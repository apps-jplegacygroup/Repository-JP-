const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJSON(filePath, defaultValue) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Queue (failed leads pending retry) ---

function getQueue() {
  return readJSON(QUEUE_FILE, []);
}

function saveQueue(queue) {
  writeJSON(QUEUE_FILE, queue);
}

function addToQueue(lead) {
  const queue = getQueue();
  queue.push(lead);
  saveQueue(queue);
}

function updateLeadInQueue(id, updates) {
  const queue = getQueue();
  const idx = queue.findIndex((l) => l.id === id);
  if (idx !== -1) {
    queue[idx] = { ...queue[idx], ...updates };
    saveQueue(queue);
  }
}

function removeFromQueue(id) {
  const queue = getQueue().filter((l) => l.id !== id);
  saveQueue(queue);
}

function getPendingLeads() {
  return getQueue().filter((l) => l.status === 'pending');
}

// --- Stats ---

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getStats() {
  return readJSON(STATS_FILE, {});
}

function saveStats(stats) {
  writeJSON(STATS_FILE, stats);
}

function incrementStat(field) {
  const stats = getStats();
  const key = todayKey();
  if (!stats[key]) stats[key] = { received: 0, sent: 0, failed: 0 };
  stats[key][field] = (stats[key][field] || 0) + 1;
  saveStats(stats);
}

function getStatsForDate(date) {
  const stats = getStats();
  return stats[date] || { received: 0, sent: 0, failed: 0 };
}

function getAllStats() {
  return getStats();
}

module.exports = {
  addToQueue,
  updateLeadInQueue,
  removeFromQueue,
  getPendingLeads,
  getQueue,
  incrementStat,
  getStatsForDate,
  getAllStats,
  todayKey,
};
