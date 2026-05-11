const express = require('express');
const fetch = require('node-fetch');
const { requireAuth } = require('./auth');
const db = require('../db/database');

const router = express.Router();
const API_BASE = 'https://graph.facebook.com/v20.0';

// ── Humanize Meta error codes into friendly messages ─────────────────────────
function humanizeMetaError(code, subcode, rawMessage) {
  // Token expired or invalid
  if (code === 190 || code === 102 || code === 463 || code === 467) {
    const err = new Error('Your Facebook connection has expired. Please reconnect in Settings.');
    err.code = 'TOKEN_EXPIRED';
    return err;
  }
  // Permission not granted
  if (code === 10 || code === 200 || code === 230) {
    const err = new Error('Luna X doesn\'t have permission to do that on Facebook yet. This will be available after Meta approves our app.');
    err.code = 'PERMISSION_DENIED';
    return err;
  }
  // Rate limited
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    const err = new Error('Facebook is temporarily limiting requests. Please try again in a few minutes.');
    err.code = 'RATE_LIMITED';
    return err;
  }
  // Account disabled or restricted
  if (code === 368 || code === 1000) {
    const err = new Error('Your Facebook account or page has a restriction. Check your Page Quality in Meta Business Suite.');
    err.code = 'ACCOUNT_RESTRICTED';
    return err;
  }
  // Media errors
  if (code === 9007 || code === 2207026) {
    const err = new Error('The video or image couldn\'t be processed by Instagram. Try a different format or size.');
    err.code = 'MEDIA_ERROR';
    return err;
  }
  // Generic fallback — strip raw technical details
  const clean = (rawMessage || '')
    .replace(/\(#\d+\)/g, '')
    .replace(/\(code \d+\)/g, '')
    .replace(/Meta API: /g, '')
    .trim();
  const err = new Error(clean || 'Something went wrong with Facebook. Please try again.');
  err.code = 'META_ERROR';
  return err;
}

// Helper — look up meta_access_token from DB for current user
function getUserMetaToken(userId) {
  const user = db.prepare('SELECT meta_access_token FROM users WHERE id = ?').get(userId);
  return user?.meta_access_token || null;
}

// Helper — make authenticated Meta API call
async function metaGet(path, token, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) {
    throw humanizeMetaError(data.error.code, data.error.error_subcode, data.error.message);
  }
  return data;
}

async function metaPost(path, token, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const data = await res.json();
  if (data.error) {
    throw humanizeMetaError(data.error.code, data.error.error_subcode, data.error.message);
  }
  return data;
}

// ── Error response helper — sends token_expired flag so frontend can prompt reconnect
function handleMetaError(e, res) {
  if (e.code === 'TOKEN_EXPIRED') {
    return res.status(401).json({
      error: e.message,
      code: 'TOKEN_EXPIRED',
      action: 'reconnect'  // frontend watches for this
    });
  }
  return res.status(400).json({ error: e.message, code: e.code || 'META_ERROR' });
}

// ── GET /meta/accounts ──
router.get('/accounts', requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM user_accounts WHERE user_id = ?').all(req.user.id);
  res.json({ accounts });
});

// ── GET /meta/pages ──
router.get('/pages', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaGet('/me/accounts', token, {
      fields: 'id,name,access_token,instagram_business_account{id,name,username}'
    });
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/save-selection ──
// Saves the user's chosen IG account + FB page to the DB so it persists across sessions
router.post('/save-selection', requireAuth, async (req, res) => {
  try {
    const { igId, igName, pageId, pageName, pageToken } = req.body;
    db.prepare(`
      UPDATE users SET
        meta_ig_id = ?,
        meta_ig_name = ?,
        meta_page_id = ?,
        meta_page_name = ?,
        meta_page_token = ?
      WHERE id = ?
    `).run(igId || null, igName || null, pageId || null, pageName || null, pageToken || null, req.user.id);
    res.json({ success: true });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── GET /meta/pages/:pageId/leadgen_forms ──
router.get('/pages/:pageId/leadgen_forms', requireAuth, async (req, res) => {
  try {
    const pageAcct = db.prepare('SELECT * FROM user_accounts WHERE user_id = ? AND account_id = ?')
      .get(req.user.id, req.params.pageId);
    const token = pageAcct?.access_token || getUserMetaToken(req.user.id);
    const data = await metaGet(`/${req.params.pageId}/leadgen_forms`, token, {
      fields: 'id,name,status,leads_count,questions,created_time',
      limit: 50,
    });
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/campaigns ──
router.get('/ads/campaigns', requireAuth, async (req, res) => {
  try {
    const { accountId, since, until } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const fields = 'id,name,status,objective,insights{spend,reach,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency}';
    const timeRange = since ? JSON.stringify({ since, until }) : undefined;
    const data = await metaGet(`/${accountId}/campaigns`, token, {
      fields, limit: 50,
      ...(timeRange && { time_range: timeRange }),
    });
    db.prepare(`
      INSERT INTO ad_cache (user_id, account_id, data_type, data, fetched_at)
      VALUES (?, ?, 'campaigns', ?, unixepoch())
      ON CONFLICT(user_id, account_id, data_type) DO UPDATE SET data = excluded.data, fetched_at = unixepoch()
    `).run(req.user.id, accountId, JSON.stringify(data));
    res.json(data);
  } catch (e) {
    const cached = db.prepare('SELECT data FROM ad_cache WHERE user_id = ? AND account_id = ? AND data_type = ?')
      .get(req.user.id, req.query.accountId, 'campaigns');
    if (cached) return res.json({ ...JSON.parse(cached.data), _cached: true });
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/adsets ──
router.get('/ads/adsets', requireAuth, async (req, res) => {
  try {
    const { accountId, since, until } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const fields = 'id,name,status,daily_budget,lifetime_budget,insights{spend,reach,impressions,clicks,ctr,cpc,cpm,frequency}';
    const data = await metaGet(`/${accountId}/adsets`, token, {
      fields, limit: 50,
      ...(since && { time_range: JSON.stringify({ since, until }) }),
    });
    db.prepare(`INSERT INTO ad_cache (user_id, account_id, data_type, data) VALUES (?, ?, 'adsets', ?) ON CONFLICT(user_id, account_id, data_type) DO UPDATE SET data = excluded.data, fetched_at = unixepoch()`).run(req.user.id, accountId, JSON.stringify(data));
    res.json(data);
  } catch (e) {
    const cached = db.prepare('SELECT data FROM ad_cache WHERE user_id = ? AND account_id = ? AND data_type = ?').get(req.user.id, req.query.accountId, 'adsets');
    if (cached) return res.json({ ...JSON.parse(cached.data), _cached: true });
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/creatives ──
router.get('/ads/creatives', requireAuth, async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const fields = 'id,name,status,creative{id,name,thumbnail_url,image_url},insights{spend,reach,impressions,clicks,ctr,cpc}';
    const data = await metaGet(`/${accountId}/ads`, token, { fields, limit: 30 });
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/insights ──
router.get('/ads/insights', requireAuth, async (req, res) => {
  try {
    const { accountId, since, until } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaGet(`/${accountId}/insights`, token, {
      fields: 'spend,reach,impressions,clicks,ctr,cpc',
      time_increment: 1,
      since, until,
    });
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/ads/adsets/create ──
router.post('/ads/adsets/create', requireAuth, async (req, res) => {
  try {
    const { accountId, adSetConfig } = req.body;
    if (!accountId || !adSetConfig) return res.status(400).json({ error: 'accountId and adSetConfig required' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaPost(`/${accountId}/adsets`, token, adSetConfig);
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/ads/creatives/create ──
router.post('/ads/creatives/create', requireAuth, async (req, res) => {
  try {
    const { accountId, creativeConfig } = req.body;
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaPost(`/${accountId}/adcreatives`, token, creativeConfig);
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/ads/ads/create ──
router.post('/ads/ads/create', requireAuth, async (req, res) => {
  try {
    const { accountId, adConfig } = req.body;
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaPost(`/${accountId}/ads`, token, adConfig);
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/post ──
router.post('/post', requireAuth, async (req, res) => {
  try {
    const { igId, pageId, caption, captionFacebook, hashtags, mediaUrl, mediaType, scheduledTime, platforms } = req.body;
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });

    const hashtagStr = (hashtags||[]).map(h => '#' + h).join(' ');
    const captionIG = caption + (hashtagStr ? '\n\n' + hashtagStr : '');
    const captionFB = (captionFacebook || caption) + (hashtagStr ? '\n\n' + hashtagStr : '');
    const fullCaption = captionIG;

    const pageAcct = db.prepare('SELECT * FROM user_accounts WHERE user_id = ? AND account_id = ?').get(req.user.id, pageId);
    const pageToken = pageAcct?.access_token || token;
    const isFuture = scheduledTime && new Date(scheduledTime).getTime() > Date.now() + 60000;
    const unixTime = scheduledTime ? Math.floor(new Date(scheduledTime).getTime() / 1000) : null;
    const results = [];

    if ((platforms || []).includes('Instagram') && igId) {
      let creationId = null;
      if (mediaUrl && mediaType === 'video') {
        const r = await metaPost(`/${igId}/media`, token, {
          media_type: 'REELS', video_url: mediaUrl, caption: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime, published: false }),
        });
        creationId = r.id;
        if (creationId && !isFuture) {
          let ready = false;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await metaGet(`/${creationId}`, token, { fields: 'status_code' });
            if (s.status_code === 'FINISHED') { ready = true; break; }
            if (s.status_code === 'ERROR') throw new Error('Video processing failed');
          }
          if (!ready) throw new Error('Video processing timed out');
        }
      } else if (mediaUrl && mediaType === 'image') {
        const r = await metaPost(`/${igId}/media`, token, {
          image_url: mediaUrl, caption: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime, published: false }),
        });
        creationId = r.id;
      }
      if (creationId) {
        await metaPost(`/${igId}/media_publish`, token, { creation_id: creationId });
        results.push('Instagram');
      }
    }

    if ((platforms || []).includes('Facebook') && pageId) {
      if (mediaUrl && mediaType === 'video') {
        await metaPost(`/${pageId}/videos`, pageToken, {
          file_url: mediaUrl, description: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime }),
        });
      } else if (mediaUrl && mediaType === 'image') {
        await metaPost(`/${pageId}/photos`, pageToken, {
          url: mediaUrl, caption: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime, published: false }),
        });
      } else {
        await metaPost(`/${pageId}/feed`, pageToken, {
          message: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime, published: false }),
        });
      }
      results.push('Facebook');
    }

    res.json({ success: true, posted: results });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// Temporary endpoint for Meta App Review API test call (pages_read_user_content)
router.get('/page-feed-test', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT meta_page_id, meta_page_token, meta_access_token FROM users WHERE id = ?').get(req.user.id);
    if (!user?.meta_page_id) return res.status(400).json({ error: 'No page connected. Connect Facebook in Settings first.' });
    const token = user.meta_page_token || user.meta_access_token;
    const data = await metaGet(`/${user.meta_page_id}/feed`, token, { limit: 1 });
    res.json({ success: true, page_id: user.meta_page_id, data });
  } catch(e) {
    handleMetaError(e, res);
  }
});

module.exports = router;
