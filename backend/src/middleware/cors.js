const cors = require('cors');

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173', // Vite dev server
].filter(Boolean);

module.exports = cors({
  origin(origin, callback) {
    // Allow requests with no origin (curl, Postman, Railway health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
