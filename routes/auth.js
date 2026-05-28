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
    const user = db.prepare(`
      SELECT id, email, name, business_name, created_at,
             meta_access_token, meta_ig_id, meta_ig_name,
             meta_page_id, meta_page_name, meta_page_token,
             tiktok_open_id, tiktok_access_token, tiktok_display_name, tiktok_avatar_url,
             youtube_access_token, youtube_channel_id, youtube_channel_name, youtube_channel_avatar,
             linkedin_access_token, linkedin_person_id, linkedin_name, linkedin_avatar_url,
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

module.exports = router;
module.exports.requireAuth = requireAuth;
