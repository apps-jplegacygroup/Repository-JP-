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

const FUB_HEADERS = () => ({
  Authorization: getAuthHeader(),
  'Content-Type': 'application/json',
  'X-System': 'jp-legacy-agent',
  'X-System-Key': process.env.FUB_API_KEY,
});

/**
 * Search FUB for an existing contact by email or phone.
 * Returns the first matching person object, or null if not found.
 * @param {string} email
 * @param {string} phone
 */
async function findContact(email, phone) {
  // Try email first, then phone
  const queries = [];
  if (email) queries.push({ email });
  if (phone) queries.push({ phone });

  for (const params of queries) {
    const response = await axios.get(`${FUB_BASE_URL}/people`, {
      headers: FUB_HEADERS(),
      params,
      timeout: 10000,
    });
    const people = response.data?.people || [];
    if (people.length > 0) return people[0];
  }

  return null;
}

/**
 * Adds a note to an existing FUB contact.
 * @param {number} personId
 * @param {string} body
 */
async function addNote(personId, body) {
  await axios.post(
    `${FUB_BASE_URL}/notes`,
    { personId, body, isHtml: false },
    { headers: FUB_HEADERS(), timeout: 10000 }
  );
}

/**
 * Updates tags on an existing FUB contact.
 * Replaces any previous Score-* / Lead-Caliente / Lead-Tibio / Lead-Frio tags
 * and merges the rest so existing tags are preserved.
 * @param {number} personId
 * @param {string[]} newTags       - tags to add (e.g. ["Score-8", "Lead-Caliente"])
 * @param {string[]} existingTags  - current tags on the contact
 */
async function updateContactTags(personId, newTags, existingTags = []) {
  const SCORE_TAG = /^(Score-\d+|Lead-Caliente|Lead-Tibio|Lead-Frio)$/;
  const keepTags = existingTags.filter((t) => !SCORE_TAG.test(t));
  const merged = [...new Set([...keepTags, ...newTags])];

  await axios.put(
    `${FUB_BASE_URL}/people/${personId}`,
    { tags: merged },
    { headers: FUB_HEADERS(), timeout: 10000 }
  );
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
    headers: FUB_HEADERS(),
    timeout: 10000,
  });

  return response.data;
}

/**
 * Updates the source field of an existing FUB contact.
 * @param {number} personId
 * @param {string} source - clean source string
 */
async function updatePersonSource(personId, source) {
  await axios.put(
    `${FUB_BASE_URL}/people/${personId}`,
    { source },
    { headers: FUB_HEADERS(), timeout: 10000 }
  );
}

module.exports = { createContact, findContact, addNote, updateContactTags, updatePersonSource };
