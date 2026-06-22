const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db/database');
const { sendEmail } = require('./email');

function createSession(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return jwt.sign(
    { id: userId, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ── GOOGLE OAUTH ──────────────────────────────────────────
router.get('/google', (req, res) => {
  if(!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=google_not_configured`);
  }
  const isNative = req.query.redirect === 'native';
  const stateBase = crypto.randomBytes(16).toString('hex');
  const state = isNative ? `${stateBase}:native` : stateBase;

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

  const isNative = state && state.endsWith(':native');
  const cleanState = isNative ? state.slice(0, -7) : state;

  const storedState = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, 'google');
  if(!storedState) return res.redirect(`${process.env.FRONTEND_URL}/login?error=invalid_state`);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  try {
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

    if(isNative) {
      return res.redirect(`lunax://auth?token=${session.token}`);
    }
    res.redirect(`${process.env.FRONTEND_URL}/lunax.html?session=${session.token}&welcome=${session.isNew ? '1' : '0'}`);
  } catch(err) {
    console.error('Google OAuth error:', err);
    if(isNative) return res.redirect(`lunax://auth?error=google_failed`);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=google_failed`);
  }
});

// ── APPLE OAUTH ───────────────────────────────────────────
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
    const appleUser = userJson ? JSON.parse(userJson) : {};
    const name = appleUser.name ? `${appleUser.name.firstName || ''} ${appleUser.name.lastName || ''}`.trim() : '';
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

// ── META OAUTH (Facebook + Instagram) ────────────────────
//
// Valid Meta scopes as of Graph API v20+:
//   - email, public_profile                     → basic user info
//   - pages_show_list                           → list pages
//   - pages_read_engagement                     → read page posts/engagement
//   - pages_manage_posts                        → publish to pages
//   - pages_manage_metadata                     → manage page settings
//   - instagram_basic                           → read IG profile
//   - instagram_content_publish                 → publish to IG
//   - instagram_manage_comments                 → read/reply to IG comments
//   - business_management                       → access business assets
//
// REMOVED (no longer valid):
//   - instagram_manage_insights  → replaced by instagram_basic + pages_read_engagement
//   - publish_video              → removed; video publishing uses pages_manage_posts
//
router.get('/meta', (req, res) => {
  const isNative = req.query.redirect === 'native';
  const userToken = req.query.token || null; // JWT from logged-in native user

  // Encode isNative + userToken into state so callback can retrieve them
  const stateBase = crypto.randomBytes(16).toString('hex');
  const stateSuffix = isNative ? `:native${userToken ? `:${userToken}` : ''}` : '';
  const state = `${stateBase}${stateSuffix}`;

  db.prepare('INSERT OR REPLACE INTO oauth_states (state, provider, created_at) VALUES (?, ?, ?)')
    .run(state, 'meta', Date.now());

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: `${process.env.BACKEND_URL}/auth/meta/callback`,
    scope: [
      'email',
      'public_profile',
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'pages_manage_metadata',
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_comments',
      'business_management'
    ].join(','),
    state,
    response_type: 'code'
  });
  res.redirect(`https://www.facebook.com/v20.0/dialog/oauth?${params}`);
});

router.get('/meta/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // Parse state to extract native flag and user token
  let isNative = false;
  let userToken = null;
  let cleanState = state;
  if (state && state.includes(':native')) {
    isNative = true;
    const parts = state.split(':native');
    cleanState = parts[0];
    const afterNative = parts[1]; // may be `:JWT...` or empty
    if (afterNative && afterNative.startsWith(':')) {
      userToken = afterNative.slice(1);
    }
  }

  if (error || !code) {
    if (isNative) return res.redirect(`lunax://meta?error=meta_denied`);
    return res.redirect(`${process.env.FRONTEND_URL}/login?error=meta_denied`);
  }

  try {
    // Exchange code for short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.BACKEND_URL + '/auth/meta/callback')}&client_secret=${process.env.META_APP_SECRET}&code=${code}`
    );
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token from Meta');

    // Exchange for long-lived token
    const llRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokens.access_token}`
    );
    const llTokens = await llRes.json();
    const longToken = llTokens.access_token || tokens.access_token;

    // Get user profile
    const profileRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${longToken}`);
    const profile = await profileRes.json();

    // Auto-fetch pages and linked Instagram accounts
    let autoPageId = null, autoPageToken = null, autoPageName = null;
    let autoIgId = null, autoIgName = null;
    try {
      const pagesRes = await fetch(
        `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,name,username}&access_token=${longToken}`
      );
      const pagesData = await pagesRes.json();
      if (pagesData.data && pagesData.data.length > 0) {
        const firstPage = pagesData.data[0];
        autoPageId = firstPage.id;
        autoPageToken = firstPage.access_token;
        autoPageName = firstPage.name;
        if (firstPage.instagram_business_account) {
          autoIgId = firstPage.instagram_business_account.id;
          autoIgName = firstPage.instagram_business_account.name
            || firstPage.instagram_business_account.username
            || null;
        }
      }
    } catch(e) {
      console.error('Meta OAuth: could not auto-fetch pages:', e.message);
    }

    // Determine existing user — from native JWT token first, then state JWT, then OAuth lookup
    let existingUserId = null;

    if (userToken) {
      try {
        const decoded = jwt.verify(userToken, process.env.JWT_SECRET);
        existingUserId = decoded.id;
      } catch(e) { /* invalid token, fall through */ }
    }

    if (!existingUserId && cleanState) {
      try {
        const decoded = jwt.verify(cleanState, process.env.JWT_SECRET);
        existingUserId = decoded.id;
      } catch(e) { /* not a JWT state, fall through */ }
    }

    let session;
    if (existingUserId) {
      // Link Meta to the existing logged-in account
      db.prepare(`UPDATE users SET
        meta_access_token = ?,
        meta_page_id = ?,
        meta_page_name = ?,
        meta_page_token = ?,
        meta_ig_id = ?,
        meta_ig_name = ?,
        updated_at = ?
        WHERE id = ?`)
        .run(longToken, autoPageId, autoPageName, autoPageToken, autoIgId, autoIgName, Date.now(), existingUserId);
      db.prepare(`
        INSERT INTO oauth_accounts (user_id, provider, provider_id, access_token, updated_at)
        VALUES (?, 'meta', ?, ?, ?)
        ON CONFLICT(provider, provider_id) DO UPDATE SET
          access_token = excluded.access_token,
          updated_at = excluded.updated_at,
          user_id = excluded.user_id
      `).run(existingUserId, profile.id, longToken, Date.now());
      const sessionToken = createSession(existingUserId);
      session = { token: sessionToken, isNew: false };
    } else {
      // New user or unrecognized state
      session = await findOrCreateOAuthUser({
        provider: 'meta',
        providerId: profile.id,
        email: profile.email,
        name: profile.name,
        emailVerified: true,
        accessToken: longToken
      });
    }

    // Build redirect with page/IG names so the native app can display them
    const fbName = encodeURIComponent(autoPageName || profile.name || 'Facebook');
    const igName = encodeURIComponent(autoIgName || '');

    if (isNative) {
      return res.redirect(
        `lunax://meta?token=${session.token}&fb_name=${fbName}&ig_name=${igName}&connected=1`
      );
    }
    res.redirect(`${process.env.FRONTEND_URL}/lunax.html?session=${session.token}&welcome=${session.isNew ? '1' : '0'}`);
  } catch(err) {
    console.error('Meta OAuth error:', err);
    if (isNative) return res.redirect(`lunax://meta?error=meta_failed`);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=meta_failed`);
  }
});

// ── SHARED: find or create OAuth user ────────────────────
async function findOrCreateOAuthUser({ provider, providerId, email, name, avatar, emailVerified, accessToken }) {
  let user = db.prepare('SELECT u.* FROM users u JOIN oauth_accounts oa ON u.id = oa.user_id WHERE oa.provider = ? AND oa.provider_id = ?').get(provider, providerId);

  if(!user && email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  }

  const isNew = !user;

  if(!user) {
    const userId = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, email_verified, avatar_url, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, ?, ?, ?)
    `).run(userId, (email || '').toLowerCase(), name || 'User', emailVerified ? 1 : 0, avatar || null, now, now);

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

    if(email) {
      sendEmail({
        to: email,
        subject: isBeta ? `Welcome to Luna X Beta! 🎉` : 'Welcome to Luna X!',
        html: `<h2>Welcome, ${name}!</h2><p>Your Luna X account is ready. ${isBeta ? 'You have free Pro access as a beta user!' : 'Your 14-day free trial is active.'}</p><a href="${process.env.FRONTEND_URL}/lunax.html" style="display:inline-block;padding:12px 24px;background:#7c6dfa;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open Luna X →</a>`
      }).catch(() => {});
    }
  }

  db.prepare(`
    INSERT INTO oauth_accounts (user_id, provider, provider_id, access_token, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_id) DO UPDATE SET access_token = excluded.access_token, updated_at = excluded.updated_at
  `).run(user.id, provider, providerId, accessToken || null, Date.now());

  const token = createSession(user.id);
  return { token, isNew };
}

module.exports = router;
