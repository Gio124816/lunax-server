const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ── MIDDLEWARE ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── REGISTER ────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, businessName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const now = Date.now();
    const verifyToken = uuidv4();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, business_name, email_verify_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, email.toLowerCase(), passwordHash, name, businessName || '', verifyToken, now, now);

    // During beta — everyone gets free Pro access (is_beta=1)
    // After beta ends, they'll be converted to 14-day trials via /billing/end-beta
    const isBeta = process.env.BETA_MODE !== 'ended';
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL').get().count;

    db.prepare(`
      INSERT INTO subscriptions (user_id, plan, status, is_beta, beta_user_number, trial_ends_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      isBeta ? 'pro' : 'trial',
      isBeta ? 'active' : 'trial',
      isBeta ? 1 : 0,
      isBeta ? totalUsers : null,
      isBeta ? null : now + 14 * 24 * 60 * 60 * 1000,
      now
    );

    const token = jwt.sign({ id: userId, email: email.toLowerCase() }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: userId, email: email.toLowerCase(), name, businessName: businessName || '' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── LOGIN ───────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        businessName: user.business_name,
        subscription: subscription || null
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── ME ──────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  try {
    _ensureIgDirectColumns(); // make sure columns exist before selecting them
    const user = db.prepare(`
      SELECT id, email, name, business_name, created_at,
             meta_access_token, meta_ig_id, meta_ig_name,
             meta_page_id, meta_page_name, meta_page_token,
             tiktok_open_id, tiktok_access_token, tiktok_display_name, tiktok_avatar_url,
             youtube_access_token, youtube_channel_id, youtube_channel_name, youtube_channel_avatar,
             linkedin_access_token, linkedin_person_id, linkedin_name, linkedin_avatar_url,
             ig_direct_user_id, ig_direct_username, ig_direct_token_expires_at,
             notif_email, notif_published, notif_failed, notif_weekly, notif_ai, notif_import
      FROM users WHERE id = ?
    `).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);
    res.json({ ...user, subscription: subscription || null });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── NOTIFICATION PREFERENCES ────────────────────────────
router.post('/notifications', requireAuth, (req, res) => {
  try {
    const { email, notif_published, notif_failed, notif_weekly, notif_ai, notif_import } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    db.prepare(`
      UPDATE users SET
        notif_email = ?,
        notif_published = ?,
        notif_failed = ?,
        notif_weekly = ?,
        notif_ai = ?,
        notif_import = ?
      WHERE id = ?
    `).run(email, notif_published ? 1 : 0, notif_failed ? 1 : 0, notif_weekly ? 1 : 0, notif_ai ? 1 : 0, notif_import ? 1 : 0, req.user.id);
    res.json({ success: true });
  } catch(err) {
    console.error('Notification prefs error:', err);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ── FORGOT PASSWORD ─────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent' });

    const resetToken = uuidv4();
    const expires = Date.now() + 60 * 60 * 1000;
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
      .run(resetToken, expires, user.id);

    res.json({ message: 'If that email exists, a reset link has been sent' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ── RESET PASSWORD ──────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?')
      .get(token, Date.now());
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
      .run(passwordHash, user.id);

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── VERIFY EMAIL ────────────────────────────────────────
router.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const user = db.prepare('SELECT id FROM users WHERE email_verify_token = ?').get(token);
    if (!user) return res.status(400).json({ error: 'Invalid verification token' });
    db.prepare('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?').run(user.id);
    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── REQUEST ACCESS (auto-approve flow) ──────────────────
// Beta growth strategy: keep a single signup form (no separate register/login
// flow on the marketing site), but on submit we IMMEDIATELY provision an
// account and email the user their login. Net effect for the user: fill out
// form → check email → log in. For the operator (you): all requests still
// stored in `access_requests` for records, AND a real `users` row exists, so
// you keep visibility and can revoke if needed.
//
// KILL SWITCH: set `SIGNUPS_OPEN=false` on Railway to immediately stop
// provisioning. Form still accepts submissions and stores them in
// access_requests for manual approval, but no account is created and no
// password is emailed. Flip back to anything else (or unset) to resume.
router.post('/request-access', async (req, res) => {
  const { name, email, instagram } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    // Always log the request first — this is the source of truth for "who
    // signed up" even if account provisioning fails for any reason.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        instagram TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
        auto_approved INTEGER DEFAULT 0
      )
    `).run();
    // Add column to pre-existing table if missing (migration-on-write).
    try { db.prepare(`ALTER TABLE access_requests ADD COLUMN auto_approved INTEGER DEFAULT 0`).run(); } catch {}

    const signupsOpen = process.env.SIGNUPS_OPEN !== 'false';
    let provisioned = false;
    let tempPassword = null;

    if (signupsOpen) {
      // Check if a user account already exists for this email. If so, skip
      // provisioning (don't reset their password — they should use Forgot
      // Password instead) but still record the request.
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);

      if (!existingUser) {
        // Generate a memorable but reasonably strong temporary password.
        // Format: "Luna-XXXXXX" (10 alphanumeric chars total after Luna-).
        // Users are encouraged to change it after logging in.
        const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';
        let suffix = '';
        for (let i = 0; i < 10; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
        tempPassword = `Luna-${suffix}`;

        const passwordHash = await bcrypt.hash(tempPassword, 12);
        const userId = uuidv4();
        const now = Date.now();
        const verifyToken = uuidv4();

        db.prepare(`
          INSERT INTO users (id, email, password_hash, name, business_name, email_verify_token, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, normalizedEmail, passwordHash, name, '', verifyToken, now, now);

        // Mirror the beta-onboarding logic from /register so auto-approved
        // users get the same Pro-during-beta experience.
        const isBeta = process.env.BETA_MODE !== 'ended';
        const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL').get().count;
        db.prepare(`
          INSERT INTO subscriptions (user_id, plan, status, is_beta, beta_user_number, trial_ends_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          isBeta ? 'pro' : 'trial',
          isBeta ? 'active' : 'trial',
          isBeta ? 1 : 0,
          isBeta ? totalUsers : null,
          isBeta ? null : now + 14 * 24 * 60 * 60 * 1000,
          now
        );
        provisioned = true;
      }
    }

    db.prepare(
      `INSERT INTO access_requests (name, email, instagram, auto_approved) VALUES (?, ?, ?, ?)`
    ).run(name, normalizedEmail, instagram || '', provisioned ? 1 : 0);

    // ── EMAILS (best-effort; failures don't block the response) ──
    // 1. To the user: their login info (only when provisioned)
    if (provisioned && tempPassword) {
      try {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
          to: normalizedEmail,
          from: 'noreply@lunaxmedia.com',
          subject: 'Welcome to Luna X — your beta access is ready',
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
              <h2 style="margin:0 0 16px">You're in.</h2>
              <p>Hi ${name.split(' ')[0] || name},</p>
              <p>Thanks for requesting access to <strong>Luna X</strong>. Your beta account is ready to use.</p>
              <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:16px;margin:20px 0">
                <p style="margin:0 0 8px"><strong>Email:</strong> ${normalizedEmail}</p>
                <p style="margin:0"><strong>Temporary password:</strong> <code style="background:#fff;padding:2px 6px;border-radius:4px;font-size:14px">${tempPassword}</code></p>
              </div>
              <p>Log in at <a href="https://lunaxmedia.com/login.html" style="color:#7c3aed">lunaxmedia.com/login.html</a> and change your password in Settings.</p>
              <p style="margin-top:32px;color:#666;font-size:13px">During beta, you get full Pro access for free. Reply to this email anytime with feedback or issues — we're listening.</p>
              <p style="color:#666;font-size:13px">— Luna X</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('[request-access] user welcome email failed:', emailErr.message);
        // Owner notification below will still flag this so you can manually
        // send credentials if needed.
      }
    }

    // 2. To you (owner): notification
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: 'needmarketingg@gmail.com',
        from: 'noreply@lunaxmedia.com',
        subject: `Luna X — ${provisioned ? 'New beta signup' : 'Access request (queued)'}: ${name}`,
        html: `
          <h2 style="font-family:sans-serif">${provisioned ? 'New beta signup (auto-approved)' : 'Access request — manual review needed'}</h2>
          <p style="font-family:sans-serif"><strong>Name:</strong> ${name}</p>
          <p style="font-family:sans-serif"><strong>Email:</strong> ${normalizedEmail}</p>
          <p style="font-family:sans-serif"><strong>Instagram:</strong> ${instagram || 'not provided'}</p>
          <p style="font-family:sans-serif"><strong>Status:</strong> ${provisioned ? '✅ account created & welcome email sent' : (signupsOpen ? '⚠️ already had an account — no email sent' : '🚦 SIGNUPS_OPEN=false — no account created, queued only')}</p>
          <p style="font-family:sans-serif;color:#888;font-size:12px">Submitted at ${new Date().toLocaleString()}</p>
        `
      });
    } catch (emailErr) {
      console.error('[request-access] owner notification email failed:', emailErr.message);
    }

    res.json({ ok: true, provisioned });
  } catch (err) {
    console.error('Request access error:', err);
    res.status(500).json({ error: 'Failed to save request' });
  }
});

// ── VIEW ACCESS REQUESTS (owner only) ───────────────────
// Simple browser-viewable list of everyone who requested access.
// Protected by a secret key in the query string so it's not public.
// Visit: /auth/access-requests?key=YOUR_SECRET
router.get('/access-requests', (req, res) => {
  const SECRET = process.env.ADMIN_KEY || 'lunax-admin-2026';
  if (req.query.key !== SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    // Table may not exist yet if no one has requested access — handle gracefully.
    const exists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='access_requests'`
    ).get();
    if (!exists) return res.json({ count: 0, requests: [] });

    const rows = db.prepare(
      `SELECT id, name, email, instagram, created_at,
              COALESCE(auto_approved, 0) AS auto_approved
       FROM access_requests ORDER BY created_at DESC`
    ).all();
    const requests = rows.map(r => ({
      ...r,
      auto_approved: !!r.auto_approved,
      requested_at: new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/Denver' }),
    }));
    res.json({ count: requests.length, requests });
  } catch (err) {
    console.error('Access-requests view error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FIND DUPLICATE ACCOUNTS BY EMAIL (temporary diagnostic) ──────────
// The connectMeta() bug (fixed) could silently create a brand-new, empty
// Luna X account sharing the same display name/email as an existing one,
// whenever a session was missing at the moment "Connect Meta" was clicked.
// Since `users.email` has no UNIQUE constraint, multiple rows can carry the
// identical email/name and look indistinguishable in the UI. This route
// finds every row for a given email and shows which one actually has posts,
// so the real account can be identified instead of guessed at.
// Visit: /auth/find-duplicates?email=you@example.com&key=YOUR_SECRET
router.get('/find-duplicates', (req, res) => {
  const SECRET = process.env.ADMIN_KEY || 'lunax-admin-2026';
  if (req.query.key !== SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email query param required' });

  try {
    const users = db.prepare(`
      SELECT id, email, name, created_at, updated_at,
             meta_access_token, meta_page_name, meta_ig_name
      FROM users WHERE email = ? ORDER BY created_at ASC
    `).all(email);

    const results = users.map(u => {
      const postCount = db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(u.id).c;
      const postedCount = db.prepare(`SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status = 'posted'`).get(u.id).c;
      return {
        id: u.id,
        created_at: new Date(u.created_at).toLocaleString('en-US', { timeZone: 'America/Denver' }),
        has_meta_connected: !!u.meta_access_token,
        meta_page_name: u.meta_page_name || null,
        meta_ig_name: u.meta_ig_name || null,
        total_posts: postCount,
        posted_count: postedCount,
      };
    });

    res.json({ email, accountsFound: results.length, accounts: results });
  } catch (err) {
    console.error('find-duplicates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FIND WHICH ACCOUNT OWNS RECENT POSTS (temporary diagnostic) ──────
// Companion to /find-duplicates: instead of searching by email, this looks
// at actual posts directly and shows which user_id/account each belongs to
// — for tracking down a post that "disappeared" because it's sitting under
// a different (possibly duplicate, possibly blank-email) account than the
// one currently logged in.
// Visit: /auth/find-post-owner?key=YOUR_SECRET
router.get('/find-post-owner', (req, res) => {
  const SECRET = process.env.ADMIN_KEY || 'lunax-admin-2026';
  if (req.query.key !== SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const rows = db.prepare(`
      SELECT p.id as post_id, p.caption, p.status, p.created_at as post_created_at,
             u.id as user_id, u.email, u.name, u.created_at as user_created_at
      FROM posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 20
    `).all();
    const results = rows.map(r => ({
      post_id: r.post_id,
      caption: (r.caption || '').slice(0, 60),
      status: r.status,
      post_created_at: new Date(r.post_created_at).toLocaleString('en-US', { timeZone: 'America/Denver' }),
      user_id: r.user_id,
      user_email: r.email || '(blank)',
      user_name: r.name,
      user_created_at: new Date(r.user_created_at).toLocaleString('en-US', { timeZone: 'America/Denver' }),
    }));
    res.json({ count: results.length, posts: results });
  } catch (err) {
    console.error('find-post-owner error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POSTED-FILE MEMORY ──────────────────────────────────
// Remembers which specific media files a user has already scheduled, so the
// bulk flow can auto-select only NEW videos from a folder next time (and not
// re-post ones already used). A file is identified by a stable signature:
//   "<full path>|<size>|<lastModified>"  — robust to renamed/duplicate names.

function ensurePostedFilesTable() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS posted_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      name TEXT,
      folder_path TEXT,
      posted_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(user_id, signature)
    )
  `).run();
}

// GET /auth/posted-files?folder=/optional/path
// Returns the signatures this user has already posted (optionally for one folder).
router.get('/posted-files', requireAuth, (req, res) => {
  try {
    ensurePostedFilesTable();
    const folder = req.query.folder;
    const rows = folder
      ? db.prepare('SELECT signature FROM posted_files WHERE user_id = ? AND folder_path = ?').all(req.user.id, folder)
      : db.prepare('SELECT signature FROM posted_files WHERE user_id = ?').all(req.user.id);
    res.json({ signatures: rows.map(r => r.signature) });
  } catch (err) {
    console.error('Posted-files get error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/posted-files   body: { signature, name, folderPath }
// Records one file as posted. Idempotent (UNIQUE(user_id, signature)).
router.post('/posted-files', requireAuth, (req, res) => {
  try {
    ensurePostedFilesTable();
    const { signature, name, folderPath } = req.body;
    if (!signature) return res.status(400).json({ error: 'signature required' });
    db.prepare(`
      INSERT INTO posted_files (user_id, signature, name, folder_path)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, signature) DO NOTHING
    `).run(req.user.id, signature, name || '', folderPath || '');
    res.json({ ok: true });
  } catch (err) {
    console.error('Posted-files record error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SIGN IN WITH APPLE
// ════════════════════════════════════════════════════════════════════════════
// Added for App Store Guideline 4.8 compliance — Apple requires an equivalent
// "Sign in with Apple" option on any app offering third-party login (Google,
// in this case). LoginView.swift's native ASAuthorizationController flow
// hands us an `identityToken` (a signed JWT from Apple, NOT a Luna X token)
// to verify, then we find-or-create a Luna X user and return the same
// {token, user} shape /login already returns, so appState.loginWithToken()
// on the client needs zero changes.
//
// REQUIRED: `npm install jwks-rsa` (verifies the token's RS256 signature
// against Apple's public keys at https://appleid.apple.com/auth/keys).
//
// REQUIRED env var: APPLE_CLIENT_ID — set this to your app's Bundle ID
// (com.lunaxmedia.lunax) on Railway. Native Sign in with Apple (as opposed
// to the web/JS flow) puts the Bundle ID in the token's `aud` claim, and we
// verify against it to make sure the token was actually issued for this app.
//
// IMPORTANT CAVEAT: Apple only includes `email` in the identity token on a
// user's FIRST authorization ever for this app — every subsequent sign-in
// only carries `sub` (a stable, per-app-per-user id), no email at all. That's
// why lookup is keyed on `apple_user_id` first, with email-based lookup only
// used to link an existing account the first time.
const jwksClient = require('jwks-rsa');

const appleJwksClient = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000, // 24h — Apple rotates these infrequently
});

function getApplePublicKey(header, callback) {
  appleJwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyAppleIdentityToken(identityToken) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      identityToken,
      getApplePublicKey,
      {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: process.env.APPLE_CLIENT_ID,
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

function _ensureAppleColumns() {
  // Same migration-on-write pattern as _ensureIgDirectColumns below —
  // no UNIQUE constraint added, consistent with how `email` itself isn't
  // unique in this schema either (see the /find-duplicates diagnostic above).
  try { db.prepare(`ALTER TABLE users ADD COLUMN apple_user_id TEXT`).run(); } catch {}
}

router.post('/apple', async (req, res) => {
  try {
    const { identityToken } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'identityToken required' });

    let decoded;
    try {
      decoded = await verifyAppleIdentityToken(identityToken);
    } catch (err) {
      console.error('Apple token verify failed:', err.message);
      return res.status(401).json({ error: 'Invalid Apple identity token' });
    }

    const appleUserId = decoded.sub;
    const email = (decoded.email || '').toLowerCase();
    if (!appleUserId) return res.status(401).json({ error: 'Apple token missing sub claim' });

    _ensureAppleColumns();

    let user = db.prepare('SELECT * FROM users WHERE apple_user_id = ?').get(appleUserId);

    if (!user && email) {
      // First-time sign-in (or a new device before apple_user_id got
      // linked) — match by email if we have one, and link it going forward.
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        db.prepare('UPDATE users SET apple_user_id = ?, updated_at = ? WHERE id = ?')
          .run(appleUserId, Date.now(), user.id);
      }
    }

    if (!user) {
      // Brand new user — provision an account, mirroring /register's
      // beta-onboarding logic. password_hash can't be NULL (NOT NULL
      // constraint on that column, confirmed by the SqliteError this threw)
      // — so we generate a random, unusable hash instead. Nobody, including
      // us, ever knows the underlying random value, so this user can only
      // ever authenticate via /auth/apple, never /login's email+password path.
      const userId = uuidv4();
      const now = Date.now();
      // Apple's private relay email (if the person chose "Hide My Email")
      // is a real, working forwarding address, so it's fine to store as-is.
      // Only fall back to a placeholder if email is truly absent (a
      // subsequent-sign-in edge case that shouldn't normally reach this
      // "brand new user" branch at all, but guards against a null insert).
      const emailToStore = email || `${appleUserId}@appleid.privaterelay.local`;
      const unusablePassword = uuidv4() + uuidv4();
      const passwordHash = await bcrypt.hash(unusablePassword, 12);

      db.prepare(`
        INSERT INTO users (id, email, password_hash, name, business_name, apple_user_id, email_verified, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, 1, ?, ?)
      `).run(userId, emailToStore, passwordHash, 'Apple User', appleUserId, now, now);

      const isBeta = process.env.BETA_MODE !== 'ended';
      const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL').get().count;
      db.prepare(`
        INSERT INTO subscriptions (user_id, plan, status, is_beta, beta_user_number, trial_ends_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        isBeta ? 'pro' : 'trial',
        isBeta ? 'active' : 'trial',
        isBeta ? 1 : 0,
        isBeta ? totalUsers : null,
        isBeta ? null : now + 14 * 24 * 60 * 60 * 1000,
        now
      );

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        businessName: user.business_name,
        subscription: subscription || null,
      },
    });
  } catch (err) {
    console.error('Apple sign-in error:', err);
    res.status(500).json({ error: 'Sign in with Apple failed' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// RESTREAM DESTINATIONS — Twitch / YouTube / Kick
// ════════════════════════════════════════════════════════════════════════
// DIFFERENT from the /oauth/{platform} routes above, which connect accounts
// for POSTING content. This connects destination accounts for the
// lunax-rtmp service to RESTREAM a live broadcast to, once streaming into
// Luna X via the RTMP key (ConnectAccountsView's StreamKeySection).
//
// REQUIRED env vars on Railway (lunax-server, not lunax-rtmp):
//   TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET
//   YOUTUBE_RESTREAM_CLIENT_ID / YOUTUBE_RESTREAM_CLIENT_SECRET
//   KICK_CLIENT_ID / KICK_CLIENT_SECRET
//   RESTREAM_REDIRECT_BASE — e.g. https://lunax-server-production.up.railway.app

const crypto = require('crypto');

// Kick requires OAuth 2.1 with PKCE (a code_verifier/code_challenge pair) —
// Twitch and Google's server-side auth-code flow work fine without it, but
// Kick's API mandates it. Since the code_verifier has to survive between
// the /oauth/kick redirect and the separate /oauth/kick/callback request,
// it's embedded inside the signed `state` JWT below rather than needing
// server-side session storage — state is already round-tripped through the
// OAuth provider unmodified, so it's a safe, stateless place to carry it.
function generatePKCEPair() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

const RESTREAM_PLATFORMS = {
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'channel:read:stream_key',
    profileUrl: 'https://api.twitch.tv/helix/users',
  },
  youtube: {
    clientId: process.env.YOUTUBE_RESTREAM_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_RESTREAM_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // force-ssl (despite the confusing name, unrelated to SSL/HTTPS) covers
    // every Live Streaming API operation this restream flow needs — insert,
    // bind, transition all accept it — without the broader channel/video
    // management access the full "youtube" scope also grants.
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    profileUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
  },
  kick: {
    clientId: process.env.KICK_CLIENT_ID,
    clientSecret: process.env.KICK_CLIENT_SECRET,
    authUrl: 'https://id.kick.com/oauth/authorize',
    tokenUrl: 'https://id.kick.com/oauth/token',
    // streamkey:read is the one that actually matters for restreaming — it's
    // what lets lunax-rtmp eventually fetch the destination channel's RTMP
    // ingest key to push a stream to.
    scope: 'user:read channel:read streamkey:read',
    profileUrl: 'https://api.kick.com/public/v1/users',
  },
};

function _ensureRestreamColumns() {
  const columns = [
    `twitch_access_token TEXT`, `twitch_refresh_token TEXT`, `twitch_display_name TEXT`,
    `youtube_restream_access_token TEXT`, `youtube_restream_refresh_token TEXT`, `youtube_restream_channel_name TEXT`,
    `kick_access_token TEXT`, `kick_refresh_token TEXT`, `kick_display_name TEXT`,
  ];
  for (const col of columns) {
    try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch {}
  }
}

// GET /restream/status — authenticated. Returns connection state for all
// three destinations at once: { twitch: "Display Name", youtube: "Channel
// Name", kick: "Display Name" } (null = not connected).
router.get('/restream/status', requireAuth, (req, res) => {
  try {
    _ensureRestreamColumns();
    const user = db.prepare(`
      SELECT twitch_access_token, twitch_display_name,
             youtube_restream_access_token, youtube_restream_channel_name,
             kick_access_token, kick_display_name
      FROM users WHERE id = ?
    `).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      twitch: user.twitch_access_token ? (user.twitch_display_name || '') : null,
      youtube: user.youtube_restream_access_token ? (user.youtube_restream_channel_name || '') : null,
      kick: user.kick_access_token ? (user.kick_display_name || '') : null,
    });
  } catch (err) {
    console.error('Restream status error:', err);
    res.status(500).json({ error: 'Failed to load restream status' });
  }
});

// GET /restream/oauth/:platform?token=X&redirect=native
router.get('/restream/oauth/:platform', (req, res) => {
  const { platform } = req.params;
  const config = RESTREAM_PLATFORMS[platform];
  if (!config) return res.status(400).send('Unknown restream platform');
  if (!config.clientId) return res.status(500).send(`${platform} restream is not configured on the server`);

  const { token } = req.query;
  if (!token) return res.status(401).send('Missing token');

  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).send('Invalid or expired token');
  }

  // Kick requires PKCE — generate the pair and embed the verifier in the
  // signed state (Twitch/Google don't need this, so it's only added for
  // Kick specifically rather than complicating the other two flows).
  let codeVerifier, codeChallenge;
  const statePayload = { uid: userId, platform };
  if (platform === 'kick') {
    const pkce = generatePKCEPair();
    codeVerifier = pkce.codeVerifier;
    codeChallenge = pkce.codeChallenge;
    statePayload.codeVerifier = codeVerifier;
  }
  const state = jwt.sign(statePayload, process.env.JWT_SECRET, { expiresIn: '10m' });
  const redirectUri = `${process.env.RESTREAM_REDIRECT_BASE}/auth/restream/oauth/${platform}/callback`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scope,
    state,
  });
  // Google (YouTube) needs these two extras to reliably return a refresh token.
  if (platform === 'youtube') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  if (platform === 'kick') {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  res.redirect(`${config.authUrl}?${params.toString()}`);
});

// GET /restream/oauth/:platform/callback
router.get('/restream/oauth/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const config = RESTREAM_PLATFORMS[platform];
  const fail = (reason) => res.redirect(`lunax://restream-error?platform=${platform}&reason=${encodeURIComponent(reason)}`);
  if (!config) return fail('Unknown platform');

  try {
    const { code, state, error } = req.query;
    if (error) return fail(error);
    if (!code || !state) return fail('Missing code or state');

    let userId, statePlatform, stateCodeVerifier;
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      userId = decoded.uid;
      statePlatform = decoded.platform;
      stateCodeVerifier = decoded.codeVerifier;
    } catch {
      return fail('Invalid or expired state');
    }
    if (statePlatform !== platform) return fail('State/platform mismatch');
    if (platform === 'kick' && !stateCodeVerifier) return fail('Missing PKCE verifier');

    const redirectUri = `${process.env.RESTREAM_REDIRECT_BASE}/auth/restream/oauth/${platform}/callback`;
    const tokenBody = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    // Kick's OAuth 2.1 flow requires the original code_verifier here — the
    // authorization request only sent its SHA-256 hash (code_challenge);
    // this is Kick verifying the client that started the flow is the same
    // one finishing it.
    if (platform === 'kick') {
      tokenBody.set('code_verifier', stateCodeVerifier);
    }
    const tokenResp = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.access_token) {
      console.error(`${platform} restream token exchange failed:`, tokenJson);
      return fail('Token exchange failed');
    }

    _ensureRestreamColumns();

    let displayName = '';
    try {
      const profileResp = await fetch(config.profileUrl, {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          ...(platform === 'twitch' ? { 'Client-Id': config.clientId } : {}),
        },
      });
      const profileJson = await profileResp.json();
      if (platform === 'kick') {
        console.log('[Kick restream] profile response status:', profileResp.status, profileResp.ok);
      }
      if (platform === 'twitch') displayName = profileJson?.data?.[0]?.display_name || '';
      else if (platform === 'youtube') displayName = profileJson?.items?.[0]?.snippet?.title || '';
      else if (platform === 'kick') {
        // Logging the raw shape since the first guess at field names
        // (data[0].name / .username) came back empty — rather than guess
        // again, this shows exactly what Kick's API actually returns so
        // the real field name can be used instead of assumed.
        console.log('[Kick restream] raw profile response:', JSON.stringify(profileJson));
        const first = profileJson?.data?.[0];
        displayName = first?.name || first?.username || first?.slug || first?.display_name
          || profileJson?.username || profileJson?.name || profileJson?.slug || '';
      }
    } catch (profileErr) {
      console.error(`${platform} restream profile fetch failed:`, profileErr.message);
    }

    const columnMap = {
      twitch: ['twitch_access_token', 'twitch_refresh_token', 'twitch_display_name'],
      youtube: ['youtube_restream_access_token', 'youtube_restream_refresh_token', 'youtube_restream_channel_name'],
      kick: ['kick_access_token', 'kick_refresh_token', 'kick_display_name'],
    }[platform];

    db.prepare(`
      UPDATE users SET ${columnMap[0]} = ?, ${columnMap[1]} = ?, ${columnMap[2]} = ?, updated_at = ?
      WHERE id = ?
    `).run(tokenJson.access_token, tokenJson.refresh_token || null, displayName, Date.now(), userId);

    res.redirect(`lunax://restream-connected?platform=${platform}&name=${encodeURIComponent(displayName)}`);
  } catch (err) {
    console.error(`${platform} restream callback error:`, err);
    fail('Unexpected error during connect');
  }
});

// DELETE /restream/oauth/:platform — authenticated.
router.delete('/restream/oauth/:platform', requireAuth, (req, res) => {
  const { platform } = req.params;
  const columnMap = {
    twitch: ['twitch_access_token', 'twitch_refresh_token', 'twitch_display_name'],
    youtube: ['youtube_restream_access_token', 'youtube_restream_refresh_token', 'youtube_restream_channel_name'],
    kick: ['kick_access_token', 'kick_refresh_token', 'kick_display_name'],
  }[platform];
  if (!columnMap) return res.status(400).json({ error: 'Unknown platform' });

  try {
    _ensureRestreamColumns();
    db.prepare(`
      UPDATE users SET ${columnMap[0]} = NULL, ${columnMap[1]} = NULL, ${columnMap[2]} = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Restream disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// INSTAGRAM API with INSTAGRAM LOGIN (no Facebook required)
// ════════════════════════════════════════════════════════════════════════════
// This is Meta's NEWER Instagram auth flow (launched June 2024). Unlike the
// existing /auth/meta flow which goes through Facebook OAuth and requires
// the user to have a Facebook Page linked to their IG, this flow authenticates
// directly via Instagram and works for any Business or Creator account —
// no Facebook account, no Facebook Page needed.
//
// SCHEMA migration (run on first request to /start). Adds 4 columns to users:
//   ig_direct_user_id            — the IG user ID returned by /me
//   ig_direct_username           — handle, for display
//   ig_direct_access_token       — long-lived token (60 day expiry)
//   ig_direct_token_expires_at   — unix ms timestamp when token expires
//
// REQUIRED env vars on Railway:
//   IG_APP_ID         — your Instagram App ID from Meta Developers
//   IG_APP_SECRET     — your Instagram App Secret
//   IG_REDIRECT_URI   — e.g. https://lunax-server-production.up.railway.app/auth/instagram-direct/callback
//   APP_FRONTEND_URL  — e.g. https://lunaxmedia.com (used to send user back after success)
//
// NOTES on Meta's setup (do this BEFORE testing):
//   1. In your Meta App, add the "Instagram" product
//   2. Set up "Instagram API with Instagram Login" (NOT "Facebook Login")
//   3. Add IG_REDIRECT_URI as an OAuth redirect URI
//   4. Request scopes: instagram_business_basic, instagram_business_content_publish
//   5. App Review required before production use — until then, add testers
//      under App Roles → Instagram Testers and have them accept the invite
//      from instagram.com/accounts/manage_access.

function _ensureIgDirectColumns() {
  // Idempotent migration. ALTER TABLE ADD COLUMN throws if the column already
  // exists — we catch and ignore. Cheap on every call (sqlite caches the
  // schema), so we run it before any IG-direct endpoint touches the DB.
  const columns = [
    `ig_direct_user_id TEXT`,
    `ig_direct_username TEXT`,
    `ig_direct_access_token TEXT`,
    `ig_direct_token_expires_at INTEGER`,
  ];
  for (const col of columns) {
    try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch {}
  }
}

// ── /auth/instagram-direct/start ───────────────────────────────────────
// Authenticated. Returns the OAuth URL the frontend should redirect to. We
// embed the user's id in `state` (signed with JWT secret) so the callback
// can match the IG account back to the correct Luna X user — and so we can
// reject CSRF attempts that try to forge the state value.
router.get('/instagram-direct/start', requireAuth, (req, res) => {
  try {
    _ensureIgDirectColumns();
    const appId = process.env.IG_APP_ID;
    const redirectUri = process.env.IG_REDIRECT_URI;
    if (!appId || !redirectUri) {
      return res.status(500).json({ error: 'Instagram direct login is not configured on the server (IG_APP_ID / IG_REDIRECT_URI missing)' });
    }
    // Sign the state to prevent CSRF / replay. JWT with 10 min expiry is plenty.
    const state = jwt.sign({ uid: req.user.id, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const scope = [
      'instagram_business_basic',
      'instagram_business_content_publish',
    ].join(',');
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
    });
    const authUrl = `https://www.instagram.com/oauth/authorize?${params.toString()}`;
    res.json({ authUrl });
  } catch (err) {
    console.error('IG-direct start error:', err);
    res.status(500).json({ error: 'Failed to start Instagram login' });
  }
});

// ── /auth/instagram-direct/callback ────────────────────────────────────
// Meta redirects the user here after they grant (or deny) permissions. We
// verify the state, exchange the code for a short-lived token, then exchange
// that for a long-lived (60-day) token, fetch the user's IG profile, and
// store everything against their Luna X account.
//
// On success → redirect to frontend with ?ig=connected
// On failure → redirect to frontend with ?ig=error&reason=...
router.get('/instagram-direct/callback', async (req, res) => {
  const frontend = process.env.APP_FRONTEND_URL || 'https://lunaxmedia.com';
  const fail = (reason) => res.redirect(`${frontend}/?ig=error&reason=${encodeURIComponent(reason)}`);

  try {
    _ensureIgDirectColumns();
    const { code, state, error, error_reason, error_description } = req.query;
    if (error) return fail(error_description || error_reason || error);
    if (!code || !state) return fail('Missing code or state from Instagram');

    // Verify state — must be a JWT we issued less than 10 minutes ago.
    let userId;
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      userId = decoded.uid;
    } catch {
      return fail('Invalid or expired state — please try connecting again');
    }
    if (!userId) return fail('State did not include a user id');

    const appId = process.env.IG_APP_ID;
    const appSecret = process.env.IG_APP_SECRET;
    const redirectUri = process.env.IG_REDIRECT_URI;
    if (!appId || !appSecret || !redirectUri) {
      return fail('Instagram direct login is not configured');
    }

    // ── Step 1: short-lived token from auth code ──
    // POST form-encoded to api.instagram.com/oauth/access_token
    const tokenForm = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    const tokenResp = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenForm.toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.access_token) {
      console.error('IG-direct short-lived token failed:', tokenJson);
      return fail(tokenJson.error_message || tokenJson.error_type || 'Token exchange failed');
    }
    const shortLivedToken = tokenJson.access_token;
    const igUserId = String(tokenJson.user_id || '');

    // ── Step 2: exchange short-lived for long-lived (60 day) ──
    // GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&...
    const llParams = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: appSecret,
      access_token: shortLivedToken,
    });
    const llResp = await fetch(`https://graph.instagram.com/access_token?${llParams.toString()}`);
    const llJson = await llResp.json();
    if (!llResp.ok || !llJson.access_token) {
      console.error('IG-direct long-lived token exchange failed:', llJson);
      // Fall back to short-lived; user will need to reconnect in an hour.
      // Still log them in.
    }
    const finalToken = llJson.access_token || shortLivedToken;
    const expiresInSeconds = llJson.expires_in || 3600; // 60d normally, 1h fallback
    const tokenExpiresAt = Date.now() + expiresInSeconds * 1000;

    // ── Step 3: fetch the user's IG profile so we have their username ──
    const meParams = new URLSearchParams({
      fields: 'id,username,account_type',
      access_token: finalToken,
    });
    const meResp = await fetch(`https://graph.instagram.com/v23.0/me?${meParams.toString()}`);
    const meJson = await meResp.json();
    if (!meResp.ok) {
      console.error('IG-direct /me failed:', meJson);
      return fail('Connected but failed to fetch profile — try again');
    }
    const username = meJson.username || '';
    const finalIgUserId = meJson.id || igUserId;
    const accountType = meJson.account_type || ''; // 'BUSINESS' or 'MEDIA_CREATOR'

    // Reject personal accounts — they can't publish via API and the user will
    // hit a confusing failure later if we let them through. Better to fail
    // here with a clear message.
    if (accountType && accountType !== 'BUSINESS' && accountType !== 'MEDIA_CREATOR') {
      return fail(`Your Instagram is a ${accountType} account. Switch to Business or Creator in IG Settings → Account type, then try again.`);
    }

    // ── Step 4: store on the user row ──
    db.prepare(`
      UPDATE users
      SET ig_direct_user_id = ?,
          ig_direct_username = ?,
          ig_direct_access_token = ?,
          ig_direct_token_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(finalIgUserId, username, finalToken, tokenExpiresAt, Date.now(), userId);

    return res.redirect(`${frontend}/?ig=connected&username=${encodeURIComponent(username)}`);
  } catch (err) {
    console.error('IG-direct callback error:', err);
    return fail('Unexpected error during Instagram connect');
  }
});

// ── /auth/instagram-direct/disconnect ──────────────────────────────────
// Clear the stored credentials. Doesn't revoke the token on Meta's side
// (they don't expose a revoke endpoint for this flow) — just drops it
// locally so we won't use it.
router.post('/instagram-direct/disconnect', requireAuth, (req, res) => {
  try {
    _ensureIgDirectColumns();
    db.prepare(`
      UPDATE users
      SET ig_direct_user_id = NULL,
          ig_direct_username = NULL,
          ig_direct_access_token = NULL,
          ig_direct_token_expires_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(Date.now(), req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('IG-direct disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ── /auth/instagram-direct/refresh ─────────────────────────────────────
// Optional: lets the frontend or a cron job extend a long-lived token before
// it expires. Meta allows refresh at any point as long as the current token
// is still valid AND at least 24h old. Returns the new expiry.
router.post('/instagram-direct/refresh', requireAuth, async (req, res) => {
  try {
    _ensureIgDirectColumns();
    const user = db.prepare('SELECT ig_direct_access_token FROM users WHERE id = ?').get(req.user.id);
    if (!user || !user.ig_direct_access_token) {
      return res.status(404).json({ error: 'No Instagram-direct connection to refresh' });
    }
    const params = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: user.ig_direct_access_token,
    });
    const resp = await fetch(`https://graph.instagram.com/refresh_access_token?${params.toString()}`);
    const json = await resp.json();
    if (!resp.ok || !json.access_token) {
      console.error('IG-direct refresh failed:', json);
      return res.status(400).json({ error: json.error_message || 'Refresh failed' });
    }
    const newExpiresAt = Date.now() + (json.expires_in || 5184000) * 1000;
    db.prepare(`
      UPDATE users
      SET ig_direct_access_token = ?,
          ig_direct_token_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(json.access_token, newExpiresAt, Date.now(), req.user.id);
    res.json({ ok: true, expiresAt: newExpiresAt });
  } catch (err) {
    console.error('IG-direct refresh error:', err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;
