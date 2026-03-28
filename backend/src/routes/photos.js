const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Property = require('../models/property');
const dropbox = require('../services/dropbox');
const { analyzeAllPhotos } = require('../services/claude');
const stability = require('../services/stability');

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

// Base Dropbox path — resolves to:
// /JP Legacy Group/INSUMOS GENERALES DE TODO - MARKETING/00_To Organize (Inbox)/JP Legacy Pipeline/2026/[address]
const DROPBOX_BASE = '/JP Legacy Pipeline/2026';

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
    '/JP Legacy Pipeline',
    '/JP Legacy Pipeline/2026',
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

// POST /api/v1/properties/:id/photos/expand
// Starts Stability AI outpaint (4:3 → 9:16) as a background job.
// Returns 202 immediately; frontend polls GET /properties/:id for progress.
router.post('/expand', requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const property = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const rawPhotos = property.pipeline.step1_upload?.meta?.photos || [];
  if (rawPhotos.length === 0) return res.status(400).json({ error: 'No photos uploaded yet' });

  // Mark in_progress and return 202 immediately
  Property.updatePipelineStep(propertyId, 'step2_stability', {
    status: 'in_progress',
    meta: { expandedPhotos: [], progress: 0, total: rawPhotos.length },
  });
  res.status(202).json({ ok: true, total: rawPhotos.length });

  // ---- Background processing (after response sent) ----
  ;(async () => {
    const paths = buildPaths(property);
    const expandedPhotos = [];
    const errors = [];

    for (let i = 0; i < rawPhotos.length; i++) {
      const photo = rawPhotos[i];
      try {
        console.log(`[expand] Processing ${i + 1}/${rawPhotos.length}: ${photo.name}`);

        // 1. Download raw photo from Dropbox
        const link = await dropbox.getTemporaryLink(photo.dropboxPath);
        const axios = require('axios');
        const imgRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });

        // 2. Expand 4:3 → 9:16 with Stability AI
        const expandedBuffer = await stability.expandPhoto(Buffer.from(imgRes.data));

        // 3. Upload expanded photo to Dropbox 02_fotos_expandidas
        const expandedPath = `${paths.expanded}/${photo.id}_9x16.jpg`;
        await dropbox.uploadFile(expandedBuffer, expandedPath);
        const thumbnailUrl = await dropbox.getTemporaryLink(expandedPath);
        console.log(`[expand] Done ${photo.name} → ${expandedPath}`);

        expandedPhotos.push({
          id: photo.id,
          name: photo.name,
          originalPath: photo.dropboxPath,
          expandedPath,
          thumbnailUrl,
          expandedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[expand] Failed ${photo.name}:`, err.message);
        errors.push({ name: photo.name, error: err.message });
      }

      // Update progress after each photo (success or failure)
      Property.updatePipelineStep(propertyId, 'step2_stability', {
        status: 'in_progress',
        meta: { expandedPhotos: [...expandedPhotos], errors: [...errors], progress: i + 1, total: rawPhotos.length },
      });
    }

    const finalStatus = expandedPhotos.length > 0 ? 'done' : 'failed';
    Property.updatePipelineStep(propertyId, 'step2_stability', {
      status: finalStatus,
      meta: {
        expandedPhotos,
        errors,
        progress: rawPhotos.length,
        total: rawPhotos.length,
        expandedAt: new Date().toISOString(),
      },
    });
    console.log(`[expand] Finished. ${expandedPhotos.length}/${rawPhotos.length} expanded. Status: ${finalStatus}`);
  })().catch(err => {
    console.error('[expand] Fatal background error:', err.message);
    Property.updatePipelineStep(propertyId, 'step2_stability', {
      status: 'failed',
      meta: { error: err.message },
    });
  });
});

// POST /api/v1/properties/:id/photos/analyze
// Returns 202 immediately; Claude Vision runs as a background job.
// Frontend polls GET /properties/:id — step3_claude.status changes to 'done' or 'failed'.
router.post('/analyze', requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const property = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  // Prefer expanded 9:16 photos (step2_stability) over raw 4:3 (step1_upload)
  const expandedData = property.pipeline.step2_stability?.meta;
  const usingExpanded = (expandedData?.expandedPhotos?.length || 0) > 0;
  const photos = usingExpanded
    ? expandedData.expandedPhotos.map(ep => ({
        id: ep.id,
        name: ep.name,
        dropboxPath: ep.expandedPath,
        mediaType: 'image/jpeg',
      }))
    : (property.pipeline.step1_upload?.meta?.photos || []);

  if (photos.length === 0) return res.status(400).json({ error: 'No photos uploaded yet' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set in environment' });
  }

  // Mark in_progress and return 202 immediately — avoids Railway 60s proxy timeout
  Property.updatePipelineStep(propertyId, 'step1_upload', {
    status: 'done',
    meta: property.pipeline.step1_upload.meta,
  });
  Property.updatePipelineStep(propertyId, 'step3_claude', {
    status: 'in_progress',
    meta: { total: photos.length, usingExpanded },
  });
  res.status(202).json({ ok: true, total: photos.length, usingExpanded });

  // ---- Background processing (after response sent) ----
  ;(async () => {
    const axios = require('axios');
    console.log(`[analyze] Starting background analysis of ${photos.length} ${usingExpanded ? 'EXPANDED 9:16' : 'RAW 4:3'} photos`);

    // Download + resize all photos in parallel (max 8 concurrent)
    const DOWNLOAD_CONCURRENCY = 8;
    const photoData = [];
    for (let i = 0; i < photos.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = photos.slice(i, i + DOWNLOAD_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (photo) => {
          const link = await dropbox.getTemporaryLink(photo.dropboxPath);
          const imgRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
          // Resize to max 1200px (enough for Claude Vision, smaller = faster)
          const resized = await sharp(Buffer.from(imgRes.data))
            .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          const kb = Math.round(resized.byteLength / 1024);
          console.log(`[analyze] Downloaded+resized ${photo.name}: ${kb}KB`);
          return { id: photo.id, name: photo.name, base64: resized.toString('base64'), mediaType: 'image/jpeg' };
        })
      );
      photoData.push(...results);
    }

    console.log(`[analyze] All ${photoData.length} photos ready. Calling Claude Vision…`);
    const { all, selected } = await analyzeAllPhotos(photoData);
    console.log(`[analyze] Done. Analyzed: ${all.length}, Selected: ${selected.length}`);

    Property.updatePipelineStep(propertyId, 'step3_claude', {
      status: 'done',
      meta: {
        analysisResults: all,
        selectedPhotos: selected,
        analyzedAt: new Date().toISOString(),
        totalAnalyzed: all.length,
        totalSelected: selected.length,
      },
    });
  })().catch(err => {
    console.error('[analyze] FAILED:', err.message, err.stack?.split('\n')[1]);
    Property.updatePipelineStep(propertyId, 'step3_claude', {
      status: 'failed',
      meta: { error: err.message },
    });
  });
});

module.exports = router;
