require('dotenv').config();
const express = require('express');
const { startRetryQueue } = require('./services/retryQueue');
const { startDailyReport, printDailyReport } = require('./services/reports');
const webhookRouter = require('./routes/webhook');
const reportRouter = require('./routes/report');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/webhook', webhookRouter);
app.use('/report', reportRouter);

// Start background jobs
startRetryQueue();
startDailyReport();

app.listen(PORT, () => {
  console.log(`[Server] jp-legacy-agent running on port ${PORT}`);
  console.log(`[Server] Webhook endpoint: POST /webhook/lead`);
  console.log(`[Server] Report endpoint:  GET  /report`);
  // Print today's report on startup
  printDailyReport();
});
