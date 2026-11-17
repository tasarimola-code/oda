import { create } from 'zustand';
import type { AppInfo, AppSettings, ClientStatus, SavedHostSummary } from '../../shared/ipc';
import type { ChatMessage, ConvKey, FriendEntry, HostInfo, RoomInfo, UserPublic } from '../../shared/protocol';
import type { PathKind } from '../../shared/netclass';

export type View = 'home' | 'chats' | 'friends' | 'settings';
export type MessageStatus = 'sending' | 'sent' | 'failed';

export interface UiMessage extends ChatMessage {
  status: MessageStatus;
  localId?: string;
}

export interface ConvState {
  messages: UiMessage[];
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
}

export type PeerState = 'connecting' | 'connected' | 'failed';

export interface PeerUi {
  state: PeerState;
  pathKind: PathKind | null;
  speaking: boolean;
}

export type MicError = 'denied' | 'notfound' | 'busy' | null;

export interface VoiceUi {
  roomId: string | null;
  joining: boolean;
  muted: boolean;
  deafened: boolean;
  micError: MicError;
  localSpeaking: boolean;
  peers: Record<string, PeerUi>;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface State {
  ready: boolean;
  bootError: string | null;
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  clientStatus: ClientStatus | null;
  savedHosts: SavedHostSummary[];
  focused: boolean;

  me: UserPublic | null;
  host: HostInfo | null;
  users: Record<string, UserPublic>;
  rooms: RoomInfo[];
  friends: FriendEntry[];
  blocked: string[];
  unread: Record<ConvKey, number>;
  convs: Record<ConvKey, ConvState>;

  view: View;
  activeRoomId: string | null;
  chatConv: ConvKey | null;
  chatOpen: boolean;
  sidebarOpen: boolean;
  modal: ModalState | null;

  voice: VoiceUi;
  toasts: Toast[];
}

export type ModalState =
  | { kind: 'invite'; roomId?: string }
  | { kind: 'createRoom' }
  | { kind: 'renameRoom'; roomId: string }
  | { kind: 'roomMembers'; roomId: string }
  | { kind: 'join' }
  | { kind: 'start'; step: 'create' | 'join' }
  | { kind: 'editAddress'; hostId: string }
  | { kind: 'confirm'; title: string; text: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> };

export const initialVoice: VoiceUi = { roomId: null, joining: false, muted: false, deafened: false, micError: null, localSpeaking: false, peers: {} };

export const useStore = create<State>(() => ({
  ready: false,
  bootError: null,
  appInfo: null,
  settings: null,
  clientStatus: null,
  savedHosts: [],
  focused: true,
  me: null,
  host: null,
  users: {},
  rooms: [],
  friends: [],
  blocked: [],
  unread: {},
  convs: {},
  view: 'chats',
  activeRoomId: null,
  chatConv: null,
  chatOpen: true,
  sidebarOpen: true,
  modal: null,
  voice: initialVoice,
  toasts: [],
}));

export const get = useStore.getState;
export const set = useStore.setState;

let toastSeq = 1;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = toastSeq++;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), kind === 'error' ? 7000 : 4000);
}

/** Shared so store selectors return a stable reference for conversations not loaded yet. */
const EMPTY_CONV: ConvState = Object.freeze({ messages: Object.freeze([]) as unknown as UiMessage[], hasMore: true, loaded: false, loading: false });

export function convOf(s: State, key: ConvKey): ConvState {
  return s.convs[key] ?? EMPTY_CONV;
}

export function isConnected(s: State): boolean {
  return s.clientStatus?.state === 'connected' && !!s.me;
}

export function userName(s: State, id: string): string {
  return s.users[id]?.displayName ?? 'Bilinmeyen';
}
