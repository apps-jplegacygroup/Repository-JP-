const express = require('express');
const { sendReportByEmail, sendWeeklyReport, sendMonthlyReport } = require('../services/reports');
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
      const date = yesterdayKeyET();
      console.log(`[Admin] Sending daily report for ${date} (yesterday ET)...`);
      await sendReportByEmail(date);
      return res.json({ ok: true, type: 'daily', date });
    }

    if (type === 'weekly') {
      console.log('[Admin] Sending weekly report...');
      await sendWeeklyReport();
      return res.json({ ok: true, type: 'weekly' });
    }

    if (type === 'monthly') {
      console.log('[Admin] Sending monthly report...');
      await sendMonthlyReport();
      return res.json({ ok: true, type: 'monthly' });
    }

    return res.status(400).json({ error: 'type must be daily, weekly, or monthly' });
  } catch (err) {
    console.error(`[Admin] Error sending ${type} report:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
