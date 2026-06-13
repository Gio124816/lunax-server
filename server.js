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

const app = express();
const PORT = process.env.PORT || 3001;

// — TRUST PROXY (fixes express-rate-limit warning on Railway) ——
app.set('trust proxy', 1);

// — SECURITY —————————————————————————
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
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

// — HEALTH CHECK ————————————————————
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
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
app.use('/feedback', feedbackRoutes);
app.use('/notifications', notificationRoutes);
app.use('/invite', inviteRoutes);
app.use('/referral', inviteRoutes);
app.use('/oauth', tiktokRoutes);
app.use('/oauth', youtubeRoutes);
app.use('/oauth', linkedinRoutes);
app.use('/comments', requireAuth, commentsRoutes);
app.use('/analytics', requireAuth, analyticsRoutes);

// — INSTAGRAM APP REVIEW ENDPOINTS ——————————————————————
// Required by Meta before IG-direct App Review can be approved.
// Deauthorize callback: called by Meta when a user removes the app from their
// Instagram settings. We delete their social_accounts row + wipe IG tokens.
app.post('/auth/instagram-direct/deauthorize', express.json(), (req, res) => {
  // Meta sends a signed_request param. For App Review we just need the
  // endpoint to exist and return 200. Full signed_request verification is
  // optional for IG-direct (unlike Facebook Login) but good practice.
  try {
    const db = require('./db/database');
    const { signed_request } = req.body || {};
    if (signed_request) {
      // Decode payload (base64url second segment, no verification required
      // for the deauth callback per IG docs — verification is for data deletion)
      const [, payload] = signed_request.split('.');
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const igUserId = data.user_id;
      if (igUserId) {
        // Remove the social_accounts row for this IG user
        db.prepare(`
          DELETE FROM social_accounts
          WHERE platform = 'instagram-direct' AND platform_account_id = ?
        `).run(String(igUserId));
        // Also clear legacy token columns on the users row if present
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
    res.status(200).json({ success: true }); // Always 200 to Meta
  }
});

// Data deletion request: called by Meta when a user requests their data be
// deleted under GDPR/CCPA. Must return a { url, confirmation_code } so Meta
// can show the user a status page.
app.post('/auth/instagram-direct/data-deletion', express.json(), (req, res) => {
  try {
    const db = require('./db/database');
    const crypto = require('crypto');
    const { signed_request } = req.body || {};
    let igUserId = null;

    if (signed_request) {
      const [sig, payload] = signed_request.split('.');
      // Verify HMAC-SHA256 signature using IG app secret
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
      // Find the Luna X user linked to this IG account
      const acct = db.prepare(`
        SELECT user_id FROM social_accounts
        WHERE platform = 'instagram-direct' AND platform_account_id = ?
      `).get(String(igUserId));

      if (acct) {
        // Soft-delete: mark user deleted_at so the 30-day hard-delete job
        // in database.js picks it up. This cascades to posts, sessions, etc.
        db.prepare(`
          UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?
        `).run(Date.now(), Date.now(), acct.user_id);
        // Also immediately remove the social account row
        db.prepare(`
          DELETE FROM social_accounts
          WHERE platform = 'instagram-direct' AND platform_account_id = ?
        `).run(String(igUserId));
        console.log(`Data deletion requested for IG user ${igUserId} → Luna X user ${acct.user_id} (confirmation: ${confirmationCode})`);
      }
    }

    // Meta requires this exact shape
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
