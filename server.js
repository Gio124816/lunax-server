require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth');
const billingRoutes = require('./routes/billing');
const metaRoutes = require('./routes/meta');
const aiRoutes = require('./routes/ai');
const postsRoutes = require('./routes/posts');
const uploadRoutes = require('./routes/upload');
const transcribeRoutes = require('./routes/transcribe');
const { startScheduler } = require('./routes/scheduler');
const { requireAuth } = require('./routes/auth');
const feedbackRoutes = require('./routes/feedback');
const notificationRoutes = require('./routes/notifications');
const inviteRoutes = require('./routes/invite');
const tiktokRoutes = require('./routes/tiktok');
const youtubeRoutes = require('./routes/youtube');
const linkedinRoutes = require('./routes/linkedin');
const voiceRoutes = require('./routes/voice');
const commentsRoutes = require('./routes/comments');
const analyticsRoutes = require('./routes/analytics');
const linkInBioRoutes = require('./routes/linkinbio-route');
const streamRoutes = require('./routes/stream');
const vodRoutes = require('./routes/vod-import');
const teamRoutes = require('./routes/team');

const app = express();
const PORT = process.env.PORT || 3001;

// — TRUST PROXY (fixes express-rate-limit warning on Railway) ——
app.set('trust proxy', 1);

// — SECURITY —————————————————————————
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
  // FIX #8: Add referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://lunaxmedia.com',
    'https://www.lunaxmedia.com',
    /\.netlify\.app$/,
    /\.netlify\.live$/
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
}));

// /config is intentionally public — Meta App ID is not a secret.
// It is embedded in every OAuth redirect URL and visible to anyone
// who inspects the login flow. Only META_APP_SECRET must stay private.
app.get('/config', (req, res) => {
  res.json({
    metaAppId: process.env.META_APP_ID
  });
});

// — STRIPE WEBHOOK — must be raw body BEFORE json middleware —
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

// — BODY PARSING ————————————————————
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

// — RATE LIMITING ———————————————————
const globalLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests – please slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts – please wait 15 minutes' }
});

const aiLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'AI rate limit reached – please wait a moment' }
});

app.use(globalLimit);
app.use('/auth/login', authLimit);
app.use('/auth/register', authLimit);
app.use('/auth/forgot-password', authLimit);
app.use('/ai', aiLimit);

// FIX #7: Catch unhandled async rejections before they can crash the server
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// FIX #6: /health returns minimal info — no version or uptime exposed
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// — ROUTES ——————————————————————————
app.use('/auth', authRoutes);
app.use('/auth', oauthRoutes);
app.use('/billing', billingRoutes);
app.use('/meta', requireAuth, metaRoutes);
app.use('/ai', requireAuth, aiRoutes);
app.use('/posts', requireAuth, postsRoutes);
app.use('/upload', requireAuth, uploadRoutes);
app.use('/transcribe', requireAuth, transcribeRoutes);
app.use('/voice', requireAuth, voiceRoutes);

// FIX #2: feedback, notifications, invite, referral now require auth
app.use('/feedback', requireAuth, feedbackRoutes);
app.use('/notifications', requireAuth, notificationRoutes);
app.use('/invite', requireAuth, inviteRoutes);
app.use('/referral', requireAuth, inviteRoutes);

// FIX #3: OAuth callback routes — no JWT required during redirect flow,
// but each individual route file MUST validate the `state` param to prevent CSRF.
// See notes in tiktok.js / youtube.js / linkedin.js.
app.use('/oauth', tiktokRoutes);
app.use('/oauth', youtubeRoutes);
app.use('/oauth', linkedinRoutes);

app.use('/comments', requireAuth, commentsRoutes);
app.use('/analytics', requireAuth, analyticsRoutes);

// — TEAM MEMBERSHIP —————————————————
// Mounted without top-level requireAuth on purpose: POST /team/accept-invite
// must stay public (the invitee has no account/JWT yet to accept it with).
// Every other route in team.js applies requireAuth individually — same
// mixed-auth pattern as /stream below.
app.use('/team', teamRoutes);

// — LINK IN BIO ————————————————————
// FIX #4: Authenticated CRUD uses the full router
app.use('/linkinbio', requireAuth, linkInBioRoutes);
// Public page: lunaxmedia.com/u/:slug — only GET /:slug should be reachable here.
// Ensure linkInBioRoutes only exposes read-only routes without auth; all write
// routes must check for authentication internally or be absent from the public mount.
app.use('/u', linkInBioRoutes);

// — STREAM (RTMP ingest + clip markers) ————————————
// /stream/validate and /stream/started/ended use x-rtmp-secret (no JWT)
// /stream/key, /stream/clip, /stream/sessions use requireAuth
app.use('/stream', streamRoutes);
app.use('/vod', requireAuth, vodRoutes);

// — INSTAGRAM APP REVIEW ENDPOINTS ——————————————————————
app.post('/auth/instagram-direct/deauthorize', express.json(), (req, res) => {
  try {
    const db = require('./db/database');
    const { signed_request } = req.body || {};
    if (signed_request) {
      const [, payload] = signed_request.split('.');
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const igUserId = data.user_id;
      if (igUserId) {
        db.prepare(`
          DELETE FROM social_accounts
          WHERE platform = 'instagram-direct' AND platform_account_id = ?
        `).run(String(igUserId));
        db.prepare(`
          UPDATE users SET
            meta_access_token = NULL,
            meta_ig_id = NULL,
            meta_ig_name = NULL,
            updated_at = ?
          WHERE meta_ig_id = ?
        `).run(Date.now(), String(igUserId));
        console.log(`Deauthorized IG user ${igUserId}`);
      }
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Deauthorize error:', err);
    res.status(200).json({ success: true });
  }
});

app.post('/auth/instagram-direct/data-deletion', express.json(), (req, res) => {
  try {
    const db = require('./db/database');
    const crypto = require('crypto');
    const { signed_request } = req.body || {};
    let igUserId = null;

    if (signed_request) {
      const [sig, payload] = signed_request.split('.');
      const appSecret = process.env.IG_APP_SECRET;
      if (appSecret) {
        const expectedSig = crypto
          .createHmac('sha256', appSecret)
          .update(payload)
          .digest('base64url');
        if (sig !== expectedSig) {
          return res.status(400).json({ error: 'Invalid signature' });
        }
      }
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      igUserId = data.user_id;
    }

    const confirmationCode = crypto.randomBytes(8).toString('hex');

    if (igUserId) {
      const acct = db.prepare(`
        SELECT user_id FROM social_accounts
        WHERE platform = 'instagram-direct' AND platform_account_id = ?
      `).get(String(igUserId));

      if (acct) {
        db.prepare(`
          UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?
        `).run(Date.now(), Date.now(), acct.user_id);
        db.prepare(`
          DELETE FROM social_accounts
          WHERE platform = 'instagram-direct' AND platform_account_id = ?
        `).run(String(igUserId));
        console.log(`Data deletion requested for IG user ${igUserId} → Luna X user ${acct.user_id} (confirmation: ${confirmationCode})`);
      }
    }

    res.status(200).json({
      url: `${process.env.APP_FRONTEND_URL || 'https://lunaxmedia.com'}/data-deletion?code=${confirmationCode}`,
      confirmation_code: confirmationCode
    });
  } catch (err) {
    console.error('Data deletion error:', err);
    res.status(500).json({ error: 'Data deletion failed' });
  }
});

// — START SCHEDULER —————————————————
startScheduler();

// — ERROR HANDLER ———————————————————
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

// — NOT FOUND ———————————————————————
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// — START ————————————————————————————
app.listen(PORT, () => {
  console.log(`✓ Luna X server running on port ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
});

module.exports = app;
