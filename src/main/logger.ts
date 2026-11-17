import fs from 'node:fs';
import path from 'node:path';

type Level = 'info' | 'warn' | 'error';
type Meta = Record<string, string | number | boolean | null | undefined>;

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;
const SENSITIVE_KEYS = /(secret|token|invite|password|passphrase|signature|private|body|sdp|candidate|nonce)/i;

let logFile: string | null = null;
let consoleEnabled = true;

export function initLogger(dir: string, opts: { console?: boolean } = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'oda.log');
  consoleEnabled = opts.console ?? true;
}

export function logDirectory(): string | null {
  return logFile ? path.dirname(logFile) : null;
}

function rotate(): void {
  if (!logFile) return;
  try {
    const st = fs.statSync(logFile);
    if (st.size < MAX_BYTES) return;
  } catch {
    return;
  }
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${logFile}.${i}`;
    const to = `${logFile}.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  fs.renameSync(logFile, `${logFile}.1`);
}

/** Drops values of keys that may carry secrets or message content. */
function scrub(meta?: Meta): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    parts.push(`${k}=${SENSITIVE_KEYS.test(k) ? '[gizli]' : String(v).slice(0, 200)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function write(level: Level, scope: string, msg: string, meta?: Meta): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${scrub(meta)}`;
  if (consoleEnabled) (level === 'error' ? console.error : console.log)(line);
  if (!logFile) return;
  try {
    rotate();
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* logging must never crash the app */
  }
}

export interface Logger {
  info(msg: string, meta?: Meta): void;
  warn(msg: string, meta?: Meta): void;
  error(msg: string, meta?: Meta): void;
}

export function createLogger(scope: string): Logger {
  return {
    info: (m, meta) => write('info', scope, m, meta),
    warn: (m, meta) => write('warn', scope, m, meta),
    error: (m, meta) => write('error', scope, m, meta),
  };
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
