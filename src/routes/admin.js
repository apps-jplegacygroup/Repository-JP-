const express = require('express');
const { sendReportByEmail, sendWeeklyReport, sendMonthlyReport } = require('../services/reports');
const {
  sendDailyMarketingReport,
  sendWeeklyMarketingReport,
  sendMonthlyMarketingReport,
} = require('../services/marketingReport');
const { sendSocialReport, sendDailySocialReport, sendMonthlySocialReport, previewDailySocialReport } = require('../services/socialReport');
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

    if (type === 'social' || type === 'social-weekly') {
      console.log('[Admin] Sending social report (background)...');
      res.json({ ok: true, type: 'social', status: 'processing' });
      sendSocialReport().catch((err) =>
        console.error('[Admin] Background social report failed:', err.message)
      );
      return;
    }

    if (type === 'social-daily') {
      console.log('[Admin] Sending social daily report (background)...');
      res.json({ ok: true, type: 'social-daily', status: 'processing' });
      sendDailySocialReport().catch((err) =>
        console.error('[Admin] Background social-daily failed:', err.message)
      );
      return;
    }

    if (type === 'social-monthly') {
      console.log('[Admin] Sending social monthly report (background)...');
      res.json({ ok: true, type: 'social-monthly', status: 'processing' });
      sendMonthlySocialReport().catch((err) =>
        console.error('[Admin] Background social-monthly failed:', err.message)
      );
      return;
    }

    return res.status(400).json({ error: 'type must be daily|weekly|monthly|marketing-daily|marketing-weekly|marketing-monthly|social|social-daily|social-monthly' });
  } catch (err) {
    console.error(`[Admin] Error sending ${type} report:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/preview-daily-social — build daily social HTML without sending email
router.get('/preview-daily-social', async (req, res) => {
  try {
    const { html } = await previewDailySocialReport();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    console.error('[Admin] preview-daily-social error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/debug-youtube?brand=paola&date=YYYY-MM-DD — raw Metricool YouTube posts JSON
router.get('/debug-youtube', async (req, res) => {
  const axios = require('axios');
  const token  = process.env.METRICOOL_API_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  const brand  = req.query.brand || 'paola';
  const envMap = { paola: 'METRICOOL_BLOG_ID_PAOLA', jorge: 'METRICOOL_BLOG_ID_JORGE', jp_legacy: 'METRICOOL_BLOG_ID_JP_LEGACY' };
  const blogId = process.env[envMap[brand]];
  if (!blogId) return res.status(400).json({ error: `No blogId for brand "${brand}"` });

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const date = req.query.date || yest.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  try {
    const http = axios.create({ baseURL: 'https://app.metricool.com/api', headers: { 'X-Mc-Auth': token }, timeout: 20000 });
    const { data } = await http.get('/v2/analytics/posts/youtube', {
      params: { userId, blogId, from: `${date}T00:00:00`, to: `${date}T23:59:59`, postsType: 'publishedInRange' },
    });
    return res.json({ brand, blogId, date, raw: data });
  } catch (e) {
    return res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /admin/debug-yt-timeline?brand=paola&date=YYYY-MM-DD&metric=videoViews — raw YouTube timelines
router.get('/debug-yt-timeline', async (req, res) => {
  const axios = require('axios');
  const token  = process.env.METRICOOL_API_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  const brand  = req.query.brand || 'paola';
  const metric = req.query.metric || 'videoViews';
  const envMap = { paola: 'METRICOOL_BLOG_ID_PAOLA', jorge: 'METRICOOL_BLOG_ID_JORGE', jp_legacy: 'METRICOOL_BLOG_ID_JP_LEGACY' };
  const blogId = process.env[envMap[brand]];
  if (!blogId) return res.status(400).json({ error: `No blogId for "${brand}"` });

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const date = req.query.date || yest.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  try {
    const http = axios.create({ baseURL: 'https://app.metricool.com/api', headers: { 'X-Mc-Auth': token }, timeout: 20000 });
    const { data } = await http.get('/v2/analytics/timelines', {
      params: { userId, blogId, from: `${date}T00:00:00`, to: `${date}T23:59:59`, metric, network: 'youtube' },
    });
    return res.json({ brand, blogId, date, metric, raw: data });
  } catch (e) {
    return res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /admin/debug-metricool?brand=paola&date=YYYY-MM-DD — full Metricool API discovery for a brand
router.get('/debug-metricool', async (req, res) => {
  const axios = require('axios');
  const token  = process.env.METRICOOL_API_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  const brand  = req.query.brand || 'paola';
  const envMap = { paola: 'METRICOOL_BLOG_ID_PAOLA', jorge: 'METRICOOL_BLOG_ID_JORGE', jp_legacy: 'METRICOOL_BLOG_ID_JP_LEGACY' };
  const blogId = process.env[envMap[brand]];
  if (!blogId) return res.status(400).json({ error: `No blogId for "${brand}"` });

  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const date = req.query.date || yest.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const from = `${date}T00:00:00`, to = `${date}T23:59:59`;
  const base = { userId, blogId };

  const http = axios.create({ baseURL: 'https://app.metricool.com/api', headers: { 'X-Mc-Auth': token }, timeout: 20000 });
  const tryGet = async (url, params) => {
    try { const { data } = await http.get(url, { params }); return data; }
    catch (e) { return { _error: e.response?.status, _msg: e.response?.data?.detail || e.message }; }
  };

  // Timeline metrics to probe — one call per metric
  const tlMetrics = ['impressions','reach','profileVisits','websiteClicks','followersCount',
    'followers','engagement','likes','comments','saved','shares','reachStories','impressionsStories',
    'views','estimatedMinutesWatched','subscribersGained','totalSubscribers'];
  const tlIG = {}, tlIGpost = {}, tlYT = {};
  await Promise.all(tlMetrics.map(async m => {
    // Instagram requires subject param — try both 'account' and 'post'
    tlIG[m]     = await tryGet('/v2/analytics/timelines', { ...base, from, to, metric: m, network: 'instagram', subject: 'account' });
    tlIGpost[m] = await tryGet('/v2/analytics/timelines', { ...base, from, to, metric: m, network: 'instagram', subject: 'post' });
    tlYT[m]     = await tryGet('/v2/analytics/timelines', { ...base, from, to, metric: m, network: 'youtube' });
  }));

  const [
    overview,    overviewV1,
    stories,     storiesV1,
    audience,    audienceIG,
    reelsRaw,    postsRaw,
    ytPosts,     fbPosts,
    igV1Posts,   igV1Reels,
  ] = await Promise.all([
    // Overview endpoints (try both v1 and v2 patterns)
    tryGet('/v2/analytics/overview',   { ...base, from, to }),
    tryGet('/stats/overview',          { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
    // Stories
    tryGet('/v2/analytics/stories',    { ...base, from, to }),
    tryGet('/stats/instagram/stories', { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
    // Audience
    tryGet('/v2/analytics/audience',   { ...base }),
    tryGet('/v2/analytics/audience',   { ...base, network: 'instagram' }),
    // Instagram reels & posts (v1 format we know works)
    tryGet('/stats/instagram/reels',   { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
    tryGet('/stats/instagram/posts',   { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
    // YouTube posts
    tryGet('/v2/analytics/posts/youtube', { ...base, from, to, postsType: 'publishedInRange' }),
    // Facebook posts
    tryGet('/stats/facebook/posts',    { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
    // Instagram stats (v1)
    tryGet('/stats/instagram/posts',   { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
    tryGet('/stats/instagram/reels',   { ...base, start: date.replace(/-/g,''), end: date.replace(/-/g,'') }),
  ]);

  return res.json({
    brand, blogId, date,
    timelines_instagram_account: tlIG,
    timelines_instagram_post:    tlIGpost,
    timelines_youtube:           tlYT,
    overview_v2:         overview,
    overview_v1:         overviewV1,
    stories_v2:          stories,
    stories_v1:          storiesV1,
    audience_v2:         audience,
    audience_v2_ig:      audienceIG,
    ig_reels:            reelsRaw,
    ig_posts:            postsRaw,
    yt_posts:            ytPosts,
    fb_posts:            fbPosts,
  });
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
