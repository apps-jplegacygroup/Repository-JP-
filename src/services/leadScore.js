/**
 * Lead Quality Scoring Service
 * Analyzes lead data with Claude AI and assigns a score from 1-10.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Points per criteria (max 9 from AI + 1 structural = 10)
const CRITERIA_POINTS = {
  hasBudget: 2,       // Tiene presupuesto definido
  hasTimeline: 2,     // Tiene timeline claro
  hasPurchaseType: 2, // Especifica cash o financiado
  hasPreApproval: 1,  // Pre-aprobación o habló con banco
  hasLocation: 1,     // Zona o ciudad específica
  isSpanish: 1,       // Idioma español / cliente latino
};

function getLabel(score) {
  if (score >= 8) return 'Lead-Caliente';
  if (score >= 5) return 'Lead-Tibio';
  return 'Lead-Frio';
}

function buildTags(score) {
  return [`Score-${score}`, getLabel(score)];
}

function buildNoteText(score, breakdown, hasEmailAndPhone) {
  const emoji = score >= 8 ? '🔥' : score >= 5 ? '🌡️' : '❄️';
  const lines = [`${emoji} Score: ${score}/10 — ${getLabel(score)}`];
  if (breakdown.hasBudget)       lines.push('✓ Presupuesto definido (+2)');
  if (breakdown.hasTimeline)     lines.push('✓ Timeline claro (+2)');
  if (breakdown.hasPurchaseType) lines.push('✓ Tipo de compra definido (+2)');
  if (breakdown.hasPreApproval)  lines.push('✓ Pre-aprobación bancaria (+1)');
  if (breakdown.hasLocation)     lines.push('✓ Zona o ciudad específica (+1)');
  if (breakdown.isSpanish)       lines.push('✓ Cliente latino / español (+1)');
  if (hasEmailAndPhone)          lines.push('✓ Email + teléfono (+1)');
  return lines.join('\n');
}

async function analyzeWithAI(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Score] ANTHROPIC_API_KEY no configurada — scoring omitido.');
    return { points: 0, breakdown: {}, reason: 'Sin API key' };
  }
  if (!text.trim()) {
    console.warn('[Score] Contexto vacío — scoring omitido.');
    return { points: 0, breakdown: {}, reason: 'Sin información' };
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are a real estate lead scoring assistant. Analyze the following lead information and return ONLY a JSON object — no explanation, no extra text.

Scoring criteria (set true if the lead clearly meets it):
- hasBudget: mentions a specific budget or price (e.g. "500k", "$400,000", "300 mil")
- hasTimeline: mentions a clear buying timeline (e.g. "inmediato", "3 meses", "este año", "ASAP", "urgente")
- hasPurchaseType: specifies cash or financed (e.g. "cash", "financiado", "pre-approved")
- hasPreApproval: already spoke with a bank or has pre-approval
- hasLocation: mentions a specific city or area (Orlando, Tampa, St. Cloud, Apopka, Kissimmee, etc.)
- isSpanish: the text is in Spanish or the lead appears to be Latino
- reason: a single short line (max 10 words) summarizing why this lead got this score. Examples: "Cash buyer, Orlando, timeline 2 meses", "Sin información relevante en notas", "Presupuesto 400k, financiado, busca Kissimmee"

Respond ONLY with this JSON (no extra text):
{"hasBudget":false,"hasTimeline":false,"hasPurchaseType":false,"hasPreApproval":false,"hasLocation":false,"isSpanish":false,"reason":""}

Lead info:
${text}`,
      },
    ],
  });

  try {
    const raw = message.content[0]?.text || '{}';
    const json = JSON.parse(raw.match(/\{.*\}/s)?.[0] || '{}');
    const breakdown = {
      hasBudget:       !!json.hasBudget,
      hasTimeline:     !!json.hasTimeline,
      hasPurchaseType: !!json.hasPurchaseType,
      hasPreApproval:  !!json.hasPreApproval,
      hasLocation:     !!json.hasLocation,
      isSpanish:       !!json.isSpanish,
    };
    const points = Object.entries(CRITERIA_POINTS).reduce(
      (sum, [key, pts]) => sum + (breakdown[key] ? pts : 0),
      0
    );
    return { points, breakdown, reason: json.reason || '' };
  } catch {
    return { points: 0, breakdown: {}, reason: '' };
  }
}

/**
 * Score a lead from 1–10 using FUB notes.
 * @param {object} lead  - { name, email, phone, source }
 * @param {string[]} notes - array of note body strings from FUB
 * @returns {object} { score, reason }
 */
async function scoreLeadFromNotes(lead, notes = []) {
  const hasEmailAndPhone = !!(lead.email && lead.phone);

  const notesText = notes.length > 0
    ? notes.map((n, i) => `Nota ${i + 1}: ${n}`).join('\n')
    : '';

  const context = [
    lead.name   && `Nombre: ${lead.name}`,
    lead.source && `Fuente: ${lead.source}`,
    lead.phone  && `Teléfono: ${lead.phone}`,
    notesText   && `\nNOTAS EN FUB:\n${notesText}`,
  ]
    .filter(Boolean)
    .join('\n');

  console.log(`[Score] Analizando notas de: ${lead.name} (${notes.length} notas)`);
  const aiResult = await analyzeWithAI(context);

  const score = Math.min(10, Math.max(1, aiResult.points + (hasEmailAndPhone ? 1 : 0)));

  return { score, reason: aiResult.reason || '' };
}

/**
 * Score a lead from 1–10 using webhook payload.
 * @param {object} lead   - { name, email, phone, source }
 * @param {object} rawBody - full webhook payload (may contain notes, message, etc.)
 * @returns {object} { score, label, tags, noteText }
 */
async function scoreLead(lead, rawBody = {}) {
  // Structural point: has both email AND phone
  const hasEmailAndPhone = !!(lead.email && lead.phone);

  // Build text context for AI — include all string fields from the payload
  const skipFields = new Set(['name', 'email', 'phone', 'source']);
  const extraLines = Object.entries(rawBody)
    .filter(([k, v]) => !skipFields.has(k) && typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}: ${v}`);

  const context = [
    lead.name   && `Nombre: ${lead.name}`,
    lead.source && `Fuente: ${lead.source}`,
    ...extraLines,
  ]
    .filter(Boolean)
    .join('\n');

  console.log(`[Score] procesando lead: ${lead.name} — notas: ${context.slice(0, 120)}`);
  const aiResult = await analyzeWithAI(context);

  const score = Math.min(10, Math.max(1, aiResult.points + (hasEmailAndPhone ? 1 : 0)));

  return {
    score,
    label: getLabel(score),
    tags: buildTags(score),
    noteText: buildNoteText(score, aiResult.breakdown, hasEmailAndPhone),
  };
}

module.exports = { scoreLead, scoreLeadFromNotes };
