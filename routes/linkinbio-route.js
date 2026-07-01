const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/database');

const router = express.Router();

// ── DB MIGRATION ──────────────────────────────────────────────────────────────
// Disable foreign keys during table creation — Railway resets SQLite on redeploy
// so the users table may not exist yet when linkinbio table is created
try { db.pragma('foreign_keys = OFF'); } catch(e) {}

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS linkinbio (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL UNIQUE,
      name       TEXT DEFAULT '',
      bio        TEXT DEFAULT '',
      ig         TEXT DEFAULT '',
      tt         TEXT DEFAULT '',
      yt         TEXT DEFAULT '',
      links      TEXT DEFAULT '[]',
      theme      TEXT DEFAULT 'dark',
      slug       TEXT DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `).run();
} catch(e) {}

try { db.pragma('foreign_keys = ON'); } catch(e) {}

// Add new columns safely
const newCols = [
  'ALTER TABLE linkinbio ADD COLUMN slug TEXT DEFAULT ""',
  'ALTER TABLE linkinbio ADD COLUMN cta_text TEXT DEFAULT ""',
  'ALTER TABLE linkinbio ADD COLUMN cta_url TEXT DEFAULT ""',
  'ALTER TABLE linkinbio ADD COLUMN avatar_url TEXT DEFAULT ""',
  'ALTER TABLE linkinbio ADD COLUMN socials TEXT DEFAULT "[]"',
  'ALTER TABLE linkinbio ADD COLUMN linkedin TEXT DEFAULT ""',
];
for (const col of newCols) {
  try { db.prepare(col).run(); } catch(e) {}
}

// ── GET: load user's link-in-bio data ─────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM linkinbio WHERE user_id = ?').get(req.user.id);
  if (!row) return res.json({});
  try {
    res.json({
      ...row,
      links:   JSON.parse(row.links   || '[]'),
      socials: JSON.parse(row.socials || '[]'),
      ctaText:   row.cta_text   || '',
      ctaUrl:    row.cta_url    || '',
      avatarUrl: row.avatar_url || '',
    });
  } catch(e) {
    res.json({ ...row, links: [], socials: [] });
  }
});

// ── POST: save/update user's link-in-bio data ─────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const { name, bio, links, theme, ctaText, ctaUrl, avatarUrl, socials } = req.body;

  // Slug: use what the client sent, otherwise derive from name
  let slug = (req.body.slug || '').trim();
  if (!slug) {
    slug = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || String(req.user.id);
  }

  const linksJson   = JSON.stringify(Array.isArray(links)   ? links   : []);
  const socialsJson = JSON.stringify(Array.isArray(socials) ? socials : []);
  const now = Date.now();

  try { db.pragma('foreign_keys = OFF'); } catch(e) {}
  db.prepare(`
    INSERT INTO linkinbio (user_id, name, bio, links, theme, slug, cta_text, cta_url, avatar_url, socials, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      name       = excluded.name,
      bio        = excluded.bio,
      links      = excluded.links,
      theme      = excluded.theme,
      slug       = excluded.slug,
      cta_text   = excluded.cta_text,
      cta_url    = excluded.cta_url,
      avatar_url = excluded.avatar_url,
      socials    = excluded.socials,
      updated_at = excluded.updated_at
  `).run(req.user.id, name||'', bio||'', linksJson, theme||'dark', slug, ctaText||'', ctaUrl||'', avatarUrl||'', socialsJson, now);
  try { db.pragma('foreign_keys = ON'); } catch(e) {}

  res.json({ success: true, slug, url: `https://lunaxmedia.com/u/${slug}` });
});

// ── PUBLIC: serve the link-in-bio page (no auth) ─────────────────────────────
router.get('/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM linkinbio WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d0d0d;color:#fff"><h2>Page not found</h2></body></html>`);

  let links = [];
  let socials = [];
  try { links   = JSON.parse(row.links   || '[]'); } catch(e) {}
  try { socials = JSON.parse(row.socials || '[]'); } catch(e) {}

  const themes = {
    dark:    { bg:'#0d0d0d',  card:'rgba(255,255,255,0.07)', btn:'#6c5ce7', text:'#fff',   sub:'rgba(255,255,255,0.55)', border:'rgba(255,255,255,0.08)' },
    purple:  { bg:'#1a1228',  card:'rgba(255,255,255,0.07)', btn:'#6c5ce7', text:'#fff',   sub:'rgba(255,255,255,0.6)',  border:'rgba(255,255,255,0.08)' },
    rose:    { bg:'#1a0010',  card:'rgba(255,255,255,0.07)', btn:'#e1306c', text:'#fff',   sub:'rgba(255,255,255,0.6)',  border:'rgba(255,255,255,0.08)' },
    green:   { bg:'#001a12',  card:'rgba(255,255,255,0.07)', btn:'#00b09b', text:'#fff',   sub:'rgba(255,255,255,0.6)',  border:'rgba(255,255,255,0.08)' },
    minimal: { bg:'#f5f5f7',  card:'#fff',                   btn:'#111',    text:'#111',   sub:'#666',                  border:'#e8e8f0' },
  };
  const t = themes[row.theme] || themes.dark;
  const initial = (row.name || 'L')[0].toUpperCase();

  // Platform deep-link helpers
  const platformMeta = {
    instagram: { emoji: '📸', label: 'Instagram', deepLink: h => `https://instagram.com/${h.replace('@','')}` },
    tiktok:    { emoji: '🎵', label: 'TikTok',    deepLink: h => `https://tiktok.com/@${h.replace('@','')}` },
    youtube:   { emoji: '▶️', label: 'YouTube',   deepLink: h => h.startsWith('http') ? h : `https://youtube.com/${h}` },
    linkedin:  { emoji: '💼', label: 'LinkedIn',  deepLink: h => h.startsWith('http') ? h : `https://linkedin.com/in/${h}` },
    facebook:  { emoji: '📘', label: 'Facebook',  deepLink: h => `https://facebook.com/${h.replace('@','')}` },
  };

  // Render social pills
  const socialPills = socials.map(s => {
    const meta = platformMeta[s.platform] || { emoji: '🔗', deepLink: h => h };
    const url  = meta.deepLink(s.handle || '');
    const displayHandle = s.handle.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    const labelBadge = s.label ? `<span style="font-size:10px;opacity:.6;margin-left:4px">${s.label}</span>` : '';
    return `<a href="${url}" style="display:inline-flex;align-items:center;gap:5px;background:${t.card};border:1px solid ${t.border};border-radius:20px;padding:5px 12px;font-size:12px;color:${t.sub};text-decoration:none;margin:3px">${meta.emoji} ${displayHandle}${labelBadge}</a>`;
  }).join('');

  // CTA button
  const ctaBtn = (row.cta_text && row.cta_url)
    ? `<a href="${row.cta_url}" class="cta-btn">${row.cta_text}</a>`
    : '';

  // Link buttons
  const linkButtons = links
    .filter(l => l.title && l.url)
    .map(l => {
      const emoji = l.emoji ? `<span style="margin-right:10px;font-size:16px">${l.emoji}</span>` : '';
      return `<a href="${l.url}" class="link-btn">${emoji}<span>${l.title}</span><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="opacity:.4;margin-left:auto"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>`;
    }).join('');

  // Avatar
  const avatarHtml = row.avatar_url
    ? `<img src="${row.avatar_url}" class="avatar-img" alt="${row.name}">`
    : `<div class="avatar-initials">${initial}</div>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${row.name || 'Link in bio'}</title>
  <meta property="og:title" content="${row.name || 'Link in bio'}">
  <meta property="og:description" content="${row.bio || ''}">
  ${row.avatar_url ? `<meta property="og:image" content="${row.avatar_url}">` : ''}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: ${t.bg};
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 48px 16px 64px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .card { width: 100%; max-width: 440px; }

    /* Top gradient glow */
    .glow {
      position: fixed; top: 0; left: 0; right: 0; height: 200px;
      background: radial-gradient(ellipse at 50% 0%, ${t.btn}33 0%, transparent 70%);
      pointer-events: none;
    }

    /* Avatar */
    .avatar-wrap { display: flex; justify-content: center; margin-bottom: 16px; }
    .avatar-img {
      width: 84px; height: 84px; border-radius: 50%;
      object-fit: cover; border: 3px solid ${t.btn}55;
    }
    .avatar-initials {
      width: 84px; height: 84px; border-radius: 50%;
      background: linear-gradient(135deg, ${t.btn}66, ${t.btn}33);
      border: 3px solid ${t.btn}55;
      display: flex; align-items: center; justify-content: center;
      font-size: 34px; font-weight: 700; color: ${t.btn};
    }

    .name { font-size: 22px; font-weight: 700; color: ${t.text}; text-align: center; margin-bottom: 6px; }
    .bio  { font-size: 14px; color: ${t.sub}; text-align: center; line-height: 1.6; margin-bottom: 16px; }
    .socials { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-bottom: 24px; }

    /* CTA button */
    .cta-btn {
      display: block; width: 100%;
      background: ${t.btn}; color: #fff;
      border-radius: 14px; padding: 16px 20px;
      text-align: center; font-size: 16px; font-weight: 700;
      text-decoration: none; margin-bottom: 16px;
      transition: opacity .15s, transform .15s;
    }
    .cta-btn:hover { opacity: .88; transform: translateY(-1px); }

    /* Link buttons */
    .link-btn {
      display: flex; align-items: center;
      background: ${t.card}; border: 1px solid ${t.border};
      border-radius: 14px; padding: 15px 18px;
      font-size: 15px; font-weight: 500; color: ${t.text};
      text-decoration: none; margin-bottom: 10px;
      transition: opacity .15s, transform .15s;
    }
    .link-btn:hover { opacity: .8; transform: translateY(-1px); }

    .powered { text-align: center; margin-top: 32px; font-size: 11px; color: ${t.sub}; opacity: .4; }
    .powered a { color: inherit; text-decoration: none; }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="card">
    <div class="avatar-wrap">${avatarHtml}</div>
    <div class="name">${row.name || ''}</div>
    ${row.bio ? `<div class="bio">${row.bio}</div>` : ''}
    ${socialPills ? `<div class="socials">${socialPills}</div>` : ''}
    ${ctaBtn}
    ${linkButtons}
    <div class="powered">Powered by <a href="https://lunaxmedia.com">Luna X</a></div>
  </div>
</body>
</html>`);
});

module.exports = router;
