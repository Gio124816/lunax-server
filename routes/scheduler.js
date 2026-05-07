const cron = require('node-cron');
const fetch = require('node-fetch');
const db = require('../db/database');

const API_BASE = 'https://graph.facebook.com/v20.0';
const GRAPH_VIDEO_BASE = 'https://graph-video.facebook.com/v20.0';
const BACKEND_URL = process.env.BACKEND_URL || 'https://lunax-server-production.up.railway.app';

async function metaPost(path, token, body = {}, useVideoBase = false) {
  const base = useVideoBase ? GRAPH_VIDEO_BASE : API_BASE;
  const res = await fetch(`${base}${path}`, {
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

// Facebook Resumable Upload API for video
async function uploadVideoToFacebook(videoUrl, pageId, pageToken) {
  console.log(`[Scheduler] Starting Facebook resumable upload for page ${pageId}...`);

  const headRes = await fetch(videoUrl, { method: 'HEAD' });
  const fileSize = headRes.headers.get('content-length');
  if (!fileSize) throw new Error('Could not determine video file size from S3');
  console.log(`[Scheduler] Video file size: ${fileSize} bytes`);

  const startRes = await fetch(`${GRAPH_VIDEO_BASE}/${pageId}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_phase: 'start',
      file_size: parseInt(fileSize),
      access_token: pageToken,
    }),
  });
  const startData = await startRes.json();
  if (startData.error) throw new Error(`Upload start failed: ${startData.error.message}`);
  const { upload_session_id, video_id, start_offset, end_offset } = startData;
  console.log(`[Scheduler] Upload session started: ${upload_session_id}, video_id: ${video_id}`);

  const videoRes = await fetch(videoUrl);
  const videoBuffer = await videoRes.buffer();
  let currentStart = parseInt(start_offset);
  let currentEnd = parseInt(end_offset);

  const FormData = require('form-data');

  while (currentStart < videoBuffer.length) {
    const chunk = videoBuffer.slice(currentStart, currentEnd);
    console.log(`[Scheduler] Uploading chunk ${currentStart}-${currentEnd} of ${videoBuffer.length}...`);

    const formData = new FormData();
    formData.append('upload_phase', 'transfer');
    formData.append('upload_session_id', upload_session_id);
    formData.append('start_offset', String(currentStart));
    formData.append('video_file_chunk', chunk, { filename: 'video.mp4', contentType: 'video/mp4' });
    formData.append('access_token', pageToken);

    const transferRes = await fetch(`${GRAPH_VIDEO_BASE}/${pageId}/videos`, {
      method: 'POST',
      headers: formData.getHeaders(),
      body: formData,
    });
    const transferData = await transferRes.json();
    if (transferData.error) throw new Error(`Upload transfer failed: ${transferData.error.message}`);

    currentStart = parseInt(transferData.start_offset);
    currentEnd = parseInt(transferData.end_offset);
    if (currentStart === currentEnd) break;
  }

  console.log(`[Scheduler] Finishing upload session...`);
  const finishRes = await fetch(`${GRAPH_VIDEO_BASE}/${pageId}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_phase: 'finish',
      upload_session_id,
      access_token: pageToken,
    }),
  });
  const finishData = await finishRes.json();
  if (finishData.error) throw new Error(`Upload finish failed: ${finishData.error.message}`);
  console.log(`[Scheduler] Facebook video upload complete. Video ID: ${video_id}`);

  return video_id;
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
        // 40 checks x 5 seconds = 200 seconds max (up from 20x3=60s)
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const s = await fetch(`${API_BASE}/${creationId}?fields=status_code&access_token=${token}`).then(r => r.json());
          console.log(`[Scheduler] Video status check ${i + 1}: ${s.status_code}`);
          if (s.status_code === 'FINISHED') { ready = true; break; }
          if (s.status_code === 'ERROR') throw new Error('Video processing failed on Meta');
        }
        if (!ready) throw new Error('Video processing timed out after 200s — video may be too large or Meta is slow');
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
        // Facebook video requires Meta App Review approval for publish_video permission.
        // Until approved, video posts to Facebook pages are blocked by Meta at the API level.
        // Images and text posts work fine in the meantime.
        console.log(`[Scheduler] Facebook video blocked — publish_video permission pending Meta App Review`);
        throw new Error('Facebook video posting requires Meta App Review approval (pending). Images and text posts work fine. Please repost as an image or text, or wait for Meta approval.');
      } else if (post.media_url && post.media_type === 'image') {
        await metaPost(`/${pageId}/photos`, pageToken, { url: post.media_url, caption });
        results.push('Facebook');
        console.log(`[Scheduler] Facebook image publish success for post ${post.id}`);
      } else {
        await metaPost(`/${pageId}/feed`, pageToken, { message: caption });
        results.push('Facebook');
        console.log(`[Scheduler] Facebook text publish success for post ${post.id}`);
      }
    } catch (e) {
      console.error(`[Scheduler] Facebook error for post ${post.id}:`, e.message);
      errors.push(`Facebook: ${e.message}`);
    }
  }

  return { results, errors };
}

function startScheduler() {
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
