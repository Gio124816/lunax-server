const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');
const { requireAuth } = require('./auth');
const db = require('../db/database');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.FEEDBACK_EMAIL || 'giovanni@arderemedia.com';
const FROM_NAME = 'Luna X';

// ── Send helper ──
async function sendEmail({ to, subject, html, text }) {
  try {
    await sgMail.send({ from: { email: FROM_EMAIL, name: FROM_NAME }, to, subject, html, text });
    console.log(`Email sent to ${to}: ${subject}`);
    return true;
  } catch(e) {
    console.error('SendGrid error:', e.response?.body || e.message);
    return false;
  }
}

// ── POST /notifications/post-success ── (called by scheduler)
router.post('/post-success', async (req, res) => {
  try {
    const { userId, caption, platforms, scheduledTime } = req.body;
    const user = db.prepare(`
      SELECT email, name, notif_email, notif_published FROM users WHERE id = ?
    `).get(userId);
    if (!user || !user.notif_published || !user.notif_email) return res.json({ skipped: true });

    const platformList = (platforms || []).join(' & ');
    const time = scheduledTime ? new Date(scheduledTime).toLocaleString() : 'just now';
    const preview = (caption || '').slice(0, 120) + ((caption || '').length > 120 ? '...' : '');

    await sendEmail({
      to: user.notif_email,
      subject: `✅ Your post went live on ${platformList}`,
      text: `Hi ${user.name},\n\nYour post was published successfully on ${platformList}.\n\n"${preview}"\n\nPublished: ${time}\n\n— Luna X`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8f7ff">
          <div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
            <div style="font-size:28px;margin-bottom:8px">✅</div>
            <h2 style="margin:0 0 4px;font-size:18px;color:#1a1a2e">Post published!</h2>
            <p style="margin:0 0 20px;color:#666;font-size:13px">Your post went live on <strong>${platformList}</strong></p>
            <div style="background:#f8f7ff;border-radius:10px;padding:14px 16px;margin-bottom:20px;border-left:3px solid #6c5ce7">
              <p style="margin:0;font-size:13px;color:#333;line-height:1.6">"${preview}"</p>
            </div>
            <p style="margin:0;font-size:12px;color:#999">Published ${time}</p>
          </div>
          <p style="text-align:center;margin-top:16px;font-size:11px;color:#aaa">Luna X · <a href="https://lunaxmedia.com" style="color:#6c5ce7">lunaxmedia.com</a></p>
        </div>
      `
    });
    res.json({ sent: true });
  } catch(e) {
    console.error('post-success email error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notifications/post-failed ── (called by scheduler)
router.post('/post-failed', async (req, res) => {
  try {
    const { userId, caption, platforms, error } = req.body;
    const user = db.prepare(`
      SELECT email, name, notif_email, notif_failed FROM users WHERE id = ?
    `).get(userId);
    if (!user || !user.notif_failed || !user.notif_email) return res.json({ skipped: true });

    const platformList = (platforms || []).join(' & ');
    const preview = (caption || '').slice(0, 100);

    await sendEmail({
      to: user.notif_email,
      subject: `⚠️ Post failed to publish on ${platformList}`,
      text: `Hi ${user.name},\n\nYour post failed to publish on ${platformList}.\n\nError: ${error}\n\nCaption: "${preview}"\n\nLog in to Luna X to retry.\n\n— Luna X`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8f7ff">
          <div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
            <div style="font-size:28px;margin-bottom:8px">⚠️</div>
            <h2 style="margin:0 0 4px;font-size:18px;color:#1a1a2e">Post failed to publish</h2>
            <p style="margin:0 0 16px;color:#666;font-size:13px">Something went wrong on <strong>${platformList}</strong></p>
            <div style="background:#fff5f5;border-radius:10px;padding:12px 16px;margin-bottom:16px;border-left:3px solid #ef4444">
              <p style="margin:0;font-size:12px;color:#c0392b">${error}</p>
            </div>
            <div style="background:#f8f7ff;border-radius:10px;padding:12px 16px;margin-bottom:20px">
              <p style="margin:0;font-size:13px;color:#333">"${preview}"</p>
            </div>
            <a href="https://lunaxmedia.com/lunax.html" style="display:inline-block;background:#6c5ce7;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Retry in Luna X →</a>
          </div>
        </div>
      `
    });
    res.json({ sent: true });
  } catch(e) {
    console.error('post-failed email error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notifications/weekly ── (called by scheduler every Monday)
router.post('/weekly', async (req, res) => {
  try {
    // Get all users with weekly notifications enabled
    const users = db.prepare(`
      SELECT id, name, notif_email FROM users 
      WHERE notif_weekly = 1 AND notif_email IS NOT NULL AND notif_email != ''
    `).all();

    let sent = 0;
    for (const user of users) {
      // Get post stats for the past week
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) as posted,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
        FROM posts WHERE user_id = ? AND created_at > ?
      `).get(user.id, weekAgo);

      await sendEmail({
        to: user.notif_email,
        subject: `📊 Your Luna X weekly summary`,
        text: `Hi ${user.name},\n\nHere's your week on Luna X:\n\nPosts published: ${stats.posted || 0}\nPosts failed: ${stats.failed || 0}\nTotal scheduled: ${stats.total || 0}\n\n— Luna X`,
        html: `
          <div style="font-family:'DM Sans',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8f7ff">
            <div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
              <div style="font-size:28px;margin-bottom:8px">📊</div>
              <h2 style="margin:0 0 4px;font-size:18px;color:#1a1a2e">Your weekly summary</h2>
              <p style="margin:0 0 20px;color:#666;font-size:13px">Here's how your social media performed this week</p>
              <div style="display:flex;gap:12px;margin-bottom:20px">
                <div style="flex:1;background:#f0fdf4;border-radius:10px;padding:16px;text-align:center">
                  <div style="font-size:28px;font-weight:700;color:#16a34a">${stats.posted || 0}</div>
                  <div style="font-size:11px;color:#666;margin-top:2px">Published</div>
                </div>
                <div style="flex:1;background:#f8f7ff;border-radius:10px;padding:16px;text-align:center">
                  <div style="font-size:28px;font-weight:700;color:#6c5ce7">${stats.total || 0}</div>
                  <div style="font-size:11px;color:#666;margin-top:2px">Total posts</div>
                </div>
                ${stats.failed ? `<div style="flex:1;background:#fff5f5;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:700;color:#ef4444">${stats.failed}</div><div style="font-size:11px;color:#666;margin-top:2px">Failed</div></div>` : ''}
              </div>
              <a href="https://lunaxmedia.com/lunax.html" style="display:inline-block;background:#6c5ce7;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">View dashboard →</a>
            </div>
          </div>
        `
      });
      sent++;
    }
    res.json({ sent });
  } catch(e) {
    console.error('weekly email error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
