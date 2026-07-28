// ════════════════════════════════════════════════════════════════════════════
// routes/stream.js
// ════════════════════════════════════════════════════════════════════════════
// Handles everything stream-related on the MAIN backend:
//   GET  /stream/validate/:streamKey   — RTMP server calls this to auth a stream
//   POST /stream/started               — RTMP server notifies stream is live
//   POST /stream/ended                 — RTMP server notifies stream ended
//   POST /stream/clip                  — iOS app marks a clip moment
//   GET  /stream/key                   — user fetches their stream key
//   POST /stream/key/regenerate        — user regenerates their stream key
//   GET  /stream/sessions              — user's past stream sessions
//   GET  /stream/sessions/:id/clips    — clips from a session

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { S3Client, GetObjectCommand, PutObjectCommand,
        DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const router = express.Router();

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'lunax-media';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// ── Schema migration ──────────────────────────────────────────────────────────
function ensureStreamSchema() {
  // Stream key on users table
  try { db.prepare('ALTER TABLE users ADD COLUMN stream_key TEXT').run(); } catch {}

  // Kick refresh support — kick_access_token already exists from auth.js's
  // restream OAuth callback; these two are new, needed for the refresh flow
  // added alongside getKickDestination.
  try { db.prepare('ALTER TABLE users ADD COLUMN kick_refresh_token TEXT').run(); } catch {}
  try { db.prepare('ALTER TABLE users ADD COLUMN kick_token_expires_at INTEGER').run(); } catch {}

  // Stream sessions table — one row per live stream
  db.prepare(`
    CREATE TABLE IF NOT EXISTS stream_sessions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      stream_key   TEXT NOT NULL,
      s3_key       TEXT,
      started_at   INTEGER,
      ended_at     INTEGER,
      duration_sec INTEGER,
      status       TEXT DEFAULT 'live',
      platforms    TEXT DEFAULT '[]',
      created_at   INTEGER DEFAULT (strftime('%s','now') * 1000)
    )
  `).run();

  // Clip markers table — one row per "Luna clip that" call
  db.prepare(`
    CREATE TABLE IF NOT EXISTS stream_clips (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      stream_key     TEXT NOT NULL,
      stream_offset  INTEGER NOT NULL,
      label          TEXT,
      s3_clip_key    TEXT,
      status         TEXT DEFAULT 'pending',
      post_id        TEXT,
      created_at     INTEGER DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (session_id) REFERENCES stream_sessions(id)
    )
  `).run();
}
ensureStreamSchema();

// ── Helper: get or create stream key for user ─────────────────────────────────
function getOrCreateStreamKey(userId) {
  const user = db.prepare('SELECT stream_key FROM users WHERE id = ?').get(userId);
  if (user?.stream_key) return user.stream_key;
  const key = `lx_${uuidv4().replace(/-/g, '')}`;
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(key, userId);
  return key;
}

// ── GET /stream/key — user gets their stream key + RTMP URL ──────────────────
router.get('/key', requireAuth, (req, res) => {
  const key = getOrCreateStreamKey(req.user.id);
  const rtmpHost = process.env.RTMP_SERVER_HOST || 'lunax-rtmp.railway.app';
  res.json({
    streamKey: key,
    rtmpUrl:   `rtmp://${rtmpHost}/live`,
    fullUrl:   `rtmp://${rtmpHost}/live/${key}`,
    // For streaming apps that need separate server + key:
    server: `rtmp://${rtmpHost}/live`,
    key,
    // WebSocket for real-time status in iOS app
    wsUrl: `wss://${rtmpHost.replace(':1935', '')}?key=${key}`,
  });
});

// ── POST /stream/key/regenerate ───────────────────────────────────────────────
router.post('/key/regenerate', requireAuth, (req, res) => {
  const key = `lx_${uuidv4().replace(/-/g, '')}`;
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(key, req.user.id);
  res.json({ streamKey: key });
});

// ── GET /stream/validate/:streamKey — called by RTMP server (no auth header) ──
// This endpoint must NOT require JWT — the RTMP server calls it with just the key.
// We validate the key against a shared secret instead.
// ── Restream credential helpers ────────────────────────────────────────────
// The previous version of /validate treated the OAuth access_token itself
// as if it WERE the RTMP stream key, and queried a `social_accounts` table
// that doesn't match where these tokens are actually stored (users.
// twitch_access_token etc., set up in auth.js's restream OAuth routes).
// Neither would ever have worked: an OAuth token authenticates API calls,
// it isn't ingest credential. This section fetches the REAL stream key/
// ingest URL from each platform, refreshing the OAuth token first if it's
// expired.

async function refreshTwitchToken(user) {
  if (!user.twitch_refresh_token) return null;
  try {
    const body = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.twitch_refresh_token,
    });
    const resp = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await resp.json();
    if (!resp.ok || !json.access_token) {
      console.warn('[Restream] Twitch token refresh failed:', json);
      return null;
    }
    const expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : null;
    db.prepare(`UPDATE users SET twitch_access_token = ?, twitch_refresh_token = ?, twitch_token_expires_at = ? WHERE id = ?`)
      .run(json.access_token, json.refresh_token || user.twitch_refresh_token, expiresAt, user.id);
    return json.access_token;
  } catch (e) {
    console.warn('[Restream] Twitch token refresh error:', e.message);
    return null;
  }
}

async function getTwitchDestination(user) {
  if (!user.twitch_access_token || !user.twitch_user_id) return null;
  let accessToken = user.twitch_access_token;
  // Refresh proactively if we know it's expired, rather than waiting for
  // Twitch to reject the stream-key request and losing this platform for
  // the whole session.
  if (user.twitch_token_expires_at && Date.now() > user.twitch_token_expires_at) {
    accessToken = await refreshTwitchToken(user);
    if (!accessToken) return null;
  }
  try {
    const resp = await fetch(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${user.twitch_user_id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID,
      },
    });
    if (resp.status === 401) {
      // Token rejected despite our expiry check (e.g. manually revoked) —
      // one retry after a forced refresh before giving up on this platform.
      const refreshed = await refreshTwitchToken(user);
      if (!refreshed) return null;
      const retryResp = await fetch(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${user.twitch_user_id}`, {
        headers: { Authorization: `Bearer ${refreshed}`, 'Client-Id': process.env.TWITCH_CLIENT_ID },
      });
      const retryJson = await retryResp.json();
      const key = retryJson?.data?.[0]?.stream_key;
      return key ? { name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: key } : null;
    }
    const json = await resp.json();
    const key = json?.data?.[0]?.stream_key;
    return key ? { name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: key } : null;
  } catch (e) {
    console.warn('[Restream] Twitch stream-key fetch failed:', e.message);
    return null;
  }
}

async function refreshYouTubeToken(user) {
  if (!user.youtube_restream_refresh_token) return null;
  try {
    const body = new URLSearchParams({
      client_id: process.env.YOUTUBE_RESTREAM_CLIENT_ID,
      client_secret: process.env.YOUTUBE_RESTREAM_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.youtube_restream_refresh_token,
    });
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await resp.json();
    if (!resp.ok || !json.access_token) {
      console.warn('[Restream] YouTube token refresh failed:', json);
      return null;
    }
    // Google doesn't always return a new refresh_token on refresh — keep
    // the existing one when it doesn't.
    const expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : null;
    db.prepare(`UPDATE users SET youtube_restream_access_token = ?, youtube_restream_token_expires_at = ? WHERE id = ?`)
      .run(json.access_token, expiresAt, user.id);
    return json.access_token;
  } catch (e) {
    console.warn('[Restream] YouTube token refresh error:', e.message);
    return null;
  }
}

// YouTube has no static stream key — every session needs a fresh broadcast
// + stream created via the Live Streaming API, then bound together. This
// is the most involved of the three, and the one part that genuinely can't
// be tested until Google's OAuth verification review for youtube.force-ssl
// clears — the code path is correct per Google's documented flow, but
// unverified against a real approved connection.
async function getYouTubeDestination(user) {
  if (!user.youtube_restream_access_token) return null;
  let accessToken = user.youtube_restream_access_token;
  if (user.youtube_restream_token_expires_at && Date.now() > user.youtube_restream_token_expires_at) {
    accessToken = await refreshYouTubeToken(user);
    if (!accessToken) return null;
  }

  const authHeader = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  try {
    // 1. Create the broadcast (the "event" — title, privacy, schedule)
    const broadcastResp = await fetch(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          snippet: {
            title: `Live via Luna X — ${new Date().toLocaleDateString()}`,
            scheduledStartTime: new Date().toISOString(),
          },
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
          contentDetails: { enableAutoStart: true, enableAutoStop: true },
        }),
      }
    );
    const broadcast = await broadcastResp.json();
    if (!broadcastResp.ok || !broadcast.id) {
      console.warn('[Restream] YouTube liveBroadcasts.insert failed:', broadcast);
      return null;
    }

    // 2. Create the stream (this is what actually returns the ingest URL/key)
    const streamResp = await fetch(
      'https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          snippet: { title: 'Luna X Stream' },
          cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
        }),
      }
    );
    const stream = await streamResp.json();
    if (!streamResp.ok || !stream.id) {
      console.warn('[Restream] YouTube liveStreams.insert failed:', stream);
      return null;
    }

    // 3. Bind the stream to the broadcast — required before ingest works
    const bindResp = await fetch(
      `https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id=${broadcast.id}&streamId=${stream.id}&part=id`,
      { method: 'POST', headers: authHeader }
    );
    if (!bindResp.ok) {
      console.warn('[Restream] YouTube liveBroadcasts.bind failed:', await bindResp.json());
      return null;
    }

    const ingestionInfo = stream.cdn?.ingestionInfo;
    if (!ingestionInfo?.ingestionAddress || !ingestionInfo?.streamName) return null;

    // NOTE: transitioning the broadcast to "live" (making it publicly
    // visible/actually going out) is deliberately NOT done here — YouTube
    // expects the stream's health to reach "good"/"ok" status before that
    // transition succeeds, which only happens once ffmpeg is actively
    // pushing data into this ingest URL. That transition needs to happen
    // from a point in the flow that runs AFTER ffmpeg has started, not
    // here at validate-time. See the TODO in startRestreaming on the RTMP
    // server, or wherever /stream/started's handling gets extended next.
    return {
      name: 'YouTube',
      rtmpUrl: ingestionInfo.ingestionAddress,
      streamKey: ingestionInfo.streamName,
      youtubeBroadcastId: broadcast.id, // needed later for the transition-to-live call
    };
  } catch (e) {
    console.warn('[Restream] YouTube broadcast creation failed:', e.message);
    return null;
  }
}

// Kick: confirmed via docs.kick.com — there is no dedicated stream-key
// endpoint. The stream key/ingest URL are fields (`stream.key`, `stream.url`)
// returned inside the regular GET /public/v1/channels response, gated by the
// streamkey:read scope. Calling it with no query params returns the channel
// for the currently authenticated user.
//
// IMPORTANT: this requires auth.js's Kick OAuth authorize call to request
// BOTH `channel:read` and `streamkey:read` scopes — if only one is present,
// `stream.key`/`stream.url` will likely come back empty or the `stream`
// object may be omitted entirely. Verify the scope string in auth.js before
// testing this live.
async function refreshKickToken(user) {
  if (!user.kick_refresh_token) return null;
  try {
    const body = new URLSearchParams({
      client_id: process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.kick_refresh_token,
    });
    const resp = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await resp.json();
    if (!resp.ok || !json.access_token) {
      console.warn('[Restream] Kick token refresh failed:', json);
      return null;
    }
    const expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : null;
    db.prepare(`UPDATE users SET kick_access_token = ?, kick_refresh_token = ?, kick_token_expires_at = ? WHERE id = ?`)
      .run(json.access_token, json.refresh_token || user.kick_refresh_token, expiresAt, user.id);
    return json.access_token;
  } catch (e) {
    console.warn('[Restream] Kick token refresh error:', e.message);
    return null;
  }
}

async function fetchKickChannel(accessToken) {
  const resp = await fetch('https://api.kick.com/public/v1/channels', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await resp.json();
  return { ok: resp.status !== 401, status: resp.status, channel: json?.data?.[0] || null };
}

async function getKickDestination(user) {
  if (!user.kick_access_token) return null;
  let accessToken = user.kick_access_token;
  if (user.kick_token_expires_at && Date.now() > user.kick_token_expires_at) {
    accessToken = await refreshKickToken(user);
    if (!accessToken) return null;
  }
  try {
    let { ok, status, channel } = await fetchKickChannel(accessToken);
    if (status === 401) {
      const refreshed = await refreshKickToken(user);
      if (!refreshed) return null;
      ({ channel } = await fetchKickChannel(refreshed));
    } else if (!ok) {
      return null;
    }
    const key = channel?.stream?.key;
    const url = channel?.stream?.url;
    if (!key || !url) {
      console.warn('[Restream] Kick channel returned no stream.key/stream.url — check streamkey:read scope is granted.');
      return null;
    }
    return { name: 'Kick', rtmpUrl: url, streamKey: key };
  } catch (e) {
    console.warn('[Restream] Kick stream-key fetch failed:', e.message);
    return null;
  }
}

router.get('/validate/:streamKey', async (req, res) => {
  // Verify caller is our own RTMP server using a shared secret
  const serverSecret = req.headers['x-rtmp-secret'];
  if (serverSecret !== process.env.RTMP_SHARED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { streamKey } = req.params;
  const user = db.prepare(`
    SELECT id, email, meta_page_token, meta_page_id, meta_ig_id, meta_access_token,
           twitch_access_token, twitch_refresh_token, twitch_user_id, twitch_token_expires_at,
           youtube_restream_access_token, youtube_restream_refresh_token, youtube_restream_token_expires_at,
           kick_access_token, kick_refresh_token, kick_token_expires_at
    FROM users WHERE stream_key = ?
  `).get(streamKey);

  if (!user) {
    return res.status(404).json({ error: 'Invalid stream key' });
  }

  // Real ingest credentials, fetched from each platform using the stored
  // OAuth tokens — not the OAuth tokens themselves. Each helper handles its
  // own token refresh and returns null (rather than throwing) on any
  // failure, so one platform being disconnected/expired/unimplemented
  // (Kick, for now) never blocks the other two or the stream itself.
  const [twitchDest, youtubeDest, kickDest] = await Promise.all([
    getTwitchDestination(user).catch(e => { console.warn('[Validate] Twitch destination error:', e.message); return null; }),
    getYouTubeDestination(user).catch(e => { console.warn('[Validate] YouTube destination error:', e.message); return null; }),
    getKickDestination(user).catch(e => { console.warn('[Validate] Kick destination error:', e.message); return null; }),
  ]);
  const platforms = [twitchDest, youtubeDest, kickDest].filter(Boolean);

  console.log(`[Validate] Stream key OK for user ${user.id} — ${platforms.length} platform(s): ${platforms.map(p => p.name).join(', ') || 'none'}`);
  res.json({
    userId:    user.id,
    userName:  user.email.split('@')[0],
    platforms,
  });
});

// ── POST /stream/started — RTMP server notifies us a stream is live ───────────
router.post('/started', (req, res) => {
  if (req.headers['x-rtmp-secret'] !== process.env.RTMP_SHARED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { streamKey, userId, s3Key, startedAt } = req.body;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO stream_sessions (id, user_id, stream_key, s3_key, started_at, status)
    VALUES (?, ?, ?, ?, ?, 'live')
  `).run(id, userId, streamKey, s3Key, startedAt);
  console.log(`[Stream] Session started: ${id}`);
  res.json({ ok: true, sessionId: id });
});

// ── POST /stream/ended — RTMP server notifies us stream ended ─────────────────
// This triggers clip extraction and AI highlight detection
router.post('/ended', async (req, res) => {
  if (req.headers['x-rtmp-secret'] !== process.env.RTMP_SHARED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { streamKey, userId, s3Key, duration, clipMarkers, startedAt, endedAt } = req.body;
  res.json({ ok: true }); // respond immediately, process async

  try {
    // Update session record
    const session = db.prepare(
      'SELECT id FROM stream_sessions WHERE stream_key = ? AND status = ? ORDER BY started_at DESC LIMIT 1'
    ).get(streamKey, 'live');

    const sessionId = session?.id || uuidv4();
    db.prepare(`
      UPDATE stream_sessions SET
        ended_at = ?, duration_sec = ?, status = 'ended', s3_key = ?
      WHERE id = ?
    `).run(endedAt, duration, s3Key, sessionId);

    // Save clip markers to DB
    for (const marker of (clipMarkers || [])) {
      db.prepare(`
        INSERT OR IGNORE INTO stream_clips
          (id, session_id, user_id, stream_key, stream_offset, label, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(marker.id, sessionId, userId, streamKey, marker.streamOffset, marker.label || 'Clip');
    }

    console.log(`[Stream] Session ended: ${sessionId}, ${clipMarkers?.length || 0} clips to extract`);

    // Queue clip extraction (runs async, doesn't block)
    if (clipMarkers?.length > 0 && s3Key) {
      extractClipsFromStream(sessionId, userId, s3Key, clipMarkers, duration)
        .catch(e => console.error('[Clip extraction] Error:', e.message));
    }

    // Schedule auto-delete of raw stream after 24 hours
    scheduleRawDelete(s3Key, 24 * 60 * 60 * 1000);

  } catch (e) {
    console.error('[Stream/ended] Error:', e.message);
  }
});

// ── POST /stream/clip — iOS app marks a clip during stream ───────────────────
// Also accepts calls directly (not just via RTMP server)
router.post('/clip', requireAuth, (req, res) => {
  const { label, streamOffset } = req.body;
  const user = db.prepare('SELECT stream_key FROM users WHERE id = ?').get(req.user.id);
  if (!user?.stream_key) return res.status(400).json({ error: 'No stream key' });

  // Find active session
  const session = db.prepare(
    'SELECT id FROM stream_sessions WHERE stream_key = ? AND status = ? ORDER BY started_at DESC LIMIT 1'
  ).get(user.stream_key, 'live');

  if (!session) return res.status(400).json({ error: 'No active stream' });

  const clipId = uuidv4();
  const offset = streamOffset || Date.now(); // fallback if offset not provided

  db.prepare(`
    INSERT INTO stream_clips (id, session_id, user_id, stream_key, stream_offset, label, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(clipId, session.id, req.user.id, user.stream_key, offset, label || 'Clip');

  // Also forward to RTMP server if it's running
  const rtmpHttp = process.env.RTMP_HTTP_URL;
  if (rtmpHttp) {
    fetch(`${rtmpHttp}/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamKey: user.stream_key, label }),
    }).catch(() => {}); // fire and forget
  }

  res.json({ ok: true, clipId });
});

// ── GET /stream/sessions — user's stream history ──────────────────────────────
router.get('/sessions', requireAuth, (req, res) => {
  const sessions = db.prepare(`
    SELECT s.*,
           COUNT(c.id) as clip_count,
           COUNT(CASE WHEN c.status = 'ready' THEN 1 END) as ready_clips
    FROM stream_sessions s
    LEFT JOIN stream_clips c ON c.session_id = s.id
    WHERE s.user_id = ?
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 20
  `).all(req.user.id);
  res.json({ sessions });
});

// ── GET /stream/sessions/:id/clips — clips from one session ──────────────────
router.get('/sessions/:id/clips', requireAuth, async (req, res) => {
  const clips = db.prepare(`
    SELECT * FROM stream_clips
    WHERE session_id = ? AND user_id = ?
    ORDER BY stream_offset ASC
  `).all(req.params.id, req.user.id);

  // Generate presigned URLs for ready clips
  const clipsWithUrls = await Promise.all(clips.map(async (clip) => {
    if (clip.s3_clip_key) {
      try {
        const url = await getSignedUrl(s3, new GetObjectCommand({
          Bucket: S3_BUCKET, Key: clip.s3_clip_key,
        }), { expiresIn: 3600 });
        return { ...clip, downloadUrl: url };
      } catch { return clip; }
    }
    return clip;
  }));

  res.json({ clips: clipsWithUrls });
});

// ── Clip extraction ───────────────────────────────────────────────────────────
// Downloads only the relevant byte range from S3 for each clip marker,
// slices it with FFmpeg, and uploads the clip back to S3.
async function extractClipsFromStream(sessionId, userId, rawS3Key, markers, totalDuration) {
  console.log(`[ClipExtract] Starting extraction for session ${sessionId}`);

  // Get the raw stream's total size from S3
  let fileSize;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: rawS3Key }));
    fileSize = head.ContentLength;
  } catch (e) {
    console.error('[ClipExtract] Could not HEAD raw stream:', e.message);
    return;
  }

  const bytesPerSecond = fileSize / totalDuration;

  for (const marker of markers) {
    const clipId = marker.id;
    const offsetSec = marker.streamOffset / 1000;

    // 30 seconds before the marker, 30 seconds after — adjustable per user later
    const startSec = Math.max(0, offsetSec - 30);
    const endSec   = Math.min(totalDuration, offsetSec + 30);
    const clipDuration = endSec - startSec;

    // Calculate byte range (approximate — FFmpeg will handle exact keyframes)
    const startByte = Math.floor(startSec * bytesPerSecond);
    const endByte   = Math.min(fileSize - 1, Math.ceil(endSec * bytesPerSecond));

    console.log(`[ClipExtract] Clip ${clipId}: ${startSec}s-${endSec}s (bytes ${startByte}-${endByte})`);

    try {
      // Download just the relevant byte range from S3
      const rangeResp = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: rawS3Key,
        Range: `bytes=${startByte}-${endByte}`,
      }));

      // Collect the stream bytes
      const chunks = [];
      for await (const chunk of rangeResp.Body) {
        chunks.push(chunk);
      }
      const inputBuffer = Buffer.concat(chunks);

      // Use FFmpeg to trim to exact timestamps and encode cleanly
      const clipBuffer = await ffmpegTrimBuffer(inputBuffer, 0, clipDuration);

      // Upload clip to S3
      const clipKey = `streams/${userId}/clips/${sessionId}/${clipId}.mp4`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: clipKey,
        Body: clipBuffer,
        ContentType: 'video/mp4',
        Metadata: { sessionId, clipId, offsetSec: String(offsetSec) },
      }));

      // Update DB
      db.prepare(`
        UPDATE stream_clips SET s3_clip_key = ?, status = 'ready' WHERE id = ?
      `).run(clipKey, clipId);

      // Create a post record in pending state so it shows in the Video Editor
      const postId = uuidv4();
      const publicUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${clipKey}`;
      db.prepare(`
        INSERT INTO posts (id, user_id, caption, platforms, media_url, media_type,
                          scheduled_time, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        postId, userId,
        marker.label || 'Stream clip',
        JSON.stringify([]),
        publicUrl, 'video',
        null, 'draft',
        Date.now(), Date.now()
      );

      db.prepare('UPDATE stream_clips SET post_id = ? WHERE id = ?').run(postId, clipId);
      console.log(`[ClipExtract] ✓ Clip ${clipId} ready → ${clipKey}`);

    } catch (e) {
      console.error(`[ClipExtract] Failed to extract clip ${clipId}:`, e.message);
      db.prepare('UPDATE stream_clips SET status = ? WHERE id = ?').run('failed', clipId);
    }
  }

  console.log(`[ClipExtract] ✓ All ${markers.length} clips extracted for session ${sessionId}`);
}

// Run FFmpeg on a buffer — trim to duration and output clean MP4
function ffmpegTrimBuffer(inputBuffer, startSec, durationSec) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-ss', String(startSec),
      '-t', String(durationSec),
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-movflags', 'faststart',
      '-f', 'mp4',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    ff.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    ff.stderr.on('data', () => {}); // suppress FFmpeg progress output
    ff.on('error', reject);
    ff.on('exit', code => {
      if (code !== 0 && chunks.length === 0) reject(new Error(`FFmpeg exit ${code}`));
    });

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// Delete raw stream from S3 after delay
function scheduleRawDelete(s3Key, delayMs) {
  setTimeout(async () => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
      console.log(`[S3] Auto-deleted raw stream: ${s3Key}`);
    } catch (e) {
      console.warn(`[S3] Could not auto-delete ${s3Key}:`, e.message);
    }
  }, delayMs);
}

module.exports = router;
