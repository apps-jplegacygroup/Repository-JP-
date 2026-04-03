/**
 * FUB Report Service
 * Extracts lead data from Follow Up Boss API for monthly reporting.
 */

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { scoreLeadFromNotes } = require('./leadScore');
const { getLeadsComparisonCache, saveLeadsComparisonCache } = require('../utils/storage');
const { updatePersonSource } = require('./fub');

const FUB_BASE_URL = 'https://api.followupboss.com/v1';

// Exact stage names in FUB
const STAGE_UNDER_CONTRACT = 'Under Contract';
const STAGE_CERRADO = 'Cerrado';

// Source normalization rules — applied before grouping
// null = exclude entirely (not a real lead source)
const SOURCE_MAP = {
  // ── EXCLUIDOS ───────────────────────────────────────────────────────────
  'Contacts (not leads)':           null,
  '<unspecified>':                  'Sin clasificar ⚠️',
  'Company':                        null,
  'Branded Website':                null,
  'Compass':                        null,
  'Eventos':                        null,
  'Ex miembros':                    null,
  'Import':                         null,
  'Jose David':                     null,
  'KVCore':                         null,
  'Mortgage Calculator':            null,
  'Sales agents constructoras':     null,
  'Sebastian Martinez (realtor)':   null,
  'Svenka Millender':               null,
  'Ylopo':                          null,
  'New Lead Source...':             null,

  // ── RENOMBRADOS ─────────────────────────────────────────────────────────
  'Facebook':                           'Facebook JP',
  'Facebook Jorge':                     'Facebook Jorge',
  'Facebook Paola':                     'Facebook Paola',
  'Instagram JP':                       'Instagram JP',
  'Instagram Jorge':                    'Instagram Jorge',
  'Instagram Paola':                    'Instagram Paola',
  'Tik Tok Jorge':                      'TikTok Jorge',
  'Tik Tok JP Legacy Group':            'TikTok JP Legacy',
  'Tik Tok Paola':                      'TikTok Paola',
  'WhatsApp Paola':                     'WhatsApp Paola',
  'Jp Legacy Number (Jorge y Paola)':   'WhatsApp JP Legacy',
  'Youtube Jorge':                      'YouTube Jorge',
  'Youtube Paola':                      'YouTube Paola',
  'Homes.com':                          'Homes.com',
  'Zillow':                             'Zillow',
  'Referral JP':                        'Referidos JP',
  'Karina Araya':                       'Referidos Karina',
  'Carlos Carreno':                     'Referidos Carlos',
  'Richard Garcia':                     'Referidos Richard',
  'Pauta Facebook JP':                  'Pauta Facebook JP',
  'Pauta Facebook Leads Paola':         'Pauta Facebook Paola',
  'Formulario Web':                     'Formulario Web',
  'Wojo FB Ads':                        'Wojo FB Ads',
  'Jorge Florez Personal':              'Jorge Personal',
  'LinkedIn Paola':                     'LinkedIn Paola',
  'JP LEGACY LISTINGS':                 'JP Legacy Listings',
  // Concatenated Respond.io tags (handled here before cleanSourceTag)
  'PaolaJorge Florez,Instagram,Nuevo Lead': 'Instagram Paola',
  'PaolaJP Legacy,Facebook,Nuevo Lead':     'Facebook Paola',
  'PaolaPaola Diaz,Instagram,Nuevo Lead':   'Instagram Paola',
};

function normalizeSource(raw) {
  const source = (raw || '').trim();
  if (source === '') return 'Sin fuente';
  if (Object.prototype.hasOwnProperty.call(SOURCE_MAP, source)) {
    return SOURCE_MAP[source]; // null = ignore
  }
  // If it looks like a concatenated Respond.io tag, clean it
  if (source.includes(',') || /^Paola|^JP Legacy/.test(source)) {
    return cleanSourceTag(source);
  }
  return source;
}

function fubHeaders() {
  const apiKey = process.env.FUB_API_KEY;
  if (!apiKey) throw new Error('FUB_API_KEY is not set');
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  return {
    Authorization: `Basic ${encoded}`,
    'Content-Type': 'application/json',
  };
}

function formatUSD(n) {
  if (!n) return '$0';
  return '$' + Number(n).toLocaleString('en-US');
}

// ─── Source Cleaner ────────────────────────────────────────────────────────

/**
 * Detects the agent (Paola / Jorge / JP) from the first segment of a
 * concatenated Respond.io source string.
 * Format: "[prefix][AgentFullName],[Channel],[Stage]"
 */
function detectAgent(rawSource) {
  if (rawSource.includes('Paola Diaz'))                      return 'Paola';
  if (rawSource.includes('Jorge Florez') || rawSource.includes('Jorge')) return 'Jorge';
  if (rawSource.includes('JP Legacy'))                       return 'JP';
  if (rawSource.includes('Paola'))                           return 'Paola';
  return 'JP';
}

/**
 * Cleans the raw FUB source field, which arrives as concatenated Respond.io tags
 * (e.g. "PaolaPaola Diaz,Instagram,Nuevo Lead") and returns a clean channel name.
 *
 * Valid sources: Instagram Paola/Jorge/JP, Facebook Paola/Jorge/JP,
 *   TikTok Paola/Jorge/JP, YouTube Paola/Jorge, WhatsApp,
 *   Zillow, Homes.com, Referidos, Sin fuente
 */
function cleanSourceTag(rawSource) {
  if (!rawSource) return 'Sin fuente';
  const lower = rawSource.toLowerCase();

  // Pass-through already-clean (normalized) sources
  const clean = [
    'Instagram Paola', 'Instagram Jorge', 'Instagram JP',
    'Facebook Paola',  'Facebook Jorge',  'Facebook JP',
    'TikTok Paola',    'TikTok Jorge',    'TikTok JP Legacy',
    'YouTube Paola',   'YouTube Jorge',
    'WhatsApp JP Legacy', 'WhatsApp Paola',
    'Zillow', 'Homes.com',
    'Referidos JP', 'Referidos Karina', 'Referidos Carlos', 'Referidos Richard',
    'Pauta Facebook JP', 'Pauta Facebook Paola',
    'Formulario Web', 'Wojo FB Ads', 'Jorge Personal',
    'LinkedIn Paola', 'JP Legacy Listings', 'Sin fuente',
  ];
  if (clean.includes(rawSource)) return rawSource;

  // Detect channel
  let channel = null;
  if (lower.includes('instagram'))                                   channel = 'Instagram';
  else if (lower.includes('whatsapp') || lower.includes('whatapp')) channel = 'WhatsApp';
  else if (lower.includes('facebook'))                               channel = 'Facebook';
  else if (lower.includes('tiktok'))                                 channel = 'TikTok';
  else if (lower.includes('youtube'))                                channel = 'YouTube';
  else if (lower.includes('zillow'))                                 return 'Zillow';
  else if (lower.includes('homes.com'))                              return 'Homes.com';
  else if (lower.includes('referido'))                               return 'Referidos';

  if (!channel) {
    // Pattern: "PaolaUnknown", "JorgeUnknown", "JPUnknown" — Respond.io couldn't identify the channel
    if (/^Paola/i.test(rawSource)) return 'Sin canal (Paola)';
    if (/^Jorge/i.test(rawSource)) return 'Sin canal (Jorge)';
    if (/^JP/i.test(rawSource))    return 'Sin canal (JP)';
    return rawSource;
  }

  if (channel === 'WhatsApp') return 'WhatsApp';

  // For all other channels, detect agent
  const agent = detectAgent(rawSource);

  if (channel === 'Instagram') {
    if (agent === 'Paola') return 'Instagram Paola';
    if (agent === 'Jorge') return 'Instagram Jorge';
    return 'Instagram JP';
  }
  if (channel === 'Facebook') {
    if (agent === 'Paola') return 'Facebook Paola';
    if (agent === 'Jorge') return 'Facebook Jorge';
    return 'Facebook JP';
  }
  if (channel === 'TikTok') {
    if (agent === 'Paola') return 'TikTok Paola';
    if (agent === 'Jorge') return 'TikTok Jorge';
    return 'TikTok JP';
  }
  if (channel === 'YouTube') {
    if (agent === 'Paola') return 'YouTube Paola';
    return 'YouTube Jorge'; // YouTube only has Paola/Jorge
  }

  return rawSource;
}

// ─── FUB API Fetchers ──────────────────────────────────────────────────────

/**
 * Fetch all people created within a month.
 * Paginates DESC by created, stops once records fall before the month start.
 */
async function fetchPeopleForMonth(year, month) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0, 23, 59, 59);

  const people = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await axios.get(`${FUB_BASE_URL}/people`, {
      headers: fubHeaders(),
      params: { sort: '-created', limit, offset },
      timeout: 15000,
    });

    const batch = response.data?.people || [];
    if (batch.length === 0) break;

    const inMonth = batch.filter((p) => {
      const created = new Date(p.created);
      return created >= firstDay && created <= lastDay;
    });
    people.push(...inMonth);

    const oldest = new Date(batch[batch.length - 1]?.created || 0);
    if (oldest < firstDay) break;
    if (batch.length < limit) break;
    offset += limit;
  }

  return people;
}

/**
 * Fetch notes for a list of person IDs.
 * Returns a flat array of note body strings.
 */
async function fetchNotesForPeople(personIds) {
  const noteBodies = [];
  for (const personId of personIds) {
    try {
      const response = await axios.get(`${FUB_BASE_URL}/notes`, {
        headers: fubHeaders(),
        params: { personId, limit: 10 },
        timeout: 10000,
      });
      (response.data?.notes || []).forEach((n) => {
        if (n.body) noteBodies.push(n.body);
      });
    } catch {
      // skip
    }
  }
  return noteBodies;
}

/**
 * Fetch notes for a single person. Returns array of note body strings.
 */
async function fetchNotesForPerson(personId) {
  try {
    const response = await axios.get(`${FUB_BASE_URL}/notes`, {
      headers: fubHeaders(),
      params: { personId, limit: 10 },
      timeout: 10000,
    });
    return (response.data?.notes || [])
      .map((n) => n.body)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Fetch the timestamp of the first activity (call, email, or note) for a person.
 * Uses the /events endpoint sorted ascending by id to get the earliest event.
 * Returns hours between lead creation and first event, or null if no events.
 */
async function fetchFirstActivityHours(personId, createdAt) {
  if (!createdAt) return null;
  try {
    // Sort ascending by id gives the oldest event first
    const response = await axios.get(`${FUB_BASE_URL}/events`, {
      headers: fubHeaders(),
      params: { personId, sort: 'id', limit: 1 },
      timeout: 10000,
    });
    const events = response.data?.events || [];
    if (events.length === 0) return null;

    const firstEventAt = events[0].created || events[0].createdAt;
    if (!firstEventAt) return null;

    const diffMs = new Date(firstEventAt) - new Date(createdAt);
    if (diffMs < 0) return null; // event predates lead (data anomaly)
    return diffMs / 3600000; // convert ms → hours
  } catch {
    return null;
  }
}

/**
 * Fetch leads that moved to "Cerrado" stage today.
 * Queries FUB for people with stage=Cerrado sorted by most recently updated,
 * then filters to those whose updated date matches the given date string (YYYY-MM-DD).
 * Returns array of { name, source, assignedTo } objects.
 */
async function fetchClosedToday(dateStr) {
  try {
    const response = await axios.get(`${FUB_BASE_URL}/people`, {
      headers: fubHeaders(),
      params: { stage: STAGE_CERRADO, sort: '-updated', limit: 50 },
      timeout: 15000,
    });

    const people = response.data?.people || [];

    return people
      .filter((p) => {
        const updated = p.updated || p.updatedAt || '';
        return updated.slice(0, 10) === dateStr;
      })
      .map((p) => ({
        name: [p.firstName, p.lastName].filter(Boolean).join(' ') || '—',
        source: p.source || '—',
        assignedTo: p.assignedTo || '—',
      }));
  } catch {
    return [];
  }
}

// ─── AI Notes Analysis ─────────────────────────────────────────────────────

async function analyzeNotesWithAI(noteBodies) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || noteBodies.length === 0) {
    return { topCity: '—', priceRange: '—', topBuilder: '—' };
  }

  const notesText = noteBodies.slice(0, 50).join('\n---\n');
  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Analyze these real estate lead notes and extract:
1. The most mentioned city (from: Orlando, Tampa, St. Cloud, Apopka, or other)
2. The most common price range requested (e.g. "$300,000–$400,000")
3. The most mentioned builder (from: Pulte, Toll Brothers, M/I Homes, or other)

Respond in this exact JSON format with no extra text:
{"topCity":"...","priceRange":"...","topBuilder":"..."}

Notes:
${notesText}`,
        },
      ],
    });

    const text = message.content[0]?.text || '{}';
    const json = JSON.parse(text.match(/\{.*\}/s)?.[0] || '{}');
    return {
      topCity: json.topCity || '—',
      priceRange: json.priceRange || '—',
      topBuilder: json.topBuilder || '—',
    };
  } catch {
    return { topCity: '—', priceRange: '—', topBuilder: '—' };
  }
}

// ─── Data Aggregation ──────────────────────────────────────────────────────

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item) || 'Sin asignar';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function topEntry(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function collectMonthlyFUBData(year, month) {
  console.log(`[FUBReport] Fetching people for ${year}-${String(month).padStart(2, '0')}...`);
  const people = await fetchPeopleForMonth(year, month);
  console.log(`[FUBReport] ${people.length} people found.`);

  // --- Conversions: exact stage match ---
  const underContract = people.filter((p) => p.stage === STAGE_UNDER_CONTRACT);
  const cerrado       = people.filter((p) => p.stage === STAGE_CERRADO);

  // --- Source normalization + filtering ---
  // Exclude people whose source maps to null AND exclude already-closed leads from active count
  const CLOSED_STAGES = new Set([STAGE_UNDER_CONTRACT, STAGE_CERRADO]);
  const countableLeads = people.filter(
    (p) => normalizeSource(p.source) !== null && !CLOSED_STAGES.has(p.stage)
  );
  const bySource = groupBy(countableLeads, (p) => normalizeSource(p.source));
  const conversionsBySource = groupBy(
    underContract.filter((p) => normalizeSource(p.source) !== null),
    (p) => normalizeSource(p.source)
  );
  const closedBySource = groupBy(
    cerrado.filter((p) => normalizeSource(p.source) !== null),
    (p) => normalizeSource(p.source)
  );

  // --- Agents ---
  const byAgent = groupBy(people, (p) => p.assignedTo || 'Sin asignar');

  // --- Pipeline (total + per stage) ---
  const pipeline              = people.reduce((sum, p) => sum + (Number(p.price) || 0), 0);
  const underContractPipeline = underContract.reduce((sum, p) => sum + (Number(p.price) || 0), 0);
  const cerradoPipeline       = cerrado.reduce((sum, p) => sum + (Number(p.price) || 0), 0);

  // --- First activity time: sample up to 20 leads ---
  const sample = people.slice(0, 20);
  const activityHours = await Promise.all(
    sample.map((p) => fetchFirstActivityHours(p.id, p.created))
  );
  const validTimes = activityHours.filter((h) => h !== null);
  const avgResponseHours = validTimes.length
    ? Math.round(validTimes.reduce((a, b) => a + b, 0) / validTimes.length)
    : null;

  // --- Notes AI analysis ---
  const notesSample = people.slice(0, 30).map((p) => p.id);
  const noteBodies = await fetchNotesForPeople(notesSample);
  const aiInsights = await analyzeNotesWithAI(noteBodies);

  // --- Weeks ---
  const weeks = buildWeekBreakdown(year, month, people);
  const bestWeek = weeks.reduce(
    (best, w) => (w.count > best.count ? w : best),
    weeks[0] || { label: '—', count: 0 }
  );

  return {
    total: people.length,
    countableTotal: countableLeads.length,
    bySource,
    byAgent,
    underContract: underContract.length,
    cerrado: cerrado.length,
    conversionsBySource,
    closedBySource,
    pipeline,
    underContractPipeline,
    cerradoPipeline,
    avgResponseHours,
    aiInsights,
    weeks,
    bestWeek,
    topSource: topEntry(bySource)[0],
  };
}

function buildWeekBreakdown(year, month, people) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const weeks = [];
  let weekNum = 1;
  let cur = new Date(firstDay);

  while (cur <= lastDay) {
    const wStart = new Date(cur);
    const wEnd = new Date(cur);
    wEnd.setDate(wEnd.getDate() + 6);
    if (wEnd > lastDay) wEnd.setTime(lastDay.getTime());

    const count = people.filter((p) => {
      const created = new Date(p.created);
      return created >= wStart && created <= wEnd;
    }).length;

    weeks.push({
      label: `Semana ${weekNum} (${wStart.getDate()}–${wEnd.getDate()})`,
      count,
    });

    weekNum++;
    cur.setDate(cur.getDate() + 7);
  }

  return weeks;
}

/**
 * Fetch all leads created on a specific date from FUB.
 * Returns array of { name, phone, source, score } sorted by score desc.
 * Score is extracted from the contact's Score-X tag.
 */
/**
 * Returns { dayStart, dayEnd } as UTC Date objects covering the full day
 * in America/New_York (handles EDT UTC-4 and EST UTC-5 automatically).
 *
 * Strategy: at noon UTC on the target date, check what hour it is in ET
 * using Intl — that gives us the exact UTC offset without locale parsing.
 */
function etDayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  // "8" for EDT (UTC-4), "7" for EST (UTC-5)
  const etHour = parseInt(
    noonUTC.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10
  );
  const offsetHours = 12 - etHour; // 4 for EDT, 5 for EST

  const dayStart = new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0, 0));
  const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { dayStart, dayEnd };
}

async function fetchLeadsForDate(dateStr) {
  try {
    const { dayStart, dayEnd } = etDayBounds(dateStr);

    console.log('[Debug] Fecha del reporte:', dateStr);
    console.log('[Debug] dayStart UTC:', dayStart.toISOString());
    console.log('[Debug] dayEnd UTC:', dayEnd.toISOString());

    const people = [];
    let offset = 0;
    const limit = 100;
    let totalFetched = 0;

    while (true) {
      const response = await axios.get(`${FUB_BASE_URL}/people`, {
        headers: fubHeaders(),
        params: { sort: '-created', limit, offset },
        timeout: 15000,
      });

      const batch = response.data?.people || [];
      if (batch.length === 0) break;
      totalFetched += batch.length;

      const inDay = batch.filter((p) => {
        const created = new Date(p.created);
        return created >= dayStart && created <= dayEnd
          && normalizeSource(p.source) !== null;
      });
      people.push(...inDay);

      const oldest = new Date(batch[batch.length - 1]?.created || 0);
      if (oldest < dayStart) break;
      if (batch.length < limit) break;
      offset += limit;
    }

    console.log('[Debug] Leads encontrados en FUB:', people.length);

    // Build base lead objects
    const baseLeads = people.map((p) => ({
      id:        p.id,
      name:      [p.firstName, p.lastName].filter(Boolean).join(' ') || '—',
      phone:     p.phones?.[0]?.value || '—',
      email:     p.emails?.[0]?.value || '',
      source:    normalizeSource(p.source) || 'Sin fuente',
      videoLink: p.customVideoLink || null,
      videoName: p.customVideoName || null,
    }));

    console.log('[Debug] Primeros 3 leads:', JSON.stringify(baseLeads.slice(0, 3)));

    // Fetch all notes in parallel (fast, no rate limit concern)
    const notesPerLead = await Promise.all(
      baseLeads.map((lead) => fetchNotesForPerson(lead.id).catch(() => []))
    );

    // Score sequentially to avoid Anthropic rate limits
    const scored = [];
    for (let i = 0; i < baseLeads.length; i++) {
      const lead = baseLeads[i];
      try {
        const { score, reason } = await scoreLeadFromNotes(lead, notesPerLead[i]);
        scored.push({ name: lead.name, phone: lead.phone, source: lead.source, videoLink: lead.videoLink, videoName: lead.videoName, score, scoreReason: reason });
      } catch (leadErr) {
        console.error(`[Debug] Error scoring lead "${lead.name}":`, leadErr.message);
        scored.push({ name: lead.name, phone: lead.phone, source: lead.source, videoLink: lead.videoLink, videoName: lead.videoName, score: 1, scoreReason: 'Sin análisis' });
      }
    }

    return scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  } catch (err) {
    console.error('[FUBReport] Error fetching leads for date:', err.message);
    return [];
  }
}

/**
 * Fetch and score all FUB leads created between startDateStr and endDateStr (inclusive, ET timezone).
 * Scores up to maxScored leads via AI; the rest get score=null.
 * @param {string} startDateStr  - 'YYYY-MM-DD'
 * @param {string} endDateStr    - 'YYYY-MM-DD'
 * @param {object} opts
 * @param {number} opts.maxScored - max leads to AI-score (default 50)
 */
async function fetchLeadsForRange(startDateStr, endDateStr, { maxScored = 50 } = {}) {
  try {
    const { dayStart } = etDayBounds(startDateStr);
    const { dayEnd }   = etDayBounds(endDateStr);

    console.log(`[FUBReport] fetchLeadsForRange ${startDateStr} – ${endDateStr}`);

    const people = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await axios.get(`${FUB_BASE_URL}/people`, {
        headers: fubHeaders(),
        params: { sort: '-created', limit, offset },
        timeout: 15000,
      });

      const batch = response.data?.people || [];
      if (batch.length === 0) break;

      const inRange = batch.filter((p) => {
        const created = new Date(p.created);
        return created >= dayStart && created <= dayEnd
          && normalizeSource(p.source) !== null;
      });
      people.push(...inRange);

      const oldest = new Date(batch[batch.length - 1]?.created || 0);
      if (oldest < dayStart) break;
      if (batch.length < limit) break;
      offset += limit;
    }

    console.log(`[FUBReport] fetchLeadsForRange found ${people.length} leads`);

    // Build base lead objects
    const baseLeads = people.map((p) => ({
      id:        p.id,
      name:      [p.firstName, p.lastName].filter(Boolean).join(' ') || '—',
      phone:     p.phones?.[0]?.value || '—',
      email:     p.emails?.[0]?.value || '',
      source:    normalizeSource(p.source) || 'Sin fuente',
      videoLink: p.customVideoLink || null,
      videoName: p.customVideoName || null,
    }));

    // Fetch notes in parallel
    const notesPerLead = await Promise.all(
      baseLeads.map((lead) => fetchNotesForPerson(lead.id).catch(() => []))
    );

    // Score up to maxScored leads sequentially; skip the rest
    const scored = [];
    for (let i = 0; i < baseLeads.length; i++) {
      const lead = baseLeads[i];
      if (i < maxScored) {
        try {
          const { score, reason } = await scoreLeadFromNotes(lead, notesPerLead[i]);
          scored.push({ name: lead.name, phone: lead.phone, source: lead.source, videoLink: lead.videoLink, videoName: lead.videoName, score, scoreReason: reason });
        } catch {
          scored.push({ name: lead.name, phone: lead.phone, source: lead.source, videoLink: lead.videoLink, videoName: lead.videoName, score: 1, scoreReason: 'Sin análisis' });
        }
      } else {
        scored.push({ name: lead.name, phone: lead.phone, source: lead.source, videoLink: lead.videoLink, videoName: lead.videoName, score: null, scoreReason: 'Sin análisis (límite del período)' });
      }
    }

    return scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  } catch (err) {
    console.error('[FUBReport] Error fetching leads for range:', err.message);
    return [];
  }
}

/**
 * Diagnostic: show raw FUB data for a date without stage filtering.
 * Returns { dateStr, dayStartUTC, dayEndUTC, totalInPage, inDateRange, stages, samples }
 */
async function debugFUBLeads(dateStr) {
  const { dayStart, dayEnd } = etDayBounds(dateStr);

  const response = await axios.get(`${FUB_BASE_URL}/people`, {
    headers: fubHeaders(),
    params: { sort: '-created', limit: 100, offset: 0 },
    timeout: 15000,
  });

  const batch = response.data?.people || [];

  // People in the date range (no stage filter, no source filter)
  const inRange = batch.filter((p) => {
    const created = new Date(p.created);
    return created >= dayStart && created <= dayEnd;
  });

  // Unique stages across the whole first page
  const stageSet = {};
  batch.forEach((p) => {
    const s = p.stage || '(empty)';
    stageSet[s] = (stageSet[s] || 0) + 1;
  });

  // Sample leads in range
  const samples = inRange.map((p) => ({
    name:   [p.firstName, p.lastName].filter(Boolean).join(' ') || '—',
    created: p.created,
    stage:  p.stage || '(empty)',
    source: p.source || '(empty)',
    normalizedSource: normalizeSource(p.source),
  }));

  return {
    dateStr,
    dayStartUTC: dayStart.toISOString(),
    dayEndUTC:   dayEnd.toISOString(),
    queryParams: { sort: '-created', limit: 100, offset: 0 },
    totalInPage: batch.length,
    inDateRangeCount: inRange.length,
    stagesInPage: stageSet,
    samplesInRange: samples,
  };
}

// ─── Deals Pipeline ────────────────────────────────────────────────────────

const ACTIVE_STAGES  = ['Under Contract', 'Inspection', 'Appraisal', 'Financing', 'Clear to Close'];
const PROXIMOS_STAGE = 'Proximos Deals'; // FUB stores with trailing space — match via trim()
const CLOSED_STAGE   = 'Closing';

function formatCloseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now  = new Date();
  const diff = new Date(dateStr) - new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil(diff / 86400000);
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Returns the most relevant stage deadline and its label for a deal.
 * Priority: most imminent deadline for the current work stage.
 */
function stageDeadlineInfo(d) {
  const stage = d.stageName;
  const pick = (dateStr, label) => dateStr ? { date: dateStr, label } : null;

  if (stage === 'Under Contract') {
    return pick(d.dueDiligenceDate, 'Vence DD')
        || pick(d.earnestMoneyDueDate, 'Earnest Money')
        || pick(d.projectedCloseDate, 'Cierre');
  }
  if (stage === 'Inspection') {
    return pick(d.customInspectionDeadline, 'Vence Inspección')
        || pick(d.dueDiligenceDate, 'Vence DD')
        || pick(d.projectedCloseDate, 'Cierre');
  }
  if (stage === 'Appraisal') {
    return pick(d.dueDiligenceDate, 'Vence DD')
        || pick(d.projectedCloseDate, 'Cierre');
  }
  if (stage === 'Financing') {
    return pick(d.customFinancingDeadline, 'Vence Financing')
        || pick(d.dueDiligenceDate, 'Vence DD')
        || pick(d.projectedCloseDate, 'Cierre');
  }
  if (stage === 'Clear to Close') {
    return pick(d.finalWalkThroughDate, 'Walk Through')
        || pick(d.projectedCloseDate, 'Cierre');
  }
  return pick(d.projectedCloseDate, 'Cierre');
}

const MONTHS_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_ES_SHORT = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

/**
 * Builds a month-by-month breakdown for the current calendar year.
 * Returns an array of 12 objects:
 *   { month: 'Jan', label: 'Ene', closings, closingsVolume, newContracts, newContractsVolume }
 */
function buildYearToDate(deals) {
  const year = new Date().getFullYear();
  const currentMonth = new Date().getMonth(); // 0-based

  return MONTHS_EN.map((mon, idx) => {
    const key = `${year}-${String(idx + 1).padStart(2, '0')}`;
    const isPast = idx <= currentMonth;

    const closings = deals.filter(
      (d) => d.stageName === CLOSED_STAGE && (d.enteredStageAt || '').slice(0, 7) === key
    );
    const newContracts = deals.filter(
      (d) => (d.createdAt || '').slice(0, 7) === key
    );

    return {
      month:              mon,
      label:              MONTHS_ES_SHORT[idx],
      monthKey:           key,
      isPast,
      closings:           closings.length,
      closingsVolume:     closings.reduce((s, d) => s + (Number(d.price) || 0), 0),
      closingsCommission: closings.reduce((s, d) => s + (Number(d.agentCommission) || 0), 0),
      newContracts:       newContracts.length,
      newContractsVolume: newContracts.reduce((s, d) => s + (Number(d.price) || 0), 0),
    };
  });
}

/**
 * Fetch the deals pipeline from FUB.
 * Returns {
 *   activeDeals, stageSummary, activeCount, activeTotal,
 *   closedCount, closedTotal,
 *   monthly: { closings, closingsVolume, closingsCommission, newContracts, newContractsVolume, monthKey }
 * }
 */
async function fetchDealsPipeline() {
  try {
    const response = await axios.get(`${FUB_BASE_URL}/deals`, {
      headers: fubHeaders(),
      params: { limit: 100 },
      timeout: 15000,
    });

    const deals = response.data?.deals || [];
    const monthKey = currentMonthKey();

    const byStage = {};
    deals.forEach((d) => {
      const stage = (d.stageName || '').trim() || 'Sin stage';
      if (!byStage[stage]) byStage[stage] = [];
      byStage[stage].push(d);
    });

    // Active deals — include all deadline fields, sorted by stage deadline ascending
    const activeDeals = ACTIVE_STAGES.flatMap((stage) =>
      (byStage[stage] || []).map((d) => {
        const deadline = stageDeadlineInfo(d);
        return {
          stage,
          name:                    d.name || '—',
          price:                   Number(d.price) || 0,
          projectedCloseDate:      d.projectedCloseDate      || null,
          lender:                  d.customLender            || null,
          financingType:           d.customFinancingType     || null,
          titleCompany:            d.customTitleCompany      || null,
          loanOfficer:             d.customLoanOfficer       || null,
          agentCommission:         Number(d.agentCommission) || 0,
          // Stage-specific deadline
          deadlineDate:            deadline?.date  || null,
          deadlineLabel:           deadline?.label || 'Cierre',
        };
      })
    ).sort((a, b) => {
      // Sort by stage deadline ascending (most urgent first), nulls last
      if (!a.deadlineDate) return 1;
      if (!b.deadlineDate) return -1;
      return new Date(a.deadlineDate) - new Date(b.deadlineDate);
    });

    const stageSummary = ACTIVE_STAGES.map((stage) => {
      const items = byStage[stage] || [];
      return {
        stage,
        count: items.length,
        total: items.reduce((sum, d) => sum + (Number(d.price) || 0), 0),
      };
    });

    const closedDeals   = byStage[CLOSED_STAGE]   || [];
    const proximosDeals = (byStage[PROXIMOS_STAGE] || []).map((d) => ({
      id:          d.id,
      name:        d.name || '—',
      price:       Number(d.price) || 0,
      description: d.description || '',
      projectedCloseDate: d.projectedCloseDate || null,
      lender:      d.customLender         || null,
      loanOfficer: d.customLoanOfficer    || null,
      financingType: d.customFinancingType || null,
    }));

    // Monthly stats — closings that entered Closing stage this month
    const closingsThisMonth = closedDeals.filter(
      (d) => (d.enteredStageAt || '').slice(0, 7) === monthKey
    );
    const closingsVolume     = closingsThisMonth.reduce((s, d) => s + (Number(d.price) || 0), 0);
    const closingsCommission = closingsThisMonth.reduce((s, d) => s + (Number(d.agentCommission) || 0), 0);

    // New contracts entered pipeline this month (created this month, any stage)
    const newContractsThisMonth = deals.filter(
      (d) => (d.createdAt || '').slice(0, 7) === monthKey
    );
    const newContractsVolume = newContractsThisMonth.reduce((s, d) => s + (Number(d.price) || 0), 0);

    return {
      activeDeals,
      stageSummary,
      activeCount:  activeDeals.length,
      activeTotal:  activeDeals.reduce((sum, d) => sum + d.price, 0),
      proximosDeals,
      closedCount:  closedDeals.length,
      closedTotal:  closedDeals.reduce((sum, d) => sum + (Number(d.price) || 0), 0),
      monthly: {
        monthKey,
        closings:           closingsThisMonth.length,
        closingsVolume,
        closingsCommission,
        closingsDeals:      closingsThisMonth.map((d) => ({
          name:  d.name || '—',
          price: Number(d.price) || 0,
          date:  (d.enteredStageAt || '').slice(0, 10),
          agentCommission: Number(d.agentCommission) || 0,
        })),
        newContracts:       newContractsThisMonth.length,
        newContractsVolume,
      },
      yearToDate: buildYearToDate(deals),
    };
  } catch (err) {
    console.error('[FUBReport] Error fetching deals pipeline:', err.message);
    return null;
  }
}

// ─── Source Auto-Correction ────────────────────────────────────────────────

/**
 * Scans all FUB contacts created on dateStr, detects dirty sources
 * (raw Respond.io/Zapier concatenated tags), cleans them with cleanSourceTag,
 * and updates FUB directly if the source changed.
 *
 * Returns a summary: { scanned, corrected, corrections: [{name, from, to}] }
 */
async function autoCorrectFUBSources(dateStr) {
  // NOTE: FUB API does not allow updating the `source` field after contact creation.
  // Strategy: detect dirty sources from Zapier, add a note + tag so the team sees the
  // correct source in FUB, and the report already uses normalizeSource() so it's protected.
  const { addNote, updateContactTags } = require('./fub');
  const { dayStart, dayEnd } = etDayBounds(dateStr);
  const summary = { scanned: 0, corrected: 0, corrections: [] };

  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await axios.get(`${FUB_BASE_URL}/people`, {
      headers: fubHeaders(),
      params: { sort: '-created', limit, offset },
      timeout: 15000,
    });

    const batch = response.data?.people || [];
    if (batch.length === 0) break;

    const inDay = batch.filter((p) => {
      const created = new Date(p.created);
      return created >= dayStart && created <= dayEnd;
    });

    for (const person of inDay) {
      summary.scanned++;
      const raw   = person.source || '';
      const clean = cleanSourceTag(raw);

      // Skip if already clean, already tagged, or internal contact
      if (clean === raw || normalizeSource(raw) === null) continue;
      const alreadyTagged = (person.tags || []).includes('source-corregido');
      if (alreadyTagged) continue;

      try {
        const name = [person.firstName, person.lastName].filter(Boolean).join(' ') || '—';

        // Add a note with the corrected source so the team sees it in FUB
        await addNote(person.id,
          `⚠️ Source corregido automáticamente\n` +
          `Source original (Zapier): ${raw}\n` +
          `Source correcto: ${clean}\n` +
          `Nota: el source en FUB no puede cambiarse vía API. El reporte diario ya usa "${clean}".`
        );

        // Tag it so we don't process it again
        await updateContactTags(person.id, ['source-corregido'], person.tags || []);

        summary.corrections.push({ name, from: raw, to: clean });
        summary.corrected++;
        console.log(`[SourceFix] "${name}": "${raw}" → "${clean}" (nota + tag agregados)`);
      } catch (err) {
        console.error(`[SourceFix] Error procesando ${person.id}:`, err.message);
      }
    }

    const oldest = new Date(batch[batch.length - 1]?.created || 0);
    if (oldest < dayStart || batch.length < limit) break;
    offset += limit;
  }

  console.log(`[SourceFix] Done for ${dateStr}: scanned=${summary.scanned} corrected=${summary.corrected}`);
  return summary;
}

// ─── Leads Year-over-Year Comparison ──────────────────────────────────────

/**
 * Fetches all FUB people created since Jan 1 of the previous year,
 * groups them by year-month (excluding internal/null sources),
 * and returns monthly counts for current year and previous year.
 *
 * Results are cached in data/leads_comparison_cache.json for 12 hours
 * to avoid re-fetching 70+ pages on every report run.
 */
async function fetchLeadsYearComparison() {
  // Return cache if fresh (< 12 hours old)
  const cached = getLeadsComparisonCache();
  if (cached?.lastUpdated) {
    const ageHours = (Date.now() - new Date(cached.lastUpdated)) / 3600000;
    if (ageHours < 12) {
      console.log('[FUBReport] Using cached leads comparison (age: ' + ageHours.toFixed(1) + 'h)');
      return cached.data;
    }
  }

  console.log('[FUBReport] Fetching leads year comparison from FUB (full scan)...');

  const currentYear  = new Date().getFullYear();
  const previousYear = currentYear - 1;
  const cutoff       = new Date(`${previousYear}-01-01T00:00:00Z`);

  const monthlyCounts = {}; // { 'YYYY-MM': count }

  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await axios.get(`${FUB_BASE_URL}/people`, {
      headers: fubHeaders(),
      params:  { sort: '-created', limit, offset },
      timeout: 20000,
    });

    const batch = response.data?.people || [];
    if (batch.length === 0) break;

    for (const p of batch) {
      // Only count real leads (exclude internal sources)
      if (normalizeSource(p.source) === null) continue;
      const created = new Date(p.created);
      if (created < cutoff) break;           // stop scan — older than our window
      const key = p.created.slice(0, 7);     // 'YYYY-MM'
      monthlyCounts[key] = (monthlyCounts[key] || 0) + 1;
    }

    // Stop once the oldest record in this batch is before our cutoff
    const oldestInBatch = new Date(batch[batch.length - 1]?.created || 0);
    if (oldestInBatch < cutoff || batch.length < limit) break;

    offset += limit;
  }

  // Build the 12-month arrays for each year
  const currentYearData  = {};
  const previousYearData = {};

  for (let m = 1; m <= 12; m++) {
    const mk = String(m).padStart(2, '0');
    currentYearData[`${currentYear}-${mk}`]  = monthlyCounts[`${currentYear}-${mk}`]  || 0;
    previousYearData[`${previousYear}-${mk}`] = monthlyCounts[`${previousYear}-${mk}`] || 0;
  }

  const result = {
    currentYear,
    previousYear,
    currentYearData,
    previousYearData,
  };

  saveLeadsComparisonCache(result);
  console.log('[FUBReport] Leads comparison cached. Months scanned:', Object.keys(monthlyCounts).length);
  return result;
}

module.exports = {
  collectMonthlyFUBData,
  fetchClosedToday,
  fetchLeadsForDate,
  fetchLeadsForRange,
  fetchDealsPipeline,
  fetchLeadsYearComparison,
  autoCorrectFUBSources,
  cleanSourceTag,
  formatUSD,
  debugFUBLeads,
  formatCloseDate,
  daysUntil,
};
