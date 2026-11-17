import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyAddress } from '../src/shared/netclass';
import { decodeInvite, encodeInvite } from '../src/shared/invite';
import { linkify, nameKey, normalizeDisplayName, normalizeMessageBody, isSafeExternalUrl } from '../src/shared/validate';
import { decryptBackup, encryptBackup, type BackupPayload } from '../src/main/backup';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/main/settings';
import { RateLimiter } from '../src/main/host/rateLimit';
import { HostDb, DbCorruptError } from '../src/main/host/db';
import { DEFAULT_SERVER, resolveDefaultServer } from '../src/shared/defaultServer';
import { tmpDir } from './helpers';

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).toUpperCase().padStart(2, '0')).join(':');

describe('built-in server', () => {
  it('ships a pinned server and accepts only a complete override', () => {
    expect(DEFAULT_SERVER.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(resolveDefaultServer(undefined)).toBe(DEFAULT_SERVER);
    expect(resolveDefaultServer(`abcDEF123456|Test|127.0.0.1|45000|${FP}`)).toEqual({ hostId: 'abcDEF123456', hostName: 'Test', addresses: ['127.0.0.1'], port: 45000, fingerprint: FP });
    expect(resolveDefaultServer(`abcDEF123456|Test|127.0.0.1|45000|zz`)).toBe(DEFAULT_SERVER);
    expect(resolveDefaultServer('bozuk')).toBe(DEFAULT_SERVER);
  });
});

describe('address classification', () => {
  it.each([
    ['127.0.0.1', 'self'],
    ['192.168.1.20', 'lan'],
    ['10.0.0.5', 'lan'],
    ['172.20.1.1', 'lan'],
    ['172.32.1.1', 'internet'],
    ['100.101.102.103', 'private-overlay'],
    ['100.63.0.1', 'internet'],
    ['85.105.1.1', 'internet'],
    ['fe80::1', 'lan'],
    ['fd7a:115c:a1e0::1', 'private-overlay'],
    ['myhost.duckdns.org', 'internet'],
  ])('%s -> %s', (addr, kind) => {
    expect(classifyAddress(addr)).toBe(kind);
  });
});

describe('invite codes', () => {
  const payload = { h: 'abcdefghijkl', n: 'Akşam Grubu', a: ['192.168.1.20', '100.64.1.2'], p: 47823, f: FP, s: 'A'.repeat(32) };
  it('round-trips including Turkish characters', () => {
    const code = encodeInvite(payload);
    expect(code.startsWith('ODA1-')).toBe(true);
    expect(decodeInvite(code)).toEqual({ v: 1, ...payload });
    expect(decodeInvite(`  ${code.slice(0, 20)}\n${code.slice(20)} `)).not.toBeNull();
  });
  it('rejects tampered or malformed codes', () => {
    expect(decodeInvite('ODA1-!!!')).toBeNull();
    expect(decodeInvite(encodeInvite({ ...payload, f: 'nope' }))).toBeNull();
    expect(decodeInvite(encodeInvite({ ...payload, p: 80 }))).toBeNull();
    expect(decodeInvite(encodeInvite({ ...payload, a: ['bad host!'] }))).toBeNull();
    expect(decodeInvite('hello')).toBeNull();
  });
});

describe('validation', () => {
  it('normalizes names and strips control characters', () => {
    expect(normalizeDisplayName('  Ece\u200B  Yılmaz ')).toBe('Ece Yılmaz');
    expect(normalizeDisplayName('a')).toBeNull();
    expect(normalizeDisplayName('x'.repeat(33))).toBeNull();
    expect(nameKey('IŞIK')).toBe(nameKey('ışık'));
    expect(nameKey('Irmak')).toBe(nameKey('ırmak'));
  });
  it('normalizes message bodies', () => {
    expect(normalizeMessageBody('  merhaba\r\ndünya  ')).toBe('merhaba\ndünya');
    expect(normalizeMessageBody('\u0000')).toBeNull();
  });
  it('linkifies only http(s) and trims punctuation', () => {
    expect(linkify('bak: https://ornek.com/a?b=1, javascript:alert(1)')).toEqual([
      { text: 'bak: ' },
      { text: 'https://ornek.com/a?b=1', href: 'https://ornek.com/a?b=1' },
      { text: ', javascript:alert(1)' },
    ]);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///c:/windows')).toBe(false);
    expect(isSafeExternalUrl('https://user:pw@x.com')).toBe(false);
    expect(isSafeExternalUrl('https://x.com')).toBe(true);
  });
});

describe('encrypted backups', () => {
  const payload: BackupPayload = { v: 1, createdAt: 1, appVersion: 't', host: null, hostConfig: null, clientHosts: [{ privateKeyPem: 'SECRET' }], settings: {} };
  it('round-trips and does not contain plaintext secrets', () => {
    const buf = encryptBackup(payload, 'uzun-parola-123');
    expect(buf.toString('utf8')).not.toContain('SECRET');
    expect(decryptBackup(buf, 'uzun-parola-123')).toEqual(payload);
  });
  it('fails on wrong password and short passwords', () => {
    const buf = encryptBackup(payload, 'uzun-parola-123');
    expect(() => decryptBackup(buf, 'yanlis-parola')).toThrow(/yanlış/);
    expect(() => encryptBackup(payload, 'kisa')).toThrow();
  });
});

describe('settings', () => {
  it('ignores unknown keys and invalid values', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { audio: { outputVolume: 500, echoCancellation: false, evil: 1 }, network: { useStun: true }, hack: true });
    expect(s.audio.outputVolume).toBe(100);
    expect(s.audio.echoCancellation).toBe(false);
    expect((s as unknown as Record<string, unknown>).hack).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).network).toBeUndefined();
  });
});

describe('rate limiter', () => {
  it('limits bursts and refills over time', () => {
    let t = 0;
    const rl = new RateLimiter(3, 1, () => t);
    expect([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([true, true, true, false]);
    t += 1000;
    expect(rl.take('a')).toBe(true);
    expect(rl.take('b')).toBe(true);
  });
});

describe('database', () => {
  it('migrates, and detects a corrupt file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'x.db');
    const db = HostDb.open(file);
    expect(db.db.pragma('user_version', { simple: true })).toBe(2);
    db.close();
    const bad = path.join(dir, 'bad.db');
    fs.writeFileSync(bad, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x41)]));
    expect(() => HostDb.open(bad)).toThrow(DbCorruptError);
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, Buffer.alloc(8192, 0x5a));
    expect(() => HostDb.open(garbage)).toThrow(DbCorruptError);
    fs.renameSync(bad, bad + '.aside');
    fs.renameSync(garbage, garbage + '.aside');
  });
  it('binds parameters safely in search', () => {
    const db = HostDb.open(':memory:');
    const u = db.createUser({ displayName: 'A', nameKey: 'a', color: '#000000', role: 'admin' });
    const r = db.createRoom({ name: 'R', isPrivate: false, capacity: 4, createdBy: u.id });
    db.insertMessage({ convKey: `room:${r.id}`, roomId: r.id, dmA: null, dmB: null, senderId: u.id, body: "Robert'); DROP TABLE users;--", clientId: 'aaaaaa1' });
    expect(db.search(u.id, "'); DROP", [r.id]).length).toBe(1);
    expect(db.search(u.id, '" OR 1 --', [r.id])).toEqual([]);
    expect(db.countUsers()).toBe(1);
  });
});
