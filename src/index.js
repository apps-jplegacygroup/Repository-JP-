require('dotenv').config();
const express = require('express');
const https = require('https');
const axios = require('axios');
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

// ─── Debug: Asana token diagnostic (TEMPORAL) ───────────────────────────────
app.get('/debug/asana-test', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const results = {};

  // 1. Detect which token env vars are present
  const tokenNames = ['ASANA_TOKEN', 'ASANA_ACCESS_TOKEN', 'ASANA_PAT', 'ASANA_API_KEY'];
  results.tokensPresentes = tokenNames.filter(t => !!process.env[t]);
  const token = process.env.ASANA_TOKEN || process.env.ASANA_ACCESS_TOKEN ||
                process.env.ASANA_PAT   || process.env.ASANA_API_KEY || null;
  results.tokenUsado     = token ? `${token.slice(0, 12)}... (${token.length} chars)` : 'NINGUNO';
  results.tokenVariable  = results.tokensPresentes[0] || 'NINGUNO';

  if (!token) {
    return res.json({ ...results, error: 'No se encontró ningún token de Asana en las variables de entorno' });
  }

  // 2. Verify token against /users/me
  try {
    const r1 = await axios.get('https://app.asana.com/api/1.0/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    results.asanaStatus = r1.status;
    results.asanaUser   = r1.data?.data?.name || '(sin nombre)';
    results.asanaEmail  = r1.data?.data?.email || '(sin email)';
  } catch (e) {
    results.asanaStatus = e.response?.status || 'ERROR';
    results.asanaError  = e.response?.data?.errors?.[0]?.message || e.message;
  }

  // 3. Fetch first 3 tasks from pipeline project with memberships
  try {
    const r2 = await axios.get(
      'https://app.asana.com/api/1.0/projects/1211674641565541/tasks',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 3, opt_fields: 'name,memberships.section.name' },
      }
    );
    results.pipelineStatus   = r2.status;
    results.pipelineTareas   = r2.data?.data?.length ?? 0;
    results.primeraTarea     = r2.data?.data?.[0]?.name || 'vacío';
    results.primeraSeccion   = r2.data?.data?.[0]?.memberships?.[0]?.section?.name || 'sin sección';
  } catch (e) {
    results.pipelineStatus = e.response?.status || 'ERROR';
    results.pipelineError  = e.response?.data?.errors?.[0]?.message || e.message;
  }

  // 4. Fetch Team Overview project
  try {
    const r3 = await axios.get(
      'https://app.asana.com/api/1.0/projects/1212623827839295/tasks',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 3, opt_fields: 'name,assignee.name,completed' },
      }
    );
    results.teamOverviewStatus  = r3.status;
    results.teamOverviewTareas  = r3.data?.data?.length ?? 0;
    results.primeraTeamTarea    = r3.data?.data?.[0]?.name || 'vacío';
    results.primeraTeamAssignee = r3.data?.data?.[0]?.assignee?.name || 'sin assignee';
  } catch (e) {
    results.teamOverviewStatus = e.response?.status || 'ERROR';
    results.teamOverviewError  = e.response?.data?.errors?.[0]?.message || e.message;
  }

  res.json(results);
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
  console.log(`[Server] Admin:   POST /admin/send-report?type=daily|weekly|monthly|marketing-daily|marketing-weekly|marketing-monthly|social`);
  checkEnvVars();
  startSelfPing();
  printDailyReport();
});
