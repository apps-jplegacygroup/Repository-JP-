const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const EMAIL_LOG_FILE = path.join(DATA_DIR, 'email_log.json');

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

// Date string (YYYY-MM-DD) for today in America/New_York (handles EDT/EST)
function todayKeyET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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
  if (!stats[key]) stats[key] = { received: 0, sent: 0, failed: 0, duplicates: 0, sources: {} };
  stats[key][field] = (stats[key][field] || 0) + 1;
  saveStats(stats);
}

function incrementStatBySource(source) {
  const stats = getStats();
  const key = todayKey();
  if (!stats[key]) stats[key] = { received: 0, sent: 0, failed: 0, duplicates: 0, sources: {} };
  if (!stats[key].sources) stats[key].sources = {};
  stats[key].sources[source] = (stats[key].sources[source] || 0) + 1;
  saveStats(stats);
}

function recordLeadScore(name, score, source, phone) {
  const stats = getStats();
  const key = todayKey();
  if (!stats[key]) stats[key] = { received: 0, sent: 0, failed: 0, duplicates: 0, sources: {}, scores: [] };
  if (!stats[key].scores) stats[key].scores = [];
  stats[key].scores.push({ name, score, source, phone: phone || '—' });
  saveStats(stats);
}

function getStatsForDate(date) {
  const stats = getStats();
  return stats[date] || { received: 0, sent: 0, failed: 0, duplicates: 0, sources: {}, scores: [] };
}

function getAllStats() {
  return getStats();
}

// --- Email Log ---

function getEmailLog() {
  return readJSON(EMAIL_LOG_FILE, []);
}

function appendEmailLog(entry) {
  const log = getEmailLog();
  log.push(entry);
  writeJSON(EMAIL_LOG_FILE, log);
}

function getEmailLogForDate(date) {
  return getEmailLog().filter((e) => e.date === date);
}

function getLastSuccessfulDailyEmail() {
  const log = getEmailLog();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === 'daily' && log[i].status === 'success') return log[i];
  }
  return null;
}

module.exports = {
  appendEmailLog,
  getEmailLog,
  getEmailLogForDate,
  getLastSuccessfulDailyEmail,
  addToQueue,
  updateLeadInQueue,
  removeFromQueue,
  getPendingLeads,
  getQueue,
  incrementStat,
  incrementStatBySource,
  recordLeadScore,
  getStatsForDate,
  getAllStats,
  todayKey,
  todayKeyET,
};
