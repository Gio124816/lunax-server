const cron = require('node-cron');
const fetch = require('node-fetch');
const db = require('../db/database');

const API_BASE = 'https://graph.facebook.com/v20.0';
const BACKEND_URL = process.env.BACKEND_URL || 'https://lunax-server-production.up.railway.app';

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

async function notifyUser(type, userId, payload) {
  try {
    await fetch(`${BACKEND_URL}/notifications/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...payload }),
    });
  } catch (e) {
    console.error(`[Scheduler] Failed to send ${type} notification:`, e.message);
  }
}

async function publishPost(post, user) {
  const token = user.meta_access_token;
  if (!token) throw new Error('No Meta access token for user');

  const platforms = JSON.parse(post.platforms || '[]');
  const hashtags = JSON.parse(post.hashtags || '[]');
  const caption = post.caption + (hashtags.length ? '\n\n' + hashtags.map(h => '#' + h).join(' ') : '');
  const results = [];
  const errors = [];

  const igId = user.meta_ig_id;
  const pageId = user.meta_page_id;
  const pageToken = user.meta_page_token || token;

  if (platforms.includes('Instagram') && igId) {
    try {
      let creationId;
      if (post.media_url && post.media_type === 'video') {
        console.log(`[Scheduler] Uploading video to Instagram for post ${post.id}...`);
        const r = await metaPost(`/${igId}/media`, token, {
          media_type: 'REELS', video_url: post.media_url, caption
        });
        creationId = r.id;
        console.log(`[Scheduler] Video container created: ${creationId}, waiting for processing...`);
        let ready = false;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const s = await fetch(`${API_BASE}/${creationId}?fields=status_code&access_token=${token}`).then(r => r.json());
          console.log(`[Scheduler] Video status check ${i + 1}: ${s.status_code}`);
          if (s.status_code === 'FINISHED') { ready = true; break; }
          if (s.status_code === 'ERROR') throw new Error('Video processing failed on Meta');
        }
        if (!ready) throw new Error('Video processing timed out after 60s');
      } else if (post.media_url && post.media_type === 'image') {
        const r = await metaPost(`/${igId}/media`, token, { image_url: post.media_url, caption });
        creationId = r.id;
      }
      if (creationId) {
        await metaPost(`/${igId}/media_publish`, token, { creation_id: creationId });
        results.push('Instagram');
        console.log(`[Scheduler] Instagram publish success for post ${post.id}`);
      }
    } catch (e) {
      console.error(`[Scheduler] Instagram error for post ${post.id}:`, e.message);
      errors.push(`Instagram: ${e.message}`);
    }
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
      console.log(`[Scheduler] Facebook publish success for post ${post.id}`);
    } catch (e) {
      console.error(`[Scheduler] Facebook error for post ${post.id}:`, e.message);
      errors.push(`Facebook: ${e.message}`);
    }
  }

  return { results, errors };
}

function startScheduler() {
  // ── Every minute: publish due posts ──
  cron.schedule('* * * * *', async () => {
    const now = Date.now();

    // Debug: log all scheduled posts every minute so we can see what's in the DB
    const allScheduled = db.prepare(`
      SELECT id, status, scheduled_time, caption
      FROM posts WHERE status = 'scheduled'
    `).all();

    if (allScheduled.length > 0) {
      console.log(`[Scheduler] Tick — now=${now} (${new Date(now).toISOString()}). Pending scheduled posts:`);
      for (const p of allScheduled) {
        const diff = p.scheduled_time - now;
        console.log(`  Post ${p.id}: scheduled_time=${p.scheduled_time}, diff=${diff}ms (${Math.round(diff/1000)}s), caption="${p.caption?.substring(0, 40)}..."`);
      }
    } else {
      console.log(`[Scheduler] Tick — now=${now}. No scheduled posts.`);
    }

    // Look for posts due in the past 5 minutes (300000ms window to catch missed ticks)
    const due = db.prepare(`
      SELECT p.*, u.meta_access_token, u.meta_ig_id, u.meta_page_id, u.meta_page_token,
             u.id as uid, u.name as user_name
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.status = 'scheduled'
        AND p.scheduled_time <= ?
        AND p.scheduled_time > ? - 300000
    `).all(now, now);

    for (const post of due) {
      console.log(`[Scheduler] Publishing post ${post.id} (scheduled_time=${post.scheduled_time}, now=${now})`);
      db.prepare("UPDATE posts SET status = 'posting' WHERE id = ?").run(post.id);

      try {
        const user = db.prepare(`
          SELECT id, meta_access_token, meta_ig_id, meta_page_id, meta_page_token, name
          FROM users WHERE id = ?
        `).get(post.uid);

        const { results, errors } = await publishPost(post, user);
        const platforms = JSON.parse(post.platforms || '[]');

        if (results.length > 0 && errors.length === 0) {
          db.prepare("UPDATE posts SET status = 'posted', posted_at = ?, error_message = NULL WHERE id = ?")
            .run(now, post.id);
          console.log(`[Scheduler] Post ${post.id} SUCCESS → published to: ${results.join(', ')}`);
          await notifyUser('post-success', post.uid, {
            caption: post.caption,
            platforms: results,
            scheduledTime: post.scheduled_time,
          });
        } else if (results.length > 0 && errors.length > 0) {
          db.prepare("UPDATE posts SET status = 'posted', posted_at = ?, error_message = ? WHERE id = ?")
            .run(now, errors.join('; '), post.id);
          console.log(`[Scheduler] Post ${post.id} PARTIAL: ${results.join(', ')} OK | errors: ${errors.join('; ')}`);
          await notifyUser('post-failed', post.uid, {
            caption: post.caption,
            platforms,
            error: `Partial failure — ${errors.join('; ')}`,
          });
        } else {
          db.prepare("UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?")
            .run(errors.join('; '), post.id);
          console.error(`[Scheduler] Post ${post.id} FAILED:`, errors.join('; '));
          await notifyUser('post-failed', post.uid, {
            caption: post.caption,
            platforms,
            error: errors.join('; '),
          });
        }
      } catch (e) {
        db.prepare("UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?")
          .run(e.message, post.id);
        console.error(`[Scheduler] Post ${post.id} EXCEPTION:`, e.message);
        try {
          await notifyUser('post-failed', post.uid, {
            caption: post.caption,
            platforms: JSON.parse(post.platforms || '[]'),
            error: e.message,
          });
        } catch (_) {}
      }
    }
  });

  // ── Every Monday at 8am: weekly summary emails ──
  cron.schedule('0 8 * * 1', async () => {
    console.log('[Scheduler] Sending weekly summary emails...');
    try {
      await fetch(`${BACKEND_URL}/notifications/weekly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch (e) {
      console.error('[Scheduler] Weekly email error:', e.message);
    }
  });

  console.log('[Scheduler] Started — checking every minute for due posts');
  console.log('[Scheduler] Weekly summaries scheduled for Monday 8am');
}

module.exports = { startScheduler };
