export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 47823;
export const MIN_ROOM_CAPACITY = 2;
/** Peer-to-peer mesh: every participant uploads to every other one. */
export const MAX_ROOM_CAPACITY = 6;
/** Media server (SFU): each participant uploads once. */
export const MAX_SFU_ROOM_CAPACITY = 50;
/** HTTP/WebSocket path prefix under which the host proxies the media server signaling. */
export const SFU_PATH = '/lk';
export const MAX_MESSAGE_LENGTH = 4000;
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 32;
export const MAX_ROOM_NAME_LENGTH = 40;
export const HISTORY_PAGE_SIZE = 50;
export const MAX_FRAME_BYTES = 128 * 1024;
export const WS_PATH = '/oda';

export type Role = 'admin' | 'member';

export interface UserPublic {
  id: string;
  displayName: string;
  color: string;
  role: Role;
  online: boolean;
  banned?: boolean;
  /** Voice channel this person is in right now; friends can join if they can see the room. */
  voiceRoomId?: string | null;
}

export interface VoiceParticipant {
  userId: string;
  muted: boolean;
  deafened: boolean;
  joinedAt: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  isPrivate: boolean;
  capacity: number;
  createdAt: number;
  /** Creator; may rename/delete the room, manage members and create invites for it. */
  ownerId: string | null;
  voice: VoiceParticipant[];
}

export type FriendState = 'friends' | 'outgoing' | 'incoming';

export interface FriendEntry {
  userId: string;
  state: FriendState;
  since: number;
}

/** Conversation key from the viewer's perspective: `room:<roomId>` or `dm:<otherUserId>`. */
export type ConvKey = string;

export interface ChatMessage {
  id: number;
  conv: ConvKey;
  senderId: string;
  body: string;
  createdAt: number;
  clientId: string | null;
}

export interface InviteInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  roomId: string | null;
  revoked: boolean;
  createdBy: string | null;
  role: Role;
}

export type MediaMode = 'mesh' | 'sfu';

export interface HostInfo {
  hostId: string;
  hostName: string;
  ownerName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  /** mesh: voice goes directly between participants; sfu: through the host's media server. */
  media: MediaMode;
  maxRoomCapacity: number;
  /** Always-on server (no desktop owner whose PC must stay open). */
  dedicated: boolean;
  /** Anyone with the app can create an account and their own rooms (no invite needed to sign up). */
  openRegistration: boolean;
  /** Rooms a single member may own (admins are not limited). */
  maxOwnedRooms: number;
  inviteLimits: InviteLimits;
}

export interface InviteLimits {
  maxUses: number;
  maxMinutes: number;
}

export interface SfuGrant {
  /** Path on the host (under SFU_PATH) where the media server signaling is proxied. */
  path: string;
  token: string;
}

export interface Bootstrap {
  me: UserPublic;
  host: HostInfo;
  users: UserPublic[];
  rooms: RoomInfo[];
  friends: FriendEntry[];
  blocked: string[];
  unread: Record<ConvKey, number>;
}

export type ConvRef = { kind: 'room'; roomId: string } | { kind: 'dm'; userId: string };

export interface SearchHit {
  message: ChatMessage;
  snippet: string;
}

/** RPC contract: method name -> params/result. */
export interface RpcMethods {
  'state.bootstrap': { params: Record<string, never>; result: Bootstrap };
  'profile.update': { params: { displayName?: string; color?: string }; result: UserPublic };
  'users.search': { params: { q: string }; result: UserPublic[] };

  'friends.request': { params: { userId: string }; result: FriendEntry[] };
  'friends.accept': { params: { userId: string }; result: FriendEntry[] };
  'friends.reject': { params: { userId: string }; result: FriendEntry[] };
  'friends.remove': { params: { userId: string }; result: FriendEntry[] };
  'blocks.add': { params: { userId: string }; result: { blocked: string[]; friends: FriendEntry[] } };
  'blocks.remove': { params: { userId: string }; result: { blocked: string[] } };

  'rooms.create': { params: { name: string; isPrivate: boolean; capacity: number }; result: RoomInfo };
  'rooms.update': { params: { roomId: string; name?: string; capacity?: number }; result: RoomInfo };
  'rooms.delete': { params: { roomId: string }; result: { ok: true } };
  'rooms.members': { params: { roomId: string }; result: string[] };
  'rooms.addMember': { params: { roomId: string; userId: string }; result: string[] };
  'rooms.removeMember': { params: { roomId: string; userId: string }; result: string[] };

  'messages.send': { params: { conv: ConvRef; body: string; clientId: string }; result: ChatMessage };
  'messages.history': { params: { conv: ConvRef; beforeId?: number; limit?: number }; result: { messages: ChatMessage[]; hasMore: boolean } };
  'messages.markRead': { params: { conv: ConvRef; lastId: number }; result: { ok: true } };
  'messages.search': { params: { q: string }; result: SearchHit[] };

  'voice.join': { params: { roomId: string; muted: boolean; deafened: boolean }; result: { roomId: string; participants: VoiceParticipant[]; sfu?: SfuGrant } };
  'voice.leave': { params: Record<string, never>; result: { ok: true } };
  'voice.state': { params: { muted: boolean; deafened: boolean }; result: { ok: true } };
  'rtc.signal': { params: { to: string; data: RtcSignal }; result: { ok: true } };

  /** Invite into a room the caller owns. */
  'invites.create': { params: { roomId: string; expiresInMinutes: number; maxUses: number }; result: { invite: InviteInfo; code: string } };
  /** Adds an already registered user to the room of an invite (role is never changed). */
  'invites.redeem': { params: { secret: string }; result: { room: RoomInfo } };

  'admin.invites.create': { params: { expiresInMinutes: number; maxUses: number; roomId?: string | null }; result: { invite: InviteInfo; code: string } };
  'admin.invites.list': { params: Record<string, never>; result: InviteInfo[] };
  'admin.invites.revoke': { params: { inviteId: string }; result: InviteInfo[] };
  'admin.users.kick': { params: { userId: string }; result: { ok: true } };
  'admin.users.ban': { params: { userId: string }; result: UserPublic[] };
  'admin.users.unban': { params: { userId: string }; result: UserPublic[] };
  'admin.users.list': { params: Record<string, never>; result: UserPublic[] };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result'];

export const RPC_METHODS: readonly RpcMethod[] = [
  'state.bootstrap', 'profile.update', 'users.search',
  'friends.request', 'friends.accept', 'friends.reject', 'friends.remove', 'blocks.add', 'blocks.remove',
  'rooms.create', 'rooms.update', 'rooms.delete', 'rooms.members', 'rooms.addMember', 'rooms.removeMember',
  'messages.send', 'messages.history', 'messages.markRead', 'messages.search',
  'voice.join', 'voice.leave', 'voice.state', 'rtc.signal',
  'invites.create', 'invites.redeem',
  'admin.invites.create', 'admin.invites.list', 'admin.invites.revoke',
  'admin.users.kick', 'admin.users.ban', 'admin.users.unban', 'admin.users.list',
] as const;

export type RtcSignal =
  | { type: 'offer'; sdp: string; restart?: boolean }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: 'bye' };

/** Server-pushed events. */
export interface ServerEvents {
  'presence': { userId: string; online: boolean };
  'user.updated': { user: UserPublic };
  'user.added': { user: UserPublic };
  'message': { message: ChatMessage };
  'room.updated': { room: RoomInfo };
  'room.removed': { roomId: string };
  'voice.update': { roomId: string; participants: VoiceParticipant[] };
  'rtc.signal': { from: string; data: RtcSignal };
  'friends.updated': { friends: FriendEntry[] };
  'blocks.updated': { blocked: string[] };
  'session.ended': { reason: SessionEndReason };
}
export type ServerEventName = keyof ServerEvents;

export type SessionEndReason = 'kicked' | 'banned' | 'device_revoked' | 'host_shutdown' | 'replaced';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVITE_INVALID'
  | 'INVITE_EXPIRED'
  | 'INVITE_USED'
  | 'NAME_TAKEN'
  | 'BANNED'
  | 'DEVICE_UNKNOWN'
  | 'ROOM_FULL'
  | 'BLOCKED'
  | 'NOT_FRIENDS'
  | 'PROTOCOL'
  | 'INTERNAL';

/** Wire frames. */
export type ClientFrame =
  | { t: 'auth.register'; id: number; invite?: string; displayName: string; publicKey: string; signature: string; deviceName: string }
  | { t: 'auth.login'; id: number; publicKey: string; signature: string }
  | { t: 'req'; id: number; m: string; p: unknown };

export type ServerFrame =
  | { t: 'hello'; protocol: number; hostId: string; hostName: string; nonce: string; dedicated?: boolean }
  | { t: 'res'; id: number; ok: true; data: unknown }
  | { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } }
  | { t: 'evt'; e: ServerEventName; d: unknown };

export function authPayload(hostId: string, nonce: string, publicKey: string): string {
  return `ODA-AUTH-1\n${hostId}\n${nonce}\n${publicKey}`;
}

export const AVATAR_COLORS = ['#8A6A3B', '#2F6DB5', '#3F7D4E', '#A34A55', '#6B5B95', '#2E7F86', '#9A5B2E', '#56627A'];
