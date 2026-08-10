const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');
const { getAllowedGroupIds } = require('./team');

const router = express.Router();

// Ungrouped accounts stay accessible to everyone (no client label to
// restrict) — same rule as accounts.js's _isGroupAccessible.
function _isGroupAccessible(userId, groupId) {
  if (!groupId) return true;
  const allowed = getAllowedGroupIds(userId);
  return allowed === null || allowed.includes(groupId);
}

// A post is accessible if EVERY account it's tied to is — its primary
// account_id (single-account posts) and every social_accounts row linked
// via post_targets (mass-posts). Conservative on purpose: if a mass-post
// spans both an allowed and a restricted-away client, the whole post stays
// hidden from a restricted member rather than partially showing captions/
// schedule info that touches an excluded client at all. A post tied to no
// account anywhere (no account_id, no targets) has nothing to check against
// and is treated as accessible.
function _postIsAccessible(userId, post) {
  const allowed = getAllowedGroupIds(userId);
  if (allowed === null) return true; // unrestricted — sees everything, unchanged default

  if (post.account_id) {
    const acct = db.prepare(`SELECT group_id FROM social_accounts WHERE id = ?`).get(post.account_id);
    if (acct && !_isGroupAccessible(userId, acct.group_id)) return false;
  }

  const targets = db.prepare(`
    SELECT sa.group_id FROM post_targets pt
    JOIN social_accounts sa ON sa.id = pt.social_account_id
    WHERE pt.post_id = ?
  `).all(post.id);
  for (const t of targets) {
    if (!_isGroupAccessible(userId, t.group_id)) return false;
  }

  return true;
}

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
  const visible = posts.filter(p => _postIsAccessible(req.user.id, p));
  res.json({ posts: visible.map(deserializePost) });
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
    // Mass-posting: explicit list of social_accounts ids to publish this
    // same content to (e.g. "post this clip to all my gaming accounts").
    // Optional — omitting it (or sending an empty array) preserves the
    // original single-account-per-platform behavior untouched.
    accountIds,
  } = req.body;
  const id = uuidv4();
  const now = Date.now();
  const scheduledMs = scheduledTime ? new Date(scheduledTime).getTime() : null;

  // Validate accountId against the OWNER's connected accounts — a team
  // member has none of their own; they're posting on behalf of the shared
  // team's connections. If it doesn't exist there either, use null to avoid
  // an FK constraint error. Also enforced here (not just filtered out of
  // GET /posts): a restricted member could otherwise still successfully
  // PUBLISH to an excluded client's account even though they'd never see it
  // in their own list afterward — this is the actual gate, the list
  // filtering elsewhere is just display-level on top of it.
  let validAccountId = null;
  if (accountId) {
    const acct = db.prepare('SELECT id, group_id FROM social_accounts WHERE id = ? AND user_id = ?').get(accountId, ownerId);
    validAccountId = (acct && _isGroupAccessible(req.user.id, acct.group_id)) ? accountId : null;
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

  // Mass-posting: validate each requested account belongs to this owner AND
  // is accessible to this specific caller — a restricted team member gets
  // any excluded-client account silently dropped from the target list here,
  // the same way an id from the wrong owner already was, rather than a
  // separate error path that would reveal the excluded account even exists.
  if (Array.isArray(accountIds) && accountIds.length > 0) {
    const candidateAccounts = db.prepare(`
      SELECT id, group_id FROM social_accounts WHERE user_id = ? AND id IN (${accountIds.map(() => '?').join(',')})
    `).all(ownerId, ...accountIds);
    const validAccounts = candidateAccounts.filter(a => _isGroupAccessible(req.user.id, a.group_id));
    validAccounts.forEach(a => {
      db.prepare(`
        INSERT INTO post_targets (id, post_id, social_account_id, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(uuidv4(), id, a.id, now);
    });
  }

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.json({ post: deserializePost(post) });
});

// — PATCH /posts/:id/status — lightweight status-only update (used by Swift after publish)
router.patch('/:id/status', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!_postIsAccessible(req.user.id, post)) return res.status(404).json({ error: 'Post not found' });
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
  if (!_postIsAccessible(req.user.id, post)) return res.status(404).json({ error: 'Post not found' });
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

// — GET /posts/:id/targets — per-account publish results for a mass-posted item
router.get('/:id/targets', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
  const post = db.prepare('SELECT id, account_id FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!_postIsAccessible(req.user.id, post)) return res.status(404).json({ error: 'Post not found' });
  const targets = db.prepare(`
    SELECT pt.*, sa.platform, sa.account_name, sa.account_handle
    FROM post_targets pt
    JOIN social_accounts sa ON sa.id = pt.social_account_id
    WHERE pt.post_id = ?
    ORDER BY sa.platform, sa.account_name
  `).all(req.params.id);
  res.json({
    targets: targets.map(t => ({
      id: t.id,
      accountId: t.social_account_id,
      platform: t.platform,
      accountName: t.account_name,
      accountHandle: t.account_handle,
      status: t.status,
      platformPostId: t.platform_post_id,
      errorMessage: t.error_message,
      postedAt: t.posted_at,
    })),
  });
});

// — DELETE /posts/:id —
router.delete('/:id', requireAuth, (req, res) => {
  const ownerId = _resolveOwnerId(req.user.id);
  const post = db.prepare('SELECT id, account_id FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!_postIsAccessible(req.user.id, post)) return res.status(404).json({ error: 'Post not found' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
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
