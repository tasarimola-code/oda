// Three isolated ODA instances (separate profiles) joining an ODA server by pasting invite codes,
// driven through the real UI: onboarding, messaging, friends/DM, voice through the SFU, server restart.
//
// Local (default): the real oda-server bundle + a real LiveKit media server on this PC.
//   ODA_LIVEKIT_BIN=path\to\livekit-server.exe node scripts/e2e-sfu.mjs
// Remote: against a deployed server over the internet, starting from a fresh server's admin invite.
//   ODA_REMOTE_ADMIN_CODE=ODA1-... node scripts/e2e-sfu.mjs
// Either way all clients run on this PC; it does not replace a test from different homes.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeBurstWav } from './fake-voice.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'test-results', 'e2e-sfu');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oda-e2e-sfu-'));
const lkBin = process.env.ODA_LIVEKIT_BIN ?? path.join(process.env.LOCALAPPDATA ?? '', 'oda-dev', 'livekit', 'livekit-server.exe');
const serverJs = path.join(root, 'dist', 'server', 'oda-server.cjs');
const port = 44000 + Math.floor(Math.random() * 1500);
const lkPort = 17880 + Math.floor(Math.random() * 100);
const results = [];
const remoteAdmin = process.env.ODA_REMOTE_ADMIN_CODE?.trim();

if (!remoteAdmin && !fs.existsSync(lkBin)) throw new Error(`LiveKit binary not found: ${lkBin}`);
if (!fs.existsSync(serverJs)) throw new Error('Run "npm run build" first.');

// Remote: media is expected at the server's public address. Local: UDP media does not bind to loopback,
// so LiveKit advertises the first LAN address.
const mediaHost = remoteAdmin
  ? JSON.parse(Buffer.from(remoteAdmin.slice(5), 'base64url').toString('utf8')).a[0]
  : Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254') && !a.address.startsWith('172.'))?.address;
if (!mediaHost) throw new Error('No LAN IPv4 address for LiveKit node_ip.');
const mediaPorts = remoteAdmin ? [7881, 7882] : [lkPort + 1, lkPort + 2];

function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------- media + ODA server
const lkKey = 'APIe2e' + randomBytes(4).toString('hex');
const lkSecret = randomBytes(32).toString('base64url');
const lkConfig = path.join(tmp, 'livekit.yaml');
fs.writeFileSync(
  lkConfig,
  [
    `port: ${lkPort}`,
    'bind_addresses: ["127.0.0.1"]',
    'rtc:',
    `  tcp_port: ${lkPort + 1}`,
    `  udp_port: ${lkPort + 2}`,
    '  use_external_ip: false',
    `  node_ip: ${mediaHost}`,
    '  ips:',
    '    includes:',
    `      - ${mediaHost}/32`,
    'keys:',
    `  ${lkKey}: ${lkSecret}`,
    'room:',
    '  max_participants: 50',
    '  empty_timeout: 60',
    'logging:',
    '  level: warn',
    '',
  ].join('\n'),
);
const lkLog = fs.createWriteStream(path.join(outDir, 'livekit.log'));
let livekit = null;
function startLivekit() {
  livekit = spawn(lkBin, ['--config', lkConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  livekit.stdout.pipe(lkLog, { end: false });
  livekit.stderr.pipe(lkLog, { end: false });
}

const odaData = path.join(tmp, 'server');
const serverEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ODA_DATA: odaData };
const cli = (...args) => execFileSync(electronPath, [serverJs, ...args], { env: serverEnv, encoding: 'utf8' });
let serverOut = '';
let odaServer = null;

let voiceSeed = 7;
async function launch(name) {
  const wav = path.join(tmp, `${name}.wav`);
  writeBurstWav(wav, voiceSeed++);
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root, `--oda-profile=${path.join(tmp, name)}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
    cwd: root,
  });
  // Test-side instrumentation only: lets the harness read WebRTC stats; the app itself exposes nothing.
  await app.context().addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__odaPcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__odaPcs.push(this);
      }
    };
  });
  const page = await app.firstWindow();
  const consoleLog = fs.createWriteStream(path.join(outDir, `console-${name}.log`));
  page.on('console', (m) => m.type() !== 'debug' && consoleLog.write(`${m.type()} ${m.text()}\n`));
  page.on('pageerror', (e) => consoleLog.write(`pageerror ${e.message}\n`));
  await page.reload();
  await page.setViewportSize({ width: 1600, height: 900 }).catch(() => undefined);
  await page.waitForSelector('.onboarding, .main', { timeout: 20000 });
  return { app, page, name };
}

// First launch shows the join form; pasting a valid code connects without pressing a button.
async function join(inst, code, displayName) {
  const { page } = inst;
  await page.getByLabel('Görünen adın').fill(displayName);
  await page.getByLabel('Davet kodu').fill(code);
  await page.waitForSelector('.room-header h1', { timeout: 20000 });
  return page.textContent('.room-header h1');
}

function expectedPrefill() {
  const n = os.userInfo().username.slice(0, 32).replace(/[._-]+/g, ' ').trim();
  return n.length >= 2 && n.length <= 32 ? n : '';
}

async function waitFor(fn, tries = 40, ms = 250) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

async function roomInfo(page, re, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const txt = (await page.textContent('.room-info').catch(() => '')) ?? '';
    if (re.test(txt)) return txt;
    await page.waitForTimeout(500);
  }
  return (await page.textContent('.room-info').catch(() => '')) ?? '';
}

async function inbound(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__odaPcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') out.push({ bytes: r.bytesReceived ?? 0, energy: r.totalAudioEnergy ?? 0 });
      });
    }
    return out;
  });
}

async function iceConfig(page) {
  return page.evaluate(() => (window.__odaPcs ?? []).map((pc) => (pc.getConfiguration().iceServers ?? []).length));
}

async function selectedRemote(page) {
  return page.evaluate(async () => {
    for (const pc of window.__odaPcs ?? []) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      let pairId;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      const pair = pairId && stats.get(pairId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      if (remote) return `${remote.address ?? remote.ip}:${remote.port}/${remote.protocol}`;
    }
    return null;
  });
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const insts = [];

try {
  let adminCode = remoteAdmin;
  if (!remoteAdmin) {
    startLivekit();
    cli('init', '--name', 'Sunucu Topluluğu', '--public', '127.0.0.1', '--port', String(port), '--livekit-key', lkKey, '--livekit-secret', lkSecret, '--livekit-url', `http://127.0.0.1:${lkPort}`);
    let refused = false;
    try {
      execFileSync(electronPath, [serverJs, 'invite'], { env: serverEnv, stdio: 'pipe' });
    } catch {
      refused = true;
    }
    step('Server: member invite refused before an admin exists', refused);
    adminCode = cli('invite', '--admin').trim().split('\n').pop().trim();
    step('Server: admin invite issued', adminCode.startsWith('ODA1-'));

    odaServer = spawn(electronPath, [serverJs, 'run'], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    odaServer.stdout.on('data', (d) => (serverOut += d));
    odaServer.stderr.on('data', (d) => (serverOut += d));
    for (let i = 0; i < 40 && !/server running/.test(serverOut); i++) await new Promise((r) => setTimeout(r, 250));
    step('Server: running', /server running/.test(serverOut));
  }

  const A = await launch('admin');
  insts.push(A);
  await shot(A.page, '00-onboarding');
  const joinFormFirst = (await A.page.getByLabel('Davet kodu').isVisible()) && (await A.page.getByText(/Oda oluştur|host ol|Yerel ağ/).count()) === 0;
  step('A: first launch shows only the invite join form (no local host / LAN option)', joinFormFirst);
  const prefill = await A.page.getByLabel('Görünen adın').inputValue();
  step('A: display name prefilled from the Windows account', prefill === expectedPrefill(), JSON.stringify(prefill));
  await A.page.getByLabel('Davet kodu').fill('ODA1-bozuk');
  step('A: malformed code shows an error and does not connect', await A.page.getByText('Davet kodu okunamadı').isVisible());
  step('A: joined server by pasting the admin invite', (await join(A, adminCode, 'Yönetici')) === 'Genel');

  await A.page.getByRole('button', { name: 'Davet Et' }).click();
  const usesDefault = await A.page.locator('#inv-uses').inputValue();
  const expDefault = await A.page.locator('#inv-exp').inputValue();
  step('A: server invite defaults (50 uses, 7 days) offered', usesDefault === '50' && expDefault === '10080', `${usesDefault} / ${expDefault}`);
  await A.page.getByRole('button', { name: 'Davet kodu oluştur' }).click();
  const codeBox = A.page.getByLabel('Davet kodu');
  await codeBox.waitFor({ timeout: 10000 });
  const code = await codeBox.inputValue();
  await shot(A.page, '01-server-invite');
  step('A: member invite created from the app', code.startsWith('ODA1-'));
  await A.page.locator('.modal-foot').getByRole('button', { name: 'Kapat', exact: true }).click();

  const B = await launch('b');
  insts.push(B);
  step('B: joined with invite', (await join(B, code, 'Deniz')) === 'Genel');
  const C = await launch('c');
  insts.push(C);
  step('C: joined with the same invite', (await join(C, code, 'Ece')) === 'Genel');

  const composerA = A.page.getByPlaceholder('Mesaj yaz…');
  await composerA.fill('Merhaba Deniz, hoş geldin! https://example.com');
  await composerA.press('Enter');
  await B.page.getByText('Merhaba Deniz, hoş geldin!').waitFor({ timeout: 10000 });
  step('Room message A→B delivered', true);
  const composerB = B.page.getByPlaceholder('Mesaj yaz…');
  await composerB.fill('Selam!\nİkinci satır');
  await composerB.press('Enter');
  await A.page.getByText('İkinci satır').waitFor({ timeout: 10000 });
  step('Room message B→A delivered (newline preserved)', true);
  const htmlProbe = '<img src=x onerror=alert(1)>';
  await composerB.fill(htmlProbe);
  await composerB.press('Enter');
  await A.page.getByText(htmlProbe).waitFor({ timeout: 10000 });
  step('User HTML is rendered as text', (await A.page.locator('.chat-panel img').count()) === 0);

  for (const i of insts) await i.page.getByRole('button', { name: 'Odaya katıl' }).click();
  for (const i of insts) {
    const txt = await roomInfo(i.page, /Ses: |Başarısız/);
    step(`${i.name}: voice connected through the server`, /Ses: Sunucu üzerinden/.test(txt), txt.match(/Ses: [^·]+|Başarısız[^·]*/)?.[0] ?? txt);
  }
  step('Peer cards show 3 participants', (await A.page.locator('.p-card').count()) === 3);

  await A.page.waitForTimeout(3000);
  for (const i of insts) {
    const s = await inbound(i.page);
    const live = s.filter((r) => r.bytes > 2000 && r.energy > 0);
    step(`${i.name}: receives audio from both others via SFU`, live.length >= 2, JSON.stringify(s));
  }
  step('No ICE/STUN servers configured on media connections', (await iceConfig(B.page)).every((n) => n === 0), JSON.stringify(await iceConfig(B.page)));
  const remote = await selectedRemote(B.page);
  step('Media flows directly to the media server ports', !!remote && remote.startsWith(`${mediaHost}:`) && (remote.includes(`:${mediaPorts[1]}/udp`) || remote.includes(`:${mediaPorts[0]}/tcp`)), remote ?? 'none');

  const seenSpeaking = async (page, name) => {
    for (let i = 0; i < 80; i++) {
      if ((await page.locator(`.p-card.speaking[aria-label^="${name}"]`).count()) > 0) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await A.page.locator('.control-bar').getByRole('button', { name: 'Mikrofonu kapat', exact: true }).click();
  step('Remote speaking indicator (server active speakers)', (await seenSpeaking(A.page, 'Deniz')) || (await seenSpeaking(A.page, 'Ece')));
  await shot(A.page, '02-voice-three');
  await shot(B.page, '03-voice-b');

  let mutedSeen = false;
  for (let i = 0; i < 20 && !mutedSeen; i++) {
    mutedSeen = (await B.page.locator('.p-card[aria-label^="Yönetici"][aria-label*="Mikrofonu kapalı"]').count()) > 0;
    if (!mutedSeen) await B.page.waitForTimeout(250);
  }
  step('Mute state visible to others', mutedSeen);

  if (!remoteAdmin) {
    // Media server restart: clients must get back without user action.
    livekit.kill();
    await new Promise((r) => setTimeout(r, 1500));
    startLivekit();
    const back = await roomInfo(B.page, /Ses: Sunucu üzerinden/, 120);
    await roomInfo(C.page, /Ses: Sunucu üzerinden/, 60);
    step('Voice recovers after a media server restart', /Ses: Sunucu üzerinden/.test(back), back.match(/Ses: [^·]+|Bağlanıyor|Başarısız[^·]*/)?.[0] ?? back);
    await B.page.waitForTimeout(2500);
    const afterB = (await inbound(B.page)).filter((r) => r.bytes > 2000);
    step('Audio flows again after restart', afterB.length >= 1, JSON.stringify(afterB));
  }

  await C.page.locator('.control-bar').getByRole('button', { name: /Odadan Ayrıl/ }).click();
  let left = false;
  for (let i = 0; i < 40 && !left; i++) {
    left = (await A.page.locator('.p-card').count()) === 2;
    if (!left) await A.page.waitForTimeout(250);
  }
  step('Leaving updates everyone', left);

  await A.page.getByRole('button', { name: 'Arkadaşlar' }).first().click();
  await A.page.getByRole('tab', { name: 'Kişi ekle' }).click();
  await A.page.locator('.page .list-row', { hasText: 'Deniz' }).getByRole('button', { name: 'Arkadaş ekle' }).click();
  await B.page.locator('.rail').getByRole('button', { name: /Arkadaşlar/ }).click();
  await B.page.getByRole('tab', { name: /Bekleyen/ }).click();
  await B.page.locator('.page').getByRole('button', { name: /Kabul et/ }).click();
  await B.page.getByRole('tab', { name: /^Arkadaşlar/ }).click();
  await B.page.locator('.page').getByRole('button', { name: /Mesaj gönder/ }).click();
  const dmBox = B.page.getByPlaceholder('Mesaj yaz…');
  await dmBox.fill('Özel mesaj: yarın 21:00?');
  await dmBox.press('Enter');
  await B.page.locator('.chat-panel').getByText('Özel mesaj: yarın 21:00?').waitFor({ timeout: 10000 });
  step('Friend request accepted and DM delivered with unread badge', await waitFor(async () => (await A.page.locator('.sidebar .badge, .rail .badge').count()) > 0));
  await shot(B.page, '05-dm');
  await A.page.getByRole('button', { name: 'Ana Sayfa' }).first().click();
  await shot(A.page, '06-home');
  const homeText = (await A.page.textContent('.page').catch(() => '')) ?? '';
  step('Home lists the server, no local host card', /Sunucuların/.test(homeText) && !/Bu bilgisayardaki oda|Hostu başlat/.test(homeText));

  await A.page.getByRole('button', { name: 'Ayarlar' }).first().click();
  await A.page.getByText('Bağlı olduğun sunucu').waitFor({ timeout: 5000 }).catch(() => undefined);
  const privacy = (await A.page.textContent('.privacy-list').catch(() => '')) ?? '';
  step('Privacy text explains server storage and non-E2E audio', /uçtan uca şifreli değildir/.test(privacy) && /sunucudaki SQLite/.test(privacy));
  await shot(A.page, '04-privacy');

  if (!remoteAdmin) {
    odaServer.kill();
    await new Promise((r) => odaServer.once('exit', r));
    step('B shows the server-unreachable state when the server stops', await waitFor(() => B.page.isVisible('.banner.warn, .banner.err')));
    await shot(B.page, '07-server-down');
    odaServer = spawn(electronPath, [serverJs, 'run'], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    odaServer.stdout.on('data', (d) => (serverOut += d));
    odaServer.stderr.on('data', (d) => (serverOut += d));
    const reconnected = await waitFor(async () => (await B.page.locator('.tb-status .dot.ok').count()) > 0 && !(await B.page.isVisible('.banner.warn, .banner.err')), 180);
    step('B reconnects automatically after the server restarts', reconnected);
    await B.page.getByRole('button', { name: 'Sohbetler' }).first().click();
    await B.page.locator('.chat-head').getByRole('button', { name: 'Oda Sohbeti' }).click({ timeout: 3000 }).catch(() => undefined);
    await B.page.getByText('İkinci satır').first().waitFor({ timeout: 10000 }).catch(() => undefined);
    step('Room history kept across the server restart', (await B.page.getByText('İkinci satır').count()) > 0);

    const status = cli('status');
    step('Server status lists members and rooms', /Üyeler\s+: 3/.test(status) && /Genel \[25\]/.test(status), status.split('\n').find((l) => l.startsWith('Üyeler')) ?? '');
    step('Server log contains no tokens or invite secrets', !/eyJ|access_token|ODA1-/.test(serverOut));
  }
} catch (e) {
  step('Unexpected error', false, String(e?.message ?? e).split('\n')[0]);
  for (const i of insts) await shot(i.page, `error-${i.name}`).catch(() => undefined);
} finally {
  for (const i of insts) await i.app.close().catch(() => undefined);
  odaServer?.kill();
  livekit?.kill();
  fs.writeFileSync(path.join(outDir, 'server.log'), serverOut);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) {
    for (const who of ['admin', 'b', 'c']) {
      const log = path.join(tmp, who, 'logs', 'oda.log');
      if (fs.existsSync(log)) fs.copyFileSync(log, path.join(outDir, `${who}.log`));
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Output: ${outDir}`);
process.exit(failed ? 1 : 0);
