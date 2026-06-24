(() => {
  "use strict";

  const LOCAL = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const DEFAULT_API_URL = LOCAL ? 'http://localhost:3001' : 'https://api.riggedio.com:3000';
  const CONFIG = window.RiggedConfig || {};
  const URL_PARAMS = new URLSearchParams(window.location.search);
  const API_URL = String(URL_PARAMS.get('api') || CONFIG.apiUrl || localStorage.getItem('rigged.apiUrl') || DEFAULT_API_URL).replace(/\/+$/, '');
  const TOKEN_KEY = 'rigged.authToken';
  const USER_KEY = 'rigged.authUser';
  let currentUser = readUser();

  function readUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }

  function setSession(user, token) {
    currentUser = user || null;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
    window.dispatchEvent(new CustomEvent('rigged:auth', { detail: { user: currentUser } }));
    render();
  }

  function authHeaders(headers = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    return {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function apiFetch(path, options = {}) {
    return fetch(`${API_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: authHeaders(options.headers || {}),
    });
  }

  async function loadMe() {
    const response = await apiFetch('/auth/me');
    if (!response.ok) throw new Error('Not signed in');
    const data = await response.json();
    setSession(data.user, null);
    return data.user;
  }

  function formMarkup(mode) {
    const isRegister = mode === 'register';
    return `
      <form class="auth-form" data-auth-form="${mode}">
        <strong>${isRegister ? 'Create account' : 'Sign in'}</strong>
        ${isRegister ? '<label><span>Username</span><input name="username" autocomplete="username" required minlength="3" maxlength="24"></label><label><span>Email</span><input name="email" type="email" autocomplete="email" required></label>' : '<label><span>Username or email</span><input name="login" autocomplete="username" required></label>'}
        <label><span>Password</span><input name="password" type="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" required minlength="8"></label>
        <button class="auth-submit" type="submit">${isRegister ? 'Register' : 'Login'}</button>
        <button class="auth-link" type="button" data-auth-mode="${isRegister ? 'login' : 'register'}">${isRegister ? 'I already have an account' : 'Create an account'}</button>
        <p class="auth-error" role="alert" hidden></p>
      </form>
    `;
  }

  function accountMarkup() {
    if (!currentUser) return formMarkup('login');
    return `
      <section class="auth-profile">
        <strong>Account</strong>
        <dl>
          <div><dt>Username</dt><dd>${escapeHtml(currentUser.username)}</dd></div>
          <div><dt>Email</dt><dd>${escapeHtml(currentUser.email)}</dd></div>
          <div><dt>Created</dt><dd>${new Date(currentUser.created_at).toLocaleDateString()}</dd></div>
        </dl>
        <button class="auth-submit" type="button" data-auth-logout>Logout</button>
      </section>
    `;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function render(mode = null) {
    const mount = document.getElementById('authPanel');
    const status = document.getElementById('authStatus');
    if (!mount) return;
    mount.innerHTML = mode ? formMarkup(mode) : accountMarkup();
    if (status) status.textContent = currentUser ? currentUser.username : 'Guest';
  }

  async function submitAuth(form) {
    const error = form.querySelector('.auth-error');
    const mode = form.dataset.authForm;
    const body = Object.fromEntries(new FormData(form));
    error.hidden = true;
    const response = await apiFetch(`/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      error.textContent = data.error || 'Authentication failed.';
      error.hidden = false;
      return;
    }
    setSession(data.user, data.token);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const actions = document.querySelector('.lobby-entry-actions');
    if (actions && !document.getElementById('authPanel')) {
      actions.insertAdjacentHTML('afterbegin', '<div class="auth-strip"><span>Account</span><strong id="authStatus">Guest</strong></div><div id="authPanel" class="auth-panel"></div>');
    }
    render();
    loadMe().catch(() => render());
  });

  document.addEventListener('click', async (event) => {
    const modeButton = event.target.closest('[data-auth-mode]');
    if (modeButton) render(modeButton.dataset.authMode);
    if (event.target.closest('[data-auth-logout]')) {
      await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null, null);
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-auth-form]');
    if (!form) return;
    event.preventDefault();
    submitAuth(form).catch((error) => {
      const target = form.querySelector('.auth-error');
      target.textContent = error.message || 'Authentication failed.';
      target.hidden = false;
    });
  });

  window.RiggedAuth = {
    API_URL,
    fetch: apiFetch,
    getToken: () => localStorage.getItem(TOKEN_KEY),
    getUser: () => currentUser,
    requireAccount: async () => currentUser || loadMe(),
  };
})();
