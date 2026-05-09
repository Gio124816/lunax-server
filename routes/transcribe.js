const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /transcribe
 * Body: { videoUrl: "https://..." }
 * Returns: { transcript: "..." }
 *
 * Downloads video from S3, sends to OpenAI Whisper, returns transcript.
 * The transcript is then used by the frontend to enrich the AI caption prompt.
 */
router.post('/', requireAuth, async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    // Graceful fallback — transcription is optional, not a hard requirement
    console.warn('[Transcribe] OPENAI_API_KEY not set — skipping transcription');
    return res.json({ transcript: null, skipped: true });
  }

  try {
    console.log(`[Transcribe] Downloading video from: ${videoUrl}`);
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);

    const videoBuffer = await videoRes.buffer();
    const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`[Transcribe] Video downloaded — ${fileSizeMB}MB. Sending to Whisper...`);

    // Whisper accepts up to 25MB
    if (videoBuffer.length > 25 * 1024 * 1024) {
      console.warn('[Transcribe] Video too large for Whisper (>25MB) — skipping');
      return res.json({ transcript: null, skipped: true, reason: 'Video too large for transcription (max 25MB)' });
    }

    // Determine file extension from URL
    const ext = videoUrl.split('?')[0].split('.').pop().toLowerCase() || 'mp4';
    const allowedExts = ['mp4', 'mov', 'avi', 'webm', 'm4a', 'mp3', 'wav'];
    const safeExt = allowedExts.includes(ext) ? ext : 'mp4';

    const form = new FormData();
    form.append('file', videoBuffer, {
      filename: `video.${safeExt}`,
      contentType: `video/${safeExt}`,
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`Whisper API error: ${whisperRes.status} — ${errText}`);
    }

    const transcript = await whisperRes.text();
    const wordCount = transcript.trim().split(/\s+/).length;
    console.log(`[Transcribe] Transcript received — ${wordCount} words`);

    res.json({ transcript: transcript.trim() });

  } catch (e) {
    console.error('[Transcribe] Error:', e.message);
    // Don't hard-fail — transcription is enhancement, not required
    res.json({ transcript: null, skipped: true, reason: e.message });
  }
});

module.exports = router;
