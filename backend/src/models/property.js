const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// DATA_DIR env var = Railway persistent volume mount path (e.g. /data)
// Falls back to local src/data/ for development
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'properties.json');

// Ensure data directory and file exist
function ensureStore() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeAll(properties) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(properties, null, 2), 'utf8');
}

const PIPELINE_STEPS = [
  'step1_upload',
  'step2_claude',
  'step3_stability',
  'step4_qa',
  'step5_sequence',
  'step6_kling',
  'step7_higgsfield',
  'step8_render',
];

function defaultPipeline() {
  const pipeline = {};
  for (const step of PIPELINE_STEPS) {
    pipeline[step] = { status: 'pending', updatedAt: null, meta: {} };
  }
  return pipeline;
}

// --- Public API ---

function getAll() {
  return readAll();
}

function getById(id) {
  return readAll().find(p => p.id === id) || null;
}

function create({ address, clientName, assignedTo = [], createdBy, notes = '' }) {
  const properties = readAll();
  const now = new Date().toISOString();
  const property = {
    id: uuidv4(),
    address,
    clientName,
    assignedTo,
    createdBy,
    createdAt: now,
    updatedAt: now,
    pipeline: defaultPipeline(),
    notes,
  };
  properties.push(property);
  writeAll(properties);
  return property;
}

function update(id, fields) {
  const properties = readAll();
  const idx = properties.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const allowed = ['address', 'clientName', 'assignedTo', 'notes'];
  for (const key of allowed) {
    if (fields[key] !== undefined) properties[idx][key] = fields[key];
  }
  properties[idx].updatedAt = new Date().toISOString();
  writeAll(properties);
  return properties[idx];
}

function updatePipelineStep(id, step, { status, meta }) {
  if (!PIPELINE_STEPS.includes(step)) return { error: 'Invalid pipeline step' };
  const validStatuses = ['pending', 'in_progress', 'done', 'failed'];
  if (!validStatuses.includes(status)) return { error: 'Invalid status' };

  const properties = readAll();
  const idx = properties.findIndex(p => p.id === id);
  if (idx === -1) return null;

  properties[idx].pipeline[step] = {
    status,
    updatedAt: new Date().toISOString(),
    meta: meta ?? properties[idx].pipeline[step].meta,
  };
  properties[idx].updatedAt = new Date().toISOString();
  writeAll(properties);
  return properties[idx];
}

function remove(id) {
  const properties = readAll();
  const idx = properties.findIndex(p => p.id === id);
  if (idx === -1) return false;
  properties.splice(idx, 1);
  writeAll(properties);
  return true;
}

module.exports = { getAll, getById, create, update, updatePipelineStep, remove, PIPELINE_STEPS };
