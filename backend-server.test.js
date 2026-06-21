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
  assert.match(publicLobby.inviteCode, /^[A-Z0-9]{6}$/, 'creating a lobby should return a visible invite code');

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

  const selectionUpdate = await request('/api/lobby/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobbyId: publicLobby.lobbyId,
      playerId: `guest-${suffix}`,
      factionIndex: 2,
      party: 'Verdant',
      leader: 'Elena Park',
      color: '#00FF66',
      leaderProfile: { skin: '#c98f68', hairstyle: 'charmer', facialHair: 'none', hat: 'none', flag: 'green_laurel' },
    }),
  });
  const selectedGuest = selectionUpdate.lobby.players.find((player) => player.id === `guest-${suffix}`);
  assert.equal(selectedGuest.factionIndex, 2, 'leader faction should be shared');
  assert.equal(selectedGuest.leader, 'Elena Park', 'leader identity should be shared');
  assert.equal(selectedGuest.leaderProfile.flag, 'green_laurel', 'leader appearance should be shared');
  let observerLobby = (await request('/api/lobbies')).find((lobby) => lobby.id === publicLobby.lobbyId);
  let observedGuest = observerLobby.players.find((player) => player.id === `guest-${suffix}`);
  assert.equal(observedGuest.party, 'Verdant', 'another polling client should see the changed party name');
  assert.equal(observedGuest.leader, 'Elena Park', 'another polling client should see the changed leader');
  assert.equal(observedGuest.leaderProfile.flag, 'green_laurel', 'another polling client should see the changed portrait');

  const botId = `bot-${suffix}`;
  const botJoin = await request('/api/lobby/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: botId, playerName: 'Bot 1', isBot: true }),
  });
  assert.ok(botJoin.lobby.players.some((player) => player.id === botId && player.isBot), 'bot should occupy a lobby slot');
  observerLobby = (await request('/api/lobbies')).find((lobby) => lobby.id === publicLobby.lobbyId);
  assert.ok(observerLobby.players.some((player) => player.id === botId && player.isBot), 'another polling client should see the added bot');
  const botRemoval = await request('/api/lobby/bot/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, hostId: `public-host-${suffix}`, botId }),
  });
  assert.ok(!botRemoval.lobby.players.some((player) => player.id === botId), 'host should be able to reopen a bot slot');
  observerLobby = (await request('/api/lobbies')).find((lobby) => lobby.id === publicLobby.lobbyId);
  assert.ok(!observerLobby.players.some((player) => player.id === botId), 'another polling client should see the reopened slot');

  let readyUpdate = await request('/api/lobby/ready', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: `guest-${suffix}`, ready: true }),
  });
  assert.equal(readyUpdate.lobby.players.find((player) => player.id === `guest-${suffix}`).ready, true, 'guest ready should be visible');
  observerLobby = (await request('/api/lobbies')).find((lobby) => lobby.id === publicLobby.lobbyId);
  observedGuest = observerLobby.players.find((player) => player.id === `guest-${suffix}`);
  assert.equal(observedGuest.ready, true, 'another polling client should see the ready highlight');
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
  const publishedState = await request('/api/game/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobbyId: publicLobby.lobbyId,
      hostId: `public-host-${suffix}`,
      version: 1,
      state: {
        elapsed: 12.5,
        players: [{ cash: 15000, action: { type: 'speech', state: 4, decoyState: 9, left: 12, total: 20, speechRateMult: 2 } }],
        states: [{ influence: [10, 5] }],
        latestAssassinationEvent: { id: 1, assassinId: 0, targetId: 1, stateIndex: 4, playAt: 1234567890 },
        latestBroadcastEvent: { id: 3, channelIndex: 2, subtitle: 'Synchronized bulletin' },
        matchOver: true,
        matchResult: { id: 1, winnerId: 0, reason: 'test victory' },
      },
    }),
  });
  assert.equal(publishedState.ok, true, 'host should publish authoritative gameplay state');
  const observedState = await request(`/api/game/state?lobbyId=${publicLobby.lobbyId}`);
  assert.equal(observedState.version, 1, 'guest should receive the latest gameplay version');
  assert.equal(observedState.state.elapsed, 12.5, 'guest should receive the same gameplay timer');
  assert.equal(observedState.state.players[0].action.decoyState, 9, 'guest should receive the synchronized speech decoy state');
  assert.equal(observedState.state.players[0].action.speechRateMult, 2, 'guest should receive the synchronized accelerated speech rate');
  assert.deepEqual(observedState.state.latestAssassinationEvent, { id: 1, assassinId: 0, targetId: 1, stateIndex: 4, playAt: 1234567890 }, 'guest should receive the scheduled assassination animation event');
  assert.deepEqual(observedState.state.latestBroadcastEvent, { id: 3, channelIndex: 2, subtitle: 'Synchronized bulletin' }, 'guest should receive the synchronized news broadcast');
  assert.deepEqual(observedState.state.matchResult, { id: 1, winnerId: 0, reason: 'test victory' }, 'guest should receive the synchronized ending result');
  await request('/api/game/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: `guest-${suffix}`, command: { type: 'buyChannel', args: [2] } }),
  });
  const drained = await request('/api/game/commands/drain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, hostId: `public-host-${suffix}` }),
  });
  assert.equal(drained.commands.length, 1, 'host should receive queued guest actions');
  assert.equal(drained.commands[0].command.type, 'buyChannel');
  await request('/api/lobby/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, playerId: `guest-${suffix}` }),
  });
  const migrated = await request('/api/lobby/leave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId: publicLobby.lobbyId, hostId: `public-host-${suffix}` }),
  });
  assert.equal(migrated.migrated, true, 'a started match should migrate instead of closing when its host leaves');
  assert.equal(migrated.hostId, `guest-${suffix}`, 'the next connected human should become host');
  const continuedState = await request('/api/game/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lobbyId: publicLobby.lobbyId,
      hostId: `guest-${suffix}`,
      version: 2,
      state: { ...observedState.state, elapsed: 13.5 },
    }),
  });
  assert.equal(continuedState.ok, true, 'the promoted host should continue authoritative state publishing');
  const migratedObservation = await request(`/api/game/state?lobbyId=${publicLobby.lobbyId}`);
  assert.equal(migratedObservation.hostId, `guest-${suffix}`, 'all clients should observe the migrated host id');
  assert.equal(migratedObservation.state.elapsed, 13.5, 'the match should continue from the shared snapshot');
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
  console.log('PASS: live leader selection persists for lobby polling');
  console.log('PASS: host can change a bot back to an open slot');
  console.log('PASS: independent lobby observers see all lineup changes');
  console.log('PASS: guest ready status appears and clears');
  console.log('PASS: host settings persist for guest polling');
  console.log('PASS: started lobby leaves the public list');
  console.log('PASS: authoritative gameplay state and guest commands synchronize');
  console.log('PASS: next connected player becomes host and continues the match');
  console.log('PASS: host heartbeat is accepted');
  console.log('PASS: closing host removes public lobby');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
