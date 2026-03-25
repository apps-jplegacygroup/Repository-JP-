const axios = require('axios');

const BASE_URL = 'https://app.asana.com/api/1.0';

const OPT_FIELDS = [
  'name',
  'assignee.name',
  'due_on',
  'start_on',
  'completed',
  'completed_at',
  'custom_fields.name',
  'custom_fields.display_value',
  'custom_fields.enum_value.name',
  'custom_fields.number_value',
  'custom_fields.text_value',
  'custom_fields.type',
].join(',');

function asanaClient() {
  const token = process.env.ASANA_TOKEN;
  if (!token) throw new Error('ASANA_TOKEN no configurado');
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchProjectTasks(projectId) {
  const client = asanaClient();
  const tasks = [];
  let offset = undefined;

  do {
    const params = { project: projectId, opt_fields: OPT_FIELDS, limit: 100 };
    if (offset) params.offset = offset;

    const { data } = await client.get('/tasks', { params });
    tasks.push(...data.data);
    offset = data.next_page ? data.next_page.offset : null;
  } while (offset);

  return tasks;
}

// Extract a custom field value by name (case-insensitive)
function getCustomField(task, fieldName) {
  if (!task.custom_fields) return null;
  const field = task.custom_fields.find(
    (f) => f.name && f.name.toLowerCase() === fieldName.toLowerCase()
  );
  if (!field) return null;
  if (field.enum_value && field.enum_value.name) return field.enum_value.name;
  if (field.display_value) return field.display_value;
  if (field.number_value !== null && field.number_value !== undefined) return String(field.number_value);
  if (field.text_value) return field.text_value;
  return null;
}

module.exports = { fetchProjectTasks, getCustomField };
