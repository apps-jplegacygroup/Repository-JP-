const express = require('express');
const { sendReportByEmail, sendWeeklyReport, sendMonthlyReport } = require('../services/reports');
const { debugFUBLeads } = require('../services/fubReport');
const { yesterdayKeyET } = require('../utils/storage');

const router = express.Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'jplegacy2026';

// Middleware: verify X-Admin-Token header
router.use((req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// POST /admin/send-report?type=daily|weekly|monthly
router.post('/send-report', async (req, res) => {
  const { type } = req.query;

  try {
    if (type === 'daily') {
      const date = req.query.date || yesterdayKeyET();
      console.log(`[Admin] Sending daily report for ${date} (background)...`);
      res.json({ ok: true, type: 'daily', date, status: 'processing' });
      sendReportByEmail(date).catch((err) =>
        console.error(`[Admin] Background daily report failed (${date}):`, err.message)
      );
      return;
    }

    if (type === 'weekly') {
      console.log('[Admin] Sending weekly report (background)...');
      res.json({ ok: true, type: 'weekly', status: 'processing' });
      sendWeeklyReport().catch((err) =>
        console.error('[Admin] Background weekly report failed:', err.message)
      );
      return;
    }

    if (type === 'monthly') {
      console.log('[Admin] Sending monthly report (background)...');
      res.json({ ok: true, type: 'monthly', status: 'processing' });
      sendMonthlyReport().catch((err) =>
        console.error('[Admin] Background monthly report failed:', err.message)
      );
      return;
    }

    return res.status(400).json({ error: 'type must be daily, weekly, or monthly' });
  } catch (err) {
    console.error(`[Admin] Error sending ${type} report:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/debug-fub?date=YYYY-MM-DD — diagnose FUB lead fetch for a specific date
router.get('/debug-fub', async (req, res) => {
  const date = req.query.date || yesterdayKeyET();
  try {
    const result = await debugFUBLeads(date);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/debug-report?date=YYYY-MM-DD — returns scored leads as JSON (no email sent)
router.get('/debug-report', async (req, res) => {
  const date = req.query.date || yesterdayKeyET();
  try {
    const { fetchLeadsForDate } = require('../services/fubReport');
    const leads = await fetchLeadsForDate(date);
    return res.json({
      date,
      leadsCount: leads.length,
      leads,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
