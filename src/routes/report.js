const express = require('express');
const { buildReport, getAllReports } = require('../services/reports');
const { buildDailyData, buildDailyText, buildDailyHTML } = require('../services/marketingReport');
const { getQueue, todayKey } = require('../utils/storage');

const router = express.Router();

// GET /report — today's report as text
router.get('/', async (req, res) => {
  const date = req.query.date || todayKey();
  console.log(`[Report] Report requested for ${date}`);
  const { text } = await buildReport(date);
  res.type('text/plain').send(text);
});

// GET /report/json — all stats as JSON
router.get('/json', (req, res) => {
  res.json(getAllReports());
});

// GET /report/queue — current retry queue
router.get('/queue', (req, res) => {
  res.json(getQueue());
});

// GET /test-marketing-report — TEMPORAL: preview del nuevo reporte diario de marketing
router.get('/test-marketing-report', async (req, res) => {
  // Prevent HTTP-level caching (Railway CDN, browser, proxies)
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
  });
  try {
    console.log(`[Test] Generando preview — ${new Date().toISOString()}`);
    const data = await buildDailyData();
    const text = buildDailyText(data);
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    console.error('[Test] Error generando reporte de marketing:', err);
    res.status(500).type('text/plain').send(`Error: ${err.message}\n\n${err.stack}`);
  }
});

// GET /report/test-marketing-report-html — visual preview of daily email in browser
router.get('/test-marketing-report-html', async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
  });
  try {
    console.log(`[Test HTML] Generando preview HTML — ${new Date().toISOString()}`);
    const data = await buildDailyData();
    const html = buildDailyHTML(data);
    res.type('text/html; charset=utf-8').send(html);
  } catch (err) {
    console.error('[Test HTML] Error:', err);
    res.status(500).type('text/plain').send(`Error: ${err.message}\n\n${err.stack}`);
  }
});

module.exports = router;
