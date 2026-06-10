// ════════════════════════════════════════════════════════════════════════════
// routes/comments.js
// ════════════════════════════════════════════════════════════════════════════
// Comment fetching and reply endpoints for the Luna X post detail modal.
//
// Required permissions on the user's Meta connection:
//   - pages_read_user_content   (read comments on Facebook posts)
//   - pages_manage_engagement   (reply to comments on Facebook posts)
//   - instagram_business_basic + instagram_manage_comments (for IG-direct)
//   - OR the equivalent Facebook-Login scopes if user connected via Meta flow
//
// USAGE from the frontend:
//   GET  /comments/:lunaXPostId
//     → { comments: [{ id, from: {name, id}, message, created_time, can_reply }], platform: 'facebook'|'instagram'|null }
//   POST /comments/:commentId/reply
//     body: { message: string, platform: 'facebook'|'instagram', lunaXPostId: string }
//     → { id: string }    // the new comment id
//
// LIMITATIONS:
//   - Only posts published AFTER scheduler.js was updated to save fb_post_id /
//     ig_post_id will have queryable comments. Older posts have no external id
//     saved → endpoint returns { comments: [], platform: null, error: 'no_external_id' }.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

// ── schema migration ─────────────────────────────────────────────────────
// posts.fb_post_id  : the Facebook post id returned by /me/feed (form: pageId_postId)
// posts.ig_post_id  : the Instagram media id returned by /media_publish
// Idempotent — ALTER TABLE ADD COLUMN throws if column exists, we catch.
function _ensurePostColumns() {
  for (const col of ['fb_post_id TEXT', 'ig_post_id TEXT']) {
    try { db.prepare(`ALTER TABLE posts ADD COLUMN ${col}`).run(); } catch {}
  }
}

// ── helper: fetch a post + the user's tokens, picking the right platform ──
function _resolvePostAndCreds(lunaXPostId, userId) {
  _ensurePostColumns();
  const post = db.prepare(`
    SELECT id, user_id, fb_post_id, ig_post_id, platforms
    FROM posts
    WHERE id = ? AND user_id = ?
  `).get(lunaXPostId, userId);
  if (!post) return { error: 'post_not_found' };

  const user = db.prepare(`
    SELECT meta_access_token, meta_page_token, meta_page_id, meta_ig_id,
           ig_direct_access_token, ig_direct_user_id
    FROM users WHERE id = ?
  `).get(userId);
  if (!user) return { error: 'user_not_found' };

  // Prefer FB if we have a FB post id; else IG. UI is the same either way.
  if (post.fb_post_id) {
    if (!user.meta_page_token) return { error: 'missing_meta_page_token' };
    return {
      platform: 'facebook',
      externalId: post.fb_post_id,
      accessToken: user.meta_page_token,
    };
  }
  if (post.ig_post_id) {
    // Prefer the IG-direct token if user has one. Falls back to Meta access
    // token (which works against graph.facebook.com for IG posts published
    // via the Facebook-routed flow).
    if (user.ig_direct_access_token) {
      return {
        platform: 'instagram',
        externalId: post.ig_post_id,
        accessToken: user.ig_direct_access_token,
        graphHost: 'graph.instagram.com',
      };
    }
    if (user.meta_access_token) {
      return {
        platform: 'instagram',
        externalId: post.ig_post_id,
        accessToken: user.meta_access_token,
        graphHost: 'graph.facebook.com',
      };
    }
    return { error: 'missing_instagram_token' };
  }
  return { error: 'no_external_id' };
}

// ── GET /comments/:lunaXPostId ───────────────────────────────────────────
// Fetches comments for the given post. Front-end calls this when the user
// opens the post detail modal and switches to the Comments tab.
router.get('/:lunaXPostId', requireAuth, async (req, res) => {
  try {
    const ctx = _resolvePostAndCreds(req.params.lunaXPostId, req.user.id);
    if (ctx.error === 'no_external_id') {
      // Common case: post was scheduled/published before the migration that
      // saves external ids. Return empty + a hint to the UI.
      return res.json({
        comments: [],
        platform: null,
        note: 'Comments are only available for posts published after the latest update — repost to enable.',
      });
    }
    if (ctx.error) return res.status(400).json({ error: ctx.error });

    const host = ctx.graphHost || 'graph.facebook.com';
    const fields = ctx.platform === 'facebook'
      // FB returns more fields including from{} which is the commenter
      ? 'id,from,message,created_time,can_reply,like_count'
      // IG returns username instead of from{}
      : 'id,username,text,timestamp,like_count';
    const url = `https://${host}/v23.0/${ctx.externalId}/comments?fields=${fields}&access_token=${encodeURIComponent(ctx.accessToken)}&limit=50`;
    const r = await fetch(url);
    const json = await r.json();
    if (!r.ok) {
      const msg = (json && json.error && (json.error.message || json.error.error_user_msg)) || `HTTP ${r.status}`;
      // Token-expired or permission-missing surfaces here. Pass through the
      // Meta message so the UI can show something helpful.
      return res.status(r.status).json({ error: msg, raw: json });
    }

    // Normalize Facebook + Instagram comment shapes into a single format.
    const comments = (json.data || []).map(c => ({
      id: c.id,
      author: ctx.platform === 'facebook'
        ? (c.from && c.from.name) || 'Unknown'
        : c.username || 'Unknown',
      message: ctx.platform === 'facebook' ? c.message : c.text,
      createdAt: c.created_time || c.timestamp || null,
      likeCount: c.like_count || 0,
      canReply: c.can_reply !== false, // FB only; IG always allows reply
    }));
    res.json({ comments, platform: ctx.platform });
  } catch (err) {
    console.error('GET /comments error:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ── POST /comments/:commentId/reply ──────────────────────────────────────
// Posts a reply to a specific comment. Front-end calls this when the user
// types in the reply box and hits Reply.
//
// Body shape: { message: string, lunaXPostId: string }
// We re-resolve the post + creds from lunaXPostId (rather than trusting the
// client) so the user can't reply on behalf of another user's post.
router.post('/:commentId/reply', requireAuth, async (req, res) => {
  try {
    const { message, lunaXPostId } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Reply message is required' });
    }
    if (!lunaXPostId) {
      return res.status(400).json({ error: 'lunaXPostId is required' });
    }
    const ctx = _resolvePostAndCreds(lunaXPostId, req.user.id);
    if (ctx.error) return res.status(400).json({ error: ctx.error });

    const host = ctx.graphHost || 'graph.facebook.com';
    // FB: POST /{comment-id}/comments  { message }
    // IG: POST /{comment-id}/replies   { message }
    const path = ctx.platform === 'facebook' ? 'comments' : 'replies';
    const body = new URLSearchParams({
      message: message.trim(),
      access_token: ctx.accessToken,
    });
    const r = await fetch(`https://${host}/v23.0/${req.params.commentId}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await r.json();
    if (!r.ok) {
      const msg = (json && json.error && (json.error.message || json.error.error_user_msg)) || `HTTP ${r.status}`;
      return res.status(r.status).json({ error: msg, raw: json });
    }
    res.json({ id: json.id });
  } catch (err) {
    console.error('POST /comments/:id/reply error:', err);
    res.status(500).json({ error: 'Failed to post reply' });
  }
});

module.exports = router;
