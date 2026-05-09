const cron = require('node-cron');
const fetch = require('node-fetch');
const db = require('../db/database');

const API_BASE = 'https://graph.facebook.com/v20.0';
const GRAPH_VIDEO_BASE = 'https://graph-video.facebook.com/v20.0';
const BACKEND_URL = process.env.BACKEND_URL || 'https://lunax-server-production.up.railway.app';

const MAX_RETRIES = 3; // give up after 3 attempts

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

// Correct Facebook Resumable Upload API per Meta docs:
// https://developers.facebook.com/docs/video-api/guides/publishing
async function uploadVideoToFacebook(videoUrl, pageId, pageToken, userToken) {
  const appId = process.env.META_APP_ID;
  console.log(`[Scheduler] Starting Facebook Resumable Upload for page ${pageId}...`);

  // Step 1: Download video from S3
  const videoRes = await fetch(videoUrl);
  const videoBuffer = await videoRes.buffer();
  const fileSize = videoBuffer.length;
  console.log(`[Scheduler] Video size: ${fileSize} bytes`);

  // Step 2: Start upload session with USER token + APP_ID
  const sessionRes = await fetch(
    `https://graph.facebook.com/v20.0/${appId}/uploads?file_name=video.mp4&file_length=${fileSize}&file_type=video/mp4&access_token=${userToken}`,
    { method: 'POST' }
  );
  const sessionData = await sessionRes.json();
  if (sessionData.error) throw new Error(`Upload session failed: ${sessionData.error.message}`);
  const uploadSessionId = sessionData.id; // format: "upload:abc123"
  console.log(`[Scheduler] Upload session created: ${uploadSessionId}`);

  // Step 3: Upload raw file binary with USER token in header
  const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${uploadSessionId}`, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${userToken}`,
      'file_offset': '0',
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize),
    },
    body: videoBuffer,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.error) throw new Error(`Upload failed: ${uploadData.error.message}`);
  const fileHandle = uploadData.h;
  if (!fileHandle) throw new Error('No file handle returned from upload');
  console.log(`[Scheduler] File handle received: ${fileHandle.substring(0, 20)}...`);

  // Step 4: Publish to page using PAGE token + file handle
  const publishRes = await fetch(`${GRAPH_VIDEO_BASE}/${pageId}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: pageToken,
      fbuploader_video_file_chunk: fileHandle,
    }),
  });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`Publish failed: ${publishData.error.message}`);
  console.log(`[Scheduler] Facebook video published. Video ID: ${publishData.id}`);
  return publishData.id;
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

  // ── Instagram ──────────────────────────────────────────────────────────────
  if (platforms.includes('Instagram') && igId) {
    try {
      let creationId;
      if (post.media_url && post.media_type === 'video') {
        console.log(`[Scheduler] Uploading video to Instagram for post ${post.id}...`);
        const r = await metaPost(`/${igId}/media`, token, {
          media_type: 'REELS', video_url: post.media_url, caption
        });
        creationId = r.id;
        console.log(`[Scheduler] IG container created: ${creationId}, waiting for processing...`);
        let ready = false;
        // 40 checks x 5 seconds = 200 seconds max
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const s = await fetch(`${API_BASE}/${creationId}?fields=status_code&access_token=${token}`).then(r => r.json());
          console.log(`[Scheduler] Video status check ${i + 1}: ${s.status_code}`);
          if (s.status_code === 'FINISHED') { ready = true; break; }
          if (s.status_code === 'ERROR') throw new Error('Video processing failed on Meta');
        }
        if (!ready) throw new Error('Video processing timed out after 200s');
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

  // ── Facebook ───────────────────────────────────────────────────────────────
  if (platforms.includes('Facebook') && pageId) {
    try {
      if (post.media_url && post.media_type === 'video') {
        // Use correct Resumable Upload API — user token for upload, page token for publish
        const videoId = await uploadVideoToFacebook(post.media_url, pageId, pageToken, token);
        // Set description on the published video
        await fetch(`${API_BASE}/${videoId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: caption, access_token: pageToken }),
        });
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

// ── RE-QUEUE ON STARTUP ────────────────────────────────────────────────────
// Called once when Railway restarts — re-schedules any posts that were
// scheduled or stuck in 'posting' status and haven't been published yet.
function requeueMissedPosts() {
  const now = Date.now();

  // Recover posts stuck in 'posting' (Railway died mid-publish) — reset to scheduled
  // Only if they haven't expired (within last 10 minutes)
  const stuck = db.prepare(`
    SELECT id, scheduled_time, caption FROM posts
    WHERE status = 'posting'
      AND scheduled_time > ? - 600000
  `).all(now);

  for (const post of stuck) {
    console.log(`[Scheduler] Recovering stuck post ${post.id} (was 'posting') → reset to 'scheduled'`);
    db.prepare(`UPDATE posts SET status = 'scheduled' WHERE id = ?`).run(post.id);
  }

  // Log upcoming scheduled posts so we know what's in the queue
  const upcoming = db.prepare(`
    SELECT id, scheduled_time, caption FROM posts
    WHERE status = 'scheduled' AND scheduled_time > ?
    ORDER BY scheduled_time ASC
  `).all(now);

  if (upcoming.length > 0) {
    console.log(`[Scheduler] ${upcoming.length} post(s) in queue after restart:`);
    for (const p of upcoming) {
      const inMs = p.scheduled_time - now;
      console.log(`  Post ${p.id}: fires in ${Math.round(inMs / 60000)}min — "${p.caption?.substring(0, 40)}..."`);
    }
  } else {
    console.log('[Scheduler] No upcoming posts in queue after restart.');
  }
}

function startScheduler() {
  // Re-queue missed posts immediately on startup
  requeueMissedPosts();

  cron.schedule('* * * * *', async () => {
    const now = Date.now();

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
      // Enforce max retry count
      const retryCount = post.retry_count || 0;
      if (retryCount >= MAX_RETRIES) {
        console.log(`[Scheduler] Post ${post.id} has hit max retries (${MAX_RETRIES}) — marking as failed`);
        db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`)
          .run(`Max retries (${MAX_RETRIES}) exceeded`, post.id);
        continue;
      }

      console.log(`[Scheduler] Publishing post ${post.id} (scheduled_time=${post.scheduled_time}, now=${now}, attempt=${retryCount + 1})`);
      db.prepare("UPDATE posts SET status = 'posting' WHERE id = ?").run(post.id);

      try {
        const user = db.prepare(`
          SELECT id, meta_access_token, meta_ig_id, meta_page_id, meta_page_token, name
          FROM users WHERE id = ?
        `).get(post.uid);

        const { results, errors } = await publishPost(post, user);
        const platforms = JSON.parse(post.platforms || '[]');

        if (results.length > 0 && errors.length === 0) {
          db.prepare("UPDATE posts SET status = 'posted', posted_at = ?, error_message = NULL, retry_count = 0 WHERE id = ?")
            .run(now, post.id);
          console.log(`[Scheduler] Post ${post.id} SUCCESS → published to: ${results.join(', ')}`);
          await notifyUser('post-success', post.uid, {
            caption: post.caption,
            platforms: results,
            scheduledTime: post.scheduled_time,
          });
        } else if (results.length > 0 && errors.length > 0) {
          // Partial success — posted somewhere, mark posted but record partial errors
          db.prepare("UPDATE posts SET status = 'posted', posted_at = ?, error_message = ?, retry_count = 0 WHERE id = ?")
            .run(now, errors.join('; '), post.id);
          console.log(`[Scheduler] Post ${post.id} PARTIAL: ${results.join(', ')} OK | errors: ${errors.join('; ')}`);
          await notifyUser('post-failed', post.uid, {
            caption: post.caption,
            platforms,
            error: `Partial failure — ${errors.join('; ')}`,
          });
        } else {
          // Full failure — increment retry count and reschedule in 5 minutes if under max
          const newRetryCount = retryCount + 1;
          if (newRetryCount < MAX_RETRIES) {
            const retryTime = now + 5 * 60 * 1000; // retry in 5 minutes
            db.prepare("UPDATE posts SET status = 'scheduled', scheduled_time = ?, error_message = ?, retry_count = ? WHERE id = ?")
              .run(retryTime, errors.join('; '), newRetryCount, post.id);
            console.log(`[Scheduler] Post ${post.id} FAILED (attempt ${newRetryCount}/${MAX_RETRIES}) — retrying in 5 min. Error: ${errors.join('; ')}`);
          } else {
            db.prepare("UPDATE posts SET status = 'failed', error_message = ?, retry_count = ? WHERE id = ?")
              .run(errors.join('; '), newRetryCount, post.id);
            console.error(`[Scheduler] Post ${post.id} PERMANENTLY FAILED after ${newRetryCount} attempts:`, errors.join('; '));
            await notifyUser('post-failed', post.uid, {
              caption: post.caption,
              platforms,
              error: errors.join('; '),
            });
          }
        }
      } catch (e) {
        const newRetryCount = (post.retry_count || 0) + 1;
        if (newRetryCount < MAX_RETRIES) {
          const retryTime = now + 5 * 60 * 1000;
          db.prepare("UPDATE posts SET status = 'scheduled', scheduled_time = ?, error_message = ?, retry_count = ? WHERE id = ?")
            .run(retryTime, e.message, newRetryCount, post.id);
          console.error(`[Scheduler] Post ${post.id} EXCEPTION (attempt ${newRetryCount}/${MAX_RETRIES}) — retrying in 5 min:`, e.message);
        } else {
          db.prepare("UPDATE posts SET status = 'failed', error_message = ?, retry_count = ? WHERE id = ?")
            .run(e.message, newRetryCount, post.id);
          console.error(`[Scheduler] Post ${post.id} PERMANENTLY FAILED:`, e.message);
          try {
            await notifyUser('post-failed', post.uid, {
              caption: post.caption,
              platforms: JSON.parse(post.platforms || '[]'),
              error: e.message,
            });
          } catch (_) {}
        }
      }
    }
  });

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
