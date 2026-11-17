import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppController, UserError } from './controller';
import { createLogger, errMessage, initLogger, logDirectory } from './logger';
import type { SecretBox } from './secretBox';
import { isSafeExternalUrl } from '../shared/validate';
import type { AppInfo, IpcResult, RendererEvents } from '../shared/ipc';
import { MIN_BACKUP_PASSWORD } from './backup';

// ---------------------------------------------------------------- early setup
const argProfile = process.argv.find((a) => a.startsWith('--oda-profile='));
if (argProfile) app.setPath('userData', path.resolve(argProfile.slice('--oda-profile='.length)));
const startHidden = process.argv.includes('--hidden');

// Local IPs are exchanged only with authenticated room members; mDNS names often fail to resolve across Windows PCs.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.setAppUserModelId('com.oda.app');

protocol.registerSchemesAsPrivileged([{ scheme: 'oda', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const APP_ORIGIN = 'oda://app';
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob: mediastream:",
  // Only the loopback SFU bridge (secret path, pinned upstream); nothing on the network directly.
  "connect-src ws://127.0.0.1:* http://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};

let log = createLogger('main');
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: AppController | null = null;
let quitting = false;

if (!argProfile && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(onReady);
}

function assetPath(name: string): string {
  return path.join(__dirname, '..', 'assets', name);
}

function rendererRoot(): string {
  return path.join(__dirname, '..', 'renderer');
}

function makeSecretBox(): SecretBox {
  const available = safeStorage.isEncryptionAvailable();
  return {
    available,
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  };
}

function send<E extends keyof RendererEvents>(e: E, payload: RendererEvents[E]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('oda:event', e, payload);
}

async function onReady(): Promise<void> {
  initLogger(path.join(app.getPath('userData'), 'logs'), { console: !app.isPackaged });
  log = createLogger('main');
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged });

  registerProtocol();
  hardenSession();
  controller = new AppController(app.getPath('userData'), makeSecretBox(), send, app.getVersion());
  registerIpc(controller);
  applyLoginItem();
  createWindow();
  createTray();
  await controller.restore();
}

function registerProtocol(): void {
  const root = rendererRoot();
  protocol.handle('oda', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(full);
      return new Response(data, {
        headers: {
          'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function isAppUrl(url: string | undefined | null): boolean {
  return !!url && (url === APP_ORIGIN || url.startsWith(APP_ORIGIN + '/'));
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = (details as { requestingUrl?: string }).requestingUrl ?? wc.getURL();
    if (!isAppUrl(origin)) return callback(false);
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return callback(types.length > 0 && types.every((t) => t === 'audio'));
    }
    if (permission === 'speaker-selection') return callback(true);
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => isAppUrl(origin) && (permission === 'media' || permission === 'speaker-selection'));
  ses.on('will-download', (e) => e.preventDefault());
}

function createWindow(): void {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1600, Math.max(1280, wa.width - 80));
  const height = Math.min(900, Math.max(720, wa.height - 60));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    title: 'ODA',
    backgroundColor: '#101216',
    icon: assetPath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101216', symbolColor: '#B8BDC6', height: 36 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  Menu.setApplicationMenu(null);
  const wc = mainWindow.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('render-process-gone', (_e, d) => {
    log.error('renderer gone', { reason: d.reason });
    if (!quitting && d.reason !== 'clean-exit') setTimeout(() => mainWindow?.reload(), 500);
  });
  mainWindow.on('ready-to-show', () => {
    const s = controller?.settings.get();
    if (!(startHidden || s?.app.startMinimized && process.argv.includes('--hidden'))) mainWindow?.show();
  });
  mainWindow.on('focus', () => send('app.focus', { focused: true }));
  mainWindow.on('blur', () => send('app.focus', { focused: false }));
  mainWindow.on('close', (e) => {
    const s = controller?.settings.get();
    if (!quitting && s?.app.closeToTray && tray) {
      e.preventDefault();
      mainWindow?.hide();
      if (!s.trayHintShown && Notification.isSupported()) {
        new Notification({
          title: 'ODA arka planda çalışıyor',
          body: 'Sunucuya bağlı kalır ve mesaj bildirimleri gelir. Tamamen kapatmak için tepsi simgesinden Çıkış seçin.',
          icon: assetPath('icon.png'),
        }).show();
        controller?.settings.set({ trayHintShown: true });
      }
    }
  });
  void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(assetPath('icon.png')).resize({ width: 16, height: 16 }));
  } catch (e) {
    log.warn('tray unavailable', { err: errMessage(e) });
    return;
  }
  tray.setToolTip('ODA');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "ODA'yı göster", click: showWindow },
      { type: 'separator' },
      { label: 'Çıkış', click: () => quitApp() },
    ]),
  );
  tray.on('click', showWindow);
}

function quitApp(): void {
  quitting = true;
  app.quit();
}

app.on('before-quit', (e) => {
  quitting = true;
  if (controller) {
    e.preventDefault();
    const c = controller;
    controller = null;
    void c
      .shutdown()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  }
});

app.on('window-all-closed', () => {
  if (!tray) quitApp();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!isAppUrl(url)) ev.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

function applyLoginItem(): void {
  if (!app.isPackaged || !controller) return;
  const s = controller.settings.get();
  app.setLoginItemSettings({ openAtLogin: s.app.startWithWindows, name: 'ODA', args: s.app.startMinimized ? ['--hidden'] : [] });
}

// ---------------------------------------------------------------- IPC
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcResult<R>> => {
    if (!isAppUrl(event.senderFrame?.url) || event.sender !== mainWindow?.webContents) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'forbidden' } };
    }
    try {
      return { ok: true, data: await fn(...(args as A)) };
    } catch (e) {
      const code = e instanceof UserError ? e.code : ((e as { code?: string }).code ?? 'ERROR');
      if (!(e instanceof UserError)) log.warn('ipc error', { channel, err: errMessage(e) });
      return { ok: false, error: { code, message: errMessage(e) } };
    }
  });
}

const str = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || v.length > max) throw new UserError('BAD_REQUEST', 'Geçersiz değer.');
  return v;
};
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new UserError('BAD_REQUEST', 'Geçersiz sayı.');
  return v;
};

function windowsUserName(): string {
  try {
    return os.userInfo().username.slice(0, 32);
  } catch {
    return '';
  }
}

function registerIpc(c: AppController): void {
  handle('app.info', (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${os.type()} ${os.release()}`,
    userDataDir: app.getPath('userData'),
    logDir: logDirectory() ?? '',
    secureStorage: safeStorage.isEncryptionAvailable(),
    deviceName: os.hostname(),
    userName: windowsUserName(),
    defaultServer: { hostId: c.defaultServer.hostId, hostName: c.defaultServer.hostName },
  }));
  handle('app.openLogs', async () => {
    const dir = logDirectory();
    if (dir) await shell.openPath(dir);
  });
  handle('app.openExternal', async (url: unknown) => {
    const u = str(url, 2048);
    if (!isSafeExternalUrl(u) || !mainWindow) return false;
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Aç', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      title: 'Bağlantıyı aç',
      message: 'Bu bağlantı varsayılan tarayıcınızda açılacak.',
      detail: u,
    });
    if (r.response !== 0) return false;
    await shell.openExternal(u);
    return true;
  });
  handle('app.openMicPrivacy', async () => {
    await shell.openExternal('ms-settings:privacy-microphone');
  });
  handle('app.notify', (title: unknown, body: unknown) => {
    const s = c.settings.get();
    if (!s.notifications.messages || !Notification.isSupported() || mainWindow?.isFocused()) return;
    const n = new Notification({ title: str(title, 100), body: str(body, 200), icon: assetPath('icon.png'), silent: !s.notifications.sounds });
    n.on('click', showWindow);
    n.show();
  });
  handle('app.copyText', (text: unknown) => clipboard.writeText(str(text, 8192)));
  handle('app.quit', () => quitApp());

  handle('settings.get', () => c.settings.get());
  handle('settings.set', (patch: unknown) => {
    const next = c.settings.set((patch ?? {}) as never);
    applyLoginItem();
    return next;
  });

  handle('client.status', () => c.clientStatus());
  handle('client.savedHosts', () => c.profile.summaries());
  handle('client.previewInvite', (code: unknown) => c.previewInvite(str(code, 4096)));
  handle('client.joinWithInvite', (opts: unknown) => {
    const o = (opts ?? {}) as Record<string, unknown>;
    return c.joinWithInvite({ code: str(o.code, 4096), displayName: str(o.displayName, 64) });
  });
  handle('client.createAccount', (opts: unknown) => {
    const o = (opts ?? {}) as Record<string, unknown>;
    return c.createAccount({ displayName: str(o.displayName, 64) });
  });
  handle('client.connectSaved', (hostId: unknown) => c.connectSaved(str(hostId, 64)));
  handle('client.updateSavedAddress', (hostId: unknown, address: unknown, port: unknown) => c.updateSavedAddress(str(hostId, 64), str(address, 253), int(port)));
  handle('client.disconnect', () => c.disconnect());
  handle('client.forget', (hostId: unknown) => c.forget(str(hostId, 64)));
  handle('client.request', (method: unknown, params: unknown) => c.request(str(method, 64), params));
  handle('client.sfuUrl', () => c.sfuUrl());

  handle('backup.exportTo', async (password: unknown) => {
    const pw = str(password, 256);
    if (pw.length < MIN_BACKUP_PASSWORD) throw new UserError('BAD_REQUEST', `Yedek parolası en az ${MIN_BACKUP_PASSWORD} karakter olmalı.`);
    if (!mainWindow) return null;
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'ODA yedeğini kaydet',
      defaultPath: path.join(app.getPath('documents'), `ODA-yedek-${stamp}.odabak`),
      filters: [{ name: 'ODA yedeği', extensions: ['odabak'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await c.exportBackup(r.filePath, pw);
    return { path: r.filePath };
  });
  handle('backup.importFrom', async (password: unknown) => {
    const pw = str(password, 256);
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'ODA yedeğini seç',
      properties: ['openFile'],
      filters: [{ name: 'ODA yedeği', extensions: ['odabak'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return c.importBackup(r.filePaths[0], pw);
  });
}
