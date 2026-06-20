const http = require('http');

const PORT = process.env.PORT || 3001;
const players = new Map();

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function cleanOldPlayers() {
  const now = Date.now();
  for (const [id, player] of players) {
    if (now - player.updatedAt > 30000) {
      players.delete(id);
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  try {
    if (req.method === 'POST' && req.url === '/api/join') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const name = String(body.name || 'Player').slice(0, 32);
      if (!id) {
        sendJson(res, 400, { error: 'Missing player id' });
        return;
      }

      const existing = players.get(id) || {};
      const player = {
        id,
        name,
        x: Number(existing.x || 0),
        y: Number(existing.y || 0),
        joinedAt: existing.joinedAt || Date.now(),
        updatedAt: Date.now()
      };
      players.set(id, player);
      sendJson(res, 200, { ok: true, player, players: Array.from(players.values()) });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/move') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id || !players.has(id)) {
        sendJson(res, 404, { error: 'Player has not joined yet' });
        return;
      }

      const player = players.get(id);
      player.x = Number(body.x || 0);
      player.y = Number(body.y || 0);
      player.updatedAt = Date.now();
      players.set(id, player);
      sendJson(res, 200, { ok: true, player });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/players') {
      cleanOldPlayers();
      sendJson(res, 200, Array.from(players.values()));
      return;
    }

    sendJson(res, 404, { error: 'Route not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`RIGGED backend multiplayer server running on http://localhost:${PORT}`);
});
