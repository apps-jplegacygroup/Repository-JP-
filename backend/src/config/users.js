// Hardcoded user store — passwords live in Railway env vars, not here.
// To add a 4th user: add an entry + set the corresponding env var on Railway.

const USERS = [
  {
    id: 'u1',
    email: 'jorgeflorez@jplegacygroup.com',
    name: 'Jorge Florez',
    role: 'admin',          // sees ALL properties
    passwordEnvKey: 'USER_JORGE_PASS',
  },
  {
    id: 'u2',
    email: 'karen@getvau.com',
    name: 'Karen',
    role: 'user',           // sees only properties where assignedTo includes 'u2'
    passwordEnvKey: 'USER_KAREN_PASS',
  },
  {
    id: 'u3',
    email: 'marketing@jplegacygroup.com',
    name: 'Marketing',
    role: 'user',
    passwordEnvKey: 'USER_MARKETING_PASS',
  },
];

function findByEmail(email) {
  return USERS.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
}

function findById(id) {
  return USERS.find(u => u.id === id) || null;
}

module.exports = { USERS, findByEmail, findById };
