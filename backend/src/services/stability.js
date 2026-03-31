const sharp = require('sharp');

// Custom error class so callers can detect 402 (no credits) vs retryable errors
class StabilityError extends Error {
  constructor(status, body) {
    const msg = `Stability AI ${status}: ${body.slice(0, 400)}`;
    super(msg);
    this.status = status;
    this.isCreditsError = status === 402;
    this.isRetryable = status === 429 || status >= 500;
  }
}

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

  // Retry up to 3 times for rate limits / server errors (NOT for 402 — no credits)
  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const blob = new Blob([resized], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('image', blob, 'photo.jpg');
    form.append('up', '555');          // 555 + 810 + 555 = 1920 → 9:16
    form.append('down', '555');
    form.append('left', '0');
    form.append('right', '0');
    form.append('creativity', '0.5');
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
        signal: AbortSignal.timeout(45_000), // 45s per API call
      }
    );

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer); // 1080×1920 JPEG buffer
    }

    const text = await response.text();
    lastErr = new StabilityError(response.status, text);

    // 402 = no credits — stop immediately, don't retry
    if (lastErr.isCreditsError) throw lastErr;

    // 429 / 5xx — wait before retrying
    if (lastErr.isRetryable && attempt < MAX_ATTEMPTS) {
      const delay = attempt * 5000; // 5s, 10s
      console.warn(`[stability] attempt ${attempt} failed (${response.status}), retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // 4xx other than 402/429 — not retryable
    throw lastErr;
  }

  throw lastErr;
}

// Remove an object from a photo using Stability AI Search and Replace.
// objectDescription: text description of what to remove (e.g. "red car", "no parking sign")
// The object is replaced with background continuation matching the surrounding area.
async function removeObject(imageBuffer, objectDescription) {
  if (!process.env.STABILITY_API_KEY) {
    throw new Error('STABILITY_API_KEY is not set in environment');
  }

  // Stability AI Search and Replace expects the image as JPEG at reasonable resolution
  const jpegBuffer = await sharp(imageBuffer)
    .jpeg({ quality: 90 })
    .toBuffer();

  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const blob = new Blob([jpegBuffer], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('image', blob, 'photo.jpg');
    form.append('search_prompt', objectDescription);
    form.append('prompt', 'background, seamless continuation, photorealistic, same architectural style, empty space, no objects, no text, no signs');
    form.append('output_format', 'jpeg');

    const response = await fetch(
      'https://api.stability.ai/v2beta/stable-image/edit/search-and-replace',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
          Accept: 'image/*',
        },
        body: form,
        signal: AbortSignal.timeout(60_000),
      }
    );

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    const text = await response.text();
    lastErr = new StabilityError(response.status, text);

    if (lastErr.isCreditsError) throw lastErr;

    if (lastErr.isRetryable && attempt < MAX_ATTEMPTS) {
      const delay = attempt * 5000;
      console.warn(`[stability/remove-object] attempt ${attempt} failed (${response.status}), retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw lastErr;
  }

  throw lastErr;
}

module.exports = { expandPhoto, removeObject, StabilityError };
