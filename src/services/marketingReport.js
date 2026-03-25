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

const MONTHS_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];
const DAYS_ES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

// ══════════════════════════════════════════════════════════════════════════════
// EASTERN TIME HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Returns 'YYYY-MM-DD' for a JS Date in America/New_York */
function dateKeyET(jsDate = new Date()) {
  return jsDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function todayET() {
  return dateKeyET(new Date());
}

/** Format ISO timestamp → "2:34 PM" in ET timezone */
function formatTimeET(isoTimestamp) {
  if (!isoTimestamp) return '—';
  try {
    const d = new Date(isoTimestamp);
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch (_) {
    return '—';
  }
}

/** Parse 'YYYY-MM-DD' as midnight-UTC Date (safe for arithmetic) */
function parseDate(str) {
  if (!str) return null;
  // Accept YYYY-MM-DD (possibly with time suffix like T00:00:00Z)
  const match = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 0-6 weekday for a YYYY-MM-DD string (0=Sun, 6=Sat) */
function weekdayOf(isoDate) {
  const d = parseDate(isoDate);
  if (!d) return -1;
  return d.getUTCDay();
}

function isWeekdayET(isoDate) {
  const w = weekdayOf(isoDate);
  return w >= 1 && w <= 5;
}

/** Yesterday (previous calendar day) in ET */
function yesterdayET() {
  const d = parseDate(todayET());
  d.setUTCDate(d.getUTCDate() - 1);
  return fmtDate(d);
}

/** Previous workday: Monday → Friday, else yesterday */
function prevWorkdayET() {
  const today = todayET();
  const dow = weekdayOf(today);
  const d = parseDate(today);
  if (dow === 1) {
    d.setUTCDate(d.getUTCDate() - 3); // Monday → Friday
  } else {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return fmtDate(d);
}

/** Monday of the current ET week */
function currentWeekStartET() {
  const today = todayET();
  const d = parseDate(today);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return fmtDate(d);
}

/** { start, end } Mon-Fri of PREVIOUS week */
function previousWeekRangeET() {
  const mon = parseDate(currentWeekStartET());
  mon.setUTCDate(mon.getUTCDate() - 7);
  const fri = new Date(mon);
  fri.setUTCDate(mon.getUTCDate() + 4);
  return { start: fmtDate(mon), end: fmtDate(fri) };
}

/** { start, end, label } of PREVIOUS calendar month */
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

/** Format 'YYYY-MM-DD' → "Martes 24 de Marzo" */
function formatDateES(isoDate) {
  if (!isoDate) return '—';
  const d = parseDate(isoDate);
  if (!d) return '—';
  return `${DAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}`;
}

/** Short date: "24 Mar" */
function shortDate(isoDate) {
  if (!isoDate) return '—';
  const d = parseDate(isoDate);
  if (!d) return '—';
  return `${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()].slice(0, 3)}`;
}

/** Integer days between two YYYY-MM-DD strings */
function daysBetween(start, end) {
  if (!start || !end) return null;
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return null;
  return Math.max(0, Math.round((e - s) / 86400000));
}

/** Array of { start, end, label } for Mon-Fri weeks within a date range */
function weeksInRange(start, end) {
  const weeks = [];
  let d = parseDate(start);
  const endD = parseDate(end);
  if (!d || !endD) return weeks;
  // advance to first Monday
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  while (d <= endD) {
    const fri = new Date(d);
    fri.setUTCDate(d.getUTCDate() + 4);
    const actualEnd = fri <= endD ? fri : endD;
    weeks.push({
      start: fmtDate(d),
      end: fmtDate(actualEnd),
      label: `${shortDate(fmtDate(d))} – ${shortDate(fmtDate(actualEnd))}`,
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
  if (['high', 'alta', 'alto', 'crítica', 'critica'].includes(v)) return 'High';
  if (['medium', 'media', 'medio', 'normal'].includes(v)) return 'Medium';
  if (['low', 'baja', 'bajo'].includes(v)) return 'Low';
  return raw.trim();
}

function normalizeEffort(raw) {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const map = {
    'small': 1, 'pequeño': 1, 'bajo': 1, 'low': 1, '1': 1,
    'medium': 2, 'medio': 2, 'normal': 2, '2': 2,
    'large': 3, 'grande': 3, 'alto': 3, 'high': 3, '3': 3,
  };
  const n = parseFloat(raw);
  if (!isNaN(n) && n >= 1 && n <= 5) return n;
  return map[v] || null;
}

function normalizeTipo(raw) {
  if (!raw) return 'Otros';
  const v = raw.trim().toLowerCase();
  if (['diseño', 'design', 'diseno'].includes(v)) return 'Diseño';
  if (v === 'video') return 'Video';
  if (['administrativo', 'admin', 'administrative'].includes(v)) return 'Administrativo';
  if (['meeting', 'reunión', 'reunion'].includes(v)) return 'Meeting';
  return 'Otros';
}

/** Fuzzy-match Asana assignee name to TEAM member */
function matchAssignee(rawName) {
  if (!rawName) return 'Sin asignar';
  const lower = rawName.toLowerCase().trim();
  for (const member of TEAM) {
    const ml = member.toLowerCase();
    // exact match
    if (lower === ml) return member;
    const parts = ml.split(' ');
    // single-word member (Karen): match if assignee starts with that word
    if (parts.length === 1 && lower.startsWith(parts[0])) return member;
    // multi-word: starts with first word and contains last word
    if (parts.length > 1 && lower.startsWith(parts[0]) && lower.includes(parts[parts.length - 1])) return member;
  }
  return rawName;
}

function normalizeTasks(rawTasks) {
  return rawTasks.map((t) => {
    const assigneeName = t.assignee ? t.assignee.name : null;
    const completedAtRaw = t.completed_at || null;
    const completedDate = completedAtRaw ? dateKeyET(new Date(completedAtRaw)) : null;
    const startDateRaw = getFieldMulti(t, 'Fecha de inicio', 'Start date', 'Start time') || t.start_on || null;
    const endDateRaw   = getFieldMulti(t, 'Fecha de fin', 'End date', 'End Time') || t.due_on || null;
    const prioridad    = normalizePriority(getFieldMulti(t, 'Prioridad', 'Priority'));
    const estado       = getFieldMulti(t, 'Estado', 'Status') || '—';
    const effortRaw    = getFieldMulti(t, 'Effort level', 'Effort Level', 'Nivel de esfuerzo');
    const effortNum    = normalizeEffort(effortRaw);
    const tipoRaw      = getFieldMulti(t, 'Tipo', 'Type');
    const tipo         = normalizeTipo(tipoRaw);

    // avoid treating due_on as startDate
    const startDate = (startDateRaw && startDateRaw !== t.due_on) ? startDateRaw : null;
    const endDate   = endDateRaw || null;

    return {
      name:          t.name || '(sin nombre)',
      assignee:      matchAssignee(assigneeName),
      dueDate:       t.due_on || null,
      startDate,
      endDate,
      prioridad,
      estado,
      effortRaw,
      effortLabel:   effortNum === 1 ? 'Small' : effortNum === 2 ? 'Medium' : effortNum === 3 ? 'Large' : '—',
      effortNum,
      tipo,
      completed:     !!t.completed,
      completedDate,
      completedAt:   completedAtRaw,
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TASK CATEGORIZATION
// ══════════════════════════════════════════════════════════════════════════════

const IN_PROGRESS_STATES = ['in progress', 'en progreso', 'doing', 'wip', 'working', 'en curso', 'iniciado'];

function inferInProgress(task) {
  if (!task.estado || task.estado === '—') return false;
  const v = task.estado.toLowerCase().trim();
  return IN_PROGRESS_STATES.some((s) => v.includes(s));
}

/**
 * Categorizes tasks into 4 mutually exclusive buckets.
 * @param {Array} tasks - Pre-filtered array (caller decides what to include)
 * @param {string} today - YYYY-MM-DD
 */
function categorizeTasks(tasks, today) {
  const completed  = tasks.filter((t) => t.completed === true);
  const incomplete = tasks.filter((t) => !t.completed);

  const inProgress = incomplete.filter((t) => inferInProgress(t));
  const inProgressSet = new Set(inProgress.map((t) => t.name));

  const overdue = incomplete.filter(
    (t) => !inProgressSet.has(t.name) && t.dueDate && t.dueDate < today
  );
  const overdueSet = new Set(overdue.map((t) => t.name));

  const planned = incomplete.filter(
    (t) => !inProgressSet.has(t.name) && !overdueSet.has(t.name)
  );

  return { completed, inProgress, overdue, planned };
}

// ══════════════════════════════════════════════════════════════════════════════
// METRICS CALCULATOR
// ══════════════════════════════════════════════════════════════════════════════

function calcMetrics(tasks, rangeStart, rangeEnd, today) {
  const inRange  = (d) => d && d >= rangeStart && d <= rangeEnd;
  const isWkday  = (d) => d && isWeekdayET(d);

  const completedInPeriod = tasks.filter(
    (t) => t.completed && inRange(t.completedDate) && isWkday(t.completedDate)
  );
  const pending = tasks.filter((t) => !t.completed);
  const overdue = pending.filter((t) => t.dueDate && t.dueDate < today);
  const inProgressTasks = pending.filter((t) => inferInProgress(t));

  // On-time compliance
  const withDue       = completedInPeriod.filter((t) => t.dueDate);
  const onTime        = withDue.filter((t) => t.completedDate <= t.dueDate);
  const sameDayComp   = withDue.filter((t) => t.completedDate === t.dueDate);
  const beforeDeadline= withDue.filter((t) => t.completedDate <  t.dueDate);
  const afterDeadline = withDue.filter((t) => t.completedDate >  t.dueDate);
  const onTimeRate    = withDue.length > 0 ? (onTime.length / withDue.length) * 100 : null;

  // Duration per task
  const durations = tasks
    .filter((t) => t.startDate && t.endDate && t.endDate >= t.startDate)
    .map((t) => ({ task: t, days: daysBetween(t.startDate, t.endDate) }))
    .filter((x) => x.days !== null);

  const avgDays = durations.length > 0
    ? durations.reduce((s, x) => s + x.days, 0) / durations.length
    : null;

  const sortedDur    = [...durations].sort((a, b) => b.days - a.days);
  const longestTask  = sortedDur[0]
    ? { name: sortedDur[0].task.name, days: sortedDur[0].days }
    : null;
  const shortestTask = sortedDur[sortedDur.length - 1]
    ? { name: sortedDur[sortedDur.length - 1].task.name, days: sortedDur[sortedDur.length - 1].days }
    : null;

  const totalDaysPeriod = completedInPeriod
    .filter((t) => t.startDate && t.endDate)
    .reduce((s, t) => s + (daysBetween(t.startDate, t.endDate) || 0), 0);

  // Avg tasks per workday
  const daysWithWork   = new Set(completedInPeriod.map((t) => t.completedDate)).size;
  const avgTasksPerDay = daysWithWork > 0 ? completedInPeriod.length / daysWithWork : 0;

  // Streak (consecutive weekdays going back from today with completions)
  const doneDates = new Set(
    tasks.filter((t) => t.completed && t.completedDate).map((t) => t.completedDate)
  );
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

  // Best / worst day in period
  const dailyCompCounts = {};
  completedInPeriod.forEach((t) => {
    if (!t.completedDate) return;
    dailyCompCounts[t.completedDate] = (dailyCompCounts[t.completedDate] || 0) + 1;
  });
  let bestDayInPeriod = null;
  let worstDayInPeriod = null;
  const dayEntries = Object.entries(dailyCompCounts);
  if (dayEntries.length > 0) {
    dayEntries.sort((a, b) => b[1] - a[1]);
    bestDayInPeriod  = { date: dayEntries[0][0],                    count: dayEntries[0][1] };
    worstDayInPeriod = { date: dayEntries[dayEntries.length - 1][0], count: dayEntries[dayEntries.length - 1][1] };
  }

  // Per-day breakdown (for weekly)
  const dailyBreakdown = {};
  completedInPeriod.forEach((t) => {
    if (!t.completedDate) return;
    if (!dailyBreakdown[t.completedDate]) dailyBreakdown[t.completedDate] = { completed: 0, tasks: [] };
    dailyBreakdown[t.completedDate].completed++;
    dailyBreakdown[t.completedDate].tasks.push(t);
  });

  // Tipo distributions
  const tipoAll = {};
  TIPOS.forEach((tp) => { tipoAll[tp] = 0; });
  tasks.forEach((t) => { tipoAll[t.tipo] = (tipoAll[t.tipo] || 0) + 1; });

  const tipoPeriod = {};
  TIPOS.forEach((tp) => { tipoPeriod[tp] = 0; });
  completedInPeriod.forEach((t) => { tipoPeriod[t.tipo]++; });

  const tipoOverdueCount = {};
  TIPOS.forEach((tp) => { tipoOverdueCount[tp] = 0; });
  overdue.forEach((t) => { tipoOverdueCount[t.tipo]++; });
  const mostDelayedTipo = TIPOS.reduce((a, b) =>
    tipoOverdueCount[a] >= tipoOverdueCount[b] ? a : b
  );

  // Priority distributions
  const priorityAll  = { High: 0, Medium: 0, Low: 0, '—': 0 };
  const priorityDone = { High: 0, Medium: 0, Low: 0 };
  tasks.forEach((t) => {
    priorityAll[t.prioridad] = (priorityAll[t.prioridad] || 0) + 1;
  });
  completedInPeriod.forEach((t) => {
    if (t.prioridad in priorityDone) priorityDone[t.prioridad]++;
  });
  const highOverdue      = overdue.filter((t) => t.prioridad === 'High');

  // Effort distribution
  const effortDist = { Small: 0, Medium: 0, Large: 0, '—': 0 };
  tasks.forEach((t) => { effortDist[t.effortLabel] = (effortDist[t.effortLabel] || 0) + 1; });
  const effortNums = tasks.map((t) => t.effortNum).filter((n) => n !== null);
  const avgEffort  = effortNums.length > 0
    ? effortNums.reduce((s, n) => s + n, 0) / effortNums.length
    : null;

  // Completion rate
  const completionRate = tasks.length > 0
    ? (completedInPeriod.length / tasks.length) * 100
    : null;

  const inProgressCount = inProgressTasks.length;

  return {
    total:              tasks.length,
    completedInPeriod:  completedInPeriod.length,
    completedTasks:     completedInPeriod,
    pendingCount:       pending.length,
    pendingTasks:       [...pending].sort((a, b) => ((a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1)),
    overdueCount:       overdue.length,
    overdueTasks:       [...overdue].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
    inProgressCount,
    inProgressTasks,
    onTimeRate,
    onTimeCount:        onTime.length,
    lateCount:          afterDeadline.length,
    completedBefore:    beforeDeadline.length,
    completedSameDay:   sameDayComp.length,
    completedAfter:     afterDeadline.length,
    avgDays:            avgDays !== null ? Number(avgDays.toFixed(1)) : null,
    totalDaysPeriod,
    longestTask,
    shortestTask,
    avgTasksPerDay:     Number(avgTasksPerDay.toFixed(1)),
    streak,
    tipoAll,
    tipoPeriod,
    tipoOverdueCount,
    mostDelayedTipo:    tipoOverdueCount[mostDelayedTipo] > 0 ? mostDelayedTipo : null,
    priorityAll,
    priorityDone,
    highOverdue:        highOverdue.length,
    highOverdueTasks:   highOverdue,
    effortDist,
    avgEffort:          avgEffort !== null ? Number(avgEffort.toFixed(1)) : null,
    completionRate,
    dailyBreakdown,
    bestDayInPeriod,
    worstDayInPeriod,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CRITICAL ALERTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns array of { level: 'red'|'yellow'|'green', assignee, taskName, message }
 */
function buildCriticalAlerts(nicoleMetrics, karenMetrics, nicoleTasksByAssignee, karenTasksByAssignee, today) {
  const alerts = [];
  const tomorrow = fmtDate((() => { const d = parseDate(today); d.setUTCDate(d.getUTCDate() + 1); return d; })());

  function processAssignee(metrics, assignee) {
    // Red: High priority overdue
    metrics.highOverdueTasks.forEach((t) => {
      alerts.push({
        level: 'red',
        assignee,
        taskName: t.name,
        message: `🔴 Tarea HIGH vencida hace ${daysBetween(t.dueDate, today) || 0}d — límite ${formatDateES(t.dueDate)}`,
      });
    });

    // Red: Tasks due today not completed
    const allTasks = assignee === 'Nicole Zapata' ? nicoleTasksByAssignee : karenTasksByAssignee;
    allTasks
      .filter((t) => !t.completed && t.dueDate === today)
      .forEach((t) => {
        alerts.push({
          level: 'red',
          assignee,
          taskName: t.name,
          message: `🔴 Vence HOY y no está completada — ${t.prioridad} prioridad`,
        });
      });

    // Yellow: Medium priority overdue
    metrics.overdueTasks
      .filter((t) => t.prioridad === 'Medium')
      .forEach((t) => {
        alerts.push({
          level: 'yellow',
          assignee,
          taskName: t.name,
          message: `🟡 Tarea MEDIUM vencida hace ${daysBetween(t.dueDate, today) || 0}d`,
        });
      });

    // Yellow: Tasks due tomorrow still pending
    allTasks
      .filter((t) => !t.completed && t.dueDate === tomorrow)
      .forEach((t) => {
        alerts.push({
          level: 'yellow',
          assignee,
          taskName: t.name,
          message: `🟡 Vence mañana y sigue pendiente — ${t.prioridad} prioridad`,
        });
      });

    // Green: Low priority overdue
    metrics.overdueTasks
      .filter((t) => t.prioridad === 'Low')
      .forEach((t) => {
        alerts.push({
          level: 'green',
          assignee,
          taskName: t.name,
          message: `🟢 Tarea LOW vencida hace ${daysBetween(t.dueDate, today) || 0}d`,
        });
      });
  }

  processAssignee(nicoleMetrics, 'Nicole Zapata');
  processAssignee(karenMetrics, 'Karen');
  return alerts;
}

// ══════════════════════════════════════════════════════════════════════════════
// WEEK LEADER SCORING
// ══════════════════════════════════════════════════════════════════════════════

function score100(nm, km) {
  const safe = (n, d) => (d > 0 ? n / d : 0);

  const maxComp       = Math.max(nm.completedInPeriod, km.completedInPeriod, 1);
  const nicoleVelocity= safe(nm.completedInPeriod, maxComp) * 35;
  const karenVelocity = safe(km.completedInPeriod, maxComp) * 35;

  const nicoleOnTime  = (nm.onTimeRate !== null ? nm.onTimeRate / 100 : 0.5) * 30;
  const karenOnTime   = (km.onTimeRate !== null ? km.onTimeRate / 100 : 0.5) * 30;

  const nicoleEffort  = (nm.avgEffort !== null ? nm.avgEffort / 5 : 0.5) * 20;
  const karenEffort   = (km.avgEffort !== null ? km.avgEffort / 5 : 0.5) * 20;

  const overdueBonus  = (m) => Math.max(0, 15 - m.overdueCount * 3);
  const nicoleOver    = overdueBonus(nm);
  const karenOver     = overdueBonus(km);

  const nicoleTotal   = nicoleVelocity + nicoleOnTime + nicoleEffort + nicoleOver;
  const karenTotal    = karenVelocity  + karenOnTime  + karenEffort  + karenOver;

  let leader = 'Empate';
  if (nicoleTotal - karenTotal > 3) leader = 'Nicole Zapata';
  else if (karenTotal - nicoleTotal > 3) leader = 'Karen';

  const reasons = [];
  if (nm.completedInPeriod !== km.completedInPeriod) {
    const more = nm.completedInPeriod > km.completedInPeriod ? 'Nicole' : 'Karen';
    reasons.push(`${more} completó más tareas en el período`);
  }
  if (
    nm.onTimeRate !== null &&
    km.onTimeRate !== null &&
    Math.abs(nm.onTimeRate - km.onTimeRate) > 5
  ) {
    const better = nm.onTimeRate > km.onTimeRate ? 'Nicole' : 'Karen';
    const val    = Math.max(nm.onTimeRate, km.onTimeRate);
    reasons.push(`${better} tuvo mejor tasa de cumplimiento (${val.toFixed(0)}%)`);
  }
  if (nm.overdueCount !== km.overdueCount) {
    const fewer = nm.overdueCount < km.overdueCount ? 'Nicole' : 'Karen';
    reasons.push(`${fewer} tuvo menos tareas vencidas`);
  }

  return {
    leader,
    nicoleScore: Math.round(nicoleTotal),
    karenScore:  Math.round(karenTotal),
    reasons:     reasons.slice(0, 3),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AI ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

async function generateAIAnalysis(reportType, nm, km) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const fmt    = (v, suf = '') => (v !== null && v !== undefined ? `${v}${suf}` : 'N/A');
    const tipoStr = (m) => TIPOS.map((t) => `${t}:${m.tipoAll[t]}`).join(', ');

    const prompt = `Eres el analista de productividad del equipo de marketing de JP Legacy Group.
Analiza los siguientes datos del equipo para el reporte ${reportType}:

NICOLE ZAPATA:
- Tareas completadas en período: ${nm.completedInPeriod}
- Total tareas asignadas: ${nm.total}
- Tasa de completación: ${nm.completionRate !== null ? nm.completionRate.toFixed(0) : 'N/A'}%
- Tasa de cumplimiento a tiempo: ${fmt(nm.onTimeRate !== null ? nm.onTimeRate.toFixed(0) : null, '%')}
- Antes del límite: ${nm.completedBefore} | Mismo día: ${nm.completedSameDay} | Después: ${nm.completedAfter}
- Tareas vencidas: ${nm.overdueCount} (High: ${nm.highOverdue})
- En progreso: ${nm.inProgressCount}
- Promedio días/tarea: ${fmt(nm.avgDays, 'd')}
- Promedio tareas/día: ${fmt(nm.avgTasksPerDay)}
- Racha actual: ${nm.streak} días
- Prioridades: High=${nm.priorityAll.High} Med=${nm.priorityAll.Medium} Low=${nm.priorityAll.Low}
- Tipos: ${tipoStr(nm)}
- Effort promedio: ${fmt(nm.avgEffort, '/5')}

KAREN:
- Tareas completadas en período: ${km.completedInPeriod}
- Total tareas asignadas: ${km.total}
- Tasa de completación: ${km.completionRate !== null ? km.completionRate.toFixed(0) : 'N/A'}%
- Tasa de cumplimiento a tiempo: ${fmt(km.onTimeRate !== null ? km.onTimeRate.toFixed(0) : null, '%')}
- Antes del límite: ${km.completedBefore} | Mismo día: ${km.completedSameDay} | Después: ${km.completedAfter}
- Tareas vencidas: ${km.overdueCount} (High: ${km.highOverdue})
- En progreso: ${km.inProgressCount}
- Promedio días/tarea: ${fmt(km.avgDays, 'd')}
- Promedio tareas/día: ${fmt(km.avgTasksPerDay)}
- Racha actual: ${km.streak} días
- Prioridades: High=${km.priorityAll.High} Med=${km.priorityAll.Medium} Low=${km.priorityAll.Low}
- Tipos: ${tipoStr(km)}
- Effort promedio: ${fmt(km.avgEffort, '/5')}

Proporciona en ESPAÑOL, breve y directo (máx 200 palabras):
1. **Colaboradora más productiva:** [nombre] — [razón en 1 oración con dato específico]
2. **Mejor cumplimiento:** [nombre] — [dato concreto]
3. **Cuellos de botella:** (2-3 bullets con los principales obstáculos detectados)
4. **Tipos con más retrasos:** (1-2 bullets sobre qué tipo de tarea genera más demoras)
5. **Días menos productivos:** [observación basada en datos]
6. **3-5 recomendaciones concretas y accionables para la próxima semana:** (bullets)

Usa los datos específicos del reporte. Sé directo y práctico.`;

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages:   [{ role: 'user', content: prompt }],
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

function divider() {
  return `<tr><td style="height:1px;background:#1A1A1A;padding:0;margin:0;font-size:0;line-height:0;"></td></tr>`;
}

function sectionHeader(icon, title, count) {
  const countStr = count !== undefined && count !== null ? ` (${count})` : '';
  return `<tr><td style="padding:8px 14px;background:#0D0D0D;border-top:1px solid #1A1A1A;">
  <span style="color:#888888;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">${icon} ${title}${countStr}</span>
</td></tr>`;
}

/** Colored alert rows at top of report */
function criticalAlertsBlock(alerts) {
  if (!alerts || alerts.length === 0) return '';
  const colorMap = { red: '#FF4444', yellow: '#FFD700', green: '#4CAF50' };
  const bgMap    = { red: '#1A0000', yellow: '#1A1400', green: '#001A00' };

  const rows = alerts.map((a) => {
    const color = colorMap[a.level] || '#888888';
    const bg    = bgMap[a.level]    || '#111111';
    return `<tr>
      <td style="padding:7px 14px;background:${bg};border-bottom:1px solid #1A1A1A;">
        <span style="color:${color};font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">${a.message}</span>
        <span style="color:#555555;font-size:10px;font-family:Arial,sans-serif;margin-left:8px;">— ${a.assignee}: ${a.taskName}</span>
      </td>
    </tr>`;
  }).join('');

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #2A1A1A;border-radius:6px;overflow:hidden;">
    <tr><td style="padding:7px 14px;background:#1A0A0A;border-bottom:1px solid #2A1A1A;">
      <span style="color:#FF4444;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;">🚨 Alertas Críticas (${alerts.length})</span>
    </td></tr>
    ${rows}
  </table>
</td></tr><tr><td style="height:10px;"></td></tr>`;
}

function statBoxRow(stats) {
  const cells = stats.map((s, i) => `
  <td align="center" style="padding:12px 8px;${i > 0 ? 'border-left:1px solid #1E1E1E;' : ''}">
    <div style="color:${s.color || '#FFFFFF'};font-size:26px;font-weight:bold;font-family:Arial,sans-serif;">${s.value !== null && s.value !== undefined ? s.value : '—'}</div>
    <div style="color:#444444;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">${s.label}</div>
  </td>`).join('');
  return `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0F0F;border:1px solid #1E1E1E;border-radius:8px;">
      <tr>${cells}</tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`;
}

function priorityBadge(prioridad) {
  const color = PRIORITY_COLORS[prioridad] || '#888888';
  const bg    = prioridad === 'High'   ? '#2A0000'
              : prioridad === 'Medium' ? '#1A1400'
              : prioridad === 'Low'    ? '#001A2A'
              : '#111111';
  return `<span style="background:${bg};color:${color};padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">${prioridad || '—'}</span>`;
}

function effortBadge(effortLabel) {
  const color = effortLabel === 'Large' ? '#FF6B35'
              : effortLabel === 'Medium' ? '#FFD700'
              : effortLabel === 'Small' ? '#4CAF50'
              : '#555555';
  return `<span style="color:${color};font-size:10px;font-family:Arial,sans-serif;">${effortLabel || '—'}</span>`;
}

function tipoBadge(tipo) {
  return `<span style="color:#888888;font-size:10px;font-family:Arial,sans-serif;">${TIPO_ICONS[tipo] || '📌'} ${tipo || 'Otros'}</span>`;
}

// ── Task Detail Cards ─────────────────────────────────────────────────────────

function completedTaskRow(task) {
  const dur       = daysBetween(task.startDate, task.endDate);
  const durFromAt = task.completedAt && task.startDate
    ? daysBetween(task.startDate, dateKeyET(new Date(task.completedAt)))
    : null;
  const durDisplay= dur !== null ? `${dur}d` : (durFromAt !== null ? `~${durFromAt}d` : '—');

  let badge = '';
  if (task.dueDate && task.completedDate) {
    if (task.completedDate < task.dueDate)  badge = `<span style="background:#0A1A0A;color:#4CAF50;padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">✅ antes de tiempo</span>`;
    else if (task.completedDate === task.dueDate) badge = `<span style="background:#1A1400;color:#FFD700;padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">✅ a tiempo</span>`;
    else badge = `<span style="background:#2A0000;color:#FF4444;padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">⏰ tarde</span>`;
  }

  const timeStr = task.completedAt ? formatTimeET(task.completedAt) : '—';
  const startStr= task.startDate ? shortDate(task.startDate) : '—';

  return `<tr>
    <td style="padding:8px 12px;background:#080F08;border-bottom:1px solid #0F1A0F;">
      <div style="font-weight:bold;color:#FFFFFF;font-size:12px;font-family:Arial,sans-serif;margin-bottom:4px;">${task.name}</div>
      <table cellpadding="0" cellspacing="0" style="margin-bottom:4px;"><tr>
        <td style="padding-right:8px;">${tipoBadge(task.tipo)}</td>
        <td style="padding-right:8px;">${priorityBadge(task.prioridad)}</td>
        <td>${effortBadge(task.effortLabel)}</td>
      </tr></table>
      <div style="color:#555555;font-size:10px;font-family:Arial,sans-serif;">
        Inicio: ${startStr} &nbsp;|&nbsp; Fin: ${timeStr} &nbsp;|&nbsp; Duración: ${durDisplay} &nbsp;|&nbsp; ${badge}
      </div>
    </td>
  </tr>`;
}

function inProgressTaskRow(task, today) {
  const daysLeft   = task.dueDate ? daysBetween(today, task.dueDate) : null;
  const elapsed    = task.startDate ? daysBetween(task.startDate, today) : null;

  let statusBadge = '';
  if (task.dueDate) {
    if (task.dueDate < today) {
      statusBadge = `<span style="background:#2A0000;color:#FF4444;padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">🔴 excedida</span>`;
    } else if (daysLeft !== null && daysLeft <= 2) {
      statusBadge = `<span style="background:#1A1000;color:#FFD700;padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">⚠️ en riesgo</span>`;
    } else {
      statusBadge = `<span style="background:#0A1A0A;color:#4CAF50;padding:2px 7px;border-radius:10px;font-size:10px;font-family:Arial,sans-serif;">✅ dentro del tiempo</span>`;
    }
  }

  return `<tr>
    <td style="padding:8px 12px;background:#0A0A10;border-bottom:1px solid #141420;">
      <div style="font-weight:bold;color:#FFFFFF;font-size:12px;font-family:Arial,sans-serif;margin-bottom:4px;">${task.name}</div>
      <table cellpadding="0" cellspacing="0" style="margin-bottom:4px;"><tr>
        <td style="padding-right:8px;">${tipoBadge(task.tipo)}</td>
        <td style="padding-right:8px;">${priorityBadge(task.prioridad)}</td>
        <td>Esfuerzo estimado: ${effortBadge(task.effortLabel)}</td>
      </tr></table>
      <div style="color:#555555;font-size:10px;font-family:Arial,sans-serif;">
        Fecha límite: ${formatDateES(task.dueDate)}
        &nbsp;|&nbsp; Días restantes: ${daysLeft !== null ? daysLeft : '—'}
        &nbsp;|&nbsp; ${statusBadge}
        ${elapsed !== null ? `&nbsp;|&nbsp; Transcurrido: ${elapsed}d` : ''}
      </div>
    </td>
  </tr>`;
}

function overdueTaskRow(task, today) {
  const daysLate  = task.dueDate ? daysBetween(task.dueDate, today) : null;
  const alertColor= task.prioridad === 'High'   ? '#FF4444'
                  : task.prioridad === 'Medium' ? '#FFD700'
                  : '#4CAF50';
  const alertBg   = task.prioridad === 'High'   ? '#1A0000'
                  : task.prioridad === 'Medium' ? '#141000'
                  : '#001A00';
  const alertIcon = task.prioridad === 'High' ? '🔴' : task.prioridad === 'Medium' ? '🟡' : '🟢';

  return `<tr>
    <td style="padding:8px 12px;background:${alertBg};border-bottom:1px solid #1A0A0A;">
      <div style="margin-bottom:4px;">
        <span style="color:${alertColor};font-size:11px;font-weight:bold;font-family:Arial,sans-serif;">${alertIcon} ${task.name}</span>
      </div>
      <table cellpadding="0" cellspacing="0" style="margin-bottom:4px;"><tr>
        <td style="padding-right:8px;">${tipoBadge(task.tipo)}</td>
        <td>${priorityBadge(task.prioridad)}</td>
      </tr></table>
      <div style="color:#555555;font-size:10px;font-family:Arial,sans-serif;">
        Fecha límite: ${formatDateES(task.dueDate)}
        &nbsp;|&nbsp; Días de retraso: <span style="color:${alertColor};font-weight:bold;">${daysLate !== null ? daysLate : '—'}</span>
      </div>
    </td>
  </tr>`;
}

function plannedTaskRow(task, today) {
  const daysLeft = task.dueDate ? daysBetween(today, task.dueDate) : null;
  const dueToday = task.dueDate === today;

  return `<tr>
    <td style="padding:8px 12px;background:#0A0A0A;border-bottom:1px solid #141414;">
      <div style="font-weight:bold;color:#CCCCCC;font-size:12px;font-family:Arial,sans-serif;margin-bottom:4px;">
        ${task.name}${dueToday ? ' <span style="color:#FFD700;font-size:10px;font-family:Arial,sans-serif;">🔔 Vence hoy</span>' : ''}
      </div>
      <table cellpadding="0" cellspacing="0" style="margin-bottom:4px;"><tr>
        <td style="padding-right:8px;">${tipoBadge(task.tipo)}</td>
        <td style="padding-right:8px;">${priorityBadge(task.prioridad)}</td>
        <td>Esfuerzo: ${effortBadge(task.effortLabel)}</td>
      </tr></table>
      <div style="color:#555555;font-size:10px;font-family:Arial,sans-serif;">
        Fecha límite: ${formatDateES(task.dueDate)}
        &nbsp;|&nbsp; Días restantes: ${daysLeft !== null ? daysLeft : '—'}
      </div>
    </td>
  </tr>`;
}

// ── Metrics Block ─────────────────────────────────────────────────────────────

function metricsBlock(metrics, label) {
  const m         = metrics;
  const onTimeStr = m.onTimeRate !== null ? `${m.onTimeRate.toFixed(0)}%` : '—';
  const avgDayStr = m.avgDays !== null ? `${m.avgDays}d` : '—';
  const compRate  = m.completionRate !== null ? `${m.completionRate.toFixed(0)}%` : '—';
  const pendRate  = m.total > 0 ? `${(((m.total - m.completedInPeriod) / m.total) * 100).toFixed(0)}%` : '—';
  const ovdRate   = m.total > 0 ? `${((m.overdueCount / m.total) * 100).toFixed(0)}%` : '—';
  const longest   = m.longestTask  ? `${m.longestTask.name.slice(0, 28)}${m.longestTask.name.length > 28 ? '…' : ''} ${m.longestTask.days}d` : '—';
  const shortest  = m.shortestTask ? `${m.shortestTask.name.slice(0, 28)}${m.shortestTask.name.length > 28 ? '…' : ''} ${m.shortestTask.days}d` : '—';

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#080808;border:1px solid #1A1A1A;border-radius:6px;overflow:hidden;">
    <tr><td style="padding:7px 12px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;">📈 MÉTRICAS ${label}</span>
    </td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #141414;">
      <span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Total asignadas: <b style="color:#FFF;">${m.total}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Completadas: <b style="color:#4CAF50;">${m.completedInPeriod} (${compRate})</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">En progreso: <b style="color:#4FC3F7;">${m.inProgressCount}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">No completadas: <b style="color:#FFD700;">${m.pendingCount} (${pendRate})</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Vencidas: <b style="color:${m.overdueCount > 0 ? '#FF4444' : '#555'}">${m.overdueCount} (${ovdRate})</b></span>
    </td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #141414;">
      <span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Tiempo total: <b style="color:#C9A84C;">${m.totalDaysPeriod}d</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Promedio/tarea: <b style="color:#C9A84C;">${avgDayStr}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Más larga: <b style="color:#FF6B35;">${longest}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Más corta: <b style="color:#4CAF50;">${shortest}</b></span>
    </td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #141414;">
      <span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Tasa a tiempo: <b style="color:${m.onTimeRate !== null && m.onTimeRate >= 70 ? '#4CAF50' : '#FF6B35'}">${onTimeStr}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Antes del límite: <b style="color:#4CAF50;">${m.completedBefore}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">El mismo día: <b style="color:#FFD700;">${m.completedSameDay}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Después: <b style="color:${m.completedAfter > 0 ? '#FF4444' : '#555'}">${m.completedAfter}</b></span>
    </td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #141414;">
      <span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Racha actual: <b style="color:#FF9800;">${m.streak > 0 ? `🔥${m.streak} días` : '—'}</b></span>
      &nbsp;|&nbsp;<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;">Prom tareas/día: <b style="color:#C9A84C;">${m.avgTasksPerDay}</b></span>
    </td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #141414;">
      <span style="color:#555;font-size:10px;font-family:Arial,sans-serif;">Tipos: </span>
      ${TIPOS.map((t) => `<span style="color:#888;font-size:10px;font-family:Arial,sans-serif;">${t} <b style="color:#FFF;">${m.tipoAll[t] || 0}</b></span>`).join(' &nbsp;|&nbsp; ')}
    </td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #141414;">
      <span style="color:#555;font-size:10px;font-family:Arial,sans-serif;">Prioridad: </span>
      <span style="color:#FF4444;font-size:10px;font-family:Arial,sans-serif;">High <b>${m.priorityAll.High}</b></span>
      &nbsp;|&nbsp;<span style="color:#FFD700;font-size:10px;font-family:Arial,sans-serif;">Medium <b>${m.priorityAll.Medium}</b></span>
      &nbsp;|&nbsp;<span style="color:#4FC3F7;font-size:10px;font-family:Arial,sans-serif;">Low <b>${m.priorityAll.Low}</b></span>
    </td></tr>
    <tr><td style="padding:8px 12px;">
      <span style="color:#555;font-size:10px;font-family:Arial,sans-serif;">Effort: </span>
      <span style="color:#4CAF50;font-size:10px;font-family:Arial,sans-serif;">Small <b>${m.effortDist.Small}</b></span>
      &nbsp;|&nbsp;<span style="color:#FFD700;font-size:10px;font-family:Arial,sans-serif;">Medium <b>${m.effortDist.Medium}</b></span>
      &nbsp;|&nbsp;<span style="color:#FF6B35;font-size:10px;font-family:Arial,sans-serif;">Large <b>${m.effortDist.Large}</b></span>
    </td></tr>
  </table>
</td></tr><tr><td style="height:8px;"></td></tr>`;
}

// ── AI Block ──────────────────────────────────────────────────────────────────

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

// ── Comparison Row Helper ─────────────────────────────────────────────────────

function cmpRow(label, nVal, kVal, higherBetter = true, unit = '') {
  const n = typeof nVal === 'number' ? nVal : parseFloat(nVal);
  const k = typeof kVal === 'number' ? kVal : parseFloat(kVal);
  let nWin = false, kWin = false;
  if (!isNaN(n) && !isNaN(k) && n !== k) {
    nWin = higherBetter ? n > k : n < k;
    kWin = !nWin;
  }
  const fmt = (v, win) => {
    const display = typeof v === 'number'
      ? (Number.isInteger(v) ? v : v.toFixed(1))
      : (v !== null && v !== undefined ? v : '—');
    const color = win ? '#4CAF50' : '#888888';
    const bg    = win ? 'background:#081408;' : '';
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
    cmpRow('Tareas completadas',       nm.completedInPeriod,  km.completedInPeriod,  true),
    cmpRow('Tasa de cumplimiento',     nm.onTimeRate !== null ? nm.onTimeRate.toFixed(0) : null, km.onTimeRate !== null ? km.onTimeRate.toFixed(0) : null, true, '%'),
    cmpRow('Tasa de completación',     nm.completionRate !== null ? nm.completionRate.toFixed(0) : null, km.completionRate !== null ? km.completionRate.toFixed(0) : null, true, '%'),
    cmpRow('Días promedio/tarea',      nm.avgDays,            km.avgDays,            false, 'd'),
    cmpRow('Tareas/día',               nm.avgTasksPerDay,     km.avgTasksPerDay,     true),
    cmpRow('Racha actual (días)',       nm.streak,             km.streak,             true),
    cmpRow('Tareas High completadas',  nm.priorityDone.High,  km.priorityDone.High,  true),
    cmpRow('Tareas High vencidas',     nm.highOverdue,        km.highOverdue,        false),
    cmpRow('Tareas vencidas total',    nm.overdueCount,       km.overdueCount,       false),
    cmpRow('Effort promedio',          nm.avgEffort,          km.avgEffort,          true, '/5'),
    cmpRow('En progreso',              nm.inProgressCount,    km.inProgressCount,    false),
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
// PER-COLLABORATOR SECTIONS
// ══════════════════════════════════════════════════════════════════════════════

/** Daily assignee section: shows yesterday completions + today plan */
function dailyAssigneeSection(assignee, tasks, yesterday, today) {
  const headerColor = assignee === 'Nicole Zapata' ? '#C9A84C' : '#4FC3F7';
  const cats        = categorizeTasks(tasks, today);

  const completedYesterday = cats.completed.filter((t) => t.completedDate === yesterday);
  const completedToday     = cats.completed.filter((t) => t.completedDate === today);
  const plannedToday       = cats.planned.filter((t) => !t.dueDate || t.dueDate >= today);

  const metrics = calcMetrics(tasks, yesterday, today, today);

  const yesterdaySeparator = `<tr><td style="padding:6px 14px;background:#0D0D0D;border-top:1px solid #1A1A1A;border-bottom:1px solid #1A1A1A;">
    <span style="color:#555555;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">── AYER ${formatDateES(yesterday)} ──</span>
  </td></tr>`;

  const todaySeparator = `<tr><td style="padding:6px 14px;background:#0D0D0D;border-top:1px solid #1A1A1A;border-bottom:1px solid #1A1A1A;">
    <span style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">── HOY ${formatDateES(today)} ──</span>
  </td></tr>`;

  const buildSection = (title, rows, emptyMsg) => {
    if (rows.length === 0) {
      return `<tr><td style="padding:4px 14px;background:#080808;border-bottom:1px solid #141414;">
        <span style="color:#333;font-size:10px;font-style:italic;font-family:Arial,sans-serif;">${emptyMsg}</span>
      </td></tr>`;
    }
    return rows.join('');
  };

  const body = `
    <tr><td style="padding:12px 14px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:${headerColor};font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">👤 ${assignee}</span>
      <span style="color:#333;font-size:10px;font-family:Arial,sans-serif;margin-left:10px;">${tasks.length} tareas asignadas</span>
    </td></tr>
    ${yesterdaySeparator}
    ${sectionHeader('✅', 'Completadas ayer', completedYesterday.length)}
    ${buildSection('Completadas ayer', completedYesterday.map((t) => completedTaskRow(t)), 'Sin tareas completadas ayer.')}
    ${sectionHeader('⚙️', 'En Progreso', cats.inProgress.length)}
    ${buildSection('En Progreso', cats.inProgress.map((t) => inProgressTaskRow(t, today)), 'Sin tareas en progreso.')}
    ${cats.overdue.length > 0 ? sectionHeader('🔴', 'Vencidas', cats.overdue.length) : ''}
    ${cats.overdue.length > 0 ? buildSection('Vencidas', cats.overdue.map((t) => overdueTaskRow(t, today)), '') : ''}
    ${todaySeparator}
    ${sectionHeader('✅', 'Completadas hoy', completedToday.length)}
    ${buildSection('Completadas hoy', completedToday.map((t) => completedTaskRow(t)), 'Sin tareas completadas hoy aún.')}
    ${sectionHeader('📋', 'Planificadas / Pendientes hoy', plannedToday.length)}
    ${buildSection('Planificadas', plannedToday.map((t) => plannedTaskRow(t, today)), 'Sin tareas planificadas para hoy.')}
  `;

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    ${body}
    <tr><td style="padding:10px 14px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${metricsBlock(metrics, `${assignee.split(' ')[0].toUpperCase()}`)}
      </table>
    </td></tr>
  </table>
</td></tr><tr><td style="height:12px;"></td></tr>`;
}

/** Weekly assignee section: per-day breakdown Mon-Fri + weekly metrics */
function weeklyAssigneeSection(assignee, tasks, weekRange, today) {
  const headerColor = assignee === 'Nicole Zapata' ? '#C9A84C' : '#4FC3F7';
  const cats        = categorizeTasks(tasks, today);
  const metrics     = calcMetrics(tasks, weekRange.start, weekRange.end, today);

  // Build day date keys for the week
  const dayKeys = [];
  const startD  = parseDate(weekRange.start);
  for (let i = 0; i < 5; i++) {
    const d = new Date(startD);
    d.setUTCDate(startD.getUTCDate() + i);
    dayKeys.push(fmtDate(d));
  }

  let dayRows = '';
  dayKeys.forEach((dk) => {
    const dayLabel = formatDateES(dk).toUpperCase();
    const completedThatDay = cats.completed.filter((t) => t.completedDate === dk);
    const dayHdr = `<tr><td style="padding:5px 14px;background:#111111;border-top:1px solid #1A1A1A;border-bottom:1px solid #1A1A1A;">
      <span style="color:#888888;font-size:9px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">📆 ${dayLabel}</span>
    </td></tr>`;
    dayRows += dayHdr;
    if (completedThatDay.length > 0) {
      dayRows += completedThatDay.map((t) => completedTaskRow(t)).join('');
    } else {
      dayRows += `<tr><td style="padding:5px 14px;background:#080808;border-bottom:1px solid #141414;">
        <span style="color:#2A2A2A;font-size:10px;font-style:italic;font-family:Arial,sans-serif;">Sin completaciones este día.</span>
      </td></tr>`;
    }
  });

  // In progress, overdue for the week
  const inProgSection = cats.inProgress.length > 0
    ? sectionHeader('⚙️', 'En Progreso', cats.inProgress.length) +
      cats.inProgress.map((t) => inProgressTaskRow(t, today)).join('')
    : '';
  const ovdSection = cats.overdue.length > 0
    ? sectionHeader('🔴', 'Vencidas', cats.overdue.length) +
      cats.overdue.map((t) => overdueTaskRow(t, today)).join('')
    : '';

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:12px 14px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:${headerColor};font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">👤 ${assignee}</span>
      <span style="color:#333;font-size:10px;font-family:Arial,sans-serif;margin-left:10px;">${tasks.length} tareas asignadas</span>
    </td></tr>
    ${sectionHeader('📅', 'Completadas por Día', metrics.completedInPeriod)}
    ${dayRows}
    ${inProgSection}
    ${ovdSection}
    <tr><td style="padding:10px 14px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${metricsBlock(metrics, `SEMANA — ${assignee.split(' ')[0].toUpperCase()}`)}
      </table>
    </td></tr>
  </table>
</td></tr><tr><td style="height:12px;"></td></tr>`;
}

/** Monthly assignee section: per-week breakdown + monthly metrics */
function monthlyAssigneeSection(assignee, tasks, monthRange, today) {
  const headerColor = assignee === 'Nicole Zapata' ? '#C9A84C' : '#4FC3F7';
  const cats        = categorizeTasks(tasks, today);
  const metrics     = calcMetrics(tasks, monthRange.start, monthRange.end, today);
  const weeks       = weeksInRange(monthRange.start, monthRange.end);

  let weekRows = '';
  weeks.forEach((w) => {
    const weekMetrics = calcMetrics(tasks, w.start, w.end, today);
    const completedThisWeek = cats.completed.filter(
      (t) => t.completedDate >= w.start && t.completedDate <= w.end
    );
    weekRows += `<tr><td style="padding:5px 14px;background:#111111;border-top:1px solid #1A1A1A;border-bottom:1px solid #1A1A1A;">
      <span style="color:#888888;font-size:9px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">📆 SEMANA ${w.label}</span>
      <span style="color:#C9A84C;font-size:10px;font-family:Arial,sans-serif;margin-left:10px;">${weekMetrics.completedInPeriod} completadas</span>
      ${weekMetrics.overdueCount > 0 ? `<span style="color:#FF4444;font-size:10px;font-family:Arial,sans-serif;margin-left:6px;">· ${weekMetrics.overdueCount} vencidas</span>` : ''}
    </td></tr>`;
    if (completedThisWeek.length > 0) {
      weekRows += completedThisWeek.slice(0, 5).map((t) => completedTaskRow(t)).join('');
      if (completedThisWeek.length > 5) {
        weekRows += `<tr><td style="padding:4px 14px;background:#080808;border-bottom:1px solid #141414;">
          <span style="color:#2A2A2A;font-size:10px;font-family:Arial,sans-serif;">+ ${completedThisWeek.length - 5} más esta semana</span>
        </td></tr>`;
      }
    } else {
      weekRows += `<tr><td style="padding:5px 14px;background:#080808;border-bottom:1px solid #141414;">
        <span style="color:#2A2A2A;font-size:10px;font-style:italic;font-family:Arial,sans-serif;">Sin completaciones esta semana.</span>
      </td></tr>`;
    }
  });

  const ovdSection = cats.overdue.length > 0
    ? sectionHeader('🔴', 'Vencidas este mes', cats.overdue.length) +
      cats.overdue.map((t) => overdueTaskRow(t, today)).join('')
    : '';

  return `<tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:12px 14px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:${headerColor};font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">👤 ${assignee}</span>
      <span style="color:#333;font-size:10px;font-family:Arial,sans-serif;margin-left:10px;">${tasks.length} tareas asignadas</span>
    </td></tr>
    ${sectionHeader('📅', 'Completadas por Semana', metrics.completedInPeriod)}
    ${weekRows}
    ${ovdSection}
    <tr><td style="padding:10px 14px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${metricsBlock(metrics, `MES — ${assignee.split(' ')[0].toUpperCase()}`)}
      </table>
    </td></tr>
  </table>
</td></tr><tr><td style="height:12px;"></td></tr>`;
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
  const today     = todayET();
  const yesterday = yesterdayET();
  const tasks     = await fetchAndNormalize();
  const byAssignee= splitByTeam(tasks);

  const nicole = calcMetrics(byAssignee['Nicole Zapata'], yesterday, today, today);
  const karen  = calcMetrics(byAssignee['Karen'],         yesterday, today, today);

  const alerts = buildCriticalAlerts(
    nicole, karen,
    byAssignee['Nicole Zapata'],
    byAssignee['Karen'],
    today
  );

  const aiText = await generateAIAnalysis('diario', nicole, karen);
  return { today, yesterday, byAssignee, metrics: { nicole, karen }, alerts, totalTasks: tasks.length, aiText };
}

async function buildWeeklyData() {
  const today     = todayET();
  const weekRange = previousWeekRangeET();
  const tasks     = await fetchAndNormalize();
  const byAssignee= splitByTeam(tasks);

  const nicole = calcMetrics(byAssignee['Nicole Zapata'], weekRange.start, weekRange.end, today);
  const karen  = calcMetrics(byAssignee['Karen'],         weekRange.start, weekRange.end, today);

  const alerts = buildCriticalAlerts(
    nicole, karen,
    byAssignee['Nicole Zapata'],
    byAssignee['Karen'],
    today
  );

  const leaderResult = score100(nicole, karen);
  const aiText       = await generateAIAnalysis('semanal', nicole, karen);
  return { today, weekRange, byAssignee, metrics: { nicole, karen }, leaderResult, alerts, totalTasks: tasks.length, aiText };
}

async function buildMonthlyData() {
  const today      = todayET();
  const monthRange = previousMonthRangeET();
  const tasks      = await fetchAndNormalize();
  const byAssignee = splitByTeam(tasks);

  const nicole = calcMetrics(byAssignee['Nicole Zapata'], monthRange.start, monthRange.end, today);
  const karen  = calcMetrics(byAssignee['Karen'],         monthRange.start, monthRange.end, today);

  const weeks = weeksInRange(monthRange.start, monthRange.end);
  const weeklyTrends = weeks.map((w) => ({
    label:  w.label,
    nicole: calcMetrics(byAssignee['Nicole Zapata'], w.start, w.end, today).completedInPeriod,
    karen:  calcMetrics(byAssignee['Karen'],         w.start, w.end, today).completedInPeriod,
  }));

  const alerts = buildCriticalAlerts(
    nicole, karen,
    byAssignee['Nicole Zapata'],
    byAssignee['Karen'],
    today
  );

  const leaderResult = score100(nicole, karen);
  const aiText       = await generateAIAnalysis('mensual', nicole, karen);
  return { today, monthRange, byAssignee, metrics: { nicole, karen }, leaderResult, weeklyTrends, alerts, totalTasks: tasks.length, aiText };
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

function buildDailyHTML(data) {
  const { today, yesterday, metrics: { nicole, karen }, byAssignee, alerts, totalTasks, aiText } = data;
  const totalOverdue    = nicole.overdueCount + karen.overdueCount;
  const totalCompleted  = nicole.completedInPeriod + karen.completedInPeriod;
  const totalInProgress = nicole.inProgressCount + karen.inProgressCount;
  const totalPlanned    = byAssignee['Nicole Zapata'].filter((t) => !t.completed && t.dueDate === today).length
                        + byAssignee['Karen'].filter((t) => !t.completed && t.dueDate === today).length;

  const teamSummary = statBoxRow([
    { value: totalTasks,      label: 'Total proyecto',      color: '#FFFFFF' },
    { value: totalCompleted,  label: 'Completadas ayer',    color: '#4CAF50' },
    { value: totalInProgress, label: 'En progreso',         color: '#4FC3F7' },
    { value: totalOverdue,    label: 'Vencidas',            color: totalOverdue > 0 ? '#FF4444' : '#555555' },
    { value: totalPlanned,    label: 'Planificadas hoy',    color: '#FFD700' },
  ]);

  // Quick Nicole vs Karen daily comparison
  const nWins = nicole.completedInPeriod > karen.completedInPeriod;
  const kWins = karen.completedInPeriod  > nicole.completedInPeriod;
  const quickCompare = `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
      <tr><td colspan="2" style="padding:8px 14px;border-bottom:1px solid #141414;">
        <span style="color:#888888;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">⚔️ Comparativo del Día</span>
      </td></tr>
      <tr>
        <td style="padding:14px;text-align:center;border-right:1px solid #141414;background:${nWins ? '#081408' : '#0A0A0A'};">
          <div style="color:#C9A84C;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">NICOLE ZAPATA</div>
          <div style="color:${nWins ? '#4CAF50' : '#888888'};font-size:30px;font-weight:bold;font-family:Arial,sans-serif;">${nicole.completedInPeriod}${nWins ? ' 🏆' : ''}</div>
          <div style="color:#444444;font-size:9px;font-family:Arial,sans-serif;">completadas · ${nicole.overdueCount} vencidas · ${nicole.inProgressCount} en progreso</div>
        </td>
        <td style="padding:14px;text-align:center;background:${kWins ? '#081408' : '#0A0A0A'};">
          <div style="color:#4FC3F7;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">KAREN</div>
          <div style="color:${kWins ? '#4CAF50' : '#888888'};font-size:30px;font-weight:bold;font-family:Arial,sans-serif;">${karen.completedInPeriod}${kWins ? ' 🏆' : ''}</div>
          <div style="color:#444444;font-size:9px;font-family:Arial,sans-serif;">completadas · ${karen.overdueCount} vencidas · ${karen.inProgressCount} en progreso</div>
        </td>
      </tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`;

  const body = [
    htmlHeader(
      '📅 Reporte Diario Marketing',
      `${formatDateES(today)} · America/New_York`
    ),
    criticalAlertsBlock(alerts),
    `<tr><td><table width="100%" cellpadding="0" cellspacing="0">${teamSummary}</table></td></tr>`,
    `<tr><td style="height:6px;"></td></tr>`,
    quickCompare,
    dailyAssigneeSection('Nicole Zapata', byAssignee['Nicole Zapata'], yesterday, today),
    dailyAssigneeSection('Karen',         byAssignee['Karen'],         yesterday, today),
    aiBlock(aiText),
  ].join('');

  return htmlWrap(body);
}

function buildWeeklyHTML(data) {
  const { today, weekRange, metrics: { nicole, karen }, byAssignee, leaderResult, alerts, totalTasks, aiText } = data;
  const totalOverdue   = nicole.overdueCount + karen.overdueCount;
  const totalCompleted = nicole.completedInPeriod + karen.completedInPeriod;
  const avgOnTime      = [nicole.onTimeRate, karen.onTimeRate].filter((n) => n !== null);
  const avgOnTimeStr   = avgOnTime.length > 0
    ? `${(avgOnTime.reduce((s, n) => s + n, 0) / avgOnTime.length).toFixed(0)}%`
    : '—';

  const teamSummary = statBoxRow([
    { value: totalCompleted, label: 'Completadas semana', color: '#4CAF50' },
    { value: avgOnTimeStr,   label: 'Cumplimiento prom.',  color: '#C9A84C' },
    { value: totalOverdue,   label: 'Vencidas',            color: totalOverdue > 0 ? '#FF4444' : '#555555' },
    { value: totalTasks,     label: 'Total proyecto',      color: '#FFFFFF' },
  ]);

  const body = [
    htmlHeader(
      '📊 Reporte Semanal Marketing',
      `Semana del ${formatDateES(weekRange.start)} al ${formatDateES(weekRange.end)}`
    ),
    criticalAlertsBlock(alerts),
    `<tr><td><table width="100%" cellpadding="0" cellspacing="0">${teamSummary}</table></td></tr>`,
    `<tr><td style="height:8px;"></td></tr>`,
    weeklyAssigneeSection('Nicole Zapata', byAssignee['Nicole Zapata'], weekRange, today),
    weeklyAssigneeSection('Karen',         byAssignee['Karen'],         weekRange, today),
    comparisonSection(nicole, karen, leaderResult),
    aiBlock(aiText),
  ].join('');

  return htmlWrap(body);
}

function buildMonthlyHTML(data) {
  const { today, monthRange, metrics: { nicole, karen }, byAssignee, leaderResult, weeklyTrends, alerts, totalTasks, aiText } = data;
  const { leader, nicoleScore, karenScore } = leaderResult;
  const totalCompleted = nicole.completedInPeriod + karen.completedInPeriod;
  const totalOverdue   = nicole.overdueCount + karen.overdueCount;

  const teamSummary = statBoxRow([
    { value: totalCompleted,           label: 'Completadas mes',  color: '#4CAF50' },
    { value: nicole.completedInPeriod, label: 'Nicole',           color: '#C9A84C' },
    { value: karen.completedInPeriod,  label: 'Karen',            color: '#4FC3F7' },
    { value: totalOverdue,             label: 'Vencidas',         color: totalOverdue > 0 ? '#FF4444' : '#555555' },
    { value: totalTasks,               label: 'Total proyecto',   color: '#FFFFFF' },
  ]);

  const trendRows = weeklyTrends.map((w) =>
    `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #141414;color:#888888;font-size:11px;font-family:Arial,sans-serif;">${w.label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #141414;text-align:center;color:#C9A84C;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${w.nicole}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #141414;text-align:center;color:#4FC3F7;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${w.karen}</td>
    </tr>`
  ).join('');

  const trendsSection = weeklyTrends.length > 0
    ? `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
      <tr><td colspan="3" style="padding:8px 14px;border-bottom:1px solid #141414;">
        <span style="color:#888888;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">📈 Tendencia Semanal del Mes</span>
      </td></tr>
      <tr>
        <td style="padding:5px 12px;border-bottom:1px solid #141414;color:#2A2A2A;font-size:9px;font-family:Arial,sans-serif;">SEMANA</td>
        <td style="padding:5px 12px;border-bottom:1px solid #141414;color:#C9A84C;font-size:9px;font-family:Arial,sans-serif;text-align:center;">NICOLE</td>
        <td style="padding:5px 12px;border-bottom:1px solid #141414;color:#4FC3F7;font-size:9px;font-family:Arial,sans-serif;text-align:center;">KAREN</td>
      </tr>
      ${trendRows}
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`
    : '';

  // Collaboradora del Mes banner
  const mesLeaderBanner = leader !== 'Empate'
    ? `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(#0D1208,#081408);border:2px solid #C9A84C;border-radius:8px;">
      <tr><td style="padding:20px;text-align:center;">
        <div style="color:#C9A84C;font-size:11px;letter-spacing:4px;text-transform:uppercase;font-family:Arial,sans-serif;">🏆 COLABORADORA DEL MES</div>
        <div style="color:#FFFFFF;font-size:26px;font-weight:bold;margin:10px 0;font-family:Arial,sans-serif;">${leader}</div>
        <div style="color:#555555;font-size:11px;font-family:Arial,sans-serif;">Nicole ${nicoleScore} pts — Karen ${karenScore} pts</div>
        <div style="color:#333333;font-size:10px;margin-top:6px;font-family:Arial,sans-serif;">${leaderResult.reasons.join(' · ')}</div>
      </td></tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`
    : `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#141414;border:1px solid #1E1E1E;border-radius:8px;">
      <tr><td style="padding:16px;text-align:center;">
        <div style="color:#888888;font-size:13px;font-family:Arial,sans-serif;">🤝 Empate técnico este mes — Nicole ${nicoleScore} pts · Karen ${karenScore} pts</div>
      </td></tr>
    </table>
  </td></tr><tr><td style="height:10px;"></td></tr>`;

  const body = [
    htmlHeader(
      '📆 Reporte Mensual Marketing',
      `${monthRange.label} · America/New_York`
    ),
    criticalAlertsBlock(alerts),
    `<tr><td><table width="100%" cellpadding="0" cellspacing="0">${teamSummary}</table></td></tr>`,
    `<tr><td style="height:8px;"></td></tr>`,
    trendsSection,
    monthlyAssigneeSection('Nicole Zapata', byAssignee['Nicole Zapata'], monthRange, today),
    monthlyAssigneeSection('Karen',         byAssignee['Karen'],         monthRange, today),
    comparisonSection(nicole, karen, leaderResult),
    mesLeaderBanner,
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
    from:    'JP Legacy Agent <apps@jplegacygroup.com>',
    to:      RECIPIENTS,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[Marketing] ✅ Email enviado: ${subject}`);
}

async function sendDailyMarketingReport() {
  console.log('[Marketing] Generando reporte DIARIO...');
  const data    = await buildDailyData();
  const html    = buildDailyHTML(data);
  const hasOverdue = data.metrics.nicole.overdueCount + data.metrics.karen.overdueCount > 0;
  const d       = parseDate(data.today);
  const dayName = DAYS_ES[d.getUTCDay()];
  const dateStr = `${dayName} ${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()]}`;
  const subject = `JP Legacy — Reporte Diario · ${dateStr}${hasOverdue ? ' ⚠️' : ''}`;
  await sendMarketingEmail(subject, html);
  return { data, html };
}

async function sendWeeklyMarketingReport() {
  console.log('[Marketing] Generando reporte SEMANAL...');
  const data    = await buildWeeklyData();
  const html    = buildWeeklyHTML(data);
  const subject = `JP Legacy — Reporte Semanal · ${shortDate(data.weekRange.start)} al ${shortDate(data.weekRange.end)}`;
  await sendMarketingEmail(subject, html);
  return { data, html };
}

async function sendMonthlyMarketingReport() {
  console.log('[Marketing] Generando reporte MENSUAL...');
  const data    = await buildMonthlyData();
  const html    = buildMonthlyHTML(data);
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

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  startMarketingReport,
  sendDailyMarketingReport,
  sendWeeklyMarketingReport,
  sendMonthlyMarketingReport,
  buildDailyData,
  buildWeeklyData,
  buildMonthlyData,
};
