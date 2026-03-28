const axios = require('axios');

const TOKEN = () => process.env.DROPBOX_TOKEN;

const CONTENT_API = 'https://content.dropboxapi.com/2';
const API = 'https://api.dropboxapi.com/2';

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
        Authorization: `Bearer ${TOKEN()}`,
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
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
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
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
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
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
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
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
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

// Test token validity — returns account email or throws
async function testToken() {
  const res = await axios({
    method: 'post',
    url: `${API}/users/get_current_account`,
    data: {},
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

module.exports = { uploadFile, getTemporaryLink, getSharedLink, listFolder, createFolder, testToken };
