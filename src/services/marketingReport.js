'use strict';
const axios = require('axios');
const cron = require('node-cron');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const PIPELINE_PROJECT_ID = '1211674641565541';
const TEAM_OVERVIEW_PROJECT_ID = '1212623827839295';

const PIPELINE_STAGES = [
  'Concept/Idea',
  'Resources pending',
  'Ready to edit',
  'Editing / Design',
  'Review & Feedback',
  'Aproved',
  'Ready to upload',
  'Scheduled/Publlished',
  'Archive',
  'Paused',
  'Backup',
];

const NON_STAGNATED_STAGES = ['Scheduled/Publlished', 'Archive', 'Backup'];

const CADENCE_GOALS = { Paola: 5, Jorge: 4, 'JP Legacy': 7 };

const RECIPIENTS = [
  'jorgeflorez@jplegacygroup.com',
  'paoladiaz@jplegacygroup.com',
  'marketing@jplegacygroup.com',
  'karen@getvau.com',
];

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ══════════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function parseDate(str) {
  if (!str) return null;
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

/** Monday of the week containing isoDate (Mon-Sun week) */
function mondayOf(isoDate) {
  const d = parseDate(isoDate);
  if (!d) return null;
  const dow = d.getUTCDay(); // 0=Sun
  const offset = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

/** Current week Mon-Sun in ET */
function currentWeekRangeET() {
  const today = todayET();
  const mon = mondayOf(today);
  const sun = new Date(mon);
  sun.setUTCDate(sun.getUTCDate() + 6);
  return { start: fmtDate(mon), end: fmtDate(sun) };
}

/** Previous week Mon-Sun in ET */
function prevWeekRangeET() {
  const today = todayET();
  const mon = mondayOf(today);
  const prevMon = new Date(mon);
  prevMon.setUTCDate(prevMon.getUTCDate() - 7);
  const prevSun = new Date(prevMon);
  prevSun.setUTCDate(prevSun.getUTCDate() + 6);
  return { start: fmtDate(prevMon), end: fmtDate(prevSun) };
}

/** Previous calendar month range */
function prevMonthRangeET() {
  const today = parseDate(todayET());
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth(); // 0-indexed, this is current month
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const start = new Date(Date.UTC(prevYear, prevMonth, 1));
  const end = new Date(Date.UTC(prevYear, prevMonth + 1, 0));
  return {
    start: fmtDate(start),
    end: fmtDate(end),
    label: `${MONTHS_ES[prevMonth]} ${prevYear}`,
  };
}

function formatTodayES(isoDate) {
  const d = parseDate(isoDate);
  if (!d) return isoDate;
  const dow = d.getUTCDay();
  const day = d.getUTCDate();
  const mon = MONTHS_ES[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${DAYS_ES[dow]} ${day} de ${mon}, ${year}`;
}

function formatTimeNowET() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function isInRange(isoDate, start, end) {
  if (!isoDate) return false;
  return isoDate >= start && isoDate <= end;
}

function addDays(isoDate, n) {
  const d = parseDate(isoDate);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

// ══════════════════════════════════════════════════════════════════════════════
// ASANA API HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function asanaHeaders() {
  return { Authorization: `Bearer ${process.env.ASANA_TOKEN}` };
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Fetch all pages of tasks from Asana for a project */
async function fetchPipelineTasks() {
  const tasks = [];
  let offset = null;
  const optFields = [
    'name', 'assignee.name', 'tags',
    'due_on', 'created_at', 'modified_at', 'completed', 'completed_at',
    'custom_fields.name', 'custom_fields.display_value',
    'notes', 'memberships.section.name',
  ].join(',');

  do {
    const params = {
      project: PIPELINE_PROJECT_ID,
      opt_fields: optFields,
      limit: 100,
    };
    if (offset) params.offset = offset;

    const res = await axios.get('https://app.asana.com/api/1.0/tasks', {
      headers: asanaHeaders(),
      params,
    });

    tasks.push(...(res.data.data || []));
    offset = res.data.next_page ? res.data.next_page.offset : null;
  } while (offset);

  const firstStage = tasks[0] && tasks[0].memberships && tasks[0].memberships[0]
    ? tasks[0].memberships[0].section && tasks[0].memberships[0].section.name
    : 'NO_MEMBERSHIPS';
  console.log(`[marketingReport] Pipeline: ${tasks.length} tareas. Primera sección: ${JSON.stringify(firstStage)}`);
  console.log('[DEBUG] tags sample task 0:', JSON.stringify(tasks[0]?.tags));
  console.log('[DEBUG] tags sample task 1:', JSON.stringify(tasks[1]?.tags));
  console.log('[DEBUG] task notes sample:', tasks[0]?.notes?.substring(0, 200));
  return tasks;
}

/** Fetch Team Overview tasks with completed_since for current week */
async function fetchTeamOverviewTasks(weekStart) {
  const tasks = [];
  let offset = null;
  const optFields = [
    'name', 'assignee.name', 'due_on', 'completed', 'completed_at',
    'start_on', 'custom_fields.name', 'custom_fields.display_value',
  ].join(',');

  const completedSince = `${weekStart}T00:00:00.000Z`;
  console.log(`[marketingReport] Team Overview: project=${TEAM_OVERVIEW_PROJECT_ID} completed_since=${completedSince}`);

  do {
    const params = {
      project: TEAM_OVERVIEW_PROJECT_ID,
      opt_fields: optFields,
      completed_since: completedSince,
      limit: 100,
    };
    if (offset) params.offset = offset;

    const res = await axios.get('https://app.asana.com/api/1.0/tasks', {
      headers: asanaHeaders(),
      params,
    });

    tasks.push(...(res.data.data || []));
    offset = res.data.next_page ? res.data.next_page.offset : null;
  } while (offset);

  console.log(`[marketingReport] Team Overview: ${tasks.length} tareas recibidas`);
  return tasks;
}

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINE TASK PROCESSORS
// ══════════════════════════════════════════════════════════════════════════════

/** Get the section/stage name from a task's memberships */
function getTaskStage(task) {
  if (!task.memberships || task.memberships.length === 0) return 'Unknown';
  const membership = task.memberships.find(m => m.section && m.section.name);
  return membership ? membership.section.name : 'Unknown';
}

/** Classify accounts from task name (tags are empty in this project).
 *  Expected patterns in name:  "… – Paola, Jorge & JP – 2026"
 *                               "… – Paola & JP – 2026"
 *                               "… – Jorge – 2026"  etc.
 */
function getTaskAccounts(task) {
  const name = (task.name || '').toLowerCase();
  const accounts = [];

  const hasPaola = name.includes('paola');
  // "jorge" appears standalone; avoid false match on "jp legacy" which doesn't contain it
  const hasJorge = name.includes('jorge');
  // "& jp" covers "Paola & JP", "Jorge & JP"; "jp –" covers "– JP – 2026"; "jp legacy" is explicit
  const hasJP = name.includes('& jp') || /–\s*jp\s*–/.test(name) || name.includes('jp legacy') || name.includes('jplegacy');

  if (hasPaola) accounts.push('Paola');
  if (hasJorge) accounts.push('Jorge');
  if (hasJP) accounts.push('JP Legacy');

  return accounts;
}

/** Shorten long task names to first two segments split by " – " */
function shortName(name) {
  const parts = (name || '').split('–');
  return parts.slice(0, 2).join('–').trim();
}

/** Extract platform tags (non-account tags) */
function getTaskPlatformTags(task) {
  if (!task.tags || task.tags.length === 0) return [];
  const accountKeywords = ['paola', 'jorge', 'jp legacy', 'jplegacy'];
  return task.tags
    .map(t => t.name || '')
    .filter(name => name.length > 0)
    .filter(name => {
      const lower = name.toLowerCase();
      return !accountKeywords.some(kw => lower.includes(kw));
    });
}

/** Extract links from notes */
function extractLinks(notes) {
  if (!notes) return { dropbox: null, instagram: null, zillow: null };
  const dropboxMatch = notes.match(/https?:\/\/[^\s\n"<>]*dropbox\.com[^\s\n"<>]*/i);
  const instagramMatch = notes.match(/https?:\/\/[^\s\n"<>]*instagram\.com[^\s\n"<>]*/i);
  const zillowMatch = notes.match(/https?:\/\/[^\s\n"<>]*zillow\.com[^\s\n"<>]*/i);
  return {
    dropbox: dropboxMatch ? dropboxMatch[0] : null,
    instagram: instagramMatch ? instagramMatch[0] : null,
    zillow: zillowMatch ? zillowMatch[0] : null,
  };
}

/** Days in current stage (based on modified_at) */
function daysInStage(task) {
  if (!task.modified_at) return 0;
  return Math.floor((Date.now() - new Date(task.modified_at)) / (1000 * 60 * 60 * 24));
}

/** Extract a custom field value by name (case-insensitive) from raw Asana task */
function getCF(task, fieldName) {
  if (!task.custom_fields) return null;
  const f = task.custom_fields.find(cf => cf.name && cf.name.toLowerCase() === fieldName.toLowerCase());
  if (!f) return null;
  if (f.enum_value && f.enum_value.name) return f.enum_value.name;
  if (f.display_value) return f.display_value;
  if (f.text_value) return f.text_value;
  return null;
}

/** Enrich a pipeline task with derived fields */
function enrichPipelineTask(task) {
  console.log('[DEBUG] notes for task:', task.name?.substring(0, 40), '| notes:', task.notes?.substring(0, 150));
  const stage = getTaskStage(task);
  const accounts = getTaskAccounts(task);
  const links = extractLinks(task.notes);
  const platforms = getTaskPlatformTags(task);
  const days = daysInStage(task);
  const stagnated = days > 3 && !NON_STAGNATED_STAGES.includes(stage);

  // Fecha de publicación — determines if priority/type fields are real
  const fechaPublicacion = getCF(task, 'Fecha de publicación') ||
                           getCF(task, 'fecha de publicacion') ||
                           getCF(task, 'Hora de publicación') || null;
  const hasFechaPublicacion = !!(fechaPublicacion && fechaPublicacion.trim());

  // Priority only valid when fechaPublicacion is set
  const prioridadRaw = getCF(task, 'Prioridad') || getCF(task, 'prioridad') || null;
  const prioridad = hasFechaPublicacion ? prioridadRaw : null;
  const urgente = hasFechaPublicacion &&
    !!(prioridadRaw && prioridadRaw.toLowerCase().includes('urgent')) &&
    !task.completed;

  // Tipo only valid when fechaPublicacion is set
  const tipoRaw = getCF(task, 'Tipo de contenido') || getCF(task, 'Tipo') || null;
  const tipo = hasFechaPublicacion ? tipoRaw : null;

  // Delivery margin: due_on should be >= 2 days before fechaPublicacion
  let margenDias = null;
  let entregaEnRiesgo = false;
  if (hasFechaPublicacion && task.due_on) {
    const pubDate = parseDate(fechaPublicacion.slice(0, 10));
    const dueDate = parseDate(task.due_on);
    if (pubDate && dueDate) {
      margenDias = Math.round((pubDate - dueDate) / 86400000);
      entregaEnRiesgo = margenDias < 2;
    }
  }

  return {
    gid: task.gid,
    name: task.name,
    stage,
    accounts,
    platforms,
    assignee: task.assignee ? task.assignee.name : null,
    due_on: task.due_on || null,
    created_at: task.created_at,
    modified_at: task.modified_at,
    completed: task.completed || false,
    completed_at: task.completed_at || null,
    notes: task.notes || '',
    tags: (task.tags || []).map(t => t.name),
    links,
    days_in_stage: days,
    stagnated,
    fechaPublicacion: hasFechaPublicacion ? fechaPublicacion : null,
    prioridad,
    urgente,
    tipo,
    margenDias,
    entregaEnRiesgo,
    // Cross-reference fields — set by crossReferenceVideos()
    estadoProduccion: null,
    responsableProduccion: null,
    fechaEstadoProduccion: null,
    completadoEnEquipo: false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-REFERENCE: TEAM OVERVIEW ↔ PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

// Accept both slash and dash separators: "INICIO/", "INICIO-", etc.
const VIDEO_PREFIXES = ['INICIO/', 'INICIO-', 'PROCESO/', 'PROCESO-', 'FIN/', 'FIN-'];

/** Returns { prefix, videoName } if task name starts with a video prefix, else null */
function parseVideoTask(taskName) {
  if (!taskName) return null;
  const upper = taskName.toUpperCase();
  for (const prefix of VIDEO_PREFIXES) {
    if (upper.startsWith(prefix)) {
      const videoName = taskName.slice(prefix.length).trim();
      if (videoName.length > 0) {
        // Normalize prefix to canonical form (INICIO/PROCESO/FIN) for comparisons
        const canonical = prefix.replace(/[-/]$/, '');
        return { prefix: canonical, videoName };
      }
    }
  }
  return null;
}

/** Count words in common between two strings (case-insensitive) */
function commonWords(a, b) {
  const stopWords = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'the', 'of', 'and', 'for']);
  const wordsA = new Set(
    a.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
  );
  return b.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w) && wordsA.has(w)).length;
}

/**
 * Cross-reference Team Overview video tasks with Pipeline tasks.
 * Mutates pipelineTasks in place to add estadoProduccion fields.
 * Returns enriched teamVideoTasks with pipelineMatch info.
 */
function crossReferenceVideos(teamTasks, pipelineTasks) {
  const videoTasks = [];

  for (const tt of teamTasks) {
    const parsed = parseVideoTask(tt.name);
    if (!parsed) continue; // Not a video task — skip entirely

    // Find best matching pipeline task
    let bestMatch = null;
    let bestScore = 0;

    for (const pt of pipelineTasks) {
      const score = commonWords(parsed.videoName, pt.name);
      if (score >= 3 && score > bestScore) {
        bestScore = score;
        bestMatch = pt;
      }
    }

    const videoEntry = {
      teamTask: tt,
      prefix: parsed.prefix,
      videoName: parsed.videoName,
      assignee: tt.assignee || null,
      completed: tt.completed || false,
      completedAt: tt.completed_at ? tt.completed_at.slice(0, 10) : null,
      pipelineMatch: bestMatch ? bestMatch.gid : null,
      pipelineMatchName: bestMatch ? bestMatch.name : null,
    };

    videoTasks.push(videoEntry);

    // Enrich pipeline task if matched
    if (bestMatch) {
      // Prefer higher-priority states: FIN > PROCESO > INICIO
      const priority = { FIN: 3, PROCESO: 2, INICIO: 1 };
      const current = priority[bestMatch.estadoProduccion] || 0;
      if ((priority[parsed.prefix] || 0) >= current) {
        bestMatch.estadoProduccion = parsed.prefix;
        bestMatch.responsableProduccion = tt.assignee || null;
        bestMatch.fechaEstadoProduccion = tt.completed_at
          ? tt.completed_at.slice(0, 10)
          : tt.created_at ? tt.created_at.slice(0, 10) : null;
        bestMatch.completadoEnEquipo = tt.completed || false;
      }
    }
  }

  return videoTasks;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEAM METRICS CALCULATOR
// ══════════════════════════════════════════════════════════════════════════════

function calcTeamMemberMetrics(memberName, tasks, weekStart, weekEnd, today, videoTasks) {
  const isMatch = (t) => {
    if (!t.assignee) return false;
    const lower = (t.assignee || '').toLowerCase();
    if (memberName.toLowerCase().includes('karen')) return lower.includes('karen');
    return lower === memberName.toLowerCase();
  };

  // All tasks for this person (no week filter — we apply week logic per metric below)
  const myTasks = tasks.filter(t => isMatch(t));

  // Completed THIS week: use completed_at to determine week membership
  const completedWeek = myTasks.filter(t =>
    t.completed && t.completed_at &&
    isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
  ).length;

  // In-progress TODAY: due_on = today and not yet completed
  const inProgressToday = myTasks.filter(t =>
    !t.completed && t.due_on === today
  ).length;

  // Pending TODAY: overdue (due_on < today) and not completed
  const pendingToday = myTasks.filter(t =>
    !t.completed && t.due_on && t.due_on < today
  ).length;

  // On-time rate: completed tasks where completed_at <= due_on
  const completedWithDue = myTasks.filter(t => t.completed && t.completed_at && t.due_on);
  const onTime = completedWithDue.filter(t => t.completed_at.slice(0, 10) <= t.due_on);
  const onTimeRate = completedWithDue.length > 0
    ? Math.round((onTime.length / completedWithDue.length) * 100)
    : 0;

  // Urgentes: non-completed tasks with 'urgent' priority (only from tasks with due in week)
  const urgentesActivas = myTasks.filter(t => {
    if (t.completed) return false;
    const cf = t.custom_fields || [];
    const prioridad = cf.find && cf.find(f => f.name && f.name.toLowerCase() === 'prioridad');
    const prioVal = prioridad ? (prioridad.display_value || (prioridad.enum_value && prioridad.enum_value.name) || '') : '';
    const fechaPub = cf.find && cf.find(f => f.name && (f.name.toLowerCase().includes('fecha de publicaci') || f.name.toLowerCase().includes('hora de publicaci')));
    const hasFechaPub = !!(fechaPub && (fechaPub.display_value || fechaPub.text_value));
    return hasFechaPub && prioVal.toLowerCase().includes('urgent');
  });

  // Videos en producción this week (INICIO/PROCESO/FIN tasks for this person)
  const videosProduccion = (videoTasks || []).filter(vt => {
    if (!vt.assignee) return false;
    const lower = vt.assignee.toLowerCase();
    const match = memberName.toLowerCase().includes('karen')
      ? lower.includes('karen')
      : lower === memberName.toLowerCase();
    return match;
  });

  return { completedWeek, inProgressToday, pendingToday, onTimeRate, urgentesActivas, videosProduccion };
}

// ══════════════════════════════════════════════════════════════════════════════
// AI ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

async function generateAIAnalysis(data) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const context = [
    `Pipeline: ${data.pipeline.activeTotal} videos activos.`,
    `Alerts: ${data.alerts.critical.length} críticas, ${data.alerts.attention.length} atención.`,
    `Estancados: ${data.stagnated.length}.`,
    `Nicole: ${data.team.nicole.completedWeek} completadas semana.`,
    `Karen: ${data.team.karen.completedWeek} completadas semana.`,
    `Cadencia Paola: ${data.cadence['Paola'].actual}/${data.cadence['Paola'].goal},`,
    `Jorge: ${data.cadence['Jorge'].actual}/${data.cadence['Jorge'].goal},`,
    `JP Legacy: ${data.cadence['JP Legacy'].actual}/${data.cadence['JP Legacy'].goal}.`,
  ].join(' ');

  const callHaiku = () => anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 250,
    messages: [{
      role: 'user',
      content: `Analiza estos datos del pipeline de marketing de JP Legacy Group y da observaciones clave, cuellos de botella detectados y 2-3 recomendaciones concretas. Tono ejecutivo en español. Solo el párrafo de análisis, máximo 150 palabras, sin preámbulos.\n\n${context}`,
    }],
  });

  try {
    const msg = await callHaiku();
    return msg.content[0].text;
  } catch (e) {
    console.warn('[marketingReport] AI attempt 1 failed:', e.message, '— retrying in 2s');
    await new Promise(r => setTimeout(r, 2000));
    try {
      const msg = await callHaiku();
      return msg.content[0].text;
    } catch (e2) {
      console.error('[marketingReport] AI attempt 2 failed:', e2.message);
      return '[Análisis IA no disponible temporalmente]';
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ALERT BUILDER
// ══════════════════════════════════════════════════════════════════════════════

function buildAlerts(pipeline, accounts, today, weekStart, weekEnd, allTasks, videoTasks) {
  const critical = [];
  const attention = [];

  const stages = pipeline.stages;
  const allActive = Object.values(stages).flat();
  const next7End = addDays(today, 7);

  // 🔴 Approved = 0
  if ((stages['Aproved'] || []).length === 0) {
    critical.push('Stage "Aprobado" tiene 0 videos — no hay contenido listo para publicar');
  }

  // 🔴 Ready to upload = 0
  if ((stages['Ready to upload'] || []).length === 0) {
    critical.push('Stage "Ready to upload" tiene 0 videos');
  }

  // 🔴 Task due today with no dropbox link
  for (const t of allActive.filter(t => t.due_on === today && !t.links.dropbox && !NON_STAGNATED_STAGES.includes(t.stage))) {
    critical.push(`"${t.name}" vence HOY sin archivo Dropbox`);
  }

  // 🔴 Account 0 scheduled next 7 days AND 0 published this week → >4 days no publish
  for (const [, acctData] of Object.entries(accounts)) {
    const lastPub = acctData.tasks
      .filter(t => t.completed && t.completed_at)
      .map(t => t.completed_at.slice(0, 10))
      .sort().reverse()[0] || null;
    const daysSince = lastPub
      ? Math.floor((parseDate(today) - parseDate(lastPub)) / 86400000)
      : null;
    if (daysSince !== null && daysSince > 4) {
      critical.push(`Cuenta ${acctData.name}: ${daysSince} días sin publicar`);
    }
  }

  // 🔴 Urgent tasks active (with fechaPublicacion set)
  const urgentesAll = allTasks.filter(t => t.urgente);
  if (urgentesAll.length > 0) {
    for (const t of urgentesAll) {
      critical.push(`⚡ Urgente activa: "${t.name}" | Vence: ${t.due_on || '—'}`);
    }
  }

  // 🔴 Ready to upload with no FIN/ completed in Team Overview — only alert if due today or tomorrow
  const readyToUploadTasks = stages['Ready to upload'] || [];
  for (const t of readyToUploadTasks) {
    if (!t.due_on) continue;
    const daysUntilDue = Math.round((parseDate(t.due_on) - parseDate(today)) / 86400000);
    if (daysUntilDue > 1) continue;
    const finMatch = (videoTasks || []).find(vt =>
      vt.prefix === 'FIN' && vt.pipelineMatch === t.gid && vt.completed
    );
    if (!finMatch) {
      critical.push(`"${t.name}" en Ready to upload sin tarea FIN/ completada en Team Overview`);
    }
  }

  // 🔴 3+ videos same day same account
  for (const [, acctData] of Object.entries(accounts)) {
    const byDay = {};
    for (const t of acctData.tasks.filter(t => t.due_on && !t.completed)) {
      byDay[t.due_on] = (byDay[t.due_on] || 0) + 1;
    }
    for (const [day, count] of Object.entries(byDay)) {
      if (count > 3) critical.push(`${acctData.name}: ${count} videos el mismo día (${day})`);
    }
  }

  // 🟡 Resources pending > 2 days
  for (const t of (stages['Resources pending'] || []).filter(t => t.days_in_stage > 2)) {
    attention.push(`"${t.name}" lleva ${t.days_in_stage} días en "Resources pending"`);
  }

  // 🟡 Account < 2 tasks next 7 days
  for (const [, acctData] of Object.entries(accounts)) {
    const upcoming = acctData.tasks.filter(t => t.due_on && t.due_on >= today && t.due_on <= next7End && !t.completed);
    if (upcoming.length < 2) {
      attention.push(`Cuenta ${acctData.name}: solo ${upcoming.length} tarea(s) en próximos 7 días`);
    }
  }

  // 🟡 > 24 without due date
  const noDate = allActive.filter(t => !t.due_on && !t.completed);
  if (noDate.length > 24) {
    attention.push(`${noDate.length} videos sin fecha asignada (umbral: 24)`);
  }

  // 🟡 Delivery margin < 2 days
  for (const t of allTasks.filter(t => t.entregaEnRiesgo && !t.completed)) {
    attention.push(`"${t.name}" — margen de entrega: ${t.margenDias} día(s) (mínimo recomendado: 2)`);
  }

  // 🟡 > 3 urgentes activas total
  if (urgentesAll.length > 3) {
    attention.push(`${urgentesAll.length} urgentes activas simultáneamente (máximo recomendado: 3)`);
  }

  return { critical, attention };
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

async function buildDailyData() {
  const today = todayET();
  const { start: weekStart, end: weekEnd } = currentWeekRangeET();
  const next7End = addDays(today, 7);

  console.log(`[marketingReport] buildDailyData: today=${today} weekStart=${weekStart} weekEnd=${weekEnd}`);

  // ── Fetch pipeline tasks ──────────────────────────────────────────────────
  let rawPipeline = [];
  try {
    rawPipeline = await fetchPipelineTasks();
  } catch (err) {
    console.error('[marketingReport] Pipeline fetch error:', err.message);
  }

  await delay(300);

  // ── Fetch team overview tasks ─────────────────────────────────────────────
  let rawTeam = [];
  try {
    rawTeam = await fetchTeamOverviewTasks(weekStart);
  } catch (err) {
    console.error('[marketingReport] Team overview fetch error:', err.message);
  }
  console.log(`[marketingReport] rawPipeline=${rawPipeline.length} rawTeam=${rawTeam.length}`);

  // ── DEBUG: log raw data shape ─────────────────────────────────────────────
  if (rawPipeline.length > 0) {
    const t0 = rawPipeline[0];
    console.log('[DEBUG] rawPipeline[0].name:', t0.name?.slice(0, 60));
    console.log('[DEBUG] rawPipeline[0].memberships:', JSON.stringify(t0.memberships?.slice(0, 1)));
    console.log('[DEBUG] rawPipeline[0] section via getTaskStage:', getTaskStage(t0));
    console.log('[DEBUG] task.tags sample:', JSON.stringify(rawPipeline[0]?.tags));
    const tagSample = rawPipeline.flatMap(t => (t.tags || []).map(tg => tg.name)).filter(Boolean);
    console.log('[DEBUG] all tag names across pipeline:', JSON.stringify([...new Set(tagSample)].slice(0, 20)));
  } else {
    console.log('[DEBUG] rawPipeline is EMPTY — no pipeline tasks fetched');
  }
  if (rawTeam.length > 0) {
    const r0 = rawTeam[0];
    console.log('[DEBUG] rawTeam[0].name:', r0.name?.slice(0, 60));
    console.log('[DEBUG] rawTeam[0].due_on:', r0.due_on);
    console.log('[DEBUG] rawTeam[0].assignee:', r0.assignee?.name || r0.assignee);
    console.log('[DEBUG] rawTeam[0].completed:', r0.completed);
  } else {
    console.log('[DEBUG] rawTeam is EMPTY — no team tasks fetched');
  }
  console.log('[DEBUG] weekStart:', weekStart, 'weekEnd:', weekEnd, 'today:', today);

  // ── Enrich pipeline tasks ─────────────────────────────────────────────────
  const tasks = rawPipeline.map(enrichPipelineTask);
  console.log('[DEBUG] tasks after enrich:', tasks.length);

  // ── Build stages map ──────────────────────────────────────────────────────
  const stagesMap = {};
  for (const stage of PIPELINE_STAGES) stagesMap[stage] = [];
  for (const task of tasks) {
    if (stagesMap[task.stage] !== undefined) {
      stagesMap[task.stage].push(task);
    } else {
      // Unknown stage — put in a catch-all
      if (!stagesMap['Other']) stagesMap['Other'] = [];
      stagesMap['Other'].push(task);
    }
  }
  console.log('[DEBUG] stages distribution:', JSON.stringify(
    Object.fromEntries(Object.entries(stagesMap).map(([k, v]) => [k, v.length]).filter(([, n]) => n > 0))
  ));

  const stageCounts = {};
  for (const [s, arr] of Object.entries(stagesMap)) stageCounts[s] = arr.length;

  const activeStages = PIPELINE_STAGES.filter(s => !['Scheduled/Publlished', 'Archive', 'Paused', 'Backup'].includes(s));
  const activeTotal = activeStages.reduce((sum, s) => sum + (stagesMap[s] || []).length, 0);

  // ── Build accounts ────────────────────────────────────────────────────────
  const accountDefs = {
    Paola: { name: 'Paola Díaz' },
    Jorge: { name: 'Jorge Florez' },
    'JP Legacy': { name: 'JP Legacy Group' },
  };

  const accounts = {};
  for (const [key, def] of Object.entries(accountDefs)) {
    const acctTasks = tasks.filter(t => t.accounts.includes(key));

    const publishedThisWeek = acctTasks.filter(t =>
      t.completed && t.completed_at &&
      isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
    ).length;

    const publishedToday = acctTasks.filter(t =>
      t.completed && t.completed_at &&
      t.completed_at.slice(0, 10) === today
    ).length;

    // Days since last publish
    const completedDates = acctTasks
      .filter(t => t.completed && t.completed_at)
      .map(t => t.completed_at.slice(0, 10))
      .sort()
      .reverse();
    const lastPublish = completedDates[0] || null;
    const daysSincePublish = lastPublish
      ? Math.floor((parseDate(today) - parseDate(lastPublish)) / (1000 * 60 * 60 * 24))
      : null;

    // Upcoming week tasks
    const upcomingWeek = acctTasks.filter(t =>
      t.due_on && t.due_on >= today && t.due_on <= next7End && !t.completed
    ).sort((a, b) => a.due_on.localeCompare(b.due_on));

    // Content balance: platform distribution
    const contentBalance = {};
    for (const t of acctTasks) {
      for (const p of t.platforms) {
        contentBalance[p] = (contentBalance[p] || 0) + 1;
      }
    }

    accounts[key] = {
      name: def.name,
      tasks: acctTasks,
      publishedToday,
      publishedThisWeek,
      daysSincePublish,
      upcomingWeek,
      contentBalance,
    };
  }

  // ── Cross-reference Team Overview ↔ Pipeline ─────────────────────────────
  const teamTasksNormalized = rawTeam.map(t => ({
    ...t,
    assignee: t.assignee ? t.assignee.name : null,
    completed_at: t.completed_at || null,
    due_on: t.due_on || null,
  }));
  let videoTasks = [];
  try {
    videoTasks = crossReferenceVideos(teamTasksNormalized, tasks);
    console.log(`[marketingReport] crossReference: ${videoTasks.length} video tasks found (INICIO/PROCESO/FIN)`);
  } catch (err) {
    console.error('[marketingReport] crossReference error:', err.message);
  }

  // ── Stagnated videos ──────────────────────────────────────────────────────
  const stagnated = tasks.filter(t => t.stagnated && !t.completed);

  // ── Pipeline object ───────────────────────────────────────────────────────
  const pipeline = { stages: stagesMap, stageCounts, activeTotal };

  // ── Alerts ────────────────────────────────────────────────────────────────
  let alerts = { critical: [], attention: [] };
  try {
    alerts = buildAlerts(pipeline, accounts, today, weekStart, weekEnd, tasks, videoTasks);
  } catch (err) {
    console.error('[marketingReport] Alert build error:', err.message);
  }

  // ── Inventory ─────────────────────────────────────────────────────────────
  const allActive = tasks.filter(t => !t.completed);
  const readyToUpload = (stagesMap['Ready to upload'] || []).length;
  const noDate = allActive.filter(t => !t.due_on).length;
  const pausedRecoverable = (stagesMap['Paused'] || []).length;

  // producedThisWeek = FIN/ tasks completed this week
  const producedThisWeek = videoTasks.filter(vt =>
    vt.prefix === 'FIN' && vt.completed && vt.completedAt &&
    isInRange(vt.completedAt, weekStart, weekEnd)
  ).length;

  const publishedThisWeek = (stagesMap['Scheduled/Publlished'] || []).filter(t =>
    t.completed && t.completed_at &&
    isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
  ).length;

  // ── Cadence ───────────────────────────────────────────────────────────────
  const cadence = {};
  for (const [key, goal] of Object.entries(CADENCE_GOALS)) {
    const actual = accounts[key]
      ? accounts[key].tasks.filter(t =>
          t.completed && t.completed_at &&
          isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
        ).length
      : 0;
    cadence[key] = { goal, actual };
  }

  // ── Team metrics ──────────────────────────────────────────────────────────
  console.log('[DEBUG] teamTasksNormalized count:', teamTasksNormalized.length);
  if (teamTasksNormalized.length > 0) {
    const sample = teamTasksNormalized.slice(0, 3).map(t => `${t.assignee}|due:${t.due_on}|done:${t.completed}`);
    console.log('[DEBUG] teamTasks sample:', sample.join(' // '));
  }
  const nicoleMetrics = calcTeamMemberMetrics('Nicole Zapata', teamTasksNormalized, weekStart, weekEnd, today, videoTasks);
  const karenMetrics = calcTeamMemberMetrics('karen', teamTasksNormalized, weekStart, weekEnd, today, videoTasks);
  console.log('[DEBUG] nicole completedWeek:', nicoleMetrics.completedWeek, 'karen completedWeek:', karenMetrics.completedWeek);

  const mostProductiveThisWeek = nicoleMetrics.completedWeek >= karenMetrics.completedWeek
    ? 'Nicole Zapata'
    : 'Karen';
  const mostProdCount = Math.max(nicoleMetrics.completedWeek, karenMetrics.completedWeek);

  const team = {
    nicole: nicoleMetrics,
    karen: karenMetrics,
    mostProductiveThisWeek,
    mostProdCount,
  };

  // ── AI Analysis ───────────────────────────────────────────────────────────
  const partialData = {
    pipeline,
    alerts,
    stagnated,
    team,
    cadence,
  };

  let aiAnalysis = '[Análisis IA no disponible]';
  try {
    aiAnalysis = await generateAIAnalysis(partialData);
  } catch (err) {
    console.error('[marketingReport] AI error:', err.message);
  }

  return {
    today,
    todayFormatted: formatTodayES(today),
    generatedAt: formatTimeNowET(),
    alerts,
    accounts,
    pipeline,
    stagnated,
    inventory: { readyToUpload, noDate, pausedRecoverable, producedThisWeek, publishedThisWeek },
    cadence,
    team,
    aiAnalysis,
  };
}

async function buildWeeklyData() {
  const today = todayET();
  const { start: weekStart, end: weekEnd } = prevWeekRangeET();

  let rawPipeline = [];
  try {
    rawPipeline = await fetchPipelineTasks();
  } catch (err) {
    console.error('[marketingReport] Pipeline fetch error:', err.message);
  }

  await delay(300);

  let rawTeam = [];
  try {
    rawTeam = await fetchTeamOverviewTasks(weekStart);
  } catch (err) {
    console.error('[marketingReport] Team overview fetch error:', err.message);
  }

  const tasks = rawPipeline.map(enrichPipelineTask);

  const stagesMap = {};
  for (const stage of PIPELINE_STAGES) stagesMap[stage] = [];
  for (const task of tasks) {
    if (stagesMap[task.stage] !== undefined) {
      stagesMap[task.stage].push(task);
    }
  }

  const stageCounts = {};
  for (const [s, arr] of Object.entries(stagesMap)) stageCounts[s] = arr.length;
  const activeStages = PIPELINE_STAGES.filter(s => !['Scheduled/Publlished', 'Archive', 'Paused', 'Backup'].includes(s));
  const activeTotal = activeStages.reduce((sum, s) => sum + (stagesMap[s] || []).length, 0);
  const pipeline = { stages: stagesMap, stageCounts, activeTotal };

  const accountDefs = {
    Paola: { name: 'Paola Díaz' },
    Jorge: { name: 'Jorge Florez' },
    'JP Legacy': { name: 'JP Legacy Group' },
  };

  const accounts = {};
  for (const [key, def] of Object.entries(accountDefs)) {
    const acctTasks = tasks.filter(t => t.accounts.includes(key));
    const publishedThisWeek = acctTasks.filter(t =>
      t.completed && t.completed_at &&
      isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
    ).length;
    const publishedToday = 0;
    const daysSincePublish = null;
    const upcomingWeek = [];
    const contentBalance = {};
    for (const t of acctTasks) {
      for (const p of t.platforms) {
        contentBalance[p] = (contentBalance[p] || 0) + 1;
      }
    }
    accounts[key] = { name: def.name, tasks: acctTasks, publishedToday, publishedThisWeek, daysSincePublish, upcomingWeek, contentBalance };
  }

  const stagnated = tasks.filter(t => t.stagnated && !t.completed);
  const alerts = buildAlerts(pipeline, accounts, today, weekStart, weekEnd);

  const readyToUpload = (stagesMap['Ready to upload'] || []).length;
  const noDate = tasks.filter(t => !t.completed && !t.due_on).length;
  const pausedRecoverable = (stagesMap['Paused'] || []).length;
  const producedThisWeek = tasks.filter(t =>
    t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
  ).length;
  const publishedThisWeek = (stagesMap['Scheduled/Publlished'] || []).filter(t =>
    t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
  ).length;

  const cadence = {};
  for (const [key, goal] of Object.entries(CADENCE_GOALS)) {
    const actual = accounts[key]
      ? accounts[key].tasks.filter(t =>
          t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
        ).length
      : 0;
    cadence[key] = { goal, actual };
  }

  const teamTasks = rawTeam.map(t => ({
    ...t,
    assignee: t.assignee ? t.assignee.name : null,
    completed_at: t.completed_at || null,
    due_on: t.due_on || null,
  }));

  const nicoleMetrics = calcTeamMemberMetrics('Nicole Zapata', teamTasks, weekStart, weekEnd, today);
  const karenMetrics = calcTeamMemberMetrics('karen', teamTasks, weekStart, weekEnd, today);
  const mostProductiveToday = nicoleMetrics.inProgressToday >= karenMetrics.inProgressToday ? 'Nicole Zapata' : 'Karen';
  const team = { nicole: nicoleMetrics, karen: karenMetrics, mostProductiveToday };

  let aiAnalysis = '[Análisis IA no disponible]';
  try {
    aiAnalysis = await generateAIAnalysis({ pipeline, alerts, stagnated, team, cadence });
  } catch (err) {
    console.error('[marketingReport] AI error:', err.message);
  }

  return {
    weekRange: { start: weekStart, end: weekEnd },
    today,
    todayFormatted: formatTodayES(today),
    generatedAt: formatTimeNowET(),
    alerts,
    accounts,
    pipeline,
    stagnated,
    inventory: { readyToUpload, noDate, pausedRecoverable, producedThisWeek, publishedThisWeek },
    cadence,
    team,
    aiAnalysis,
  };
}

async function buildMonthlyData() {
  const today = todayET();
  const { start: monthStart, end: monthEnd, label: monthLabel } = prevMonthRangeET();

  let rawPipeline = [];
  try {
    rawPipeline = await fetchPipelineTasks();
  } catch (err) {
    console.error('[marketingReport] Pipeline fetch error:', err.message);
  }

  await delay(300);

  let rawTeam = [];
  try {
    rawTeam = await fetchTeamOverviewTasks(monthStart);
  } catch (err) {
    console.error('[marketingReport] Team overview fetch error:', err.message);
  }

  const tasks = rawPipeline.map(enrichPipelineTask);

  const stagesMap = {};
  for (const stage of PIPELINE_STAGES) stagesMap[stage] = [];
  for (const task of tasks) {
    if (stagesMap[task.stage] !== undefined) stagesMap[task.stage].push(task);
  }

  const stageCounts = {};
  for (const [s, arr] of Object.entries(stagesMap)) stageCounts[s] = arr.length;
  const activeStages = PIPELINE_STAGES.filter(s => !['Scheduled/Publlished', 'Archive', 'Paused', 'Backup'].includes(s));
  const activeTotal = activeStages.reduce((sum, s) => sum + (stagesMap[s] || []).length, 0);
  const pipeline = { stages: stagesMap, stageCounts, activeTotal };

  const accountDefs = {
    Paola: { name: 'Paola Díaz' },
    Jorge: { name: 'Jorge Florez' },
    'JP Legacy': { name: 'JP Legacy Group' },
  };

  const accounts = {};
  for (const [key, def] of Object.entries(accountDefs)) {
    const acctTasks = tasks.filter(t => t.accounts.includes(key));
    const publishedThisWeek = acctTasks.filter(t =>
      t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), monthStart, monthEnd)
    ).length;
    const contentBalance = {};
    for (const t of acctTasks) {
      for (const p of t.platforms) contentBalance[p] = (contentBalance[p] || 0) + 1;
    }
    accounts[key] = { name: def.name, tasks: acctTasks, publishedToday: 0, publishedThisWeek, daysSincePublish: null, upcomingWeek: [], contentBalance };
  }

  const stagnated = tasks.filter(t => t.stagnated && !t.completed);
  const alerts = buildAlerts(pipeline, accounts, today, monthStart, monthEnd);

  const readyToUpload = (stagesMap['Ready to upload'] || []).length;
  const noDate = tasks.filter(t => !t.completed && !t.due_on).length;
  const pausedRecoverable = (stagesMap['Paused'] || []).length;
  const producedThisWeek = tasks.filter(t =>
    t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), monthStart, monthEnd)
  ).length;
  const publishedThisWeek = (stagesMap['Scheduled/Publlished'] || []).filter(t =>
    t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), monthStart, monthEnd)
  ).length;

  const cadence = {};
  for (const [key, goal] of Object.entries(CADENCE_GOALS)) {
    const actual = accounts[key]
      ? accounts[key].tasks.filter(t =>
          t.completed && t.completed_at && isInRange(t.completed_at.slice(0, 10), monthStart, monthEnd)
        ).length
      : 0;
    cadence[key] = { goal: goal * 4, actual }; // Monthly goal = weekly * 4
  }

  const teamTasks = rawTeam.map(t => ({
    ...t,
    assignee: t.assignee ? t.assignee.name : null,
    completed_at: t.completed_at || null,
    due_on: t.due_on || null,
  }));

  const nicoleMetrics = calcTeamMemberMetrics('Nicole Zapata', teamTasks, monthStart, monthEnd, today);
  const karenMetrics = calcTeamMemberMetrics('karen', teamTasks, monthStart, monthEnd, today);
  const mostProductiveToday = nicoleMetrics.completedWeek >= karenMetrics.completedWeek ? 'Nicole Zapata' : 'Karen';
  const team = { nicole: nicoleMetrics, karen: karenMetrics, mostProductiveToday };

  let aiAnalysis = '[Análisis IA no disponible]';
  try {
    aiAnalysis = await generateAIAnalysis({ pipeline, alerts, stagnated, team, cadence });
  } catch (err) {
    console.error('[marketingReport] AI error:', err.message);
  }

  return {
    monthRange: { start: monthStart, end: monthEnd, label: monthLabel },
    today,
    todayFormatted: formatTodayES(today),
    generatedAt: formatTimeNowET(),
    alerts,
    accounts,
    pipeline,
    stagnated,
    inventory: { readyToUpload, noDate, pausedRecoverable, producedThisWeek, publishedThisWeek },
    cadence,
    team,
    aiAnalysis,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEXT REPORT BUILDER
// ══════════════════════════════════════════════════════════════════════════════

function estadoIcon(estado) {
  if (estado === 'FIN') return '✅ FIN';
  if (estado === 'PROCESO') return '🔄 PROCESO';
  if (estado === 'INICIO') return '🟡 INICIO';
  return '⬜ Sin estado';
}

function buildDailyText(data) {
  const HR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines = [];

  lines.push(`📊 REPORTE DIARIO MARKETING JP — ${data.todayFormatted}`);
  lines.push(`Generado: ${data.generatedAt} ET`);
  lines.push(HR);
  lines.push('');

  // ── Alerts ──────────────────────────────────────────────────────────────
  lines.push('🚨 ALERTAS CRÍTICAS');
  if (data.alerts.critical.length === 0 && data.alerts.attention.length === 0) {
    lines.push('✅ Sin alertas críticas hoy');
  } else {
    for (const a of data.alerts.critical) lines.push(`🔴 ${a}`);
    for (const a of data.alerts.attention) lines.push(`🟡 ${a}`);
  }
  lines.push('');

  // ── Accounts ──────────────────────────────────────────────────────────────
  const accountOrder = [
    { key: 'Paola', label: '👤 PAOLA DÍAZ' },
    { key: 'Jorge', label: '👤 JORGE FLOREZ' },
    { key: 'JP Legacy', label: '🏢 JP LEGACY GROUP' },
  ];

  for (const { key, label } of accountOrder) {
    lines.push(HR);
    lines.push(label);
    lines.push('');
    const acct = data.accounts[key];
    if (!acct) { lines.push('[Sección no disponible — error de conexión]'); lines.push(''); continue; }

    const goal = CADENCE_GOALS[key];
    const daysSinceStr = acct.daysSincePublish !== null ? String(acct.daysSincePublish) : 'N/A';
    lines.push(`Publicados hoy: ${acct.publishedToday} | Esta semana: ${acct.publishedThisWeek}/${goal}`);
    lines.push(`Días sin publicar: ${daysSinceStr}`);

    // Content balance — only tasks with tipo set (fechaPublicacion required)
    const tipoTasks = acct.tasks.filter(t => t.tipo);
    if (tipoTasks.length > 0) {
      const tipoCount = {};
      for (const t of tipoTasks) tipoCount[t.tipo] = (tipoCount[t.tipo] || 0) + 1;
      const total = tipoTasks.length;
      const balStr = Object.entries(tipoCount)
        .map(([p, n]) => `${p} ${Math.round((n / total) * 100)}%`)
        .join(' | ');
      lines.push(`Balance de contenido (7 días): ${balStr}`);
    }

    lines.push('');
    lines.push('📅 Próximos 7 días:');
    if (acct.upcomingWeek.length === 0) {
      lines.push('  Sin contenido programado');
    } else {
      for (const t of acct.upcomingWeek) {
        lines.push(`${t.due_on} — ${shortName(t.name)}`);
        if (t.platforms.length > 0) lines.push(`  📱 ${t.platforms.join(', ')}`);
        lines.push(`  Estado producción: ${estadoIcon(t.estadoProduccion)}`);
        if (t.links.dropbox) lines.push(`  🔗 ${t.links.dropbox}`);
        else lines.push('  ⚠️ Sin archivo Dropbox');
        lines.push(`  Stage pipeline: ${t.stage}`);
        if (t.entregaEnRiesgo) lines.push(`  ⚠️ Entrega en riesgo — margen: ${t.margenDias} día(s)`);
      }
    }
    lines.push('');
    lines.push('📊 Último publicado: ⏳ Métricas disponibles en 24-48h');
    lines.push('');
  }

  // ── Pipeline General ────────────────────────────────────────────────────
  lines.push(HR);
  lines.push('🎬 PIPELINE GENERAL — Estado por Stage');
  lines.push('');
  const activeStageList = [
    'Concept/Idea', 'Resources pending', 'Ready to edit',
    'Editing / Design', 'Review & Feedback', 'Aproved', 'Ready to upload',
  ];
  for (const s of activeStageList) {
    const stageTasks = data.pipeline.stages[s] || [];
    const count = stageTasks.length;
    let extra = '';
    if (s === 'Resources pending') {
      const blocked = stageTasks.filter(t => t.tags && t.tags.some(tag => tag.toLowerCase().includes('faltan'))).length;
      if (blocked > 0) extra = ` [${blocked} bloqueados ⚠️]`;
    }
    if (s === 'Aproved' && count === 0) extra = ' [⚠️ ALERTA]';
    lines.push(`${s.padEnd(22)} ${count} videos${extra}`);
  }
  lines.push('──────────────────────');
  lines.push(`Pipeline activo total: ${data.pipeline.activeTotal} videos`);
  lines.push('');
  lines.push(`Scheduled/Published    ${data.pipeline.stageCounts['Scheduled/Publlished'] || 0} (histórico total)`);
  lines.push(`Paused                 ${data.pipeline.stageCounts['Paused'] || 0} | Backup: ${data.pipeline.stageCounts['Backup'] || 0}`);
  lines.push('');

  // Per-video detail for active stages
  for (const s of activeStageList) {
    const stageTasks = (data.pipeline.stages[s] || []).filter(t => !t.completed);
    if (stageTasks.length === 0) continue;
    lines.push(`  — ${s} —`);
    for (const t of stageTasks) {
      lines.push(`  ${shortName(t.name)}`);
      lines.push(`    Cuenta: ${t.accounts.join(' + ') || '—'}`);
      lines.push(`    Estado producción: ${estadoIcon(t.estadoProduccion)}`);
      if (t.responsableProduccion) lines.push(`    Responsable: ${t.responsableProduccion}`);
      if (t.links.dropbox) lines.push(`    🔗 ${t.links.dropbox}`);
    }
    lines.push('');
  }

  // ── Stagnated ────────────────────────────────────────────────────────────
  lines.push(HR);
  lines.push('⏱️ VIDEOS ESTANCADOS (+3 días sin moverse)');
  lines.push('');
  if (data.stagnated.length === 0) {
    lines.push('✅ Sin videos estancados hoy');
  } else {
    for (const t of data.stagnated) {
      lines.push(shortName(t.name));
      lines.push(`  Stage: ${t.stage} | Lleva: ${t.days_in_stage} días`);
      lines.push(`  Cuenta: ${t.accounts.join(' + ') || '—'}`);
      lines.push(`  Estado producción: ${estadoIcon(t.estadoProduccion)}`);
      const blockedTags = (t.tags || []).filter(tag => tag.toLowerCase().includes('faltan'));
      if (blockedTags.length > 0) lines.push(`  Bloqueado por: ${blockedTags.join(', ')}`);
      lines.push(`  Responsable: ${t.assignee || '—'}`);
      if (t.links.dropbox) lines.push(`  🔗 ${t.links.dropbox}`);
    }
  }
  lines.push('');

  // ── Inventory ────────────────────────────────────────────────────────────
  lines.push(HR);
  lines.push('📦 INVENTARIO');
  lines.push('');
  lines.push(`Ready to upload: ${data.inventory.readyToUpload} videos listos para publicar`);
  lines.push(`Sin fecha asignada: ${data.inventory.noDate} videos (sin programar)`);
  lines.push(`Paused recuperables: ${data.inventory.pausedRecoverable}`);
  lines.push('');
  lines.push('Ratio producción/publicación esta semana:');
  const surplus = data.inventory.producedThisWeek - data.inventory.publishedThisWeek;
  lines.push(`  Terminados (FIN/ completados): ${data.inventory.producedThisWeek}`);
  lines.push(`  Publicados: ${data.inventory.publishedThisWeek}`);
  lines.push(`  ${surplus >= 0 ? `Superávit: +${surplus}` : `Déficit: ${surplus}`}`);
  lines.push('');

  // ── Cadence ────────────────────────────────────────────────────────────
  lines.push(HR);
  lines.push('📊 CADENCIA SEMANAL');
  lines.push('');
  lines.push('             Meta    Real    Estado');
  const cadenceRows = [
    { label: 'Paola', key: 'Paola' },
    { label: 'Jorge', key: 'Jorge' },
    { label: 'JP Legacy', key: 'JP Legacy' },
  ];
  for (const row of cadenceRows) {
    const c = data.cadence[row.key];
    const pct = c.goal > 0 ? c.actual / c.goal : 0;
    const status = pct >= 1 ? '🟢' : pct >= 0.5 ? '🟡' : '🔴';
    lines.push(`${row.label.padEnd(13)} ${String(c.goal + '/sem').padEnd(8)} ${String(c.actual + '/sem').padEnd(8)} ${status}`);
  }
  lines.push('');

  // ── Team ────────────────────────────────────────────────────────────────
  lines.push(HR);
  lines.push('👥 EQUIPO — Semana actual');
  lines.push('[Solo tareas con due_date esta semana. Semanas anteriores son histórico.]');
  lines.push('');

  const teamMembers = [
    { key: 'nicole', label: '👤 Nicole Zapata', metrics: data.team.nicole },
    { key: 'karen', label: '👤 Karen', metrics: data.team.karen },
  ];

  for (const { label, metrics } of teamMembers) {
    lines.push(label);
    const urgCount = metrics.urgentesActivas ? metrics.urgentesActivas.length : 0;
    lines.push(`  🔴 Urgentes activas: ${urgCount} (meta: 0)`);
    if (urgCount > 0) {
      for (const ut of metrics.urgentesActivas) {
        const cf = ut.custom_fields || [];
        const fechaPubCF = cf.find && cf.find(f => f.name && f.name.toLowerCase().includes('fecha'));
        const fechaPubVal = fechaPubCF ? (fechaPubCF.display_value || '') : '—';
        const dueDateStr = ut.due_on || '—';
        const margen = (ut.due_on && fechaPubVal !== '—')
          ? (() => {
              const d = parseDate(fechaPubVal.slice(0, 10));
              const due = parseDate(dueDateStr);
              return (d && due) ? Math.round((d - due) / 86400000) : '?';
            })()
          : '?';
        lines.push(`  ├── ${ut.name} | Due: ${dueDateStr} | Publica: ${fechaPubVal} | Margen: ${margen} días`);
      }
    }

    const vids = metrics.videosProduccion || [];
    if (vids.length > 0) {
      lines.push(`  🎬 Videos en producción esta semana:`);
      for (const vt of vids) {
        lines.push(`  ├── ${vt.prefix} — ${vt.videoName}`);
      }
    }

    lines.push(`  Completadas esta semana: ${metrics.completedWeek}`);
    lines.push(`  En progreso hoy: ${metrics.inProgressToday} | Pendientes hoy: ${metrics.pendingToday}`);
    lines.push(`  Tasa a tiempo: ${metrics.onTimeRate}%`);
    lines.push('');
  }

  lines.push(`🏆 Más productiva esta semana: ${data.team.mostProductiveThisWeek} con ${data.team.mostProdCount} tareas`);
  lines.push('');

  // ── AI Analysis ────────────────────────────────────────────────────────
  lines.push(HR);
  lines.push('🤖 Análisis IA — JP Legacy Agent');
  lines.push(data.aiAnalysis || '[Análisis IA no disponible]');
  lines.push('');
  lines.push(`JP Legacy Agent · Auto-generado · ${data.todayFormatted} ${data.generatedAt} ET`);

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML EMAIL BUILDERS
// ══════════════════════════════════════════════════════════════════════════════

function htmlWrapper(title, body) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#111111;font-family:Arial,sans-serif;color:#FFFFFF;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#111111;">
  <tr><td align="center" style="padding:20px 10px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#1A1A1A;border-radius:8px;overflow:hidden;">
      ${body}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function htmlSection(content) {
  return `<tr><td style="padding:20px 24px;border-bottom:1px solid #2A2A2A;">${content}</td></tr>`;
}

function htmlHeader(title, subtitle = '') {
  return `<tr><td style="background:#0D0D0D;padding:24px;border-bottom:2px solid #333;">
    <h1 style="margin:0;font-size:20px;font-weight:bold;color:#FFFFFF;text-transform:uppercase;letter-spacing:1px;">${title}</h1>
    ${subtitle ? `<p style="margin:6px 0 0;font-size:13px;color:#888;">${subtitle}</p>` : ''}
  </td></tr>`;
}

function htmlSectionTitle(title) {
  return `<h2 style="margin:0 0 12px;font-size:14px;font-weight:bold;color:#AAAAAA;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #333;padding-bottom:8px;">${title}</h2>`;
}

function buildAlertBadge(type, text) {
  const bg = type === 'critical' ? '#FF4444' : '#FFD700';
  const fg = type === 'critical' ? '#FFFFFF' : '#000000';
  const icon = type === 'critical' ? '🔴' : '🟡';
  return `<div style="background:${bg};color:${fg};padding:8px 12px;border-radius:4px;margin-bottom:6px;font-size:13px;">${icon} ${text}</div>`;
}

function buildDailyHTML(data) {
  const sections = [];

  // Header
  sections.push(htmlHeader(
    '📊 Reporte Diario Marketing JP',
    `${data.todayFormatted} · Generado: ${data.generatedAt} ET`
  ));

  // Alerts
  let alertsContent = htmlSectionTitle('🚨 Alertas');
  if (data.alerts.critical.length === 0 && data.alerts.attention.length === 0) {
    alertsContent += '<p style="color:#4CAF50;margin:0;">✅ Sin alertas hoy</p>';
  } else {
    for (const a of data.alerts.critical) alertsContent += buildAlertBadge('critical', a);
    for (const a of data.alerts.attention) alertsContent += buildAlertBadge('attention', a);
  }
  sections.push(htmlSection(alertsContent));

  // Accounts
  const accountOrder = [
    { key: 'Paola', icon: '👤', label: 'Paola Díaz' },
    { key: 'Jorge', icon: '👤', label: 'Jorge Florez' },
    { key: 'JP Legacy', icon: '🏢', label: 'JP Legacy Group' },
  ];

  for (const { key, icon, label } of accountOrder) {
    const acct = data.accounts[key];
    if (!acct) continue;
    const goal = CADENCE_GOALS[key];
    let ac = htmlSectionTitle(`${icon} ${label}`);
    ac += `<table width="100%" cellpadding="4" cellspacing="0" style="font-size:13px;color:#CCC;">`;
    ac += `<tr><td>Publicados hoy:</td><td><strong style="color:#FFF;">${acct.publishedToday}</strong></td>`;
    ac += `<td>Esta semana:</td><td><strong style="color:#FFF;">${acct.publishedThisWeek}/${goal}</strong></td></tr>`;
    ac += `<tr><td>Días sin publicar:</td><td colspan="3"><strong style="color:${acct.daysSincePublish !== null && acct.daysSincePublish > 4 ? '#FF4444' : '#FFF'};">${acct.daysSincePublish !== null ? acct.daysSincePublish : 'N/A'}</strong></td></tr>`;
    ac += `</table>`;

    if (acct.upcomingWeek.length > 0) {
      ac += `<p style="font-size:12px;color:#888;margin:12px 0 6px;">📅 PRÓXIMOS 7 DÍAS</p>`;
      for (const t of acct.upcomingWeek) {
        ac += `<div style="background:#222;border-radius:4px;padding:8px 10px;margin-bottom:6px;font-size:13px;">`;
        ac += `<strong style="color:#FFF;">${t.due_on}</strong> — ${shortName(t.name)}`;
        if (t.platforms.length > 0) ac += `<br><span style="color:#888;">📱 ${t.platforms.join(', ')}</span>`;
        if (t.links.dropbox) ac += `<br><a href="${t.links.dropbox}" style="color:#4FC3F7;font-size:12px;">🔗 Dropbox</a>`;
        else ac += `<br><span style="color:#FF8800;font-size:12px;">⚠️ Sin archivo Dropbox</span>`;
        ac += `<br><span style="color:#666;font-size:12px;">Stage: ${t.stage}</span>`;
        ac += `</div>`;
      }
    } else {
      ac += `<p style="color:#FF8800;font-size:13px;margin:8px 0 0;">⚠️ Sin contenido programado en próximos 7 días</p>`;
    }
    sections.push(htmlSection(ac));
  }

  // Pipeline
  let pc = htmlSectionTitle('🎬 Pipeline General — Por Stage');
  pc += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  pc += `<tr style="background:#222;"><th style="text-align:left;color:#888;">Stage</th><th style="text-align:right;color:#888;">Videos</th></tr>`;
  const activeStageList = ['Concept/Idea', 'Resources pending', 'Ready to edit', 'Editing / Design', 'Review & Feedback', 'Aproved', 'Ready to upload'];
  for (const s of activeStageList) {
    const count = data.pipeline.stageCounts[s] || 0;
    const warn = (s === 'Aproved' && count === 0) || (s === 'Ready to upload' && count === 0);
    pc += `<tr style="border-bottom:1px solid #2A2A2A;">
      <td style="color:#CCC;">${s}</td>
      <td style="text-align:right;color:${warn ? '#FF4444' : '#FFF'};font-weight:${warn ? 'bold' : 'normal'};">${count}${warn ? ' ⚠️' : ''}</td>
    </tr>`;
  }
  pc += `<tr style="border-top:2px solid #444;">
    <td style="color:#FFF;font-weight:bold;">Pipeline activo total</td>
    <td style="text-align:right;color:#FFF;font-weight:bold;">${data.pipeline.activeTotal}</td>
  </tr>`;
  pc += `</table>`;
  pc += `<p style="font-size:12px;color:#666;margin:8px 0 0;">Scheduled/Published: ${data.pipeline.stageCounts['Scheduled/Publlished'] || 0} · Paused: ${data.pipeline.stageCounts['Paused'] || 0} · Backup: ${data.pipeline.stageCounts['Backup'] || 0}</p>`;
  sections.push(htmlSection(pc));

  // Stagnated
  let sc = htmlSectionTitle('⏱️ Videos Estancados (+3 días)');
  if (data.stagnated.length === 0) {
    sc += '<p style="color:#4CAF50;margin:0;">✅ Sin videos estancados hoy</p>';
  } else {
    for (const t of data.stagnated) {
      sc += `<div style="background:#2A1800;border-left:3px solid #FF8800;padding:8px 10px;margin-bottom:6px;font-size:13px;border-radius:2px;">`;
      sc += `<strong style="color:#FF8800;">${shortName(t.name)}</strong>`;
      sc += `<br><span style="color:#AAA;">Stage: ${t.stage} | ${t.days_in_stage} días | ${t.assignee || '—'}</span>`;
      if (t.accounts.length > 0) sc += `<br><span style="color:#888;">Cuenta: ${t.accounts.join(' + ')}</span>`;
      if (t.links.dropbox) sc += `<br><a href="${t.links.dropbox}" style="color:#4FC3F7;font-size:12px;">🔗 Dropbox</a>`;
      sc += `</div>`;
    }
  }
  sections.push(htmlSection(sc));

  // Inventory
  let ic = htmlSectionTitle('📦 Inventario');
  ic += `<table width="100%" cellpadding="4" cellspacing="0" style="font-size:13px;color:#CCC;">`;
  ic += `<tr><td>Ready to upload:</td><td><strong style="color:#FFF;">${data.inventory.readyToUpload} videos</strong></td></tr>`;
  ic += `<tr><td>Sin fecha asignada:</td><td><strong style="color:${data.inventory.noDate > 24 ? '#FF4444' : '#FFF'};">${data.inventory.noDate} videos</strong></td></tr>`;
  ic += `<tr><td>Paused recuperables:</td><td><strong style="color:#FFF;">${data.inventory.pausedRecoverable}</strong></td></tr>`;
  const surplus = data.inventory.producedThisWeek - data.inventory.publishedThisWeek;
  ic += `<tr><td>Producidos esta semana:</td><td><strong style="color:#FFF;">${data.inventory.producedThisWeek}</strong></td></tr>`;
  ic += `<tr><td>Publicados esta semana:</td><td><strong style="color:#FFF;">${data.inventory.publishedThisWeek}</strong></td></tr>`;
  ic += `<tr><td>${surplus >= 0 ? 'Superávit' : 'Déficit'}:</td><td><strong style="color:${surplus >= 0 ? '#4CAF50' : '#FF4444'};">${surplus >= 0 ? '+' : ''}${surplus}</strong></td></tr>`;
  ic += `</table>`;
  sections.push(htmlSection(ic));

  // Cadence
  let cad = htmlSectionTitle('📊 Cadencia Semanal');
  cad += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  cad += `<tr style="background:#222;"><th style="text-align:left;color:#888;">Cuenta</th><th style="color:#888;">Meta</th><th style="color:#888;">Real</th><th style="color:#888;">Estado</th></tr>`;
  const cadenceRows = [{ label: 'Paola', key: 'Paola' }, { label: 'Jorge', key: 'Jorge' }, { label: 'JP Legacy', key: 'JP Legacy' }];
  for (const row of cadenceRows) {
    const c = data.cadence[row.key];
    const pct = c.goal > 0 ? c.actual / c.goal : 0;
    const status = pct >= 1 ? '🟢' : pct >= 0.5 ? '🟡' : '🔴';
    cad += `<tr style="border-bottom:1px solid #2A2A2A;">
      <td style="color:#CCC;">${row.label}</td>
      <td style="text-align:center;color:#888;">${c.goal}/sem</td>
      <td style="text-align:center;color:#FFF;font-weight:bold;">${c.actual}/sem</td>
      <td style="text-align:center;">${status}</td>
    </tr>`;
  }
  cad += `</table>`;
  sections.push(htmlSection(cad));

  // Team
  let tc = htmlSectionTitle('👥 Equipo — Semana Actual');
  tc += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  tc += `<tr style="background:#222;"><th style="text-align:left;color:#888;">Métrica</th><th style="color:#888;">Nicole Zapata</th><th style="color:#888;">Karen</th></tr>`;
  const teamRows = [
    ['Completadas semana', data.team.nicole.completedWeek, data.team.karen.completedWeek],
    ['En progreso hoy', data.team.nicole.inProgressToday, data.team.karen.inProgressToday],
    ['Pendientes hoy', data.team.nicole.pendingToday, data.team.karen.pendingToday],
    ['Racha (días)', data.team.nicole.streak, data.team.karen.streak],
    ['Tasa a tiempo', `${data.team.nicole.onTimeRate}%`, `${data.team.karen.onTimeRate}%`],
  ];
  for (const [label, n, k] of teamRows) {
    tc += `<tr style="border-bottom:1px solid #2A2A2A;"><td style="color:#CCC;">${label}</td><td style="text-align:center;color:#FFF;">${n}</td><td style="text-align:center;color:#FFF;">${k}</td></tr>`;
  }
  tc += `</table>`;
  tc += `<p style="font-size:12px;color:#888;margin:8px 0 0;">🏆 Más productiva hoy: <strong style="color:#FFF;">${data.team.mostProductiveToday}</strong></p>`;
  sections.push(htmlSection(tc));

  // AI Analysis
  let ai = htmlSectionTitle('🤖 Análisis IA — JP Legacy Agent');
  ai += `<p style="font-size:14px;color:#CCC;line-height:1.6;margin:0;">${data.aiAnalysis}</p>`;
  sections.push(htmlSection(ai));

  // Footer
  sections.push(`<tr><td style="padding:16px 24px;background:#0D0D0D;text-align:center;">
    <p style="margin:0;font-size:11px;color:#555;">JP Legacy Agent · Auto-generado · ${data.todayFormatted} ${data.generatedAt} ET</p>
  </td></tr>`);

  return htmlWrapper('Reporte Diario Marketing JP', sections.join('\n'));
}

function buildWeeklyHTML(data) {
  const range = data.weekRange
    ? `Semana ${data.weekRange.start} — ${data.weekRange.end}`
    : data.todayFormatted;
  const sections = [];

  sections.push(htmlHeader(
    '📊 Reporte Semanal Marketing JP',
    `${range} · Generado: ${data.generatedAt} ET`
  ));

  // Alerts
  let alertsContent = htmlSectionTitle('🚨 Alertas de la Semana');
  if (data.alerts.critical.length === 0 && data.alerts.attention.length === 0) {
    alertsContent += '<p style="color:#4CAF50;margin:0;">✅ Sin alertas esta semana</p>';
  } else {
    for (const a of data.alerts.critical) alertsContent += buildAlertBadge('critical', a);
    for (const a of data.alerts.attention) alertsContent += buildAlertBadge('attention', a);
  }
  sections.push(htmlSection(alertsContent));

  // Cadence
  let cad = htmlSectionTitle('📊 Cadencia de la Semana');
  cad += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  cad += `<tr style="background:#222;"><th style="text-align:left;color:#888;">Cuenta</th><th style="color:#888;">Meta</th><th style="color:#888;">Real</th><th style="color:#888;">Estado</th></tr>`;
  for (const row of [{ label: 'Paola', key: 'Paola' }, { label: 'Jorge', key: 'Jorge' }, { label: 'JP Legacy', key: 'JP Legacy' }]) {
    const c = data.cadence[row.key];
    const pct = c.goal > 0 ? c.actual / c.goal : 0;
    const status = pct >= 1 ? '🟢' : pct >= 0.5 ? '🟡' : '🔴';
    cad += `<tr style="border-bottom:1px solid #2A2A2A;"><td style="color:#CCC;">${row.label}</td><td style="text-align:center;color:#888;">${c.goal}/sem</td><td style="text-align:center;color:#FFF;font-weight:bold;">${c.actual}/sem</td><td style="text-align:center;">${status}</td></tr>`;
  }
  cad += `</table>`;
  sections.push(htmlSection(cad));

  // Pipeline
  let pc = htmlSectionTitle('🎬 Pipeline');
  pc += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  for (const s of ['Concept/Idea', 'Resources pending', 'Ready to edit', 'Editing / Design', 'Review & Feedback', 'Aproved', 'Ready to upload']) {
    pc += `<tr style="border-bottom:1px solid #2A2A2A;"><td style="color:#CCC;">${s}</td><td style="text-align:right;color:#FFF;">${data.pipeline.stageCounts[s] || 0}</td></tr>`;
  }
  pc += `<tr><td style="color:#FFF;font-weight:bold;">Total activo</td><td style="text-align:right;color:#FFF;font-weight:bold;">${data.pipeline.activeTotal}</td></tr>`;
  pc += `</table>`;
  sections.push(htmlSection(pc));

  // Team
  let tc = htmlSectionTitle('👥 Equipo');
  tc += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  tc += `<tr style="background:#222;"><th style="text-align:left;color:#888;">Métrica</th><th style="color:#888;">Nicole</th><th style="color:#888;">Karen</th></tr>`;
  tc += `<tr><td style="color:#CCC;">Completadas</td><td style="text-align:center;color:#FFF;">${data.team.nicole.completedWeek}</td><td style="text-align:center;color:#FFF;">${data.team.karen.completedWeek}</td></tr>`;
  tc += `<tr><td style="color:#CCC;">Tasa a tiempo</td><td style="text-align:center;color:#FFF;">${data.team.nicole.onTimeRate}%</td><td style="text-align:center;color:#FFF;">${data.team.karen.onTimeRate}%</td></tr>`;
  tc += `</table>`;
  sections.push(htmlSection(tc));

  // AI
  let ai = htmlSectionTitle('🤖 Análisis IA');
  ai += `<p style="font-size:14px;color:#CCC;line-height:1.6;margin:0;">${data.aiAnalysis}</p>`;
  sections.push(htmlSection(ai));

  sections.push(`<tr><td style="padding:16px 24px;background:#0D0D0D;text-align:center;"><p style="margin:0;font-size:11px;color:#555;">JP Legacy Agent · Reporte Semanal · ${range}</p></td></tr>`);

  return htmlWrapper('Reporte Semanal Marketing JP', sections.join('\n'));
}

function buildMonthlyHTML(data) {
  const range = data.monthRange ? data.monthRange.label : data.todayFormatted;
  const sections = [];

  sections.push(htmlHeader(
    '📊 Reporte Mensual Marketing JP',
    `${range} · Generado: ${data.generatedAt} ET`
  ));

  let alertsContent = htmlSectionTitle('🚨 Resumen de Alertas');
  if (data.alerts.critical.length === 0 && data.alerts.attention.length === 0) {
    alertsContent += '<p style="color:#4CAF50;margin:0;">✅ Mes sin alertas críticas</p>';
  } else {
    for (const a of data.alerts.critical) alertsContent += buildAlertBadge('critical', a);
    for (const a of data.alerts.attention) alertsContent += buildAlertBadge('attention', a);
  }
  sections.push(htmlSection(alertsContent));

  let cad = htmlSectionTitle('📊 Cadencia Mensual');
  cad += `<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">`;
  cad += `<tr style="background:#222;"><th style="text-align:left;color:#888;">Cuenta</th><th style="color:#888;">Meta</th><th style="color:#888;">Real</th><th style="color:#888;">Estado</th></tr>`;
  for (const row of [{ label: 'Paola', key: 'Paola' }, { label: 'Jorge', key: 'Jorge' }, { label: 'JP Legacy', key: 'JP Legacy' }]) {
    const c = data.cadence[row.key];
    const pct = c.goal > 0 ? c.actual / c.goal : 0;
    const status = pct >= 1 ? '🟢' : pct >= 0.5 ? '🟡' : '🔴';
    cad += `<tr style="border-bottom:1px solid #2A2A2A;"><td style="color:#CCC;">${row.label}</td><td style="text-align:center;color:#888;">${c.goal}/mes</td><td style="text-align:center;color:#FFF;font-weight:bold;">${c.actual}/mes</td><td style="text-align:center;">${status}</td></tr>`;
  }
  cad += `</table>`;
  sections.push(htmlSection(cad));

  let inv = htmlSectionTitle('📦 Inventario del Mes');
  inv += `<table width="100%" cellpadding="4" cellspacing="0" style="font-size:13px;color:#CCC;">`;
  inv += `<tr><td>Producidos:</td><td><strong style="color:#FFF;">${data.inventory.producedThisWeek}</strong></td></tr>`;
  inv += `<tr><td>Publicados:</td><td><strong style="color:#FFF;">${data.inventory.publishedThisWeek}</strong></td></tr>`;
  const surplus = data.inventory.producedThisWeek - data.inventory.publishedThisWeek;
  inv += `<tr><td>${surplus >= 0 ? 'Superávit' : 'Déficit'}:</td><td><strong style="color:${surplus >= 0 ? '#4CAF50' : '#FF4444'};">${surplus >= 0 ? '+' : ''}${surplus}</strong></td></tr>`;
  inv += `</table>`;
  sections.push(htmlSection(inv));

  let ai = htmlSectionTitle('🤖 Análisis IA Mensual');
  ai += `<p style="font-size:14px;color:#CCC;line-height:1.6;margin:0;">${data.aiAnalysis}</p>`;
  sections.push(htmlSection(ai));

  sections.push(`<tr><td style="padding:16px 24px;background:#0D0D0D;text-align:center;"><p style="margin:0;font-size:11px;color:#555;">JP Legacy Agent · Reporte Mensual · ${range}</p></td></tr>`);

  return htmlWrapper('Reporte Mensual Marketing JP', sections.join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL SENDERS
// ══════════════════════════════════════════════════════════════════════════════

async function sendDailyMarketingReport() {
  console.log('[marketingReport] Building daily data...');
  let data;
  try {
    data = await buildDailyData();
  } catch (err) {
    console.error('[marketingReport] buildDailyData fatal error:', err);
    return;
  }

  const text = buildDailyText(data);
  const html = buildDailyHTML(data);
  const subject = `📊 Reporte Diario Marketing JP — ${data.todayFormatted}`;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: 'JP Legacy Agent <apps@jplegacygroup.com>',
      to: RECIPIENTS,
      subject,
      text,
      html,
    });
    console.log('[marketingReport] Daily report sent:', result?.data?.id || 'ok');
  } catch (err) {
    console.error('[marketingReport] Email send error:', err.message);
  }
}

async function sendWeeklyMarketingReport() {
  console.log('[marketingReport] Building weekly data...');
  let data;
  try {
    data = await buildWeeklyData();
  } catch (err) {
    console.error('[marketingReport] buildWeeklyData fatal error:', err);
    return;
  }

  const range = data.weekRange ? `${data.weekRange.start} — ${data.weekRange.end}` : data.todayFormatted;
  const subject = `📊 Reporte Semanal Marketing JP — ${range}`;
  const html = buildWeeklyHTML(data);
  const text = buildDailyText(data); // reuse text builder as fallback

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: 'JP Legacy Agent <apps@jplegacygroup.com>',
      to: RECIPIENTS,
      subject,
      text,
      html,
    });
    console.log('[marketingReport] Weekly report sent:', result?.data?.id || 'ok');
  } catch (err) {
    console.error('[marketingReport] Weekly email send error:', err.message);
  }
}

async function sendMonthlyMarketingReport() {
  console.log('[marketingReport] Building monthly data...');
  let data;
  try {
    data = await buildMonthlyData();
  } catch (err) {
    console.error('[marketingReport] buildMonthlyData fatal error:', err);
    return;
  }

  const range = data.monthRange ? data.monthRange.label : data.todayFormatted;
  const subject = `📊 Reporte Mensual Marketing JP — ${range}`;
  const html = buildMonthlyHTML(data);
  const text = buildDailyText(data);

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: 'JP Legacy Agent <apps@jplegacygroup.com>',
      to: RECIPIENTS,
      subject,
      text,
      html,
    });
    console.log('[marketingReport] Monthly report sent:', result?.data?.id || 'ok');
  } catch (err) {
    console.error('[marketingReport] Monthly email send error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CRON REGISTRATION
// ══════════════════════════════════════════════════════════════════════════════

function startMarketingReport() {
  // Daily Mon-Fri at 9am ET (14:00 UTC)
  cron.schedule('0 13 * * 1-5', async () => {
    console.log('[marketingReport] Daily cron fired');
    await sendDailyMarketingReport();
  });

  // Weekly on Monday at 9am ET (14:00 UTC) — same time as daily, but weekly report runs additionally
  cron.schedule('0 13 * * 1', async () => {
    console.log('[marketingReport] Weekly cron fired');
    await sendWeeklyMarketingReport();
  });

  // Monthly on 1st at 9am ET (14:00 UTC)
  cron.schedule('0 13 1 * *', async () => {
    console.log('[marketingReport] Monthly cron fired');
    await sendMonthlyMarketingReport();
  });

  console.log('[marketingReport] Cron jobs registered: daily (Mon-Fri 9am ET), weekly (Mon 9am ET), monthly (1st 9am ET)');
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
  buildDailyText,
  buildWeeklyData,
  buildMonthlyData,
};
