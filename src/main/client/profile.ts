import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { SecretBox } from '../secretBox';
import type { SavedHostSummary } from '../../shared/ipc';
import { isValidHost, isValidPort } from '../../shared/netclass';

export interface SavedHost {
  hostId: string;
  hostName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  userId: string;
  displayName: string;
  publicKey: string;
  privateKey: string;
  keyProtected: boolean;
  isOwnHost: boolean;
  lastAddress: string | null;
  lastConnectedAt: number | null;
}

interface ProfileFile {
  v: 1;
  hosts: SavedHost[];
  lastHostId: string | null;
}

export interface DeviceKey {
  publicKey: string;
  privateKeyPem: string;
}

export function generateDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

export function signWith(privateKeyPem: string | KeyObject, payload: string): string {
  const key = typeof privateKeyPem === 'string' ? createPrivateKey(privateKeyPem) : privateKeyPem;
  return sign(null, Buffer.from(payload), key).toString('base64');
}

export class LocalProfile {
  private file: string;
  private box: SecretBox;
  private data: ProfileFile;

  constructor(userDataDir: string, box: SecretBox) {
    this.file = path.join(userDataDir, 'client.json');
    this.box = box;
    this.data = this.read();
  }

  private read(): ProfileFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ProfileFile;
      if (raw.v !== 1 || !Array.isArray(raw.hosts)) throw new Error('bad');
      return raw;
    } catch (e) {
      if (fs.existsSync(this.file)) {
        fs.renameSync(this.file, `${this.file}.bad-${Date.now()}`);
        void e;
      }
      return { v: 1, hosts: [], lastHostId: null };
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get lastHostId(): string | null {
    return this.data.lastHostId;
  }

  /** Account used to sign back in: the built-in server if we have one, else the last used server. Local leftover hosts are ignored. */
  preferredAccount(preferHostId?: string | null): SavedHost | undefined {
    const all = this.data.hosts.filter((h) => !h.isOwnHost);
    return (preferHostId ? all.find((h) => h.hostId === preferHostId) : undefined) ?? all.find((h) => h.hostId === this.data.lastHostId) ?? all[0];
  }

  setLastHost(hostId: string | null): void {
    this.data.lastHostId = hostId;
    this.write();
  }

  get(hostId: string): SavedHost | undefined {
    return this.data.hosts.find((h) => h.hostId === hostId);
  }

  all(): SavedHost[] {
    return [...this.data.hosts];
  }

  /** Joined servers. Records of a community once hosted on this PC (older versions) are kept but not listed. */
  summaries(): SavedHostSummary[] {
    return this.data.hosts.filter((h) => !h.isOwnHost).map((h) => ({
      hostId: h.hostId,
      hostName: h.hostName,
      displayName: h.displayName,
      addresses: h.addresses,
      port: h.port,
      fingerprint: h.fingerprint,
      isOwnHost: h.isOwnHost,
      lastConnectedAt: h.lastConnectedAt,
      lastAddress: h.lastAddress,
    }));
  }

  save(entry: Omit<SavedHost, 'privateKey' | 'keyProtected'> & { privateKeyPem: string }): void {
    const { privateKeyPem, ...rest } = entry;
    const protectedKey = this.box.available;
    const host: SavedHost = { ...rest, privateKey: protectedKey ? this.box.encrypt(privateKeyPem) : privateKeyPem, keyProtected: protectedKey };
    this.data.hosts = [...this.data.hosts.filter((h) => h.hostId !== entry.hostId), host];
    this.write();
  }

  privateKeyOf(hostId: string): string {
    const h = this.get(hostId);
    if (!h) throw new Error('Kayıtlı sunucu bulunamadı.');
    return h.keyProtected ? this.box.decrypt(h.privateKey) : h.privateKey;
  }

  update(hostId: string, patch: Partial<Pick<SavedHost, 'hostName' | 'addresses' | 'port' | 'displayName' | 'lastAddress' | 'lastConnectedAt'>>): void {
    const h = this.get(hostId);
    if (!h) return;
    if (patch.addresses) patch.addresses = patch.addresses.filter(isValidHost).slice(0, 12);
    if (patch.port !== undefined && !isValidPort(patch.port)) delete patch.port;
    Object.assign(h, patch);
    this.write();
  }

  remove(hostId: string): void {
    this.data.hosts = this.data.hosts.filter((h) => h.hostId !== hostId);
    if (this.data.lastHostId === hostId) this.data.lastHostId = null;
    this.write();
  }

  /** Plain export for encrypted backups. */
  exportPlain(): Array<Omit<SavedHost, 'privateKey' | 'keyProtected'> & { privateKeyPem: string }> {
    return this.data.hosts.map((h) => {
      const { privateKey: _p, keyProtected: _k, ...rest } = h;
      return { ...rest, privateKeyPem: this.privateKeyOf(h.hostId) };
    });
  }
}
