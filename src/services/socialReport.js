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

async function fetchInstagram(http, userId, blogId, range) {
  const b = { userId, blogId };
  const [posts, reels] = await Promise.all([
    safeGet(http, '/stats/instagram/posts', { ...b, start: toV1(range.start), end: toV1(range.end) }),
    safeGet(http, '/stats/instagram/reels', { ...b, start: toV1(range.start), end: toV1(range.end) }),
  ]);
  const all = [...extractPosts(posts), ...extractPosts(reels)];
  return {
    platform:    'instagram',
    posts:       all,
    postsCount:  all.length,
    totalReach:  all.reduce((s,p) => s + (p.reach||0), 0),
    totalImpr:   all.reduce((s,p) => s + (p.impressions||0), 0),
    avgEng:      all.length ? all.reduce((s,p) => s + (p.engagement||0), 0) / all.length : null,
    topEng:      topByField(all, 'engagement'),
    topViews:    topByField(all, 'videoViews', 'views', 'reach'),
    followers:   null, followerGrowth: null, followerPct: null,
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
    totalViews: all.reduce((s,p) => s + (p.views||p.videoViews||0), 0),
    avgEng:     all.length ? all.reduce((s,p) => s + (p.engagement||0), 0) / all.length : null,
    topViews:   topByField(all, 'views', 'videoViews'),
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
    totalReach: all.reduce((s,p) => s + (p.reach||0), 0),
    avgEng:     all.length ? all.reduce((s,p) => s + (p.engagement||0), 0) / all.length : null,
    topEng:     topByField(all, 'engagement', 'reach'),
    followers:  null, followerGrowth: null, followerPct: null,
  };
}

async function fetchYouTube(http, userId, blogId, range) {
  const b = { userId, blogId };
  const raw = await safeGet(http, '/v2/analytics/posts/youtube',
    { ...b, from: toV2s(range.start), to: toV2e(range.end), postsType: 'publishedInRange' });
  const all = extractPosts(raw);
  const totalWatchSec = all.reduce((s,p) =>
    s + (p.averageViewDuration||p.watchTime||0), 0);
  return {
    platform:    'youtube',
    posts:       all,
    postsCount:  all.length,
    totalViews:  all.reduce((s,p) => s + (p.views||0), 0),
    watchHours:  Math.round(totalWatchSec / 3600),
    topViews:    topByField(all, 'views'),
    subscribers: null, subGrowth: null, subPct: null,
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
  const raw = post?.content || post?.text || post?.title || post?.description || '(sin título)';
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
  const mainMetric1 = isYT
    ? `<td style="width:50%;padding:10px 12px;border-right:1px solid #1A1A1A;">
        <div style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;">SUSCRIPTORES</div>
        <div style="color:#FFF;font-size:20px;font-weight:bold;font-family:Arial;">${fmtN(pf.subscribers||0)}</div>
        <div style="color:#4CAF50;font-size:10px;font-family:Arial;">${fmtNP(pf.subGrowth)} esta semana</div>
      </td>`
    : `<td style="width:50%;padding:10px 12px;border-right:1px solid #1A1A1A;">
        <div style="color:#888;font-size:9px;font-family:Arial;letter-spacing:1px;">SEGUIDORES</div>
        <div style="color:#FFF;font-size:20px;font-weight:bold;font-family:Arial;">${fmtN(pf.followers||0)}</div>
        <div style="color:#4CAF50;font-size:10px;font-family:Arial;">${fmtNP(pf.followerGrowth)} · ${fmtPct(pf.followerPct)}</div>
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
          👁 <strong style="color:#FFF;">${fmtN(top.videoViews||top.views||top.reach||0)}</strong>
        </td>
        <td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">
          ❤️ <strong style="color:#FFF;">${fmtN(top.likes||top.reactions||0)}</strong>
        </td>
        <td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">
          💬 <strong style="color:#FFF;">${fmtN(top.comments||0)}</strong>
        </td>
        ${top.saved ? `<td style="padding-right:10px;color:#888;font-size:10px;font-family:Arial;">🔖 <strong style="color:#FFF;">${fmtN(top.saved)}</strong></td>` : ''}
        ${top.shares ? `<td style="color:#888;font-size:10px;font-family:Arial;">↗️ <strong style="color:#FFF;">${fmtN(top.shares)}</strong></td>` : ''}
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
// CRON — Lunes 9:00am ET (14:00 UTC)
// ══════════════════════════════════════════════════════════

function startSocialReport() {
  cron.schedule('0 14 * * 1', async () => {
    console.log('[Social] Cron: reporte semanal de redes…');
    try { await sendSocialReport(); }
    catch (err) { console.error('[Social] Error:', err.message); }
  });
  console.log('[Cron] ✅ Social Weekly:  0 14 * * 1    → 9:00am ET lunes');
}

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════

module.exports = { startSocialReport, sendSocialReport, buildSocialData };
