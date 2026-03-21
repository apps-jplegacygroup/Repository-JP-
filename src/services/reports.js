const cron = require('node-cron');
const { getAllStats, getStatsForDate, todayKey, getQueue } = require('../utils/storage');

function buildReport(date) {
  const stats = getStatsForDate(date);
  const queue = getQueue();
  const failedLeads = queue.filter((l) => l.status === 'dead');
  const pendingLeads = queue.filter((l) => l.status === 'pending');

  const lines = [
    `╔══════════════════════════════════════╗`,
    `║       JP-LEGACY AGENT — DAILY REPORT      ║`,
    `╚══════════════════════════════════════╝`,
    ``,
    ` Date    : ${date}`,
    ` Generated: ${new Date().toISOString()}`,
    ``,
    `────────────────────────────────────────`,
    ` Leads received today   : ${stats.received}`,
    ` Leads sent to FUB      : ${stats.sent}`,
    ` Leads failed today     : ${stats.failed}`,
    `────────────────────────────────────────`,
    ` Pending in retry queue : ${pendingLeads.length}`,
    ` Dead (max retries hit) : ${failedLeads.length}`,
    ``,
  ];

  if (failedLeads.length > 0) {
    lines.push(' Dead leads (action required):');
    failedLeads.forEach((l, i) => {
      lines.push(`  ${i + 1}. ${l.name} <${l.email}> — ${l.error}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function printDailyReport() {
  const report = buildReport(todayKey());
  console.log('\n' + report);
  return report;
}

function getAllReports() {
  const stats = getAllStats();
  return Object.entries(stats)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, s]) => ({ date, ...s }));
}

function startDailyReport() {
  // Every day at midnight
  cron.schedule('0 0 * * *', () => {
    console.log('[Reports] Generating daily report...');
    printDailyReport();
  });

  console.log('[Reports] Daily report scheduler started (midnight).');
}

module.exports = { startDailyReport, printDailyReport, buildReport, getAllReports };
