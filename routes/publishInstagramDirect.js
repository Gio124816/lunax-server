// ════════════════════════════════════════════════════════════════════════════
// publishInstagramDirect.js
// ════════════════════════════════════════════════════════════════════════════
// Publishes a single media item (image or video) to an Instagram Business or
// Creator account using the Instagram API with Instagram Login flow — the
// 2024 path that doesn't require a Facebook Page linkage.
//
// USAGE from scheduler.js:
//   const { publishInstagramDirect } = require('./publishInstagramDirect');
//   const igDirectToken = user.ig_direct_access_token;
//   const igUserId = user.ig_direct_user_id;
//   if (igDirectToken && igUserId) {
//     // Prefer direct flow if available
//     await publishInstagramDirect({
//       igUserId, accessToken: igDirectToken,
//       mediaUrl: post.mediaUrl,           // publicly accessible URL
//       mediaType: post.mediaType,         // 'video' or 'image'
//       caption: post.captionForInstagram || post.caption,
//     });
//   } else if (user.meta_access_token) {
//     // Existing Facebook-routed flow as fallback
//     ...
//   }
//
// API DOCS:
//   Container create: POST https://graph.instagram.com/v23.0/{ig-user-id}/media
//   Publish:          POST https://graph.instagram.com/v23.0/{ig-user-id}/media_publish
//   Status check:     GET  https://graph.instagram.com/v23.0/{container-id}?fields=status_code
//
// IMPORTANT: Videos must be FINISHED uploading on Meta's side before publish
// will succeed. We poll the container status_code field for FINISHED before
// calling /media_publish. Image containers are usually ready immediately.

const GRAPH = 'https://graph.instagram.com/v23.0';

async function _post(url, params) {
  const body = new URLSearchParams(params);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await r.json();
  if (!r.ok) {
    const msg = (json && json.error && (json.error.message || json.error.error_user_msg)) || json.error_message || `HTTP ${r.status}`;
    const err = new Error(`Instagram API: ${msg}`);
    err.response = json;
    throw err;
  }
  return json;
}

async function _get(url) {
  const r = await fetch(url);
  const json = await r.json();
  if (!r.ok) {
    const msg = (json && json.error && (json.error.message || json.error.error_user_msg)) || json.error_message || `HTTP ${r.status}`;
    const err = new Error(`Instagram API: ${msg}`);
    err.response = json;
    throw err;
  }
  return json;
}

// Wait for a video container to finish processing on Meta's side.
// Returns when status_code === 'FINISHED', throws on ERROR or timeout.
async function _waitForContainer(containerId, accessToken, { timeoutMs = 5 * 60 * 1000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ fields: 'status_code', access_token: accessToken });
    const status = await _get(`${GRAPH}/${containerId}?${params.toString()}`);
    const code = status.status_code;
    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Container processing failed (status: ${code})`);
    }
    // IN_PROGRESS or PUBLISHED → keep polling (PUBLISHED here means container
    // is ready, which is what we want).
    if (code === 'PUBLISHED') return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Container processing timed out after 5 minutes');
}

/**
 * Publish a single photo or video to Instagram via the direct API.
 *
 * @param {object} opts
 * @param {string} opts.igUserId      - Instagram user id (from /auth/me ig_direct_user_id)
 * @param {string} opts.accessToken   - Long-lived IG access token
 * @param {string} opts.mediaUrl      - Publicly accessible URL of the media (e.g. S3)
 * @param {string} opts.mediaType     - 'video' or 'image' (case-insensitive)
 * @param {string} opts.caption       - Caption text (may include hashtags)
 * @param {boolean} [opts.shareToFeed] - For Reels: true to also share to main feed (default true)
 * @returns {Promise<{containerId: string, publishedId: string}>}
 */
async function publishInstagramDirect(opts) {
  const { igUserId, accessToken, mediaUrl, caption, shareToFeed = true } = opts;
  const mediaType = String(opts.mediaType || '').toLowerCase();
  if (!igUserId) throw new Error('Missing igUserId');
  if (!accessToken) throw new Error('Missing accessToken');
  if (!mediaUrl) throw new Error('Missing mediaUrl');

  const isVideo = mediaType.startsWith('video');

  // ── Step 1: create the media container ──
  // For videos, Meta processes asynchronously. For photos, container is
  // ready immediately. Either way we get a container_id back.
  const createParams = {
    access_token: accessToken,
    caption: caption || '',
  };
  if (isVideo) {
    // 'REELS' is the recommended type for short-form video; falls back to
    // showing on grid AND in Reels tab when share_to_feed is true.
    createParams.media_type = 'REELS';
    createParams.video_url = mediaUrl;
    createParams.share_to_feed = shareToFeed ? 'true' : 'false';
  } else {
    createParams.image_url = mediaUrl;
  }
  const createResp = await _post(`${GRAPH}/${igUserId}/media`, createParams);
  const containerId = createResp.id;
  if (!containerId) {
    throw new Error('Container creation returned no id: ' + JSON.stringify(createResp));
  }

  // ── Step 2: for videos, wait until processing finishes ──
  if (isVideo) {
    await _waitForContainer(containerId, accessToken);
  }

  // ── Step 3: publish the container ──
  const publishResp = await _post(`${GRAPH}/${igUserId}/media_publish`, {
    access_token: accessToken,
    creation_id: containerId,
  });
  const publishedId = publishResp.id;
  if (!publishedId) {
    throw new Error('Publish returned no id: ' + JSON.stringify(publishResp));
  }
  return { containerId, publishedId };
}

module.exports = { publishInstagramDirect };
