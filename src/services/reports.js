const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { getAllStats, getStatsForDate, todayKey, getQueue, appendEmailLog, getEmailLogForDate, getLastSuccessfulDailyEmail } = require('../utils/storage');
const { collectMonthlyFUBData, fetchClosedToday, fetchLeadsForDate, formatUSD } = require('./fubReport');

const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Predefined source order (unknown sources appended at the end)
const SOURCE_ORDER = [
  'WhatsApp',
  'Instagram Paola', 'Instagram Jorge', 'Instagram JP',
  'Facebook Paola',  'Facebook Jorge',  'Facebook JP',
  'TikTok Paola',    'TikTok Jorge',    'TikTok JP',
  'YouTube Paola',   'YouTube Jorge',
  'Zillow', 'Homes.com', 'Referidos', 'Sin fuente',
];

// Sources attributed to Paola (by name match)
const PAOLA_SOURCES = [
  'Instagram Paola', 'Facebook Paola', 'TikTok Paola', 'YouTube Paola',
];

const RECIPIENTS = [
  'apps@jplegacygroup.com',
  'jorgeflorez@jplegacygroup.com',
  'paoladiaz@jplegacygroup.com',
  'lucianamaalouf@jplegacygroup.com',
  'marketing@jplegacygroup.com',
  'jeffersonbeltran@jplegacygroup.com',
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function formatSpanishDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return `${DAYS_ES[d.getDay()]} ${day} de ${MONTHS_ES[month - 1]}`;
}

function pct(part, total) {
  if (!total) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function changeArrow(current, previous) {
  if (!previous) return current > 0 ? '↑100%' : '—';
  const diff = Math.round(((current - previous) / previous) * 100);
  if (diff > 0) return `↑${diff}%`;
  if (diff < 0) return `↓${Math.abs(diff)}%`;
  return '→0%';
}

// Returns an array of date strings [startDate .. endDate] inclusive
function dateRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    dates.push(dateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// Aggregate stats for a list of date strings
function aggregateDates(dates) {
  const all = getAllStats();
  const totals = { received: 0, sent: 0, failed: 0, sources: {} };
  dates.forEach((d) => {
    const s = all[d];
    if (!s) return;
    totals.received += s.received || 0;
    totals.sent += s.sent || 0;
    totals.failed += s.failed || 0;
    Object.entries(s.sources || {}).forEach(([src, n]) => {
      totals.sources[src] = (totals.sources[src] || 0) + n;
    });
  });
  return totals;
}

// Sort sources using predefined order
function sortedSources(sources) {
  const known = SOURCE_ORDER.filter((s) => sources[s]);
  const others = Object.keys(sources).filter((s) => !SOURCE_ORDER.includes(s));
  return [...known, ...others];
}

async function sendEmail(subject, body, type = 'unknown') {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.warn('[Reports] Email skipped: GMAIL_USER or GMAIL_APP_PASSWORD not set.');
    appendEmailLog({ date, time, type, subject, status: 'failed', error: 'Credenciales no configuradas' });
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  try {
    await transporter.sendMail({
      from: `"JP Legacy Agent" <${GMAIL_USER}>`,
      to: RECIPIENTS,
      subject,
      text: body,
    });
    console.log(`[Reports] Email enviado: ${subject}`);
    appendEmailLog({ date, time, type, subject, status: 'success', error: null });
  } catch (err) {
    console.error('[Reports] Error al enviar email:', err.message);
    appendEmailLog({ date, time, type, subject, status: 'failed', error: err.message });
    throw err;
  }
}

// ─── Reporte Diario ────────────────────────────────────────────────────────

async function buildReport(date) {
  const stats = getStatsForDate(date);
  const queue = getQueue();
  const pendingLeads = queue.filter((l) => l.status === 'pending');

  // Fetch leads from FUB for accurate scores + phone data
  const [fubLeads, closedToday] = await Promise.all([
    fetchLeadsForDate(date),
    fetchClosedToday(date),
  ]);

  // Score breakdown from FUB leads (only those with a score assigned)
  const scoredLeads = fubLeads.filter((l) => l.score !== null);
  const caliente = scoredLeads.filter((l) => l.score >= 8);
  const tibio    = scoredLeads.filter((l) => l.score >= 5 && l.score <= 7);
  const frio     = scoredLeads.filter((l) => l.score <= 4);

  const lines = [
    `📊 JP Legacy — Reporte Diario ${date}`,
    ``,
    `Leads recibidos hoy: ${stats.received}`,
    `Leads enviados al FUB: ${stats.sent}`,
    `Leads duplicados detectados: ${stats.duplicates || 0}`,
  ];

  // Ventas cerradas hoy
  if (closedToday.length > 0) {
    lines.push(``);
    closedToday.forEach((l) => {
      lines.push(`🏆 ¡Venta cerrada hoy! ${l.name} — ${l.source} — ${l.assignedTo}`);
    });
  }

  // Scores section — always shown
  lines.push(``);
  lines.push(`SCORES DE HOY`);
  lines.push(`🔥 Lead-Caliente (8-10): ${caliente.length} leads`);
  lines.push(`🌡️ Lead-Tibio (5-7): ${tibio.length} leads`);
  lines.push(`❄️ Lead-Frío (1-4): ${frio.length} leads`);

  // Detalle de leads — all leads sorted by score desc, with phone
  lines.push(``);
  lines.push(`DETALLE DE LEADS DE HOY`);
  if (fubLeads.length > 0) {
    fubLeads.forEach((l) => {
      const emoji = l.score >= 8 ? '🔥' : l.score >= 5 ? '🌡️' : l.score !== null ? '❄️' : '•';
      const scoreLabel = l.score !== null ? `Score ${l.score}/10` : 'Sin score';
      lines.push(`${emoji} ${l.name} — ${scoreLabel} — ${l.source} — ${l.phone}`);
    });
  } else {
    lines.push(`Sin leads registrados hoy.`);
  }

  // Por canal — always shown
  lines.push(``);
  lines.push(`POR CANAL`);
  const sources = stats.sources || {};
  const allSources = sortedSources(sources);
  if (allSources.length > 0) {
    allSources.forEach((s) => {
      lines.push(`${s} → ${sources[s]} leads`);
    });
  } else {
    lines.push(`Sin datos de canal hoy.`);
  }

  lines.push(``);
  if (stats.failed === 0) {
    lines.push('Todos los leads fueron enviados al FUB para gestión comercial.');
  } else {
    lines.push(`${pendingLeads.length} leads pendientes de gestión.`);
  }

  // System status footer
  const lastSuccess = getLastSuccessfulDailyEmail();
  const lastSentLabel = lastSuccess
    ? `${lastSuccess.date} ${lastSuccess.time}`
    : 'sin registros previos';
  lines.push(`✅ Sistema operativo — último reporte enviado: ${lastSentLabel}`);

  return lines.join('\n');
}

async function printDailyReport() {
  const report = await buildReport(todayKey());
  console.log('\n' + report);
  return report;
}

function getAllReports() {
  const stats = getAllStats();
  return Object.entries(stats)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, s]) => ({ date, ...s }));
}

async function sendReportByEmail(date) {
  const report = await buildReport(date);
  const subject = `📊 JP Legacy — Reporte Diario ${date}`;
  await sendEmail(subject, report, 'daily');
}

// ─── Reporte Semanal ───────────────────────────────────────────────────────

function buildWeeklyReport(weekStart, weekEnd) {
  // Previous week for comparison
  const prevStart = new Date(weekStart);
  prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd = new Date(weekEnd);
  prevEnd.setDate(prevEnd.getDate() - 7);

  const thisWeekDates = dateRange(weekStart, weekEnd);
  const prevWeekDates = dateRange(dateKey(prevStart), dateKey(prevEnd));

  const thisStats = aggregateDates(thisWeekDates);
  const prevStats = aggregateDates(prevWeekDates);

  const total = thisStats.received;
  const prevTotal = prevStats.received;
  const arrow = changeArrow(total, prevTotal);

  const startLabel = formatSpanishDate(weekStart);
  const endLabel = formatSpanishDate(weekEnd);

  const sources = thisStats.sources;
  const allSources = sortedSources(sources);

  // Top channel
  const topSource = allSources.reduce((top, s) =>
    (sources[s] || 0) > (sources[top] || 0) ? s : top, allSources[0] || '—');

  // Paola vs JP/Jorge
  const paolaTotal = PAOLA_SOURCES.reduce((sum, s) => sum + (sources[s] || 0), 0);
  const paolaSourcesList = PAOLA_SOURCES.filter((s) => sources[s]);
  const jpTotal = total - paolaTotal;
  const jpSourcesList = allSources.filter((s) => !PAOLA_SOURCES.includes(s));

  const lines = [
    `Reporte Semanal – ${startLabel} al ${endLabel}`,
    ``,
    `Leads esta semana: ${total} (${arrow} vs semana anterior)`,
    ``,
    `Desglose por canal:`,
  ];

  allSources.forEach((s) => {
    lines.push(`${sources[s]} ${s} (${pct(sources[s], total)})`);
  });

  lines.push(``);
  lines.push(`Canal más activo: ${topSource}`);
  lines.push(``);
  lines.push(`Paola: ${paolaTotal} leads (${paolaSourcesList.join(' + ') || '—'})`);
  lines.push(`JP: ${jpTotal} leads (${jpSourcesList.join(' + ') || '—'})`);

  return lines.join('\n');
}

async function sendWeeklyReport() {
  // Runs on Monday — report covers the previous Mon–Sun
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - 1); // yesterday = Sunday
  const monday = new Date(sunday);
  monday.setDate(sunday.getDate() - 6); // 6 days before Sunday = Monday

  const weekStart = dateKey(monday);
  const weekEnd = dateKey(sunday);

  console.log(`[Reports] Generating weekly report for ${weekStart} – ${weekEnd}...`);
  const report = buildWeeklyReport(weekStart, weekEnd);
  const subject = `📊 JP Legacy — Reporte Semanal ${weekStart}`;
  await sendEmail(subject, report, 'weekly');
}

// ─── Reporte Mensual (enriquecido con datos de FUB + IA) ──────────────────

async function buildMonthlyReport(year, month) {
  const monthName = MONTHS_ES[month - 1];
  const prevMonthName = MONTHS_ES[month - 2 < 0 ? 11 : month - 2];
  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  // Pull live data from FUB
  const data = await collectMonthlyFUBData(year, month);

  // Previous month total from local stats for % comparison
  const prevFirstDay = new Date(prevMonthYear, prevMonth - 1, 1);
  const prevLastDay = new Date(prevMonthYear, prevMonth, 0);
  const prevDates = dateRange(dateKey(prevFirstDay), dateKey(prevLastDay));
  const prevStats = aggregateDates(prevDates);
  const prevTotal = prevStats.received || 0;

  const arrow = changeArrow(data.total, prevTotal);
  const base = data.countableTotal || 1;
  const underContractRate = `${Math.round((data.underContract / base) * 100)}%`;
  const cerradoRate       = `${Math.round((data.cerrado / base) * 100)}%`;
  const closingRate       = data.underContract > 0
    ? `${Math.round((data.cerrado / data.underContract) * 100)}%`
    : '—';

  // Source breakdown sorted by count
  const sourceEntries = Object.entries(data.bySource).sort((a, b) => b[1] - a[1]);

  // Agent breakdown sorted by count
  const agentEntries = Object.entries(data.byAgent).sort((a, b) => b[1] - a[1]);

  // Conversions per source
  const convSourceEntries = Object.entries(data.conversionsBySource).sort((a, b) => b[1] - a[1]);

  const lines = [
    `📊 JP Legacy — Reporte Mensual ${monthName} ${year}`,
    ``,
    `────────────────────────────────────`,
    `RESUMEN EJECUTIVO`,
    `────────────────────────────────────`,
    `Total leads: ${data.total} (${arrow} vs ${prevMonthName})`,
    `Mejor semana: ${data.bestWeek.label} con ${data.bestWeek.count} leads`,
    `Pipeline total: ${formatUSD(data.pipeline)}`,
    ``,
    `────────────────────────────────────`,
    `CONVERSIÓN`,
    `────────────────────────────────────`,
    `Under Contract este mes: ${data.underContract} leads`,
    `Cerrados este mes: ${data.cerrado} leads`,
    `Tasa de cierre: ${closingRate} (Cerrados / Under Contract)`,
    `Valor total cerrado: ${formatUSD(data.cerradoPipeline)}`,
    `Pipeline activo: ${formatUSD(data.underContractPipeline)}`,
    `Tiempo promedio primer contacto: ${data.avgResponseHours !== null ? data.avgResponseHours + ' horas' : '—'}`,
    ``,
    `────────────────────────────────────`,
    `ROI POR CANAL`,
    `────────────────────────────────────`,
  ];

  sourceEntries.forEach(([source, count]) => {
    const contracts = data.conversionsBySource[source] || 0;
    lines.push(`${source} → ${count} leads | ${contracts} contratos`);
  });

  lines.push(``);
  lines.push(`────────────────────────────────────`);
  lines.push(`SEMANA A SEMANA`);
  lines.push(`────────────────────────────────────`);
  data.weeks.forEach((w) => {
    lines.push(`${w.label}: ${w.count} leads`);
  });

  lines.push(``);
  lines.push(`────────────────────────────────────`);
  lines.push(`PROPIEDADES MÁS BUSCADAS`);
  lines.push(`────────────────────────────────────`);
  lines.push(`Ciudad más mencionada: ${data.aiInsights.topCity}`);
  lines.push(`Precio promedio solicitado: ${data.aiInsights.priceRange}`);
  lines.push(`Builder más mencionado: ${data.aiInsights.topBuilder}`);

  lines.push(``);
  lines.push(`────────────────────────────────────`);
  lines.push(`EQUIPO`);
  lines.push(`────────────────────────────────────`);
  agentEntries.forEach(([agent, count]) => {
    lines.push(`${agent} → ${count} leads asignados`);
  });

  lines.push(``);
  lines.push(`Todos los leads fueron enviados al FUB para gestión comercial.`);

  return lines.join('\n');
}

async function sendMonthlyReport() {
  // Runs on the 1st — report covers the previous month
  const today = new Date();
  const prevMonth = today.getMonth() === 0 ? 12 : today.getMonth(); // 1-based
  const year = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();

  const monthName = MONTHS_ES[prevMonth - 1];
  console.log(`[Reports] Generating monthly FUB report for ${monthName} ${year}...`);
  try {
    const report = await buildMonthlyReport(year, prevMonth);
    const subject = `📊 JP Legacy — Reporte Mensual ${monthName} ${year}`;
    await sendEmail(subject, report, 'monthly');
  } catch (err) {
    console.error('[Reports] Error generating monthly report:', err.message);
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

function startDailyReport() {
  // Every day at midnight — generate and print report
  cron.schedule('0 0 * * *', () => {
    console.log('[Reports] Generating daily report...');
    printDailyReport();
  });

  // Every day at 8am EDT (12:00 UTC) — send daily report by email
  cron.schedule('0 12 * * *', () => {
    const date = todayKey();
    console.log(`[Reports] Sending daily report by email for ${date}...`);
    sendReportByEmail(date);
  });

  // Every Monday at 8am EDT (12:00 UTC) — send weekly report (covers previous Mon–Sun)
  cron.schedule('0 12 * * 1', () => {
    sendWeeklyReport();
  });

  // Every 1st of the month at 8am EDT (12:00 UTC) — send monthly report (covers previous month)
  cron.schedule('0 12 1 * *', () => {
    sendMonthlyReport();
  });

  // Every day at 8:05am EDT (12:05 UTC) — audit: verify daily report was sent, retry if not
  cron.schedule('5 12 * * *', async () => {
    const date = todayKey();
    const todayLog = getEmailLogForDate(date);
    const alreadySent = todayLog.some((e) => e.type === 'daily' && e.status === 'success');
    if (alreadySent) {
      console.log(`[Audit] Reporte diario ${date} ya fue enviado exitosamente. OK.`);
      return;
    }

    console.log(`[Audit] Reporte diario ${date} no fue enviado. Reintentando...`);
    try {
      await sendReportByEmail(date);
      console.log(`[Audit] Reintento exitoso para ${date}.`);
    } catch (err) {
      console.error(`[Audit] Reintento fallido para ${date}:`, err.message);

      // Count failed attempts today (excluding alerts)
      const failedAttempts = getEmailLogForDate(date).filter(
        (e) => e.type === 'daily' && e.status === 'failed'
      );
      const alreadyAlerted = getEmailLogForDate(date).some((e) => e.type === 'alert');

      if (failedAttempts.length >= 2 && !alreadyAlerted) {
        console.error(`[Audit] 2 fallos consecutivos. Enviando alerta a jorgeflorez@jplegacygroup.com...`);
        const alertSubject = '⚠️ JP Legacy — Reporte diario no pudo enviarse';
        const alertBody = [
          `⚠️ El reporte diario de ${date} no pudo enviarse después de ${failedAttempts.length} intentos.`,
          ``,
          `Último error: ${err.message}`,
          ``,
          `Por favor, verifica el sistema manualmente.`,
        ].join('\n');

        const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
        });
        const now = new Date();
        try {
          await transporter.sendMail({
            from: `"JP Legacy Agent" <${GMAIL_USER}>`,
            to: 'jorgeflorez@jplegacygroup.com',
            subject: alertSubject,
            text: alertBody,
          });
          console.log('[Audit] Alerta enviada a jorgeflorez@jplegacygroup.com');
          appendEmailLog({
            date: now.toISOString().slice(0, 10),
            time: now.toTimeString().slice(0, 8),
            type: 'alert',
            subject: alertSubject,
            status: 'success',
            error: null,
          });
        } catch (alertErr) {
          console.error('[Audit] No se pudo enviar la alerta:', alertErr.message);
          appendEmailLog({
            date: now.toISOString().slice(0, 10),
            time: now.toTimeString().slice(0, 8),
            type: 'alert',
            subject: alertSubject,
            status: 'failed',
            error: alertErr.message,
          });
        }
      }
    }
  });

  console.log('[Reports] Schedulers started: daily (midnight + 12:00 UTC/8am EDT + 12:05 UTC audit), weekly (Mon 12:00 UTC), monthly (1st 12:00 UTC).');
}

module.exports = {
  startDailyReport,
  printDailyReport,
  buildReport,
  buildWeeklyReport,
  buildMonthlyReport,
  getAllReports,
  sendReportByEmail,
  sendWeeklyReport,
  sendMonthlyReport,
};
