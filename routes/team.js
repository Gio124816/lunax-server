// ════════════════════════════════════════════════════════════════════════════
// routes/team.js
// ════════════════════════════════════════════════════════════════════════════
// Multi-user team membership. A team owner (any existing account) can invite
// teammates who get their own login but act on behalf of the owner's connected
// Pages/ad accounts. Every reply sent through the shared Inbox is attributed to
// whichever team member actually sent it — see routes/comments.js.
//
// This exists specifically to support Meta's Business Asset User Profile
// Access permission: apps where multiple people share access to the same
// connected Page need to show which real, identified person took each action,
// rather than everything appearing to come from one anonymous account.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('./email');

// ── DB MIGRATION — per-member client access restriction ──────────────────
// Absence of any row for a member means unrestricted (full access to every
// client group, the existing default) — restriction is an explicit opt-in
// exception per member, not a default-closed permission model.
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS team_member_group_access (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      group_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, group_id)
    )
  `).run();
} catch (e) { console.error('team_member_group_access migration error:', e.message); }

// Returns null for "no restriction — sees every client group" (the default
// for the owner and for any member nobody has ever restricted), or an array
// of the specific group_ids a restricted member is allowed to see. Other
// routes that return or act on grouped accounts (accounts.js today; ideally
// the posting/publish path too — see note in accounts.js) should call this
// and filter/deny accordingly, not just resolveOwnerId() alone, or a
// restricted member's exclusion is only cosmetic.
function getAllowedGroupIds(userId) {
  const rows = db.prepare(`SELECT group_id FROM team_member_group_access WHERE user_id = ?`).all(userId);
  return rows.length === 0 ? null : rows.map(r => r.group_id);
}

// Resolves the effective "owner" id for a given user — themselves if they're
// a standalone/owner account, or whoever they're a team member of. Every
// other route that touches connected Pages/ad accounts should resolve
// through this rather than using req.user.id directly, so team members see
// and act on the same shared assets as the owner.
function resolveOwnerId(userId) {
  const row = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(userId);
  return row && row.team_owner_id ? row.team_owner_id : userId;
}

function generateInviteCode() {
  return uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase();
}

// ── POST /team/invite ────────────────────────────────────────────────────
// Owner-only. Creates a pending invite for an email address.
router.post('/invite', requireAuth, async (req, res) => {
  try {
    const me = db.prepare(`SELECT team_owner_id, name FROM users WHERE id = ?`).get(req.user.id);
    if (me && me.team_owner_id) {
      return res.status(403).json({ error: 'Only the account owner can invite team members' });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const inviteCode = generateInviteCode();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO team_invites (id, owner_id, email, invite_code, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, req.user.id, email.toLowerCase(), inviteCode, Date.now());

    const frontend = process.env.APP_FRONTEND_URL || 'https://lunaxmedia.com';
    const inviteLink = `${frontend}/login.html?teamInvite=${inviteCode}`;
    const ownerName = (me && me.name) || 'A Luna X user';

    // Send the actual email. Non-fatal if it fails — SendGrid quota, missing
    // API key, whatever — since the invite link is also returned directly
    // and shown in Settings as a manual fallback either way.
    const emailResult = await sendEmail({
      to: email,
      subject: `${ownerName} invited you to join their team on Luna X`,
      html: `
        <h2>You're invited to join a Luna X team</h2>
        <p>${ownerName} has invited you to help manage their connected social accounts on Luna X. You'll get your own login, and every reply you send through the Inbox is attributed to you by name.</p>
        <p><a href="${inviteLink}">Accept the invite →</a></p>
        <p>If the button doesn't work, copy and paste this link into your browser:<br>${inviteLink}</p>
      `,
      text: `You've been invited to join a team on Luna X. Accept your invite here: ${inviteLink}`
    });

    if (!emailResult.success) {
      console.warn('[Team] Invite email failed to send (non-fatal, link still returned/shown in UI):', emailResult.reason);
    }

    res.json({ id, inviteCode, inviteLink, emailSent: emailResult.success });
  } catch (err) {
    console.error('POST /team/invite error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// ── GET /team/invites ─────────────────────────────────────────────────────
// Owner-only. Lists pending invites for the management UI.
router.get('/invites', requireAuth, (req, res) => {
  try {
    const me = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(req.user.id);
    if (me && me.team_owner_id) {
      return res.status(403).json({ error: 'Only the account owner can view invites' });
    }
    const invites = db.prepare(`
      SELECT id, email, status, created_at, accepted_at FROM team_invites
      WHERE owner_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json({ invites });
  } catch (err) {
    console.error('GET /team/invites error:', err);
    res.status(500).json({ error: 'Failed to fetch invites' });
  }
});

// ── DELETE /team/invites/:id ──────────────────────────────────────────────
router.delete('/invites/:id', requireAuth, (req, res) => {
  try {
    db.prepare(`DELETE FROM team_invites WHERE id = ? AND owner_id = ? AND status = 'pending'`)
      .run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /team/invites/:id error:', err);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// ── POST /team/accept-invite ──────────────────────────────────────────────
// Public — the invitee doesn't have an account yet. Creates their login,
// links it to the owner's team, marks the invite accepted, logs them in.
router.post('/accept-invite', async (req, res) => {
  try {
    const { inviteCode, name, password } = req.body;
    if (!inviteCode || !name || !password) {
      return res.status(400).json({ error: 'inviteCode, name, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const invite = db.prepare(`SELECT * FROM team_invites WHERE invite_code = ? AND status = 'pending'`)
      .get(inviteCode.toUpperCase());
    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });

    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(invite.email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const now = Date.now();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, team_owner_id, team_role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'member', ?, ?)
    `).run(userId, invite.email, passwordHash, name, invite.owner_id, now, now);

    db.prepare(`UPDATE team_invites SET status = 'accepted', accepted_at = ? WHERE id = ?`)
      .run(now, invite.id);

    const token = jwt.sign({ id: userId, email: invite.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      message: 'Joined team successfully',
      token,
      user: { id: userId, email: invite.email, name, teamRole: 'member' }
    });
  } catch (err) {
    console.error('POST /team/accept-invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ── GET /team/members ─────────────────────────────────────────────────────
// Works whether called by the owner or any team member — resolves to the
// same shared roster either way.
router.get('/members', requireAuth, (req, res) => {
  try {
    const ownerId = resolveOwnerId(req.user.id);
    const members = db.prepare(`
      SELECT id, name, email, team_role,
             CASE WHEN id = ? THEN 1 ELSE 0 END as is_you
      FROM users WHERE id = ? OR team_owner_id = ?
      ORDER BY (team_role = 'owner') DESC, created_at ASC
    `).all(req.user.id, ownerId, ownerId);
    res.json({ members, ownerId });
  } catch (err) {
    console.error('GET /team/members error:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// ── DELETE /team/members/:id ──────────────────────────────────────────────
// Owner-only. Removes a team member's access entirely.
router.delete('/members/:id', requireAuth, (req, res) => {
  try {
    const me = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(req.user.id);
    if (me && me.team_owner_id) {
      return res.status(403).json({ error: 'Only the account owner can remove team members' });
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You can't remove yourself as the owner" });
    }
    db.prepare(`DELETE FROM users WHERE id = ? AND team_owner_id = ?`).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /team/members/:id error:', err);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

// ── GET /team/members/:id/group-access ────────────────────────────────────
// Owner-only. null allowedGroupIds means unrestricted (sees every client).
router.get('/members/:id/group-access', requireAuth, (req, res) => {
  try {
    const me = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(req.user.id);
    if (me && me.team_owner_id) {
      return res.status(403).json({ error: 'Only the account owner can view client access' });
    }
    const member = db.prepare(`SELECT id FROM users WHERE id = ? AND team_owner_id = ?`).get(req.params.id, req.user.id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    res.json({ allowedGroupIds: getAllowedGroupIds(req.params.id) });
  } catch (err) {
    console.error('GET /team/members/:id/group-access error:', err);
    res.status(500).json({ error: 'Failed to fetch client access' });
  }
});

// ── PUT /team/members/:id/group-access ────────────────────────────────────
// Owner-only. Body: { groupIds: [...] } — replaces the restriction set
// entirely. An empty array removes every restriction (back to full access),
// matching "restriction is an exception" — there's no separate "restrict to
// nothing" state distinct from "not a member of this team."
router.put('/members/:id/group-access', requireAuth, (req, res) => {
  try {
    const me = db.prepare(`SELECT team_owner_id FROM users WHERE id = ?`).get(req.user.id);
    if (me && me.team_owner_id) {
      return res.status(403).json({ error: 'Only the account owner can set client access' });
    }
    const member = db.prepare(`SELECT id FROM users WHERE id = ? AND team_owner_id = ?`).get(req.params.id, req.user.id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];

    // Only allow restricting to groups that actually belong to this owner —
    // otherwise a malformed request could scope a member to a group_id from
    // a different account entirely, silently granting or denying nothing
    // meaningful.
    const ownedGroupIds = new Set(
      db.prepare(`SELECT id FROM account_groups WHERE user_id = ?`).all(req.user.id).map(g => g.id)
    );
    const validGroupIds = groupIds.filter(id => ownedGroupIds.has(id));

    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM team_member_group_access WHERE user_id = ?`).run(req.params.id);
      for (const groupId of validGroupIds) {
        db.prepare(`
          INSERT INTO team_member_group_access (id, user_id, group_id, created_at) VALUES (?, ?, ?, ?)
        `).run(uuidv4(), req.params.id, groupId, now);
      }
    });
    tx();

    res.json({ allowedGroupIds: validGroupIds.length === 0 ? null : validGroupIds });
  } catch (err) {
    console.error('PUT /team/members/:id/group-access error:', err);
    res.status(500).json({ error: 'Failed to update client access' });
  }
});

module.exports = router;
module.exports.resolveOwnerId = resolveOwnerId;
module.exports.getAllowedGroupIds = getAllowedGroupIds;
