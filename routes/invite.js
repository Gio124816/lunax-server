const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('./auth');
const db = require('../db/database');

// ── GET /invite/validate ──
// Check if an invite code or whitelisted email is valid
router.post('/validate', (req, res) => {
  const { code, email } = req.body;

  // 1. Check email whitelist from env var (comma-separated)
  const whitelist = (process.env.BETA_WHITELIST || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (email && whitelist.includes(email.toLowerCase())) {
    return res.json({ valid: true, method: 'whitelist' });
  }

  // 2. Check invite code
  if (code) {
    const invite = db.prepare(`
      SELECT * FROM invite_codes WHERE code = ? AND (max_uses = 0 OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)
    `).get(code.trim().toUpperCase(), Date.now());
    if (invite) {
      return res.json({ valid: true, method: 'invite_code', inviteId: invite.id });
    }
  }

  res.status(403).json({ valid: false, error: 'Invalid invite code or email not on access list' });
});

// ── POST /invite/use ──
// Mark an invite code as used after successful registration
router.post('/use', (req, res) => {
  const { code, email } = req.body;
  if (!code) return res.json({ ok: true });
  try {
    const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code.trim().toUpperCase());
    if (invite) {
      db.prepare('UPDATE invite_codes SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(Date.now(), invite.id);
      db.prepare('INSERT INTO invite_uses (invite_id, email, used_at) VALUES (?, ?, ?)').run(invite.id, email || '', Date.now());
    }
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: true }); // non-blocking
  }
});

// ── POST /invite/create ── (admin only — protected by ADMIN_SECRET)
router.post('/create', (req, res) => {
  const { secret, label, maxUses, expiresInDays } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const code = req.body.code || generateCode();
  const expiresAt = expiresInDays ? Date.now() + expiresInDays * 86400000 : null;
  try {
    db.prepare(`
      INSERT INTO invite_codes (id, code, label, max_uses, uses, expires_at, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(uuidv4(), code.toUpperCase(), label || '', maxUses || 0, expiresAt, Date.now());
    res.json({ code: code.toUpperCase(), label, maxUses: maxUses || 'unlimited', expiresAt });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /invite/list ── (admin only)
router.get('/list', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const codes = db.prepare('SELECT * FROM invite_codes ORDER BY created_at DESC').all();
  res.json({ codes });
});

// ── DELETE /invite/:code ── (admin only)
router.delete('/:code', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(req.params.code.toUpperCase());
  res.json({ deleted: true });
});

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── POST /invite/bulk ── (admin only)
// Generate codes in bulk and return GHL-ready CSV
router.post('/bulk', (req, res) => {
  const { secret, count, label, maxUses, expiresInDays } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const total = Math.min(parseInt(count) || 100, 5000);
  const uses = parseInt(maxUses) || 3;
  const expiresAt = expiresInDays ? Date.now() + expiresInDays * 86400000 : null;
  const baseUrl = process.env.FRONTEND_URL || 'https://lunaxmedia.com';

  const codes = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO invite_codes (id, code, label, max_uses, uses, expires_at, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (let i = 0; i < total; i++) {
      const code = generateCode();
      const id = uuidv4();
      insert.run(id, code, label || 'bulk', uses, expiresAt, Date.now());
      codes.push(code);
    }
  });

  insertMany();

  // Return CSV formatted for GHL custom fields
  // GHL expects: columns you can map to contact fields
  const csv = [
    'code,invite_link,max_uses',
    ...codes.map(c => `${c},${baseUrl}?code=${c},${uses}`)
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="lunax-invite-codes-${Date.now()}.csv"`);
  res.send(csv);
});

module.exports = router;
