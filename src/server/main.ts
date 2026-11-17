/**
 * ODA dedicated server (Linux, headless): the same host service as the desktop app,
 * with voice routed through a LiveKit media server on the same machine.
 *
 *   oda-server init --name "Topluluk" --public 203.0.113.10 [--port 47823]
 *                   --livekit-key KEY --livekit-secret SECRET [--livekit-url http://127.0.0.1:7880]
 *   oda-server run
 *   oda-server invite [--admin] [--uses 1] [--days 7 | --hours 24]
 *   oda-server invites | revoke <id> | status | rename --name AD | backup <file>
 *
 * Data directory: $ODA_DATA (default /var/lib/oda).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HostDb, newId } from '../main/host/db';
import { HostServer, issueInvite } from '../main/host/server';
import { loadOrCreateTls, loadTls } from '../main/host/tls';
import type { SfuConfig } from '../main/host/livekit';
import { plainBox } from '../main/secretBox';
import { createLogger, errMessage } from '../main/logger';
import { isValidHost, isValidPort } from '../shared/netclass';
import { normalizeRoomName } from '../shared/validate';
import { DEFAULT_PORT } from '../shared/protocol';

const log = createLogger('server');
const dataDir = path.resolve(process.env.ODA_DATA ?? '/var/lib/oda');
const files = {
  config: path.join(dataDir, 'server.json'),
  db: path.join(dataDir, 'oda-host.db'),
  tls: path.join(dataDir, 'tls.json'),
  backups: path.join(dataDir, 'backups'),
};
const BACKUP_KEEP = 14;
const BACKUP_INTERVAL_MS = 24 * 3600 * 1000;

interface ServerConfig {
  port: number;
  publicAddresses: string[];
  sfu: SfuConfig;
  maxConnections: number;
  /** Anyone with the app can sign up and create their own rooms. */
  openRegistration?: boolean;
}

class CliError extends Error {}

function parseArgs(argv: string[]): { cmd: string; pos: string[]; opts: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return { cmd, pos, opts };
}

function str(opts: Record<string, string | true>, key: string, required = false): string | undefined {
  const v = opts[key];
  if (v === undefined || v === true) {
    if (required) throw new CliError(`--${key} gerekli.`);
    return undefined;
  }
  return v;
}

function num(opts: Record<string, string | true>, key: string, def: number, min: number, max: number): number {
  const raw = str(opts, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(`--${key} ${min}–${max} arasında bir tam sayı olmalı.`);
  return n;
}

function readConfig(): ServerConfig {
  if (!fs.existsSync(files.config)) throw new CliError(`Sunucu kurulmamış (${files.config} yok). Önce "oda-server init" çalıştırın.`);
  const c = JSON.parse(fs.readFileSync(files.config, 'utf8')) as ServerConfig;
  if (!isValidPort(c.port) || !Array.isArray(c.publicAddresses) || !c.publicAddresses.length || !c.sfu?.apiKey || !c.sfu?.apiSecret || !c.sfu?.upstream) {
    throw new CliError(`${files.config} eksik veya geçersiz.`);
  }
  return c;
}

function writeConfig(c: ServerConfig): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = files.config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, files.config);
}

function withDb<T>(fn: (db: HostDb) => T): T {
  const db = HostDb.open(files.db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function cmdInit(opts: Record<string, string | true>): Promise<void> {
  if (fs.existsSync(files.db) || fs.existsSync(files.tls)) throw new CliError(`${dataDir} içinde zaten bir topluluk var.`);
  const name = normalizeRoomName(str(opts, 'name', true));
  if (!name) throw new CliError('--name 1–40 karakter olmalı.');
  const publicAddresses = (str(opts, 'public', true) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!publicAddresses.length || publicAddresses.length > 4 || !publicAddresses.every(isValidHost)) throw new CliError('--public geçerli IP/alan adı olmalı (virgülle en fazla 4).');
  const port = num(opts, 'port', DEFAULT_PORT, 1024, 65535);
  const sfu: SfuConfig = {
    apiKey: str(opts, 'livekit-key', true)!,
    apiSecret: str(opts, 'livekit-secret', true)!,
    upstream: str(opts, 'livekit-url') ?? 'http://127.0.0.1:7880',
  };
  if (sfu.apiSecret.length < 32) throw new CliError('--livekit-secret en az 32 karakter olmalı.');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tls = await loadOrCreateTls(files.tls, plainBox);
  withDb((db) => {
    db.db.transaction(() => {
      db.setMeta('host_id', newId(16));
      db.setMeta('host_name', name);
      db.setMeta('created_at', String(Date.now()));
    })();
  });
  writeConfig({ port, publicAddresses, sfu, maxConnections: 512, openRegistration: opts.open === true });
  console.log(`Topluluk oluşturuldu: ${name}`);
  console.log(`Parmak izi: ${tls.fingerprint}`);
  console.log('Sonraki adım: "oda-server invite --admin" ile yönetici daveti oluşturun.');
}

function cmdInvite(opts: Record<string, string | true>): void {
  const cfg = readConfig();
  const tls = loadTls(files.tls, plainBox);
  if (!tls) throw new CliError('TLS anahtarı bulunamadı.');
  const admin = opts.admin === true;
  const uses = num(opts, 'uses', 1, 1, 1000);
  const minutes = opts.hours !== undefined ? num(opts, 'hours', 24, 1, 2160) * 60 : num(opts, 'days', admin ? 1 : 7, 1, 90) * 1440;
  const code = withDb((db) => {
    if (!admin && !db.hasActiveAdmin()) throw new CliError('Önce "--admin" davetiyle bir yönetici katılmalı; oda ve ayarlar yönetici katıldığında oluşur.');
    const hostId = db.getMeta('host_id');
    if (!hostId) throw new CliError('Veritabanı başlatılmamış.');
    const r = issueInvite(db, { hostId, addresses: cfg.publicAddresses, port: cfg.port, fingerprint: tls.fingerprint, createdBy: null, roomId: null, maxUses: uses, minutes, role: admin ? 'admin' : 'member' });
    log.info('invite created', { invite: r.row.id, role: r.row.role, maxUses: uses, minutes });
    return r.code;
  });
  console.log(`${admin ? 'Yönetici' : 'Üye'} daveti (${uses} kullanım, ${Math.round(minutes / 60)} saat):`);
  console.log(code);
}

function cmdInvites(): void {
  withDb((db) => {
    for (const i of db.listInvites()) {
      const state = i.revoked ? 'iptal' : i.expiresAt < Date.now() ? 'süresi doldu' : i.uses >= i.maxUses ? 'tükendi' : 'etkin';
      console.log(`${i.id}  ${i.role.padEnd(6)}  ${i.uses}/${i.maxUses}  ${new Date(i.expiresAt).toISOString()}  ${state}`);
    }
  });
}

function cmdRevoke(id: string | undefined): void {
  if (!id) throw new CliError('Davet kimliği gerekli: oda-server revoke <id>');
  withDb((db) => db.revokeInvite(id));
  console.log('İptal edildi.');
}

function cmdRename(opts: Record<string, string | true>): void {
  const name = normalizeRoomName(str(opts, 'name', true));
  if (!name) throw new CliError('--name 1–40 karakter olmalı.');
  withDb((db) => db.setMeta('host_name', name));
  console.log(`Topluluk adı: ${name} (yeni bağlantılarda ve yeni davetlerde görünür)`);
}

function cmdStatus(): void {
  const cfg = readConfig();
  const tls = loadTls(files.tls, plainBox);
  withDb((db) => {
    const users = db.listUsers();
    console.log(`Topluluk : ${db.getMeta('host_name')} (${db.getMeta('host_id')})`);
    console.log(`Adresler : ${cfg.publicAddresses.join(', ')}  port ${cfg.port}`);
    console.log(`Parmak izi: ${tls?.fingerprint ?? '?'}`);
    console.log(`Üyeler   : ${users.length} (yönetici ${users.filter((u) => u.role === 'admin').length}, yasaklı ${users.filter((u) => u.status === 'banned').length})`);
    console.log(`Odalar   : ${db.listRooms().map((r) => `${r.name} [${r.capacity}]`).join(', ') || '—'}`);
    console.log(`Ses      : LiveKit ${cfg.sfu.upstream}`);
    console.log(`Kayıt    : ${cfg.openRegistration ? 'açık (herkes hesap ve kendi odasını açabilir)' : 'yalnızca davetle'}`);
  });
}

function cmdOpenRegistration(value: string | undefined): void {
  if (value !== 'on' && value !== 'off') throw new CliError('Kullanım: oda-server open-registration on|off');
  const cfg = readConfig();
  cfg.openRegistration = value === 'on';
  writeConfig(cfg);
  console.log(`Açık kayıt: ${value === 'on' ? 'açık' : 'kapalı'}. Etkinleşmesi için: systemctl restart oda-server`);
}

async function cmdBackup(file: string | undefined): Promise<void> {
  if (!file) throw new CliError('Hedef dosya gerekli: oda-server backup <dosya>');
  const db = HostDb.open(files.db);
  try {
    await db.backupTo(path.resolve(file));
  } finally {
    db.close();
  }
  console.log(`Yedek yazıldı: ${path.resolve(file)} (TLS anahtarı ayrıca ${files.tls} içinde)`);
}

async function autoBackup(db: HostDb): Promise<void> {
  fs.mkdirSync(files.backups, { recursive: true, mode: 0o700 });
  const list = fs.readdirSync(files.backups).filter((f) => /^auto-\d+\.db$/.test(f)).sort().reverse();
  const last = list[0] ? Number(/auto-(\d+)/.exec(list[0])![1]) : 0;
  if (Date.now() - last < BACKUP_INTERVAL_MS) return;
  await db.backupTo(path.join(files.backups, `auto-${Date.now()}.db`));
  for (const old of list.slice(BACKUP_KEEP - 1)) fs.rmSync(path.join(files.backups, old), { force: true });
  log.info('auto backup written');
}

async function cmdRun(): Promise<void> {
  const cfg = readConfig();
  const tls = loadTls(files.tls, plainBox);
  if (!tls) throw new CliError('TLS anahtarı bulunamadı.');
  const db = HostDb.open(files.db);
  const server = new HostServer({
    db,
    tls,
    port: cfg.port,
    advertisedAddresses: () => cfg.publicAddresses,
    sfu: cfg.sfu,
    dedicated: true,
    maxConnections: cfg.maxConnections,
    openRegistration: cfg.openRegistration === true,
  });
  await server.start();
  const backup = () => autoBackup(db).catch((e) => log.warn('auto backup failed', { err: errMessage(e) }));
  void backup();
  const timer = setInterval(backup, 3600 * 1000);
  log.info('server running', { port: cfg.port, fingerprint: tls.fingerprint, openRegistration: cfg.openRegistration === true });
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    clearInterval(timer);
    await server.stop().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

function help(): void {
  console.log(`ODA sunucusu
  init --name AD --public IP[,IP] --livekit-key K --livekit-secret S [--port ${DEFAULT_PORT}] [--livekit-url http://127.0.0.1:7880]
  run
  invite [--admin] [--uses N] [--days N | --hours N]
  invites
  revoke <id>
  status
  rename --name AD
  open-registration on|off   (açık: uygulamayı kuran herkes hesap ve kendi odasını açar)
  backup <dosya>
Veri klasörü: ${dataDir} (ODA_DATA ile değiştirilebilir)`);
}

async function main(): Promise<void> {
  const { cmd, pos, opts } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'init':
      return cmdInit(opts);
    case 'run':
      return cmdRun();
    case 'invite':
      return cmdInvite(opts);
    case 'invites':
      return cmdInvites();
    case 'revoke':
      return cmdRevoke(pos[0]);
    case 'status':
      return cmdStatus();
    case 'rename':
      return cmdRename(opts);
    case 'backup':
      return cmdBackup(pos[0]);
    case 'open-registration':
      return cmdOpenRegistration(pos[0]);
    default:
      return help();
  }
}

main().catch((e) => {
  if (e instanceof CliError) console.error(`Hata: ${e.message}`);
  else log.error('fatal', { err: errMessage(e) });
  process.exit(1);
});
