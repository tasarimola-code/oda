import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';
import type { FriendEntry, InviteInfo, Role, UserPublic } from '../../shared/protocol';

export class DbCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbCorruptError';
  }
}

export function newId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export interface UserRow {
  id: string;
  display_name: string;
  name_key: string;
  color: string;
  role: Role;
  status: 'active' | 'banned';
  created_at: number;
  last_seen_at: number | null;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  public_key: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface RoomRow {
  id: string;
  name: string;
  is_private: number;
  capacity: number;
  created_by: string;
  created_at: number;
  deleted_at: number | null;
}

export interface InviteRow {
  id: string;
  token_hash: string;
  created_by: string | null;
  room_id: string | null;
  role: Role;
  max_uses: number;
  uses: number;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

export interface MessageRow {
  id: number;
  conv_key: string;
  room_id: string | null;
  dm_a: string | null;
  dm_b: string | null;
  sender_id: string;
  body: string;
  client_id: string | null;
  created_at: number;
}

export function dmKey(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

export function roomKey(roomId: string): string {
  return `room:${roomId}`;
}

export class HostDb {
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /** Opens (and migrates) the database. Throws DbCorruptError if the file is unreadable. */
  static open(file: string): HostDb {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    let db: Database.Database | null = null;
    try {
      db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 3000');
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new DbCorruptError(`quick_check: ${String(check)}`);
      const h = new HostDb(db);
      h.migrate();
      return h;
    } catch (e) {
      // Windows keeps the file locked while a handle is open; recovery must be able to move it aside.
      db?.close();
      if (e instanceof DbCorruptError) throw e;
      const err = e as { code?: string; message?: string };
      if (err.code && /SQLITE_(CORRUPT|NOTADB)/.test(err.code)) throw new DbCorruptError(err.message ?? 'corrupt');
      throw e;
    }
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current > MIGRATIONS.length) {
      throw new Error(`Veritabanı daha yeni bir ODA sürümüne ait (şema ${current}).`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      const tx = this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      });
      tx();
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  async backupTo(file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.db.backup(file);
  }

  // ---------- meta ----------
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- users ----------
  createUser(u: { displayName: string; nameKey: string; color: string; role: Role }): UserRow {
    const row: UserRow = {
      id: newId(),
      display_name: u.displayName,
      name_key: u.nameKey,
      color: u.color,
      role: u.role,
      status: 'active',
      created_at: Date.now(),
      last_seen_at: null,
    };
    this.db
      .prepare('INSERT INTO users(id, display_name, name_key, color, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.display_name, row.name_key, row.color, row.role, row.status, row.created_at);
    return row;
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getUserByNameKey(key: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE name_key = ?').get(key) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all() as UserRow[];
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
  }

  hasActiveAdmin(): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get();
  }

  updateUserProfile(id: string, displayName: string, nameKey: string, color: string): void {
    this.db.prepare('UPDATE users SET display_name = ?, name_key = ?, color = ? WHERE id = ?').run(displayName, nameKey, color, id);
  }

  setUserStatus(id: string, status: 'active' | 'banned'): void {
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  }

  touchUser(id: string): void {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  searchUsers(q: string, limit = 20): UserRow[] {
    const esc = q.replace(/[\\%_]/g, (c) => '\\' + c);
    return this.db
      .prepare("SELECT * FROM users WHERE name_key LIKE ? ESCAPE '\\' ORDER BY display_name COLLATE NOCASE LIMIT ?")
      .all(`%${esc}%`, limit) as UserRow[];
  }

  // ---------- devices ----------
  addDevice(userId: string, publicKey: string, name: string): DeviceRow {
    const row: DeviceRow = { id: newId(), user_id: userId, public_key: publicKey, name, created_at: Date.now(), last_seen_at: null, revoked_at: null };
    this.db.prepare('INSERT INTO devices(id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)').run(row.id, userId, publicKey, name, row.created_at);
    return row;
  }

  getDeviceByKey(publicKey: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE public_key = ?').get(publicKey) as DeviceRow | undefined;
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  revokeDevicesOfUser(userId: string): void {
    this.db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId);
  }

  // ---------- rooms ----------
  createRoom(r: { name: string; isPrivate: boolean; capacity: number; createdBy: string }): RoomRow {
    const row: RoomRow = { id: newId(), name: r.name, is_private: r.isPrivate ? 1 : 0, capacity: r.capacity, created_by: r.createdBy, created_at: Date.now(), deleted_at: null };
    this.db
      .prepare('INSERT INTO rooms(id, name, is_private, capacity, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.is_private, row.capacity, row.created_by, row.created_at);
    if (r.isPrivate) this.addRoomMember(row.id, r.createdBy);
    return row;
  }

  getRoom(id: string): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE id = ? AND deleted_at IS NULL').get(id) as RoomRow | undefined;
  }

  listRooms(): RoomRow[] {
    return this.db.prepare('SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY created_at').all() as RoomRow[];
  }

  updateRoom(id: string, name: string, capacity: number): void {
    this.db.prepare('UPDATE rooms SET name = ?, capacity = ? WHERE id = ?').run(name, capacity, id);
  }

  deleteRoom(id: string): void {
    this.db.prepare('UPDATE rooms SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
  }

  addRoomMember(roomId: string, userId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO room_members(room_id, user_id, added_at) VALUES (?, ?, ?)').run(roomId, userId, Date.now());
  }

  removeRoomMember(roomId: string, userId: string): void {
    this.db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);
  }

  isRoomMember(roomId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
  }

  roomMembers(roomId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId) as { user_id: string }[]).map((r) => r.user_id);
  }

  countRoomsOwnedBy(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM rooms WHERE created_by = ? AND deleted_at IS NULL').get(userId) as { c: number }).c;
  }

  /** Users who share a live room with, are friends/pending with, or have a DM with the given user. */
  relatedUserIds(userId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT m2.user_id id FROM room_members m1
           JOIN room_members m2 ON m2.room_id = m1.room_id
           JOIN rooms r ON r.id = m1.room_id AND r.deleted_at IS NULL
          WHERE m1.user_id = ?
         UNION SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END FROM friendships WHERE user_a = ? OR user_b = ?
         UNION SELECT CASE WHEN dm_a = ? THEN dm_b ELSE dm_a END FROM messages WHERE dm_a = ? OR dm_b = ?
         UNION SELECT blocked_id FROM blocks WHERE blocker_id = ?`,
      )
      .all(userId, userId, userId, userId, userId, userId, userId, userId) as { id: string }[];
    const out = new Set(rows.map((r) => r.id));
    out.add(userId);
    return out;
  }

  areRelated(a: string, b: string): boolean {
    if (a === b) return true;
    const [x, y] = a < b ? [a, b] : [b, a];
    return !!this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM room_members m1 JOIN room_members m2 ON m2.room_id = m1.room_id JOIN rooms r ON r.id = m1.room_id AND r.deleted_at IS NULL WHERE m1.user_id = ? AND m2.user_id = ?)
            OR EXISTS (SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?)
            OR EXISTS (SELECT 1 FROM messages WHERE conv_key = ? LIMIT 1)`,
      )
      .get(a, b, x, y, dmKey(x, y));
  }

  // ---------- invites ----------
  createInvite(i: { tokenHash: string; createdBy: string | null; roomId: string | null; maxUses: number; expiresAt: number; role?: Role }): InviteRow {
    const row: InviteRow = {
      id: newId(),
      token_hash: i.tokenHash,
      created_by: i.createdBy,
      room_id: i.roomId,
      role: i.role ?? 'member',
      max_uses: i.maxUses,
      uses: 0,
      expires_at: i.expiresAt,
      revoked_at: null,
      created_at: Date.now(),
    };
    this.db
      .prepare('INSERT INTO invites(id, token_hash, created_by, room_id, role, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(row.id, row.token_hash, row.created_by, row.room_id, row.role, row.max_uses, row.expires_at, row.created_at);
    return row;
  }

  getInviteByHash(hash: string): InviteRow | undefined {
    return this.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hash) as InviteRow | undefined;
  }

  incrementInviteUse(id: string): boolean {
    const r = this.db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL').run(id);
    return r.changes === 1;
  }

  listInvites(): InviteInfo[] {
    const rows = this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 100').all() as InviteRow[];
    return rows.map(inviteInfo);
  }

  revokeInvite(id: string): void {
    this.db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  }

  // ---------- friendships ----------
  getFriendship(a: string, b: string): { status: 'pending' | 'accepted'; requester_id: string } | undefined {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db.prepare('SELECT status, requester_id FROM friendships WHERE user_a = ? AND user_b = ?').get(x, y) as
      | { status: 'pending' | 'accepted'; requester_id: string }
      | undefined;
  }

  upsertFriendship(a: string, b: string, status: 'pending' | 'accepted', requester: string): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO friendships(user_a, user_b, status, requester_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_a, user_b) DO UPDATE SET status = excluded.status, requester_id = excluded.requester_id, updated_at = excluded.updated_at`,
      )
      .run(x, y, status, requester, now, now);
  }

  deleteFriendship(a: string, b: string): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(x, y);
  }

  listFriends(userId: string): FriendEntry[] {
    const rows = this.db
      .prepare('SELECT user_a, user_b, status, requester_id, updated_at FROM friendships WHERE user_a = ? OR user_b = ?')
      .all(userId, userId) as { user_a: string; user_b: string; status: string; requester_id: string; updated_at: number }[];
    return rows.map((r) => {
      const other = r.user_a === userId ? r.user_b : r.user_a;
      const state = r.status === 'accepted' ? 'friends' : r.requester_id === userId ? 'outgoing' : 'incoming';
      return { userId: other, state, since: r.updated_at } as FriendEntry;
    });
  }

  areFriends(a: string, b: string): boolean {
    return this.getFriendship(a, b)?.status === 'accepted';
  }

  // ---------- blocks ----------
  addBlock(blocker: string, blocked: string): void {
    this.db.prepare('INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(blocker, blocked, Date.now());
  }

  removeBlock(blocker: string, blocked: string): void {
    this.db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blocker, blocked);
  }

  listBlocked(blocker: string): string[] {
    return (this.db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(blocker) as { blocked_id: string }[]).map((r) => r.blocked_id);
  }

  isBlockedEither(a: string, b: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
      .get(a, b, b, a);
  }

  hasBlocked(blocker: string, blocked: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blocker, blocked);
  }

  // ---------- messages ----------
  insertMessage(m: { convKey: string; roomId: string | null; dmA: string | null; dmB: string | null; senderId: string; body: string; clientId: string }): { row: MessageRow; duplicate: boolean } {
    const existing = this.db.prepare('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?').get(m.senderId, m.clientId) as MessageRow | undefined;
    if (existing) return { row: existing, duplicate: true };
    const now = Date.now();
    const r = this.db
      .prepare('INSERT INTO messages(conv_key, room_id, dm_a, dm_b, sender_id, body, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.convKey, m.roomId, m.dmA, m.dmB, m.senderId, m.body, m.clientId, now);
    const row: MessageRow = {
      id: Number(r.lastInsertRowid),
      conv_key: m.convKey,
      room_id: m.roomId,
      dm_a: m.dmA,
      dm_b: m.dmB,
      sender_id: m.senderId,
      body: m.body,
      client_id: m.clientId,
      created_at: now,
    };
    return { row, duplicate: false };
  }

  history(convKey: string, viewerId: string, beforeId: number | undefined, limit: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conv_key = ? AND id < ?
           AND sender_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(convKey, beforeId ?? Number.MAX_SAFE_INTEGER, viewerId, limit) as MessageRow[];
    return rows.reverse();
  }

  maxMessageId(convKey: string): number {
    const r = this.db.prepare('SELECT MAX(id) m FROM messages WHERE conv_key = ?').get(convKey) as { m: number | null };
    return r.m ?? 0;
  }

  setReadState(userId: string, convKey: string, lastId: number): void {
    this.db
      .prepare(
        `INSERT INTO read_state(user_id, conv_key, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, conv_key) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
      )
      .run(userId, convKey, lastId);
  }

  /** Unread counts for the given canonical conversation keys. */
  unreadCounts(userId: string, convKeys: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const stmt = this.db.prepare(
      `SELECT COUNT(*) c FROM messages
       WHERE conv_key = ? AND sender_id != ?
         AND id > COALESCE((SELECT last_read_id FROM read_state WHERE user_id = ? AND conv_key = ?), 0)
         AND sender_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)`,
    );
    for (const k of convKeys) {
      const c = (stmt.get(k, userId, userId, k, userId) as { c: number }).c;
      if (c > 0) out[k] = Math.min(c, 999);
    }
    return out;
  }

  /** Full-text search restricted to conversations the viewer may read. */
  search(viewerId: string, q: string, roomIds: string[], limit = 30): Array<MessageRow & { snippet: string }> {
    const terms = q
      .normalize('NFC')
      .split(/\s+/)
      .map((t) => t.replace(/["*^:(){}[\]]/g, ''))
      .filter((t) => t.length > 0)
      .slice(0, 6);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"*`).join(' ');
    const roomPlaceholders = roomIds.map(() => '?').join(',') || "''";
    const sql = `
      SELECT m.*, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND (m.room_id IN (${roomPlaceholders}) OR m.dm_a = ? OR m.dm_b = ?)
        AND m.sender_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
      ORDER BY m.id DESC LIMIT ?`;
    try {
      return this.db.prepare(sql).all(match, ...roomIds, viewerId, viewerId, viewerId, limit) as Array<MessageRow & { snippet: string }>;
    } catch {
      return [];
    }
  }
}

export function inviteInfo(r: InviteRow): InviteInfo {
  return {
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    maxUses: r.max_uses,
    uses: r.uses,
    roomId: r.room_id,
    revoked: r.revoked_at !== null,
    createdBy: r.created_by,
    role: r.role,
  };
}

export function userPublic(r: UserRow, online: boolean, voiceRoomId: string | null = null): UserPublic {
  return {
    id: r.id,
    displayName: r.display_name,
    color: r.color,
    role: r.role,
    online,
    banned: r.status === 'banned' ? true : undefined,
    voiceRoomId,
  };
}
