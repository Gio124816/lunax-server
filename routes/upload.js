const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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

// POST /upload — accepts base64 encoded file, uploads to S3, returns public URL
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
