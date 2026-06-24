const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, safeUser } = require('./db');

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'rigged_auth';
const BCRYPT_ROUNDS = Math.max(12, Number(process.env.BCRYPT_ROUNDS) || 12);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const loginRegisterHits = new Map();

function jwtSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  return process.env.JWT_SECRET;
}

function authCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  return `${COOKIE_NAME}=${token}; HttpOnly${secure}; SameSite=${sameSite}; Path=/; Max-Age=${Math.floor(ONE_WEEK_MS / 1000)}`;
}

function clearAuthCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  return `${COOKIE_NAME}=; HttpOnly${secure}; SameSite=${sameSite}; Path=/; Max-Age=0`;
}

function parseCookies(header) {
  return Object.fromEntries(String(header || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function tokenFromRequest(request) {
  const authorization = String(request.headers.authorization || '');
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  return parseCookies(request.headers.cookie)[COOKIE_NAME] || '';
}

async function userFromToken(token) {
  if (!token) return null;
  const payload = jwt.verify(token, jwtSecret());
  const result = await pool.query('SELECT id, username, email, created_at FROM users WHERE id = $1', [payload.sub]);
  return safeUser(result.rows[0]);
}

async function attachAuthToRequest(request) {
  try {
    request.user = await userFromToken(tokenFromRequest(request));
  } catch {
    request.user = null;
  }
  return request.user;
}

async function requireAuth(request, response, send) {
  const user = await attachAuthToRequest(request);
  if (!user) {
    send(response, 401, { error: 'Authentication required' });
    return null;
  }
  return user;
}

function validateRegistration(body) {
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) return 'Username must be 3-24 letters, numbers, underscores, or hyphens.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return 'Enter a valid email address.';
  if (password.length < 8 || password.length > 128) return 'Password must be 8-128 characters.';
  return '';
}

function validateLogin(body) {
  const login = String(body.login || body.email || body.username || '').trim();
  const password = String(body.password || '');
  if (!login || !password) return 'Enter your username/email and password.';
  return '';
}

function rateLimitKey(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function checkAuthRateLimit(request) {
  const now = Date.now();
  const key = rateLimitKey(request);
  const windowMs = 15 * 60 * 1000;
  const max = 20;
  const entry = loginRegisterHits.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  loginRegisterHits.set(key, entry);
  return entry.count <= max;
}

function issueToken(user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, jwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

async function handleAuthRoute(request, response, url, readJson, send) {
  if (!url.pathname.startsWith('/auth/')) return false;

  if ((url.pathname === '/auth/register' || url.pathname === '/auth/login') && !checkAuthRateLimit(request)) {
    send(response, 429, { error: 'Too many attempts. Try again later.' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/auth/register') {
    const body = await readJson(request);
    const validationError = validateRegistration(body);
    if (validationError) return send(response, 400, { error: validationError }), true;
    const username = String(body.username).trim();
    const email = String(body.email).trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)', [username, email]);
    if (existing.rowCount) return send(response, 409, { error: 'Username or email is already registered.' }), true;
    const passwordHash = await bcrypt.hash(String(body.password), BCRYPT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at',
      [username, email, passwordHash]
    );
    const user = safeUser(result.rows[0]);
    const token = issueToken(user);
    return send(response, 201, { user, token }, { 'Set-Cookie': authCookie(token) }), true;
  }

  if (request.method === 'POST' && url.pathname === '/auth/login') {
    const body = await readJson(request);
    const validationError = validateLogin(body);
    if (validationError) return send(response, 400, { error: validationError }), true;
    const login = String(body.login || body.email || body.username).trim();
    const result = await pool.query('SELECT id, username, email, password_hash, created_at FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)', [login]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(String(body.password), row.password_hash))) {
      return send(response, 401, { error: 'Invalid username/email or password.' }), true;
    }
    const user = safeUser(row);
    const token = issueToken(user);
    return send(response, 200, { user, token }, { 'Set-Cookie': authCookie(token) }), true;
  }

  if (request.method === 'GET' && url.pathname === '/auth/me') {
    const user = await requireAuth(request, response, send);
    if (!user) return true;
    return send(response, 200, { user }), true;
  }

  if (request.method === 'POST' && url.pathname === '/auth/logout') {
    return send(response, 200, { ok: true }, { 'Set-Cookie': clearAuthCookie() }), true;
  }

  send(response, 404, { error: 'Route not found' });
  return true;
}

module.exports = { attachAuthToRequest, handleAuthRoute, requireAuth, tokenFromRequest, userFromToken };
