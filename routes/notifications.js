const express = require('express');
const router = express.Router();
const sgMail = require('@sendgrid/mail');
const { requireAuth } = require('./auth');
const db = require('../db/database');
const Anthropic = require('@anthropic-ai/sdk');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── AI Performance Report ────────────────────────────────────────────────────
async function generateAIInsights(user, stats, period) {
  const periodLabel = { daily: 'today', weekly: 'this week', monthly: 'this month' }[period] || period;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      messages: [{ role: 'user', content: `You are an AI social media strategist for ${user.business_name || user.name}, a local service business.

REPORTING PERIOD: ${periodLabel}
POSTS PUBLISHED: ${stats.posted}
POSTS FAILED: ${stats.failed}
POSTS SCHEDULED UPCOMING: ${stats.scheduled}
TOTAL POSTS ALL TIME: ${stats.total_all_time}
PLATFORMS: ${stats.platforms || 'Instagram, Facebook'}

Return ONLY valid JSON with no markdown:
{
  "summary": "2-sentence encouraging summary of their performance this period",
  "contentIdeas": [
    {"title": "idea title", "description": "one sentence", "format": "Reel|Carousel|Story|Post", "platform": "Instagram|Facebook|Both"},
    {"title": "idea title", "description": "one sentence", "format": "Reel|Carousel|Story|Post", "platform": "Instagram|Facebook|Both"},
    {"title": "idea title", "description": "one sentence", "format": "Reel|Carousel|Story|Post", "platform": "Instagram|Facebook|Both"}
  ],
  "timingTips": ["specific posting time tip", "specific frequency tip"],
  "adSuggestion": "one sentence specific ad campaign recommendation"
}` }]
    });
    return JSON.parse(msg.content[0].text.trim().replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('[Notifications] AI insights error:', e.message);
    return {
      summary: `You published ${stats.posted} post${stats.posted !== 1 ? 's' : ''} ${periodLabel}. Keep up the consistent posting to grow your audience.`,
      contentIdeas: [
        { title: 'Before & After', description: 'Show a transformation from your recent work', format: 'Reel', platform: 'Both' },
        { title: 'Team spotlight', description: 'Introduce your crew to build trust with customers', format: 'Post', platform: 'Facebook' },
        { title: 'Quick tip', description: 'Share a pro tip related to your industry', format: 'Carousel', platform: 'Instagram' }
      ],
      timingTips: [
        'Post between 7–9am or 6–8pm on weekdays for maximum reach',
        'Aim for at least 3 posts per week to stay top of mind'
      ],
      adSuggestion: 'Consider running a $10/day lead generation campaign targeting homeowners within 25 miles of your business.'
    };
  }
}

async function sendPerformanceReport(userId, period, recipientEmail, recipientName) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  const toEmail = recipientEmail || user.notif_email || user.email;
  const toName = recipientName || user.name;
  if (!toEmail) throw new Error('No email address for user');

  const now = Date.now();
  const windows = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 };
  const since = now - (windows[period] || windows.weekly);

  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) as posted,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status='scheduled' AND scheduled_time > ? THEN 1 ELSE 0 END) as scheduled
    FROM posts WHERE user_id = ? AND created_at > ?
  `).get(now, userId, since);

  const totalAllTime = db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND status='posted'").get(userId).c;

  const platformPosts = db.prepare("SELECT platforms FROM posts WHERE user_id = ? AND status='posted' AND created_at > ?").all(userId, since);
  const counts = {};
  platformPosts.forEach(p => {
    try { JSON.parse(p.platforms || '[]').forEach(pl => { counts[pl] = (counts[pl] || 0) + 1; }); } catch(e) {}
  });
  const platforms = Object.entries(counts).map(([p, c]) => `${p} (${c})`).join(', ') || 'None yet';

  const fullStats = { posted: stats.posted || 0, failed: stats.failed || 0, scheduled: stats.scheduled || 0, total_all_time: totalAllTime || 0, platforms };
  const ai = await generateAIInsights(user, fullStats, period);

  const periodLabel = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[period] || 'Performance';
  const businessName = user.business_name || user.name || 'Your Business';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const nextPeriodStr = period === 'daily' ? 'WEEK' : period === 'weekly' ? '2 WEEKS' : 'MONTH';

  const contentIdeasHTML = (ai.contentIdeas || []).map(idea =>
    `<div style="background:#f8f7ff;border-radius:10px;padding:14px 16px;margin-bottom:10px;border-left:3px solid #6c5ce7">
      <div style="margin-bottom:4px"><span style="font-size:11px;font-weight:600;color:#6c5ce7;background:rgba(108,92,231,0.1);padding:2px 8px;border-radius:20px">${idea.format}</span><span style="font-size:11px;color:#999;margin-left:6px">${idea.platform}</span></div>
      <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-bottom:2px">${idea.title}</div>
      <div style="font-size:12px;color:#666">${idea.description}</div>
    </div>`
  ).join('');

  const timingHTML = (ai.timingTips || []).map(tip =>
    `<div style="display:flex;gap:8px;margin-bottom:8px"><span style="color:#6c5ce7;flex-shrink:0">&#8594;</span><span style="font-size:13px;color:#444">${tip}</span></div>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0f0f8;font-family:Arial,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:32px 16px">
  <div style="text-align:center;margin-bottom:24px">
    <div style="font-size:22px;font-weight:700;color:#1a1a2e">Luna X</div>
    <div style="font-size:12px;color:#999">${periodLabel} Performance Report &middot; ${dateStr}</div>
  </div>
  <div style="background:linear-gradient(135deg,#6c5ce7,#a594ff);border-radius:16px;padding:24px;margin-bottom:20px;color:#fff">
    <div style="font-size:13px;opacity:0.85;margin-bottom:4px">${periodLabel} report for</div>
    <div style="font-size:22px;font-weight:700">${businessName}</div>
    ${toName !== user.name ? `<div style="font-size:12px;opacity:0.75;margin-top:4px">Prepared for ${toName}</div>` : ''}
  </div>
  <div style="background:#fff;border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
    <div style="font-size:11px;font-weight:600;color:#6c5ce7;margin-bottom:8px">&#10022; AI SUMMARY</div>
    <p style="margin:0;font-size:14px;color:#333;line-height:1.7">${ai.summary}</p>
  </div>
  <table width="100%" style="margin-bottom:16px;border-spacing:0"><tr>
    <td style="padding-right:8px"><div style="background:#fff;border-radius:14px;padding:18px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.05)"><div style="font-size:32px;font-weight:700;color:#16a34a">${fullStats.posted}</div><div style="font-size:11px;color:#666">Published</div></div></td>
    <td style="padding-right:8px"><div style="background:#fff;border-radius:14px;padding:18px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.05)"><div style="font-size:32px;font-weight:700;color:#6c5ce7">${fullStats.scheduled}</div><div style="font-size:11px;color:#666">Scheduled</div></div></td>
    <td><div style="background:#fff;border-radius:14px;padding:18px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.05)"><div style="font-size:32px;font-weight:700;color:#1a1a2e">${fullStats.total_all_time}</div><div style="font-size:11px;color:#666">All time</div></div></td>
  </tr></table>
  <div style="background:#fff;border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
    <div style="font-size:11px;font-weight:600;color:#6c5ce7;margin-bottom:14px">&#128161; CONTENT IDEAS FOR NEXT ${nextPeriodStr}</div>
    ${contentIdeasHTML}
  </div>
  <div style="background:#fff;border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
    <div style="font-size:11px;font-weight:600;color:#6c5ce7;margin-bottom:14px">&#9200; POSTING TIPS</div>
    ${timingHTML}
  </div>
  ${ai.adSuggestion ? `<div style="background:#fff8f0;border:1px solid #ffd6a0;border-radius:16px;padding:20px;margin-bottom:20px"><div style="font-size:11px;font-weight:600;color:#d97706;margin-bottom:8px">&#128176; AD RECOMMENDATION</div><p style="margin:0;font-size:13px;color:#444;line-height:1.6">${ai.adSuggestion}</p></div>` : ''}
  <div style="text-align:center;margin-bottom:24px">
    <a href="https://lunaxmedia.com/lunax.html" style="display:inline-block;background:#6c5ce7;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600">Open Luna X &#8594;</a>
  </div>
  <p style="text-align:center;font-size:11px;color:#aaa">Luna X &middot; <a href="https://lunaxmedia.com" style="color:#6c5ce7;text-decoration:none">lunaxmedia.com</a></p>
</div></body></html>`;

  const subject = `${periodLabel} Luna X Report — ${businessName}`;
  const text = `${periodLabel} Report for ${businessName}\n\nPublished: ${fullStats.posted}\nScheduled: ${fullStats.scheduled}\nAll time: ${fullStats.total_all_time}\n\n${ai.summary}\n\nContent ideas:\n${(ai.contentIdeas||[]).map(i=>`- ${i.title}: ${i.description}`).join('\n')}\n\nTips:\n${(ai.timingTips||[]).join('\n')}\n\n${ai.adSuggestion||''}\n\nhttps://lunaxmedia.com/lunax.html`;

  await sendEmail({ to: toEmail, subject, html, text });
  console.log(`[Notifications] ${periodLabel} report sent to ${toEmail} for user ${userId}`);
  return { sent: true, to: toEmail, period };
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

// ── POST /notifications/report — manual trigger (any period, optional recipient)
router.post('/report', requireAuth, async (req, res) => {
  try {
    const { period = 'weekly', recipientEmail, recipientName } = req.body;
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
    }
    const result = await sendPerformanceReport(req.user.id, period, recipientEmail, recipientName);
    res.json(result);
  } catch(e) {
    console.error('[Notifications] report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notifications/weekly ── (called by scheduler every Monday)
router.post('/weekly', async (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id FROM users
      WHERE notif_weekly = 1 AND notif_email IS NOT NULL AND notif_email != '' AND deleted_at IS NULL
    `).all();
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await sendPerformanceReport(u.id, 'weekly'); sent++; }
      catch(e) { console.error(`Weekly report failed for ${u.id}:`, e.message); failed++; }
    }
    res.json({ sent, failed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notifications/daily ── (called by scheduler every morning at 6am)
router.post('/daily', async (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id FROM users
      WHERE notif_ai = 1 AND notif_email IS NOT NULL AND notif_email != '' AND deleted_at IS NULL
    `).all();
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await sendPerformanceReport(u.id, 'daily'); sent++; }
      catch(e) { console.error(`Daily report failed for ${u.id}:`, e.message); failed++; }
    }
    res.json({ sent, failed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notifications/monthly ── (called by scheduler on 1st of month)
router.post('/monthly', async (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id FROM users
      WHERE notif_import = 1 AND notif_email IS NOT NULL AND notif_email != '' AND deleted_at IS NULL
    `).all();
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await sendPerformanceReport(u.id, 'monthly'); sent++; }
      catch(e) { console.error(`Monthly report failed for ${u.id}:`, e.message); failed++; }
    }
    res.json({ sent, failed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notifications/token-expiry ── alert user their Meta token is expiring
router.post('/token-expiry', async (req, res) => {
  try {
    const { userId, daysLeft } = req.body;
    const user = db.prepare('SELECT email, name, notif_email FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ skipped: true });
    const toEmail = user.notif_email || user.email;
    await sendEmail({
      to: toEmail,
      subject: `Your Luna X Facebook connection expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
      text: `Hi ${user.name},\n\nYour Facebook/Instagram connection expires in ${daysLeft} days. After that, Luna X won't be able to post.\n\nLog in and go to Settings to reconnect.\n\nhttps://lunaxmedia.com/lunax.html`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8f7ff">
        <div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
          <div style="font-size:28px;margin-bottom:8px">&#9888;&#65039;</div>
          <h2 style="margin:0 0 4px;font-size:18px;color:#1a1a2e">Facebook connection expiring</h2>
          <p style="margin:0 0 16px;color:#666;font-size:13px">Your Meta connection expires in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>. Luna X won't be able to post to Instagram or Facebook after that.</p>
          <a href="https://lunaxmedia.com/lunax.html" style="display:inline-block;background:#6c5ce7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Reconnect now &#8594;</a>
          <p style="margin:16px 0 0;font-size:12px;color:#999">Settings &#8594; Connections &#8594; Reconnect Facebook</p>
        </div>
      </div>`
    });
    res.json({ sent: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.sendEmail = sendEmail;
module.exports.sendPerformanceReport = sendPerformanceReport;
