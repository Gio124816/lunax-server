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

// Helper — resolve which ad account to use: explicit query param wins, else
// fall back to the user's saved auto-selected account. Lets the dashboard work
// without the user pasting an ad account ID every time.
function resolveAdAccountId(req) {
  if (req.query.accountId) return req.query.accountId;
  try {
    const row = db.prepare('SELECT meta_ad_account_id FROM users WHERE id = ?').get(req.user.id);
    return row?.meta_ad_account_id || null;
  } catch (e) {
    return null;
  }
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
  const accounts = db.prepare('SELECT * FROM social_accounts WHERE user_id = ?').all(req.user.id);
  res.json({ accounts });
});

// ── GET /meta/pages ──
router.get('/pages', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });

    const data = await metaGet('/me/accounts', token, {
      fields: 'id,name,access_token,picture,instagram_business_account{id,name,username,profile_picture_url}'
    });

    // Shaped pages array for native Swift app
    const pages = (data.data || []).map(page => ({
      id: page.id,
      name: page.name,
      access_token: page.access_token,
      picture: page.picture?.data?.url || null,
      instagram: page.instagram_business_account ? {
        id: page.instagram_business_account.id,
        name: page.instagram_business_account.name || page.instagram_business_account.username,
        username: page.instagram_business_account.username,
        picture: page.instagram_business_account.profile_picture_url || null
      } : null
    }));

    // Current saved selection
    const user = db.prepare('SELECT meta_page_id, meta_page_name, meta_ig_id, meta_ig_name FROM users WHERE id = ?').get(req.user.id);

    // Return BOTH formats:
    // - data[] keeps Electron app working (it reads res.data)
    // - pages[] + selected for native Swift app
    res.json({
      data: data.data || [],   // ← Electron app reads this
      pages,                   // ← Swift app reads this
      selected: {
        pageId: user?.meta_page_id || null,
        pageName: user?.meta_page_name || null,
        igId: user?.meta_ig_id || null,
        igName: user?.meta_ig_name || null
      }
    });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/pages ── (alias for save-selection, used by native app)
router.post('/pages', requireAuth, async (req, res) => {
  try {
    const { pageId, pageName, pageToken, igId, igName } = req.body;
    db.prepare(`
      UPDATE users SET
        meta_page_id = ?,
        meta_page_name = ?,
        meta_page_token = ?,
        meta_ig_id = ?,
        meta_ig_name = ?,
        updated_at = ?
      WHERE id = ?
    `).run(pageId || null, pageName || null, pageToken || null, igId || null, igName || null, Date.now(), req.user.id);
    res.json({ success: true });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── GET /meta/adaccounts ──
// Lists the user's Meta ad accounts and auto-selects a sensible default,
// mirroring how /pages works for IG/Facebook page selection. The frontend can
// call this on connect to populate the picker AND get a pre-selected account
// so the user doesn't have to paste an ad account ID by hand.
router.get('/adaccounts', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const data = await metaGet('/me/adaccounts', token, {
      fields: 'id,account_id,name,account_status,currency,amount_spent,business{id,name}',
      limit: 100,
    });
    const accounts = (data.data || []).map(a => ({
      id: a.account_id,                 // numeric id used by the ads endpoints
      actId: a.id,                      // full "act_..." id
      name: a.name || `Ad account ${a.account_id}`,
      status: a.account_status,         // 1 = active
      currency: a.currency,
      amountSpent: Number(a.amount_spent || 0),
      business: a.business?.name || null,
    }));

    // Auto-select: prefer an ACTIVE account (status 1); among those, the one
    // with the most spend (most likely the account they actually use). Fall
    // back to the first account if none are active.
    const active = accounts.filter(a => a.status === 1);
    const pool = active.length ? active : accounts;
    const autoSelected = pool.slice().sort((a, b) => b.amountSpent - a.amountSpent)[0] || null;

    // Persist the auto-selected account if the user doesn't already have one
    // saved, so it sticks across sessions (same behavior as page selection).
    if (autoSelected) {
      const existing = db.prepare('SELECT meta_ad_account_id FROM users WHERE id = ?').get(req.user.id);
      if (!existing || !existing.meta_ad_account_id) {
        try {
          db.prepare('UPDATE users SET meta_ad_account_id = ? WHERE id = ?')
            .run(autoSelected.id, req.user.id);
        } catch (dbErr) {
          // Column may not exist yet on older DBs — non-fatal, just log
          console.warn('[meta/adaccounts] could not persist auto-selection:', dbErr.message);
        }
      }
    }

    res.json({ accounts, autoSelected });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/save-ad-account ──
// Persists the user's chosen ad account (when they pick a different one than
// the auto-selected default).
router.post('/save-ad-account', requireAuth, async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    db.prepare('UPDATE users SET meta_ad_account_id = ? WHERE id = ?')
      .run(accountId, req.user.id);
    res.json({ success: true });
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
    const pageAcct = db.prepare('SELECT * FROM social_accounts WHERE user_id = ? AND account_id = ?')
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
    const { since, until } = req.query;
    const accountId = resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected. Connect Facebook and pick an ad account first.' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const fields = 'id,name,status,objective,daily_budget,lifetime_budget,insights{spend,reach,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency}';
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
    const acctId = resolveAdAccountId(req);
    const cached = acctId && db.prepare('SELECT data FROM ad_cache WHERE user_id = ? AND account_id = ? AND data_type = ?')
      .get(req.user.id, acctId, 'campaigns');
    if (cached) return res.json({ ...JSON.parse(cached.data), _cached: true });
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/adsets ──
router.get('/ads/adsets', requireAuth, async (req, res) => {
  try {
    const { since, until } = req.query;
    const accountId = resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected. Connect Facebook and pick an ad account first.' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const fields = 'id,name,status,daily_budget,lifetime_budget,insights{spend,reach,impressions,clicks,ctr,cpc,cpm,frequency}';
    const data = await metaGet(`/${accountId}/adsets`, token, {
      fields, limit: 50,
      ...(since && { time_range: JSON.stringify({ since, until }) }),
    });
    db.prepare(`INSERT INTO ad_cache (user_id, account_id, data_type, data, fetched_at) VALUES (?, ?, 'adsets', ?, unixepoch()) ON CONFLICT(user_id, account_id, data_type) DO UPDATE SET data = excluded.data, fetched_at = unixepoch()`).run(req.user.id, accountId, JSON.stringify(data));
    res.json(data);
  } catch (e) {
    const acctId = resolveAdAccountId(req);
    const cached = acctId && db.prepare('SELECT data FROM ad_cache WHERE user_id = ? AND account_id = ? AND data_type = ?').get(req.user.id, acctId, 'adsets');
    if (cached) return res.json({ ...JSON.parse(cached.data), _cached: true });
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/creatives ──
router.get('/ads/creatives', requireAuth, async (req, res) => {
  try {
    const accountId = resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected. Connect Facebook and pick an ad account first.' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { since, until } = req.query;
    const fields = 'id,name,status,ad_id,creative{id,name,thumbnail_url,image_url,video_id,object_story_spec{video_data{video_id,image_url},link_data{picture,message,name,call_to_action}}},insights{spend,reach,impressions,clicks,ctr,cpc,actions}';
    const data = await metaGet(`/${accountId}/ads`, token, {
      fields, limit: 30,
      ...(since && { time_range: JSON.stringify({ since, until }) }),
    });
    res.json(data);
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/insights ──
router.get('/ads/insights', requireAuth, async (req, res) => {
  try {
    const { since, until } = req.query;
    const accountId = resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected. Connect Facebook and pick an ad account first.' });
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

// ── POST /meta/ads/launch ──────────────────────────────────────────────────
// The AI ad builder's launch step. Takes an approved ad plan and creates the
// full chain on Meta — campaign → ad set → creative → ad — ALL IN PAUSED STATE.
// Nothing spends money until the user flips it active (a second railguard on
// top of the frontend confirmation modal). Each step is created in order; if
// any step fails, we return what was created so the frontend can show partial
// progress and the user can clean up in Meta if needed.
//
// Expected body (the approved plan from the review card):
// {
//   accountId,                     // optional; falls back to saved account
//   useExistingCampaignId,         // if set, skip campaign creation
//   useExistingAdSetId,            // if set, skip ad set creation
//   campaign: { name, objective }, // when creating a new campaign
//   adSet: { name, dailyBudget, targeting, optimizationGoal, billingEvent, startTime, endTime },
//   creative: { name, pageId, message, headline, description, videoId, imageUrl, linkUrl, callToActionType },
//   ad: { name }
// }
router.post('/ads/launch', requireAuth, async (req, res) => {
  const created = { campaignId: null, adSetId: null, creativeId: null, adId: null };
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    let accountId = req.body.accountId || resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected.' });
    if (!String(accountId).startsWith('act_')) accountId = 'act_' + accountId;

    const plan = req.body || {};

    // ── 1. CAMPAIGN ──
    let campaignId = plan.useExistingCampaignId || null;
    if (!campaignId) {
      if (!plan.campaign || !plan.campaign.name) {
        return res.status(400).json({ error: 'campaign.name required when not using an existing campaign' });
      }
      const campaignBody = {
        name: plan.campaign.name,
        objective: plan.campaign.objective || 'OUTCOME_LEADS',
        status: 'PAUSED',                       // ← railguard: never auto-active
        special_ad_categories: JSON.stringify(plan.campaign.specialAdCategories || []),
      };
      const camp = await metaPost(`/${accountId}/campaigns`, token, campaignBody);
      campaignId = camp.id;
      created.campaignId = campaignId;
    }

    // ── 2. AD SET ──
    let adSetId = plan.useExistingAdSetId || null;
    if (!adSetId) {
      const as = plan.adSet || {};
      if (!as.dailyBudget) return res.status(400).json({ error: 'adSet.dailyBudget required (in cents)' });
      const adSetBody = {
        name: as.name || `${(plan.campaign && plan.campaign.name) || 'Luna X'} — Ad Set`,
        campaign_id: campaignId,
        daily_budget: as.dailyBudget,           // integer, minor units (cents)
        billing_event: as.billingEvent || 'IMPRESSIONS',
        optimization_goal: as.optimizationGoal || 'LEAD_GENERATION',
        bid_strategy: as.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
        targeting: JSON.stringify(as.targeting || {
          geo_locations: { countries: ['US'] },
          age_min: 18, age_max: 65,
        }),
        status: 'PAUSED',                       // ← railguard
        ...(as.startTime && { start_time: as.startTime }),
        ...(as.endTime && { end_time: as.endTime }),
      };
      const adset = await metaPost(`/${accountId}/adsets`, token, adSetBody);
      adSetId = adset.id;
      created.adSetId = adSetId;
    }

    // ── 3. CREATIVE ──
    const cr = plan.creative || {};
    if (!cr.pageId) return res.status(400).json({ error: 'creative.pageId required' });
    // Build object_story_spec depending on whether we have video or image
    let objectStorySpec;
    const linkData = {
      message: cr.message || '',
      link: cr.linkUrl || `https://facebook.com/${cr.pageId}`,
      ...(cr.headline && { name: cr.headline }),
      ...(cr.description && { description: cr.description }),
      ...(cr.callToActionType && {
        call_to_action: { type: cr.callToActionType, value: { link: cr.linkUrl || `https://facebook.com/${cr.pageId}` } },
      }),
    };
    if (cr.videoId) {
      objectStorySpec = {
        page_id: cr.pageId,
        video_data: {
          video_id: cr.videoId,
          message: cr.message || '',
          ...(cr.imageUrl && { image_url: cr.imageUrl }),
          ...(cr.callToActionType && {
            call_to_action: { type: cr.callToActionType, value: { link: cr.linkUrl || `https://facebook.com/${cr.pageId}` } },
          }),
        },
      };
    } else if (cr.imageUrl) {
      objectStorySpec = { page_id: cr.pageId, link_data: { ...linkData, picture: cr.imageUrl } };
    } else {
      objectStorySpec = { page_id: cr.pageId, link_data: linkData };
    }
    const creativeBody = {
      name: cr.name || 'Luna X Creative',
      object_story_spec: JSON.stringify(objectStorySpec),
    };
    const creative = await metaPost(`/${accountId}/adcreatives`, token, creativeBody);
    created.creativeId = creative.id;

    // ── 4. AD ──
    const adBody = {
      name: (plan.ad && plan.ad.name) || cr.name || 'Luna X Ad',
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED',                          // ← railguard: built paused
    };
    const ad = await metaPost(`/${accountId}/ads`, token, adBody);
    created.adId = ad.id;

    res.json({
      success: true,
      created,
      status: 'PAUSED',
      message: 'Ad built and staged in PAUSED state. Review in Meta or activate when ready — nothing is spending yet.',
    });
  } catch (e) {
    console.error('[ads/launch] error:', e.message, '| created so far:', created);
    // Return partial progress so the frontend can tell the user what exists
    res.status(400).json({
      error: e.message,
      code: e.code || 'LAUNCH_FAILED',
      created,
      partial: !!(created.campaignId || created.adSetId || created.creativeId),
    });
  }
});

// ── POST /meta/ads/activate ──
// Flips a paused ad (and optionally its ad set/campaign) to ACTIVE. This is the
// step that actually starts spending — called only after explicit user action.
router.post('/ads/activate', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { adId, adSetId, campaignId } = req.body;
    const results = {};
    // Activate from the top down so the ad isn't orphaned by a paused parent
    if (campaignId) { await metaPost(`/${campaignId}`, token, { status: 'ACTIVE' }); results.campaign = 'ACTIVE'; }
    if (adSetId)    { await metaPost(`/${adSetId}`, token, { status: 'ACTIVE' }); results.adSet = 'ACTIVE'; }
    if (adId)       { await metaPost(`/${adId}`, token, { status: 'ACTIVE' }); results.ad = 'ACTIVE'; }
    res.json({ success: true, results });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/ads/upload-video ──
// Uploads a video to the ad account's video library so it can be used in a
// creative. Returns the video_id the creative step needs.
router.post('/ads/upload-video', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    let accountId = req.body.accountId || resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected.' });
    if (!String(accountId).startsWith('act_')) accountId = 'act_' + accountId;
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
    // Meta can ingest a video by URL via file_url
    const data = await metaPost(`/${accountId}/advideos`, token, { file_url: videoUrl });
    res.json({ success: true, videoId: data.id });
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

    const pageAcct = db.prepare('SELECT * FROM social_accounts WHERE user_id = ? AND account_id = ?').get(req.user.id, pageId);
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

// ── GET /meta/ads/:adId/preview ──
// Returns Meta's rendered ad preview iframe — used by the native app to show
// the actual ad at full quality (video plays, images full-res) instead of
// the blurry thumbnail_url. Calls Meta's /<adId>/previews endpoint.
router.get('/ads/:adId/preview', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { adId } = req.params;
    const data = await metaGet(`/${adId}/previews`, token, {
      ad_format: 'DESKTOP_FEED_STANDARD',
    });
    // Meta returns an array of preview objects — each has a `body` field
    // containing an <iframe> HTML snippet that renders the real ad
    const body = data.data?.[0]?.body || '';
    res.json({ body });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── GET /meta/ads/:adId/video ──
// Returns the playable video source URL for a video ad.
// Fetches the ad's creative to get video_id, then fetches the video object
// for its `source` URL (direct MP4 link, full resolution).
router.get('/ads/:adId/video', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { adId } = req.params;

    // Step 1: get the ad's creative and extract video_id
    const adData = await metaGet(`/${adId}`, token, {
      fields: 'creative{video_id,object_story_spec{video_data{video_id}}}',
    });
    const videoId = adData.creative?.video_id
      || adData.creative?.object_story_spec?.video_data?.video_id;

    if (!videoId) return res.json({ videoUrl: null });

    // Step 2: fetch the video object for its source (direct playable URL)
    const videoData = await metaGet(`/${videoId}`, token, {
      fields: 'source,embed_html',
    });

    res.json({ videoUrl: videoData.source || null });
  } catch (e) {
    handleMetaError(e, res);
  }
});

module.exports = router;
