const cron = require('node-cron');
const fetch = require('node-fetch');
const db = require('../db/database');
const { postToTikTok } = require('./tiktok');
const { postToYouTube } = require('./youtube');
const { postToLinkedIn } = require('./linkedin');

// ── DB MIGRATION — add LinkedIn columns if not exist ─────────────────────
const linkedinCols = [
  'linkedin_access_token TEXT',
  'linkedin_refresh_token TEXT',
  'linkedin_token_expires_at INTEGER',
  'linkedin_person_id TEXT',
  'linkedin_name TEXT',
  'linkedin_avatar_url TEXT',
];
for (const col of linkedinCols) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); console.log('Migration: added ' + col.split(' ')[0]); } catch(e) {}
}

// ── DB MIGRATION — add TikTok columns if not exist ────────────────────────
const youtubeCols = [
  'youtube_access_token TEXT',
  'youtube_refresh_token TEXT',
  'youtube_token_expires_at INTEGER',
  'youtube_channel_id TEXT',
  'youtube_channel_name TEXT',
  'youtube_channel_avatar TEXT',
];
for (const col of youtubeCols) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch(e) {}
}

const tiktokCols = [
  'tiktok_open_id TEXT',
  'tiktok_access_token TEXT',
  'tiktok_refresh_token TEXT',
  'tiktok_token_expires_at INTEGER',
  'tiktok_display_name TEXT',
  'tiktok_avatar_url TEXT',
];
for (const col of tiktokCols) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch(e) {}
}

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
             u.tiktok_access_token, u.tiktok_refresh_token, u.tiktok_token_expires_at,
             u.tiktok_open_id, u.tiktok_display_name,
             u.youtube_access_token, u.youtube_refresh_token, u.youtube_token_expires_at,
             u.linkedin_access_token, u.linkedin_person_id, u.linkedin_name,
             u.id as uid, u.name as user_name, p.user_id as post_user_id
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
        // Use user data from JOIN result — avoid second lookup that can miss tokens
        const user = {
          id: post.uid || post.user_id,
          meta_access_token: post.meta_access_token,
          meta_ig_id: post.meta_ig_id,
          meta_page_id: post.meta_page_id,
          meta_page_token: post.meta_page_token,
          tiktok_access_token: post.tiktok_access_token,
          tiktok_refresh_token: post.tiktok_refresh_token,
          tiktok_token_expires_at: post.tiktok_token_expires_at,
          tiktok_open_id: post.tiktok_open_id,
          youtube_access_token: post.youtube_access_token,
          youtube_refresh_token: post.youtube_refresh_token,
          youtube_token_expires_at: post.youtube_token_expires_at,
          linkedin_access_token: post.linkedin_access_token,
          linkedin_person_id: post.linkedin_person_id,
          linkedin_name: post.linkedin_name,
          name: post.user_name
        };

        // If token still missing, try a fresh lookup
        if (!user.meta_access_token) {
          const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(post.post_user_id || post.user_id);
          if (freshUser?.meta_access_token) {
            user.meta_access_token = freshUser.meta_access_token;
            user.meta_ig_id = freshUser.meta_ig_id;
            user.meta_page_id = freshUser.meta_page_id;
            user.meta_page_token = freshUser.meta_page_token;
          }
        }

        const { results, errors } = await publishPost(post, user);
        const platforms = JSON.parse(post.platforms || '[]');

        // ── YouTube posting ────────────────────────────────────────────────
        if (platforms.includes('YouTube') && user.youtube_access_token) {
          try {
            const ytResult = await postToYouTube(post, user);
            results.push('YouTube');
            console.log(`[Scheduler] YouTube post success: ${ytResult.url}`);
          } catch (ytErr) {
            console.error(`[Scheduler] YouTube post failed for post ${post.id}:`, ytErr.message);
            errors.push(`YouTube: ${ytErr.message}`);
          }
        }

        
        // ── LinkedIn posting ───────────────────────────────────────────────
        if (platforms.includes('LinkedIn') && user.linkedin_access_token) {
          try {
            const liResult = await postToLinkedIn(post, user);
            results.push('LinkedIn');
            console.log(`[Scheduler] LinkedIn post success: ${liResult.postId}`);
          } catch (liErr) {
            console.error(`[Scheduler] LinkedIn post failed for post ${post.id}:`, liErr.message);
            errors.push(`LinkedIn: ${liErr.message}`);
          }
        }

        // ── TikTok posting ─────────────────────────────────────────────────
        if (platforms.includes('TikTok') && user.tiktok_access_token) {
          try {
            await postToTikTok(post, user);
            results.push('TikTok');
            console.log(`[Scheduler] TikTok post success for post ${post.id}`);
          } catch (ttErr) {
            console.error(`[Scheduler] TikTok post failed for post ${post.id}:`, ttErr.message);
            errors.push(`TikTok: ${ttErr.message}`);
          }
        }

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

  // Daily report — 6am every day
  cron.schedule('0 6 * * *', async () => {
    console.log('[Scheduler] Sending daily reports...');
    try {
      await fetch(`${BACKEND_URL}/notifications/daily`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch(e) {
      console.error('[Scheduler] Daily report error:', e.message);
    }
  });

  // Monthly report — 8am on 1st of every month
  cron.schedule('0 8 1 * *', async () => {
    console.log('[Scheduler] Sending monthly reports...');
    try {
      await fetch(`${BACKEND_URL}/notifications/monthly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch(e) {
      console.error('[Scheduler] Monthly report error:', e.message);
    }
  });

  // Meta token refresh check — runs daily at 7am
  // Refreshes tokens expiring within 7 days, alerts user if expiring within 14 days
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] Checking Meta token expiry...');
    try {
      const users = db.prepare(`
        SELECT id, name, meta_access_token, notif_email, email
        FROM users WHERE meta_access_token IS NOT NULL AND deleted_at IS NULL
      `).all();

      for (const user of users) {
        try {
          // Check token expiry by calling Graph API debug endpoint
          const debugRes = await fetch(
            `https://graph.facebook.com/debug_token?input_token=${user.meta_access_token}&access_token=${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
          );
          const debugData = await debugRes.json();
          const expiresAt = debugData.data?.expires_at; // Unix timestamp, 0 = never expires

          if (!expiresAt || expiresAt === 0) {
            console.log(`[Scheduler] User ${user.id}: token never expires (long-lived) — skipping`);
            continue;
          }

          const expiryMs = expiresAt * 1000;
          const daysLeft = Math.floor((expiryMs - Date.now()) / 86400000);
          console.log(`[Scheduler] User ${user.id}: Meta token expires in ${daysLeft} days`);

          if (daysLeft <= 0) {
            // Token already expired — mark it
            db.prepare("UPDATE users SET meta_access_token = NULL WHERE id = ?").run(user.id);
            console.log(`[Scheduler] User ${user.id}: token expired — cleared`);
            await fetch(`${BACKEND_URL}/notifications/token-expiry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: user.id, daysLeft: 0 }),
            });
          } else if (daysLeft <= 7) {
            // Within 7 days — try to refresh automatically
            try {
              const refreshRes = await fetch(
                `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${user.meta_access_token}`
              );
              const refreshData = await refreshRes.json();
              if (refreshData.access_token) {
                db.prepare("UPDATE users SET meta_access_token = ?, updated_at = ? WHERE id = ?")
                  .run(refreshData.access_token, Date.now(), user.id);
                console.log(`[Scheduler] User ${user.id}: Meta token refreshed successfully`);
              } else {
                throw new Error(refreshData.error?.message || 'No token returned');
              }
            } catch(refreshErr) {
              console.error(`[Scheduler] User ${user.id}: token refresh failed:`, refreshErr.message);
              // Notify user to reconnect manually
              await fetch(`${BACKEND_URL}/notifications/token-expiry`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: user.id, daysLeft }),
              });
            }
          } else if (daysLeft <= 14) {
            // Between 7-14 days — warn user but don't refresh yet
            await fetch(`${BACKEND_URL}/notifications/token-expiry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: user.id, daysLeft }),
            });
          }
        } catch(e) {
          console.error(`[Scheduler] Token check failed for user ${user.id}:`, e.message);
        }
      }
    } catch(e) {
      console.error('[Scheduler] Token refresh cron error:', e.message);
    }
  });

  console.log('[Scheduler] Started — checking every minute for due posts');
  console.log('[Scheduler] Daily reports: 6am | Weekly reports: Monday 8am | Monthly: 1st of month 8am');
  console.log('[Scheduler] Meta token refresh check: daily at 7am');
}

module.exports = { startScheduler };
