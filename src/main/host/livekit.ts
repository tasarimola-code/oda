import http from 'node:http';
import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** LiveKit media server reachable from the host only (loopback). */
export interface SfuConfig {
  apiKey: string;
  apiSecret: string;
  /** e.g. http://127.0.0.1:7880 */
  upstream: string;
}

const TOKEN_TTL_SEC = 10 * 60;
const ADMIN_TTL_SEC = 60;

function b64url(v: string): string {
  return Buffer.from(v).toString('base64url');
}

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Grants joining exactly one room, publishing the microphone only. */
export function participantToken(cfg: SfuConfig, o: { identity: string; name: string; room: string }): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: cfg.apiKey,
      sub: o.identity,
      name: o.name,
      nbf: now - 10,
      exp: now + TOKEN_TTL_SEC,
      jti: randomBytes(9).toString('base64url'),
      video: {
        room: o.room,
        roomJoin: true,
        canSubscribe: true,
        canPublish: true,
        canPublishSources: ['microphone'],
        canPublishData: false,
        canUpdateOwnMetadata: false,
      },
    },
    cfg.apiSecret,
  );
}

/**
 * Verifies the join token carried in a signaling URL (?access_token=...), including tokens the media
 * server refreshed for the client (same key). Returns who it is for; null if absent, forged or expired.
 */
export function tokenSubject(cfg: SfuConfig, url: string): { identity: string; room: string } | null {
  const q = url.indexOf('?');
  if (q < 0) return null;
  const token = new URLSearchParams(url.slice(q + 1)).get('access_token');
  if (!token || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') return null;
    const expected = createHmac('sha256', cfg.apiSecret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iss?: string; sub?: string; exp?: number; nbf?: number; video?: { room?: string } };
    const now = Math.floor(Date.now() / 1000);
    if (body.iss !== cfg.apiKey || typeof body.exp !== 'number' || body.exp < now || (typeof body.nbf === 'number' && body.nbf > now + 30)) return null;
    if (typeof body.sub !== 'string' || typeof body.video?.room !== 'string') return null;
    return { identity: body.sub, room: body.video.room };
  } catch {
    return null;
  }
}

function adminToken(cfg: SfuConfig, room: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: cfg.apiKey, sub: 'oda-host', nbf: now - 10, exp: now + ADMIN_TTL_SEC, video: { room, roomAdmin: true } }, cfg.apiSecret);
}

function twirp(cfg: SfuConfig, method: string, room: string, body: Record<string, unknown>): Promise<number> {
  const url = new URL(`/twirp/livekit.RoomService/${method}`, cfg.upstream);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        timeout: 5000,
        headers: { Authorization: `Bearer ${adminToken(cfg, room)}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Disconnects a participant from the media server. A missing participant is not an error. */
export async function removeParticipant(cfg: SfuConfig, room: string, identity: string): Promise<void> {
  const status = await twirp(cfg, 'RemoveParticipant', room, { room, identity });
  if (status !== 200 && status !== 404) throw new Error(`RemoveParticipant HTTP ${status}`);
}

/** Only the client signaling endpoints are exposed; the server API (/twirp) stays private. */
export function sfuUpstreamPath(url: string, prefix: string): string | null {
  if (!url.startsWith(prefix + '/')) return null;
  const rest = url.slice(prefix.length);
  const pathname = rest.split('?')[0];
  if (!/^\/rtc(\/[A-Za-z0-9_/-]*)?$/.test(pathname) || pathname.includes('..')) return null;
  return rest;
}

const HOP_HEADERS = new Set(['host', 'origin', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);

export function proxyUpgrade(cfg: SfuConfig, path: string, req: IncomingMessage, socket: Duplex, head: Buffer, clientIp: string): void {
  const target = new URL(cfg.upstream);
  const upstream = net.connect({ host: target.hostname, port: Number(target.port || 80) });
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${target.host}`, `X-Forwarded-For: ${clientIp}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    if (!HOP_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
  }
  const kill = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.setTimeout(10_000, kill);
  upstream.once('connect', () => {
    upstream.setTimeout(0);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => {
    if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    kill();
  });
  socket.on('error', kill);
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}

export function proxyHttp(cfg: SfuConfig, path: string, req: IncomingMessage, res: ServerResponse, clientIp: string): void {
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  const headers: Record<string, string> = { 'X-Forwarded-For': clientIp };
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k) && typeof v === 'string') headers[k] = v;
  }
  const up = http.request(new URL(path, cfg.upstream), { method: 'GET', headers, timeout: 10_000 }, (r) => {
    res.writeHead(r.statusCode ?? 502, { 'Content-Type': r.headers['content-type'] ?? 'text/plain', 'Cache-Control': 'no-store' });
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  up.end();
}
