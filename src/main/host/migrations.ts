/**
 * Host database schema. Each entry upgrades `PRAGMA user_version` from index to index+1.
 * Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  /* 0 -> 1 */ `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    name_key     TEXT NOT NULL UNIQUE,
    color        TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('admin','member')),
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key   TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX devices_user ON devices(user_id);

  CREATE TABLE rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    is_private  INTEGER NOT NULL DEFAULT 0,
    capacity    INTEGER NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
  );

  CREATE TABLE room_members (
    room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE invites (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL REFERENCES users(id),
    room_id     TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    max_uses    INTEGER NOT NULL,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE friendships (
    user_a       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
    requester_id TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
  );

  CREATE TABLE blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_key   TEXT NOT NULL,
    room_id    TEXT,
    dm_a       TEXT,
    dm_b       TEXT,
    sender_id  TEXT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    client_id  TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_conv ON messages(conv_key, id);
  CREATE UNIQUE INDEX messages_dedupe ON messages(sender_id, client_id) WHERE client_id IS NOT NULL;

  CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  END;

  CREATE TABLE read_state (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conv_key     TEXT NOT NULL,
    last_read_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, conv_key)
  );
  `,
  /* 1 -> 2: invites may be issued by the server itself (no creator) and may grant the admin role. */ `
  CREATE TABLE invites_v2 (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    room_id     TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    max_uses    INTEGER NOT NULL,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER,
    created_at  INTEGER NOT NULL
  );
  INSERT INTO invites_v2(id, token_hash, created_by, room_id, role, max_uses, uses, expires_at, revoked_at, created_at)
    SELECT id, token_hash, created_by, room_id, 'member', max_uses, uses, expires_at, revoked_at, created_at FROM invites;
  DROP TABLE invites;
  ALTER TABLE invites_v2 RENAME TO invites;
  `,
];
