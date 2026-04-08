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

const CADENCE_GOALS = { PAOLA: 5, JORGE: 4, JP_LEGACY: 7 };

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
  return { Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}` };
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Fetch all pages of tasks from Asana for a project */
async function fetchPipelineTasks() {
  const tasks = [];
  let offset = null;
  const optFields = [
    'name', 'assignee', 'assignee.name', 'tags', 'tags.name',
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

/** Classify accounts from task tags */
function getTaskAccounts(task) {
  const accounts = [];
  if (!task.tags || task.tags.length === 0) return accounts;
  for (const tag of task.tags) {
    const name = (tag.name || '').toLowerCase();
    if (name.includes('paola')) accounts.push('PAOLA');
    if (name.includes('jorge')) accounts.push('JORGE');
    if (name.includes('jp legacy') || name.includes('jplegacy')) accounts.push('JP_LEGACY');
  }
  return [...new Set(accounts)];
}

/** Extract platform tags (non-account tags) */
function getTaskPlatformTags(task) {
  if (!task.tags || task.tags.length === 0) return [];
  const accountKeywords = ['paola', 'jorge', 'jp legacy', 'jplegacy'];
  return task.tags
    .map(t => t.name || '')
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

/** Enrich a pipeline task with derived fields */
function enrichPipelineTask(task) {
  const stage = getTaskStage(task);
  const accounts = getTaskAccounts(task);
  const links = extractLinks(task.notes);
  const platforms = getTaskPlatformTags(task);
  const days = daysInStage(task);
  const stagnated = days > 3 && !NON_STAGNATED_STAGES.includes(stage);

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
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEAM METRICS CALCULATOR
// ══════════════════════════════════════════════════════════════════════════════

function calcTeamMemberMetrics(memberName, tasks, weekStart, weekEnd, today) {
  const isMatch = (t) => {
    if (!t.assignee) return false;
    const lower = (t.assignee || '').toLowerCase();
    if (memberName.toLowerCase().includes('karen')) return lower.includes('karen');
    return lower === memberName.toLowerCase();
  };

  const myTasks = tasks.filter(t => isMatch(t));

  const completedWeek = myTasks.filter(t =>
    t.completed && t.completed_at &&
    isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
  ).length;

  const inProgressToday = myTasks.filter(t =>
    !t.completed && t.due_on === today
  ).length;

  const pendingToday = myTasks.filter(t =>
    !t.completed && t.due_on && t.due_on < today
  ).length;

  // On-time rate: completed tasks with due_on where completed_at date <= due_on
  const completedWithDue = myTasks.filter(t => t.completed && t.completed_at && t.due_on);
  const onTime = completedWithDue.filter(t => t.completed_at.slice(0, 10) <= t.due_on);
  const onTimeRate = completedWithDue.length > 0
    ? Math.round((onTime.length / completedWithDue.length) * 100)
    : 0;

  // Streak: consecutive days (backwards from yesterday) with >= 1 completion
  let streak = 0;
  const todayDate = parseDate(today);
  let checkDate = new Date(todayDate);
  checkDate.setUTCDate(checkDate.getUTCDate() - 1);

  for (let i = 0; i < 30; i++) {
    const checkStr = fmtDate(checkDate);
    const completedOnDay = myTasks.some(t =>
      t.completed && t.completed_at && t.completed_at.slice(0, 10) === checkStr
    );
    if (!completedOnDay) break;
    streak++;
    checkDate.setUTCDate(checkDate.getUTCDate() - 1);
  }

  return { completedWeek, inProgressToday, pendingToday, streak, onTimeRate };
}

// ══════════════════════════════════════════════════════════════════════════════
// AI ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

async function generateAIAnalysis(data) {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const context = [
      `Pipeline: ${data.pipeline.activeTotal} videos activos.`,
      `Alerts: ${data.alerts.critical.length} críticas, ${data.alerts.attention.length} atención.`,
      `Estancados: ${data.stagnated.length}.`,
      `Nicole: ${data.team.nicole.completedWeek} completadas semana.`,
      `Karen: ${data.team.karen.completedWeek} completadas semana.`,
      `Cadencia Paola: ${data.cadence.PAOLA.actual}/${data.cadence.PAOLA.goal},`,
      `Jorge: ${data.cadence.JORGE.actual}/${data.cadence.JORGE.goal},`,
      `JP Legacy: ${data.cadence.JP_LEGACY.actual}/${data.cadence.JP_LEGACY.goal}.`,
    ].join(' ');

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Analiza estos datos del pipeline de marketing de JP Legacy Group y da observaciones clave, cuellos de botella detectados y 2-3 recomendaciones concretas. Tono ejecutivo en español. Solo el párrafo de análisis, máximo 150 palabras, sin preámbulos.\n\n${context}`,
      }],
    });
    return msg.content[0].text;
  } catch (err) {
    console.error('[marketingReport] AI analysis error:', err.message);
    return '[Análisis IA no disponible — error de conexión]';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ALERT BUILDER
// ══════════════════════════════════════════════════════════════════════════════

function buildAlerts(pipeline, accounts, today, weekStart, weekEnd) {
  const critical = [];
  const attention = [];

  const stages = pipeline.stages;

  // Critical: Approved stage has 0 tasks
  const approvedCount = (stages['Aproved'] || []).length;
  if (approvedCount === 0) {
    critical.push('Stage "Aprobado" tiene 0 videos — no hay contenido listo para publicar');
  }

  // Critical: Ready to upload has 0 tasks
  const readyCount = (stages['Ready to upload'] || []).length;
  if (readyCount === 0) {
    critical.push('Stage "Ready to upload" tiene 0 videos');
  }

  // Critical: task due today with no dropbox link
  const allActive = Object.values(stages).flat();
  const dueTodayNoFile = allActive.filter(t =>
    t.due_on === today && !t.links.dropbox && !NON_STAGNATED_STAGES.includes(t.stage)
  );
  for (const t of dueTodayNoFile) {
    critical.push(`"${t.name}" vence HOY sin archivo Dropbox`);
  }

  // Critical: account has 0 scheduled in next 7 days AND 0 published this week
  const next7End = addDays(today, 7);
  for (const [acct, acctData] of Object.entries(accounts)) {
    const upcoming = acctData.tasks.filter(t =>
      t.stage === 'Scheduled/Publlished' && t.due_on &&
      t.due_on >= today && t.due_on <= next7End
    );
    const publishedThisWeek = acctData.tasks.filter(t =>
      t.completed && t.completed_at &&
      isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd) &&
      t.stage === 'Scheduled/Publlished'
    );
    if (upcoming.length === 0 && publishedThisWeek.length === 0) {
      critical.push(`Cuenta ${acctData.name}: 0 publicaciones programadas en próximos 7 días y 0 publicadas esta semana`);
    }
  }

  // Attention: Resources pending > 2 days
  const resPending = (stages['Resources pending'] || []).filter(t => t.days_in_stage > 2);
  for (const t of resPending) {
    attention.push(`"${t.name}" lleva ${t.days_in_stage} días en "Resources pending"`);
  }

  // Attention: account < 2 tasks in next 7 days
  for (const [acct, acctData] of Object.entries(accounts)) {
    const upcoming = acctData.tasks.filter(t =>
      t.due_on && t.due_on >= today && t.due_on <= next7End
    );
    if (upcoming.length < 2) {
      attention.push(`Cuenta ${acctData.name}: solo ${upcoming.length} tarea(s) en próximos 7 días`);
    }
  }

  // Attention: > 24 tasks with no due date
  const noDate = allActive.filter(t => !t.due_on && !t.completed);
  if (noDate.length > 24) {
    attention.push(`${noDate.length} videos sin fecha asignada (umbral: 24)`);
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

  // ── Enrich pipeline tasks ─────────────────────────────────────────────────
  const tasks = rawPipeline.map(enrichPipelineTask);

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

  const stageCounts = {};
  for (const [s, arr] of Object.entries(stagesMap)) stageCounts[s] = arr.length;

  const activeStages = PIPELINE_STAGES.filter(s => !['Scheduled/Publlished', 'Archive', 'Paused', 'Backup'].includes(s));
  const activeTotal = activeStages.reduce((sum, s) => sum + (stagesMap[s] || []).length, 0);

  // ── Build accounts ────────────────────────────────────────────────────────
  const accountDefs = {
    PAOLA: { name: 'Paola Díaz' },
    JORGE: { name: 'Jorge Florez' },
    JP_LEGACY: { name: 'JP Legacy Group' },
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
      : 999;

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

  // ── Stagnated videos ──────────────────────────────────────────────────────
  const stagnated = tasks.filter(t => t.stagnated && !t.completed);

  // ── Pipeline object ───────────────────────────────────────────────────────
  const pipeline = { stages: stagesMap, stageCounts, activeTotal };

  // ── Alerts ────────────────────────────────────────────────────────────────
  let alerts = { critical: [], attention: [] };
  try {
    alerts = buildAlerts(pipeline, accounts, today, weekStart, weekEnd);
  } catch (err) {
    console.error('[marketingReport] Alert build error:', err.message);
  }

  // ── Inventory ─────────────────────────────────────────────────────────────
  const allActive = tasks.filter(t => !t.completed);
  const readyToUpload = (stagesMap['Ready to upload'] || []).length;
  const noDate = allActive.filter(t => !t.due_on).length;
  const pausedRecoverable = (stagesMap['Paused'] || []).length;

  const producedThisWeek = tasks.filter(t =>
    t.completed && t.completed_at &&
    isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
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
  const teamTasks = rawTeam.map(t => ({
    ...t,
    assignee: t.assignee ? t.assignee.name : null,
    completed_at: t.completed_at || null,
    due_on: t.due_on || null,
  }));

  const nicoleMetrics = calcTeamMemberMetrics('Nicole Zapata', teamTasks, weekStart, weekEnd, today);
  const karenMetrics = calcTeamMemberMetrics('karen', teamTasks, weekStart, weekEnd, today);

  const mostProductiveToday = nicoleMetrics.inProgressToday >= karenMetrics.inProgressToday
    ? 'Nicole Zapata'
    : 'Karen';

  const team = {
    nicole: nicoleMetrics,
    karen: karenMetrics,
    mostProductiveToday,
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
    PAOLA: { name: 'Paola Díaz' },
    JORGE: { name: 'Jorge Florez' },
    JP_LEGACY: { name: 'JP Legacy Group' },
  };

  const accounts = {};
  for (const [key, def] of Object.entries(accountDefs)) {
    const acctTasks = tasks.filter(t => t.accounts.includes(key));
    const publishedThisWeek = acctTasks.filter(t =>
      t.completed && t.completed_at &&
      isInRange(t.completed_at.slice(0, 10), weekStart, weekEnd)
    ).length;
    const publishedToday = 0;
    const daysSincePublish = 0;
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
    PAOLA: { name: 'Paola Díaz' },
    JORGE: { name: 'Jorge Florez' },
    JP_LEGACY: { name: 'JP Legacy Group' },
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
    accounts[key] = { name: def.name, tasks: acctTasks, publishedToday: 0, publishedThisWeek, daysSincePublish: 0, upcomingWeek: [], contentBalance };
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

function buildDailyText(data) {
  const HR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines = [];

  lines.push(`📊 REPORTE DIARIO MARKETING JP — ${data.todayFormatted}`);
  lines.push(`Generado: ${data.generatedAt} ET`);
  lines.push(HR);
  lines.push('');

  // Alerts
  lines.push('🚨 ALERTAS CRÍTICAS');
  if (data.alerts.critical.length === 0) {
    lines.push('✅ Sin alertas críticas');
  } else {
    for (const a of data.alerts.critical) lines.push(`🔴 ${a}`);
  }
  if (data.alerts.attention.length > 0) {
    lines.push('');
    lines.push('⚠️ ATENCIÓN');
    for (const a of data.alerts.attention) lines.push(`🟡 ${a}`);
  }
  lines.push('');

  // Accounts
  const accountOrder = [
    { key: 'PAOLA', label: '👤 PAOLA DÍAZ' },
    { key: 'JORGE', label: '👤 JORGE FLOREZ' },
    { key: 'JP_LEGACY', label: '👤 JP LEGACY GROUP' },
  ];

  for (const { key, label } of accountOrder) {
    lines.push(HR);
    lines.push(label);
    lines.push('');
    const acct = data.accounts[key];
    if (!acct) { lines.push('[Datos no disponibles]'); lines.push(''); continue; }

    const goal = CADENCE_GOALS[key];
    lines.push(`Publicados hoy: ${acct.publishedToday} | Esta semana: ${acct.publishedThisWeek}/${goal}`);
    lines.push(`Días sin publicar: ${acct.daysSincePublish}`);

    // Content balance
    const balEntries = Object.entries(acct.contentBalance);
    if (balEntries.length > 0) {
      const total = balEntries.reduce((s, [, v]) => s + v, 0);
      const balStr = balEntries.map(([p, n]) => `${p} ${Math.round((n / total) * 100)}%`).join(' | ');
      lines.push(`Balance de contenido (7 días): ${balStr}`);
    }

    lines.push('');
    lines.push('📅 Próximos 7 días:');
    if (acct.upcomingWeek.length === 0) {
      lines.push('  Sin contenido programado');
    } else {
      for (const t of acct.upcomingWeek) {
        lines.push(`${t.due_on} — ${t.name}`);
        if (t.platforms.length > 0) lines.push(`  📱 ${t.platforms.join(', ')}`);
        if (t.links.dropbox) lines.push(`  🔗 ${t.links.dropbox}`);
        else lines.push('  ⚠️ Sin archivo Dropbox');
        lines.push(`  Stage: ${t.stage}`);
      }
    }
    lines.push('');
  }

  // Pipeline
  lines.push(HR);
  lines.push('🎬 PIPELINE GENERAL — Estado por Stage');
  lines.push('');
  const activeStageList = [
    'Concept/Idea', 'Resources pending', 'Ready to edit',
    'Editing / Design', 'Review & Feedback', 'Aproved', 'Ready to upload',
  ];
  for (const s of activeStageList) {
    const count = data.pipeline.stageCounts[s] || 0;
    let extra = '';
    if (s === 'Resources pending') {
      const blocked = (data.pipeline.stages[s] || []).filter(t => t.days_in_stage > 2).length;
      if (blocked > 0) extra = ` [${blocked} bloqueados ⚠️]`;
    }
    if (s === 'Aproved' && count === 0) extra = ' [⚠️ ALERTA]';
    lines.push(`${s.padEnd(22)} ${count} videos${extra}`);
  }
  lines.push('──────────────────────');
  lines.push(`Pipeline activo total: ${data.pipeline.activeTotal} videos`);
  lines.push('');
  lines.push(`Scheduled/Published   ${data.pipeline.stageCounts['Scheduled/Publlished'] || 0} (histórico total)`);
  lines.push(`Paused                ${data.pipeline.stageCounts['Paused'] || 0} | Backup: ${data.pipeline.stageCounts['Backup'] || 0}`);
  lines.push('');

  // Stagnated
  lines.push(HR);
  lines.push('⏱️ VIDEOS ESTANCADOS (+3 días sin moverse)');
  lines.push('');
  if (data.stagnated.length === 0) {
    lines.push('✅ Sin videos estancados hoy');
  } else {
    for (const t of data.stagnated) {
      lines.push(t.name);
      lines.push(`  Stage: ${t.stage} | Lleva: ${t.days_in_stage} días`);
      lines.push(`  Cuenta: ${t.accounts.join(', ') || '—'}`);
      lines.push(`  Responsable: ${t.assignee || '—'}`);
      if (t.links.dropbox) lines.push(`  🔗 ${t.links.dropbox}`);
    }
  }
  lines.push('');

  // Inventory
  lines.push(HR);
  lines.push('📦 INVENTARIO');
  lines.push('');
  lines.push(`Ready to upload: ${data.inventory.readyToUpload} videos listos para publicar`);
  lines.push(`Sin fecha asignada: ${data.inventory.noDate} videos`);
  lines.push(`Paused recuperables: ${data.inventory.pausedRecoverable}`);
  lines.push('');
  lines.push('Ratio producción/publicación esta semana:');
  const surplus = data.inventory.producedThisWeek - data.inventory.publishedThisWeek;
  lines.push(`  Terminados: ${data.inventory.producedThisWeek} | Publicados: ${data.inventory.publishedThisWeek} | ${surplus >= 0 ? `Superávit: +${surplus}` : `Déficit: ${surplus}`}`);
  lines.push('');

  // Cadence
  lines.push(HR);
  lines.push('📊 CADENCIA SEMANAL');
  lines.push('');
  lines.push('             Meta    Real    Estado');
  const cadenceRows = [
    { label: 'Paola', key: 'PAOLA' },
    { label: 'Jorge', key: 'JORGE' },
    { label: 'JP Legacy', key: 'JP_LEGACY' },
  ];
  for (const row of cadenceRows) {
    const c = data.cadence[row.key];
    const pct = c.goal > 0 ? c.actual / c.goal : 0;
    const status = pct >= 1 ? '🟢' : pct >= 0.5 ? '🟡' : '🔴';
    lines.push(`${row.label.padEnd(13)} ${String(c.goal + '/sem').padEnd(8)} ${String(c.actual + '/sem').padEnd(8)} ${status}`);
  }
  lines.push('');

  // Team
  lines.push(HR);
  lines.push('👥 EQUIPO — Semana actual');
  lines.push('');
  lines.push('👤 Nicole Zapata');
  lines.push(`  Completadas esta semana: ${data.team.nicole.completedWeek}`);
  lines.push(`  En progreso hoy: ${data.team.nicole.inProgressToday}`);
  lines.push(`  Pendientes hoy: ${data.team.nicole.pendingToday}`);
  lines.push(`  Racha: ${data.team.nicole.streak} días | Tasa a tiempo: ${data.team.nicole.onTimeRate}%`);
  lines.push('');
  lines.push('👤 Karen');
  lines.push(`  Completadas esta semana: ${data.team.karen.completedWeek}`);
  lines.push(`  En progreso hoy: ${data.team.karen.inProgressToday}`);
  lines.push(`  Pendientes hoy: ${data.team.karen.pendingToday}`);
  lines.push(`  Racha: ${data.team.karen.streak} días | Tasa a tiempo: ${data.team.karen.onTimeRate}%`);
  lines.push('');
  const mostProd = data.team.mostProductiveToday;
  const mostProdCount = mostProd === 'Nicole Zapata'
    ? data.team.nicole.inProgressToday
    : data.team.karen.inProgressToday;
  lines.push(`🏆 Más productiva hoy: ${mostProd} con ${mostProdCount} tareas`);
  lines.push('');

  // AI
  lines.push(HR);
  lines.push('🤖 Análisis IA — JP Legacy Agent');
  lines.push(data.aiAnalysis);
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
    { key: 'PAOLA', icon: '👤', label: 'Paola Díaz' },
    { key: 'JORGE', icon: '👤', label: 'Jorge Florez' },
    { key: 'JP_LEGACY', icon: '🏢', label: 'JP Legacy Group' },
  ];

  for (const { key, icon, label } of accountOrder) {
    const acct = data.accounts[key];
    if (!acct) continue;
    const goal = CADENCE_GOALS[key];
    let ac = htmlSectionTitle(`${icon} ${label}`);
    ac += `<table width="100%" cellpadding="4" cellspacing="0" style="font-size:13px;color:#CCC;">`;
    ac += `<tr><td>Publicados hoy:</td><td><strong style="color:#FFF;">${acct.publishedToday}</strong></td>`;
    ac += `<td>Esta semana:</td><td><strong style="color:#FFF;">${acct.publishedThisWeek}/${goal}</strong></td></tr>`;
    ac += `<tr><td>Días sin publicar:</td><td colspan="3"><strong style="color:${acct.daysSincePublish > 4 ? '#FF4444' : '#FFF'};">${acct.daysSincePublish}</strong></td></tr>`;
    ac += `</table>`;

    if (acct.upcomingWeek.length > 0) {
      ac += `<p style="font-size:12px;color:#888;margin:12px 0 6px;">📅 PRÓXIMOS 7 DÍAS</p>`;
      for (const t of acct.upcomingWeek) {
        ac += `<div style="background:#222;border-radius:4px;padding:8px 10px;margin-bottom:6px;font-size:13px;">`;
        ac += `<strong style="color:#FFF;">${t.due_on}</strong> — ${t.name}`;
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
      sc += `<strong style="color:#FF8800;">${t.name}</strong>`;
      sc += `<br><span style="color:#AAA;">Stage: ${t.stage} | ${t.days_in_stage} días | ${t.assignee || '—'}</span>`;
      if (t.accounts.length > 0) sc += `<br><span style="color:#888;">Cuenta: ${t.accounts.join(', ')}</span>`;
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
  const cadenceRows = [{ label: 'Paola', key: 'PAOLA' }, { label: 'Jorge', key: 'JORGE' }, { label: 'JP Legacy', key: 'JP_LEGACY' }];
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
  for (const row of [{ label: 'Paola', key: 'PAOLA' }, { label: 'Jorge', key: 'JORGE' }, { label: 'JP Legacy', key: 'JP_LEGACY' }]) {
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
  for (const row of [{ label: 'Paola', key: 'PAOLA' }, { label: 'Jorge', key: 'JORGE' }, { label: 'JP Legacy', key: 'JP_LEGACY' }]) {
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
  cron.schedule('0 14 * * 1-5', async () => {
    console.log('[marketingReport] Daily cron fired');
    await sendDailyMarketingReport();
  });

  // Weekly on Monday at 9am ET (14:00 UTC) — same time as daily, but weekly report runs additionally
  cron.schedule('0 14 * * 1', async () => {
    console.log('[marketingReport] Weekly cron fired');
    await sendWeeklyMarketingReport();
  });

  // Monthly on 1st at 9am ET (14:00 UTC)
  cron.schedule('0 14 1 * *', async () => {
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
  buildWeeklyData,
  buildMonthlyData,
};
