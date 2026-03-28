const BASE_URL = 'https://platform.higgsfield.ai';
const MODEL    = 'kling-video/v2.1/pro/image-to-video';

// Retry-able HTTP errors
class HiggsfieldError extends Error {
  constructor(status, body) {
    super(`Higgsfield ${status}: ${body.slice(0, 300)}`);
    this.status      = status;
    this.isRetryable = status === 429 || status >= 500;
  }
}

function authHeader() {
  const id     = process.env.HIGGSFIELD_API_KEY_ID;
  const secret = process.env.HIGGSFIELD_API_KEY_SECRET;
  if (!id || !secret) throw new Error('HIGGSFIELD_API_KEY_ID or HIGGSFIELD_API_KEY_SECRET not set');
  return `Key ${id}:${secret}`;
}

// Submit an image-to-video job.
// imageUrl   — publicly accessible URL (e.g. Dropbox temp link)
// prompt     — Kling movement prompt
// duration   — seconds (default 5 — min Higgsfield supports is 5s)
async function submitClip(imageUrl, prompt, duration = 5) {
  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE_URL}/${MODEL}`, {
      method:  'POST',
      headers: {
        Authorization:  authHeader(),
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body:   JSON.stringify({ image_url: imageUrl, prompt, duration }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) return res.json(); // { status, request_id, status_url, cancel_url }

    const text = await res.text();
    lastErr = new HiggsfieldError(res.status, text);

    if (lastErr.isRetryable && attempt < MAX_ATTEMPTS) {
      const delay = attempt * 10_000; // 10s, 20s
      console.warn(`[higgsfield] submit attempt ${attempt} failed (${res.status}), retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// Poll a submitted job until it completes, fails, or times out.
// Returns the completed status object (with video.url).
async function pollClip(requestId, { maxWaitMs = 360_000, intervalMs = 12_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/requests/${requestId}/status`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      signal:  AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      // 404 occasionally happens right after submission — treat as transient
      if (res.status !== 404) throw new HiggsfieldError(res.status, text);
    } else {
      const data = await res.json();
      console.log(`[higgsfield] poll ${requestId} → ${data.status}`);

      if (data.status === 'completed') return data;
      if (data.status === 'failed' || data.status === 'nsfw') {
        throw new Error(`Higgsfield job ${data.status}${data.error ? ': ' + data.error : ''}`);
      }
      // queued | in_progress — continue polling
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`Higgsfield generation timed out after ${maxWaitMs / 60_000} minutes`);
}

module.exports = { submitClip, pollClip, HiggsfieldError };
