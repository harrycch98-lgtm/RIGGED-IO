// Server multiplayer bridge. Local pages use the bundled test server;
// production uses the RIGGED API host.
const BACKEND_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://localhost:3001'
  : 'https://api.riggedio.com:3000';

const SERVER_PLAYER_ID_KEY = 'riggedServerPlayerId';
const SERVER_PLAYER_NAME_KEY = 'riggedServerPlayerName';

let playerId = sessionStorage.getItem(SERVER_PLAYER_ID_KEY);
if (!playerId) {
  playerId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(SERVER_PLAYER_ID_KEY, playerId);
}

let playerPollTimer = null;

function isBackendConfigured() {
  return !!BACKEND_URL;
}

async function requestJson(path, options = {}) {
  if (!isBackendConfigured()) {
    console.warn('Server multiplayer backend is not configured yet. Update BACKEND_URL in multiplayer-server.js.');
    return null;
  }

  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function joinGame(playerName) {
  const safeName = playerName || sessionStorage.getItem(SERVER_PLAYER_NAME_KEY) || 'Player';
  sessionStorage.setItem(SERVER_PLAYER_NAME_KEY, safeName);

  try {
    const data = await requestJson('/api/join', {
      method: 'POST',
      body: JSON.stringify({ name: safeName, id: playerId })
    });
    console.log('Joined:', data);
    return data;
  } catch (error) {
    console.error('Could not join backend multiplayer game:', error);
    return null;
  }
}

async function updatePosition(x, y) {
  try {
    return await requestJson('/api/move', {
      method: 'POST',
      body: JSON.stringify({ id: playerId, x, y })
    });
  } catch (error) {
    console.error('Could not update backend multiplayer position:', error);
    return null;
  }
}

async function getOtherPlayers() {
  try {
    const players = await requestJson('/api/players');
    console.log('Players:', players);
    return Array.isArray(players) ? players.filter((player) => player.id !== playerId) : [];
  } catch (error) {
    console.error('Could not load backend multiplayer players:', error);
    return [];
  }
}

function pollPlayers(intervalMs = 1000) {
  stopPolling();
  playerPollTimer = window.setInterval(async () => {
    const players = await getOtherPlayers();
    window.dispatchEvent(new CustomEvent('rigged:serverPlayers', { detail: players }));
  }, intervalMs);
}

function stopPolling() {
  if (playerPollTimer) {
    window.clearInterval(playerPollTimer);
    playerPollTimer = null;
  }
}

window.RiggedServerMultiplayer = {
  BACKEND_URL,
  playerId,
  joinGame,
  updatePosition,
  getOtherPlayers,
  pollPlayers,
  stopPolling,
  isBackendConfigured
};

window.joinGame = joinGame;
window.updatePosition = updatePosition;
window.getOtherPlayers = getOtherPlayers;

window.addEventListener('load', () => {
  console.log('Server multiplayer bridge ready:', BACKEND_URL);
});
