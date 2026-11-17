// Smoke test for a packaged ODA.exe (fuses disable --inspect, so it cannot be driven by Playwright directly):
// 1) start a local oda-server, 2) seed a profile that joins it by pasting the invite (dev build UI),
// 3) start the packaged exe on that profile and verify it reconnects to the server on its own.
// Voice is not exercised here (no media server); see e2e-sfu.mjs and packaged-vps.mjs for that.
// Usage: node scripts/smoke-packaged.mjs [path\to\ODA.exe]
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const exe = path.resolve(process.argv[2] ?? path.join(root, 'out', 'win-unpacked', 'ODA.exe'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oda-smoke-'));
const profile = path.join(tmp, 'profile');
const serverJs = path.join(root, 'dist', 'server', 'oda-server.cjs');
const port = 44000 + Math.floor(Math.random() * 1000);
const serverEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ODA_DATA: path.join(tmp, 'server') };
const cli = (...args) => execFileSync(electronPath, [serverJs, ...args], { env: serverEnv, encoding: 'utf8' });
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const established = (pid) =>
  Number(
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -OwningProcess ${pid} -RemotePort ${port} -State Established -ErrorAction SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0',
  );

let server = null;
let child = null;
try {
  step('Packaged exe exists', fs.existsSync(exe), exe);
  cli('init', '--name', 'Smoke', '--public', '127.0.0.1', '--port', String(port), '--livekit-key', 'APIsmoke', '--livekit-secret', randomBytes(32).toString('base64url'), '--livekit-url', 'http://127.0.0.1:9');
  const code = cli('invite', '--admin').trim().split('\n').pop().trim();
  server = spawn(electronPath, [serverJs, 'run'], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.on('data', (d) => (serverOut += d));
  server.stderr.on('data', (d) => (serverOut += d));
  for (let i = 0; i < 40 && !/server running/.test(serverOut); i++) await sleep(250);
  step('Local ODA server running', /server running/.test(serverOut));

  const dev = await electron.launch({ executablePath: electronPath, args: [root, `--oda-profile=${profile}`], cwd: root });
  const page = await dev.firstWindow();
  await page.waitForSelector('.onboarding', { timeout: 20000 });
  await page.getByLabel('Görünen adın').fill('Test');
  await page.getByLabel('Davet kodu').fill(code);
  await page.waitForSelector('.room-header h1', { timeout: 20000 });
  await dev.close();
  await sleep(1000);
  step('Profile seeded by pasting the invite', fs.existsSync(path.join(profile, 'client.json')));
  step('No local host data in the desktop profile', !fs.existsSync(path.join(profile, 'host')));

  fs.rmSync(path.join(profile, 'logs'), { recursive: true, force: true });
  child = spawn(exe, [`--oda-profile=${profile}`], { stdio: 'ignore', windowsHide: false });
  let connected = false;
  for (let i = 0; i < 40 && !connected; i++) {
    await sleep(500);
    connected = established(child.pid) > 0;
  }
  step('Packaged app reconnected to the server on its own', connected, `port ${port}`);

  const logFile = path.join(profile, 'logs', 'oda.log');
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  step('Log shows packaged start', /starting .*packaged=true/.test(logText));
  step('Log contains no secrets', !/ODA1-|PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}/.test(logText));

  let title = '';
  for (let i = 0; i < 10 && !title; i++) {
    title = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' }).trim();
    if (!title) await sleep(500);
  }
  step('Main window is open', title.length > 0, title);
} catch (e) {
  step('Unexpected error', false, String(e?.message ?? e).split('\n')[0]);
} finally {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already exited */
    }
  }
  server?.kill();
  await sleep(1000);
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed.`);
process.exit(failed ? 1 : 0);
