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
// Two-phase fetch for reliable creative data:
//
// Phase 1: Fetch ads list with basic creative ID + insights.
//   We intentionally do NOT request object_story_spec nested inside the ads
//   call — Meta frequently returns it empty/truncated when nested 3+ levels deep.
//
// Phase 2: For each ad, fetch the full creative directly via GET /{creative_id}
//   with all the fields we need. This is the only reliable way to get the
//   complete object_story_spec with message, headline, description, CTA, and link.
//   Video ads also get enriched with the full-res poster frame (picture field).
router.get('/ads/creatives', requireAuth, async (req, res) => {
  try {
    const accountId = resolveAdAccountId(req);
    if (!accountId) return res.status(400).json({ error: 'No ad account selected. Connect Facebook and pick an ad account first.' });
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { since, until } = req.query;

    // Phase 1: lightweight ads fetch — just IDs, names, creative ID, and insights
    const adFields = 'id,name,status,creative{id},insights{spend,reach,impressions,clicks,ctr,cpc,actions}';
    const data = await metaGet(`/${accountId}/ads`, token, {
      fields: adFields,
      limit: 30,
      ...(since && { time_range: JSON.stringify({ since, until }) }),
    });

    const ads = data.data || [];

    // Phase 2: fetch full creative details for each ad in parallel
    await Promise.allSettled(ads.map(async (ad) => {
      const creativeId = ad.creative?.id;
      if (!creativeId) return;

      try {
        // Fetch the complete creative object directly — fully reliable at this depth
        const creative = await metaGet(`/${creativeId}`, token, {
          fields: [
            'id', 'name',
            'thumbnail_url', 'image_url',
            'video_id',
            'object_story_spec{page_id,video_data{video_id,image_url,message,title,call_to_action},link_data{picture,message,name,description,link,call_to_action}}'
          ].join(',')
        });

        ad.creative = creative;

        // Resolve video_id from creative or its object_story_spec
        const videoId = creative.video_id
          || creative.object_story_spec?.video_data?.video_id
          || null;

        if (videoId) {
          try {
            // Fetch full-res poster frame (and source URL if permitted)
            const videoData = await metaGet(`/${videoId}`, token, {
              fields: 'picture,source'
            });
            ad.creative.resolvedThumb    = videoData.picture || creative.thumbnail_url || null;
            ad.creative.resolvedVideoUrl = videoData.source  || null;
            ad.creative.resolvedVideoId  = videoId;
          } catch (e) {
            ad.creative.resolvedThumb   = creative.thumbnail_url || null;
            ad.creative.resolvedVideoId = videoId;
            console.warn(`[creatives] video enrich failed for ${videoId}:`, e.message);
          }
        } else {
          // Image ad — use image_url (full-res) or link_data.picture
          ad.creative.resolvedThumb = creative.image_url
            || creative.object_story_spec?.link_data?.picture
            || creative.thumbnail_url
            || null;
        }
      } catch (e) {
        console.warn(`[creatives] creative fetch failed for ${creativeId}:`, e.message);
      }
    }));

    res.json({ ...data, data: ads });
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

// ── POST /meta/ads/creatives/update ──
// Updates an existing ad creative's copy (message, headline, description, CTA, link).
// Meta requires creating a NEW creative and swapping it onto the ad — you cannot
// mutate an in-use creative in place. This route handles that two-step automatically.
router.post('/ads/creatives/update', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { creativeId, objectStorySpec } = req.body;
    if (!creativeId || !objectStorySpec) {
      return res.status(400).json({ error: 'creativeId and objectStorySpec required' });
    }

    // Step 1: find which ad account owns this creative
    const creativeData = await metaGet(`/${creativeId}`, token, {
      fields: 'account_id,name'
    });
    const accountId = creativeData.account_id;
    if (!accountId) return res.status(400).json({ error: 'Could not determine ad account for creative' });

    // Step 2: create the new creative in the same ad account
    const newCreative = await metaPost(`/${accountId}/adcreatives`, token, {
      name: (creativeData.name || 'Luna X Creative') + ' (edited)',
      object_story_spec: JSON.stringify(objectStorySpec)
    });

    // Step 3: find all ads using the old creative and swap to the new one
    const adsUsingCreative = await metaGet(`/${creativeId}/ads`, token, {
      fields: 'id'
    });
    const adIds = (adsUsingCreative.data || []).map(a => a.id);
    const swapResults = await Promise.allSettled(
      adIds.map(adId => metaPost(`/${adId}`, token, {
        creative: JSON.stringify({ creative_id: newCreative.id })
      }))
    );

    res.json({
      success: true,
      newCreativeId: newCreative.id,
      adsUpdated: adIds.length,
      swapResults: swapResults.map(r => r.status)
    });
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


// ── GET /meta/inbox ──
// Fetches Instagram DMs + Facebook Page conversations + post comments.
// Returns a unified thread list for the engagement inbox.
// Note: Instagram DM API requires instagram_manage_messages permission.
// Facebook conversations use the Page token, not the user token.
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Debug: log what we have for this user so we can diagnose empty inbox
    console.log('[Inbox] user fields:', {
      id: user?.id,
      meta_page_id: user?.meta_page_id,
      meta_page_name: user?.meta_page_name,
      meta_ig_id: user?.meta_ig_id,
      meta_ig_name: user?.meta_ig_name,
      has_token: !!user?.meta_access_token,
      has_page_token: !!user?.meta_page_token
    });

    // Also check social_accounts table for this user
    const socialAccts = db.prepare("SELECT platform, account_id, account_name FROM social_accounts WHERE user_id = ?").all(req.user.id);
    console.log('[Inbox] social_accounts:', socialAccts);

    const pageId = user?.meta_page_id;
    const igId   = user?.meta_ig_id;

    // Resolve the page access token — try users table first, then social_accounts,
    // then fetch live from Meta and auto-save it so the next request is instant.
    let pageToken = user?.meta_page_token || (() => {
      const acct = pageId
        ? db.prepare("SELECT access_token FROM social_accounts WHERE user_id = ? AND (account_id = ? OR platform = 'meta')").get(req.user.id, pageId)
        : db.prepare("SELECT access_token FROM social_accounts WHERE user_id = ? AND platform = 'meta'").get(req.user.id);
      return acct?.access_token || null;
    })();

    // If still missing, fetch pages from Meta and grab the right page token
    if (!pageToken && pageId) {
      try {
        const pagesData = await metaGet('/me/accounts', token, {
          fields: 'id,name,access_token'
        });
        const matchedPage = (pagesData.data || []).find(p => p.id === pageId);
        if (matchedPage?.access_token) {
          pageToken = matchedPage.access_token;
          // Auto-save so future calls don't need to re-fetch
          db.prepare('UPDATE users SET meta_page_token = ?, updated_at = ? WHERE id = ?')
            .run(pageToken, Date.now(), req.user.id);
          console.log('[Inbox] auto-saved missing page token for page', pageId);
        }
      } catch(e) {
        console.warn('[Inbox] could not fetch page token:', e.message);
      }
    }

    // Final fallback: use user token (will work for some endpoints, not all)
    if (!pageToken) pageToken = token;

    console.log('[Inbox] resolved pageId:', pageId, '| igId:', igId, '| has pageToken:', !!pageToken);

    const threads = [];
    const errors  = [];

    // ── Facebook Page Conversations (DMs) ──────────────────────────────
    if (pageId && pageToken) {
      try {
        const fbConvs = await metaGet(`/${pageId}/conversations`, pageToken, {
          fields: 'id,updated_time,participants,messages{id,message,from,created_time}',
          limit: 25
        });
        console.log('[Inbox] FB DMs raw:', JSON.stringify(fbConvs).slice(0, 300));
        (fbConvs.data || []).forEach(conv => {
          const msgs = (conv.messages?.data || []).reverse(); // oldest first
          const other = (conv.participants?.data || []).find(p => p.id !== pageId);
          if (!msgs.length) return;
          threads.push({
            id: 'fb-' + conv.id,
            platform: 'fb',
            type: 'dm',
            name: other?.name || 'Facebook User',
            initials: (other?.name || 'F').slice(0, 2).toUpperCase(),
            avatarBg: '#1877f2',
            time: relTime(conv.updated_time),
            unread: true,
            done: false,
            rawId: conv.id,
            pageToken,
            messages: msgs.map(m => ({
              id: m.id,
              from: m.from?.id === pageId ? 'us' : 'them',
              text: m.message || '',
              time: relTime(m.created_time)
            }))
          });
        });
      } catch (e) {
        errors.push('FB DMs: ' + e.message);
      }
    }

    // ── Facebook Post Comments ─────────────────────────────────────────
    if (pageId && pageToken) {
      try {
        const feed = await metaGet(`/${pageId}/feed`, pageToken, {
          fields: 'id,message,created_time,comments{id,message,from,created_time,comments{id,message,from,created_time}}',
          limit: 10
        });
        console.log('[Inbox] FB feed posts:', (feed.data||[]).length, '| first post comments:', JSON.stringify((feed.data||[])[0]?.comments).slice(0,200));
        (feed.data || []).forEach(post => {
          (post.comments?.data || []).forEach(comment => {
            const replies = (comment.comments?.data || []).map(r => ({
              id: r.id,
              from: r.from?.id === pageId ? 'us' : 'them',
              text: r.message || '',
              time: relTime(r.created_time)
            }));
            threads.push({
              id: 'fb-comment-' + comment.id,
              platform: 'fb',
              type: 'comment',
              name: comment.from?.name || 'Facebook User',
              initials: (comment.from?.name || 'F').slice(0, 2).toUpperCase(),
              avatarBg: '#1877f2',
              time: relTime(comment.created_time),
              unread: true,
              done: false,
              rawId: comment.id,
              postId: post.id,
              pageToken,
              messages: [
                { id: comment.id, from: 'them', text: comment.message || '', time: relTime(comment.created_time) },
                ...replies
              ]
            });
          });
        });
      } catch (e) {
        errors.push('FB Comments: ' + e.message);
      }
    }

    // ── Instagram DMs ──────────────────────────────────────────────────
    // Requires instagram_manage_messages permission (Advanced Access).
    // Will 403 until that permission is approved — non-fatal.
    if (igId) {
      try {
        const igConvs = await metaGet(`/${igId}/conversations`, token, {
          platform: 'instagram',
          fields: 'id,updated_time,participants,messages{id,message,from,created_time}',
          limit: 25
        });
        (igConvs.data || []).forEach(conv => {
          const msgs = (conv.messages?.data || []).reverse();
          const other = (conv.participants?.data || []).find(p => String(p.id) !== String(igId));
          if (!msgs.length) return;
          threads.push({
            id: 'ig-' + conv.id,
            platform: 'ig',
            type: 'dm',
            name: other?.name || other?.username || 'Instagram User',
            initials: (other?.name || other?.username || 'I').slice(0, 2).toUpperCase(),
            avatarBg: '#e1306c',
            time: relTime(conv.updated_time),
            unread: true,
            done: false,
            rawId: conv.id,
            messages: msgs.map(m => ({
              id: m.id,
              from: m.from?.id === igId ? 'us' : 'them',
              text: m.message || '',
              time: relTime(m.created_time)
            }))
          });
        });
      } catch (e) {
        // Non-fatal — instagram_manage_messages requires App Review
        errors.push('IG DMs (needs App Review): ' + e.message);
      }
    }

    // ── Instagram Post Comments ────────────────────────────────────────
    if (igId) {
      try {
        const igMedia = await metaGet(`/${igId}/media`, token, {
          fields: 'id,caption,timestamp,comments{id,text,username,timestamp,replies{id,text,username,timestamp}}',
          limit: 10
        });
        console.log('[Inbox] IG media posts:', (igMedia.data||[]).length, '| first post comments:', JSON.stringify((igMedia.data||[])[0]?.comments).slice(0,200));
        (igMedia.data || []).forEach(post => {
          (post.comments?.data || []).forEach(comment => {
            const replies = (comment.replies?.data || []).map(r => ({
              id: r.id,
              from: 'us',
              text: r.text || '',
              time: relTime(r.timestamp)
            }));
            threads.push({
              id: 'ig-comment-' + comment.id,
              platform: 'ig',
              type: 'comment',
              name: comment.username || 'Instagram User',
              initials: (comment.username || 'I').slice(0, 2).toUpperCase(),
              avatarBg: '#e1306c',
              time: relTime(comment.timestamp),
              unread: true,
              done: false,
              rawId: comment.id,
              postId: post.id,
              igId,
              messages: [
                { id: comment.id, from: 'them', text: comment.text || '', time: relTime(comment.timestamp) },
                ...replies
              ]
            });
          });
        });
      } catch (e) {
        errors.push('IG Comments: ' + e.message);
      }
    }

    // Sort newest first
    threads.sort((a, b) => (b.rawTime || 0) - (a.rawTime || 0));
    console.log('[Inbox] total threads:', threads.length, '| errors:', errors);
    res.json({ threads, errors: errors.length ? errors : undefined });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// ── POST /meta/inbox/reply ──
// Send a reply to a Facebook comment, Facebook DM, or Instagram comment.
router.post('/inbox/reply', requireAuth, async (req, res) => {
  try {
    const token = getUserMetaToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'No Meta token' });
    const { threadId, rawId, platform, type, message, pageToken, postId, igId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

    let result;
    const tok = pageToken || token;

    if (platform === 'fb' && type === 'dm') {
      // Reply to FB conversation thread
      result = await metaPost(`/${rawId}/messages`, tok, {
        messaging_type: 'RESPONSE',
        message: { text: message.trim() }
      });
    } else if (platform === 'fb' && type === 'comment') {
      // Reply to FB comment
      result = await metaPost(`/${rawId}/comments`, tok, {
        message: message.trim()
      });
    } else if (platform === 'ig' && type === 'comment') {
      // Reply to IG comment
      result = await metaPost(`/${rawId}/replies`, token, {
        message: message.trim()
      });
    } else {
      return res.status(400).json({ error: 'Unsupported reply type' });
    }

    res.json({ success: true, result });
  } catch (e) {
    handleMetaError(e, res);
  }
});

// Helper: human-readable relative time
function relTime(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)  return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

module.exports = router;
