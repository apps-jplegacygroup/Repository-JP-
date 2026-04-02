const axios = require('axios');

const CONTENT_API = 'https://content.dropboxapi.com/2';
const API         = 'https://api.dropboxapi.com/2';

// Serialize an object to a JSON string that is safe to use as an HTTP header
// value. Characters outside printable ASCII (0x21–0x7e) — including spaces
// and any non-ASCII codepoints — are escaped as \uXXXX so Node.js's HTTP
// layer never sees them. Dropbox parses the Unicode escapes correctly.
function dropboxArg(obj) {
  return JSON.stringify(obj).replace(/[^\x21-\x7e]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// ── Token management ─────────────────────────────────────────────────────────
// Uses DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET.
// Falls back to static DROPBOX_TOKEN if refresh vars are not set.
// Token cached in memory for 3h; invalidated on 401 and immediately refreshed.
let _cachedToken   = null;
let _cacheExpiry   = 0;   // unix ms

function _invalidateToken() {
  _cachedToken = null;
  _cacheExpiry = 0;
}

async function TOKEN() {
  // Require refresh token — no fallback to static DROPBOX_TOKEN
  if (!process.env.DROPBOX_REFRESH_TOKEN) {
    console.error('[dropbox] DROPBOX_REFRESH_TOKEN is not set! All Dropbox calls will fail.');
    throw new Error('DROPBOX_REFRESH_TOKEN is not configured');
  }

  // Use cached token if still valid
  const now = Date.now();
  if (_cachedToken && now < _cacheExpiry) return _cachedToken;

  console.log('[dropbox] fetching fresh token via refresh_token grant...');
  console.log('[dropbox] DROPBOX_APP_KEY set:', !!process.env.DROPBOX_APP_KEY);
  console.log('[dropbox] DROPBOX_APP_SECRET set:', !!process.env.DROPBOX_APP_SECRET);
  console.log('[dropbox] DROPBOX_REFRESH_TOKEN prefix:', process.env.DROPBOX_REFRESH_TOKEN?.slice(0, 10));

  try {
    const res = await axios.post(
      'https://api.dropboxapi.com/oauth2/token',
      new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
        client_id:     process.env.DROPBOX_APP_KEY,
        client_secret: process.env.DROPBOX_APP_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (!res.data.access_token) {
      console.error('[dropbox] refresh response missing access_token:', JSON.stringify(res.data));
      throw new Error('Dropbox token refresh returned no access_token');
    }

    _cachedToken = res.data.access_token;
    _cacheExpiry = Date.now() + 3 * 60 * 60 * 1000; // 3 hours
    console.log('[dropbox] token refreshed successfully, expires_in:', res.data.expires_in);
    return _cachedToken;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[dropbox] refresh failed:', detail);
    throw new Error(`Dropbox token refresh failed: ${detail}`);
  }
}

// Helper: extract readable Dropbox error, throwing with status attached
function dropboxError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  const enhanced = new Error(`Dropbox ${status}: ${msg}`);
  enhanced.dropboxStatus = status;
  enhanced.dropboxData = data;
  throw enhanced;
}

// Wrapper: run an axios call; on 401, invalidate token cache and retry once.
// callFn receives a fresh token and must return an axios promise.
async function withRetry401(callFn) {
  try {
    return await callFn(await TOKEN());
  } catch (err) {
    // Check both the raw axios response status AND the re-thrown dropboxStatus
    const status = err.response?.status ?? err.dropboxStatus;
    if (status === 401) {
      console.warn('[dropbox] 401 received — invalidating token cache and retrying with fresh token…');
      _invalidateToken();
      // On retry, let errors propagate naturally
      return await callFn(await TOKEN()).catch(retryErr => dropboxError(retryErr));
    }
    // Not a 401 — if it came from axios, enhance it; if already enhanced, rethrow
    if (err.response) dropboxError(err);
    throw err;
  }
}

// Upload a file buffer to Dropbox
// Returns: { path_display, id, size }
async function uploadFile(buffer, dropboxPath) {
  return withRetry401(token =>
    axios.post(`${CONTENT_API}/files/upload`, buffer, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxPath,
          mode: { '.tag': 'overwrite' },
          autorename: false,
          mute: true,
          strict_conflict: false,
        }),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }).then(r => r.data)
  );
}

// Get a temporary (4-hour) direct download link for a file
async function getTemporaryLink(dropboxPath) {
  return withRetry401(token =>
    axios.post(
      `${API}/files/get_temporary_link`,
      { path: dropboxPath },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    ).then(r => r.data.link)
  );
}

// Create a shared link (permanent preview URL)
async function getSharedLink(dropboxPath) {
  try {
    return await withRetry401(token =>
      axios.post(
        `${API}/sharing/create_shared_link_with_settings`,
        { path: dropboxPath, settings: { requested_visibility: 'public' } },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      ).then(r => r.data.url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', ''))
    );
  } catch (err) {
    if (err.dropboxData?.error?.['.tag'] === 'shared_link_already_exists') {
      const existing = err.dropboxData.error.shared_link_already_exists?.metadata?.url;
      if (existing) return existing.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
    }
    throw err;
  }
}

// List files in a folder
async function listFolder(folderPath) {
  return withRetry401(token =>
    axios.post(
      `${API}/files/list_folder`,
      { path: folderPath, recursive: false },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    ).then(r => r.data.entries)
  );
}

// List image files in a shared folder link (e.g. https://www.dropbox.com/sh/xxxx)
// Returns array of { name, path_lower, size } entries for image files only
async function listSharedFolderImages(sharedLink) {
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'tiff', 'tif']);
  let entries = [];
  let cursor = null;

  const firstData = await withRetry401(token =>
    axios.post(
      `${API}/files/list_folder`,
      { path: '', shared_link: { url: sharedLink }, recursive: false },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    ).then(r => r.data)
  );
  entries = firstData.entries;
  cursor = firstData.has_more ? firstData.cursor : null;

  // Paginate if needed
  while (cursor) {
    const contData = await withRetry401(token =>
      axios.post(
        `${API}/files/list_folder/continue`,
        { cursor },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      ).then(r => r.data)
    );
    entries = entries.concat(contData.entries);
    cursor = contData.has_more ? contData.cursor : null;
  }

  // Filter to image files only
  return entries.filter(e => {
    if (e['.tag'] !== 'file') return false;
    const ext = e.name.split('.').pop().toLowerCase();
    return IMAGE_EXTS.has(ext);
  });
}

// Download a specific file from a shared folder link.
// Dropbox requires Content-Type: text/plain and an empty body;
// the args go in the Dropbox-API-Arg header as a JSON string.
// filePath: filename with leading slash, e.g. '/photo.jpg'
async function downloadSharedFile(sharedLink, filePath) {
  return withRetry401(token =>
    axios({
      method: 'post',
      url: `${CONTENT_API}/sharing/get_shared_link_file`,
      data: '',  // required empty body
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
        'Dropbox-API-Arg': dropboxArg({ url: sharedLink, path: filePath }),
      },
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }).then(r => Buffer.from(r.data))
  );
}

// Create folder (silently ignore if already exists)
async function createFolder(folderPath) {
  try {
    await withRetry401(token =>
      axios.post(
        `${API}/files/create_folder_v2`,
        { path: folderPath, autorename: false },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      )
    );
  } catch (err) {
    const data = err.dropboxData || err.response?.data;
    const tag = data?.error?.['.tag'];
    const conflictTag = data?.error?.path?.['.tag'];
    if (tag === 'path' && conflictTag === 'conflict') return; // already exists
    if (err.message?.includes('conflict')) return;
    console.warn(`[dropbox] createFolder ${folderPath}:`, data || err.message);
  }
}

// Test token validity using check/user (minimal scope required)
async function testToken() {
  return withRetry401(token =>
    axios({
      method: 'post',
      url: `${API}/check/user`,
      data: { query: 'ping' },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }).then(r => r.data)
  );
}

// Upload a large file (>100 MB) using Dropbox upload sessions (chunked).
// Chunk size: 100 MB. Automatically handles session start/append/finish.
async function uploadLargeFile(buffer, dropboxPath, chunkSizeMB = 100) {
  const CHUNK = chunkSizeMB * 1024 * 1024;
  const total = buffer.length;

  // 1 — Start session
  const startData = await withRetry401(token =>
    axios.post(
      `${CONTENT_API}/files/upload_session/start`,
      buffer.slice(0, Math.min(CHUNK, total)),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ close: total <= CHUNK }),
        },
        maxBodyLength: Infinity,
      }
    ).then(r => r.data)
  );
  const sessionId = startData.session_id;

  if (total <= CHUNK) {
    return withRetry401(token =>
      axios.post(
        `${CONTENT_API}/files/upload_session/finish`,
        Buffer.alloc(0),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              cursor: { session_id: sessionId, offset: Math.min(CHUNK, total) },
              commit: { path: dropboxPath, mode: { '.tag': 'overwrite' }, autorename: false, mute: true },
            }),
          },
          maxBodyLength: Infinity,
        }
      ).then(r => r.data)
    );
  }

  // 2 — Append remaining chunks
  let offset = CHUNK;
  while (offset < total) {
    const end    = Math.min(offset + CHUNK, total);
    const isLast = end >= total;
    const chunk  = buffer.slice(offset, end);

    if (!isLast) {
      await withRetry401(token =>
        axios.post(
          `${CONTENT_API}/files/upload_session/append_v2`,
          chunk,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
            },
            maxBodyLength: Infinity,
          }
        )
      );
      offset = end;
    } else {
      // 3 — Finish session
      return withRetry401(token =>
        axios.post(
          `${CONTENT_API}/files/upload_session/finish`,
          chunk,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({
                cursor: { session_id: sessionId, offset },
                commit: { path: dropboxPath, mode: { '.tag': 'overwrite' }, autorename: false, mute: true },
              }),
            },
            maxBodyLength: Infinity,
          }
        ).then(r => r.data)
      );
    }
  }
}

module.exports = { uploadFile, uploadLargeFile, getTemporaryLink, getSharedLink, listFolder, createFolder, testToken, listSharedFolderImages, downloadSharedFile };
