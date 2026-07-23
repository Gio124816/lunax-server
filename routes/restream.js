// ════════════════════════════════════════════════════════════════════════
// RESTREAM DESTINATIONS — Twitch / YouTube / Kick
// ════════════════════════════════════════════════════════════════════════
// Add this to lunax-server's auth.js (or wherever /oauth/tiktok etc. already
// live) — this is DIFFERENT from the existing /oauth/{platform} routes,
// which connect accounts for POSTING content. This connects destination
// accounts for the lunax-rtmp service to RESTREAM a live broadcast to,
// once you're streaming into Luna X via the RTMP key (ConnectAccountsView's
// StreamKeySection).
//
// REQUIRED env vars (one OAuth app per platform — these need to be
// registered on each platform's developer console; I can't do that part,
// it's account/infra setup, not code):
//   TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET
//   YOUTUBE_RESTREAM_CLIENT_ID / YOUTUBE_RESTREAM_CLIENT_SECRET
//     (kept separate from whatever Google OAuth app handles login/posting
//     — restreaming needs broadcast-scoped access, a different scope than
//     login or content posting needs, so reusing the same app risks
//     over-scoping a token that's used elsewhere)
//   KICK_CLIENT_ID / KICK_CLIENT_SECRET
//   RESTREAM_REDIRECT_BASE — e.g. https://lunax-server-production.up.railway.app
//     (used to build each platform's callback URL)
//
// Requires the SAME ASWebAuthenticationSession + lunax:// deep-link pattern
// already used by /auth/google and the existing /oauth/{platform} routes —
// ConnectAccountsView.swift already expects this exact contract:
//   GET  /restream/status                      (authenticated via Bearer token)
//   GET  /restream/oauth/:platform?token=X&redirect=native   (redirects to provider)
//   DELETE /restream/oauth/:platform           (authenticated via Bearer token)

const crypto = require('crypto');

// Kick requires OAuth 2.1 with PKCE (a code_verifier/code_challenge pair) —
// Twitch and Google's server-side auth-code flow work fine without it, but
// Kick's API mandates it. Since the code_verifier has to survive between
// the /oauth/kick redirect and the separate /oauth/kick/callback request,
// it's embedded inside the signed `state` JWT below rather than needing
// server-side session storage — state is already round-tripped through the
// OAuth provider unmodified, so it's a safe, stateless place to carry it.
function generatePKCEPair() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

const RESTREAM_PLATFORMS = {
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'channel:read:stream_key',
    // Twitch's user info endpoint
    profileUrl: 'https://api.twitch.tv/helix/users',
  },
  youtube: {
    clientId: process.env.YOUTUBE_RESTREAM_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_RESTREAM_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // force-ssl (despite the confusing name, unrelated to SSL/HTTPS) covers
    // every Live Streaming API operation this restream flow needs — insert,
    // bind, transition all accept it — without the broader channel/video
    // management access the full "youtube" scope also grants. Requesting
    // the narrower of two equally-sufficient scopes is also what Google's
    // own OAuth verification reviewers look for.
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    profileUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
  },
  kick: {
    clientId: process.env.KICK_CLIENT_ID,
    clientSecret: process.env.KICK_CLIENT_SECRET,
    authUrl: 'https://id.kick.com/oauth/authorize',
    tokenUrl: 'https://id.kick.com/oauth/token',
    // streamkey:read is the one that actually matters for restreaming —
    // it's what lets lunax-rtmp eventually fetch the destination channel's
    // RTMP ingest key to push a stream to. This was missing from the
    // original draft; without it the OAuth connection would succeed but
    // restreaming itself could never work.
    scope: 'user:read channel:read streamkey:read',
    profileUrl: 'https://api.kick.com/public/v1/users',
  },
};

function _ensureRestreamColumns() {
  // Same migration-on-write pattern as _ensureIgDirectColumns above.
  const columns = [
    `twitch_access_token TEXT`, `twitch_refresh_token TEXT`, `twitch_display_name TEXT`,
    `youtube_restream_access_token TEXT`, `youtube_restream_refresh_token TEXT`, `youtube_restream_channel_name TEXT`,
    `kick_access_token TEXT`, `kick_refresh_token TEXT`, `kick_display_name TEXT`,
  ];
  for (const col of columns) {
    try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch {}
  }
}

// GET /restream/status — authenticated. Returns connection state for all
// three destinations at once, matching what RestreamDestinationsSection
// in ConnectAccountsView.swift already expects: { twitch: "Display Name",
// youtube: "Channel Name", kick: "Display Name" } (empty/absent = not connected).
router.get('/restream/status', requireAuth, (req, res) => {
  try {
    _ensureRestreamColumns();
    const user = db.prepare(`
      SELECT twitch_access_token, twitch_display_name,
             youtube_restream_access_token, youtube_restream_channel_name,
             kick_access_token, kick_display_name
      FROM users WHERE id = ?
    `).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      twitch: user.twitch_access_token ? (user.twitch_display_name || '') : null,
      youtube: user.youtube_restream_access_token ? (user.youtube_restream_channel_name || '') : null,
      kick: user.kick_access_token ? (user.kick_display_name || '') : null,
    });
  } catch (err) {
    console.error('Restream status error:', err);
    res.status(500).json({ error: 'Failed to load restream status' });
  }
});

// GET /restream/oauth/:platform?token=X&redirect=native
// Verifies the Bearer-equivalent token passed as a query param (since this
// is a browser redirect, not a fetch call — same reason /auth/google's
// flow takes it this way too), then redirects to the platform's own OAuth
// consent screen. State is a signed JWT embedding the user id + platform,
// same CSRF protection pattern as /instagram-direct/start above.
router.get('/restream/oauth/:platform', (req, res) => {
  const { platform } = req.params;
  const config = RESTREAM_PLATFORMS[platform];
  if (!config) return res.status(400).send('Unknown restream platform');
  if (!config.clientId) return res.status(500).send(`${platform} restream is not configured on the server`);

  const { token } = req.query;
  if (!token) return res.status(401).send('Missing token');

  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).send('Invalid or expired token');
  }

  // Kick requires PKCE — generate the pair and embed the verifier in the
  // signed state (Twitch/Google don't need this, so it's only added for
  // Kick specifically rather than complicating the other two flows).
  let codeVerifier, codeChallenge;
  const statePayload = { uid: userId, platform };
  if (platform === 'kick') {
    const pkce = generatePKCEPair();
    codeVerifier = pkce.codeVerifier;
    codeChallenge = pkce.codeChallenge;
    statePayload.codeVerifier = codeVerifier;
  }
  const state = jwt.sign(statePayload, process.env.JWT_SECRET, { expiresIn: '10m' });
  const redirectUri = `${process.env.RESTREAM_REDIRECT_BASE}/restream/oauth/${platform}/callback`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scope,
    state,
  });
  // Google (YouTube) needs these two extras to reliably return a refresh token.
  if (platform === 'youtube') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  if (platform === 'kick') {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  res.redirect(`${config.authUrl}?${params.toString()}`);
});

// GET /restream/oauth/:platform/callback
// Exchanges the code for tokens, fetches the account's display name, stores
// both against the Luna X user, then redirects back into the app via the
// same lunax:// deep link scheme ASWebAuthenticationSession is listening
// for — ConnectAccountsView.swift reads `name` off this redirect's query string.
router.get('/restream/oauth/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const config = RESTREAM_PLATFORMS[platform];
  const fail = (reason) => res.redirect(`lunax://restream-error?platform=${platform}&reason=${encodeURIComponent(reason)}`);
  if (!config) return fail('Unknown platform');

  try {
    const { code, state, error } = req.query;
    if (error) return fail(error);
    if (!code || !state) return fail('Missing code or state');

    let userId, statePlatform, stateCodeVerifier;
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      userId = decoded.uid;
      statePlatform = decoded.platform;
      stateCodeVerifier = decoded.codeVerifier;
    } catch {
      return fail('Invalid or expired state');
    }
    if (statePlatform !== platform) return fail('State/platform mismatch');
    if (platform === 'kick' && !stateCodeVerifier) return fail('Missing PKCE verifier');

    const redirectUri = `${process.env.RESTREAM_REDIRECT_BASE}/restream/oauth/${platform}/callback`;
    const tokenBody = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });
    // Kick's OAuth 2.1 flow requires the original code_verifier here — the
    // authorization request only sent its SHA-256 hash (code_challenge);
    // this is Kick verifying the client that started the flow is the same
    // one finishing it.
    if (platform === 'kick') {
      tokenBody.set('code_verifier', stateCodeVerifier);
    }
    const tokenResp = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.access_token) {
      console.error(`${platform} restream token exchange failed:`, tokenJson);
      return fail('Token exchange failed');
    }

    _ensureRestreamColumns();

    // Fetch a display name — the exact field differs per platform, so this
    // part is a best-effort guess at each API's actual response shape and
    // may need adjusting once you can see real responses.
    let displayName = '';
    try {
      const profileResp = await fetch(config.profileUrl, {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          ...(platform === 'twitch' ? { 'Client-Id': config.clientId } : {}),
        },
      });
      const profileJson = await profileResp.json();
      if (platform === 'twitch') displayName = profileJson?.data?.[0]?.display_name || '';
      else if (platform === 'youtube') displayName = profileJson?.items?.[0]?.snippet?.title || '';
      else if (platform === 'kick') displayName = profileJson?.data?.[0]?.name || profileJson?.username || '';
    } catch (profileErr) {
      console.error(`${platform} restream profile fetch failed:`, profileErr.message);
      // Non-fatal — connection still saves, just without a display name yet.
    }

    const columnMap = {
      twitch: ['twitch_access_token', 'twitch_refresh_token', 'twitch_display_name'],
      youtube: ['youtube_restream_access_token', 'youtube_restream_refresh_token', 'youtube_restream_channel_name'],
      kick: ['kick_access_token', 'kick_refresh_token', 'kick_display_name'],
    }[platform];

    db.prepare(`
      UPDATE users SET ${columnMap[0]} = ?, ${columnMap[1]} = ?, ${columnMap[2]} = ?, updated_at = ?
      WHERE id = ?
    `).run(tokenJson.access_token, tokenJson.refresh_token || null, displayName, Date.now(), userId);

    res.redirect(`lunax://restream-connected?platform=${platform}&name=${encodeURIComponent(displayName)}`);
  } catch (err) {
    console.error(`${platform} restream callback error:`, err);
    fail('Unexpected error during connect');
  }
});

// DELETE /restream/oauth/:platform — authenticated. Clears stored tokens
// locally; doesn't attempt to revoke on the platform's side (mirrors how
// /instagram-direct/disconnect above handles this same tradeoff).
router.delete('/restream/oauth/:platform', requireAuth, (req, res) => {
  const { platform } = req.params;
  const columnMap = {
    twitch: ['twitch_access_token', 'twitch_refresh_token', 'twitch_display_name'],
    youtube: ['youtube_restream_access_token', 'youtube_restream_refresh_token', 'youtube_restream_channel_name'],
    kick: ['kick_access_token', 'kick_refresh_token', 'kick_display_name'],
  }[platform];
  if (!columnMap) return res.status(400).json({ error: 'Unknown platform' });

  try {
    _ensureRestreamColumns();
    db.prepare(`
      UPDATE users SET ${columnMap[0]} = NULL, ${columnMap[1]} = NULL, ${columnMap[2]} = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Restream disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});
