const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();

// ── DB MIGRATION ──────────────────────────────────────────────────────────────
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS linkinbio (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name      TEXT DEFAULT '',
      bio       TEXT DEFAULT '',
      ig        TEXT DEFAULT '',
      tt        TEXT DEFAULT '',
      yt        TEXT DEFAULT '',
      links     TEXT DEFAULT '[]',
      theme     TEXT DEFAULT 'purple',
      slug      TEXT DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `).run();
} catch(e) {}

try { db.prepare('ALTER TABLE linkinbio ADD COLUMN slug TEXT DEFAULT ""').run(); } catch(e) {}

// ── GET: load user's link-in-bio data ─────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM linkinbio WHERE user_id = ?').get(req.user.id);
  if (!row) return res.json({});
  try {
    res.json({ ...row, links: JSON.parse(row.links || '[]') });
  } catch(e) {
    res.json({ ...row, links: [] });
  }
});

// ── POST: save/update user's link-in-bio data ─────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const { name, bio, ig, tt, yt, links, theme } = req.body;
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || req.user.id;
  const linksJson = JSON.stringify(Array.isArray(links) ? links : []);
  const now = Date.now();

  db.prepare(`
    INSERT INTO linkinbio (user_id, name, bio, ig, tt, yt, links, theme, slug, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      name = excluded.name,
      bio = excluded.bio,
      ig = excluded.ig,
      tt = excluded.tt,
      yt = excluded.yt,
      links = excluded.links,
      theme = excluded.theme,
      slug = excluded.slug,
      updated_at = excluded.updated_at
  `).run(req.user.id, name||'', bio||'', ig||'', tt||'', yt||'', linksJson, theme||'purple', slug, now);

  res.json({ success: true, slug, url: `https://lunaxmedia.com/u/${slug}` });
});

// ── PUBLIC: serve the link-in-bio page (no auth) ─────────────────────────────
router.get('/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM linkinbio WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send('<h1>Page not found</h1>');

  let links = [];
  try { links = JSON.parse(row.links || '[]'); } catch(e) {}

  const themes = {
    purple: { bg:'#1a1228', card:'rgba(255,255,255,0.07)', btn:'#6c5ce7', text:'#fff', sub:'rgba(255,255,255,0.6)' },
    dark:   { bg:'#0d0d0d', card:'rgba(255,255,255,0.05)', btn:'#333',    text:'#fff', sub:'rgba(255,255,255,0.5)' },
    rose:   { bg:'#1a0010', card:'rgba(255,255,255,0.07)', btn:'#e1306c', text:'#fff', sub:'rgba(255,255,255,0.6)' },
    green:  { bg:'#001a12', card:'rgba(255,255,255,0.07)', btn:'#00b09b', text:'#fff', sub:'rgba(255,255,255,0.6)' },
    minimal:{ bg:'#f5f5f7', card:'#fff',                  btn:'#111',    text:'#111', sub:'#666' },
  };
  const t = themes[row.theme] || themes.purple;
  const initial = (row.name || 'L')[0].toUpperCase();

  const socialLinks = [
    row.ig ? `<a href="https://instagram.com/${row.ig.replace('@','')}" style="color:${t.sub};font-size:13px;text-decoration:none;display:block;margin-bottom:4px">📸 @${row.ig.replace('@','')}</a>` : '',
    row.tt ? `<a href="https://tiktok.com/@${row.tt.replace('@','')}" style="color:${t.sub};font-size:13px;text-decoration:none;display:block;margin-bottom:4px">🎵 @${row.tt.replace('@','')}</a>` : '',
    row.yt ? `<a href="${row.yt}" style="color:${t.sub};font-size:13px;text-decoration:none;display:block;margin-bottom:4px">▶️ YouTube</a>` : '',
  ].filter(Boolean).join('');

  const linkButtons = links
    .filter(l => l.title && l.url)
    .map(l => `<a href="${l.url}" style="display:block;background:${t.card};border-radius:14px;padding:15px 20px;text-align:center;font-size:15px;font-weight:500;color:${t.text};text-decoration:none;margin-bottom:12px;border:1px solid rgba(255,255,255,0.08);transition:.2s" onmouseover="this.style.opacity='.8'" onmouseout="this.style.opacity='1'">${l.title}</a>`)
    .join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${row.name || 'Link in bio'}</title>
  <meta property="og:title" content="${row.name || 'Link in bio'}">
  <meta property="og:description" content="${row.bio || ''}">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${t.bg};min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    .card{width:100%;max-width:420px}
    .avatar{width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,${t.btn},#a594ff);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:#fff;margin:0 auto 16px}
    .name{font-size:22px;font-weight:700;color:${t.text};text-align:center;margin-bottom:6px}
    .bio{font-size:14px;color:${t.sub};text-align:center;line-height:1.6;margin-bottom:16px}
    .socials{text-align:center;margin-bottom:24px}
    .powered{text-align:center;margin-top:24px;font-size:11px;color:${t.sub};opacity:.5}
    .powered a{color:inherit;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="avatar">${initial}</div>
    <div class="name">${row.name || ''}</div>
    ${row.bio ? `<div class="bio">${row.bio}</div>` : ''}
    ${socialLinks ? `<div class="socials">${socialLinks}</div>` : ''}
    ${linkButtons}
    <div class="powered">Powered by <a href="https://lunaxmedia.com">Luna X</a></div>
  </div>
</body>
</html>`);
});

module.exports = router;
