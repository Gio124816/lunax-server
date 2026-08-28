// ════════════════════════════════════════════════════════════════════════════
// routes/webhook.js
// ════════════════════════════════════════════════════════════════════════════
// Receives real-time Page events Meta pushes to us after a Page is
// subscribed via POST /meta/subscribe-page (see routes/meta.js). This is
// the actual, literal purpose of the pages_manage_metadata permission —
// without this file, requesting that permission had nothing genuine behind
// it, which is exactly what App Review flagged: the permission was allowed,
// but nothing in the app actually subscribed to or received a webhook event.
//
// Two routes, both required by Meta's webhook system:
//   GET  /webhook — one-time verification handshake when you register this
//                    URL in the Meta App Dashboard (App > Webhooks). Meta
//                    calls this once with a challenge string; we must
//                    confirm we control META_WEBHOOK_VERIFY_TOKEN and echo
//                    the exact challenge back, or the subscription is
//                    rejected outright.
//   POST /webhook — the actual events themselves, once subscribed. Must
//                    verify the X-Hub-Signature-256 header (an HMAC of the
//                    raw body using the App Secret) so a request can't be
//                    spoofed by anyone who simply knows this URL.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db/database');

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id     TEXT,
      field       TEXT,
      payload     TEXT NOT NULL,
      received_at INTEGER NOT NULL
    )
  `).run();
} catch (e) { console.error('webhook_events migration error:', e.message); }

// ── GET /webhook — verification handshake ─────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verification handshake succeeded');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] Verification handshake failed — token mismatch or wrong mode');
  res.sendStatus(403);
});

// ── POST /webhook — real events arrive here ───────────────────────────────
// Mounted with express.raw() in server.js (see there for why) — req.body is
// a raw Buffer here, not parsed JSON, specifically so the signature check
// below runs against the exact bytes Meta signed.
router.post('/', (req, res) => {
  try {
    const signature = req.get('X-Hub-Signature-256') || '';
    const appSecret = process.env.META_APP_SECRET;
    if (appSecret) {
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.body).digest('hex');
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      const isValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      if (!isValid) {
        console.warn('[Webhook] Signature verification failed — rejecting');
        return res.sendStatus(403);
      }
    } else {
      console.warn('[Webhook] META_APP_SECRET not set — skipping signature verification (unsafe for production)');
    }

    const body = JSON.parse(req.body.toString('utf8'));
    const now = Date.now();

    for (const entry of (body.entry || [])) {
      const pageId = entry.id;
      for (const change of (entry.changes || [])) {
        // Logged unconditionally and to full detail on purpose — this exact
        // line is what you point at during the App Review screencast to
        // prove a real webhook event arrived for the same Page shown
        // connecting earlier in the same recording.
        console.log(`[Webhook] Page ${pageId} — field "${change.field}":`, JSON.stringify(change.value));
        try {
          db.prepare(`
            INSERT INTO webhook_events (page_id, field, payload, received_at) VALUES (?, ?, ?, ?)
          `).run(pageId, change.field, JSON.stringify(change.value), now);
        } catch (dbErr) {
          console.error('[Webhook] Failed to store event (non-fatal):', dbErr.message);
        }
      }
    }

    // Meta requires a fast 200 — acknowledge receipt immediately, all
    // processing above already happened synchronously and is cheap enough
    // not to need deferring.
    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Error handling event:', err.message);
    // Still 200 — a malformed/unexpected payload shouldn't cause Meta to
    // keep retrying indefinitely or flag the endpoint as unhealthy.
    res.sendStatus(200);
  }
});

// ── GET /webhook/recent — lets the app (or you, during review prep) see
// the last few events that actually arrived, without digging through logs.
router.get('/recent', (req, res) => {
  try {
    const events = db.prepare(`
      SELECT id, page_id, field, payload, received_at FROM webhook_events
      ORDER BY received_at DESC LIMIT 20
    `).all();
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recent events' });
  }
});

module.exports = router;
