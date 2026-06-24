const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const { attachAuthToRequest, handleAuthRoute, userFromToken } = require('./auth');
const { initDb } = require('./db');

const PORT = 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://riggedio.com,https://www.riggedio.com';
const players = new Map();
const lobbies = new Map();
let lobbyIdCounter = 1000;
const LOBBY_HEARTBEAT_TIMEOUT = 20000;
const GAME_PRESENCE_TIMEOUT = 8000;

const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/api.riggedio.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/api.riggedio.com/fullchain.pem')
};

const server = https.createServer(options, handleHttp);
const wss = new WebSocket.Server({ server });

async function handleHttp(req, res) {
  res.req = req;
  const origin = req.headers.origin || '';
  const allowed = CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean);
  const allowedOrigin = allowed.includes('*') ? (origin || '*') : (allowed.includes(origin) ? origin : allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, 'https://api.riggedio.com');

  try {
    await attachAuthToRequest(req);
    if (await handleAuthRoute(req, res, requestUrl, readJsonPromise, sendJson)) return;
  } catch (error) {
    console.error(error);
    sendJson(res, 400, { error: 'Invalid request' });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/account') {
    if (!req.user) return sendJson(res, 401, { error: 'Authentication required' });
    sendJson(res, 200, { user: req.user });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/lobby/create') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      const lobbyId = String(lobbyIdCounter++);
      const inviteCode = 'CODE' + Math.floor(Math.random() * 900000 + 100000);
      const now = Date.now();
      const lobby = {
        id: lobbyId,
        hostId: data.hostId,
        hostName: data.hostDisplayName || data.hostName || 'Host',
        lobbyName: String(data.lobbyName || "Host's Lobby").trim().slice(0, 32),
        isPublic: data.isPublic === true,
        visibility: data.isPublic === true ? 'public' : 'private',
        mode: data.mode,
        difficulty: data.difficulty,
        players: [{ id: data.hostId, name: data.hostDisplayName || 'Host', host: true, isBot: false, ready: true, connected: true, lastSeen: now, user: req.user || null, userId: req.user?.id || null }],
        maxPlayers: parseInt(data.maxPlayers) || 4,
        createdAt: now,
        updatedAt: now,
        lastHeartbeat: now,
        started: false,
        status: 'open',
        inviteCode: inviteCode,
        gameState: null,
        gameStateVersion: 0,
        gameCommands: []
      };
      lobbies.set(lobbyId, lobby);
      console.log('Lobby created:', inviteCode);
      sendJson(res, 200, { lobbyId, inviteCode, lobby });
    });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/lobbies') {
    pruneAbandonedLobbies();
    const publicOnly = requestUrl.searchParams.get('public') === '1';
    const visibleLobbies = Array.from(lobbies.values()).filter(lobby =>
      !publicOnly || (lobby.isPublic && !lobby.started && lobby.players.length < lobby.maxPlayers)
    );
    console.log('Returning lobbies:', visibleLobbies.length);
    sendJson(res, 200, visibleLobbies);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/lobby/join') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      const lobby = lobbies.get(data.lobbyId);
      if (!lobby) {
        sendJson(res, 404, { error: 'Lobby not found' });
        return;
      }
      if (lobby.started) {
        sendJson(res, 409, { error: 'Game already started' });
        return;
      }
      if (lobby.players.length >= lobby.maxPlayers) {
        sendJson(res, 400, { error: 'Lobby full' });
        return;
      }
      if (!lobby.players.some(player => player.id === data.playerId)) {
        lobby.players.push({ id: data.playerId, name: data.playerName, isBot: data.isBot === true, ready: data.isBot === true, connected: true, lastSeen: Date.now(), user: req.user || null, userId: req.user?.id || null });
      } else if (req.user) {
        const player = lobby.players.find(entry => entry.id === data.playerId);
        player.user = req.user;
        player.userId = req.user.id;
      }
      lobby.updatedAt = Date.now();
      console.log('Player joined:', data.playerName);
      sendJson(res, 200, { success: true, lobby });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/lobby/start') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      const lobby = lobbies.get(data.lobbyId);
      if (!lobby || lobby.hostId !== data.hostId) {
        sendJson(res, 403, { error: 'Not host' });
        return;
      }
      while (lobby.players.length < lobby.maxPlayers) {
        lobby.players.push({ id: 'bot_' + Math.random(), name: 'Bot ' + (lobby.players.length) });
      }
      lobby.players.forEach(player => {
        if (!player.isBot) {
          player.connected = true;
          player.lastSeen = Date.now();
        }
      });
      lobby.started = true;
      lobby.status = 'started';
      lobby.updatedAt = Date.now();
      console.log('Game started');
      sendJson(res, 200, { success: true, lobby });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/heartbeat') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== data.hostId) return sendJson(res, 403, { error: 'Not host' });
      lobby.lastHeartbeat = Date.now();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/leave') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 200, { removed: false });
      if (lobby.hostId !== data.hostId) return sendJson(res, 403, { error: 'Not host' });
      if (lobby.started) {
        markPlayerDisconnected(lobby, data.hostId);
        const nextHost = promoteLobbyHost(lobby, data.hostId);
        if (nextHost) {
          console.log('Host migrated:', lobby.id, '->', nextHost.id);
          return sendJson(res, 200, { removed: false, migrated: true, hostId: nextHost.id, lobby });
        }
      }
      lobbies.delete(lobby.id);
      console.log('Host closed lobby:', lobby.id);
      sendJson(res, 200, { removed: true });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/presence') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      const player = lobby.players.find(entry => entry.id === data.playerId && !entry.isBot);
      if (!player) return sendJson(res, 404, { error: 'Player not found' });
      player.connected = true;
      player.lastSeen = Date.now();
      if (req.user) {
        player.user = req.user;
        player.userId = req.user.id;
      }
      sendJson(res, 200, { ok: true, hostId: lobby.hostId });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/ready') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      const player = lobby.players.find(entry => entry.id === data.playerId && entry.id !== lobby.hostId);
      if (!player) return sendJson(res, 404, { error: 'Guest not found' });
      player.ready = data.ready === true;
      lobby.updatedAt = Date.now();
      sendJson(res, 200, { success: true, lobby });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/player') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      const player = lobby.players.find(entry => entry.id === data.playerId && !entry.isBot);
      if (!player) return sendJson(res, 404, { error: 'Player not found' });
      const clean = (value, fallback, max) => String(value || fallback).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) || fallback;
      const profile = data.leaderProfile && typeof data.leaderProfile === 'object' ? data.leaderProfile : {};
      player.name = clean(data.name, player.name || 'Player', 20);
      player.factionIndex = Math.max(0, Math.min(7, Number(data.factionIndex) || 0));
      player.party = clean(data.party, 'Party', 28);
      player.leader = clean(data.leader, 'Leader', 28);
      player.color = /^#[0-9a-f]{3,8}$/i.test(String(data.color || '')) ? String(data.color) : '#34ff86';
      player.leaderProfile = {
        skin: clean(profile.skin, '#d8a07a', 16),
        hairstyle: clean(profile.hairstyle, 'charmer', 24),
        facialHair: clean(profile.facialHair, 'none', 24),
        hat: clean(profile.hat, 'none', 24),
        flag: clean(profile.flag, 'campaign_stripes', 32),
      };
      lobby.updatedAt = Date.now();
      sendJson(res, 200, { success: true, lobby });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/game/state') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== data.hostId) return sendJson(res, 403, { error: 'Only the host can publish game state' });
      if (!lobby.started) return sendJson(res, 409, { error: 'Lobby has not started' });
      lobby.gameState = data.state && typeof data.state === 'object' ? data.state : null;
      lobby.gameStateVersion = Math.max((lobby.gameStateVersion || 0) + 1, Number(data.version) || 0);
      lobby.updatedAt = Date.now();
      sendJson(res, 200, { ok: true, version: lobby.gameStateVersion });
    });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/game/state') {
    const lobby = lobbies.get(String(requestUrl.searchParams.get('lobbyId') || ''));
    if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
    sendJson(res, 200, { version: lobby.gameStateVersion || 0, state: lobby.gameState || null, hostId: lobby.hostId });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/game/command') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      if (!lobby.players.some(player => player.id === data.playerId && !player.isBot)) return sendJson(res, 403, { error: 'Player is not in this lobby' });
      if (!data.command || typeof data.command !== 'object') return sendJson(res, 400, { error: 'Invalid command' });
      lobby.gameCommands = lobby.gameCommands || [];
      lobby.gameCommands.push({ id: `${Date.now()}-${Math.random()}`, playerId: data.playerId, command: data.command, createdAt: Date.now() });
      if (lobby.gameCommands.length > 100) lobby.gameCommands.splice(0, lobby.gameCommands.length - 100);
      sendJson(res, 202, { queued: true });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/game/commands/drain') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== data.hostId) return sendJson(res, 403, { error: 'Only the host can drain commands' });
      const commands = (lobby.gameCommands || []).splice(0);
      sendJson(res, 200, { commands });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/bot/remove') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== data.hostId) return sendJson(res, 403, { error: 'Only the host can remove bots' });
      const botIndex = lobby.players.findIndex(player => player.id === data.botId && player.isBot === true);
      if (botIndex < 0) return sendJson(res, 404, { error: 'Bot not found' });
      lobby.players.splice(botIndex, 1);
      lobby.updatedAt = Date.now();
      sendJson(res, 200, { success: true, lobby });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/lobby/settings') {
    readRequestJson(req, res, data => {
      const lobby = lobbies.get(String(data.lobbyId || ''));
      if (!lobby) return sendJson(res, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== data.hostId) return sendJson(res, 403, { error: 'Not host' });
      lobby.mode = data.mode === 'majority50' ? 'majority50' : 'campaign100';
      lobby.difficulty = ['easy', 'medium', 'hard'].includes(data.difficulty) ? data.difficulty : lobby.difficulty;
      lobby.maxPlayers = Math.max(lobby.players.length, Math.min(5, Number(data.maxPlayers) || lobby.maxPlayers));
      lobby.updatedAt = Date.now();
      sendJson(res, 200, { success: true, lobby });
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function readRequestJson(req, res, onData) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 2000000) req.destroy();
  });
  req.on('end', () => {
    try {
      onData(JSON.parse(body || '{}'));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
    }
  });
}

function readJsonPromise(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2000000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function pruneAbandonedLobbies() {
  const now = Date.now();
  for (const [id, lobby] of lobbies) {
    const abandonedSetup = !lobby.started && now - (lobby.lastHeartbeat || lobby.createdAt) > LOBBY_HEARTBEAT_TIMEOUT;
    const expiredMatch = lobby.started && now - (lobby.updatedAt || lobby.createdAt) > 6 * 60 * 60 * 1000;
    if (lobby.started) {
      const host = lobby.players.find(player => player.id === lobby.hostId && !player.isBot);
      const hostTimedOut = !host || now - Number(host.lastSeen || 0) > GAME_PRESENCE_TIMEOUT;
      if (hostTimedOut) {
        if (host) markPlayerDisconnected(lobby, host.id);
        const nextHost = promoteLobbyHost(lobby, lobby.hostId, now);
        if (nextHost) console.log('Host timed out; migrated:', lobby.id, '->', nextHost.id);
      }
    }
    if (abandonedSetup || expiredMatch || (lobby.started && !lobby.hostId)) {
      lobbies.delete(id);
      console.log('Removed abandoned lobby:', id);
    }
  }
}

function markPlayerDisconnected(lobby, playerId) {
  const player = lobby.players.find(entry => entry.id === playerId && !entry.isBot);
  if (!player) return;
  player.connected = false;
  player.lastSeen = 0;
  player.host = false;
}

function promoteLobbyHost(lobby, previousHostId, now = Date.now()) {
  const nextHost = lobby.players.find(player =>
    !player.isBot &&
    player.id !== previousHostId &&
    player.connected !== false &&
    now - Number(player.lastSeen || 0) <= GAME_PRESENCE_TIMEOUT * 2
  );
  lobby.players.forEach(player => { player.host = !!nextHost && player.id === nextHost.id; });
  lobby.hostId = nextHost?.id || '';
  if (nextHost) {
    nextHost.connected = true;
    nextHost.lastSeen = now;
    lobby.updatedAt = now;
  }
  return nextHost || null;
}

setInterval(pruneAbandonedLobbies, 5000).unref();

function sendJson(res, code, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

wss.on('connection', (ws) => {
  console.log('Player connected');
  let playerId = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'join') {
        playerId = msg.id;
        let user = null;
        try {
          user = await userFromToken(String(msg.authToken || ''));
        } catch {}
        players.set(playerId, { id: playerId, name: msg.name, x: msg.x || 0, y: msg.y || 0, user, userId: user?.id || null });
      }
      if (msg.type === 'move' && playerId) {
        const p = players.get(playerId);
        if (p) {
          p.x = msg.x || 0;
          p.y = msg.y || 0;
          broadcast();
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (playerId) players.delete(playerId);
  });
});

function broadcast() {
  const msg = JSON.stringify(Array.from(players.values()));
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}

initDb()
  .then(() => {
    server.listen(PORT, () => console.log(`RIGGED live on wss://api.riggedio.com:${PORT}`));
  })
  .catch((error) => {
    console.error('Could not initialize database:', error);
    process.exit(1);
  });
