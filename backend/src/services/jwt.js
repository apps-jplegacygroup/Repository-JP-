const jwt = require('jsonwebtoken');

const SECRET = () => process.env.JWT_SECRET;
const EXPIRY = '8h';

function sign(payload) {
  return jwt.sign(payload, SECRET(), { expiresIn: EXPIRY });
}

function verify(token) {
  return jwt.verify(token, SECRET()); // throws on invalid/expired
}

module.exports = { sign, verify };
