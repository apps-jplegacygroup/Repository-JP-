const axios = require('axios');

const FUB_BASE_URL = 'https://api.followupboss.com/v1';
const TAGS = ['JP-Legacy', 'Ylopo-New'];

function getAuthHeader() {
  const apiKey = process.env.FUB_API_KEY;
  if (!apiKey) throw new Error('FUB_API_KEY is not set');
  // FUB Basic Auth: base64(apiKey + ":")
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Creates a contact in Follow Up Boss.
 * @param {object} lead - { name, email, phone, source }
 * @returns {object} FUB API response data
 */
async function createContact(lead) {
  const [firstName, ...rest] = (lead.name || '').trim().split(' ');
  const lastName = rest.join(' ') || '';

  const payload = {
    firstName,
    lastName,
    emails: lead.email ? [{ value: lead.email }] : [],
    phones: lead.phone ? [{ value: lead.phone }] : [],
    tags: TAGS,
    source: lead.source || 'Respond.io',
  };

  const response = await axios.post(`${FUB_BASE_URL}/people`, payload, {
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
      'X-System': 'jp-legacy-agent',
      'X-System-Key': process.env.FUB_API_KEY,
    },
    timeout: 10000,
  });

  return response.data;
}

module.exports = { createContact };
