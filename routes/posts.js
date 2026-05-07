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
  const { caption, hashtags, mediaUrl, mediaType, platforms, scheduledTime, accountId } = req.body;
  const id = uuidv4();
  const now = Date.now();
  // Store scheduled_time in MILLISECONDS (13 digits) to match scheduler comparison
  const scheduledMs = scheduledTime ? new Date(scheduledTime).getTime() : null;
  db.prepare(`
    INSERT INTO posts (id, user_id, account_id, caption, hashtags, media_url, media_type, platforms, scheduled_time, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `).run(
    id, req.user.id, accountId || null, caption,
    typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags || []),
    mediaUrl || null, mediaType || null,
    typeof platforms === 'string' ? platforms : JSON.stringify(platforms || []),
    scheduledMs,
    now, now
  );
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.json({ post: deserializePost(post) });
});

// — PATCH /posts/:id —
router.patch('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const { caption, scheduledTime, status } = req.body;
  const now = Date.now();
  // Store scheduled_time in MILLISECONDS to match scheduler comparison
  const scheduledMs = scheduledTime ? new Date(scheduledTime).getTime() : null;
  db.prepare(`
    UPDATE posts SET
      caption = COALESCE(?, caption),
      scheduled_time = COALESCE(?, scheduled_time),
      status = COALESCE(?, status),
      updated_at = ?
    WHERE id = ?
  `).run(
    caption || null,
    scheduledMs,
    status || null,
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
  };
}

module.exports = router;
