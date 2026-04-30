const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db/database');
const { sendEmail } = require('./email');

function createSession(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return jwt.sign(
    { id: userId, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}


// ── GOOGLE OAUTH ──────────────────────────────────────────
// Setup: console.cloud.google.com → APIs → OAuth consent screen
// → Credentials → Create OAuth 2.0 Client ID (Web)
// Add redirect URI: https://YOUR_RAILWAY_URL/auth/google/callback
// Set env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

router.get('/google', (req, res) => {
  if(!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=google_not_configured`);
  }
  const state = crypto.randomBytes(16).toString('hex');
  // Store state in session for CSRF protection
  db.prepare('INSERT OR REPLACE INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)')
    .run(state, 'google', Date.now());

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if(error || !code) return res.redirect(`${process.env.FRONTEND_URL}/login?error=google_denied`);

  // Verify state
  const storedState = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, 'google');
  if(!storedState) return res.redirect(`${process.env.FRONTEND_URL}/login?error=invalid_state`);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.BACKEND_URL}/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if(!tokens.access_token) throw new Error('No access token');

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json();

    const session = await findOrCreateOAuthUser({
      provider: 'google',
      providerId: profile.id,
      email: profile.email,
      name: profile.name,
      avatar: profile.picture,
      emailVerified: profile.verified_email
    });

    res.redirect(`${process.env.FRONTEND_URL}/lunax.html?session=${session.token}&welcome=${session.isNew ? '1' : '0'}`);
  } catch(err) {
    console.error('Google OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=google_failed`);
  }
});

// ── APPLE OAUTH ───────────────────────────────────────────
// Setup: developer.apple.com → Certificates → Sign in with Apple
// Requires: Apple Developer account ($99/yr), App ID, Service ID
// Set env vars: APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY

router.get('/apple', (req, res) => {
  if(!process.env.APPLE_CLIENT_ID) {
    return res.redirect(`${process.env.FRONTEND_URL}/login?error=apple_not_configured`);
  }
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)')
    .run(state, 'apple', Date.now());

  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/apple/callback`,
    response_type: 'code id_token',
    scope: 'name email',
    response_mode: 'form_post',
    state
  });
  res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

router.post('/apple/callback', async (req, res) => {
  const { code, state, error, user: userJson } = req.body;
  if(error || !code) return res.redirect(`${process.env.FRONTEND_URL}/login?error=apple_denied`);

  const storedState = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, 'apple');
  if(!storedState) return res.redirect(`${process.env.FRONTEND_URL}/login?error=invalid_state`);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  try {
    // Apple sends user name only on first sign-in
    const appleUser = userJson ? JSON.parse(userJson) : {};
    const name = appleUser.name ? `${appleUser.name.firstName || ''} ${appleUser.name.lastName || ''}`.trim() : '';

    // Decode the id_token to get email (Apple sends email only on first sign-in too)
    const idToken = req.body.id_token;
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());

    const session = await findOrCreateOAuthUser({
      provider: 'apple',
      providerId: payload.sub,
      email: payload.email,
      name: name || payload.email?.split('@')[0] || 'Apple User',
      emailVerified: payload.email_verified
    });

    res.redirect(`${process.env.FRONTEND_URL}/lunax.html?session=${session.token}&welcome=${session.isNew ? '1' : '0'}`);
  } catch(err) {
    console.error('Apple OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=apple_failed`);
  }
});

// ── MICROSOFT OAUTH ───────────────────────────────────────
// Setup: portal.azure.com → App registrations → New registration
// Add redirect URI: https://YOUR_RAILWAY_URL/auth/microsoft/callback
// Set env vars: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID

router.get('/microsoft', (req, res) => {
  if(!process.env.MICROSOFT_CLIENT_ID) {
    return res.redirect(`${process.env.FRONTEND_URL}/login?error=microsoft_not_configured`);
  }
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)')
    .run(state, 'microsoft', Date.now());

  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/microsoft/callback`,
    response_type: 'code',
    scope: 'openid email profile User.Read',
    state,
    prompt: 'select_account'
  });
  res.redirect(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`);
});

router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if(error || !code) return res.redirect(`${process.env.FRONTEND_URL}/login?error=microsoft_denied`);

  const storedState = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, 'microsoft');
  if(!storedState) return res.redirect(`${process.env.FRONTEND_URL}/login?error=invalid_state`);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: `${process.env.BACKEND_URL}/auth/microsoft/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if(!tokens.access_token) throw new Error('No access token');

    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json();

    const session = await findOrCreateOAuthUser({
      provider: 'microsoft',
      providerId: profile.id,
      email: profile.mail || profile.userPrincipalName,
      name: profile.displayName,
      emailVerified: true
    });

    res.redirect(`${process.env.FRONTEND_URL}/lunax.html?session=${session.token}&welcome=${session.isNew ? '1' : '0'}`);
  } catch(err) {
    console.error('Microsoft OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=microsoft_failed`);
  }
});

// ── META OAUTH (existing) ─────────────────────────────────
router.get('/meta', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)')
    .run(state, 'meta', Date.now());

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/meta/callback`,
    scope: 'email,public_profile,instagram_basic,instagram_content_publish,pages_manage_posts,pages_show_list',
    state,
    response_type: 'code'
  });
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params}`);
});

router.get('/meta/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if(error || !code) return res.redirect(`${process.env.FRONTEND_URL}/login?error=meta_denied`);

  try {
    const tokenRes = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.BACKEND_URL+'/auth/meta/callback')}&client_secret=${process.env.META_APP_SECRET}&code=${code}`
    );
    const tokens = await tokenRes.json();
    if(!tokens.access_token) throw new Error('No access token from Meta');

    // Get long-lived token
    const llRes = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokens.access_token}`
    );
    const llTokens = await llRes.json();
    const longToken = llTokens.access_token || tokens.access_token;

    const profileRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${longToken}`);
    const profile = await profileRes.json();

    const session = await findOrCreateOAuthUser({
      provider: 'meta',
      providerId: profile.id,
      email: profile.email,
      name: profile.name,
      emailVerified: true,
      accessToken: longToken
    });

    res.redirect(`${process.env.FRONTEND_URL}/lunax.html?session=${session.token}&welcome=${session.isNew ? '1' : '0'}`);
  } catch(err) {
    console.error('Meta OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=meta_failed`);
  }
});

// ── SHARED: find or create OAuth user ────────────────────
async function findOrCreateOAuthUser({ provider, providerId, email, name, avatar, emailVerified, accessToken }) {
  const { createSession, sanitizeUser } = require('./auth');

  // Check if this OAuth account already linked
  let user = db.prepare('SELECT u.* FROM users u JOIN oauth_accounts oa ON u.id = oa.user_id WHERE oa.provider = ? AND oa.provider_id = ?').get(provider, providerId);

  // Check if email already has an account
  if(!user && email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  }

  const isNew = !user;

  if(!user) {
    // Create new user
    const userId = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, email_verified, avatar_url, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, ?, ?)
    `).run(userId, (email || '').toLowerCase(), name || 'User', emailVerified ? 1 : 0, avatar || null, now, now);

    // Beta or trial subscription
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL').get().count;
    const isBeta = totalUsers <= 100;
    if(isBeta) {
      db.prepare('INSERT INTO subscriptions (user_id, plan, status, is_beta, beta_user_number, created_at) VALUES (?, ?, ?, 1, ?, ?)')
        .run(userId, 'pro', 'active', totalUsers, now);
    } else {
      db.prepare('INSERT INTO subscriptions (user_id, plan, status, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, 'trial', 'active', now + 14 * 24 * 60 * 60 * 1000, now);
    }

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    // Send welcome email
    if(email) {
      sendEmail({
        to: email,
        subject: isBeta ? `Welcome to Luna X Beta! 🎉` : 'Welcome to Luna X!',
        html: `<h2>Welcome, ${name}!</h2><p>Your Luna X account is ready. ${isBeta ? 'You have free Pro access as a beta user!' : 'Your 14-day free trial is active.'}</p><a href="${process.env.FRONTEND_URL}/lunax.html" style="display:inline-block;padding:12px 24px;background:#7c6dfa;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open Luna X →</a>`
      }).catch(() => {});
    }
  }

  // Link OAuth account (upsert)
  db.prepare(`
    INSERT INTO oauth_accounts (user_id, provider, provider_id, access_token, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_id) DO UPDATE SET access_token = excluded.access_token, updated_at = excluded.updated_at
  `).run(user.id, provider, providerId, accessToken || null, Date.now());

  const token = createSession(user.id);
return { token, isNew };
}

// ── ADD OAUTH TABLES TO SCHEMA ────────────────────────────
// Add this to db/database.js schema:
// CREATE TABLE IF NOT EXISTS oauth_accounts (
//   id          INTEGER PRIMARY KEY AUTOINCREMENT,
//   user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//   provider    TEXT NOT NULL,
//   provider_id TEXT NOT NULL,
//   access_token TEXT,
//   updated_at  INTEGER,
//   UNIQUE(provider, provider_id)
// );
// CREATE TABLE IF NOT EXISTS oauth_states (
//   state      TEXT PRIMARY KEY,
//   provider   TEXT NOT NULL,
//   created_at INTEGER NOT NULL
// );

module.exports = router;
