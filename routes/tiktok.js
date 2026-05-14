const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/database');
const { requireAuth } = require('./auth');

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = 'https://lunax-server-production.up.railway.app/oauth/tiktok/callback';

// ── STEP 1: Redirect user to TikTok OAuth ──────────────
router.get('/tiktok', (req, res) => {
  // Token can come from query param (browser redirect) or Authorization header
  let userId;
  const qToken = req.query.token;
  if (qToken) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(qToken, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch(e) {
      return res.redirect('https://lunaxmedia.com?tiktok=error');
    }
  } else {
    // Fall back to requireAuth header
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.redirect('https://lunaxmedia.com?tiktok=error');
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      userId = decoded.id;
    } catch(e) {
      return res.redirect('https://lunaxmedia.com?tiktok=error');
    }
  }

  const state = Buffer.from(JSON.stringify({
    userId,
    ts: Date.now()
  })).toString('base64');

  const scopes = ['user.info.basic', 'video.upload'].join(',');

  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.searchParams.set('client_key', CLIENT_KEY);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// ── STEP 2: TikTok redirects back with code ────────────
router.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('TikTok OAuth error:', error);
    return res.redirect('https://lunaxmedia.com?tiktok=error');
  }

  let userId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    userId = decoded.userId;
  } catch (e) {
    return res.redirect('https://lunaxmedia.com?tiktok=error');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, refresh_token, open_id, expires_in } = tokenRes.data;

    // Fetch user info
    const userRes = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
      params: { fields: 'open_id,display_name,avatar_url' },
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const ttUser = userRes.data?.data?.user || {};
    const expiresAt = Date.now() + (expires_in * 1000);

    // Save to DB
    db.prepare(`
      UPDATE users SET
        tiktok_open_id = ?,
        tiktok_access_token = ?,
        tiktok_refresh_token = ?,
        tiktok_token_expires_at = ?,
        tiktok_display_name = ?,
        tiktok_avatar_url = ?
      WHERE id = ?
    `).run(
      open_id || ttUser.open_id,
      access_token,
      refresh_token || null,
      expiresAt,
      ttUser.display_name || '',
      ttUser.avatar_url || '',
      userId
    );

    res.redirect('https://lunaxmedia.com?tiktok=connected');
  } catch (err) {
    console.error('TikTok callback error:', err.response?.data || err.message);
    res.redirect('https://lunaxmedia.com?tiktok=error');
  }
});

// ── DISCONNECT TikTok ──────────────────────────────────
router.post('/tiktok/disconnect', requireAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users SET
        tiktok_open_id = NULL,
        tiktok_access_token = NULL,
        tiktok_refresh_token = NULL,
        tiktok_token_expires_at = NULL,
        tiktok_display_name = NULL,
        tiktok_avatar_url = NULL
      WHERE id = ?
    `).run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('TikTok disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ── REFRESH TOKEN ──────────────────────────────────────
async function refreshTikTokToken(userId, refreshToken) {
  try {
    const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, refresh_token, expires_in } = res.data;
    const expiresAt = Date.now() + (expires_in * 1000);

    db.prepare(`
      UPDATE users SET
        tiktok_access_token = ?,
        tiktok_refresh_token = ?,
        tiktok_token_expires_at = ?
      WHERE id = ?
    `).run(access_token, refresh_token || refreshToken, expiresAt, userId);

    return access_token;
  } catch (err) {
    console.error('TikTok token refresh failed:', err.response?.data || err.message);
    return null;
  }
}

// ── POST VIDEO TO TIKTOK ───────────────────────────────
// Called by scheduler when a post has tiktok=true
async function postToTikTok(post, user) {
  let accessToken = user.tiktok_access_token;

  if (!accessToken) throw new Error('No TikTok access token');

  // Refresh if within 1 hour of expiry
  if (user.tiktok_token_expires_at && Date.now() > user.tiktok_token_expires_at - 3600000) {
    if (user.tiktok_refresh_token) {
      accessToken = await refreshTikTokToken(user.id, user.tiktok_refresh_token);
      if (!accessToken) throw new Error('TikTok token refresh failed');
    }
  }

  const mediaUrl = post.media_url;
  if (!mediaUrl) throw new Error('TikTok post requires a video URL');

  // Initialize upload
  const initRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    post_info: {
      title: post.caption || '',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: mediaUrl,
    }
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    }
  });

  const publishId = initRes.data?.data?.publish_id;
  if (!publishId) throw new Error('TikTok did not return a publish_id');

  // Poll for status (up to 60 seconds)
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      publish_id: publishId
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      }
    });

    const status = statusRes.data?.data?.status;
    if (status === 'PUBLISH_COMPLETE') {
      return { success: true, publishId };
    }
    if (status === 'FAILED') {
      throw new Error(`TikTok publish failed: ${statusRes.data?.data?.fail_reason || 'unknown'}`);
    }
  }

  // Still processing — return optimistically
  return { success: true, publishId, pending: true };
}

module.exports = router;
module.exports.postToTikTok = postToTikTok;
module.exports.refreshTikTokToken = refreshTikTokToken;
