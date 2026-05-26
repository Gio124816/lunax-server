const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { S3Client, PutObjectCommand, GetObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const router = express.Router();

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  // Recent @aws-sdk/client-s3 versions inject a CRC32 checksum into the signed
  // request by default. For PRESIGNED browser uploads that breaks things: the
  // signature then demands an x-amz-checksum-crc32 header the browser's plain
  // fetch() PUT never sends, so S3 rejects/resets the connection (every time,
  // every file). Setting these to WHEN_REQUIRED means no checksum is baked in
  // unless we explicitly ask — which matches the simple browser PUT below.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const BUCKET = process.env.AWS_S3_BUCKET || 'lunax-media';
const REGION = process.env.AWS_REGION || 'us-east-2';

// GET /upload/presign — returns a presigned S3 URL for direct browser upload
// Frontend uploads file directly to S3, bypassing Railway entirely
// Works for any file size
router.get('/presign', requireAuth, async (req, res) => {
  try {
    const { fileName, fileType } = req.query;
    if (!fileName || !fileType) {
      return res.status(400).json({ error: 'fileName and fileType are required' });
    }

    const ext = path.extname(fileName) || (fileType.includes('video') ? '.mp4' : '.jpg');
    const key = `uploads/${uuidv4()}${ext}`;

    // Generate presigned PUT URL — valid for 15 minutes.
    // NOTE: we intentionally do NOT set ContentType here. Including it makes the
    // SDK sign expecting a matching Content-Type header on the PUT; any mismatch
    // (or an extra/!=-signed header from the browser) causes S3 to reject and
    // reset the connection mid-body — the ERR_CONNECTION_RESET we were chasing.
    // With no ContentType signed, SignedHeaders=host, and the browser sends only
    // the body — they match, and S3 accepts it. (S3 infers type from the key ext;
    // we can set ContentType server-side later via copy if ever needed.)
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;

    console.log(`[Upload] Presigned URL generated for ${fileName} → ${key}`);
    res.json({ presignedUrl, publicUrl, key });
  } catch (e) {
    console.error('[Upload] Presign error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /upload — accepts base64 encoded file, uploads to S3, returns public URL
// kept for backwards compatibility with any existing callers
router.post('/', requireAuth, async (req, res) => {
  try {
    const { fileData, fileName, fileType } = req.body;
    if (!fileData || !fileName || !fileType) {
      return res.status(400).json({ error: 'fileData, fileName, and fileType are required' });
    }

    // Strip base64 header if present (e.g. "data:video/mp4;base64,")
    const base64 = fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    const ext = path.extname(fileName) || (fileType.includes('video') ? '.mp4' : '.jpg');
    const key = `uploads/${uuidv4()}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: fileType,
    }));

    const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
    res.json({ url: publicUrl });
  } catch (e) {
    console.error('[Upload] S3 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// MULTIPART UPLOAD — for large videos. A single browser PUT of a 100MB+ file
// over a flaky connection frequently resets (ERR_CONNECTION_RESET). Multipart
// splits the file into chunks uploaded independently with per-chunk retry, so
// a dropped chunk only re-sends that chunk, not the whole file.
//
// Flow: init → (presign + PUT each part) → complete. abort cleans up on failure.
// ───────────────────────────────────────────────────────────────────────────

// POST /upload/multipart/init  body: { fileName, fileType }
// Returns { uploadId, key } — start of a multipart upload session.
router.post('/multipart/init', requireAuth, async (req, res) => {
  try {
    const { fileName, fileType } = req.body;
    if (!fileName || !fileType) {
      return res.status(400).json({ error: 'fileName and fileType are required' });
    }
    const ext = path.extname(fileName) || (String(fileType).includes('video') ? '.mp4' : '.jpg');
    const key = `uploads/${uuidv4()}${ext}`;
    const out = await s3.send(new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: fileType,
    }));
    console.log(`[Upload] Multipart init for ${fileName} → ${key} (uploadId ${out.UploadId?.slice(0, 12)}…)`);
    res.json({ uploadId: out.UploadId, key });
  } catch (e) {
    console.error('[Upload] Multipart init error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /upload/multipart/part-url  body: { key, uploadId, partNumber }
// Returns { url } — a presigned URL to PUT one chunk (part). Parts are 1-indexed.
router.post('/multipart/part-url', requireAuth, async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.body;
    if (!key || !uploadId || !partNumber) {
      return res.status(400).json({ error: 'key, uploadId and partNumber are required' });
    }
    const command = new UploadPartCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: Number(partNumber),
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ url });
  } catch (e) {
    console.error('[Upload] Multipart part-url error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /upload/multipart/complete  body: { key, uploadId, parts:[{PartNumber,ETag}] }
// Assembles the uploaded parts into the final object. Returns { publicUrl }.
router.post('/multipart/complete', requireAuth, async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body;
    if (!key || !uploadId || !Array.isArray(parts) || !parts.length) {
      return res.status(400).json({ error: 'key, uploadId and parts[] are required' });
    }
    // S3 requires parts sorted ascending by PartNumber.
    const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted },
    }));
    const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
    console.log(`[Upload] Multipart complete → ${key} (${sorted.length} parts)`);
    res.json({ publicUrl, key });
  } catch (e) {
    console.error('[Upload] Multipart complete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /upload/multipart/abort  body: { key, uploadId }
// Cancels an in-progress multipart upload and frees the partial parts.
router.post('/multipart/abort', requireAuth, async (req, res) => {
  try {
    const { key, uploadId } = req.body;
    if (!key || !uploadId) return res.status(400).json({ error: 'key and uploadId are required' });
    await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
    console.log(`[Upload] Multipart aborted → ${key}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Upload] Multipart abort error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
