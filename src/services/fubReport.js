/**
 * FUB Report Service
 * Extracts lead data from Follow Up Boss API for monthly reporting.
 */

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

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

  if (!channel) return rawSource; // Unknown format — return as-is

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

    console.log(`[FUBReport] Filtro ET para ${dateStr}:`);
    console.log(`[FUBReport]   dayStart UTC: ${dayStart.toISOString()}`);
    console.log(`[FUBReport]   dayEnd   UTC: ${dayEnd.toISOString()}`);

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

      // Log first batch diagnostics
      if (offset === 0) {
        console.log(`[FUBReport]   FUB returned ${batch.length} people in first page`);
        batch.slice(0, 3).forEach((p, i) => {
          const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || '—';
          console.log(`[FUBReport]   lead[${i}]: ${name} — created: ${p.created}`);
        });
      }
      totalFetched += batch.length;

      const inDay = batch.filter((p) => {
        const created = new Date(p.created);
        return created >= dayStart && created <= dayEnd
          && (p.stage || '').includes('New Lead Organico')
          && normalizeSource(p.source) !== null;
      });
      people.push(...inDay);

      const oldest = new Date(batch[batch.length - 1]?.created || 0);
      if (oldest < dayStart) break;
      if (batch.length < limit) break;
      offset += limit;
    }

    console.log(`[FUBReport]   Total fetched: ${totalFetched} | Matching day: ${people.length}`);

    return people
      .map((p) => {
        const name   = [p.firstName, p.lastName].filter(Boolean).join(' ') || '—';
        const phone  = p.phones?.[0]?.value || '—';
        const source = normalizeSource(p.source) || 'Sin fuente';
        const scoreTag = (p.tags || []).find((t) => /^Score-\d+$/.test(t));
        const score  = scoreTag ? parseInt(scoreTag.replace('Score-', ''), 10) : null;
        return { name, phone, source, score };
      })
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  } catch (err) {
    console.error('[FUBReport] Error fetching leads for date:', err.message);
    return [];
  }
}

module.exports = { collectMonthlyFUBData, fetchClosedToday, fetchLeadsForDate, cleanSourceTag, formatUSD };
