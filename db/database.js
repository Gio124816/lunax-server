const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../lunax.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// ── USERS ──
// Each user is identified by their Meta user ID
// Token stored server-side — users never see it
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    meta_user_id TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT,
    meta_access_token TEXT NOT NULL,
    meta_token_expires INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    last_seen INTEGER DEFAULT (unixepoch())
  )
`);

// ── USER ACCOUNTS ──
// Pages and Instagram accounts connected by each user
db.exec(`
  CREATE TABLE IF NOT EXISTS user_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_name TEXT,
    access_token TEXT,
    instagram_id TEXT,
    ad_account_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, account_id)
  )
`);

// ── SCHEDULED POSTS ──
// Posts queued to go out at a specific time
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    account_id TEXT,
    caption TEXT NOT NULL,
    hashtags TEXT,
    media_url TEXT,
    media_type TEXT,
    platforms TEXT NOT NULL,
    scheduled_time INTEGER NOT NULL,
    status TEXT DEFAULT 'scheduled',
    meta_post_id TEXT,
    error TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    published_at INTEGER
  )
`);

// ── AD CAMPAIGNS CACHE ──
// Cached ad data to avoid hitting Meta API on every load
db.exec(`
  CREATE TABLE IF NOT EXISTS ad_cache (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data TEXT NOT NULL,
    fetched_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, account_id, data_type)
  )
`);

// ── SESSIONS ──
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  )
`);

module.exports = db;
