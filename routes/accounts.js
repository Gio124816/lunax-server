// ════════════════════════════════════════════════════════════════════════════
// routes/accounts.js
// ════════════════════════════════════════════════════════════════════════════
// Multi-account management — lets one Luna X login connect and manage many
// social accounts (multiple Instagram/Facebook/TikTok accounts), optionally
// grouped into named "clients" for an agency/manager workflow. This is
// deliberately just the CRUD layer over social_accounts + account_groups;
// the actual OAuth connect flow (oauth.js) is what populates these rows, and
// the publish pipeline (meta.js, comments.js — Phase 2) is what will read
// an explicit account_id from here instead of assuming a single owner row.
//
// USAGE from the frontend:
//   GET    /accounts                → { groups: [...], ungrouped: [...] }
//   PATCH  /accounts/:id            body: { accountName?, groupId?, isDefault? }
//   DELETE /accounts/:id
//   POST   /accounts/groups         body: { name }
//   PATCH  /accounts/groups/:id     body: { name }
//   DELETE /accounts/groups/:id     (ungroups member accounts, doesn't delete them)

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('./auth');
const { v4: uuidv4 } = require('uuid');
const { getAllowedGroupIds } = require('./team');

// Same pattern as every other route file — team members manage the shared
// owner's connected accounts, not their own separate (nonexistent) set.
function _resolveOwnerId(userId) {
  const row = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(userId);
  return row && row.team_owner_id ? row.team_owner_id : userId;
}

// Ungrouped (groupId null) is always accessible — there's no client label
// to restrict there, matching GET /'s treatment of ungrouped accounts.
function _isGroupAccessible(userId, groupId) {
  if (!groupId) return true;
  const allowed = getAllowedGroupIds(userId);
  return allowed === null || allowed.includes(groupId);
}

function _serializeAccount(a) {
  return {
    id: a.id,
    platform: a.platform,
    accountName: a.account_name,
    accountHandle: a.account_handle,
    pageId: a.page_id,
    groupId: a.group_id,
    isDefault: !!a.is_default,
    connectedAt: a.connected_at,
    lastUsedAt: a.last_used_at,
  };
}

// ── GET /accounts — everything the current owner has connected ──────────
router.get('/', requireAuth, (req, res) => {
  try {
    const ownerId = _resolveOwnerId(req.user.id);
    const accounts = db.prepare(`
      SELECT * FROM social_accounts WHERE user_id = ? ORDER BY connected_at ASC
    `).all(ownerId);
    const groups = db.prepare(`
      SELECT * FROM account_groups WHERE user_id = ? ORDER BY created_at ASC
    `).all(ownerId);

    const byGroup = {};
    const ungrouped = [];
    accounts.forEach(a => {
      const serialized = _serializeAccount(a);
      if (a.group_id) {
        if (!byGroup[a.group_id]) byGroup[a.group_id] = [];
        byGroup[a.group_id].push(serialized);
      } else {
        ungrouped.push(serialized);
      }
    });

    res.json({
      // Restricted members (getAllowedGroupIds returns non-null) only see
      // the client groups they've been explicitly granted — resolveOwnerId
      // alone would give every team member the owner's full account list
      // regardless, which is the existing default and stays that way for
      // anyone nobody has ever restricted (allowedGroupIds === null).
      groups: groups
        .filter(g => {
          const allowed = getAllowedGroupIds(req.user.id);
          return allowed === null || allowed.includes(g.id);
        })
        .map(g => ({
          id: g.id,
          name: g.name,
          accounts: byGroup[g.id] || [],
        })),
      ungrouped,
    });
  } catch (err) {
    console.error('GET /accounts error:', err);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// ── PATCH /accounts/:id — rename, move to a group, or set as default ────
router.patch('/:id', requireAuth, (req, res) => {
  try {
    const ownerId = _resolveOwnerId(req.user.id);
    const account = db.prepare(`SELECT * FROM social_accounts WHERE id = ? AND user_id = ?`).get(req.params.id, ownerId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!_isGroupAccessible(req.user.id, account.group_id)) {
      return res.status(403).json({ error: 'You do not have access to this client' });
    }

    const { accountName, groupId, isDefault } = req.body || {};

    // groupId: null/empty explicitly ungroups; undefined leaves it alone.
    if (groupId !== undefined) {
      if (groupId) {
        const group = db.prepare(`SELECT id FROM account_groups WHERE id = ? AND user_id = ?`).get(groupId, ownerId);
        if (!group) return res.status(400).json({ error: 'Group not found' });
        if (!_isGroupAccessible(req.user.id, groupId)) {
          return res.status(403).json({ error: 'You do not have access to that client' });
        }
      }
      db.prepare(`UPDATE social_accounts SET group_id = ? WHERE id = ?`).run(groupId || null, account.id);
    }

    if (accountName !== undefined) {
      db.prepare(`UPDATE social_accounts SET account_name = ? WHERE id = ?`).run(accountName, account.id);
    }

    // Only one account per platform can be default — clear any existing
    // default on this platform before setting the new one.
    if (isDefault === true) {
      db.prepare(`UPDATE social_accounts SET is_default = 0 WHERE user_id = ? AND platform = ?`)
        .run(ownerId, account.platform);
      db.prepare(`UPDATE social_accounts SET is_default = 1 WHERE id = ?`).run(account.id);
    }

    const updated = db.prepare(`SELECT * FROM social_accounts WHERE id = ?`).get(account.id);
    res.json({ account: _serializeAccount(updated) });
  } catch (err) {
    console.error('PATCH /accounts/:id error:', err);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// ── DELETE /accounts/:id — disconnect a single account ──────────────────
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const ownerId = _resolveOwnerId(req.user.id);
    const account = db.prepare(`SELECT * FROM social_accounts WHERE id = ? AND user_id = ?`).get(req.params.id, ownerId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!_isGroupAccessible(req.user.id, account.group_id)) {
      return res.status(403).json({ error: 'You do not have access to this client' });
    }

    db.prepare(`DELETE FROM social_accounts WHERE id = ?`).run(account.id);

    // If this was the default for its platform, promote the next-oldest
    // connected account on that platform (if any) so posting doesn't
    // silently lose a fallback account.
    if (account.is_default) {
      const next = db.prepare(`
        SELECT id FROM social_accounts WHERE user_id = ? AND platform = ? ORDER BY connected_at ASC LIMIT 1
      `).get(ownerId, account.platform);
      if (next) db.prepare(`UPDATE social_accounts SET is_default = 1 WHERE id = ?`).run(next.id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /accounts/:id error:', err);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

// ── POST /accounts/groups — create a named client ────────────────────────
router.post('/groups', requireAuth, (req, res) => {
  try {
    const ownerId = _resolveOwnerId(req.user.id);
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });

    const id = uuidv4();
    db.prepare(`INSERT INTO account_groups (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, ownerId, name.trim(), Date.now());
    res.json({ group: { id, name: name.trim(), accounts: [] } });
  } catch (err) {
    console.error('POST /accounts/groups error:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// ── PATCH /accounts/groups/:id — rename a client ─────────────────────────
router.patch('/groups/:id', requireAuth, (req, res) => {
  try {
    const ownerId = _resolveOwnerId(req.user.id);
    const group = db.prepare(`SELECT * FROM account_groups WHERE id = ? AND user_id = ?`).get(req.params.id, ownerId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });

    db.prepare(`UPDATE account_groups SET name = ? WHERE id = ?`).run(name.trim(), group.id);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /accounts/groups/:id error:', err);
    res.status(500).json({ error: 'Failed to rename group' });
  }
});

// ── DELETE /accounts/groups/:id — remove a client label, keep the accounts ─
router.delete('/groups/:id', requireAuth, (req, res) => {
  try {
    const ownerId = _resolveOwnerId(req.user.id);
    const group = db.prepare(`SELECT * FROM account_groups WHERE id = ? AND user_id = ?`).get(req.params.id, ownerId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Ungroup member accounts rather than deleting them — a client's
    // accounts staying connected after you rename/remove the grouping is
    // almost always what's wanted; deleting them is a separate, explicit action.
    db.prepare(`UPDATE social_accounts SET group_id = NULL WHERE group_id = ?`).run(group.id);
    db.prepare(`DELETE FROM account_groups WHERE id = ?`).run(group.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /accounts/groups/:id error:', err);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

module.exports = router;
