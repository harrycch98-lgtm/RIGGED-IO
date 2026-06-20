// Minimal RIGGED multiplayer lobby service for local testing and deployment.
// Run with: node backend-server.js
const http = require('http');
const { randomBytes, randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 3001);
const LOBBY_HEARTBEAT_TIMEOUT = 20_000;
const lobbies = new Map();
const worldPlayers = new Map();

function send(response, status, value) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) request.destroy();
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
  return {
    ...lobby,
    players: lobby.players.map((player) => ({ ...player })),
  };
}

function pruneLobbies() {
  const expiry = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, lobby] of lobbies) {
    const heartbeatExpired = !lobby.started && Date.now() - (lobby.lastHeartbeat || lobby.updatedAt) > LOBBY_HEARTBEAT_TIMEOUT;
    if (lobby.updatedAt < expiry || heartbeatExpired) lobbies.delete(id);
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { ok: true, lobbies: lobbies.size });
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
        players: [{ id: hostId, name: hostName, host: true, isBot: false, ready: true }],
        started: false,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        lastHeartbeat: now,
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
        });
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
      setTimeout(() => lobbies.delete(lobby.id), 120_000).unref();
      return send(response, 200, { started: true, lobby: publicLobby(lobby) });
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
      lobbies.delete(lobby.id);
      return send(response, 200, { removed: true });
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
      player.factionIndex = Math.max(0, Math.min(7, Number(body.factionIndex) || 0));
      player.party = cleanText(body.party, 'Party', 28);
      player.leader = cleanText(body.leader, 'Leader', 28);
      player.color = /^#[0-9a-f]{3,8}$/i.test(String(body.color || '')) ? String(body.color) : '#34ff86';
      player.leaderProfile = cleanLeaderProfile(body.leaderProfile);
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
      const player = { id: cleanText(body.id, randomUUID(), 100), name: cleanText(body.name, 'Player', 24), x: 0, y: 0 };
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

server.listen(PORT, () => console.log(`RIGGED lobby server listening on http://localhost:${PORT}`));
