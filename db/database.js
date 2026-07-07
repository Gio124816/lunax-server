const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/lunax.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -64000'); // 64MB cache

// ── SCHEMA ────────────────────────────────────────────────
db.exec(`
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id                    TEXT PRIMARY KEY,
    email                 TEXT UNIQUE NOT NULL,
    password_hash         TEXT NOT NULL,
    name                  TEXT NOT NULL,
    business_name         TEXT DEFAULT '',
    brand_voice           TEXT DEFAULT '',
    tone                  TEXT DEFAULT '',
    default_hashtags      TEXT DEFAULT '',
    avatar_url            TEXT,
    email_verified        INTEGER DEFAULT 0,
    email_verify_token    TEXT,
    reset_token           TEXT,
    reset_token_expires   INTEGER,
    failed_login_attempts INTEGER DEFAULT 0,
    last_failed_login     INTEGER,
    last_login_at         INTEGER,
    deleted_at            INTEGER,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );

  -- Sessions
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    created_at    INTEGER NOT NULL,
    ip_address    TEXT,
    user_agent    TEXT
  );

  -- Subscriptions
  CREATE TABLE IF NOT EXISTS subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan                    TEXT NOT NULL DEFAULT 'trial',
    status                  TEXT NOT NULL DEFAULT 'trial',
    is_beta                 INTEGER DEFAULT 0,
    beta_user_number        INTEGER,
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    trial_ends_at           INTEGER,
    current_period_start    INTEGER,
    current_period_end      INTEGER,
    cancel_at_period_end    INTEGER DEFAULT 0,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER
  );

  -- Payments (audit log)
  CREATE TABLE IF NOT EXISTS payments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             TEXT NOT NULL REFERENCES users(id),
    stripe_invoice_id   TEXT,
    amount              INTEGER,
    currency            TEXT DEFAULT 'usd',
    status              TEXT,
    created_at          INTEGER NOT NULL
  );

  -- Social accounts (connected platforms)
  CREATE TABLE IF NOT EXISTS social_accounts (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform            TEXT NOT NULL,
    platform_account_id TEXT NOT NULL,
    account_name        TEXT,
    account_handle      TEXT,
    access_token        TEXT NOT NULL,
    token_expires_at    INTEGER,
    refresh_token       TEXT,
    page_id             TEXT,
    ad_account_id       TEXT,
    connected_at        INTEGER NOT NULL,
    last_used_at        INTEGER,
    UNIQUE(user_id, platform, platform_account_id)
  );

  -- Posts
  CREATE TABLE IF NOT EXISTS posts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id      TEXT REFERENCES social_accounts(id),
    caption         TEXT,
    hashtags        TEXT,
    platforms       TEXT,
    media_url       TEXT,
    media_type      TEXT,
    status          TEXT DEFAULT 'draft',
    scheduled_time  INTEGER,
    posted_at       INTEGER,
    platform_post_ids TEXT,
    error_message       TEXT,
    retry_count         INTEGER DEFAULT 0,
    post_type           TEXT DEFAULT 'feed',
    also_share_to_story INTEGER DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  -- Post analytics
  CREATE TABLE IF NOT EXISTS post_analytics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform    TEXT,
    likes       INTEGER DEFAULT 0,
    comments    INTEGER DEFAULT 0,
    shares      INTEGER DEFAULT 0,
    reach       INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks      INTEGER DEFAULT 0,
    fetched_at  INTEGER NOT NULL
  );

  -- OAuth accounts (Google, Apple, Microsoft, Meta)
  CREATE TABLE IF NOT EXISTS oauth_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    provider_id  TEXT NOT NULL,
    access_token TEXT,
    updated_at   INTEGER,
    UNIQUE(provider, provider_id)
  );

  -- OAuth state tokens (CSRF protection)
  CREATE TABLE IF NOT EXISTS oauth_states (
    state      TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.prepare(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  email TEXT,
  type TEXT NOT NULL,
  rating INTEGER,
  message TEXT,
  created_at INTEGER NOT NULL
)`).run();

db.exec(`
  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
  CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_time, status);
  CREATE INDEX IF NOT EXISTS idx_social_accounts_user ON social_accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
`);

// ── MIGRATIONS ────────────────────────────────────────────
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_access_token TEXT`).run(); console.log('Migration: added meta_access_token'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_ig_id TEXT`).run(); console.log('Migration: added meta_ig_id'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_ig_name TEXT`).run(); console.log('Migration: added meta_ig_name'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_page_id TEXT`).run(); console.log('Migration: added meta_page_id'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_page_name TEXT`).run(); console.log('Migration: added meta_page_name'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_page_token TEXT`).run(); console.log('Migration: added meta_page_token'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN meta_ad_account_id TEXT`).run(); console.log('Migration: added meta_ad_account_id'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN notif_email TEXT`).run(); console.log('Migration: added notif_email'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN notif_published INTEGER DEFAULT 1`).run(); console.log('Migration: added notif_published'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN notif_failed INTEGER DEFAULT 1`).run(); console.log('Migration: added notif_failed'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN notif_weekly INTEGER DEFAULT 1`).run(); console.log('Migration: added notif_weekly'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN notif_ai INTEGER DEFAULT 0`).run(); console.log('Migration: added notif_ai'); } catch(e) {}
try { db.prepare(`ALTER TABLE users ADD COLUMN notif_import INTEGER DEFAULT 0`).run(); console.log('Migration: added notif_import'); } catch(e) {}

// Invite system tables
db.prepare(`CREATE TABLE IF NOT EXISTS invite_codes (
  id           TEXT PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  label        TEXT DEFAULT '',
  max_uses     INTEGER DEFAULT 0,
  uses         INTEGER DEFAULT 0,
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS invite_uses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id   TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  email       TEXT,
  used_at     INTEGER NOT NULL
)`).run();

// Referral system tables
db.prepare(`CREATE TABLE IF NOT EXISTS referrals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS referral_uses (
  id          TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  email       TEXT,
  joined      INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
)`).run();

// Ad cache table
db.prepare(`CREATE TABLE IF NOT EXISTS ad_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  data_type   TEXT NOT NULL,
  data        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  UNIQUE(user_id, account_id, data_type)
)`).run();

// AI highlight detection — feedback log (every accept/adjust/reject decision,
// used to bias future /ai/highlights suggestions for this user) and taught
// examples (clips the user explicitly marked as good, fed back in as
// few-shot context on future requests).
db.prepare(`CREATE TABLE IF NOT EXISTS highlight_feedback (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggestion_id    TEXT NOT NULL,
  action           TEXT NOT NULL,
  original_start   REAL,
  original_end     REAL,
  corrected_start  REAL,
  corrected_end    REAL,
  created_at       INTEGER NOT NULL
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS highlight_examples (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name           TEXT,
  start_time          REAL,
  end_time            REAL,
  transcript_excerpt  TEXT,
  created_at          INTEGER NOT NULL
)`).run();

// Full reference videos taught to the AI as "this is the editing style I want" —
// distinct from highlight_examples above, which are excerpts of the user's own
// already-imported clips. These don't have a transcript (no ASR run on them),
// just a title/notes pair used as plain-language style guidance in prompts.
db.prepare(`CREATE TABLE IF NOT EXISTS style_examples (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  notes       TEXT DEFAULT '',
  url         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
)`).run();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_highlight_feedback_user ON highlight_feedback(user_id);
  CREATE INDEX IF NOT EXISTS idx_highlight_examples_user ON highlight_examples(user_id);
  CREATE INDEX IF NOT EXISTS idx_style_examples_user ON style_examples(user_id);
`);

// ── MAINTENANCE ───────────────────────────────────────────

function cleanExpiredSessions() {
  const deleted = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  if (deleted.changes > 0) console.log(`Cleaned ${deleted.changes} expired sessions`);
}

function cleanDeletedAccounts() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const users = db.prepare('SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  users.forEach(u => {
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log(`Hard deleted user ${u.id}`);
  });
}

setInterval(() => {
  cleanExpiredSessions();
  cleanDeletedAccounts();
}, 60 * 60 * 1000);

cleanExpiredSessions();

module.exports = db;
