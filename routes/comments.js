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

  // Only select columns that actually exist in the DB.
  // ig_direct_access_token / ig_direct_user_id are NOT in this schema.
  const user = db.prepare(`
    SELECT meta_access_token, meta_page_token, meta_page_id, meta_ig_id
    FROM users WHERE id = ?
  `).get(userId);
  if (!user) return { error: 'user_not_found' };

  // Prefer FB if we have a FB post id; else IG.
  if (post.fb_post_id) {
    if (!user.meta_page_token) return { error: 'missing_meta_page_token' };
    return {
      platform: 'facebook',
      externalId: post.fb_post_id,
      accessToken: user.meta_page_token,
    };
  }
  if (post.ig_post_id) {
    // Use meta_access_token for IG published via Meta OAuth flow
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

// ── POST /comments/sync ──────────────────────────────────────────────────
// Lightweight endpoint Swift calls before GET /comments.
// We don't need to do anything special here — GET /comments already fetches
// live from Meta. Just return 200 so Swift knows sync is "done".
router.post('/sync', requireAuth, (req, res) => {
  res.json({ ok: true, message: 'Use GET /comments to fetch inbox' });
});

// ── GET /comments  (no param) — global inbox ────────────────────────────
// Fetches comments from ALL published posts for the current user.
// Called by the native app Inbox view on load.
// Returns: { comments: [{ id, platform, type, senderName, text, postCaption,
//                         timestamp, isDone, reply, postId }] }
router.get('/', requireAuth, async (req, res) => {
  try {
    _ensurePostColumns();

    // Get all published posts that have an external ID (fb_post_id or ig_post_id)
    const posts = db.prepare(`
      SELECT id, caption, fb_post_id, ig_post_id, platforms
      FROM posts
      WHERE user_id = ? AND (fb_post_id IS NOT NULL OR ig_post_id IS NOT NULL)
      ORDER BY scheduled_time DESC LIMIT 20
    `).all(req.user.id);

    const user = db.prepare(`
      SELECT meta_access_token, meta_page_token, meta_page_id, meta_ig_id
      FROM users WHERE id = ?
    `).get(req.user.id);

    if (!user) return res.json({ comments: [] });

    const allComments = [];

    // STRATEGY 1: fetch comments from DB-tracked posts (have fb_post_id/ig_post_id)
    if (posts.length > 0) {
      const dbFetchJobs = posts.slice(0, 10).map(async (post) => {
        const ctx = _resolvePostAndCreds(post.id, req.user.id);
        if (ctx.error) return;
        const host = ctx.graphHost || 'graph.facebook.com';
        const fields = ctx.platform === 'facebook'
          ? 'id,from,message,created_time,can_reply,like_count'
          : 'id,username,text,timestamp,like_count';
        try {
          const r = await fetch(
            `https://${host}/v23.0/${ctx.externalId}/comments?fields=${fields}&access_token=${encodeURIComponent(ctx.accessToken)}&limit=25`
          );
          if (!r.ok) return;
          const json = await r.json();
          (json.data || []).forEach(c => allComments.push({
            id: c.id,
            platform: ctx.platform === 'facebook' ? 'Facebook' : 'Instagram',
            type: 'comment',
            senderName: ctx.platform === 'facebook' ? ((c.from && c.from.name) || 'Unknown') : (c.username || 'Unknown'),
            senderAvatar: null,
            text: ctx.platform === 'facebook' ? (c.message || '') : (c.text || ''),
            postCaption: post.caption ? post.caption.substring(0, 100) : null,
            postId: post.id,
            timestamp: c.created_time || c.timestamp || new Date().toISOString(),
            isDone: false, reply: null,
          }));
        } catch (e) {
          console.error(`[Inbox] DB post comments error for ${post.id}:`, e.message);
        }
      });
      await Promise.all(dbFetchJobs);
    }

    // STRATEGY 2: fetch directly from Facebook Page feed (works even with no DB posts)
    // This is the primary source when DB is fresh after a Railway redeploy.
    if (user.meta_page_token && user.meta_page_id) {
      try {
        // Get recent page posts with their comments in one call
        const feedUrl = `https://graph.facebook.com/v23.0/${user.meta_page_id}/feed?fields=id,message,created_time,comments{id,from,message,created_time,like_count}&access_token=${encodeURIComponent(user.meta_page_token)}&limit=10`;
        const feedResp = await fetch(feedUrl);
        if (feedResp.ok) {
          const feedJson = await feedResp.json();
          for (const fbPost of (feedJson.data || [])) {
            // Save fb_post_id back to DB if we find a matching post by caption
            const caption = fbPost.message || '';
            if (caption) {
              try {
                db.prepare(`
                  UPDATE posts SET fb_post_id = ?
                  WHERE user_id = ? AND fb_post_id IS NULL
                    AND LOWER(SUBSTR(caption, 1, 60)) = LOWER(SUBSTR(?, 1, 60))
                `).run(fbPost.id, req.user.id, caption);
              } catch {}
            }
            for (const c of ((fbPost.comments && fbPost.comments.data) || [])) {
              // Deduplicate by id
              if (allComments.some(x => x.id === c.id)) continue;
              allComments.push({
                id: c.id,
                platform: 'Facebook',
                type: 'comment',
                senderName: (c.from && c.from.name) || 'Unknown',
                senderAvatar: null,
                text: c.message || '',
                postCaption: caption.substring(0, 100),
                postId: fbPost.id,
                timestamp: c.created_time || new Date().toISOString(),
                isDone: false, reply: null,
              });
            }
          }
        }
      } catch (e) {
        console.error('[Inbox] FB feed fetch error:', e.message);
      }
    }

    // STRATEGY 3: fetch from Instagram media (even without DB posts)
    if (user.meta_ig_id && user.meta_access_token) {
      try {
        const igMediaUrl = `https://graph.facebook.com/v23.0/${user.meta_ig_id}/media?fields=id,caption,timestamp,comments{id,username,text,timestamp}&access_token=${encodeURIComponent(user.meta_access_token)}&limit=10`;
        const igResp = await fetch(igMediaUrl);
        if (igResp.ok) {
          const igJson = await igResp.json();
          for (const igPost of (igJson.data || [])) {
            // Save ig_post_id back to DB if we have a matching post
            if (igPost.id) {
              try {
                db.prepare(`
                  UPDATE posts SET ig_post_id = ?
                  WHERE user_id = ? AND ig_post_id IS NULL
                    AND LOWER(SUBSTR(caption, 1, 60)) = LOWER(SUBSTR(?, 1, 60))
                `).run(igPost.id, req.user.id, igPost.caption || '');
              } catch {}
            }
            for (const c of ((igPost.comments && igPost.comments.data) || [])) {
              if (allComments.some(x => x.id === c.id)) continue;
              allComments.push({
                id: c.id,
                platform: 'Instagram',
                type: 'comment',
                senderName: c.username || 'Unknown',
                senderAvatar: null,
                text: c.text || '',
                postCaption: (igPost.caption || '').substring(0, 100),
                postId: igPost.id,
                timestamp: c.timestamp || new Date().toISOString(),
                isDone: false, reply: null,
              });
            }
          }
        }
      } catch (e) {
        console.error('[Inbox] IG media fetch error:', e.message);
      }
    }

    // Also fetch Facebook Page DMs (conversations) if page token exists
    if (user.meta_page_token && user.meta_page_id) {
      try {
        const convUrl = `https://graph.facebook.com/v23.0/${user.meta_page_id}/conversations?fields=participants,messages{message,from,created_time}&access_token=${encodeURIComponent(user.meta_page_token)}&limit=10`;
        const convResp = await fetch(convUrl);
        if (convResp.ok) {
          const convJson = await convResp.json();
          for (const conv of (convJson.data || [])) {
            const msgs = conv.messages && conv.messages.data || [];
            for (const m of msgs) {
              // Skip messages sent BY the page (from.id === page_id)
              if (m.from && String(m.from.id) === String(user.meta_page_id)) continue;
              allComments.push({
                id: m.id || conv.id,
                platform: 'Facebook',
                type: 'dm',
                senderName: (m.from && m.from.name) || 'Unknown',
                senderAvatar: null,
                text: m.message || '',
                postCaption: null,
                postId: null,
                timestamp: m.created_time || new Date().toISOString(),
                isDone: false,
                reply: null,
              });
            }
          }
        }
      } catch (e) {
        console.error('[Inbox] Failed to fetch FB DMs:', e.message);
      }
    }

    // Sort newest first
    allComments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log(`[Inbox] Returning ${allComments.length} messages for user ${req.user.id}`);
    res.json({ comments: allComments });
  } catch (err) {
    console.error('GET /comments (global) error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox', comments: [] });
  }
});

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
