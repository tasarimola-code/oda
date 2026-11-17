import { isValidHost, isValidPort } from './netclass';

export interface InvitePayload {
  v: 1;
  /** host id */
  h: string;
  /** host display name */
  n: string;
  /** candidate addresses (IP or DNS names) */
  a: string[];
  /** port */
  p: number;
  /** TLS certificate SHA-256 fingerprint (AA:BB:..) */
  f: string;
  /** invite secret */
  s: string;
}

const PREFIX = 'ODA1-';

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeInvite(p: Omit<InvitePayload, 'v'>): string {
  return PREFIX + b64urlEncode(JSON.stringify({ v: 1, ...p }));
}

const FP_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function isFingerprint(v: unknown): v is string {
  return typeof v === 'string' && FP_RE.test(v);
}

export function decodeInvite(code: string): InvitePayload | null {
  const trimmed = code.replace(/\s+/g, '');
  if (!trimmed.startsWith(PREFIX) || trimmed.length > 4096) return null;
  try {
    const obj = JSON.parse(b64urlDecode(trimmed.slice(PREFIX.length))) as Partial<InvitePayload>;
    if (obj.v !== 1) return null;
    if (typeof obj.h !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(obj.h)) return null;
    if (typeof obj.n !== 'string' || obj.n.length > 64) return null;
    if (!Array.isArray(obj.a) || obj.a.length === 0 || obj.a.length > 12) return null;
    const addrs = obj.a.filter((x): x is string => typeof x === 'string' && isValidHost(x));
    if (addrs.length === 0) return null;
    if (typeof obj.p !== 'number' || !isValidPort(obj.p)) return null;
    if (!isFingerprint(obj.f)) return null;
    if (typeof obj.s !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(obj.s)) return null;
    return { v: 1, h: obj.h, n: obj.n, a: addrs, p: obj.p, f: obj.f, s: obj.s };
  } catch {
    return null;
  }
}

/** Short human-comparable form of a fingerprint (first 4 groups). */
export function shortFingerprint(fp: string): string {
  return fp.split(':').slice(0, 6).join(':');
}
