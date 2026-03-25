/**
 * socialReport.js
 * Weekly social media report via Metricool API
 * Covers: JP Legacy Group, Paola Díaz, Jorge Florez
 * Platforms: Instagram, Facebook, TikTok, YouTube
 * Cron: Every Monday 9:00am ET (14:00 UTC)
 */

const axios = require('axios');
const cron = require('node-cron');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://app.metricool.com/api';

const RECIPIENTS = [
  'jorgeflorez@jplegacygroup.com',
  'paoladiaz@jplegacygroup.com',
  'marketing@jplegacygroup.com',
  'karen@getvau.com',
];

// Brand configuration — searchNames used to auto-match Metricool profiles
const BRANDS_CONFIG = [
  {
    key: 'jp_legacy',
    name: 'JP Legacy Group',
    envKey: 'METRICOOL_BLOG_ID_JP_LEGACY',
    searchNames: ['jp legacy', 'jplegacy', 'jp_legacy'],
    platforms: ['instagram', 'facebook', 'tiktok'],
    color: '#C9A84C',
    icon: '🏢',
  },
  {
    key: 'paola',
    name: 'Paola Díaz',
    envKey: 'METRICOOL_BLOG_ID_PAOLA',
    searchNames: ['paola', 'paola diaz', 'paola díaz'],
    platforms: ['instagram', 'facebook', 'tiktok', 'youtube'],
    color: '#FF6B9D',
    icon: '👤',
  },
  {
    key: 'jorge',
    name: 'Jorge Florez',
    envKey: 'METRICOOL_BLOG_ID_JORGE',
    searchNames: ['jorge', 'jorge florez'],
    platforms: ['instagram', 'facebook', 'tiktok', 'youtube'],
    color: '#4FC3F7',
    icon: '👤',
  },
];

const PLATFORM_ICONS = {
  instagram: '📸',
  facebook: '📘',
  tiktok: '🎵',
  youtube: '▶️',
};

const PLATFORM_COLORS = {
  instagram: '#E1306C',
  facebook: '#1877F2',
  tiktok: '#69C9D0',
  youtube: '#FF0000',
};

// ─── ET Date Helpers ──────────────────────────────────────────────────────────

function nowET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function dateKeyET(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

/** Previous full week Mon–Sun in ET */
function previousWeekRange() {
  const now = nowET();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon…
  // Monday of CURRENT week
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  // Previous Mon
  const prevMon = new Date(monday);
  prevMon.setDate(monday.getDate() - 7);
  // Previous Sun
  const prevSun = new Date(prevMon);
  prevSun.setDate(prevMon.getDate() + 6);

  return {
    start: dateKeyET(prevMon),
    end: dateKeyET(prevSun),
  };
}

/** Format YYYY-MM-DD → YYYYMMDD (v1 API format) */
function toV1(iso) {
  return iso.replace(/-/g, '');
}

/** Format YYYY-MM-DD → YYYY-MM-DDTHH:mm:ss (v2 API format) */
function toV2Start(iso) {
  return `${iso}T00:00:00`;
}
function toV2End(iso) {
  return `${iso}T23:59:59`;
}

/** "24 Mar" style */
function shortDate(iso) {
  if (!iso) return '—';
  const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "Lunes 24 de Marzo" style */
function longDate(iso) {
  if (!iso) return '—';
  const DAYS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]} ${d} de ${MONTHS[m - 1]}`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toFixed(2) + '%';
}

function fmtMin(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Metricool API Client ─────────────────────────────────────────────────────

function metricool() {
  const token = process.env.METRICOOL_API_TOKEN;
  if (!token) throw new Error('METRICOOL_API_TOKEN no configurado');
  const userId = process.env.METRICOOL_USER_ID;
  if (!userId) throw new Error('METRICOOL_USER_ID no configurado');

  const client = axios.create({
    baseURL: BASE_URL,
    headers: { 'X-Mc-Auth': token, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  return { client, userId };
}

/** GET /admin/simpleProfiles — returns all brands/profiles */
async function fetchBrands() {
  const { client, userId } = metricool();
  const { data } = await client.get('/admin/simpleProfiles', { params: { userId } });
  return Array.isArray(data) ? data : (data.data || []);
}

/** Resolve blogId for each brand — env override or name-match */
async function resolveBlogIds() {
  let profiles = null;

  const resolved = {};
  for (const brand of BRANDS_CONFIG) {
    // 1. Check env var override
    const envId = process.env[brand.envKey];
    if (envId) {
      resolved[brand.key] = { ...brand, blogId: envId };
      continue;
    }
    // 2. Auto-discover from API
    if (!profiles) {
      try {
        profiles = await fetchBrands();
        console.log(`[Social] Perfiles Metricool encontrados: ${profiles.length}`);
        profiles.forEach((p) => console.log(`  → id=${p.id} name="${p.name}"`));
      } catch (e) {
        console.error('[Social] No se pudo obtener perfiles:', e.message);
        profiles = [];
      }
    }
    const match = profiles.find((p) =>
      brand.searchNames.some((s) => (p.name || '').toLowerCase().includes(s))
    );
    if (match) {
      resolved[brand.key] = { ...brand, blogId: String(match.id) };
      console.log(`[Social] Matched "${brand.name}" → blogId=${match.id}`);
    } else {
      console.warn(`[Social] ⚠️ No se encontró perfil para "${brand.name}"`);
      resolved[brand.key] = { ...brand, blogId: null };
    }
  }
  return resolved;
}

// ─── Platform Data Fetchers ───────────────────────────────────────────────────

async function safeGet(client, url, params) {
  try {
    const { data } = await client.get(url, { params });
    return data;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    console.warn(`[Social] ⚠️ ${url} → ${status || 'ERR'}: ${msg}`);
    return null;
  }
}

async function fetchInstagramData(client, userId, blogId, range) {
  const base = { userId, blogId };
  const v1p = { ...base, start: toV1(range.start), end: toV1(range.end) };
  const v2p = { ...base, from: toV2Start(range.start), to: toV2End(range.end) };

  const [posts, reels, stories, followersTL] = await Promise.all([
    safeGet(client, '/stats/instagram/posts',   v1p),
    safeGet(client, '/stats/instagram/reels',   v1p),
    safeGet(client, '/stats/instagram/stories', v1p),
    safeGet(client, '/v2/analytics/timelines', {
      ...v2p, network: 'instagram', subject: 'account', metric: 'followers',
    }),
  ]);

  const allPosts = [...(Array.isArray(posts) ? posts : []), ...(Array.isArray(reels) ? reels : [])];

  // Sort by engagement desc for top content
  const sorted = [...allPosts].sort((a, b) => (b.engagement || 0) - (a.engagement || 0));
  const topByViews = [...allPosts].sort((a, b) => (b.views || b.reach || 0) - (a.views || a.reach || 0));

  // Follower growth from timeline
  const tlValues = followersTL?.data?.[0]?.values || [];
  const currentFollowers = tlValues.length ? tlValues[tlValues.length - 1]?.value : null;
  const startFollowers   = tlValues.length ? tlValues[0]?.value : null;
  const followerGrowth   = currentFollowers !== null && startFollowers !== null
    ? currentFollowers - startFollowers : null;

  return {
    platform: 'instagram',
    posts: Array.isArray(posts) ? posts : [],
    reels: Array.isArray(reels) ? reels : [],
    stories: Array.isArray(stories) ? stories : [],
    topEngagement: sorted.slice(0, 3),
    topViews: topByViews.slice(0, 3),
    totalReach: allPosts.reduce((s, p) => s + (p.reach || 0), 0),
    totalImpressions: allPosts.reduce((s, p) => s + (p.impressions || 0), 0),
    avgEngagementRate: allPosts.length
      ? allPosts.reduce((s, p) => s + (p.engagement || 0), 0) / allPosts.length
      : null,
    currentFollowers,
    followerGrowth,
    postsCount: allPosts.length,
  };
}

async function fetchFacebookData(client, userId, blogId, range) {
  const base = { userId, blogId };
  const v1p = { ...base, start: toV1(range.start), end: toV1(range.end) };
  const v2p = { ...base, from: toV2Start(range.start), to: toV2End(range.end) };

  const [posts, followersTL] = await Promise.all([
    safeGet(client, '/stats/facebook/posts', v1p),
    safeGet(client, '/v2/analytics/timelines', {
      ...v2p, network: 'facebook', subject: 'account', metric: 'followers',
    }),
  ]);

  const arr = Array.isArray(posts) ? posts : [];
  const sorted = [...arr].sort((a, b) => (b.engagement || 0) - (a.engagement || 0));

  const tlValues = followersTL?.data?.[0]?.values || [];
  const currentFollowers = tlValues.length ? tlValues[tlValues.length - 1]?.value : null;
  const startFollowers   = tlValues.length ? tlValues[0]?.value : null;

  return {
    platform: 'facebook',
    posts: arr,
    topEngagement: sorted.slice(0, 3),
    totalReach: arr.reduce((s, p) => s + (p.reach || 0), 0),
    avgEngagementRate: arr.length
      ? arr.reduce((s, p) => s + (p.engagement || 0), 0) / arr.length
      : null,
    currentFollowers,
    followerGrowth: currentFollowers !== null && startFollowers !== null
      ? currentFollowers - startFollowers : null,
    postsCount: arr.length,
  };
}

async function fetchTikTokData(client, userId, blogId, range) {
  const base = { userId, blogId };
  const v2p = { ...base, from: toV2Start(range.start), to: toV2End(range.end) };

  const [posts, followersTL] = await Promise.all([
    safeGet(client, '/v2/analytics/posts/tiktok', v2p),
    safeGet(client, '/v2/analytics/timelines', {
      ...v2p, network: 'tiktok', subject: 'account', metric: 'followers',
    }),
  ]);

  const arr = Array.isArray(posts?.data) ? posts.data : (Array.isArray(posts) ? posts : []);
  const sortedViews  = [...arr].sort((a, b) => (b.views || b.videoViews || 0) - (a.views || a.videoViews || 0));
  const sortedEngage = [...arr].sort((a, b) => (b.engagement || 0) - (a.engagement || 0));

  const tlValues = followersTL?.data?.[0]?.values || [];
  const currentFollowers = tlValues.length ? tlValues[tlValues.length - 1]?.value : null;
  const startFollowers   = tlValues.length ? tlValues[0]?.value : null;

  return {
    platform: 'tiktok',
    posts: arr,
    topViews: sortedViews.slice(0, 3),
    topEngagement: sortedEngage.slice(0, 3),
    totalViews: arr.reduce((s, p) => s + (p.views || p.videoViews || 0), 0),
    avgEngagementRate: arr.length
      ? arr.reduce((s, p) => s + (p.engagement || 0), 0) / arr.length
      : null,
    currentFollowers,
    followerGrowth: currentFollowers !== null && startFollowers !== null
      ? currentFollowers - startFollowers : null,
    postsCount: arr.length,
  };
}

async function fetchYouTubeData(client, userId, blogId, range) {
  const base = { userId, blogId };
  const v2p = { ...base, from: toV2Start(range.start), to: toV2End(range.end), postsType: 'publishedInRange' };

  const [posts, followersTL] = await Promise.all([
    safeGet(client, '/v2/analytics/posts/youtube', v2p),
    safeGet(client, '/v2/analytics/timelines', {
      ...base,
      from: toV2Start(range.start), to: toV2End(range.end),
      network: 'youtube', subject: 'account', metric: 'followers',
    }),
  ]);

  const arr = Array.isArray(posts?.data) ? posts.data : (Array.isArray(posts) ? posts : []);
  const sortedViews = [...arr].sort((a, b) => (b.views || 0) - (a.views || 0));

  const tlValues = followersTL?.data?.[0]?.values || [];
  const currentSubs = tlValues.length ? tlValues[tlValues.length - 1]?.value : null;
  const startSubs   = tlValues.length ? tlValues[0]?.value : null;

  return {
    platform: 'youtube',
    posts: arr,
    topViews: sortedViews.slice(0, 3),
    totalViews: arr.reduce((s, p) => s + (p.views || 0), 0),
    totalWatchTimeSeconds: arr.reduce((s, p) => s + (p.averageViewDuration || p.watchTime || 0), 0),
    currentSubscribers: currentSubs,
    subscriberGrowth: currentSubs !== null && startSubs !== null ? currentSubs - startSubs : null,
    postsCount: arr.length,
  };
}

// ─── Main Data Builder ────────────────────────────────────────────────────────

async function buildSocialData() {
  const { client, userId } = metricool();
  const range = previousWeekRange();

  console.log(`[Social] Generando reporte semanal: ${range.start} → ${range.end}`);

  // Resolve brand blogIds
  const brands = await resolveBlogIds();

  const results = {};

  for (const brandConfig of BRANDS_CONFIG) {
    const brand = brands[brandConfig.key];
    if (!brand?.blogId) {
      console.warn(`[Social] Saltando "${brand.name}" — sin blogId`);
      results[brand.key] = { ...brand, platforms: {}, error: 'No blogId found' };
      continue;
    }

    console.log(`[Social] Fetching "${brand.name}" (blogId=${brand.blogId})...`);
    const platformData = {};

    const fetchers = [];
    if (brand.platforms.includes('instagram')) fetchers.push(
      fetchInstagramData(client, userId, brand.blogId, range).then((d) => { platformData.instagram = d; })
    );
    if (brand.platforms.includes('facebook')) fetchers.push(
      fetchFacebookData(client, userId, brand.blogId, range).then((d) => { platformData.facebook = d; })
    );
    if (brand.platforms.includes('tiktok')) fetchers.push(
      fetchTikTokData(client, userId, brand.blogId, range).then((d) => { platformData.tiktok = d; })
    );
    if (brand.platforms.includes('youtube')) fetchers.push(
      fetchYouTubeData(client, userId, brand.blogId, range).then((d) => { platformData.youtube = d; })
    );

    await Promise.all(fetchers);
    results[brand.key] = { ...brand, platforms: platformData };

    const totalPosts = Object.values(platformData).reduce((s, p) => s + (p?.postsCount || 0), 0);
    const totalFollowerGrowth = Object.values(platformData).reduce((s, p) => s + (p?.followerGrowth || p?.subscriberGrowth || 0), 0);
    console.log(`[Social]   → ${totalPosts} posts, +${totalFollowerGrowth} seguidores`);
  }

  // Cross-brand comparisons
  const comparisons = buildComparisons(results);

  // AI analysis
  const aiText = await generateSocialAI(results, range);

  return { range, brands: results, comparisons, aiText };
}

// ─── Cross-Brand Comparisons ──────────────────────────────────────────────────

function buildComparisons(results) {
  const brandKeys = Object.keys(results);
  const metrics = {};

  for (const key of brandKeys) {
    const brand = results[key];
    const pf = brand.platforms || {};
    metrics[key] = {
      name: brand.name,
      totalFollowerGrowth: Object.values(pf).reduce((s, p) =>
        s + (p?.followerGrowth ?? p?.subscriberGrowth ?? 0), 0),
      totalReach: (pf.instagram?.totalReach || 0) + (pf.facebook?.totalReach || 0),
      totalViews: (pf.tiktok?.totalViews || 0) + (pf.youtube?.totalViews || 0),
      avgEngagementRate: (() => {
        const rates = [
          pf.instagram?.avgEngagementRate,
          pf.facebook?.avgEngagementRate,
          pf.tiktok?.avgEngagementRate,
        ].filter((r) => r !== null && r !== undefined);
        return rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : null;
      })(),
      totalPosts: Object.values(pf).reduce((s, p) => s + (p?.postsCount || 0), 0),
    };
  }

  const best = (fn) => {
    let bestKey = null, bestVal = -Infinity;
    for (const key of brandKeys) {
      const v = fn(metrics[key]);
      if (v !== null && v > bestVal) { bestVal = v; bestKey = key; }
    }
    return { key: bestKey, name: bestKey ? results[bestKey].name : '—', value: bestVal };
  };

  // Best single post/video across all brands
  let bestPost = null;
  for (const key of brandKeys) {
    const pf = results[key].platforms || {};
    const topIG   = pf.instagram?.topViews?.[0];
    const topTT   = pf.tiktok?.topViews?.[0];
    const topYT   = pf.youtube?.topViews?.[0];
    for (const [post, platform] of [[topIG, 'Instagram'], [topTT, 'TikTok'], [topYT, 'YouTube']]) {
      if (!post) continue;
      const views = post.views || post.videoViews || post.reach || 0;
      if (!bestPost || views > bestPost.views) {
        bestPost = { ...post, views, platform, brandName: results[key].name };
      }
    }
  }

  return {
    mostFollowerGrowth: best((m) => m.totalFollowerGrowth),
    mostReach:          best((m) => m.totalReach),
    bestEngagement:     best((m) => m.avgEngagementRate),
    mostViews:          best((m) => m.totalViews),
    bestPost,
    metrics,
  };
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────

async function generateSocialAI(results, range) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const summary = BRANDS_CONFIG.map((bc) => {
      const b = results[bc.key];
      const pf = b?.platforms || {};
      return `${b.name}:
  Instagram: ${pf.instagram?.postsCount || 0} posts, reach ${fmtNum(pf.instagram?.totalReach)}, eng ${fmtPct(pf.instagram?.avgEngagementRate)}, +${pf.instagram?.followerGrowth ?? 0} seguidores
  TikTok: ${pf.tiktok?.postsCount || 0} videos, ${fmtNum(pf.tiktok?.totalViews)} vistas, +${pf.tiktok?.followerGrowth ?? 0} seguidores
  Facebook: ${pf.facebook?.postsCount || 0} posts, reach ${fmtNum(pf.facebook?.totalReach)}
  YouTube: ${pf.youtube?.postsCount || 0} videos, ${fmtNum(pf.youtube?.totalViews)} vistas`;
    }).join('\n\n');

    const { content } = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Eres un estratega experto en redes sociales para JP Legacy Group. Analiza los datos de la semana ${range.start} al ${range.end}:

${summary}

Proporciona en español (máximo 550 tokens):
1. Qué tipo de contenido está funcionando mejor y en qué plataforma
2. Diferencias clave entre las 3 marcas (JP Legacy, Paola, Jorge)
3. Qué plataforma merece más inversión de tiempo esta semana
4. 1-2 observaciones sobre tendencias de audiencia
5. 5 recomendaciones concretas de contenido para la próxima semana (con día y hora sugerida)

Sé directo, específico y accionable. Sin introducción larga.`,
      }],
    });
    return content[0]?.text || null;
  } catch (e) {
    console.warn('[Social] AI analysis error:', e.message);
    return null;
  }
}

// ─── HTML Builders ────────────────────────────────────────────────────────────

function htmlWrap(body, range) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>JP Legacy — Redes Sociales</title></head>
<body style="margin:0;padding:0;background:#000;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#000000">
<tr><td align="center" style="padding:24px 12px;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

  <!-- HEADER -->
  <tr><td style="padding:28px 0 18px;text-align:center;border-bottom:2px solid #C9A84C;">
    <div style="color:#C9A84C;font-size:26px;font-weight:bold;letter-spacing:4px;font-family:Arial,sans-serif;">JP LEGACY GROUP</div>
    <div style="color:#888;font-size:11px;letter-spacing:2px;margin-top:8px;font-family:Arial,sans-serif;">
      REPORTE SEMANAL DE REDES SOCIALES &nbsp;·&nbsp; ${shortDate(range.start)} al ${shortDate(range.end)}
    </div>
  </td></tr>
  <tr><td style="height:18px;"></td></tr>

  ${body}

  <!-- FOOTER -->
  <tr><td style="height:20px;"></td></tr>
  <tr><td style="text-align:center;padding:14px 0;border-top:1px solid #1A1A1A;">
    <span style="color:#333;font-size:10px;font-family:Arial,sans-serif;">
      JP Legacy Agent · Datos vía Metricool API · America/New_York
    </span>
  </td></tr>

</table></td></tr></table>
</body></html>`;
}

function statBox(label, value, color) {
  return `<td style="padding:14px 8px;text-align:center;">
    <div style="color:${color || '#C9A84C'};font-size:24px;font-weight:bold;font-family:Arial,sans-serif;">${value}</div>
    <div style="color:#555;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">${label}</div>
  </td>`;
}

function divider() {
  return `<tr><td style="height:1px;background:#1A1A1A;padding:0;"></td></tr><tr><td style="height:14px;"></td></tr>`;
}

function platformHeader(platform) {
  return `<tr><td style="padding:8px 14px;background:#111;border-top:1px solid #1A1A1A;">
    <span style="color:${PLATFORM_COLORS[platform] || '#888'};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">
      ${PLATFORM_ICONS[platform]} ${platform.toUpperCase()}
    </span>
  </td></tr>`;
}

function followerRow(label, current, growth) {
  const growthStr = growth !== null && growth !== undefined
    ? `<span style="color:${growth >= 0 ? '#4CAF50' : '#FF4444'};font-size:11px;font-family:Arial,sans-serif;margin-left:8px;">${growth >= 0 ? '+' : ''}${fmtNum(growth)} esta semana</span>`
    : '';
  return `<tr><td style="padding:6px 14px;border-bottom:1px solid #0A0A0A;">
    <span style="color:#888;font-size:11px;font-family:Arial,sans-serif;">${label}: </span>
    <span style="color:#FFF;font-size:13px;font-weight:bold;font-family:Arial,sans-serif;">${fmtNum(current)}</span>
    ${growthStr}
  </td></tr>`;
}

function metricsRowInline(items) {
  const cells = items.map(([label, value, color]) =>
    `<td style="padding:6px 14px;text-align:center;border-right:1px solid #111;">
      <div style="color:${color || '#888'};font-size:13px;font-weight:bold;font-family:Arial,sans-serif;">${value}</div>
      <div style="color:#444;font-size:9px;font-family:Arial,sans-serif;">${label}</div>
    </td>`
  ).join('');
  return `<tr><td style="padding:4px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;"><tr>${cells}</tr></table>
  </td></tr>`;
}

function topPostsSection(title, posts, viewKey = 'views') {
  if (!posts || posts.length === 0) return '';
  const rows = posts.map((p, i) => {
    const text = (p.text || p.title || p.description || '(sin título)').slice(0, 55);
    const views = fmtNum(p[viewKey] || p.videoViews || p.reach || p.views || 0);
    const likes = fmtNum(p.likes || p.reactions || 0);
    const comments = fmtNum(p.comments || 0);
    const shares = fmtNum(p.shares || 0);
    const medals = ['🥇','🥈','🥉'];
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #0D0D0D;background:#080808;">
        <div style="font-family:Arial,sans-serif;">
          <span style="font-size:12px;">${medals[i] || '▸'}</span>
          <span style="color:#CCC;font-size:11px;margin-left:4px;">${text}${text.length >= 55 ? '…' : ''}</span>
        </div>
        <div style="color:#444;font-size:10px;font-family:Arial,sans-serif;margin-top:2px;">
          👁 ${views} &nbsp;·&nbsp; ❤️ ${likes} &nbsp;·&nbsp; 💬 ${comments} &nbsp;·&nbsp; ↗️ ${shares}
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<tr><td style="padding:4px 14px 2px;background:#050505;">
    <span style="color:#555;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;">${title}</span>
  </td></tr>${rows}`;
}

function instagramSection(data) {
  if (!data) return `<tr><td style="padding:8px 14px;color:#333;font-size:11px;font-family:Arial,sans-serif;font-style:italic;">Sin datos de Instagram</td></tr>`;
  return `
    ${platformHeader('instagram')}
    ${followerRow('Seguidores', data.currentFollowers, data.followerGrowth)}
    ${metricsRowInline([
      ['Alcance', fmtNum(data.totalReach), '#C9A84C'],
      ['Impresiones', fmtNum(data.totalImpressions), '#888'],
      ['Eng Rate', fmtPct(data.avgEngagementRate), '#4CAF50'],
      ['Posts', data.postsCount, '#4FC3F7'],
    ])}
    ${topPostsSection('🏆 Top Reels / Posts por Engagement', data.topEngagement)}
    ${topPostsSection('👁 Top Posts por Vistas / Alcance', data.topViews, 'reach')}
  `;
}

function facebookSection(data) {
  if (!data) return `<tr><td style="padding:8px 14px;color:#333;font-size:11px;font-family:Arial,sans-serif;font-style:italic;">Sin datos de Facebook</td></tr>`;
  return `
    ${platformHeader('facebook')}
    ${followerRow('Seguidores', data.currentFollowers, data.followerGrowth)}
    ${metricsRowInline([
      ['Alcance', fmtNum(data.totalReach), '#C9A84C'],
      ['Eng Rate', fmtPct(data.avgEngagementRate), '#4CAF50'],
      ['Posts', data.postsCount, '#4FC3F7'],
    ])}
    ${topPostsSection('🏆 Top Posts por Engagement', data.topEngagement)}
  `;
}

function tiktokSection(data) {
  if (!data) return `<tr><td style="padding:8px 14px;color:#333;font-size:11px;font-family:Arial,sans-serif;font-style:italic;">Sin datos de TikTok</td></tr>`;
  return `
    ${platformHeader('tiktok')}
    ${followerRow('Seguidores', data.currentFollowers, data.followerGrowth)}
    ${metricsRowInline([
      ['Vistas totales', fmtNum(data.totalViews), '#C9A84C'],
      ['Eng Rate', fmtPct(data.avgEngagementRate), '#4CAF50'],
      ['Videos', data.postsCount, '#4FC3F7'],
    ])}
    ${topPostsSection('🏆 Top Videos por Vistas', data.topViews, 'videoViews')}
  `;
}

function youtubeSection(data) {
  if (!data) return `<tr><td style="padding:8px 14px;color:#333;font-size:11px;font-family:Arial,sans-serif;font-style:italic;">Sin datos de YouTube</td></tr>`;
  const watchH = data.totalWatchTimeSeconds ? Math.round(data.totalWatchTimeSeconds / 3600) : null;
  return `
    ${platformHeader('youtube')}
    ${followerRow('Suscriptores', data.currentSubscribers, data.subscriberGrowth)}
    ${metricsRowInline([
      ['Vistas', fmtNum(data.totalViews), '#C9A84C'],
      ['Watch Time', watchH !== null ? `${watchH}h` : '—', '#FF6B35'],
      ['Videos', data.postsCount, '#4FC3F7'],
    ])}
    ${topPostsSection('🏆 Top Videos por Vistas', data.topViews, 'views')}
  `;
}

function brandSection(brand) {
  const pf = brand.platforms || {};
  const totalGrowth = Object.values(pf).reduce((s, p) =>
    s + (p?.followerGrowth ?? p?.subscriberGrowth ?? 0), 0);
  const totalPosts = Object.values(pf).reduce((s, p) => s + (p?.postsCount || 0), 0);
  const totalReach = (pf.instagram?.totalReach || 0) + (pf.facebook?.totalReach || 0);

  const errorNote = brand.error
    ? `<tr><td style="padding:10px 14px;color:#FF4444;font-size:11px;font-family:Arial,sans-serif;">⚠️ ${brand.error} — Configura METRICOOL_BLOG_ID_${brand.key.toUpperCase()} en Railway</td></tr>`
    : '';

  return `
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">

    <!-- Brand Header -->
    <tr><td style="padding:14px 16px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:${brand.color};font-size:14px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">
        ${brand.icon} ${brand.name}
      </span>
    </td></tr>

    <!-- Quick stats -->
    <tr><td style="border-bottom:1px solid #141414;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          ${statBox('Nuevos seguidores', `${totalGrowth >= 0 ? '+' : ''}${fmtNum(totalGrowth)}`, totalGrowth >= 0 ? '#4CAF50' : '#FF4444')}
          ${statBox('Posts publicados', totalPosts, '#4FC3F7')}
          ${statBox('Alcance total', fmtNum(totalReach), '#C9A84C')}
        </tr>
      </table>
    </td></tr>

    ${errorNote}
    ${pf.instagram ? instagramSection(pf.instagram) : ''}
    ${pf.facebook  ? facebookSection(pf.facebook)   : ''}
    ${pf.tiktok    ? tiktokSection(pf.tiktok)        : ''}
    ${pf.youtube   ? youtubeSection(pf.youtube)      : ''}

  </table>
  </td></tr>
  <tr><td style="height:14px;"></td></tr>`;
}

function comparisonsSection(cmp, results) {
  const cmpRow = (label, key, fmt) => {
    const m = cmp.metrics;
    const sorted = Object.keys(m).sort((a, b) => (m[b][key] || 0) - (m[a][key] || 0));
    return `<tr>
      <td style="padding:6px 14px;border-bottom:1px solid #0A0A0A;color:#888;font-size:11px;font-family:Arial,sans-serif;width:35%;">${label}</td>
      ${sorted.map((k, i) => `<td style="padding:6px 8px;border-bottom:1px solid #0A0A0A;text-align:center;background:${i === 0 ? '#0A1A0A' : '#050505'};">
        <div style="color:${i === 0 ? '#4CAF50' : '#555'};font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${fmt(m[k][key])}</div>
        <div style="color:#333;font-size:9px;font-family:Arial,sans-serif;">${results[k].name.split(' ')[0]}</div>
      </td>`).join('')}
    </tr>`;
  };

  const bestPost = cmp.bestPost;
  const bestPostHtml = bestPost ? `
    <tr><td colspan="4" style="padding:10px 14px;background:#0A1A0A;border-top:1px solid #141414;">
      <span style="color:#C9A84C;font-size:10px;font-weight:bold;letter-spacing:1px;font-family:Arial,sans-serif;">🏆 MEJOR CONTENIDO DE LA SEMANA</span><br>
      <span style="color:#FFF;font-size:12px;font-family:Arial,sans-serif;">${(bestPost.text || bestPost.title || '(sin título)').slice(0, 60)}…</span><br>
      <span style="color:#888;font-size:10px;font-family:Arial,sans-serif;">${bestPost.brandName} · ${bestPost.platform} · ${fmtNum(bestPost.views)} vistas</span>
    </td></tr>` : '';

  return `
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1E1E1E;border-radius:8px;overflow:hidden;">
    <tr><td colspan="4" style="padding:12px 14px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:#C9A84C;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">⚡ Comparativo 3 Marcas</span>
    </td></tr>
    ${cmpRow('Nuevos seguidores', 'totalFollowerGrowth', (v) => `+${fmtNum(v || 0)}`)}
    ${cmpRow('Alcance total', 'totalReach', fmtNum)}
    ${cmpRow('Vistas (TikTok + YT)', 'totalViews', fmtNum)}
    ${cmpRow('Engagement rate prom', 'avgEngagementRate', fmtPct)}
    ${cmpRow('Total posts', 'totalPosts', (v) => v || 0)}
    ${bestPostHtml}
  </table>
  </td></tr>
  <tr><td style="height:14px;"></td></tr>`;
}

function aiSection(aiText) {
  if (!aiText) return '';
  const formatted = aiText
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#C9A84C;">$1</strong>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');

  return `
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#080808;border:1px solid #1A1A1A;border-radius:8px;overflow:hidden;">
    <tr><td style="padding:10px 14px;background:#0D0D0D;border-bottom:1px solid #1A1A1A;">
      <span style="color:#C9A84C;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">🤖 Análisis Claude AI</span>
    </td></tr>
    <tr><td style="padding:14px;color:#CCCCCC;font-size:12px;line-height:1.7;font-family:Arial,sans-serif;">${formatted}</td></tr>
  </table>
  </td></tr>`;
}

function executiveSummary(brands, range) {
  let totalGrowth = 0, totalReach = 0, totalPosts = 0;
  let bestGrowthName = '—', bestGrowthVal = -Infinity;
  let bestReachName = '—', bestReachVal = -Infinity;

  for (const bc of BRANDS_CONFIG) {
    const b = brands[bc.key];
    const pf = b?.platforms || {};
    const growth = Object.values(pf).reduce((s, p) => s + (p?.followerGrowth ?? p?.subscriberGrowth ?? 0), 0);
    const reach  = (pf.instagram?.totalReach || 0) + (pf.facebook?.totalReach || 0);
    const posts  = Object.values(pf).reduce((s, p) => s + (p?.postsCount || 0), 0);
    totalGrowth += growth;
    totalReach  += reach;
    totalPosts  += posts;
    if (growth > bestGrowthVal) { bestGrowthVal = growth; bestGrowthName = b.name; }
    if (reach  > bestReachVal)  { bestReachVal = reach;   bestReachName = b.name; }
  }

  return `
  <tr><td>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #2A2A2A;border-radius:8px;overflow:hidden;">
    <tr><td colspan="4" style="padding:10px 14px;border-bottom:1px solid #1A1A1A;">
      <span style="color:#C9A84C;font-size:10px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">📊 Resumen Ejecutivo</span>
    </td></tr>
    <tr>
      ${statBox('Nuevos seguidores', `+${fmtNum(totalGrowth)}`, '#4CAF50')}
      ${statBox('Alcance combinado', fmtNum(totalReach), '#C9A84C')}
      ${statBox('Posts publicados', totalPosts, '#4FC3F7')}
    </tr>
    <tr>
      <td colspan="3" style="padding:8px 14px;border-top:1px solid #141414;">
        <span style="color:#555;font-size:10px;font-family:Arial,sans-serif;">Mayor crecimiento: <strong style="color:#4CAF50;">${bestGrowthName}</strong></span>
        &nbsp;·&nbsp;
        <span style="color:#555;font-size:10px;font-family:Arial,sans-serif;">Mayor alcance: <strong style="color:#C9A84C;">${bestReachName}</strong></span>
      </td>
    </tr>
  </table>
  </td></tr>
  <tr><td style="height:14px;"></td></tr>`;
}

// ─── Main HTML Builder ────────────────────────────────────────────────────────

function buildSocialHTML(data) {
  const { range, brands, comparisons, aiText } = data;

  const body = `
    ${executiveSummary(brands, range)}
    ${BRANDS_CONFIG.map((bc) => brandSection(brands[bc.key])).join('')}
    ${divider()}
    ${comparisonsSection(comparisons, brands)}
    ${aiSection(aiText)}
  `;

  return htmlWrap(body, range);
}

// ─── Send Email ───────────────────────────────────────────────────────────────

async function sendSocialReport() {
  console.log('[Social] Iniciando reporte semanal de redes...');
  const data   = await buildSocialData();
  const html   = buildSocialHTML(data);
  const { range } = data;

  const subject = `JP Legacy — Reporte Semanal de Redes · Semana del ${shortDate(range.start)} al ${shortDate(range.end)}`;

  if (!process.env.RESEND_API_KEY) {
    console.warn('[Social] RESEND_API_KEY no configurado — email no enviado');
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

// ─── Cron Scheduler ──────────────────────────────────────────────────────────
// Lunes 9:00am ET (14:00 UTC)

function startSocialReport() {
  cron.schedule('0 14 * * 1', async () => {
    console.log('[Social] Cron: disparando reporte semanal de redes...');
    try {
      await sendSocialReport();
    } catch (err) {
      console.error('[Social] Error en reporte de redes:', err.message);
    }
  });

  console.log('[Cron] ✅ Social Weekly:  0 14 * * 1    → 9:00am ET lunes');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { startSocialReport, sendSocialReport, buildSocialData };
