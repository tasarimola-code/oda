import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  WS_PATH,
  authPayload,
  type ErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerEventName,
  type ServerFrame,
  type SessionEndReason,
} from '../../shared/protocol';
import { classifyAddress } from '../../shared/netclass';
import type { ClientStatus } from '../../shared/ipc';
import { signWith } from './profile';
import { createLogger, errMessage } from '../logger';

const log = createLogger('client');

export class ClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectTarget {
  hostId: string;
  hostName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  isOwnHost: boolean;
  /** Refuse hosts that do not announce themselves as an always-on ODA server (checked before any auth). */
  requireServer?: boolean;
}

export type AuthMode =
  | { kind: 'login'; publicKey: string; privateKeyPem: string }
  | { kind: 'register'; publicKey: string; privateKeyPem: string; invite?: string; displayName: string };

const FATAL_CODES = new Set<string>([
  'FINGERPRINT_MISMATCH',
  'HOST_MISMATCH',
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_USED',
  'NAME_TAKEN',
  'BANNED',
  'DEVICE_UNKNOWN',
  'UNAUTHORIZED',
  'KICKED',
  'REPLACED',
  'BAD_REQUEST',
  'NOT_SERVER',
]);

const REQUEST_TIMEOUT_MS = 12_000;
const CONNECT_TIMEOUT_MS = 6_000;

function hostForUrl(addr: string): string {
  return net.isIPv6(addr.replace(/^\[|\]$/g, '')) ? `[${addr.replace(/^\[|\]$/g, '')}]` : addr;
}

interface Attempt {
  ws: WebSocket;
  address: string;
  hello: Extract<ServerFrame, { t: 'hello' }>;
}

/** Opens one pinned WSS connection and waits for the host hello. */
function openPinned(address: string, port: number, fingerprint: string, expectedHostId: string, signal: AbortSignal): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pinned = false;
    const url = `wss://${hostForUrl(address)}:${port}${WS_PATH}`;
    const ws = new WebSocket(url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_FRAME_BYTES * 4,
      perMessageDeflate: false,
      // Certificate trust is established by the fingerprint pinned in the invite,
      // checked below before any application data is exchanged.
      createConnection: ((opts: tls.ConnectionOptions) => {
        const host = String(opts.host ?? address).replace(/^\[|\]$/g, '');
        const sock = tls.connect({ ...opts, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
        sock.once('secureConnect', () => {
          const fp = sock.getPeerX509Certificate()?.fingerprint256?.toUpperCase();
          if (fp !== fingerprint) {
            fail(new ClientError('FINGERPRINT_MISMATCH', 'Sunucunun güvenlik parmak izi davetteki ile eşleşmiyor. Bağlantı güvenli değil; sunucu yöneticisinden yeni davet isteyin.'));
            sock.destroy();
          } else {
            pinned = true;
          }
        });
        return sock;
      }) as unknown as WebSocket.ClientOptions['createConnection'],
    });
    const timer = setTimeout(() => fail(new ClientError('TIMEOUT', `${address}:${port} yanıt vermedi.`)), CONNECT_TIMEOUT_MS + 1000);
    const onAbort = () => fail(new ClientError('ABORTED', 'iptal'));
    signal.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    function fail(e: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(e);
    }
    ws.once('message', (data) => {
      if (settled) return;
      if (!pinned) return fail(new ClientError('FINGERPRINT_MISMATCH', 'Sertifika doğrulanmadı.'));
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return fail(new ClientError('PROTOCOL', 'Geçersiz sunucu yanıtı.'));
      }
      if (frame.t !== 'hello') return fail(new ClientError('PROTOCOL', 'Beklenmeyen sunucu yanıtı.'));
      if (frame.protocol !== PROTOCOL_VERSION) return fail(new ClientError('PROTOCOL', 'Sunucu farklı bir ODA sürümü kullanıyor. ODA\'yı güncelleyin veya sunucu yöneticisine haber verin.'));
      if (frame.hostId !== expectedHostId) return fail(new ClientError('HOST_MISMATCH', 'Bu adreste farklı bir ODA sunucusu çalışıyor.'));
      settled = true;
      cleanup();
      resolve({ ws, address, hello: frame });
    });
    ws.once('error', (e: NodeJS.ErrnoException) => {
      const code = e.code ?? '';
      const msg =
        code === 'ECONNREFUSED'
          ? `${address}:${port} bağlantıyı reddetti (sunucu kapalı veya port yanlış).`
          : code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
            ? `${address}:${port} adresine ulaşılamıyor.`
            : `${address}:${port}: ${errMessage(e)}`;
      fail(e instanceof ClientError ? e : new ClientError('HOST_UNREACHABLE', msg));
    });
    ws.once('close', () => fail(new ClientError('HOST_UNREACHABLE', `${address}:${port} bağlantıyı kapattı.`)));
  });
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: ClientError) => void;
  timer: NodeJS.Timeout;
}

/**
 * Connection to one host. Emits:
 *  - 'status' (ClientStatus)
 *  - 'event' (name, data)
 *  - 'registered' ({ userId, address })
 *  - 'authenticated' ({ userId, address })
 */
export class HostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closedByUser = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private status: ClientStatus;
  private auth: AuthMode;

  constructor(
    private target: ConnectTarget,
    auth: AuthMode,
  ) {
    super();
    this.auth = auth;
    this.status = {
      state: 'idle',
      hostId: target.hostId,
      hostName: target.hostName,
      userId: null,
      address: null,
      port: target.port,
      pathKind: null,
      isOwnHost: target.isOwnHost,
      attempt: 0,
      nextRetryAt: null,
      error: null,
    };
  }

  get currentStatus(): ClientStatus {
    return { ...this.status };
  }

  get hostId(): string {
    return this.target.hostId;
  }

  /** Address that won the connection race, with the pinned fingerprint; null when not connected. */
  get pinnedTarget(): { address: string; port: number; fingerprint: string } | null {
    if (this.status.state !== 'connected' || !this.status.address) return null;
    return { address: this.status.address, port: this.target.port, fingerprint: this.target.fingerprint };
  }

  private setStatus(patch: Partial<ClientStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.currentStatus);
  }

  updateTarget(patch: Partial<ConnectTarget>): void {
    this.target = { ...this.target, ...patch };
  }

  /** Switch to login auth after a successful registration. */
  useLogin(publicKey: string, privateKeyPem: string): void {
    this.auth = { kind: 'login', publicKey, privateKeyPem };
  }

  connect(): void {
    this.closedByUser = false;
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setStatus({ state: this.attempt === 0 ? 'connecting' : 'reconnecting', attempt: this.attempt, nextRetryAt: null });
    const abort = new AbortController();
    this.abort = abort;
    let winner: Attempt;
    try {
      winner = await this.race(abort);
    } catch (e) {
      if (this.closedByUser) return;
      this.handleFailure(e instanceof ClientError ? e : new ClientError('HOST_UNREACHABLE', errMessage(e)));
      return;
    }
    if (this.closedByUser) {
      winner.ws.terminate();
      return;
    }
    if (this.target.requireServer && winner.hello.dedicated !== true) {
      winner.ws.terminate();
      this.handleFailure(new ClientError('NOT_SERVER', 'Bu davet bir ODA sunucusuna ait değil (bir bilgisayardaki eski oda). ODA yalnızca sunucu davetleriyle çalışır; sunucu yöneticisinden yeni davet isteyin.'));
      return;
    }
    this.attach(winner);
    try {
      const signature = signWith(this.auth.privateKeyPem, authPayload(winner.hello.hostId, winner.hello.nonce, this.auth.publicKey));
      const frame =
        this.auth.kind === 'register'
          ? { t: 'auth.register', invite: this.auth.invite, displayName: this.auth.displayName, publicKey: this.auth.publicKey, signature, deviceName: os.hostname().slice(0, 64) }
          : { t: 'auth.login', publicKey: this.auth.publicKey, signature };
      const res = (await this.rawRequest(frame as Record<string, unknown>)) as { userId: string };
      const kind = this.auth.kind;
      this.attempt = 0;
      this.setStatus({ state: 'connected', userId: res.userId, address: winner.address, pathKind: classifyAddress(winner.address), error: null, attempt: 0 });
      if (kind === 'register') this.emit('registered', { userId: res.userId, address: winner.address });
      this.emit('authenticated', { userId: res.userId, address: winner.address });
    } catch (e) {
      const err = e instanceof ClientError ? e : new ClientError('INTERNAL', errMessage(e));
      this.detach();
      this.handleFailure(err);
    }
  }

  private async race(abort: AbortController): Promise<Attempt> {
    const addrs = [...new Set(this.target.addresses)];
    if (addrs.length === 0) throw new ClientError('HOST_UNREACHABLE', 'Bağlanılacak adres yok.');
    const errors: ClientError[] = [];
    return new Promise<Attempt>((resolve, reject) => {
      let remaining = addrs.length;
      let done = false;
      addrs.forEach((addr, i) => {
        setTimeout(() => {
          if (done) {
            remaining--;
            return;
          }
          openPinned(addr, this.target.port, this.target.fingerprint, this.target.hostId, abort.signal)
            .then((a) => {
              if (done) {
                a.ws.terminate();
                return;
              }
              done = true;
              abort.abort();
              resolve(a);
            })
            .catch((e: ClientError) => {
              if (e.code !== 'ABORTED') errors.push(e);
              remaining--;
              if (remaining === 0 && !done) {
                done = true;
                const fatal = errors.find((x) => x.code === 'FINGERPRINT_MISMATCH' || x.code === 'HOST_MISMATCH' || x.code === 'PROTOCOL');
                reject(fatal ?? errors[0] ?? new ClientError('HOST_UNREACHABLE', 'Sunucuya ulaşılamadı.'));
              }
            });
        }, i * 150);
      });
    });
  }

  private attach(a: Attempt): void {
    this.ws = a.ws;
    const ws = a.ws;
    ws.on('message', (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (frame.t === 'res') {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.data);
        else p.reject(new ClientError(frame.error.code, frame.error.message));
      } else if (frame.t === 'evt') {
        if (frame.e === 'session.ended') this.onSessionEnded((frame.d as { reason: SessionEndReason }).reason);
        this.emit('event', frame.e as ServerEventName, frame.d);
      }
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.detach();
      if (this.closedByUser) return;
      const announced = this.status.state === 'connected' ? this.status.error : null;
      if (announced) return this.handleFailure(new ClientError(String(announced.code), announced.message));
      if (code === 4002) return this.handleFailure(new ClientError('KICKED', 'Sunucu yöneticisi sizi çıkardı. Tekrar bağlanabilirsiniz.'));
      if (code === 4003) return this.handleFailure(new ClientError('BANNED', 'Bu sunucuda erişiminiz kapatıldı.'));
      if (code === 4005) return this.handleFailure(new ClientError('REPLACED', 'Bu hesap başka bir pencerede/oturumda açıldı.'));
      if (code === 4004) return this.handleFailure(new ClientError('HOST_SHUTDOWN', 'Sunucu yeniden başlatılıyor. Açıldığında otomatik bağlanılacak.'));
      this.handleFailure(new ClientError('HOST_UNREACHABLE', 'Sunucu ile bağlantı koptu.'));
    });
    ws.on('error', () => {
      /* close follows */
    });
    ws.on('ping', () => this.bumpPing());
    this.bumpPing();
  }

  /** The host pings every 15s; missing pings for 40s means the link is dead. */
  private bumpPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      log.warn('host heartbeat lost');
      this.ws?.terminate();
    }, 40_000);
  }

  private onSessionEnded(reason: SessionEndReason): void {
    const map: Record<SessionEndReason, [string, string]> = {
      kicked: ['KICKED', 'Sunucu yöneticisi sizi çıkardı. Tekrar bağlanabilirsiniz.'],
      banned: ['BANNED', 'Bu sunucuda erişiminiz kapatıldı.'],
      device_revoked: ['DEVICE_UNKNOWN', 'Bu cihazın erişimi iptal edildi.'],
      host_shutdown: ['HOST_SHUTDOWN', 'Sunucu yeniden başlatılıyor. Açıldığında otomatik bağlanılacak.'],
      replaced: ['REPLACED', 'Bu hesap başka bir oturumda açıldı.'],
    };
    const [code, message] = map[reason];
    this.setStatus({ error: { code, message } });
  }

  private detach(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ClientError('OFFLINE', 'Sunucu bağlantısı yok.'));
    }
    this.pending.clear();
    try {
      ws?.terminate();
    } catch {
      /* ignore */
    }
  }

  private handleFailure(err: ClientError): void {
    log.warn('connection failed', { code: err.code });
    const fatal = FATAL_CODES.has(err.code) || this.auth.kind === 'register';
    if (fatal) {
      this.setStatus({ state: 'failed', error: { code: err.code, message: err.message }, nextRetryAt: null, pathKind: null });
      return;
    }
    this.attempt++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    const keepError = this.status.error?.code === 'HOST_SHUTDOWN' && err.code === 'HOST_UNREACHABLE' ? this.status.error : { code: err.code, message: err.message };
    this.setStatus({ state: 'reconnecting', error: keepError, attempt: this.attempt, nextRetryAt: Date.now() + delay, pathKind: null });
    this.retryTimer = setTimeout(() => void this.run(), delay);
  }

  retryNow(): void {
    if (this.status.state === 'connected') return;
    this.closedByUser = false;
    this.attempt = Math.max(this.attempt, 1);
    void this.run();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.abort?.abort();
    this.detach();
    this.setStatus({ state: 'idle', error: null, nextRetryAt: null, pathKind: null, address: null });
  }

  private rawRequest(frame: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new ClientError('OFFLINE', 'Sunucu bağlantısı yok.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ClientError('TIMEOUT', 'Sunucu zamanında yanıt vermedi.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...frame, id }));
    });
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.status.state !== 'connected') return Promise.reject(new ClientError('OFFLINE', 'Sunucu bağlantısı yok.'));
    return this.rawRequest({ t: 'req', m: method, p: params }) as Promise<RpcResult<M>>;
  }
}

export type { ErrorCode };
