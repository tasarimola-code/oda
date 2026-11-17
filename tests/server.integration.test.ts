import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type net from 'node:net';
import WebSocket from 'ws';
import { HostDb, newId } from '../src/main/host/db';
import { HostServer, issueInvite } from '../src/main/host/server';
import { loadOrCreateTls, type TlsMaterial } from '../src/main/host/tls';
import { participantToken, sfuUpstreamPath, tokenSubject, type SfuConfig } from '../src/main/host/livekit';
import { plainBox } from '../src/main/secretBox';
import { SfuBridge } from '../src/main/client/sfuBridge';
import type { HostClient } from '../src/main/client/connection';
import { MAX_SFU_ROOM_CAPACITY, SFU_PATH } from '../src/shared/protocol';
import { freePort, joinWithCode, tmpDir } from './helpers';

/** Stands in for LiveKit: records signaling upgrades and RoomService calls, echoes WebSocket bytes. */
class FakeMediaServer {
  upgrades: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  removed: Array<{ room: string; identity: string }> = [];
  private server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/twirp/livekit.RoomService/RemoveParticipant') {
        this.removed.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/rtc/v1/validate')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('success');
        return;
      }
      res.writeHead(404).end();
    });
  });
  private sockets = new Set<net.Socket>();
  port = 0;

  async start(): Promise<void> {
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server.on('upgrade', (req, socket) => {
      this.upgrades.push({ url: req.url ?? '', headers: req.headers });
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      // Minimal echo: reflect each client frame back unmasked (small text frames only).
      socket.on('data', (buf: Buffer) => {
        const len = buf[1] & 0x7f;
        const mask = buf.subarray(2, 6);
        const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let media: FakeMediaServer;
let db: HostDb;
let tls: TlsMaterial;
let server: HostServer;
let sfu: SfuConfig;
let hostId: string;
let port: number;
let admin: HostClient;
let member: HostClient;
let memberId: string;
const bridge = new SfuBridge();

function invite(role: 'admin' | 'member', maxUses = 1) {
  return issueInvite(db, { hostId, addresses: ['127.0.0.1'], port, fingerprint: tls.fingerprint, createdBy: null, roomId: null, maxUses, minutes: 60, role }).code;
}

function openWs(url: string): Promise<{ ws: WebSocket; status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin: 'oda://app' });
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
    ws.once('error', () => resolve({ ws, status: 0 }));
  });
}

beforeAll(async () => {
  media = new FakeMediaServer();
  await media.start();
  const dir = tmpDir();
  db = HostDb.open(path.join(dir, 'oda-host.db'));
  hostId = newId(16);
  db.setMeta('host_id', hostId);
  db.setMeta('host_name', 'Sunucu Topluluğu');
  db.setMeta('created_at', String(Date.now()));
  tls = await loadOrCreateTls(path.join(dir, 'tls.json'), plainBox);
  port = freePort();
  sfu = { apiKey: 'APItest', apiSecret: 'x'.repeat(40), upstream: `http://127.0.0.1:${media.port}` };
  server = new HostServer({ db, tls, port, bindAddress: '127.0.0.1', advertisedAddresses: () => ['127.0.0.1'], sfu, dedicated: true, maxConnections: 64 });
  await server.start();
});

afterAll(async () => {
  bridge.close();
  admin?.disconnect();
  member?.disconnect();
  await server.stop();
  db.close();
  await media.stop();
});

describe('dedicated server bootstrap', () => {
  it('member invites need an admin; the first admin gets the default room', async () => {
    expect(db.hasActiveAdmin()).toBe(false);
    const a = await joinWithCode(invite('admin'), 'Yönetici', { requireServer: true });
    expect(a.status.state).toBe('connected');
    admin = a.client;
    const boot = await admin.request('state.bootstrap', {});
    expect(boot.me.role).toBe('admin');
    expect(boot.host.media).toBe('sfu');
    expect(boot.host.dedicated).toBe(true);
    expect(boot.host.maxRoomCapacity).toBe(MAX_SFU_ROOM_CAPACITY);
    expect(boot.host.inviteLimits.maxUses).toBe(1000);
    expect(boot.host.ownerName).toBe('Yönetici');
    expect(boot.rooms.map((r) => [r.name, r.capacity])).toEqual([['Genel', 25]]);
    expect(db.hasActiveAdmin()).toBe(true);

    const m = await joinWithCode(invite('member', 5), 'Üye', { requireServer: true });
    expect(m.status.state).toBe('connected');
    member = m.client;
    memberId = m.status.userId!;
    const mb = await member.request('state.bootstrap', {});
    expect(mb.me.role).toBe('member');
    expect(mb.rooms).toHaveLength(1);
  });

  it('allows large rooms up to the server limit', async () => {
    const big = await admin.request('rooms.create', { name: 'Büyük', isPrivate: false, capacity: 40 });
    expect(big.capacity).toBe(40);
    await expect(admin.request('rooms.create', { name: 'Çok büyük', isPrivate: false, capacity: MAX_SFU_ROOM_CAPACITY + 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const inv = await admin.request('admin.invites.create', { expiresInMinutes: 90 * 1440, maxUses: 1000 });
    expect(inv.invite.maxUses).toBe(1000);
  });
});

describe('media server access', () => {
  let roomId: string;
  let token: string;

  it('voice.join returns a single-room, microphone-only grant; mesh signaling is refused', async () => {
    roomId = (await member.request('state.bootstrap', {})).rooms.find((r) => r.name === 'Genel')!.id;
    const res = await member.request('voice.join', { roomId, muted: false, deafened: false });
    expect(res.sfu?.path).toBe(SFU_PATH);
    token = res.sfu!.token;
    expect(tokenSubject(sfu, `/x?access_token=${token}`)).toEqual({ identity: memberId, room: roomId });
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.video).toMatchObject({ room: roomId, roomJoin: true, canPublishSources: ['microphone'], canPublishData: false });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(11 * 60);
    await expect(member.request('rtc.signal', { to: 'x'.repeat(16), data: { type: 'bye' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('bridges signaling through the pinned connection to /rtc only', async () => {
    const base = await bridge.url(member.pinnedTarget!);
    expect(base).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}$/);
    const { ws, status } = await openWs(`${base}/rtc/v1?access_token=${token}`);
    expect(status).toBe(101);
    const echo = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
    ws.send('merhaba');
    expect(await echo).toBe('merhaba');
    ws.close();
    const up = media.upgrades.at(-1)!;
    expect(up.url.startsWith('/rtc/v1?access_token=')).toBe(true);
    expect(up.headers.origin).toBeUndefined();

    const validate = await fetch(`${base.replace('ws:', 'http:')}/rtc/v1/validate?access_token=${token}`, { headers: { Origin: 'oda://app' } });
    expect(validate.status).toBe(200);
    expect(validate.headers.get('access-control-allow-origin')).toBe('oda://app');

    expect((await openWs(`${base}/twirp/livekit.RoomService/ListRooms?access_token=${token}`)).status).toBe(404);
    expect((await openWs(`${base.replace(/\/[^/]+$/, '/yanlis')}/rtc/v1?access_token=${token}`)).status).toBe(404);
  });

  it('rejects forged tokens and tokens of users no longer in the room', async () => {
    const base = await bridge.url(member.pinnedTarget!);
    const forged = participantToken({ ...sfu, apiSecret: 'y'.repeat(40) }, { identity: memberId, name: 'Üye', room: roomId });
    expect((await openWs(`${base}/rtc/v1?access_token=${forged}`)).status).toBe(403);
    expect((await openWs(`${base}/rtc/v1`)).status).toBe(403);
    const otherRoom = participantToken(sfu, { identity: memberId, name: 'Üye', room: 'baska-oda' });
    expect((await openWs(`${base}/rtc/v1?access_token=${otherRoom}`)).status).toBe(403);

    await member.request('voice.leave', {});
    expect((await openWs(`${base}/rtc/v1?access_token=${token}`)).status).toBe(403);
    await new Promise((r) => setTimeout(r, 200));
    expect(media.removed).toContainEqual({ room: roomId, identity: memberId });
  });

  it('never forwards the server API', () => {
    expect(sfuUpstreamPath('/lk/rtc/v1?access_token=a', '/lk')).toBe('/rtc/v1?access_token=a');
    expect(sfuUpstreamPath('/lk/twirp/livekit.RoomService/ListRooms', '/lk')).toBeNull();
    expect(sfuUpstreamPath('/lk/rtc/../twirp', '/lk')).toBeNull();
    expect(sfuUpstreamPath('/lkx/rtc', '/lk')).toBeNull();
  });

  it('bridge refuses a host whose certificate does not match', async () => {
    const t = member.pinnedTarget!;
    const other = new SfuBridge();
    const wrong = (t.fingerprint.startsWith('AA') ? 'BB' : 'AA') + t.fingerprint.slice(2);
    const base = await other.url({ ...t, fingerprint: wrong });
    expect((await openWs(`${base}/rtc/v1?access_token=${token}`)).status).toBe(502);
    other.close();
  });
});
