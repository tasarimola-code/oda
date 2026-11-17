// Installed ODA.exe against a real ODA server: seeds a temporary profile that joins the server through the
// dev build, then starts the packaged exe on it (fuses block Playwright), joins voice via UI Automation and
// captures the window. Check the server side with: journalctl -u oda-livekit | grep 'participant active'
// Usage: $env:CODE='ODA1-…member invite…'; node scripts/packaged-vps.mjs "$env:LOCALAPPDATA\Programs\ODA\ODA.exe"
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const exe = process.argv[2];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oda-pkg-vps-'));
const outDir = path.join(root, 'test-results', 'install');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (file, ...args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', file), ...args], { encoding: 'utf8' }).trim();

const dev = await electron.launch({ executablePath: electronPath, args: [root, `--oda-profile=${profile}`], cwd: root });
const page = await dev.firstWindow();
await page.waitForSelector('.onboarding', { timeout: 20000 });
await page.getByLabel('Görünen adın').fill('Kurulum' + Math.floor(Math.random() * 1000));
await page.getByLabel('Davet kodu').fill(process.env.CODE);
try {
  await page.waitForSelector('.room-header h1', { timeout: 30000 });
} catch (e) {
  await page.screenshot({ path: path.join(outDir, 'seed-fail.png') });
  console.log('seed failed; visible text:', (await page.textContent('body')).slice(0, 600));
  await dev.close();
  process.exit(1);
}
await dev.close();
await sleep(1000);
console.log('seeded profile joined the server');

fs.rmSync(path.join(profile, 'logs'), { recursive: true, force: true });
const child = spawn(exe, [`--oda-profile=${profile}`, '--force-renderer-accessibility'], { stdio: 'ignore' });
try {
  await sleep(9000);
  console.log('invoke join voice:', ps('uia-invoke.ps1', String(child.pid), 'Odaya katıl'));
  await sleep(9000);
  console.log('capture:', ps('capture-window.ps1', String(child.pid), path.join(outDir, 'packaged-vps-voice.png')));
  const log = fs.readFileSync(path.join(profile, 'logs', 'oda.log'), 'utf8');
  console.log('log lines:', log.split('\n').length, 'packaged:', /packaged=true/.test(log), 'secrets:', /ODA1-|eyJ[A-Za-z0-9_-]{20,}/.test(log));
  console.log(log.split('\n').filter((l) => /client|connect|voice|sfu|error|warn/i.test(l)).slice(-15).join('\n'));
  console.log('invoke leave voice:', ps('uia-invoke.ps1', String(child.pid), 'Odadan Ayrıl'));
  await sleep(2000);
} finally {
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(1000);
  fs.rmSync(profile, { recursive: true, force: true });
}
