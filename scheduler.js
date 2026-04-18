const cron = require('node-cron');
const fetch = require('node-fetch');
const db = require('../db/database');

const API_BASE = 'https://graph.facebook.com/v20.0';

async function metaPost(path, token, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function publishPost(post, user) {
  const token = user.meta_access_token;
  const platforms = JSON.parse(post.platforms || '[]');
  const hashtags = JSON.parse(post.hashtags || '[]');
  const caption = post.caption + (hashtags.length ? '\n\n' + hashtags.map(h => '#' + h).join(' ') : '');
  const results = [];
  const errors = [];

  // Get page token
  const pageAcct = db.prepare('SELECT * FROM user_accounts WHERE user_id = ? AND type = "page" LIMIT 1').get(user.id);
  const pageToken = pageAcct?.access_token || token;
  const pageId = pageAcct?.account_id;
  const igId = pageAcct?.instagram_id;

  if (platforms.includes('Instagram') && igId) {
    try {
      let creationId;
      if (post.media_url && post.media_type === 'video') {
        const r = await metaPost(`/${igId}/media`, token, { media_type: 'REELS', video_url: post.media_url, caption });
        creationId = r.id;
        // Wait for video processing
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const res = await fetch(`${API_BASE}/${creationId}?fields=status_code&access_token=${token}`);
          const s = await res.json();
          if (s.status_code === 'FINISHED') break;
          if (s.status_code === 'ERROR') throw new Error('Video processing failed');
        }
      } else if (post.media_url && post.media_type === 'image') {
        const r = await metaPost(`/${igId}/media`, token, { image_url: post.media_url, caption });
        creationId = r.id;
      }
      if (creationId) {
        await metaPost(`/${igId}/media_publish`, token, { creation_id: creationId });
        results.push('Instagram');
      }
    } catch (e) { errors.push(`Instagram: ${e.message}`); }
  }

  if (platforms.includes('Facebook') && pageId) {
    try {
      if (post.media_url && post.media_type === 'video') {
        await metaPost(`/${pageId}/videos`, pageToken, { file_url: post.media_url, description: caption });
      } else if (post.media_url && post.media_type === 'image') {
        await metaPost(`/${pageId}/photos`, pageToken, { url: post.media_url, caption });
      } else {
        await metaPost(`/${pageId}/feed`, pageToken, { message: caption });
      }
      results.push('Facebook');
    } catch (e) { errors.push(`Facebook: ${e.message}`); }
  }

  return { results, errors };
}

function startScheduler() {
  // Run every minute — check for posts due in the next 60 seconds
  cron.schedule('* * * * *', async () => {
    const now = Math.floor(Date.now() / 1000);
    const due = db.prepare(`
      SELECT sp.*, u.meta_access_token, u.id as uid
      FROM scheduled_posts sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.status = 'scheduled'
        AND sp.scheduled_time <= ?
        AND sp.scheduled_time > ? - 120
    `).all(now, now);

    for (const post of due) {
      console.log(`[Scheduler] Publishing post ${post.id} for user ${post.uid}`);
      // Mark as posting immediately to prevent double-publish
      db.prepare("UPDATE scheduled_posts SET status = 'posting' WHERE id = ?").run(post.id);
      try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(post.uid);
        const { results, errors } = await publishPost(post, user);
        if (errors.length && !results.length) {
          db.prepare("UPDATE scheduled_posts SET status = 'failed', error = ?, published_at = unixepoch() WHERE id = ?")
            .run(errors.join('; '), post.id);
          console.error(`[Scheduler] Post ${post.id} failed:`, errors);
        } else {
          db.prepare("UPDATE scheduled_posts SET status = 'posted', published_at = unixepoch(), error = ? WHERE id = ?")
            .run(errors.length ? errors.join('; ') : null, post.id);
          console.log(`[Scheduler] Post ${post.id} published to: ${results.join(', ')}`);
        }
      } catch (e) {
        db.prepare("UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?").run(e.message, post.id);
        console.error(`[Scheduler] Post ${post.id} error:`, e.message);
      }
    }
  });

  console.log('[Scheduler] Started — checking every minute for due posts');
}

module.exports = { startScheduler };
