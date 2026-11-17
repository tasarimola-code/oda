import { get, set, toast, convOf, initialVoice, useStore, type UiMessage, type View } from './store';
import { oda, rpc, unwrap, errorText, randomId, OdaError } from '../lib/api';
import { SfuVoice } from '../voice/SfuVoice';
import type { BaseVoice, VoiceCallbacks } from '../voice/base';
import { t } from '../i18n';
import type { AppSettings, ClientStatus, DeepPartial, RendererEvents } from '../../shared/ipc';
import { HISTORY_PAGE_SIZE, type ChatMessage, type ConvKey, type ConvRef, type RtcSignal, type ServerEvents, type VoiceParticipant } from '../../shared/protocol';

let voice: BaseVoice | null = null;
let pendingRejoin: string | null = null;

const voiceCallbacks: VoiceCallbacks = {
  signal: async (to, data) => {
    await rpc('rtc.signal', { to, data });
  },
  onPeers: (peers) => set((s) => ({ voice: { ...s.voice, peers } })),
  onLocalSpeaking: (v) => set((s) => ({ voice: { ...s.voice, localSpeaking: v } })),
  onMicError: (e) => set((s) => ({ voice: { ...s.voice, micError: e } })),
  onDeviceFallback: () => toast(t.mic.deviceLost, 'info'),
  sfuUrl: () => unwrap(oda().client.sfuUrl()),
  regrant: async (roomId) => {
    const v = get().voice;
    if (v.roomId !== roomId) return null;
    const res = await rpc('voice.join', { roomId, muted: v.muted, deafened: v.deafened });
    return res.sfu ?? null;
  },
};

/** Voice always goes through the ODA server's media server (LiveKit). */
function ensureVoice(): void {
  const settings = get().settings;
  if (!settings || voice) return;
  voice = new SfuVoice(settings.audio, voiceCallbacks);
  voice.setBlocked(get().blocked);
}

export function convRef(key: ConvKey): ConvRef {
  if (key.startsWith('room:')) return { kind: 'room', roomId: key.slice(5) };
  return { kind: 'dm', userId: key.slice(3) };
}

// ---------------------------------------------------------------- init
export async function init(): Promise<void> {
  const api = oda();
  api.on('client.status', onClientStatus);
  api.on('client.event', onServerEvent);
  api.on('app.focus', ({ focused }) => {
    set({ focused });
    if (focused) markVisibleRead();
  });
  const [appInfo, settings, clientStatus, savedHosts] = await Promise.all([
    unwrap(api.app.info()),
    unwrap(api.settings.get()),
    unwrap(api.client.status()),
    unwrap(api.client.savedHosts()),
  ]);
  set({ appInfo, settings, savedHosts, ready: true });
  ensureVoice();
  useStore.subscribe((s, p) => {
    if (s.blocked !== p.blocked) voice?.setBlocked(s.blocked);
  });
  onClientStatus(clientStatus);
  if (!settings.onboardingDone && savedHosts.length > 0) {
    await updateSettings({ onboardingDone: true });
  }
}

export async function updateSettings(patch: DeepPartial<AppSettings>): Promise<void> {
  try {
    const next = await unwrap(oda().settings.set(patch));
    set({ settings: next });
    voice?.updateSettings(next.audio);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function refreshSavedHosts(): Promise<void> {
  const savedHosts = await unwrap(oda().client.savedHosts());
  set({ savedHosts });
}

// ---------------------------------------------------------------- connection
let lastState: ClientStatus['state'] | null = null;

function onClientStatus(s: ClientStatus): void {
  const prev = get().clientStatus;
  set({ clientStatus: s });
  if (s.state === 'connected' && (lastState !== 'connected' || prev?.hostId !== s.hostId)) {
    void loadBootstrap();
    void refreshSavedHosts();
  }
  if (s.state !== 'connected' && lastState === 'connected') {
    pendingRejoin = get().voice.roomId;
    void voice?.leave();
    set((st) => ({
      voice: { ...initialVoice, muted: st.voice.muted },
      convs: failPending(st.convs),
    }));
  }
  if (prev?.hostId && prev.hostId !== s.hostId) {
    set({ me: null, host: null, users: {}, rooms: [], friends: [], blocked: [], unread: {}, convs: {}, activeRoomId: null, chatConv: null });
  }
  if (s.state === 'failed' || s.state === 'idle') void refreshSavedHosts();
  lastState = s.state;
}

function failPending(convs: ReturnType<typeof get>['convs']) {
  const out: typeof convs = {};
  for (const [k, c] of Object.entries(convs)) {
    out[k] = { ...c, messages: c.messages.map((m) => (m.status === 'sending' ? { ...m, status: 'failed' as const } : m)) };
  }
  return out;
}

async function loadBootstrap(): Promise<void> {
  try {
    const b = await rpc('state.bootstrap', {});
    const users: Record<string, (typeof b.users)[number]> = {};
    for (const u of b.users) users[u.id] = u;
    const st = get();
    const activeRoomId = b.rooms.find((r) => r.id === st.activeRoomId)?.id ?? b.rooms[0]?.id ?? null;
    const chatConv = st.chatConv && (st.chatConv.startsWith('dm:') || b.rooms.some((r) => `room:${r.id}` === st.chatConv)) ? st.chatConv : activeRoomId ? `room:${activeRoomId}` : null;
    set({ me: b.me, host: b.host, users, rooms: b.rooms, friends: b.friends, blocked: b.blocked, unread: b.unread, activeRoomId, chatConv, convs: {} });
    if (chatConv) void loadHistory(chatConv, true);
    ensureVoice();
    voice?.setBlocked(b.blocked);
    // Rejoin voice after reconnect if we were in a room.
    const wanted = pendingRejoin;
    pendingRejoin = null;
    if (wanted && b.rooms.some((r) => r.id === wanted)) void joinVoice(wanted);
    maybeEnterWanted();
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

// ---------------------------------------------------------------- own rooms & invites
const OWN_INVITE = { maxUses: 100, expiresInMinutes: 30 * 24 * 60 };
export const OWN_INVITE_DAYS = OWN_INVITE.expiresInMinutes / 1440;
export const OWN_INVITE_USES = OWN_INVITE.maxUses;
const NEW_ROOM_CAPACITY = 25;

/** Room to open (and join by voice) as soon as it shows up in the room list; `null` id means the first room. */
let wantRoom: { id: string | null; voice: boolean } | null = null;

export function enterRoom(roomId: string | null, withVoice: boolean): void {
  wantRoom = { id: roomId, voice: withVoice };
  maybeEnterWanted();
}

function maybeEnterWanted(): void {
  const w = wantRoom;
  const s = get();
  if (!w || !s.me) return;
  const id = w.id ?? s.rooms[0]?.id;
  if (!id || !s.rooms.some((r) => r.id === id)) return;
  wantRoom = null;
  selectRoom(id);
  if (w.voice && s.voice.roomId !== id) void joinVoice(id);
}

/** Can the signed-in user create rooms on the server they are connected to? */
export function canCreateRoomHere(): boolean {
  const s = get();
  return s.clientStatus?.state === 'connected' && !!s.me && (s.host?.openRegistration === true || s.me.role === 'admin');
}

export function openCreateRoom(): void {
  set({ modal: canCreateRoomHere() ? { kind: 'createRoom' } : { kind: 'start', step: 'create' } });
}

export function openJoin(): void {
  set({ modal: { kind: 'join' } });
}

/** Creates an invite code for a room the user owns. */
export async function createRoomInvite(roomId: string): Promise<string> {
  const r = await rpc('invites.create', { roomId, ...OWN_INVITE });
  return r.code;
}

/** Signs in to the built-in server (creating the account if needed), creates a room and its invite. */
export async function createOwnRoom(displayName: string, roomName: string): Promise<{ roomId: string; code: string }> {
  await unwrap(oda().client.createAccount({ displayName }));
  const room = await rpc('rooms.create', { name: roomName, isPrivate: true, capacity: NEW_ROOM_CAPACITY });
  set((s) => ({ rooms: s.rooms.some((r) => r.id === room.id) ? s.rooms : [...s.rooms, room] }));
  const code = await createRoomInvite(room.id);
  return { roomId: room.id, code };
}

/** Joins an invite's room, creating an account on its server first if this device has none. */
export async function joinByCode(code: string, displayName: string): Promise<void> {
  const res = await unwrap(oda().client.joinWithInvite({ code, displayName }));
  // A new account joined through the invite has exactly the invite's room.
  enterRoom(res.roomId, true);
}

export async function connectSaved(hostId: string): Promise<void> {
  try {
    await unwrap(oda().client.connectSaved(hostId));
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

/** Signs back in with the account already on this device. Never asks for an invite. */
export async function signIn(): Promise<void> {
  const s = get();
  const def = s.appInfo?.defaultServer.hostId;
  const hosts = s.savedHosts.filter((h) => !h.isOwnHost);
  const id = hosts.find((h) => h.hostId === def)?.hostId ?? hosts.find((h) => h.hostId === s.clientStatus?.hostId)?.hostId ?? hosts[0]?.hostId;
  if (!id) {
    openCreateRoom();
    return;
  }
  await connectSaved(id);
}

export async function disconnect(): Promise<void> {
  await leaveVoice();
  await unwrap(oda().client.disconnect()).catch(() => undefined);
}

// ---------------------------------------------------------------- navigation
export function setView(view: View): void {
  set({ view });
  if (view === 'chats') {
    const s = get();
    if (!s.chatConv && s.activeRoomId) openConv(`room:${s.activeRoomId}`);
  }
}

export function selectRoom(roomId: string): void {
  set({ activeRoomId: roomId, view: 'chats' });
  openConv(`room:${roomId}`);
}

export function openConv(key: ConvKey): void {
  set({ chatConv: key, chatOpen: true });
  const c = convOf(get(), key);
  if (!c.loaded && !c.loading) void loadHistory(key, true);
  else markVisibleRead();
}

export function openDm(userId: string): void {
  openConv(`dm:${userId}`);
}

// ---------------------------------------------------------------- messages
export async function loadHistory(key: ConvKey, initial = false): Promise<void> {
  const c = convOf(get(), key);
  if (c.loading || (!initial && !c.hasMore)) return;
  set((s) => ({ convs: { ...s.convs, [key]: { ...convOf(s, key), loading: true } } }));
  try {
    const beforeId = initial ? undefined : c.messages.find((m) => m.id > 0)?.id;
    const res = await rpc('messages.history', { conv: convRef(key), beforeId, limit: HISTORY_PAGE_SIZE });
    set((s) => {
      const cur = convOf(s, key);
      const incoming: UiMessage[] = res.messages.map((m) => ({ ...m, status: 'sent' }));
      const known = new Set(cur.messages.map((m) => m.id));
      const merged = initial
        ? [...incoming, ...cur.messages.filter((m) => m.id < 0 || !incoming.some((x) => x.id === m.id))]
        : [...incoming.filter((m) => !known.has(m.id)), ...cur.messages];
      return { convs: { ...s.convs, [key]: { messages: merged, hasMore: res.hasMore, loaded: true, loading: false } } };
    });
    markVisibleRead();
  } catch (e) {
    set((s) => ({ convs: { ...s.convs, [key]: { ...convOf(s, key), loading: false } } }));
    if (!(e instanceof OdaError && e.code === 'OFFLINE')) toast(errorText(e), 'error');
  }
}

let readTimer: ReturnType<typeof setTimeout> | null = null;
export function markVisibleRead(): void {
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const s = get();
    const key = s.chatConv;
    if (!key || !s.focused || !s.chatOpen || s.clientStatus?.state !== 'connected') return;
    const c = convOf(s, key);
    const last = [...c.messages].reverse().find((m) => m.id > 0);
    if (!last) return;
    if (s.unread[key]) set((st) => ({ unread: { ...st.unread, [key]: 0 } }));
    void rpc('messages.markRead', { conv: convRef(key), lastId: last.id }).catch(() => undefined);
  }, 300);
}

let tempSeq = -1;
export async function sendMessage(key: ConvKey, body: string, existing?: UiMessage): Promise<void> {
  const s = get();
  if (!s.me) return;
  const clientId = existing?.clientId ?? randomId(20);
  const localId = existing?.localId ?? `l${tempSeq}`;
  const temp: UiMessage = existing
    ? { ...existing, status: 'sending' }
    : { id: tempSeq--, conv: key, senderId: s.me.id, body, createdAt: Date.now(), clientId, status: 'sending', localId };
  set((st) => {
    const c = convOf(st, key);
    const msgs = existing ? c.messages.map((m) => (m.localId === localId ? temp : m)) : [...c.messages, temp];
    return { convs: { ...st.convs, [key]: { ...c, messages: msgs } } };
  });
  if (s.clientStatus?.state !== 'connected') {
    setMessageStatus(key, localId, 'failed');
    return;
  }
  try {
    const msg = await rpc('messages.send', { conv: convRef(key), body: temp.body, clientId });
    set((st) => {
      const c = convOf(st, key);
      const withoutDup = c.messages.filter((m) => m.id !== msg.id || m.localId === localId);
      return { convs: { ...st.convs, [key]: { ...c, messages: withoutDup.map((m) => (m.localId === localId ? { ...msg, status: 'sent' as const, localId } : m)) } } };
    });
  } catch (e) {
    setMessageStatus(key, localId, 'failed');
    if (e instanceof OdaError && e.code !== 'OFFLINE' && e.code !== 'TIMEOUT') toast(e.message, 'error');
  }
}

function setMessageStatus(key: ConvKey, localId: string, status: UiMessage['status']): void {
  set((st) => {
    const c = convOf(st, key);
    return { convs: { ...st.convs, [key]: { ...c, messages: c.messages.map((m) => (m.localId === localId ? { ...m, status } : m)) } } };
  });
}

export function discardMessage(key: ConvKey, localId: string): void {
  set((st) => {
    const c = convOf(st, key);
    return { convs: { ...st.convs, [key]: { ...c, messages: c.messages.filter((m) => m.localId !== localId) } } };
  });
}

function onIncomingMessage(m: ChatMessage): void {
  const s = get();
  if (!s.me) return;
  const key = m.conv;
  const c = s.convs[key];
  if (c?.loaded) {
    if (!c.messages.some((x) => x.id === m.id || (x.clientId && x.clientId === m.clientId && x.senderId === m.senderId))) {
      set((st) => {
        const cur = convOf(st, key);
        return { convs: { ...st.convs, [key]: { ...cur, messages: [...cur.messages, { ...m, status: 'sent' }] } } };
      });
    }
  }
  if (m.senderId === s.me.id) return;
  const visible = s.chatConv === key && s.chatOpen && s.focused;
  if (visible) {
    markVisibleRead();
  } else {
    set((st) => ({ unread: { ...st.unread, [key]: Math.min(999, (st.unread[key] ?? 0) + 1) } }));
  }
  if (!s.focused) {
    const sender = s.users[m.senderId]?.displayName ?? '';
    const where = key.startsWith('room:') ? s.rooms.find((r) => `room:${r.id}` === key)?.name : t.chat.dm;
    void oda().app.notify(`${sender}${where ? ' · ' + where : ''}`, m.body.slice(0, 140));
  }
}

// ---------------------------------------------------------------- server events
function onServerEvent(ev: RendererEvents['client.event']): void {
  switch (ev.e) {
    case 'presence': {
      const d = ev.d as ServerEvents['presence'];
      set((s) => (s.users[d.userId] ? { users: { ...s.users, [d.userId]: { ...s.users[d.userId], online: d.online } } } : {}));
      break;
    }
    case 'user.updated':
    case 'user.added': {
      const d = ev.d as ServerEvents['user.updated'];
      set((s) => ({ users: { ...s.users, [d.user.id]: d.user }, me: s.me?.id === d.user.id ? { ...d.user, online: true } : s.me }));
      break;
    }
    case 'message':
      onIncomingMessage((ev.d as ServerEvents['message']).message);
      break;
    case 'room.updated': {
      const { room } = ev.d as ServerEvents['room.updated'];
      set((s) => {
        const exists = s.rooms.some((r) => r.id === room.id);
        return { rooms: exists ? s.rooms.map((r) => (r.id === room.id ? room : r)) : [...s.rooms, room] };
      });
      maybeEnterWanted();
      break;
    }
    case 'room.removed': {
      const { roomId } = ev.d as ServerEvents['room.removed'];
      set((s) => {
        const rooms = s.rooms.filter((r) => r.id !== roomId);
        const activeRoomId = s.activeRoomId === roomId ? (rooms[0]?.id ?? null) : s.activeRoomId;
        const chatConv = s.chatConv === `room:${roomId}` ? (activeRoomId ? `room:${activeRoomId}` : null) : s.chatConv;
        return { rooms, activeRoomId, chatConv };
      });
      if (get().voice.roomId === roomId) void leaveVoice();
      break;
    }
    case 'voice.update': {
      const { roomId, participants } = ev.d as ServerEvents['voice.update'];
      set((s) => ({ rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, voice: participants } : r)) }));
      if (voice && get().voice.roomId === roomId && !get().voice.joining) {
        const stillIn = voice.onParticipants(roomId, participants);
        if (!stillIn) {
          void voice.leave();
          set((s) => ({ voice: { ...initialVoice, muted: s.voice.muted } }));
        }
      }
      break;
    }
    case 'rtc.signal': {
      const d = ev.d as ServerEvents['rtc.signal'];
      void voice?.onSignal(d.from, d.data as RtcSignal);
      break;
    }
    case 'friends.updated': {
      const { friends } = ev.d as ServerEvents['friends.updated'];
      const prev = get().friends;
      set({ friends });
      const newIncoming = friends.filter((f) => f.state === 'incoming' && !prev.some((p) => p.userId === f.userId && p.state === 'incoming'));
      for (const f of newIncoming) toast(`${get().users[f.userId]?.displayName ?? ''}: arkadaşlık isteği`, 'info');
      break;
    }
    case 'blocks.updated': {
      const { blocked } = ev.d as ServerEvents['blocks.updated'];
      set({ blocked });
      voice?.setBlocked(blocked);
      break;
    }
    case 'session.ended':
      break;
  }
}

// ---------------------------------------------------------------- voice
export async function joinVoice(roomId: string): Promise<void> {
  const s = get();
  if (!s.me || !voice || s.voice.joining) return;
  const room = s.rooms.find((r) => r.id === roomId);
  if (!room) return;
  if (room.voice.length >= room.capacity && !room.voice.some((p) => p.userId === s.me!.id)) {
    toast(t.room.full, 'error');
    return;
  }
  const startMuted = s.settings?.audio.startMuted ?? false;
  set((st) => ({ voice: { ...st.voice, roomId, joining: true, muted: startMuted, deafened: false, peers: {} } }));
  const engine = voice;
  let joinedOnHost = false;
  try {
    await engine.join(s.me.id, roomId, startMuted);
    const muted = startMuted || !engine.hasMic;
    engine.setMuted(muted);
    const res = await rpc('voice.join', { roomId, muted, deafened: false });
    joinedOnHost = true;
    set((st) => ({ voice: { ...st.voice, joining: false, muted }, rooms: st.rooms.map((r) => (r.id === roomId ? { ...r, voice: res.participants } : r)) }));
    await engine.start(res);
  } catch (e) {
    await engine.leave();
    if (joinedOnHost) await rpc('voice.leave', {}).catch(() => undefined);
    set((st) => ({ voice: { ...initialVoice, micError: st.voice.micError } }));
    toast(joinedOnHost ? t.room.sfuFailed : errorText(e), 'error');
  }
}

export async function leaveVoice(): Promise<void> {
  if (!get().voice.roomId) return;
  pendingRejoin = null;
  await voice?.leave();
  set((s) => ({ voice: { ...initialVoice, muted: s.voice.muted } }));
  await rpc('voice.leave', {}).catch(() => undefined);
}

async function pushVoiceState(): Promise<void> {
  const v = get().voice;
  if (!v.roomId || v.joining) return;
  await rpc('voice.state', { muted: v.muted, deafened: v.deafened }).catch(() => undefined);
}

export async function toggleMute(): Promise<void> {
  const v = get().voice;
  if (v.roomId && !voice?.hasMic && v.muted) {
    const ok = await voice?.retryMic();
    if (!ok) return;
  }
  const muted = !v.muted;
  const deafened = muted ? v.deafened : false;
  voice?.setDeafened(deafened);
  voice?.setMuted(muted);
  set((s) => ({ voice: { ...s.voice, muted, deafened } }));
  await pushVoiceState();
}

export async function toggleDeafen(): Promise<void> {
  const v = get().voice;
  const deafened = !v.deafened;
  voice?.setDeafened(deafened);
  set((s) => ({ voice: { ...s.voice, deafened } }));
  await pushVoiceState();
}

export async function retryMic(): Promise<void> {
  const ok = await voice?.retryMic();
  if (ok) {
    voice?.setMuted(false);
    set((s) => ({ voice: { ...s.voice, muted: false, micError: null } }));
    await pushVoiceState();
  }
}

export function retryPeer(userId: string): void {
  voice?.retryPeer(userId);
}

export function setPeerVolume(userId: string, volume: number): void {
  const s = get().settings;
  if (!s) return;
  void updateSettings({ audio: { peerVolumes: { ...s.audio.peerVolumes, [userId]: volume } } });
}

export function togglePeerMuted(userId: string): void {
  const s = get().settings;
  if (!s) return;
  void updateSettings({ audio: { peerMuted: { ...s.audio.peerMuted, [userId]: !s.audio.peerMuted[userId] } } });
}

export type { VoiceParticipant };
