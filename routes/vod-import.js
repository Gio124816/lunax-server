// routes/vod-import.js
// Imports VODs from YouTube and Twitch into S3 for clipping
// Uses yt-dlp for downloading (must be installed on Railway)

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, CreateMultipartUploadCommand,
        UploadPartCommand, CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const S3_BUCKET = process.env.AWS_S3_BUCKET || 'lunax-media';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// Ensure schema
function ensureVodSchema() {
  db.prepare(`CREATE TABLE IF NOT EXISTS vod_imports (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    source_url  TEXT NOT NULL,
    platform    TEXT NOT NULL,
    title       TEXT,
    duration    INTEGER,
    s3_key      TEXT,
    status      TEXT DEFAULT 'pending',
    progress    INTEGER DEFAULT 0,
    error       TEXT,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  )`).run();
}
ensureVodSchema();

// Detect platform from URL
function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('twitch.tv')) return 'twitch';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com')) return 'instagram';
  return 'unknown';
}

// yt-dlp prints a "your version is 90+ days old" nag banner to stderr on every
// run, ahead of the actual failure. Grabbing the first N characters of stderr
// (the old approach) surfaces that banner instead of the real error. This pulls
// out the actual "ERROR: ..." line if yt-dlp printed one, falling back to the
// tail of stderr (where real failures land) rather than the head.
function extractYtDlpError(stderr) {
  const lines = (stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
  const errorLine = lines.find(l => l.startsWith('ERROR:'));
  if (errorLine) return errorLine.slice(0, 300);
  return (stderr || '').trim().slice(-300) || 'yt-dlp exited with an error';
}

// Active import jobs (in-memory progress tracking)
const activeImports = new Map();

// POST /vod/import — start a VOD import
router.post('/import', requireAuth, async (req, res) => {
  const { url, ownsContent } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!ownsContent) return res.status(400).json({ error: 'Please confirm you own the rights to this content' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported platform. Paste a YouTube, Twitch, TikTok, or Instagram URL.' });

  const importId = uuidv4();
  db.prepare(`INSERT INTO vod_imports (id, user_id, source_url, platform, status) VALUES (?, ?, ?, ?, 'pending')`
  ).run(importId, req.user.id, url, platform);

  res.json({ importId, status: 'pending' });

  // Start download async
  downloadVod(importId, req.user.id, url, platform).catch(e => {
    console.error(`[VOD] Import ${importId} failed:`, e.message);
    db.prepare(`UPDATE vod_imports SET status = 'failed', error = ? WHERE id = ?`).run(e.message, importId);
    activeImports.delete(importId);
  });
});

// GET /vod/imports — list user's VOD imports
router.get('/imports', requireAuth, (req, res) => {
  const imports = db.prepare(`
    SELECT * FROM vod_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.user.id);
  res.json({ imports });
});

// GET /vod/import/:id — get status of one import
router.get('/import/:id', requireAuth, (req, res) => {
  const imp = db.prepare(`SELECT * FROM vod_imports WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
  if (!imp) return res.status(404).json({ error: 'Not found' });
  // Merge in-memory progress
  const progress = activeImports.get(req.params.id) || {};
  res.json({ ...imp, ...progress });
});

// DELETE /vod/import/:id — cancel/delete an import
router.delete('/import/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM vod_imports WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
  activeImports.delete(req.params.id);
  res.json({ ok: true });
});

// ── Download pipeline ─────────────────────────────────────────────────────────
async function downloadVod(importId, userId, url, platform) {
  const tmpDir = `/tmp/lunax-vod-${importId}`;
  const tmpFile = path.join(tmpDir, 'video.mp4');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Step 1: Get video info
    db.prepare(`UPDATE vod_imports SET status = 'fetching_info' WHERE id = ?`).run(importId);
    activeImports.set(importId, { status: 'fetching_info', progress: 5 });

    const info = await getVideoInfo(url);
    db.prepare(`UPDATE vod_imports SET title = ?, duration = ?, status = 'downloading' WHERE id = ?`
    ).run(info.title || 'Imported VOD', info.duration || 0, importId);
    activeImports.set(importId, { status: 'downloading', progress: 10, title: info.title });

    console.log(`[VOD] Downloading: ${info.title} (${Math.round((info.duration || 0) / 60)}min)`);

    // Step 2: Download with yt-dlp
    await downloadWithYtDlp(url, tmpFile, (percent) => {
      activeImports.set(importId, { status: 'downloading', progress: Math.round(10 + percent * 0.6) });
      db.prepare(`UPDATE vod_imports SET progress = ? WHERE id = ?`).run(Math.round(10 + percent * 0.6), importId);
    });

    // Step 3: Upload to S3
    db.prepare(`UPDATE vod_imports SET status = 'uploading', progress = 70 WHERE id = ?`).run(importId);
    activeImports.set(importId, { status: 'uploading', progress: 70 });

    const s3Key = `vods/${userId}/${importId}/raw.mp4`;
    await uploadFileToS3(tmpFile, s3Key, (percent) => {
      activeImports.set(importId, { status: 'uploading', progress: Math.round(70 + percent * 0.25) });
    });

    const publicUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;

    // Step 4: Create a draft post record so it shows in Video Editor
    const postId = uuidv4();
    db.prepare(`
      INSERT INTO posts (id, user_id, caption, platforms, media_url, media_type,
                        scheduled_time, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(postId, userId, info.title || 'Imported VOD', JSON.stringify([]),
           publicUrl, 'video', null, 'draft', Date.now(), Date.now());

    db.prepare(`UPDATE vod_imports SET status = 'ready', progress = 100, s3_key = ? WHERE id = ?`
    ).run(s3Key, importId);
    activeImports.set(importId, { status: 'ready', progress: 100, s3Key, postId, publicUrl });

    console.log(`[VOD] Import ${importId} complete → ${s3Key}`);
  } finally {
    // Cleanup temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', '--quiet', url];
    const proc = spawn('yt-dlp', args);
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    // Without this, a failed spawn (e.g. yt-dlp missing) emits an unhandled
    // 'error' event and crashes the entire Node process, not just this import.
    proc.on('error', e => {
      reject(new Error(`yt-dlp is not installed on this server: ${e.message}`));
    });
    proc.on('exit', code => {
      if (code !== 0) {
        // yt-dlp not installed — return minimal info
        if (err.includes('not found') || err.includes('No such file')) {
          console.warn('[VOD] yt-dlp not installed, using minimal info');
          resolve({ title: 'Imported VOD', duration: 0 });
        } else {
          reject(new Error(extractYtDlpError(err)));
        }
        return;
      }
      try {
        const info = JSON.parse(out);
        resolve({ title: info.title, duration: info.duration, thumbnail: info.thumbnail });
      } catch { resolve({ title: 'Imported VOD', duration: 0 }); }
    });
  });
}

function downloadWithYtDlp(url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    // Best quality MP4, max 1080p (keeps file sizes manageable)
    const args = [
      '--format', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
      '--merge-output-format', 'mp4',
      '--output', outputPath,
      '--no-playlist',
      '--progress',
      '--newline',
      url,
    ];
    const proc = spawn('yt-dlp', args);
    proc.stdout.on('data', d => {
      const line = d.toString();
      // Parse yt-dlp progress: [download]  45.3% of ...
      const match = line.match(/(\d+\.?\d*)%/);
      if (match) onProgress(parseFloat(match[1]));
    });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('exit', code => {
      if (code === 0) resolve();
      else {
        if (err.includes('not found') || err.includes('No such file')) {
          reject(new Error('yt-dlp is not installed on this server. Add it to the Railway build command.'));
        } else {
          reject(new Error(extractYtDlpError(err)));
        }
      }
    });
    proc.on('error', e => reject(new Error(`yt-dlp not found: ${e.message}`)));
  });
}

async function uploadFileToS3(filePath, s3Key, onProgress) {
  const fileSize = fs.statSync(filePath).size;
  const PART_SIZE = 10 * 1024 * 1024; // 10MB parts

  const multipart = await s3.send(new CreateMultipartUploadCommand({
    Bucket: S3_BUCKET, Key: s3Key, ContentType: 'video/mp4',
  }));

  const parts = [];
  const stream = fs.createReadStream(filePath, { highWaterMark: PART_SIZE });
  let partNumber = 1;
  let bytesUploaded = 0;
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (buf.length >= PART_SIZE) {
      chunks.length = 0;
      const result = await s3.send(new UploadPartCommand({
        Bucket: S3_BUCKET, Key: s3Key,
        UploadId: multipart.UploadId,
        PartNumber: partNumber,
        Body: buf,
      }));
      parts.push({ PartNumber: partNumber, ETag: result.ETag });
      bytesUploaded += buf.length;
      onProgress(Math.round((bytesUploaded / fileSize) * 100));
      partNumber++;
    }
  }

  // Upload remaining
  if (chunks.length > 0) {
    const buf = Buffer.concat(chunks);
    const result = await s3.send(new UploadPartCommand({
      Bucket: S3_BUCKET, Key: s3Key,
      UploadId: multipart.UploadId,
      PartNumber: partNumber,
      Body: buf,
    }));
    parts.push({ PartNumber: partNumber, ETag: result.ETag });
  }

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: S3_BUCKET, Key: s3Key,
    UploadId: multipart.UploadId,
    MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
  }));
}

module.exports = router;
