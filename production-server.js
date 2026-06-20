const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');

const PORT = 3000;
const players = new Map();
const lobbies = new Map();
let lobbyIdCounter = 1000;
const LOBBY_HEARTBEAT_TIMEOUT = 20000;

const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/api.riggedio.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/api.riggedio.com/fullchain.pem')
};

const server = https.createServer(options, handleHttp);
const wss = new WebSocket.Server({ server });

function handleHttp(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, 'https://api.riggedio.com');

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
        players: [{ id: data.hostId, name: data.hostDisplayName || 'Host', host: true }],
        maxPlayers: parseInt(data.maxPlayers) || 4,
        createdAt: now,
        updatedAt: now,
        lastHeartbeat: now,
        started: false,
        status: 'open',
        inviteCode: inviteCode
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
    const openLobbies = Array.from(lobbies.values()).filter(l =>
      !l.started && l.players.length < l.maxPlayers && (!publicOnly || l.isPublic)
    );
    console.log('Returning lobbies:', openLobbies.length);
    sendJson(res, 200, openLobbies);
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
      if (lobby.players.length >= lobby.maxPlayers) {
        sendJson(res, 400, { error: 'Lobby full' });
        return;
      }
      if (!lobby.players.some(player => player.id === data.playerId)) {
        lobby.players.push({ id: data.playerId, name: data.playerName, isBot: data.isBot === true });
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
      lobby.started = true;
      lobby.status = 'started';
      lobby.updatedAt = Date.now();
      console.log('Game started');
      sendJson(res, 200, { success: true, lobby });
      setTimeout(() => lobbies.delete(lobby.id), 120000).unref();
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
      lobbies.delete(lobby.id);
      console.log('Host closed lobby:', lobby.id);
      sendJson(res, 200, { removed: true });
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function readRequestJson(req, res, onData) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) req.destroy();
  });
  req.on('end', () => {
    try {
      onData(JSON.parse(body || '{}'));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
    }
  });
}

function pruneAbandonedLobbies() {
  const now = Date.now();
  for (const [id, lobby] of lobbies) {
    if (!lobby.started && now - (lobby.lastHeartbeat || lobby.createdAt) > LOBBY_HEARTBEAT_TIMEOUT) {
      lobbies.delete(id);
      console.log('Removed abandoned lobby:', id);
    }
  }
}

setInterval(pruneAbandonedLobbies, 5000).unref();

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

wss.on('connection', (ws) => {
  console.log('Player connected');
  let playerId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'join') {
        playerId = msg.id;
        players.set(playerId, { id: playerId, name: msg.name, x: msg.x || 0, y: msg.y || 0 });
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

server.listen(PORT, () => console.log(`🎮 RIGGED live on wss://api.riggedio.com:${PORT}`));
