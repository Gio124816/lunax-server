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
const { startScheduler } = require('./routes/scheduler');
const { requireAuth } = require('./routes/auth');
const feedbackRoutes = require('./routes/feedback');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
app.use('/feedback', feedbackRoutes);
app.use('/notifications', notificationRoutes);

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
