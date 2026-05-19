// routes/voice.js
// POST /voice/transcribe — accepts short audio (base64) and returns transcript.
// Used by the Luna X desktop app as a fallback for webkitSpeechRecognition,
// which fails in Electron because Chromium's built-in speech endpoint
// requires a Google-distributed API key that only official Chrome ships with.

const express = require('express');
const axios = require('axios');

const router = express.Router();

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const AAI = 'https://api.assemblyai.com/v2';

// Tunables
const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 20_000;   // 20s max — voice commands are seconds, not minutes
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8MB decoded — generous for ~60s of webm/opus

router.post('/transcribe', async (req, res) => {
  try {
    if (!ASSEMBLYAI_KEY) {
      return res.status(500).json({ error: 'Transcription not configured (ASSEMBLYAI_API_KEY missing)' });
    }

    const { audio, mimeType } = req.body || {};
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'Missing audio (expected base64 string)' });
    }

    // Decode base64 → Buffer
    let buffer;
    try {
      buffer = Buffer.from(audio, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid base64 audio' });
    }
    if (!buffer.length) return res.status(400).json({ error: 'Empty audio' });
    if (buffer.length > MAX_AUDIO_BYTES) {
      return res.status(413).json({ error: 'Audio too large (max 8MB)' });
    }

    // 1) Upload raw audio bytes to AssemblyAI
    const uploadRes = await axios.post(`${AAI}/upload`, buffer, {
      headers: {
        Authorization: ASSEMBLYAI_KEY,
        'Content-Type': 'application/octet-stream'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 15_000
    });
    const upload_url = uploadRes.data?.upload_url;
    if (!upload_url) {
      console.error('[voice] AssemblyAI upload returned no upload_url:', uploadRes.data);
      return res.status(502).json({ error: 'Transcription upload failed' });
    }

    // 2) Request transcript. AssemblyAI requires speech_models (plural array)
    //    as of 2025/2026 — the older speech_model (singular) is rejected.
    //    "universal" is the current low-cost/low-latency tier (replaced "nano"
    //    in April 2026) — ideal for short English voice commands.
    const trCreate = await axios.post(`${AAI}/transcript`, {
      audio_url: upload_url,
      speech_models: ['universal'],
      language_code: 'en_us',
      punctuate: true,
      format_text: true
    }, {
      headers: {
        Authorization: ASSEMBLYAI_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15_000
    });
    const transcriptId = trCreate.data?.id;
    if (!transcriptId) {
      console.error('[voice] AssemblyAI transcript create returned no id:', trCreate.data);
      return res.status(502).json({ error: 'Transcription request failed' });
    }

    // 3) Poll until completed / error / timeout
    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const pollRes = await axios.get(`${AAI}/transcript/${transcriptId}`, {
        headers: { Authorization: ASSEMBLYAI_KEY },
        timeout: 10_000,
        // Don't throw on non-2xx; we'll inspect status
        validateStatus: () => true
      });
      const status = pollRes.data?.status;
      if (status === 'completed') {
        return res.json({
          text: (pollRes.data.text || '').trim(),
          confidence: pollRes.data.confidence ?? null
        });
      }
      if (status === 'error') {
        console.error('[voice] AssemblyAI error:', pollRes.data?.error);
        return res.status(502).json({ error: 'Transcription failed', detail: pollRes.data?.error });
      }
      // else: queued / processing — keep polling
    }

    return res.status(504).json({ error: 'Transcription timed out' });
  } catch (err) {
    // axios errors carry response details; surface them in server logs
    if (err.response) {
      console.error('[voice] AssemblyAI HTTP error:',
        err.response.status, err.response.data);
    } else {
      console.error('[voice] Transcribe error:', err.message);
    }
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
