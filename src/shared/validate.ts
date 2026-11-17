import { MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH, MAX_ROOM_NAME_LENGTH, MIN_NAME_LENGTH } from './protocol';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...s].length < MIN_NAME_LENGTH || [...s].length > MAX_NAME_LENGTH) return null;
  return s;
}

/** Key used for uniqueness: case- and Turkish-dotless-insensitive. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();
}

export function normalizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...s].length < 1 || [...s].length > MAX_ROOM_NAME_LENGTH) return null;
  return s;
}

export function normalizeMessageBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (s.length === 0 || s.length > MAX_MESSAGE_LENGTH) return null;
  return s;
}

export function isId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v);
}

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
}

export function isClientId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v);
}

/** Splits text into plain and link segments. Only http(s) URLs become links. */
export function linkify(text: string): Array<{ text: string; href?: string }> {
  const out: Array<{ text: string; href?: string }> = [];
  const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: url, href: url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.hostname.length > 0;
  } catch {
    return false;
  }
}
