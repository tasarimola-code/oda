import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { HostDb, dmKey, inviteInfo, roomKey, userPublic, type InviteRow, type MessageRow, type RoomRow, type UserRow } from './db';
import { RateLimiter } from './rateLimit';
import type { TlsMaterial } from './tls';
import { participantToken, proxyHttp, proxyUpgrade, removeParticipant, sfuUpstreamPath, tokenSubject, type SfuConfig } from './livekit';
import { encodeInvite } from '../../shared/invite';
import {
  AVATAR_COLORS,
  HISTORY_PAGE_SIZE,
  MAX_FRAME_BYTES,
  MAX_ROOM_CAPACITY,
  MAX_SFU_ROOM_CAPACITY,
  MIN_ROOM_CAPACITY,
  PROTOCOL_VERSION,
  SFU_PATH,
  WS_PATH,
  authPayload,
  type Bootstrap,
  type ChatMessage,
  type ClientFrame,
  type ConvRef,
  type ErrorCode,
  type HostInfo,
  type InviteInfo,
  type InviteLimits,
  type Role,
  type RoomInfo,
  type RpcMethod,
  type RtcSignal,
  type ServerEventName,
  type ServerEvents,
  type ServerFrame,
  type SessionEndReason,
  type UserPublic,
  type VoiceParticipant,
  RPC_METHODS,
} from '../../shared/protocol';
import { isClientId, isColor, isId, nameKey, normalizeDisplayName, normalizeMessageBody, normalizeRoomName } from '../../shared/validate';
import { createLogger, errMessage, type Logger } from '../logger';

export class RpcError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const AUTH_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 15_000;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_IP = 8;
const DESKTOP_INVITE_LIMITS: InviteLimits = { maxUses: 50, maxMinutes: 7 * 24 * 60 };
const SERVER_INVITE_LIMITS: InviteLimits = { maxUses: 1000, maxMinutes: 90 * 24 * 60 };
/** Default capacity of the room created for a new community. */
export const DEFAULT_SERVER_ROOM_CAPACITY = 25;
/** Rooms one non-admin user may own at a time. */
export const MAX_OWNED_ROOMS = 5;
const MAX_ROOMS_CLOSED = 50;
const MAX_ROOMS_OPEN = 5000;

export const CLOSE = {
  AUTH_FAILED: 4001,
  KICKED: 4002,
  BANNED: 4003,
  SHUTDOWN: 4004,
  REPLACED: 4005,
  RATE_LIMITED: 4008,
  AUTH_TIMEOUT: 4009,
  PROTOCOL: 4010,
} as const;

interface Conn {
  id: string;
  ws: WebSocket;
  ip: string;
  nonce: string;
  alive: boolean;
  userId: string | null;
  deviceId: string | null;
  authTimer: NodeJS.Timeout | null;
}

interface VoiceEntry extends VoiceParticipant {
  connId: string;
}

export interface HostServerOptions {
  db: HostDb;
  tls: TlsMaterial;
  port: number;
  bindAddress?: string;
  advertisedAddresses: () => string[];
  logger?: Logger;
  /** Media server for voice; without it voice is a peer-to-peer mesh. */
  sfu?: SfuConfig | null;
  /** Always-on server deployment (larger invite limits, no desktop owner). */
  dedicated?: boolean;
  maxConnections?: number;
  /** Accounts can be created without an invite; every user may create and invite into their own private rooms. */
  openRegistration?: boolean;
}

export function hashInviteSecret(secret: string): string {
  return createHash('sha256').update('oda-invite:' + secret).digest('hex');
}

/** Stores a new invite and returns its shareable code. The secret itself is never stored. */
export function issueInvite(
  db: HostDb,
  o: { hostId: string; addresses: string[]; port: number; fingerprint: string; createdBy: string | null; roomId: string | null; maxUses: number; minutes: number; role?: Role },
): { row: ReturnType<HostDb['createInvite']>; code: string } {
  const secret = randomBytes(24).toString('base64url');
  const row = db.createInvite({ tokenHash: hashInviteSecret(secret), createdBy: o.createdBy, roomId: o.roomId, maxUses: o.maxUses, expiresAt: Date.now() + o.minutes * 60_000, role: o.role });
  const code = encodeInvite({ h: o.hostId, n: db.getMeta('host_name') ?? 'ODA', a: o.addresses, p: o.port, f: o.fingerprint, s: secret });
  return { row, code };
}

function b64ToKey(publicKey: string) {
  if (typeof publicKey !== 'string' || publicKey.length > 200) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function isRtcSignal(v: unknown): v is RtcSignal {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  switch (s.type) {
    case 'offer':
      return typeof s.sdp === 'string' && s.sdp.length < 60_000 && (s.restart === undefined || typeof s.restart === 'boolean');
    case 'answer':
      return typeof s.sdp === 'string' && s.sdp.length < 60_000;
    case 'candidate':
      return (
        typeof s.candidate === 'string' &&
        s.candidate.length < 2000 &&
        (s.sdpMid === null || typeof s.sdpMid === 'string') &&
        (s.sdpMLineIndex === null || typeof s.sdpMLineIndex === 'number')
      );
    case 'bye':
      return true;
    default:
      return false;
  }
}

export class HostServer {
  private readonly db: HostDb;
  private readonly tls: TlsMaterial;
  private readonly log: Logger;
  private server: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private conns = new Map<string, Conn>();
  private online = new Map<string, Set<Conn>>();
  private voice = new Map<string, Map<string, VoiceEntry>>();
  private voiceRoomOf = new Map<string, string>();

  private connLimiter = new RateLimiter(20, 0.5);
  private authLimiter = new RateLimiter(10, 1 / 6);
  private inviteFailLimiter = new RateLimiter(5, 1 / 60);
  /** New accounts without an invite, per IP: a burst of 5, then one every 10 minutes. */
  private signupLimiter = new RateLimiter(5, 1 / 600);
  private roomCreateLimiter = new RateLimiter(5, 1 / 120);
  private rpcLimiter = new RateLimiter(40, 10);
  private msgLimiter = new RateLimiter(10, 2);
  private signalLimiter = new RateLimiter(300, 60);

  readonly port: number;
  private readonly bindAddress: string;
  private readonly advertisedAddresses: () => string[];
  readonly hostId: string;
  private readonly sfu: SfuConfig | null;
  private readonly dedicated: boolean;
  private readonly maxConnections: number;
  private readonly maxCapacity: number;
  private readonly inviteLimits: InviteLimits;
  private readonly openRegistration: boolean;

  constructor(opts: HostServerOptions) {
    this.db = opts.db;
    this.tls = opts.tls;
    this.port = opts.port;
    this.bindAddress = opts.bindAddress ?? '0.0.0.0';
    this.advertisedAddresses = opts.advertisedAddresses;
    this.log = opts.logger ?? createLogger('host');
    this.sfu = opts.sfu ?? null;
    this.dedicated = opts.dedicated ?? false;
    this.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
    this.maxCapacity = this.sfu ? MAX_SFU_ROOM_CAPACITY : MAX_ROOM_CAPACITY;
    this.inviteLimits = this.dedicated ? SERVER_INVITE_LIMITS : DESKTOP_INVITE_LIMITS;
    this.openRegistration = opts.openRegistration ?? false;
    const hostId = this.db.getMeta('host_id');
    if (!hostId) throw new Error('Host veritabanı başlatılmamış.');
    this.hostId = hostId;
  }

  // ---------------------------------------------------------------- lifecycle
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = https.createServer({ key: this.tls.key, cert: this.tls.cert, minVersion: 'TLSv1.2' }, (req, res) => {
        const sfuPath = this.sfu ? sfuUpstreamPath(req.url ?? '', SFU_PATH) : null;
        const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
        if (sfuPath && this.sfu && this.connLimiter.take(ip) && this.sfuAllowed(req.url ?? '')) return proxyHttp(this.sfu, sfuPath, req, res, ip);
        res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('ODA');
      });
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: false });
      server.on('upgrade', (req, socket, head) => this.onUpgrade(wss, req, socket, head));
      server.on('tlsClientError', () => {
        /* scanners and failed handshakes are expected on open ports */
      });
      const onError = (e: Error) => {
        server.removeListener('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (e) => this.log.error('server error', { err: errMessage(e) }));
        this.server = server;
        this.wss = wss;
        this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
        this.log.info('host listening', { port: this.port, bind: this.bindAddress });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.bindAddress);
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of [...this.conns.values()]) {
      this.endSession(c, 'host_shutdown', CLOSE.SHUTDOWN);
    }
    this.conns.clear();
    this.online.clear();
    this.voice.clear();
    this.voiceRoomOf.clear();
    const server = this.server;
    this.server = null;
    this.wss?.close();
    this.wss = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        setTimeout(resolve, 1500);
      });
    }
    this.log.info('host stopped');
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  get onlineUserCount(): number {
    return this.online.size;
  }

  hostInfo(): HostInfo {
    const ownerId = this.db.getMeta('owner_id');
    const owner = ownerId ? this.db.getUser(ownerId) : undefined;
    return {
      hostId: this.hostId,
      hostName: this.db.getMeta('host_name') ?? 'ODA',
      ownerName: owner?.display_name ?? '',
      addresses: this.advertisedAddresses(),
      port: this.port,
      fingerprint: this.tls.fingerprint,
      media: this.sfu ? 'sfu' : 'mesh',
      maxRoomCapacity: this.maxCapacity,
      dedicated: this.dedicated,
      openRegistration: this.openRegistration,
      maxOwnedRooms: MAX_OWNED_ROOMS,
      inviteLimits: { ...this.inviteLimits },
    };
  }

  // ---------------------------------------------------------------- transport
  /** A media server connection is allowed only while its token holder is in that voice room here. */
  private sfuAllowed(url: string): boolean {
    if (!this.sfu) return false;
    const sub = tokenSubject(this.sfu, url);
    if (!sub || this.voiceRoomOf.get(sub.identity) !== sub.room) return false;
    const u = this.db.getUser(sub.identity);
    return !!u && u.status === 'active';
  }

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const url = req.url ?? '';
    const sfuPath = this.sfu ? sfuUpstreamPath(url, SFU_PATH) : null;
    if (sfuPath && this.sfu) {
      if (!this.connLimiter.take(ip)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!this.sfuAllowed(url)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      proxyUpgrade(this.sfu, sfuPath, req, socket, head, ip);
      return;
    }
    const perIp = [...this.conns.values()].filter((c) => c.ip === ip).length;
    if (url !== WS_PATH || !this.connLimiter.take(ip) || this.conns.size >= this.maxConnections || perIp >= MAX_CONNECTIONS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const conn: Conn = {
      id: randomBytes(8).toString('hex'),
      ws,
      ip,
      nonce: randomBytes(32).toString('base64'),
      alive: true,
      userId: null,
      deviceId: null,
      authTimer: null,
    };
    this.conns.set(conn.id, conn);
    conn.authTimer = setTimeout(() => {
      if (!conn.userId) ws.close(CLOSE.AUTH_TIMEOUT, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(CLOSE.PROTOCOL, 'binary');
        return;
      }
      void this.onFrame(conn, data);
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => {
      /* close follows */
    });
    this.send(conn, { t: 'hello', protocol: PROTOCOL_VERSION, hostId: this.hostId, hostName: this.db.getMeta('host_name') ?? 'ODA', nonce: conn.nonce, dedicated: this.dedicated });
  }

  private tick(): void {
    for (const c of this.conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* closed */
      }
    }
  }

  private send(conn: Conn, frame: ServerFrame): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  private emit<E extends ServerEventName>(conn: Conn, e: E, d: ServerEvents[E]): void {
    this.send(conn, { t: 'evt', e, d });
  }

  private emitToUser<E extends ServerEventName>(userId: string, e: E, d: ServerEvents[E]): void {
    for (const c of this.online.get(userId) ?? []) this.emit(c, e, d);
  }

  private emitToAll<E extends ServerEventName>(e: E, d: ServerEvents[E], filter?: (userId: string) => boolean): void {
    for (const [uid, set] of this.online) {
      if (filter && !filter(uid)) continue;
      for (const c of set) this.emit(c, e, d);
    }
  }

  private onClose(conn: Conn): void {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    this.conns.delete(conn.id);
    const uid = conn.userId;
    if (!uid) return;
    const roomId = this.voiceRoomOf.get(uid);
    if (roomId && this.voice.get(roomId)?.get(uid)?.connId === conn.id) this.leaveVoice(uid);
    const set = this.online.get(uid);
    if (set) {
      set.delete(conn);
      if (set.size === 0) {
        this.online.delete(uid);
        this.db.touchUser(uid);
        this.emitToAll('presence', { userId: uid, online: false }, (other) => this.canSeeUser(other, uid));
      }
    }
  }

  private endSession(conn: Conn, reason: SessionEndReason, code: number): void {
    this.emit(conn, 'session.ended', { reason });
    setTimeout(() => {
      try {
        conn.ws.close(code, reason);
      } catch {
        /* ignore */
      }
    }, 50);
  }

  private async onFrame(conn: Conn, data: RawData): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(data.toString()) as ClientFrame;
    } catch {
      conn.ws.close(CLOSE.PROTOCOL, 'bad json');
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.id !== 'number') {
      conn.ws.close(CLOSE.PROTOCOL, 'bad frame');
      return;
    }
    const id = frame.id;
    try {
      let result: unknown;
      if (frame.t === 'auth.register' || frame.t === 'auth.login') {
        if (conn.userId) throw new RpcError('PROTOCOL', 'Zaten oturum açıldı.');
        if (!this.authLimiter.take(conn.ip)) throw new RpcError('RATE_LIMITED', 'Çok fazla deneme. Biraz bekleyin.');
        result = frame.t === 'auth.register' ? this.register(conn, frame) : this.login(conn, frame);
      } else if (frame.t === 'req') {
        if (!conn.userId) throw new RpcError('UNAUTHORIZED', 'Önce oturum açın.');
        if (typeof frame.m !== 'string' || !(RPC_METHODS as readonly string[]).includes(frame.m)) throw new RpcError('BAD_REQUEST', 'Bilinmeyen istek.');
        const m = frame.m as RpcMethod;
        const limiter = m === 'rtc.signal' ? this.signalLimiter : m === 'messages.send' ? this.msgLimiter : this.rpcLimiter;
        if (!limiter.take(conn.userId)) throw new RpcError('RATE_LIMITED', 'Çok hızlı istek gönderiliyor.');
        const user = this.db.getUser(conn.userId);
        if (!user || user.status !== 'active') {
          this.endSession(conn, 'banned', CLOSE.BANNED);
          throw new RpcError('BANNED', 'Bu sunucuda erişiminiz kapatıldı.');
        }
        const params = (frame.p && typeof frame.p === 'object' ? frame.p : {}) as Record<string, unknown>;
        result = this.dispatch(conn, user, m, params);
      } else {
        throw new RpcError('PROTOCOL', 'Bilinmeyen çerçeve.');
      }
      this.send(conn, { t: 'res', id, ok: true, data: result });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError('INTERNAL', 'Sunucuda beklenmeyen hata.');
      if (!(e instanceof RpcError)) this.log.error('rpc failed', { err: errMessage(e), type: frame.t === 'req' ? frame.m : frame.t });
      this.send(conn, { t: 'res', id, ok: false, error: { code: err.code, message: err.message } });
      if ((frame.t === 'auth.register' || frame.t === 'auth.login') && !conn.userId) {
        setTimeout(() => conn.ws.close(CLOSE.AUTH_FAILED, 'auth failed'), 100);
      }
    }
  }

  // ---------------------------------------------------------------- auth
  private verifySignature(conn: Conn, publicKey: string, signature: unknown): void {
    const key = b64ToKey(publicKey);
    if (!key || typeof signature !== 'string' || signature.length > 200) throw new RpcError('BAD_REQUEST', 'Geçersiz cihaz anahtarı.');
    const ok = cryptoVerify(null, Buffer.from(authPayload(this.hostId, conn.nonce, publicKey)), key, Buffer.from(signature, 'base64'));
    if (!ok) throw new RpcError('UNAUTHORIZED', 'Cihaz imzası doğrulanamadı.');
  }

  /** Validates an invite secret; failed attempts count against the caller's IP. */
  private checkInvite(ip: string, secret: unknown): InviteRow {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(secret)) throw new RpcError('INVITE_INVALID', 'Davet kodu geçersiz.');
    if (!this.inviteFailLimiter.canTake(ip)) throw new RpcError('RATE_LIMITED', 'Çok fazla hatalı davet denemesi. Daha sonra tekrar deneyin.');
    const invite = this.db.getInviteByHash(hashInviteSecret(secret));
    const failInvite = (code: ErrorCode, msg: string): never => {
      this.inviteFailLimiter.take(ip);
      throw new RpcError(code, msg);
    };
    if (!invite || invite.revoked_at) return failInvite('INVITE_INVALID', 'Davet geçersiz veya iptal edilmiş.');
    if (invite.expires_at < Date.now()) return failInvite('INVITE_EXPIRED', 'Davetin süresi dolmuş. Davet edenden yeni kod isteyin.');
    if (invite.uses >= invite.max_uses) return failInvite('INVITE_USED', 'Bu davetin kullanım hakkı dolmuş. Davet edenden yeni kod isteyin.');
    if (invite.room_id && !this.db.getRoom(invite.room_id)) return failInvite('INVITE_INVALID', 'Davetin odası silinmiş.');
    return invite;
  }

  private register(conn: Conn, f: Extract<ClientFrame, { t: 'auth.register' }>): { userId: string } {
    const withInvite = f.invite !== undefined && f.invite !== null && f.invite !== '';
    if (!withInvite && !this.openRegistration) throw new RpcError('INVITE_INVALID', 'Bu sunucuya yalnızca davetle katılınabilir.');
    const invite = withInvite ? this.checkInvite(conn.ip, f.invite) : null;
    if (!invite && !this.signupLimiter.canTake(conn.ip)) throw new RpcError('RATE_LIMITED', 'Bu ağdan çok fazla yeni hesap açıldı. Biraz sonra tekrar deneyin.');
    const displayName = normalizeDisplayName(f.displayName);
    if (!displayName) throw new RpcError('BAD_REQUEST', 'Görünen ad 2–32 karakter olmalı.');
    const key = nameKey(displayName);
    if (this.db.getUserByNameKey(key)) throw new RpcError('NAME_TAKEN', 'Bu görünen ad bu sunucuda kullanılıyor. Başka bir ad seçin.');
    this.verifySignature(conn, f.publicKey, f.signature);
    if (this.db.getDeviceByKey(f.publicKey)) throw new RpcError('BAD_REQUEST', 'Bu cihaz anahtarı zaten kayıtlı.');
    const deviceName = typeof f.deviceName === 'string' ? f.deviceName.slice(0, 64) : 'Windows';
    if (!invite) this.signupLimiter.take(conn.ip);

    const user = this.db.db.transaction(() => {
      if (invite && !this.db.incrementInviteUse(invite.id)) throw new RpcError('INVITE_USED', 'Bu davetin kullanım hakkı dolmuş.');
      const color = AVATAR_COLORS[this.db.countUsers() % AVATAR_COLORS.length];
      const role = invite?.role === 'admin' ? 'admin' : 'member';
      const u = this.db.createUser({ displayName, nameKey: key, color, role });
      const dev = this.db.addDevice(u.id, f.publicKey, deviceName);
      if (role === 'admin' && !this.db.getMeta('owner_id')) this.db.setMeta('owner_id', u.id);
      // An invite-only community starts without rooms; the first admin gets the default one.
      if (!this.openRegistration && role === 'admin' && this.db.listRooms().length === 0) {
        this.db.createRoom({ name: 'Genel', isPrivate: false, capacity: Math.min(this.maxCapacity, DEFAULT_SERVER_ROOM_CAPACITY), createdBy: u.id });
      }
      if (invite?.room_id) this.db.addRoomMember(invite.room_id, u.id);
      for (const r of this.db.listRooms()) {
        this.db.setReadState(u.id, roomKey(r.id), this.db.maxMessageId(roomKey(r.id)));
      }
      return { u, dev };
    })();
    this.log.info('user registered', { user: user.u.id, role: user.u.role, invited: !!invite });
    this.completeAuth(conn, user.u, user.dev.id);
    this.emitToAll('user.added', { user: this.pub(user.u, true) }, (uid) => uid !== user.u.id && this.canSeeUser(uid, user.u.id));
    return { userId: user.u.id };
  }

  private login(conn: Conn, f: Extract<ClientFrame, { t: 'auth.login' }>): { userId: string } {
    if (typeof f.publicKey !== 'string') throw new RpcError('BAD_REQUEST', 'Geçersiz istek.');
    const dev = this.db.getDeviceByKey(f.publicKey);
    if (!dev || dev.revoked_at) throw new RpcError('DEVICE_UNKNOWN', 'Bu cihaz bu sunucuda tanınmıyor. Bu cihazda ilk kez giriş yapıyorsan oda oluştur veya davet koduyla katıl.');
    this.verifySignature(conn, f.publicKey, f.signature);
    const user = this.db.getUser(dev.user_id);
    if (!user) throw new RpcError('DEVICE_UNKNOWN', 'Hesap bulunamadı.');
    if (user.status === 'banned') throw new RpcError('BANNED', 'Bu sunucuda erişiminiz kapatıldı.');
    this.completeAuth(conn, user, dev.id);
    return { userId: user.id };
  }

  private completeAuth(conn: Conn, user: UserRow, deviceId: string): void {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    conn.authTimer = null;
    // A device keeps a single live session; older one is closed.
    for (const other of this.online.get(user.id) ?? []) {
      if (other.deviceId === deviceId && other !== conn) this.endSession(other, 'replaced', CLOSE.REPLACED);
    }
    conn.userId = user.id;
    conn.deviceId = deviceId;
    this.db.touchDevice(deviceId);
    this.db.touchUser(user.id);
    let set = this.online.get(user.id);
    const wasOnline = !!set && set.size > 0;
    if (!set) {
      set = new Set();
      this.online.set(user.id, set);
    }
    set.add(conn);
    if (!wasOnline) this.emitToAll('presence', { userId: user.id, online: true }, (uid) => uid !== user.id && this.canSeeUser(uid, user.id));
  }

  // ---------------------------------------------------------------- helpers
  private isOnline(userId: string): boolean {
    return (this.online.get(userId)?.size ?? 0) > 0;
  }

  private pub(u: UserRow, online = this.isOnline(u.id)): UserPublic {
    return userPublic(u, online, this.voiceRoomOf.get(u.id) ?? null);
  }

  /**
   * On an open server strangers share one database, so a user only sees people they share a room with,
   * friends (incl. pending requests) and DM partners. Admins and invite-only communities see everyone.
   */
  private canSeeUser(viewerId: string, targetId: string): boolean {
    if (!this.openRegistration || viewerId === targetId) return true;
    if (this.db.getUser(viewerId)?.role === 'admin') return true;
    return this.db.areRelated(viewerId, targetId);
  }

  private canAccessRoom(user: UserRow, room: RoomRow): boolean {
    if (!room.is_private || this.db.isRoomMember(room.id, user.id)) return true;
    // Steam-style: a friend's own channels are visible and joinable without a fresh invite.
    if (this.openRegistration && room.created_by && this.db.areFriends(user.id, room.created_by)) return true;
    // Admins of an open server moderate users but do not see strangers' private rooms.
    return user.role === 'admin' && !this.openRegistration;
  }

  private roomsOwnedBy(userId: string): RoomRow[] {
    return this.db.listRooms().filter((r) => r.created_by === userId);
  }

  /** Lets a new friend see the other person's channels immediately. */
  private shareOwnedRooms(ownerId: string, viewerId: string): void {
    const owner = this.db.getUser(ownerId);
    if (owner) this.emitToUser(viewerId, 'user.added', { user: this.pub(owner) });
    for (const room of this.roomsOwnedBy(ownerId)) this.emitToUser(viewerId, 'room.updated', { room: this.roomInfo(room) });
  }

  /** Drops friendship-only access; people added with an invite stay in the room. */
  private revokeFriendRoomAccess(ownerId: string, viewerId: string): void {
    for (const room of this.roomsOwnedBy(ownerId)) {
      if (this.db.isRoomMember(room.id, viewerId)) continue;
      if (this.voiceRoomOf.get(viewerId) === room.id) this.leaveVoice(viewerId);
      this.emitToUser(viewerId, 'room.removed', { roomId: room.id });
    }
  }

  private isRoomOwner(user: UserRow, room: RoomRow): boolean {
    return room.created_by === user.id || (user.role === 'admin' && this.canAccessRoom(user, room));
  }

  private requireRoomOwner(user: UserRow, roomId: unknown): RoomRow {
    const room = this.requireRoom(user, roomId);
    if (!this.isRoomOwner(user, room)) throw new RpcError('FORBIDDEN', 'Bu işlemi yalnızca odayı kuran kişi yapabilir.');
    return room;
  }

  private canAccessRoomById(userId: string, room: RoomRow): boolean {
    const u = this.db.getUser(userId);
    return !!u && u.status === 'active' && this.canAccessRoom(u, room);
  }

  private voiceList(roomId: string): VoiceParticipant[] {
    return [...(this.voice.get(roomId)?.values() ?? [])]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(({ userId, muted, deafened, joinedAt }) => ({ userId, muted, deafened, joinedAt }));
  }

  private roomInfo(r: RoomRow): RoomInfo {
    return { id: r.id, name: r.name, isPrivate: !!r.is_private, capacity: r.capacity, createdAt: r.created_at, ownerId: r.created_by ?? null, voice: this.voiceList(r.id) };
  }

  private requireRoom(user: UserRow, roomId: unknown): RoomRow {
    if (!isId(roomId)) throw new RpcError('BAD_REQUEST', 'Geçersiz oda.');
    const room = this.db.getRoom(roomId);
    if (!room || !this.canAccessRoom(user, room)) throw new RpcError('NOT_FOUND', 'Oda bulunamadı veya erişim izniniz yok.');
    return room;
  }

  private requireAdmin(user: UserRow): void {
    if (user.role !== 'admin') throw new RpcError('FORBIDDEN', 'Bu işlem için yönetici olmalısınız.');
  }

  private requireUser(id: unknown): UserRow {
    if (!isId(id)) throw new RpcError('BAD_REQUEST', 'Geçersiz kullanıcı.');
    const u = this.db.getUser(id);
    if (!u) throw new RpcError('NOT_FOUND', 'Kullanıcı bulunamadı.');
    return u;
  }

  private viewConv(canonical: string, viewerId: string): string {
    if (canonical.startsWith('dm:')) {
      const [, a, b] = canonical.split(':');
      return `dm:${a === viewerId ? b : a}`;
    }
    return canonical;
  }

  private toChat(r: MessageRow, viewerId: string): ChatMessage {
    return { id: r.id, conv: this.viewConv(r.conv_key, viewerId), senderId: r.sender_id, body: r.body, createdAt: r.created_at, clientId: r.client_id };
  }

  /** Resolves a conversation reference to its canonical key after access checks. */
  private resolveConv(user: UserRow, ref: unknown, forWrite: boolean): { key: string; room: RoomRow | null; other: UserRow | null } {
    const r = ref as ConvRef | undefined;
    if (!r || typeof r !== 'object') throw new RpcError('BAD_REQUEST', 'Geçersiz sohbet.');
    if (r.kind === 'room') {
      const room = this.requireRoom(user, r.roomId);
      return { key: roomKey(room.id), room, other: null };
    }
    if (r.kind === 'dm') {
      const other = this.requireUser(r.userId);
      if (other.id === user.id) throw new RpcError('BAD_REQUEST', 'Kendinize mesaj gönderemezsiniz.');
      if (forWrite) {
        if (this.db.isBlockedEither(user.id, other.id)) throw new RpcError('BLOCKED', 'Bu kişiyle mesajlaşma engellenmiş.');
        if (!this.db.areFriends(user.id, other.id)) throw new RpcError('NOT_FRIENDS', 'Özel mesaj için önce arkadaş olmalısınız.');
        if (other.status !== 'active') throw new RpcError('FORBIDDEN', 'Bu kullanıcıya mesaj gönderilemiyor.');
      }
      return { key: dmKey(user.id, other.id), room: null, other };
    }
    throw new RpcError('BAD_REQUEST', 'Geçersiz sohbet.');
  }

  private notifyFriends(...userIds: string[]): void {
    for (const uid of userIds) this.emitToUser(uid, 'friends.updated', { friends: this.db.listFriends(uid) });
  }

  private broadcastRoom(room: RoomRow): void {
    const info = this.roomInfo(room);
    this.emitToAll('room.updated', { room: info }, (uid) => this.canAccessRoomById(uid, room));
  }

  private leaveVoice(userId: string): void {
    const roomId = this.voiceRoomOf.get(userId);
    if (!roomId) return;
    this.voiceRoomOf.delete(userId);
    if (this.sfu) {
      removeParticipant(this.sfu, roomId, userId).catch((e) => this.log.warn('media server remove failed', { room: roomId, err: errMessage(e) }));
    }
    const m = this.voice.get(roomId);
    m?.delete(userId);
    if (m && m.size === 0) this.voice.delete(roomId);
    const room = this.db.getRoom(roomId);
    const participants = this.voiceList(roomId);
    if (room) this.emitToAll('voice.update', { roomId, participants }, (uid) => this.canAccessRoomById(uid, room));
    else this.emitToUser(userId, 'voice.update', { roomId, participants });
    const user = this.db.getUser(userId);
    if (user) this.emitToAll('user.updated', { user: this.pub(user) }, (uid) => this.canSeeUser(uid, userId));
  }

  private createInvite(me: UserRow, roomId: string | null, p: Record<string, unknown>): { invite: InviteInfo; code: string } {
    const minutes = Math.round(Number(p.expiresInMinutes));
    const maxUses = Math.round(Number(p.maxUses));
    const lim = this.inviteLimits;
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > lim.maxMinutes) throw new RpcError('BAD_REQUEST', `Süre 5 dakika ile ${Math.round(lim.maxMinutes / 1440)} gün arası olmalı.`);
    if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > lim.maxUses) throw new RpcError('BAD_REQUEST', `Kullanım sayısı 1–${lim.maxUses} arası olmalı.`);
    const addresses = this.advertisedAddresses();
    if (addresses.length === 0) throw new RpcError('FORBIDDEN', 'Davete eklenecek ağ adresi bulunamadı. Ağ bağlantınızı kontrol edin.');
    const { row, code } = issueInvite(this.db, { hostId: this.hostId, addresses, port: this.port, fingerprint: this.tls.fingerprint, createdBy: me.id, roomId, maxUses, minutes });
    this.log.info('invite created', { invite: row.id, maxUses, minutes, room: !!roomId });
    return { invite: inviteInfo(row), code };
  }

  /** Makes a user a member of a room and introduces them to the room's other members. */
  private addToRoom(room: RoomRow, user: UserRow): void {
    this.db.addRoomMember(room.id, user.id);
    this.db.setReadState(user.id, roomKey(room.id), this.db.maxMessageId(roomKey(room.id)));
    const members = this.db.roomMembers(room.id).filter((id) => id !== user.id);
    for (const id of members) {
      const m = this.db.getUser(id);
      if (!m || m.status !== 'active') continue;
      this.emitToUser(id, 'user.added', { user: this.pub(user, this.isOnline(user.id)) });
      this.emitToUser(user.id, 'user.added', { user: this.pub(m, this.isOnline(m.id)) });
    }
    this.emitToUser(user.id, 'room.updated', { room: this.roomInfo(room) });
  }

  private kickUser(userId: string, reason: SessionEndReason, code: number): void {
    this.leaveVoice(userId);
    for (const c of this.online.get(userId) ?? []) this.endSession(c, reason, code);
  }

  // ---------------------------------------------------------------- dispatch
  private dispatch(conn: Conn, me: UserRow, m: RpcMethod, p: Record<string, unknown>): unknown {
    switch (m) {
      case 'state.bootstrap':
        return this.bootstrap(me);

      case 'profile.update': {
        let displayName = me.display_name;
        let key = me.name_key;
        if (p.displayName !== undefined) {
          const n = normalizeDisplayName(p.displayName);
          if (!n) throw new RpcError('BAD_REQUEST', 'Görünen ad 2–32 karakter olmalı.');
          const k = nameKey(n);
          const existing = this.db.getUserByNameKey(k);
          if (existing && existing.id !== me.id) throw new RpcError('NAME_TAKEN', 'Bu görünen ad kullanılıyor.');
          displayName = n;
          key = k;
        }
        let color = me.color;
        if (p.color !== undefined) {
          if (!isColor(p.color)) throw new RpcError('BAD_REQUEST', 'Geçersiz renk.');
          color = p.color;
        }
        this.db.updateUserProfile(me.id, displayName, key, color);
        const updated = this.pub(this.db.getUser(me.id)!, true);
        this.emitToAll('user.updated', { user: updated }, (uid) => this.canSeeUser(uid, me.id));
        return updated;
      }

      case 'users.search': {
        const q = typeof p.q === 'string' ? nameKey(p.q).slice(0, 32) : '';
        if (!q || (this.openRegistration && q.length < 3)) return [];
        return this.db
          .searchUsers(q)
          .filter((u) => u.id !== me.id && (me.role === 'admin' || u.status === 'active'))
          .map((u) => this.pub(u, this.isOnline(u.id)));
      }

      case 'friends.request': {
        const other = this.requireUser(p.userId);
        if (other.id === me.id) throw new RpcError('BAD_REQUEST', 'Kendinize istek gönderemezsiniz.');
        if (other.status !== 'active') throw new RpcError('FORBIDDEN', 'Bu kullanıcıya istek gönderilemiyor.');
        if (this.db.isBlockedEither(me.id, other.id)) throw new RpcError('BLOCKED', 'Engellenmiş bir kullanıcıya istek gönderilemez.');
        const f = this.db.getFriendship(me.id, other.id);
        if (!f) this.db.upsertFriendship(me.id, other.id, 'pending', me.id);
        else if (f.status === 'pending' && f.requester_id === other.id) {
          this.db.upsertFriendship(me.id, other.id, 'accepted', other.id);
          this.shareOwnedRooms(me.id, other.id);
          this.shareOwnedRooms(other.id, me.id);
        }
        if (!f && this.openRegistration) {
          this.emitToUser(other.id, 'user.added', { user: this.pub(me, true) });
          this.emitToUser(me.id, 'user.added', { user: this.pub(other, this.isOnline(other.id)) });
        }
        this.notifyFriends(other.id);
        return this.db.listFriends(me.id);
      }

      case 'friends.accept': {
        const other = this.requireUser(p.userId);
        const f = this.db.getFriendship(me.id, other.id);
        if (!f || f.status !== 'pending' || f.requester_id !== other.id) throw new RpcError('NOT_FOUND', 'Bekleyen istek bulunamadı.');
        if (this.db.isBlockedEither(me.id, other.id)) throw new RpcError('BLOCKED', 'Engellenmiş kullanıcı.');
        this.db.upsertFriendship(me.id, other.id, 'accepted', other.id);
        this.shareOwnedRooms(me.id, other.id);
        this.shareOwnedRooms(other.id, me.id);
        this.notifyFriends(other.id);
        return this.db.listFriends(me.id);
      }

      case 'friends.reject': {
        const other = this.requireUser(p.userId);
        const f = this.db.getFriendship(me.id, other.id);
        if (f && f.status === 'pending') this.db.deleteFriendship(me.id, other.id);
        this.notifyFriends(other.id);
        return this.db.listFriends(me.id);
      }

      case 'friends.remove': {
        const other = this.requireUser(p.userId);
        this.db.deleteFriendship(me.id, other.id);
        this.revokeFriendRoomAccess(me.id, other.id);
        this.revokeFriendRoomAccess(other.id, me.id);
        this.notifyFriends(other.id);
        return this.db.listFriends(me.id);
      }

      case 'blocks.add': {
        const other = this.requireUser(p.userId);
        if (other.id === me.id) throw new RpcError('BAD_REQUEST', 'Kendinizi engelleyemezsiniz.');
        this.db.addBlock(me.id, other.id);
        this.db.deleteFriendship(me.id, other.id);
        this.revokeFriendRoomAccess(me.id, other.id);
        this.revokeFriendRoomAccess(other.id, me.id);
        this.notifyFriends(other.id);
        return { blocked: this.db.listBlocked(me.id), friends: this.db.listFriends(me.id) };
      }

      case 'blocks.remove': {
        const other = this.requireUser(p.userId);
        this.db.removeBlock(me.id, other.id);
        return { blocked: this.db.listBlocked(me.id) };
      }

      case 'rooms.create': {
        if (!this.openRegistration) this.requireAdmin(me);
        const name = normalizeRoomName(p.name);
        if (!name) throw new RpcError('BAD_REQUEST', 'Oda adı 1–40 karakter olmalı.');
        const capacity = Number(p.capacity);
        if (!Number.isInteger(capacity) || capacity < MIN_ROOM_CAPACITY || capacity > this.maxCapacity) {
          throw new RpcError('BAD_REQUEST', `Kapasite ${MIN_ROOM_CAPACITY}–${this.maxCapacity} arası olmalı.`);
        }
        const maxRooms = this.openRegistration ? MAX_ROOMS_OPEN : MAX_ROOMS_CLOSED;
        if (this.db.listRooms().length >= maxRooms) throw new RpcError('FORBIDDEN', 'Sunucudaki oda sınırına ulaşıldı.');
        if (me.role !== 'admin' && this.db.countRoomsOwnedBy(me.id) >= MAX_OWNED_ROOMS) {
          throw new RpcError('FORBIDDEN', `En fazla ${MAX_OWNED_ROOMS} oda kurabilirsiniz. Yeni oda için kullanmadığınız bir odayı silin.`);
        }
        if (!this.roomCreateLimiter.take(me.id)) throw new RpcError('RATE_LIMITED', 'Çok hızlı oda oluşturuluyor. Biraz bekleyin.');
        // On an open server every room is private: only its creator and people with its invite see it.
        const isPrivate = this.openRegistration || p.isPrivate === true;
        const room = this.db.createRoom({ name, isPrivate, capacity, createdBy: me.id });
        this.broadcastRoom(room);
        return this.roomInfo(room);
      }

      case 'rooms.update': {
        const room = this.requireRoomOwner(me, p.roomId);
        const name = p.name === undefined ? room.name : normalizeRoomName(p.name);
        if (!name) throw new RpcError('BAD_REQUEST', 'Oda adı 1–40 karakter olmalı.');
        const capacity = p.capacity === undefined ? room.capacity : Number(p.capacity);
        if (!Number.isInteger(capacity) || capacity < MIN_ROOM_CAPACITY || capacity > this.maxCapacity) throw new RpcError('BAD_REQUEST', 'Geçersiz kapasite.');
        this.db.updateRoom(room.id, name, capacity);
        const updated = this.db.getRoom(room.id)!;
        this.broadcastRoom(updated);
        return this.roomInfo(updated);
      }

      case 'rooms.delete': {
        const room = this.requireRoomOwner(me, p.roomId);
        if (!this.openRegistration && this.db.listRooms().length <= 1) throw new RpcError('FORBIDDEN', 'Son oda silinemez.');
        const audience = [...this.online.keys()].filter((uid) => this.canAccessRoomById(uid, room));
        for (const uid of [...(this.voice.get(room.id)?.keys() ?? [])]) this.leaveVoice(uid);
        this.db.deleteRoom(room.id);
        for (const uid of audience) this.emitToUser(uid, 'room.removed', { roomId: room.id });
        return { ok: true };
      }

      case 'rooms.members': {
        const room = this.requireRoomOwner(me, p.roomId);
        return this.db.roomMembers(room.id);
      }

      case 'rooms.addMember': {
        const room = this.requireRoomOwner(me, p.roomId);
        const u = this.requireUser(p.userId);
        if (u.status !== 'active') throw new RpcError('FORBIDDEN', 'Bu kullanıcı eklenemez.');
        if (!this.canSeeUser(me.id, u.id)) throw new RpcError('NOT_FOUND', 'Kullanıcı bulunamadı.');
        this.addToRoom(room, u);
        return this.db.roomMembers(room.id);
      }

      case 'rooms.removeMember': {
        const room = this.requireRoomOwner(me, p.roomId);
        const u = this.requireUser(p.userId);
        if (u.id === room.created_by) throw new RpcError('FORBIDDEN', 'Odayı kuran kişi odadan çıkarılamaz.');
        if (u.role === 'admin' && !this.openRegistration) throw new RpcError('FORBIDDEN', 'Yönetici odadan çıkarılamaz.');
        this.db.removeRoomMember(room.id, u.id);
        if (room.is_private) {
          if (this.voiceRoomOf.get(u.id) === room.id) this.leaveVoice(u.id);
          this.emitToUser(u.id, 'room.removed', { roomId: room.id });
        }
        return this.db.roomMembers(room.id);
      }

      case 'messages.send': {
        const body = normalizeMessageBody(p.body);
        if (!body) throw new RpcError('BAD_REQUEST', 'Mesaj boş veya çok uzun (en fazla 4000 karakter).');
        if (!isClientId(p.clientId)) throw new RpcError('BAD_REQUEST', 'Geçersiz mesaj kimliği.');
        const conv = this.resolveConv(me, p.conv, true);
        const [a, b] = conv.other ? (me.id < conv.other.id ? [me.id, conv.other.id] : [conv.other.id, me.id]) : [null, null];
        const { row, duplicate } = this.db.insertMessage({
          convKey: conv.key,
          roomId: conv.room?.id ?? null,
          dmA: a,
          dmB: b,
          senderId: me.id,
          body,
          clientId: p.clientId,
        });
        if (!duplicate) {
          this.db.setReadState(me.id, conv.key, row.id);
          if (conv.room) {
            const room = conv.room;
            for (const [uid, set] of this.online) {
              if (!this.canAccessRoomById(uid, room) || this.db.hasBlocked(uid, me.id)) continue;
              for (const c of set) if (c !== conn) this.emit(c, 'message', { message: this.toChat(row, uid) });
            }
          } else if (conv.other) {
            for (const uid of [me.id, conv.other.id]) {
              for (const c of this.online.get(uid) ?? []) if (c !== conn) this.emit(c, 'message', { message: this.toChat(row, uid) });
            }
          }
        }
        return this.toChat(row, me.id);
      }

      case 'messages.history': {
        const conv = this.resolveConv(me, p.conv, false);
        const limit = Math.max(1, Math.min(100, Number(p.limit) || HISTORY_PAGE_SIZE));
        const beforeId = typeof p.beforeId === 'number' && p.beforeId > 0 ? p.beforeId : undefined;
        const rows = this.db.history(conv.key, me.id, beforeId, limit + 1);
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(rows.length - limit) : rows;
        return { messages: page.map((r) => this.toChat(r, me.id)), hasMore };
      }

      case 'messages.markRead': {
        const conv = this.resolveConv(me, p.conv, false);
        const lastId = Number(p.lastId);
        if (!Number.isInteger(lastId) || lastId < 0) throw new RpcError('BAD_REQUEST', 'Geçersiz mesaj.');
        this.db.setReadState(me.id, conv.key, Math.min(lastId, this.db.maxMessageId(conv.key)));
        return { ok: true };
      }

      case 'messages.search': {
        const q = typeof p.q === 'string' ? p.q.slice(0, 100) : '';
        const roomIds = this.db
          .listRooms()
          .filter((r) => this.canAccessRoom(me, r))
          .map((r) => r.id);
        return this.db.search(me.id, q, roomIds).map((r) => ({ message: this.toChat(r, me.id), snippet: r.snippet }));
      }

      case 'voice.join': {
        const room = this.requireRoom(me, p.roomId);
        const muted = p.muted === true;
        const deafened = p.deafened === true;
        const current = this.voiceRoomOf.get(me.id);
        let members = this.voice.get(room.id);
        if (current === room.id && members?.has(me.id)) {
          const entry = members.get(me.id)!;
          if (entry.connId !== conn.id) {
            const old = this.conns.get(entry.connId);
            if (old) this.emit(old, 'voice.update', { roomId: room.id, participants: this.voiceList(room.id).filter((x) => x.userId !== me.id) });
          }
          Object.assign(entry, { muted, deafened, connId: conn.id });
        } else {
          if (current) this.leaveVoice(me.id);
          members = this.voice.get(room.id);
          if ((members?.size ?? 0) >= room.capacity) throw new RpcError('ROOM_FULL', `Oda dolu (en fazla ${room.capacity} kişi).`);
          if (!members) {
            members = new Map();
            this.voice.set(room.id, members);
          }
          members.set(me.id, { userId: me.id, muted, deafened, joinedAt: Date.now(), connId: conn.id });
          this.voiceRoomOf.set(me.id, room.id);
          this.emitToAll('user.updated', { user: this.pub(me, true) }, (uid) => this.canSeeUser(uid, me.id));
        }
        const participants = this.voiceList(room.id);
        this.emitToAll('voice.update', { roomId: room.id, participants }, (uid) => this.canAccessRoomById(uid, room));
        if (this.sfu) {
          const token = participantToken(this.sfu, { identity: me.id, name: me.display_name, room: room.id });
          return { roomId: room.id, participants, sfu: { path: SFU_PATH, token } };
        }
        return { roomId: room.id, participants };
      }

      case 'voice.leave':
        this.leaveVoice(me.id);
        return { ok: true };

      case 'voice.state': {
        const roomId = this.voiceRoomOf.get(me.id);
        const entry = roomId ? this.voice.get(roomId)?.get(me.id) : undefined;
        if (!roomId || !entry) throw new RpcError('NOT_FOUND', 'Sesli odada değilsiniz.');
        entry.muted = p.muted === true;
        entry.deafened = p.deafened === true;
        const room = this.db.getRoom(roomId);
        if (room) this.emitToAll('voice.update', { roomId, participants: this.voiceList(roomId) }, (uid) => this.canAccessRoomById(uid, room));
        return { ok: true };
      }

      case 'rtc.signal': {
        if (this.sfu) throw new RpcError('BAD_REQUEST', 'Bu sunucuda ses, ses sunucusu üzerinden iletilir.');
        if (!isId(p.to) || !isRtcSignal(p.data)) throw new RpcError('BAD_REQUEST', 'Geçersiz sinyal.');
        const roomId = this.voiceRoomOf.get(me.id);
        if (!roomId || this.voiceRoomOf.get(p.to) !== roomId) throw new RpcError('NOT_FOUND', 'Karşı taraf aynı sesli odada değil.');
        const mine = this.voice.get(roomId)?.get(me.id);
        if (!mine || mine.connId !== conn.id) throw new RpcError('FORBIDDEN', 'Bu bağlantı sesli odada değil.');
        const target = this.voice.get(roomId)?.get(p.to);
        const tc = target ? this.conns.get(target.connId) : undefined;
        if (!tc) throw new RpcError('NOT_FOUND', 'Karşı taraf bağlı değil.');
        this.emit(tc, 'rtc.signal', { from: me.id, data: p.data });
        return { ok: true };
      }

      case 'invites.create': {
        const room = this.requireRoomOwner(me, p.roomId);
        return this.createInvite(me, room.id, p);
      }

      case 'invites.redeem': {
        if (typeof p.secret !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.secret)) throw new RpcError('INVITE_INVALID', 'Davet kodu geçersiz.');
        const existing = this.db.getInviteByHash(hashInviteSecret(p.secret));
        if (existing?.room_id) {
          const already = this.db.getRoom(existing.room_id);
          if (already && this.canAccessRoom(me, already)) return { room: this.roomInfo(already) };
        }
        const invite = this.checkInvite(conn.ip, p.secret);
        if (!invite.room_id) throw new RpcError('INVITE_INVALID', 'Bu davet bir odaya bağlı değil; zaten bu sunucudasınız.');
        const room = this.db.getRoom(invite.room_id)!;
        if (!this.canAccessRoom(me, room)) {
          if (!this.db.incrementInviteUse(invite.id)) throw new RpcError('INVITE_USED', 'Bu davetin kullanım hakkı dolmuş.');
          this.addToRoom(room, me);
          this.log.info('invite redeemed', { invite: invite.id, user: me.id });
        }
        return { room: this.roomInfo(room) };
      }

      case 'admin.invites.create': {
        this.requireAdmin(me);
        const roomId = p.roomId ? this.requireRoom(me, p.roomId).id : null;
        return this.createInvite(me, roomId, p);
      }

      case 'admin.invites.list':
        this.requireAdmin(me);
        return this.db.listInvites();

      case 'admin.invites.revoke': {
        this.requireAdmin(me);
        if (!isId(p.inviteId)) throw new RpcError('BAD_REQUEST', 'Geçersiz davet.');
        this.db.revokeInvite(p.inviteId);
        return this.db.listInvites();
      }

      case 'admin.users.list':
        this.requireAdmin(me);
        return this.db.listUsers().map((u) => this.pub(u, this.isOnline(u.id)));

      case 'admin.users.kick': {
        this.requireAdmin(me);
        const u = this.requireUser(p.userId);
        if (u.role === 'admin') throw new RpcError('FORBIDDEN', 'Yönetici çıkarılamaz.');
        this.kickUser(u.id, 'kicked', CLOSE.KICKED);
        this.log.info('user kicked', { user: u.id });
        return { ok: true };
      }

      case 'admin.users.ban': {
        this.requireAdmin(me);
        const u = this.requireUser(p.userId);
        if (u.role === 'admin') throw new RpcError('FORBIDDEN', 'Yönetici yasaklanamaz.');
        this.db.setUserStatus(u.id, 'banned');
        this.kickUser(u.id, 'banned', CLOSE.BANNED);
        this.emitToAll('user.updated', { user: this.pub(this.db.getUser(u.id)!, false) }, (uid) => this.canSeeUser(uid, u.id));
        this.log.info('user banned', { user: u.id });
        return this.db.listUsers().map((x) => this.pub(x, this.isOnline(x.id)));
      }

      case 'admin.users.unban': {
        this.requireAdmin(me);
        const u = this.requireUser(p.userId);
        this.db.setUserStatus(u.id, 'active');
        this.emitToAll('user.updated', { user: this.pub(this.db.getUser(u.id)!, false) }, (uid) => this.canSeeUser(uid, u.id));
        return this.db.listUsers().map((x) => this.pub(x, this.isOnline(x.id)));
      }
    }
    throw new RpcError('BAD_REQUEST', 'Bilinmeyen istek.');
  }

  private bootstrap(me: UserRow): Bootstrap {
    const rooms = this.db.listRooms().filter((r) => this.canAccessRoom(me, r));
    const related = this.openRegistration && me.role !== 'admin' ? this.db.relatedUserIds(me.id) : null;
    const users = this.db
      .listUsers()
      .filter((u) => !related || related.has(u.id))
      .filter((u) => me.role === 'admin' || u.status === 'active' || u.id === me.id)
      .map((u) => this.pub(u, this.isOnline(u.id)));
    const dmKeys = (
      this.db.db.prepare('SELECT DISTINCT conv_key FROM messages WHERE dm_a = ? OR dm_b = ?').all(me.id, me.id) as { conv_key: string }[]
    ).map((r) => r.conv_key);
    const canonical = [...rooms.map((r) => roomKey(r.id)), ...dmKeys];
    const unreadCanonical = this.db.unreadCounts(me.id, canonical);
    const unread: Record<string, number> = {};
    for (const [k, v] of Object.entries(unreadCanonical)) unread[this.viewConv(k, me.id)] = v;
    return {
      me: this.pub(me, true),
      host: this.hostInfo(),
      users,
      rooms: rooms.map((r) => this.roomInfo(r)),
      friends: this.db.listFriends(me.id),
      blocked: this.db.listBlocked(me.id),
      unread,
    };
  }
}
