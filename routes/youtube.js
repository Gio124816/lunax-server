const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/database');
const { requireAuth } = require('./auth');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://lunax-server-production.up.railway.app/oauth/youtube/callback';

// ── DB MIGRATION — add YouTube columns if not exist ────────────────────────
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

// ── STEP 1: Redirect user to Google OAuth ──────────────
router.get('/youtube', (req, res) => {
  let userId;
  const qToken = req.query.token;
  if (qToken) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(qToken, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch(e) {
      return res.redirect('https://lunaxmedia.com?youtube=error');
    }
  } else {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.redirect('https://lunaxmedia.com?youtube=error');
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      userId = decoded.id;
    } catch(e) {
      return res.redirect('https://lunaxmedia.com?youtube=error');
    }
  }

  const state = Buffer.from(JSON.stringify({
    userId,
    ts: Date.now()
  })).toString('base64');

  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// ── STEP 2: Google redirects back with code ────────────
router.get('/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('YouTube OAuth error:', error);
    return res.redirect('https://lunaxmedia.com?youtube=error');
  }

  let userId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    userId = decoded.userId;
  } catch (e) {
    return res.redirect('https://lunaxmedia.com?youtube=error');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = Date.now() + (expires_in * 1000);

    // Fetch YouTube channel info
    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true },
      headers: { Authorization: `Bearer ${access_token}` }
    });

    console.log('[YouTube] channel API response items:', channelRes.data?.items?.length ?? 'none');

    const channel = channelRes.data?.items?.[0];

    // No channel = account exists but user hasn't created a YouTube channel yet
    if (!channel) {
      console.warn('[YouTube] No YouTube channel found for this Google account — redirecting with no_channel error');
      return res.redirect('https://lunaxmedia.com?youtube=no_channel');
    }

    let channelId = channel?.id || '';
    let channelName = channel?.snippet?.title || '';
    let channelAvatar = channel?.snippet?.thumbnails?.default?.url || '';

    // Fallback: fetch Google profile name if channel title somehow empty
    if (!channelName) {
      try {
        const profileRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        channelName = profileRes.data?.name || profileRes.data?.email || 'YouTube Account';
        channelAvatar = channelAvatar || profileRes.data?.picture || '';
      } catch(e) {
        channelName = 'YouTube Account';
      }
    }

    // Save to DB
    db.prepare(`
      UPDATE users SET
        youtube_access_token = ?,
        youtube_refresh_token = ?,
        youtube_token_expires_at = ?,
        youtube_channel_id = ?,
        youtube_channel_name = ?,
        youtube_channel_avatar = ?
      WHERE id = ?
    `).run(access_token, refresh_token || null, expiresAt, channelId, channelName, channelAvatar, userId);

    res.redirect('https://lunaxmedia.com?youtube=connected');
  } catch (err) {
    console.error('YouTube callback error:', err.response?.data || err.message);
    res.redirect('https://lunaxmedia.com?youtube=error');
  }
});

// ── DISCONNECT YouTube ─────────────────────────────────
router.post('/youtube/disconnect', requireAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users SET
        youtube_access_token = NULL,
        youtube_refresh_token = NULL,
        youtube_token_expires_at = NULL,
        youtube_channel_id = NULL,
        youtube_channel_name = NULL,
        youtube_channel_avatar = NULL
      WHERE id = ?
    `).run(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('YouTube disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ── REFRESH TOKEN ──────────────────────────────────────
async function refreshYouTubeToken(userId, refreshToken) {
  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const { access_token, expires_in } = res.data;
    const expiresAt = Date.now() + (expires_in * 1000);

    db.prepare(`
      UPDATE users SET
        youtube_access_token = ?,
        youtube_token_expires_at = ?
      WHERE id = ?
    `).run(access_token, expiresAt, userId);

    return access_token;
  } catch (err) {
    console.error('YouTube token refresh failed:', err.response?.data || err.message);
    return null;
  }
}

// ── DETECT IF VIDEO IS A SHORT ────────────────────────
// Parses MP4 mvhd box to get duration in seconds
function getMp4DurationSeconds(buffer) {
  try {
    // Search for 'mvhd' box which contains duration
    for (let i = 0; i < buffer.length - 8; i++) {
      if (buffer[i]===0x6d && buffer[i+1]===0x76 && buffer[i+2]===0x68 && buffer[i+3]===0x64) {
        const version = buffer[i+4];
        if (version === 0) {
          // version 0: timescale at offset 12, duration at offset 16
          const timescale = buffer.readUInt32BE(i+12);
          const duration = buffer.readUInt32BE(i+16);
          return timescale > 0 ? duration / timescale : 0;
        } else {
          // version 1: timescale at offset 20, duration at offset 24 (64-bit, read high 32 only)
          const timescale = buffer.readUInt32BE(i+20);
          const duration = buffer.readUInt32BE(i+28);
          return timescale > 0 ? duration / timescale : 0;
        }
      }
    }
  } catch(e) {}
  return 0;
}

function shouldBeShort(post, videoBuffer) {
  // Explicit flag from user command
  if (post.is_short === 1 || post.is_short === true) return true;
  if (post.is_short === 0 || post.is_short === false) return false;

  // Auto-detect: check duration
  const durationSec = getMp4DurationSeconds(videoBuffer);
  console.log(`[YouTube] Video duration: ${durationSec.toFixed(1)}s`);
  // Auto-detect: ≤60s always a Short; 60-180s only if user explicitly requested
  if (durationSec > 0 && durationSec <= 60) {
    console.log(`[YouTube] Auto-detected as Short (${durationSec.toFixed(1)}s)`);
    return true;
  }
  // 60-180s: only Short if user said so (checked above via is_short flag)
  if (durationSec > 60 && durationSec <= 180) {
    console.log(`[YouTube] ${durationSec.toFixed(1)}s — eligible for Short but needs explicit request`);
  }

  // Check filename hints
  const url = (post.media_url || '').toLowerCase();
  if (url.includes('short') || url.includes('reel') || url.includes('vertical')) return true;

  return false;
}

// ── POST VIDEO TO YOUTUBE ──────────────────────────────
// Called by scheduler when a post has youtube=true
async function postToYouTube(post, user) {
  let accessToken = user.youtube_access_token;

  if (!accessToken) throw new Error('No YouTube access token');

  // Refresh if within 5 minutes of expiry
  if (user.youtube_token_expires_at && Date.now() > user.youtube_token_expires_at - 300000) {
    if (user.youtube_refresh_token) {
      accessToken = await refreshYouTubeToken(user.id, user.youtube_refresh_token);
      if (!accessToken) throw new Error('YouTube token refresh failed');
    }
  }

  const mediaUrl = post.media_url;
  if (!mediaUrl) throw new Error('YouTube post requires a video URL');

  // Download video from S3
  const videoRes = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
  const videoBuffer = Buffer.from(videoRes.data);
  const mimeType = mediaUrl.match(/\.mov$/i) ? 'video/quicktime' : 'video/mp4';

  // Step 1: Initiate resumable upload — must use /upload/ endpoint
  const isShort = shouldBeShort(post, videoBuffer);
  const baseTags = (() => { try { return JSON.parse(post.hashtags || '[]'); } catch(e) { return []; } })();
  const tags = isShort ? [...new Set([...baseTags, 'Shorts'])] : baseTags;

  // For Shorts: title must include #Shorts, and video must be portrait ≤60s
  const rawTitle = post.caption?.slice(0, 97) || 'Luna X Post';
  const title = isShort ? `${rawTitle} #Shorts` : rawTitle;
  const description = isShort
    ? `${post.caption || ''}\n\n#Shorts`
    : (post.caption || '');

  console.log(`[YouTube] Posting as: ${isShort ? 'SHORT' : 'regular video'} — "${title.slice(0,50)}"`);

  const metaRes = await axios.post(
    'https://www.googleapis.com/upload/youtube/v3/videos',
    {
      snippet: {
        title,
        description,
        tags,
        categoryId: '22',
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      }
    },
    {
      params: { part: 'snippet,status', uploadType: 'resumable' },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(videoBuffer.length),
      }
    }
  );

  const uploadUrl = metaRes.headers.location;
  if (!uploadUrl) {
    console.error('[YouTube] No upload URL returned. Response:', metaRes.status, metaRes.headers);
    throw new Error('YouTube did not return an upload URL');
  }
  console.log('[YouTube] Got resumable upload URL, uploading', videoBuffer.length, 'bytes...');

  // Step 2: Upload video bytes
  const uploadRes = await axios.put(uploadUrl, videoBuffer, {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(videoBuffer.length),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const videoId = uploadRes.data?.id;
  if (!videoId) throw new Error('YouTube upload failed — no video ID returned');

  console.log(`[YouTube] Upload complete! Video ID: ${videoId}`);
  return { success: true, videoId, url: `https://youtube.com/watch?v=${videoId}` };
}

module.exports = router;
module.exports.postToYouTube = postToYouTube;
module.exports.refreshYouTubeToken = refreshYouTubeToken;
