const express = require('express');
const fetch = require('node-fetch');
const { requireAuth } = require('./auth');
const db = require('../db/database');

const router = express.Router();
const API_BASE = 'https://graph.facebook.com/v20.0';

// Helper — make authenticated Meta API call using user's token
async function metaGet(path, token, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function metaPost(path, token, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message} (code ${data.error.code})`);
  return data;
}

// ── GET /meta/accounts ──
// Returns all pages + Instagram + ad accounts for this user
router.get('/accounts', requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM user_accounts WHERE user_id = ?').all(req.user.id);
  res.json({ accounts });
});

// — GET /meta/accounts —
router.get('/accounts', requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM user_accounts WHERE user_id = ?').all(req.user.id);
  res.json({ accounts });
});

// — GET /meta/pages —
router.get('/pages', requireAuth, async (req, res) => {
  try {
    const token = req.user.meta_access_token;
    if(!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaGet('/me/accounts', token, {
      fields: 'id,name,access_token,instagram_business_account{id,name,username}'
    });
    res.json(data);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// — GET /meta/pages/:pageId/leadgen_forms —

// ── GET /meta/pages/:pageId/leadgen_forms ──
// Pull real lead forms from a Facebook Page
router.get('/pages/:pageId/leadgen_forms', requireAuth, async (req, res) => {
  try {
    const pageAcct = db.prepare('SELECT * FROM user_accounts WHERE user_id = ? AND account_id = ?')
      .get(req.user.id, req.params.pageId);
    const token = pageAcct?.access_token || req.user.meta_access_token;
    const data = await metaGet(`/${req.params.pageId}/leadgen_forms`, token, {
      fields: 'id,name,status,leads_count,questions,created_time',
      limit: 50,
    });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /meta/ads/campaigns ──
// Pull campaigns for user's ad account
router.get('/ads/campaigns', requireAuth, async (req, res) => {
  try {
    const { accountId, since, until } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const fields = 'id,name,status,objective,insights{spend,reach,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency}';
    const timeRange = since ? JSON.stringify({ since, until }) : undefined;

    const data = await metaGet(`/${accountId}/campaigns`, req.user.meta_access_token, {
      fields,
      limit: 50,
      ...(timeRange && { time_range: timeRange }),
    });

    // Cache the result
    db.prepare(`
      INSERT INTO ad_cache (user_id, account_id, data_type, data, fetched_at)
      VALUES (?, ?, 'campaigns', ?, unixepoch())
      ON CONFLICT(user_id, account_id, data_type) DO UPDATE SET data = excluded.data, fetched_at = unixepoch()
    `).run(req.user.id, accountId, JSON.stringify(data));

    res.json(data);
  } catch (e) {
    // Return cached data if available
    const cached = db.prepare('SELECT data FROM ad_cache WHERE user_id = ? AND account_id = ? AND data_type = ?')
      .get(req.user.id, req.query.accountId, 'campaigns');
    if (cached) return res.json({ ...JSON.parse(cached.data), _cached: true });
    res.status(400).json({ error: e.message });
  }
});

// ── GET /meta/ads/adsets ──
router.get('/ads/adsets', requireAuth, async (req, res) => {
  try {
    const { accountId, since, until } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const fields = 'id,name,status,daily_budget,lifetime_budget,insights{spend,reach,impressions,clicks,ctr,cpc,cpm,frequency}';
    const data = await metaGet(`/${accountId}/adsets`, req.user.meta_access_token, {
      fields, limit: 50,
      ...(since && { time_range: JSON.stringify({ since, until }) }),
    });
    db.prepare(`INSERT INTO ad_cache (user_id, account_id, data_type, data) VALUES (?, ?, 'adsets', ?) ON CONFLICT(user_id, account_id, data_type) DO UPDATE SET data = excluded.data, fetched_at = unixepoch()`).run(req.user.id, accountId, JSON.stringify(data));
    res.json(data);
  } catch (e) {
    const cached = db.prepare('SELECT data FROM ad_cache WHERE user_id = ? AND account_id = ? AND data_type = ?').get(req.user.id, req.query.accountId, 'adsets');
    if (cached) return res.json({ ...JSON.parse(cached.data), _cached: true });
    res.status(400).json({ error: e.message });
  }
});

// ── GET /meta/ads/creatives ──
router.get('/ads/creatives', requireAuth, async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const fields = 'id,name,status,creative{id,name,thumbnail_url,image_url},insights{spend,reach,impressions,clicks,ctr,cpc}';
    const data = await metaGet(`/${accountId}/ads`, req.user.meta_access_token, { fields, limit: 30 });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /meta/ads/insights ──
// Daily breakdown for chart
router.get('/ads/insights', requireAuth, async (req, res) => {
  try {
    const { accountId, since, until } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const data = await metaGet(`/${accountId}/insights`, req.user.meta_access_token, {
      fields: 'spend,reach,impressions,clicks,ctr,cpc',
      time_increment: 1,
      since, until,
    });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /meta/ads/adsets/create ──
// Create a new ad set inside an existing campaign
router.post('/ads/adsets/create', requireAuth, async (req, res) => {
  try {
    const { accountId, adSetConfig } = req.body;
    if (!accountId || !adSetConfig) return res.status(400).json({ error: 'accountId and adSetConfig required' });
    const data = await metaPost(`/${accountId}/adsets`, req.user.meta_access_token, adSetConfig);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /meta/ads/creatives/create ──
router.post('/ads/creatives/create', requireAuth, async (req, res) => {
  try {
    const { accountId, creativeConfig } = req.body;
    const data = await metaPost(`/${accountId}/adcreatives`, req.user.meta_access_token, creativeConfig);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /meta/ads/ads/create ──
router.post('/ads/ads/create', requireAuth, async (req, res) => {
  try {
    const { accountId, adConfig } = req.body;
    const data = await metaPost(`/${accountId}/ads`, req.user.meta_access_token, adConfig);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /meta/post ──
// Publish or schedule a post to Instagram + Facebook
router.post('/post', requireAuth, async (req, res) => {
  try {
    const { igId, pageId, caption, hashtags, mediaUrl, mediaType, scheduledTime, platforms } = req.body;
    const fullCaption = caption + (hashtags?.length ? '\n\n' + hashtags.map(h => '#' + h).join(' ') : '');
    const pageAcct = db.prepare('SELECT * FROM user_accounts WHERE user_id = ? AND account_id = ?').get(req.user.id, pageId);
    const pageToken = pageAcct?.access_token || req.user.meta_access_token;
    const isFuture = scheduledTime && new Date(scheduledTime).getTime() > Date.now() + 60000;
    const unixTime = scheduledTime ? Math.floor(new Date(scheduledTime).getTime() / 1000) : null;
    const results = [];

    if ((platforms || []).includes('Instagram') && igId) {
      let creationId = null;
      if (mediaUrl && mediaType === 'video') {
        const r = await metaPost(`/${igId}/media`, req.user.meta_access_token, {
          media_type: 'REELS', video_url: mediaUrl, caption: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime, published: false }),
        });
        creationId = r.id;
        if (creationId && !isFuture) {
          let ready = false;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await metaGet(`/${creationId}`, req.user.meta_access_token, { fields: 'status_code' });
            if (s.status_code === 'FINISHED') { ready = true; break; }
            if (s.status_code === 'ERROR') throw new Error('Video processing failed');
          }
          if (!ready) throw new Error('Video processing timed out');
        }
      } else if (mediaUrl && mediaType === 'image') {
        const r = await metaPost(`/${igId}/media`, req.user.meta_access_token, {
          image_url: mediaUrl, caption: fullCaption,
          ...(isFuture && { scheduled_publish_time: unixTime, published: false }),
        });
        creationId = r.id;
      }
      if (creationId) {
        await metaPost(`/${igId}/media_publish`, req.user.meta_access_token, { creation_id: creationId });
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
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
