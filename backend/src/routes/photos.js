const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Property = require('../models/property');
const dropbox = require('../services/dropbox');
const { analyzeAllPhotos } = require('../services/claude');

const router = express.Router({ mergeParams: true }); // to access :id from parent

// Multer: memory storage, max 100 files, 20MB each
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 100 },
  fileFilter(_req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

router.use(requireAuth);

// POST /api/v1/properties/:id/photos/upload
// Accepts up to 100 images (multipart field: "photos")
router.post('/upload', requireAdmin, upload.array('photos', 100), async (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const folderPath = `/JP Legacy Pipeline/${req.params.id}/raw`;

  try {
    await dropbox.createFolder(`/JP Legacy Pipeline`);
    await dropbox.createFolder(`/JP Legacy Pipeline/${req.params.id}`);
    await dropbox.createFolder(folderPath);
  } catch (e) { /* folders may already exist */ }

  const uploaded = [];
  const errors = [];

  for (const file of req.files) {
    try {
      // Validate resolution with sharp
      const meta = await sharp(file.buffer).metadata();
      const minDim = 1000;
      if (meta.width < minDim || meta.height < minDim) {
        errors.push({ name: file.originalname, error: `Resolution too low: ${meta.width}x${meta.height} (min ${minDim}px)` });
        continue;
      }

      const photoId = uuidv4();
      const ext = file.originalname.split('.').pop().toLowerCase();
      const dropboxPath = `${folderPath}/${photoId}.${ext}`;

      await dropbox.uploadFile(file.buffer, dropboxPath);
      const thumbnailUrl = await dropbox.getTemporaryLink(dropboxPath);

      uploaded.push({
        id: photoId,
        name: file.originalname,
        dropboxPath,
        thumbnailUrl,
        width: meta.width,
        height: meta.height,
        size: file.size,
        mediaType: file.mimetype,
        uploadedAt: new Date().toISOString(),
      });
    } catch (err) {
      errors.push({ name: file.originalname, error: err.message });
    }
  }

  // Merge with existing photos in step1 meta
  const existing = property.pipeline.step1_upload?.meta?.photos || [];
  const allPhotos = [...existing, ...uploaded];

  const status = allPhotos.length > 0 ? 'in_progress' : 'pending';
  Property.updatePipelineStep(req.params.id, 'step1_upload', {
    status,
    meta: { photos: allPhotos, dropboxFolder: folderPath },
  });

  res.json({ uploaded: uploaded.length, errors, photos: allPhotos });
});

// GET /api/v1/properties/:id/photos
router.get('/', (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const photos = property.pipeline.step1_upload?.meta?.photos || [];
  res.json({ photos });
});

// DELETE /api/v1/properties/:id/photos/:photoId
router.delete('/:photoId', requireAdmin, (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const photos = property.pipeline.step1_upload?.meta?.photos || [];
  const filtered = photos.filter(p => p.id !== req.params.photoId);
  Property.updatePipelineStep(req.params.id, 'step1_upload', {
    status: filtered.length > 0 ? 'in_progress' : 'pending',
    meta: { ...property.pipeline.step1_upload.meta, photos: filtered },
  });
  res.json({ ok: true, remaining: filtered.length });
});

// POST /api/v1/properties/:id/photos/analyze
// Fetches all uploaded photos from Dropbox, runs Claude Vision, stores results
router.post('/analyze', requireAdmin, async (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const photos = property.pipeline.step1_upload?.meta?.photos || [];
  if (photos.length === 0) return res.status(400).json({ error: 'No photos uploaded yet' });

  // Mark step1 as done, step2 as in_progress
  Property.updatePipelineStep(req.params.id, 'step1_upload', { status: 'done', meta: property.pipeline.step1_upload.meta });
  Property.updatePipelineStep(req.params.id, 'step2_claude', { status: 'in_progress', meta: {} });

  // Stream response — analysis takes time
  res.setHeader('Content-Type', 'application/json');

  try {
    // Download photos from Dropbox as base64
    const axios = require('axios');
    const photoData = await Promise.all(
      photos.map(async (photo) => {
        const link = await dropbox.getTemporaryLink(photo.dropboxPath);
        const imgRes = await axios.get(link, { responseType: 'arraybuffer' });
        const base64 = Buffer.from(imgRes.data).toString('base64');
        return {
          id: photo.id,
          name: photo.name,
          base64,
          mediaType: photo.mediaType || 'image/jpeg',
        };
      })
    );

    const { all, selected } = await analyzeAllPhotos(photoData);

    // Save analysis to step2 meta
    Property.updatePipelineStep(req.params.id, 'step2_claude', {
      status: 'done',
      meta: {
        analysisResults: all,
        selectedPhotos: selected,
        analyzedAt: new Date().toISOString(),
        totalAnalyzed: all.length,
        totalSelected: selected.length,
      },
    });

    res.json({
      ok: true,
      totalAnalyzed: all.length,
      totalSelected: selected.length,
      selected,
    });
  } catch (err) {
    Property.updatePipelineStep(req.params.id, 'step2_claude', {
      status: 'failed',
      meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
