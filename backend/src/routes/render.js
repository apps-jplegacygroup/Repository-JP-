const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const axios    = require('axios');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Property = require('../models/property');
const dropbox  = require('../services/dropbox');
const { renderFinal, makeTempDir, cleanTempDir } = require('../services/render');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// ── helpers (mirrors photos.js) ─────────────────────────────────────────────
const DROPBOX_BASE = '/JP Legacy Pipeline/2026';
function sanitizeFolderName(str) {
  return str.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function buildPaths(property) {
  const folder = sanitizeFolderName(property.address || property.id);
  const base   = `${DROPBOX_BASE}/${folder}`;
  return { base, clips: `${base}/04_clips`, output: `${base}/05_output_final` };
}

function setPhase(propertyId, meta) {
  const prop = Property.getById(propertyId);
  Property.updatePipelineStep(propertyId, 'step8_render', {
    status: meta.phase === 'done' ? 'done' : meta.phase === 'failed' ? 'failed' : 'in_progress',
    meta,
  });
}

// POST /api/v1/properties/:id/render
router.post('/', requireAdmin, async (req, res) => {
  const propertyId = req.params.id;
  const property   = Property.getById(propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const step7Meta  = property.pipeline.step7_higgsfield?.meta || {};
  const doneClips  = (step7Meta.clips || []).filter(c => c.status === 'done');

  if (doneClips.length === 0) {
    return res.status(400).json({
      error: 'No completed clips found in step7_higgsfield. Generate clips with Higgsfield first.',
    });
  }

  // Sort clips by sequence order (step5_sequence.meta.orderedPhotos)
  const orderedPhotos = property.pipeline.step5_sequence?.meta?.orderedPhotos || [];
  const orderMap      = {};
  orderedPhotos.forEach((p, i) => { orderMap[p.photoId] = i; });
  const orderedClips  = [...doneClips].sort((a, b) =>
    (orderMap[a.photoId] ?? 999) - (orderMap[b.photoId] ?? 999)
  );

  setPhase(propertyId, {
    phase:     'starting',
    message:   `Preparando render de ${orderedClips.length} clips…`,
    clipCount: orderedClips.length,
    downloaded: 0,
    startedAt: new Date().toISOString(),
  });

  res.status(202).json({ ok: true, clipCount: orderedClips.length });

  // ── Background ────────────────────────────────────────────────────────────
  ;(async () => {
    const tempDir = makeTempDir(propertyId);

    try {
      // ── 1. Download clips ───────────────────────────────────────────────
      const clipPaths = [];
      for (let i = 0; i < orderedClips.length; i++) {
        const clip     = orderedClips[i];
        const clipFile = path.join(tempDir, `clip_${String(i).padStart(3, '0')}.mp4`);
        console.log(`[render] Downloading ${i + 1}/${orderedClips.length}: ${clip.name}`);

        setPhase(propertyId, {
          phase:     'downloading_clips',
          message:   `Descargando clips… ${i + 1}/${orderedClips.length}`,
          clipCount: orderedClips.length,
          downloaded: i,
        });

        // Always get a fresh temp link — old ones expire in 4h
        const link  = await dropbox.getTemporaryLink(clip.dropboxPath);
        const dlRes = await axios.get(link, { responseType: 'stream', timeout: 120_000 });

        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(clipFile);
          dlRes.data.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error',  reject);
          dlRes.data.on('error', reject);
        });

        clipPaths.push(clipFile);
      }

      // ── 2. Render ───────────────────────────────────────────────────────
      console.log(`[render] FFmpeg concat: ${clipPaths.length} clips`);
      setPhase(propertyId, {
        phase:     'rendering',
        message:   `Renderizando ${clipPaths.length} clips con FFmpeg…`,
        clipCount: orderedClips.length,
        downloaded: orderedClips.length,
        renderPct:  0,
      });

      const dateStr     = new Date().toISOString().split('T')[0];
      const addressSlug = (property.address || propertyId)
        .replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      const outputFile  = path.join(tempDir, `tour_${addressSlug}_${dateStr}.mp4`);

      await renderFinal(clipPaths, outputFile, (pct) => {
        const prop = Property.getById(propertyId);
        Property.updatePipelineStep(propertyId, 'step8_render', {
          status: 'in_progress',
          meta: {
            ...(prop.pipeline.step8_render?.meta || {}),
            message:   `Renderizando… ${pct.toFixed(0)}%`,
            renderPct: pct,
          },
        });
      });

      const fileSizeMB = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
      console.log(`[render] Output: ${outputFile} (${fileSizeMB} MB)`);

      // ── 3. Upload to Dropbox ────────────────────────────────────────────
      setPhase(propertyId, {
        phase:     'uploading',
        message:   `Subiendo a Dropbox… (${fileSizeMB} MB)`,
        clipCount: orderedClips.length,
        downloaded: orderedClips.length,
        renderPct:  100,
      });

      const paths        = buildPaths(property);
      const dropboxDest  = `${paths.output}/${path.basename(outputFile)}`;
      const fileBuffer   = fs.readFileSync(outputFile);

      if (fileBuffer.length > 100 * 1024 * 1024) {
        await dropbox.uploadLargeFile(fileBuffer, dropboxDest);
      } else {
        await dropbox.uploadFile(fileBuffer, dropboxDest);
      }

      const outputUrl = await dropbox.getTemporaryLink(dropboxDest);

      setPhase(propertyId, {
        phase:       'done',
        message:     `Render completo ✓ — ${fileSizeMB} MB`,
        clipCount:   orderedClips.length,
        downloaded:  orderedClips.length,
        renderPct:   100,
        outputUrl,
        dropboxPath: dropboxDest,
        fileSizeMB:  parseFloat(fileSizeMB),
        completedAt: new Date().toISOString(),
      });
      console.log(`[render] ✓ Complete → ${outputUrl.slice(0, 80)}`);

    } catch (err) {
      console.error('[render] Fatal:', err.message);
      setPhase(propertyId, {
        phase:   'failed',
        message: `Error: ${err.message}`,
        error:   err.message,
      });
    } finally {
      cleanTempDir(tempDir);
    }
  })();
});

module.exports = router;
