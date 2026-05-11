const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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

    // Generate presigned PUT URL — valid for 15 minutes
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: fileType,
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

module.exports = router;
