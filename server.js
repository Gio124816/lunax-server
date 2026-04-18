require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS — allow requests from your frontend URL
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5500',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    // Add your Vercel/Netlify URL here when deployed
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-session-token'],
}));

// Sessions
app.use(session({
  secret: process.env.SESSION_SECRET || 'lunax-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 24 * 60 * 60 * 1000, // 60 days
  }
}));

// ── ROUTES ──
app.use('/auth', require('./routes/auth'));
app.use('/meta', require('./routes/meta'));
app.use('/ai', require('./routes/ai'));
app.use('/posts', require('./routes/posts'));

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Luna X API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── ROOT ──
app.get('/', (req, res) => {
  res.json({
    service: 'Luna X API',
    version: '1.0.0',
    docs: 'See README.md for endpoint documentation',
    health: '/health',
    auth: '/auth/meta'
  });
});

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`\n🌙 Luna X API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Auth:   http://localhost:${PORT}/auth/meta\n`);

  // Start the post scheduler
  const { startScheduler } = require('./routes/scheduler');
  startScheduler();
});

module.exports = app;
