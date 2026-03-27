const express = require('express');
const { findByEmail } = require('../config/users');
const { sign } = require('../services/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/v1/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = findByEmail(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const expectedPassword = process.env[user.passwordEnvKey];
  if (!expectedPassword || password !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = sign({ userId: user.id, email: user.email, role: user.role });

  return res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
