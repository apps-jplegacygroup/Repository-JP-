const axios = require('axios');

const CONTENT_API = 'https://content.dropboxapi.com/2';
const API         = 'https://api.dropboxapi.com/2';

// ── Token management ─────────────────────────────────────────────────────────
// Supports two modes:
//   1. DROPBOX_TOKEN (legacy static token — short-lived, kept for fallback)
//   2. DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET
//      → auto-refreshes before every request; token cached in memory for 3h.
let _cachedToken   = null;
let _cacheExpiry   = 0;   // unix ms

async function TOKEN() {
  // Mode 1: static token (no refresh credentials set)
  if (!process.env.DROPBOX_REFRESH_TOKEN) {
    return process.env.DROPBOX_TOKEN;
  }

  // Mode 2: refresh token — use cached value if still valid (3-hour window)
  const now = Date.now();
  if (_cachedToken && now < _cacheExpiry) return _cachedToken;

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

  _cachedToken = res.data.access_token;
  _cacheExpiry = now + 3 * 60 * 60 * 1000; // cache for 3 hours
  console.log('[dropbox] access token refreshed');
  return _cachedToken;
}

// Helper: extract readable Dropbox error
function dropboxError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  const enhanced = new Error(`Dropbox ${status}: ${msg}`);
  enhanced.dropboxStatus = status;
  enhanced.dropboxData = data;
  throw enhanced;
}

// Upload a file buffer to Dropbox
// Returns: { path_display, id, size }
async function uploadFile(buffer, dropboxPath) {
  try {
    const res = await axios.post(`${CONTENT_API}/files/upload`, buffer, {
      headers: {
        Authorization: `Bearer ${await TOKEN()}`,
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
    });
    return res.data;
  } catch (err) {
    dropboxError(err);
  }
}

// Get a temporary (4-hour) direct download link for a file
async function getTemporaryLink(dropboxPath) {
  try {
    const res = await axios.post(
      `${API}/files/get_temporary_link`,
      { path: dropboxPath },
      { headers: { Authorization: `Bearer ${await TOKEN()}`, 'Content-Type': 'application/json' } }
    );
    return res.data.link;
  } catch (err) {
    dropboxError(err);
  }
}

// Create a shared link (permanent preview URL)
async function getSharedLink(dropboxPath) {
  try {
    const res = await axios.post(
      `${API}/sharing/create_shared_link_with_settings`,
      { path: dropboxPath, settings: { requested_visibility: 'public' } },
      { headers: { Authorization: `Bearer ${await TOKEN()}`, 'Content-Type': 'application/json' } }
    );
    return res.data.url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
  } catch (err) {
    if (err.response?.data?.error?.['.tag'] === 'shared_link_already_exists') {
      const existing = err.response.data.error.shared_link_already_exists?.metadata?.url;
      if (existing) return existing.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
    }
    dropboxError(err);
  }
}

// List files in a folder
async function listFolder(folderPath) {
  try {
    const res = await axios.post(
      `${API}/files/list_folder`,
      { path: folderPath, recursive: false },
      { headers: { Authorization: `Bearer ${await TOKEN()}`, 'Content-Type': 'application/json' } }
    );
    return res.data.entries;
  } catch (err) {
    dropboxError(err);
  }
}

// Create folder (silently ignore if already exists)
async function createFolder(folderPath) {
  try {
    await axios.post(
      `${API}/files/create_folder_v2`,
      { path: folderPath, autorename: false },
      { headers: { Authorization: `Bearer ${await TOKEN()}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const tag = err.response?.data?.error?.['.tag'];
    const conflictTag = err.response?.data?.error?.path?.['.tag'];
    if (tag === 'path' && conflictTag === 'conflict') return; // already exists
    if (err.message?.includes('conflict')) return;
    // ignore folder already exists errors silently
    console.warn(`[dropbox] createFolder ${folderPath}:`, err.response?.data || err.message);
  }
}

// Test token validity using check/user (minimal scope required)
async function testToken() {
  const res = await axios({
    method: 'post',
    url: `${API}/check/user`,
    data: { query: 'ping' },
    headers: {
      Authorization: `Bearer ${await TOKEN()}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data; // returns { result: 'ping' } if token is valid
}

// Upload a large file (>100 MB) using Dropbox upload sessions (chunked).
// Chunk size: 100 MB. Automatically handles session start/append/finish.
async function uploadLargeFile(buffer, dropboxPath, chunkSizeMB = 100) {
  const CHUNK = chunkSizeMB * 1024 * 1024;
  const total = buffer.length;

  // 1 — Start session
  let sessionId;
  try {
    const startRes = await axios.post(
      `${CONTENT_API}/files/upload_session/start`,
      buffer.slice(0, Math.min(CHUNK, total)),
      {
        headers: {
          Authorization: `Bearer ${await TOKEN()}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ close: total <= CHUNK }),
        },
        maxBodyLength: Infinity,
      }
    );
    sessionId = startRes.data.session_id;
  } catch (err) { dropboxError(err); }

  if (total <= CHUNK) {
    // File fits in one chunk — commit immediately
    try {
      const res = await axios.post(
        `${CONTENT_API}/files/upload_session/finish`,
        Buffer.alloc(0),
        {
          headers: {
            Authorization: `Bearer ${await TOKEN()}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              cursor: { session_id: sessionId, offset: Math.min(CHUNK, total) },
              commit: { path: dropboxPath, mode: { '.tag': 'overwrite' }, autorename: false, mute: true },
            }),
          },
          maxBodyLength: Infinity,
        }
      );
      return res.data;
    } catch (err) { dropboxError(err); }
  }

  // 2 — Append remaining chunks
  let offset = CHUNK;
  while (offset < total) {
    const end      = Math.min(offset + CHUNK, total);
    const isLast   = end >= total;
    const chunk    = buffer.slice(offset, end);

    if (!isLast) {
      try {
        await axios.post(
          `${CONTENT_API}/files/upload_session/append_v2`,
          chunk,
          {
            headers: {
              Authorization: `Bearer ${await TOKEN()}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
            },
            maxBodyLength: Infinity,
          }
        );
      } catch (err) { dropboxError(err); }
      offset = end;
    } else {
      // 3 — Finish session
      try {
        const res = await axios.post(
          `${CONTENT_API}/files/upload_session/finish`,
          chunk,
          {
            headers: {
              Authorization: `Bearer ${await TOKEN()}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({
                cursor: { session_id: sessionId, offset },
                commit: { path: dropboxPath, mode: { '.tag': 'overwrite' }, autorename: false, mute: true },
              }),
            },
            maxBodyLength: Infinity,
          }
        );
        return res.data;
      } catch (err) { dropboxError(err); }
      break;
    }
  }
}

module.exports = { uploadFile, uploadLargeFile, getTemporaryLink, getSharedLink, listFolder, createFolder, testToken };
