import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostDb, newId } from '../src/main/host/db';
import { HostServer } from '../src/main/host/server';
import { loadOrCreateTls, type TlsMaterial } from '../src/main/host/tls';
import { HostClient, type AuthMode } from '../src/main/client/connection';
import { AVATAR_COLORS, MAX_ROOM_CAPACITY } from '../src/shared/protocol';
import { nameKey } from '../src/shared/validate';
import { generateDeviceKey } from '../src/main/client/profile';
import { plainBox } from '../src/main/secretBox';
import { decodeInvite } from '../src/shared/invite';
import type { ClientStatus } from '../src/shared/ipc';
import type { ServerEventName } from '../src/shared/protocol';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oda-test-'));
}

let nextPort = 41000 + Math.floor(Math.random() * 2000);
export function freePort(): number {
  return nextPort++;
}

/** In-process host with a local owner account (peer-to-peer voice); `dedicated` makes it behave like oda-server. */
class TestHost {
  private server: HostServer | null = null;
  private db: HostDb | null = null;
  constructor(
    private readonly dir: string,
    private readonly tls: TlsMaterial,
    private readonly port: number,
    private readonly dedicated: boolean,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.db = HostDb.open(path.join(this.dir, 'oda-host.db'));
    this.server = new HostServer({ db: this.db, tls: this.tls, port: this.port, advertisedAddresses: () => ['127.0.0.1'], dedicated: this.dedicated });
    await this.server.start();
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await s.stop();
    this.db?.close();
    this.db = null;
  }
}

export async function makeHost(adminName = 'Rıfat', opts: { dedicated?: boolean } = {}) {
  const dir = tmpDir();
  const key = generateDeviceKey();
  const port = freePort();
  const tls = await loadOrCreateTls(path.join(dir, 'tls.json'), plainBox);
  const hostId = newId(16);
  let adminUserId = '';
  const db = HostDb.open(path.join(dir, 'oda-host.db'));
  db.db.transaction(() => {
    db.setMeta('host_id', hostId);
    db.setMeta('host_name', 'Test Topluluğu');
    db.setMeta('created_at', String(Date.now()));
    const admin = db.createUser({ displayName: adminName, nameKey: nameKey(adminName), color: AVATAR_COLORS[0], role: 'admin' });
    adminUserId = admin.id;
    db.setMeta('owner_id', admin.id);
    db.addDevice(admin.id, key.publicKey, 'test');
    db.createRoom({ name: 'Genel', isPrivate: false, capacity: MAX_ROOM_CAPACITY, createdBy: admin.id });
  })();
  db.close();
  const host = new TestHost(dir, tls, port, opts.dedicated ?? false);
  await host.start();
  return { dir, host, key, port, hostId, adminUserId, fingerprint: tls.fingerprint };
}

export function waitStatus(client: HostClient, pred: (s: ClientStatus) => boolean, timeout = 8000): Promise<ClientStatus> {
  return new Promise((resolve, reject) => {
    if (pred(client.currentStatus)) return resolve(client.currentStatus);
    const t = setTimeout(() => {
      client.off('status', on);
      reject(new Error('status timeout; last=' + JSON.stringify(client.currentStatus)));
    }, timeout);
    const on = (s: ClientStatus) => {
      if (pred(s)) {
        clearTimeout(t);
        client.off('status', on);
        resolve(s);
      }
    };
    client.on('status', on);
  });
}

export function waitEvent<T = unknown>(client: HostClient, name: ServerEventName, pred: (d: T) => boolean = () => true, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      client.off('event', on);
      reject(new Error('event timeout ' + name));
    }, timeout);
    const on = (e: ServerEventName, d: T) => {
      if (e === name && pred(d)) {
        clearTimeout(t);
        client.off('event', on);
        resolve(d);
      }
    };
    client.on('event', on);
  });
}

export async function connectClient(opts: { hostId: string; port: number; fingerprint: string; auth: AuthMode; addresses?: string[]; requireServer?: boolean }) {
  const client = new HostClient(
    { hostId: opts.hostId, hostName: 'Test', addresses: opts.addresses ?? ['127.0.0.1'], port: opts.port, fingerprint: opts.fingerprint, isOwnHost: false, requireServer: opts.requireServer },
    opts.auth,
  );
  client.connect();
  const s = await waitStatus(client, (x) => x.state === 'connected' || x.state === 'failed');
  return { client, status: s };
}

export async function joinWithCode(code: string, displayName: string, opts: { requireServer?: boolean } = {}) {
  const inv = decodeInvite(code)!;
  const key = generateDeviceKey();
  const res = await connectClient({
    hostId: inv.h,
    port: inv.p,
    fingerprint: inv.f,
    addresses: ['127.0.0.1'],
    requireServer: opts.requireServer,
    auth: { kind: 'register', publicKey: key.publicKey, privateKeyPem: key.privateKeyPem, invite: inv.s, displayName },
  });
  return { ...res, key, inv };
}
