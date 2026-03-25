require('dotenv').config();
const express = require('express');
const https = require('https');
const { startRetryQueue } = require('./services/retryQueue');
const { startDailyReport, printDailyReport } = require('./services/reports');
const { startMarketingReport } = require('./services/marketingReport');
const { startSocialReport } = require('./services/socialReport');
const webhookRouter = require('./routes/webhook');
const reportRouter = require('./routes/report');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Env var validation ──────────────────────────────────────────────────────
function checkEnvVars() {
  const required = {
    FUB_API_KEY:        process.env.FUB_API_KEY,
    RESEND_API_KEY:     process.env.RESEND_API_KEY,
    ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY,
    ASANA_TOKEN:        process.env.ASANA_TOKEN,
    ASANA_PROJECT_ID:      process.env.ASANA_PROJECT_ID,
    METRICOOL_API_TOKEN:   process.env.METRICOOL_API_TOKEN,
    METRICOOL_USER_ID:     process.env.METRICOOL_USER_ID,
  };
  const optional = {
    ADMIN_TOKEN:             process.env.ADMIN_TOKEN        || '(usando default jplegacy2026)',
    RAILWAY_PUBLIC_DOMAIN:   process.env.RAILWAY_PUBLIC_DOMAIN || '(no configurado — self-ping desactivado)',
  };

  console.log('[Env] ── Variables de entorno ──────────────────────');
  let allOk = true;
  for (const [key, val] of Object.entries(required)) {
    if (val) {
      console.log(`[Env] ✅ ${key}: configurada (${val.slice(0, 8)}...)`);
    } else {
      console.error(`[Env] ❌ ${key}: NO CONFIGURADA — funcionalidad crítica desactivada`);
      allOk = false;
    }
  }
  for (const [key, val] of Object.entries(optional)) {
    console.log(`[Env] ℹ️  ${key}: ${val}`);
  }
  console.log(`[Env] ───────────────────────────────────────────────`);
  return allOk;
}

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
startMarketingReport();
startSocialReport();

app.listen(PORT, () => {
  console.log(`[Server] jp-legacy-agent running on port ${PORT}`);
  console.log(`[Server] Webhook: POST /webhook/lead`);
  console.log(`[Server] Report:  GET  /report`);
  console.log(`[Server] Admin:   POST /admin/send-report?type=daily|weekly|monthly|marketing-daily|marketing-weekly|marketing-monthly|social-weekly`);
  checkEnvVars();
  startSelfPing();
  printDailyReport();
});
