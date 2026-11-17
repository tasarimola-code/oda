import fs from 'node:fs';
import { HostClient, ClientError, type ConnectTarget } from './client/connection';
import { LocalProfile, generateDeviceKey } from './client/profile';
import { SfuBridge } from './client/sfuBridge';
import { SettingsStore } from './settings';
import { buildPayload, decryptBackup, encryptBackup } from './backup';
import type { SecretBox } from './secretBox';
import { decodeInvite, isFingerprint } from '../shared/invite';
import { isValidHost, isValidPort } from '../shared/netclass';
import { normalizeDisplayName } from '../shared/validate';
import { RPC_METHODS, type Bootstrap, type RpcMethod } from '../shared/protocol';
import { resolveDefaultServer, type ServerTarget } from '../shared/defaultServer';
import type { ClientStatus, JoinResult, RendererEvents, SavedHostSummary } from '../shared/ipc';
import { createLogger, errMessage } from './logger';

const log = createLogger('controller');

export class UserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IDLE_STATUS: ClientStatus = {
  state: 'idle',
  hostId: null,
  hostName: null,
  userId: null,
  address: null,
  port: null,
  pathKind: null,
  isOwnHost: false,
  attempt: 0,
  nextRetryAt: null,
  error: null,
};

const NOT_SERVER_MESSAGE = 'Bu kayıt bu bilgisayarda çalışan eski bir odaya ait. ODA artık yalnızca sunucu davetleriyle çalışır.';

/** The desktop app is a client of ODA servers only; it never hosts a community itself. */
export class AppController {
  readonly profile: LocalProfile;
  readonly settings: SettingsStore;
  readonly defaultServer: ServerTarget = resolveDefaultServer(process.env.ODA_SERVER);
  private client: HostClient | null = null;
  private readonly sfuBridge = new SfuBridge();

  constructor(
    readonly userDataDir: string,
    box: SecretBox,
    private readonly send: <E extends keyof RendererEvents>(e: E, payload: RendererEvents[E]) => void,
    private readonly appVersion: string,
  ) {
    this.profile = new LocalProfile(userDataDir, box);
    this.settings = new SettingsStore(userDataDir);
  }

  /** Reconnects with the saved account; no invite is needed after the first sign-in on this device. */
  async restore(): Promise<void> {
    const saved = this.profile.preferredAccount(this.defaultServer.hostId);
    if (!saved) return;
    try {
      await this.connectSaved(saved.hostId);
    } catch (e) {
      log.warn('session restore failed', { err: errMessage(e) });
    }
  }

  async shutdown(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
    this.sfuBridge.close();
  }

  clientStatus(): ClientStatus {
    return this.client?.currentStatus ?? { ...IDLE_STATUS };
  }

  private attachClient(client: HostClient): void {
    this.client?.removeAllListeners();
    this.client?.disconnect();
    this.client = client;
    client.on('status', (s: ClientStatus) => {
      if (this.client === client) this.send('client.status', s);
    });
    client.on('event', (e, d) => {
      if (this.client === client) this.send('client.event', { e, d });
    });
    client.on('authenticated', ({ address }: { address: string }) => {
      this.profile.update(client.hostId, { lastAddress: address, lastConnectedAt: Date.now() });
      this.profile.setLastHost(client.hostId);
    });
  }

  previewInvite(code: string) {
    const inv = decodeInvite(code);
    if (!inv) throw new UserError('INVALID_INVITE_CODE', 'Davet kodu okunamadı. Kodu eksiksiz kopyaladığınızdan emin olun.');
    const saved = this.profile.get(inv.h);
    return { hostName: inv.n, addresses: inv.a, port: inv.p, fingerprint: inv.f, known: !!saved && !saved.isOwnHost };
  }

  /** Account on the built-in server: reused if this device already has one, otherwise created without an invite. */
  async createAccount(opts: { displayName: string }): Promise<JoinResult> {
    const server = this.defaultServer;
    const existing = this.profile.get(server.hostId);
    if (existing && !existing.isOwnHost) {
      await this.connectSaved(server.hostId);
      const client = this.client!;
      await this.waitConnected(client);
      return { status: client.currentStatus, roomId: null };
    }
    const displayName = normalizeDisplayName(opts.displayName);
    if (!displayName) throw new UserError('BAD_REQUEST', 'Görünen ad 2–32 karakter olmalı.');
    const client = this.registerOn(server, displayName);
    await this.waitConnected(client);
    return { status: client.currentStatus, roomId: null };
  }

  async joinWithInvite(opts: { code: string; displayName: string }): Promise<JoinResult> {
    const inv = decodeInvite(opts.code);
    if (!inv) throw new UserError('INVALID_INVITE_CODE', 'Davet kodu okunamadı. Kodu eksiksiz kopyaladığınızdan emin olun.');
    const existing = this.profile.get(inv.h);
    if (existing?.isOwnHost) throw new UserError('NOT_SERVER', NOT_SERVER_MESSAGE);
    if (existing) {
      await this.connectSaved(inv.h);
      const client = this.client!;
      await this.waitConnected(client);
      try {
        const { room } = await client.request('invites.redeem', { secret: inv.s });
        return { status: client.currentStatus, roomId: room.id };
      } catch (e) {
        // Spent or expired codes must not block signing back in; the account and rooms are already on this device.
        if (e instanceof ClientError && (e.code === 'INVITE_USED' || e.code === 'INVITE_EXPIRED' || e.code === 'INVITE_INVALID')) {
          return { status: client.currentStatus, roomId: null };
        }
        if (e instanceof ClientError) throw new UserError(e.code, e.message);
        throw e;
      }
    }
    const displayName = normalizeDisplayName(opts.displayName);
    if (!displayName) throw new UserError('BAD_REQUEST', 'Görünen ad 2–32 karakter olmalı.');
    const client = this.registerOn({ hostId: inv.h, hostName: inv.n, addresses: inv.a, port: inv.p, fingerprint: inv.f }, displayName, inv.s);
    await this.waitConnected(client);
    return { status: client.currentStatus, roomId: null };
  }

  private registerOn(server: ServerTarget, displayName: string, invite?: string): HostClient {
    const key = generateDeviceKey();
    const target: ConnectTarget = { ...server, isOwnHost: false, requireServer: true };
    const client = new HostClient(target, { kind: 'register', publicKey: key.publicKey, privateKeyPem: key.privateKeyPem, invite, displayName });
    client.once('registered', ({ userId, address }: { userId: string; address: string }) => {
      this.profile.save({
        hostId: server.hostId,
        hostName: server.hostName,
        addresses: [...new Set([address, ...server.addresses])],
        port: server.port,
        fingerprint: server.fingerprint,
        userId,
        displayName,
        publicKey: key.publicKey,
        privateKeyPem: key.privateKeyPem,
        isOwnHost: false,
        lastAddress: address,
        lastConnectedAt: Date.now(),
      });
      client.useLogin(key.publicKey, key.privateKeyPem);
    });
    this.attachClient(client);
    client.connect();
    return client;
  }

  /** Resolves when the client is signed in; rejects with the server's reason if it gives up. */
  private waitConnected(client: HostClient, timeoutMs = 25_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (err?: Error) => {
        if (timer) clearTimeout(timer);
        client.off('status', check);
        if (err) reject(err);
        else resolve();
      };
      const check = (s: ClientStatus) => {
        if (s.state === 'connected') done();
        else if (s.state === 'failed' || s.state === 'idle') done(new UserError(s.error?.code ?? 'HOST_UNREACHABLE', s.error?.message ?? 'Sunucuya bağlanılamadı.'));
      };
      timer = setTimeout(() => {
        const s = client.currentStatus;
        done(new UserError(s.error?.code ?? 'TIMEOUT', s.error?.message ?? 'Sunucu yanıt vermedi. İnternet bağlantınızı kontrol edip tekrar deneyin.'));
      }, timeoutMs);
      client.on('status', check);
      const now = client.currentStatus;
      if (now.state === 'connected' || now.state === 'failed') check(now);
    });
  }

  async connectSaved(hostId: string): Promise<ClientStatus> {
    const saved = this.profile.get(hostId);
    if (!saved) throw new UserError('NOT_FOUND', 'Kayıtlı sunucu bulunamadı.');
    if (saved.isOwnHost) throw new UserError('NOT_SERVER', NOT_SERVER_MESSAGE);
    if (this.client && this.client.hostId === hostId && this.client.currentStatus.state !== 'failed' && this.client.currentStatus.state !== 'idle') {
      this.client.retryNow();
      return this.client.currentStatus;
    }
    let privateKeyPem: string;
    try {
      privateKeyPem = this.profile.privateKeyOf(hostId);
    } catch {
      throw new UserError('KEY_UNAVAILABLE', 'Cihaz anahtarı çözülemedi (Windows kullanıcı hesabı değişmiş olabilir). Yedekten geri yükleyin veya yeni davetle katılın.');
    }
    const addresses = saved.lastAddress ? [saved.lastAddress, ...saved.addresses.filter((a) => a !== saved.lastAddress)] : saved.addresses;
    const client = new HostClient(
      { hostId, hostName: saved.hostName, addresses, port: saved.port, fingerprint: saved.fingerprint, isOwnHost: false, requireServer: true },
      { kind: 'login', publicKey: saved.publicKey, privateKeyPem },
    );
    this.attachClient(client);
    client.connect();
    return client.currentStatus;
  }

  updateSavedAddress(hostId: string, address: string, port: number): SavedHostSummary[] {
    const saved = this.profile.get(hostId);
    if (!saved) throw new UserError('NOT_FOUND', 'Kayıtlı sunucu bulunamadı.');
    if (!isValidHost(address) || !isValidPort(port)) throw new UserError('BAD_REQUEST', 'Geçersiz adres veya port.');
    this.profile.update(hostId, { addresses: [address, ...saved.addresses.filter((a) => a !== address)], lastAddress: address, port });
    return this.profile.summaries();
  }

  disconnect(): ClientStatus {
    this.client?.disconnect();
    return this.clientStatus();
  }

  forget(hostId: string): SavedHostSummary[] {
    if (this.client?.hostId === hostId) {
      this.client.removeAllListeners();
      this.client.disconnect();
      this.client = null;
      this.send('client.status', { ...IDLE_STATUS });
    }
    this.profile.remove(hostId);
    return this.profile.summaries();
  }

  /** Local URL the renderer's LiveKit client uses to reach the connected server's media server. */
  async sfuUrl(): Promise<string> {
    const target = this.client?.pinnedTarget;
    if (!target) throw new UserError('OFFLINE', 'Sunucuya bağlı değilsiniz.');
    return this.sfuBridge.url(target);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!(RPC_METHODS as readonly string[]).includes(method)) throw new UserError('BAD_REQUEST', 'Bilinmeyen istek.');
    if (!this.client) throw new UserError('OFFLINE', 'Sunucuya bağlı değilsiniz.');
    const client = this.client;
    try {
      const result = await client.request(method as RpcMethod, (params ?? {}) as never);
      if (method === 'state.bootstrap') this.onBootstrap(client.hostId, result as Bootstrap);
      return result;
    } catch (e) {
      if (e instanceof ClientError) throw new UserError(e.code, e.message);
      throw e;
    }
  }

  private onBootstrap(hostId: string, b: Bootstrap): void {
    const saved = this.profile.get(hostId);
    if (!saved) return;
    const patch: Parameters<LocalProfile['update']>[1] = { hostName: b.host.hostName, displayName: b.me.displayName };
    if (b.host.addresses.length) {
      const first = saved.lastAddress ? [saved.lastAddress] : [];
      patch.addresses = [...new Set([...first, ...b.host.addresses, ...saved.addresses])];
    }
    this.profile.update(hostId, patch);
  }

  // ---------------------------------------------------------------- backups
  async exportBackup(file: string, password: string): Promise<void> {
    const payload = await buildPayload({
      appVersion: this.appVersion,
      snapshot: null,
      tls: null,
      hostConfig: null,
      clientHosts: this.profile.exportPlain().filter((h) => !(h as { isOwnHost?: boolean }).isOwnHost),
      settings: this.settings.get(),
    });
    const buf = encryptBackup(payload, password);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    log.info('backup exported', { hosts: payload.clientHosts.length });
  }

  /** Restores server memberships (device keys) and settings. A community database in old backups is ignored. */
  async importBackup(file: string, password: string): Promise<{ restoredHosts: number; skippedHostDb: boolean }> {
    const payload = decryptBackup(fs.readFileSync(file), password);
    this.client?.removeAllListeners();
    this.client?.disconnect();
    this.client = null;
    this.send('client.status', { ...IDLE_STATUS });
    let restoredHosts = 0;
    for (const raw of payload.clientHosts as Array<Record<string, unknown>>) {
      if (typeof raw?.hostId !== 'string' || typeof raw.privateKeyPem !== 'string' || !isFingerprint(raw.fingerprint) || raw.isOwnHost === true) continue;
      this.profile.save(raw as never);
      restoredHosts++;
    }
    if (payload.settings) this.settings.replace(payload.settings);
    log.info('backup imported', { restoredHosts, skippedHostDb: !!payload.host });
    return { restoredHosts, skippedHostDb: !!payload.host };
  }
}
