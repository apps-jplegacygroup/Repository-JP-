const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createContact } = require('../services/fub');
const { addToQueue, incrementStat } = require('../utils/storage');

const router = express.Router();

// POST /webhook/lead
router.post('/lead', async (req, res) => {
  const { name, email, phone, source } = req.body || {};

  // Validate required fields
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing required fields: name, email' });
  }

  const lead = {
    id: uuidv4(),
    name,
    email,
    phone: phone || '',
    source: source || 'Respond.io',
    receivedAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
    lastAttempt: null,
    error: null,
  };

  incrementStat('received');
  console.log(`[Webhook] Lead received: ${name} <${email}> from ${lead.source}`);

  try {
    await createContact(lead);
    incrementStat('sent');
    console.log(`[Webhook] Lead ${lead.id} created in FUB.`);
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
