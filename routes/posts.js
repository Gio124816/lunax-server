const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();

// Resolves the effective "owner" id — a team member's own row has no posts
// or connected accounts of its own; they act on behalf of whoever they're a
// team member of. See routes/team.js for the full model. Every route below
// needs this: not just to create posts under the shared account, but so a
// team member can still edit/delete/status-update a post afterward — those
// checks previously matched on req.user.id directly, which would have
// locked a team member out of their own just-created post.
function _resolveOwnerId(userId) {
  const row = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(userId);
  return row && row.team_owner_id ? row.team_owner_id : userId;
}

// — GET /posts —
router.get('/', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
  const posts = db.prepare(`
    SELECT * FROM posts WHERE user_id = ?
    ORDER BY scheduled_time DESC LIMIT 100
  `).all(ownerId);
  res.json({ posts: posts.map(deserializePost) });
});

// — POST /posts —
router.post('/', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
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

  // Validate accountId against the OWNER's connected accounts — a team
  // member has none of their own; they're posting on behalf of the shared
  // team's connections. If it doesn't exist there either, use null to avoid
  // an FK constraint error.
  let validAccountId = null;
  if (accountId) {
    const acct = db.prepare('SELECT id FROM social_accounts WHERE id = ? AND user_id = ?').get(accountId, ownerId);
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
    id, ownerId, validAccountId, caption,
    typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags || []),
    mediaUrl || null, mediaType || null,
    typeof platforms === 'string' ? platforms : JSON.stringify(platforms || []),
    scheduledMs,
    finalStatus,
    now, now,
    finalPostType,
    finalAlsoShare,
  );

  // Attribution — records which real team member actually created/scheduled
  // this post, the same way comment replies are attributed. Non-fatal: the
  // post already saved successfully either way.
  try {
    db.prepare(`
      INSERT INTO action_attributions (id, team_owner_id, acted_by_id, action_type, target_id, created_at)
      VALUES (?, ?, ?, 'post_created', ?, ?)
    `).run(uuidv4(), ownerId, req.user.id, id, now);
  } catch (attrErr) {
    console.error('[Posts] Failed to log post attribution:', attrErr.message);
  }

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.json({ post: deserializePost(post) });
});

// — PATCH /posts/:id/status — lightweight status-only update (used by Swift after publish)
router.patch('/:id/status', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const { status, mediaUrl, mediaType, igPostId, fbPostId } = req.body;
  const allowedStatuses = ['scheduled', 'draft', 'posting', 'posted', 'failed'];
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  // Analytics and Posted Content both key off posted_at + ig_post_id/fb_post_id —
  // this route accepted a status change but never stamped any of the three,
  // so a post could flip to 'posted' here and still never show up anywhere
  // that reads posted_at. Stamp it the moment status actually becomes 'posted'.
  const isNowPosted = status === 'posted' && post.status !== 'posted';

  db.prepare(`
    UPDATE posts SET
      status = ?,
      media_url = COALESCE(?, media_url),
      media_type = COALESCE(?, media_type),
      ig_post_id = COALESCE(?, ig_post_id),
      fb_post_id = COALESCE(?, fb_post_id),
      posted_at = COALESCE(posted_at, ?),
      updated_at = ?
    WHERE id = ?
  `).run(
    status,
    mediaUrl || null,
    mediaType || null,
    igPostId || null,
    fbPostId || null,
    isNowPosted ? Date.now() : null,
    Date.now(),
    req.params.id
  );
  res.json({ success: true });
});

// — PATCH /posts/:id —
router.patch('/:id', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
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
  const ownerId = _resolveOwnerId(req.user.id);
  db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, ownerId);
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
