const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/database');
const { requireAuth } = require('./auth');
const { _resolveOwnerId, _upsertSocialAccount } = require('./oauth');

// This is Meta's separate "Instagram API with Instagram Login" product —
// distinct from the Facebook-Login-based flow in oauth.js's /meta routes.
// It authenticates directly against an Instagram professional (Business or
// Creator) account with no Facebook Page or Business Manager required at
// all, which is exactly what's needed for an account that was never linked
// to a Page in the first place. Uses its own app credentials (IG_APP_ID /
// IG_APP_SECRET — the same IG_APP_SECRET already referenced by the
// data-deletion webhook in server.js, since Meta requires that webhook for
// any app using this specific login product).
const CLIENT_ID = process.env.IG_APP_ID;
const CLIENT_SECRET = process.env.IG_APP_SECRET;
const REDIRECT_URI = 'https://lunax-server-production.up.railway.app/oauth/instagram-direct/callback';
const crypto = require('crypto');

// ── STATE HELPERS — HMAC-signed to prevent CSRF (same pattern as tiktok.js/youtube.js/linkedin.js) ──
function createState(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyState(state) {
  const lastDot = state.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = state.slice(0, lastDot);
  const sig = state.slice(lastDot + 1);
  const expectedSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() - data.ts > 10 * 60 * 1000) return null;
    return data;
  } catch (e) { return null; }
}

// ── DB MIGRATION — add ig_direct columns if not present ──────────────────
// scheduler.js and analytics.js already reference user.ig_direct_access_token
// and user.ig_direct_user_id (the "Path A — Instagram-direct" publish/insights
// logic was already built) — this is the migration that was missing to
// actually let anything populate those columns.
const igDirectCols = [
  'ig_direct_access_token TEXT',
  'ig_direct_user_id TEXT',
  'ig_direct_username TEXT',
  'ig_direct_name TEXT',
  'ig_direct_token_expires_at INTEGER',
];
for (const col of igDirectCols) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch (e) {}
}

// ── STEP 1: Redirect user to Instagram's own OAuth (no Facebook Page involved) ──
router.get('/instagram-direct', (req, res) => {
  let userId;
  const qToken = req.query.token;
  if (qToken) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(qToken, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch (e) {
      return res.redirect('https://lunaxmedia.com?instagram=error');
    }
  } else {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.redirect('https://lunaxmedia.com?instagram=error');
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      userId = decoded.id;
    } catch (e) {
      return res.redirect('https://lunaxmedia.com?instagram=error');
    }
  }

  const state = createState(userId);
  // Minimal scopes — just what the existing publish/insights logic in
  // scheduler.js and analytics.js actually uses. Not requesting
  // comments/messaging scopes here since nothing downstream consumes them
  // for this login path yet (the Inbox feature reads from the Facebook-Page
  // based meta_* fields, not ig_direct_*).
  const scopes = ['instagram_business_basic', 'instagram_business_content_publish'].join(',');

  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// ── STEP 2: Instagram redirects back with a code ──────────────────────────
router.get('/instagram-direct/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Instagram-direct OAuth error:', error);
    return res.redirect('https://lunaxmedia.com?instagram=error');
  }

  let userId;
  try {
    const decoded = verifyState(state);
    if (!decoded) return res.redirect('https://lunaxmedia.com?instagram=error');
    userId = decoded.userId;
  } catch (e) {
    return res.redirect('https://lunaxmedia.com?instagram=error');
  }

  try {
    // Step A: exchange code for a short-lived token (~1 hour)
    const shortRes = await axios.post('https://api.instagram.com/oauth/access_token', new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const { access_token: shortToken, user_id: igUserId } = shortRes.data;

    // Step B: exchange short-lived for a long-lived token (~60 days,
    // refreshable) — Instagram's own exchange endpoint, not a standard
    // OAuth refresh_token grant.
    const longRes = await axios.get('https://graph.instagram.com/access_token', {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: CLIENT_SECRET,
        access_token: shortToken,
      }
    });
    const { access_token: longToken, expires_in } = longRes.data;
    const expiresAt = Date.now() + (expires_in * 1000);

    // Step C: fetch the account's own profile
    const profileRes = await axios.get('https://graph.instagram.com/me', {
      params: { fields: 'id,username,name,account_type', access_token: longToken }
    });
    const profile = profileRes.data || {};
    const username = profile.username || '';
    const name = profile.name || profile.username || 'Instagram Account';

    console.log(`[Instagram-direct] Connected: ${name} (@${username})`);

    const ownerId = _resolveOwnerId(userId);

    // Save to DB — same singular-column pattern the other platforms use,
    // so scheduler.js's existing "Path A" publish logic and analytics.js's
    // insights fetch work immediately with zero changes to either file.
    db.prepare(`
      UPDATE users SET
        ig_direct_access_token = ?,
        ig_direct_user_id = ?,
        ig_direct_username = ?,
        ig_direct_name = ?,
        ig_direct_token_expires_at = ?
      WHERE id = ?
    `).run(longToken, String(igUserId), username, name, expiresAt, ownerId);

    // Multi-account: a distinct platform key from 'instagram' (the
    // Facebook-Page-linked flow) — an account can be connected via either
    // or both paths without collision.
    _upsertSocialAccount({
      ownerId, platform: 'instagram-direct',
      platformAccountId: String(igUserId),
      accountName: name,
      accountHandle: username,
      accessToken: longToken,
      tokenExpiresAt: expiresAt,
      isDefault: true,
    });

    res.redirect('https://lunaxmedia.com?instagram=connected');
  } catch (err) {
    console.error('Instagram-direct callback error:', err.response?.data || err.message);
    res.redirect('https://lunaxmedia.com?instagram=error');
  }
});

// ── DISCONNECT ──────────────────────────────────────────────────────────
router.post('/instagram-direct/disconnect', requireAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users SET
        ig_direct_access_token = NULL,
        ig_direct_user_id = NULL,
        ig_direct_username = NULL,
        ig_direct_name = NULL,
        ig_direct_token_expires_at = NULL
      WHERE id = ?
    `).run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Instagram-direct disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ── REFRESH — Instagram's own long-lived token refresh, not a standard OAuth refresh_token grant ──
async function refreshIgDirectToken(userId, currentToken) {
  try {
    const res = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: { grant_type: 'ig_refresh_token', access_token: currentToken }
    });
    const { access_token, expires_in } = res.data;
    const expiresAt = Date.now() + (expires_in * 1000);
    db.prepare(`UPDATE users SET ig_direct_access_token = ?, ig_direct_token_expires_at = ? WHERE id = ?`)
      .run(access_token, expiresAt, userId);
    return access_token;
  } catch (err) {
    console.error('Instagram-direct token refresh failed:', err.response?.data || err.message);
    return null;
  }
}

// Per-account variant for multi-account mode, same pattern as the other
// three platforms' *_ForAccount refresh functions.
async function refreshIgDirectTokenForAccount(accountId, currentToken) {
  try {
    const res = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: { grant_type: 'ig_refresh_token', access_token: currentToken }
    });
    const { access_token, expires_in } = res.data;
    const expiresAt = Date.now() + (expires_in * 1000);
    db.prepare(`UPDATE social_accounts SET access_token = ?, token_expires_at = ? WHERE id = ?`)
      .run(access_token, expiresAt, accountId);
    return access_token;
  } catch (err) {
    console.error('Instagram-direct token refresh (multi-account) failed:', err.response?.data || err.message);
    return null;
  }
}

module.exports = router;
module.exports.refreshIgDirectToken = refreshIgDirectToken;
module.exports.refreshIgDirectTokenForAccount = refreshIgDirectTokenForAccount;
