const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ── MIDDLEWARE ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── REGISTER ────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, businessName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const now = Date.now();
    const verifyToken = uuidv4();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, business_name, email_verify_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, email.toLowerCase(), passwordHash, name, businessName || '', verifyToken, now, now);

    db.prepare(`
      INSERT INTO subscriptions (user_id, plan, status, trial_ends_at, created_at)
      VALUES (?, 'trial', 'active', ?, ?)
    `).run(userId, now + 14 * 24 * 60 * 60 * 1000, now);

    const token = jwt.sign({ id: userId, email: email.toLowerCase() }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: userId, email: email.toLowerCase(), name, businessName: businessName || '' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── LOGIN ───────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        businessName: user.business_name,
        subscription: subscription || null
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── ME ──────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  try {
    const user = db.prepare(
  'SELECT id, email, name, business_name, created_at, meta_access_token FROM users WHERE id = ?'
).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.user.id);
    res.json({ ...user, subscription: subscription || null });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── FORGOT PASSWORD ─────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    // Always return success to prevent email enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent' });

    const resetToken = uuidv4();
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
      .run(resetToken, expires, user.id);

    res.json({ message: 'If that email exists, a reset link has been sent' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ── RESET PASSWORD ──────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = db.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?')
      .get(token, Date.now());
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
      .run(passwordHash, user.id);

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── VERIFY EMAIL ────────────────────────────────────────
router.get('/verify', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const user = db.prepare('SELECT id FROM users WHERE email_verify_token = ?').get(token);
    if (!user) return res.status(400).json({ error: 'Invalid verification token' });
    db.prepare('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?').run(user.id);
    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

module.exports = router;
module.exports.requireAuth = requireAuth;
