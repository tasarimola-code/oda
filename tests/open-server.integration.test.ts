import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { HostDb, newId } from '../src/main/host/db';
import { HostServer, MAX_OWNED_ROOMS, issueInvite } from '../src/main/host/server';
import { loadOrCreateTls, type TlsMaterial } from '../src/main/host/tls';
import { plainBox } from '../src/main/secretBox';
import { generateDeviceKey } from '../src/main/client/profile';
import type { HostClient } from '../src/main/client/connection';
import { decodeInvite } from '../src/shared/invite';
import { connectClient, freePort, joinWithCode, tmpDir, waitEvent } from './helpers';

let db: HostDb;
let tls: TlsMaterial;
let server: HostServer;
let hostId: string;
let port: number;
const clients: HostClient[] = [];

async function signUp(displayName: string) {
  const key = generateDeviceKey();
  const res = await connectClient({ hostId, port, fingerprint: tls.fingerprint, requireServer: true, auth: { kind: 'register', publicKey: key.publicKey, privateKeyPem: key.privateKeyPem, displayName } });
  clients.push(res.client);
  return res;
}

beforeAll(async () => {
  const dir = tmpDir();
  db = HostDb.open(path.join(dir, 'oda-host.db'));
  hostId = newId(16);
  db.setMeta('host_id', hostId);
  db.setMeta('host_name', 'Açık Sunucu');
  tls = await loadOrCreateTls(path.join(dir, 'tls.json'), plainBox);
  port = freePort();
  server = new HostServer({
    db,
    tls,
    port,
    bindAddress: '127.0.0.1',
    advertisedAddresses: () => ['127.0.0.1'],
    sfu: { apiKey: 'APItest', apiSecret: 'x'.repeat(40), upstream: 'http://127.0.0.1:9' },
    dedicated: true,
    openRegistration: true,
  });
  await server.start();
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await server.stop();
  db.close();
});

describe('open server: everyone creates their own rooms', () => {
  let a: HostClient;
  let b: HostClient;
  let c: HostClient;
  let aId: string;
  let bId: string;
  let cId: string;
  let roomId: string;
  let code: string;

  it('signs up without an invite and starts with no rooms and no strangers', async () => {
    const r = await signUp('Ayşe');
    expect(r.status.state).toBe('connected');
    a = r.client;
    aId = r.status.userId!;
    const boot = await a.request('state.bootstrap', {});
    expect(boot.me.role).toBe('member');
    expect(boot.host.openRegistration).toBe(true);
    expect(boot.host.maxOwnedRooms).toBe(MAX_OWNED_ROOMS);
    expect(boot.rooms).toEqual([]);
    expect(boot.users.map((u) => u.id)).toEqual([aId]);
  });

  it('creates a private room it owns and an invite code for it', async () => {
    const room = await a.request('rooms.create', { name: 'Ayşe odası', isPrivate: false, capacity: 25 });
    expect(room).toMatchObject({ name: 'Ayşe odası', isPrivate: true, capacity: 25, ownerId: aId });
    roomId = room.id;
    const inv = await a.request('invites.create', { roomId, expiresInMinutes: 30 * 1440, maxUses: 100 });
    expect(inv.invite).toMatchObject({ roomId, maxUses: 100, role: 'member' });
    code = inv.code;
    expect(decodeInvite(code)).toMatchObject({ h: hostId, p: port, f: tls.fingerprint });
  });

  it('a new user joins the room with the code and both see each other', async () => {
    const added = waitEvent<{ user: { id: string } }>(a, 'user.added');
    const r = await joinWithCode(code, 'Burak', { requireServer: true });
    expect(r.status.state).toBe('connected');
    b = r.client;
    bId = r.status.userId!;
    clients.push(b);
    expect((await added).user.id).toBe(bId);
    const boot = await b.request('state.bootstrap', {});
    expect(boot.rooms.map((x) => x.id)).toEqual([roomId]);
    expect(boot.users.map((u) => u.id).sort()).toEqual([aId, bId].sort());
    const v = await b.request('voice.join', { roomId, muted: false, deafened: false });
    expect(v.sfu?.token).toBeTruthy();
    await b.request('voice.leave', {});
  });

  it('only the owner manages the room or creates invites for it', async () => {
    await expect(b.request('invites.create', { roomId, expiresInMinutes: 60, maxUses: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(b.request('rooms.delete', { roomId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(b.request('rooms.update', { roomId, name: 'Benim' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(b.request('admin.invites.create', { expiresInMinutes: 60, maxUses: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(b.request('rooms.removeMember', { roomId, userId: aId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an outsider sees neither the room nor its members', async () => {
    const r = await signUp('Cem');
    c = r.client;
    cId = r.status.userId!;
    const boot = await c.request('state.bootstrap', {});
    expect(boot.rooms).toEqual([]);
    expect(boot.users.map((u) => u.displayName)).toEqual(['Cem']);
    await expect(c.request('voice.join', { roomId, muted: false, deafened: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.request('messages.history', { conv: { kind: 'room', roomId } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.request('invites.create', { roomId, expiresInMinutes: 60, maxUses: 5 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.request('rooms.members', { roomId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an existing account redeems a code to enter the room, once', async () => {
    const usesBefore = db.listInvites().find((i) => i.roomId === roomId)!.uses;
    const res = await c.request('invites.redeem', { secret: decodeInvite(code)!.s });
    expect(res.room.id).toBe(roomId);
    await c.request('invites.redeem', { secret: decodeInvite(code)!.s });
    expect(db.listInvites().find((i) => i.roomId === roomId)!.uses).toBe(usesBefore + 1);
    const boot = await c.request('state.bootstrap', {});
    expect(boot.rooms.map((x) => x.id)).toEqual([roomId]);
    expect(boot.users.map((u) => u.displayName).sort()).toEqual(['Ayşe', 'Burak', 'Cem']);
    await expect(c.request('invites.redeem', { secret: 'x'.repeat(32) })).rejects.toMatchObject({ code: 'INVITE_INVALID' });
  });

  it('redeeming never changes the role', async () => {
    const adminInvite = issueInvite(db, { hostId, addresses: ['127.0.0.1'], port, fingerprint: tls.fingerprint, createdBy: aId, roomId, maxUses: 5, minutes: 60, role: 'admin' });
    const r = await signUp('Deniz');
    await r.client.request('invites.redeem', { secret: decodeInvite(adminInvite.code)!.s });
    expect((await r.client.request('state.bootstrap', {})).me.role).toBe('member');
  });

  it('the owner removes a member from the room', async () => {
    const removed = waitEvent<{ roomId: string }>(c, 'room.removed');
    await a.request('rooms.removeMember', { roomId, userId: (await c.request('state.bootstrap', {})).me.id });
    expect((await removed).roomId).toBe(roomId);
    expect((await c.request('state.bootstrap', {})).rooms).toEqual([]);
  });

  it('a spent invite still signs an existing member back into the room', async () => {
    const spent = issueInvite(db, { hostId, addresses: ['127.0.0.1'], port, fingerprint: tls.fingerprint, createdBy: aId, roomId, maxUses: 1, minutes: 60, role: 'member' });
    const secret = decodeInvite(spent.code)!.s;
    await c.request('invites.redeem', { secret });
    expect(db.listInvites().find((i) => i.id === spent.row.id)!.uses).toBe(1);
    const again = await b.request('invites.redeem', { secret });
    expect(again.room.id).toBe(roomId);
    await a.request('rooms.removeMember', { roomId, userId: cId });
    expect((await c.request('state.bootstrap', {})).rooms.map((x) => x.id)).not.toContain(roomId);
  });

  it('friends see each other\'s rooms and can join voice without a new invite', async () => {
    await a.request('friends.request', { userId: cId });
    await c.request('friends.accept', { userId: aId });
    const boot = await c.request('state.bootstrap', {});
    expect(boot.rooms.map((x) => x.id)).toContain(roomId);
    const v = await c.request('voice.join', { roomId, muted: false, deafened: false });
    expect(v.sfu?.token).toBeTruthy();
    expect((await a.request('state.bootstrap', {})).users.find((u) => u.id === cId)?.voiceRoomId).toBe(roomId);
    await c.request('voice.leave', {});
  });

  it('unfriending drops friendship-only room access', async () => {
    await a.request('friends.remove', { userId: cId });
    expect((await c.request('state.bootstrap', {})).rooms.map((x) => x.id)).not.toContain(roomId);
    await expect(c.request('voice.join', { roomId, muted: false, deafened: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('limits rooms per user', async () => {
    for (let i = 2; i <= MAX_OWNED_ROOMS; i++) await a.request('rooms.create', { name: `Oda ${i}`, isPrivate: true, capacity: 10 });
    await expect(a.request('rooms.create', { name: 'Fazla', isPrivate: true, capacity: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the owner may delete even their last room', async () => {
    const r = await b.request('rooms.create', { name: 'Burak odası', isPrivate: true, capacity: 10 });
    expect(r.ownerId).toBe(bId);
    await b.request('rooms.delete', { roomId: r.id });
    expect((await b.request('state.bootstrap', {})).rooms.map((x) => x.id)).toEqual([roomId]);
  });

  it('rate-limits new accounts per network', async () => {
    // Ayşe, Cem and Deniz used 3 of the 5 invite-less sign-ups.
    expect((await signUp('Ece')).status.state).toBe('connected');
    expect((await signUp('Fatih')).status.state).toBe('connected');
    const r = await signUp('Gül');
    expect(r.status.state).toBe('failed');
    expect(r.status.error?.code).toBe('RATE_LIMITED');
  });
});
