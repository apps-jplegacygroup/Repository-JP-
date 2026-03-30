const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Property = require('../models/property');
const dropbox = require('../services/dropbox');
const { analyzeAllPhotos } = require('../services/claude');
const { expandPhoto, StabilityError } = require('../services/stability');
const { submitClip, pollClip }        = require('../services/higgsfield');

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

// POST /api/v1/properties/:id/photos/import-dropbox
// Accepts { sharedLink } — returns 202 immediately, imports images in background
// Processes photos in parallel batches of 5 for 70-80% faster imports.
router.post('/import-dropbox', requireAdmin, async (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const { sharedLink } = req.body;
  if (!sharedLink || !sharedLink.includes('dropbox.com')) {
    return res.status(400).json({ error: 'sharedLink must be a valid Dropbox URL' });
  }

  // Mark import as started before responding
  Property.updatePipelineStep(req.params.id, 'step1_upload', {
    status: 'in_progress',
    meta: {
      ...property.pipeline.step1_upload?.meta,
      importing: true,
      progress: 0,
      statusMessage: 'Listing images in Dropbox folder…',
      importError: null,
      importSummary: null,
    },
  });

  res.status(202).json({ message: 'Import started' });

  // Background job
  (async () => {
    const propertyId = req.params.id;
    const BATCH_SIZE = 5;

    function saveProgress(progress, statusMessage) {
      const current = Property.getById(propertyId);
      if (!current) return;
      Property.updatePipelineStep(propertyId, 'step1_upload', {
        status: 'in_progress',
        meta: { ...current.pipeline.step1_upload?.meta, importing: true, progress, statusMessage, importError: null },
      });
    }

    try {
      // 1 — Ensure Dropbox folders exist
      const currentProp = Property.getById(propertyId);
      const paths = await ensurePropertyFolders(currentProp);

      // 2 — List images in shared folder
      saveProgress(0, 'Listing images in Dropbox folder…');
      console.log(`[import-dropbox] listing shared folder: ${sharedLink}`);
      const imageEntries = await dropbox.listSharedFolderImages(sharedLink);
      console.log(`[import-dropbox] found ${imageEntries.length} image(s) in shared folder`);

      saveProgress(1, `Found ${imageEntries.length} image${imageEntries.length !== 1 ? 's' : ''} — starting download…`);

      if (imageEntries.length === 0) {
        const current = Property.getById(propertyId);
        Property.updatePipelineStep(propertyId, 'step1_upload', {
          status: current?.pipeline?.step1_upload?.meta?.photos?.length > 0 ? 'in_progress' : 'pending',
          meta: { ...current?.pipeline?.step1_upload?.meta, importing: false, progress: 0, statusMessage: null, importError: 'No images found in that Dropbox folder.' },
        });
        return;
      }

      const total = imageEntries.length;
      const uploaded = [];
      const errors = [];
      let completed = 0;

      // 3 — Process in parallel batches of BATCH_SIZE
      for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = imageEntries.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(batch.map(async (entry) => {
          console.log(`[import-dropbox] downloading: ${entry.name}`);
          const buffer = await dropbox.downloadSharedFile(sharedLink, `/${entry.name}`);

          const meta = await sharp(buffer).metadata();
          const minDim = 1000;
          if (meta.width < minDim || meta.height < minDim) {
            throw new Error(`Resolution too low: ${meta.width}x${meta.height} (min ${minDim}px)`);
          }
          const photoId = uuidv4();
          const ext = entry.name.split('.').pop().toLowerCase() || 'jpg';
          const dropboxPath = `${paths.raw}/${photoId}.${ext}`;
          await dropbox.uploadFile(buffer, dropboxPath);
          const thumbnailUrl = await dropbox.getTemporaryLink(dropboxPath);
          console.log(`[import-dropbox] ✓ ${entry.name}`);
          return {
            id: photoId,
            name: entry.name,
            dropboxPath,
            thumbnailUrl,
            width: meta.width,
            height: meta.height,
            size: entry.size,
            mediaType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            uploadedAt: new Date().toISOString(),
          };
        }));

        // Collect results and update progress after each batch
        results.forEach((result, idx) => {
          const photoName = batch[idx].name;
          if (result.status === 'fulfilled') {
            uploaded.push(result.value);
          } else {
            const err = result.reason;
            console.error(`[import-dropbox] photo ${i + idx} failed (${photoName}):`, err.message || err);
            errors.push({ name: photoName, error: err.message || String(err) });
          }
        });

        completed += batch.length;
        const pct = Math.round((completed / total) * 100);
        saveProgress(pct, `Importing photo ${completed} of ${total} — ${pct}%`);
      }

      // 4 — Merge with existing photos and mark done
      const currentAfter = Property.getById(propertyId);
      const existing = currentAfter?.pipeline?.step1_upload?.meta?.photos || [];
      const allPhotos = [...existing, ...uploaded];

      Property.updatePipelineStep(propertyId, 'step1_upload', {
        status: allPhotos.length > 0 ? 'in_progress' : 'pending',
        meta: {
          photos: allPhotos,
          dropboxFolders: paths,
          importing: false,
          progress: 100,
          statusMessage: `${uploaded.length} of ${total} imported — 100%`,
          importError: errors.length > 0 && uploaded.length === 0 ? 'All images failed to import.' : null,
          importSummary: { imported: uploaded.length, total, failed: errors.length, errors },
        },
      });

      console.log(`[import-dropbox] ${propertyId}: imported ${uploaded.length}/${total}, failed ${errors.length}`);
    } catch (err) {
      console.error('[import-dropbox] error:', err.message);
      const current = Property.getById(propertyId);
      Property.updatePipelineStep(propertyId, 'step1_upload', {
        status: current?.pipeline?.step1_upload?.meta?.photos?.length > 0 ? 'in_progress' : 'pending',
        meta: { ...current?.pipeline?.step1_upload?.meta, importing: false, progress: 0, statusMessage: null, importError: err.message },
      });
    }
  })();
});

// GET /api/v1/properties/:id/photos
router.get('/', (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const photos = property.pipeline.step1_upload?.meta?.photos || [];
  res.json({ photos });
});

// DELETE /api/v1/properties/:id/photos/:photoId
router.delete('/:photoId', (req, res) => {
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
// On retry: skips photos that already have an expandedPhoto entry (resume from where it left off).
router.post('/expand', requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const property = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const rawPhotos = property.pipeline.step1_upload?.meta?.photos || [];
  if (rawPhotos.length === 0) return res.status(400).json({ error: 'No photos uploaded yet' });

  // Carry over already-expanded photos so retries don't re-process them
  const prevMeta   = property.pipeline.step2_stability?.meta || {};
  const alreadyExp = prevMeta.expandedPhotos || [];
  const alreadyIds = new Set(alreadyExp.map(e => e.id));
  const pending    = rawPhotos.filter(p => !alreadyIds.has(p.id));

  if (pending.length === 0) {
    return res.status(400).json({ error: 'All photos already expanded. No pending photos to process.' });
  }

  // Mark in_progress; keep previous expanded photos in meta
  Property.updatePipelineStep(propertyId, 'step2_stability', {
    status: 'in_progress',
    meta: {
      expandedPhotos: alreadyExp,
      errors: [],
      progress: alreadyExp.length,
      total: rawPhotos.length,
    },
  });
  console.log(`[expand] 202 sent for ${propertyId}. pending=${pending.length} alreadyDone=${alreadyExp.length} total=${rawPhotos.length}`);
  res.status(202).json({ ok: true, total: rawPhotos.length, pending: pending.length, alreadyDone: alreadyExp.length });

  // ---- Background processing (true fire-and-forget — runs on Railway
  //      independently of the HTTP connection; user can navigate away) ----
  console.log(`[expand] scheduling setImmediate for ${propertyId}`);
  setImmediate(() => {
    console.log(`[expand] background job started for property: ${propertyId}`);
    (async () => {
      const axios = require('axios');
      // Re-fetch property so buildPaths uses the latest address (not a stale snapshot)
      const freshProp = Property.getById(propertyId) || property;
      const paths = buildPaths(freshProp);
      console.log(`[expand] Dropbox paths: raw=${paths.raw} expanded=${paths.expanded}`);
      console.log(`[expand] STABILITY_API_KEY set: ${!!process.env.STABILITY_API_KEY}`);
      console.log(`[expand] Processing ${pending.length} photos for property ${propertyId}`);

      const expandedPhotos = [...alreadyExp]; // start with already-done photos
      const errors = [];
      let creditsExhausted = false;

      // Wrap a promise with a hard timeout
      function withTimeout(promise, ms) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms);
          promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
        });
      }

      // Process a single photo: download → expand → upload. Throws on failure.
      async function processOnePhoto(photo) {
        const link = await dropbox.getTemporaryLink(photo.dropboxPath);
        const imgRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
        const expandedBuffer = await expandPhoto(Buffer.from(imgRes.data));
        const expandedPath = `${paths.expanded}/${photo.id}_9x16.jpg`;
        await dropbox.uploadFile(expandedBuffer, expandedPath);
        const thumbnailUrl = await dropbox.getTemporaryLink(expandedPath);
        return { expandedPath, thumbnailUrl };
      }

      for (let i = 0; i < pending.length; i++) {
        const photo = pending[i];

        if (creditsExhausted) {
          errors.push({ name: photo.name, error: 'Skipped — Stability AI credits exhausted' });
          Property.updatePipelineStep(propertyId, 'step2_stability', {
            status: 'in_progress',
            meta: { expandedPhotos: [...expandedPhotos], errors: [...errors], progress: expandedPhotos.length, total: rawPhotos.length },
          });
          continue;
        }

        console.log(`[expand] [${i + 1}/${pending.length}] Starting: ${photo.name} (id=${photo.id}) dropboxPath=${photo.dropboxPath}`);

        let result = null;
        let lastErr = null;

        // Try up to 2 attempts (original + 1 retry), each with a 90s outer timeout
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`[expand] [${i + 1}/${pending.length}] attempt ${attempt}: calling processOnePhoto`);
            result = await withTimeout(processOnePhoto(photo), 90_000);
            console.log(`[expand] [${i + 1}/${pending.length}] attempt ${attempt}: processOnePhoto returned OK`);
            break; // success
          } catch (err) {
            lastErr = err;
            console.error(`[expand] [${i + 1}/${pending.length}] attempt ${attempt} error: ${err.message}`);
            if (err instanceof StabilityError && err.isCreditsError) break; // no point retrying
            if (attempt < 2) {
              console.warn(`[expand] attempt ${attempt} failed for ${photo.name}: ${err.message} — retrying in 3s…`);
              await new Promise(r => setTimeout(r, 3000)); // brief pause before retry
            }
          }
        }

        if (result) {
          console.log(`[expand] ✓ ${photo.name}`);
          expandedPhotos.push({
            id: photo.id,
            name: photo.name,
            originalPath: photo.dropboxPath,
            expandedPath: result.expandedPath,
            thumbnailUrl: result.thumbnailUrl,
            expandedAt: new Date().toISOString(),
          });
        } else {
          console.error(`[expand] ✗ ${photo.name} (both attempts failed): ${lastErr.message}`);
          if (lastErr instanceof StabilityError && lastErr.isCreditsError) {
            creditsExhausted = true;
            errors.push({ name: photo.name, error: 'Stability AI credits exhausted — purchase more at platform.stability.ai/account/credits' });
          } else {
            errors.push({ name: photo.name, error: lastErr.message });
          }
        }

        // Persist progress after every photo so resume works after a restart
        Property.updatePipelineStep(propertyId, 'step2_stability', {
          status: 'in_progress',
          meta: { expandedPhotos: [...expandedPhotos], errors: [...errors], progress: expandedPhotos.length, total: rawPhotos.length },
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
          creditsExhausted,
        },
      });
      console.log(`[expand] Done. ${expandedPhotos.length}/${rawPhotos.length} expanded. Errors: ${errors.length}. Status: ${finalStatus}`);
    })().catch(err => {
      console.error('[expand] FATAL background error:', err.message);
      console.error('[expand] FATAL stack:', err.stack);
      Property.updatePipelineStep(propertyId, 'step2_stability', {
        status: 'failed',
        meta: { ...Property.getById(propertyId)?.pipeline?.step2_stability?.meta, error: err.message },
      });
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

// POST /api/v1/properties/:id/photos/generate-kling-prompt/:photoId
// Analyzes the expanded photo with Claude Vision and returns a Kling 3.0
// movement prompt following strict cinematography rules.
// Synchronous — ~5s, well within Railway 60s timeout.
router.post('/generate-kling-prompt/:photoId', requireAdmin, async (req, res) => {
  const { id: propertyId, photoId } = req.params;
  const { space = '', description = '', wowFactor = 5 } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }

  const property = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const expandedPhotos = property.pipeline.step2_stability?.meta?.expandedPhotos || [];
  const photo = expandedPhotos.find(p => p.id === photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found in expanded photos' });

  try {
    const axios    = require('axios');
    const Anthropic = require('@anthropic-ai/sdk');
    const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Download + resize for Claude Vision
    const link   = await dropbox.getTemporaryLink(photo.expandedPath);
    const imgRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
    const resized = await sharp(Buffer.from(imgRes.data))
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const base64Image = resized.toString('base64');

    const spaceCtx = space ? `Space type: ${space.replace(/_/g, ' ')}` : '';
    const descCtx  = description ? `Description: ${description}` : '';
    const wowCtx   = `WOW factor: ${wowFactor}/10`;

    const response = await claudeClient.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: `You are a luxury real estate video director specializing in Kling 3.0 AI video generation.

Analyze this 9:16 property photo and generate ONE cinematic movement prompt following these STRICT rules:

FIXED RULES:
- ONE single movement per prompt — never combine two movements
- Multi-shot is ALWAYS OFF
- ALWAYS end with the exact anti-shake phrase: "Smooth gimbal-stabilized cinematic drone, no shake, no wobble, no handheld movement, perfectly fluid motion throughout"
- Do NOT re-describe the photo — focus ONLY on camera movement and what it reveals
- NEVER use: moves, goes, racing, sharply, quickly, rapidly
- USE: orbit, dolly push, crane up, tracking lateral, pull-back, FPV forward

MOVEMENT SELECTION GUIDE:
- ORBIT: facades, entrances, architectural focal points
- DOLLY PUSH: corridors, kitchens, one-point perspectives
- CRANE UP: pools, exteriors, revealing scale from low to high
- TRACKING LATERAL: pools, long facades, open floor plans
- PULL-BACK + ASCENT: epic closing shot
- FPV FORWARD: driveway, approach to facade

PARALLAX: Add subtle depth/parallax layer whenever architecture or furnishings allow.

PROMPT STRUCTURE:
[Camera movement + direction]
[What the movement reveals or emphasizes]
[Parallax or depth note if applicable]
Smooth gimbal-stabilized cinematic drone, no shake, no wobble, no handheld movement, perfectly fluid [movement] throughout, wide anamorphic lens, luxury real estate cinematography.

MOVEMENT KEY MAPPING — pick the ONE best key from this list:
- orbit → orbit
- dolly push → dolly_forward
- crane up / aerial → aerial_descent
- tracking lateral left → pan_left
- tracking lateral right → pan_right
- pull-back → dolly_back
- FPV forward → dolly_forward
- slow zoom in → slow_zoom_in
- slow zoom out → slow_zoom_out
- static → static

Photo context:
${spaceCtx}
${descCtx}
${wowCtx}

Respond ONLY with a raw JSON object, no markdown, no explanation:
{
  "klingPrompt": "the full prompt following the structure above",
  "klingMovement": "one key from the mapping list above"
}`,
          },
        ],
      }],
    });

    const raw     = response.content[0].text.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned);

    console.log(`[generate-kling] ${photo.name} → ${parsed.klingMovement}: "${parsed.klingPrompt.slice(0, 80)}…"`);
    res.json({ klingPrompt: parsed.klingPrompt, klingMovement: parsed.klingMovement });

  } catch (err) {
    console.error(`[generate-kling] Error for ${photo?.name}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Spaces that contain a floor — use the floor-correction base prompt for these.
const FLOOR_SPACES = new Set([
  'living_room', 'living room',
  'bedroom',
  'kitchen',
  'dining_room', 'dining room',
  'bathroom',
  'hallway',
  'entrance',
]);

const FLOOR_BASE_PROMPT =
  'Correct the image by adjusting the floor perspective to align naturally with the architecture and camera angle. ' +
  'Ensure straight lines and proper depth so the floor looks realistic and consistent with the scene. ' +
  'Adjust the floor color to match the original image tones, ensuring consistent lighting, shadows, and color grading. ' +
  'The floor should blend naturally with the environment without looking altered or artificial. ' +
  'Do not modify any other elements of the image. ' +
  'Do not change furniture, walls, lighting, or architecture. ' +
  'Only correct the floor perspective and color to match the original image. ' +
  'Maintain photorealistic quality, natural textures, accurate perspective, and consistent lighting.';

// POST /api/v1/properties/:id/photos/suggest-prompt/:photoId
// Calls Claude Vision with the expanded image + current prompt + failed checks
// and returns an improved Stability AI outpaint prompt.
// Synchronous — Claude responds in <10s, well within Railway's 60s timeout.
router.post('/suggest-prompt/:photoId', requireAdmin, async (req, res) => {
  const { id: propertyId, photoId } = req.params;
  const { currentPrompt = '', failedChecks = [] } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }

  const property = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const expandedPhotos = property.pipeline.step2_stability?.meta?.expandedPhotos || [];
  const photo = expandedPhotos.find(p => p.id === photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found in expanded photos' });

  try {
    const axios = require('axios');

    // Download + resize the expanded photo for Claude
    const link = await dropbox.getTemporaryLink(photo.expandedPath);
    const imgRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });
    const resized = await sharp(Buffer.from(imgRes.data))
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const base64Image = resized.toString('base64');

    const { analyzePhoto: _unused, ...claudeModule } = require('../services/claude');
    const Anthropic = require('@anthropic-ai/sdk');
    const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const checksText = failedChecks.length > 0
      ? `Problemas detectados: ${failedChecks.join(', ')}.`
      : 'Problemas generales de calidad en la expansión.';

    const promptContext = currentPrompt
      ? `Prompt actual usado (que no funcionó bien): "${currentPrompt}"`
      : 'No se usó prompt personalizado — se usó el prompt por defecto.';

    const spaceKey = (photo.space || '').toLowerCase().replace(/_/g, ' ').trim();
    const isFloorSpace = FLOOR_SPACES.has(photo.space) || FLOOR_SPACES.has(spaceKey);

    // For floor spaces: ask Claude for a short space-specific addition only;
    // we'll prepend the full base floor prompt ourselves so it's always exact.
    // For other spaces: ask Claude for the full improved prompt.
    const claudeInstruction = isFloorSpace
      ? `Eres un experto en fotografía inmobiliaria de lujo y prompts para Stability AI.

Esta foto de ${photo.space?.replace(/_/g, ' ') || 'interior'} ha sido expandida usando Stability AI outpaint y tiene problemas.

${checksText}
${promptContext}

Ya tenemos este prompt base para corregir el piso:
"${FLOOR_BASE_PROMPT}"

Analiza la imagen y escribe UNA SOLA oración adicional en inglés que describa detalles específicos de ESTE espacio (materiales del piso, colores dominantes, estilo arquitectónico, elementos visibles) para añadir contexto útil a ese prompt base. NO repitas ninguna parte del prompt base. Solo la oración adicional, sin explicación, sin comillas, sin texto extra.`
      : `Eres un experto en prompts para Stability AI aplicados a fotografía inmobiliaria de lujo.

Esta foto ha sido expandida de 4:3 a 9:16 (vertical) usando Stability AI outpaint y el resultado tiene problemas.

${checksText}
${promptContext}

Analiza la imagen y genera un prompt mejorado para Stability AI outpaint que corrija específicamente esos problemas. El prompt debe:
- Guiar a Stability AI para producir una continuación limpia y realista de la foto inmobiliaria
- Mencionar elementos arquitectónicos o naturales que se vean en la foto para dar contexto
- Lograr que la expansión se mezcle perfectamente con la imagen original
- Ser específico para este espacio/ambiente (no genérico)
- Siempre incluir: "Maintain exact floor material continuity (same color, texture, and pattern), preserve furniture style and scale, match wall colors and textures seamlessly, no abrupt transitions."

Responde ÚNICAMENTE con el prompt mejorado en inglés, sin explicación, sin comillas, sin texto adicional. Máximo 3 oraciones.`;

    const response = await claudeClient.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          { type: 'text', text: claudeInstruction },
        ],
      }],
    });

    const claudeAddition = response.content[0].text.trim();

    // For floor spaces: base prompt + Claude's space-specific addition
    // For other spaces: Claude's full prompt
    const suggestedPrompt = isFloorSpace
      ? `${FLOOR_BASE_PROMPT} ${claudeAddition}`
      : claudeAddition;

    console.log(`[suggest-prompt] ${photo.name} (space=${photo.space}, floor=${isFloorSpace}): "${suggestedPrompt.slice(0, 120)}"`);
    res.json({ suggestedPrompt });

  } catch (err) {
    console.error(`[suggest-prompt] Error for ${photo.name}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Translate any prompt to English using Claude Haiku (fast + cheap).
// If the text is already in English or is empty, returns it unchanged.
async function translatePromptToEnglish(text) {
  if (!text || !text.trim()) return text;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Translate the following text to English for use as a Stability AI image generation prompt. If it is already in English, return it exactly as-is. Return ONLY the translated text — no explanations, no quotes, no extra words.\n\n${text}`,
      }],
    });
    const translated = response.content[0].text.trim();
    console.log(`[translate-prompt] "${text.slice(0, 60)}" → "${translated.slice(0, 60)}"`);
    return translated;
  } catch (err) {
    console.error(`[translate-prompt] Failed, using original: ${err.message}`);
    return text; // fallback: use original rather than fail
  }
}

// POST /api/v1/properties/:id/photos/reexpand/:photoId
// Re-expands a single previously-expanded photo with an optional custom prompt.
// Returns 202 immediately; updates step2_stability + step4_qa in the background.
router.post('/reexpand/:photoId', requireAdmin, async (req, res) => {
  const { id: propertyId, photoId } = req.params;
  const { prompt = '' } = req.body;

  const property = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const expandedPhotos = property.pipeline.step2_stability?.meta?.expandedPhotos || [];
  const photo = expandedPhotos.find(p => p.id === photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found in expanded photos' });

  // Mark reexpanding=true in step4_qa decisions so frontend can show spinner
  const step4Meta = property.pipeline.step4_qa?.meta || {};
  const decisions = { ...(step4Meta.decisions || {}) };
  decisions[photoId] = { ...(decisions[photoId] || {}), reexpanding: true, reexpandError: null };
  Property.updatePipelineStep(propertyId, 'step4_qa', {
    status: property.pipeline.step4_qa?.status || 'in_progress',
    meta: { ...step4Meta, decisions },
  });

  res.status(202).json({ ok: true, photoId });

  // ---- Background processing ----
  ;(async () => {
    const axios = require('axios');
    const paths = buildPaths(property);

    // Download the original raw photo (not the expanded one) to re-expand fresh
    const link = await dropbox.getTemporaryLink(photo.originalPath);
    const imgRes = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000 });

    // Translate prompt to English (Stability AI only accepts English)
    const englishPrompt = await translatePromptToEnglish(prompt);

    // Re-expand with the translated prompt
    const expandedBuffer = await expandPhoto(Buffer.from(imgRes.data), englishPrompt);

    // Overwrite the existing expanded path in Dropbox
    await dropbox.uploadFile(expandedBuffer, photo.expandedPath);
    const thumbnailUrl = await dropbox.getTemporaryLink(photo.expandedPath);

    // Update step2_stability: replace the thumbnail URL for this photo
    const prop1 = Property.getById(propertyId);
    const updatedExpanded = (prop1.pipeline.step2_stability?.meta?.expandedPhotos || []).map(ep =>
      ep.id === photoId ? { ...ep, thumbnailUrl, reexpandedAt: new Date().toISOString() } : ep
    );
    Property.updatePipelineStep(propertyId, 'step2_stability', {
      status: prop1.pipeline.step2_stability?.status || 'done',
      meta: { ...prop1.pipeline.step2_stability?.meta, expandedPhotos: updatedExpanded },
    });

    // Mark reexpanding=false in step4_qa decisions
    const prop2 = Property.getById(propertyId);
    const m2 = prop2.pipeline.step4_qa?.meta || {};
    const d2 = { ...(m2.decisions || {}) };
    d2[photoId] = { ...(d2[photoId] || {}), reexpanding: false, reexpandError: null, reexpandedAt: new Date().toISOString() };
    Property.updatePipelineStep(propertyId, 'step4_qa', {
      status: prop2.pipeline.step4_qa?.status || 'in_progress',
      meta: { ...m2, decisions: d2 },
    });
    console.log(`[reexpand] ✓ ${photo.name}`);
  })().catch(err => {
    console.error(`[reexpand] ✗ ${photo.name}: ${err.message}`);
    const prop = Property.getById(propertyId);
    const m = prop.pipeline.step4_qa?.meta || {};
    const d = { ...(m.decisions || {}) };
    d[photoId] = { ...(d[photoId] || {}), reexpanding: false, reexpandError: err.message };
    Property.updatePipelineStep(propertyId, 'step4_qa', {
      status: prop.pipeline.step4_qa?.status || 'in_progress',
      meta: { ...m, decisions: d },
    });
  });
});

// POST /api/v1/properties/:id/photos/higgsfield
// Generates video clips for all photos using Higgsfield AI (Kling model).
// Returns 202 immediately; processes one photo at a time to respect rate limits.
// Resume-safe: re-running skips already-completed clips.
router.post('/higgsfield', requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const property   = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  if (!process.env.HIGGSFIELD_API_KEY_ID || !process.env.HIGGSFIELD_API_KEY_SECRET) {
    return res.status(500).json({ error: 'HIGGSFIELD_API_KEY_ID and HIGGSFIELD_API_KEY_SECRET must be set in Railway' });
  }

  const ordered        = property.pipeline.step5_sequence?.meta?.orderedPhotos || [];
  const klingPrompts   = property.pipeline.step6_kling?.meta?.klingPrompts     || {};
  const expandedPhotos = property.pipeline.step2_stability?.meta?.expandedPhotos || [];

  if (ordered.length === 0) {
    return res.status(400).json({ error: 'No photos in step5_sequence.meta.orderedPhotos — complete the Sequence step first' });
  }

  // Resume: skip clips already marked done
  const prevMeta    = property.pipeline.step7_higgsfield?.meta || {};
  const alreadyDone = (prevMeta.clips || []).filter(c => c.status === 'done');
  const alreadyIds  = new Set(alreadyDone.map(c => c.photoId));
  const pending     = ordered.filter(p => !alreadyIds.has(p.photoId));

  if (pending.length === 0) {
    return res.status(400).json({ error: 'All clips already generated. Nothing to do.' });
  }

  Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
    status: 'in_progress',
    meta: {
      clips:    alreadyDone,
      errors:   prevMeta.errors || [],
      progress: alreadyDone.length,
      total:    ordered.length,
      startedAt: new Date().toISOString(),
    },
  });

  res.status(202).json({ ok: true, total: ordered.length, pending: pending.length, alreadyDone: alreadyDone.length });

  // ── Background processing ────────────────────────────────────────────────
  ;(async () => {
    const axios  = require('axios');
    const paths  = buildPaths(property);
    const clips  = [...alreadyDone];
    const errors = []; // Start fresh each run — stale errors from previous runs are discarded

    for (let i = 0; i < pending.length; i++) {
      const photo = pending[i];
      const ep    = expandedPhotos.find(e => e.id === photo.photoId);
      const entry = klingPrompts[photo.photoId];

      if (!ep) {
        errors.push({ photoId: photo.photoId, name: photo.name, error: 'Expanded photo not found in step2_stability' });
        Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
          status: 'in_progress',
          meta: { clips: [...clips], errors: [...errors], progress: clips.length, total: ordered.length },
        });
        continue;
      }
      if (!entry?.prompt) {
        errors.push({ photoId: photo.photoId, name: photo.name, error: 'No Kling prompt found in step6_kling — generate prompts first' });
        Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
          status: 'in_progress',
          meta: { clips: [...clips], errors: [...errors], progress: clips.length, total: ordered.length },
        });
        continue;
      }

      try {
        console.log(`[higgsfield] ${clips.length + 1}/${ordered.length} Submitting: ${photo.name}`);

        // Fresh Dropbox temp link — old links may have expired
        const imageUrl = await dropbox.getTemporaryLink(ep.expandedPath);

        // 1 — Submit job to Higgsfield
        const job = await submitClip(imageUrl, entry.prompt, 5);
        console.log(`[higgsfield] Job ${job.request_id} submitted for ${photo.name}`);

        // Mark this photo as "generating" so frontend can show it immediately
        Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
          status: 'in_progress',
          meta: {
            clips:    [...clips, { photoId: photo.photoId, name: photo.name, status: 'generating', requestId: job.request_id }],
            errors,
            progress: clips.length,
            total:    ordered.length,
          },
        });

        // 2 — Poll until completed (max 6 min per clip, 12s interval)
        const result   = await pollClip(job.request_id, { maxWaitMs: 360_000, intervalMs: 12_000 });
        const videoUrl = result.video?.url;
        if (!videoUrl) throw new Error('Higgsfield returned completed status but no video.url');

        // 3 — Download clip
        console.log(`[higgsfield] Downloading clip for ${photo.name}…`);
        const videoRes    = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
        const videoBuffer = Buffer.from(videoRes.data);

        // 4 — Upload to Dropbox 04_clips/
        const clipPath       = `${paths.clips}/${photo.photoId}.mp4`;
        await dropbox.uploadFile(videoBuffer, clipPath);
        const clipDropboxUrl = await dropbox.getTemporaryLink(clipPath);

        clips.push({
          photoId:     photo.photoId,
          name:        photo.name,
          space:       photo.space,
          wowFactor:   photo.wow_factor,
          status:      'done',
          requestId:   job.request_id,
          dropboxPath: clipPath,
          dropboxUrl:  clipDropboxUrl,
          generatedAt: new Date().toISOString(),
        });
        console.log(`[higgsfield] ✓ ${photo.name} (${clips.length}/${ordered.length})`);

      } catch (err) {
        console.error(`[higgsfield] ✗ ${photo.name}: ${err.message}`);
        errors.push({ photoId: photo.photoId, name: photo.name, error: err.message });
      }

      // Persist progress after every photo
      Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
        status: 'in_progress',
        meta: { clips: [...clips], errors: [...errors], progress: clips.length, total: ordered.length },
      });
    }

    const finalStatus = clips.length > 0 ? 'done' : 'failed';
    Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
      status: finalStatus,
      meta: {
        clips,
        errors,
        progress:    ordered.length,
        total:       ordered.length,
        completedAt: new Date().toISOString(),
      },
    });
    console.log(`[higgsfield] Complete. ${clips.length}/${ordered.length} clips. Errors: ${errors.length}. Status: ${finalStatus}`);
  })().catch(err => {
    console.error('[higgsfield] Fatal background error:', err.message);
    const prop = Property.getById(propertyId);
    Property.updatePipelineStep(propertyId, 'step7_higgsfield', {
      status: 'failed',
      meta: { ...(prop.pipeline.step7_higgsfield?.meta || {}), error: err.message },
    });
  });
});

module.exports = router;
