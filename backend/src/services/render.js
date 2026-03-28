const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const CROSSFADE_DURATION  = 0.5;  // seconds
const CLIP_DURATION       = 5;    // each Higgsfield clip
const EFFECTIVE_DURATION  = CLIP_DURATION - CROSSFADE_DURATION; // 4.5s per clip

// Build ffmpeg xfade filter_complex string for N clips
// e.g. for 3 clips:
//   [0:v][1:v]xfade=transition=fade:duration=0.5:offset=4.500[v1];
//   [v1][2:v]xfade=transition=fade:duration=0.5:offset=9.000[vout]
function buildXfadeFilter(n) {
  if (n < 2) return null;
  const parts = [];
  let prev = '[0:v]';
  for (let i = 1; i < n; i++) {
    const offset  = (i * EFFECTIVE_DURATION).toFixed(3);
    const outTag  = i === n - 1 ? '[vout]' : `[v${i}]`;
    parts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${CROSSFADE_DURATION}:offset=${offset}${outTag}`);
    prev = outTag;
  }
  return parts.join(';');
}

// Concatenate an ordered array of local mp4 paths into a single output file.
// onProgress(pct) called with 0-100 during encoding.
async function renderFinal(clipPaths, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const n = clipPaths.length;
    if (n === 0) return reject(new Error('No clips to render'));

    let cmd = ffmpeg();
    for (const p of clipPaths) cmd = cmd.input(p);

    const baseOpts = [
      '-c:v libx264',
      '-crf 18',
      '-preset fast',
      '-an',                   // clips are silent — no audio track
      '-pix_fmt yuv420p',      // broad player compatibility
      '-movflags +faststart',  // web-optimized (moov atom at front)
    ];

    if (n === 1) {
      // Single clip — just re-encode
      cmd
        .outputOptions(baseOpts)
        .output(outputPath);
    } else {
      const filter = buildXfadeFilter(n);
      cmd
        .complexFilter(filter)
        .outputOptions([`-map [vout]`, ...baseOpts])
        .output(outputPath);
    }

    cmd
      .on('start', line  => console.log('[ffmpeg] start:', line.slice(0, 160)))
      .on('progress', p  => {
        const pct = Math.min(99, p.percent || 0);
        onProgress?.(pct, p.timemark);
      })
      .on('end',          () => { console.log('[ffmpeg] done →', outputPath); resolve(outputPath); })
      .on('error', (err, _stdout, stderr) => {
        console.error('[ffmpeg] error:', err.message);
        console.error('[ffmpeg] stderr (last 500):', stderr?.slice(-500));
        reject(new Error(`FFmpeg: ${err.message}`));
      })
      .run();
  });
}

// Create an isolated temp dir per property render
function makeTempDir(propertyId) {
  const dir = path.join(os.tmpdir(), `jp-render-${propertyId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (_) { /* best-effort */ }
}

module.exports = { renderFinal, makeTempDir, cleanTempDir };
