const express = require('express');
const { sendReportByEmail, sendWeeklyReport, sendMonthlyReport } = require('../services/reports');
const {
  sendDailyMarketingReport,
  sendWeeklyMarketingReport,
  sendMonthlyMarketingReport,
} = require('../services/marketingReport');
const { sendSocialReport } = require('../services/socialReport');
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

    if (type === 'marketing-daily' || type === 'marketing') {
      console.log('[Admin] Sending marketing-daily report (background)...');
      res.json({ ok: true, type: 'marketing-daily', status: 'processing' });
      sendDailyMarketingReport().catch((err) =>
        console.error('[Admin] Background marketing-daily failed:', err.message)
      );
      return;
    }

    if (type === 'marketing-weekly') {
      console.log('[Admin] Sending marketing-weekly report (background)...');
      res.json({ ok: true, type: 'marketing-weekly', status: 'processing' });
      sendWeeklyMarketingReport().catch((err) =>
        console.error('[Admin] Background marketing-weekly failed:', err.message)
      );
      return;
    }

    if (type === 'marketing-monthly') {
      console.log('[Admin] Sending marketing-monthly report (background)...');
      res.json({ ok: true, type: 'marketing-monthly', status: 'processing' });
      sendMonthlyMarketingReport().catch((err) =>
        console.error('[Admin] Background marketing-monthly failed:', err.message)
      );
      return;
    }

    if (type === 'social-weekly') {
      console.log('[Admin] Sending social-weekly report (background)...');
      res.json({ ok: true, type: 'social-weekly', status: 'processing' });
      sendSocialReport().catch((err) =>
        console.error('[Admin] Background social-weekly failed:', err.message)
      );
      return;
    }

    return res.status(400).json({ error: 'type must be daily, weekly, monthly, marketing-daily, marketing-weekly, marketing-monthly, or social-weekly' });
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
