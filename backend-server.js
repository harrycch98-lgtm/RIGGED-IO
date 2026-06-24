// Minimal RIGGED multiplayer lobby service for local testing and deployment.
// Run with: node backend-server.js
const http = require('http');
const { randomBytes, randomUUID } = require('crypto');
const { attachAuthToRequest, handleAuthRoute, requireAuth } = require('./auth');
const { initDb } = require('./db');

const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001,https://riggedio.com,https://www.riggedio.com';
const LOBBY_HEARTBEAT_TIMEOUT = 20_000;
const GAME_PRESENCE_TIMEOUT = 8_000;
const lobbies = new Map();
const worldPlayers = new Map();

function corsOrigin(request) {
  const allowed = CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
  const origin = request.headers.origin || '';
  if (origin === 'null') return 'null';
  if (allowed.includes('*')) return origin || '*';
  return allowed.includes(origin) ? origin : allowed[0] || '*';
}

function send(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': corsOrigin(response.req || {}),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function cleanText(value, fallback, maxLength) {
  const cleaned = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, maxLength);
  return cleaned || fallback;
}

function cleanLeaderProfile(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    skin: cleanText(source.skin, '#d8a07a', 16),
    hairstyle: cleanText(source.hairstyle, 'charmer', 24),
    facialHair: cleanText(source.facialHair, 'none', 24),
    hat: cleanText(source.hat, 'none', 24),
    flag: cleanText(source.flag, 'campaign_stripes', 32),
  };
}

function inviteCode() {
  let code = '';
  do { code = randomBytes(5).toString('base64url').toUpperCase().replace(/[-_]/g, '').slice(0, 6); }
  while ([...lobbies.values()].some((lobby) => lobby.inviteCode === code));
  return code;
}

function publicLobby(lobby) {
  const { gameState, gameCommands, ...publicData } = lobby;
  return {
    ...publicData,
    players: lobby.players.map((player) => ({ ...player })),
    gameStateVersion: lobby.gameStateVersion || 0,
  };
}

function pruneLobbies() {
  const now = Date.now();
  const expiry = now - 6 * 60 * 60 * 1000;
  for (const [id, lobby] of lobbies) {
    const heartbeatExpired = !lobby.started && now - (lobby.lastHeartbeat || lobby.updatedAt) > LOBBY_HEARTBEAT_TIMEOUT;
    if (lobby.started) {
      const host = lobby.players.find((player) => player.id === lobby.hostId && !player.isBot);
      if (!host || now - Number(host.lastSeen || 0) > GAME_PRESENCE_TIMEOUT) {
        if (host) markPlayerDisconnected(lobby, host.id);
        promoteLobbyHost(lobby, lobby.hostId, now);
      }
    }
    if (lobby.updatedAt < expiry || heartbeatExpired || (lobby.started && !lobby.hostId)) lobbies.delete(id);
  }
}

function markPlayerDisconnected(lobby, playerId) {
  const player = lobby.players.find((entry) => entry.id === playerId && !entry.isBot);
  if (!player) return;
  player.connected = false;
  player.lastSeen = 0;
  player.host = false;
}

function promoteLobbyHost(lobby, previousHostId, now = Date.now()) {
  const nextHost = lobby.players.find((player) =>
    !player.isBot && player.id !== previousHostId && player.connected !== false &&
    now - Number(player.lastSeen || 0) <= GAME_PRESENCE_TIMEOUT * 2
  );
  lobby.players.forEach((player) => { player.host = !!nextHost && player.id === nextHost.id; });
  lobby.hostId = nextHost?.id || '';
  if (nextHost) {
    nextHost.connected = true;
    nextHost.lastSeen = now;
    lobby.updatedAt = now;
  }
  return nextHost || null;
}

const server = http.createServer(async (request, response) => {
  response.req = request;
  if (request.method === 'OPTIONS') return send(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    await attachAuthToRequest(request);
    if (await handleAuthRoute(request, response, url, readJson, send)) return;

    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { ok: true, lobbies: lobbies.size });
    }

    if (request.method === 'GET' && url.pathname === '/api/account') {
      const user = await requireAuth(request, response, send);
      if (!user) return;
      return send(response, 200, { user });
    }

    if (request.method === 'GET' && url.pathname === '/api/lobbies') {
      pruneLobbies();
      const publicOnly = url.searchParams.get('public') === '1';
      const result = [...lobbies.values()]
        .filter((lobby) => !publicOnly || (lobby.isPublic && !lobby.started && lobby.players.length < lobby.maxPlayers))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(publicLobby);
      return send(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/create') {
      const body = await readJson(request);
      const hostId = cleanText(body.hostId, randomUUID(), 80);
      const hostName = cleanText(body.hostName, 'Host', 24);
      const id = randomUUID();
      const now = Date.now();
      const lobby = {
        id,
        lobbyId: id,
        inviteCode: inviteCode(),
        lobbyName: cleanText(body.lobbyName, `${hostName}'s Lobby`, 32),
        isPublic: body.isPublic === true,
        visibility: body.isPublic === true ? 'public' : 'private',
        hostId,
        mode: body.mode === 'majority50' ? 'majority50' : 'campaign100',
        difficulty: ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium',
        maxPlayers: Math.max(2, Math.min(5, Number(body.maxPlayers) || 4)),
        players: [{ id: hostId, name: hostName, host: true, isBot: false, ready: true, connected: true, lastSeen: now, user: request.user || null, userId: request.user?.id || null }],
        started: false,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        lastHeartbeat: now,
        gameState: null,
        gameStateVersion: 0,
        gameCommands: [],
      };
      lobbies.set(id, lobby);
      return send(response, 201, { lobbyId: id, inviteCode: lobby.inviteCode, lobby: publicLobby(lobby) });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/join') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (lobby.started) return send(response, 409, { error: 'Game already started' });
      const playerId = cleanText(body.playerId, randomUUID(), 100);
      if (!lobby.players.some((player) => player.id === playerId)) {
        if (lobby.players.length >= lobby.maxPlayers) return send(response, 409, { error: 'Lobby is full' });
        lobby.players.push({
          id: playerId,
          name: cleanText(body.playerName, 'Player', 24),
          host: false,
          isBot: body.isBot === true,
          ready: body.isBot === true,
          connected: true,
          lastSeen: Date.now(),
          user: request.user || null,
          userId: request.user?.id || null,
        });
      } else if (request.user) {
        const player = lobby.players.find((entry) => entry.id === playerId);
        player.user = request.user;
        player.userId = request.user.id;
      }
      lobby.updatedAt = Date.now();
      return send(response, 200, { lobby: publicLobby(lobby) });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/start') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (String(body.hostId || '') !== lobby.hostId) return send(response, 403, { error: 'Only the host can start' });
      lobby.started = true;
      lobby.status = 'started';
      lobby.updatedAt = Date.now();
      lobby.players.forEach((player) => {
        if (!player.isBot) {
          player.connected = true;
          player.lastSeen = Date.now();
        }
      });
      return send(response, 200, { started: true, lobby: publicLobby(lobby) });
    }

    if (request.method === 'POST' && url.pathname === '/api/game/state') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== body.hostId) return send(response, 403, { error: 'Only the host can publish game state' });
      if (!lobby.started) return send(response, 409, { error: 'Lobby has not started' });
      lobby.gameState = body.state && typeof body.state === 'object' ? body.state : null;
      lobby.gameStateVersion = Math.max(lobby.gameStateVersion + 1, Number(body.version) || 0);
      lobby.updatedAt = Date.now();
      return send(response, 200, { ok: true, version: lobby.gameStateVersion });
    }

    if (request.method === 'GET' && url.pathname === '/api/game/state') {
      const lobby = lobbies.get(String(url.searchParams.get('lobbyId') || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      return send(response, 200, { version: lobby.gameStateVersion || 0, state: lobby.gameState || null, hostId: lobby.hostId });
    }

    if (request.method === 'POST' && url.pathname === '/api/game/command') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (!lobby.players.some((player) => player.id === body.playerId && !player.isBot)) return send(response, 403, { error: 'Player is not in this lobby' });
      const command = body.command && typeof body.command === 'object' ? body.command : null;
      if (!command) return send(response, 400, { error: 'Invalid command' });
      lobby.gameCommands.push({ id: randomUUID(), playerId: body.playerId, command, createdAt: Date.now() });
      if (lobby.gameCommands.length > 100) lobby.gameCommands.splice(0, lobby.gameCommands.length - 100);
      return send(response, 202, { queued: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/game/commands/drain') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== body.hostId) return send(response, 403, { error: 'Only the host can drain commands' });
      const commands = lobby.gameCommands.splice(0);
      return send(response, 200, { commands });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/heartbeat') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (String(body.hostId || '') !== lobby.hostId) return send(response, 403, { error: 'Only the host can maintain this lobby' });
      lobby.lastHeartbeat = Date.now();
      return send(response, 200, { ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/leave') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 200, { removed: false });
      if (String(body.hostId || '') !== lobby.hostId) return send(response, 403, { error: 'Only the host can close this lobby' });
      if (lobby.started) {
        markPlayerDisconnected(lobby, body.hostId);
        const nextHost = promoteLobbyHost(lobby, body.hostId);
        if (nextHost) return send(response, 200, { removed: false, migrated: true, hostId: nextHost.id, lobby: publicLobby(lobby) });
      }
      lobbies.delete(lobby.id);
      return send(response, 200, { removed: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/presence') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      const player = lobby.players.find((entry) => entry.id === body.playerId && !entry.isBot);
      if (!player) return send(response, 404, { error: 'Player not found' });
      player.connected = true;
      player.lastSeen = Date.now();
      if (request.user) {
        player.user = request.user;
        player.userId = request.user.id;
      }
      return send(response, 200, { ok: true, hostId: lobby.hostId });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/ready') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      const player = lobby.players.find((entry) => entry.id === body.playerId && entry.id !== lobby.hostId);
      if (!player) return send(response, 404, { error: 'Guest not found' });
      player.ready = body.ready === true;
      lobby.updatedAt = Date.now();
      return send(response, 200, { success: true, lobby: publicLobby(lobby) });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/player') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      const player = lobby.players.find((entry) => entry.id === body.playerId && !entry.isBot);
      if (!player) return send(response, 404, { error: 'Player not found' });
      player.name = cleanText(body.name, player.name || 'Player', 20);
      player.factionIndex = Math.max(0, Math.min(7, Number(body.factionIndex) || 0));
      player.party = cleanText(body.party, 'Party', 28);
      player.leader = cleanText(body.leader, 'Leader', 28);
      player.color = /^#[0-9a-f]{3,8}$/i.test(String(body.color || '')) ? String(body.color) : '#34ff86';
      player.leaderProfile = cleanLeaderProfile(body.leaderProfile);
      lobby.updatedAt = Date.now();
      return send(response, 200, { success: true, lobby: publicLobby(lobby) });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/bot/remove') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== body.hostId) return send(response, 403, { error: 'Only the host can remove bots' });
      const botIndex = lobby.players.findIndex((player) => player.id === body.botId && player.isBot === true);
      if (botIndex < 0) return send(response, 404, { error: 'Bot not found' });
      lobby.players.splice(botIndex, 1);
      lobby.updatedAt = Date.now();
      return send(response, 200, { success: true, lobby: publicLobby(lobby) });
    }

    if (request.method === 'POST' && url.pathname === '/api/lobby/settings') {
      const body = await readJson(request);
      const lobby = lobbies.get(String(body.lobbyId || ''));
      if (!lobby) return send(response, 404, { error: 'Lobby not found' });
      if (lobby.hostId !== body.hostId) return send(response, 403, { error: 'Only the host can update settings' });
      lobby.mode = body.mode === 'majority50' ? 'majority50' : 'campaign100';
      lobby.difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : lobby.difficulty;
      lobby.maxPlayers = Math.max(lobby.players.length, Math.min(5, Number(body.maxPlayers) || lobby.maxPlayers));
      lobby.updatedAt = Date.now();
      return send(response, 200, { success: true, lobby: publicLobby(lobby) });
    }

    // Compatibility routes used by multiplayer-server.js.
    if (request.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(request);
      const player = { id: cleanText(body.id, randomUUID(), 100), name: cleanText(body.name, 'Player', 24), x: 0, y: 0, user: request.user || null, userId: request.user?.id || null };
      worldPlayers.set(player.id, player);
      return send(response, 200, player);
    }
    if (request.method === 'POST' && url.pathname === '/api/move') {
      const body = await readJson(request);
      const player = worldPlayers.get(String(body.id || ''));
      if (!player) return send(response, 404, { error: 'Player not found' });
      player.x = Number(body.x) || 0;
      player.y = Number(body.y) || 0;
      return send(response, 200, player);
    }
    if (request.method === 'GET' && url.pathname === '/api/players') {
      return send(response, 200, [...worldPlayers.values()]);
    }

    return send(response, 404, { error: 'Route not found' });
  } catch (error) {
    console.error(error);
    return send(response, 400, { error: 'Invalid request' });
  }
});

setInterval(pruneLobbies, 2_000).unref();
initDb()
  .then(() => {
    server.listen(PORT, () => console.log(`RIGGED lobby server listening on http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Could not initialize database:', error);
    process.exit(1);
  });
