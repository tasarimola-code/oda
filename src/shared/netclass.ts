/** 'server': audio relayed by the host's media server (SFU); never produced by classifyAddress. */
export type PathKind = 'self' | 'lan' | 'private-overlay' | 'internet' | 'server' | 'unknown';

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** Classifies an IP address or hostname by network reachability class. */
export function classifyAddress(addr: string): PathKind {
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (!a) return 'unknown';
  if (a === 'localhost' || a === '::1') return 'self';
  const v4 = parseV4(a);
  if (v4) {
    const [x, y] = v4;
    if (x === 127) return 'self';
    if (x === 10) return 'lan';
    if (x === 172 && y >= 16 && y <= 31) return 'lan';
    if (x === 192 && y === 168) return 'lan';
    if (x === 169 && y === 254) return 'lan';
    if (x === 100 && y >= 64 && y <= 127) return 'private-overlay';
    return 'internet';
  }
  if (a.includes(':')) {
    if (a.startsWith('fe80')) return 'lan';
    if (a.startsWith('fd7a:115c:a1e0')) return 'private-overlay';
    if (a.startsWith('fc') || a.startsWith('fd')) return 'lan';
    return 'internet';
  }
  if (a.endsWith('.local')) return 'lan';
  if (a.endsWith('.ts.net')) return 'private-overlay';
  return 'internet';
}

export function isValidHost(host: string): boolean {
  const h = host.trim();
  if (!h || h.length > 253) return false;
  if (parseV4(h)) return true;
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(h) && h.includes(':')) return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(h);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
