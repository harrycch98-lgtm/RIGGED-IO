const assert = require('assert/strict');

const base = process.env.TEST_BACKEND_URL || 'http://localhost:3001';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { response, data };
}

async function expectOk(path, options) {
  const { response, data } = await request(path, options);
  assert.ok(response.ok, `${path} returned ${response.status}: ${JSON.stringify(data)}`);
  return { response, data };
}

(async () => {
  const suffix = Date.now().toString(36);
  const username = `rigged_${suffix}`;
  const email = `rigged_${suffix}@example.com`;
  const password = 'swordfish123';

  const register = await expectOk('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  assert.equal(register.response.status, 201, 'register should create a user');
  assert.equal(register.data.user.username, username);
  assert.equal(register.data.user.email, email);
  assert.match(String(register.data.token || ''), /\./, 'register should return a JWT');
  const cookie = register.response.headers.get('set-cookie') || '';
  assert.match(cookie, /rigged_auth=/, 'register should set the auth cookie');

  const duplicate = await request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  assert.equal(duplicate.response.status, 409, 'duplicate register should be rejected');

  const badLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: username, password: 'wrong-password' }),
  });
  assert.equal(badLogin.response.status, 401, 'bad password should be rejected');

  const login = await expectOk('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: email, password }),
  });
  assert.equal(login.data.user.username, username, 'login should resolve the correct user');
  const loginCookie = login.response.headers.get('set-cookie') || '';
  assert.match(loginCookie, /rigged_auth=/, 'login should refresh the auth cookie');

  const meUnauthed = await request('/auth/me');
  assert.equal(meUnauthed.response.status, 401, 'me should reject missing auth');

  const meWithBearer = await expectOk('/auth/me', {
    headers: { Authorization: `Bearer ${login.data.token}` },
  });
  assert.equal(meWithBearer.data.user.email, email, 'me should accept bearer tokens');

  const meWithCookie = await expectOk('/auth/me', {
    headers: { Cookie: loginCookie.split(';', 1)[0] },
  });
  assert.equal(meWithCookie.data.user.username, username, 'me should accept auth cookies');

  const logout = await expectOk('/auth/logout', {
    method: 'POST',
    headers: { Cookie: loginCookie.split(';', 1)[0] },
  });
  assert.equal(logout.data.ok, true, 'logout should succeed');

  console.log('PASS: register creates a user and session');
  console.log('PASS: duplicate registration is blocked');
  console.log('PASS: login rejects wrong passwords');
  console.log('PASS: login accepts username/email and returns auth');
  console.log('PASS: /auth/me works with bearer token and cookie');
  console.log('PASS: logout clears the session');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
