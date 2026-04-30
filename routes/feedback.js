const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { sendEmail } = require('./email');

// ── CREATE FEEDBACK TABLE (add to your database.js schema) ──
// db.prepare(`CREATE TABLE IF NOT EXISTS feedback (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   user_id TEXT,
//   email TEXT,
//   type TEXT NOT NULL,
//   rating INTEGER,
//   message TEXT NOT NULL,
//   created_at INTEGER NOT NULL
// )`).run();

// ── POST /feedback ──
router.post('/', async (req, res) => {
  try {
    const { type, rating, message, email } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const now = Date.now();

    // Get user_id from token if logged in
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        userId = payload.id;
      } catch(e) {}
    }

    // Store in DB
    db.prepare(`
      INSERT INTO feedback (user_id, email, type, rating, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, email || null, type || 'other', rating || null, message.trim(), now);

    // Email notification to you
    const typeEmoji = { bug: '🐛', idea: '💡', praise: '✨', other: '💬' }[type] || '💬';
    const stars = rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : 'Not rated';

    await sendEmail({
      to: process.env.FEEDBACK_EMAIL || 'giovanni@arderemedia.com',
      subject: `${typeEmoji} Luna X Feedback: ${type || 'other'} (${stars})`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#6c5ce7">New Luna X Feedback ${typeEmoji}</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <tr><td style="padding:6px 0;color:#666;width:80px">Type</td><td style="padding:6px 0;font-weight:600">${type || 'other'}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Rating</td><td style="padding:6px 0;color:#f59e0b;font-size:18px">${stars}</td></tr>
            <tr><td style="padding:6px 0;color:#666">From</td><td style="padding:6px 0">${email || userId || 'Anonymous'}</td></tr>
          </table>
          <div style="background:#f8f7ff;border-left:3px solid #6c5ce7;padding:12px 16px;border-radius:0 8px 8px 0;font-size:15px;line-height:1.6">
            ${message.trim().replace(/\n/g, '<br>')}
          </div>
          <p style="color:#999;font-size:12px;margin-top:16px">Sent from Luna X v1.0</p>
        </div>
      `
    }).catch(() => {}); // Don't fail if email fails

    res.json({ ok: true, message: 'Feedback received!' });

  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ── GET /feedback (admin view) ──
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100
    `).all();
    res.json({ feedback: rows });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

module.exports = router;
