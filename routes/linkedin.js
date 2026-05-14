const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/database');
const { requireAuth } = require('./auth');

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = 'https://lunax-server-production.up.railway.app/oauth/linkedin/callback';

// ── DB MIGRATION — add LinkedIn columns if not exist ──────────────────────
const linkedinCols = [
  'linkedin_access_token TEXT',
  'linkedin_refresh_token TEXT',
  'linkedin_token_expires_at INTEGER',
  'linkedin_person_id TEXT',
  'linkedin_name TEXT',
  'linkedin_avatar_url TEXT',
];
for (const col of linkedinCols) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch(e) {}
}

// ── STEP 1: Redirect user to LinkedIn OAuth ────────────────────────────────
router.get('/linkedin', (req, res) => {
  let userId;
  const qToken = req.query.token;
  if (qToken) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(qToken, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch(e) {
      return res.redirect('https://lunaxmedia.com?linkedin=error');
    }
  } else {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.redirect('https://lunaxmedia.com?linkedin=error');
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      userId = decoded.id;
    } catch(e) {
      return res.redirect('https://lunaxmedia.com?linkedin=error');
    }
  }

  const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');

  const scopes = ['openid', 'profile', 'email', 'w_member_social'].join(' ');

  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// ── STEP 2: LinkedIn redirects back with code ──────────────────────────────
router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('LinkedIn OAuth error:', error);
    return res.redirect('https://lunaxmedia.com?linkedin=error');
  }

  let userId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    userId = decoded.userId;
  } catch(e) {
    return res.redirect('https://lunaxmedia.com?linkedin=error');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = Date.now() + ((expires_in || 5183944) * 1000); // ~60 days default

    // Fetch LinkedIn profile via OpenID userinfo endpoint
    const profileRes = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const profile = profileRes.data;
    const personId = profile.sub || '';
    const name = profile.name || profile.given_name || 'LinkedIn User';
    const avatar = profile.picture || '';

    console.log(`[LinkedIn] Connected: ${name} (${personId})`);

    // Save to DB
    db.prepare(`
      UPDATE users SET
        linkedin_access_token = ?,
        linkedin_refresh_token = ?,
        linkedin_token_expires_at = ?,
        linkedin_person_id = ?,
        linkedin_name = ?,
        linkedin_avatar_url = ?
      WHERE id = ?
    `).run(access_token, refresh_token || null, expiresAt, personId, name, avatar, userId);

    res.redirect('https://lunaxmedia.com?linkedin=connected');
  } catch(err) {
    console.error('LinkedIn callback error:', err.response?.data || err.message);
    res.redirect('https://lunaxmedia.com?linkedin=error');
  }
});

// ── DISCONNECT LinkedIn ────────────────────────────────────────────────────
router.post('/linkedin/disconnect', requireAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users SET
        linkedin_access_token = NULL,
        linkedin_refresh_token = NULL,
        linkedin_token_expires_at = NULL,
        linkedin_person_id = NULL,
        linkedin_name = NULL,
        linkedin_avatar_url = NULL
      WHERE id = ?
    `).run(req.user.id);
    res.json({ ok: true });
  } catch(err) {
    console.error('LinkedIn disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ── POST TO LINKEDIN ───────────────────────────────────────────────────────
async function postToLinkedIn(post, user) {
  const accessToken = user.linkedin_access_token;
  if (!accessToken) throw new Error('No LinkedIn access token');

  const personId = user.linkedin_person_id;
  if (!personId) throw new Error('No LinkedIn person ID');

  const author = `urn:li:person:${personId}`;

  // Build the post body
  const shareContent = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: post.caption || '' },
        shareMediaCategory: 'NONE',
      }
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
  };

  // If there's media (image or video), upload it first
  if (post.media_url) {
    const isVideo = /\.(mp4|mov|avi|webm)$/i.test(post.media_url);
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(post.media_url);

    if (isImage) {
      // Register image upload
      const registerRes = await axios.post(
        'https://api.linkedin.com/v2/assets?action=registerUpload',
        {
          registerUploadRequest: {
            recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
            owner: author,
            serviceRelationships: [{
              relationshipType: 'OWNER',
              identifier: 'urn:li:userGeneratedContent'
            }]
          }
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );

      const uploadUrl = registerRes.data?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
      const asset = registerRes.data?.value?.asset;

      if (uploadUrl && asset) {
        // Download image from S3 and upload to LinkedIn
        const imgRes = await axios.get(post.media_url, { responseType: 'arraybuffer' });
        await axios.put(uploadUrl, imgRes.data, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' }
        });

        shareContent.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory = 'IMAGE';
        shareContent.specificContent['com.linkedin.ugc.ShareContent'].media = [{
          status: 'READY',
          description: { text: post.caption?.slice(0, 200) || '' },
          media: asset,
          title: { text: 'Luna X Post' }
        }];
      }
    } else if (isVideo) {
      // Video posting — upload via registerUpload
      const registerRes = await axios.post(
        'https://api.linkedin.com/v2/assets?action=registerUpload',
        {
          registerUploadRequest: {
            recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
            owner: author,
            serviceRelationships: [{
              relationshipType: 'OWNER',
              identifier: 'urn:li:userGeneratedContent'
            }]
          }
        },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );

      const uploadUrl = registerRes.data?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
      const asset = registerRes.data?.value?.asset;

      if (uploadUrl && asset) {
        const vidRes = await axios.get(post.media_url, { responseType: 'arraybuffer' });
        await axios.put(uploadUrl, vidRes.data, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'video/mp4' },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

        shareContent.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory = 'VIDEO';
        shareContent.specificContent['com.linkedin.ugc.ShareContent'].media = [{
          status: 'READY',
          description: { text: post.caption?.slice(0, 200) || '' },
          media: asset,
          title: { text: 'Luna X Post' }
        }];
      }
    }
  }

  // Publish the post
  const postRes = await axios.post(
    'https://api.linkedin.com/v2/ugcPosts',
    shareContent,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      }
    }
  );

  const postId = postRes.headers['x-restli-id'] || postRes.data?.id;
  console.log(`[LinkedIn] Posted successfully: ${postId}`);
  return { success: true, postId };
}

module.exports = router;
module.exports.postToLinkedIn = postToLinkedIn;
