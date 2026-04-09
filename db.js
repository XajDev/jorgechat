// ============================================================
// db.js — PostgreSQL connection + table setup
// ============================================================
// Uses the DATABASE_URL env var that Railway auto-provides
// when you add a Postgres database to your project.
// All tables are created on startup if they don't exist (IF NOT EXISTS).
// ============================================================

const { Pool } = require('pg');

// Railway gives you DATABASE_URL automatically when you add Postgres.
// It looks like: postgresql://user:pass@host:port/dbname
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL required for Railway's Postgres
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Helper: run a query and return rows
async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// Helper: run a query and return the first row (or null)
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows.length > 0 ? rows[0] : null;
}

// ============================================================
// TABLE CREATION — runs once on startup
// ============================================================
async function initDB() {
  // Accounts table — stores user credentials and profile info
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
      last_display_change BIGINT DEFAULT 0,
      last_seen     BIGINT DEFAULT 0,
      created_at    BIGINT DEFAULT 0
    )
  `);

  // Friends — bidirectional, stored as two rows (a->b and b->a)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      user1 TEXT NOT NULL REFERENCES accounts(username),
      user2 TEXT NOT NULL REFERENCES accounts(username),
      created_at BIGINT DEFAULT 0,
      PRIMARY KEY (user1, user2)
    )
  `);

  // Friend requests — one-directional
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_user TEXT NOT NULL REFERENCES accounts(username),
      to_user   TEXT NOT NULL REFERENCES accounts(username),
      timestamp BIGINT DEFAULT 0,
      PRIMARY KEY (from_user, to_user)
    )
  `);

  // Rooms — chat rooms (public or private)
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

  // Room members
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      role     TEXT DEFAULT 'member',
      PRIMARY KEY (room_id, username)
    )
  `);

  // Room invites (for private rooms)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_invites (
      room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      PRIMARY KEY (room_id, username)
    )
  `);

  // Room bans
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_bans (
      room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      PRIMARY KEY (room_id, username)
    )
  `);

  // Messages — covers public, DM, and room messages all in one table.
  // channel_type: 'public', 'dm', 'room'
  // channel_id: 'public', 'username1::username2' (sorted), or room_id
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
      timestamp    BIGINT NOT NULL
    )
  `);

  // Index for fast message lookups by channel
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel
    ON messages (channel_type, channel_id, timestamp)
  `);

  // Read receipts for DMs
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
