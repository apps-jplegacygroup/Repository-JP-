const cron = require('node-cron');
const { Resend } = require('resend');
const { fetchProjectTasks, getCustomField } = require('./asana');

const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000; // UTC-5, sin DST

const TEAM = ['Nicole Zapata', 'Karen'];

const TIPO_LABELS = ['Diseño', 'Video', 'Administrativo', 'Meeting'];

const RECIPIENTS = [
  'jorgeflorez@jplegacygroup.com',
  'paoladiaz@jplegacygroup.com',
  'marketing@jplegacygroup.com',
  'karen@getvau.com',
];

const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ─── Fecha helpers (America/Bogota = UTC-5 fijo) ────────────────────────────

function bogotaDate(jsDate) {
  return new Date(jsDate.getTime() + BOGOTA_OFFSET_MS);
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function todayBogota() {
  return dateKey(bogotaDate(new Date()));
}

// Lunes de la semana actual en Bogota
function weekStartBogota() {
  const bog = bogotaDate(new Date());
  const day = bog.getUTCDay(); // 0=Dom
  const monday = new Date(bog);
  monday.setUTCDate(bog.getUTCDate() - (day === 0 ? 6 : day - 1));
  return dateKey(monday);
}

function formatBogotaDate(isoDateStr) {
  if (!isoDateStr) return '—';
  const [year, month, day] = isoDateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${DAYS_ES[d.getUTCDay()]} ${day} de ${MONTHS_ES[month - 1]}`;
}

function formatSpanishDate(isoDateStr) {
  const [year, month, day] = isoDateStr.split('-').map(Number);
  return `${DAYS_ES[new Date(year, month - 1, day).getDay()]} ${day} de ${MONTHS_ES[month - 1]}`;
}

// ─── Effort level → número ───────────────────────────────────────────────────

const EFFORT_MAP = {
  'muy bajo': 1, 'very low': 1, '1': 1,
  'bajo': 2, 'low': 2, '2': 2,
  'medio': 3, 'medium': 3, 'normal': 3, '3': 3,
  'alto': 4, 'high': 4, '4': 4,
  'muy alto': 5, 'very high': 5, '5': 5,
};

function parseEffort(val) {
  if (!val) return null;
  const n = parseFloat(val);
  if (!isNaN(n)) return n;
  return EFFORT_MAP[val.toLowerCase().trim()] || null;
}

// ─── Normalizar tipo ─────────────────────────────────────────────────────────

function normalizeTipo(val) {
  if (!val) return 'Otros';
  const v = val.trim();
  for (const label of TIPO_LABELS) {
    if (v.toLowerCase() === label.toLowerCase()) return label;
  }
  return 'Otros';
}

// ─── Construir datos del reporte ─────────────────────────────────────────────

async function buildMarketingReport() {
  const projectId = process.env.ASANA_PROJECT_ID;
  if (!projectId) throw new Error('ASANA_PROJECT_ID no configurado');

  const today = todayBogota();
  const weekStart = weekStartBogota();

  const rawTasks = await fetchProjectTasks(projectId);
  console.log(`[Marketing] Tareas obtenidas de Asana: ${rawTasks.length}`);

  // Normalizar tareas
  const tasks = rawTasks.map((t) => {
    const completedAt = t.completed_at
      ? dateKey(bogotaDate(new Date(t.completed_at)))
      : null;

    return {
      name: t.name || '(sin nombre)',
      assignee: t.assignee ? t.assignee.name : 'Sin asignar',
      dueDate: t.due_on || null,
      startDate: t.start_on || getCustomField(t, 'Fecha de inicio') || null,
      endDate: getCustomField(t, 'Fecha de fin') || t.due_on || null,
      prioridad: getCustomField(t, 'Prioridad') || '—',
      estado: getCustomField(t, 'Estado') || '—',
      effortRaw: getCustomField(t, 'Effort level'),
      tipo: normalizeTipo(getCustomField(t, 'Tipo')),
      completed: t.completed || false,
      completedDate: completedAt,
    };
  });

  // Agrupar por colaboradora (incluye "Sin asignar" y otros)
  const assignees = new Set(tasks.map((t) => t.assignee));
  // Poner primero las del equipo definido
  const orderedAssignees = [
    ...TEAM.filter((m) => assignees.has(m)),
    ...[...assignees].filter((a) => !TEAM.includes(a)),
  ];

  const byAssignee = {};
  for (const a of orderedAssignees) {
    const mine = tasks.filter((t) => t.assignee === a);

    const completedToday = mine.filter((t) => t.completed && t.completedDate === today);
    const completedWeek  = mine.filter((t) => t.completed && t.completedDate >= weekStart);
    const pending        = mine.filter((t) => !t.completed);
    const overdue        = pending.filter((t) => t.dueDate && t.dueDate < today);

    // Distribución por tipo (solo pendientes + completadas)
    const tipoCount = {};
    for (const tipo of [...TIPO_LABELS, 'Otros']) tipoCount[tipo] = 0;
    mine.forEach((t) => { tipoCount[t.tipo] = (tipoCount[t.tipo] || 0) + 1; });

    // Effort promedio (solo tareas con valor)
    const efforts = mine.map((t) => parseEffort(t.effortRaw)).filter((n) => n !== null);
    const avgEffort = efforts.length > 0
      ? (efforts.reduce((s, n) => s + n, 0) / efforts.length).toFixed(1)
      : null;

    byAssignee[a] = { completedToday, completedWeek, pending, overdue, tipoCount, avgEffort, total: mine.length };
  }

  return { today, weekStart, byAssignee, orderedAssignees, totalTasks: tasks.length };
}

// ─── HTML del reporte ────────────────────────────────────────────────────────

function buildMarketingHTML(data) {
  const { today, byAssignee, orderedAssignees, totalTasks } = data;
  const formattedToday = formatSpanishDate(today);

  const TIPO_ICONS = { Diseño: '🎨', Video: '🎬', Administrativo: '📋', Meeting: '📅', Otros: '📌' };

  const assigneeSections = orderedAssignees.map((assignee) => {
    const d = byAssignee[assignee];
    const isTeam = TEAM.includes(assignee);
    const headerColor = isTeam ? '#C9A84C' : '#888888';

    // Tareas vencidas
    const overdueRows = d.overdue.length > 0
      ? d.overdue.map((t) => `
        <tr>
          <td style="padding:8px 12px;background:#1A0800;border-bottom:1px solid #2A1A0A;color:#FF6B35;font-size:13px;font-family:Arial,sans-serif;">
            ⚠️ ${t.name}
          </td>
          <td style="padding:8px 12px;background:#1A0800;border-bottom:1px solid #2A1A0A;color:#FF6B35;font-size:12px;font-family:Arial,sans-serif;white-space:nowrap;">
            ${formatBogotaDate(t.dueDate)}
          </td>
          <td style="padding:8px 12px;background:#1A0800;border-bottom:1px solid #2A1A0A;color:#888888;font-size:12px;font-family:Arial,sans-serif;">
            ${t.prioridad}
          </td>
        </tr>`).join('')
      : '';

    // Tareas pendientes (no vencidas)
    const pendingNotOverdue = d.pending.filter((t) => !t.dueDate || t.dueDate >= today);
    const pendingRows = pendingNotOverdue.slice(0, 10).map((t) => `
      <tr>
        <td style="padding:8px 12px;background:#111111;border-bottom:1px solid #1E1E1E;color:#FFFFFF;font-size:13px;font-family:Arial,sans-serif;">
          ${t.name}
        </td>
        <td style="padding:8px 12px;background:#111111;border-bottom:1px solid #1E1E1E;color:#888888;font-size:12px;font-family:Arial,sans-serif;white-space:nowrap;">
          ${t.dueDate ? formatBogotaDate(t.dueDate) : '—'}
        </td>
        <td style="padding:8px 12px;background:#111111;border-bottom:1px solid #1E1E1E;color:#888888;font-size:12px;font-family:Arial,sans-serif;">
          ${t.prioridad}
        </td>
      </tr>`).join('');

    const morePending = pendingNotOverdue.length > 10
      ? `<tr><td colspan="3" style="padding:8px 12px;background:#111111;color:#555555;font-size:11px;font-family:Arial,sans-serif;text-align:center;">
          + ${pendingNotOverdue.length - 10} tareas más pendientes
        </td></tr>`
      : '';

    // Distribución de tipos
    const tipoItems = Object.entries(d.tipoCount)
      .filter(([, count]) => count > 0)
      .map(([tipo, count]) => {
        const icon = TIPO_ICONS[tipo] || '📌';
        return `<td style="padding:8px;text-align:center;">
          <div style="color:#C9A84C;font-size:18px;">${icon}</div>
          <div style="color:#FFFFFF;font-size:16px;font-weight:bold;font-family:Arial,sans-serif;">${count}</div>
          <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">${tipo.toUpperCase()}</div>
        </td>`;
      }).join('');

    return `
    <!-- COLABORADORA: ${assignee} -->
    <tr><td style="padding-top:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;overflow:hidden;">

        <!-- Header colaboradora -->
        <tr><td style="padding:14px 18px;border-bottom:1px solid #2A2A2A;">
          <span style="color:${headerColor};font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">
            👤 ${assignee}
          </span>
          <span style="color:#555555;font-size:11px;font-family:Arial,sans-serif;margin-left:12px;">
            ${d.total} tareas totales
          </span>
          ${d.avgEffort ? `<span style="color:#888888;font-size:11px;font-family:Arial,sans-serif;margin-left:12px;">· Esfuerzo prom: <strong style="color:#C9A84C;">${d.avgEffort}/5</strong></span>` : ''}
        </td></tr>

        <!-- Stats rápidos -->
        <tr><td style="padding:14px 18px;border-bottom:1px solid #2A2A2A;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="25%" align="center">
                <div style="color:#4FC3F7;font-size:28px;font-weight:bold;font-family:Arial,sans-serif;">${d.completedToday.length}</div>
                <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">COMPLETADAS HOY</div>
              </td>
              <td width="25%" align="center" style="border-left:1px solid #222222;">
                <div style="color:#4CAF50;font-size:28px;font-weight:bold;font-family:Arial,sans-serif;">${d.completedWeek.length}</div>
                <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">ESTA SEMANA</div>
              </td>
              <td width="25%" align="center" style="border-left:1px solid #222222;">
                <div style="color:#FFD700;font-size:28px;font-weight:bold;font-family:Arial,sans-serif;">${d.pending.length}</div>
                <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">PENDIENTES</div>
              </td>
              <td width="25%" align="center" style="border-left:1px solid #222222;">
                <div style="color:${d.overdue.length > 0 ? '#FF6B35' : '#555555'};font-size:28px;font-weight:bold;font-family:Arial,sans-serif;">${d.overdue.length}</div>
                <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">VENCIDAS</div>
              </td>
            </tr>
          </table>
        </td></tr>

        ${d.overdue.length > 0 ? `
        <!-- Tareas vencidas -->
        <tr><td>
          <div style="padding:10px 18px 6px;color:#FF6B35;font-size:10px;letter-spacing:2px;font-family:Arial,sans-serif;">TAREAS VENCIDAS</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:6px 12px;font-size:10px;color:#333333;font-family:Arial,sans-serif;border-bottom:1px solid #1A1A1A;">TAREA</td>
              <td style="padding:6px 12px;font-size:10px;color:#333333;font-family:Arial,sans-serif;border-bottom:1px solid #1A1A1A;">VENCÍA</td>
              <td style="padding:6px 12px;font-size:10px;color:#333333;font-family:Arial,sans-serif;border-bottom:1px solid #1A1A1A;">PRIORIDAD</td>
            </tr>
            ${overdueRows}
          </table>
        </td></tr>` : ''}

        ${d.pending.length > 0 ? `
        <!-- Tareas pendientes -->
        <tr><td>
          <div style="padding:10px 18px 6px;color:#888888;font-size:10px;letter-spacing:2px;font-family:Arial,sans-serif;">TAREAS PENDIENTES</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:6px 12px;font-size:10px;color:#333333;font-family:Arial,sans-serif;border-bottom:1px solid #1A1A1A;">TAREA</td>
              <td style="padding:6px 12px;font-size:10px;color:#333333;font-family:Arial,sans-serif;border-bottom:1px solid #1A1A1A;">FECHA LÍMITE</td>
              <td style="padding:6px 12px;font-size:10px;color:#333333;font-family:Arial,sans-serif;border-bottom:1px solid #1A1A1A;">PRIORIDAD</td>
            </tr>
            ${pendingRows}${morePending}
          </table>
        </td></tr>` : ''}

        ${tipoItems ? `
        <!-- Distribución por tipo -->
        <tr><td style="padding:14px 18px;border-top:1px solid #1A1A1A;">
          <div style="color:#555555;font-size:10px;letter-spacing:2px;margin-bottom:10px;font-family:Arial,sans-serif;">DISTRIBUCIÓN POR TIPO</div>
          <table cellpadding="0" cellspacing="0"><tr>${tipoItems}</tr></table>
        </td></tr>` : ''}

      </table>
    </td></tr>
    <tr><td style="height:8px;"></td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>JP Legacy — Reporte Marketing</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#000000">
<tr><td align="center" style="padding:24px 12px;">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

  <!-- HEADER -->
  <tr><td style="padding:28px 0 20px;text-align:center;border-bottom:2px solid #C9A84C;">
    <div style="color:#C9A84C;font-size:28px;font-weight:bold;letter-spacing:4px;font-family:Arial,sans-serif;">JP LEGACY GROUP</div>
    <div style="color:#888888;font-size:11px;letter-spacing:2px;margin-top:8px;text-transform:uppercase;font-family:Arial,sans-serif;">
      Reporte de Marketing &nbsp;—&nbsp; ${formattedToday}
    </div>
  </td></tr>

  <tr><td style="height:20px;"></td></tr>

  <!-- RESUMEN GENERAL -->
  <tr><td style="background:#111111;border:1px solid #2A2A2A;border-radius:8px;padding:16px 20px;">
    <div style="color:#C9A84C;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:10px;">
      Resumen del Equipo
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <div style="color:#FFFFFF;font-size:32px;font-weight:bold;font-family:Arial,sans-serif;">${totalTasks}</div>
          <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">TOTAL TAREAS</div>
        </td>
        <td align="center" style="border-left:1px solid #222222;">
          <div style="color:#4FC3F7;font-size:32px;font-weight:bold;font-family:Arial,sans-serif;">
            ${orderedAssignees.reduce((s, a) => s + byAssignee[a].completedToday.length, 0)}
          </div>
          <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">COMPLETADAS HOY</div>
        </td>
        <td align="center" style="border-left:1px solid #222222;">
          <div style="color:#4CAF50;font-size:32px;font-weight:bold;font-family:Arial,sans-serif;">
            ${orderedAssignees.reduce((s, a) => s + byAssignee[a].completedWeek.length, 0)}
          </div>
          <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">ESTA SEMANA</div>
        </td>
        <td align="center" style="border-left:1px solid #222222;">
          <div style="color:#FF6B35;font-size:32px;font-weight:bold;font-family:Arial,sans-serif;">
            ${orderedAssignees.reduce((s, a) => s + byAssignee[a].overdue.length, 0)}
          </div>
          <div style="color:#555555;font-size:10px;letter-spacing:1px;font-family:Arial,sans-serif;">VENCIDAS</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="height:16px;"></td></tr>

  <!-- SECCIONES POR COLABORADORA -->
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${assigneeSections}
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="height:24px;"></td></tr>
  <tr><td style="text-align:center;padding:16px 0;border-top:1px solid #1A1A1A;">
    <span style="color:#333333;font-size:10px;font-family:Arial,sans-serif;">
      JP Legacy Agent · Reporte generado automáticamente · America/Bogota
    </span>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Enviar email ─────────────────────────────────────────────────────────────

async function sendMarketingReport() {
  console.log('[Marketing] Iniciando reporte de marketing Asana...');

  const data = await buildMarketingReport();
  const html = buildMarketingHTML(data);

  const totalOverdue = data.orderedAssignees.reduce((s, a) => s + data.byAssignee[a].overdue.length, 0);
  const alertFlag = totalOverdue > 0 ? ' ⚠️' : '';
  const subject = `📊 JP Legacy — Reporte Marketing ${data.today}${alertFlag}`;

  if (!process.env.RESEND_API_KEY) {
    console.warn('[Marketing] Email skipped: RESEND_API_KEY no configurado.');
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
  console.log(`[Marketing] Email enviado: ${subject}`);
}

// ─── Cron scheduler ───────────────────────────────────────────────────────────
// 8:00am America/Bogota (UTC-5) = 13:00 UTC → "0 13 * * 1-5" (lunes a viernes)

function startMarketingReport() {
  // Lunes a viernes a las 8am Bogota (13:00 UTC)
  cron.schedule('0 13 * * 1-5', async () => {
    console.log('[Marketing] Cron: disparando reporte de marketing...');
    try {
      await sendMarketingReport();
    } catch (err) {
      console.error('[Marketing] Error en reporte:', err.message);
    }
  });

  console.log('[Cron] ✅ Marketing: 0 13 * * 1-5  → 8:00am Bogota lun-vie');
}

module.exports = { startMarketingReport, sendMarketingReport, buildMarketingReport };
