const cron = require('node-cron');
const { Resend } = require('resend');
const { getAllStats, todayKey, todayKeyET, yesterdayKeyET, appendEmailLog, getEmailLogForDate, getLastSuccessfulDailyEmail } = require('../utils/storage');
const { collectMonthlyFUBData, fetchClosedToday, fetchLeadsForDate, fetchLeadsForRange, fetchDealsPipeline, fetchLeadsYearComparison, autoCorrectFUBSources, formatUSD, formatCloseDate, daysUntil } = require('./fubReport');

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

// ─── Leads Year-over-Year Comparison HTML ─────────────────────────────────

const MONTHS_ES_SHORT = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function buildLeadsComparisonHTML(comparison) {
  if (!comparison) return '';

  const { currentYear, previousYear, currentYearData, previousYearData } = comparison;
  const now          = new Date();
  const currentMonth = now.getMonth(); // 0-based — last completed month index

  // Only show months that have passed (up to and including current month)
  const months = MONTHS_ES_SHORT.map((label, idx) => {
    const mk     = String(idx + 1).padStart(2, '0');
    const curKey = `${currentYear}-${mk}`;
    const preKey = `${previousYear}-${mk}`;
    return {
      label,
      idx,
      cur:    currentYearData[curKey]  || 0,
      prev:   previousYearData[preKey] || 0,
      isPast: idx <= currentMonth,
    };
  }).filter((m) => m.isPast);

  const maxVal = Math.max(1, ...months.flatMap((m) => [m.cur, m.prev]));

  // YTD totals
  const ytdCur  = months.reduce((s, m) => s + m.cur,  0);
  const ytdPrev = months.reduce((s, m) => s + m.prev, 0);
  const ytdDiff = ytdCur - ytdPrev;
  const ytdPct  = ytdPrev > 0 ? ((ytdDiff / ytdPrev) * 100).toFixed(0) : '—';
  const ytdColor = ytdDiff >= 0 ? '#4CAF50' : '#FF5252';
  const ytdArrow = ytdDiff >= 0 ? '▲' : '▼';

  const rows = months.map((m) => {
    const curPct  = Math.max(3, Math.round((m.cur  / maxVal) * 100));
    const prevPct = Math.max(3, Math.round((m.prev / maxVal) * 100));
    const diff    = m.cur - m.prev;
    const diffPct = m.prev > 0 ? ((diff / m.prev) * 100).toFixed(0) : null;
    const diffColor = diff >= 0 ? '#4CAF50' : '#FF5252';
    const diffStr   = diffPct !== null
      ? `<span style="color:${diffColor};font-size:9px;font-family:Arial,sans-serif;font-weight:bold;">${diff >= 0 ? '+' : ''}${diffPct}%</span>`
      : '';

    return `<tr style="border-bottom:1px solid #1A1A1A;">
      <td style="padding:7px 0;width:22px;color:#888888;font-size:10px;font-family:Arial,sans-serif;white-space:nowrap;">${m.label}</td>
      <td style="padding:7px 8px;width:44%;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td title="${currentYear}" style="padding:0 0 2px;">
              <table cellpadding="0" cellspacing="0" width="${curPct}%">
                <tr><td style="background:#C9A84C;border-radius:2px;height:5px;font-size:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td title="${previousYear}" style="padding:0;">
              <table cellpadding="0" cellspacing="0" width="${prevPct}%">
                <tr><td style="background:#3A3A3A;border-radius:2px;height:5px;font-size:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
      <td style="padding:7px 4px;text-align:right;white-space:nowrap;">
        <span style="color:#C9A84C;font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">${m.cur}</span>
        <span style="color:#555555;font-size:10px;font-family:Arial,sans-serif;">vs ${m.prev}</span>
      </td>
      <td style="padding:7px 0 7px 6px;text-align:right;white-space:nowrap;width:36px;">${diffStr}</td>
    </tr>`;
  }).join('');

  return `
  <!-- LEADS YoY COMPARISON -->
  <tr><td style="height:16px;"></td></tr>
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;padding:16px 16px 12px;">

    <div style="color:#C9A84C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:4px;">
      📈 Evolución de Leads — ${currentYear} vs ${previousYear}
    </div>
    <div style="margin-bottom:14px;">
      <span style="display:inline-block;width:10px;height:5px;background:#C9A84C;border-radius:2px;vertical-align:middle;"></span>
      <span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;margin-left:4px;">${currentYear}</span>
      &nbsp;&nbsp;
      <span style="display:inline-block;width:10px;height:5px;background:#3A3A3A;border-radius:2px;vertical-align:middle;"></span>
      <span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;margin-left:4px;">${previousYear}</span>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid #222222;padding-top:10px;">
      <tr>
        <td>
          <span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;">Total YTD ${currentYear}: </span>
          <span style="color:#C9A84C;font-size:13px;font-weight:bold;font-family:Arial,sans-serif;">${ytdCur}</span>
          <span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;"> leads</span>
        </td>
        <td align="right">
          <span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;">vs ${previousYear}: ${ytdPrev} &nbsp;</span>
          <span style="color:${ytdColor};font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">${ytdArrow} ${Math.abs(ytdDiff)} (${ytdPct}%)</span>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

// ─── Deals Pipeline HTML ───────────────────────────────────────────────────

function buildPipelineHTML(pipeline) {
  if (!pipeline) return '';

  const STAGE_ICON = {
    'Under Contract': '📝',
    'Inspection':     '🔍',
    'Appraisal':      '📊',
    'Financing':      '🏦',
    'Clear to Close': '✅',
  };

  // ── Summary cards per active stage ──
  const summaryCards = pipeline.stageSummary
    .filter((s) => s.count > 0)
    .map((s) => {
      const icon = STAGE_ICON[s.stage] || '•';
      return `<td align="center" style="padding:8px 4px;">
        <div style="background:#1A1A1A;border:1px solid #2A2A2A;border-radius:6px;padding:10px 6px;min-width:82px;">
          <div style="font-size:15px;">${icon}</div>
          <div style="color:#C9A84C;font-size:18px;font-weight:bold;font-family:Arial,sans-serif;line-height:1.2;">${s.count}</div>
          <div style="color:#888888;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">${s.stage}</div>
          <div style="color:#555555;font-size:10px;font-family:Arial,sans-serif;margin-top:2px;">$${s.total.toLocaleString('en-US')}</div>
        </div>
      </td>`;
    }).join('');

  // ── Split: overdue vs current deals ──
  const overdueDeals = pipeline.activeDeals.filter((d) => {
    const days = daysUntil(d.deadlineDate);
    return days !== null && days < 0;
  });
  const currentDeals = pipeline.activeDeals.filter((d) => {
    const days = daysUntil(d.deadlineDate);
    return days === null || days >= 0;
  });

  function buildDealRow(d, forceRowBg) {
    const days     = daysUntil(d.deadlineDate);
    const isUrgent = days !== null && days <= 7;
    const isPast   = days !== null && days < 0;
    const priceStr = d.price > 0 ? `$${d.price.toLocaleString('en-US')}` : '—';
    const stageIcon = STAGE_ICON[d.stage] || '•';

    // Deadline badge
    let badge = '';
    if (isPast) {
      badge = `<span style="background:#3A0000;color:#FF4444;font-size:9px;font-weight:bold;padding:2px 6px;border-radius:3px;font-family:Arial,sans-serif;">VENCIDO</span>`;
    } else if (days === 0) {
      badge = `<span style="background:#3A1A00;color:#FF6B35;font-size:9px;font-weight:bold;padding:2px 6px;border-radius:3px;font-family:Arial,sans-serif;">HOY</span>`;
    } else if (isUrgent) {
      badge = `<span style="background:#2A1800;color:#FFD700;font-size:9px;font-weight:bold;padding:2px 6px;border-radius:3px;font-family:Arial,sans-serif;">${days}d</span>`;
    }

    const deadlineStr = d.deadlineDate
      ? `${d.deadlineLabel}: ${formatCloseDate(d.deadlineDate)}`
      : '—';
    const closeStr = d.projectedCloseDate
      ? `Cierre: ${formatCloseDate(d.projectedCloseDate)}`
      : '';
    const lenderStr = d.lender
      ? d.lender
      : (d.financingType || '');
    const titleStr  = d.titleCompany || '';

    const rowBg = forceRowBg || (isPast ? '#120000' : isUrgent ? '#0F0C00' : '#111111');
    return `<tr>
      <td style="padding:11px 16px;background:${rowBg};border-bottom:1px solid #1E1E1E;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;">
            <span style="color:#FFFFFF;font-size:13px;font-weight:bold;font-family:Arial,sans-serif;">${d.name}</span>
            &nbsp;<span style="color:#666666;font-size:10px;font-family:Arial,sans-serif;">${stageIcon} ${d.stage}</span><br>
            <span style="color:#FF6B35;font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">${deadlineStr}</span>
            ${badge ? `&nbsp;${badge}` : ''}<br>
            <span style="color:#666666;font-size:10px;font-family:Arial,sans-serif;">
              ${closeStr}${closeStr && lenderStr ? ' &nbsp;·&nbsp; ' : ''}${lenderStr}${titleStr ? ' &nbsp;·&nbsp; ' + titleStr : ''}
            </span>
          </td>
          <td align="right" style="vertical-align:top;white-space:nowrap;padding-left:8px;">
            <span style="color:#C9A84C;font-size:14px;font-weight:bold;font-family:Arial,sans-serif;">${priceStr}</span>
          </td>
        </tr></table>
      </td>
    </tr>`;
  }

  // ── Overdue alert section ──
  const overdueSection = overdueDeals.length > 0 ? `
    <tr><td style="padding:10px 16px 6px;background:#1A0000;border-bottom:1px solid #3A0000;">
      <span style="color:#FF4444;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">⚠️ Deals Vencidos — Requieren Atención Inmediata</span>
    </td></tr>
    ${overdueDeals.map((d) => buildDealRow(d, '#1A0000')).join('')}
  ` : '';

  const dealRows = currentDeals.map((d) => buildDealRow(d, null)).join('');

  // ── Monthly sales summary ──
  const m = pipeline.monthly;
  const monthlySummaryRows = m.closingsDeals.length > 0
    ? m.closingsDeals.map((cd) => {
        const comm = cd.agentCommission > 0 ? ` — Comisión: $${cd.agentCommission.toLocaleString('en-US')}` : '';
        return `<tr><td style="padding:4px 0;color:#AAAAAA;font-size:11px;font-family:Arial,sans-serif;">
          🏆 ${cd.name} — $${cd.price.toLocaleString('en-US')}${comm} (${cd.date})
        </td></tr>`;
      }).join('')
    : `<tr><td style="padding:4px 0;color:#555555;font-size:11px;font-family:Arial,sans-serif;font-style:italic;">Sin cierres este mes aún</td></tr>`;

  const commRow = m.closingsCommission > 0
    ? `<br><span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;">Comisiones este mes: $${m.closingsCommission.toLocaleString('en-US')}</span>`
    : '';

  // ── Year-to-date month bars ──
  const ytd = pipeline.yearToDate || [];
  const maxClosings = Math.max(1, ...ytd.map((r) => r.closings));
  const ytdRows = ytd.map((r) => {
    if (!r.isPast) return ''; // skip future months
    const barPct = Math.max(4, Math.round((r.closings / maxClosings) * 100));
    const volStr = r.closingsVolume > 0 ? `$${(r.closingsVolume / 1000).toFixed(0)}K` : '—';
    return `<tr>
      <td style="padding:5px 0;width:26px;color:#888888;font-size:10px;font-family:Arial,sans-serif;white-space:nowrap;">${r.label}</td>
      <td style="padding:5px 8px;width:70%;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="background:#1E1E1E;border-radius:3px;height:5px;padding:0;">
            <table cellpadding="0" cellspacing="0" width="${barPct}%"><tr>
              <td style="background:#C9A84C;border-radius:3px;height:5px;font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
          </td>
        </tr></table>
      </td>
      <td style="padding:5px 0;text-align:right;white-space:nowrap;">
        <span style="color:#C9A84C;font-size:10px;font-weight:bold;font-family:Arial,sans-serif;">${r.closings}</span>
        <span style="color:#444444;font-size:9px;font-family:Arial,sans-serif;margin-left:4px;">${volStr}</span>
      </td>
    </tr>`;
  }).join('');

  const ytdTotalClosings = ytd.filter((r) => r.isPast).reduce((s, r) => s + r.closings, 0);
  const ytdTotalVolume   = ytd.filter((r) => r.isPast).reduce((s, r) => s + r.closingsVolume, 0);
  const activeSection    = pipeline.activeCount > 0 ? `
      <tr><td colspan="3" style="padding:16px 16px 12px;border-bottom:1px solid #2A2A2A;">
        <table cellpadding="0" cellspacing="4"><tr>${summaryCards}</tr></table>
      </td></tr>
      ${overdueSection}
      ${dealRows}` : `<tr><td colspan="3" style="padding:16px;text-align:center;color:#555555;font-size:11px;font-family:Arial,sans-serif;font-style:italic;">Sin deals activos en este momento.</td></tr>`;

  return `
  <!-- PIPELINE DEALS -->
  <tr><td style="height:16px;"></td></tr>
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;overflow:hidden;">
    <table width="100%" cellpadding="0" cellspacing="0">

      <!-- Pipeline header -->
      <tr><td style="padding:16px 16px 10px;border-bottom:1px solid #C9A84C;">
        <span style="color:#C9A84C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;">🏠 Pipeline de Deals</span>
        <span style="color:#555555;font-size:11px;font-family:Arial,sans-serif;float:right;">${pipeline.activeCount} activos — $${pipeline.activeTotal.toLocaleString('en-US')}</span>
      </td></tr>

      <!-- Active stage cards + deal rows -->
      ${activeSection}

      <!-- Monthly sales summary -->
      <tr><td style="padding:14px 16px 6px;border-top:1px solid #2A2A2A;">
        <div style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:8px;">
          📅 Ventas este mes
        </div>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="33%" align="center" style="padding:6px 4px;">
              <div style="color:#FFFFFF;font-size:26px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${m.closings}</div>
              <div style="color:#888888;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">Cierres</div>
              ${m.closingsVolume > 0 ? `<div style="color:#C9A84C;font-size:10px;font-family:Arial,sans-serif;">$${m.closingsVolume.toLocaleString('en-US')}</div>` : ''}
              ${commRow}
            </td>
            <td width="33%" align="center" style="padding:6px 4px;border-left:1px solid #222222;">
              <div style="color:#FFFFFF;font-size:26px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${m.newContracts}</div>
              <div style="color:#888888;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">Contratos nuevos</div>
              ${m.newContractsVolume > 0 ? `<div style="color:#C9A84C;font-size:10px;font-family:Arial,sans-serif;">$${m.newContractsVolume.toLocaleString('en-US')}</div>` : ''}
            </td>
            <td width="33%" align="center" style="padding:6px 4px;border-left:1px solid #222222;">
              <div style="color:#FFFFFF;font-size:26px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${pipeline.activeCount}</div>
              <div style="color:#888888;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">En pipeline</div>
              <div style="color:#C9A84C;font-size:10px;font-family:Arial,sans-serif;">$${pipeline.activeTotal.toLocaleString('en-US')}</div>
            </td>
          </tr>
        </table>
        ${m.closingsDeals.length > 0 ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${monthlySummaryRows}</table>` : ''}
      </td></tr>

      <!-- Year-to-date closings bar chart -->
      <tr><td style="padding:14px 16px;border-top:1px solid #1E1E1E;">
        <div style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:10px;">
          📈 Cierres ${new Date().getFullYear()} — Ene a ${['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][new Date().getMonth() + 1]}
        </div>
        <table width="100%" cellpadding="0" cellspacing="0">${ytdRows}</table>
        <div style="margin-top:8px;color:#555555;font-size:10px;font-family:Arial,sans-serif;">
          Total YTD: <span style="color:#C9A84C;font-weight:bold;">${ytdTotalClosings} cierres</span> — $${ytdTotalVolume.toLocaleString('en-US')}
          &nbsp;·&nbsp; Cerrados histórico: <span style="color:#888888;">${pipeline.closedCount} deals</span>
        </div>
      </td></tr>

    </table>
  </td></tr>`;
}

// ─── Proximos Contratos HTML ───────────────────────────────────────────────

function buildProximosContratosHTML(proximosDeals) {
  if (!proximosDeals || proximosDeals.length === 0) return '';

  const totalVolume = proximosDeals.reduce((s, d) => s + d.price, 0);

  const dealCards = proximosDeals.map((d, i) => {
    const priceStr  = d.price > 0 ? `$${d.price.toLocaleString('en-US')}` : 'Precio por confirmar';
    const closeStr  = d.projectedCloseDate ? `Cierre estimado: ${formatCloseDate(d.projectedCloseDate)}` : '';
    const lenderStr = [d.lender, d.loanOfficer, d.financingType].filter(Boolean).join(' · ');
    const rowBg     = i % 2 === 0 ? '#111111' : '#141414';

    // Trim description to ~300 chars and add ellipsis
    const desc = d.description
      ? (d.description.length > 300 ? d.description.slice(0, 297) + '…' : d.description)
      : 'Sin descripción registrada.';

    return `<tr>
      <td style="padding:14px 16px;background:${rowBg};border-bottom:1px solid #1E1E1E;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;">
            <span style="color:#FFFFFF;font-size:14px;font-weight:bold;font-family:Arial,sans-serif;">${d.name}</span><br>
            ${closeStr ? `<span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;">${closeStr}</span>` : ''}
            ${lenderStr ? `<span style="color:#666666;font-size:10px;font-family:Arial,sans-serif;"> · ${lenderStr}</span>` : ''}
          </td>
          <td align="right" style="vertical-align:top;white-space:nowrap;padding-left:8px;">
            <span style="color:#C9A84C;font-size:14px;font-weight:bold;font-family:Arial,sans-serif;">${priceStr}</span>
          </td>
        </tr>
        <tr><td colspan="2" style="padding-top:8px;">
          <div style="background:#1A1A1A;border-left:3px solid #C9A84C;border-radius:0 4px 4px 0;padding:10px 12px;">
            <span style="color:#AAAAAA;font-size:11px;font-family:Arial,sans-serif;line-height:1.5;">${desc}</span>
          </div>
        </td></tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  return `
  <!-- PROXIMOS CONTRATOS -->
  <tr><td style="height:16px;"></td></tr>
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;overflow:hidden;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:16px 16px 10px;border-bottom:1px solid #C9A84C;">
        <span style="color:#C9A84C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;">🤝 Pipeline Próximos Contratos</span>
        <span style="color:#555555;font-size:11px;font-family:Arial,sans-serif;float:right;">${proximosDeals.length} prospecto${proximosDeals.length > 1 ? 's' : ''} — $${totalVolume.toLocaleString('en-US')}</span>
      </td></tr>
      ${dealCards}
      <tr><td style="padding:10px 16px;background:#0A0A0A;border-top:1px solid #1E1E1E;text-align:center;">
        <span style="color:#555555;font-size:10px;font-family:Arial,sans-serif;">Volumen potencial total: <strong style="color:#C9A84C;">$${totalVolume.toLocaleString('en-US')}</strong></span>
      </td></tr>
    </table>
  </td></tr>`;
}

// ─── HTML Email Builder — 100% inline styles (Gmail/Outlook compatible) ─────

function buildDailyReportHTML(date, fubLeads, closedToday, sources, caliente, tibio, frio, lastSentLabel, pipeline, leadsComparison, reportLabel = 'Reporte Diario de Leads', periodLabel = null) {
  const formattedDate = periodLabel || formatSpanishDate(date);
  const totalLeads = fubLeads.length;
  const allSources = sortedSources(sources);
  const maxSourceCount = allSources.length > 0 ? Math.max(...allSources.map((s) => sources[s])) : 1;

  // ── Lead rows (fully inline — no CSS classes) ──
  const leadRows = fubLeads.length > 0
    ? fubLeads.map((l, i) => {
        const isHot  = l.score >= 8;
        const isWarm = l.score >= 5 && l.score < 8;
        const scoreColor = isHot ? '#FF6B35' : isWarm ? '#FFD700' : '#4FC3F7';
        const emoji      = isHot ? '🔥' : isWarm ? '🌡️' : '❄️';
        const scoreLabel = l.score !== null ? `${emoji} ${l.score}/10` : '—';
        const reason     = l.scoreReason || '';
        const rowBg      = i % 2 === 0 ? '#111111' : '#161616';
        const videoStr = l.videoName && l.videoLink
          ? `<a href="${l.videoLink}" style="color:#C9A84C;font-size:11px;font-family:Arial,sans-serif;text-decoration:none;">▶ ${l.videoName}</a>`
          : l.videoLink
            ? `<a href="${l.videoLink}" style="color:#C9A84C;font-size:11px;font-family:Arial,sans-serif;text-decoration:none;">▶ Ver video</a>`
            : '';
        return `<tr>
          <td style="padding:12px 16px;background:${rowBg};border-bottom:1px solid #222222;">
            <span style="color:#FFFFFF;font-weight:bold;font-size:14px;font-family:Arial,sans-serif;">${l.name}</span><br>
            <span style="color:#888888;font-size:12px;font-family:Arial,sans-serif;">${l.source}&nbsp;&nbsp;|&nbsp;&nbsp;${l.phone}</span>
            ${videoStr ? `<br>${videoStr}` : ''}
          </td>
          <td style="padding:12px 16px;background:${rowBg};border-bottom:1px solid #222222;text-align:center;white-space:nowrap;">
            <span style="color:${scoreColor};font-weight:bold;font-size:15px;font-family:Arial,sans-serif;">${scoreLabel}</span>
          </td>
          <td style="padding:12px 16px;background:${rowBg};border-bottom:1px solid #222222;">
            <span style="color:#888888;font-size:11px;font-style:italic;font-family:Arial,sans-serif;">${reason}</span>
          </td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" style="padding:20px;text-align:center;color:#888888;background:#111111;font-family:Arial,sans-serif;">Sin leads registrados.</td></tr>`;

  // ── Channel bars ──
  const channelBars = allSources.map((s) => {
    const count = sources[s];
    const pct = Math.max(4, Math.round((count / maxSourceCount) * 100));
    return `<tr>
      <td style="padding:7px 0;width:38%;color:#FFFFFF;font-size:12px;font-family:Arial,sans-serif;">${s}</td>
      <td style="padding:7px 8px;width:50%;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="background:#222222;border-radius:4px;height:6px;padding:0;">
            <table cellpadding="0" cellspacing="0" width="${pct}%"><tr>
              <td style="background:#C9A84C;border-radius:4px;height:6px;font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
          </td>
        </tr></table>
      </td>
      <td style="padding:7px 0;width:12%;color:#C9A84C;font-size:12px;font-weight:bold;text-align:right;font-family:Arial,sans-serif;">${count}</td>
    </tr>`;
  }).join('');

  // ── Closed deals ──
  const closedRows = closedToday.length > 0
    ? closedToday.map((l) => `
      <tr><td style="padding:0 0 10px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="background:#1A1200;border:1px solid #C9A84C;border-radius:8px;padding:14px 18px;">
            <span style="font-size:18px;">🏆</span>
            <span style="color:#C9A84C;font-weight:bold;font-size:14px;letter-spacing:1px;font-family:Arial,sans-serif;"> ¡VENTA CERRADA!</span><br>
            <span style="color:#FFFFFF;font-size:13px;font-family:Arial,sans-serif;">${l.name}&nbsp;·&nbsp;${l.source}&nbsp;·&nbsp;${l.assignedTo}</span>
          </td></tr>
        </table>
      </td></tr>`).join('')
    : '';

  // ── Unclassified warning ──
  const unclassified = sources['Sin clasificar ⚠️'] || 0;
  const warningRow = unclassified > 0
    ? `<tr><td style="padding-top:12px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="background:#1A0F00;border:1px solid #FF8C00;border-radius:8px;padding:14px 18px;">
            <span style="color:#FF8C00;font-size:13px;font-family:Arial,sans-serif;">⚠️ <strong>${unclassified} lead${unclassified > 1 ? 's' : ''} sin fuente clasificada</strong> — revisar source en FUB</span>
          </td></tr>
        </table>
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>JP Legacy — Reporte Diario</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#000000" style="background-color:#000000;">
<tr><td align="center" style="padding:24px 12px;">

<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- HEADER -->
  <tr><td style="padding:28px 0 20px;text-align:center;border-bottom:2px solid #C9A84C;">
    <div style="color:#C9A84C;font-size:28px;font-weight:bold;letter-spacing:4px;font-family:Arial,sans-serif;">JP LEGACY GROUP</div>
    <div style="color:#888888;font-size:11px;letter-spacing:2px;margin-top:8px;text-transform:uppercase;font-family:Arial,sans-serif;">${reportLabel} &nbsp;—&nbsp; ${formattedDate}</div>
  </td></tr>

  <tr><td style="height:20px;"></td></tr>

  <!-- SUMMARY STATS -->
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;padding:20px;">
    <div style="color:#C9A84C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:16px;">${reportLabel.includes('Semanal') ? 'Resumen de la Semana' : reportLabel.includes('Mensual') ? 'Resumen del Mes' : 'Resumen del Día'}</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="25%" align="center" style="padding:8px 4px;">
          <div style="color:#FFFFFF;font-size:36px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${totalLeads}</div>
          <div style="color:#888888;font-size:10px;letter-spacing:1px;margin-top:4px;text-transform:uppercase;font-family:Arial,sans-serif;">Total</div>
        </td>
        <td width="25%" align="center" style="padding:8px 4px;border-left:1px solid #222222;">
          <div style="color:#FF6B35;font-size:32px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${caliente.length}</div>
          <div style="color:#FF6B35;font-size:10px;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">🔥 Calientes</div>
        </td>
        <td width="25%" align="center" style="padding:8px 4px;border-left:1px solid #222222;">
          <div style="color:#FFD700;font-size:32px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${tibio.length}</div>
          <div style="color:#FFD700;font-size:10px;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">🌡️ Tibios</div>
        </td>
        <td width="25%" align="center" style="padding:8px 4px;border-left:1px solid #222222;">
          <div style="color:#4FC3F7;font-size:32px;font-weight:bold;line-height:1;font-family:Arial,sans-serif;">${frio.length}</div>
          <div style="color:#4FC3F7;font-size:10px;letter-spacing:1px;margin-top:4px;font-family:Arial,sans-serif;">❄️ Fríos</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="height:12px;"></td></tr>

  ${closedToday.length > 0 ? `
  <!-- CLOSED DEALS -->
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0">${closedRows}</table>
  </td></tr>
  <tr><td style="height:12px;"></td></tr>` : ''}

  <!-- LEADS TABLE -->
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;overflow:hidden;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td colspan="3" style="padding:16px 16px 12px;border-bottom:1px solid #C9A84C;">
        <span style="color:#C9A84C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;">Detalle de Leads — Ordenado por Score</span>
      </td></tr>
      <tr style="background:#0D0D0D;">
        <td style="padding:8px 16px;font-size:10px;color:#555555;letter-spacing:1px;font-family:Arial,sans-serif;border-bottom:1px solid #222222;">LEAD</td>
        <td style="padding:8px 16px;font-size:10px;color:#555555;letter-spacing:1px;text-align:center;font-family:Arial,sans-serif;border-bottom:1px solid #222222;white-space:nowrap;">SCORE</td>
        <td style="padding:8px 16px;font-size:10px;color:#555555;letter-spacing:1px;font-family:Arial,sans-serif;border-bottom:1px solid #222222;">ANÁLISIS IA</td>
      </tr>
      ${leadRows}
    </table>
  </td></tr>

  <tr><td style="height:12px;"></td></tr>

  ${allSources.length > 0 ? `
  <!-- CHANNELS -->
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;padding:20px;">
    <div style="color:#C9A84C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:14px;">Por Canal</div>
    <table width="100%" cellpadding="0" cellspacing="0">${channelBars}</table>
  </td></tr>
  <tr><td style="height:12px;"></td></tr>` : ''}

  ${buildLeadsComparisonHTML(leadsComparison)}

  ${buildPipelineHTML(pipeline)}

  ${buildProximosContratosHTML(pipeline?.proximosDeals)}

  <!-- WARNINGS & FOOTER -->
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${warningRow}
      <tr><td style="padding-top:20px;text-align:center;border-top:1px solid #222222;">
        <span style="color:#444444;font-size:11px;font-family:Arial,sans-serif;">JP Legacy Group &copy; 2026 &nbsp;—&nbsp; Sistema Automatizado de Leads</span><br>
        <span style="color:#333333;font-size:10px;font-family:Arial,sans-serif;">Último reporte: ${lastSentLabel}</span>
      </td></tr>
    </table>
  </td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;
}

// ─── Reporte Diario ────────────────────────────────────────────────────────

async function buildReport(date) {
  // Fetch leads, closed deals, pipeline, and YoY comparison in parallel
  const [fubLeads, closedToday, pipeline, leadsComparison] = await Promise.all([
    fetchLeadsForDate(date),
    fetchClosedToday(date),
    fetchDealsPipeline(),
    fetchLeadsYearComparison().catch(() => null),
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
      if (l.videoName || l.videoLink) {
        const vidLabel = l.videoName ? `▶ ${l.videoName}` : '▶ Ver video';
        lines.push(`    ${vidLabel}${l.videoLink ? `: ${l.videoLink}` : ''}`);
      }
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

  // Pipeline de Deals
  if (pipeline) {
    const m = pipeline.monthly;
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🏠 PIPELINE DE DEALS`);
    lines.push(``);
    lines.push(`ACTIVOS: ${pipeline.activeCount} deals — $${pipeline.activeTotal.toLocaleString('en-US')}`);
    pipeline.stageSummary.filter((s) => s.count > 0).forEach((s) => {
      lines.push(`  ${s.stage}: ${s.count} deal${s.count > 1 ? 's' : ''} — $${s.total.toLocaleString('en-US')}`);
    });

    if (pipeline.activeDeals.length > 0) {
      lines.push(``);
      lines.push(`DETALLE (ordenado por próximo vencimiento)`);
      pipeline.activeDeals.forEach((d) => {
        const days    = daysUntil(d.deadlineDate);
        const urgency = days === null ? '' : days < 0 ? ' ⚠️ VENCIDO' : days === 0 ? ' ⚠️ HOY' : days <= 7 ? ` ⚠️ ${days}d` : '';
        const dlStr   = d.deadlineDate ? `${d.deadlineLabel}: ${formatCloseDate(d.deadlineDate)}` : 'Sin vencimiento';
        const closeStr= d.projectedCloseDate ? ` — Cierre: ${formatCloseDate(d.projectedCloseDate)}` : '';
        const price   = d.price > 0 ? `$${d.price.toLocaleString('en-US')}` : '—';
        const lender  = d.lender ? ` — ${d.lender}` : '';
        lines.push(`  • [${d.stage}] ${d.name} — ${price} — ${dlStr}${urgency}${closeStr}${lender}`);
      });
    }

    lines.push(``);
    lines.push(`VENTAS ESTE MES`);
    lines.push(`  Cierres:          ${m.closings}${m.closingsVolume > 0 ? ' — $' + m.closingsVolume.toLocaleString('en-US') : ''}`);
    lines.push(`  Contratos nuevos: ${m.newContracts}${m.newContractsVolume > 0 ? ' — $' + m.newContractsVolume.toLocaleString('en-US') : ''}`);
    if (m.closingsCommission > 0) {
      lines.push(`  Comisiones:       $${m.closingsCommission.toLocaleString('en-US')}`);
    }
    if (m.closingsDeals.length > 0) {
      m.closingsDeals.forEach((cd) => {
        lines.push(`    🏆 ${cd.name} — $${cd.price.toLocaleString('en-US')} (${cd.date})`);
      });
    }

    // YTD summary (past months only, compact)
    if (pipeline.yearToDate) {
      const ytdPast = pipeline.yearToDate.filter((r) => r.isPast && (r.closings > 0 || r.newContracts > 0));
      if (ytdPast.length > 0) {
        lines.push(``);
        lines.push(`CIERRES ${new Date().getFullYear()} (YTD)`);
        ytdPast.forEach((r) => {
          const vol = r.closingsVolume > 0 ? ` — $${r.closingsVolume.toLocaleString('en-US')}` : '';
          lines.push(`  ${r.label}: ${r.closings} cierres${vol}  |  ${r.newContracts} contratos nuevos`);
        });
        const ytdTotal = ytdPast.reduce((s, r) => s + r.closings, 0);
        const ytdVol   = ytdPast.reduce((s, r) => s + r.closingsVolume, 0);
        lines.push(`  TOTAL YTD: ${ytdTotal} cierres — $${ytdVol.toLocaleString('en-US')}`);
      }
    }

    lines.push(``);
    lines.push(`🏆 Cerrados histórico: ${pipeline.closedCount} deals — $${pipeline.closedTotal.toLocaleString('en-US')}`);
  }

  // Leads YoY comparison (text version)
  if (leadsComparison) {
    const { currentYear, previousYear, currentYearData, previousYearData } = leadsComparison;
    const currentMonth = new Date().getMonth();
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📈 EVOLUCIÓN DE LEADS — ${currentYear} vs ${previousYear}`);
    lines.push(``);
    let ytdCur = 0, ytdPrev = 0;
    MONTHS_ES_SHORT.forEach((label, idx) => {
      if (idx > currentMonth) return;
      const mk   = String(idx + 1).padStart(2, '0');
      const cur  = currentYearData[`${currentYear}-${mk}`]  || 0;
      const prev = previousYearData[`${previousYear}-${mk}`] || 0;
      ytdCur  += cur;
      ytdPrev += prev;
      const diff    = cur - prev;
      const diffPct = prev > 0 ? ` (${diff >= 0 ? '+' : ''}${((diff / prev) * 100).toFixed(0)}%)` : '';
      lines.push(`  ${label}: ${String(cur).padStart(4)} leads  vs  ${String(prev).padStart(4)} el año pasado${diffPct}`);
    });
    const totalDiff = ytdCur - ytdPrev;
    const totalPct  = ytdPrev > 0 ? ` (${totalDiff >= 0 ? '+' : ''}${((totalDiff / ytdPrev) * 100).toFixed(0)}%)` : '';
    lines.push(``);
    lines.push(`  TOTAL YTD: ${ytdCur} leads en ${currentYear}  vs  ${ytdPrev} en ${previousYear}${totalPct}`);
  }

  // Proximos Contratos (text version)
  if (pipeline?.proximosDeals?.length > 0) {
    const pd = pipeline.proximosDeals;
    const totalVol = pd.reduce((s, d) => s + d.price, 0);
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🤝 PIPELINE PRÓXIMOS CONTRATOS — ${pd.length} prospecto${pd.length > 1 ? 's' : ''}`);
    lines.push(`   Volumen potencial: $${totalVol.toLocaleString('en-US')}`);
    lines.push(``);
    pd.forEach((d) => {
      const priceStr = d.price > 0 ? `$${d.price.toLocaleString('en-US')}` : 'Precio por confirmar';
      const closeStr = d.projectedCloseDate ? ` — Cierre est: ${formatCloseDate(d.projectedCloseDate)}` : '';
      lines.push(`  • ${d.name}  ${priceStr}${closeStr}`);
      if (d.description) {
        const desc = d.description.length > 200 ? d.description.slice(0, 197) + '…' : d.description;
        lines.push(`    ${desc}`);
      }
    });
  }

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

  // Debug: log first 3 leads to confirm data before HTML generation
  console.log(`[Report] buildReport(${date}): fubLeads=${fubLeads.length}`);
  fubLeads.slice(0, 3).forEach((l, i) => {
    console.log(`[Report]   lead[${i}]: name="${l.name}" source="${l.source}" score=${l.score} reason="${l.scoreReason}"`);
  });

  const text = lines.join('\n');
  const html = buildDailyReportHTML(date, fubLeads, closedToday, sources, caliente, tibio, frio, lastSentLabel, pipeline, leadsComparison);

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

async function buildWeeklyReport(weekStart, weekEnd) {
  const startLabel = formatSpanishDate(weekStart);
  const endLabel   = formatSpanishDate(weekEnd);
  const periodLabel = `${startLabel} al ${endLabel}`;

  const [fubLeads, pipeline, leadsComparison] = await Promise.all([
    fetchLeadsForRange(weekStart, weekEnd, { maxScored: 70 }),
    fetchDealsPipeline(),
    fetchLeadsYearComparison().catch(() => null),
  ]);

  const scoredLeads = fubLeads.filter((l) => l.score !== null);
  const caliente = scoredLeads.filter((l) => l.score >= 8);
  const tibio    = scoredLeads.filter((l) => l.score >= 5 && l.score <= 7);
  const frio     = scoredLeads.filter((l) => l.score <= 4);

  const sources = {};
  fubLeads.forEach((l) => { sources[l.source] = (sources[l.source] || 0) + 1; });

  const lastSentLabel = `Semana ${weekStart} – ${weekEnd}`;

  // ── Text version ──
  const lines = [
    `📊 JP Legacy — Reporte Semanal ${periodLabel}`,
    ``,
    `────────────────────────────────────`,
    `RESUMEN DE LA SEMANA`,
    `────────────────────────────────────`,
    `Total leads: ${fubLeads.length}`,
    `🔥 Lead-Caliente (8-10): ${caliente.length} leads`,
    `🌡️ Lead-Tibio (5-7): ${tibio.length} leads`,
    `❄️ Lead-Frío (1-4): ${frio.length} leads`,
    ``,
    `DESGLOSE POR CANAL`,
  ];

  sortedSources(sources).forEach((s) => {
    lines.push(`  ${sources[s]} — ${s}`);
  });

  lines.push(``);
  lines.push(`DETALLE DE LEADS (ordenado por score)`);
  fubLeads.forEach((l) => {
    const emoji = l.score >= 8 ? '🔥' : l.score >= 5 ? '🌡️' : l.score !== null ? '❄️' : '•';
    const scoreLabel = l.score !== null ? `${l.score}/10` : '—/10';
    const reason = l.scoreReason ? ` — ${l.scoreReason}` : '';
    lines.push(`${emoji} ${scoreLabel}${reason} | ${l.name} — ${l.source} — ${l.phone}`);
    if (l.videoName || l.videoLink) {
      const vidLabel = l.videoName ? `▶ ${l.videoName}` : '▶ Ver video';
      lines.push(`    ${vidLabel}${l.videoLink ? `: ${l.videoLink}` : ''}`);
    }
  });

  if (pipeline?.activeDeals?.length > 0) {
    const overdueText  = pipeline.activeDeals.filter((d) => { const days = daysUntil(d.deadlineDate); return days !== null && days < 0; });
    const currentText  = pipeline.activeDeals.filter((d) => { const days = daysUntil(d.deadlineDate); return days === null || days >= 0; });

    if (overdueText.length > 0) {
      lines.push(``);
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`⚠️ DEALS VENCIDOS — REQUIEREN ATENCIÓN INMEDIATA`);
      overdueText.forEach((d) => {
        const days = daysUntil(d.deadlineDate);
        lines.push(`  ⛔ [${d.stage}] ${d.name} — ${formatUSD(d.price)} — VENCIDO hace ${Math.abs(days)}d`);
      });
    }

    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📋 PIPELINE ACTIVO — ${currentText.length} deals`);
    currentText.forEach((d) => {
      const days    = daysUntil(d.deadlineDate);
      const urgency = days === null ? '' : days === 0 ? ' ⚠️ HOY' : days <= 7 ? ` ⚠️ ${days}d` : '';
      lines.push(`  • [${d.stage}] ${d.name} — ${formatUSD(d.price)}${urgency}`);
    });
  }

  if (pipeline?.proximosDeals?.length > 0) {
    const pd = pipeline.proximosDeals;
    const totalVol = pd.reduce((s, d) => s + d.price, 0);
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🤝 PIPELINE PRÓXIMOS CONTRATOS — ${pd.length} prospectos`);
    lines.push(`   Volumen potencial: $${totalVol.toLocaleString('en-US')}`);
    pd.forEach((d) => {
      const priceStr = d.price > 0 ? `$${d.price.toLocaleString('en-US')}` : 'Precio por confirmar';
      lines.push(`  • ${d.name}  ${priceStr}`);
      if (d.description) {
        const desc = d.description.length > 150 ? d.description.slice(0, 147) + '…' : d.description;
        lines.push(`    ${desc}`);
      }
    });
  }

  const text = lines.join('\n');
  const html = buildDailyReportHTML(
    weekStart,
    fubLeads,
    [],
    sources,
    caliente,
    tibio,
    frio,
    lastSentLabel,
    pipeline,
    leadsComparison,
    'Reporte Semanal de Leads',
    periodLabel
  );

  return { text, html };
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
  try {
    const report = await buildWeeklyReport(weekStart, weekEnd);
    const subject = `📊 JP Legacy — Reporte Semanal ${weekStart}`;
    await sendEmail(subject, report.text, 'weekly', report.html);
  } catch (err) {
    console.error('[Reports] Error generating weekly report:', err.message);
  }
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

  const text = lines.join('\n');

  // Build HTML with same structure as daily/weekly
  const [fubLeads, pipeline] = await Promise.all([
    fetchLeadsForRange(
      dateKey(new Date(year, month - 1, 1)),
      dateKey(new Date(year, month, 0)),
      { maxScored: 50 }
    ),
    fetchDealsPipeline(),
  ]);

  const scoredLeads = fubLeads.filter((l) => l.score !== null);
  const caliente = scoredLeads.filter((l) => l.score >= 8);
  const tibio    = scoredLeads.filter((l) => l.score >= 5 && l.score <= 7);
  const frio     = scoredLeads.filter((l) => l.score <= 4);

  const monthlySources = {};
  fubLeads.forEach((l) => { monthlySources[l.source] = (monthlySources[l.source] || 0) + 1; });

  const leadsComparison = await fetchLeadsYearComparison().catch(() => null);
  const periodLabel = `${monthName} ${year}`;
  const lastSentLabel = periodLabel;

  const html = buildDailyReportHTML(
    dateKey(new Date(year, month - 1, 1)),
    fubLeads,
    [],
    monthlySources,
    caliente,
    tibio,
    frio,
    lastSentLabel,
    pipeline,
    leadsComparison,
    'Reporte Mensual de Leads',
    periodLabel
  );

  return { text, html };
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
    await sendEmail(subject, report.text, 'monthly', report.html);
  } catch (err) {
    console.error('[Reports] Error generating monthly report:', err.message);
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

function startDailyReport() {
  // Every day at midnight ET (05:00 UTC) — generate and print report to console
  cron.schedule('0 5 * * *', () => {
    console.log(`[Cron medianoche] Generando reporte del día en consola... ${new Date().toISOString()}`);
    printDailyReport();
  });

  // Every weekday at 9am EDT (13:00 UTC) — send daily report for YESTERDAY
  cron.schedule('0 13 * * 1-5', () => {
    const date = yesterdayKeyET();
    console.log(`[Cron 9am] Iniciando reporte diario de ayer... fecha=${date} utc=${new Date().toISOString()}`);
    sendReportByEmail(date).catch((err) =>
      console.error(`[Cron 9am] Error enviando reporte diario (${date}):`, err.message)
    );
  });

  // Every Monday at 9am EDT (13:00 UTC) — send weekly report (covers previous Mon–Sun)
  cron.schedule('0 13 * * 1', () => {
    console.log(`[Cron semanal] Iniciando reporte semanal... utc=${new Date().toISOString()}`);
    sendWeeklyReport().catch((err) =>
      console.error('[Cron semanal] Error:', err.message)
    );
  });

  // Every 1st of the month at 9am EDT (13:00 UTC) — send monthly report (covers previous month)
  cron.schedule('0 13 1 * *', () => {
    console.log(`[Cron mensual] Iniciando reporte mensual... utc=${new Date().toISOString()}`);
    sendMonthlyReport().catch((err) =>
      console.error('[Cron mensual] Error:', err.message)
    );
  });

  // Every weekday at 8:55am EDT (12:55 UTC) — auto-correct dirty sources from Zapier before the report
  cron.schedule('55 12 * * 1-5', async () => {
    const date = yesterdayKeyET();
    console.log(`[SourceFix] Iniciando autocorrección de sources para ${date}...`);
    try {
      const summary = await autoCorrectFUBSources(date);
      if (summary.corrected > 0) {
        console.log(`[SourceFix] ${summary.corrected} sources corregidos en FUB:`);
        summary.corrections.forEach((c) =>
          console.log(`  • ${c.name}: "${c.from}" → "${c.to}"`)
        );
      } else {
        console.log(`[SourceFix] Todos los sources estaban limpios (${summary.scanned} contactos revisados).`);
      }
    } catch (err) {
      console.error('[SourceFix] Error en autocorrección:', err.message);
    }
  });

  // Every weekday at 9:05am EDT (13:05 UTC) — audit: verify daily report was sent, retry if not
  cron.schedule('5 13 * * 1-5', async () => {
    const date = yesterdayKeyET();
    console.log(`[Cron auditoría] Verificando reporte de ${date}... utc=${new Date().toISOString()}`);
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

  console.log('[Cron] ✅ Schedulers activos:');
  console.log('[Cron]    0  5 * * *  → medianoche ET  — consola');
  console.log('[Cron]   55 11 * * *  → 7:55am EDT     — autocorrección sources Zapier');
  console.log('[Cron]    0 12 * * *  → 8:00am EDT     — email diario (AYER)');
  console.log('[Cron]    5 12 * * *  → 8:05am EDT     — auditoría/reintento');
  console.log('[Cron]    0 12 * * 1  → lunes 8am EDT  — email semanal');
  console.log('[Cron]    0 12 1 * *  → día 1 8am EDT  — email mensual');
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
  autoCorrectFUBSources,
};
