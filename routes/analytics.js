const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();

// ── DB MIGRATION ──────────────────────────────────────────────────────────────
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS post_analytics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      platform    TEXT NOT NULL DEFAULT 'instagram',
      likes       INTEGER DEFAULT 0,
      comments    INTEGER DEFAULT 0,
      shares      INTEGER DEFAULT 0,
      reach       INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      saves       INTEGER DEFAULT 0,
      video_views INTEGER DEFAULT 0,
      clicks      INTEGER DEFAULT 0,
      fetched_at  INTEGER NOT NULL,
      UNIQUE(post_id, platform)
    )
  `).run();
} catch (e) {}

try { db.prepare('ALTER TABLE post_analytics ADD COLUMN saves INTEGER DEFAULT 0').run(); } catch (e) {}
try { db.prepare('ALTER TABLE post_analytics ADD COLUMN video_views INTEGER DEFAULT 0').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_analytics_post ON post_analytics(post_id)').run(); } catch (e) {}

// Ensure posts table has ig_post_id and fb_post_id columns
try { db.prepare('ALTER TABLE posts ADD COLUMN ig_post_id TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE posts ADD COLUMN fb_post_id TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE posts ADD COLUMN posted_at INTEGER').run(); } catch (e) {}

// ── HELPERS ───────────────────────────────────────────────────────────────────

const GRAPH_IG = 'https://graph.instagram.com/v23.0';
const GRAPH_FB = 'https://graph.facebook.com/v23.0';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchIgDirectInsights(igMediaId, igToken) {
  const fields = 'like_count,comments_count,ig_reels_video_view_total_count,reach,impressions,saved,shares';
  const url = `${GRAPH_IG}/${igMediaId}?fields=${fields}&access_token=${igToken}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (!resp.ok || json.error) {
    throw new Error(json.error?.message || `IG insights HTTP ${resp.status}`);
  }
  return {
    likes: json.like_count || 0,
    comments: json.comments_count || 0,
    video_views: json.ig_reels_video_view_total_count || 0,
    reach: json.reach || 0,
    impressions: json.impressions || 0,
    saves: json.saved || 0,
    shares: json.shares || 0,
  };
}

async function fetchFbInsights(fbPostId, fbPageToken) {
  const fields = 'likes.summary(true),comments.summary(true),shares,insights.metric(post_impressions,post_reach,post_clicks)';
  const url = `${GRAPH_FB}/${fbPostId}?fields=${fields}&access_token=${fbPageToken}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (!resp.ok || json.error) {
    throw new Error(json.error?.message || `FB insights HTTP ${resp.status}`);
  }

  const insights = {};
  if (json.insights && json.insights.data) {
    for (const metric of json.insights.data) {
      insights[metric.name] = metric.values?.[0]?.value || 0;
    }
  }

  return {
    likes: json.likes?.summary?.total_count || 0,
    comments: json.comments?.summary?.total_count || 0,
    shares: json.shares?.count || 0,
    reach: insights.post_reach || 0,
    impressions: insights.post_impressions || 0,
    saves: 0,
    video_views: 0,
    clicks: insights.post_clicks || 0,
  };
}

function upsertAnalytics(postId, platform, stats) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO post_analytics
      (post_id, platform, likes, comments, shares, reach, impressions, saves, video_views, clicks, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id, platform) DO UPDATE SET
      likes = excluded.likes,
      comments = excluded.comments,
      shares = excluded.shares,
      reach = excluded.reach,
      impressions = excluded.impressions,
      saves = excluded.saves,
      video_views = excluded.video_views,
      clicks = excluded.clicks,
      fetched_at = excluded.fetched_at
  `).run(
    postId, platform,
    stats.likes || 0,
    stats.comments || 0,
    stats.shares || 0,
    stats.reach || 0,
    stats.impressions || 0,
    stats.saves || 0,
    stats.video_views || 0,
    stats.clicks || 0,
    now
  );
}

async function refreshPostAnalytics(post, user) {
  const results = [];

  if (post.ig_post_id && user.ig_direct_access_token) {
    try {
      const stats = await fetchIgDirectInsights(post.ig_post_id, user.ig_direct_access_token);
      upsertAnalytics(post.id, 'instagram', stats);
      results.push({ platform: 'instagram', ...stats });
    } catch (e) {
      console.warn(`[Analytics] IG insights failed for post ${post.id}:`, e.message);
    }
  }

  if (post.fb_post_id && user.meta_page_token) {
    try {
      const stats = await fetchFbInsights(post.fb_post_id, user.meta_page_token);
      upsertAnalytics(post.id, 'facebook', stats);
      results.push({ platform: 'facebook', ...stats });
    } catch (e) {
      console.warn(`[Analytics] FB insights failed for post ${post.id}:`, e.message);
    }
  }

  return results;
}

// ── BACKGROUND REFRESH JOB ────────────────────────────────────────────────────
async function runAnalyticsRefresh() {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const staleCutoff = Date.now() - CACHE_TTL;

    const posts = db.prepare(`
      SELECT p.id, p.user_id, p.ig_post_id, p.fb_post_id,
             u.ig_direct_access_token, u.ig_direct_user_id,
             u.meta_page_token, u.meta_access_token
      FROM posts p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'posted'
        AND p.posted_at > ?
        AND (
          NOT EXISTS (
            SELECT 1 FROM post_analytics pa
            WHERE pa.post_id = p.id AND pa.fetched_at > ?
          )
        )
      LIMIT 50
    `).all(cutoff, staleCutoff);

    if (posts.length === 0) return;
    console.log(`[Analytics] Refreshing ${posts.length} posts...`);

    for (const post of posts) {
      await refreshPostAnalytics(post, post);
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    // Never let the background job crash the server
    console.error('[Analytics] Background refresh error (non-fatal):', e.message);
  }
}

setTimeout(() => {
  runAnalyticsRefresh();
  setInterval(runAnalyticsRefresh, CACHE_TTL);
}, 30 * 1000);

// ── ROUTES ────────────────────────────────────────────────────────────────────

router.get('/summary', requireAuth, (req, res) => {
  const userId = req.user.id;
  const days = parseInt(req.query.days) || 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(pa.likes), 0) as total_likes,
      COALESCE(SUM(pa.comments), 0) as total_comments,
      COALESCE(SUM(pa.shares), 0) as total_shares,
      COALESCE(SUM(pa.reach), 0) as total_reach,
      COALESCE(SUM(pa.impressions), 0) as total_impressions,
      COALESCE(SUM(pa.saves), 0) as total_saves,
      COALESCE(SUM(pa.video_views), 0) as total_video_views,
      COUNT(DISTINCT p.id) as total_posts
    FROM posts p
    LEFT JOIN post_analytics pa ON pa.post_id = p.id
    WHERE p.user_id = ? AND p.status = 'posted' AND p.posted_at > ?
  `).get(userId, since);

  const topPosts = db.prepare(`
    SELECT
      p.id, p.caption, p.media_type, p.media_url, p.posted_at, p.post_type,
      COALESCE(SUM(pa.likes), 0) as likes,
      COALESCE(SUM(pa.comments), 0) as comments,
      COALESCE(SUM(pa.shares), 0) as shares,
      COALESCE(SUM(pa.reach), 0) as reach,
      COALESCE(SUM(pa.impressions), 0) as impressions,
      COALESCE(SUM(pa.saves), 0) as saves,
      COALESCE(SUM(pa.video_views), 0) as video_views,
      pa.fetched_at
    FROM posts p
    LEFT JOIN post_analytics pa ON pa.post_id = p.id
    WHERE p.user_id = ? AND p.status = 'posted' AND p.posted_at > ?
    GROUP BY p.id
    ORDER BY reach DESC
    LIMIT 5
  `).all(userId, since);

  const daily = db.prepare(`
    SELECT
      date(p.posted_at / 1000, 'unixepoch') as day,
      COALESCE(SUM(pa.likes), 0) as likes,
      COALESCE(SUM(pa.reach), 0) as reach,
      COALESCE(SUM(pa.impressions), 0) as impressions,
      COUNT(DISTINCT p.id) as posts
    FROM posts p
    LEFT JOIN post_analytics pa ON pa.post_id = p.id
    WHERE p.user_id = ? AND p.status = 'posted' AND p.posted_at > ?
    GROUP BY day
    ORDER BY day ASC
  `).all(userId, since);

  const byPlatform = db.prepare(`
    SELECT
      pa.platform,
      COALESCE(SUM(pa.likes), 0) as likes,
      COALESCE(SUM(pa.comments), 0) as comments,
      COALESCE(SUM(pa.reach), 0) as reach,
      COALESCE(SUM(pa.impressions), 0) as impressions,
      COUNT(DISTINCT pa.post_id) as posts
    FROM post_analytics pa
    JOIN posts p ON p.id = pa.post_id
    WHERE p.user_id = ? AND p.status = 'posted' AND p.posted_at > ?
    GROUP BY pa.platform
  `).all(userId, since);

  res.json({ totals, topPosts, daily, byPlatform, days });
});

router.get('/posts', requireAuth, (req, res) => {
  const userId = req.user.id;
  const days = parseInt(req.query.days) || 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  const posts = db.prepare(`
    SELECT
      p.id, p.caption, p.media_type, p.media_url, p.posted_at, p.post_type,
      p.platforms, p.ig_post_id, p.fb_post_id,
      COALESCE(SUM(pa.likes), 0) as likes,
      COALESCE(SUM(pa.comments), 0) as comments,
      COALESCE(SUM(pa.shares), 0) as shares,
      COALESCE(SUM(pa.reach), 0) as reach,
      COALESCE(SUM(pa.impressions), 0) as impressions,
      COALESCE(SUM(pa.saves), 0) as saves,
      COALESCE(SUM(pa.video_views), 0) as video_views,
      MAX(pa.fetched_at) as fetched_at
    FROM posts p
    LEFT JOIN post_analytics pa ON pa.post_id = p.id
    WHERE p.user_id = ? AND p.status = 'posted' AND p.posted_at > ?
    GROUP BY p.id
    ORDER BY p.posted_at DESC
    LIMIT ?
  `).all(userId, since, limit);

  // platforms is stored as a JSON string column — the frontend expects a
  // real array (it calls .join()/.includes() on it), so this must be parsed
  // here rather than passed through raw. Left unparsed, any post that reached
  // this endpoint threw an uncaught TypeError mid-render on the Analytics
  // page and left it stuck on its loading spinner forever.
  const parsedPosts = posts.map(p => ({
    ...p,
    platforms: (() => { try { return JSON.parse(p.platforms || '[]'); } catch { return []; } })(),
  }));

  res.json({ posts: parsedPosts });
});

router.post('/refresh/:postId', requireAuth, async (req, res) => {
  const post = db.prepare(`
    SELECT p.*, u.ig_direct_access_token, u.ig_direct_user_id,
           u.meta_page_token, u.meta_access_token
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND p.user_id = ?
  `).get(req.params.postId, req.user.id);

  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status !== 'posted') return res.status(400).json({ error: 'Post not yet published' });
  if (!post.ig_post_id && !post.fb_post_id) {
    return res.status(400).json({ error: 'No platform ID saved for this post — analytics not available' });
  }

  try {
    const results = await refreshPostAnalytics(post, post);
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
