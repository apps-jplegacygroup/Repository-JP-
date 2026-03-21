const cron = require('node-cron');
const { createContact } = require('./fub');
const {
  getPendingLeads,
  updateLeadInQueue,
  removeFromQueue,
  incrementStat,
} = require('../utils/storage');

const MAX_RETRIES = 10;

async function processQueue() {
  const pending = getPendingLeads();
  if (pending.length === 0) return;

  console.log(`[Queue] Processing ${pending.length} pending lead(s)...`);

  for (const lead of pending) {
    try {
      await createContact(lead);
      console.log(`[Queue] Lead ${lead.id} sent to FUB successfully.`);
      removeFromQueue(lead.id);
      incrementStat('sent');
    } catch (err) {
      const retryCount = (lead.retryCount || 0) + 1;
      const errorMsg = err.response?.data?.message || err.message;

      if (retryCount >= MAX_RETRIES) {
        console.error(`[Queue] Lead ${lead.id} reached max retries. Marking as dead.`);
        updateLeadInQueue(lead.id, {
          status: 'dead',
          retryCount,
          lastAttempt: new Date().toISOString(),
          error: errorMsg,
        });
      } else {
        console.warn(`[Queue] Lead ${lead.id} retry ${retryCount}/${MAX_RETRIES} failed: ${errorMsg}`);
        updateLeadInQueue(lead.id, {
          retryCount,
          lastAttempt: new Date().toISOString(),
          error: errorMsg,
        });
      }
    }
  }
}

function startRetryQueue() {
  // Every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Queue] Running retry cycle...');
    await processQueue();
  });

  console.log('[Queue] Retry queue started (every 5 minutes).');
}

module.exports = { startRetryQueue, processQueue };
