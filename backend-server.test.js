const assert = require('assert/strict');

const base = process.env.TEST_BACKEND_URL || 'http://localhost:3001';

async function request(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const data = await response.json();
  assert.ok(response.ok, `${path} returned ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function create(body) {
  return request('/api/lobby/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

(async () => {
  const suffix = Date.now().toString(36);
  const publicLobby = await create({
    hostId: `public-host-${suffix}`,
    hostName: 'Host',
    lobbyName: `Election Night ${suffix}`,
    isPublic: true,
    mode: 'campaign100',
    difficulty: 'hard',
    maxPlayers: 4,
  });
  const privateLobby = await create({
    hostId: `private-host-${suffix}`,
    hostName: 'Host',
    lobbyName: `Secret Strategy ${suffix}`,
    isPublic: false,
    mode: 'majority50',
    difficulty: 'easy',
    maxPlayers: 3,
  });

  let browsable = await request('/api/lobbies?public=1');
  const listed = browsable.find((lobby) => lobby.id === publicLobby.lobbyId);
  assert.ok(listed, 'public lobby should be listed');
  assert.equal(listed.lobbyName, `Election Night ${suffix}`);
  assert.equal(listed.isPublic, true);
  assert.ok(!browsable.some((lobby) => lobby.id === privateLobby.lobbyId), 'private lobby must not be listed');

  const joined = await request('/api/lobby/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: `guest-${suffix}`, playerName: 'Player' }),
  });
  assert.equal(joined.lobby.players.length, 2, 'guest should join the public lobby');

  let readyUpdate = await request('/api/lobby/ready', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: `guest-${suffix}`, ready: true }),
  });
  assert.equal(readyUpdate.lobby.players.find((player) => player.id === `guest-${suffix}`).ready, true, 'guest ready should be visible');
  readyUpdate = await request('/api/lobby/ready', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: `guest-${suffix}`, ready: false }),
  });
  assert.equal(readyUpdate.lobby.players.find((player) => player.id === `guest-${suffix}`).ready, false, 'cancel ready should clear status');

  const settingsUpdate = await request('/api/lobby/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobbyId: publicLobby.lobbyId,
      hostId: `public-host-${suffix}`,
      mode: 'majority50',
      difficulty: 'medium',
      maxPlayers: 5,
    }),
  });
  assert.equal(settingsUpdate.lobby.mode, 'majority50');
  assert.equal(settingsUpdate.lobby.difficulty, 'medium');
  assert.equal(settingsUpdate.lobby.maxPlayers, 5);
  const refreshedSettings = (await request('/api/lobbies')).find((lobby) => lobby.id === publicLobby.lobbyId);
  assert.equal(refreshedSettings.mode, 'majority50', 'guest polling should receive host mode');
  assert.equal(refreshedSettings.difficulty, 'medium', 'guest polling should receive host difficulty');
  assert.equal(refreshedSettings.maxPlayers, 5, 'guest polling should receive host player count');

  const started = await request('/api/lobby/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, hostId: `public-host-${suffix}` }),
  });
  assert.equal(started.started, true);
  browsable = await request('/api/lobbies?public=1');
  assert.ok(!browsable.some((lobby) => lobby.id === publicLobby.lobbyId), 'started lobby must leave the browser');

  const closingLobby = await create({
    hostId: `closing-host-${suffix}`,
    hostName: 'Host',
    lobbyName: `Closing Test ${suffix}`,
    isPublic: true,
    maxPlayers: 4,
  });
  const heartbeat = await request('/api/lobby/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: closingLobby.lobbyId, hostId: `closing-host-${suffix}` }),
  });
  assert.equal(heartbeat.ok, true, 'host heartbeat should keep the lobby alive');
  const left = await request('/api/lobby/leave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: closingLobby.lobbyId, hostId: `closing-host-${suffix}` }),
  });
  assert.equal(left.removed, true, 'host leaving should remove the lobby');
  browsable = await request('/api/lobbies?public=1');
  assert.ok(!browsable.some((lobby) => lobby.id === closingLobby.lobbyId), 'closed host lobby must leave the browser');

  console.log('PASS: named public lobby appears in browser');
  console.log('PASS: private lobby stays hidden');
  console.log('PASS: guest joins the selected public lobby');
  console.log('PASS: guest ready status appears and clears');
  console.log('PASS: host settings persist for guest polling');
  console.log('PASS: started lobby leaves the public list');
  console.log('PASS: host heartbeat is accepted');
  console.log('PASS: closing host removes public lobby');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
