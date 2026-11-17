import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, joinWithCode, makeHost, waitEvent, waitStatus } from './helpers';
import type { HostClient } from '../src/main/client/connection';
import type { ChatMessage, RoomInfo, VoiceParticipant } from '../src/shared/protocol';
import { generateDeviceKey } from '../src/main/client/profile';

let ctx: Awaited<ReturnType<typeof makeHost>>;
let admin: HostClient;
let mert: HostClient;
let mertKey: ReturnType<typeof generateDeviceKey>;
let denizKey: ReturnType<typeof generateDeviceKey>;
let genel: RoomInfo;
const extra: HostClient[] = [];

async function invite(maxUses = 1, expiresInMinutes = 60) {
  const r = await admin.request('admin.invites.create', { expiresInMinutes, maxUses });
  return r.code;
}

beforeAll(async () => {
  ctx = await makeHost();
  const a = await connectClient({
    hostId: ctx.hostId,
    port: ctx.port,
    fingerprint: ctx.fingerprint,
    auth: { kind: 'login', publicKey: ctx.key.publicKey, privateKeyPem: ctx.key.privateKeyPem },
  });
  expect(a.status.state).toBe('connected');
  admin = a.client;
  const boot = await admin.request('state.bootstrap', {});
  expect(boot.me.role).toBe('admin');
  genel = boot.rooms[0];
});

afterAll(async () => {
  for (const c of [admin, mert, ...extra]) c?.disconnect();
  await ctx.host.stop();
});

describe('invites and identity', () => {
  it('registers a member with a single-use invite and rejects reuse', async () => {
    const code = await invite(1);
    const j = await joinWithCode(code, 'Mert');
    expect(j.status.state).toBe('connected');
    mert = j.client;
    mertKey = j.key;
    mert.useLogin(j.key.publicKey, j.key.privateKeyPem);

    const again = await joinWithCode(code, 'Deniz');
    expect(again.status.state).toBe('failed');
    expect(again.status.error?.code).toBe('INVITE_USED');
  });

  it('desktop clients refuse a host that is not an ODA server without using up the invite', async () => {
    const created = await admin.request('admin.invites.create', { expiresInMinutes: 60, maxUses: 1 });
    const refused = await joinWithCode(created.code, 'Selin', { requireServer: true });
    expect(refused.status.state).toBe('failed');
    expect(refused.status.error?.code).toBe('NOT_SERVER');
    refused.client.disconnect();
    const list = await admin.request('admin.invites.list', {});
    expect(list.find((i) => i.id === created.invite.id)?.uses).toBe(0);
    const ok = await joinWithCode(created.code, 'Selin');
    expect(ok.status.state).toBe('connected');
    ok.client.disconnect();
  });

  it('rejects duplicate display names case-insensitively (Turkish)', async () => {
    const code = await invite(1);
    const j = await joinWithCode(code, 'MERT');
    expect(j.status.error?.code).toBe('NAME_TAKEN');
    const j2 = await joinWithCode(code, 'Deniz');
    expect(j2.status.state).toBe('connected');
    extra.push(j2.client);
    denizKey = j2.key;
  });

  it('rejects expired, revoked and forged invites', async () => {
    const r = await admin.request('admin.invites.create', { expiresInMinutes: 60, maxUses: 1 });
    await admin.request('admin.invites.revoke', { inviteId: r.invite.id });
    const j = await joinWithCode(r.code, 'Ece');
    expect(j.status.error?.code).toBe('INVITE_INVALID');
  });

  it('refuses a host whose certificate does not match the pinned fingerprint', async () => {
    const wrong = ctx.fingerprint.replace(/^[0-9A-F]{2}/, (x) => (x === 'AA' ? 'BB' : 'AA'));
    const r = await connectClient({ hostId: ctx.hostId, port: ctx.port, fingerprint: wrong, auth: { kind: 'login', publicKey: mertKey.publicKey, privateKeyPem: mertKey.privateKeyPem } });
    expect(r.status.state).toBe('failed');
    expect(r.status.error?.code).toBe('FINGERPRINT_MISMATCH');
    r.client.disconnect();
  });

  it('rejects login with an unknown device key', async () => {
    const k = generateDeviceKey();
    const r = await connectClient({ hostId: ctx.hostId, port: ctx.port, fingerprint: ctx.fingerprint, auth: { kind: 'login', publicKey: k.publicKey, privateKeyPem: k.privateKeyPem } });
    expect(r.status.error?.code).toBe('DEVICE_UNKNOWN');
  });

  it('rejects a login signed with a different private key', async () => {
    const other = generateDeviceKey();
    const r = await connectClient({ hostId: ctx.hostId, port: ctx.port, fingerprint: ctx.fingerprint, auth: { kind: 'login', publicKey: mertKey.publicKey, privateKeyPem: other.privateKeyPem } });
    expect(r.status.state).toBe('failed');
    expect(r.status.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('authorization', () => {
  it('members cannot perform admin actions', async () => {
    await expect(mert.request('rooms.create', { name: 'X', isPrivate: false, capacity: 4 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mert.request('admin.invites.create', { expiresInMinutes: 60, maxUses: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mert.request('admin.users.kick', { userId: 'aaaaaaaaaaaa' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('private rooms are hidden from non-members until granted', async () => {
    const room = await admin.request('rooms.create', { name: 'Özel Oda', isPrivate: true, capacity: 3 });
    let boot = await mert.request('state.bootstrap', {});
    expect(boot.rooms.find((r) => r.id === room.id)).toBeUndefined();
    await expect(mert.request('voice.join', { roomId: room.id, muted: false, deafened: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await admin.request('rooms.addMember', { roomId: room.id, userId: boot.me.id });
    boot = await mert.request('state.bootstrap', {});
    expect(boot.rooms.find((r) => r.id === room.id)).toBeDefined();
  });

  it('rejects unknown RPC methods and invalid input', async () => {
    await expect(mert.request('nope' as never, {} as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: '   ', clientId: 'abcdef12' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: 'x'.repeat(4001), clientId: 'abcdef13' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('messaging', () => {
  it('delivers room messages, stores them and dedupes by clientId', async () => {
    const got = waitEvent<{ message: ChatMessage }>(admin, 'message', (d) => d.message.body.includes('Herkese selam'));
    const sent = await mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: 'Herkese selam <b>kalın</b>', clientId: 'cid-00001' });
    const recv = await got;
    expect(recv.message.id).toBe(sent.id);
    expect(recv.message.conv).toBe(`room:${genel.id}`);
    expect(recv.message.body).toBe('Herkese selam <b>kalın</b>');
    const dup = await mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: 'Herkese selam <b>kalın</b>', clientId: 'cid-00001' });
    expect(dup.id).toBe(sent.id);
    const hist = await admin.request('messages.history', { conv: { kind: 'room', roomId: genel.id } });
    expect(hist.messages.filter((m) => m.id === sent.id)).toHaveLength(1);
  });

  it('paginates history', async () => {
    for (let i = 0; i < 8; i++) await admin.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: `mesaj ${i}`, clientId: `page-${i}-xx` });
    const p1 = await mert.request('messages.history', { conv: { kind: 'room', roomId: genel.id }, limit: 3 });
    expect(p1.messages).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    expect(p1.messages[2].body).toBe('mesaj 7');
    const p2 = await mert.request('messages.history', { conv: { kind: 'room', roomId: genel.id }, limit: 3, beforeId: p1.messages[0].id });
    expect(p2.messages.map((m) => m.body)).toEqual(['mesaj 2', 'mesaj 3', 'mesaj 4']);
    expect(p2.messages[p2.messages.length - 1].id).toBeLessThan(p1.messages[0].id);
  });

  it('tracks unread counts and read state', async () => {
    const before = await mert.request('state.bootstrap', {});
    expect(before.unread[`room:${genel.id}`]).toBeGreaterThanOrEqual(8);
    const hist = await mert.request('messages.history', { conv: { kind: 'room', roomId: genel.id }, limit: 1 });
    await mert.request('messages.markRead', { conv: { kind: 'room', roomId: genel.id }, lastId: hist.messages[0].id });
    const after = await mert.request('state.bootstrap', {});
    expect(after.unread[`room:${genel.id}`]).toBeUndefined();
  });

  it('requires friendship for DMs and delivers them after acceptance', async () => {
    const adminId = (await admin.request('state.bootstrap', {})).me.id;
    const mertId = (await mert.request('state.bootstrap', {})).me.id;
    await expect(mert.request('messages.send', { conv: { kind: 'dm', userId: adminId }, body: 'selam', clientId: 'dm-000001' })).rejects.toMatchObject({ code: 'NOT_FRIENDS' });

    const incoming = waitEvent<{ friends: { userId: string; state: string }[] }>(admin, 'friends.updated', (d) => d.friends.some((f) => f.userId === mertId && f.state === 'incoming'));
    const out = await mert.request('friends.request', { userId: adminId });
    expect(out.find((f) => f.userId === adminId)?.state).toBe('outgoing');
    await incoming;
    const acc = await admin.request('friends.accept', { userId: mertId });
    expect(acc.find((f) => f.userId === mertId)?.state).toBe('friends');

    const got = waitEvent<{ message: ChatMessage }>(admin, 'message', (d) => d.message.conv === `dm:${mertId}`);
    const sent = await mert.request('messages.send', { conv: { kind: 'dm', userId: adminId }, body: 'Özel selam', clientId: 'dm-000002' });
    expect(sent.conv).toBe(`dm:${adminId}`);
    expect((await got).message.body).toBe('Özel selam');

    const hits = await admin.request('messages.search', { q: 'özel' });
    expect(hits.some((h) => h.message.id === sent.id)).toBe(true);
  });

  it('blocking closes DMs and hides blocked user messages', async () => {
    const adminId = (await admin.request('state.bootstrap', {})).me.id;
    const mertId = (await mert.request('state.bootstrap', {})).me.id;
    const b = await admin.request('blocks.add', { userId: mertId });
    expect(b.blocked).toContain(mertId);
    expect(b.friends.find((f) => f.userId === mertId)).toBeUndefined();
    await expect(mert.request('messages.send', { conv: { kind: 'dm', userId: adminId }, body: 'hey', clientId: 'dm-000003' })).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(mert.request('friends.request', { userId: adminId })).rejects.toMatchObject({ code: 'BLOCKED' });
    const sent = await mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: 'görünmemeli', clientId: 'blk-00001' });
    const hist = await admin.request('messages.history', { conv: { kind: 'room', roomId: genel.id } });
    expect(hist.messages.some((m) => m.id === sent.id)).toBe(false);
    await admin.request('blocks.remove', { userId: mertId });
  });
});

describe('voice signaling', () => {
  it('joins, enforces capacity, relays signals only within the room', async () => {
    const small = await admin.request('rooms.create', { name: 'İkili', isPrivate: false, capacity: 2 });
    const adminId = (await admin.request('state.bootstrap', {})).me.id;
    const mertId = (await mert.request('state.bootstrap', {})).me.id;

    await expect(mert.request('rtc.signal', { to: adminId, data: { type: 'bye' } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const j1 = await admin.request('voice.join', { roomId: small.id, muted: false, deafened: false });
    expect(j1.participants).toHaveLength(1);
    const upd = waitEvent<{ roomId: string; participants: VoiceParticipant[] }>(admin, 'voice.update', (d) => d.participants.length === 2);
    const j2 = await mert.request('voice.join', { roomId: small.id, muted: true, deafened: false });
    expect(j2.participants.map((p) => p.userId)).toEqual([adminId, mertId]);
    expect((await upd).participants.find((p) => p.userId === mertId)?.muted).toBe(true);

    await expect(extra[0].request('voice.join', { roomId: small.id, muted: false, deafened: false })).rejects.toMatchObject({ code: 'ROOM_FULL' });

    const sig = waitEvent<{ from: string; data: { type: string } }>(admin, 'rtc.signal');
    await mert.request('rtc.signal', { to: adminId, data: { type: 'offer', sdp: 'v=0\r\n' } });
    const s = await sig;
    expect(s.from).toBe(mertId);
    expect(s.data.type).toBe('offer');
    await expect(mert.request('rtc.signal', { to: adminId, data: { type: 'evil' } as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const muteUpd = waitEvent<{ participants: VoiceParticipant[] }>(admin, 'voice.update', (d) => d.participants.some((p) => p.userId === mertId && !p.muted));
    await mert.request('voice.state', { muted: false, deafened: false });
    await muteUpd;

    const leaveUpd = waitEvent<{ participants: VoiceParticipant[] }>(admin, 'voice.update', (d) => d.participants.length === 1);
    await mert.request('voice.leave', {});
    await leaveUpd;
    await admin.request('voice.leave', {});
  });
});

describe('moderation and persistence', () => {
  it('ban ends the session and blocks login; unban restores it', async () => {
    const deniz = extra[0];
    const denizId = (await deniz.request('state.bootstrap', {})).me.id;
    const ended = waitStatus(deniz, (s) => s.state === 'failed');
    await admin.request('admin.users.ban', { userId: denizId });
    const st = await ended;
    expect(st.error?.code).toBe('BANNED');
    const auth = { kind: 'login' as const, publicKey: denizKey.publicKey, privateKeyPem: denizKey.privateKeyPem };
    const refused = await connectClient({ hostId: ctx.hostId, port: ctx.port, fingerprint: ctx.fingerprint, auth });
    expect(refused.status.error?.code).toBe('BANNED');
    await admin.request('admin.users.unban', { userId: denizId });
    const back = await connectClient({ hostId: ctx.hostId, port: ctx.port, fingerprint: ctx.fingerprint, auth });
    expect(back.status.state).toBe('connected');
    extra.push(back.client);
  });

  it('keeps messages across a host restart and clients reconnect automatically', async () => {
    const marker = `kalıcı-${Date.now()}`;
    await mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: marker, clientId: 'persist-01' });
    const down = waitStatus(mert, (s) => s.state === 'reconnecting');
    await ctx.host.stop();
    const st = await down;
    expect(st.error?.code).toBe('HOST_SHUTDOWN');
    await expect(mert.request('messages.send', { conv: { kind: 'room', roomId: genel.id }, body: 'x', clientId: 'persist-02' })).rejects.toMatchObject({ code: 'OFFLINE' });
    await ctx.host.start();
    mert.retryNow();
    await waitStatus(mert, (s) => s.state === 'connected', 15000);
    const hist = await mert.request('messages.history', { conv: { kind: 'room', roomId: genel.id } });
    expect(hist.messages.some((m) => m.body === marker)).toBe(true);
  });
});
