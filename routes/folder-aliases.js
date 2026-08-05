// ════════════════════════════════════════════════════════════════════════════
// routes/folder-aliases.js
// ════════════════════════════════════════════════════════════════════════════
// Syncs the CORRECTED FOLDER NAME for a spoken/typed alias across devices —
// e.g. "izuka" → "YAZUKA MEDIA". Deliberately does NOT sync a path or a
// security-scoped bookmark: those are meaningless on a second Mac (different
// sandbox, different disk) and don't exist at all on iOS. What's actually
// portable is the plain fact "this word means that real folder name" — a
// second device still has to search its own filesystem for a folder with
// that name and grant its own one-time access, exactly like
// FolderBookmarkManager already does locally, just searching for the right
// name instead of the original mishearing.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS folder_aliases (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      alias       TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(user_id, alias)
    )
  `).run();
} catch (e) { console.error('folder_aliases migration error:', e.message); }

// ── GET /folder-aliases — every alias this user has taught Luna X ────────
router.get('/', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, alias, folder_name, created_at FROM folder_aliases WHERE user_id = ? ORDER BY created_at ASC
    `).all(req.user.id);
    res.json({
      aliases: rows.map(r => ({ id: r.id, alias: r.alias, folderName: r.folder_name, createdAt: r.created_at }))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /folder-aliases — body: { alias, folderName } ───────────────────
// Upserts on (user_id, alias) — re-teaching the same spoken name just
// updates which real folder it points to, rather than accumulating stale
// duplicates.
router.post('/', requireAuth, (req, res) => {
  try {
    const alias = (req.body?.alias || '').trim().toLowerCase();
    const folderName = (req.body?.folderName || '').trim();
    if (!alias || !folderName) return res.status(400).json({ error: 'alias and folderName are required' });

    const existing = db.prepare(`SELECT id FROM folder_aliases WHERE user_id = ? AND alias = ?`).get(req.user.id, alias);
    if (existing) {
      db.prepare(`UPDATE folder_aliases SET folder_name = ?, created_at = ? WHERE id = ?`)
        .run(folderName, Date.now(), existing.id);
      return res.json({ id: existing.id, alias, folderName });
    }
    const id = uuidv4();
    db.prepare(`INSERT INTO folder_aliases (id, user_id, alias, folder_name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, req.user.id, alias, folderName, Date.now());
    res.json({ id, alias, folderName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE /folder-aliases/:id ────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  try {
    db.prepare(`DELETE FROM folder_aliases WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
