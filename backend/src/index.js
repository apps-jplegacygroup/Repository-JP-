require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const corsMiddleware = require('./middleware/cors');

// Validate required env vars
const required = ['JWT_SECRET', 'USER_JORGE_PASS', 'USER_KAREN_PASS', 'USER_MARKETING_PASS'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[startup] Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(corsMiddleware);
app.use(express.json());

// Rate limit login endpoint only
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// Routes
const authRoutes = require('./routes/auth');
const propertiesRoutes = require('./routes/properties');
const photosRoutes = require('./routes/photos');

app.use('/api/v1/auth/login', loginLimiter);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/properties', propertiesRoutes);
app.use('/api/v1/properties/:id/photos', photosRoutes);

// Temporary debug endpoint — remove after confirming env vars
app.get('/debug/env', async (_req, res) => {
  const { testToken } = require('./services/dropbox');
  let dropboxStatus = 'not_tested';
  let dropboxAccount = null;
  let dropboxError = null;
  try {
    const account = await testToken();
    dropboxStatus = 'ok';
    dropboxAccount = account.email;
  } catch (e) {
    dropboxStatus = 'failed';
    dropboxError = e.message;
  }
  res.json({
    jwt_secret_exists: !!process.env.JWT_SECRET,
    jorge_pass_exists: !!process.env.USER_JORGE_PASS,
    dropbox_token_exists: !!process.env.DROPBOX_TOKEN,
    dropbox_token_length: process.env.DROPBOX_TOKEN?.length ?? 0,
    dropbox_token_prefix: process.env.DROPBOX_TOKEN?.slice(0, 10),
    dropbox_status: dropboxStatus,
    dropbox_account: dropboxAccount,
    dropbox_error: dropboxError,
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'video-pipeline-api', time: new Date().toISOString() });
});

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[video-pipeline-api] Running on port ${PORT}`);
});
