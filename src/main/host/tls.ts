import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import type { SecretBox } from '../secretBox';

export interface TlsMaterial {
  key: string;
  cert: string;
  fingerprint: string;
}

interface StoredTls {
  v: 1;
  cert: string;
  key: string;
  keyProtected: boolean;
}

export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.toUpperCase();
}

export async function createTlsMaterial(): Promise<TlsMaterial> {
  const notBeforeDate = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfterDate = new Date(Date.now() + 20 * 365 * 24 * 3600 * 1000);
  const pems = await generate([{ name: 'commonName', value: 'ODA Host' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  });
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOf(pems.cert) };
}

export function saveTls(file: string, tls: TlsMaterial, box: SecretBox): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const protectedKey = box.available;
  const stored: StoredTls = { v: 1, cert: tls.cert, key: protectedKey ? box.encrypt(tls.key) : tls.key, keyProtected: protectedKey };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadTls(file: string, box: SecretBox): TlsMaterial | null {
  if (!fs.existsSync(file)) return null;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredTls;
  const key = stored.keyProtected ? box.decrypt(stored.key) : stored.key;
  return { key, cert: stored.cert, fingerprint: fingerprintOf(stored.cert) };
}

export async function loadOrCreateTls(file: string, box: SecretBox): Promise<TlsMaterial> {
  const existing = loadTls(file, box);
  if (existing) return existing;
  const tls = await createTlsMaterial();
  saveTls(file, tls, box);
  return tls;
}
