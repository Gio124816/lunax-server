const express = require('express');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

const router = express.Router();

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

// Scopes needed for Luna X
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_show_list',
  'ads_read',
  'ads_management',
  'read_insights',
  'business_management',
  'leads_retrieval',
].join(',');

// ── STEP 1: Redirect user to Meta login ──
router.get('/meta', (req, res) => {
  const state = uuidv4();
  req.session.oauthState = state;
  const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=${state}&response_type=code`;
  res.redirect(url);
});

// ── STEP 2: Meta redirects back here with code ──
router.get('/meta/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(error)}`);
  if (state !== req.session.oauthState) return res.redirect(`${FRONTEND_URL}?auth_error=invalid_state`);

  try {
    // Exchange code for short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&client_secret=${META_APP_SECRET}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
    );
    const longData = await longRes.json();
    const accessToken = longData.access_token || tokenData.access_token;
    const expiresIn = longData.expires_in || 3600;

    // Get user info
    const meRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name,email&access_token=${accessToken}`);
    const meData = await meRes.json();

    // Upsert user in DB
    const userId = uuidv4();
    const existing = db.prepare('SELECT id FROM users WHERE meta_user_id = ?').get(meData.id);

    if (existing) {
      db.prepare('UPDATE users SET meta_access_token = ?, meta_token_expires = ?, name = ?, last_seen = unixepoch() WHERE meta_user_id = ?')
        .run(accessToken, Math.floor(Date.now()/1000) + expiresIn, meData.name, meData.id);
    } else {
      db.prepare('INSERT INTO users (id, meta_user_id, name, email, meta_access_token, meta_token_expires) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, meData.id, meData.name, meData.email || '', accessToken, Math.floor(Date.now()/1000) + expiresIn);
    }

    const user = db.prepare('SELECT * FROM users WHERE meta_user_id = ?').get(meData.id);

    // Fetch and cache their pages + Instagram accounts
    await syncUserAccounts(user);

    // Return session token to frontend
    res.redirect(`${FRONTEND_URL}?session_token=${user.id}&user_name=${encodeURIComponent(user.name)}`);

  } catch (e) {
    console.error('Auth error:', e);
    res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(e.message)}`);
  }
});

// ── Sync user's pages and Instagram accounts ──
async function syncUserAccounts(user) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,name,username}&access_token=${user.meta_access_token}`
    );
    const data = await res.json();
    if (!data.data) return;

    for (const page of data.data) {
      const igId = page.instagram_business_account?.id || null;
      db.prepare(`
        INSERT INTO user_accounts (id, user_id, type, account_id, account_name, access_token, instagram_id)
        VALUES (?, ?, 'page', ?, ?, ?, ?)
        ON CONFLICT(user_id, account_id) DO UPDATE SET
          account_name = excluded.account_name,
          access_token = excluded.access_token,
          instagram_id = excluded.instagram_id
      `).run(uuidv4(), user.id, page.id, page.name, page.access_token, igId);
    }

    // Fetch ad accounts
    const adRes = await fetch(
      `https://graph.facebook.com/v20.0/me/adaccounts?fields=id,name,account_status&access_token=${user.meta_access_token}`
    );
    const adData = await adRes.json();
    if (adData.data) {
      for (const acct of adData.data) {
        db.prepare(`
          INSERT INTO user_accounts (id, user_id, type, account_id, account_name)
          VALUES (?, ?, 'adaccount', ?, ?)
          ON CONFLICT(user_id, account_id) DO UPDATE SET account_name = excluded.account_name
        `).run(uuidv4(), user.id, acct.id, acct.name);
      }
    }
  } catch (e) {
    console.error('Sync accounts error:', e.message);
  }
}

// ── Get current user info ──
router.get('/me', require('../middleware/auth').requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM user_accounts WHERE user_id = ?').all(req.user.id);
  res.json({
    id: req.user.id,
    name: req.user.name,
    accounts: accounts.map(a => ({
      type: a.type,
      accountId: a.account_id,
      name: a.account_name,
      instagramId: a.instagram_id,
    }))
  });
});

// ── Disconnect ──
router.post('/disconnect', require('../middleware/auth').requireAuth, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  db.prepare('DELETE FROM user_accounts WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

module.exports = router;
