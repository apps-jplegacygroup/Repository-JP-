/**
 * socialReport.js — JP Legacy Reporte Semanal de Redes Sociales
 * Fuente: Metricool API
 * Marcas: Paola Díaz · Jorge Florez · JP Legacy Group
 * Cron: Lunes 9:00am ET (14:00 UTC)
 */

'use strict';

const axios    = require('axios');
const cron     = require('node-cron');
const { Resend }   = require('resend');
const Anthropic    = require('@anthropic-ai/sdk');

// ══════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════

const BASE_URL = 'https://app.metricool.com/api';

const RECIPIENTS = [
  'jorgeflorez@jplegacygroup.com',
  'paoladiaz@jplegacygroup.com',
  'marketing@jplegacygroup.com',
  'karen@getvau.com',
  'jeffersonbeltran@jplegacygroup.com',
];

// Daily report: 4 recipients (no jefferson — sólo resumen operativo)
const DAILY_RECIPIENTS = RECIPIENTS.filter(r => !r.includes('jefferson'));

// Brand definitions — color is gradient start, color2 is end
const BRANDS = [
  {
    key:         'paola',
    name:        'Paola Díaz',
    icon:        '👩',
    envKey:      'METRICOOL_BLOG_ID_PAOLA',
    searchNames: ['paola'],
    platforms:   ['instagram', 'tiktok', 'facebook', 'youtube'],
    color:       '#FF6B9D',
    color2:      '#FF8C42',
    bg:          '#1A0A10',
    border:      '#3D1525',
  },
  {
    key:         'jorge',
    name:        'Jorge Florez',
    icon:        '👨',
    envKey:      'METRICOOL_BLOG_ID_JORGE',
    searchNames: ['jorge'],
    platforms:   ['instagram', 'tiktok', 'facebook', 'youtube'],
    color:       '#4FC3F7',
    color2:      '#00E5CC',
    bg:          '#080F14',
    border:      '#0D2030',
  },
  {
    key:         'jp_legacy',
    name:        'JP Legacy Group',
    icon:        '🏢',
    envKey:      'METRICOOL_BLOG_ID_JP_LEGACY',
    searchNames: ['jp legacy', 'jplegacy', 'jplegacygroup'],
    platforms:   ['instagram', 'tiktok', 'facebook'],
    color:       '#C9A84C',
    color2:      '#F5D176',
    bg:          '#0F0C00',
    border:      '#2A2000',
  },
];

const PLATFORM_META = {
  instagram: { icon: '📸', name: 'Instagram', color: '#E1306C', bg: '#1A0812' },
  tiktok:    { icon: '🎵', name: 'TikTok',    color: '#69C9D0', bg: '#080F10' },
  facebook:  { icon: '📘', name: 'Facebook',  color: '#1877F2', bg: '#080A14' },
  youtube:   { icon: '▶️', name: 'YouTube',   color: '#FF0000', bg: '#140808' },
};

// ══════════════════════════════════════════════════════════
// DATE / FORMAT HELPERS
// ══════════════════════════════════════════════════════════

function nowET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function dateKeyET(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function previousWeekRange() {
  const now = nowET();
  const dow = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const prevMon = new Date(mon); prevMon.setDate(mon.getDate() - 7);
  const prevSun = new Date(prevMon); prevSun.setDate(prevMon.getDate() + 6);
  return { start: dateKeyET(prevMon), end: dateKeyET(prevSun) };
}

function toV1(iso) { return iso.replace(/-/g, ''); }
function toV2s(iso) { return `${iso}T00:00:00`; }
function toV2e(iso) { return `${iso}T23:59:59`; }

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DAYS_ES   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

function fmtDateES(iso) {
  if (!iso) return '—';
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return `${DAYS_ES[dt.getUTCDay()]} ${d} de ${MONTHS_ES[m-1]}`;
}

function shortDateES(iso) {
  if (!iso) return '—';
  const [,m,d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_ES[m-1].slice(0,3)}`;
}

function fmtN(n) {
  if (n === null || n === undefined || n === 0) return '0';
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1)+'M';
  if (n >= 1_000)     return (n/1_000).toFixed(1)+'K';
  return String(Math.round(n));
}

function fmtNP(n) {          // with + prefix for growth
  if (!n && n !== 0) return '—';
  return (n >= 0 ? '+' : '') + fmtN(n);
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toFixed(2) + '%';
}

function engBar(pct) {        // Visual engagement bar 0-10%
  const p = Math.min(100, Math.round((Number(pct) / 10) * 100));
  return `<table cellpadding="0" cellspacing="0" style="width:120px;margin-top:3px;">
    <tr>
      <td style="background:#1A1A1A;border-radius:3px;overflow:hidden;height:5px;width:120px;">
        <div style="width:${p}%;height:5px;background:linear-gradient(90deg,#4CAF50,#8BC34A);border-radius:3px;"></div>
      </td>
    </tr>
  </table>`;
}

// ══════════════════════════════════════════════════════════
// METRICOOL API CLIENT
// ══════════════════════════════════════════════════════════

function mcClient() {
  const token  = process.env.METRICOOL_API_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  if (!token)  throw new Error('METRICOOL_API_TOKEN no configurado');
  if (!userId) throw new Error('METRICOOL_USER_ID no configurado');
  return {
    userId,
    http: axios.create({
      baseURL: BASE_URL,
      headers: { 'X-Mc-Auth': token },
      timeout: 20000,
    }),
  };
}

async function safeGet(http, url, params) {
  try {
    const { data } = await http.get(url, { params });
    return data;
  } catch (e) {
    console.warn(`[Social] ⚠️ ${url} → ${e.response?.status||'ERR'}: ${e.response?.data?.detail || e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// BRAND RESOLUTION
// ══════════════════════════════════════════════════════════

async function resolveBrands(http, userId) {
  let profiles = null;
  const resolved = {};

  for (const brand of BRANDS) {
    const envId = process.env[brand.envKey];
    if (envId) { resolved[brand.key] = { ...brand, blogId: String(envId) }; continue; }
    if (!profiles) {
      try {
        const raw = await http.get('/admin/simpleProfiles', { params: { userId } });
        profiles = Array.isArray(raw.data) ? raw.data : (raw.data?.data || []);
        console.log(`[Social] ${profiles.length} perfiles Metricool`);
      } catch (e) { console.error('[Social] fetchProfiles:', e.message); profiles = []; }
    }
    const match = profiles.find(p =>
      brand.searchNames.some(s => (p.name||p.label||'').toLowerCase().includes(s))
    );
    if (match) {
      resolved[brand.key] = { ...brand, blogId: String(match.id) };
      console.log(`[Social] "${brand.name}" → blogId=${match.id}`);
    } else {
      console.warn(`[Social] ⚠️ No blogId para "${brand.name}"`);
      resolved[brand.key] = { ...brand, blogId: null };
    }
  }
  return resolved;
}

// ══════════════════════════════════════════════════════════
// PLATFORM FETCHERS
// ══════════════════════════════════════════════════════════

function extractPosts(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

function topByField(arr, ...fields) {
  return [...arr].sort((a, b) => {
    const va = fields.reduce((v, f) => v || a[f] || 0, 0);
    const vb = fields.reduce((v, f) => v || b[f] || 0, 0);
    return vb - va;
  }).slice(0, 3);
}

async function fetchFollowerTimeline(http, userId, blogId, network, range, subject) {
  const params = {
    userId, blogId,
    from: toV2s(range.start), to: toV2e(range.end),
    metric: 'followers', network,
  };
  if (subject) params.subject = subject;
  const raw = await safeGet(http, '/v2/analytics/timelines', params);
  const values = raw?.data?.[0]?.values || [];
  if (!values.length) return { followers: null, followerGrowth: null, followerPct: null };
  // API devuelve descendente: values[0] = más reciente, values[last] = más antiguo
  const current = values[0].value;
  const oldest  = values[values.length - 1].value;
  const growth  = values.length > 1 ? current - oldest : null;
  const pct     = growth !== null && oldest > 0 ? (growth / oldest) * 100 : null;
  return { followers: current, followerGrowth: growth, followerPct: pct };
}

async function fetchInstagram(http, userId, blogId, range) {
  const b = { userId, blogId };
  const [posts, reels, follData, reachRaw] = await Promise.all([
    safeGet(http, '/stats/instagram/posts', { ...b, start: toV1(range.start), end: toV1(range.end) }),
    safeGet(http, '/stats/instagram/reels', { ...b, start: toV1(range.start), end: toV1(range.end) }),
    fetchFollowerTimeline(http, userId, blogId, 'instagram', range, 'account'),
    // Account-level weekly reach (includes stories/profile visits, not just post reach)
    safeGet(http, '/v2/analytics/timelines', {
      userId, blogId, from: toV2s(range.start), to: toV2e(range.end),
      metric: 'reach', network: 'instagram', subject: 'account',
    }),
  ]);
  const all = [...extractPosts(posts), ...extractPosts(reels)];
  const postReach = all.reduce((s,p) => s + (p.reach||0), 0);
  // If no posts were published, fall back to account-level weekly reach sum
  const accountReachValues = reachRaw?.data?.[0]?.values || [];
  const accountReach = accountReachValues.reduce((s,v) => s + (v.value||0), 0);
  const totalReach = postReach > 0 ? postReach : accountReach;
  return {
    platform:    'instagram',
    posts:       all,
    postsCount:  all.length,
    totalReach,
    totalImpr:   all.reduce((s,p) => s + (p.impressions||0), 0),
    avgEng:      all.length ? all.reduce((s,p) => s + (p.engagement||0), 0) / all.length : null,
    topEng:      topByField(all, 'engagement'),
    topViews:    topByField(all, 'videoViews', 'views', 'reach'),
    ...follData,
  };
}

async function fetchTikTok(http, userId, blogId, range) {
  const b = { userId, blogId };
  const raw = await safeGet(http, '/v2/analytics/posts/tiktok',
    { ...b, from: toV2s(range.start), to: toV2e(range.end) });
  const all = extractPosts(raw);
  return {
    platform:   'tiktok',
    posts:      all,
    postsCount: all.length,
    totalViews: all.reduce((s,p) => s + (p.viewCount||p.views||p.videoViews||0), 0),
    totalLikes: all.reduce((s,p) => s + (p.likeCount||p.likes||0), 0),
    avgEng:     all.length ? all.reduce((s,p) => s + (p.engagement||0), 0) / all.length : null,
    topViews:   topByField(all, 'viewCount', 'views', 'videoViews'),
    topEng:     topByField(all, 'engagement'),
    followers: null, followerGrowth: null, followerPct: null,
  };
}

async function fetchFacebook(http, userId, blogId, range) {
  const b = { userId, blogId };
  const raw = await safeGet(http, '/stats/facebook/posts',
    { ...b, start: toV1(range.start), end: toV1(range.end) });
  const all = extractPosts(raw);
  return {
    platform:   'facebook',
    posts:      all,
    postsCount: all.length,
    // Facebook has no 'reach' field — impressionsUnique is the unique-audience equivalent
    totalReach: all.reduce((s,p) => s + (p.impressionsUnique||p.reach||0), 0),
    totalImpr:  all.reduce((s,p) => s + (p.impressions||p.impressionsOrganic||0), 0),
    avgEng:     all.length ? all.reduce((s,p) => s + (p.engagement||0), 0) / all.length : null,
    topEng:     topByField(all, 'engagement', 'impressionsUnique'),
    followers:  null, followerGrowth: null, followerPct: null,
  };
}

async function fetchYouTube(http, userId, blogId, range) {
  const b = { userId, blogId };
  const [raw, subRaw, gainRaw] = await Promise.all([
    safeGet(http, '/v2/analytics/posts/youtube',
      { ...b, from: toV2s(range.start), to: toV2e(range.end), postsType: 'publishedInRange' }),
    safeGet(http, '/v2/analytics/timelines',
      { userId, blogId, from: toV2s(range.start), to: toV2e(range.end), metric: 'totalSubscribers', network: 'youtube' }),
    safeGet(http, '/v2/analytics/timelines',
      { userId, blogId, from: toV2s(range.start), to: toV2e(range.end), metric: 'subscribersGained', network: 'youtube' }),
  ]);
  const all = extractPosts(raw);
  // watchMinutes is total minutes watched per video (not averageViewDuration which is per-view avg)
  const totalWatchMin = all.reduce((s,p) => s + (p.watchMinutes||0), 0);
  const subVals = subRaw?.data?.[0]?.values || [];
  const gainVals = gainRaw?.data?.[0]?.values || [];
  // API returns descending: values[0] = most recent
  const subscribers = subVals.length ? subVals[0].value : null;
  const subGrowth   = gainVals.length ? gainVals.reduce((s,v) => s + (v.value||0), 0) : null;
  const subPct      = subscribers && subGrowth !== null && subscribers > subGrowth
    ? (subGrowth / (subscribers - subGrowth)) * 100 : null;
  return {
    platform:    'youtube',
    posts:       all,
    postsCount:  all.length,
    totalViews:  all.reduce((s,p) => s + (p.views||0), 0),
    watchHours:  Math.round(totalWatchMin / 60),
    topViews:    topByField(all, 'views'),
    subscribers, subGrowth, subPct,
  };
}

// ══════════════════════════════════════════════════════════
// MAIN DATA BUILDER
// ══════════════════════════════════════════════════════════

async function buildSocialData() {
  const { http, userId } = mcClient();
  const range    = previousWeekRange();
  console.log(`[Social] Semana: ${range.start} → ${range.end}`);

  const resolved = await resolveBrands(http, userId);
  const results  = {};

  for (const brand of BRANDS) {
    const b = resolved[brand.key];
    if (!b?.blogId) {
      results[brand.key] = { ...b, data: {}, error: 'No blogId' };
      continue;
    }
    console.log(`[Social] Fetching "${b.name}" (blogId=${b.blogId})…`);
    const data = {};

    const jobs = [];
    if (b.platforms.includes('instagram'))
      jobs.push(fetchInstagram(http, userId, b.blogId, range).then(d => { data.instagram = d; }));
    if (b.platforms.includes('tiktok'))
      jobs.push(fetchTikTok(http, userId, b.blogId, range).then(d => { data.tiktok = d; }));
    if (b.platforms.includes('facebook'))
      jobs.push(fetchFacebook(http, userId, b.blogId, range).then(d => { data.facebook = d; }));
    if (b.platforms.includes('youtube'))
      jobs.push(fetchYouTube(http, userId, b.blogId, range).then(d => { data.youtube = d; }));

    await Promise.all(jobs);
    results[brand.key] = { ...b, data };

    const totalPosts = Object.values(data).reduce((s,p) => s + (p?.postsCount||0), 0);
    console.log(`[Social]   → ${b.name}: ${totalPosts} posts`);
  }

  const highlights = buildHighlights(results);
  const aiText     = await generateAI(results, range);
  return { range, results, highlights, aiText };
}

// ══════════════════════════════════════════════════════════
// HIGHLIGHTS
// ══════════════════════════════════════════════════════════

function buildHighlights(results) {
  let bestContent = null;
  let bestGrowth  = { name:'—', val:0 };
  let bestEng     = { name:'—', val:0 };
  let starPlatform= { name:'—', val:0 };

  const platViews = { instagram:0, tiktok:0, facebook:0, youtube:0 };

  for (const brand of BRANDS) {
    const b = results[brand.key];
    if (!b?.data) continue;

    // Best single post across all brands+platforms
    for (const [pfKey, pf] of Object.entries(b.data)) {
      const topArr = pf.topViews || pf.topEng || [];
      if (topArr[0]) {
        const views = topArr[0].views || topArr[0].videoViews || topArr[0].reach || 0;
        if (!bestContent || views > bestContent.views)
          bestContent = { ...topArr[0], views, platform: pfKey, brandName: brand.name };
      }
      platViews[pfKey] = (platViews[pfKey]||0) + (pf.totalViews||pf.totalReach||0);
    }

    // Most follower growth — we don't have timeline data, use posts count as proxy
    const totalPosts = Object.values(b.data).reduce((s,p) => s+(p?.postsCount||0), 0);

    // Best engagement
    const engs = Object.values(b.data)
      .map(p => p?.avgEng).filter(v => v !== null && v !== undefined);
    const avgEng = engs.length ? engs.reduce((s,v)=>s+v,0)/engs.length : 0;
    if (avgEng > bestEng.val) bestEng = { name: brand.name, val: avgEng };
  }

  // Star platform by total views/reach
  const starPlat = Object.entries(platViews).sort((a,b) => b[1]-a[1])[0];
  if (starPlat) starPlatform = { name: PLATFORM_META[starPlat[0]]?.name || starPlat[0], val: starPlat[1] };

  return { bestContent, bestGrowth, bestEng, starPlatform };
}

// ══════════════════════════════════════════════════════════
// AI ANALYSIS
// ══════════════════════════════════════════════════════════

async function generateAI(results, range) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const summary = BRANDS.map(bc => {
      const b = results[bc.key];
      const d = b?.data || {};
      return `${bc.name}:
  Instagram: ${d.instagram?.postsCount||0} posts, alcance total ${fmtN(d.instagram?.totalReach)}, engagement ${fmtPct(d.instagram?.avgEng)}
  TikTok: ${d.tiktok?.postsCount||0} videos, vistas ${fmtN(d.tiktok?.totalViews)}, engagement ${fmtPct(d.tiktok?.avgEng)}
  Facebook: ${d.facebook?.postsCount||0} posts, alcance ${fmtN(d.facebook?.totalReach)}, engagement ${fmtPct(d.facebook?.avgEng)}
  YouTube: ${d.youtube?.postsCount||0} videos, vistas ${fmtN(d.youtube?.totalViews)}`;
    }).join('\n\n');

    const { content } = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Eres estratega experto en redes sociales para JP Legacy Group.
Datos semana ${range.start} al ${range.end}:

${summary}

Responde en español, máximo 650 tokens, con este formato exacto:

✅ QUÉ FUNCIONÓ
[2-3 bullets con lo que tuvo mejor resultado y por qué]

❌ QUÉ NO FUNCIONÓ
[1-2 bullets con lo que tuvo menor rendimiento]

🎯 REPLICAR LA PRÓXIMA SEMANA
[El formato/tipo de contenido que más funcionó y cómo replicarlo]

📅 MEJORES DÍAS Y HORAS
[Por marca y plataforma, cuándo publicar]

💡 5 IDEAS DE CONTENIDO
1. [idea concreta con plataforma y formato]
2. [idea concreta]
3. [idea concreta]
4. [idea concreta]
5. [idea concreta]

🔥 OPORTUNIDAD DE LA SEMANA
[Un tema o formato específico para aprovechar ya]`,
      }],
    });
    return content[0]?.text || null;
  } catch (e) {
    console.warn('[Social] AI error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// HTML — COMPONENTS
// ══════════════════════════════════════════════════════════

// Post caption
function cap(post) {
  const raw = post?.videoDescription || post?.content || post?.text || post?.title || post?.description || '(sin título)';
  return raw.replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,60) + (raw.length > 60 ? '…' : '');
}

// Metric card for a single platform
function platformCard(pf, brand) {
  if (!pf) return '';
  const pm  = PLATFORM_META[pf.platform];
  const top = (pf.topEng?.[0] || pf.topViews?.[0]);
  const isYT = pf.platform === 'youtube';
  const isTT = pf.platform === 'tiktok';

  // Main metrics inside the "card box"
  const hasFollowers = pf.followers !== null && pf.followers !== undefined;
  const mainMetric1 = isYT
    ? `<td style="width:50%;padding:10px 12px;border-right:1px solid #1A1A1A;">
        <div style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;">SUSCRIPTORES</div>
        <div style="color:#FFF;font-size:20px;font-weight:bold;font-family:Arial;">${pf.subscribers !== null && pf.subscribers !== undefined ? fmtN(pf.subscribers) : '—'}</div>
        <div style="color:#4CAF50;font-size:10px;font-family:Arial;">${pf.subGrowth !== null ? fmtNP(pf.subGrowth)+' esta semana' : 'sin datos aún'}</div>
      </td>`
    : `<td style="width:50%;padding:10px 12px;border-right:1px solid #1A1A1A;">
        <div style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;">SEGUIDORES</div>
        <div style="color:#FFF;font-size:20px;font-weight:bold;font-family:Arial;">${hasFollowers ? fmtN(pf.followers) : '—'}</div>
        <div style="color:#4CAF50;font-size:10px;font-family:Arial;">${hasFollowers && pf.followerGrowth !== null ? fmtNP(pf.followerGrowth)+' · '+fmtPct(pf.followerPct) : 'sin datos de seguidores'}</div>
      </td>`;

  const mainMetric2 = isTT || isYT
    ? `<td style="width:50%;padding:10px 12px;">
        <div style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;">${isYT ? 'VISTAS' : 'VISTAS TOTALES'}</div>
        <div style="color:#FFF;font-size:20px;font-weight:bold;font-family:Arial;">${fmtN(pf.totalViews||0)}</div>
        ${isYT ? `<div style="color:#888;font-size:10px;font-family:Arial;">Watch time: ${pf.watchHours||0}h</div>` : ''}
      </td>`
    : `<td style="width:50%;padding:10px 12px;">
        <div style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;">ALCANCE</div>
        <div style="color:#FFF;font-size:20px;font-weight:bold;font-family:Arial;">${fmtN(pf.totalReach||0)}</div>
        ${pf.totalImpr ? `<div style="color:#888;font-size:10px;font-family:Arial;">${fmtN(pf.totalImpr)} impresiones</div>` : ''}
      </td>`;

  const engRow = pf.avgEng !== null && pf.avgEng !== undefined ? `
    <tr><td style="padding:8px 12px;border-top:1px solid #1A1A1A;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;width:90px;">ENGAGEMENT</td>
        <td>
          <span style="color:#4CAF50;font-size:13px;font-weight:bold;font-family:Arial;">${fmtPct(pf.avgEng)}</span>
          ${engBar(pf.avgEng)}
        </td>
        <td style="text-align:right;color:#888;font-size:10px;font-family:Arial;">${pf.postsCount} posts</td>
      </tr></table>
    </td></tr>` : '';

  const topRow = top ? `
    <tr><td style="padding:10px 12px;background:#050505;border-top:1px solid #1A1A1A;">
      <div style="color:${pm.color};font-size:9px;font-weight:bold;letter-spacing:1px;font-family:Arial;margin-bottom:4px;">
        🏆 TOP ${isYT ? 'VIDEO' : isTT ? 'VIDEO' : pf.platform==='instagram' ? 'REEL/POST' : 'POST'}
      </div>
      <div style="color:#CCC;font-size:11px;font-family:Arial;margin-bottom:5px;">${cap(top)}</div>
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">
          👁 <strong style="color:#FFF;">${fmtN(top.viewCount||top.videoViews||top.views||top.reach||0)}</strong>
        </td>
        <td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">
          ❤️ <strong style="color:#FFF;">${fmtN(top.likeCount||top.likes||top.reactions||0)}</strong>
        </td>
        <td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">
          💬 <strong style="color:#FFF;">${fmtN(top.commentCount||top.comments||0)}</strong>
        </td>
        ${(top.saved) ? `<td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">🔖 <strong style="color:#FFF;">${fmtN(top.saved)}</strong></td>` : ''}
        ${(top.shareCount||top.shares) ? `<td style="color:#888;font-size:10px;font-family:Arial;">↗️ <strong style="color:#FFF;">${fmtN(top.shareCount||top.shares)}</strong></td>` : ''}
      </tr></table>
    </td></tr>` : '';

  return `
  <!-- ${pm.name} -->
  <tr><td style="padding:0 0 12px 0;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:${pm.bg};border:1px solid ${pm.color}33;border-radius:8px;overflow:hidden;">
      <!-- Platform header -->
      <tr><td style="padding:8px 12px;background:${pm.color}18;border-bottom:1px solid ${pm.color}33;">
        <span style="color:${pm.color};font-size:12px;font-weight:bold;letter-spacing:2px;
          text-transform:uppercase;font-family:Arial;">${pm.icon} ${pm.name}</span>
      </td></tr>
      <!-- Main stats -->
      <tr><td><table width="100%" cellpadding="0" cellspacing="0">
        <tr>${mainMetric1}${mainMetric2}</tr>
      </table></td></tr>
      ${engRow}
      ${topRow}
    </table>
  </td></tr>`;
}

// Brand section
function brandSection(brand, result) {
  const d    = result?.data || {};
  const err  = result?.error;

  const totalPosts = Object.values(d).reduce((s,p) => s+(p?.postsCount||0), 0);
  const totalReach = (d.instagram?.totalReach||0) + (d.facebook?.totalReach||0);
  const totalViews = (d.tiktok?.totalViews||0) + (d.youtube?.totalViews||0);

  const errBanner = err
    ? `<tr><td style="padding:10px 14px;color:#FF4444;font-size:11px;font-family:Arial;">
        ⚠️ ${err} — Configura ${brand.envKey} en Railway
      </td></tr>` : '';

  const platformRows = brand.platforms
    .filter(pf => d[pf])
    .map(pf => platformCard(d[pf], brand))
    .join('');

  const summaryRow = `
  <tr><td style="padding:10px 14px;background:${brand.bg};border-top:1px solid ${brand.border};">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;border-right:1px solid ${brand.border};">
        <div style="color:${brand.color};font-size:22px;font-weight:bold;font-family:Arial;">${totalPosts}</div>
        <div style="color:#444;font-size:9px;letter-spacing:1px;font-family:Arial;">POSTS</div>
      </td>
      <td style="text-align:center;border-right:1px solid ${brand.border};">
        <div style="color:${brand.color};font-size:22px;font-weight:bold;font-family:Arial;">${fmtN(totalReach)}</div>
        <div style="color:#444;font-size:9px;letter-spacing:1px;font-family:Arial;">ALCANCE</div>
      </td>
      <td style="text-align:center;">
        <div style="color:${brand.color};font-size:22px;font-weight:bold;font-family:Arial;">${fmtN(totalViews)}</div>
        <div style="color:#444;font-size:9px;letter-spacing:1px;font-family:Arial;">VISTAS</div>
      </td>
    </tr></table>
  </td></tr>`;

  return `
  <tr><td style="padding:0 0 6px 0;">
  <table width="100%" cellpadding="0" cellspacing="0"
    style="background:${brand.bg};border:2px solid ${brand.border};border-radius:10px;overflow:hidden;">

    <!-- Brand header -->
    <tr><td style="padding:14px 16px;
      background:linear-gradient(135deg,${brand.color}22,${brand.color2}11);
      border-bottom:2px solid ${brand.border};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>
          <div style="font-size:20px;">${brand.icon}</div>
          <div style="color:${brand.color};font-size:14px;font-weight:bold;
            letter-spacing:2px;text-transform:uppercase;font-family:Arial;">${brand.name}</div>
        </td>
      </tr></table>
    </td></tr>

    ${errBanner}

    <!-- Platform cards -->
    <tr><td style="padding:14px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${platformRows}
      </table>
    </td></tr>

    ${summaryRow}

  </table>
  </td></tr>
  <tr><td style="height:16px;"></td></tr>`;
}

// Comparison table
function comparisonTable(results) {
  const row = (label, fn) => {
    const cells = BRANDS.map(bc => {
      const b = results[bc.key];
      return `<td style="padding:8px 10px;text-align:center;border-right:1px solid #111;">
        <span style="color:#FFF;font-size:12px;font-family:Arial;">${fn(b)}</span>
      </td>`;
    }).join('');
    return `<tr>
      <td style="padding:8px 10px;color:#666;font-size:10px;font-family:Arial;border-right:1px solid #111;
        border-bottom:1px solid #0D0D0D;background:#060606;">${label}</td>
      ${cells.replace(/border-bottom[^;]+;/g,'')}
    </tr>`;
  };

  return `
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0"
    style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    <!-- Header -->
    <tr>
      <td style="padding:10px 14px;background:#111;border-bottom:1px solid #1A1A1A;border-right:1px solid #111;">
        <span style="color:#C9A84C;font-size:10px;font-weight:bold;letter-spacing:2px;font-family:Arial;">⚡ COMPARATIVO</span>
      </td>
      ${BRANDS.map(bc => `<td style="padding:10px 10px;background:${bc.bg};border-bottom:1px solid #1A1A1A;border-right:1px solid #111;text-align:center;">
        <span style="color:${bc.color};font-size:10px;font-weight:bold;letter-spacing:1px;font-family:Arial;">${bc.icon} ${bc.name.split(' ')[0].toUpperCase()}</span>
      </td>`).join('')}
    </tr>
    ${row('Posts publicados', b => {
      const d = b?.data||{};
      return Object.values(d).reduce((s,p) => s+(p?.postsCount||0), 0);
    })}
    ${row('Alcance total', b => {
      const d = b?.data||{};
      return fmtN((d.instagram?.totalReach||0)+(d.facebook?.totalReach||0));
    })}
    ${row('Vistas (TT+YT)', b => {
      const d = b?.data||{};
      return fmtN((d.tiktok?.totalViews||0)+(d.youtube?.totalViews||0));
    })}
    ${row('Engagement prom', b => {
      const d = b?.data||{};
      const engs = Object.values(d).map(p=>p?.avgEng).filter(v=>v!=null);
      return engs.length ? fmtPct(engs.reduce((s,v)=>s+v,0)/engs.length) : '—';
    })}
    ${row('Nuevos seguidores', b => {
      const d = b?.data||{};
      const g = Object.values(d).reduce((s,p)=>s+(p?.followerGrowth||p?.subGrowth||0),0);
      return fmtNP(g);
    })}
  </table>
  </td></tr>`;
}

// Highlights block
function highlightsBlock(h) {
  const bestPostLine = h.bestContent
    ? `<tr><td style="padding:7px 14px;border-bottom:1px solid #0D0D0D;">
        <span style="color:#555;font-size:10px;font-family:Arial;">🥇 Mejor contenido:</span>
        <span style="color:#FFF;font-size:11px;font-family:Arial;margin-left:6px;">${cap(h.bestContent)}</span>
        <span style="color:#888;font-size:10px;font-family:Arial;margin-left:6px;">
          — ${h.bestContent.brandName} · ${PLATFORM_META[h.bestContent.platform]?.name} · ${fmtN(h.bestContent.views)} vistas
        </span>
      </td></tr>` : '';

  return `
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0"
    style="background:#0D0D00;border:1px solid #2A2000;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:8px 14px;background:#141200;border-bottom:1px solid #2A2000;">
      <span style="color:#F5D176;font-size:11px;font-weight:bold;letter-spacing:2px;font-family:Arial;">🏆 HIGHLIGHTS DE LA SEMANA</span>
    </td></tr>
    ${bestPostLine}
    <tr><td style="padding:7px 14px;border-bottom:1px solid #0D0D0D;">
      <span style="color:#555;font-size:10px;font-family:Arial;">⚡ Mayor engagement:</span>
      <span style="color:#4CAF50;font-size:12px;font-weight:bold;font-family:Arial;margin-left:6px;">${h.bestEng.name} ${fmtPct(h.bestEng.val)}</span>
    </td></tr>
    <tr><td style="padding:7px 14px;">
      <span style="color:#555;font-size:10px;font-family:Arial;">🎬 Plataforma estrella:</span>
      <span style="color:#C9A84C;font-size:12px;font-weight:bold;font-family:Arial;margin-left:6px;">${h.starPlatform.name}</span>
    </td></tr>
  </table>
  </td></tr>
  <tr><td style="height:14px;"></td></tr>`;
}

// AI block
function aiBlock(aiText) {
  if (!aiText) return '';
  const html = aiText
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/✅ (QUÉ FUNCIONÓ)/g,'<strong style="color:#4CAF50;font-size:12px;">✅ $1</strong>')
    .replace(/❌ (QUÉ NO FUNCIONÓ)/g,'<strong style="color:#FF4444;font-size:12px;">❌ $1</strong>')
    .replace(/🎯 (REPLICAR[^\n]*)/g,'<strong style="color:#4FC3F7;font-size:12px;">🎯 $1</strong>')
    .replace(/📅 (MEJORES[^\n]*)/g,'<strong style="color:#C9A84C;font-size:12px;">📅 $1</strong>')
    .replace(/💡 (5 IDEAS[^\n]*)/g,'<strong style="color:#FFD700;font-size:12px;">💡 $1</strong>')
    .replace(/🔥 (OPORTUNIDAD[^\n]*)/g,'<strong style="color:#FF6B35;font-size:12px;">🔥 $1</strong>')
    .replace(/\n/g, '<br>');

  return `
  <tr><td style="height:16px;"></td></tr>
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0"
    style="background:#060610;border:1px solid #1A1A2A;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:10px 14px;background:#0A0A1A;border-bottom:1px solid #1A1A2A;">
      <span style="color:#818CF8;font-size:11px;font-weight:bold;letter-spacing:2px;font-family:Arial;">🤖 ANÁLISIS CLAUDE AI — ESTRATEGIA DE CONTENIDO</span>
    </td></tr>
    <tr><td style="padding:16px;color:#CCCCCC;font-size:12px;line-height:1.8;font-family:Arial;">
      ${html}
    </td></tr>
  </table>
  </td></tr>`;
}

// ══════════════════════════════════════════════════════════
// FULL HTML BUILDER
// ══════════════════════════════════════════════════════════

function buildSocialHTML(data) {
  const { range, results, highlights, aiText } = data;
  const now = nowET();
  const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
  const generatedStr = `${fmtDateES(dateKeyET(now))} · ${timeStr} ET`;

  const brandRows = BRANDS.map(bc => brandSection(bc, results[bc.key])).join('');

  const body = `
    <!-- Header -->
    <tr><td style="padding:30px 0 20px;text-align:center;
      border-bottom:3px solid #C9A84C;">
      <div style="font-size:11px;letter-spacing:4px;color:#C9A84C;
        text-transform:uppercase;font-family:Arial;margin-bottom:6px;">JP LEGACY GROUP</div>
      <div style="font-size:22px;font-weight:bold;color:#FFFFFF;
        font-family:Arial;letter-spacing:1px;">📱 Reporte Semanal de Redes</div>
      <div style="font-size:11px;color:#666;font-family:Arial;margin-top:6px;">
        Semana del <strong style="color:#AAA;">${shortDateES(range.start)}</strong>
        al <strong style="color:#AAA;">${shortDateES(range.end)}</strong>
      </div>
      <div style="font-size:10px;color:#333;font-family:Arial;margin-top:4px;">
        Generado el ${generatedStr}
      </div>
    </td></tr>
    <tr><td style="height:18px;"></td></tr>

    ${highlightsBlock(highlights)}

    ${brandRows}

    <!-- Divider -->
    <tr><td style="height:6px;background:linear-gradient(90deg,#C9A84C33,transparent);border-radius:3px;"></td></tr>
    <tr><td style="height:14px;"></td></tr>

    ${comparisonTable(results)}

    ${aiBlock(aiText)}

    <!-- Footer -->
    <tr><td style="height:24px;"></td></tr>
    <tr><td style="text-align:center;padding:14px;border-top:1px solid #1A1A1A;">
      <div style="color:#C9A84C;font-size:12px;font-weight:bold;letter-spacing:3px;font-family:Arial;">JP LEGACY GROUP</div>
      <div style="color:#333;font-size:10px;font-family:Arial;margin-top:4px;">
        Reporte generado automáticamente · JP Legacy Agent · America/New_York
      </div>
    </td></tr>
  `;

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>JP Legacy — Redes Sociales</title>
</head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0A0A0A">
<tr><td align="center" style="padding:20px 10px;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">
${body}
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════
// SEND EMAIL
// ══════════════════════════════════════════════════════════

async function sendSocialReport() {
  console.log('[Social] Iniciando reporte semanal de redes…');
  const data    = await buildSocialData();
  const html    = buildSocialHTML(data);
  const { range } = data;
  const subject = `📱 JP Legacy — Reporte Semanal de Redes · Semana del ${shortDateES(range.start)} al ${shortDateES(range.end)}`;

  if (!process.env.RESEND_API_KEY) {
    console.warn('[Social] RESEND_API_KEY no configurado — email omitido');
    return { subject, html, data };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: 'JP Legacy Agent <apps@jplegacygroup.com>',
    to: RECIPIENTS,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[Social] ✅ Email enviado: ${subject}`);
  return { subject, data };
}

// ══════════════════════════════════════════════════════════
// DATE HELPERS — DAILY & MONTHLY
// ══════════════════════════════════════════════════════════

function yesterdayDateET() {
  const now = nowET();
  const d = new Date(now); d.setDate(now.getDate() - 1);
  return dateKeyET(d);
}

function previousMonthRange() {
  const now = nowET();
  const y = now.getFullYear(), cur = now.getMonth(); // 0-based
  const pm = cur === 0 ? 11 : cur - 1;
  const py = cur === 0 ? y - 1 : y;
  const start = `${py}-${String(pm + 1).padStart(2,'0')}-01`;
  const last  = new Date(py, pm + 1, 0).getDate();
  const end   = `${py}-${String(pm + 1).padStart(2,'0')}-${String(last).padStart(2,'0')}`;
  return { start, end, name: MONTHS_ES[pm], year: py };
}

function monthBeforeRange() {
  const { start: ps } = previousMonthRange();
  const [py, pm] = ps.split('-').map(Number); // pm 1-based
  const bm = pm === 1 ? 12 : pm - 1;
  const by = pm === 1 ? py - 1 : py;
  const start = `${by}-${String(bm).padStart(2,'0')}-01`;
  const last  = new Date(by, bm, 0).getDate();
  const end   = `${by}-${String(bm).padStart(2,'0')}-${String(last).padStart(2,'0')}`;
  return { start, end, name: MONTHS_ES[bm - 1], year: by };
}

function bestDayHour(posts) {
  const dMap = {}, hMap = {};
  for (const p of posts) {
    let ms = typeof p.timestamp === 'number' ? p.timestamp : null;
    if (!ms && p.created)               ms = new Date(p.created).getTime();
    if (!ms && p.publishedAt?.dateTime) ms = new Date(p.publishedAt.dateTime).getTime();
    if (!ms && p.createTime)            ms = new Date(p.createTime).getTime();
    if (!ms || isNaN(ms)) continue;
    const dt = new Date(ms);
    const dw = dt.getDay(), hr = dt.getHours();
    if (!dMap[dw]) dMap[dw] = { n:0, e:0 };
    dMap[dw].n++; dMap[dw].e += p.engagement||0;
    if (!hMap[hr]) hMap[hr] = { n:0, e:0 };
    hMap[hr].n++; hMap[hr].e += p.engagement||0;
  }
  let bd = null, bh = null, maxD = -1, maxH = -1;
  for (const [k, v] of Object.entries(dMap)) { const a = v.e/v.n; if (a > maxD) { maxD=a; bd=+k; } }
  for (const [k, v] of Object.entries(hMap)) { const a = v.e/v.n; if (a > maxH) { maxH=a; bh=+k; } }
  return {
    day:    bd !== null ? DAYS_ES[bd] : '—',
    hour:   bh !== null ? `${String(bh).padStart(2,'0')}:00` : '—',
    dayEng: maxD > 0   ? fmtPct(maxD) : '—',
  };
}

// ══════════════════════════════════════════════════════════
// DAILY DATA BUILDER  (Instagram · Facebook · YouTube)
// ══════════════════════════════════════════════════════════

// Fetch one day's IG + FB + YT data for a brand, returning aggregated metrics
async function fetchOneDayBrand(http, userId, b, date, prevDate) {
  const daily = b.platforms.filter(p => ['instagram','facebook','youtube'].includes(p));
  const data  = {}, prev = {};
  const jobs  = [];

  const agIg = (all, reachFallback) => ({
    platform:       'instagram',
    postsCount:     all.length,
    totalReach:     all.reduce((s,p)=>s+(p.reach||0),0) || reachFallback,
    avgEng:         all.length ? all.reduce((s,p)=>s+(p.engagement||0),0)/all.length : null,
    totalLikes:     all.reduce((s,p)=>s+(p.likes||0),0),
    totalComments:  all.reduce((s,p)=>s+(p.comments||0),0),
    totalSaved:     all.reduce((s,p)=>s+(p.saved||0),0),
    totalShares:    all.reduce((s,p)=>s+(p.shares||0),0),
    totalInteractions: all.reduce((s,p)=>s+(p.interactions||0),0),
  });

  const agFb = (all) => ({
    platform:       'facebook',
    postsCount:     all.length,
    totalReach:     all.reduce((s,p)=>s+(p.impressionsUnique||p.reach||0),0),
    avgEng:         all.length ? all.reduce((s,p)=>s+(p.engagement||0),0)/all.length : null,
    totalLikes:     all.reduce((s,p)=>s+(p.reactions||p.like||0),0),
    totalComments:  all.reduce((s,p)=>s+(p.comments||0),0),
    totalShares:    all.reduce((s,p)=>s+(p.shares||0),0),
  });

  const agYt = (all) => ({
    platform:       'youtube',
    postsCount:     all.length,
    totalViews:     all.reduce((s,p)=>s+(p.views||0),0),
    watchHours:     Math.round(all.reduce((s,p)=>s+(p.watchMinutes||0),0)/60),
    totalLikes:     all.reduce((s,p)=>s+(p.likes||0),0),
    totalComments:  all.reduce((s,p)=>s+(p.comments||0),0),
  });

  if (daily.includes('instagram')) {
    jobs.push(Promise.all([
      safeGet(http, '/stats/instagram/posts', { userId, blogId: b.blogId, start: toV1(date), end: toV1(date) }),
      safeGet(http, '/stats/instagram/reels', { userId, blogId: b.blogId, start: toV1(date), end: toV1(date) }),
      safeGet(http, '/v2/analytics/timelines', { userId, blogId: b.blogId, from: toV2s(date), to: toV2e(date), metric: 'reach', network: 'instagram', subject: 'account' }),
      // prev day posts/reels for comparison
      safeGet(http, '/stats/instagram/posts', { userId, blogId: b.blogId, start: toV1(prevDate), end: toV1(prevDate) }),
      safeGet(http, '/stats/instagram/reels', { userId, blogId: b.blogId, start: toV1(prevDate), end: toV1(prevDate) }),
      safeGet(http, '/v2/analytics/timelines', { userId, blogId: b.blogId, from: toV2s(prevDate), to: toV2e(prevDate), metric: 'reach', network: 'instagram', subject: 'account' }),
    ]).then(([posts, reels, reachRaw, pp, pr, preachRaw]) => {
      const all  = [...extractPosts(posts), ...extractPosts(reels)];
      const pall = [...extractPosts(pp), ...extractPosts(pr)];
      const ar   = (reachRaw?.data?.[0]?.values||[]).reduce((s,v)=>s+(v.value||0),0);
      const par  = (preachRaw?.data?.[0]?.values||[]).reduce((s,v)=>s+(v.value||0),0);
      data.instagram = agIg(all, ar);
      prev.instagram = agIg(pall, par);
    }));
  }

  if (daily.includes('facebook')) {
    jobs.push(Promise.all([
      safeGet(http, '/stats/facebook/posts', { userId, blogId: b.blogId, start: toV1(date),     end: toV1(date)     }),
      safeGet(http, '/stats/facebook/posts', { userId, blogId: b.blogId, start: toV1(prevDate), end: toV1(prevDate) }),
    ]).then(([raw, praw]) => {
      data.facebook = agFb(extractPosts(raw));
      prev.facebook = agFb(extractPosts(praw));
    }));
  }

  if (daily.includes('youtube')) {
    jobs.push(Promise.all([
      safeGet(http, '/v2/analytics/posts/youtube', { userId, blogId: b.blogId, from: toV2s(date),     to: toV2e(date),     postsType: 'publishedInRange' }),
      safeGet(http, '/v2/analytics/posts/youtube', { userId, blogId: b.blogId, from: toV2s(prevDate), to: toV2e(prevDate), postsType: 'publishedInRange' }),
    ]).then(([raw, praw]) => {
      data.youtube = agYt(extractPosts(raw));
      prev.youtube = agYt(extractPosts(praw));
    }));
  }

  await Promise.all(jobs);
  return { data, prev };
}

async function buildDailySocialData() {
  const { http, userId } = mcClient();
  const now2      = nowET();
  const date      = yesterdayDateET();
  const dbd       = new Date(now2); dbd.setDate(now2.getDate() - 2);
  const prevDate  = dateKeyET(dbd);
  const dbd2      = new Date(now2); dbd2.setDate(now2.getDate() - 3);
  const prevPrev  = dateKeyET(dbd2);  // for follower delta of prevDate

  console.log(`[Social Daily] Fecha: ${date} (vs ${prevDate})`);

  const resolved = await resolveBrands(http, userId);
  const results  = {};

  for (const brand of BRANDS) {
    const b = resolved[brand.key];
    if (!b?.blogId) { results[brand.key] = { ...b, data: {}, prev: {}, error: 'No blogId' }; continue; }

    const [dayData, follCur, follPrev] = await Promise.all([
      fetchOneDayBrand(http, userId, b, date, prevDate),
      fetchFollowerTimeline(http, userId, b.blogId, 'instagram', { start: prevDate, end: date   }, 'account'),
      fetchFollowerTimeline(http, userId, b.blogId, 'instagram', { start: prevPrev, end: prevDate }, 'account'),
    ]);

    if (dayData.data.instagram) {
      dayData.data.instagram.newFollowers = follCur.followerGrowth;
      dayData.data.instagram.followers    = follCur.followers;
    }
    if (dayData.prev.instagram) {
      dayData.prev.instagram.newFollowers = follPrev.followerGrowth;
      dayData.prev.instagram.followers    = follPrev.followers;
    }

    results[brand.key] = { ...b, data: dayData.data, prev: dayData.prev };
  }

  return { date, prevDate, results };
}

// ══════════════════════════════════════════════════════════
// DAILY AI — Analysis per brand
// ══════════════════════════════════════════════════════════

async function generateDailyAI(results, date) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const summary = BRANDS.map(bc => {
      const b = results[bc.key];
      const d = b?.data || {}, p = b?.prev || {};
      const ig  = d.instagram, pig = p.instagram;
      const tt  = d.tiktok,    ptt = p.tiktok;
      const fb  = d.facebook,  pfb = p.facebook;
      const yt  = d.youtube,   pyt = p.youtube;
      return `${bc.name}:
  Instagram: ${ig?.postsCount||0} posts · alcance ${ig?.totalReach||0} (ayer: ${pig?.totalReach||0}) · eng ${ig?.avgEng?.toFixed(2)||'—'}% · likes ${ig?.totalLikes||0} · comentarios ${ig?.totalComments||0} · guardados ${ig?.totalSaved||0} · compartidos ${ig?.totalShares||0} · nuevos seguidores ${ig?.newFollowers ?? '—'} (ayer: ${pig?.newFollowers ?? '—'})
  Facebook: ${fb?.postsCount||0} posts · alcance ${fb?.totalReach||0} · likes ${fb?.totalLikes||0}
  YouTube: ${yt?.postsCount||0} videos · ${yt?.totalViews||0} vistas · ${yt?.watchHours||0}h watch`;
    }).join('\n\n');

    const { content } = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: `Eres estratega de redes sociales para JP Legacy Group (inmobiliaria en Florida).
Datos del ${date} vs día anterior:

${summary}

Si una marca no publicó nada ese día, igual analiza el alcance orgánico y sugiere qué publicar al día siguiente.

Responde en español, máximo 850 tokens, con este formato EXACTO:

=== PAOLA DÍAZ ===
- ¿Qué funcionó bien hoy? [basado en los datos reales]
- ¿Qué bajó o no rindió? [lo que estuvo en 0 o bajó vs ayer]
- Acción 1 para mañana: [recomendación concreta]
- Acción 2 para mañana: [recomendación concreta]

=== JORGE FLOREZ ===
- ¿Qué funcionó bien hoy? [basado en los datos]
- ¿Qué bajó o no rindió? [lo que bajó]
- Acción 1 para mañana: [recomendación]
- Acción 2 para mañana: [recomendación]

=== JP LEGACY GROUP ===
- ¿Qué funcionó bien hoy? [basado en los datos]
- ¿Qué bajó o no rindió? [lo que bajó]
- Acción 1 para mañana: [recomendación]
- Acción 2 para mañana: [recomendación]

=== OPORTUNIDAD DE LA SEMANA ===
Basado en los datos de las 3 marcas hoy, ¿qué tipo de contenido deberían priorizar esta semana? [1-2 líneas concretas]`,
      }],
    });
    return content[0]?.text || null;
  } catch (e) {
    console.warn('[Social Daily] AI error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// DAILY HTML BUILDER
// ══════════════════════════════════════════════════════════

function buildDailySocialHTML({ date, prevDate, results, aiText }) {
  const now     = nowET();
  const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });

  // Day-over-day delta badge
  function dd(cur, prev) {
    if (cur == null || prev == null) return '';
    const diff = (cur||0) - (prev||0);
    if (diff === 0) return '<span style="color:#444;font-size:9px;font-family:Arial;">▬0</span>';
    const color = diff > 0 ? '#4CAF50' : '#FF4444';
    return `<span style="color:${color};font-size:9px;font-family:Arial;">${diff > 0 ? '▲' : '▼'}${fmtN(Math.abs(diff))}</span>`;
  }

  function mCell(label, value, delta, valColor) {
    return `<td style="padding:7px 8px;text-align:center;border-right:1px solid #111;">
      <div style="color:#444;font-size:8px;letter-spacing:1px;font-family:Arial;margin-bottom:2px;">${label}</div>
      <div style="color:${valColor||'#FFF'};font-size:15px;font-weight:bold;font-family:Arial;line-height:1;">${value}</div>
      <div style="height:13px;margin-top:2px;">${delta||''}</div>
    </td>`;
  }

  function dayPlatformBlock(pfKey, pf, prevpf) {
    const pm  = PLATFORM_META[pfKey];
    if (!pf) return '';
    const isYT = pfKey === 'youtube';
    const isIG = pfKey === 'instagram';

    // Skip if truly empty
    const noData = !pf.postsCount && !(pf.totalReach) && !(pf.totalViews)
                   && !(isIG && pf.newFollowers != null);
    if (noData) {
      return `<tr><td style="padding:0 0 6px;">
        <table width="100%" cellpadding="0" cellspacing="0"
          style="background:${pm.bg};border:1px solid ${pm.color}22;border-radius:6px;">
          <tr><td style="padding:6px 10px;">
            <span style="color:${pm.color};font-size:11px;font-family:Arial;">${pm.icon} ${pm.name}</span>
            <span style="color:#333;font-size:10px;font-family:Arial;margin-left:8px;font-style:italic;">Sin actividad</span>
          </td></tr>
        </table>
      </td></tr>`;
    }

    let statsRow = '';
    if (isYT) {
      statsRow = `<tr>
        ${mCell('VISTAS',     fmtN(pf.totalViews||0),  dd(pf.totalViews,  prevpf?.totalViews))}
        ${mCell('WATCH TIME', `${pf.watchHours||0}h`,  dd(pf.watchHours,  prevpf?.watchHours))}
        ${mCell('VIDEOS',     pf.postsCount||0,         dd(pf.postsCount,  prevpf?.postsCount))}
      </tr>`;
    } else {
      const thirdCell = isIG && pf.newFollowers != null
        ? mCell('NUEVOS SEG', fmtNP(pf.newFollowers), dd(pf.newFollowers, prevpf?.newFollowers), pf.newFollowers >= 0 ? '#4CAF50' : '#FF4444')
        : mCell('POSTS', pf.postsCount||0, dd(pf.postsCount, prevpf?.postsCount));
      statsRow = `<tr>
        ${mCell('ALCANCE', fmtN(pf.totalReach||0), dd(pf.totalReach, prevpf?.totalReach))}
        ${mCell('ENGAGEMENT', pf.avgEng != null ? fmtPct(pf.avgEng) : '—', dd(pf.avgEng, prevpf?.avgEng))}
        ${thirdCell}
      </tr>`;
    }

    // Engagement breakdown row (IG and FB only)
    let engRow = '';
    if (!isYT) {
      const hasEng = (pf.totalLikes||0) + (pf.totalComments||0) + (pf.totalSaved||0) + (pf.totalShares||0) > 0;
      if (hasEng) {
        const savedCell = isIG
          ? `<td style="padding:3px 0;text-align:center;border-right:1px solid #111;">
              <div style="color:#888;font-size:10px;font-family:Arial;">🔖 <strong style="color:#FFF;">${fmtN(pf.totalSaved||0)}</strong></div>
              <div>${dd(pf.totalSaved, prevpf?.totalSaved)}</div>
            </td>`
          : '';
        engRow = `<tr><td colspan="3" style="padding:4px 6px 6px;border-top:1px solid #111;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="padding:3px 0;text-align:center;border-right:1px solid #111;">
              <div style="color:#888;font-size:10px;font-family:Arial;">❤️ <strong style="color:#FFF;">${fmtN(pf.totalLikes||0)}</strong></div>
              <div>${dd(pf.totalLikes, prevpf?.totalLikes)}</div>
            </td>
            <td style="padding:3px 0;text-align:center;border-right:1px solid #111;">
              <div style="color:#888;font-size:10px;font-family:Arial;">💬 <strong style="color:#FFF;">${fmtN(pf.totalComments||0)}</strong></div>
              <div>${dd(pf.totalComments, prevpf?.totalComments)}</div>
            </td>
            ${savedCell}
            <td style="padding:3px 0;text-align:center;">
              <div style="color:#888;font-size:10px;font-family:Arial;">↗️ <strong style="color:#FFF;">${fmtN(pf.totalShares||0)}</strong></div>
              <div>${dd(pf.totalShares, prevpf?.totalShares)}</div>
            </td>
          </tr></table>
        </td></tr>`;
      }
    }

    return `<tr><td style="padding:0 0 8px;">
      <table width="100%" cellpadding="0" cellspacing="0"
        style="background:${pm.bg};border:1px solid ${pm.color}33;border-radius:6px;overflow:hidden;">
        <tr><td style="padding:6px 10px;background:${pm.color}18;border-bottom:1px solid ${pm.color}33;">
          <span style="color:${pm.color};font-size:11px;font-weight:bold;letter-spacing:1px;font-family:Arial;">${pm.icon} ${pm.name}</span>
          <span style="color:#444;font-size:9px;font-family:Arial;margin-left:8px;">${pf.postsCount||0} posts publicados</span>
        </td></tr>
        <tr><td><table width="100%" cellpadding="0" cellspacing="0">${statsRow}${engRow}</table></td></tr>
      </table>
    </td></tr>`;
  }

  function dayBrandRow(brand, result) {
    const d    = result?.data || {};
    const prev = result?.prev || {};
    const plats = ['instagram','facebook','youtube'].filter(p => brand.platforms.includes(p));
    const platformBlocks = plats.map(pfKey => dayPlatformBlock(pfKey, d[pfKey], prev[pfKey])).join('');

    return `
    <tr><td style="padding:0 0 10px;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:${brand.bg};border:1px solid ${brand.border};border-radius:8px;overflow:hidden;">
      <tr><td style="padding:9px 14px;background:linear-gradient(90deg,${brand.color}22,${brand.color2}11,transparent);
        border-bottom:1px solid ${brand.border};">
        <span style="font-size:14px;font-weight:bold;font-family:Arial;
          background:linear-gradient(90deg,${brand.color},${brand.color2});
          -webkit-background-clip:text;-webkit-text-fill-color:transparent;">
          ${brand.icon} ${brand.name}
        </span>
      </td></tr>
      <tr><td style="padding:10px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">${platformBlocks}</table>
      </td></tr>
    </table>
    </td></tr>`;
  }

  // Per-brand AI analysis block
  function dailyAiBlock(text) {
    if (!text) return '';
    const html = text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/=== (PAOLA[^=]*)===/g,        '<strong style="color:#FF6B9D;font-size:12px;letter-spacing:1px;">👩 $1</strong>')
      .replace(/=== (JORGE[^=]*)===/g,        '<strong style="color:#4FC3F7;font-size:12px;letter-spacing:1px;">👨 $1</strong>')
      .replace(/=== (JP LEGACY[^=]*)===/g,    '<strong style="color:#C9A84C;font-size:12px;letter-spacing:1px;">🏢 $1</strong>')
      .replace(/=== (OPORTUNIDAD[^=]*)===/g,  '<strong style="color:#818CF8;font-size:12px;letter-spacing:1px;">🌐 $1</strong>')
      .replace(/- ¿Qué funcionó[^\n]*/g,      m => `<span style="color:#4CAF50;">${m}</span>`)
      .replace(/- ¿Qué bajó[^\n]*/g,          m => `<span style="color:#FF9800;">${m}</span>`)
      .replace(/- Acción \d[^\n]*/g,           m => `<span style="color:#FFD700;">${m}</span>`)
      .replace(/•\s+/g, '&bull;&nbsp;')
      .replace(/\n/g, '<br>');
    return `
    <tr><td style="height:14px;"></td></tr>
    <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#060610;border:1px solid #1A1A2A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:10px 14px;background:#0A0A1A;border-bottom:1px solid #1A1A2A;">
        <span style="color:#818CF8;font-size:11px;font-weight:bold;letter-spacing:2px;font-family:Arial;">🤖 ANÁLISIS CLAUDE AI — POR MARCA</span>
      </td></tr>
      <tr><td style="padding:14px 16px;color:#CCC;font-size:11px;line-height:1.9;font-family:Arial;">${html}</td></tr>
    </table>
    </td></tr>`;
  }

  const brandRows      = BRANDS.map(bc => dayBrandRow(bc, results[bc.key])).join('');
  const [yr, mo, dy]   = date.split('-').map(Number);
  const dt             = new Date(Date.UTC(yr, mo-1, dy));

  const body = `
    <tr><td style="padding:24px 0 16px;text-align:center;border-bottom:2px solid #C9A84C;">
      <div style="font-size:10px;letter-spacing:4px;color:#C9A84C;text-transform:uppercase;font-family:Arial;margin-bottom:5px;">JP LEGACY GROUP</div>
      <div style="font-size:20px;font-weight:bold;color:#FFF;font-family:Arial;letter-spacing:1px;">📱 Reporte Diario de Redes</div>
      <div style="font-size:12px;color:#AAA;font-family:Arial;margin-top:5px;">${DAYS_ES[dt.getUTCDay()]} ${dy} de ${MONTHS_ES[mo-1]}</div>
      <div style="font-size:10px;color:#555;font-family:Arial;margin-top:2px;">vs ${shortDateES(prevDate)} · Generado ${timeStr} ET</div>
    </td></tr>
    <tr><td style="height:16px;"></td></tr>
    ${brandRows}
    ${dailyAiBlock(aiText)}
    <tr><td style="height:20px;"></td></tr>
    <tr><td style="text-align:center;padding:12px;border-top:1px solid #1A1A1A;">
      <div style="color:#C9A84C;font-size:11px;font-weight:bold;letter-spacing:2px;font-family:Arial;">JP LEGACY GROUP</div>
      <div style="color:#333;font-size:10px;font-family:Arial;margin-top:3px;">
        Reporte automático diario · JP Legacy Agent · America/New_York
      </div>
    </td></tr>`;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>JP Legacy — Redes Diario</title></head>
<body style="margin:0;padding:0;background:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0A0A0A">
<tr><td align="center" style="padding:16px 10px;">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">
${body}
</table></td></tr></table></body></html>`;
}

async function sendDailySocialReport() {
  console.log('[Social Daily] Iniciando reporte diario de redes…');
  const data    = await buildDailySocialData();
  const aiText  = await generateDailyAI(data.results, data.date);
  const html    = buildDailySocialHTML({ ...data, aiText });
  const [y, m, d] = data.date.split('-').map(Number);
  const dt      = new Date(Date.UTC(y, m-1, d));
  const subject = `JP Legacy — Reporte Diario de Redes · ${DAYS_ES[dt.getUTCDay()]} ${d} ${MONTHS_ES[m-1].slice(0,3)}`;

  if (!process.env.RESEND_API_KEY) {
    console.warn('[Social Daily] RESEND_API_KEY no configurado — email omitido');
    return { subject, html, data };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: 'JP Legacy Agent <apps@jplegacygroup.com>',
    to: DAILY_RECIPIENTS,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[Social Daily] ✅ Email enviado: ${subject}`);
  return { subject, data };
}

// ══════════════════════════════════════════════════════════
// MONTHLY DATA BUILDER
// ══════════════════════════════════════════════════════════

async function buildMonthlySocialData() {
  const { http, userId } = mcClient();
  const range     = previousMonthRange();
  const prevRange = monthBeforeRange();
  console.log(`[Social Monthly] Mes: ${range.name} ${range.year} vs ${prevRange.name} ${prevRange.year}`);

  const resolved = await resolveBrands(http, userId);
  const results  = {};

  for (const brand of BRANDS) {
    const b = resolved[brand.key];
    if (!b?.blogId) { results[brand.key] = { ...b, data:{}, prevData:{}, error:'No blogId' }; continue; }
    console.log(`[Social Monthly] Fetching "${b.name}"…`);

    const fetchForRange = async (r) => {
      const data = {};
      const jobs = [];
      if (b.platforms.includes('instagram')) jobs.push(fetchInstagram(http, userId, b.blogId, r).then(d => { data.instagram = d; }));
      if (b.platforms.includes('tiktok'))    jobs.push(fetchTikTok   (http, userId, b.blogId, r).then(d => { data.tiktok    = d; }));
      if (b.platforms.includes('facebook'))  jobs.push(fetchFacebook (http, userId, b.blogId, r).then(d => { data.facebook  = d; }));
      if (b.platforms.includes('youtube'))   jobs.push(fetchYouTube  (http, userId, b.blogId, r).then(d => { data.youtube   = d; }));
      await Promise.all(jobs);
      return data;
    };

    const [data, prevData] = await Promise.all([fetchForRange(range), fetchForRange(prevRange)]);
    results[brand.key] = { ...b, data, prevData };
    console.log(`[Social Monthly]   → ${b.name}: ${Object.values(data).reduce((s,p)=>s+(p?.postsCount||0),0)} posts`);
  }

  // All posts for top-5 and best day/hour analysis
  const allPosts = [];
  for (const brand of BRANDS) {
    const b = results[brand.key];
    if (!b?.data) continue;
    for (const [pfKey, pf] of Object.entries(b.data))
      for (const p of (pf?.posts||[]))
        allPosts.push({ ...p, _brand: brand.name, _brandIcon: brand.icon, _platform: pfKey });
  }

  const top5Views = [...allPosts]
    .sort((a,b) => (b.viewCount||b.views||b.videoViews||b.reach||0)-(a.viewCount||a.views||a.videoViews||a.reach||0))
    .slice(0,5);
  const top5Eng = [...allPosts]
    .sort((a,b) => (b.engagement||0)-(a.engagement||0))
    .slice(0,5);

  const bestByBrand = {};
  for (const brand of BRANDS) {
    const b = results[brand.key];
    if (!b?.data) continue;
    bestByBrand[brand.key] = bestDayHour(Object.values(b.data).flatMap(pf => pf?.posts||[]));
  }

  const aiText = await generateMonthlyAI(results, range, prevRange);
  return { range, prevRange, results, top5Views, top5Eng, bestByBrand, aiText };
}

async function generateMonthlyAI(results, range, prevRange) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const summary = BRANDS.map(bc => {
      const b = results[bc.key];
      const d = b?.data||{}, pd = b?.prevData||{};
      return `${bc.name} — ${range.name}:
  Instagram: ${d.instagram?.postsCount||0} posts, alcance ${fmtN(d.instagram?.totalReach)}, eng ${fmtPct(d.instagram?.avgEng)}, seguidores ${fmtN(d.instagram?.followers)} (${fmtNP(d.instagram?.followerGrowth)})
  TikTok: ${d.tiktok?.postsCount||0} videos, ${fmtN(d.tiktok?.totalViews)} vistas, eng ${fmtPct(d.tiktok?.avgEng)}
  Facebook: ${d.facebook?.postsCount||0} posts, alcance ${fmtN(d.facebook?.totalReach)}, eng ${fmtPct(d.facebook?.avgEng)}
  YouTube: ${d.youtube?.postsCount||0} videos, ${fmtN(d.youtube?.totalViews)} vistas
  vs ${prevRange.name}: IG posts ${pd.instagram?.postsCount||0}, alcance ${fmtN(pd.instagram?.totalReach)}, TT ${fmtN(pd.tiktok?.totalViews)} vistas`;
    }).join('\n\n');

    const { content } = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 750,
      messages: [{
        role: 'user',
        content: `Eres estratega experto en redes sociales para JP Legacy Group (inmobiliaria en Florida).
Datos de ${range.name} ${range.year} comparado con ${prevRange.name} ${prevRange.year}:

${summary}

Responde en español, máximo 700 tokens:

📊 RESUMEN DEL MES
[2-3 líneas sobre desempeño general vs mes anterior]

🏆 MEJOR RESULTADO DEL MES
[El logro más destacado con datos concretos]

⚠️ PUNTO A MEJORAR
[La mayor oportunidad de mejora]

💡 5 RECOMENDACIONES PARA EL PRÓXIMO MES
1. [recomendación estratégica concreta con plataforma y formato]
2. [recomendación]
3. [recomendación]
4. [recomendación]
5. [recomendación]

🎯 OBJETIVO CLAVE PARA EL PRÓXIMO MES
[Una meta específica y medible]`,
      }],
    });
    return content[0]?.text || null;
  } catch (e) {
    console.warn('[Social Monthly] AI error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// MONTHLY HTML BUILDER
// ══════════════════════════════════════════════════════════

function buildMonthlySocialHTML({ range, prevRange, results, top5Views, top5Eng, bestByBrand, aiText }) {
  const now     = nowET();
  const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });

  function delta(cur, prev) {
    if (cur == null || prev == null || prev === 0) return '';
    const d = cur - prev, pct = ((d/prev)*100).toFixed(1);
    const color = d >= 0 ? '#4CAF50' : '#FF4444';
    return `<span style="color:${color};font-size:10px;font-family:Arial;">${d>=0?'▲':'▼'} ${pct}%</span>`;
  }

  function compRow(label, cur, prev, fmt) {
    const f = fmt || (v => fmtN(v||0));
    return `<tr style="border-bottom:1px solid #0D0D0D;">
      <td style="padding:5px 10px;color:#666;font-size:10px;font-family:Arial;">${label}</td>
      <td style="padding:5px 10px;color:#FFF;font-size:11px;font-weight:bold;font-family:Arial;">${f(cur)}</td>
      <td style="padding:5px 10px;color:#444;font-size:10px;font-family:Arial;">${f(prev)}</td>
      <td style="padding:5px 10px;">${delta(cur, prev)}</td>
    </tr>`;
  }

  function monthlyBrandSection(brand, result) {
    const d  = result?.data    || {};
    const pd = result?.prevData || {};
    const bh = bestByBrand[brand.key] || { day:'—', hour:'—', dayEng:'—' };

    const platformRows = brand.platforms.filter(pf => d[pf]).map(pf => platformCard(d[pf], brand)).join('');

    const compTable = `
    <tr><td style="padding:4px 0 8px;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:6px;">
      <tr style="background:#111;">
        <td style="padding:5px 10px;color:#555;font-size:9px;letter-spacing:1px;font-family:Arial;">MÉTRICA</td>
        <td style="padding:5px 10px;color:${brand.color};font-size:9px;letter-spacing:1px;font-family:Arial;">${range.name.toUpperCase()}</td>
        <td style="padding:5px 10px;color:#444;font-size:9px;letter-spacing:1px;font-family:Arial;">${prevRange.name.toUpperCase()}</td>
        <td style="padding:5px 10px;color:#333;font-size:9px;font-family:Arial;">Δ</td>
      </tr>
      ${compRow('IG Seguidores',  d.instagram?.followers,  pd.instagram?.followers)}
      ${compRow('IG Alcance',     d.instagram?.totalReach, pd.instagram?.totalReach)}
      ${compRow('IG Engagement',  d.instagram?.avgEng,     pd.instagram?.avgEng, v => fmtPct(v))}
      ${d.tiktok ? compRow('TT Vistas',      d.tiktok?.totalViews, pd.tiktok?.totalViews) : ''}
      ${d.tiktok ? compRow('TT Engagement',  d.tiktok?.avgEng,     pd.tiktok?.avgEng, v => fmtPct(v)) : ''}
      ${compRow('FB Alcance',     d.facebook?.totalReach,  pd.facebook?.totalReach)}
    </table>
    </td></tr>
    <tr><td style="padding:0 0 14px;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#0D0D0D;border:1px solid #1A1A1A;border-radius:6px;">
      <tr>
        <td style="padding:8px 12px;">
          <span style="color:#555;font-size:10px;font-family:Arial;">📅 Mejor día:</span>
          <span style="color:${brand.color};font-size:11px;font-weight:bold;font-family:Arial;margin-left:6px;">${bh.day}</span>
          <span style="color:#444;font-size:10px;font-family:Arial;margin-left:4px;">(eng ${bh.dayEng})</span>
        </td>
        <td style="padding:8px 12px;">
          <span style="color:#555;font-size:10px;font-family:Arial;">⏰ Mejor hora:</span>
          <span style="color:${brand.color};font-size:11px;font-weight:bold;font-family:Arial;margin-left:6px;">${bh.hour} ET</span>
        </td>
      </tr>
    </table>
    </td></tr>`;

    return `
    <tr><td style="padding:0 0 12px;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:${brand.bg};border:1px solid ${brand.border};border-radius:10px;overflow:hidden;">
      <tr><td style="padding:12px 16px;background:linear-gradient(90deg,${brand.color}33,${brand.color2}11,transparent);
        border-bottom:2px solid ${brand.border};">
        <span style="font-size:15px;font-weight:bold;font-family:Arial;
          background:linear-gradient(90deg,${brand.color},${brand.color2});
          -webkit-background-clip:text;-webkit-text-fill-color:transparent;">
          ${brand.icon} ${brand.name}
        </span>
        <span style="color:#444;font-size:10px;font-family:Arial;margin-left:10px;">
          ${Object.values(d).reduce((s,p)=>s+(p?.postsCount||0),0)} posts en ${range.name}
        </span>
      </td></tr>
      <tr><td style="padding:12px 14px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${platformRows}
        <tr><td style="height:8px;"></td></tr>
        ${compTable}
      </table>
      </td></tr>
    </table>
    </td></tr>`;
  }

  function top5Table(title, posts, icon) {
    const rows = posts.map((p, i) => {
      const val = icon === '👁' ? fmtN(p.viewCount||p.views||p.videoViews||p.reach||0) : fmtPct(p.engagement||0);
      const pm  = PLATFORM_META[p._platform] || {};
      return `<tr style="background:${i%2===0?'#0D0D0D':'#0A0A0A'};">
        <td style="padding:6px 10px;color:${pm.color||'#888'};font-size:10px;font-family:Arial;width:70px;">${pm.icon||''} ${pm.name||p._platform}</td>
        <td style="padding:6px 10px;color:#777;font-size:10px;font-family:Arial;width:70px;">${p._brandIcon} ${p._brand.split(' ')[0]}</td>
        <td style="padding:6px 10px;color:#CCC;font-size:10px;font-family:Arial;">${cap(p)}</td>
        <td style="padding:6px 10px;color:#FFF;font-size:11px;font-weight:bold;font-family:Arial;text-align:right;white-space:nowrap;">${val}</td>
      </tr>`;
    }).join('');

    return `
    <tr><td style="padding:0 0 10px;">
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#0D0D0D;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:9px 14px;background:#111;border-bottom:1px solid #1E1E1E;">
        <span style="color:#C9A84C;font-size:11px;font-weight:bold;letter-spacing:2px;font-family:Arial;">${icon} TOP 5 — ${title}</span>
      </td></tr>
      <tr><td><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
    </table>
    </td></tr>`;
  }

  function monthlyAiBlock(text) {
    if (!text) return '';
    const html = text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/📊 (RESUMEN[^\n]*)/g,     '<strong style="color:#C9A84C;font-size:12px;">📊 $1</strong>')
      .replace(/🏆 (MEJOR[^\n]*)/g,        '<strong style="color:#4CAF50;font-size:12px;">🏆 $1</strong>')
      .replace(/⚠️ (PUNTO[^\n]*)/g,        '<strong style="color:#FF9800;font-size:12px;">⚠️ $1</strong>')
      .replace(/💡 (5 RECOMEND[^\n]*)/g,   '<strong style="color:#FFD700;font-size:12px;">💡 $1</strong>')
      .replace(/🎯 (OBJETIVO[^\n]*)/g,     '<strong style="color:#4FC3F7;font-size:12px;">🎯 $1</strong>')
      .replace(/\n/g,'<br>');
    return `<tr><td style="height:16px;"></td></tr>
    <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#060610;border:1px solid #1A1A2A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:10px 14px;background:#0A0A1A;border-bottom:1px solid #1A1A2A;">
        <span style="color:#818CF8;font-size:11px;font-weight:bold;letter-spacing:2px;font-family:Arial;">🤖 ANÁLISIS CLAUDE AI — ESTRATEGIA MENSUAL</span>
      </td></tr>
      <tr><td style="padding:16px;color:#CCC;font-size:12px;line-height:1.8;font-family:Arial;">${html}</td></tr>
    </table>
    </td></tr>`;
  }

  const brandSections = BRANDS.map(bc => monthlyBrandSection(bc, results[bc.key])).join('');

  const body = `
    <tr><td style="padding:28px 0 18px;text-align:center;border-bottom:2px solid #C9A84C;">
      <div style="font-size:10px;letter-spacing:4px;color:#C9A84C;text-transform:uppercase;font-family:Arial;margin-bottom:5px;">JP LEGACY GROUP</div>
      <div style="font-size:22px;font-weight:bold;color:#FFF;font-family:Arial;letter-spacing:1px;">📅 Reporte Mensual de Redes</div>
      <div style="font-size:13px;color:#AAA;font-family:Arial;margin-top:6px;">${range.name} ${range.year}</div>
      <div style="font-size:10px;color:#333;font-family:Arial;margin-top:3px;">Generado ${timeStr} ET</div>
    </td></tr>
    <tr><td style="height:18px;"></td></tr>
    ${brandSections}
    <tr><td style="height:6px;background:linear-gradient(90deg,#C9A84C33,transparent);border-radius:3px;"></td></tr>
    <tr><td style="height:12px;"></td></tr>
    ${top5Views.length ? top5Table('MAYOR ALCANCE / VISTAS', top5Views, '👁') : ''}
    ${top5Eng.length   ? top5Table('MAYOR ENGAGEMENT',       top5Eng,   '⚡') : ''}
    ${monthlyAiBlock(aiText)}
    <tr><td style="height:24px;"></td></tr>
    <tr><td style="text-align:center;padding:14px;border-top:1px solid #1A1A1A;">
      <div style="color:#C9A84C;font-size:12px;font-weight:bold;letter-spacing:3px;font-family:Arial;">JP LEGACY GROUP</div>
      <div style="color:#333;font-size:10px;font-family:Arial;margin-top:4px;">
        Reporte mensual automático · JP Legacy Agent · America/New_York
      </div>
    </td></tr>`;

  return `<!DOCTYPE html><html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>JP Legacy — Redes Mensual</title></head>
<body style="margin:0;padding:0;background:#0A0A0A;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0A0A0A">
<tr><td align="center" style="padding:20px 10px;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">
${body}
</table></td></tr></table></body></html>`;
}

async function sendMonthlySocialReport() {
  console.log('[Social Monthly] Iniciando reporte mensual de redes…');
  const data    = await buildMonthlySocialData();
  const html    = buildMonthlySocialHTML(data);
  const subject = `JP Legacy — Reporte Mensual de Redes · ${data.range.name} ${data.range.year}`;

  if (!process.env.RESEND_API_KEY) {
    console.warn('[Social Monthly] RESEND_API_KEY no configurado — email omitido');
    return { subject, html, data };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: 'JP Legacy Agent <apps@jplegacygroup.com>',
    to: RECIPIENTS,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[Social Monthly] ✅ Email enviado: ${subject}`);
  return { subject, data };
}

// ══════════════════════════════════════════════════════════
// CRON — Todos los schedules de Social
// ══════════════════════════════════════════════════════════

function startSocialReport() {
  // AJUSTE 1: Semanal a 9:05am ET (desfasado 5 min vs Marketing Weekly @ 9:00am)
  cron.schedule('5 14 * * 1', async () => {
    console.log('[Social] Cron: reporte semanal de redes…');
    try { await sendSocialReport(); }
    catch (err) { console.error('[Social] Error semanal:', err.message); }
  });

  // AJUSTE 2: Diario lun-vie 8:00am ET
  cron.schedule('0 13 * * 1-5', async () => {
    console.log('[Social Daily] Cron: reporte diario de redes…');
    try { await sendDailySocialReport(); }
    catch (err) { console.error('[Social Daily] Error:', err.message); }
  });

  // AJUSTE 3: Mensual día 1 a 8:05am ET
  cron.schedule('5 12 1 * *', async () => {
    console.log('[Social Monthly] Cron: reporte mensual de redes…');
    try { await sendMonthlySocialReport(); }
    catch (err) { console.error('[Social Monthly] Error:', err.message); }
  });

  console.log('[Cron] ✅ Social Daily:   0 13 * * 1-5  → 8:00am ET lun-vie');
  console.log('[Cron] ✅ Social Weekly:  5 14 * * 1    → 9:05am ET lunes');
  console.log('[Cron] ✅ Social Monthly: 5 12 1 * *    → 8:05am ET día 1');
}

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════

module.exports = {
  startSocialReport,
  sendSocialReport,        buildSocialData,
  sendDailySocialReport,   buildDailySocialData,
  sendMonthlySocialReport, buildMonthlySocialData,
};
