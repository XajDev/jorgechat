const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows.length > 0 ? rows[0] : null;
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username      TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      color         TEXT NOT NULL DEFAULT '#000000',
      token         TEXT,
      bio           TEXT DEFAULT '',
      pfp           TEXT,
      tags          TEXT[] DEFAULT '{}',
      badges        TEXT[] DEFAULT '{}',
      theme         TEXT DEFAULT 'xp-blue',
      last_display_change BIGINT DEFAULT 0,
      last_seen     BIGINT DEFAULT 0,
      created_at    BIGINT DEFAULT 0,
      is_admin      BOOLEAN DEFAULT false
    )
  `);

  // Add columns if they don't exist (for existing databases)
  const cols = [
    ['accounts','badges',"ALTER TABLE accounts ADD COLUMN IF NOT EXISTS badges TEXT[] DEFAULT '{}'"],
    ['accounts','theme',"ALTER TABLE accounts ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'xp-blue'"],
    ['accounts','is_admin',"ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false"],
  ];
  for (const c of cols) { try { await pool.query(c[2]); } catch(e) {} }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      user1 TEXT NOT NULL REFERENCES accounts(username),
      user2 TEXT NOT NULL REFERENCES accounts(username),
      created_at BIGINT DEFAULT 0,
      PRIMARY KEY (user1, user2)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_user TEXT NOT NULL REFERENCES accounts(username),
      to_user   TEXT NOT NULL REFERENCES accounts(username),
      timestamp BIGINT DEFAULT 0,
      PRIMARY KEY (from_user, to_user)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator     TEXT NOT NULL REFERENCES accounts(username),
      private     BOOLEAN DEFAULT false,
      created_at  BIGINT DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      role     TEXT DEFAULT 'member',
      PRIMARY KEY (room_id, username)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_invites (
      room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      PRIMARY KEY (room_id, username)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_bans (
      room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      PRIMARY KEY (room_id, username)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      username     TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color        TEXT NOT NULL,
      text         TEXT DEFAULT '',
      file_data    JSONB,
      type         TEXT DEFAULT 'message',
      edited       BOOLEAN DEFAULT false,
      deleted      BOOLEAN DEFAULT false,
      reactions    JSONB DEFAULT '{}',
      pinned       BOOLEAN DEFAULT false,
      timestamp    BIGINT NOT NULL
    )
  `);
  try { await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false"); } catch(e) {}

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_type, channel_id, timestamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_text ON messages USING gin(to_tsvector('english', text))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS read_receipts (
      username   TEXT NOT NULL REFERENCES accounts(username),
      channel_id TEXT NOT NULL,
      last_read  BIGINT DEFAULT 0,
      PRIMARY KEY (username, channel_id)
    )
  `);

  console.log('[DB] All tables ready');
}

module.exports = { pool, query, queryOne, initDB };
