require('dotenv').config();
const express = require('express');
const https = require('https');
const { startRetryQueue } = require('./services/retryQueue');
const { startDailyReport, printDailyReport } = require('./services/reports');
const webhookRouter = require('./routes/webhook');
const reportRouter = require('./routes/report');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Health endpoint ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/webhook', webhookRouter);
app.use('/report', reportRouter);
app.use('/admin', adminRouter);

// ─── Self-ping: keeps Railway awake every 10 minutes ────────────────────────
function startSelfPing() {
  const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;

  if (!RAILWAY_URL) {
    console.log('[Ping] RAILWAY_PUBLIC_DOMAIN not set — self-ping disabled.');
    return;
  }

  setInterval(() => {
    const url = `${RAILWAY_URL}/health`;
    https.get(url, (res) => {
      console.log(`[Ping] Self-ping OK — ${url} → ${res.statusCode}`);
    }).on('error', (err) => {
      console.warn(`[Ping] Self-ping failed: ${err.message}`);
    });
  }, 10 * 60 * 1000); // every 10 minutes

  console.log(`[Ping] Self-ping started → ${RAILWAY_URL}/health every 10 min`);
}

// Start background jobs
startRetryQueue();
startDailyReport();

app.listen(PORT, () => {
  console.log(`[Server] jp-legacy-agent running on port ${PORT}`);
  console.log(`[Server] Webhook endpoint: POST /webhook/lead`);
  console.log(`[Server] Report endpoint:  GET  /report`);
  console.log(`[Server] Admin endpoint:   POST /admin/send-report?type=daily|weekly|monthly`);
  startSelfPing();
  // Print today's report on startup
  printDailyReport();
});
