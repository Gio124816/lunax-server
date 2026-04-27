// Email sending via SendGrid (free tier: 100/day)
// Set SENDGRID_API_KEY in Railway env vars
// Fallback: logs to console in development

async function sendEmail({ to, subject, html, text }) {
  // In development, just log
  if (process.env.NODE_ENV !== 'production' && !process.env.SENDGRID_API_KEY) {
    console.log(`\n📧 EMAIL (dev mode — not sent)\nTo: ${to}\nSubject: ${subject}\n${text || '[HTML email]'}\n`);
    return { success: true, dev: true };
  }

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('SENDGRID_API_KEY not set — email not sent');
    return { success: false, reason: 'no_api_key' };
  }

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: {
          email: process.env.FROM_EMAIL || 'hello@lunaxmedia.com',
          name: 'Luna X'
        },
        subject,
        content: [
          ...(html ? [{ type: 'text/html', value: wrapHtml(subject, html) }] : []),
          ...(text ? [{ type: 'text/plain', value: text }] : [])
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('SendGrid error:', err);
      return { success: false, reason: err };
    }

    return { success: true };
  } catch (err) {
    console.error('Email send failed:', err);
    return { success: false, reason: err.message };
  }
}

function wrapHtml(subject, content) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, 'DM Sans', sans-serif; background: #f5f5f7; margin: 0; padding: 40px 20px; color: #0a0a0f; }
    .card { background: #fff; border-radius: 16px; max-width: 520px; margin: 0 auto; padding: 40px; }
    .logo { font-size: 28px; font-weight: 800; color: #7c6dfa; margin-bottom: 24px; display: block; }
    h2 { font-size: 22px; font-weight: 700; margin: 0 0 16px; }
    p { font-size: 15px; line-height: 1.6; color: #444; margin: 0 0 16px; }
    a { color: #7c6dfa; }
    .footer { text-align: center; margin-top: 32px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <span class="logo">Luna X</span>
    ${content}
    <div class="footer">
      Luna X · Ardere Media LLC · <a href="https://lunaxmedia.com">lunaxmedia.com</a><br>
      <a href="https://lunaxmedia.com/unsubscribe">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { sendEmail };
