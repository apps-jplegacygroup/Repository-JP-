const express = require('express');
const { buildReport, getAllReports } = require('../services/reports');
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

module.exports = router;
