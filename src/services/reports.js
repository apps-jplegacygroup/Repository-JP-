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
  const G = '#C9A84C';   // gold
  const BG = '#000000';  // black
  const BG2 = '#111111'; // card bg
  const BG3 = '#1A1A1A'; // row alt
  const W = '#FFFFFF';   // white
  const DIM = '#999999'; // dimmed

  const formattedDate = formatSpanishDate(date);
  const totalLeads = fubLeads.length;
  const allSources = sortedSources(sources);
  const maxSourceCount = allSources.length > 0 ? Math.max(...allSources.map((s) => sources[s])) : 1;

  // Lead rows
  const leadRows = fubLeads.length > 0
    ? fubLeads.map((l, i) => {
        const isHot  = l.score >= 8;
        const isWarm = l.score >= 5 && l.score < 8;
        const scoreColor = isHot ? '#FF4500' : isWarm ? '#FFD700' : '#4A90D9';
        const scoreBg    = isHot ? '#2A0A00' : isWarm ? '#2A2200' : '#001A2A';
        const emoji      = isHot ? '🔥' : isWarm ? '🌡️' : '❄️';
        const scoreLabel = l.score !== null ? `${l.score}/10` : '—';
        const rowBg      = i % 2 === 0 ? BG2 : BG3;
        const reason     = l.scoreReason || '—';
        return `
          <tr>
            <td style="padding:12px 16px;background:${rowBg};border-bottom:1px solid #222;">
              <span style="font-size:14px;font-weight:700;color:${W};">${l.name}</span>
              <br><span style="font-size:12px;color:${DIM};">${l.source} &nbsp;|&nbsp; ${l.phone}</span>
            </td>
            <td style="padding:12px 16px;background:${scoreBg};border-bottom:1px solid #222;text-align:center;white-space:nowrap;">
              <span style="font-size:16px;">${emoji}</span>
              <span style="font-size:15px;font-weight:700;color:${scoreColor};"> ${scoreLabel}</span>
            </td>
            <td style="padding:12px 16px;background:${rowBg};border-bottom:1px solid #222;">
              <span style="font-size:12px;color:${DIM};font-style:italic;">${reason}</span>
            </td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="3" style="padding:20px;text-align:center;color:${DIM};background:${BG2};">Sin leads registrados hoy.</td></tr>`;

  // Channel bars
  const channelBars = allSources.map((s) => {
    const count = sources[s];
    const pct = Math.round((count / maxSourceCount) * 100);
    return `
      <tr>
        <td style="padding:6px 0;width:40%;color:${W};font-size:13px;">${s}</td>
        <td style="padding:6px 8px;width:50%;">
          <div style="background:#222;border-radius:4px;height:10px;overflow:hidden;">
            <div style="background:${G};height:10px;width:${pct}%;border-radius:4px;"></div>
          </div>
        </td>
        <td style="padding:6px 0;width:10%;color:${G};font-size:13px;font-weight:700;text-align:right;">${count}</td>
      </tr>`;
  }).join('');

  // Closed deals
  const closedSection = closedToday.length > 0
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        ${closedToday.map((l) => `
          <tr>
            <td style="background:#1A1000;border:1px solid ${G};border-radius:6px;padding:14px 18px;margin-bottom:8px;">
              <span style="font-size:18px;">🏆</span>
              <span style="font-size:14px;font-weight:700;color:${G};"> ¡VENTA CERRADA HOY!</span>
              <br><span style="font-size:13px;color:${W};">${l.name} — ${l.source} — ${l.assignedTo}</span>
            </td>
          </tr>`).join('<tr><td style="height:8px;"></td></tr>')}
      </table>`
    : '';

  // Warning
  const unclassified = sources['Sin clasificar ⚠️'] || 0;
  const warningSection = unclassified > 0
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
        <tr>
          <td style="background:#1A1000;border:1px solid #FF8C00;border-radius:6px;padding:14px 18px;">
            <span style="color:#FF8C00;font-size:13px;">⚠️ Acción requerida: <strong>${unclassified} lead${unclassified > 1 ? 's' : ''} sin fuente clasificada</strong> — revisar y actualizar el source en FUB</span>
          </td>
        </tr>
      </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>JP Legacy — Reporte Diario</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="${BG}" style="background:${BG};">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- CARD WRAPPER -->
        <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td align="center" style="padding:36px 40px 24px;background:${BG};">
              <span style="font-size:28px;font-weight:700;letter-spacing:4px;color:${G};font-family:Arial,sans-serif;">JP LEGACY GROUP</span>
              <br><br>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="height:1px;background:${G};opacity:0.6;"></td>
                </tr>
              </table>
              <br>
              <span style="font-size:13px;letter-spacing:2px;color:${DIM};text-transform:uppercase;">Reporte Diario de Leads &nbsp;—&nbsp; ${formattedDate}</span>
            </td>
          </tr>

          <!-- SUMMARY BOXES -->
          <tr>
            <td style="padding:0 24px 24px;">
              <table width="100%" cellpadding="0" cellspacing="8">
                <tr>
                  <td width="25%" align="center" style="background:${BG2};border:1px solid #333;border-radius:8px;padding:18px 8px;">
                    <div style="font-size:28px;font-weight:700;color:${G};">${totalLeads}</div>
                    <div style="font-size:11px;color:${DIM};margin-top:4px;letter-spacing:1px;">TOTAL LEADS</div>
                  </td>
                  <td width="4%"></td>
                  <td width="21%" align="center" style="background:#2A0A00;border:1px solid #FF4500;border-radius:8px;padding:18px 8px;">
                    <div style="font-size:26px;font-weight:700;color:#FF4500;">${caliente.length}</div>
                    <div style="font-size:11px;color:#FF4500;margin-top:4px;">🔥 CALIENTES</div>
                  </td>
                  <td width="4%"></td>
                  <td width="21%" align="center" style="background:#2A2200;border:1px solid #FFD700;border-radius:8px;padding:18px 8px;">
                    <div style="font-size:26px;font-weight:700;color:#FFD700;">${tibio.length}</div>
                    <div style="font-size:11px;color:#FFD700;margin-top:4px;">🌡️ TIBIOS</div>
                  </td>
                  <td width="4%"></td>
                  <td width="21%" align="center" style="background:#001A2A;border:1px solid #4A90D9;border-radius:8px;padding:18px 8px;">
                    <div style="font-size:26px;font-weight:700;color:#4A90D9;">${frio.length}</div>
                    <div style="font-size:11px;color:#4A90D9;margin-top:4px;">❄️ FRÍOS</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${closedSection ? `<tr><td style="padding:0 24px 8px;">${closedSection}</td></tr>` : ''}

          <!-- LEADS TABLE -->
          <tr>
            <td style="padding:0 24px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #333;border-radius:8px;overflow:hidden;">
                <tr>
                  <td colspan="3" style="background:#111;padding:14px 16px;border-bottom:1px solid ${G};">
                    <span style="font-size:12px;font-weight:700;letter-spacing:2px;color:${G};text-transform:uppercase;">Detalle de Leads — Ordenado por Score</span>
                  </td>
                </tr>
                <tr style="background:#0A0A0A;">
                  <th style="padding:10px 16px;text-align:left;font-size:11px;color:${DIM};letter-spacing:1px;font-weight:600;border-bottom:1px solid #222;">LEAD</th>
                  <th style="padding:10px 16px;text-align:center;font-size:11px;color:${DIM};letter-spacing:1px;font-weight:600;border-bottom:1px solid #222;white-space:nowrap;">SCORE</th>
                  <th style="padding:10px 16px;text-align:left;font-size:11px;color:${DIM};letter-spacing:1px;font-weight:600;border-bottom:1px solid #222;">ANÁLISIS IA</th>
                </tr>
                ${leadRows}
              </table>
            </td>
          </tr>

          <!-- CHANNELS -->
          ${allSources.length > 0 ? `
          <tr>
            <td style="padding:0 24px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #333;border-radius:8px;overflow:hidden;">
                <tr>
                  <td colspan="3" style="background:#111;padding:14px 16px;border-bottom:1px solid ${G};">
                    <span style="font-size:12px;font-weight:700;letter-spacing:2px;color:${G};text-transform:uppercase;">Por Canal</span>
                  </td>
                </tr>
                <tr>
                  <td colspan="3" style="padding:16px 20px;background:${BG2};">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      ${channelBars}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>` : ''}

          ${warningSection ? `<tr><td style="padding:0 24px 24px;">${warningSection}</td></tr>` : ''}

          <!-- FOOTER -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #222;text-align:center;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="height:1px;background:${G};opacity:0.3;"></td>
                </tr>
              </table>
              <br>
              <span style="font-size:11px;color:${DIM};letter-spacing:1px;">JP Legacy Group © 2026 &nbsp;—&nbsp; Sistema Automatizado de Leads</span>
              <br>
              <span style="font-size:10px;color:#555;margin-top:6px;display:block;">Último reporte enviado: ${lastSentLabel}</span>
            </td>
          </tr>

        </table>
        <!-- END CARD -->

      </td>
    </tr>
  </table>
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
