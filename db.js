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

  // Add reply_to column to messages for threading
  try { await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to TEXT"); } catch(e) {}

  // User notes — private notes about other users
  await pool.query(`CREATE TABLE IF NOT EXISTS user_notes (
    owner TEXT NOT NULL REFERENCES accounts(username),
    target TEXT NOT NULL REFERENCES accounts(username),
    note TEXT DEFAULT '',
    updated_at BIGINT DEFAULT 0,
    PRIMARY KEY (owner, target)
  )`);

  // Room settings — slow mode, topic
  try { await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS topic TEXT DEFAULT ''"); } catch(e) {}
  try { await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slow_mode INT DEFAULT 0"); } catch(e) {}
  // Track last message time per user per room for slow mode
  await pool.query(`CREATE TABLE IF NOT EXISTS room_slow_tracker (
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    last_msg BIGINT DEFAULT 0,
    PRIMARY KEY (room_id, username)
  )`);

  // AFK tracking
  try { await pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS afk_timeout INT DEFAULT 300"); } catch(e) {}

  // Custom emojis — uploaded by admins, usable by everyone
  await pool.query(`CREATE TABLE IF NOT EXISTS custom_emojis (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at BIGINT DEFAULT 0
  )`);

  // Scheduled messages
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES accounts(username),
    channel_type TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    text TEXT DEFAULT '',
    file_data JSONB,
    send_at BIGINT NOT NULL,
    sent BOOLEAN DEFAULT false,
    created_at BIGINT NOT NULL
  )`);

  console.log('[DB] All tables ready (extended)');
}

module.exports = { pool, query, queryOne, initDB };
