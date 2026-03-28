const sharp = require('sharp');

// Expand a single photo from 4:3 landscape → 9:16 portrait using Stability AI outpaint.
//
// Math:
//   Input:  1080 × 810  (4:3 at 1080px wide)
//   Add:    555px top + 555px bottom
//   Output: 1080 × 1920 (9:16 — standard vertical/Reels format)
//
// imageBuffer: raw Buffer from Dropbox (any resolution)
// prompt: optional text hint for Stability (e.g. "luxurious interior, bright natural light")
async function expandPhoto(imageBuffer, prompt = '') {
  if (!process.env.STABILITY_API_KEY) {
    throw new Error('STABILITY_API_KEY is not set in environment');
  }

  // Resize source to 1080×810 (4:3) so the output is exactly 1080×1920
  const resized = await sharp(imageBuffer)
    .resize(1080, 810, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Build multipart/form-data using Node 18 built-in FormData + Blob
  const blob = new Blob([resized], { type: 'image/jpeg' });
  const form = new FormData();
  form.append('image', blob, 'photo.jpg');
  form.append('up', '555');          // 555 + 810 + 555 = 1920 → 9:16
  form.append('down', '555');
  form.append('left', '0');
  form.append('right', '0');
  form.append('creativity', '0.5');  // balanced AI fill
  form.append('output_format', 'jpeg');
  if (prompt) form.append('prompt', prompt);

  const response = await fetch(
    'https://api.stability.ai/v2beta/stable-image/edit/outpaint',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
        Accept: 'image/*',
      },
      body: form,
      // fetch has no default timeout — rely on Railway's 60s limit per request
      // (background processing handles this at the route level)
      signal: AbortSignal.timeout(120_000), // 2 min per image
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stability AI ${response.status}: ${text.slice(0, 400)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer); // 1080×1920 JPEG buffer
}

module.exports = { expandPhoto };
