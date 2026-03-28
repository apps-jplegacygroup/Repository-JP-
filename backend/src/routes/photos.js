const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Property = require('../models/property');
const dropbox = require('../services/dropbox');
const { analyzeAllPhotos } = require('../services/claude');

const router = express.Router({ mergeParams: true });

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

// Base Dropbox path
const DROPBOX_BASE = '/JP Legacy Group/INSUMOS GENERALES DE TODO - MARKETING/Video Pipeline';

// Sanitize property address for use as folder name
function sanitizeFolderName(str) {
  return str
    .replace(/[<>:"/\\|?*]/g, '')  // remove invalid chars
    .replace(/\s+/g, ' ')           // collapse spaces
    .trim()
    .slice(0, 80);                  // max 80 chars
}

// Build folder paths for a property
function buildPaths(property) {
  const folder = sanitizeFolderName(property.address || property.id);
  const base = `${DROPBOX_BASE}/${folder}`;
  return {
    base,
    raw:       `${base}/01_fotos_raw`,
    expanded:  `${base}/02_fotos_expandidas`,
    approved:  `${base}/03_fotos_aprobadas`,
    clips:     `${base}/04_clips`,
    output:    `${base}/05_output_final`,
  };
}

// Ensure all 5 subfolders exist in Dropbox
async function ensurePropertyFolders(property) {
  const paths = buildPaths(property);
  // Create from top down
  const toCreate = [
    '/JP Legacy Group',
    '/JP Legacy Group/INSUMOS GENERALES DE TODO - MARKETING',
    '/JP Legacy Group/INSUMOS GENERALES DE TODO - MARKETING/Video Pipeline',
    paths.base,
    paths.raw,
    paths.expanded,
    paths.approved,
    paths.clips,
    paths.output,
  ];
  for (const p of toCreate) {
    await dropbox.createFolder(p);
  }
  return paths;
}

// POST /api/v1/properties/:id/photos/upload
router.post('/upload', requireAdmin, upload.array('photos', 100), async (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  let paths;
  try {
    paths = await ensurePropertyFolders(property);
  } catch (e) {
    return res.status(500).json({ error: `Dropbox folder creation failed: ${e.message}` });
  }

  const uploaded = [];
  const errors = [];

  for (const file of req.files) {
    try {
      // Validate resolution
      const meta = await sharp(file.buffer).metadata();
      const minDim = 1000;
      if (meta.width < minDim || meta.height < minDim) {
        errors.push({ name: file.originalname, error: `Resolution too low: ${meta.width}x${meta.height} (min ${minDim}px)` });
        continue;
      }

      const photoId = uuidv4();
      const ext = file.originalname.split('.').pop().toLowerCase() || 'jpg';
      const dropboxPath = `${paths.raw}/${photoId}.${ext}`;

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

  // Merge with existing photos
  const existing = property.pipeline.step1_upload?.meta?.photos || [];
  const allPhotos = [...existing, ...uploaded];

  Property.updatePipelineStep(req.params.id, 'step1_upload', {
    status: allPhotos.length > 0 ? 'in_progress' : 'pending',
    meta: { photos: allPhotos, dropboxFolders: paths },
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
router.post('/analyze', requireAdmin, async (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const photos = property.pipeline.step1_upload?.meta?.photos || [];
  if (photos.length === 0) return res.status(400).json({ error: 'No photos uploaded yet' });

  Property.updatePipelineStep(req.params.id, 'step1_upload', {
    status: 'done',
    meta: property.pipeline.step1_upload.meta,
  });
  Property.updatePipelineStep(req.params.id, 'step2_claude', { status: 'in_progress', meta: {} });

  try {
    const axios = require('axios');
    const photoData = await Promise.all(
      photos.map(async (photo) => {
        const link = await dropbox.getTemporaryLink(photo.dropboxPath);
        const imgRes = await axios.get(link, { responseType: 'arraybuffer' });
        const base64 = Buffer.from(imgRes.data).toString('base64');
        return { id: photo.id, name: photo.name, base64, mediaType: photo.mediaType || 'image/jpeg' };
      })
    );

    const { all, selected } = await analyzeAllPhotos(photoData);

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

    res.json({ ok: true, totalAnalyzed: all.length, totalSelected: selected.length, selected });
  } catch (err) {
    Property.updatePipelineStep(req.params.id, 'step2_claude', {
      status: 'failed',
      meta: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
