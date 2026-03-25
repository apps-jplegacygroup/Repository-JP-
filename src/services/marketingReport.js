'use strict';
const cron = require('node-cron');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const { fetchProjectTasks, getCustomField } = require('./asana');

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const TEAM = ['Nicole Zapata', 'Karen'];

const TIPOS = ['Diseño', 'Video', 'Administrativo', 'Meeting', 'Otros'];
const TIPO_ICONS = { Diseño: '🎨', Video: '🎬', Administrativo: '📋', Meeting: '📅', Otros: '📌' };

const PRIORITY_COLORS = { High: '#FF4444', Medium: '#FFD700', Low: '#4FC3F7', '—': '#333333' };

const RECIPIENTS = [
  'jorgeflorez@jplegacygroup.com',
  'paoladiaz@jplegacygroup.com',
  'marketing@jplegacygroup.com',
  'karen@getvau.com',
];

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto',
  'Septiembre','Octubre','Noviembre','Diciembre'];
const DAYS_ES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

// ══════════════════════════════════════════════════════════════════════════════
// EASTERN TIME HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// Returns 'YYYY-MM-DD' for a JS Date in America/New_York
function dateKeyET(jsDate = new Date()) {
  return jsDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function todayET() { return dateKeyET(new Date()); }

// Parse a YYYY-MM-DD string as a midnight-UTC Date (safe for arithmetic)
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Get 0-6 weekday for a YYYY-MM-DD string (0=Sun, 6=Sat) — in ET
function weekdayOf(isoDate) {
  const d = parseDate(isoDate);
  return d.getUTCDay();
}

function isWeekdayET(isoDate) {
  const w = weekdayOf(isoDate);
  return w >= 1 && w <= 5;
}

// Monday of the current ET week
function currentWeekStartET() {
  const today = todayET();
  const d = parseDate(today);
  const dow = d.getUTCDay(); // 0=Sun
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return fmtDate(d);
}

// { start, end } for Mon-Fri of PREVIOUS week
function previousWeekRangeET() {
  const mon = parseDate(currentWeekStartET());
  mon.setUTCDate(mon.getUTCDate() - 7);
  const fri = new Date(mon);
  fri.setUTCDate(mon.getUTCDate() + 4);
  return { start: fmtDate(mon), end: fmtDate(fri) };
}

// { start, end } for the PREVIOUS calendar month (used by monthly cron on the 1st)
function previousMonthRangeET() {
  const today = todayET();
  let [y, m] = today.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, label: `${MONTHS_ES[m - 1]} ${y}` };
}

// Format YYYY-MM-DD → "Lunes 24 de Marzo"
function formatDateES(isoDate) {
  if (!isoDate) return '—';
  const d = parseDate(isoDate);
  return `${DAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}`;
}

// Short date: "24 Mar"
function shortDate(isoDate) {
  if (!isoDate) return '—';
  const d = parseDate(isoDate);
  return `${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()].slice(0, 3)}`;
}

// Days between two YYYY-MM-DD strings (inclusive start to end)
function daysBetween(start, end) {
  if (!start || !end) return null;
  const ms = parseDate(end) - parseDate(start);
  return Math.max(0, Math.round(ms / 86400000));
}

// Weeks (Mon-Fri) within a date range for trend tables
function weeksInRange(start, end) {
  const weeks = [];
  let d = parseDate(start);
  const endD = parseDate(end);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // find first Monday
  while (d <= endD) {
    const fri = new Date(d);
    fri.setUTCDate(d.getUTCDate() + 4);
    weeks.push({
      start: fmtDate(d),
      end: fmtDate(fri <= endD ? fri : endD),
      label: `${shortDate(fmtDate(d))} – ${shortDate(fmtDate(fri <= endD ? fri : endD))}`,
    });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return weeks;
}

// ══════════════════════════════════════════════════════════════════════════════
// TASK NORMALIZATION
// ══════════════════════════════════════════════════════════════════════════════

function getFieldMulti(task, ...names) {
  for (const n of names) {
    const v = getCustomField(task, n);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function normalizePriority(raw) {
  if (!raw) return '—';
  const v = raw.trim().toLowerCase();
  if (['high','alta','alto','crítica','critica'].includes(v)) return 'High';
  if (['medium','media','medio','normal'].includes(v)) return 'Medium';
  if (['low','baja','bajo'].includes(v)) return 'Low';
  return raw.trim();
}

function normalizeEffort(raw) {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const map = {
    'small':1,'pequeño':1,'bajo':1,'low':1,'1':1,
    'medium':2,'medio':2,'normal':2,'2':2,
    'large':3,'grande':3,'alto':3,'high':3,'3':3,
  };
  const n = parseFloat(raw);
  if (!isNaN(n) && n >= 1 && n <= 5) return n;
  return map[v] || null;
}

function normalizeTipo(raw) {
  if (!raw) return 'Otros';
  const v = raw.trim().toLowerCase();
  if (['diseño','design','diseno'].includes(v)) return 'Diseño';
  if (v === 'video') return 'Video';
  if (['administrativo','admin','administrative'].includes(v)) return 'Administrativo';
  if (['meeting','reunión','reunion','reunión'].includes(v)) return 'Meeting';
  return 'Otros';
}

// Fuzzy-match Asana assignee name to TEAM member (handles "Karen Lastname" → "Karen")
function matchAssignee(rawName) {
  if (!rawName) return 'Sin asignar';
  const lower = rawName.toLowerCase().trim();
  for (const member of TEAM) {
    const ml = member.toLowerCase();
    if (lower === ml) return member;
    const parts = ml.split(' ');
    if (parts.length === 1 && lower.startsWith(parts[0])) return member;
    if (lower.startsWith(parts[0]) && lower.includes(parts[parts.length - 1])) return member;
  }
  return rawName; // keep original if no match
}

function normalizeTasks(rawTasks) {
  return rawTasks.map((t) => {
    const assigneeName = t.assignee ? t.assignee.name : null;
    const completedAt = t.completed_at ? dateKeyET(new Date(t.completed_at)) : null;
    const startDate = getFieldMulti(t, 'Fecha de inicio', 'Start date', 'Start time') || t.start_on || null;
    const endDate   = getFieldMulti(t, 'Fecha de fin', 'End date', 'End Time') || t.due_on || null;
    const prioridad = normalizePriority(getFieldMulti(t, 'Prioridad', 'Priority'));
    const effortRaw = getFieldMulti(t, 'Effort level', 'Effort Level', 'Nivel de esfuerzo');
    const effort    = normalizeEffort(effortRaw);

    return {
      name:          t.name || '(sin nombre)',
      assignee:      matchAssignee(assigneeName),
      dueDate:       t.due_on || null,
      startDate:     startDate !== t.due_on ? startDate : null, // avoid treating due_on as startDate
      endDate,
      prioridad,
      estado:        getFieldMulti(t, 'Estado', 'Status') || '—',
      effortRaw,
      effort,
      effortLabel:   effort === 1 ? 'Small' : effort === 2 ? 'Medium' : effort === 3 ? 'Large' : '—',
      tipo:          normalizeTipo(getFieldMulti(t, 'Tipo', 'Type')),
      completed:     !!t.completed,
      completedDate: completedAt,
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// METRICS CALCULATOR
// ══════════════════════════════════════════════════════════════════════════════

function calcMetrics(tasks, rangeStart, rangeEnd, today) {
  const inRange = (d) => d && d >= rangeStart && d <= rangeEnd;
  const isWeekday = (d) => d && isWeekdayET(d);

  const completedInPeriod = tasks.filter((t) =>
    t.completed && inRange(t.completedDate) && isWeekday(t.completedDate)
  );
  const pending = tasks.filter((t) => !t.completed);
  const overdue = pending.filter((t) => t.dueDate && t.dueDate < today);

  // On-time compliance
  const withDue = completedInPeriod.filter((t) => t.dueDate);
  const onTime  = withDue.filter((t) => t.completedDate <= t.dueDate);
  const sameDayCompleted = withDue.filter((t) => t.completedDate === t.dueDate);
  const beforeDeadline   = withDue.filter((t) => t.completedDate <  t.dueDate);
  const afterDeadline    = withDue.filter((t) => t.completedDate >  t.dueDate);
  const onTimeRate = withDue.length > 0 ? (onTime.length / withDue.length) * 100 : null;

  // Time per task (startDate → endDate)
  const durations = tasks
    .filter((t) => t.startDate && t.endDate && t.endDate >= t.startDate)
    .map((t) => ({ task: t, days: daysBetween(t.startDate, t.endDate) }));

  const avgDays = durations.length > 0
    ? durations.reduce((s, x) => s + x.days, 0) / durations.length
    : null;

  const sortedDur = [...durations].sort((a, b) => b.days - a.days);
  const longestTask  = sortedDur[0]  ? { name: sortedDur[0].task.name,  days: sortedDur[0].days }  : null;
  const shortestTask = sortedDur[sortedDur.length - 1]
    ? { name: sortedDur[sortedDur.length - 1].task.name, days: sortedDur[sortedDur.length - 1].days }
    : null;

  const totalDaysPeriod = completedInPeriod
    .filter((t) => t.startDate && t.endDate)
    .reduce((s, t) => s + daysBetween(t.startDate, t.endDate), 0);

  // Avg tasks per workday (in period)
  const daysWithWork = new Set(completedInPeriod.map((t) => t.completedDate)).size;
  const avgTasksPerDay = daysWithWork > 0 ? completedInPeriod.length / daysWithWork : 0;

  // Consecutive-day streak going back from today (weekdays only)
  const doneDates = new Set(tasks.filter((t) => t.completed && t.completedDate).map((t) => t.completedDate));
  let streak = 0;
  const cur = parseDate(today);
  for (let i = 0; i < 31; i++) {
    const key = fmtDate(cur);
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      if (doneDates.has(key)) streak++;
      else break;
    }
    cur.setUTCDate(cur.getUTCDate() - 1);
  }

  // Tipo distribution (all tasks + period completions)
  const tipoAll = {};
  TIPOS.forEach((t) => { tipoAll[t] = 0; });
  tasks.forEach((t) => { tipoAll[t.tipo] = (tipoAll[t.tipo] || 0) + 1; });

  const tipoPeriod = {};
  TIPOS.forEach((t) => { tipoPeriod[t] = 0; });
  completedInPeriod.forEach((t) => { tipoPeriod[t.tipo]++; });

  // Tipo with highest overdue rate
  const tipoOverdueCount = {};
  TIPOS.forEach((t) => { tipoOverdueCount[t] = 0; });
  overdue.forEach((t) => { tipoOverdueCount[t.tipo]++; });
  const mostDelayedTipo = TIPOS.reduce((a, b) => tipoOverdueCount[a] >= tipoOverdueCount[b] ? a : b);

  // Priority distribution
  const priorityAll  = { High: 0, Medium: 0, Low: 0, '—': 0 };
  const priorityDone = { High: 0, Medium: 0, Low: 0 };
  tasks.forEach((t) => { priorityAll[t.prioridad]  = (priorityAll[t.prioridad] || 0) + 1; });
  completedInPeriod.forEach((t) => { if (t.prioridad in priorityDone) priorityDone[t.prioridad]++; });
  const highOverdue = overdue.filter((t) => t.prioridad === 'High');

  // Effort distribution
  const effortDist = { Small: 0, Medium: 0, Large: 0, '—': 0 };
  tasks.forEach((t) => { effortDist[t.effortLabel] = (effortDist[t.effortLabel] || 0) + 1; });
  const effortNums = tasks.map((t) => t.effort).filter((n) => n !== null);
  const avgEffort = effortNums.length > 0 ? effortNums.reduce((s, n) => s + n, 0) / effortNums.length : null;

  // Completion rate = period completions / total assigned
  const completionRate = tasks.length > 0 ? (completedInPeriod.length / tasks.length) * 100 : null;

  return {
    total: tasks.length,
    completedInPeriod: completedInPeriod.length,
    completedTasks: completedInPeriod,
    pendingCount: pending.length,
    pendingTasks: [...pending].sort((a, b) => ((a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1)),
    overdueCount: overdue.length,
    overdueTasks: [...overdue].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
    onTimeRate,
    onTimeCount: onTime.length,
    lateCount: afterDeadline.length,
    completedBefore: beforeDeadline.length,
    completedSameDay: sameDayCompleted.length,
    completedAfter: afterDeadline.length,
    avgDays: avgDays !== null ? Number(avgDays.toFixed(1)) : null,
    totalDaysPeriod,
    longestTask,
    shortestTask,
    avgTasksPerDay: Number(avgTasksPerDay.toFixed(1)),
    streak,
    tipoAll,
    tipoPeriod,
    tipoOverdueCount,
    mostDelayedTipo: tipoOverdueCount[mostDelayedTipo] > 0 ? mostDelayedTipo : null,
    priorityAll,
    priorityDone,
    highOverdue: highOverdue.length,
    highOverdueTasks: highOverdue,
    effortDist,
    avgEffort: avgEffort !== null ? Number(avgEffort.toFixed(1)) : null,
    completionRate,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPARISON & LEADER LOGIC
// ══════════════════════════════════════════════════════════════════════════════

function score100(nm, km) {
  const safe = (n, d) => (d > 0 ? n / d : 0);

  const maxComp = Math.max(nm.completedInPeriod, km.completedInPeriod, 1);
  const nicoleVelocity = safe(nm.completedInPeriod, maxComp) * 35;
  const karenVelocity  = safe(km.completedInPeriod, maxComp) * 35;

  const nicoleOnTime = (nm.onTimeRate !== null ? nm.onTimeRate / 100 : 0.5) * 30;
  const karenOnTime  = (km.onTimeRate !== null ? km.onTimeRate / 100 : 0.5) * 30;

  const nicoleEffort = (nm.avgEffort !== null ? nm.avgEffort / 5 : 0.5) * 20;
  const karenEffort  = (km.avgEffort !== null ? km.avgEffort / 5 : 0.5) * 20;

  const overdueBonus = (m) => Math.max(0, 15 - m.overdueCount * 3);
  const nicoleOver = overdueBonus(nm);
  const karenOver  = overdueBonus(km);

  const nicoleTotal = nicoleVelocity + nicoleOnTime + nicoleEffort + nicoleOver;
  const karenTotal  = karenVelocity  + karenOnTime  + karenEffort  + karenOver;

  let leader = 'Empate';
  if (nicoleTotal - karenTotal > 3) leader = 'Nicole Zapata';
  else if (karenTotal - nicoleTotal > 3) leader = 'Karen';

  const reasons = [];
  if (nm.completedInPeriod !== km.completedInPeriod) {
    const more = nm.completedInPeriod > km.completedInPeriod ? 'Nicole' : 'Karen';
    reasons.push(`${more} completó más tareas en el período`);
  }
  if (nm.onTimeRate !== null && km.onTimeRate !== null && Math.abs(nm.onTimeRate - km.onTimeRate) > 5) {
    const better = nm.onTimeRate > km.onTimeRate ? 'Nicole' : 'Karen';
    const val = Math.max(nm.onTimeRate, km.onTimeRate);
    reasons.push(`${better} tuvo mejor tasa de cumplimiento (${val.toFixed(0)}%)`);
  }
  if (nm.overdueCount !== km.overdueCount) {
    const fewer = nm.overdueCount < km.overdueCount ? 'Nicole' : 'Karen';
    reasons.push(`${fewer} tuvo menos tareas vencidas`);
  }

  return {
    leader,
    nicoleScore: Math.round(nicoleTotal),
    karenScore: Math.round(karenTotal),
    reasons: reasons.slice(0, 3),
  };
}

function cmpRow(label, nVal, kVal, higherBetter = true, unit = '') {
  const n = typeof nVal === 'number' ? nVal : parseFloat(nVal);
  const k = typeof kVal === 'number' ? kVal : parseFloat(kVal);
  let nWin = false, kWin = false;
  if (!isNaN(n) && !isNaN(k) && n !== k) {
    nWin = higherBetter ? n > k : n < k;
    kWin = !nWin;
  }
  const fmt = (v, win) => {
    const display = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : (v ?? '—');
    const color = win ? '#4CAF50' : '#888888';
    const bg = win ? 'background:#081408;' : '';
    return `<td style="padding:8px 12px;border-bottom:1px solid #1A1A1A;text-align:center;${bg}">
      <span style="color:${color};font-size:13px;font-weight:bold;font-family:Arial,sans-serif;">
        ${display}${unit}${win ? ' 🏆' : ''}
      </span>
    </td>`;
  };
  return `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #1A1A1A;color:#AAAAAA;font-size:12px;font-family:Arial,sans-serif;">${label}</td>
    ${fmt(nVal, nWin)}
    ${fmt(kVal, kWin)}
  </tr>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// AI ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

async function generateAIAnalysis(reportType, nm, km) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const fmt = (v, suf = '') => (v !== null && v !== undefined ? `${v}${suf}` : 'N/A');
    const tipoStr = (m) => TIPOS.map((t) => `${t}:${m.tipoAll[t]}`).join(', ');

    const prompt = `Eres el analista de productividad del equipo de marketing de JP Legacy Group.
Analiza los siguientes datos del equipo para el reporte ${reportType}:

NICOLE ZAPATA:
- Tareas completadas en período: ${nm.completedInPeriod}
- Tasa de cumplimiento a tiempo: ${fmt(nm.onTimeRate, '%')}
- Tareas vencidas: ${nm.overdueCount}
- Promedio días por tarea: ${fmt(nm.avgDays, ' días')}
- Promedio tareas/día: ${fmt(nm.avgTasksPerDay)}
- Prioridades: High=${nm.priorityAll.High} Med=${nm.priorityAll.Medium} Low=${nm.priorityAll.Low}
- Tipos: ${tipoStr(nm)}

KAREN:
- Tareas completadas en período: ${km.completedInPeriod}
- Tasa de cumplimiento a tiempo: ${fmt(km.onTimeRate, '%')}
- Tareas vencidas: ${km.overdueCount}
- Promedio días por tarea: ${fmt(km.avgDays, ' días')}
- Promedio tareas/día: ${fmt(km.avgTasksPerDay)}
- Prioridades: High=${km.priorityAll.High} Med=${km.priorityAll.Medium} Low=${km.priorityAll.Low}
- Tipos: ${tipoStr(km)}

Proporciona en español, breve y directo:
1. **Colaboradora más productiva:** [nombre] — [razón en 1 oración]
2. **Mejor cumplimiento:** [nombre] — [dato]
3. **Cuellos de botella:** [máx 2 bullets]
4. **Tipos con más retrasos:** [1-2 bullets]
5. **3 recomendaciones para la próxima semana:** [bullets accionables]

Máx 180 palabras. Usa los datos específicos.`;

    const msg = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text;
  } catch (err) {
    console.error('[Marketing] AI analysis error:', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML SHARED COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

const BASE_CSS = `background:#000000;font-family:Arial,sans-serif;`;

function htmlWrap(body) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;${BASE_CSS}">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#000000">
<tr><td align="center" style="padding:20px 10px;">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">
${body}
<tr><td style="height:20px;"></td></tr>
<tr><td style="text-align:center;padding:14px 0;border-top:1px solid #1A1A1A;">
  <span style="color:#2A2A2A;font-size:10px;font-family:Arial,sans-serif;">
    JP Legacy Agent · Auto-generado · America/New_York (ET)
  </span>
</td></tr>
</table></td></tr></table></body></html>`;
}

function htmlHeader(title, subtitle) {
  return `<tr><td style="padding:24px 0 18px;text-align:center;border-bottom:2px solid #C9A84C;">
  <div style="color:#C9A84C;font-size:22px;font-weight:bold;letter-spacing:4px;font-family:Arial,sans-serif;">JP LEGACY GROUP</div>
  <div style="color:#FFFFFF;font-size:14px;font-weight:bold;margin-top:8px;font-family:Arial,sans-serif;">${title}</div>
  <div style="color:#666666;font-size:11px;margin-top:4px;font-family:Arial,sans-serif;">${subtitle}</div>
</td></tr><tr><td style="height:14px;"></td></tr>`;
}

function statBoxRow(stats) {
  const cells = stats.map((s, i) => `
  <td align="center" style="padding:12px 8px;${i > 0 ? 'border-left:1px solid #1E1E1E;' : ''}">
    <div style="color:${s.color || '#FFFFFF'};font-size:26px;font-weight:bold;font-family:Arial,sans-serif;">${s.value ?? '—'}</div>
    <div style="color:#444444;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">${s.label}</div>
  </td>`).join('');
  return `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0F0F;border:1px solid #1E1E1E;border-radius:8px;">
      <tr>${cells}</tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`;
}

function taskListTable(tasks, maxRows = 8, isOverdue = false) {
  if (!tasks || tasks.length === 0)
    return `<p style="color:#333333;font-size:12px;margin:4px 0;font-family:Arial,sans-serif;font-style:italic;">Sin tareas en esta categoría.</p>`;
  const rows = tasks.slice(0, maxRows).map((t) => {
    const bg = isOverdue ? '#140800' : '#0A0A0A';
    const tc = isOverdue ? '#FF6B35' : '#CCCCCC';
    return `<tr>
      <td style="padding:6px 10px;background:${bg};border-bottom:1px solid #141414;color:${tc};font-size:12px;font-family:Arial,sans-serif;">${isOverdue ? '⚠️ ' : ''}${t.name}</td>
      <td style="padding:6px 10px;background:${bg};border-bottom:1px solid #141414;color:#555555;font-size:11px;white-space:nowrap;font-family:Arial,sans-serif;">${formatDateES(t.dueDate)}</td>
      <td style="padding:6px 10px;background:${bg};border-bottom:1px solid #141414;font-size:11px;white-space:nowrap;font-family:Arial,sans-serif;"><span style="color:${PRIORITY_COLORS[t.prioridad] || '#333333'}">${t.prioridad}</span></td>
    </tr>`;
  }).join('');
  const more = tasks.length > maxRows
    ? `<tr><td colspan="3" style="padding:5px 10px;background:#080808;color:#2A2A2A;font-size:10px;text-align:center;font-family:Arial,sans-serif;">+ ${tasks.length - maxRows} más</td></tr>`
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="padding:4px 10px;font-size:9px;color:#252525;font-family:Arial,sans-serif;border-bottom:1px solid #141414;">TAREA</td>
      <td style="padding:4px 10px;font-size:9px;color:#252525;font-family:Arial,sans-serif;border-bottom:1px solid #141414;">FECHA LÍMITE</td>
      <td style="padding:4px 10px;font-size:9px;color:#252525;font-family:Arial,sans-serif;border-bottom:1px solid #141414;">PRIORIDAD</td>
    </tr>${rows}${more}</table>`;
}

function tipoGrid(tipoCount, total) {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr>${TIPOS.map((tipo) => {
    const count = tipoCount[tipo] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `<td style="padding:8px 4px;text-align:center;">
      <div style="font-size:16px;">${TIPO_ICONS[tipo]}</div>
      <div style="color:#FFFFFF;font-size:15px;font-weight:bold;font-family:Arial,sans-serif;">${count}</div>
      <div style="color:#555555;font-size:9px;letter-spacing:1px;font-family:Arial,sans-serif;">${tipo.toUpperCase()}</div>
      <div style="color:#C9A84C;font-size:9px;font-family:Arial,sans-serif;">${pct}%</div>
    </td>`;
  }).join('')}</tr></table>`;
}

function priorityPills(priorityAll) {
  return `<span style="background:#2A0000;color:#FF4444;padding:3px 10px;border-radius:12px;font-size:11px;margin-right:6px;font-family:Arial,sans-serif;">High ${priorityAll.High}</span>
  <span style="background:#1A1400;color:#FFD700;padding:3px 10px;border-radius:12px;font-size:11px;margin-right:6px;font-family:Arial,sans-serif;">Medium ${priorityAll.Medium}</span>
  <span style="background:#001A2A;color:#4FC3F7;padding:3px 10px;border-radius:12px;font-size:11px;font-family:Arial,sans-serif;">Low ${priorityAll.Low}</span>`;
}

function aiBlock(aiText) {
  if (!aiText) return '';
  const html = aiText
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#C9A84C;">$1</strong>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n[-•] /g, '<br>• ')
    .replace(/\n(\d+\.) /g, '<br>$1 ');
  return `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0D0A;border:1px solid #1A2A1A;border-radius:8px;">
      <tr><td style="padding:10px 16px;border-bottom:1px solid #1A2A1A;">
        <span style="color:#4CAF50;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">🤖 Análisis del Equipo — Claude AI</span>
      </td></tr>
      <tr><td style="padding:14px 16px;color:#CCCCCC;font-size:13px;line-height:1.6;font-family:Arial,sans-serif;">${html}</td></tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`;
}

// ── Collaborator Card ─────────────────────────────────────────────────────────
function assigneeCard(assignee, m, reportType) {
  const headerColor = assignee === 'Nicole Zapata' ? '#C9A84C' : '#4FC3F7';

  const onTimeStr = m.onTimeRate !== null ? `${m.onTimeRate.toFixed(0)}%` : '—';
  const avgDaysStr = m.avgDays !== null ? `${m.avgDays}d` : '—';

  let velocitySection = '';
  if (reportType === 'daily') {
    velocitySection = statBoxRow([
      { value: m.completedInPeriod, label: 'Completadas hoy', color: '#4FC3F7' },
      { value: m.pendingCount,      label: 'Pendientes',      color: '#FFD700' },
      { value: m.overdueCount,      label: 'Vencidas',        color: m.overdueCount > 0 ? '#FF6B35' : '#555555' },
      { value: onTimeStr,           label: 'A tiempo',        color: '#4CAF50' },
    ]);
  } else {
    velocitySection = statBoxRow([
      { value: m.completedInPeriod,            label: 'Completadas',     color: '#4FC3F7' },
      { value: m.avgTasksPerDay,               label: 'Tareas/día',      color: '#C9A84C' },
      { value: `${m.completionRate !== null ? m.completionRate.toFixed(0) : '—'}%`, label: 'Compl. rate', color: '#FFFFFF' },
      { value: m.streak > 0 ? `🔥${m.streak}d` : '—', label: 'Racha',  color: '#FF9800' },
    ]);
  }

  const timeSection = reportType !== 'daily' ? `
  <tr><td style="padding:10px 14px;border-top:1px solid #141414;">
    <div style="color:#555555;font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-family:Arial,sans-serif;">Tiempo & Esfuerzo</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="width:50%;padding-right:8px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:4px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">Prom. días/tarea</td>
              <td style="padding:4px 0;color:#C9A84C;font-size:11px;font-weight:bold;text-align:right;font-family:Arial,sans-serif;">${avgDaysStr}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">Tiempo total período</td>
              <td style="padding:4px 0;color:#C9A84C;font-size:11px;font-weight:bold;text-align:right;font-family:Arial,sans-serif;">${m.totalDaysPeriod}d</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">Effort promedio</td>
              <td style="padding:4px 0;color:#C9A84C;font-size:11px;font-weight:bold;text-align:right;font-family:Arial,sans-serif;">${m.avgEffort !== null ? `${m.avgEffort}/5` : '—'}</td>
            </tr>
          </table>
        </td>
        <td style="width:50%;padding-left:8px;border-left:1px solid #141414;">
          <div style="color:#555555;font-size:9px;margin-bottom:4px;font-family:Arial,sans-serif;">Effort Level</div>
          <span style="background:#0A1A0A;color:#4CAF50;padding:2px 8px;border-radius:10px;font-size:10px;margin-right:4px;font-family:Arial,sans-serif;">S ${m.effortDist.Small}</span>
          <span style="background:#1A1400;color:#FFD700;padding:2px 8px;border-radius:10px;font-size:10px;margin-right:4px;font-family:Arial,sans-serif;">M ${m.effortDist.Medium}</span>
          <span style="background:#1A0A0A;color:#FF6B35;padding:2px 8px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">L ${m.effortDist.Large}</span>
          ${m.longestTask ? `<div style="color:#444444;font-size:10px;margin-top:6px;font-family:Arial,sans-serif;">📏 Más larga: <span style="color:#888888">${m.longestTask.name.slice(0, 32)}… (${m.longestTask.days}d)</span></div>` : ''}
        </td>
      </tr>
    </table>
  </td></tr>` : '';

  const qualitySection = reportType !== 'daily' ? `
  <tr><td style="padding:10px 14px;border-top:1px solid #141414;">
    <div style="color:#555555;font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-family:Arial,sans-serif;">Calidad & Cumplimiento</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:3px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">Tasa a tiempo</td>
        <td style="padding:3px 0;text-align:right;font-family:Arial,sans-serif;"><span style="color:${m.onTimeRate !== null && m.onTimeRate >= 70 ? '#4CAF50' : '#FF6B35'};font-size:13px;font-weight:bold;">${onTimeStr}</span></td>
      </tr>
      <tr>
        <td style="padding:3px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">Antes del límite</td>
        <td style="padding:3px 0;color:#4CAF50;text-align:right;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${m.completedBefore}</td>
      </tr>
      <tr>
        <td style="padding:3px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">El mismo día</td>
        <td style="padding:3px 0;color:#FFD700;text-align:right;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${m.completedSameDay}</td>
      </tr>
      <tr>
        <td style="padding:3px 0;color:#888888;font-size:11px;font-family:Arial,sans-serif;">Después del límite</td>
        <td style="padding:3px 0;color:${m.completedAfter > 0 ? '#FF6B35' : '#555555'};text-align:right;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${m.completedAfter}</td>
      </tr>
      ${m.highOverdue > 0 ? `<tr><td colspan="2" style="padding:4px 0;"><span style="background:#2A0000;color:#FF4444;padding:3px 10px;border-radius:4px;font-size:11px;font-family:Arial,sans-serif;">🚨 ${m.highOverdue} tarea(s) High vencidas</span></td></tr>` : ''}
    </table>
  </td></tr>` : '';

  const overdueSection = m.overdueCount > 0 ? `
  <tr><td style="border-top:1px solid #141414;">
    <div style="padding:8px 14px 4px;color:#FF6B35;font-size:9px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">Tareas Vencidas (${m.overdueCount})</div>
    ${taskListTable(m.overdueTasks, 6, true)}
  </td></tr>` : '';

  const pendingSection = m.pendingCount > 0 ? `
  <tr><td style="border-top:1px solid #141414;">
    <div style="padding:8px 14px 4px;color:#888888;font-size:9px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">Tareas Pendientes (${m.pendingCount})</div>
    ${taskListTable(m.pendingTasks, reportType === 'daily' ? 10 : 6, false)}
  </td></tr>` : '';

  const tipoSection = reportType !== 'daily' ? `
  <tr><td style="padding:10px 14px;border-top:1px solid #141414;">
    <div style="color:#555555;font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-family:Arial,sans-serif;">Distribución por Tipo</div>
    ${tipoGrid(m.tipoAll, m.total)}
  </td></tr>` : '';

  const prioritySection = reportType !== 'daily' ? `
  <tr><td style="padding:10px 14px;border-top:1px solid #141414;">
    <div style="color:#555555;font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-family:Arial,sans-serif;">Prioridades</div>
    ${priorityPills(m.priorityAll)}
    <div style="color:#333333;font-size:10px;margin-top:6px;font-family:Arial,sans-serif;">
      Completadas: High ${m.priorityDone.High} · Med ${m.priorityDone.Medium} · Low ${m.priorityDone.Low}
    </div>
  </td></tr>` : '';

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:12px 14px;border-bottom:1px solid #141414;">
      <span style="color:${headerColor};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">👤 ${assignee}</span>
      <span style="color:#333333;font-size:10px;font-family:Arial,sans-serif;margin-left:10px;">${m.total} tareas asignadas</span>
    </td></tr>
    <tr><td style="padding:10px 14px;">
      <table width="100%" cellpadding="0" cellspacing="0">${velocitySection}</table>
    </td></tr>
    ${timeSection}${qualitySection}${overdueSection}${pendingSection}${tipoSection}${prioritySection}
  </table>
</td></tr><tr><td style="height:10px;"></td></tr>`;
}

// ── Comparison Section ────────────────────────────────────────────────────────
function comparisonSection(nm, km, leaderResult) {
  const { leader, nicoleScore, karenScore, reasons } = leaderResult;

  const leaderBanner = leader !== 'Empate'
    ? `<tr><td colspan="3" style="padding:14px;text-align:center;background:#081408;border-bottom:1px solid #1A2A1A;">
        <div style="color:#4CAF50;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-family:Arial,sans-serif;">🏆 LÍDER DEL PERÍODO</div>
        <div style="color:#FFFFFF;font-size:20px;font-weight:bold;margin:6px 0;font-family:Arial,sans-serif;">${leader}</div>
        <div style="color:#555555;font-size:11px;font-family:Arial,sans-serif;">${reasons.join(' · ')}</div>
        <div style="color:#333333;font-size:10px;margin-top:6px;font-family:Arial,sans-serif;">Nicole ${nicoleScore} pts — Karen ${karenScore} pts</div>
      </td></tr>`
    : `<tr><td colspan="3" style="padding:12px;text-align:center;background:#141414;border-bottom:1px solid #1E1E1E;">
        <div style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">🤝 Empate técnico este período</div>
      </td></tr>`;

  const headers = `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #1A1A1A;background:#0A0A0A;"></td>
    <td style="padding:8px 12px;border-bottom:1px solid #1A1A1A;text-align:center;background:#0A0A0A;color:#C9A84C;font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">Nicole Zapata</td>
    <td style="padding:8px 12px;border-bottom:1px solid #1A1A1A;text-align:center;background:#0A0A0A;color:#4FC3F7;font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">Karen</td>
  </tr>`;

  const rows = [
    cmpRow('Tareas completadas',       nm.completedInPeriod,              km.completedInPeriod,              true),
    cmpRow('Tasa de cumplimiento',     nm.onTimeRate !== null ? nm.onTimeRate.toFixed(0) : null, km.onTimeRate !== null ? km.onTimeRate.toFixed(0) : null, true,  '%'),
    cmpRow('Días promedio/tarea',      nm.avgDays,                         km.avgDays,                         false, 'd'),
    cmpRow('Tareas/día',               nm.avgTasksPerDay,                  km.avgTasksPerDay,                  true),
    cmpRow('Racha actual (días)',       nm.streak,                          km.streak,                          true),
    cmpRow('Tareas High completadas',  nm.priorityDone.High,               km.priorityDone.High,               true),
    cmpRow('Tareas High vencidas',     nm.highOverdue,                     km.highOverdue,                     false),
    cmpRow('Tareas vencidas total',    nm.overdueCount,                    km.overdueCount,                    false),
    cmpRow('Effort promedio',          nm.avgEffort,                       km.avgEffort,                       true,  '/5'),
  ].join('');

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    <tr><td colspan="3" style="padding:10px 14px;border-bottom:1px solid #141414;">
      <span style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;">⚔️ Nicole vs Karen</span>
    </td></tr>
    ${leaderBanner}
    <table width="100%" cellpadding="0" cellspacing="0">${headers}${rows}</table>
  </table>
</td></tr><tr><td style="height:10px;"></td></tr>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

async function fetchAndNormalize() {
  const projectId = process.env.ASANA_PROJECT_ID;
  if (!projectId) throw new Error('ASANA_PROJECT_ID no configurado');
  const raw = await fetchProjectTasks(projectId);
  console.log(`[Marketing] Tareas de Asana: ${raw.length}`);
  return normalizeTasks(raw);
}

function splitByTeam(tasks) {
  const byAssignee = {};
  for (const member of TEAM) {
    byAssignee[member] = tasks.filter((t) => t.assignee === member);
  }
  return byAssignee;
}

async function buildDailyData() {
  const today = todayET();
  const weekStart = currentWeekStartET();
  const tasks = await fetchAndNormalize();
  const byAssignee = splitByTeam(tasks);

  const nicole = calcMetrics(byAssignee['Nicole Zapata'], today, today, today);
  const karen  = calcMetrics(byAssignee['Karen'],         today, today, today);

  const aiText = await generateAIAnalysis('diario', nicole, karen);
  return { today, weekStart, byAssignee, metrics: { nicole, karen }, totalTasks: tasks.length, aiText };
}

async function buildWeeklyData() {
  const today = todayET();
  const weekRange = previousWeekRangeET();
  const tasks = await fetchAndNormalize();
  const byAssignee = splitByTeam(tasks);

  const nicole = calcMetrics(byAssignee['Nicole Zapata'], weekRange.start, weekRange.end, today);
  const karen  = calcMetrics(byAssignee['Karen'],         weekRange.start, weekRange.end, today);

  const leaderResult = score100(nicole, karen);
  const aiText = await generateAIAnalysis('semanal', nicole, karen);
  return { today, weekRange, byAssignee, metrics: { nicole, karen }, leaderResult, totalTasks: tasks.length, aiText };
}

async function buildMonthlyData() {
  const today = todayET();
  const monthRange = previousMonthRangeET();
  const tasks = await fetchAndNormalize();
  const byAssignee = splitByTeam(tasks);

  const nicole = calcMetrics(byAssignee['Nicole Zapata'], monthRange.start, monthRange.end, today);
  const karen  = calcMetrics(byAssignee['Karen'],         monthRange.start, monthRange.end, today);

  // Weekly breakdown within the month
  const weeks = weeksInRange(monthRange.start, monthRange.end);
  const weeklyTrends = weeks.map((w) => ({
    label: w.label,
    nicole: calcMetrics(byAssignee['Nicole Zapata'], w.start, w.end, today).completedInPeriod,
    karen:  calcMetrics(byAssignee['Karen'],         w.start, w.end, today).completedInPeriod,
  }));

  const leaderResult = score100(nicole, karen);
  const aiText = await generateAIAnalysis('mensual', nicole, karen);
  return { today, monthRange, byAssignee, metrics: { nicole, karen }, leaderResult, weeklyTrends, totalTasks: tasks.length, aiText };
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

function buildDailyHTML(data) {
  const { today, metrics: { nicole, karen }, totalTasks, aiText } = data;
  const totalOverdue   = nicole.overdueCount + karen.overdueCount;
  const totalCompleted = nicole.completedInPeriod + karen.completedInPeriod;

  const teamSummary = statBoxRow([
    { value: totalTasks,    label: 'Total proyecto',    color: '#FFFFFF' },
    { value: totalCompleted, label: 'Completadas hoy', color: '#4FC3F7' },
    { value: nicole.pendingCount + karen.pendingCount, label: 'Pendientes', color: '#FFD700' },
    { value: totalOverdue,  label: 'Vencidas',          color: totalOverdue > 0 ? '#FF6B35' : '#555555' },
  ]);

  // Quick Nicole vs Karen daily comparison
  const nWins = nicole.completedInPeriod > karen.completedInPeriod;
  const kWins = karen.completedInPeriod  > nicole.completedInPeriod;
  const quickCompare = `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
      <tr><td colspan="2" style="padding:8px 14px;border-bottom:1px solid #141414;">
        <span style="color:#888888;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">Comparativo del Día</span>
      </td></tr>
      <tr>
        <td style="padding:12px;text-align:center;border-right:1px solid #141414;background:${nWins ? '#081408' : '#0A0A0A'};">
          <div style="color:#C9A84C;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">NICOLE ZAPATA</div>
          <div style="color:${nWins ? '#4CAF50' : '#888888'};font-size:28px;font-weight:bold;font-family:Arial,sans-serif;">${nicole.completedInPeriod}${nWins ? ' 🏆' : ''}</div>
          <div style="color:#444444;font-size:9px;font-family:Arial,sans-serif;">completadas · ${nicole.overdueCount} vencidas</div>
        </td>
        <td style="padding:12px;text-align:center;background:${kWins ? '#081408' : '#0A0A0A'};">
          <div style="color:#4FC3F7;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">KAREN</div>
          <div style="color:${kWins ? '#4CAF50' : '#888888'};font-size:28px;font-weight:bold;font-family:Arial,sans-serif;">${karen.completedInPeriod}${kWins ? ' 🏆' : ''}</div>
          <div style="color:#444444;font-size:9px;font-family:Arial,sans-serif;">completadas · ${karen.overdueCount} vencidas</div>
        </td>
      </tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`;

  const body = [
    htmlHeader(
      `📅 Reporte Diario Marketing`,
      `${formatDateES(today)} · America/New_York`
    ),
    `<tr><td>`,
    `<table width="100%" cellpadding="0" cellspacing="0">${teamSummary}</table>`,
    `</td></tr><tr><td style="height:6px;"></td></tr>`,
    quickCompare,
    assigneeCard('Nicole Zapata', nicole, 'daily'),
    assigneeCard('Karen', karen, 'daily'),
    aiBlock(aiText),
  ].join('');

  return htmlWrap(body);
}

function buildWeeklyHTML(data) {
  const { weekRange, metrics: { nicole, karen }, leaderResult, totalTasks, aiText } = data;
  const totalOverdue   = nicole.overdueCount + karen.overdueCount;
  const totalCompleted = nicole.completedInPeriod + karen.completedInPeriod;
  const avgOnTime = [nicole.onTimeRate, karen.onTimeRate].filter(n => n !== null);
  const avgOnTimeStr = avgOnTime.length > 0
    ? `${(avgOnTime.reduce((s, n) => s + n, 0) / avgOnTime.length).toFixed(0)}%`
    : '—';

  const teamSummary = statBoxRow([
    { value: totalCompleted, label: 'Completadas semana', color: '#4FC3F7' },
    { value: avgOnTimeStr,   label: 'Cumplimiento prom',  color: '#4CAF50' },
    { value: totalOverdue,   label: 'Vencidas',           color: totalOverdue > 0 ? '#FF6B35' : '#555555' },
    { value: totalTasks,     label: 'Total proyecto',     color: '#FFFFFF' },
  ]);

  const body = [
    htmlHeader(
      `📊 Reporte Semanal Marketing`,
      `Semana del ${formatDateES(weekRange.start)} al ${formatDateES(weekRange.end)}`
    ),
    `<tr><td><table width="100%" cellpadding="0" cellspacing="0">${teamSummary}</table></td></tr>`,
    `<tr><td style="height:8px;"></td></tr>`,
    assigneeCard('Nicole Zapata', nicole, 'weekly'),
    assigneeCard('Karen', karen, 'weekly'),
    comparisonSection(nicole, karen, leaderResult),
    aiBlock(aiText),
  ].join('');

  return htmlWrap(body);
}

function buildMonthlyHTML(data) {
  const { monthRange, metrics: { nicole, karen }, leaderResult, weeklyTrends, totalTasks, aiText } = data;
  const totalCompleted = nicole.completedInPeriod + karen.completedInPeriod;
  const totalOverdue   = nicole.overdueCount + karen.overdueCount;

  const teamSummary = statBoxRow([
    { value: totalCompleted, label: 'Completadas mes',   color: '#4FC3F7' },
    { value: nicole.completedInPeriod, label: 'Nicole',   color: '#C9A84C' },
    { value: karen.completedInPeriod,  label: 'Karen',    color: '#4FC3F7' },
    { value: totalOverdue,  label: 'Vencidas',           color: totalOverdue > 0 ? '#FF6B35' : '#555555' },
  ]);

  const trendRows = weeklyTrends.map((w) =>
    `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #141414;color:#888888;font-size:11px;font-family:Arial,sans-serif;">${w.label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #141414;text-align:center;color:#C9A84C;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${w.nicole}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #141414;text-align:center;color:#4FC3F7;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${w.karen}</td>
    </tr>`
  ).join('');

  const trendsSection = weeklyTrends.length > 0 ? `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
      <tr><td colspan="3" style="padding:8px 14px;border-bottom:1px solid #141414;">
        <span style="color:#888888;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">Tendencia Semanal</span>
      </td></tr>
      <tr>
        <td style="padding:5px 12px;border-bottom:1px solid #141414;color:#2A2A2A;font-size:9px;font-family:Arial,sans-serif;">SEMANA</td>
        <td style="padding:5px 12px;border-bottom:1px solid #141414;color:#C9A84C;font-size:9px;font-family:Arial,sans-serif;text-align:center;">NICOLE</td>
        <td style="padding:5px 12px;border-bottom:1px solid #141414;color:#4FC3F7;font-size:9px;font-family:Arial,sans-serif;text-align:center;">KAREN</td>
      </tr>
      ${trendRows}
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>` : '';

  const body = [
    htmlHeader(
      `📆 Reporte Mensual Marketing`,
      `${monthRange.label} · America/New_York`
    ),
    `<tr><td><table width="100%" cellpadding="0" cellspacing="0">${teamSummary}</table></td></tr>`,
    `<tr><td style="height:8px;"></td></tr>`,
    trendsSection,
    assigneeCard('Nicole Zapata', nicole, 'monthly'),
    assigneeCard('Karen', karen, 'monthly'),
    comparisonSection(nicole, karen, leaderResult),
    aiBlock(aiText),
  ].join('');

  return htmlWrap(body);
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT SENDERS
// ══════════════════════════════════════════════════════════════════════════════

async function sendMarketingEmail(subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Marketing] Email skipped — RESEND_API_KEY no configurado');
    return;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: 'JP Legacy Agent <apps@jplegacygroup.com>',
    to: RECIPIENTS,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[Marketing] ✅ Email enviado: ${subject}`);
}

async function sendDailyMarketingReport() {
  console.log('[Marketing] Generando reporte DIARIO...');
  const data = await buildDailyData();
  const html = buildDailyHTML(data);
  const hasOverdue = data.metrics.nicole.overdueCount + data.metrics.karen.overdueCount > 0;
  const d = parseDate(data.today);
  const dayName = DAYS_ES[d.getUTCDay()];
  const dateStr = `${dayName} ${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()]}`;
  const subject = `JP Legacy — Reporte Diario · ${dateStr}${hasOverdue ? ' ⚠️' : ''}`;
  await sendMarketingEmail(subject, html);
  return { data, html };
}

async function sendWeeklyMarketingReport() {
  console.log('[Marketing] Generando reporte SEMANAL...');
  const data = await buildWeeklyData();
  const html = buildWeeklyHTML(data);
  const subject = `JP Legacy — Reporte Semanal · ${shortDate(data.weekRange.start)} al ${shortDate(data.weekRange.end)}`;
  await sendMarketingEmail(subject, html);
  return { data, html };
}

async function sendMonthlyMarketingReport() {
  console.log('[Marketing] Generando reporte MENSUAL...');
  const data = await buildMonthlyData();
  const html = buildMonthlyHTML(data);
  const subject = `JP Legacy — Reporte Mensual · ${data.monthRange.label}`;
  await sendMarketingEmail(subject, html);
  return { data, html };
}

// ══════════════════════════════════════════════════════════════════════════════
// CRON SCHEDULER
// ══════════════════════════════════════════════════════════════════════════════

function startMarketingReport() {
  // Daily Mon-Fri 9:00am ET (14:00 UTC)
  cron.schedule('0 14 * * 1-5', async () => {
    console.log('[Marketing] Cron: reporte DIARIO disparado');
    try { await sendDailyMarketingReport(); }
    catch (err) { console.error('[Marketing] Cron daily error:', err.message); }
  });

  // Weekly Monday 9:00am ET (14:00 UTC) — reports on PREVIOUS week
  cron.schedule('0 14 * * 1', async () => {
    console.log('[Marketing] Cron: reporte SEMANAL disparado');
    try { await sendWeeklyMarketingReport(); }
    catch (err) { console.error('[Marketing] Cron weekly error:', err.message); }
  });

  // Monthly 1st of month 9:00am ET (14:00 UTC) — reports on PREVIOUS month
  cron.schedule('0 14 1 * *', async () => {
    console.log('[Marketing] Cron: reporte MENSUAL disparado');
    try { await sendMonthlyMarketingReport(); }
    catch (err) { console.error('[Marketing] Cron monthly error:', err.message); }
  });

  console.log('[Cron] ✅ Marketing Daily:   0 14 * * 1-5  → 9:00am ET lun-vie');
  console.log('[Cron] ✅ Marketing Weekly:  0 14 * * 1    → 9:00am ET lunes (semana anterior)');
  console.log('[Cron] ✅ Marketing Monthly: 0 14 1 * *    → 9:00am ET día 1 (mes anterior)');
}

module.exports = {
  startMarketingReport,
  sendDailyMarketingReport,
  sendWeeklyMarketingReport,
  sendMonthlyMarketingReport,
  buildDailyData,
  buildWeeklyData,
  buildMonthlyData,
};
