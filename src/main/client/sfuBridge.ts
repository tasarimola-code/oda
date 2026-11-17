import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { SFU_PATH } from '../../shared/protocol';
import { createLogger, errMessage } from '../logger';

const log = createLogger('sfu-bridge');

export interface PinnedTarget {
  address: string;
  port: number;
  fingerprint: string;
}

const APP_ORIGIN = 'oda://app';
const CONNECT_TIMEOUT_MS = 8000;
const DROP_HEADERS = new Set(['host', 'origin', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);

function hostHeader(t: PinnedTarget): string {
  const a = t.address.replace(/^\[|\]$/g, '');
  return `${net.isIPv6(a) ? `[${a}]` : a}:${t.port}`;
}

/** Resolves only after the host certificate matched the fingerprint from the invite. */
export function connectPinned(t: PinnedTarget): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const host = t.address.replace(/^\[|\]$/g, '');
    // Trust comes from the pinned fingerprint checked on secureConnect, before any bytes are written.
    const sock = tls.connect({ host, port: t.port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout'));
    }, CONNECT_TIMEOUT_MS);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = sock.getPeerX509Certificate()?.fingerprint256?.toUpperCase();
      if (fp !== t.fingerprint) {
        sock.destroy();
        reject(new Error('fingerprint mismatch'));
        return;
      }
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Loopback endpoint for the LiveKit client in the renderer. The renderer cannot pin a self-signed
 * certificate, so it talks plain HTTP/WS to 127.0.0.1 behind an unguessable path and this bridge
 * forwards to the host's /lk endpoint over the pinned TLS connection.
 */
export class SfuBridge {
  private server: http.Server | null = null;
  private port = 0;
  private readonly secret = randomBytes(24).toString('base64url');
  private target: PinnedTarget | null = null;
  private sockets = new Set<Duplex>();

  async url(target: PinnedTarget): Promise<string> {
    if (this.target && (this.target.address !== target.address || this.target.port !== target.port || this.target.fingerprint !== target.fingerprint)) this.dropAll();
    this.target = { ...target };
    if (!this.server) await this.listen();
    return `ws://127.0.0.1:${this.port}/${this.secret}`;
  }

  private listen(): Promise<void> {
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => void this.onUpgrade(req, socket, head));
    server.on('clientError', (_e, socket) => socket.destroy());
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  /** Maps /<secret>/rtc... to /lk/rtc...; anything else is rejected. */
  private upstreamPath(url: string | undefined): string | null {
    const prefix = `/${this.secret}`;
    if (!url || !url.startsWith(prefix + '/rtc')) return null;
    const rest = url.slice(prefix.length);
    const pathname = rest.split('?')[0];
    if (!/^\/rtc(\/[A-Za-z0-9_/-]*)?$/.test(pathname) || pathname.includes('..')) return null;
    return SFU_PATH + rest;
  }

  private originOk(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    return o === undefined || o === APP_ORIGIN;
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once('close', () => this.sockets.delete(s));
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    const path = this.upstreamPath(req.url);
    const target = this.target;
    if (!path || !target || !this.originOk(req) || req.method !== 'GET') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    let up: tls.TLSSocket;
    try {
      up = await connectPinned(target);
    } catch (e) {
      log.warn('upstream connect failed', { err: errMessage(e) });
      if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    if (socket.destroyed) {
      up.destroy();
      return;
    }
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${hostHeader(target)}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!DROP_HEADERS.has(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    this.track(socket);
    this.track(up);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    up.on('error', () => socket.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = this.upstreamPath(req.url);
    const target = this.target;
    const cors: Record<string, string> = req.headers.origin === APP_ORIGIN ? { 'Access-Control-Allow-Origin': APP_ORIGIN, Vary: 'Origin' } : {};
    if (!path || !target || !this.originOk(req)) {
      res.writeHead(404, cors).end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '600' }).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, cors).end();
      return;
    }
    let sock: tls.TLSSocket;
    try {
      sock = await connectPinned(target);
    } catch (e) {
      log.warn('upstream connect failed', { err: errMessage(e) });
      res.writeHead(502, cors).end();
      return;
    }
    const headers: Record<string, string> = { Host: hostHeader(target) };
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k) && typeof v === 'string') headers[k] = v;
    const up = http.request({ method: 'GET', path, headers, createConnection: () => sock, timeout: 10_000 }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...cors, 'Content-Type': r.headers['content-type'] ?? 'text/plain', 'Cache-Control': 'no-store' });
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, cors);
      res.end();
    });
    up.end();
  }

  private dropAll(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  close(): void {
    this.dropAll();
    this.server?.close();
    this.server = null;
    this.target = null;
  }
}
