const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createContact, findContact, addNote, updateContactTags } = require('../services/fub');
const { scoreLead } = require('../services/leadScore');
const { cleanSourceTag } = require('../services/fubReport');
const { addToQueue, incrementStat, incrementStatBySource, recordLeadScore } = require('../utils/storage');

const router = express.Router();

/**
 * Extracts the lead source from a Respond.io webhook body.
 * Respond.io may send the channel/inbox name in different fields depending on
 * how the webhook template is configured. We try multiple paths before defaulting.
 */
function extractSource(body) {
  // Try every common field name Respond.io might use
  const candidates = [
    body.source,
    body.channel,
    body.channelName,
    body.inboxName,
    body.inbox,
    body.conversationChannel,
    body.conversation?.channel?.name,
    body.conversation?.inbox?.name,
    body.contact?.channel,
    // Tags array → join into a string cleanSourceTag can parse
    Array.isArray(body.tags) ? body.tags.join(',') : null,
    Array.isArray(body.contact?.tags) ? body.contact.tags.join(',') : null,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Apply lead score to a FUB contact: update tags and add a score note.
 * Runs async after responding — errors are logged but don't affect the response.
 */
async function applyScore(lead, rawBody, fubPersonId, existingTags = []) {
  try {
    const result = await scoreLead(lead, rawBody);
    await updateContactTags(fubPersonId, result.tags, existingTags);
    await addNote(fubPersonId, result.noteText);
    recordLeadScore(lead.name, result.score, lead.source, lead.phone);
    console.log(`[Score] ${lead.email} → ${result.score}/10 (${result.label})`);
  } catch (err) {
    console.error(`[Score] Error scoring lead ${lead.email}:`, err.message);
  }
}

// POST /webhook/debug — echo raw body for diagnosing Respond.io payload format (no lead created)
router.post('/debug', (req, res) => {
  console.log('[Webhook/debug] Raw body:', JSON.stringify(req.body, null, 2));
  res.json({ received: true, body: req.body });
});

// POST /webhook/lead
router.post('/lead', async (req, res) => {
  const body = req.body || {};
  const { name, email, phone } = body;

  // Log the full raw body so we can see exactly what Respond.io sends
  console.log('[Webhook] Raw body from Respond.io:', JSON.stringify(body));

  // Validate required fields
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing required fields: name, email' });
  }

  const rawSource = extractSource(body);
  const cleanedSource = cleanSourceTag(rawSource || '');
  // Only fall back to 'Respond.io' if we truly got nothing at all
  const resolvedSource = cleanedSource && cleanedSource !== 'Sin fuente' ? cleanedSource : (rawSource || 'Respond.io');

  console.log(`[Webhook] Source extraction — raw="${rawSource}" → cleaned="${cleanedSource}" → resolved="${resolvedSource}"`);

  const lead = {
    id: uuidv4(),
    name,
    email,
    phone: phone || '',
    source: resolvedSource,
    receivedAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
    lastAttempt: null,
    error: null,
  };

  incrementStat('received');
  incrementStatBySource(lead.source);
  console.log(`[Webhook] Lead received: ${name} <${email}> from ${lead.source}`);

  try {
    // Check for duplicate in FUB before creating
    const existing = await findContact(lead.email, lead.phone);

    if (existing) {
      // Duplicate found — add a note with new contact info
      const noteBody =
        `Nueva conversación desde ${lead.source} — ${new Date().toISOString()}\n` +
        `Nombre: ${lead.name}\n` +
        `Email: ${lead.email}\n` +
        `Teléfono: ${lead.phone || '—'}`;

      await addNote(existing.id, noteBody);
      incrementStat('duplicates');

      // Score and tag in background (don't block response)
      applyScore(lead, req.body, existing.id, existing.tags || []);

      console.log(`[Webhook] Duplicate detected for ${email} — FUB contact ${existing.id}. Note added.`);
      return res.status(200).json({
        success: true,
        leadId: lead.id,
        status: 'duplicate',
        fubPersonId: existing.id,
        message: 'Existing contact found. Note added.',
      });
    }

    // No duplicate — create new contact
    const fubPerson = await createContact(lead);
    incrementStat('sent');

    // Score and tag in background (don't block response)
    applyScore(lead, req.body, fubPerson.id, fubPerson.tags || []);

    console.log(`[Webhook] Lead ${lead.id} created in FUB (id: ${fubPerson.id}).`);
    return res.status(200).json({ success: true, leadId: lead.id, status: 'sent' });

  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    console.error(`[Webhook] FUB error for lead ${lead.id}: ${errorMsg}`);

    // Save to retry queue
    lead.error = errorMsg;
    lead.lastAttempt = new Date().toISOString();
    addToQueue(lead);
    incrementStat('failed');

    return res.status(200).json({
      success: false,
      leadId: lead.id,
      status: 'queued',
      message: 'Lead queued for retry',
    });
  }
});

module.exports = router;
