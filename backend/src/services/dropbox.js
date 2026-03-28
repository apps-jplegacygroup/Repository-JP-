const axios = require('axios');

const TOKEN = () => process.env.DROPBOX_TOKEN;

const CONTENT_API = 'https://content.dropboxapi.com/2';
const API = 'https://api.dropboxapi.com/2';

// Upload a file buffer to Dropbox
// Returns: { path_display, id, size }
async function uploadFile(buffer, dropboxPath) {
  const res = await axios.post(`${CONTENT_API}/files/upload`, buffer, {
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data;
}

// Get a temporary (4-hour) direct download link for a file
async function getTemporaryLink(dropboxPath) {
  const res = await axios.post(
    `${API}/files/get_temporary_link`,
    { path: dropboxPath },
    { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
  );
  return res.data.link;
}

// Create a shared link (permanent preview URL)
async function getSharedLink(dropboxPath) {
  try {
    const res = await axios.post(
      `${API}/sharing/create_shared_link_with_settings`,
      { path: dropboxPath, settings: { requested_visibility: 'public' } },
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
    );
    // Convert to direct dl link
    return res.data.url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
  } catch (err) {
    // If already shared, fetch existing link
    if (err.response?.data?.error?.['.tag'] === 'shared_link_already_exists') {
      const existing = err.response.data.error.shared_link_already_exists?.metadata?.url;
      if (existing) return existing.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
    }
    throw err;
  }
}

// List files in a folder
async function listFolder(folderPath) {
  const res = await axios.post(
    `${API}/files/list_folder`,
    { path: folderPath, recursive: false },
    { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
  );
  return res.data.entries;
}

// Create folder (ignore if exists)
async function createFolder(folderPath) {
  try {
    await axios.post(
      `${API}/files/create_folder_v2`,
      { path: folderPath, autorename: false },
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    if (err.response?.data?.error?.['.tag'] !== 'path' ) throw err;
    // folder already exists — ok
  }
}

module.exports = { uploadFile, getTemporaryLink, getSharedLink, listFolder, createFolder };
