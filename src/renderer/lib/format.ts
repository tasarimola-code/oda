import type { PathKind } from '../../shared/netclass';
import { MAX_ROOM_CAPACITY, MIN_ROOM_CAPACITY, type HostInfo } from '../../shared/protocol';
import { t } from '../i18n';

const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const formatTime = (ts: number): string => timeFmt.format(ts);
export const formatDateTime = (ts: number): string => dateTimeFmt.format(ts);

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t.common.today;
  if (d.toDateString() === yesterday.toDateString()) return t.common.yesterday;
  return dayFmt.format(ts);
}

export function initial(name: string): string {
  const ch = [...name.trim()][0] ?? '?';
  return ch.toLocaleUpperCase('tr-TR');
}

export function pathLabel(kind: PathKind | null | undefined): string {
  switch (kind) {
    case 'self':
      return t.net.self;
    case 'lan':
      return t.net.lan;
    case 'private-overlay':
      return t.net.overlay;
    case 'internet':
      return t.net.internet;
    case 'server':
      return t.net.server;
    default:
      return t.net.unknown;
  }
}

export function capacityNote(host: HostInfo | null): string {
  return t.room.capacityNote(host?.maxRoomCapacity ?? MAX_ROOM_CAPACITY);
}

/** Selectable room sizes: every value up to 10, then coarser steps up to the host's limit. */
export function capacityOptions(host: HostInfo | null, current?: number): number[] {
  const max = host?.maxRoomCapacity ?? MAX_ROOM_CAPACITY;
  const steps = [12, 15, 20, 25, 30, 40, 50, 75, 100];
  const out = new Set<number>();
  for (let n = MIN_ROOM_CAPACITY; n <= Math.min(10, max); n++) out.add(n);
  for (const n of steps) if (n <= max) out.add(n);
  out.add(max);
  if (current && current >= MIN_ROOM_CAPACITY && current <= max) out.add(current);
  return [...out].sort((a, b) => a - b);
}

export function relativeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return t.common.expired;
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} dk`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} sa`;
  return `${Math.round(h / 24)} gün`;
}
