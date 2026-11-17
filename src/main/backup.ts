import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { TlsMaterial } from './host/tls';

const MAGIC = 'ODABAK1';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export const MIN_BACKUP_PASSWORD = 8;

export interface BackupPayload {
  v: 1;
  createdAt: number;
  appVersion: string;
  host: { db: string; tls: { key: string; cert: string } } | null;
  hostConfig: unknown;
  clientHosts: unknown[];
  settings: unknown;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, SCRYPT);
}

export function encryptBackup(payload: BackupPayload, password: string): Buffer {
  if (password.length < MIN_BACKUP_PASSWORD) throw new Error(`Yedek parolası en az ${MIN_BACKUP_PASSWORD} karakter olmalı.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(MAGIC));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = { kdf: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
  return Buffer.from(`${MAGIC}\n${JSON.stringify(envelope)}`, 'utf8');
}

export function decryptBackup(file: Buffer, password: string): BackupPayload {
  const text = file.toString('utf8');
  const nl = text.indexOf('\n');
  if (nl < 0 || text.slice(0, nl) !== MAGIC) throw new Error('Bu dosya bir ODA yedeği değil.');
  const env = JSON.parse(text.slice(nl + 1)) as { n: number; r: number; p: number; salt: string; iv: string; tag: string; data: string };
  if (env.n !== SCRYPT.N || env.r !== SCRYPT.r || env.p !== SCRYPT.p) throw new Error('Desteklenmeyen yedek biçimi.');
  const key = deriveKey(password, Buffer.from(env.salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(Buffer.from(MAGIC));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Yedek parolası yanlış veya dosya bozuk.');
  }
  const payload = JSON.parse(plain.toString('utf8')) as BackupPayload;
  if (payload.v !== 1) throw new Error('Desteklenmeyen yedek sürümü.');
  return payload;
}

export async function buildPayload(opts: {
  appVersion: string;
  snapshot: ((file: string) => Promise<void>) | null;
  tls: TlsMaterial | null;
  hostConfig: unknown;
  clientHosts: unknown[];
  settings: unknown;
}): Promise<BackupPayload> {
  let host: BackupPayload['host'] = null;
  if (opts.snapshot && opts.tls) {
    const tmp = path.join(os.tmpdir(), `oda-snap-${randomBytes(6).toString('hex')}.db`);
    try {
      await opts.snapshot(tmp);
      host = { db: fs.readFileSync(tmp).toString('base64'), tls: { key: opts.tls.key, cert: opts.tls.cert } };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return { v: 1, createdAt: Date.now(), appVersion: opts.appVersion, host, hostConfig: opts.hostConfig, clientHosts: opts.clientHosts, settings: opts.settings };
}
