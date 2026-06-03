const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();

// — GET /posts —
router.get('/', requireAuth, (req, res) => {
  const posts = db.prepare(`
    SELECT * FROM posts WHERE user_id = ?
    ORDER BY scheduled_time DESC LIMIT 100
  `).all(req.user.id);
  res.json({ posts: posts.map(deserializePost) });
});

// — POST /posts —
router.post('/', requireAuth, (req, res) => {
  const {
    caption, hashtags, mediaUrl, mediaType, platforms, scheduledTime, accountId,
    // Instagram post-type fields. Frontend sends 'story' for primary Stories,
    // 'feed' (default) for Reels/posts. also_share_to_story is the
    // "post a Reel and also share it to my Story" companion flag.
    post_type, also_share_to_story,
    // Honor the status the frontend sent ('scheduled' for normal posts,
    // 'draft' for save-as-draft). Previously this was hardcoded to 'scheduled'
    // which silently broke the entire draft feature — drafts got picked up
    // by the scheduler immediately.
    status,
  } = req.body;
  const id = uuidv4();
  const now = Date.now();
  const scheduledMs = scheduledTime ? new Date(scheduledTime).getTime() : null;

  // Validate accountId — if it doesn't exist in social_accounts, use null to avoid FK constraint error
  let validAccountId = null;
  if (accountId) {
    const acct = db.prepare('SELECT id FROM social_accounts WHERE id = ? AND user_id = ?').get(accountId, req.user.id);
    validAccountId = acct ? accountId : null;
  }

  // Normalize status. Only accept known values; default to 'scheduled' if
  // the frontend sent something unexpected or nothing at all. 'draft' is
  // important for the save-as-draft path — scheduler ignores drafts.
  const allowedStatuses = ['scheduled', 'draft', 'posting', 'posted', 'failed'];
  const finalStatus = allowedStatuses.includes(status) ? status : 'scheduled';

  // Normalize post_type. Only 'feed' or 'story' are meaningful; anything
  // else is treated as 'feed'.
  const finalPostType = (post_type === 'story') ? 'story' : 'feed';
  // also_share_to_story is a boolean from the frontend (true/false) or a
  // 0/1 integer. Coerce to 0/1 for the INTEGER column.
  const finalAlsoShare = (also_share_to_story === true || also_share_to_story === 1 || also_share_to_story === '1') ? 1 : 0;

  db.prepare(`
    INSERT INTO posts (
      id, user_id, account_id, caption, hashtags, media_url, media_type,
      platforms, scheduled_time, status, created_at, updated_at,
      post_type, also_share_to_story
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.user.id, validAccountId, caption,
    typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags || []),
    mediaUrl || null, mediaType || null,
    typeof platforms === 'string' ? platforms : JSON.stringify(platforms || []),
    scheduledMs,
    finalStatus,
    now, now,
    finalPostType,
    finalAlsoShare,
  );
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.json({ post: deserializePost(post) });
});

// — PATCH /posts/:id —
router.patch('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const {
    caption, scheduledTime, status,
    // Allow editing Instagram post-type after creation (e.g. user changes
    // their mind and wants the draft to become a Story instead of a Reel).
    post_type, also_share_to_story,
    // Also allow swapping media on edit. Useful when "edit draft" lets the
    // user pick a different file before publishing.
    mediaUrl, mediaType,
  } = req.body;
  const now = Date.now();
  // Store scheduled_time in MILLISECONDS to match scheduler comparison
  const scheduledMs = scheduledTime ? new Date(scheduledTime).getTime() : null;

  // Normalize the same way POST does. Only update post_type / also_share_to_story
  // if the field was explicitly sent in the body — leave it alone otherwise so
  // we don't accidentally clobber a previously-set value when the frontend
  // omits the field.
  const updatePostType = ('post_type' in req.body)
    ? ((post_type === 'story') ? 'story' : 'feed')
    : null; // null → COALESCE keeps existing value
  const updateAlsoShare = ('also_share_to_story' in req.body)
    ? ((also_share_to_story === true || also_share_to_story === 1 || also_share_to_story === '1') ? 1 : 0)
    : null;

  db.prepare(`
    UPDATE posts SET
      caption = COALESCE(?, caption),
      scheduled_time = COALESCE(?, scheduled_time),
      status = COALESCE(?, status),
      media_url = COALESCE(?, media_url),
      media_type = COALESCE(?, media_type),
      post_type = COALESCE(?, post_type),
      also_share_to_story = COALESCE(?, also_share_to_story),
      updated_at = ?
    WHERE id = ?
  `).run(
    caption || null,
    scheduledMs,
    status || null,
    mediaUrl || null,
    mediaType || null,
    updatePostType,
    updateAlsoShare,
    now,
    req.params.id
  );
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  res.json({ post: deserializePost(updated) });
});

// — DELETE /posts/:id —
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

function deserializePost(p) {
  return {
    ...p,
    hashtags: JSON.parse(p.hashtags || '[]'),
    platforms: JSON.parse(p.platforms || '[]'),
    // scheduled_time is now stored in ms, convert directly to ISO
    scheduledTime: p.scheduled_time ? new Date(p.scheduled_time).toISOString() : null,
    // expose error_message so the frontend can show what went wrong
    errorMessage: p.error_message || null,
    // Surface Instagram post-type fields so the frontend can show a Story
    // badge or "Reel + Story" indicator on cards. Coerce INTEGER → boolean
    // for cleaner JS consumption.
    post_type: p.post_type || 'feed',
    also_share_to_story: !!p.also_share_to_story,
  };
}

module.exports = router;
