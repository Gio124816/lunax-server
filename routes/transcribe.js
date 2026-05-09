const express = require('express');
const fetch = require('node-fetch');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// AssemblyAI v2 API (current)
const ASSEMBLYAI_API = 'https://api.assemblyai.com/v2';
const POLL_INTERVAL_MS = 3000;  // check every 3 seconds
const POLL_TIMEOUT_MS  = 5 * 60 * 1000; // give up after 5 minutes

/**
 * POST /transcribe
 * Body: { videoUrl: "https://s3.amazonaws.com/..." }
 * Returns: { transcript: "..." }
 *
 * Passes the S3 URL directly to AssemblyAI — no downloading, no size limit.
 * AssemblyAI fetches the file themselves and transcribes it.
 * Transcript is used by the frontend to enrich the AI caption prompt.
 */
router.post('/', requireAuth, async (req, res) => {
  let { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  // Convert s3:// protocol URLs to https:// so AssemblyAI can fetch them
  if (videoUrl.startsWith('s3://')) {
    const withoutProtocol = videoUrl.replace('s3://', '');
    const [bucket, ...keyParts] = withoutProtocol.split('/');
    const key = keyParts.join('/');
    const region = process.env.AWS_REGION || 'us-east-2';
    videoUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    console.log(`[Transcribe] Converted s3:// URL to: ${videoUrl}`);
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    console.warn('[Transcribe] ASSEMBLYAI_API_KEY not set — skipping transcription');
    return res.json({ transcript: null, skipped: true });
  }

  const headers = {
    'Authorization': apiKey,
    'Content-Type': 'application/json',
  };

  try {
    // Step 1 — Submit the URL for transcription (v3 endpoint)
    console.log(`[Transcribe] Submitting to AssemblyAI: ${videoUrl}`);
    const submitRes = await fetch(`${ASSEMBLYAI_API}/transcript`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        audio_url: videoUrl,
        speech_models: ['universal-2'],
        language_detection: true,
      }),
    });

    const submitData = await submitRes.json();
    if (!submitRes.ok || !submitData.id) {
      throw new Error(`AssemblyAI submit failed: ${submitData.error || JSON.stringify(submitData)}`);
    }

    const transcriptId = submitData.id;
    console.log(`[Transcribe] Job submitted — ID: ${transcriptId}`);

    // Step 2 — Poll until complete or failed
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await fetch(`${ASSEMBLYAI_API}/transcript/${transcriptId}`, { headers });
      const pollData = await pollRes.json();

      if (pollData.status === 'completed') {
        const wordCount = (pollData.text || '').trim().split(/\s+/).length;
        console.log(`[Transcribe] Complete — ${wordCount} words`);
        return res.json({ transcript: pollData.text.trim() });
      }

      if (pollData.status === 'error') {
        throw new Error(`AssemblyAI transcription error: ${pollData.error}`);
      }

      console.log(`[Transcribe] Status: ${pollData.status} — waiting...`);
    }

    throw new Error('Transcription timed out after 5 minutes');

  } catch (e) {
    console.error('[Transcribe] Error:', e.message);
    // Don't hard-fail — transcription is an enhancement, not required
    return res.json({ transcript: null, skipped: true, reason: e.message });
  }
});

module.exports = router;
