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

  const started = await request('/api/lobby/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, hostId: `public-host-${suffix}` }),
  });
  assert.equal(started.started, true);
  browsable = await request('/api/lobbies?public=1');
  assert.ok(!browsable.some((lobby) => lobby.id === publicLobby.lobbyId), 'started lobby must leave the browser');

  console.log('PASS: named public lobby appears in browser');
  console.log('PASS: private lobby stays hidden');
  console.log('PASS: guest joins the selected public lobby');
  console.log('PASS: started lobby leaves the public list');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

