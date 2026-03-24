const cron = require('node-cron');
const { Resend } = require('resend');
const { getAllStats, todayKey, todayKeyET, yesterdayKeyET, appendEmailLog, getEmailLogForDate, getLastSuccessfulDailyEmail } = require('../utils/storage');
const { collectMonthlyFUBData, fetchClosedToday, fetchLeadsForDate, formatUSD } = require('./fubReport');

const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Predefined source order (unknown sources appended at the end)
const SOURCE_ORDER = [
  'WhatsApp JP Legacy', 'WhatsApp Paola',
  'Instagram Paola',    'Instagram Jorge',  'Instagram JP',
  'Facebook Paola',     'Facebook Jorge',   'Facebook JP',
  'TikTok Paola',       'TikTok Jorge',     'TikTok JP Legacy',
  'YouTube Paola',      'YouTube Jorge',
  'LinkedIn Paola',
  'Zillow', 'Homes.com',
  'Referidos JP', 'Referidos Karina', 'Referidos Carlos', 'Referidos Richard',
  'Pauta Facebook JP', 'Pauta Facebook Paola',
  'Wojo FB Ads', 'Formulario Web',
  'Jorge Personal', 'JP Legacy Listings',
  'Sin fuente',
];

// Sources attributed to Paola
const PAOLA_SOURCES = [
  'Instagram Paola', 'Facebook Paola', 'TikTok Paola', 'YouTube Paola',
  'WhatsApp Paola', 'LinkedIn Paola', 'Pauta Facebook Paola',
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

async function sendEmail(subject, body, type = 'unknown', html = null) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);

  if (!process.env.RESEND_API_KEY) {
    console.warn('[Reports] Email skipped: RESEND_API_KEY not set.');
    appendEmailLog({ date, time, type, subject, status: 'failed', error: 'RESEND_API_KEY no configurada' });
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const payload = {
    from: 'JP Legacy Agent <apps@jplegacygroup.com>',
    to: RECIPIENTS,
    subject,
    text: body,
  };
  if (html) payload.html = html;

  try {
    const { error } = await resend.emails.send(payload);
    if (error) throw new Error(error.message);
    console.log(`[Reports] Email enviado: ${subject}`);
    appendEmailLog({ date, time, type, subject, status: 'success', error: null });
  } catch (err) {
    console.error('[Reports] Error al enviar email:', err.message);
    appendEmailLog({ date, time, type, subject, status: 'failed', error: err.message });
    throw err;
  }
}

// ─── HTML Email Builder ─────────────────────────────────────────────────────

function buildDailyReportHTML(date, fubLeads, closedToday, sources, caliente, tibio, frio, lastSentLabel) {
  const formattedDate = formatSpanishDate(date);
  const totalLeads = fubLeads.length;
  const allSources = sortedSources(sources);
  const maxSourceCount = allSources.length > 0 ? Math.max(...allSources.map((s) => sources[s])) : 1;

  // Lead rows
  const leadRows = fubLeads.length > 0
    ? fubLeads.map((l) => {
        const isHot  = l.score >= 8;
        const isWarm = l.score >= 5 && l.score < 8;
        const scoreClass = isHot ? 'score-hot' : isWarm ? 'score-warm' : 'score-cold';
        const scoreColor = isHot ? '#FF6B35' : isWarm ? '#FFD700' : '#4FC3F7';
        const emoji      = isHot ? '🔥' : isWarm ? '🌡️' : '❄️';
        const scoreLabel = l.score !== null ? `${emoji} ${l.score}/10` : '—';
        const reason     = l.scoreReason || '—';
        return `
        <div class="lead-row">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="50%">
                <div class="lead-name">${l.name}</div>
                <div class="lead-source">${l.source} &nbsp;|&nbsp; ${l.phone}</div>
              </td>
              <td width="20%" align="center">
                <span style="color:${scoreColor};font-weight:bold;font-size:15px;">${scoreLabel}</span>
              </td>
              <td width="30%" align="right">
                <span style="color:#888888;font-size:11px;font-style:italic;">${reason}</span>
              </td>
            </tr>
          </table>
        </div>`;
      }).join('')
    : '<div style="color:#888888;padding:16px 0;text-align:center;">Sin leads registrados hoy.</div>';

  // Channel bars
  const channelBars = allSources.map((s) => {
    const count = sources[s];
    const pct = Math.round((count / maxSourceCount) * 100);
    return `
      <div style="margin-bottom:12px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="38%" style="color:#FFFFFF;font-size:12px;padding-right:8px;">${s}</td>
            <td width="50%">
              <div class="channel-bar"><div class="channel-fill" style="width:${pct}%;"></div></div>
            </td>
            <td width="12%" align="right" style="color:#C9A84C;font-size:12px;font-weight:bold;padding-left:8px;">${count}</td>
          </tr>
        </table>
      </div>`;
  }).join('');

  // Closed deals
  const closedHTML = closedToday.length > 0
    ? closedToday.map((l) => `
      <div style="background:#111111;border:1px solid #C9A84C;border-radius:8px;padding:16px;margin-bottom:10px;">
        <span style="font-size:20px;">🏆</span>
        <span style="color:#C9A84C;font-weight:bold;font-size:14px;letter-spacing:1px;"> ¡VENTA CERRADA!</span>
        <div style="color:#FFFFFF;margin-top:6px;font-size:13px;">${l.name} &nbsp;·&nbsp; ${l.source} &nbsp;·&nbsp; ${l.assignedTo}</div>
      </div>`).join('')
    : '';

  // Warning
  const unclassified = sources['Sin clasificar ⚠️'] || 0;
  const warningHTML = unclassified > 0
    ? `<div style="background:#111111;border:1px solid #FF8C00;border-radius:8px;padding:14px 18px;margin-top:16px;">
        <span style="color:#FF8C00;font-size:13px;">⚠️ <strong>${unclassified} lead${unclassified > 1 ? 's' : ''} sin fuente clasificada</strong> — revisar y actualizar el source en FUB</span>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>JP Legacy — Reporte Diario</title>
  <style>
    body { background:#000000; font-family:Arial,sans-serif; color:#FFFFFF; margin:0; padding:0; }
    .container { max-width:600px; margin:0 auto; padding:20px; }
    .header { text-align:center; border-bottom:2px solid #C9A84C; padding:20px 0; margin-bottom:20px; }
    .logo { color:#C9A84C; font-size:28px; font-weight:bold; letter-spacing:4px; }
    .subtitle { color:#888888; font-size:12px; letter-spacing:2px; margin-top:6px; text-transform:uppercase; }
    .card { background:#111111; border:1px solid rgba(201,168,76,0.2); border-radius:8px; padding:20px; margin:15px 0; }
    .card-title { color:#C9A84C; font-size:11px; letter-spacing:3px; text-transform:uppercase; margin-bottom:15px; font-weight:bold; }
    .stat-grid { display:table; width:100%; }
    .stat-cell { display:table-cell; text-align:center; width:25%; padding:10px 4px; }
    .stat-number { color:#FFFFFF; font-size:36px; font-weight:bold; line-height:1; }
    .stat-label { color:#888888; font-size:10px; letter-spacing:1px; margin-top:4px; text-transform:uppercase; }
    .stat-number-hot  { color:#FF6B35; font-size:32px; font-weight:bold; line-height:1; }
    .stat-number-warm { color:#FFD700; font-size:32px; font-weight:bold; line-height:1; }
    .stat-number-cold { color:#4FC3F7; font-size:32px; font-weight:bold; line-height:1; }
    .lead-row { border-bottom:1px solid #222222; padding:12px 0; }
    .lead-row:last-child { border-bottom:none; }
    .lead-name { color:#FFFFFF; font-weight:bold; font-size:14px; }
    .lead-source { color:#888888; font-size:12px; margin-top:2px; }
    .score-hot  { color:#FF6B35; font-weight:bold; }
    .score-warm { color:#FFD700; font-weight:bold; }
    .score-cold { color:#4FC3F7; font-weight:bold; }
    .channel-bar  { background:#222222; border-radius:4px; height:6px; }
    .channel-fill { background:#C9A84C; border-radius:4px; height:6px; }
    .footer { text-align:center; color:#444444; font-size:11px; padding:20px 0; border-top:1px solid #222222; margin-top:20px; }
    .divider { border:none; border-top:1px solid #222222; margin:0; }
  </style>
</head>
<body>
  <div class="container">

    <!-- HEADER -->
    <div class="header">
      <div class="logo">JP LEGACY GROUP</div>
      <div class="subtitle">Reporte Diario de Leads &nbsp;—&nbsp; ${formattedDate}</div>
    </div>

    <!-- SUMMARY STATS -->
    <div class="card">
      <div class="card-title">Resumen del Día</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="25%" align="center" style="padding:8px 0;">
            <div class="stat-number">${totalLeads}</div>
            <div class="stat-label">Total Leads</div>
          </td>
          <td width="25%" align="center" style="padding:8px 0;border-left:1px solid #222;">
            <div class="stat-number-hot">${caliente.length}</div>
            <div class="stat-label" style="color:#FF6B35;">🔥 Calientes</div>
          </td>
          <td width="25%" align="center" style="padding:8px 0;border-left:1px solid #222;">
            <div class="stat-number-warm">${tibio.length}</div>
            <div class="stat-label" style="color:#FFD700;">🌡️ Tibios</div>
          </td>
          <td width="25%" align="center" style="padding:8px 0;border-left:1px solid #222;">
            <div class="stat-number-cold">${frio.length}</div>
            <div class="stat-label" style="color:#4FC3F7;">❄️ Fríos</div>
          </td>
        </tr>
      </table>
    </div>

    ${closedHTML}

    <!-- LEADS -->
    <div class="card">
      <div class="card-title">Detalle de Leads — Ordenado por Score</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;">
        <tr>
          <td width="50%" style="font-size:10px;color:#555555;letter-spacing:1px;padding-bottom:8px;">LEAD</td>
          <td width="20%" align="center" style="font-size:10px;color:#555555;letter-spacing:1px;padding-bottom:8px;">SCORE</td>
          <td width="30%" align="right" style="font-size:10px;color:#555555;letter-spacing:1px;padding-bottom:8px;">ANÁLISIS IA</td>
        </tr>
      </table>
      <hr class="divider">
      ${leadRows}
    </div>

    ${allSources.length > 0 ? `
    <!-- CHANNELS -->
    <div class="card">
      <div class="card-title">Por Canal</div>
      ${channelBars}
    </div>` : ''}

    ${warningHTML}

    <!-- FOOTER -->
    <div class="footer">
      JP Legacy Group &copy; 2026 &nbsp;—&nbsp; Sistema Automatizado de Leads<br>
      <span style="color:#333333;font-size:10px;">Último reporte: ${lastSentLabel}</span>
    </div>

  </div>
</body>
</html>`;
}

// ─── Reporte Diario ────────────────────────────────────────────────────────

async function buildReport(date) {
  // Fetch leads directly from FUB (source of truth) + closed deals today
  const [fubLeads, closedToday] = await Promise.all([
    fetchLeadsForDate(date),
    fetchClosedToday(date),
  ]);

  // Score breakdown from FUB leads
  const scoredLeads = fubLeads.filter((l) => l.score !== null);
  const caliente = scoredLeads.filter((l) => l.score >= 8);
  const tibio    = scoredLeads.filter((l) => l.score >= 5 && l.score <= 7);
  const frio     = scoredLeads.filter((l) => l.score <= 4);

  // Source breakdown derived from FUB leads
  const sources = {};
  fubLeads.forEach((l) => {
    const src = l.source || 'Sin fuente';
    sources[src] = (sources[src] || 0) + 1;
  });
  const allSources = sortedSources(sources);

  const lines = [
    `📊 JP Legacy — Reporte Diario ${date}`,
    ``,
    `Leads recibidos hoy: ${fubLeads.length}`,
  ];

  // Ventas cerradas hoy
  if (closedToday.length > 0) {
    lines.push(``);
    closedToday.forEach((l) => {
      lines.push(`🏆 ¡Venta cerrada hoy! ${l.name} — ${l.source} — ${l.assignedTo}`);
    });
  }

  // Scores section
  lines.push(``);
  lines.push(`SCORES DE HOY`);
  lines.push(`🔥 Lead-Caliente (8-10): ${caliente.length} leads`);
  lines.push(`🌡️ Lead-Tibio (5-7): ${tibio.length} leads`);
  lines.push(`❄️ Lead-Frío (1-4): ${frio.length} leads`);

  // Detalle de leads sorted by score desc, with phone
  lines.push(``);
  lines.push(`DETALLE DE LEADS DE HOY (ordenado por score)`);
  if (fubLeads.length > 0) {
    fubLeads.forEach((l) => {
      const emoji = l.score >= 8 ? '🔥' : l.score >= 5 ? '🌡️' : l.score !== null ? '❄️' : '•';
      const scoreLabel = l.score !== null ? `${l.score}/10` : '—/10';
      const reason = l.scoreReason ? ` — ${l.scoreReason}` : '';
      lines.push(`${emoji} ${scoreLabel}${reason} | ${l.name} — ${l.source} — ${l.phone}`);
    });
  } else {
    lines.push(`Sin leads registrados hoy.`);
  }

  // Por canal derived from FUB data
  lines.push(``);
  lines.push(`POR CANAL`);
  if (allSources.length > 0) {
    allSources.forEach((s) => {
      lines.push(`${s} → ${sources[s]} leads`);
    });
  } else {
    lines.push(`Sin datos de canal hoy.`);
  }

  lines.push(``);
  lines.push('Todos los leads fueron enviados al FUB para gestión comercial.');

  // ⚠️ Unclassified source warning
  const unclassifiedDaily = sources['Sin clasificar ⚠️'] || 0;
  if (unclassifiedDaily > 0) {
    lines.push(``);
    lines.push(`⚠️ Acción requerida: ${unclassifiedDaily} lead${unclassifiedDaily > 1 ? 's' : ''} sin fuente clasificada — revisar y actualizar el source en FUB`);
  }

  // System status footer
  const lastSuccess = getLastSuccessfulDailyEmail();
  const lastSentLabel = lastSuccess
    ? `${lastSuccess.date} ${lastSuccess.time}`
    : 'sin registros previos';
  lines.push(`✅ Sistema operativo — último reporte enviado: ${lastSentLabel}`);

  const text = lines.join('\n');
  const html = buildDailyReportHTML(date, fubLeads, closedToday, sources, caliente, tibio, frio, lastSentLabel);

  return { text, html };
}

async function printDailyReport() {
  const { text } = await buildReport(todayKeyET());
  console.log('\n' + text);
  return text;
}

function getAllReports() {
  const stats = getAllStats();
  return Object.entries(stats)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, s]) => ({ date, ...s }));
}

async function sendReportByEmail(date) {
  const { text, html } = await buildReport(date);
  const subject = `📊 JP Legacy — Reporte Diario ${date}`;
  await sendEmail(subject, text, 'daily', html);
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

  // ⚠️ Unclassified source warning
  const unclassifiedWeekly = sources['Sin clasificar ⚠️'] || 0;
  if (unclassifiedWeekly > 0) {
    lines.push(``);
    lines.push(`⚠️ Acción requerida: ${unclassifiedWeekly} lead${unclassifiedWeekly > 1 ? 's' : ''} sin fuente clasificada — revisar y actualizar el source en FUB`);
  }

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

  // ⚠️ Unclassified source warning
  const unclassifiedMonthly = data.bySource['Sin clasificar ⚠️'] || 0;
  if (unclassifiedMonthly > 0) {
    lines.push(``);
    lines.push(`⚠️ Acción requerida: ${unclassifiedMonthly} lead${unclassifiedMonthly > 1 ? 's' : ''} sin fuente clasificada — revisar y actualizar el source en FUB`);
  }

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
  // Every day at midnight ET (05:00 UTC) — generate and print report
  cron.schedule('0 5 * * *', () => {
    console.log(`[Cron] ⏰ Ejecutando: reporte diario consola — medianoche ET (05:00 UTC) — ${new Date().toISOString()}`);
    printDailyReport();
  });

  // Every day at 8am EDT (12:00 UTC) — send daily report for YESTERDAY
  cron.schedule('0 12 * * *', () => {
    const date = yesterdayKeyET();
    console.log(`[Cron] ⏰ Ejecutando: reporte diario email — 8am EDT (12:00 UTC) — fecha: ${date} — ${new Date().toISOString()}`);
    sendReportByEmail(date);
  });

  // Every Monday at 8am EDT (12:00 UTC) — send weekly report (covers previous Mon–Sun)
  cron.schedule('0 12 * * 1', () => {
    console.log(`[Cron] ⏰ Ejecutando: reporte semanal — lunes 8am EDT (12:00 UTC) — ${new Date().toISOString()}`);
    sendWeeklyReport();
  });

  // Every 1st of the month at 8am EDT (12:00 UTC) — send monthly report (covers previous month)
  cron.schedule('0 12 1 * *', () => {
    console.log(`[Cron] ⏰ Ejecutando: reporte mensual — día 1 del mes 8am EDT (12:00 UTC) — ${new Date().toISOString()}`);
    sendMonthlyReport();
  });

  // Every day at 8:05am EDT (12:05 UTC) — audit: verify daily report was sent, retry if not
  cron.schedule('5 12 * * *', async () => {
    const date = yesterdayKeyET();
    console.log(`[Cron] ⏰ Ejecutando: auditoría reporte diario — 8:05am EDT (12:05 UTC) — fecha: ${date} — ${new Date().toISOString()}`);
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

        const now = new Date();
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          const { error: alertErr } = await resend.emails.send({
            from: 'JP Legacy Agent <apps@jplegacygroup.com>',
            to: 'jorgeflorez@jplegacygroup.com',
            subject: alertSubject,
            text: alertBody,
          });
          if (alertErr) throw new Error(alertErr.message);
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
