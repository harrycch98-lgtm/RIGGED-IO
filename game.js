(() => {
  "use strict";

  let HUMAN = 0;
  
  // ===== WEBSOCKET MULTIPLAYER INTEGRATION =====
  const LOCAL_MULTIPLAYER = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const REST_BACKEND_URL = LOCAL_MULTIPLAYER ? 'http://localhost:3001' : 'https://api.riggedio.com:3000';
  const BACKEND_URL = LOCAL_MULTIPLAYER ? 'ws://localhost:3001' : 'wss://api.riggedio.com:3000';
  const NETWORK_PAUSE_X = -987654321;
  let ws = null;
  let playerId = null;
  let lastPositionSync = 0;
  let localPauseRequested = false;
  const POSITION_SYNC_INTERVAL = 100; // ms

  async function lobbyFetch(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function networkRoomSignal() {
    const room = String(currentLobby?.id || `solo-${playerId || currentPlayerId}`);
    let hash = 17;
    for (let index = 0; index < room.length; index += 1) hash = (hash * 31 + room.charCodeAt(index)) | 0;
    return Math.abs(hash) || 1;
  }

  function initWebSocket() {
    try {
      ws = new WebSocket(BACKEND_URL);
      
      ws.onopen = () => {
        console.log('✓ Connected to multiplayer server');
        if (playerId) joinGame();
      };
      
      ws.onmessage = (event) => {
        try {
          const allPlayers = JSON.parse(event.data);
          syncRemotePlayers(allPlayers);
        } catch (error) {
          console.error('Error parsing player data:', error);
        }
      };
      
      ws.onerror = (error) => {
        console.error('✗ WebSocket error:', error);
      };
      
      ws.onclose = () => {
        console.log('Disconnected. Reconnecting in 3s...');
        setTimeout(initWebSocket, 3000);
      };
    } catch (error) {
      console.error('Failed to connect to backend:', error);
    }
  }

  function joinGame() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const humanPlayer = players[HUMAN];
      ws.send(JSON.stringify({
        type: 'join',
        id: playerId,
        name: humanPlayer?.leader || 'Player',
        x: localPauseRequested ? NETWORK_PAUSE_X : (humanPlayer?.x || 0),
        y: localPauseRequested ? networkRoomSignal() : (humanPlayer?.y || 0)
      }));
    }
  }

  function updatePlayerPosition() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !playerId) return;
    const now = Date.now();
    if (now - lastPositionSync < POSITION_SYNC_INTERVAL) return;
    
    const humanPlayer = players[HUMAN];
    if (humanPlayer) {
      ws.send(JSON.stringify({
        type: 'move',
        id: playerId,
        x: localPauseRequested ? NETWORK_PAUSE_X : (humanPlayer.x || 0),
        y: localPauseRequested ? networkRoomSignal() : (humanPlayer.y || 0)
      }));
      lastPositionSync = now;
    }
  }

  function syncRemotePlayers(allPlayers) {
    if (!Array.isArray(allPlayers)) return;

    const roomSignal = networkRoomSignal();
    const pauseOwners = allPlayers.filter((serverPlayer) =>
      serverPlayer.x === NETWORK_PAUSE_X && serverPlayer.y === roomSignal
    );
    const networkPaused = pauseOwners.length > 0;
    if (paused !== networkPaused) {
      paused = networkPaused;
      updateUi(true);
    }
    if (pauseButton) {
      const localOwnsPause = pauseOwners.some((serverPlayer) => serverPlayer.id === playerId);
      if (localOwnsPause) pauseButton.textContent = 'Resume Everyone';
      else if (networkPaused) pauseButton.textContent = `Paused by ${pauseOwners[0].name || 'Player'}`;
      else pauseButton.textContent = 'Pause';
      pauseButton.disabled = networkPaused && !localOwnsPause;
    }
    
    for (const serverPlayer of allPlayers) {
      if (serverPlayer.id === playerId) continue;
      
      const localPlayer = players.find(p => p.id === serverPlayer.id);
      if (localPlayer) {
        localPlayer.x = serverPlayer.x || 0;
        localPlayer.y = serverPlayer.y || 0;
      }
    }
  }
  // ===== LOBBY SYSTEM =====
  let currentLobby = null;
  let currentPlayerId = Math.random().toString(36).substr(2, 9);
  let serverLobbyPollTimer = null;
  let publicLobbyPollTimer = null;
  let serverLobbyHeartbeatTimer = null;
  let serverLobbySettingsQueue = Promise.resolve();
  let serverLobbyPlayerUpdateTimer = null;
  let lastCrazyServerJoinable = null;
  let gameStatePublishTimer = null;
  let gameStatePollTimer = null;
  let gameCommandPollTimer = null;
  let gameStateVersion = 0;
  let gameStatePublishPending = false;
  let gameStatePollPending = false;
  let gameCommandDrainPending = false;
  let applyingRemoteGameCommand = false;

  function stopPublicLobbyPolling() {
    if (publicLobbyPollTimer) window.clearInterval(publicLobbyPollTimer);
    publicLobbyPollTimer = null;
  }

  function stopServerLobbyHeartbeat() {
    if (serverLobbyHeartbeatTimer) window.clearInterval(serverLobbyHeartbeatTimer);
    serverLobbyHeartbeatTimer = null;
  }

  function sendServerLobbyHeartbeat() {
    if (!window.isServerLobbyHost || !currentLobby?.id) return;
    fetch(`${REST_BACKEND_URL}/api/lobby/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lobbyId: currentLobby.id, hostId: currentPlayerId }),
      keepalive: true,
    }).catch(() => {});
  }

  function startServerLobbyHeartbeat() {
    stopServerLobbyHeartbeat();
    lastCrazyServerJoinable = null;
    sendServerLobbyHeartbeat();
    serverLobbyHeartbeatTimer = window.setInterval(sendServerLobbyHeartbeat, 5000);
  }

  function leaveHostedServerLobby() {
    if (!window.isServerLobbyHost || !currentLobby?.id) return;
    const payload = JSON.stringify({ lobbyId: currentLobby.id, hostId: currentPlayerId });
    try {
      // text/plain avoids a CORS preflight that may not finish while the tab closes.
      navigator.sendBeacon(`${REST_BACKEND_URL}/api/lobby/leave`, new Blob([payload], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      fetch(`${REST_BACKEND_URL}/api/lobby/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
    stopServerLobbyHeartbeat();
    lastCrazyServerJoinable = null;
    try {
      getCrazyGameSdk()?.leftRoom?.();
    } catch {
      // The platform SDK may already be unloading with the page.
    }
  }

  function normalizedInviteCode(value) {
    return String(value || '').trim().toUpperCase().replace(/^RIGGED-/, '');
  }

  const LOBBY_METADATA_PREFIX = 'RIGGED_LOBBY:';

  function encodedLobbyHostName(hostName, lobbyName, isPublic) {
    return `${LOBBY_METADATA_PREFIX}${isPublic ? 'PUBLIC' : 'PRIVATE'}:${encodeURIComponent(lobbyName)}:${encodeURIComponent(hostName)}`;
  }

  function lobbyMetadata(value) {
    const text = String(value || '');
    if (!text.startsWith(LOBBY_METADATA_PREFIX)) return null;
    const parts = text.slice(LOBBY_METADATA_PREFIX.length).split(':');
    if (parts.length < 3 || !['PUBLIC', 'PRIVATE'].includes(parts[0])) return null;
    try {
      return {
        isPublic: parts[0] === 'PUBLIC',
        lobbyName: decodeURIComponent(parts[1]) || 'Untitled Lobby',
        hostName: decodeURIComponent(parts.slice(2).join(':')) || 'Host',
      };
    } catch {
      return null;
    }
  }

  function normalizeServerLobby(lobby, fallback = {}) {
    const source = lobby || {};
    const sourcePlayers = Array.isArray(source.players) ? source.players : (Array.isArray(fallback.players) ? fallback.players : []);
    const metadata = lobbyMetadata(source.hostName) || lobbyMetadata(sourcePlayers[0]?.name) || lobbyMetadata(fallback.hostName);
    const explicitPublic = source.isPublic === true || source.isPublic === 1 || String(source.isPublic || '').toLowerCase() === 'true' ||
      source.public === true || source.public === 1 || String(source.public || '').toLowerCase() === 'true' ||
      String(source.visibility || '').toLowerCase() === 'public';
    const explicitPrivate = source.isPublic === false || source.isPublic === 0 || String(source.isPublic || '').toLowerCase() === 'false' ||
      String(source.visibility || '').toLowerCase() === 'private';
    return {
      ...fallback,
      ...source,
      id: source.id || source.lobbyId || fallback.id || fallback.lobbyId || '',
      inviteCode: source.inviteCode || fallback.inviteCode || '',
      maxPlayers: Number(source.maxPlayers || fallback.maxPlayers || 4),
      lobbyName: source.lobbyName || metadata?.lobbyName || fallback.lobbyName || 'Untitled Lobby',
      isPublic: explicitPublic || (!explicitPrivate && (metadata?.isPublic === true || fallback.isPublic === true)),
      hostName: metadata?.hostName || source.hostName || fallback.hostName || 'Host',
      players: sourcePlayers.map((player, index) => {
        const playerMetadata = lobbyMetadata(player.name || player.playerName);
        if (!playerMetadata) return player;
        return { ...player, name: index === 0 ? playerMetadata.hostName : (player.name || player.playerName) };
      }),
    };
  }

  function serverLobbyRosterHtml(lobby) {
    const normalized = normalizeServerLobby(lobby);
    const players = normalized.players;
    const rows = players.length
      ? players.map((player, index) => {
          const name = player.name || player.playerName || (index === 0 ? 'Host' : `Player ${index + 1}`);
          const hostBadge = player.host || player.id === normalized.hostId || index === 0 ? ' <span style="color:#34ff86">(HOST)</span>' : '';
          const readyBadge = !hostBadge && player.ready ? ' <span style="color:#34ff86">READY</span>' : '';
          return `<div style="margin-top:9px;color:#bfffe0">${index + 1}. ${escapeHtml(name)}${hostBadge}${readyBadge}</div>`;
        }).join('')
      : '<div style="margin-top:9px;color:#aaa">Waiting for lobby roster…</div>';
    return `<strong style="color:#34ff86">PLAYERS ${players.length}/${normalized.maxPlayers}</strong>${rows}`;
  }

  function pendingHostLobbyRosterHtml() {
    const maxPlayers = Number(playerCountInput?.value || window.lobbySettings?.maxPlayers || 4);
    return serverLobbyRosterHtml({
      maxPlayers,
      hostId: currentPlayerId,
      players: [{ id: currentPlayerId, name: 'Host', host: true }],
    });
  }

  function isCurrentServerLobbyHost(lobby = currentLobby) {
    if (!lobby?.id) return window.isServerLobbyHost === true;
    const normalized = normalizeServerLobby(lobby);
    return window.isServerLobbyHost === true || normalized.hostId === currentPlayerId || normalized.players.some((player, index) => player.id === currentPlayerId && (player.host === true || index === 0));
  }

  function syncMainMenuAddBotButton() {
    if (!mainMenuAddBotButton) return;
    if (!currentLobby?.id) {
      mainMenuAddBotButton.hidden = false;
      mainMenuAddBotButton.disabled = false;
      mainMenuAddBotButton.textContent = 'Add Bot';
      mainMenuAddBotButton.title = 'Add an anonymous bot to the lobby';
      return;
    }
    const lobby = normalizeServerLobby(currentLobby);
    const isHost = isCurrentServerLobbyHost(lobby);
    if (isHost) window.isServerLobbyHost = true;
    const full = lobby.players.length >= lobby.maxPlayers;
    mainMenuAddBotButton.hidden = !isHost;
    mainMenuAddBotButton.disabled = !isHost || full;
    mainMenuAddBotButton.textContent = full ? 'Lobby Full' : 'Add Bot';
    mainMenuAddBotButton.title = full ? 'Open a bot slot before adding another bot' : 'Add an anonymous bot to the lobby';
  }

  function anonymousLobbyPortraitMarkup(label = 'Anonymous') {
    return `<span class="anonymous-leader-portrait" title="${escapeHtml(label)}"><svg viewBox="0 0 80 96" aria-hidden="true"><rect width="80" height="96" fill="#020c06"/><path d="M18 91V77c0-14 9-22 22-22s22 8 22 22v14" fill="#173324" stroke="#5f8a70" stroke-width="2"/><circle cx="40" cy="34" r="18" fill="#173324" stroke="#5f8a70" stroke-width="2"/><path d="M23 29c2-15 32-20 35 1v7H23z" fill="#0b1710"/><path d="M32 35h4m8 0h4" stroke="#75a383" stroke-width="3"/><path d="M34 46h12" stroke="#75a383" stroke-width="2"/></svg></span>`;
  }

  function lobbyLeaderPortraitMarkup(player, fallbackIndex = 0) {
    if (player.isBot) return anonymousLobbyPortraitMarkup('Anonymous bot');
    const factionIndex = Math.max(0, Math.min(FACTIONS.length - 1, Number(player.factionIndex ?? fallbackIndex) || 0));
    const faction = factionForMenu(factionIndex);
    const profile = player.leaderProfile ? normalizeLeaderProfile(player.leaderProfile) : null;
    const palette = faction.portrait;
    return `<span class="leader-portrait" style="--party:${faction.color};--skin:${profile?.skin || palette.skin};--hair:${palette.hair};--suit:${palette.suit};--accent:${palette.accent};display:block;overflow:hidden">${leaderPortraitSvg(factionIndex, profile)}</span>`;
  }

  function renderLobbyLeaderStrip() {
    const strip = document.getElementById('lobbyLeaderStrip');
    if (!strip || typeof FACTIONS === 'undefined') return;
    const pending = !currentLobby?.id;
    const lobby = pending
      ? { maxPlayers: Number(playerCountInput?.value || window.lobbySettings?.maxPlayers || 4), players: [{ id: currentPlayerId, name: 'Host', host: true, ready: false, factionIndex: selectedParty, leaderProfile: selectedLeaderProfile }] }
      : normalizeServerLobby(currentLobby);
    const slots = Array.from({ length: Math.max(1, Number(lobby.maxPlayers || 4)) }, (_, index) => lobby.players[index] || null);
    strip.innerHTML = slots.map((source, index) => {
      if (!source) return `<article class="lobby-leader-slot is-empty">${anonymousLobbyPortraitMarkup('Open player slot')}<span class="lobby-leader-party">No Party</span><span class="lobby-leader-name">Open Slot</span><span class="lobby-leader-state">Waiting</span></article>`;
      const player = { ...source };
      if (!player.isBot && player.id === currentPlayerId) {
        const faction = factionForMenu(selectedParty);
        Object.assign(player, { factionIndex: selectedParty, party: faction.name, leader: faction.leader, color: faction.color, leaderProfile: selectedLeaderProfile });
        player.ready = player.host ? true : multiplayerState.localReady;
      }
      player.isBot = player.isBot === true || /^Bot\b/i.test(player.name || player.playerName || '');
      const ready = player.isBot || player.host || player.ready === true;
      const factionIndex = Math.max(0, Math.min(FACTIONS.length - 1, Number(player.factionIndex) || 0));
      const faction = factionForMenu(factionIndex);
      const color = player.isBot ? '#789485' : (player.color || faction.color || '#34ff86');
      const name = player.isBot ? `Bot ${index + 1}` : (player.leader || faction.leader || player.name || `Player ${index + 1}`);
      const partyName = player.isBot ? 'Anonymous Party' : (player.party || faction.name || 'Unnamed Party');
      const role = player.isBot ? 'BOT' : player.host ? 'HOST' : ready ? 'READY' : 'PICKING';
      const stateClass = player.isBot ? 'is-bot' : ready ? 'is-ready' : 'is-picking';
      const botAction = player.isBot && isCurrentServerLobbyHost(lobby)
        ? `<button class="lobby-bot-open" type="button" data-remove-lobby-bot="${escapeHtml(player.id)}">Empty Slot</button>`
        : '';
      return `<article class="lobby-leader-slot ${stateClass}" style="--slot-color:${color}" title="${escapeHtml(partyName)}">${lobbyLeaderPortraitMarkup(player, factionIndex)}<span class="lobby-leader-party">${escapeHtml(partyName)}</span><span class="lobby-leader-name">${escapeHtml(name)}</span><span class="lobby-leader-state">${role}</span>${botAction}</article>`;
    }).join('');
  }

  async function removeBotFromServerLobby(botId) {
    if (!currentLobby?.id || !isCurrentServerLobbyHost() || !botId) return false;
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/bot/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: currentLobby.id, hostId: currentPlayerId, botId }),
      });
      if (res.status === 404) return rebuildLegacyLobbyWithoutBot(botId);
      if (!res.ok) throw new Error(`Bot removal failed: ${res.status}`);
      const data = await res.json();
      if (data.lobby) currentLobby = normalizeServerLobby(data.lobby, currentLobby);
      void syncServerLobbyWithCrazyGames({ showInviteButton: true });
      renderServerLobbyInMainMenu();
      showToast('Bot removed. The slot is open for a player.', 'compact');
      return true;
    } catch (error) {
      console.error(error);
      showToast('Could not open that bot slot.', 'compact');
      return false;
    }
  }

  async function rebuildLegacyLobbyWithoutBot(botId) {
    const previous = normalizeServerLobby(currentLobby);
    const humanGuests = previous.players.filter((player) => !player.isBot && player.id !== currentPlayerId);
    if (humanGuests.length) {
      showToast('The live lobby server must be updated before bots can be removed around connected guests.', 'compact');
      return false;
    }
    const botsToKeep = previous.players.filter((player) => player.isBot && player.id !== botId).length;
    const removedBot = previous.players.some((player) => player.id === botId && player.isBot);
    if (!removedBot) return false;
    try {
      const leaveRes = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: previous.id, hostId: currentPlayerId }),
      });
      if (!leaveRes.ok) throw new Error(`Legacy lobby close failed: ${leaveRes.status}`);
      stopServerLobbyPolling();
      stopServerLobbyHeartbeat();
      currentLobby = null;
      const result = await createLobby(
        'Host',
        previous.mode || matchModeInput?.value || 'campaign100',
        previous.difficulty || difficultyInput?.value || 'medium',
        previous.maxPlayers || Number(playerCountInput?.value || 4),
        previous.lobbyName || "Host's Lobby",
        previous.isPublic === true,
      );
      if (!result?.lobbyId) throw new Error('Replacement lobby creation failed');
      for (let index = 0; index < botsToKeep; index += 1) {
        const added = await addBotToServerLobby();
        if (!added) throw new Error('Could not restore remaining bots');
      }
      renderServerLobbyInMainMenu();
      startServerLobbyPolling(renderServerLobbyInMainMenu);
      showToast('Bot removed. Invite code refreshed for the open slot.', 'compact');
      return true;
    } catch (error) {
      console.error(error);
      showToast('Could not rebuild the lobby without that bot.', 'compact');
      return false;
    }
  }

  function renderServerLobbyRoster(elementId) {
    const roster = document.getElementById(elementId);
    if (roster) roster.innerHTML = serverLobbyRosterHtml(currentLobby);
  }

  function renderServerLobbyInMainMenu() {
    if (multiplayerStatus) multiplayerStatus.textContent = 'Host lobby open';
    if (createLobbyButton) createLobbyButton.hidden = false;
    syncServerLobbySettingsControls(false);
    setClickableInviteCode(normalizedInviteCode(currentLobby?.inviteCode));
    if (lobbyParty) lobbyParty.innerHTML = serverLobbyRosterHtml(currentLobby);
    renderLobbyLeaderStrip();
    if (mainMenuAddBotButton) {
      syncMainMenuAddBotButton();
    }
  }

  function renderJoinedLobbyInMainMenu() {
    if (multiplayerStatus) multiplayerStatus.textContent = 'Joined host lobby';
    if (createLobbyButton) createLobbyButton.hidden = true;
    syncServerLobbySettingsControls(true);
    setClickableInviteCode(normalizedInviteCode(currentLobby?.inviteCode));
    if (lobbyParty) lobbyParty.innerHTML = serverLobbyRosterHtml(currentLobby);
    renderLobbyLeaderStrip();
    if (mainMenuAddBotButton) mainMenuAddBotButton.hidden = true;
  }

  function syncServerLobbySettingsControls(lockForGuest) {
    const lobby = normalizeServerLobby(currentLobby);
    if (matchModeInput && lobby.mode) matchModeInput.value = lobby.mode;
    if (difficultyInput && lobby.difficulty) difficultyInput.value = lobby.difficulty;
    if (playerCountInput && lobby.maxPlayers) playerCountInput.value = String(lobby.maxPlayers);
    [matchModeInput, playerCountInput, difficultyInput].forEach((control) => {
      if (!control) return;
      control.disabled = !!lockForGuest;
      control.setAttribute('aria-disabled', String(!!lockForGuest));
      control.closest('.control')?.classList.toggle('is-guest-locked', !!lockForGuest);
    });
  }

  function updateHostedLobbySettings() {
    if (!window.isServerLobbyHost || !currentLobby?.id) return;
    const settings = {
      lobbyId: currentLobby.id,
      hostId: currentPlayerId,
      mode: matchModeInput?.value || currentLobby.mode,
      difficulty: difficultyInput?.value || currentLobby.difficulty,
      maxPlayers: Number(playerCountInput?.value || currentLobby.maxPlayers),
    };
    currentLobby = normalizeServerLobby({ ...currentLobby, ...settings }, currentLobby);
    renderServerLobbyInMainMenu();
    serverLobbySettingsQueue = serverLobbySettingsQueue.then(async () => {
      const res = await fetch(`${REST_BACKEND_URL}/api/lobby/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error(`Lobby settings update failed: ${res.status}`);
      const data = await res.json();
      if (data.lobby) currentLobby = normalizeServerLobby(data.lobby, currentLobby);
    }).catch((error) => {
      console.error(error);
      showToast('Could not update lobby settings.', 'compact');
    });
  }

  function scheduleServerLobbyPlayerUpdate() {
    renderLobbyLeaderStrip();
    if (!currentLobby?.id || !currentPlayerId) return;
    if (serverLobbyPlayerUpdateTimer) window.clearTimeout(serverLobbyPlayerUpdateTimer);
    serverLobbyPlayerUpdateTimer = window.setTimeout(async () => {
      serverLobbyPlayerUpdateTimer = null;
      const faction = factionForMenu(selectedParty);
      try {
        const res = await fetch(`${REST_BACKEND_URL}/api/lobby/player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lobbyId: currentLobby.id,
            playerId: currentPlayerId,
            factionIndex: selectedParty,
            party: faction.name,
            leader: faction.leader,
            color: faction.color,
            leaderProfile: normalizeLeaderProfile(selectedLeaderProfile),
          }),
        });
        if (!res.ok) throw new Error(`Player selection update failed: ${res.status}`);
        const data = await res.json();
        if (data.lobby) currentLobby = normalizeServerLobby(data.lobby, currentLobby);
        renderLobbyLeaderStrip();
      } catch (error) {
        console.error(error);
      }
    }, 120);
  }

  function returnHostToLeaderSelection() {
    stopServerLobbyPolling();
    document.getElementById('codeScreen')?.remove();
    document.getElementById('hostScreen')?.remove();
    window.isJoiner = false;
    window.isServerLobbyHost = true;
    gameStarted = false;
    mainMenu.style.display = 'block';
    mainMenu.style.visibility = 'visible';
    mainMenu.style.zIndex = '1000';
    mainMenu.classList.remove('is-hidden');
    gameShell.style.display = 'none';
    gameShell.style.visibility = 'hidden';
    renderPartyRoster();
    renderTalentPreview(selectedParty);
    renderServerLobbyInMainMenu();
    startServerLobbyPolling(renderServerLobbyInMainMenu);
    showToast('Lobby stays open while you choose a leader.', 'compact');
  }
  
  async function createLobby(hostName, mode, difficulty, maxPlayers, lobbyName = 'Untitled Lobby', isPublic = false) {
    try {
      console.log('Creating lobby with:', { hostName, mode, difficulty, maxPlayers, lobbyName, isPublic });
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostId: currentPlayerId,
          hostName: encodedLobbyHostName(hostName, lobbyName, isPublic),
          hostDisplayName: hostName,
          mode: mode,
          difficulty: difficulty,
          maxPlayers: maxPlayers,
          lobbyName: lobbyName,
          isPublic: isPublic
        })
      });
      
      console.log('Create response status:', res.status);
      const data = await res.json();
      console.log('Lobby created:', data);
      
      if (data.lobbyId) {
        currentLobby = normalizeServerLobby(data.lobby, {
          ...data,
          id: data.lobbyId,
          lobbyName,
          isPublic,
          players: [{ id: currentPlayerId, name: hostName, host: true }],
        });
        window.isServerLobbyHost = true;
        window.isJoiner = false;
        startServerLobbyHeartbeat();
        void syncServerLobbyWithCrazyGames({ showInviteButton: true });
        scheduleServerLobbyPlayerUpdate();
      }
      return data;
    } catch (error) {
      console.error('Failed to create lobby:', error.message, error);
      showToast(error.name === 'AbortError' ? 'Lobby server timed out. Try again.' : 'Could not create the lobby.', 'compact');
      return null;
    }
  }
  
  async function getOpenLobbies() {
    try {
      console.log('Fetching lobbies from:', REST_BACKEND_URL);
      const res = await fetch(`${REST_BACKEND_URL}/api/lobbies`, { cache: 'no-store' });
      console.log('Response status:', res.status);
      
      if (!res.ok) {
        console.error('API error status:', res.status);
        return [];
      }
      
      const lobbies = await res.json();
      console.log('Lobbies returned:', lobbies);
      return Array.isArray(lobbies) ? lobbies : [];
    } catch (error) {
      console.error('Failed to get lobbies:', error.message, error);
      return [];
    }
  }

  async function getPublicLobbies() {
    try {
      let res = await fetch(`${REST_BACKEND_URL}/api/lobbies?public=1`, { cache: 'no-store' });
      // The original RIGGED backend matches request URLs literally and returns
      // 404 when a query string is present. Fall back and filter client-side.
      if (res.status === 404) res = await fetch(`${REST_BACKEND_URL}/api/lobbies`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Public lobby request failed: ${res.status}`);
      const lobbies = await res.json();
      return (Array.isArray(lobbies) ? lobbies : [])
        .map((lobby) => normalizeServerLobby(lobby))
        .filter((lobby) => lobby.isPublic && !serverLobbyHasStarted(lobby) && lobby.players.length < lobby.maxPlayers);
    } catch (error) {
      console.error('Failed to browse public lobbies:', error);
      return [];
    }
  }
  
  async function joinLobby(lobbyId, playerName) {
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lobbyId: lobbyId,
          playerId: currentPlayerId,
          playerName: playerName
        })
      });
      const data = await res.json();
      if (data.lobby) {
        stopServerLobbyHeartbeat();
        currentLobby = normalizeServerLobby(data.lobby);
        window.isServerLobbyHost = false;
        window.isJoiner = true;
        multiplayerState.localReady = false;
        void syncServerLobbyWithCrazyGames({ showInviteButton: false });
        scheduleServerLobbyPlayerUpdate();
        return data;
      }
      return null;
    } catch (error) {
      console.error('Failed to join lobby:', error);
      return null;
    }
  }

  async function addBotToServerLobby() {
    if (!currentLobby?.id || !isCurrentServerLobbyHost()) return false;
    currentLobby = normalizeServerLobby(currentLobby);
    if (currentLobby.players.length >= currentLobby.maxPlayers) {
      showToast('Lobby is already full.', 'compact');
      return false;
    }
    const botNumber = currentLobby.players.filter((player) => /^Bot\b/i.test(player.name || player.playerName || '')).length + 1;
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lobbyId: currentLobby.id,
          playerId: `bot-${currentPlayerId}-${Date.now().toString(36)}`,
          playerName: `Bot ${botNumber}`,
          isBot: true,
        }),
      });
      if (!res.ok) throw new Error(`Bot join failed: ${res.status}`);
      const data = await res.json();
      if (data.lobby) currentLobby = normalizeServerLobby(data.lobby, currentLobby);
      else await getUpdatedLobby(currentLobby.id);
      void syncServerLobbyWithCrazyGames({ showInviteButton: serverLobbyIsJoinable(currentLobby) });
      showToast(`Bot ${botNumber} joined the lobby.`, 'compact');
      return true;
    } catch (error) {
      console.error('Failed to add bot to lobby:', error);
      showToast('Could not add bot to lobby.', 'compact');
      return false;
    }
  }
  
  async function startServerLobby(hostId) {
    try {
      const res = await fetch(`${REST_BACKEND_URL}/api/lobby/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lobbyId: currentLobby.id,
          hostId: hostId
        })
      });
      if (!res.ok) throw new Error(`Lobby start failed: ${res.status}`);
      const data = await res.json();
      return data;
    } catch (error) {
      console.error('Failed to start game:', error);
      return null;
    }
  }

  let serverLobbyStartPending = false;

  async function startServerGameWithBots(button = null) {
    if (serverLobbyStartPending || !currentLobby?.id || !window.isServerLobbyHost) return false;
    serverLobbyStartPending = true;
    stopServerLobbyPolling();
    stopServerLobbyHeartbeat();
    const oldLabel = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = 'FILLING SLOTS…';
    }

    try {
      currentLobby = normalizeServerLobby(currentLobby);
      while (currentLobby.players.length < currentLobby.maxPlayers) {
        const added = await addBotToServerLobby();
        if (!added) throw new Error('Could not fill an empty lobby slot');
      }

      if (button) button.textContent = 'STARTING GAME…';
      const result = await startServerLobby(currentPlayerId);
      if (!result) throw new Error('Server did not start the lobby');
      await syncServerLobbyWithCrazyGames({ isJoinable: false, showInviteButton: false });
      document.getElementById('codeScreen')?.remove();
      document.getElementById('hostScreen')?.remove();
      startGameFromLobby();
      return true;
    } catch (error) {
      console.error('Failed to start server lobby:', error);
      showToast('Could not start the lobby. Please try again.', 'compact');
      if (button) {
        button.disabled = false;
        button.textContent = oldLabel || 'START GAME';
      }
      startServerLobbyPolling(() => {
        renderServerLobbyRoster('codeLobbyRoster');
        renderServerLobbyRoster('hostLobbyRoster');
      });
      startServerLobbyHeartbeat();
      return false;
    } finally {
      serverLobbyStartPending = false;
    }
  }
  
  function showLobbyInterface() {
    stopPublicLobbyPolling();
    const shell = document.getElementById('gameShell');
    
    // Remove old lobby if exists
    const oldLobby = document.getElementById('lobbyScreen');
    if (oldLobby) oldLobby.remove();
    
    // Create lobby UI
    const lobbyUI = document.createElement('div');
    lobbyUI.id = 'lobbyScreen';
    lobbyUI.className = 'lobby-entry-screen';
    
    lobbyUI.innerHTML = `
      <div class="lobby-entry-noise" aria-hidden="true"></div>
      <main class="lobby-entry-console">
        <button id="lobbySoundToggle" class="sound-toggle lobby-sound-toggle" type="button" aria-pressed="true" aria-label="Turn sound off">
          <span class="lobby-sound-icon" aria-hidden="true">♪</span>
          <span class="lobby-sound-label">Sound // On</span>
        </button>
        <section class="lobby-entry-hero">
          <div class="lobby-entry-kicker"><span></span> Multiplayer Command Network</div>
          <div class="lobby-entry-logo"><i aria-hidden="true">R</i><strong>RIGGED</strong></div>
          <h1>Take control.<br><em>Rewrite the map.</em></h1>
          <p>Assemble your campaign crew, choose a leader, and fight for every electoral vote in a live shared match.</p>
          <div class="lobby-entry-status">
            <div><span class="status-pulse"></span><small>Network</small><strong>Online</strong></div>
            <div><small>Protocol</small><strong>Realtime</strong></div>
            <div><small>Access</small><strong>Invite Code</strong></div>
          </div>
          <div class="lobby-entry-signal" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        </section>

        <section class="lobby-entry-actions">
          <header>
            <span>01 // Deployment</span>
            <strong>Choose your operation</strong>
            <p>Start a new room or enter a code from your host.</p>
          </header>

          <button id="hostBtn" class="lobby-route lobby-route-primary" type="button">
            <span class="lobby-route-icon">+</span>
            <span><strong>Host Lobby</strong><small>Create a room and invite your crew</small></span>
            <b>→</b>
          </button>

          <button id="joinBtn" class="lobby-route" type="button">
            <span class="lobby-route-icon">#</span>
            <span><strong>Join Lobby</strong><small>Connect with a six-character code</small></span>
            <b>→</b>
          </button>

          <button id="browseBtn" class="lobby-route" type="button">
            <span class="lobby-route-icon">⌕</span>
            <span><strong>Browse Lobbies</strong><small>Find an open public operation</small></span>
            <b>→</b>
          </button>

          <div id="lobbyContent" class="lobby-entry-content" hidden></div>
          <footer><span>RIGGED://MATCHMAKING</span><span>BUILD 31.2</span></footer>
        </section>
      </main>
    `;
    
    document.body.appendChild(lobbyUI);
    
    // Add event listeners AFTER elements are created
    setTimeout(() => {
      const hostBtn = document.getElementById('hostBtn');
      const joinBtn = document.getElementById('joinBtn');
      const browseBtn = document.getElementById('browseBtn');
      const lobbySoundToggle = document.getElementById('lobbySoundToggle');
      if (hostBtn) hostBtn.onclick = showHostLobby;
      if (joinBtn) joinBtn.onclick = showJoinLobby;
      if (browseBtn) browseBtn.onclick = showBrowseLobbies;
      if (lobbySoundToggle) lobbySoundToggle.onclick = toggleNewsSound;
      syncSoundButtons();
    }, 100);
  }
  
  function showHostLobby() {
    stopPublicLobbyPolling();
    const content = document.getElementById('lobbyContent');
    if (!content) return;
    content.hidden = false;
    document.getElementById('hostBtn')?.remove();
    document.getElementById('joinBtn')?.remove();
    document.getElementById('browseBtn')?.remove();
    
    content.innerHTML = `
      <label class="lobby-field">
        <span>Lobby Name</span>
        <input id="lobbyNameInput" type="text" maxlength="32" value="Host's Lobby" placeholder="Name your lobby" autocomplete="off">
      </label>

      <fieldset class="lobby-visibility">
        <legend>Lobby Access</legend>
        <label><input type="radio" name="lobbyVisibility" value="private" checked><span><strong>Private</strong><small>Invite code only</small></span></label>
        <label><input type="radio" name="lobbyVisibility" value="public"><span><strong>Public</strong><small>Listed in Browse Lobbies</small></span></label>
      </fieldset>

      <label style="display: block; margin-bottom: 15px; color: #34ff86;">
        <div style="margin-bottom: 5px;">Game Mode:</div>
        <select id="modeSelect" style="width: 100%; background: #333; color: #34ff86; border: 1px solid #34ff86; padding: 8px; font-family: monospace;">
          <option value="campaign100">100 Days</option>
          <option value="majority50">50% Mode</option>
        </select>
      </label>
      
      <label style="display: block; margin-bottom: 15px; color: #34ff86;">
        <div style="margin-bottom: 5px;">Difficulty:</div>
        <select id="diffSelect" style="width: 100%; background: #333; color: #34ff86; border: 1px solid #34ff86; padding: 8px; font-family: monospace;">
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
      </label>
      
      <label style="display: block; margin-bottom: 20px; color: #34ff86;">
        <div style="margin-bottom: 5px;">Players:</div>
        <select id="playerSelect" style="width: 100%; background: #333; color: #34ff86; border: 1px solid #34ff86; padding: 8px; font-family: monospace;">
          <option value="3">3</option>
          <option value="4" selected>4</option>
          <option value="5">5</option>
        </select>
      </label>
      
      <button id="confirmHost" style="width: 100%; padding: 12px; background: #34ff86; color: #000; border: none; cursor: pointer; font-weight: bold; border-radius: 3px;">CREATE LOBBY</button>
      <button id="backHostBtn" style="width: 100%; padding: 12px; background: transparent; color: #34ff86; border: 1px solid #34ff86; cursor: pointer; border-radius: 3px; margin-top: 10px;">BACK</button>
    `;
    
    setTimeout(() => {
      const confirmBtn = document.getElementById('confirmHost');
      const backBtn = document.getElementById('backHostBtn');
      
      if (confirmBtn) {
        confirmBtn.onclick = () => {
          const mode = document.getElementById('modeSelect').value;
          const difficulty = document.getElementById('diffSelect').value;
          const maxPlayers = document.getElementById('playerSelect').value;
          const lobbyName = document.getElementById('lobbyNameInput').value.trim().slice(0, 32) || "Host's Lobby";
          const isPublic = document.querySelector('input[name="lobbyVisibility"]:checked')?.value === 'public';
          
          console.log('Host settings:', { mode, difficulty, maxPlayers, lobbyName, isPublic });
          
          // Store settings
          window.lobbySettings = { mode, difficulty, maxPlayers, lobbyName, isPublic };
          if (matchModeInput) matchModeInput.value = mode;
          if (difficultyInput) difficultyInput.value = difficulty;
          if (playerCountInput) playerCountInput.value = String(maxPlayers);
          refreshMultiplayerUi();
          
          // Hide lobby screen
          const lobbyScreen = document.getElementById('lobbyScreen');
          if (lobbyScreen) {
            lobbyScreen.style.display = 'none';
            lobbyScreen.style.visibility = 'hidden';
            lobbyScreen.style.zIndex = '0';
          }
          
          // Hide gameShell
          const gameShell = document.getElementById('gameShell');
          if (gameShell) {
            gameShell.style.display = 'none';
            gameShell.style.visibility = 'hidden';
            gameShell.style.zIndex = '0';
          }
          
          // Show main menu
          const mainMenu = document.getElementById('mainMenu');
          if (mainMenu) {
            mainMenu.style.display = 'block';
            mainMenu.style.visibility = 'visible';
            mainMenu.style.zIndex = '1000';
          }
          
          console.log('Showing main menu');
        };
      }
      
      if (backBtn) {
        backBtn.onclick = showLobbyInterface;
      }
    }, 100);
  }

  async function showBrowseLobbies() {
    stopPublicLobbyPolling();
    const content = document.getElementById('lobbyContent');
    if (!content) return;
    content.hidden = false;
    document.getElementById('hostBtn')?.remove();
    document.getElementById('joinBtn')?.remove();
    document.getElementById('browseBtn')?.remove();
    content.innerHTML = `
      <div class="lobby-browser-head">
        <div><strong>PUBLIC LOBBIES</strong><small>Live rooms accepting players</small></div>
        <button id="refreshPublicLobbies" type="button">REFRESH</button>
      </div>
      <div id="publicLobbyList" class="public-lobby-list"><div class="public-lobby-empty">SCANNING NETWORK…</div></div>
      <button id="browseBackBtn" class="lobby-inline-back" type="button">BACK</button>
    `;

    const list = document.getElementById('publicLobbyList');
    const render = async () => {
      if (!list) return;
      list.innerHTML = '<div class="public-lobby-empty">SCANNING NETWORK…</div>';
      const lobbies = await getPublicLobbies();
      if (!lobbies.length) {
        list.innerHTML = '<div class="public-lobby-empty"><strong>NO PUBLIC LOBBIES</strong><span>Host one and set its access to Public.</span></div>';
        return;
      }
      list.innerHTML = lobbies.map((lobby) => `
        <article class="public-lobby-card">
          <div><strong>${escapeHtml(lobby.lobbyName)}</strong><small>${escapeHtml(lobby.mode || 'campaign100')} // ${escapeHtml(lobby.difficulty || 'medium')}</small></div>
          <span>${lobby.players.length}/${lobby.maxPlayers}</span>
          <button type="button" data-public-lobby-id="${escapeHtml(lobby.id)}">JOIN</button>
        </article>`).join('');
      list.querySelectorAll('[data-public-lobby-id]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          button.textContent = 'JOINING…';
          const result = await joinLobby(button.dataset.publicLobbyId, 'Player');
          if (result) {
            stopPublicLobbyPolling();
            showJoinerPartySelection();
          }
          else {
            button.disabled = false;
            button.textContent = 'RETRY';
          }
        };
      });
    };
    document.getElementById('refreshPublicLobbies').onclick = render;
    document.getElementById('browseBackBtn').onclick = showLobbyInterface;
    await render();
    publicLobbyPollTimer = window.setInterval(render, 3000);
  }
  
  function showLobbyCode() {
    console.log('showLobbyCode called, currentLobby:', currentLobby);
    
    // Remove old lobby screen if exists
    const oldLobby = document.getElementById('lobbyScreen');
    if (oldLobby) oldLobby.remove();
    
    // Create new lobby code screen
    const codeScreen = document.createElement('div');
    codeScreen.id = 'codeScreen';
    codeScreen.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.95); display: flex; justify-content: center; align-items: center; z-index: 99999;';
    
    const code = currentLobby && currentLobby.inviteCode ? currentLobby.inviteCode : 'ERROR: NO CODE';
    console.log('Displaying code:', code);
    
    codeScreen.innerHTML = `
      <div style="background: #1a1a1a; border: 3px solid #34ff86; padding: 50px; border-radius: 15px; max-width: 600px; color: #34ff86; font-family: monospace; text-align: center;">
        <h2 style="margin:0 0 8px;font-size:28px;color:#34ff86;">${escapeHtml(currentLobby.lobbyName)}</h2>
        <p style="color:#72d596;margin:0 0 28px;letter-spacing:2px;">${currentLobby.isPublic ? 'PUBLIC LOBBY' : 'PRIVATE LOBBY'}</p>
        <div style="background: #0a0a0a; border: 4px solid #34ff86; padding: 40px 20px; margin-bottom: 40px; font-size: 56px; letter-spacing: 12px; font-weight: bold; color: #34ff86; word-wrap: break-word;">
          ${code}
        </div>
        <p style="color: #aaa; margin-bottom: 30px; font-size: 16px;">Share this code with your friends to join</p>
        <div id="codeLobbyRoster" style="border:2px solid #34ff86;background:#0a0a0a;padding:16px;margin-bottom:18px;text-align:left;"></div>
        <button id="copyCodeBtn" style="width: 100%; padding: 16px; background: #34ff86; color: #000; border: 3px solid #34ff86; cursor: pointer; font-weight: bold; border-radius: 5px; font-size: 16px; margin-bottom: 12px;">COPY INVITE CODE</button>
        <button id="changeHostLeaderBtn" style="width:100%;padding:16px;background:transparent;color:#34ff86;border:3px solid #34ff86;cursor:pointer;font-weight:bold;border-radius:5px;font-size:16px;margin-bottom:12px;">BACK</button>
        <button id="backToLobbyBtn" style="width: 100%; padding: 16px; background: transparent; color: #34ff86; border: 3px solid #34ff86; cursor: pointer; font-weight: bold; border-radius: 5px; font-size: 16px; margin-bottom: 12px;">WAITING LOBBY</button>
      </div>
    `;
    
    document.body.appendChild(codeScreen);
    
    setTimeout(() => {
      const backBtn = document.getElementById('backToLobbyBtn');
      const copyCodeBtn = document.getElementById('copyCodeBtn');
      const changeHostLeaderBtn = document.getElementById('changeHostLeaderBtn');

      renderServerLobbyRoster('codeLobbyRoster');
      startServerLobbyPolling(() => renderServerLobbyRoster('codeLobbyRoster'));

      if (changeHostLeaderBtn) changeHostLeaderBtn.onclick = returnHostToLeaderSelection;

      if (copyCodeBtn) {
        copyCodeBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(code);
            copyCodeBtn.textContent = 'CODE COPIED!';
          } catch {
            copyCodeBtn.textContent = `CODE: ${code}`;
          }
        };
      }
      
      if (backBtn) {
        backBtn.onclick = () => {
          showHostingLobby();
        };
      }
      
    }, 100);
  }
  
  async function getUpdatedLobby(lobbyId) {
    try {
      const res = await fetch(`${REST_BACKEND_URL}/api/lobbies`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Lobby refresh failed: ${res.status}`);
      const lobbies = await res.json();
      const lobby = lobbies.find(l => (l.id || l.lobbyId) === lobbyId);
      if (lobby) {
        currentLobby = normalizeServerLobby(lobby, currentLobby || {});
        const joinable = serverLobbyIsJoinable(currentLobby);
        if (window.isServerLobbyHost && joinable !== lastCrazyServerJoinable) {
          await syncServerLobbyWithCrazyGames({ isJoinable: joinable, showInviteButton: joinable });
        }
        return lobby;
      }
      // A successfully fetched list without this lobby means the server removed it.
      // The current backend does this immediately when the host starts the match.
      return null;
    } catch (error) {
      console.error('Failed to get updated lobby:', error);
      // Undefined means a network/server error, which must not be mistaken for start.
      return undefined;
    }
  }
  
  function showHostingLobby() {
    const codeScreen = document.getElementById('codeScreen');
    if (codeScreen) codeScreen.remove();
    
    // Create hosting lobby screen
    const hostScreen = document.createElement('div');
    hostScreen.id = 'hostScreen';
    hostScreen.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.95); display: flex; justify-content: center; align-items: center; z-index: 99999;';
    
    // Initialize ready status
    if (!window.playerReadyStatus) {
      window.playerReadyStatus = {};
    }
    window.playerReadyStatus[currentPlayerId] = true; // Host is always ready
    
    currentLobby = normalizeServerLobby(currentLobby);

    // Count ready players
    const readyCount = Object.values(window.playerReadyStatus || {}).filter(r => r).length;
    // Ready state is not persisted by the lobby API, so the host remains in control of starting.
    const allReady = currentLobby.players.length > 0;
    
    hostScreen.innerHTML = `
      <div style="background: #1a1a1a; border: 3px solid #34ff86; padding: 50px; border-radius: 15px; max-width: 600px; color: #34ff86; font-family: monospace; text-align: center;">
        <h2 style="margin:0 0 8px;font-size:28px;color:#34ff86;">${escapeHtml(currentLobby.lobbyName)}</h2>
        <p style="color:#72d596;margin:0 0 24px;letter-spacing:2px;">${currentLobby.isPublic ? 'PUBLIC LOBBY' : 'PRIVATE LOBBY'}</p>
        <p style="color: #aaa; margin-bottom: 20px;">Invite Code: <strong style="color: #34ff86; font-size: 24px;">${currentLobby.inviteCode}</strong></p>
        <div style="border: 2px solid #34ff86; padding: 20px; margin-bottom: 30px; background: #0a0a0a; min-height: 100px;">
          <p style="color: #34ff86; margin: 0 0 15px 0;">Players Joined:</p>
          <p id="playerCount" style="color: #aaa; margin: 0 0 15px 0; font-size: 20px;">${currentLobby.players.length}/${currentLobby.maxPlayers} players</p>
          <div id="hostLobbyRoster" style="text-align:left"></div>
        </div>
        <button id="hostAddBotBtn" style="width:100%;padding:12px;background:transparent;color:#34ff86;border:2px solid #34ff86;cursor:pointer;font-weight:bold;border-radius:5px;margin-bottom:10px;">ADD BOT</button>
        <button id="refreshBtn" style="width: 100%; padding: 12px; background: #34ff86; color: #000; border: none; cursor: pointer; font-weight: bold; border-radius: 5px; margin-bottom: 10px; font-size: 14px;">REFRESH</button>
        <button id="backToCodeBtn" style="width: 100%; padding: 12px; background: transparent; color: #34ff86; border: 2px solid #34ff86; cursor: pointer; font-weight: bold; border-radius: 5px; margin-bottom: 10px;">BACK TO PARTY / LEADER</button>
        <button id="hostStartBtn" style="width: 100%; padding: 18px; background: ${allReady ? '#34ff86' : '#666'}; color: ${allReady ? '#000' : '#999'}; border: none; cursor: ${allReady ? 'pointer' : 'not-allowed'}; font-weight: bold; border-radius: 5px; font-size: 18px;">START GAME ${allReady ? '' : '(waiting for players)'}</button>
      </div>
    `;
    
    document.body.appendChild(hostScreen);
    
    setTimeout(() => {
      const refreshBtn = document.getElementById('refreshBtn');
      const backBtn = document.getElementById('backToCodeBtn');
      const startBtn = document.getElementById('hostStartBtn');
      const addBotBtn = document.getElementById('hostAddBotBtn');

      renderServerLobbyRoster('hostLobbyRoster');

      if (addBotBtn) {
        addBotBtn.disabled = currentLobby.players.length >= currentLobby.maxPlayers;
        addBotBtn.onclick = async () => {
          addBotBtn.disabled = true;
          await addBotToServerLobby();
          const playerCount = document.getElementById('playerCount');
          if (playerCount) playerCount.textContent = `${currentLobby.players.length}/${currentLobby.maxPlayers} players`;
          renderServerLobbyRoster('hostLobbyRoster');
          addBotBtn.disabled = currentLobby.players.length >= currentLobby.maxPlayers;
        };
      }
      
      if (refreshBtn) {
        refreshBtn.onclick = async () => {
          const updated = await getUpdatedLobby(currentLobby.id);
          if (updated) {
            const playerCount = document.getElementById('playerCount');
            if (playerCount) {
              playerCount.textContent = `${updated.players.length}/${updated.maxPlayers} players`;
            }
          }
          showHostingLobby(); // Refresh entire screen to update ready status
        };
      }
      
      if (backBtn) {
        backBtn.onclick = returnHostToLeaderSelection;
      }
      
      if (startBtn && allReady) {
        startBtn.onclick = () => startServerGameWithBots(startBtn);
      }

      startServerLobbyPolling(() => {
        const playerCount = document.getElementById('playerCount');
        if (playerCount) playerCount.textContent = `${currentLobby.players.length}/${currentLobby.maxPlayers} players`;
        renderServerLobbyRoster('hostLobbyRoster');
      });
    }, 100);
  }
  
  function showJoinLobby() {
    stopPublicLobbyPolling();
    const content = document.getElementById('lobbyContent');
    if (!content) return;
    content.hidden = false;
    document.getElementById('hostBtn')?.remove();
    document.getElementById('joinBtn')?.remove();
    
    content.innerHTML = `
      <label style="display: block; margin-bottom: 20px; color: #34ff86;">
        <div style="margin-bottom: 10px; font-size: 16px;">Enter Invite Code:</div>
        <input id="codeInput" type="text" placeholder="e.g. ABC123" style="width: 100%; background: #333; color: #34ff86; border: 1px solid #34ff86; padding: 10px; font-family: monospace; font-size: 16px; text-transform: uppercase; box-sizing: border-box;">
      </label>
      
      <button id="confirmJoin" style="width: 100%; padding: 12px; background: #34ff86; color: #000; border: none; cursor: pointer; font-weight: bold; border-radius: 3px; margin-bottom: 10px;">JOIN</button>
      <button id="backBtn2" style="width: 100%; padding: 12px; background: transparent; color: #34ff86; border: 1px solid #34ff86; cursor: pointer; border-radius: 3px;">BACK</button>
      <div id="joinStatus" style="color: #ff6666; margin-top: 10px;"></div>
    `;
    
    setTimeout(() => {
      const confirmJoinBtn = document.getElementById('confirmJoin');
      const backBtn2 = document.getElementById('backBtn2');
      const statusDiv = document.getElementById('joinStatus');
      
      if (confirmJoinBtn) {
        confirmJoinBtn.onclick = async () => {
          const code = document.getElementById('codeInput').value.trim().toUpperCase();
          console.log('Attempting to join with code:', code);
          statusDiv.innerText = 'Joining...';
          
          try {
            const lobbies = await getOpenLobbies();
            console.log('Available lobbies:', lobbies);
            
            const lobby = lobbies.find(l => normalizedInviteCode(l.inviteCode) === normalizedInviteCode(code));
            console.log('Found lobby:', lobby);
            
            if (lobby) {
              const result = await joinLobby(lobby.id, 'Player');
              console.log('Join result:', result);
              
              if (result) {
                statusDiv.innerText = 'Joined lobby!';
                showJoinerPartySelection();
              } else {
                statusDiv.innerText = 'Failed to join. Try again.';
              }
            } else {
              statusDiv.innerText = 'Invalid code!';
            }
          } catch (error) {
            console.error('Join error:', error);
            statusDiv.innerText = 'Error: ' + error.message;
          }
        };
      }
      
      if (backBtn2) {
        backBtn2.onclick = showLobbyInterface;
      }
    }, 100);
  }
  
  function showJoinerPartySelection() {
    // Hide lobby interface
    const lobbyScreen = document.getElementById('lobbyScreen');
    if (lobbyScreen) lobbyScreen.remove();
    
    // Show main menu for party selection
    const mainMenu = document.getElementById('mainMenu');
    if (mainMenu) {
      mainMenu.style.display = 'block';
      mainMenu.style.visibility = 'visible';
      mainMenu.style.zIndex = '1000';
      mainMenu.classList.remove('is-hidden');
    }
    
    // Mark as joiner (not host)
    window.isJoiner = true;
    multiplayerState.localReady = false;

    renderJoinedLobbyInMainMenu();
    renderTalentPreview(selectedParty);
    updateLobbyStartButtons();
    startServerLobbyPolling(renderJoinedLobbyInMainMenu);
    
    console.log('Joiner selecting party...');
  }

  function serverLobbyHasStarted(lobby) {
    return !!(lobby && (lobby.started || lobby.gameStarted || String(lobby.status || '').toLowerCase() === 'started'));
  }

  function stopServerLobbyPolling() {
    if (serverLobbyPollTimer) window.clearInterval(serverLobbyPollTimer);
    serverLobbyPollTimer = null;
  }

  function startServerLobbyPolling(onUpdate) {
    stopServerLobbyPolling();
    let missingPolls = 0;
    serverLobbyPollTimer = window.setInterval(async () => {
      if (!currentLobby?.id) return;
      const updated = await getUpdatedLobby(currentLobby.id);
      if (updated === undefined) return;
      if (updated === null) {
        missingPolls += 1;
        if (window.isJoiner && missingPolls >= 2) {
          stopServerLobbyPolling();
          document.getElementById('joinedLobbyScreen')?.remove();
          document.getElementById('waitScreenFull')?.remove();
          showToast('Host started the game.', 'compact');
          startGameFromLobby();
        }
        return;
      }
      missingPolls = 0;
      currentLobby = normalizeServerLobby(updated, currentLobby);
      if (serverLobbyHasStarted(currentLobby) && window.isJoiner) {
        stopServerLobbyPolling();
        document.getElementById('joinedLobbyScreen')?.remove();
        startGameFromLobby();
        return;
      }
      onUpdate?.();
    }, 600);
  }

  function showJoinedServerLobby() {
    document.getElementById('lobbyScreen')?.remove();
    document.getElementById('joinedLobbyScreen')?.remove();
    currentLobby = normalizeServerLobby(currentLobby);
    window.isJoiner = true;

    const screen = document.createElement('div');
    screen.id = 'joinedLobbyScreen';
    screen.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.95);display:flex;justify-content:center;align-items:center;z-index:99999;color:#34ff86;font-family:monospace;';
    screen.innerHTML = `
      <div style="background:#1a1a1a;border:3px solid #34ff86;padding:42px;border-radius:15px;width:min(520px,calc(100vw - 48px));text-align:center;">
        <h2 style="margin:0 0 8px;">${escapeHtml(currentLobby.lobbyName)}</h2>
        <p style="color:#72d596;margin:0 0 18px;letter-spacing:2px;">${currentLobby.isPublic ? 'PUBLIC LOBBY' : 'PRIVATE LOBBY'}</p>
        <p style="color:#aaa;margin:0 0 24px;">Invite code: <strong style="color:#34ff86">${escapeHtml(normalizedInviteCode(currentLobby.inviteCode))}</strong></p>
        <div id="joinedLobbyRoster" style="border:2px solid #34ff86;background:#0a0a0a;padding:18px;margin-bottom:20px;text-align:left;"></div>
        <p style="color:#aaa;">You are connected. Choose your leader while the host prepares the match.</p>
        <button id="chooseJoinerLeader" style="width:100%;padding:14px;background:#34ff86;color:#000;border:0;cursor:pointer;font-weight:bold;border-radius:4px;">CHOOSE LEADER</button>
      </div>`;
    document.body.appendChild(screen);

    const renderRoster = () => renderServerLobbyRoster('joinedLobbyRoster');
    renderRoster();
    document.getElementById('chooseJoinerLeader')?.addEventListener('click', () => {
      stopServerLobbyPolling();
      screen.remove();
      showJoinerPartySelection();
    });
    startServerLobbyPolling(renderRoster);
  }
  
  function showWaitingScreenFull() {
    // Hide main menu
    const mainMenu = document.getElementById('mainMenu');
    if (mainMenu) mainMenu.style.display = 'none';
    
    document.getElementById('waitScreenFull')?.remove();
    currentLobby = normalizeServerLobby(currentLobby);

    // Create full-screen waiting screen
    const waitScreen = document.createElement('div');
    waitScreen.id = 'waitScreenFull';
    waitScreen.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.95); display: flex; justify-content: center; align-items: center; z-index: 99999;';
    
    // Initialize ready status
    if (!window.playerReadyStatus) {
      window.playerReadyStatus = {};
    }
    const isReady = window.playerReadyStatus[currentPlayerId] || false;
    
    waitScreen.innerHTML = `
      <div style="background: #1a1a1a; border: 3px solid #34ff86; padding: 50px; border-radius: 15px; max-width: 600px; color: #34ff86; font-family: monospace; text-align: center;">
        <h2 style="margin-bottom: 40px; font-size: 28px; color: #34ff86;">WAITING FOR HOST</h2>
        <p style="color: #aaa; margin-bottom: 30px;">You have joined the lobby</p>
        <div style="border: 2px solid #34ff86; padding: 30px; margin-bottom: 40px; background: #0a0a0a; min-height: 100px;">
          <p style="color: #34ff86; margin: 0 0 15px 0;">Players In Lobby:</p>
          <p id="waitingLobbyPlayerCount" style="color: #aaa; margin: 0; font-size: 20px;">${currentLobby.players.length}/${currentLobby.maxPlayers} players</p>
          <div id="waitingLobbyRoster" style="margin-top:14px;text-align:left"></div>
          <p style="color: #666; margin-top: 15px; font-size: 14px;">Waiting for host to start the game...</p>
        </div>
        <button id="readyBtn" style="width: 100%; padding: 16px; background: ${isReady ? '#34ff86' : 'transparent'}; color: ${isReady ? '#000' : '#34ff86'}; border: 2px solid #34ff86; cursor: pointer; font-weight: bold; border-radius: 5px; font-size: 16px;">${isReady ? '✓ READY' : 'READY'}</button>
      </div>
    `;
    
    document.body.appendChild(waitScreen);
    renderServerLobbyRoster('waitingLobbyRoster');

    startServerLobbyPolling(() => {
      const count = document.getElementById('waitingLobbyPlayerCount');
      if (count) count.textContent = `${currentLobby.players.length}/${currentLobby.maxPlayers} players`;
      renderServerLobbyRoster('waitingLobbyRoster');
    });
    
    setTimeout(() => {
      const readyBtn = document.getElementById('readyBtn');
      if (readyBtn) {
        readyBtn.onclick = () => {
          window.playerReadyStatus[currentPlayerId] = !window.playerReadyStatus[currentPlayerId];
          showWaitingScreenFull(); // Refresh the screen
        };
      }
    }, 100);
  }

  function gameStateSnapshot() {
    return {
      players,
      states: states.map((state) => ({
        influence: state.influence,
        offices: state.offices,
        police: state.police,
        cashFreeze: state.cashFreeze,
        sabotageCooldown: state.sabotageCooldown,
        activePulse: state.activePulse,
      })),
      channels,
      missions,
      actionEffects,
      alerts,
      phase,
      baseTimer,
      elapsed,
      news,
      newsTimer,
      latestClickbait,
      clickbaitTimer,
      nextNewsAt,
      matchOver,
      paused,
      selectedState,
      mode: currentMatchMode.id,
      publishedAt: Date.now(),
    };
  }

  function applyGameStateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.states)) return;
    snapshot.players.forEach((source, index) => {
      if (players[index]) {
        Object.assign(players[index], source);
        if (players[index].action) {
          players[index].action._guestInitialLeft = Number(players[index].action.left || 0);
          players[index].action._guestReceivedAt = performance.now();
        }
      }
    });
    snapshot.states.forEach((source, index) => {
      if (states[index]) Object.assign(states[index], source);
    });
    if (Array.isArray(snapshot.channels)) {
      snapshot.channels.forEach((source, index) => {
        if (channels[index]) Object.assign(channels[index], source);
      });
    }
    missions = Array.isArray(snapshot.missions) ? snapshot.missions : missions;
    actionEffects = Array.isArray(snapshot.actionEffects) ? snapshot.actionEffects : actionEffects;
    alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : alerts;
    phase = snapshot.phase || phase;
    baseTimer = Number(snapshot.baseTimer ?? baseTimer);
    elapsed = Number(snapshot.elapsed ?? elapsed);
    news = snapshot.news ?? news;
    newsTimer = Number(snapshot.newsTimer ?? newsTimer);
    latestClickbait = snapshot.latestClickbait ?? latestClickbait;
    clickbaitTimer = Number(snapshot.clickbaitTimer ?? clickbaitTimer);
    nextNewsAt = Number(snapshot.nextNewsAt ?? nextNewsAt);
    matchOver = snapshot.matchOver === true;
    paused = snapshot.paused === true;
    selectedState = Number.isFinite(Number(snapshot.selectedState)) ? Number(snapshot.selectedState) : selectedState;
    if (snapshot.mode && MATCH_MODES[snapshot.mode]) currentMatchMode = MATCH_MODES[snapshot.mode];
    updateUi(true);
  }

  async function publishAuthoritativeGameState() {
    if (!gameStarted || !isCurrentServerLobbyHost() || !currentLobby?.id || gameStatePublishPending) return;
    gameStatePublishPending = true;
    try {
      gameStateVersion += 1;
      await lobbyFetch(`${REST_BACKEND_URL}/api/game/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: currentLobby.id, hostId: currentPlayerId, version: gameStateVersion, state: gameStateSnapshot() }),
      }, 4000);
    } catch (error) {
      console.error('Game state publish failed:', error);
    } finally {
      gameStatePublishPending = false;
    }
  }

  async function pollAuthoritativeGameState() {
    if (!gameStarted || !isServerLobbyGuest() || !currentLobby?.id || gameStatePollPending) return;
    gameStatePollPending = true;
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/game/state?lobbyId=${encodeURIComponent(currentLobby.id)}`, { cache: 'no-store' }, 4000);
      if (!res.ok) throw new Error(`Game state poll failed: ${res.status}`);
      const data = await res.json();
      if (data.state && Number(data.version || 0) > gameStateVersion) {
        gameStateVersion = Number(data.version || 0);
        applyGameStateSnapshot(data.state);
      }
    } catch (error) {
      console.error('Game state poll failed:', error);
    } finally {
      gameStatePollPending = false;
    }
  }

  function routeGuestGameCommand(type, args) {
    if (!gameStarted || !isServerLobbyGuest() || applyingRemoteGameCommand || !currentLobby?.id) return false;
    void lobbyFetch(`${REST_BACKEND_URL}/api/game/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lobbyId: currentLobby.id, playerId: currentPlayerId, command: { type, args } }),
    }, 4000).catch((error) => {
      console.error('Game command failed:', error);
      showToast('Action could not reach the host.', 'compact');
    });
    return true;
  }

  function executeRemoteGameCommand(entry) {
    const lobbyIndex = currentLobby?.players?.findIndex((player) => player.id === entry.playerId) ?? -1;
    if (lobbyIndex < 0 || !players[lobbyIndex] || players[lobbyIndex].isBot) return;
    const args = Array.isArray(entry.command?.args) ? entry.command.args : [];
    const handlers = {
      chooseHomeBase: () => chooseHomeBase(lobbyIndex, Number(args[0])),
      startAction: () => startAction(lobbyIndex, String(args[0]), Number(args[1])),
      placeAdHub: () => placeAdHub(lobbyIndex, Number(args[0])),
      upgradeMiniBase: () => upgradeMiniBase(lobbyIndex, Number(args[0])),
      buyChannel: () => buyChannel(lobbyIndex, Number(args[0])),
      upgradeMainBase: () => upgradeMainBase(lobbyIndex),
      assassinate: () => assassinate(lobbyIndex, Number(args[0])),
      sabotage: () => sabotage(lobbyIndex, Number(args[0])),
      instigateRiot: () => instigateRiot(lobbyIndex, Number(args[0])),
      togglePolice: () => togglePolice(lobbyIndex, Number(args[0])),
      selectTalent: () => {
        const player = players[lobbyIndex];
        const tier = Number(args[0]);
        const side = args[1] === 'right' ? 'right' : 'left';
        if (player && tierUnlocked(tier, player) && player.talents[tier] === undefined) player.talents[tier] = side;
      },
      togglePause: () => {
        paused = !paused;
        localPauseRequested = paused;
        if (pauseButton) pauseButton.textContent = paused ? 'Resume Everyone' : 'Pause';
      },
    };
    const handler = handlers[entry.command?.type];
    if (!handler) return;
    applyingRemoteGameCommand = true;
    try { handler(); } finally { applyingRemoteGameCommand = false; }
  }

  async function drainGuestGameCommands() {
    if (!gameStarted || !isCurrentServerLobbyHost() || !currentLobby?.id || gameCommandDrainPending) return;
    gameCommandDrainPending = true;
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/game/commands/drain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: currentLobby.id, hostId: currentPlayerId }),
      }, 4000);
      if (!res.ok) throw new Error(`Command drain failed: ${res.status}`);
      const data = await res.json();
      (data.commands || []).forEach(executeRemoteGameCommand);
    } catch (error) {
      console.error('Command drain failed:', error);
    } finally {
      gameCommandDrainPending = false;
    }
  }

  function startServerGameSync() {
    if (!currentLobby?.id) return;
    window.clearInterval(gameStatePublishTimer);
    window.clearInterval(gameStatePollTimer);
    window.clearInterval(gameCommandPollTimer);
    gameStateVersion = 0;
    if (isCurrentServerLobbyHost()) {
      publishAuthoritativeGameState();
      gameStatePublishTimer = window.setInterval(publishAuthoritativeGameState, 200);
      gameCommandPollTimer = window.setInterval(drainGuestGameCommands, 120);
    } else {
      pollAuthoritativeGameState();
      gameStatePollTimer = window.setInterval(pollAuthoritativeGameState, 200);
    }
  }
  
  function startGameFromLobby() {
    stopServerLobbyPolling();
    currentLobby = normalizeServerLobby(currentLobby);
    if (matchModeInput && currentLobby.mode) matchModeInput.value = currentLobby.mode;
    if (difficultyInput && currentLobby.difficulty) difficultyInput.value = currentLobby.difficulty;
    if (playerCountInput) playerCountInput.value = String(currentLobby.maxPlayers);
    const lobbyScreen = document.getElementById('lobbyScreen');
    const codeScreen = document.getElementById('codeScreen');
    const hostScreen = document.getElementById('hostScreen');
    if (lobbyScreen) lobbyScreen.remove();
    if (codeScreen) codeScreen.remove();
    if (hostScreen) hostScreen.remove();
    
    gameStarted = true;
    mainMenu.style.display = 'none';
    mainMenu.style.visibility = 'hidden';
    mainMenu.classList.add('is-hidden');
    gameShell.style.display = 'block';
    gameShell.style.visibility = 'visible';
    gameShell.style.zIndex = '';
    gameShell.classList.remove('is-hidden');
    playerId = currentPlayerId;
    const localLobbyIndex = currentLobby.players.findIndex((player) => player.id === currentPlayerId);
    HUMAN = localLobbyIndex >= 0 ? localLobbyIndex : 0;
    
    // Set up selected party (host's party)
    selectMenuParty(selectedParty, false);
    
    // Initialize with host as player 1
    console.log('Starting game with lobby:', currentLobby);
    
    initWebSocket();
    startGame();
    startServerGameSync();
    setSoundEnabled(soundOn, { announce: false, fade: 1.2 });
    if (!loopStarted) {
      loopStarted = true;
      lastFrame = performance.now();
      requestAnimationFrame(loop);
    }
  }
  // ===== END LOBBY SYSTEM =====
  const MATCH_SECONDS = 1800;
  const CAMPAIGN_TOTAL_DAYS = 100;
  const CAMPAIGN_DAY_SECONDS = MATCH_SECONDS / CAMPAIGN_TOTAL_DAYS;
  const MATCH_MODES = {
    campaign100: { id: "campaign100", label: "100 Days", timed: true, days: 100, seconds: MATCH_SECONDS },
    majority50: { id: "majority50", label: "50% Mode", timed: false, days: 100, seconds: null },
  };
  const HOME_BASE_SECONDS = 10;
  const NEWS_INTERVAL = 85;
  const CAPTURE_THRESHOLD = 50;
  const CHANNEL_COST = 10000;
  const CHANNEL_INFLUENCE_RATE = 0.14;
  const SPEECH_SECONDS = CAMPAIGN_DAY_SECONDS;
  const SPEECH_RATE = 10 / SPEECH_SECONDS;
  const SPEECH_RIVAL_RATE = 10 / (CAMPAIGN_DAY_SECONDS * 2);
  const AD_HUB_COST = 2000;
  const AD_HUB_DEPLOY_SECONDS = CAMPAIGN_DAY_SECONDS * 0.5;
  const AD_HUB_RATE = 1 / CAMPAIGN_DAY_SECONDS;
  const MINI_BASE_MAX_LEVEL = 3;
  const MINI_BASE_ICON_SCALE = 0.5;
  const MINI_BASE_HIT_RADIUS = 9;
  const MINI_BASE_DEFENSE = [0, 5, 10, 15];
  const MINI_BASE_CASH_DAY = [0, 140, 280, 420];
  const MINI_BASE_UPGRADE = {
    2: { cash: 2600, infl: 10, days: 1 },
    3: { cash: 4200, infl: 20, days: 1.5 },
  };
  const CANVAS_W = 1000;
  const CANVAS_H = 600;
  const Camera = {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    dragMoved: false,
    lodThreshold: 1.5,
    minZoom: 0.5,
    maxZoom: 14,
  };
  const SEMANTIC_ZOOM = {
    macroMax: 0.9,
    macroFadeEnd: 1.12,
    mesoStart: 0.96,
    mesoFull: 1.45,
    microFadeStart: 1.65,
    microFull: 2.35,
  };

  const FACTION_VISUALS = {
    oligarchy: { color: "#F59E0B", glow: "#FFE259" },
    populist: { color: "#22D3EE", glow: "#96F5FF" },
    syndicate: { color: "#00FF66", glow: "#A6FFD0" },
    vanguard: { color: "#EF4444", glow: "#FFB2B2" },
    default: { color: "#A78BFA", glow: "#DDD6FE" },
  };

  const COLOR_BLIND_PALETTE = [
    { color: "#0072B2", glow: "#8FD3FF" },
    { color: "#E69F00", glow: "#FFD98A" },
    { color: "#009E73", glow: "#8FF0CE" },
    { color: "#CC79A7", glow: "#FFC2E2" },
    { color: "#56B4E9", glow: "#B7E6FF" },
    { color: "#D55E00", glow: "#FFB088" },
    { color: "#F0E442", glow: "#FFF7A0" },
    { color: "#999999", glow: "#E0E0E0" },
  ];
  const DISTINCT_BOT_COLORS = [
    { color: "#1D4ED8", glow: "#93C5FD" },
    { color: "#16A34A", glow: "#86EFAC" },
    { color: "#DC2626", glow: "#FCA5A5" },
    { color: "#9333EA", glow: "#D8B4FE" },
    { color: "#0891B2", glow: "#67E8F9" },
    { color: "#CA8A04", glow: "#FDE68A" },
    { color: "#BE185D", glow: "#F9A8D4" },
    { color: "#64748B", glow: "#CBD5E1" },
  ];
  const FACTIONS = [
    { name: "Crimson", color: "#F59E0B", full: "Redline Compact", leader: "Mara Voss", title: "Donor War Room", region: "west", talentTree: "oligarchy", cashBias: 1.18, speechBias: 1, heatBias: 1, portrait: { skin: "#e7b28d", hair: "#3a1a16", suit: "#6b1f29", accent: "#ffb6b8" } },
    { name: "Azure", color: "#22D3EE", full: "Bluewater Front", leader: "Jonas Reed", title: "Coalition Speaker", region: "south", talentTree: "populist", cashBias: 1, speechBias: 1.16, heatBias: 1, portrait: { skin: "#d49c72", hair: "#182338", suit: "#173c8c", accent: "#a7c7ff" } },
    { name: "Verdant", color: "#00FF66", full: "Green Cities Bloc", leader: "Elena Park", title: "Civic Organizer", region: "northeast", talentTree: "syndicate", cashBias: 0.95, speechBias: 1.08, heatBias: 0.78, portrait: { skin: "#c98f68", hair: "#123424", suit: "#16633d", accent: "#a4f0bb" } },
    { name: "Gold", color: "#EF4444", full: "Liberty Exchange", leader: "Silas Grant", title: "Market Governor", region: "midwest", talentTree: "vanguard", cashBias: 1.08, speechBias: 0.98, heatBias: 0.92, portrait: { skin: "#e0ad7a", hair: "#5a3718", suit: "#7a5a13", accent: "#ffe08a" } },
    { name: "Violet", color: "#8250d6", full: "Civic Futures", leader: "Nia Vale", title: "Policy Futurist", region: "sunbelt", talentTree: "futurist", cashBias: 1, speechBias: 1.12, heatBias: 0.84, portrait: { skin: "#d2a289", hair: "#2c174e", suit: "#4b2c93", accent: "#c7adff" } },
    { name: "Cinder", color: "#f97316", full: "Cinder Machine", leader: "Petra Knox", title: "Strike Marshal", region: "midwest", talentTree: "machine", cashBias: 1.06, speechBias: 0.94, heatBias: 0.86, portrait: { skin: "#d5a17f", hair: "#231715", suit: "#5f2a17", accent: "#ffb067" } },
    { name: "Teal", color: "#14b8a6", full: "Teal Wire Accord", leader: "Imani Quill", title: "Signal Cartographer", region: "northeast", talentTree: "signal", cashBias: 0.97, speechBias: 1.1, heatBias: 0.76, portrait: { skin: "#b8805f", hair: "#102a2a", suit: "#0d5a5b", accent: "#7ff4ea" } },
    { name: "Ivory", color: "#e5e7eb", full: "Ivory Ledger Club", leader: "Rafael Sol", title: "Sunbelt Treasurer", region: "south", talentTree: "ledger", cashBias: 1.14, speechBias: 0.99, heatBias: 0.9, portrait: { skin: "#c98a62", hair: "#5e5a4e", suit: "#6c6d71", accent: "#fff4c7" } },
  ];

  const SKIN_PRESETS = ["#f1c6a8", "#d49c72", "#b8805f", "#8f5c45", "#5f3b31", "#ead2b2"];
  const LEADER_VISUALS = [
    { id: "mogul", label: "The Mogul", desc: "Tall forward-swept power combover." },
    { id: "supreme", label: "The Supreme", desc: "Severe high top with shaved sides." },
    { id: "secretary", label: "The Secretary", desc: "Neat conservative side-part." },
    { id: "strongman", label: "The Strongman", desc: "Cropped receding profile." },
    { id: "chancellor", label: "The Chancellor", desc: "Practical compact bob." },
    { id: "disruptor", label: "The Disruptor", desc: "Chaotic windblown mop." },
    { id: "anarcho", label: "The Anarcho", desc: "Wild shag with heavy sideburns." },
    { id: "iron_helmet", label: "The Iron Helmet", desc: "Rigid lacquered power-bob." },
    { id: "charmer", label: "The Charmer", desc: "Polished modern wave." },
    { id: "academic", label: "The Academic", desc: "Bald top with wild side tufts." },
    { id: "orator", label: "The Orator", desc: "Clean geometric buzz cut." },
    { id: "generalissimo", label: "The Generalissimo", desc: "Swept-back field commander hair." },
    { id: "demagogue", label: "The Demagogue", desc: "Rigid flat side-part.", forceFacial: "toothbrush" },
    { id: "steel", label: "The Man of Steel", desc: "Heavy brushed-back volume.", forceFacial: "walrus" },
  ];
  const FACIAL_HAIR = [
    { id: "none", label: "None" },
    { id: "toothbrush", label: "Toothbrush" },
    { id: "walrus", label: "Walrus" },
    { id: "mustache", label: "Statesman" },
    { id: "goatee", label: "Goatee" },
    { id: "beard", label: "Full Beard" },
  ];
  const LEADER_HATS = [
    { id: "none", label: "None" },
    { id: "keffiyeh", label: "Keffiyeh" },
    { id: "campaign_cap", label: "Campaign Cap" },
    { id: "fedora", label: "Fedora" },
    { id: "beret", label: "Beret" },
    { id: "cowboy", label: "Cowboy Hat" },
    { id: "military_cap", label: "Field Cap" },
    { id: "visor", label: "Press Visor" },
  ];
  const PARTY_FLAGS = [
    { id: "campaign_stripes", label: "Campaign Stripes", desc: "US campaign bunting." },
    { id: "red_disc", label: "Red Disc Banner", desc: "Fascist rally banners, fictionalized." },
    { id: "central_star", label: "Central Star", desc: "CCP-style committee flags, fictionalized." },
    { id: "hermit_ray", label: "Hermit Ray", desc: "North Korea parade banners, fictionalized." },
    { id: "eagle_seal", label: "Iron Regime", desc: "Fictional fascist-style warning banner." },
    { id: "workers_gear", label: "Workers Gear", desc: "Labor movement flags." },
    { id: "corporate_grid", label: "Corporate Grid", desc: "Lobbyist boardroom banners." },
    { id: "green_laurel", label: "Green Laurel", desc: "Eco-party civic flags." },
  ];
  const REPLACEMENT_LEADERS = [
    "Avery Knox", "Mina Cross", "Dorian Vale", "Cass Reed", "Nolan Voss", "Iris Park",
    "Silas Quill", "Mara Sol", "Jonas Hart", "Petra Lane", "Elena Frost", "Rafael Stone",
    "Imani Wells", "Theo Grant", "Nia Mercer", "Owen Pike", "Rina Holt", "Calder Finch",
  ];
  const AGGRESSIVE_VISUALS = ["disruptor", "anarcho", "supreme", "demagogue", "steel"];
  const DEFENSIVE_VISUALS = ["iron_helmet", "secretary", "strongman"];
  const EXPANSIONIST_VISUALS = ["charmer", "mogul", "orator"];

  const PARTY_NAME_BANK = [
    [
      { name: "Paywall GOP", full: "Grand Old Paywall Party", source: "United States Republican Party" },
      { name: "Tory Story", full: "Tory Story Club", source: "British Conservative Party" },
      { name: "Whig Wallets", full: "Whig Wallet Committee", source: "British and American Whigs" },
      { name: "Federal Xpress", full: "Federalist Express Society", source: "United States Federalist Party" },
    ],
    [
      { name: "Democrash", full: "Democrash National Committee", source: "United States Democratic Party" },
      { name: "Labor-ish", full: "Labor-ish People's League", source: "British Labour Party" },
      { name: "Social Demos", full: "Social Demo Daydreamers", source: "European Social Democrats" },
      { name: "Reform-ish", full: "Permanent Reform-ish Coalition", source: "Reform parties" },
    ],
    [
      { name: "Pirate Plank", full: "Pirate Party Plank", source: "Pirate Parties International" },
      { name: "Cyber Whigs", full: "Algorithmic Whig Network", source: "Whig parties" },
      { name: "ComNet", full: "Cominternet Working Group", source: "Communist International" },
      { name: "Know-Somes", full: "Know-Something Data Party", source: "Know Nothing Party" },
    ],
    [
      { name: "Bonaparty", full: "Bonaparty Central Office", source: "Bonapartist parties" },
      { name: "Iron Union", full: "Iron Curtain Union", source: "Cold War unity blocs" },
      { name: "Gaullists", full: "Gaullist Ghost Directorate", source: "French Gaullist parties" },
      { name: "Unity Front", full: "National Unity Front Office", source: "National unity parties" },
    ],
    [
      { name: "Caudillo Cash", full: "Caudillo Cash Machine", source: "Latin American strongman parties" },
      { name: "Falange Lite", full: "Falange Lite Committee", source: "Spanish Falange" },
      { name: "Machine Bloc", full: "Metropolitan Machine Bloc", source: "Urban political machines" },
      { name: "Boss Ticket", full: "Boss Ticket Association", source: "Tammany Hall political machines" },
    ],
    [
      { name: "Wire Greens", full: "Wire Greens Network", source: "Green parties" },
      { name: "Data Pirates", full: "Data Pirates Union", source: "Pirate parties" },
      { name: "Technopop", full: "Technopop Civic Array", source: "Technocratic reform parties" },
      { name: "Quartz Left", full: "Quartz Left Platform", source: "Digital left coalitions" },
    ],
    [
      { name: "Pearl Caucus", full: "Pearl Caucus Committee", source: "Centrist reform parties" },
      { name: "Hammer Mates", full: "Hammer Mates Central Committee", source: "Communist parties" },
      { name: "Ledger Liberals", full: "Ledger Liberal Alliance", source: "Classical liberal parties" },
      { name: "White Paper", full: "White Paper Reform Board", source: "Administrative reform movements" },
    ],
  ];

  const AI_RULES = {
    easy: { delay: 4.4, sabotage: 0.12, ad: 0.22 },
    medium: { delay: 3.1, sabotage: 0.24, ad: 0.3 },
    hard: { delay: 2.15, sabotage: 0.38, ad: 0.38 },
  };
  const AI_PERSONALITIES = [
    { id: "powerBroker", evBias: 1.15, lowVoteBias: 0, openBias: 0 },
    { id: "grassroots", evBias: 0.28, lowVoteBias: 22, openBias: 8 },
    { id: "countyBuilder", evBias: 0.45, lowVoteBias: 15, openBias: 12 },
    { id: "spoiler", evBias: 0.68, lowVoteBias: 8, openBias: 5 },
  ];

  const CHANNELS = [
    { id: "wcn", name: "WCN West", reporter: "Maya Cross", section: "Pacific / Interior", coverage: ["WA","OR","CA","ID","NV","UT","MT","WY","CO","AK","HI","AZ","NM"], voice: { pitch: 430, type: "triangle", speed: 0.078, volume: 0.038 } },
    { id: "hbn", name: "HBN Heartland", reporter: "Drew Keller", section: "Industrial / Plains", coverage: ["ND","SD","NE","KS","MN","IA","MO","WI","IL","MI","IN","OH","KY","TN","WV","DE"], voice: { pitch: 290, type: "sine", speed: 0.084, volume: 0.036 } },
    { id: "scn", name: "SCN South", reporter: "Rina Vale", section: "Gulf / Deep South", coverage: ["TX","OK","AR","LA","MS","AL","GA","FL","SC"], voice: { pitch: 390, type: "triangle", speed: 0.08, volume: 0.036 } },
    { id: "ecn", name: "ECN East", reporter: "Owen Park", section: "Atlantic / Northeast", coverage: ["PA","NY","VT","NH","ME","MA","RI","CT","NJ","MD","VA","NC"], voice: { pitch: 470, type: "sine", speed: 0.076, volume: 0.038 } },
  ];

  const STATE_DATA = [
    { abbr: "WA", name: "Washington", ev: 12, x: 88, y: 76, w: 70, h: 48, region: "west" },
    { abbr: "OR", name: "Oregon", ev: 8, x: 82, y: 129, w: 76, h: 52, region: "west" },
    { abbr: "CA", name: "California", ev: 54, x: 78, y: 190, w: 78, h: 148, region: "west" },
    { abbr: "ID", name: "Idaho", ev: 4, x: 166, y: 112, w: 58, h: 86, region: "west" },
    { abbr: "NV", name: "Nevada", ev: 6, x: 164, y: 204, w: 70, h: 92, region: "west" },
    { abbr: "AZ", name: "Arizona", ev: 11, x: 176, y: 304, w: 82, h: 66, region: "sunbelt" },
    { abbr: "UT", name: "Utah", ev: 6, x: 238, y: 218, w: 72, h: 78, region: "west" },
    { abbr: "MT", name: "Montana", ev: 4, x: 232, y: 76, w: 126, h: 52, region: "west" },
    { abbr: "WY", name: "Wyoming", ev: 3, x: 280, y: 138, w: 92, h: 56, region: "west" },
    { abbr: "CO", name: "Colorado", ev: 10, x: 318, y: 218, w: 92, h: 70, region: "west" },
    { abbr: "NM", name: "New Mexico", ev: 5, x: 268, y: 304, w: 84, h: 70, region: "sunbelt" },
    { abbr: "AK", name: "Alaska", ev: 3, x: 74, y: 444, w: 122, h: 72, region: "west", inset: true },
    { abbr: "HI", name: "Hawaii", ev: 4, x: 218, y: 480, w: 76, h: 38, region: "west", inset: true },
    { abbr: "ND", name: "North Dakota", ev: 3, x: 372, y: 78, w: 90, h: 48, region: "midwest" },
    { abbr: "SD", name: "South Dakota", ev: 3, x: 378, y: 135, w: 94, h: 50, region: "midwest" },
    { abbr: "NE", name: "Nebraska", ev: 5, x: 386, y: 192, w: 104, h: 48, region: "midwest" },
    { abbr: "KS", name: "Kansas", ev: 6, x: 418, y: 248, w: 98, h: 52, region: "midwest" },
    { abbr: "OK", name: "Oklahoma", ev: 7, x: 424, y: 306, w: 106, h: 50, region: "south" },
    { abbr: "TX", name: "Texas", ev: 40, x: 384, y: 364, w: 160, h: 104, region: "south" },
    { abbr: "MN", name: "Minnesota", ev: 10, x: 470, y: 82, w: 82, h: 66, region: "midwest" },
    { abbr: "IA", name: "Iowa", ev: 6, x: 496, y: 166, w: 76, h: 54, region: "midwest" },
    { abbr: "MO", name: "Missouri", ev: 10, x: 524, y: 232, w: 80, h: 70, region: "midwest" },
    { abbr: "AR", name: "Arkansas", ev: 6, x: 540, y: 310, w: 70, h: 56, region: "south" },
    { abbr: "LA", name: "Louisiana", ev: 8, x: 548, y: 374, w: 70, h: 56, region: "south" },
    { abbr: "WI", name: "Wisconsin", ev: 10, x: 558, y: 102, w: 70, h: 62, region: "midwest" },
    { abbr: "IL", name: "Illinois", ev: 19, x: 580, y: 184, w: 58, h: 82, region: "midwest" },
    { abbr: "MS", name: "Mississippi", ev: 6, x: 624, y: 360, w: 52, h: 70, region: "south" },
    { abbr: "MI", name: "Michigan", ev: 15, x: 634, y: 108, w: 88, h: 68, region: "midwest" },
    { abbr: "IN", name: "Indiana", ev: 11, x: 646, y: 196, w: 50, h: 70, region: "midwest" },
    { abbr: "KY", name: "Kentucky", ev: 8, x: 642, y: 270, w: 88, h: 44, region: "south" },
    { abbr: "TN", name: "Tennessee", ev: 11, x: 636, y: 320, w: 118, h: 42, region: "south" },
    { abbr: "AL", name: "Alabama", ev: 9, x: 682, y: 360, w: 56, h: 70, region: "south" },
    { abbr: "OH", name: "Ohio", ev: 17, x: 704, y: 198, w: 58, h: 68, region: "midwest" },
    { abbr: "GA", name: "Georgia", ev: 16, x: 744, y: 360, w: 70, h: 74, region: "south" },
    { abbr: "FL", name: "Florida", ev: 30, x: 782, y: 438, w: 132, h: 56, region: "sunbelt" },
    { abbr: "WV", name: "West Virginia", ev: 4, x: 752, y: 266, w: 48, h: 46, region: "south" },
    { abbr: "VA", name: "Virginia", ev: 13, x: 804, y: 276, w: 82, h: 42, region: "south" },
    { abbr: "NC", name: "North Carolina", ev: 16, x: 794, y: 324, w: 108, h: 42, region: "south" },
    { abbr: "SC", name: "South Carolina", ev: 9, x: 816, y: 372, w: 70, h: 42, region: "south" },
    { abbr: "PA", name: "Pennsylvania", ev: 19, x: 764, y: 196, w: 98, h: 50, region: "northeast" },
    { abbr: "NY", name: "New York", ev: 28, x: 792, y: 128, w: 108, h: 58, region: "northeast" },
    { abbr: "VT", name: "Vermont", ev: 3, x: 910, y: 112, w: 28, h: 40, region: "northeast" },
    { abbr: "NH", name: "New Hampshire", ev: 4, x: 944, y: 112, w: 28, h: 42, region: "northeast" },
    { abbr: "ME", name: "Maine", ev: 4, x: 928, y: 54, w: 56, h: 54, region: "northeast" },
    { abbr: "MA", name: "Massachusetts", ev: 11, x: 904, y: 190, w: 72, h: 24, region: "northeast" },
    { abbr: "RI", name: "Rhode Island", ev: 4, x: 958, y: 220, w: 24, h: 22, region: "northeast" },
    { abbr: "CT", name: "Connecticut", ev: 7, x: 904, y: 220, w: 48, h: 24, region: "northeast" },
    { abbr: "NJ", name: "New Jersey", ev: 14, x: 890, y: 246, w: 30, h: 46, region: "northeast" },
    { abbr: "DE", name: "Delaware", ev: 3, x: 904, y: 298, w: 28, h: 34, region: "northeast" },
    { abbr: "MD", name: "Maryland", ev: 10, x: 852, y: 250, w: 36, h: 24, region: "northeast" },
  ];

  const GEO_STATES = {"AL":{"shapes":[[{"x":657.1,"y":383.8},{"x":665.2,"y":382.9},{"x":668.6,"y":382.6},{"x":677.2,"y":382},{"x":682.2,"y":381.6},{"x":684.2,"y":381.3},{"x":692.8,"y":380.5},{"x":696.1,"y":380.2},{"x":697.5,"y":385.3},{"x":699.5,"y":392.2},{"x":701.1,"y":398.2},{"x":702.4,"y":402.8},{"x":703.8,"y":407.7},{"x":706.9,"y":418.8},{"x":708.1,"y":420.5},{"x":708.6,"y":422.9},{"x":710.4,"y":424.9},{"x":710.7,"y":426.2},{"x":710.9,"y":428.7},{"x":712.7,"y":429.6},{"x":711.7,"y":430.5},{"x":710.4,"y":432.2},{"x":710.8,"y":434.5},{"x":710.5,"y":435.9},{"x":709.9,"y":437.1},{"x":710.3,"y":439.8},{"x":711.5,"y":441.8},{"x":711.9,"y":443.7},{"x":711.8,"y":445.3},{"x":711.5,"y":446.6},{"x":711.4,"y":448.3},{"x":711.7,"y":449.9},{"x":713,"y":451.2},{"x":713.7,"y":453.2},{"x":709.9,"y":453.6},{"x":705.9,"y":454.1},{"x":699.7,"y":454.9},{"x":689.8,"y":455.9},{"x":682.2,"y":456.5},{"x":672.7,"y":457.4},{"x":672.4,"y":459.9},{"x":674,"y":461.4},{"x":676.4,"y":463.1},{"x":675.9,"y":465.9},{"x":677.4,"y":467.5},{"x":676.1,"y":469.5},{"x":675.2,"y":470.6},{"x":673.1,"y":471.4},{"x":670.8,"y":471.9},{"x":667.6,"y":472.3},{"x":669.3,"y":471.9},{"x":671.3,"y":471.3},{"x":670.5,"y":470.1},{"x":668.8,"y":468.8},{"x":668.3,"y":467.4},{"x":668.4,"y":464.9},{"x":666.8,"y":463.8},{"x":666.1,"y":465.2},{"x":665.8,"y":466.8},{"x":665.6,"y":469.6},{"x":664.4,"y":470.9},{"x":663.2,"y":469.7},{"x":661.1,"y":470.1},{"x":660.6,"y":466.6},{"x":660,"y":460.9},{"x":659.1,"y":454.2},{"x":657.6,"y":441.9},{"x":657.7,"y":437.4},{"x":658,"y":425.9},{"x":658,"y":422.5},{"x":658.3,"y":404.4},{"x":658.5,"y":401.8},{"x":658.6,"y":391.4},{"x":658.8,"y":385.6}]],"x":657.1,"y":380.2,"w":56.6,"h":92.1,"cx":681.7,"cy":423.2},"AK":{"shapes":[[{"x":208.2,"y":540.5},{"x":209.1,"y":539.4},{"x":210.2,"y":538.6},{"x":211.3,"y":539.6},{"x":212.1,"y":538.5},{"x":211.6,"y":537.3},{"x":212.5,"y":538.2},{"x":212.5,"y":536.8},{"x":214,"y":537.3},{"x":215.3,"y":536.4},{"x":214.7,"y":537.9},{"x":215.6,"y":536.9},{"x":216.8,"y":537.7},{"x":216.3,"y":538.9},{"x":215.1,"y":539.6},{"x":215.5,"y":541.1},{"x":214,"y":540.9},{"x":214.8,"y":542.1},{"x":213.4,"y":543},{"x":213.4,"y":541.6},{"x":212.2,"y":542.4},{"x":212.1,"y":543.8},{"x":210.8,"y":544.5},{"x":211.5,"y":543.3},{"x":211.6,"y":541.9},{"x":210.7,"y":543.1},{"x":209.1,"y":543}],[{"x":168,"y":517.6},{"x":169.3,"y":517.8},{"x":170.8,"y":517.5},{"x":172.3,"y":516.9},{"x":173.4,"y":517.9},{"x":173.5,"y":519.4},{"x":172.7,"y":520.6},{"x":171.4,"y":521.3},{"x":170.2,"y":520.4},{"x":169.1,"y":519.4}],[{"x":157.4,"y":561.3},{"x":158.9,"y":560.9},{"x":160.2,"y":560.5},{"x":161.2,"y":559.4},{"x":161.3,"y":557.9},{"x":162.9,"y":557.7},{"x":164.2,"y":558.2},{"x":162.9,"y":559.5},{"x":164.3,"y":559.3},{"x":163.2,"y":560.3},{"x":162.1,"y":561.1},{"x":160.8,"y":561.2},{"x":159.5,"y":561.6}],[{"x":173.3,"y":482.5},{"x":175.1,"y":481.7},{"x":176.3,"y":481.1},{"x":178.1,"y":480.2},{"x":180.2,"y":479.3},{"x":182,"y":478.8},{"x":183.3,"y":478.5},{"x":185.4,"y":478.5},{"x":185.3,"y":479.8},{"x":184.5,"y":480.9},{"x":185.6,"y":482},{"x":187.2,"y":482.1},{"x":188.7,"y":482.4},{"x":190.2,"y":482.9},{"x":191.2,"y":481.6},{"x":192.6,"y":481.8},{"x":191.8,"y":480.7},{"x":190.3,"y":480.8},{"x":190,"y":479},{"x":189.1,"y":477.8},{"x":190.1,"y":478.8},{"x":191.3,"y":480.3},{"x":190.7,"y":478.4},{"x":191.4,"y":476.9},{"x":190,"y":476.5},{"x":188.7,"y":476.2},{"x":187.3,"y":475.7},{"x":186.4,"y":474.6},{"x":186,"y":472.4},{"x":184.9,"y":471},{"x":183.9,"y":469.6},{"x":182.9,"y":468.5},{"x":181.8,"y":467.4},{"x":180.4,"y":466.2},{"x":181.5,"y":465.3},{"x":182.1,"y":463.6},{"x":183.6,"y":463.4},{"x":185.5,"y":463.5},{"x":186.8,"y":463.4},{"x":188.2,"y":462.8},{"x":189.5,"y":461.4},{"x":190,"y":459.5},{"x":190.5,"y":458.3},{"x":191.9,"y":456.5},{"x":193.4,"y":455.3},{"x":194.7,"y":455.7},{"x":196.6,"y":454.8},{"x":197.6,"y":453.8},{"x":198.6,"y":452.9},{"x":200.1,"y":453},{"x":201.7,"y":453},{"x":203.4,"y":452.2},{"x":204.2,"y":451.1},{"x":205.5,"y":449.7},{"x":206.6,"y":450.9},{"x":207,"y":452.2},{"x":208.4,"y":452.2},{"x":209.7,"y":452.1},{"x":210.5,"y":453.3},{"x":212.1,"y":452.8},{"x":214,"y":452.8},{"x":214.4,"y":454.5},{"x":215.8,"y":454.9},{"x":217,"y":455.8},{"x":218.3,"y":455.4},{"x":219.7,"y":455.4},{"x":221,"y":454.8},{"x":222.4,"y":455.3},{"x":223.5,"y":456},{"x":224.9,"y":456.4},{"x":226.3,"y":456.7},{"x":227.7,"y":456.3},{"x":229.1,"y":456.4},{"x":230.3,"y":457},{"x":232.1,"y":457.2},{"x":233.5,"y":456.1},{"x":235,"y":455.5},{"x":236.2,"y":456},{"x":237.4,"y":456.7},{"x":238.8,"y":457.2},{"x":240.1,"y":457.7},{"x":250.4,"y":507},{"x":251.4,"y":512.4},{"x":252.4,"y":517.3},{"x":254,"y":517.5},{"x":255.7,"y":517.4},{"x":256.4,"y":516.2},{"x":258.3,"y":515.7},{"x":258.4,"y":517.4},{"x":259.9,"y":518.2},{"x":260.9,"y":519.2},{"x":264.7,"y":521.6},{"x":265.5,"y":523.1},{"x":267.3,"y":521.7},{"x":268.3,"y":520.4},{"x":268.6,"y":518.7},{"x":269.3,"y":517.6},{"x":270.5,"y":516.3},{"x":271.9,"y":517.1},{"x":272.5,"y":518.3},{"x":274,"y":519},{"x":275.4,"y":520},{"x":277.7,"y":521.4},{"x":279,"y":522.4},{"x":280.2,"y":523.8},{"x":281.7,"y":525.2},{"x":283.3,"y":526.6},{"x":284.4,"y":527.7},{"x":286,"y":529.1},{"x":287.1,"y":531.1},{"x":288.4,"y":531.8},{"x":290,"y":532.3},{"x":291.6,"y":532.7},{"x":293.5,"y":533},{"x":294.8,"y":533.5},{"x":296.2,"y":533.9},{"x":296.2,"y":535.5},{"x":297.1,"y":537},{"x":297.9,"y":538.2},{"x":297.7,"y":539.6},{"x":297.2,"y":541.5},{"x":296.1,"y":542.4},{"x":295.3,"y":541.4},{"x":294.3,"y":540.2},{"x":294.6,"y":538.9},{"x":293.8,"y":536.8},{"x":292.7,"y":535.9},{"x":293.6,"y":537},{"x":294,"y":538.3},{"x":294,"y":540.2},{"x":293.2,"y":539.2},{"x":292,"y":539.9},{"x":290.9,"y":539.1},{"x":290.9,"y":537.6},{"x":290.6,"y":539.1},{"x":289.2,"y":538.4},{"x":289.3,"y":536.6},{"x":289.2,"y":535.1},{"x":289,"y":536.7},{"x":287.6,"y":536.5},{"x":286.5,"y":535.6},{"x":287.5,"y":534.6},{"x":286.9,"y":533.2},{"x":285.9,"y":532.3},{"x":284.5,"y":531.6},{"x":283.1,"y":530.9},{"x":281.8,"y":530.7},{"x":282.3,"y":529.5},{"x":281.2,"y":528.7},{"x":280.3,"y":527.5},{"x":282.1,"y":527.8},{"x":280.5,"y":527.1},{"x":279.2,"y":526.4},{"x":278,"y":525.1},{"x":277.8,"y":523.6},{"x":277.8,"y":525},{"x":276.1,"y":525.2},{"x":275.1,"y":523.8},{"x":274.1,"y":522.9},{"x":272.9,"y":521},{"x":272.2,"y":519.9},{"x":272.4,"y":521.6},{"x":273.2,"y":522.7},{"x":274.3,"y":524.6},{"x":274.8,"y":526},{"x":273.4,"y":525.4},{"x":271.7,"y":525.6},{"x":271.2,"y":524.1},{"x":270.3,"y":523},{"x":269,"y":523.2},{"x":267.5,"y":522.8},{"x":269.2,"y":523.6},{"x":270.4,"y":524.6},{"x":271.2,"y":525.7},{"x":270.2,"y":526.5},{"x":268.7,"y":526.8},{"x":267.2,"y":526.3},{"x":265.5,"y":525.6},{"x":264.4,"y":524.8},{"x":263.2,"y":523.5},{"x":261.6,"y":523.1},{"x":259.2,"y":522.3},{"x":257.4,"y":521.6},{"x":257.9,"y":520.1},{"x":257.3,"y":518.9},{"x":255.8,"y":520.3},{"x":254.3,"y":520.9},{"x":251.6,"y":520.3},{"x":251.5,"y":518.8},{"x":250.5,"y":519.9},{"x":249.2,"y":519.7},{"x":247.8,"y":519.6},{"x":245.9,"y":520.1},{"x":244.2,"y":520.6},{"x":242.6,"y":521},{"x":241.5,"y":522.5},{"x":242.5,"y":520.7},{"x":241.3,"y":519.9},{"x":240.1,"y":519.4},{"x":238.1,"y":519},{"x":236.6,"y":518.7},{"x":235.5,"y":519.7},{"x":234.2,"y":519.8},{"x":235.3,"y":518.8},{"x":236.5,"y":518},{"x":236,"y":516.8},{"x":234.8,"y":517.5},{"x":235.6,"y":516.2},{"x":234.2,"y":516.4},{"x":234.1,"y":515},{"x":233,"y":516.1},{"x":232.8,"y":514.7},{"x":232.5,"y":516.1},{"x":231.2,"y":516.4},{"x":229.8,"y":517.4},{"x":229.9,"y":515.8},{"x":230.5,"y":514.3},{"x":229.7,"y":515.4},{"x":228.9,"y":516.6},{"x":228.7,"y":518.1},{"x":229,"y":519.5},{"x":230.1,"y":520.7},{"x":230.9,"y":522},{"x":229.9,"y":522.9},{"x":229.2,"y":521.7},{"x":229,"y":523},{"x":227.6,"y":523.2},{"x":226.3,"y":523.6},{"x":225.9,"y":522},{"x":225.7,"y":523.4},{"x":225.6,"y":524.8},{"x":225,"y":523.3},{"x":224.9,"y":524.9},{"x":223.5,"y":526},{"x":222.9,"y":527.3},{"x":223,"y":525.7},{"x":222.1,"y":526.8},{"x":221.3,"y":527.9},{"x":219.9,"y":528.3},{"x":218.5,"y":528.7},{"x":217.6,"y":527.7},{"x":218.7,"y":526.6},{"x":219.9,"y":525.8},{"x":220.8,"y":524.5},{"x":219.7,"y":525.2},{"x":218.2,"y":525.1},{"x":218.2,"y":523.8},{"x":218.9,"y":522.4},{"x":219.3,"y":520.8},{"x":219.4,"y":519.4},{"x":220.4,"y":517.9},{"x":221.3,"y":517},{"x":222.9,"y":517.1},{"x":224.2,"y":516.6},{"x":225.6,"y":517},{"x":224.3,"y":516.3},{"x":223.2,"y":515.4},{"x":224,"y":514.3},{"x":225.1,"y":513.4},{"x":223.7,"y":513.9},{"x":222.8,"y":514.8},{"x":221.3,"y":514.6},{"x":220.2,"y":515.4},{"x":219.2,"y":516.6},{"x":217.9,"y":517.6},{"x":217.2,"y":518.9},{"x":216.3,"y":520},{"x":216.1,"y":521.4},{"x":215.2,"y":522.4},{"x":215.2,"y":523.9},{"x":213.7,"y":524.2},{"x":213.5,"y":525.7},{"x":212.3,"y":526.3},{"x":211.1,"y":527.3},{"x":210.4,"y":528.7},{"x":211.5,"y":529.5},{"x":213,"y":530.1},{"x":213,"y":531.5},{"x":211.5,"y":532.4},{"x":210.8,"y":533.8},{"x":210.5,"y":535},{"x":209.4,"y":536},{"x":207.9,"y":536.2},{"x":206.7,"y":537.5},{"x":205.4,"y":537.8},{"x":204.9,"y":539.2},{"x":203.6,"y":539.9},{"x":202.3,"y":540.5},{"x":202.4,"y":541.9},{"x":201.1,"y":542.9},{"x":200.1,"y":543.7},{"x":198.7,"y":543.6},{"x":198.6,"y":545},{"x":197,"y":544.8},{"x":196.2,"y":546},{"x":194.8,"y":546.4},{"x":195.6,"y":547.6},{"x":194.8,"y":548.9},{"x":193.3,"y":548.8},{"x":191.8,"y":549.4},{"x":190.7,"y":550.5},{"x":189.8,"y":549.4},{"x":188.3,"y":550.6},{"x":187.2,"y":551.3},{"x":185.8,"y":551.6},{"x":184.3,"y":552.1},{"x":184,"y":550.7},{"x":182.7,"y":551.6},{"x":181.7,"y":552.9},{"x":180.4,"y":553.4},{"x":179.5,"y":552.3},{"x":179.1,"y":553.8},{"x":177.8,"y":554},{"x":176.9,"y":553},{"x":176.6,"y":554.5},{"x":177,"y":555.8},{"x":175.6,"y":555.3},{"x":174.2,"y":555.6},{"x":172.5,"y":555.7},{"x":171.5,"y":556.6},{"x":170.1,"y":556.4},{"x":170.6,"y":555},{"x":171.6,"y":553.8},{"x":173,"y":553.5},{"x":174.2,"y":552.9},{"x":175.6,"y":553.1},{"x":175.8,"y":554.3},{"x":176.4,"y":552.7},{"x":177.8,"y":552.6},{"x":179.2,"y":551.3},{"x":180.8,"y":549.6},{"x":182.2,"y":548.8},{"x":183.4,"y":548.3},{"x":185.1,"y":547.9},{"x":185.7,"y":549.3},{"x":187.3,"y":549.1},{"x":187.6,"y":547.5},{"x":188.4,"y":546.3},{"x":189.7,"y":545.4},{"x":191.2,"y":544.5},{"x":193.1,"y":543.4},{"x":194.5,"y":543.3},{"x":195,"y":541.5},{"x":195.9,"y":540.5},{"x":197.3,"y":539.4},{"x":198.4,"y":538.6},{"x":198.7,"y":535.2},{"x":198.9,"y":533.9},{"x":199.6,"y":532.6},{"x":200.6,"y":531.5},{"x":201,"y":530.3},{"x":199.7,"y":530.8},{"x":198,"y":531.6},{"x":196.7,"y":531.9},{"x":195.6,"y":530.6},{"x":196,"y":529.4},{"x":194.9,"y":530.5},{"x":194.8,"y":532.2},{"x":193.4,"y":532.1},{"x":192.7,"y":530.4},{"x":191.1,"y":530.4},{"x":190.1,"y":529.5},{"x":188.8,"y":529},{"x":187.5,"y":529.6},{"x":186.3,"y":530.2},{"x":185.3,"y":531},{"x":183.8,"y":530.7},{"x":184.9,"y":529.8},{"x":184.9,"y":528.1},{"x":184.4,"y":526.5},{"x":185.4,"y":525.3},{"x":185.2,"y":523.5},{"x":184.7,"y":522.1},{"x":184.1,"y":520.8},{"x":183,"y":521.7},{"x":181.5,"y":522.2},{"x":179.6,"y":522.4},{"x":178.2,"y":521.9},{"x":177.5,"y":520.2},{"x":176.9,"y":519},{"x":175.5,"y":517.5},{"x":176,"y":515.9},{"x":176.8,"y":514.4},{"x":176.2,"y":513.1},{"x":174.8,"y":512.5},{"x":174.2,"y":511.3},{"x":174.4,"y":509.9},{"x":174.1,"y":508.2},{"x":175.5,"y":508.2},{"x":175.5,"y":506.7},{"x":177.1,"y":504.9},{"x":178,"y":503.7},{"x":178.9,"y":502.5},{"x":179.5,"y":501.2},{"x":180.6,"y":500},{"x":182.2,"y":500.2},{"x":183.2,"y":501},{"x":184.4,"y":501.6},{"x":185.7,"y":500.6},{"x":186.8,"y":499.3},{"x":188.3,"y":499.5},{"x":189.8,"y":499.5},{"x":191.1,"y":498.4},{"x":191.5,"y":496.9},{"x":191.3,"y":495},{"x":190.7,"y":493.7},{"x":191.6,"y":492.7},{"x":191.8,"y":490.9},{"x":190.2,"y":491.2},{"x":188.3,"y":491.4},{"x":187.2,"y":492.3},{"x":186.3,"y":493.5},{"x":186.1,"y":492},{"x":184.6,"y":491.9},{"x":183.2,"y":491.6},{"x":180.8,"y":491.9},{"x":179.2,"y":491.3},{"x":177.9,"y":490.7},{"x":176.6,"y":489.8},{"x":176.9,"y":488.3},{"x":175.9,"y":486.8},{"x":177.2,"y":486.1},{"x":175.9,"y":484.8},{"x":174.5,"y":484.1}],[{"x":160,"y":493.3},{"x":160.7,"y":491.9},{"x":161.4,"y":493.1},{"x":162.7,"y":493.9},{"x":164,"y":493.4},{"x":165,"y":494.8},{"x":166.1,"y":495.9},{"x":167.4,"y":496.6},{"x":168.1,"y":497.8},{"x":166.3,"y":497.6},{"x":165.2,"y":498.8},{"x":164.7,"y":497.3},{"x":163.7,"y":496.1},{"x":162.5,"y":494.9},{"x":161.1,"y":495}],[{"x":283.2,"y":538.6},{"x":283.5,"y":537.3},{"x":283.2,"y":535.9},{"x":284.7,"y":535.7},{"x":285.5,"y":536.8},{"x":287.4,"y":537.5},{"x":288.5,"y":538.9},{"x":289.8,"y":539.6},{"x":288.4,"y":540.2},{"x":289.7,"y":540.2},{"x":290.3,"y":541.4},{"x":290.8,"y":542.7},{"x":292.1,"y":543.7},{"x":291,"y":544.6},{"x":290,"y":543.7},{"x":289.4,"y":542.5},{"x":288.2,"y":543.3},{"x":287.3,"y":542.2},{"x":287.8,"y":543.4},{"x":288.9,"y":544.2},{"x":289.8,"y":545.3},{"x":287.6,"y":544.2},{"x":286.7,"y":542.5},{"x":286.3,"y":540.8},{"x":285.1,"y":540.2},{"x":284,"y":539.3}],[{"x":279.4,"y":533.7},{"x":280.5,"y":532.9},{"x":281.4,"y":531.6},{"x":282.8,"y":531.6},{"x":284.4,"y":532},{"x":285.9,"y":532.9},{"x":285.6,"y":534.2},{"x":284.3,"y":534.9},{"x":283,"y":535.4},{"x":282.4,"y":536.7},{"x":282.3,"y":538.1},{"x":280.9,"y":537.1},{"x":280.8,"y":535.5}],[{"x":274.7,"y":524.5},{"x":276,"y":525.8},{"x":277.7,"y":525.3},{"x":278.7,"y":526.6},{"x":279.6,"y":528},{"x":278.4,"y":526.9},{"x":279.2,"y":528.3},{"x":280.1,"y":529.3},{"x":279.7,"y":530.6},{"x":279.1,"y":532},{"x":278.1,"y":531.1},{"x":277.5,"y":529.8},{"x":276.7,"y":528.6},{"x":276.2,"y":527},{"x":275.5,"y":525.9}],[{"x":274.2,"y":531.8},{"x":274.7,"y":530.3},{"x":276.2,"y":530.8},{"x":277.3,"y":531.7},{"x":278,"y":533},{"x":278.9,"y":534.7},{"x":279.4,"y":536.3},{"x":279.8,"y":537.6},{"x":277.8,"y":536.3},{"x":276.5,"y":535.3},{"x":275.8,"y":534.2},{"x":275.5,"y":532.8}],[{"x":270.2,"y":529},{"x":270.6,"y":527.5},{"x":271.8,"y":526.8},{"x":273,"y":526.3},{"x":273.2,"y":527.8},{"x":274.2,"y":526.8},{"x":275.7,"y":527.2},{"x":275.7,"y":528.5},{"x":276.8,"y":530.1},{"x":275.4,"y":530.2},{"x":274,"y":529.7},{"x":274.4,"y":531.2},{"x":272.7,"y":531.2},{"x":271.7,"y":530.3}]],"x":157.4,"y":449.7,"w":140.5,"h":111.9,"cx":215.6,"cy":497.8},"AZ":{"shapes":[[{"x":250.6,"y":402.6},{"x":252.2,"y":402.7},{"x":253.7,"y":402.5},{"x":254.9,"y":401.1},{"x":254.8,"y":397.5},{"x":252.9,"y":396.8},{"x":252.7,"y":394.9},{"x":253.3,"y":392.7},{"x":253.3,"y":390.9},{"x":256,"y":388.2},{"x":257,"y":385.5},{"x":257.6,"y":384.2},{"x":257.7,"y":382.3},{"x":257.8,"y":381},{"x":259.6,"y":379.5},{"x":260.4,"y":378},{"x":261.7,"y":377.8},{"x":263.3,"y":377.1},{"x":265,"y":376.1},{"x":264.6,"y":374.3},{"x":262.6,"y":372},{"x":261.6,"y":366.8},{"x":260.5,"y":365.5},{"x":259.7,"y":363.3},{"x":260.2,"y":361},{"x":260.8,"y":359.6},{"x":261.8,"y":357.5},{"x":261.9,"y":354.6},{"x":261.4,"y":352.7},{"x":261.8,"y":351.2},{"x":262.1,"y":349.6},{"x":261.8,"y":347.7},{"x":262,"y":346},{"x":262.9,"y":344.9},{"x":262.2,"y":342.6},{"x":262.4,"y":340.6},{"x":263.8,"y":340.4},{"x":265.3,"y":340},{"x":267.5,"y":340.6},{"x":268.9,"y":342.1},{"x":269.7,"y":343.5},{"x":272.8,"y":340.9},{"x":273.9,"y":337.1},{"x":274.6,"y":332.8},{"x":275.9,"y":325.9},{"x":286.3,"y":327.8},{"x":297.8,"y":329.9},{"x":314.1,"y":332.7},{"x":319.1,"y":333.5},{"x":327.5,"y":334.7},{"x":340,"y":336.7},{"x":348.5,"y":337.9},{"x":344.8,"y":364.9},{"x":344.2,"y":368.7},{"x":342.1,"y":383.9},{"x":340.7,"y":393.6},{"x":340.5,"y":395.9},{"x":340.2,"y":397.7},{"x":333.9,"y":442.9},{"x":330.3,"y":442.4},{"x":319,"y":440.8},{"x":311.8,"y":439.7},{"x":302.2,"y":438.2},{"x":283.4,"y":427.3},{"x":272.4,"y":421},{"x":267.2,"y":417.8},{"x":248.3,"y":406.5},{"x":248.6,"y":405.2},{"x":249.3,"y":404.1}]],"x":248.3,"y":325.9,"w":100.2,"h":117,"cx":302.1,"cy":382.4},"CO":{"shapes":[[{"x":358.7,"y":263.6},{"x":370.7,"y":265.2},{"x":378.3,"y":266.1},{"x":394.5,"y":268},{"x":397.8,"y":268.4},{"x":404.6,"y":269.1},{"x":416.6,"y":270.3},{"x":427.7,"y":271.2},{"x":441.8,"y":272.3},{"x":448.5,"y":272.8},{"x":455.5,"y":273.3},{"x":454.3,"y":292},{"x":453.9,"y":298.1},{"x":453.5,"y":305.1},{"x":453.3,"y":308.2},{"x":452,"y":328.6},{"x":451.9,"y":330.8},{"x":450.8,"y":348.3},{"x":441.2,"y":347.6},{"x":436.8,"y":347.2},{"x":426.1,"y":346.4},{"x":417.2,"y":345.8},{"x":407.5,"y":344.9},{"x":405.7,"y":344.7},{"x":389.9,"y":343.1},{"x":380.2,"y":342},{"x":372.1,"y":340.9},{"x":360.1,"y":339.5},{"x":348.5,"y":337.9},{"x":349.8,"y":328.6},{"x":351.5,"y":316.2},{"x":351.5,"y":314.1},{"x":352.7,"y":305.9},{"x":353.3,"y":302.5},{"x":357.4,"y":272.8}]],"x":348.5,"y":263.6,"w":107,"h":84.7,"cx":403.3,"cy":306.7},"FL":{"shapes":[[{"x":781.6,"y":564.1},{"x":782.5,"y":562.3},{"x":783.6,"y":561.4},{"x":785,"y":560.5},{"x":787.2,"y":558.7},{"x":789.7,"y":559.4},{"x":791,"y":560.7},{"x":788.5,"y":562},{"x":786.6,"y":562},{"x":783.8,"y":563.9}],[{"x":713.7,"y":453.2},{"x":714.2,"y":454.4},{"x":715.2,"y":456.4},{"x":716.6,"y":458.3},{"x":724.3,"y":457.7},{"x":739.3,"y":456.7},{"x":751,"y":455.9},{"x":758.8,"y":455.4},{"x":759.2,"y":456.9},{"x":760,"y":459.1},{"x":762.1,"y":458.6},{"x":762.1,"y":456.6},{"x":762,"y":454.7},{"x":761.1,"y":453.4},{"x":761.1,"y":451.6},{"x":762.3,"y":450},{"x":763.6,"y":450.4},{"x":765.6,"y":450.6},{"x":768,"y":451},{"x":769.8,"y":450.8},{"x":770.9,"y":452.9},{"x":771.3,"y":454.4},{"x":772.2,"y":456.5},{"x":772.5,"y":458.3},{"x":774.8,"y":464.2},{"x":775.8,"y":466.2},{"x":778.3,"y":471.5},{"x":780.9,"y":475.7},{"x":783.1,"y":479.1},{"x":787.9,"y":484.9},{"x":790.6,"y":487.7},{"x":791.8,"y":489.9},{"x":790.9,"y":491},{"x":791,"y":493.2},{"x":791.6,"y":495.2},{"x":792.2,"y":496.7},{"x":793.5,"y":498.8},{"x":796.2,"y":502.7},{"x":797.5,"y":505.1},{"x":798.1,"y":506.4},{"x":799.4,"y":508.9},{"x":800.8,"y":511.1},{"x":802.1,"y":513.5},{"x":803.2,"y":515},{"x":804.9,"y":518.9},{"x":805.4,"y":522.6},{"x":805.5,"y":525.4},{"x":805.7,"y":528.7},{"x":805.9,"y":533.9},{"x":806.4,"y":536.5},{"x":806.2,"y":539.1},{"x":804.7,"y":538.9},{"x":804.4,"y":540.6},{"x":804.2,"y":542},{"x":803.9,"y":543.9},{"x":804.7,"y":545.3},{"x":803.9,"y":546.5},{"x":806.1,"y":543.2},{"x":806.2,"y":544.5},{"x":804.8,"y":548.3},{"x":804.4,"y":549.6},{"x":803.2,"y":551.3},{"x":801.5,"y":553.8},{"x":800.2,"y":555.1},{"x":801.7,"y":552.7},{"x":802.8,"y":551},{"x":803,"y":549.2},{"x":801.5,"y":548.8},{"x":799.2,"y":549.9},{"x":798,"y":550.8},{"x":796.8,"y":550.3},{"x":795.4,"y":551.4},{"x":793.8,"y":551.9},{"x":792.4,"y":552.2},{"x":791.3,"y":551.6},{"x":790.6,"y":549.3},{"x":790.9,"y":547.6},{"x":789.9,"y":546.2},{"x":789.2,"y":545},{"x":787.8,"y":543.7},{"x":787.3,"y":542.4},{"x":785.5,"y":541.1},{"x":784,"y":540.8},{"x":782.5,"y":540.2},{"x":781.2,"y":539.5},{"x":780.1,"y":540.5},{"x":778.9,"y":538.7},{"x":777.6,"y":536.5},{"x":776.9,"y":533.8},{"x":776.3,"y":532.2},{"x":773.8,"y":529.8},{"x":772.2,"y":528.7},{"x":771.5,"y":530},{"x":770.6,"y":527.3},{"x":769.8,"y":526.2},{"x":771.3,"y":526.7},{"x":771.5,"y":524.1},{"x":771.2,"y":522.7},{"x":770.8,"y":521.3},{"x":769.2,"y":522.3},{"x":770,"y":524.5},{"x":768.4,"y":525.3},{"x":767.6,"y":524.2},{"x":766.3,"y":522.9},{"x":764.4,"y":520.3},{"x":763.7,"y":518.9},{"x":762.2,"y":516.9},{"x":760.3,"y":514.7},{"x":759,"y":513.1},{"x":760.3,"y":511.1},{"x":761.4,"y":508.9},{"x":762.7,"y":507.4},{"x":763.2,"y":506},{"x":761.4,"y":504.7},{"x":761.9,"y":506.4},{"x":760.6,"y":506.1},{"x":760.6,"y":504.5},{"x":757.9,"y":503.2},{"x":757.5,"y":504.7},{"x":759.2,"y":505.2},{"x":760.1,"y":506.8},{"x":759.7,"y":508.5},{"x":758.3,"y":509.3},{"x":758.2,"y":510.9},{"x":757.9,"y":508.9},{"x":756.8,"y":507.7},{"x":755.7,"y":506.5},{"x":755.6,"y":503.6},{"x":754.6,"y":500.1},{"x":755.3,"y":501.5},{"x":755.7,"y":502.8},{"x":755.7,"y":500.5},{"x":756.1,"y":499.2},{"x":756.4,"y":497.8},{"x":756.6,"y":496.4},{"x":756.9,"y":494.1},{"x":757,"y":492.7},{"x":756.5,"y":490.9},{"x":755.1,"y":488.2},{"x":754.1,"y":485.5},{"x":753.7,"y":484.2},{"x":753.1,"y":482.9},{"x":749.9,"y":482.7},{"x":748.4,"y":482.2},{"x":747.6,"y":481.1},{"x":746.6,"y":480.1},{"x":745.4,"y":478.6},{"x":744.1,"y":477.9},{"x":742.6,"y":477.4},{"x":742.4,"y":475.6},{"x":741.3,"y":474.6},{"x":739.9,"y":473.9},{"x":738.9,"y":472.3},{"x":738,"y":471.1},{"x":735.3,"y":469.7},{"x":732.9,"y":468.9},{"x":731.3,"y":467.9},{"x":729.2,"y":468.7},{"x":727.4,"y":468.5},{"x":726,"y":470.3},{"x":726.8,"y":471.8},{"x":725.2,"y":472.3},{"x":723.5,"y":472.5},{"x":721.9,"y":473.8},{"x":718.4,"y":476.4},{"x":716.7,"y":476.9},{"x":714.6,"y":477.1},{"x":715.6,"y":478.4},{"x":718.2,"y":477.6},{"x":719.8,"y":476.8},{"x":721.2,"y":475.3},{"x":720.2,"y":476.9},{"x":718.6,"y":477.8},{"x":716.7,"y":479.1},{"x":715.4,"y":478.9},{"x":713.1,"y":478},{"x":711,"y":478.6},{"x":710.1,"y":477.2},{"x":709.6,"y":475.3},{"x":710.7,"y":477.7},{"x":711.5,"y":475.8},{"x":710.3,"y":474.2},{"x":709.2,"y":473.4},{"x":707.3,"y":472.7},{"x":706.2,"y":471.7},{"x":704.6,"y":471.1},{"x":703.2,"y":470.2},{"x":700.7,"y":468.9},{"x":697.9,"y":468},{"x":694.5,"y":467.2},{"x":692.7,"y":467.1},{"x":689.1,"y":467.1},{"x":687.2,"y":467.4},{"x":684.6,"y":468.1},{"x":680.9,"y":469.2},{"x":679.1,"y":469.6},{"x":675.2,"y":470.6},{"x":676.1,"y":469.5},{"x":676.4,"y":468.1},{"x":676.2,"y":466.8},{"x":676.6,"y":464.2},{"x":674.2,"y":462.1},{"x":672.5,"y":460.3},{"x":673,"y":458},{"x":682.2,"y":456.5},{"x":689.8,"y":455.9},{"x":699.7,"y":454.9},{"x":705.9,"y":454.1},{"x":709.9,"y":453.6}]],"x":672.5,"y":450,"w":133.9,"h":114.1,"cx":760.2,"cy":491.9},"GA":{"shapes":[[{"x":696.1,"y":380.2},{"x":698.2,"y":380},{"x":705.5,"y":379.1},{"x":715.3,"y":377.9},{"x":725.9,"y":376.6},{"x":733.5,"y":375.3},{"x":731.9,"y":377.8},{"x":730.8,"y":379.7},{"x":730.8,"y":381.7},{"x":732.6,"y":382.8},{"x":735,"y":384.3},{"x":736.4,"y":384.9},{"x":737.8,"y":384.4},{"x":738.9,"y":385.5},{"x":739.9,"y":386.9},{"x":740.9,"y":388.4},{"x":741.5,"y":390.3},{"x":742.8,"y":391.6},{"x":744.5,"y":393.8},{"x":746.2,"y":394.7},{"x":747.9,"y":395.3},{"x":749.7,"y":396.6},{"x":750.6,"y":398.2},{"x":751.6,"y":399.3},{"x":753.3,"y":399.7},{"x":754.5,"y":401},{"x":755.6,"y":401.6},{"x":755.6,"y":403},{"x":757.2,"y":404.6},{"x":758.5,"y":405.5},{"x":759,"y":406.8},{"x":760.6,"y":407.4},{"x":762.1,"y":408.1},{"x":763.2,"y":409.8},{"x":764.2,"y":411.4},{"x":765,"y":413},{"x":765.5,"y":414.3},{"x":765.6,"y":415.7},{"x":767.8,"y":416.5},{"x":769.4,"y":418},{"x":770.3,"y":420.1},{"x":770.6,"y":421.9},{"x":771.2,"y":423.3},{"x":772.9,"y":424.6},{"x":774.9,"y":425.2},{"x":776,"y":426.3},{"x":774.7,"y":426.8},{"x":774.3,"y":428.7},{"x":773.1,"y":429.4},{"x":772.5,"y":431.5},{"x":772.8,"y":433.4},{"x":771,"y":435.1},{"x":772.4,"y":435.4},{"x":771.4,"y":437.7},{"x":771.3,"y":439.2},{"x":771.5,"y":441.4},{"x":770.5,"y":442.9},{"x":770,"y":445.3},{"x":770.6,"y":447.2},{"x":770.1,"y":449.9},{"x":769,"y":451.1},{"x":766.1,"y":451},{"x":764.6,"y":450.3},{"x":763.1,"y":450},{"x":761.9,"y":451},{"x":761.2,"y":452.4},{"x":762,"y":454.7},{"x":762.1,"y":456.6},{"x":762.1,"y":458.6},{"x":760,"y":459.1},{"x":759.2,"y":458},{"x":758.8,"y":456.5},{"x":751,"y":455.9},{"x":739.3,"y":456.7},{"x":724.3,"y":457.7},{"x":716.6,"y":458.3},{"x":715.2,"y":456.4},{"x":714.9,"y":455.1},{"x":713.7,"y":453.2},{"x":713,"y":451.2},{"x":711.7,"y":449.9},{"x":711.4,"y":448.3},{"x":711.5,"y":446.6},{"x":711.8,"y":445.3},{"x":711.9,"y":443.7},{"x":711.5,"y":441.8},{"x":710.3,"y":440.5},{"x":709.8,"y":437.9},{"x":710.5,"y":435.9},{"x":710.8,"y":434.5},{"x":710.7,"y":433.1},{"x":711.1,"y":431.3},{"x":712.3,"y":430.5},{"x":712,"y":429},{"x":711.3,"y":426.7},{"x":710.4,"y":424.9},{"x":709.3,"y":424},{"x":708.1,"y":420.5},{"x":707.4,"y":419.3},{"x":703.8,"y":407.7},{"x":702.4,"y":402.8},{"x":701.1,"y":398.2},{"x":699.5,"y":392.2},{"x":697.5,"y":385.3}]],"x":696.1,"y":375.3,"w":79.9,"h":83.8,"cx":734.4,"cy":419.8},"IN":{"shapes":[[{"x":656.1,"y":257.5},{"x":657.4,"y":257.8},{"x":658.9,"y":258.9},{"x":660.4,"y":258.7},{"x":661.7,"y":258.2},{"x":664.1,"y":256.8},{"x":665.6,"y":255.7},{"x":670,"y":255.3},{"x":679.7,"y":254.3},{"x":688.9,"y":253.2},{"x":693.2,"y":252.7},{"x":693.8,"y":257.8},{"x":696.4,"y":279.8},{"x":697.1,"y":286.8},{"x":697.9,"y":293.9},{"x":698.3,"y":298.3},{"x":698.8,"y":302.1},{"x":697.9,"y":303.3},{"x":698.8,"y":304.3},{"x":698.7,"y":306.1},{"x":699.3,"y":307.3},{"x":697.7,"y":308.5},{"x":695.6,"y":309.7},{"x":694,"y":310.3},{"x":692,"y":310},{"x":690.7,"y":310.6},{"x":691.1,"y":312.5},{"x":690.8,"y":314.4},{"x":689,"y":315.8},{"x":688.3,"y":318.5},{"x":686.6,"y":318.9},{"x":685.9,"y":320.2},{"x":685.2,"y":321.5},{"x":685.4,"y":322.9},{"x":684.9,"y":324.5},{"x":683.6,"y":325.5},{"x":681.7,"y":324.7},{"x":680.3,"y":324},{"x":680.1,"y":322.5},{"x":678.9,"y":321.5},{"x":678.2,"y":323.3},{"x":676.7,"y":324.6},{"x":676.7,"y":326.1},{"x":675.9,"y":328},{"x":674.6,"y":327.2},{"x":672.8,"y":326},{"x":671.3,"y":327},{"x":669.8,"y":327.6},{"x":669.2,"y":329.7},{"x":667.8,"y":329.3},{"x":665.7,"y":328.4},{"x":664.4,"y":327.8},{"x":662.7,"y":328.4},{"x":661.6,"y":327.4},{"x":661.6,"y":329.5},{"x":660.4,"y":330.2},{"x":660.1,"y":328.8},{"x":658,"y":329.5},{"x":656.9,"y":328.7},{"x":657.1,"y":330.8},{"x":655.3,"y":331.2},{"x":654.1,"y":329.3},{"x":655.3,"y":327.8},{"x":654.8,"y":326.5},{"x":655.8,"y":325.5},{"x":655.4,"y":323.6},{"x":656,"y":321.7},{"x":657.6,"y":320.4},{"x":658.5,"y":318.8},{"x":659.6,"y":317.4},{"x":659.8,"y":314.9},{"x":661.4,"y":312.9},{"x":660.4,"y":310.8},{"x":660.8,"y":308.9},{"x":659.8,"y":307.1},{"x":658.6,"y":305.1},{"x":659.5,"y":304.1},{"x":659,"y":302.3},{"x":659.4,"y":296},{"x":658.8,"y":289.7},{"x":658.4,"y":284.8},{"x":658.1,"y":280.8},{"x":656.4,"y":261.6}]],"x":654.1,"y":252.7,"w":45.2,"h":78.5,"cx":676.6,"cy":289.7},"KS":{"shapes":[[{"x":454.3,"y":292},{"x":467.2,"y":292.8},{"x":472.5,"y":293},{"x":485.8,"y":293.6},{"x":499.6,"y":294.1},{"x":507.9,"y":294.3},{"x":522,"y":294.6},{"x":535.3,"y":294.7},{"x":542.6,"y":294.7},{"x":549.3,"y":294.7},{"x":550.8,"y":295.8},{"x":551.8,"y":297},{"x":553.1,"y":297.2},{"x":554.7,"y":296.7},{"x":555.4,"y":297.9},{"x":554.9,"y":299.2},{"x":554.1,"y":300.6},{"x":553,"y":301.6},{"x":552.3,"y":303.4},{"x":553.1,"y":304.6},{"x":554.5,"y":306},{"x":555.4,"y":308},{"x":556.2,"y":309.3},{"x":557.9,"y":310.2},{"x":559.7,"y":310.4},{"x":559.5,"y":318.3},{"x":559.5,"y":320.2},{"x":559.7,"y":331.4},{"x":559.8,"y":344.8},{"x":559.8,"y":346.4},{"x":559.8,"y":350.9},{"x":546.7,"y":351},{"x":536.4,"y":351},{"x":527.5,"y":351},{"x":516,"y":350.8},{"x":505,"y":350.6},{"x":491.4,"y":350.2},{"x":486,"y":350},{"x":477.9,"y":349.6},{"x":470,"y":349.3},{"x":459,"y":348.8},{"x":450.8,"y":348.3},{"x":451.9,"y":330.8},{"x":452,"y":328.6},{"x":453.3,"y":308.2},{"x":453.5,"y":305.1},{"x":453.9,"y":298.1}]],"x":450.8,"y":292,"w":109,"h":59,"cx":505.3,"cy":322.6},"ME":{"shapes":[[{"x":877,"y":192.3},{"x":875,"y":191.5},{"x":874.8,"y":189.7},{"x":872.4,"y":188.2},{"x":871.7,"y":185.9},{"x":871.4,"y":184.3},{"x":869.5,"y":179.3},{"x":869.1,"y":177.9},{"x":865,"y":164.7},{"x":861.2,"y":153.2},{"x":863.2,"y":152.5},{"x":863.9,"y":153.7},{"x":864.6,"y":152.3},{"x":864.4,"y":151},{"x":866.5,"y":150.3},{"x":864.9,"y":148.7},{"x":865.3,"y":146.3},{"x":866.1,"y":144.9},{"x":867.9,"y":143.1},{"x":867.8,"y":140.9},{"x":868.7,"y":139},{"x":867.3,"y":137.8},{"x":867.7,"y":136},{"x":866.8,"y":134.7},{"x":867,"y":132.8},{"x":867.7,"y":131.2},{"x":868.6,"y":129.8},{"x":867.9,"y":124.6},{"x":873.5,"y":108.4},{"x":875.4,"y":108.5},{"x":876.7,"y":111.3},{"x":878.9,"y":112.2},{"x":879.8,"y":111.2},{"x":882,"y":110},{"x":883.5,"y":108.6},{"x":884.3,"y":107.5},{"x":886.1,"y":106.7},{"x":887.5,"y":107.4},{"x":889.3,"y":108},{"x":891.5,"y":109.5},{"x":893,"y":110.1},{"x":895.5,"y":118.4},{"x":898.9,"y":128.9},{"x":899.7,"y":130.3},{"x":900.2,"y":132},{"x":900.3,"y":134.8},{"x":902.2,"y":135.1},{"x":904.6,"y":135.2},{"x":906.1,"y":136.4},{"x":905.8,"y":137.9},{"x":906.7,"y":139.9},{"x":908,"y":142.1},{"x":909.1,"y":142.8},{"x":909.4,"y":141.5},{"x":911.2,"y":141.5},{"x":912.6,"y":142.8},{"x":913.9,"y":144.8},{"x":915.4,"y":147},{"x":914.6,"y":148.6},{"x":913.7,"y":150.8},{"x":912.4,"y":152.1},{"x":911.9,"y":150.1},{"x":910.8,"y":151},{"x":911.3,"y":152.5},{"x":910.4,"y":153.5},{"x":909.8,"y":155.8},{"x":908.4,"y":154.5},{"x":907.5,"y":155.5},{"x":906.6,"y":157.4},{"x":905,"y":158.5},{"x":904.6,"y":159.7},{"x":903.5,"y":158.8},{"x":903,"y":160.2},{"x":902.6,"y":161.5},{"x":901.7,"y":162.6},{"x":899.3,"y":161},{"x":900.3,"y":159.8},{"x":898.7,"y":159.4},{"x":897.7,"y":160.7},{"x":899,"y":162.7},{"x":898.4,"y":165},{"x":899.2,"y":166.4},{"x":898.6,"y":167.9},{"x":898,"y":166.6},{"x":896.9,"y":165.2},{"x":896.9,"y":163.3},{"x":895.5,"y":162.4},{"x":894.3,"y":161.2},{"x":894.4,"y":159.6},{"x":893.5,"y":161.1},{"x":892,"y":161.6},{"x":893,"y":162.7},{"x":892.6,"y":163.9},{"x":892.6,"y":166.3},{"x":892.4,"y":167.7},{"x":893.6,"y":169.3},{"x":892.1,"y":170.3},{"x":891.8,"y":171.6},{"x":890.8,"y":173},{"x":890.8,"y":171.5},{"x":888.9,"y":171.6},{"x":888.6,"y":173.1},{"x":887.4,"y":174.8},{"x":886.1,"y":175},{"x":885.9,"y":176.6},{"x":884.8,"y":177.6},{"x":884.2,"y":176.4},{"x":882.9,"y":177.4},{"x":881.9,"y":178.3},{"x":880.9,"y":179.3},{"x":880.7,"y":181},{"x":879.2,"y":182.5},{"x":879.5,"y":184.3},{"x":879.2,"y":185.9},{"x":878,"y":186.5},{"x":877.6,"y":188.7},{"x":877.6,"y":190.3}]],"x":861.2,"y":106.7,"w":54.2,"h":85.6,"cx":884.3,"cy":146},"MA":{"shapes":[[{"x":844.9,"y":206.6},{"x":855.6,"y":204.3},{"x":865.1,"y":202.3},{"x":871.1,"y":200.9},{"x":872.3,"y":199.8},{"x":872.6,"y":198.1},{"x":873.7,"y":197.1},{"x":875.3,"y":196.1},{"x":876.8,"y":197.2},{"x":877.8,"y":199.2},{"x":879.2,"y":199.6},{"x":880,"y":200.7},{"x":877.3,"y":202.2},{"x":877.4,"y":203.8},{"x":876.4,"y":205.1},{"x":877.3,"y":206.1},{"x":876.8,"y":207.4},{"x":878.3,"y":206.5},{"x":880.2,"y":207.2},{"x":881.2,"y":208.4},{"x":882.6,"y":209.6},{"x":882.6,"y":211.1},{"x":883.5,"y":212.1},{"x":885.3,"y":213.3},{"x":886.1,"y":214.7},{"x":889,"y":214.7},{"x":890.2,"y":214},{"x":892.2,"y":212.8},{"x":892,"y":211.1},{"x":890.6,"y":209.4},{"x":889.2,"y":208.3},{"x":891,"y":208.6},{"x":892.4,"y":210.3},{"x":893.3,"y":212},{"x":894,"y":214.1},{"x":893.9,"y":216.3},{"x":893.2,"y":214.8},{"x":890.1,"y":216.4},{"x":888.7,"y":216.7},{"x":887.7,"y":217.6},{"x":885.7,"y":219.3},{"x":884.4,"y":220.8},{"x":882.9,"y":222.4},{"x":884.1,"y":220.6},{"x":885.1,"y":219.5},{"x":884.6,"y":217},{"x":883.3,"y":216.2},{"x":883.2,"y":217.9},{"x":881.3,"y":219},{"x":881.5,"y":220.5},{"x":880.2,"y":221.7},{"x":878.2,"y":219.1},{"x":876.7,"y":218.5},{"x":875,"y":217.6},{"x":874.3,"y":215.5},{"x":873.1,"y":213.5},{"x":867.7,"y":215.1},{"x":857.9,"y":217.1},{"x":854.8,"y":217.9},{"x":851.5,"y":218.6},{"x":845.8,"y":219.8},{"x":844.7,"y":212.8}]],"x":844.7,"y":196.1,"w":49.3,"h":26.3,"cx":866.6,"cy":210.7},"MN":{"shapes":[[{"x":524.4,"y":127.3},{"x":528.1,"y":127.3},{"x":539.8,"y":127.4},{"x":550,"y":127.3},{"x":549.9,"y":120.3},{"x":551.1,"y":120.8},{"x":553.6,"y":121.3},{"x":554.7,"y":125},{"x":555.8,"y":129.4},{"x":555.8,"y":131.3},{"x":557.7,"y":132.7},{"x":559.1,"y":132.5},{"x":561.1,"y":132.7},{"x":564.3,"y":133.7},{"x":566.4,"y":133.9},{"x":566.7,"y":135.7},{"x":568.9,"y":135.9},{"x":571.1,"y":135.3},{"x":572.5,"y":133.8},{"x":574.2,"y":133.4},{"x":577,"y":133.7},{"x":580.2,"y":135.1},{"x":581.4,"y":135.8},{"x":583,"y":136.7},{"x":583.4,"y":138.1},{"x":584.9,"y":140.8},{"x":585.6,"y":139},{"x":586.8,"y":138.4},{"x":588.7,"y":138.1},{"x":589.4,"y":139.8},{"x":590.8,"y":140.3},{"x":593.1,"y":140.9},{"x":593.2,"y":142.4},{"x":595.1,"y":142.5},{"x":596.6,"y":143.5},{"x":599,"y":142.7},{"x":601,"y":140.8},{"x":602.3,"y":140},{"x":604,"y":139.7},{"x":604.8,"y":141},{"x":605.8,"y":142.1},{"x":607.3,"y":141.6},{"x":608.7,"y":141.7},{"x":610.8,"y":141.7},{"x":612.9,"y":141.4},{"x":614.2,"y":141.8},{"x":616.3,"y":143.5},{"x":617.8,"y":142.7},{"x":619.4,"y":142.9},{"x":621.1,"y":142.7},{"x":619.9,"y":143.7},{"x":618.5,"y":144.2},{"x":617.4,"y":145.2},{"x":615.8,"y":145.8},{"x":612.9,"y":147.3},{"x":610.8,"y":148.3},{"x":608.3,"y":149.3},{"x":605.9,"y":150.8},{"x":604.3,"y":152.2},{"x":601.2,"y":155.2},{"x":600.5,"y":156.4},{"x":598.1,"y":159.3},{"x":597,"y":160.5},{"x":595.8,"y":161.2},{"x":594.7,"y":162.7},{"x":593,"y":164.2},{"x":589.8,"y":166.7},{"x":590.5,"y":168.6},{"x":588.9,"y":168},{"x":588,"y":169.7},{"x":587.4,"y":180.4},{"x":586.7,"y":181.5},{"x":585.1,"y":182.4},{"x":583,"y":183.2},{"x":581.2,"y":186.4},{"x":580,"y":189},{"x":581,"y":190.2},{"x":582.1,"y":191},{"x":583.3,"y":192.3},{"x":582.6,"y":193.9},{"x":581.9,"y":195.2},{"x":582,"y":196.6},{"x":582.2,"y":198.6},{"x":582,"y":200.1},{"x":582.2,"y":201.7},{"x":582.1,"y":203.6},{"x":581.6,"y":204.9},{"x":582.6,"y":205.9},{"x":584.1,"y":207.2},{"x":585.2,"y":208.5},{"x":587.6,"y":208.6},{"x":588.7,"y":210.1},{"x":591.8,"y":211.4},{"x":593.5,"y":212.6},{"x":594.3,"y":215},{"x":596.4,"y":216.2},{"x":598.4,"y":218.1},{"x":600.2,"y":218.4},{"x":602.5,"y":221.4},{"x":602.7,"y":224.4},{"x":603.4,"y":226.1},{"x":603.7,"y":227.6},{"x":593.9,"y":228.1},{"x":583.1,"y":228.5},{"x":577.5,"y":228.7},{"x":566.8,"y":229},{"x":558.1,"y":229.1},{"x":543,"y":229.2},{"x":533.5,"y":229.2},{"x":533.6,"y":209.8},{"x":533.6,"y":208.2},{"x":533.6,"y":203.3},{"x":533.6,"y":195.7},{"x":531.5,"y":193.7},{"x":530,"y":192.7},{"x":528.4,"y":190},{"x":529.8,"y":188.3},{"x":531.4,"y":186.7},{"x":532.2,"y":183.9},{"x":532.1,"y":182.2},{"x":531.9,"y":178.6},{"x":531.8,"y":176.6},{"x":530.3,"y":174.6},{"x":529.9,"y":171.9},{"x":529.3,"y":170.4},{"x":529.3,"y":167.5},{"x":529.8,"y":165.4},{"x":529.1,"y":162},{"x":528.9,"y":160.6},{"x":528.8,"y":158.7},{"x":528.7,"y":156.3},{"x":528.8,"y":152.9},{"x":528.2,"y":151.4},{"x":527.8,"y":149.9},{"x":526.9,"y":148.1},{"x":526.3,"y":146.6},{"x":526.1,"y":144.7},{"x":525.4,"y":143.1},{"x":525.3,"y":141.3},{"x":525.3,"y":139},{"x":525.4,"y":136.5},{"x":525.4,"y":134.4},{"x":526,"y":133},{"x":525.3,"y":131.8},{"x":525,"y":129.8}]],"x":524.4,"y":120.3,"w":96.7,"h":108.9,"cx":561.4,"cy":177.4},"NJ":{"shapes":[[{"x":827,"y":270.6},{"x":827.8,"y":268.9},{"x":828.3,"y":267.1},{"x":830.8,"y":265.4},{"x":831.9,"y":264.4},{"x":832.4,"y":262.7},{"x":834,"y":260.6},{"x":835.3,"y":259.3},{"x":836.5,"y":258.5},{"x":835.5,"y":257.5},{"x":833.9,"y":256.4},{"x":832.7,"y":255.7},{"x":830.8,"y":254.7},{"x":830.2,"y":252.5},{"x":828.7,"y":252.3},{"x":827.9,"y":250.9},{"x":827.7,"y":248.5},{"x":829,"y":246.4},{"x":827.4,"y":244.8},{"x":828.7,"y":243.2},{"x":829,"y":241.8},{"x":830,"y":240.2},{"x":830.3,"y":238.1},{"x":831.1,"y":236.8},{"x":836.7,"y":238.1},{"x":844,"y":240.5},{"x":843.9,"y":243.9},{"x":843.6,"y":246.1},{"x":841.5,"y":248.1},{"x":841.6,"y":249.5},{"x":841.5,"y":251.3},{"x":843.2,"y":251.1},{"x":844.5,"y":251.5},{"x":845.8,"y":252.1},{"x":846.1,"y":253.8},{"x":846.1,"y":256.9},{"x":846.3,"y":260.9},{"x":846.7,"y":263.6},{"x":845.6,"y":267.9},{"x":844.8,"y":269},{"x":844.8,"y":270.5},{"x":844,"y":271.7},{"x":842.7,"y":273.2},{"x":841.5,"y":275.3},{"x":840.9,"y":277.4},{"x":840.3,"y":280},{"x":839.5,"y":281.1},{"x":838,"y":281.5},{"x":838,"y":280},{"x":838.4,"y":278.3},{"x":837.1,"y":276.9},{"x":835.8,"y":276.7},{"x":834.7,"y":277.6},{"x":832.9,"y":276.2},{"x":831.2,"y":275.1},{"x":829.8,"y":274.6},{"x":828.1,"y":273.7}]],"x":827,"y":236.8,"w":19.7,"h":44.7,"cx":837.2,"cy":257.9},"NC":{"shapes":[[{"x":750.4,"y":342.8},{"x":754.8,"y":342.4},{"x":757.7,"y":342},{"x":762.7,"y":341.4},{"x":764.6,"y":341.1},{"x":770.7,"y":340.4},{"x":773.2,"y":340},{"x":782.1,"y":338.5},{"x":796.7,"y":335.9},{"x":800.5,"y":335.1},{"x":814.3,"y":332.4},{"x":819.8,"y":331.3},{"x":821.4,"y":330.9},{"x":827.6,"y":329.6},{"x":835,"y":328},{"x":837,"y":332.6},{"x":838.3,"y":334.9},{"x":840.1,"y":337.1},{"x":842.8,"y":341},{"x":840.9,"y":338.8},{"x":839.9,"y":337.7},{"x":838.1,"y":335},{"x":836.7,"y":332.7},{"x":835.7,"y":330.5},{"x":834.7,"y":329.4},{"x":833.4,"y":329.5},{"x":834.1,"y":330.8},{"x":836.1,"y":333.5},{"x":836.8,"y":334.8},{"x":837.6,"y":335.8},{"x":835.6,"y":334.4},{"x":834.2,"y":335.2},{"x":832.1,"y":333.7},{"x":832.6,"y":335},{"x":833.7,"y":335.9},{"x":832.1,"y":336.8},{"x":830.8,"y":335.9},{"x":832,"y":337.2},{"x":829.9,"y":337.1},{"x":827.8,"y":336.6},{"x":829.2,"y":337.5},{"x":828.4,"y":339.5},{"x":826.8,"y":340.2},{"x":825.1,"y":339.8},{"x":824.1,"y":338},{"x":824.3,"y":335.7},{"x":823.5,"y":336.9},{"x":824.4,"y":339.5},{"x":825.2,"y":340.6},{"x":827.7,"y":341.2},{"x":829.5,"y":340.1},{"x":830.7,"y":340.5},{"x":832.6,"y":339.2},{"x":834.3,"y":338.9},{"x":835.3,"y":340},{"x":834.8,"y":341.4},{"x":835.8,"y":344.8},{"x":836.3,"y":342.7},{"x":835.9,"y":340.4},{"x":836.7,"y":338.6},{"x":838.1,"y":338.7},{"x":839.3,"y":340},{"x":839.8,"y":341.8},{"x":840.5,"y":343.3},{"x":840.1,"y":345.5},{"x":838.4,"y":346},{"x":837.7,"y":347.7},{"x":837.2,"y":349.2},{"x":836.6,"y":350.3},{"x":835.7,"y":351.3},{"x":834.3,"y":351.2},{"x":832.7,"y":351.6},{"x":831.3,"y":351.6},{"x":829.5,"y":351},{"x":828.5,"y":349.4},{"x":830.1,"y":349},{"x":828.2,"y":348.9},{"x":828.5,"y":350.3},{"x":829.1,"y":351.6},{"x":827,"y":351.2},{"x":825.1,"y":351.2},{"x":823.4,"y":351.1},{"x":822,"y":350.6},{"x":823.2,"y":351.8},{"x":827.9,"y":352.6},{"x":830.5,"y":352.5},{"x":831,"y":354.5},{"x":830.6,"y":355.9},{"x":829.7,"y":357.7},{"x":827.4,"y":360},{"x":824.4,"y":358.8},{"x":826.1,"y":360.4},{"x":828.1,"y":360.7},{"x":829.8,"y":359},{"x":831.8,"y":358.1},{"x":833.3,"y":358.6},{"x":834.7,"y":357.6},{"x":835.1,"y":358.9},{"x":834.5,"y":360.3},{"x":833.1,"y":361.7},{"x":832.7,"y":363.1},{"x":831.6,"y":364.2},{"x":830.8,"y":362.8},{"x":831.1,"y":364},{"x":832.7,"y":364.9},{"x":833.5,"y":362.7},{"x":834.9,"y":360.4},{"x":835.9,"y":359},{"x":837.8,"y":355.7},{"x":837.1,"y":357.5},{"x":836,"y":359.3},{"x":835.1,"y":360.6},{"x":834.2,"y":362},{"x":833.5,"y":363.5},{"x":832.8,"y":365.6},{"x":830.3,"y":364.6},{"x":828.2,"y":365},{"x":825.1,"y":366.3},{"x":823.7,"y":367.1},{"x":821.2,"y":369.4},{"x":819.4,"y":371},{"x":818.2,"y":372.3},{"x":816.6,"y":374.5},{"x":815,"y":377.8},{"x":814.6,"y":379.7},{"x":814.4,"y":381.5},{"x":814.1,"y":383.8},{"x":811.9,"y":383.3},{"x":809.2,"y":383.7},{"x":807.6,"y":384.2},{"x":805.8,"y":385.2},{"x":799.5,"y":381.2},{"x":792.8,"y":376.5},{"x":790.8,"y":375},{"x":785.3,"y":371},{"x":782,"y":371.5},{"x":778,"y":372.1},{"x":768.5,"y":373.5},{"x":768.4,"y":371.3},{"x":765.6,"y":368.5},{"x":764.2,"y":370},{"x":763.9,"y":368},{"x":760.9,"y":368.3},{"x":755.3,"y":368.9},{"x":745.1,"y":369.9},{"x":743.6,"y":369.8},{"x":741.7,"y":371.2},{"x":739.9,"y":372.2},{"x":738.5,"y":373.4},{"x":733.5,"y":375.3},{"x":725.8,"y":376.5},{"x":715.3,"y":377.9},{"x":715.3,"y":373.5},{"x":716.4,"y":372.5},{"x":718.1,"y":372.7},{"x":719.1,"y":371.5},{"x":719.2,"y":370.2},{"x":719.6,"y":368.4},{"x":720.6,"y":367.3},{"x":722.2,"y":366.2},{"x":726.4,"y":365.5},{"x":728,"y":364},{"x":729.5,"y":362.7},{"x":730.8,"y":361.2},{"x":733.2,"y":360.7},{"x":734.3,"y":358.7},{"x":734.5,"y":357.2},{"x":736.2,"y":355.9},{"x":737.8,"y":354.6},{"x":738.3,"y":356.3},{"x":740.5,"y":355.3},{"x":741.1,"y":353.7},{"x":742.6,"y":352.6},{"x":744.7,"y":352},{"x":746.5,"y":352.1},{"x":747.8,"y":348.6},{"x":748.7,"y":347.6},{"x":750.7,"y":347.5},{"x":750,"y":346.4},{"x":750.5,"y":345.1}]],"x":715.3,"y":328,"w":127.5,"h":57.2,"cx":787.6,"cy":356.4},"ND":{"shapes":[[{"x":440.4,"y":123.2},{"x":448.6,"y":123.9},{"x":462.9,"y":124.9},{"x":472.2,"y":125.4},{"x":476.3,"y":125.7},{"x":484.9,"y":126.1},{"x":491.9,"y":126.4},{"x":497.9,"y":126.6},{"x":504.2,"y":126.8},{"x":515.5,"y":127.1},{"x":524.4,"y":127.3},{"x":524.7,"y":129.4},{"x":525.3,"y":131.8},{"x":526,"y":133},{"x":525.4,"y":134.4},{"x":525.4,"y":136.5},{"x":525.4,"y":138.2},{"x":525.6,"y":140.5},{"x":525.4,"y":143.1},{"x":526.1,"y":144.7},{"x":526.3,"y":146.6},{"x":526.9,"y":148.1},{"x":527.4,"y":149.7},{"x":528.2,"y":151.4},{"x":528.5,"y":152.8},{"x":528.7,"y":156.3},{"x":529,"y":158},{"x":528.9,"y":160.6},{"x":529.1,"y":162},{"x":529.1,"y":164.7},{"x":529.6,"y":167.2},{"x":529.6,"y":169.3},{"x":529.4,"y":171},{"x":530.1,"y":173.8},{"x":531.2,"y":176.1},{"x":531.9,"y":178.6},{"x":532.4,"y":181.6},{"x":532.2,"y":183.9},{"x":522.5,"y":183.8},{"x":513.9,"y":183.7},{"x":508.3,"y":183.5},{"x":496.6,"y":183.1},{"x":487.7,"y":182.7},{"x":479.4,"y":182.3},{"x":467.7,"y":181.7},{"x":462,"y":181.3},{"x":448.5,"y":180.4},{"x":440.5,"y":179.7},{"x":435.6,"y":179.3},{"x":439.4,"y":134.6}]],"x":435.6,"y":123.2,"w":96.8,"h":60.7,"cx":483.1,"cy":154.6},"OK":{"shapes":[[{"x":436.8,"y":347.2},{"x":440,"y":347.5},{"x":450.8,"y":348.3},{"x":459,"y":348.8},{"x":470,"y":349.3},{"x":477.9,"y":349.6},{"x":486,"y":350},{"x":491.4,"y":350.2},{"x":505,"y":350.6},{"x":516,"y":350.8},{"x":527.5,"y":351},{"x":536.4,"y":351},{"x":546.7,"y":351},{"x":559.8,"y":350.9},{"x":560,"y":360.2},{"x":560.3,"y":362.3},{"x":560.7,"y":365.6},{"x":561.1,"y":367.7},{"x":561.9,"y":373.4},{"x":562.2,"y":374.7},{"x":563.1,"y":380.9},{"x":563.1,"y":386.1},{"x":563,"y":390.3},{"x":563,"y":394},{"x":562.9,"y":396.8},{"x":562.9,"y":403.5},{"x":562.8,"y":413.8},{"x":561.2,"y":413.1},{"x":559.4,"y":413},{"x":558.4,"y":411.7},{"x":556.9,"y":411.9},{"x":555.7,"y":410.6},{"x":554.1,"y":409.7},{"x":552.8,"y":408.3},{"x":551.3,"y":407.9},{"x":550.4,"y":409.5},{"x":547.8,"y":409.6},{"x":546.2,"y":408.5},{"x":544.4,"y":409.3},{"x":542.6,"y":409.8},{"x":540.5,"y":409.3},{"x":538.8,"y":410.3},{"x":537.3,"y":410.3},{"x":536.8,"y":411.7},{"x":535,"y":411.6},{"x":534.6,"y":412.9},{"x":533,"y":411.4},{"x":531.4,"y":410.5},{"x":529.9,"y":410.1},{"x":529.2,"y":408.9},{"x":528.8,"y":410.3},{"x":527.6,"y":409.7},{"x":526,"y":409.6},{"x":525.7,"y":408.1},{"x":524.3,"y":408.1},{"x":523.6,"y":410.2},{"x":522.9,"y":411.9},{"x":521.1,"y":410.7},{"x":521.5,"y":409.1},{"x":519.6,"y":409.3},{"x":518.5,"y":410.5},{"x":517.2,"y":409.9},{"x":516.6,"y":408.5},{"x":515.1,"y":408.6},{"x":514.2,"y":407.2},{"x":513.1,"y":408.2},{"x":511.4,"y":409.6},{"x":509.9,"y":409.2},{"x":509.8,"y":407.1},{"x":507.7,"y":406.8},{"x":507.1,"y":405.3},{"x":507.4,"y":404},{"x":505.4,"y":404.3},{"x":503.5,"y":403.8},{"x":502.7,"y":405.2},{"x":500.3,"y":404},{"x":498.5,"y":404.2},{"x":496.7,"y":403.6},{"x":495,"y":403.1},{"x":493.1,"y":402.8},{"x":491.9,"y":402.3},{"x":490.7,"y":400.1},{"x":489.8,"y":399.2},{"x":488.2,"y":397.8},{"x":487.9,"y":399.2},{"x":486.1,"y":398.5},{"x":484.8,"y":399.2},{"x":483.2,"y":398.9},{"x":481.9,"y":397.6},{"x":480,"y":395.2},{"x":480.4,"y":359.1},{"x":473.9,"y":358.9},{"x":464.4,"y":358.4},{"x":456.4,"y":357.9},{"x":447.2,"y":357.3},{"x":436,"y":356.6},{"x":436.2,"y":354.7}]],"x":436,"y":347.2,"w":127.1,"h":66.6,"cx":517.2,"cy":377.3},"PA":{"shapes":[[{"x":750.9,"y":240.5},{"x":753,"y":239.1},{"x":755,"y":237.6},{"x":755.7,"y":236.1},{"x":758.1,"y":234.9},{"x":760.2,"y":233.3},{"x":761,"y":238.3},{"x":773,"y":236.2},{"x":776.8,"y":235.5},{"x":784.8,"y":234},{"x":796.6,"y":231.7},{"x":801.6,"y":230.6},{"x":807,"y":229.6},{"x":815.1,"y":227.8},{"x":820.3,"y":226.7},{"x":822.1,"y":228.8},{"x":824.2,"y":228.9},{"x":824.6,"y":230.1},{"x":826,"y":232.8},{"x":827.3,"y":234.5},{"x":828.8,"y":235.2},{"x":830.2,"y":235.5},{"x":831.8,"y":236.4},{"x":830.3,"y":238.1},{"x":830,"y":240.2},{"x":829,"y":241.8},{"x":828.7,"y":243.2},{"x":827.4,"y":244.8},{"x":829,"y":246.4},{"x":828.3,"y":248.4},{"x":827.6,"y":250.1},{"x":828.3,"y":252.2},{"x":829.6,"y":252.1},{"x":830.4,"y":254.1},{"x":832.1,"y":254.7},{"x":833.9,"y":256.4},{"x":835.5,"y":257.5},{"x":836.5,"y":258.5},{"x":835.3,"y":259.3},{"x":834,"y":260.6},{"x":832.6,"y":262.1},{"x":831.7,"y":263.3},{"x":830.8,"y":265.4},{"x":829,"y":266.2},{"x":827.1,"y":266.7},{"x":824.8,"y":267.4},{"x":823.5,"y":269.7},{"x":812.7,"y":271.9},{"x":806.8,"y":273.2},{"x":799.3,"y":274.7},{"x":787.5,"y":276.9},{"x":772.3,"y":279.7},{"x":763.9,"y":281.1},{"x":757.7,"y":282.2},{"x":754.9,"y":265.2}]],"x":750.9,"y":226.7,"w":85.6,"h":55.5,"cx":791.5,"cy":254.1},"SD":{"shapes":[[{"x":434,"y":196.9},{"x":435.4,"y":183},{"x":435.6,"y":179.3},{"x":440.5,"y":179.7},{"x":448.5,"y":180.4},{"x":462,"y":181.3},{"x":467.7,"y":181.7},{"x":479.4,"y":182.3},{"x":487.7,"y":182.7},{"x":496.6,"y":183.1},{"x":508.3,"y":183.5},{"x":513.9,"y":183.7},{"x":522.5,"y":183.8},{"x":532.2,"y":183.9},{"x":532,"y":185.9},{"x":530.8,"y":187.7},{"x":528.6,"y":189.3},{"x":529.6,"y":191.6},{"x":530.6,"y":193.6},{"x":533.2,"y":194.6},{"x":533.6,"y":203.3},{"x":533.6,"y":208.2},{"x":533.6,"y":209.8},{"x":533.5,"y":229.2},{"x":531.5,"y":229.2},{"x":532.5,"y":231.2},{"x":532.4,"y":233},{"x":532,"y":234.4},{"x":533.2,"y":235.8},{"x":533.3,"y":237.4},{"x":532.5,"y":239},{"x":532.2,"y":241.3},{"x":531,"y":242.8},{"x":531.7,"y":244.5},{"x":533,"y":246.9},{"x":532.6,"y":248.2},{"x":531.2,"y":247.8},{"x":529.9,"y":245.9},{"x":528.7,"y":244.7},{"x":527.3,"y":243.5},{"x":524.2,"y":242.8},{"x":523.1,"y":242},{"x":521.8,"y":240.9},{"x":520.4,"y":240.9},{"x":518.4,"y":241.3},{"x":516.7,"y":241.3},{"x":514.6,"y":240.8},{"x":513.7,"y":242.2},{"x":512.2,"y":242.7},{"x":510.7,"y":241.6},{"x":509,"y":240.6},{"x":506.2,"y":239.1},{"x":500.4,"y":238},{"x":491.3,"y":237.7},{"x":483.9,"y":237.4},{"x":473.6,"y":236.9},{"x":463.6,"y":236.4},{"x":460.6,"y":236.2},{"x":452,"y":235.6},{"x":445.1,"y":235.1},{"x":430.9,"y":234},{"x":431.4,"y":228.4},{"x":433.8,"y":199.1}]],"x":430.9,"y":179.3,"w":102.7,"h":68.9,"cx":483.6,"cy":210.5},"TX":{"shapes":[[{"x":436,"y":356.6},{"x":447.2,"y":357.3},{"x":456.4,"y":357.9},{"x":464.4,"y":358.4},{"x":473.9,"y":358.9},{"x":480.4,"y":359.1},{"x":478.9,"y":395.5},{"x":481.9,"y":397.6},{"x":483.2,"y":398.9},{"x":484.8,"y":399.2},{"x":486.1,"y":398.5},{"x":487.2,"y":399.3},{"x":488.2,"y":397.8},{"x":489.1,"y":398.7},{"x":490.7,"y":400.1},{"x":490.9,"y":402.4},{"x":492.7,"y":402.5},{"x":494,"y":402.4},{"x":496,"y":403.6},{"x":497.4,"y":404.1},{"x":499.2,"y":403.6},{"x":501.6,"y":405.6},{"x":502.9,"y":404.5},{"x":504.5,"y":404.3},{"x":506.4,"y":404.7},{"x":507.7,"y":406.8},{"x":509.4,"y":406.8},{"x":509.4,"y":409.1},{"x":510.8,"y":409.7},{"x":513.1,"y":408.2},{"x":514.2,"y":407.2},{"x":515.1,"y":408.6},{"x":516.6,"y":408.5},{"x":517.2,"y":409.9},{"x":518.5,"y":410.5},{"x":519.6,"y":409.3},{"x":521,"y":408.7},{"x":521.6,"y":410.2},{"x":521.7,"y":412.2},{"x":522.8,"y":410.9},{"x":524.5,"y":409.3},{"x":525.4,"y":407.9},{"x":526,"y":409.6},{"x":527.6,"y":409.7},{"x":528.8,"y":410.3},{"x":529.2,"y":408.9},{"x":530.6,"y":409.2},{"x":530.8,"y":410.6},{"x":531.8,"y":411.4},{"x":533.9,"y":412.6},{"x":535,"y":411.6},{"x":536.8,"y":411.7},{"x":537.3,"y":410.3},{"x":538.8,"y":410.3},{"x":540.5,"y":409.8},{"x":542.1,"y":410.3},{"x":543.3,"y":409.2},{"x":545.7,"y":408.4},{"x":546.6,"y":409.5},{"x":549.6,"y":409.6},{"x":551,"y":409},{"x":552.8,"y":408.3},{"x":554.1,"y":409.7},{"x":555.7,"y":410.6},{"x":556.9,"y":411.9},{"x":558.4,"y":411.7},{"x":559.4,"y":413},{"x":561.2,"y":413.1},{"x":562.3,"y":414.2},{"x":563.9,"y":414.9},{"x":565.5,"y":415.4},{"x":566.8,"y":415.3},{"x":568.1,"y":414.8},{"x":569.6,"y":415.3},{"x":569.9,"y":425.3},{"x":570.3,"y":444.4},{"x":571.4,"y":445.8},{"x":572.9,"y":447.6},{"x":573.7,"y":449},{"x":573.8,"y":450.5},{"x":573.9,"y":452.5},{"x":575.2,"y":453.1},{"x":575.9,"y":454.7},{"x":576.5,"y":456.2},{"x":576.8,"y":457.8},{"x":577.6,"y":459.5},{"x":578.3,"y":461},{"x":578.9,"y":462.3},{"x":578.9,"y":464.1},{"x":578.5,"y":466},{"x":577.5,"y":467.6},{"x":576.7,"y":469.2},{"x":575.8,"y":470.8},{"x":576.4,"y":473.2},{"x":575.3,"y":475.3},{"x":576.3,"y":476.9},{"x":576.6,"y":478.8},{"x":575.9,"y":479.9},{"x":575.1,"y":481.7},{"x":574.7,"y":482.9},{"x":574,"y":484.1},{"x":572.9,"y":485.3},{"x":574.4,"y":487.2},{"x":571.8,"y":487.5},{"x":569.7,"y":488.1},{"x":562.3,"y":491.6},{"x":560.7,"y":492.6},{"x":559.2,"y":493.4},{"x":560.5,"y":492.2},{"x":561.8,"y":491.5},{"x":562.7,"y":490.4},{"x":559.9,"y":490.6},{"x":560.4,"y":488.7},{"x":560.6,"y":486.2},{"x":558.6,"y":486.3},{"x":557.8,"y":487.7},{"x":555.6,"y":488.1},{"x":555.4,"y":490},{"x":557.2,"y":491.1},{"x":557.6,"y":493.6},{"x":557,"y":495.1},{"x":555.4,"y":496.1},{"x":554.2,"y":497.2},{"x":553.1,"y":498.3},{"x":555.7,"y":496.9},{"x":557.7,"y":495},{"x":558.6,"y":493.9},{"x":560.1,"y":494.2},{"x":559,"y":495.2},{"x":555.4,"y":497.6},{"x":554,"y":498.7},{"x":551.9,"y":500.6},{"x":549.6,"y":502.9},{"x":544.7,"y":505.4},{"x":542.6,"y":506.7},{"x":539.5,"y":508.1},{"x":535.9,"y":509.9},{"x":533.9,"y":511.2},{"x":532.3,"y":513.1},{"x":529.2,"y":514.8},{"x":527.7,"y":515.9},{"x":524.9,"y":518.3},{"x":523,"y":520.6},{"x":522.4,"y":521.9},{"x":519.5,"y":526.3},{"x":518.1,"y":529.4},{"x":517.4,"y":531.4},{"x":516.7,"y":534.5},{"x":516.6,"y":536.2},{"x":516.6,"y":537.8},{"x":517.1,"y":541.1},{"x":517.9,"y":544.4},{"x":518.5,"y":546.5},{"x":519.5,"y":550.1},{"x":520.1,"y":554.3},{"x":519.4,"y":551.2},{"x":518.7,"y":548.2},{"x":518.1,"y":545.8},{"x":516.6,"y":545.5},{"x":517.2,"y":543.8},{"x":516.9,"y":542.4},{"x":516.3,"y":541},{"x":516.2,"y":539.3},{"x":516.3,"y":537.1},{"x":516.2,"y":535.2},{"x":517,"y":530.8},{"x":518,"y":528},{"x":519.1,"y":525.6},{"x":520,"y":524.5},{"x":520.6,"y":523.1},{"x":520.9,"y":521.9},{"x":521.7,"y":520.5},{"x":523.3,"y":519.2},{"x":524.4,"y":517.2},{"x":526.1,"y":516.3},{"x":527.5,"y":515.4},{"x":529.6,"y":513.8},{"x":530.9,"y":513},{"x":532.4,"y":512.6},{"x":532.1,"y":511.2},{"x":530,"y":512.4},{"x":528.3,"y":513.1},{"x":528,"y":511.5},{"x":526.6,"y":511.8},{"x":526.6,"y":513.2},{"x":526.4,"y":514.8},{"x":525.2,"y":515.7},{"x":524.2,"y":516.6},{"x":522.7,"y":516.1},{"x":520.6,"y":516.4},{"x":519.6,"y":517.5},{"x":522.2,"y":516.9},{"x":522.3,"y":518.5},{"x":520,"y":522},{"x":518.9,"y":521.1},{"x":517.5,"y":521},{"x":515.6,"y":521.1},{"x":516.8,"y":521.8},{"x":517,"y":523.6},{"x":518.8,"y":524.5},{"x":517.7,"y":526.8},{"x":516.9,"y":529.7},{"x":516.1,"y":531.4},{"x":514.5,"y":532.2},{"x":514.9,"y":530.6},{"x":512.3,"y":532.2},{"x":514,"y":533},{"x":515.5,"y":532.4},{"x":515.6,"y":534.3},{"x":515.5,"y":537.5},{"x":515.1,"y":540.8},{"x":515.4,"y":544.5},{"x":515.9,"y":546.9},{"x":517.8,"y":550.3},{"x":517.7,"y":552.1},{"x":518.1,"y":554.2},{"x":519.4,"y":554.9},{"x":520.2,"y":556.7},{"x":518.8,"y":556.5},{"x":516.8,"y":557.1},{"x":516.4,"y":558.7},{"x":514.8,"y":557.8},{"x":513.5,"y":556.9},{"x":511.8,"y":555.3},{"x":509.9,"y":555},{"x":508.2,"y":554.6},{"x":506.4,"y":554.6},{"x":504.6,"y":554.3},{"x":502.9,"y":554.1},{"x":501.2,"y":553.6},{"x":500.3,"y":552.5},{"x":498.2,"y":551.3},{"x":496.1,"y":550.6},{"x":494.2,"y":550.4},{"x":493.3,"y":549.3},{"x":492.1,"y":548.4},{"x":489.8,"y":547.8},{"x":487.9,"y":547.8},{"x":487.8,"y":546.3},{"x":486.5,"y":545.1},{"x":486.4,"y":543.6},{"x":485.9,"y":541.7},{"x":485,"y":539.4},{"x":484.2,"y":538.2},{"x":483,"y":537.2},{"x":482.2,"y":536},{"x":482.5,"y":534.7},{"x":482.6,"y":533.2},{"x":482.4,"y":531.8},{"x":481.6,"y":530.8},{"x":481.8,"y":528.8},{"x":481.9,"y":527.4},{"x":481.5,"y":526},{"x":480.4,"y":525.2},{"x":478.9,"y":524.1},{"x":477.3,"y":522.7},{"x":476.2,"y":522},{"x":475.6,"y":520.6},{"x":474.7,"y":518.7},{"x":473.8,"y":517.7},{"x":473.5,"y":516.4},{"x":472.5,"y":514.9},{"x":470.5,"y":513.9},{"x":469.1,"y":512.1},{"x":468.3,"y":509.9},{"x":468.1,"y":508.5},{"x":467.4,"y":507.1},{"x":467,"y":505.5},{"x":465.9,"y":504.2},{"x":465.4,"y":501.9},{"x":464.6,"y":500.5},{"x":464,"y":498.4},{"x":463.6,"y":496.7},{"x":462.1,"y":495.3},{"x":461.8,"y":493.9},{"x":460.5,"y":493.2},{"x":459.5,"y":491.9},{"x":457.7,"y":490.1},{"x":456.3,"y":489.3},{"x":454.6,"y":488.4},{"x":454.8,"y":486.5},{"x":453,"y":485.7},{"x":452.3,"y":483.9},{"x":450.6,"y":483.8},{"x":447.6,"y":483.5},{"x":446.2,"y":483.1},{"x":444.1,"y":482.8},{"x":442.4,"y":482.4},{"x":440.7,"y":482.3},{"x":439.3,"y":481.5},{"x":438.2,"y":480.8},{"x":436.7,"y":482.8},{"x":434.8,"y":482.3},{"x":432.5,"y":483.1},{"x":431.7,"y":484.1},{"x":430.8,"y":485.5},{"x":429.6,"y":486.8},{"x":429.1,"y":488.2},{"x":428.8,"y":489.8},{"x":428,"y":491},{"x":427.9,"y":492.5},{"x":426.2,"y":492.9},{"x":424.7,"y":494.5},{"x":423.9,"y":496.4},{"x":422.1,"y":496.1},{"x":420.5,"y":495.5},{"x":418.9,"y":495},{"x":417.5,"y":493.1},{"x":416.1,"y":492.4},{"x":414.3,"y":491.8},{"x":413.4,"y":490.5},{"x":410.4,"y":489.5},{"x":408.5,"y":487.9},{"x":406.8,"y":486.3},{"x":406.1,"y":485.1},{"x":404.3,"y":484.4},{"x":402.4,"y":482.4},{"x":401.7,"y":479.9},{"x":400.8,"y":478},{"x":400.2,"y":476},{"x":400.3,"y":473.9},{"x":400.4,"y":472.2},{"x":399.6,"y":470.5},{"x":398.8,"y":469.1},{"x":398.1,"y":468},{"x":397.7,"y":464.6},{"x":396.2,"y":462.3},{"x":394.7,"y":461.1},{"x":393.1,"y":459.9},{"x":390.3,"y":458.6},{"x":388.1,"y":455.8},{"x":387.5,"y":454},{"x":385.9,"y":452.9},{"x":384.9,"y":451.6},{"x":383.7,"y":449.8},{"x":382.5,"y":448.2},{"x":380.6,"y":447.4},{"x":378.8,"y":445.9},{"x":378.3,"y":444.5},{"x":377.6,"y":442.9},{"x":377,"y":441.4},{"x":375.6,"y":440},{"x":374.1,"y":439},{"x":372.9,"y":437.8},{"x":373.4,"y":435.3},{"x":391.9,"y":437.3},{"x":405.9,"y":438.6},{"x":418.6,"y":439.7},{"x":428.9,"y":440.5},{"x":430.3,"y":421.1},{"x":430.7,"y":417},{"x":430.9,"y":414.6},{"x":431.5,"y":408},{"x":431.9,"y":404.3},{"x":433.7,"y":379.9},{"x":434.3,"y":372.9},{"x":435.3,"y":359.9}]],"x":372.9,"y":356.6,"w":206,"h":202.1,"cx":487.2,"cy":453.6},"WY":{"shapes":[[{"x":434,"y":196.9},{"x":433.8,"y":199.1},{"x":431.3,"y":228.3},{"x":430.9,"y":234},{"x":427.7,"y":271.2},{"x":416.9,"y":270.3},{"x":404.6,"y":269.1},{"x":397.8,"y":268.4},{"x":394.5,"y":268},{"x":378.3,"y":266.1},{"x":370.7,"y":265.2},{"x":358.7,"y":263.6},{"x":352,"y":262.6},{"x":344.9,"y":261.6},{"x":342.3,"y":261.3},{"x":335.8,"y":260.3},{"x":331.2,"y":259.5},{"x":332.3,"y":252.5},{"x":332.9,"y":249},{"x":334.2,"y":241},{"x":335.9,"y":230.2},{"x":336.3,"y":227.7},{"x":339.1,"y":210.4},{"x":340.4,"y":201.8},{"x":341,"y":197.6},{"x":341.4,"y":195.4},{"x":341.8,"y":192.6},{"x":342.4,"y":188.1},{"x":342.9,"y":185.7},{"x":346.4,"y":186.2},{"x":351.3,"y":187.1},{"x":354,"y":187.5},{"x":359.2,"y":188.2},{"x":368.2,"y":189.4},{"x":379,"y":190.9},{"x":393.8,"y":192.8},{"x":401.2,"y":193.7},{"x":409.5,"y":194.6},{"x":416.8,"y":195.2},{"x":428.6,"y":196.4}]],"x":331.2,"y":185.7,"w":102.8,"h":85.5,"cx":383.9,"cy":229.3},"CT":{"shapes":[[{"x":845.1,"y":220},{"x":851.5,"y":218.6},{"x":854.1,"y":218.1},{"x":856.8,"y":217.5},{"x":867.6,"y":214.9},{"x":868.1,"y":216.8},{"x":869.1,"y":220.2},{"x":869.8,"y":222.5},{"x":870.5,"y":225.8},{"x":870.4,"y":227.3},{"x":868.9,"y":227.8},{"x":867.1,"y":228.6},{"x":865.7,"y":228.9},{"x":863.3,"y":230.7},{"x":861.2,"y":231.4},{"x":859.5,"y":231.5},{"x":856.5,"y":232.7},{"x":855.2,"y":233.7},{"x":853.8,"y":235.3},{"x":852.2,"y":236.2},{"x":850.8,"y":236.8},{"x":849.4,"y":238.2},{"x":848.5,"y":239.3},{"x":846,"y":238},{"x":848.8,"y":235.2},{"x":847.5,"y":233.9},{"x":847.1,"y":231.4},{"x":846.2,"y":226.7}]],"x":845.1,"y":214.9,"w":25.4,"h":24.4,"cx":857.1,"cy":225.3},"MO":{"shapes":[[{"x":542.8,"y":283.8},{"x":551.2,"y":283.9},{"x":559.2,"y":283.9},{"x":567,"y":283.7},{"x":573.6,"y":283.4},{"x":576.7,"y":283.3},{"x":586.6,"y":282.8},{"x":594.2,"y":282.3},{"x":599.2,"y":281.9},{"x":599.9,"y":283},{"x":601.7,"y":284.7},{"x":602.8,"y":286},{"x":602.7,"y":288.8},{"x":603,"y":292.6},{"x":603.8,"y":294.1},{"x":603.9,"y":295.6},{"x":604.9,"y":296.7},{"x":605,"y":298.2},{"x":606.4,"y":299.3},{"x":607.8,"y":300.4},{"x":609,"y":301.6},{"x":609.7,"y":302.8},{"x":613.6,"y":305.7},{"x":614.7,"y":307},{"x":615,"y":308.5},{"x":615.5,"y":309.7},{"x":615.7,"y":311.7},{"x":617.1,"y":313.7},{"x":618.6,"y":312},{"x":621,"y":312.5},{"x":623.8,"y":313.7},{"x":623.2,"y":315.2},{"x":623.2,"y":317.6},{"x":622.1,"y":319.8},{"x":621.9,"y":321.5},{"x":621.1,"y":322.6},{"x":620.8,"y":324.7},{"x":622.1,"y":326.6},{"x":623.2,"y":327.9},{"x":624.5,"y":328.5},{"x":625.6,"y":329.3},{"x":626.5,"y":330.2},{"x":627.3,"y":331.6},{"x":628.8,"y":331.1},{"x":630.4,"y":332.1},{"x":631.7,"y":333.2},{"x":632.9,"y":334.5},{"x":633.9,"y":335.7},{"x":634.1,"y":337.7},{"x":635.6,"y":340.2},{"x":634.7,"y":341.5},{"x":635.3,"y":343.2},{"x":636.1,"y":345.3},{"x":636.7,"y":346.9},{"x":638,"y":347.7},{"x":638.4,"y":346.3},{"x":639.8,"y":348},{"x":640.7,"y":349.5},{"x":640,"y":351},{"x":639.8,"y":352.7},{"x":640,"y":354.1},{"x":639.1,"y":355.6},{"x":638,"y":354.5},{"x":636.8,"y":357},{"x":635.8,"y":355.7},{"x":634.5,"y":356.3},{"x":635.4,"y":357.5},{"x":635.7,"y":359.5},{"x":634.2,"y":360.2},{"x":635.4,"y":361.3},{"x":633.1,"y":361.9},{"x":634.5,"y":363.4},{"x":633.5,"y":365},{"x":632.8,"y":366.7},{"x":623.2,"y":367.4},{"x":624,"y":365.6},{"x":625.2,"y":364.5},{"x":625.9,"y":363.3},{"x":626.8,"y":362.1},{"x":627.4,"y":359.8},{"x":626.2,"y":359.1},{"x":626,"y":357.8},{"x":607.5,"y":358.8},{"x":590.4,"y":359.5},{"x":582.9,"y":359.8},{"x":571.1,"y":360.1},{"x":560,"y":360.2},{"x":559.8,"y":350.9},{"x":559.8,"y":346.4},{"x":559.8,"y":344.8},{"x":559.6,"y":332.2},{"x":559.5,"y":320.2},{"x":559.5,"y":318.3},{"x":559.4,"y":311.1},{"x":558.4,"y":309.9},{"x":556.9,"y":309.5},{"x":555.4,"y":308},{"x":555.1,"y":306.8},{"x":553.9,"y":305},{"x":552.3,"y":303.4},{"x":553.1,"y":302.3},{"x":553.3,"y":300.9},{"x":554.3,"y":299.4},{"x":555.5,"y":298.9},{"x":554.9,"y":297.7},{"x":553.5,"y":296.5},{"x":551.8,"y":297},{"x":550.8,"y":295.8},{"x":549.3,"y":294.7},{"x":547.7,"y":293.8},{"x":548.1,"y":292.5},{"x":546.9,"y":291.3},{"x":545.8,"y":289.8},{"x":544.3,"y":287.1},{"x":543.8,"y":285.3}]],"x":542.8,"y":281.9,"w":97.9,"h":85.5,"cx":590.6,"cy":324.6},"WV":{"shapes":[[{"x":732.1,"y":310.7},{"x":734.8,"y":310},{"x":736.1,"y":308.9},{"x":736,"y":307.3},{"x":737.4,"y":306.7},{"x":737.2,"y":304.6},{"x":736.5,"y":303},{"x":737.4,"y":302},{"x":737.8,"y":299.5},{"x":738.5,"y":298.3},{"x":739.8,"y":298.8},{"x":740.6,"y":299.9},{"x":742.3,"y":299.7},{"x":742.3,"y":297.9},{"x":741.4,"y":296.9},{"x":742,"y":294.9},{"x":742.8,"y":293},{"x":744.3,"y":292.9},{"x":744.3,"y":291.6},{"x":745.4,"y":290.1},{"x":746.7,"y":291.1},{"x":748.2,"y":290.1},{"x":749.5,"y":288.8},{"x":750.3,"y":287.8},{"x":752.2,"y":285.1},{"x":753,"y":283.5},{"x":753.2,"y":281.4},{"x":753.5,"y":280.1},{"x":753.6,"y":278.4},{"x":753.6,"y":276.1},{"x":753.8,"y":274.6},{"x":754.3,"y":272.8},{"x":754.8,"y":271.3},{"x":754.4,"y":269.8},{"x":753.8,"y":267.3},{"x":753.4,"y":265.9},{"x":754.9,"y":265.2},{"x":757.7,"y":282.2},{"x":763.9,"y":281.1},{"x":772.3,"y":279.7},{"x":773.8,"y":289.2},{"x":775.7,"y":287.1},{"x":776.6,"y":285.9},{"x":778,"y":284.6},{"x":778.4,"y":283.3},{"x":780.5,"y":283.6},{"x":782.3,"y":279.8},{"x":783.3,"y":280.7},{"x":785.2,"y":280.9},{"x":787,"y":280.9},{"x":787.1,"y":279.5},{"x":788.2,"y":278.3},{"x":790.4,"y":276.9},{"x":792.6,"y":277.6},{"x":794,"y":277.6},{"x":795.6,"y":277.6},{"x":795.8,"y":279.6},{"x":796.8,"y":280.6},{"x":797.6,"y":282.4},{"x":797.3,"y":286.3},{"x":792.8,"y":283.7},{"x":788.9,"y":281.5},{"x":789.2,"y":282.9},{"x":788.6,"y":285.6},{"x":789.2,"y":287.2},{"x":788.2,"y":288.5},{"x":787.2,"y":290.1},{"x":787.1,"y":291.4},{"x":786.1,"y":292.4},{"x":784.6,"y":293.6},{"x":784,"y":295.8},{"x":781.9,"y":294.6},{"x":781,"y":297.2},{"x":780.4,"y":299.4},{"x":780,"y":301.7},{"x":778.9,"y":303.5},{"x":776.4,"y":303},{"x":775.2,"y":301.5},{"x":773.5,"y":301},{"x":773.1,"y":303},{"x":773,"y":305.1},{"x":772.1,"y":306.7},{"x":770.9,"y":309.3},{"x":771.1,"y":310.6},{"x":770.7,"y":312.2},{"x":769.5,"y":314},{"x":768.2,"y":315.9},{"x":767.4,"y":317.9},{"x":767.1,"y":319.2},{"x":768.4,"y":320.2},{"x":767.1,"y":321.6},{"x":765.4,"y":324.6},{"x":764.1,"y":323.8},{"x":761.3,"y":326.2},{"x":759.8,"y":325.4},{"x":760.2,"y":326.9},{"x":758.4,"y":328},{"x":756.6,"y":328.7},{"x":755.1,"y":329.8},{"x":753.5,"y":328.8},{"x":752.2,"y":329.5},{"x":751,"y":330.5},{"x":748.6,"y":331.4},{"x":747.5,"y":330.4},{"x":745.9,"y":330.2},{"x":744.6,"y":329.1},{"x":744.3,"y":327.7},{"x":744.1,"y":326.2},{"x":742.8,"y":326},{"x":741.3,"y":325.8},{"x":740.2,"y":324.6},{"x":738.4,"y":324.1},{"x":737.5,"y":322},{"x":736.1,"y":320.9},{"x":734.7,"y":319.6},{"x":733.7,"y":317.2},{"x":732.2,"y":316.1},{"x":732.6,"y":314.5},{"x":732.8,"y":312.7}]],"x":732.1,"y":265.2,"w":65.5,"h":66.2,"cx":759.5,"cy":302.4},"IL":{"shapes":[[{"x":603.8,"y":286.1},{"x":604.4,"y":283.6},{"x":604.4,"y":281.9},{"x":605.9,"y":281.1},{"x":607.7,"y":280.4},{"x":607.9,"y":278.6},{"x":608.4,"y":277.1},{"x":609.6,"y":275.6},{"x":609.8,"y":273.9},{"x":609.7,"y":272.3},{"x":609,"y":271.2},{"x":607.2,"y":269.8},{"x":607.7,"y":268.5},{"x":608,"y":266.4},{"x":609.6,"y":266.2},{"x":610.7,"y":265.5},{"x":612.2,"y":265.6},{"x":614.2,"y":264.3},{"x":615.9,"y":264},{"x":617.5,"y":262.6},{"x":617.8,"y":260.6},{"x":618.2,"y":259.3},{"x":619.5,"y":258.4},{"x":619.7,"y":256.6},{"x":619.8,"y":254.6},{"x":619.4,"y":252.6},{"x":616.3,"y":251},{"x":615.5,"y":249.8},{"x":614.8,"y":247.9},{"x":613.6,"y":247},{"x":612.4,"y":245.7},{"x":614.6,"y":245.6},{"x":625.7,"y":245},{"x":628.2,"y":244.9},{"x":637.6,"y":244.4},{"x":639.6,"y":244.1},{"x":647,"y":243.5},{"x":651,"y":243.3},{"x":651.1,"y":245.3},{"x":650.8,"y":246.9},{"x":651.5,"y":248.6},{"x":652.7,"y":250.3},{"x":653.5,"y":251.7},{"x":654.4,"y":253.9},{"x":655.5,"y":256.5},{"x":656.4,"y":261.6},{"x":658.1,"y":280.8},{"x":658.4,"y":284.8},{"x":658.8,"y":289.5},{"x":659.4,"y":296},{"x":659.9,"y":301.6},{"x":659,"y":303.3},{"x":658.6,"y":305.1},{"x":659.8,"y":307.1},{"x":660.8,"y":308.9},{"x":660.4,"y":310.8},{"x":661.3,"y":312.2},{"x":660.8,"y":314.1},{"x":659.5,"y":316.3},{"x":658.4,"y":318.2},{"x":658,"y":320.2},{"x":657.1,"y":322},{"x":655.6,"y":322.8},{"x":656.2,"y":324.5},{"x":655.2,"y":325.8},{"x":655.3,"y":327.8},{"x":654.6,"y":329},{"x":655.1,"y":330.7},{"x":654.9,"y":332.3},{"x":653.6,"y":333.8},{"x":654.1,"y":335.5},{"x":655.2,"y":336.5},{"x":652.5,"y":337.8},{"x":651,"y":339},{"x":649.4,"y":339.4},{"x":649,"y":341.4},{"x":650.1,"y":342.7},{"x":650.1,"y":345.2},{"x":648.6,"y":345.3},{"x":647.6,"y":344.6},{"x":645.7,"y":344.1},{"x":643.2,"y":342.9},{"x":641.6,"y":343.3},{"x":640.5,"y":345.1},{"x":639.6,"y":346.9},{"x":638.4,"y":346.3},{"x":638,"y":347.7},{"x":636.7,"y":346.9},{"x":636.1,"y":345.3},{"x":635.3,"y":344},{"x":634.3,"y":342.4},{"x":635.5,"y":341.2},{"x":634.1,"y":337.7},{"x":633.9,"y":335.7},{"x":632.9,"y":334.5},{"x":631.6,"y":333.8},{"x":630.4,"y":332.1},{"x":628.8,"y":331.1},{"x":627.3,"y":331.6},{"x":627.3,"y":330},{"x":625.6,"y":329.3},{"x":624.5,"y":328.5},{"x":623.2,"y":327.9},{"x":622.1,"y":326.6},{"x":620.8,"y":324.7},{"x":621.1,"y":322.6},{"x":621.9,"y":321.5},{"x":622.1,"y":319.8},{"x":623.1,"y":318.2},{"x":622.6,"y":316.2},{"x":623.8,"y":314.7},{"x":621.8,"y":312.5},{"x":619.5,"y":311.8},{"x":618.2,"y":313},{"x":615.9,"y":312.7},{"x":615,"y":310.3},{"x":615,"y":308.5},{"x":614.7,"y":307},{"x":613.6,"y":305.7},{"x":610.5,"y":303.6},{"x":609,"y":301.6},{"x":607.8,"y":300.4},{"x":606.4,"y":299.3},{"x":605,"y":298.2},{"x":604.9,"y":296.7},{"x":603.9,"y":295.6},{"x":603.8,"y":294.1},{"x":603,"y":292.6},{"x":602.6,"y":289.9}]],"x":602.6,"y":243.3,"w":58.7,"h":104.4,"cx":635.3,"cy":290.5},"NM":{"shapes":[[{"x":348.5,"y":337.9},{"x":360.1,"y":339.5},{"x":372.1,"y":340.9},{"x":380.1,"y":341.9},{"x":389.9,"y":343.1},{"x":405.7,"y":344.7},{"x":407.5,"y":344.9},{"x":417.2,"y":345.8},{"x":426.1,"y":346.4},{"x":436.8,"y":347.2},{"x":436.2,"y":354.7},{"x":436,"y":356.6},{"x":435.3,"y":359.9},{"x":434.3,"y":372.9},{"x":433.7,"y":379.9},{"x":431.9,"y":404.3},{"x":431.5,"y":408},{"x":430.9,"y":414.6},{"x":430.7,"y":417},{"x":430.3,"y":421.1},{"x":428.9,"y":440.5},{"x":418.6,"y":439.7},{"x":405.9,"y":438.6},{"x":391.9,"y":437.3},{"x":373.4,"y":435.3},{"x":373.2,"y":436.9},{"x":373.4,"y":438.2},{"x":374.4,"y":439.5},{"x":362.4,"y":438.1},{"x":348.2,"y":436.3},{"x":347.1,"y":444.7},{"x":333.9,"y":442.9},{"x":340.2,"y":397.7},{"x":340.5,"y":395.9},{"x":340.7,"y":393.6},{"x":342.1,"y":383.9},{"x":344.2,"y":369.1},{"x":344.8,"y":364.9}]],"x":333.9,"y":337.9,"w":102.9,"h":106.8,"cx":386.1,"cy":391.4},"AR":{"shapes":[[{"x":560,"y":360.2},{"x":571.1,"y":360.1},{"x":582.9,"y":359.8},{"x":590.4,"y":359.5},{"x":607.5,"y":358.8},{"x":626,"y":357.8},{"x":626.2,"y":359.1},{"x":627.4,"y":359.8},{"x":627.3,"y":361.9},{"x":625.9,"y":363.3},{"x":625.2,"y":364.5},{"x":624,"y":365.6},{"x":623.2,"y":367.4},{"x":632.8,"y":366.7},{"x":634,"y":368},{"x":632.8,"y":368.4},{"x":633.5,"y":369.8},{"x":631.9,"y":371.3},{"x":630.5,"y":371.4},{"x":630.1,"y":373.1},{"x":631.5,"y":373.6},{"x":630.1,"y":374.3},{"x":630.6,"y":376},{"x":629.4,"y":375.1},{"x":628.7,"y":376.3},{"x":628.7,"y":378.2},{"x":628.2,"y":376.8},{"x":627,"y":377.9},{"x":628.4,"y":378.5},{"x":628,"y":380.1},{"x":628.6,"y":381.5},{"x":628.9,"y":383.1},{"x":627.2,"y":383.7},{"x":626.9,"y":385.3},{"x":625.5,"y":385.2},{"x":626.3,"y":386.8},{"x":625.5,"y":388.3},{"x":623.8,"y":389.1},{"x":623.5,"y":390.9},{"x":622.5,"y":389.8},{"x":621.8,"y":391.1},{"x":623.2,"y":391.7},{"x":622.6,"y":393},{"x":621.5,"y":392.3},{"x":622.3,"y":394.3},{"x":621.7,"y":395.6},{"x":622.1,"y":396.9},{"x":620.8,"y":397.9},{"x":619.4,"y":398.1},{"x":619.2,"y":399.8},{"x":618.1,"y":401.2},{"x":616.7,"y":401.1},{"x":618.6,"y":401.7},{"x":617.1,"y":402.1},{"x":617,"y":403.4},{"x":617.4,"y":404.7},{"x":616.1,"y":404.9},{"x":614.8,"y":405.6},{"x":615.9,"y":406.5},{"x":615,"y":407.9},{"x":616.3,"y":409.1},{"x":614,"y":409.5},{"x":614.6,"y":410.8},{"x":612.9,"y":411.1},{"x":614.2,"y":412.3},{"x":612.8,"y":413.6},{"x":612.9,"y":415.9},{"x":613.8,"y":414.8},{"x":614.4,"y":416},{"x":614.4,"y":417.5},{"x":615.2,"y":419.5},{"x":615.5,"y":421.1},{"x":613.9,"y":421.4},{"x":615,"y":423},{"x":602.2,"y":424.5},{"x":593.6,"y":424.7},{"x":584.9,"y":424.9},{"x":580.1,"y":425},{"x":569.9,"y":425.3},{"x":569.7,"y":415.5},{"x":568.1,"y":414.8},{"x":566.8,"y":415.3},{"x":565.5,"y":415.4},{"x":563.9,"y":414.9},{"x":563.2,"y":413.7},{"x":562.9,"y":403.5},{"x":562.9,"y":396.8},{"x":563,"y":394},{"x":563,"y":390.3},{"x":563.1,"y":386.1},{"x":563.1,"y":380.9},{"x":562.2,"y":374.7},{"x":561.9,"y":373.4},{"x":561.1,"y":367.7},{"x":560.7,"y":365.6},{"x":560.3,"y":362.3}]],"x":560,"y":357.8,"w":74,"h":67.5,"cx":593.3,"cy":389.5},"CA":{"shapes":[[{"x":158.5,"y":200.3},{"x":165.8,"y":202.6},{"x":169.8,"y":203.7},{"x":172.5,"y":204.3},{"x":173.8,"y":204.8},{"x":179.3,"y":206.4},{"x":181,"y":206.8},{"x":185.5,"y":208.1},{"x":187.6,"y":208.8},{"x":194.9,"y":210.9},{"x":200.3,"y":212.5},{"x":209.7,"y":215},{"x":214.1,"y":216.1},{"x":208.2,"y":238.6},{"x":205.1,"y":251},{"x":203.5,"y":257.1},{"x":201.5,"y":264.4},{"x":201,"y":266.3},{"x":200,"y":270.4},{"x":201,"y":271.9},{"x":205.4,"y":278.6},{"x":209.8,"y":285.2},{"x":212.3,"y":288.9},{"x":216.2,"y":294.7},{"x":221.1,"y":302.2},{"x":223.6,"y":305.8},{"x":228.6,"y":313.5},{"x":241.4,"y":332.7},{"x":251.1,"y":347.2},{"x":254,"y":351.7},{"x":260.2,"y":361},{"x":259.7,"y":363.3},{"x":260.5,"y":365.5},{"x":261.6,"y":366.8},{"x":262.2,"y":370.8},{"x":264,"y":373.9},{"x":265.1,"y":375.3},{"x":263.4,"y":376.8},{"x":261.7,"y":377.8},{"x":260.4,"y":378},{"x":259.6,"y":379.5},{"x":257.8,"y":381},{"x":258,"y":382.3},{"x":257.6,"y":384.2},{"x":257,"y":385.5},{"x":256.5,"y":387.2},{"x":254,"y":390.1},{"x":252.6,"y":391.9},{"x":252.7,"y":394.9},{"x":252.7,"y":397.1},{"x":254.8,"y":397.5},{"x":255.2,"y":399.8},{"x":253.7,"y":401.9},{"x":252.2,"y":402.7},{"x":251,"y":402.2},{"x":227.4,"y":399.9},{"x":213.3,"y":398.2},{"x":213.5,"y":396.7},{"x":212.8,"y":395.2},{"x":212.4,"y":393.2},{"x":212.8,"y":391.6},{"x":212.9,"y":389},{"x":212.6,"y":386.8},{"x":210.9,"y":382.3},{"x":209.7,"y":381.1},{"x":208.7,"y":379.4},{"x":207.5,"y":377.6},{"x":206.4,"y":376.3},{"x":204.8,"y":374.8},{"x":203.8,"y":373.1},{"x":202.6,"y":372.2},{"x":201.1,"y":373},{"x":199.8,"y":372},{"x":199.6,"y":370.7},{"x":199.5,"y":368},{"x":198.4,"y":365.9},{"x":196.5,"y":365.4},{"x":194.3,"y":365.6},{"x":192.3,"y":364.2},{"x":190.6,"y":362.8},{"x":188.9,"y":361.5},{"x":188.5,"y":359},{"x":187.3,"y":357.7},{"x":186.3,"y":356.4},{"x":185,"y":355.3},{"x":183.4,"y":354.8},{"x":181.6,"y":354.4},{"x":178.7,"y":352.8},{"x":176.7,"y":352},{"x":174.4,"y":351.5},{"x":171.7,"y":351.2},{"x":171.4,"y":349.5},{"x":170,"y":348.7},{"x":171.1,"y":346.1},{"x":171.7,"y":343.3},{"x":172,"y":340.5},{"x":172.6,"y":338.4},{"x":171.9,"y":337.2},{"x":169.8,"y":336},{"x":170.5,"y":333.2},{"x":170.2,"y":331.4},{"x":168.9,"y":330.8},{"x":167.9,"y":328.9},{"x":167.4,"y":327},{"x":166.3,"y":326.3},{"x":165.7,"y":325},{"x":165.7,"y":323.7},{"x":164.9,"y":322.1},{"x":164.4,"y":319.7},{"x":163.4,"y":318.4},{"x":163.1,"y":316.5},{"x":162.2,"y":314.7},{"x":160.8,"y":313.3},{"x":160.4,"y":311.1},{"x":160.5,"y":308.7},{"x":161,"y":307.3},{"x":161.3,"y":305.9},{"x":162.7,"y":306.4},{"x":164.3,"y":303.5},{"x":163.9,"y":300.9},{"x":163,"y":299.7},{"x":160.5,"y":299.5},{"x":159.4,"y":298},{"x":158.8,"y":296.1},{"x":157.6,"y":293.9},{"x":158.5,"y":291},{"x":158.2,"y":289.4},{"x":157.7,"y":287.6},{"x":158.3,"y":286.3},{"x":159,"y":282.9},{"x":160.7,"y":282.8},{"x":160.8,"y":284.7},{"x":160.4,"y":286.6},{"x":161.5,"y":287.7},{"x":162.5,"y":289.3},{"x":163.3,"y":290.5},{"x":163.2,"y":288},{"x":163.3,"y":286.2},{"x":162.5,"y":285.1},{"x":161.6,"y":283.6},{"x":162.3,"y":281.4},{"x":161.2,"y":280},{"x":163.2,"y":279.6},{"x":163.7,"y":277.9},{"x":162.6,"y":276.9},{"x":161.1,"y":277.1},{"x":160.5,"y":278.5},{"x":159.9,"y":280.3},{"x":160.6,"y":281.4},{"x":159,"y":282.2},{"x":157.7,"y":280.1},{"x":156.2,"y":278.8},{"x":155.2,"y":277.1},{"x":153.3,"y":276.9},{"x":154.5,"y":275.2},{"x":154.7,"y":272.9},{"x":154.7,"y":271.3},{"x":154,"y":268.4},{"x":153.2,"y":267.3},{"x":151.8,"y":265.5},{"x":150.8,"y":262.2},{"x":150,"y":260.8},{"x":148.9,"y":259},{"x":148.3,"y":256.8},{"x":149.3,"y":255.9},{"x":149.4,"y":253},{"x":149.2,"y":250.9},{"x":149.3,"y":249.2},{"x":149.9,"y":247.7},{"x":151.2,"y":245.9},{"x":151.5,"y":244},{"x":151.2,"y":242.4},{"x":151.5,"y":240.6},{"x":150.9,"y":238.9},{"x":149.8,"y":236.3},{"x":149.5,"y":234.7},{"x":146.9,"y":230.8},{"x":147.6,"y":228.8},{"x":147.3,"y":227.5},{"x":148.2,"y":226.1},{"x":149.4,"y":224.6},{"x":152.6,"y":221.1},{"x":153.6,"y":219.8},{"x":154.5,"y":218.1},{"x":154.5,"y":215.9},{"x":155.7,"y":214.5},{"x":157.4,"y":210.9},{"x":157.8,"y":208.9},{"x":157.7,"y":206.8},{"x":157.7,"y":205.2},{"x":156.7,"y":204}]],"x":146.9,"y":200.3,"w":118.2,"h":202.4,"cx":199,"cy":305.3},"DE":{"shapes":[[{"x":823.5,"y":269.7},{"x":824.2,"y":268.1},{"x":826,"y":266.9},{"x":828.3,"y":267.1},{"x":827.8,"y":268.9},{"x":826.4,"y":270.9},{"x":827.3,"y":271.9},{"x":827.3,"y":273.8},{"x":828.7,"y":275.3},{"x":830,"y":276.1},{"x":831.1,"y":277.9},{"x":831.5,"y":280.5},{"x":833,"y":281.7},{"x":835.5,"y":284.6},{"x":836.8,"y":284.4},{"x":837.9,"y":286.9},{"x":838.9,"y":290.7},{"x":833.6,"y":291.8},{"x":829.9,"y":292.5},{"x":823.8,"y":271}]],"x":823.5,"y":266.9,"w":15.4,"h":25.6,"cx":830.4,"cy":282.2},"HI":{"shapes":[[{"x":381.9,"y":547.9},{"x":383.2,"y":546},{"x":384.7,"y":544.4},{"x":385.8,"y":543.6},{"x":384.9,"y":541.2},{"x":384.5,"y":538.8},{"x":386.2,"y":538.3},{"x":387.5,"y":539.3},{"x":388.9,"y":540},{"x":390.6,"y":540.7},{"x":392.2,"y":541.2},{"x":394.6,"y":542.4},{"x":396.8,"y":543.6},{"x":397.8,"y":544.5},{"x":398.9,"y":545.7},{"x":398.8,"y":547.9},{"x":400.3,"y":547.9},{"x":400.7,"y":549.7},{"x":402.1,"y":551},{"x":403.5,"y":551.6},{"x":402.8,"y":553.4},{"x":401.7,"y":554.2},{"x":399.4,"y":555.7},{"x":398.1,"y":556.5},{"x":395.8,"y":556.5},{"x":394.1,"y":557.7},{"x":392.3,"y":558.9},{"x":390.7,"y":560.1},{"x":389.9,"y":562.2},{"x":388.7,"y":563.2},{"x":387.7,"y":562.2},{"x":386.3,"y":561.4},{"x":384.9,"y":560.9},{"x":384.3,"y":559.4},{"x":384.6,"y":557.6},{"x":384.9,"y":555.2},{"x":384.2,"y":553.5},{"x":383.4,"y":550.8},{"x":382.4,"y":549.6}],[{"x":370.6,"y":526.2},{"x":371.6,"y":524.2},{"x":373.3,"y":524.6},{"x":373.9,"y":525.8},{"x":376,"y":526.2},{"x":378.8,"y":525.9},{"x":379.8,"y":527},{"x":382.7,"y":528.5},{"x":383.1,"y":529.8},{"x":381.7,"y":531.1},{"x":380.3,"y":531.6},{"x":377.5,"y":532.3},{"x":376.2,"y":532.5},{"x":374.7,"y":528.7},{"x":373.4,"y":528.8},{"x":371.8,"y":528}],[{"x":364.2,"y":526.5},{"x":365.5,"y":526},{"x":367.1,"y":526.3},{"x":368.2,"y":527.2},{"x":368.1,"y":529.1},{"x":365.9,"y":529.6},{"x":365.2,"y":527.5}],[{"x":359.9,"y":522.8},{"x":360.9,"y":521.5},{"x":362,"y":520.9},{"x":365.4,"y":521.3},{"x":367.6,"y":521.7},{"x":369.3,"y":521.4},{"x":369.9,"y":522.6},{"x":368.8,"y":523.5},{"x":365.3,"y":523.3},{"x":363.7,"y":522.8}],[{"x":343.1,"y":514},{"x":345.8,"y":513.8},{"x":346.8,"y":512.5},{"x":348.5,"y":511.5},{"x":349.3,"y":513.1},{"x":350.5,"y":514.4},{"x":350.7,"y":516.2},{"x":351.8,"y":517.1},{"x":352.9,"y":518.1},{"x":354,"y":519.2},{"x":352.5,"y":519.5},{"x":351.2,"y":519.9},{"x":349.8,"y":519},{"x":348.2,"y":518.8},{"x":346.4,"y":519.2},{"x":345.5,"y":517.8},{"x":343.9,"y":515.7}],[{"x":316.9,"y":505.4},{"x":317.7,"y":504.2},{"x":320,"y":502.3},{"x":321.9,"y":502.2},{"x":323.6,"y":501.8},{"x":325.2,"y":502.7},{"x":325.5,"y":504.2},{"x":324.8,"y":506.8},{"x":322.8,"y":508.5},{"x":320.1,"y":508},{"x":319,"y":506.9}]],"x":316.9,"y":501.8,"w":86.6,"h":61.4,"cx":376.9,"cy":538.6},"IA":{"shapes":[[{"x":533.5,"y":229.2},{"x":543,"y":229.2},{"x":558.1,"y":229.1},{"x":566.8,"y":229},{"x":577.5,"y":228.7},{"x":583.1,"y":228.5},{"x":593.9,"y":228.1},{"x":603.7,"y":227.6},{"x":604,"y":229.3},{"x":605.3,"y":231},{"x":606,"y":232.2},{"x":605,"y":234.1},{"x":604.7,"y":236.2},{"x":605.2,"y":237.6},{"x":605.8,"y":239.1},{"x":606.6,"y":241.7},{"x":608.2,"y":242.7},{"x":610.6,"y":243.1},{"x":612.4,"y":245.1},{"x":612.5,"y":246.5},{"x":613.7,"y":247.4},{"x":615.6,"y":248.9},{"x":616.3,"y":251},{"x":618.7,"y":252},{"x":619.4,"y":254.1},{"x":619.5,"y":255.6},{"x":619.4,"y":257.7},{"x":618.2,"y":259.3},{"x":617.8,"y":260.6},{"x":617.5,"y":262.6},{"x":615.9,"y":264},{"x":614.2,"y":264.3},{"x":612.2,"y":265.6},{"x":610.7,"y":265.5},{"x":609.6,"y":266.2},{"x":608,"y":266.4},{"x":607.7,"y":268.5},{"x":607.2,"y":269.8},{"x":608.3,"y":271.1},{"x":609.7,"y":272.3},{"x":609.8,"y":273.9},{"x":609.6,"y":275.6},{"x":608.4,"y":277.1},{"x":607.9,"y":278.6},{"x":607.7,"y":280.4},{"x":605.9,"y":281.1},{"x":604.4,"y":281.9},{"x":604.4,"y":283.6},{"x":604.3,"y":285},{"x":602.8,"y":286},{"x":602.2,"y":284.7},{"x":600.8,"y":283.8},{"x":599.9,"y":282.5},{"x":594.2,"y":282.3},{"x":586.6,"y":282.8},{"x":576.7,"y":283.3},{"x":573.6,"y":283.4},{"x":567,"y":283.7},{"x":559.2,"y":283.9},{"x":551.2,"y":283.9},{"x":542.8,"y":283.8},{"x":542.5,"y":282.4},{"x":541.1,"y":281.2},{"x":541.9,"y":280.1},{"x":541.7,"y":278.7},{"x":541.9,"y":276.4},{"x":541.2,"y":274.9},{"x":541.2,"y":273},{"x":540.8,"y":271.7},{"x":541.2,"y":270.1},{"x":540.5,"y":267.3},{"x":539.6,"y":265.9},{"x":538.4,"y":265.1},{"x":537.9,"y":263.2},{"x":538.5,"y":261.7},{"x":538,"y":260},{"x":537.8,"y":257.8},{"x":536.3,"y":257},{"x":535.8,"y":255.1},{"x":534.8,"y":254.2},{"x":534.4,"y":251.3},{"x":533.9,"y":249.6},{"x":534.2,"y":248.2},{"x":532.8,"y":247.6},{"x":532.6,"y":245.5},{"x":531,"y":244.1},{"x":531.5,"y":242.4},{"x":532.2,"y":240.1},{"x":532.9,"y":238.5},{"x":533.7,"y":236.3},{"x":533.2,"y":234.4},{"x":531.8,"y":233},{"x":532.5,"y":231.2},{"x":531.4,"y":230.2}]],"x":531,"y":227.6,"w":88.5,"h":58.4,"cx":573.8,"cy":255.5},"KY":{"shapes":[[{"x":640.4,"y":347.7},{"x":639.8,"y":346},{"x":640.9,"y":344},{"x":642.2,"y":342.9},{"x":644.9,"y":343.5},{"x":647.6,"y":344.6},{"x":648.6,"y":345.3},{"x":650.1,"y":345.2},{"x":650.5,"y":343.8},{"x":649.1,"y":341.8},{"x":649.3,"y":340.3},{"x":650.3,"y":338.6},{"x":651.9,"y":338.1},{"x":655,"y":337.3},{"x":654.1,"y":335.5},{"x":653.6,"y":333.8},{"x":654.9,"y":332.3},{"x":656.5,"y":331.6},{"x":656.4,"y":329.3},{"x":658,"y":329.5},{"x":660.1,"y":328.8},{"x":660.4,"y":330.2},{"x":661.6,"y":329.5},{"x":661.2,"y":327.4},{"x":662.7,"y":328.4},{"x":664.4,"y":327.8},{"x":665.7,"y":328.4},{"x":666.9,"y":329.2},{"x":668.3,"y":330.3},{"x":669.3,"y":328.1},{"x":671.3,"y":327},{"x":672.8,"y":326},{"x":673.6,"y":327.4},{"x":675.1,"y":327.3},{"x":677.1,"y":326.7},{"x":676.7,"y":324.6},{"x":677.8,"y":323.7},{"x":679.3,"y":322.6},{"x":678.5,"y":321.6},{"x":680.1,"y":322.5},{"x":680.3,"y":324},{"x":681.7,"y":324.7},{"x":683.6,"y":325.5},{"x":684.9,"y":324.5},{"x":685.4,"y":322.9},{"x":685.2,"y":321.5},{"x":685.9,"y":320.2},{"x":686.6,"y":318.9},{"x":688.3,"y":318.5},{"x":689,"y":315.8},{"x":690.5,"y":315.1},{"x":691.5,"y":313.6},{"x":690.7,"y":310.6},{"x":692,"y":310},{"x":693.4,"y":309.7},{"x":694.9,"y":310.4},{"x":697.3,"y":308.5},{"x":698.5,"y":308},{"x":699.8,"y":306.5},{"x":698.5,"y":305.5},{"x":697.9,"y":303.3},{"x":698.8,"y":302.1},{"x":700,"y":301.3},{"x":702,"y":302.3},{"x":703.3,"y":301.8},{"x":706,"y":302.7},{"x":706.7,"y":304},{"x":707.7,"y":305.2},{"x":708.1,"y":306.7},{"x":710.2,"y":307.1},{"x":711.9,"y":306.6},{"x":713.4,"y":307.1},{"x":714.5,"y":307.9},{"x":716.3,"y":309},{"x":718.2,"y":307.3},{"x":720.5,"y":307.9},{"x":721.5,"y":308.8},{"x":723.6,"y":308.2},{"x":724.9,"y":306.6},{"x":726,"y":305.8},{"x":727.4,"y":305.6},{"x":728.1,"y":308},{"x":729.9,"y":308.5},{"x":731.2,"y":309.6},{"x":732.1,"y":310.7},{"x":732.3,"y":312.2},{"x":732.8,"y":313.6},{"x":732.6,"y":315.4},{"x":733.7,"y":317.2},{"x":734.4,"y":318.4},{"x":735.2,"y":320.2},{"x":736.9,"y":321.8},{"x":738.4,"y":324.1},{"x":739.7,"y":324.7},{"x":741,"y":325.2},{"x":742.8,"y":326},{"x":738.6,"y":331.7},{"x":736.8,"y":332.6},{"x":735.8,"y":333.4},{"x":733.7,"y":335.3},{"x":733.9,"y":336.6},{"x":732.5,"y":337.5},{"x":732.2,"y":339},{"x":730.8,"y":340.5},{"x":729.3,"y":340.8},{"x":728.6,"y":342.2},{"x":726.1,"y":344},{"x":724.2,"y":345.1},{"x":721.5,"y":346.2},{"x":716.5,"y":347.5},{"x":712.4,"y":348},{"x":708.4,"y":348.4},{"x":704,"y":348.7},{"x":701.3,"y":348.8},{"x":697.4,"y":349.1},{"x":694.5,"y":349.7},{"x":689.4,"y":350.1},{"x":686.4,"y":350.2},{"x":682,"y":350.3},{"x":679.4,"y":350.5},{"x":670.5,"y":351.6},{"x":665.7,"y":352.1},{"x":659.7,"y":352.7},{"x":656.5,"y":352.2},{"x":657.2,"y":354.5},{"x":649.7,"y":356},{"x":643,"y":356.5},{"x":638.6,"y":356.8},{"x":636.8,"y":357},{"x":637.4,"y":354.7},{"x":639.1,"y":355.6},{"x":640,"y":354.1},{"x":639.8,"y":352.7},{"x":640.9,"y":351.5},{"x":640,"y":350.4}]],"x":636.8,"y":301.3,"w":106,"h":55.7,"cx":695.3,"cy":332.2},"MD":{"shapes":[[{"x":772.3,"y":279.7},{"x":787.5,"y":276.9},{"x":799.3,"y":274.7},{"x":806.8,"y":273.2},{"x":812.7,"y":271.9},{"x":823.5,"y":269.7},{"x":823.8,"y":271},{"x":829.5,"y":291.4},{"x":833.6,"y":291.8},{"x":838.9,"y":290.7},{"x":838.9,"y":293.1},{"x":838.5,"y":296.9},{"x":838,"y":299},{"x":832.7,"y":300.8},{"x":831.5,"y":301.4},{"x":829.6,"y":302.9},{"x":829,"y":300.8},{"x":829.3,"y":298.9},{"x":827.7,"y":299.6},{"x":827.4,"y":298.3},{"x":828.7,"y":297.5},{"x":827.5,"y":296.8},{"x":827.9,"y":294.8},{"x":827,"y":296.2},{"x":826.3,"y":295.1},{"x":825.5,"y":296.4},{"x":825.6,"y":297.9},{"x":824,"y":297.9},{"x":822.9,"y":296.8},{"x":820.7,"y":293.8},{"x":821.8,"y":292.7},{"x":821,"y":291.5},{"x":822.5,"y":290.8},{"x":823.8,"y":291.3},{"x":822.3,"y":290},{"x":820.8,"y":289.1},{"x":820.2,"y":290.4},{"x":819.6,"y":288.7},{"x":820.2,"y":287},{"x":820.9,"y":285.4},{"x":819.7,"y":286.2},{"x":818.7,"y":287.4},{"x":818.6,"y":285.7},{"x":819.1,"y":283.9},{"x":820.7,"y":284.6},{"x":820.7,"y":283.2},{"x":819.4,"y":281.8},{"x":819.3,"y":279.4},{"x":820.2,"y":277.7},{"x":822,"y":276.8},{"x":822,"y":275.2},{"x":821.7,"y":273.2},{"x":820,"y":273.9},{"x":820.8,"y":275.5},{"x":818.9,"y":277.7},{"x":818.6,"y":276.4},{"x":818,"y":277.6},{"x":817.5,"y":278.9},{"x":816.7,"y":280.7},{"x":814.4,"y":280.4},{"x":815.4,"y":281.8},{"x":816.9,"y":282.4},{"x":817.1,"y":283.8},{"x":816.9,"y":285.4},{"x":816.7,"y":287.6},{"x":816.5,"y":289.4},{"x":817.2,"y":291},{"x":817.9,"y":293.5},{"x":819.9,"y":295.5},{"x":820.2,"y":297.2},{"x":821,"y":299},{"x":822.2,"y":300.3},{"x":822.6,"y":302.2},{"x":821.4,"y":301.2},{"x":820.1,"y":300.4},{"x":818.1,"y":299.7},{"x":815.1,"y":299.9},{"x":814.3,"y":297.9},{"x":814.5,"y":299.3},{"x":813,"y":298.7},{"x":811.2,"y":296.7},{"x":808.9,"y":298.8},{"x":807.5,"y":296.7},{"x":807.8,"y":295.3},{"x":809.2,"y":293.6},{"x":809,"y":292.3},{"x":809.6,"y":290.4},{"x":811.1,"y":288.1},{"x":808.8,"y":286.7},{"x":808,"y":288},{"x":806.4,"y":287.6},{"x":804.4,"y":286.2},{"x":802.7,"y":286.3},{"x":801.6,"y":284.7},{"x":802.2,"y":283.5},{"x":800.9,"y":283.1},{"x":798.8,"y":282.3},{"x":797.7,"y":281.3},{"x":796.8,"y":280.1},{"x":795,"y":278.6},{"x":794,"y":277.6},{"x":792.6,"y":277.6},{"x":790.4,"y":276.9},{"x":789.2,"y":278.5},{"x":787.9,"y":279},{"x":787,"y":280.9},{"x":785.6,"y":281.1},{"x":783.3,"y":280.7},{"x":782.3,"y":279.8},{"x":780.9,"y":282.6},{"x":779,"y":283.3},{"x":778,"y":284.6},{"x":776.6,"y":285.9},{"x":775.7,"y":287.1},{"x":774.3,"y":289}]],"x":772.3,"y":269.7,"w":66.6,"h":33.2,"cx":812.7,"cy":285.2},"MI":{"shapes":[[{"x":665.6,"y":255.7},{"x":666.9,"y":254.4},{"x":668.1,"y":252.9},{"x":669.5,"y":248.6},{"x":670.9,"y":246.1},{"x":671.7,"y":243.8},{"x":672,"y":242.2},{"x":672.2,"y":239.3},{"x":672.2,"y":237},{"x":671.9,"y":234.4},{"x":671.3,"y":231.5},{"x":670.5,"y":229.7},{"x":668.5,"y":226.2},{"x":667.8,"y":224.7},{"x":667,"y":222.6},{"x":666,"y":220.8},{"x":666.8,"y":218.3},{"x":667,"y":216.2},{"x":666.3,"y":214.1},{"x":665.5,"y":212.7},{"x":666.5,"y":211.3},{"x":667.4,"y":208.8},{"x":668.3,"y":206.9},{"x":668.2,"y":204.9},{"x":668.4,"y":202.7},{"x":667.7,"y":201},{"x":668.9,"y":199.6},{"x":670,"y":197.8},{"x":670.2,"y":196},{"x":671.4,"y":194.9},{"x":673.1,"y":195.1},{"x":673.7,"y":193.1},{"x":674.7,"y":191.2},{"x":676,"y":189.9},{"x":675.4,"y":191.1},{"x":676,"y":193},{"x":675.1,"y":194.4},{"x":675.3,"y":196.7},{"x":675.8,"y":198.2},{"x":676.8,"y":195.8},{"x":676.8,"y":194.2},{"x":677.3,"y":196.4},{"x":676.5,"y":198.2},{"x":677.4,"y":197.3},{"x":678.5,"y":194.8},{"x":678.5,"y":192.7},{"x":678.5,"y":191.3},{"x":678.1,"y":190},{"x":678.1,"y":188.5},{"x":679.3,"y":187.5},{"x":680.9,"y":186.3},{"x":683.2,"y":186},{"x":682.1,"y":185},{"x":680.8,"y":182.5},{"x":681.4,"y":181.3},{"x":682.7,"y":179.8},{"x":681.7,"y":178.9},{"x":684.5,"y":178.9},{"x":687.8,"y":179.3},{"x":689.1,"y":180.1},{"x":690.8,"y":179.7},{"x":692.3,"y":180},{"x":693.6,"y":181.2},{"x":694.7,"y":182.4},{"x":696.2,"y":182.2},{"x":698.1,"y":183.3},{"x":700.9,"y":184.2},{"x":702.2,"y":183.9},{"x":703.4,"y":185},{"x":704.5,"y":187.3},{"x":706,"y":189.7},{"x":704.2,"y":189.1},{"x":704,"y":191.5},{"x":705.7,"y":192.4},{"x":706.3,"y":194.9},{"x":706.7,"y":196.6},{"x":706.7,"y":198.7},{"x":706.7,"y":200.5},{"x":706.9,"y":202.4},{"x":705.8,"y":203.8},{"x":704.4,"y":204.5},{"x":704.2,"y":206.2},{"x":704.3,"y":208.1},{"x":703,"y":208.6},{"x":701.2,"y":209.8},{"x":700.3,"y":211.7},{"x":700.4,"y":213.7},{"x":700.9,"y":215.8},{"x":702.4,"y":216.2},{"x":704.1,"y":216.9},{"x":705.6,"y":214.5},{"x":706.1,"y":213.2},{"x":706.7,"y":211},{"x":708,"y":210.7},{"x":708.7,"y":209.1},{"x":711.3,"y":208.1},{"x":713,"y":206.6},{"x":714.8,"y":207.3},{"x":716.6,"y":209.7},{"x":717.8,"y":211.7},{"x":718.5,"y":214.9},{"x":719.7,"y":217.6},{"x":720.4,"y":221.5},{"x":721.2,"y":223.7},{"x":722.3,"y":225.4},{"x":722.1,"y":226.9},{"x":722.1,"y":229.3},{"x":722.1,"y":231.9},{"x":721.3,"y":234.1},{"x":720.1,"y":234.9},{"x":719.5,"y":233.5},{"x":720.5,"y":232.1},{"x":719.1,"y":232},{"x":718,"y":233.2},{"x":717.5,"y":235.2},{"x":717.8,"y":236.5},{"x":716.9,"y":238.7},{"x":715.5,"y":239.3},{"x":714.8,"y":241},{"x":715.2,"y":243},{"x":714.5,"y":244.2},{"x":713.9,"y":246.1},{"x":712.8,"y":248},{"x":711.7,"y":249.5},{"x":711.7,"y":250.9},{"x":707.5,"y":251.6},{"x":699.4,"y":253},{"x":693.3,"y":253.9},{"x":688.9,"y":253.2},{"x":679.7,"y":254.3},{"x":670,"y":255.3}],[{"x":624.2,"y":145},{"x":625.1,"y":143.9},{"x":629.2,"y":141.3},{"x":631.3,"y":139.6},{"x":632.6,"y":138.9},{"x":634.1,"y":138.5},{"x":632.4,"y":140.6},{"x":631.3,"y":142},{"x":629.1,"y":143},{"x":627.3,"y":144.2},{"x":625.9,"y":145.8}],[{"x":611,"y":170.1},{"x":612.4,"y":169.4},{"x":614.2,"y":168.5},{"x":615.9,"y":167.8},{"x":617.2,"y":166.5},{"x":618,"y":165.4},{"x":620.2,"y":164.6},{"x":622.2,"y":164.3},{"x":625.5,"y":162.9},{"x":626.8,"y":161.3},{"x":629.1,"y":160.7},{"x":629.6,"y":159.3},{"x":630.7,"y":158.1},{"x":632.6,"y":156.4},{"x":634.5,"y":155},{"x":635.8,"y":153.2},{"x":638.3,"y":151.7},{"x":640.8,"y":151.1},{"x":643,"y":151},{"x":644.2,"y":152.2},{"x":643,"y":152.6},{"x":641.2,"y":152.7},{"x":640.1,"y":154.5},{"x":638.9,"y":156.1},{"x":637.9,"y":157.7},{"x":636.7,"y":158.9},{"x":636.1,"y":160.8},{"x":635.3,"y":163.5},{"x":635.3,"y":164.9},{"x":636.6,"y":163.4},{"x":638.3,"y":161.5},{"x":639.5,"y":160.7},{"x":638.5,"y":162},{"x":637.9,"y":163.3},{"x":639.2,"y":161.9},{"x":641,"y":161.6},{"x":642.7,"y":161.5},{"x":644.6,"y":162.2},{"x":646.7,"y":163.5},{"x":647.8,"y":165.1},{"x":648.9,"y":166.6},{"x":649.8,"y":168},{"x":651.5,"y":168.5},{"x":653.4,"y":168.2},{"x":654.5,"y":167.4},{"x":655.8,"y":168.6},{"x":657.3,"y":168.9},{"x":658.8,"y":168.7},{"x":658.4,"y":166.8},{"x":659.3,"y":167.8},{"x":661.2,"y":166.9},{"x":663,"y":165.7},{"x":665.5,"y":163.7},{"x":668.7,"y":163},{"x":670.9,"y":163.1},{"x":672.5,"y":162.9},{"x":673.8,"y":162.7},{"x":676.5,"y":161},{"x":678.9,"y":160.7},{"x":680.4,"y":160.3},{"x":679.5,"y":161.7},{"x":679.7,"y":163.9},{"x":680,"y":165.7},{"x":681.5,"y":165.8},{"x":683,"y":166},{"x":684.5,"y":165},{"x":685.6,"y":165.7},{"x":687.1,"y":165.7},{"x":688.2,"y":164.2},{"x":689.8,"y":164.1},{"x":691.3,"y":163.4},{"x":691.4,"y":165.5},{"x":691.9,"y":167.3},{"x":692.2,"y":168.8},{"x":690.8,"y":169},{"x":692.2,"y":169.8},{"x":693.6,"y":170.6},{"x":694.3,"y":172.3},{"x":695.9,"y":172.9},{"x":697.2,"y":172.2},{"x":696.2,"y":170.7},{"x":698.8,"y":170.4},{"x":700.2,"y":172},{"x":700.7,"y":173.4},{"x":698.7,"y":173.4},{"x":697.3,"y":173.8},{"x":695.8,"y":173.3},{"x":694.1,"y":173.7},{"x":692.8,"y":173.5},{"x":690.1,"y":174.3},{"x":687.7,"y":173.9},{"x":686.3,"y":173.4},{"x":685.5,"y":174.5},{"x":685,"y":175.8},{"x":685,"y":177.1},{"x":683.8,"y":176.6},{"x":682.6,"y":175.7},{"x":681.2,"y":174.3},{"x":679.3,"y":173.8},{"x":677.1,"y":173.4},{"x":675.7,"y":173.2},{"x":673.6,"y":174.8},{"x":672.9,"y":176.1},{"x":671,"y":176},{"x":669.6,"y":176.8},{"x":667.7,"y":176.7},{"x":666.1,"y":176.9},{"x":664.5,"y":178.1},{"x":664.3,"y":180.3},{"x":662.3,"y":181.3},{"x":661.6,"y":182.9},{"x":660.4,"y":183.6},{"x":660.4,"y":182},{"x":661.5,"y":180.8},{"x":662,"y":179.3},{"x":660.5,"y":179.8},{"x":658.7,"y":179.6},{"x":658.4,"y":181.2},{"x":656.9,"y":182.8},{"x":656.2,"y":180.7},{"x":655.3,"y":182.5},{"x":654.1,"y":183.7},{"x":653,"y":185.8},{"x":652.5,"y":188.2},{"x":651.7,"y":189.4},{"x":650.9,"y":191.2},{"x":649.2,"y":194.2},{"x":647.6,"y":193.4},{"x":648,"y":191},{"x":648.3,"y":189.7},{"x":647,"y":190.1},{"x":645.4,"y":189.7},{"x":646.1,"y":188.1},{"x":646.1,"y":186.7},{"x":645.6,"y":184.4},{"x":644.8,"y":182.8},{"x":643.2,"y":182.2},{"x":641.3,"y":181.9},{"x":641.6,"y":179.9},{"x":639.7,"y":179.3},{"x":637.9,"y":178.9},{"x":636.4,"y":179},{"x":635,"y":178.7},{"x":633.2,"y":178.6},{"x":628.6,"y":176.9},{"x":615.1,"y":174.1},{"x":613.6,"y":171.1}]],"x":611,"y":138.5,"w":111.3,"h":117.2,"cx":680,"cy":206.2},"MS":{"shapes":[[{"x":614.3,"y":424},{"x":613.7,"y":422},{"x":615.3,"y":421.4},{"x":615.3,"y":419.9},{"x":615.8,"y":418.6},{"x":614.5,"y":418.5},{"x":615.6,"y":415.9},{"x":613.9,"y":416.9},{"x":614.6,"y":415.2},{"x":612.9,"y":415.9},{"x":613.6,"y":414.6},{"x":614.3,"y":412.9},{"x":612.8,"y":411.6},{"x":614.2,"y":411.4},{"x":615.7,"y":411.4},{"x":614,"y":410.4},{"x":615.3,"y":409.4},{"x":615,"y":407.9},{"x":615.9,"y":406.5},{"x":614.6,"y":406.1},{"x":615.6,"y":405.2},{"x":617.4,"y":404.7},{"x":617.6,"y":403.3},{"x":616.5,"y":402.6},{"x":618,"y":402.5},{"x":616.7,"y":401.1},{"x":618.1,"y":401.2},{"x":619.2,"y":399.8},{"x":619.4,"y":398.1},{"x":620.8,"y":398.9},{"x":622.1,"y":396.9},{"x":621.7,"y":395.6},{"x":622.3,"y":394.3},{"x":621.5,"y":392.3},{"x":622.6,"y":393},{"x":623.2,"y":391.7},{"x":621.8,"y":391.1},{"x":622.5,"y":389.8},{"x":622.7,"y":391.3},{"x":623.1,"y":389.8},{"x":623,"y":388.2},{"x":625.5,"y":388.3},{"x":626.3,"y":386.8},{"x":637.8,"y":385.3},{"x":646.2,"y":384.6},{"x":657.1,"y":383.8},{"x":657.9,"y":385.1},{"x":658.6,"y":391.4},{"x":658.5,"y":401.8},{"x":658.3,"y":404.4},{"x":658,"y":422.5},{"x":658,"y":425.9},{"x":657.7,"y":437.4},{"x":657.6,"y":441.9},{"x":659.1,"y":454.2},{"x":660,"y":460.9},{"x":660.6,"y":466.6},{"x":661.1,"y":470.1},{"x":659.9,"y":471.1},{"x":658.2,"y":471.1},{"x":656.8,"y":470.6},{"x":654.4,"y":470.4},{"x":653.1,"y":470.3},{"x":650.1,"y":471},{"x":648.5,"y":471.8},{"x":646.8,"y":472.5},{"x":646.4,"y":471.1},{"x":646.3,"y":472.5},{"x":644.9,"y":473.5},{"x":644.5,"y":474.8},{"x":642.6,"y":475},{"x":641.5,"y":473.3},{"x":640.5,"y":471},{"x":639.8,"y":469.5},{"x":638.3,"y":468.1},{"x":637.9,"y":466.6},{"x":638,"y":465},{"x":638.4,"y":461.9},{"x":639.1,"y":460.5},{"x":629.3,"y":460.6},{"x":621.7,"y":461},{"x":608.8,"y":461.7},{"x":609.9,"y":460.4},{"x":608.8,"y":459.2},{"x":609.2,"y":457.8},{"x":610.5,"y":456.4},{"x":609.9,"y":455.2},{"x":609.8,"y":453.5},{"x":610.6,"y":454.8},{"x":610.3,"y":453},{"x":611.3,"y":451.5},{"x":610.1,"y":450.2},{"x":612,"y":449.9},{"x":612,"y":448.3},{"x":613.8,"y":447.5},{"x":612.4,"y":447.1},{"x":612.7,"y":445.6},{"x":614,"y":446.3},{"x":615.2,"y":444.2},{"x":616.4,"y":442.7},{"x":615.3,"y":441.6},{"x":616.6,"y":441.1},{"x":617.7,"y":439.6},{"x":615.2,"y":440.2},{"x":616.7,"y":438.5},{"x":618.1,"y":437.8},{"x":619.5,"y":435.8},{"x":617.6,"y":436},{"x":618,"y":434.7},{"x":615.7,"y":433.8},{"x":617.1,"y":433.5},{"x":616.1,"y":432.2},{"x":617.3,"y":431.1},{"x":615.5,"y":431.7},{"x":615.4,"y":430.1},{"x":616.3,"y":429.1},{"x":614.6,"y":428.7},{"x":614.8,"y":426.9},{"x":616,"y":426},{"x":615.5,"y":424.3},{"x":614.2,"y":425.9}]],"x":608.8,"y":383.8,"w":52.3,"h":91.2,"cx":637.9,"cy":427.6},"MT":{"shapes":[[{"x":294,"y":101.4},{"x":304.1,"y":103.5},{"x":314.2,"y":105.5},{"x":322.5,"y":107.1},{"x":330.7,"y":108.6},{"x":345.9,"y":111.3},{"x":355.2,"y":112.8},{"x":365.3,"y":114.4},{"x":379.7,"y":116.4},{"x":385.9,"y":117.3},{"x":398.7,"y":118.9},{"x":408.7,"y":120},{"x":415,"y":120.7},{"x":428,"y":122.1},{"x":433,"y":122.5},{"x":440.4,"y":123.2},{"x":439.4,"y":134.3},{"x":435.6,"y":179.3},{"x":435.4,"y":183},{"x":434.2,"y":196.8},{"x":428.6,"y":196.4},{"x":416.8,"y":195.2},{"x":410.6,"y":194.6},{"x":401.2,"y":193.7},{"x":394.5,"y":192.9},{"x":379,"y":190.9},{"x":368.7,"y":189.5},{"x":359.2,"y":188.2},{"x":355.1,"y":187.5},{"x":351.9,"y":187.1},{"x":347.4,"y":186.5},{"x":342.9,"y":185.7},{"x":342.4,"y":188.1},{"x":341.8,"y":192.6},{"x":341.4,"y":195.4},{"x":340.4,"y":194},{"x":339.4,"y":192.9},{"x":338.6,"y":190.2},{"x":336.4,"y":190.2},{"x":335.6,"y":192.1},{"x":334.2,"y":192.8},{"x":331.4,"y":193.1},{"x":329.9,"y":191.9},{"x":327.8,"y":192.2},{"x":326.3,"y":191.2},{"x":324.7,"y":191.4},{"x":323.9,"y":192.9},{"x":322.4,"y":192.4},{"x":320.5,"y":191.6},{"x":318.9,"y":191.4},{"x":318,"y":192.4},{"x":316.5,"y":192.2},{"x":315.7,"y":190.6},{"x":315.3,"y":188.6},{"x":315.8,"y":187.1},{"x":315.3,"y":185.2},{"x":313.9,"y":184.1},{"x":312.6,"y":184.5},{"x":311.4,"y":182.8},{"x":311.2,"y":181.2},{"x":312.1,"y":180.2},{"x":311.3,"y":178.5},{"x":310.6,"y":176.5},{"x":309.8,"y":175.1},{"x":309.3,"y":173.6},{"x":309.3,"y":172.2},{"x":309.6,"y":170.8},{"x":309.4,"y":168.5},{"x":308.2,"y":167.9},{"x":307.5,"y":166.2},{"x":306.2,"y":167.4},{"x":305.1,"y":168.5},{"x":303.6,"y":168.4},{"x":302,"y":169.8},{"x":300.9,"y":167.6},{"x":299.9,"y":166},{"x":301,"y":164.8},{"x":300.3,"y":163.5},{"x":301.4,"y":162.3},{"x":303,"y":161.8},{"x":303,"y":160.2},{"x":302.2,"y":158.7},{"x":302.2,"y":157.2},{"x":303.3,"y":156.5},{"x":303.3,"y":154.7},{"x":304.4,"y":152.7},{"x":305,"y":150.6},{"x":306.4,"y":148.9},{"x":304.9,"y":147.8},{"x":302.8,"y":147.6},{"x":302.8,"y":145.8},{"x":301.1,"y":146.2},{"x":300,"y":143.9},{"x":299.9,"y":141.7},{"x":299.2,"y":140.6},{"x":297.9,"y":138.1},{"x":296.9,"y":136.8},{"x":296.5,"y":135.4},{"x":295.2,"y":134.3},{"x":293.9,"y":133.3},{"x":292,"y":130.6},{"x":293.3,"y":129.8},{"x":292.6,"y":128.6},{"x":292.7,"y":126.6},{"x":292.5,"y":125.2},{"x":291.9,"y":123},{"x":290.1,"y":119.8},{"x":290.9,"y":115.4},{"x":291.3,"y":113.8}]],"x":290.1,"y":101.4,"w":150.3,"h":95.4,"cx":366.7,"cy":151},"NH":{"shapes":[[{"x":857.3,"y":159.9},{"x":857.7,"y":157.6},{"x":857.7,"y":156.1},{"x":858.7,"y":154},{"x":860.9,"y":154.4},{"x":865,"y":164.7},{"x":869.1,"y":177.9},{"x":869.5,"y":179.3},{"x":871,"y":184},{"x":871.5,"y":185.8},{"x":871.7,"y":187.5},{"x":874.8,"y":189.7},{"x":875,"y":191.5},{"x":877,"y":192.3},{"x":876.3,"y":195.4},{"x":873.7,"y":197.1},{"x":872.6,"y":198.1},{"x":872.3,"y":199.8},{"x":871.1,"y":200.9},{"x":865.1,"y":202.3},{"x":855.6,"y":204.3},{"x":853.8,"y":202.4},{"x":853.7,"y":200.3},{"x":854.5,"y":199.2},{"x":854.3,"y":197.8},{"x":853.5,"y":194.7},{"x":853.2,"y":192.7},{"x":853.2,"y":190.4},{"x":852.8,"y":188.8},{"x":853.2,"y":186.3},{"x":854.1,"y":184.6},{"x":853.9,"y":182.9},{"x":854.5,"y":181.6},{"x":854.2,"y":180.3},{"x":854.9,"y":178.3},{"x":853.9,"y":176.6},{"x":853.6,"y":175.2},{"x":855.3,"y":173.2},{"x":856.5,"y":171.9},{"x":858,"y":170.6},{"x":858.8,"y":169.3},{"x":858.5,"y":167},{"x":857,"y":165.1},{"x":857.4,"y":163.1},{"x":857.9,"y":161.7}]],"x":852.8,"y":154,"w":24.2,"h":50.3,"cx":862.6,"cy":184.2},"NY":{"shapes":[[{"x":760.2,"y":233.3},{"x":761.6,"y":232.2},{"x":763.9,"y":230},{"x":765,"y":228.3},{"x":766.3,"y":227.3},{"x":767.5,"y":226.7},{"x":768.3,"y":224.8},{"x":769.9,"y":222.7},{"x":770.3,"y":220.5},{"x":769.5,"y":219.3},{"x":767.9,"y":218.4},{"x":767.7,"y":216.9},{"x":767,"y":215.6},{"x":766.4,"y":213.6},{"x":767.5,"y":212.9},{"x":769.2,"y":211.9},{"x":771.7,"y":210.6},{"x":773.5,"y":210},{"x":775.1,"y":209.7},{"x":776.9,"y":209.5},{"x":778.6,"y":209},{"x":782.8,"y":208.9},{"x":784.8,"y":209.6},{"x":786,"y":210.1},{"x":788.4,"y":209},{"x":790,"y":208.6},{"x":792,"y":208},{"x":794.2,"y":207.9},{"x":796.1,"y":206.8},{"x":797.2,"y":205.9},{"x":797.9,"y":204.5},{"x":799.1,"y":203.2},{"x":800.3,"y":201.9},{"x":801.9,"y":201.7},{"x":802.9,"y":200.3},{"x":802.7,"y":198.9},{"x":801.7,"y":196.2},{"x":800.9,"y":194.9},{"x":802.6,"y":194.2},{"x":801.3,"y":193},{"x":799.6,"y":192.3},{"x":798.6,"y":191.2},{"x":799,"y":189.2},{"x":800.8,"y":188.1},{"x":801.4,"y":186.8},{"x":802.5,"y":185.7},{"x":804.5,"y":183.6},{"x":804.9,"y":182},{"x":806.4,"y":179.7},{"x":807.5,"y":177.8},{"x":809.6,"y":175},{"x":812.2,"y":172.4},{"x":813.2,"y":171.2},{"x":814.9,"y":170.2},{"x":816.3,"y":170.4},{"x":821.3,"y":169.2},{"x":823.7,"y":168.6},{"x":828.6,"y":167.3},{"x":833.9,"y":165.8},{"x":834.4,"y":167.5},{"x":834.2,"y":169.1},{"x":834.8,"y":170.8},{"x":835,"y":172.2},{"x":835.4,"y":173.8},{"x":836.6,"y":175},{"x":836.8,"y":177.4},{"x":837.6,"y":179.1},{"x":836.9,"y":180.9},{"x":837,"y":182.3},{"x":836.9,"y":183.6},{"x":837.8,"y":185.6},{"x":838.5,"y":187.5},{"x":838.9,"y":190},{"x":839,"y":191.8},{"x":840.5,"y":190.8},{"x":841.5,"y":191.9},{"x":842.8,"y":197.3},{"x":844.1,"y":203.9},{"x":844.3,"y":205.7},{"x":844.7,"y":212.8},{"x":844.6,"y":219.4},{"x":846.2,"y":226.7},{"x":847.1,"y":231.4},{"x":847.5,"y":233.9},{"x":848.8,"y":235.2},{"x":846,"y":238},{"x":847.3,"y":239.4},{"x":846.4,"y":241.6},{"x":845.9,"y":243},{"x":847.1,"y":242.2},{"x":849,"y":240.9},{"x":851.1,"y":240.3},{"x":852.6,"y":239.8},{"x":854.5,"y":239.3},{"x":855.8,"y":238.3},{"x":859.4,"y":237.4},{"x":861.2,"y":236.6},{"x":863,"y":234.8},{"x":863.9,"y":233.7},{"x":865.2,"y":232.2},{"x":865.6,"y":233.6},{"x":866.9,"y":234.2},{"x":868.4,"y":234.6},{"x":869.9,"y":233.1},{"x":871.3,"y":232.3},{"x":868.3,"y":235},{"x":865,"y":237.9},{"x":862.8,"y":239.5},{"x":859.3,"y":241.9},{"x":857,"y":243.8},{"x":855,"y":244.9},{"x":853.8,"y":245.4},{"x":850.5,"y":246.9},{"x":847.5,"y":247.5},{"x":845.5,"y":248.9},{"x":844.4,"y":248.1},{"x":843.4,"y":246.6},{"x":843.6,"y":245.1},{"x":844.2,"y":240.8},{"x":836.7,"y":238.1},{"x":831.8,"y":236.4},{"x":830.9,"y":235.2},{"x":828.8,"y":235.5},{"x":827.4,"y":235.1},{"x":825.7,"y":233},{"x":825.4,"y":230.3},{"x":824.2,"y":228.9},{"x":822.8,"y":228.6},{"x":821.4,"y":227.4},{"x":815.1,"y":227.8},{"x":807,"y":229.6},{"x":801.6,"y":230.6},{"x":796.6,"y":231.7},{"x":784.8,"y":234},{"x":776.8,"y":235.5},{"x":773,"y":236.2},{"x":761.1,"y":238.3}]],"x":760.2,"y":165.8,"w":111.1,"h":83.1,"cx":814.5,"cy":210.1},"OH":{"shapes":[[{"x":693.3,"y":253.9},{"x":699.4,"y":253},{"x":707.5,"y":251.6},{"x":711.7,"y":250.9},{"x":712.9,"y":251.6},{"x":715.5,"y":252.3},{"x":717.3,"y":252.7},{"x":718.4,"y":253.7},{"x":720.2,"y":253.5},{"x":722.2,"y":253.1},{"x":723.9,"y":255},{"x":725.9,"y":255.6},{"x":727.8,"y":254.4},{"x":729.6,"y":253.5},{"x":731.9,"y":252.2},{"x":733.9,"y":252.5},{"x":735.7,"y":252.1},{"x":737,"y":250.9},{"x":738.2,"y":249.3},{"x":739.2,"y":248.1},{"x":741.1,"y":246.1},{"x":744.6,"y":243.8},{"x":746,"y":243.3},{"x":747.1,"y":242.6},{"x":750.1,"y":241},{"x":754.9,"y":265.2},{"x":753.4,"y":265.9},{"x":753.8,"y":267.3},{"x":754.4,"y":268.6},{"x":754.8,"y":271.3},{"x":754.3,"y":272.8},{"x":753.8,"y":274.6},{"x":753.6,"y":276.1},{"x":753.9,"y":278},{"x":753.2,"y":279.2},{"x":753.1,"y":280.5},{"x":752.7,"y":282.3},{"x":753,"y":284.8},{"x":750.9,"y":286.8},{"x":750,"y":288.6},{"x":749,"y":289.8},{"x":747.3,"y":291},{"x":745.4,"y":290.1},{"x":744.3,"y":291.6},{"x":744.3,"y":292.9},{"x":742.8,"y":293},{"x":742,"y":294.9},{"x":742.3,"y":296.4},{"x":742.3,"y":297.9},{"x":742.3,"y":299.7},{"x":740.9,"y":300.9},{"x":739.8,"y":298.8},{"x":738.5,"y":298.3},{"x":737.8,"y":299.5},{"x":737.3,"y":301},{"x":736.5,"y":303},{"x":737.2,"y":304.6},{"x":737.6,"y":306.2},{"x":736,"y":307.3},{"x":736.1,"y":308.9},{"x":734.8,"y":310},{"x":733.1,"y":310.9},{"x":731.9,"y":310},{"x":729.9,"y":308.5},{"x":728.1,"y":308},{"x":727.4,"y":306.3},{"x":726,"y":305.8},{"x":724.9,"y":306.6},{"x":723.6,"y":308.2},{"x":722.1,"y":308.3},{"x":720.5,"y":307.9},{"x":719,"y":307.7},{"x":716.9,"y":307.8},{"x":714.8,"y":308.7},{"x":713.7,"y":307.6},{"x":711.9,"y":306.6},{"x":710.2,"y":307.1},{"x":708.1,"y":306.7},{"x":707.7,"y":305.2},{"x":706.7,"y":304},{"x":706,"y":302.7},{"x":704.5,"y":302.4},{"x":703.7,"y":301.2},{"x":702,"y":302.3},{"x":700,"y":301.3},{"x":698.8,"y":302.1},{"x":698.3,"y":298.3},{"x":697.9,"y":293.9},{"x":697.1,"y":286.8},{"x":696.4,"y":279.8},{"x":693.8,"y":257.8}]],"x":693.3,"y":241,"w":61.6,"h":69.9,"cx":724.4,"cy":276.5},"OR":{"shapes":[[{"x":189.9,"y":126.9},{"x":191.2,"y":127.9},{"x":191.5,"y":129.6},{"x":194.3,"y":129.5},{"x":196.9,"y":132.4},{"x":197.4,"y":134.9},{"x":197.3,"y":136.6},{"x":196.9,"y":139.1},{"x":196.5,"y":140.5},{"x":197.7,"y":141.7},{"x":199.6,"y":142.9},{"x":200.9,"y":143.3},{"x":202.1,"y":144.3},{"x":204.4,"y":144.1},{"x":207.1,"y":143.5},{"x":208.6,"y":142.9},{"x":210.9,"y":143.6},{"x":212.2,"y":143.6},{"x":213.7,"y":144.6},{"x":215.9,"y":145.6},{"x":216.6,"y":147},{"x":219.3,"y":146.8},{"x":222.7,"y":146.6},{"x":224.5,"y":146.6},{"x":226.2,"y":147.9},{"x":227.8,"y":147.9},{"x":229.4,"y":147.5},{"x":230.8,"y":147.4},{"x":232.3,"y":147},{"x":234.5,"y":147.1},{"x":236.2,"y":147.4},{"x":237.7,"y":146.5},{"x":241.7,"y":147.2},{"x":243.3,"y":147.7},{"x":244.8,"y":147.4},{"x":252.7,"y":148.7},{"x":264,"y":151.5},{"x":271.4,"y":153.2},{"x":271.8,"y":155},{"x":272.6,"y":156.9},{"x":273.8,"y":157.8},{"x":275.2,"y":158.9},{"x":275.4,"y":160.7},{"x":274.1,"y":163},{"x":273.3,"y":164.1},{"x":271.7,"y":166.2},{"x":271.1,"y":167.5},{"x":270.3,"y":169.2},{"x":269.1,"y":170.5},{"x":268,"y":171.8},{"x":267.5,"y":173.7},{"x":266.4,"y":174.7},{"x":264.7,"y":175.5},{"x":263.7,"y":176.8},{"x":263,"y":178.2},{"x":261.3,"y":179.7},{"x":260.7,"y":181.2},{"x":261.2,"y":182.5},{"x":261.1,"y":184},{"x":262.6,"y":184.9},{"x":264.2,"y":186.2},{"x":263.5,"y":187.5},{"x":263.2,"y":189},{"x":262.1,"y":190.8},{"x":261.1,"y":192.6},{"x":253.7,"y":225.5},{"x":245.7,"y":223.7},{"x":232.6,"y":220.7},{"x":224.5,"y":218.8},{"x":214.1,"y":216.1},{"x":209.7,"y":215},{"x":200.3,"y":212.5},{"x":194.9,"y":210.9},{"x":187.6,"y":208.8},{"x":185.5,"y":208.1},{"x":181,"y":206.8},{"x":179.3,"y":206.4},{"x":173.8,"y":204.8},{"x":172.5,"y":204.3},{"x":169.8,"y":203.7},{"x":166.2,"y":202.6},{"x":158.5,"y":200.3},{"x":157.7,"y":199.2},{"x":157.3,"y":197},{"x":157.3,"y":195},{"x":157.5,"y":193.5},{"x":158,"y":191.5},{"x":159.3,"y":189.5},{"x":159.5,"y":187.7},{"x":159.1,"y":186.2},{"x":158.7,"y":183.9},{"x":159.8,"y":182.8},{"x":160.8,"y":181.5},{"x":161.5,"y":180.3},{"x":162.5,"y":178.4},{"x":163.3,"y":176.9},{"x":164.2,"y":175.6},{"x":166.1,"y":173.3},{"x":167.7,"y":170.5},{"x":169.7,"y":166.4},{"x":171.1,"y":163.1},{"x":172.2,"y":160.2},{"x":173.5,"y":157.2},{"x":175,"y":153.4},{"x":175.4,"y":152},{"x":176.1,"y":150.1},{"x":177.7,"y":146.8},{"x":178.6,"y":145.1},{"x":179.5,"y":142.7},{"x":180.3,"y":140.1},{"x":180.8,"y":138.7},{"x":181.8,"y":136},{"x":181.9,"y":134.1},{"x":182.5,"y":132.9},{"x":182.8,"y":131.6},{"x":183.6,"y":130.4},{"x":184.1,"y":128.8},{"x":184.2,"y":125.6},{"x":185,"y":127.2},{"x":186.7,"y":127.1},{"x":188.1,"y":127.2}]],"x":157.3,"y":125.6,"w":118.1,"h":99.9,"cx":215.8,"cy":179.2},"TN":{"shapes":[[{"x":632.8,"y":366.7},{"x":633.5,"y":365},{"x":634.6,"y":364.3},{"x":632.9,"y":362.3},{"x":634.7,"y":362.1},{"x":634.2,"y":360.8},{"x":635.4,"y":360.1},{"x":635.1,"y":358.6},{"x":635,"y":357.2},{"x":636.4,"y":357.7},{"x":638.6,"y":356.8},{"x":643,"y":356.5},{"x":649.7,"y":356},{"x":656.9,"y":355.5},{"x":656.5,"y":352.2},{"x":659.7,"y":352.2},{"x":665.7,"y":352.1},{"x":670.5,"y":351.6},{"x":678.2,"y":350.7},{"x":682,"y":350.3},{"x":686.4,"y":350.2},{"x":689.4,"y":350.1},{"x":694.5,"y":349.7},{"x":697.4,"y":349.1},{"x":701.3,"y":348.8},{"x":704,"y":348.7},{"x":708.4,"y":348.4},{"x":712.4,"y":348},{"x":716.5,"y":347.5},{"x":720.9,"y":347.1},{"x":722.8,"y":346.5},{"x":726.9,"y":346},{"x":735.5,"y":344.9},{"x":738.7,"y":344.4},{"x":746.6,"y":343.3},{"x":750.7,"y":342.3},{"x":750,"y":343.8},{"x":750.5,"y":345.1},{"x":750,"y":346.4},{"x":750.7,"y":347.5},{"x":749.3,"y":347.3},{"x":747.8,"y":348.6},{"x":746.5,"y":352.1},{"x":745,"y":352.8},{"x":743.7,"y":351.9},{"x":741.8,"y":353},{"x":740.5,"y":355.3},{"x":739.1,"y":356.5},{"x":738.4,"y":355.1},{"x":736.2,"y":355.9},{"x":735.4,"y":357.6},{"x":734,"y":357.7},{"x":733.2,"y":360.7},{"x":731.9,"y":360.6},{"x":730.5,"y":361.9},{"x":728.8,"y":363.6},{"x":726.9,"y":364.7},{"x":722.2,"y":366.2},{"x":720.6,"y":367.3},{"x":719.6,"y":368.4},{"x":718.9,"y":369.5},{"x":719.1,"y":371.5},{"x":718.1,"y":372.7},{"x":716.6,"y":372.9},{"x":715.3,"y":373.5},{"x":715.3,"y":377.9},{"x":705.5,"y":379.1},{"x":698.2,"y":380},{"x":696.1,"y":380.2},{"x":692.8,"y":380.5},{"x":684.2,"y":381.3},{"x":682.2,"y":381.6},{"x":677.2,"y":382},{"x":668.6,"y":382.6},{"x":665.2,"y":382.9},{"x":657.1,"y":383.5},{"x":646.2,"y":384.6},{"x":637.8,"y":385.3},{"x":625.4,"y":386},{"x":626.9,"y":385.3},{"x":627.2,"y":383.7},{"x":628.9,"y":383.1},{"x":628.6,"y":381.5},{"x":627.2,"y":380.3},{"x":628.4,"y":378.5},{"x":626.9,"y":378.7},{"x":628.2,"y":376.8},{"x":628.7,"y":378.2},{"x":629.2,"y":376.9},{"x":628.9,"y":375.3},{"x":630.6,"y":376},{"x":630.1,"y":374.3},{"x":631.5,"y":373.6},{"x":630.1,"y":373.1},{"x":630.5,"y":371.4},{"x":631.9,"y":371.3},{"x":632.9,"y":370.3},{"x":632.8,"y":368.4},{"x":634.1,"y":368.7}]],"x":625.4,"y":342.3,"w":125.3,"h":43.7,"cx":683.3,"cy":365.1},"UT":{"shapes":[[{"x":293.7,"y":234},{"x":296.6,"y":234.7},{"x":309.4,"y":236.8},{"x":318.7,"y":238.4},{"x":328.4,"y":240.1},{"x":334.2,"y":241},{"x":332.9,"y":249},{"x":332.3,"y":252.5},{"x":331.2,"y":259.5},{"x":335.8,"y":260.3},{"x":342.3,"y":261.3},{"x":344.9,"y":261.6},{"x":352,"y":262.6},{"x":358.7,"y":263.6},{"x":357.5,"y":272.1},{"x":353.3,"y":302.5},{"x":352.7,"y":305.9},{"x":351.5,"y":314.1},{"x":351.5,"y":316.2},{"x":349.9,"y":328},{"x":348.5,"y":337.9},{"x":340,"y":336.7},{"x":327.8,"y":334.9},{"x":319.1,"y":333.5},{"x":314.1,"y":332.7},{"x":297.8,"y":329.9},{"x":286.3,"y":327.8},{"x":275.9,"y":325.9},{"x":278.6,"y":312},{"x":279.4,"y":307.5},{"x":280,"y":304.8},{"x":280.9,"y":300},{"x":281.9,"y":295},{"x":286.9,"y":268.7},{"x":287.4,"y":266.4},{"x":289.4,"y":256.5},{"x":290.2,"y":252.3}]],"x":275.9,"y":234,"w":82.8,"h":103.9,"cx":317.4,"cy":289.4},"VA":{"shapes":[[{"x":832.2,"y":301.8},{"x":838,"y":299},{"x":837.4,"y":300.4},{"x":837,"y":302.2},{"x":835.6,"y":302.7},{"x":834.9,"y":304.1},{"x":834.4,"y":307.5},{"x":834,"y":310.7},{"x":833.8,"y":312.5},{"x":833.4,"y":313.9},{"x":833,"y":316.5},{"x":832.3,"y":317.7},{"x":831,"y":317.2},{"x":829.9,"y":315.6},{"x":830,"y":313.4},{"x":829.8,"y":312},{"x":830,"y":310.2},{"x":830.5,"y":307.6},{"x":831,"y":305.6},{"x":832.3,"y":303.4}],[{"x":743.5,"y":325.8},{"x":743.4,"y":327.4},{"x":744.6,"y":329.1},{"x":745.9,"y":330.2},{"x":747.5,"y":330.4},{"x":748.6,"y":331.4},{"x":750.4,"y":331.1},{"x":752.2,"y":329.5},{"x":752.8,"y":328.2},{"x":755.1,"y":329.8},{"x":756.6,"y":328.7},{"x":758.4,"y":328},{"x":760.2,"y":326.9},{"x":759.8,"y":325.4},{"x":761.3,"y":326.2},{"x":763.2,"y":324.7},{"x":764.7,"y":323.6},{"x":767.6,"y":322.6},{"x":767.9,"y":320.9},{"x":767.1,"y":319.2},{"x":767.4,"y":317.9},{"x":768.2,"y":315.9},{"x":769.5,"y":314},{"x":770.7,"y":312.2},{"x":771.1,"y":310.6},{"x":770.9,"y":309.3},{"x":772,"y":307.7},{"x":773,"y":305.1},{"x":773.1,"y":303},{"x":773.5,"y":301},{"x":775.2,"y":301.5},{"x":776.4,"y":303},{"x":778.9,"y":303.5},{"x":780,"y":301.7},{"x":780.4,"y":299.4},{"x":781,"y":297.2},{"x":781.6,"y":295.7},{"x":784,"y":295.8},{"x":784.6,"y":293.6},{"x":785.6,"y":292.3},{"x":786.7,"y":291.2},{"x":788.2,"y":288.5},{"x":789.2,"y":287.2},{"x":788.9,"y":285.8},{"x":789.4,"y":283.7},{"x":788.9,"y":281.5},{"x":792.8,"y":283.7},{"x":797.3,"y":286.3},{"x":797.8,"y":283.3},{"x":798.8,"y":282.3},{"x":800.4,"y":282.4},{"x":802.2,"y":283.5},{"x":801.6,"y":284.7},{"x":802.7,"y":286.3},{"x":804.4,"y":286.2},{"x":805.9,"y":286.6},{"x":807.4,"y":287.5},{"x":809.3,"y":288.9},{"x":809.6,"y":290.4},{"x":809.9,"y":291.7},{"x":808.8,"y":292.8},{"x":808,"y":294},{"x":806.9,"y":296.6},{"x":807.2,"y":298.7},{"x":809.6,"y":298.9},{"x":811,"y":297.6},{"x":811.5,"y":299.2},{"x":812.7,"y":300},{"x":814.8,"y":301.3},{"x":816.6,"y":301.5},{"x":818,"y":301},{"x":819.3,"y":302.1},{"x":820.6,"y":303},{"x":822.7,"y":303.9},{"x":824.4,"y":304.6},{"x":823.7,"y":306.2},{"x":824,"y":307.9},{"x":824.6,"y":309.4},{"x":821.9,"y":309.4},{"x":819.9,"y":307.9},{"x":818.3,"y":307.1},{"x":816.3,"y":305.6},{"x":814.6,"y":304.5},{"x":816.3,"y":306.2},{"x":817.7,"y":307.7},{"x":819.5,"y":308.4},{"x":820.3,"y":309.8},{"x":822.6,"y":310.3},{"x":824.8,"y":310.8},{"x":824.2,"y":312},{"x":825.6,"y":312.2},{"x":826.2,"y":313.8},{"x":826.1,"y":315.4},{"x":825,"y":314.6},{"x":823.7,"y":314.1},{"x":824.1,"y":315.3},{"x":825.2,"y":316.2},{"x":823.2,"y":317.1},{"x":824.7,"y":317.3},{"x":825.9,"y":318.6},{"x":827,"y":319.5},{"x":826.9,"y":321.1},{"x":825.2,"y":322.1},{"x":822.8,"y":320.4},{"x":821.9,"y":319.1},{"x":821,"y":318.1},{"x":819.6,"y":319},{"x":818,"y":318.4},{"x":816.7,"y":318.8},{"x":819,"y":319},{"x":820.4,"y":319.6},{"x":821.7,"y":321.5},{"x":824.4,"y":322.6},{"x":826.1,"y":323.2},{"x":826.7,"y":322},{"x":828.3,"y":322},{"x":830.2,"y":322.2},{"x":831.6,"y":321.6},{"x":832.5,"y":323.5},{"x":833.6,"y":325.6},{"x":835,"y":328},{"x":827.6,"y":329.6},{"x":821.4,"y":330.9},{"x":819.7,"y":331.2},{"x":814.3,"y":332.4},{"x":800.5,"y":335.1},{"x":796.7,"y":335.9},{"x":782.1,"y":338.5},{"x":773.2,"y":340},{"x":770.7,"y":340.4},{"x":764.6,"y":341.1},{"x":762.7,"y":341.4},{"x":757.7,"y":342},{"x":754.8,"y":342.4},{"x":750.4,"y":342.8},{"x":746.7,"y":342.8},{"x":738.7,"y":344.4},{"x":735.5,"y":344.9},{"x":727.2,"y":346},{"x":722.8,"y":346.5},{"x":721.1,"y":346.7},{"x":723.1,"y":345.2},{"x":726.1,"y":344},{"x":727.8,"y":343.2},{"x":729.3,"y":340.8},{"x":730.8,"y":340.5},{"x":732,"y":339.8},{"x":731.9,"y":338.1},{"x":733.1,"y":337.4},{"x":733.7,"y":335.3},{"x":734.9,"y":334.4},{"x":736.8,"y":332.6},{"x":738.6,"y":331.7}]],"x":721.1,"y":281.5,"w":116.9,"h":65.2,"cx":788.9,"cy":318.6},"WA":{"shapes":[[{"x":209.6,"y":94.8},{"x":210.6,"y":93.6},{"x":211.7,"y":92.1},{"x":212.5,"y":93.2},{"x":213.2,"y":94.5},{"x":211.8,"y":94.1},{"x":210.2,"y":94.8},{"x":211.6,"y":96.1},{"x":211.6,"y":97.5},{"x":211.3,"y":99.3},{"x":211.9,"y":97.9},{"x":212.7,"y":99.2},{"x":213.3,"y":101.1},{"x":212,"y":100},{"x":210.5,"y":98.8},{"x":211.1,"y":97.4},{"x":210.3,"y":96.4}],[{"x":206.3,"y":86.8},{"x":208.1,"y":87.8},{"x":210.3,"y":85.7},{"x":212.2,"y":87.2},{"x":211.3,"y":88.9},{"x":210.4,"y":90},{"x":209.3,"y":91},{"x":207.6,"y":89.7},{"x":206.5,"y":88.4}],[{"x":282.1,"y":98.8},{"x":281.1,"y":103.2},{"x":279.6,"y":110},{"x":278.5,"y":114.4},{"x":276,"y":125.3},{"x":271.6,"y":145.4},{"x":271.7,"y":147.5},{"x":271.7,"y":149.4},{"x":271,"y":151.4},{"x":271.4,"y":153.2},{"x":264,"y":151.5},{"x":252.7,"y":148.7},{"x":245.4,"y":147},{"x":243.3,"y":147.7},{"x":241.7,"y":147.2},{"x":238.7,"y":147.1},{"x":237,"y":146.7},{"x":234.5,"y":147.1},{"x":232.3,"y":147},{"x":230.8,"y":147.4},{"x":229.4,"y":147.5},{"x":227.8,"y":147.9},{"x":226.2,"y":147.9},{"x":224.5,"y":146.6},{"x":222.7,"y":146.6},{"x":220.4,"y":146.8},{"x":217.7,"y":146.5},{"x":216,"y":146.9},{"x":214.5,"y":144.6},{"x":212.9,"y":144.3},{"x":210.9,"y":143.6},{"x":209.5,"y":143.4},{"x":207.9,"y":143},{"x":204.4,"y":144.1},{"x":202.1,"y":144.3},{"x":200.9,"y":143.3},{"x":199.6,"y":142.9},{"x":197.7,"y":141.7},{"x":196.5,"y":140.5},{"x":196.9,"y":139.1},{"x":196.9,"y":137.6},{"x":197.2,"y":135.7},{"x":197,"y":133.4},{"x":194.9,"y":129.8},{"x":192.6,"y":129.9},{"x":190.9,"y":128.7},{"x":190.9,"y":127},{"x":188.4,"y":126.3},{"x":186.8,"y":125.5},{"x":185.4,"y":125.8},{"x":184.8,"y":124.4},{"x":183.4,"y":124.8},{"x":184.3,"y":122.7},{"x":184.9,"y":120.9},{"x":185.5,"y":118.3},{"x":185.2,"y":120.9},{"x":184.8,"y":123},{"x":185.8,"y":121},{"x":187.1,"y":120.7},{"x":186.8,"y":118.7},{"x":188.8,"y":117.7},{"x":187.1,"y":117},{"x":185.8,"y":116.2},{"x":186.1,"y":113.2},{"x":189.7,"y":113.5},{"x":188,"y":112.2},{"x":187,"y":110.9},{"x":186.5,"y":112.6},{"x":186.8,"y":109},{"x":187,"y":106.1},{"x":186.3,"y":104.6},{"x":186.9,"y":101.4},{"x":187.2,"y":97.5},{"x":186.8,"y":95.9},{"x":185.6,"y":94.1},{"x":185.6,"y":92.3},{"x":185.7,"y":90.6},{"x":185.8,"y":88.9},{"x":187.6,"y":86.2},{"x":189.4,"y":86.5},{"x":190.5,"y":87.9},{"x":191.8,"y":89},{"x":193.6,"y":90.2},{"x":194.8,"y":91.6},{"x":197.1,"y":92.5},{"x":199.3,"y":93.5},{"x":201.2,"y":94},{"x":203.3,"y":95.1},{"x":205,"y":94.4},{"x":205.5,"y":95.7},{"x":207.1,"y":96.7},{"x":207.2,"y":98.5},{"x":207.5,"y":97.1},{"x":209.3,"y":96.3},{"x":208.7,"y":98},{"x":209.8,"y":97.2},{"x":209.7,"y":98.9},{"x":209.3,"y":100.9},{"x":208.6,"y":102.1},{"x":206.8,"y":104},{"x":207.1,"y":102.4},{"x":205.7,"y":103.4},{"x":204,"y":104.9},{"x":201.6,"y":107.2},{"x":200.5,"y":108.9},{"x":202,"y":109.4},{"x":203.6,"y":109.1},{"x":201.7,"y":109},{"x":203.9,"y":105.4},{"x":205.6,"y":104.7},{"x":207,"y":104.7},{"x":208.5,"y":102.7},{"x":210.1,"y":102},{"x":210.1,"y":100.4},{"x":210.7,"y":104.3},{"x":209.7,"y":105.9},{"x":208.9,"y":107.4},{"x":208.6,"y":109.1},{"x":208,"y":110.3},{"x":207.5,"y":112.3},{"x":206.5,"y":113.3},{"x":205.6,"y":111.7},{"x":206.4,"y":110.4},{"x":205,"y":111.7},{"x":205.9,"y":113.3},{"x":204.7,"y":114.5},{"x":203.8,"y":111.7},{"x":204.8,"y":110.4},{"x":203.6,"y":111.4},{"x":203.1,"y":113.2},{"x":203.9,"y":114.3},{"x":205.6,"y":114.6},{"x":207.1,"y":112.9},{"x":207.8,"y":111.7},{"x":208.7,"y":112.9},{"x":210.5,"y":111.9},{"x":210.6,"y":110.2},{"x":210.5,"y":108.7},{"x":211.6,"y":107.2},{"x":210.8,"y":106},{"x":211.9,"y":105},{"x":212,"y":103.5},{"x":213.8,"y":101.3},{"x":215.1,"y":100.1},{"x":214,"y":98},{"x":214.1,"y":96},{"x":213,"y":97.6},{"x":213.5,"y":99.2},{"x":212.7,"y":97.5},{"x":212.6,"y":95.2},{"x":214.1,"y":95.6},{"x":214.5,"y":94.3},{"x":213.4,"y":93.3},{"x":213.3,"y":91.8},{"x":211.9,"y":91.9},{"x":211.8,"y":90.2},{"x":213.4,"y":90.5},{"x":214.5,"y":91.5},{"x":214.5,"y":89.7},{"x":215,"y":88.1},{"x":215.6,"y":86.5},{"x":214.4,"y":85.8},{"x":214,"y":87},{"x":213.9,"y":85.4},{"x":213.4,"y":84},{"x":213.3,"y":82.2},{"x":221.5,"y":83.4},{"x":225.6,"y":84.6},{"x":231.9,"y":86.3},{"x":238,"y":87.9},{"x":246.1,"y":90.1},{"x":253.4,"y":91.9},{"x":260.5,"y":93.7},{"x":268.1,"y":95.5}]],"x":183.4,"y":82.2,"w":98.7,"h":71,"cx":233.5,"cy":117.6},"WI":{"shapes":[[{"x":590.5,"y":168.6},{"x":593,"y":168.8},{"x":595.2,"y":167.8},{"x":596.9,"y":167.3},{"x":599,"y":166.1},{"x":600.4,"y":165.2},{"x":602.6,"y":164.8},{"x":603.6,"y":163.6},{"x":604.8,"y":163.2},{"x":606.5,"y":164.4},{"x":605.9,"y":165.7},{"x":604.8,"y":167},{"x":604.6,"y":168.7},{"x":604.2,"y":169.9},{"x":606.7,"y":168.9},{"x":608.9,"y":169.6},{"x":611,"y":170.1},{"x":612.4,"y":171},{"x":615.1,"y":173.7},{"x":628.6,"y":176.9},{"x":632.7,"y":178.9},{"x":634,"y":178.8},{"x":636.3,"y":178.6},{"x":637.9,"y":178.9},{"x":639.1,"y":179.6},{"x":641.6,"y":179.9},{"x":641.3,"y":181.9},{"x":643.2,"y":182.2},{"x":644.8,"y":182.8},{"x":646.1,"y":184.2},{"x":646.4,"y":185.6},{"x":646.3,"y":187.4},{"x":645.5,"y":188.7},{"x":645.8,"y":190.4},{"x":647.7,"y":189.3},{"x":648,"y":191},{"x":647.4,"y":193},{"x":648.6,"y":194.5},{"x":649.2,"y":196.9},{"x":647.5,"y":197.3},{"x":646.8,"y":198.7},{"x":645.9,"y":200},{"x":645.5,"y":201.3},{"x":644.8,"y":203.7},{"x":645.5,"y":205.6},{"x":646.3,"y":204.5},{"x":647.4,"y":203.4},{"x":648.5,"y":202.3},{"x":649.7,"y":199.4},{"x":650.9,"y":198.8},{"x":652.7,"y":198.7},{"x":652.7,"y":196.4},{"x":653.8,"y":194.5},{"x":654,"y":192.9},{"x":655.5,"y":192.3},{"x":656.2,"y":190.4},{"x":657.3,"y":191.7},{"x":656.6,"y":194.1},{"x":655.6,"y":195.6},{"x":655.3,"y":197.2},{"x":654.2,"y":198.9},{"x":653.4,"y":201.3},{"x":652.8,"y":203.1},{"x":652.1,"y":204.6},{"x":651.4,"y":209},{"x":652,"y":210.4},{"x":651.5,"y":212.3},{"x":650.5,"y":213.1},{"x":650.1,"y":214.7},{"x":649.6,"y":217.4},{"x":649.9,"y":218.7},{"x":650.4,"y":221.1},{"x":649.5,"y":223},{"x":649.4,"y":225.2},{"x":648.6,"y":227},{"x":648.3,"y":229.6},{"x":648.6,"y":231.4},{"x":649.1,"y":232.7},{"x":649.6,"y":234.6},{"x":649.8,"y":235.9},{"x":651,"y":237.8},{"x":650.9,"y":239.2},{"x":650.5,"y":241},{"x":651,"y":243.3},{"x":647,"y":243.5},{"x":639.6,"y":244.1},{"x":637.6,"y":244.4},{"x":628.2,"y":244.9},{"x":625.7,"y":245},{"x":614.6,"y":245.6},{"x":612.4,"y":245.7},{"x":611.4,"y":243.4},{"x":608.2,"y":242.7},{"x":606.6,"y":241.7},{"x":605.8,"y":239.1},{"x":605.2,"y":237.6},{"x":604.7,"y":236.2},{"x":604.6,"y":234.5},{"x":605.2,"y":233.2},{"x":605.3,"y":231},{"x":604,"y":230.4},{"x":603.5,"y":228.5},{"x":603.3,"y":226.8},{"x":602.9,"y":225.5},{"x":603,"y":222.6},{"x":601,"y":219.3},{"x":598.4,"y":218.1},{"x":596.6,"y":216.7},{"x":595.1,"y":215.6},{"x":594,"y":213.6},{"x":592.8,"y":211.9},{"x":589.4,"y":210.6},{"x":588.2,"y":208.8},{"x":585.2,"y":208.5},{"x":584.1,"y":207.6},{"x":582.6,"y":205.9},{"x":581.6,"y":204.9},{"x":582.1,"y":203.6},{"x":582.2,"y":201.7},{"x":582,"y":200.1},{"x":582.2,"y":198.6},{"x":581.8,"y":197.1},{"x":581.9,"y":195.2},{"x":582.6,"y":193.9},{"x":583.3,"y":192.3},{"x":582.1,"y":191},{"x":581,"y":190.2},{"x":580,"y":189},{"x":580.2,"y":187.2},{"x":582.1,"y":184},{"x":584.1,"y":182.8},{"x":585.6,"y":181.5},{"x":586.9,"y":180.6},{"x":587,"y":169.5},{"x":588.5,"y":169}]],"x":580,"y":163.2,"w":77.3,"h":82.5,"cx":618.7,"cy":205.8},"NE":{"shapes":[[{"x":430.9,"y":234},{"x":445.1,"y":235.1},{"x":452,"y":235.6},{"x":460.6,"y":236.2},{"x":463.6,"y":236.4},{"x":473.6,"y":236.9},{"x":483.9,"y":237.4},{"x":491.3,"y":237.7},{"x":500.4,"y":238},{"x":505.8,"y":238.2},{"x":509,"y":240.6},{"x":510.7,"y":241.6},{"x":512.2,"y":242.7},{"x":513.7,"y":242.2},{"x":514.6,"y":240.8},{"x":516.7,"y":241.3},{"x":518.4,"y":241.3},{"x":520,"y":241.3},{"x":521.8,"y":240.9},{"x":523.1,"y":242},{"x":524.2,"y":242.8},{"x":526.3,"y":243},{"x":528.6,"y":244.1},{"x":530.2,"y":245},{"x":530.9,"y":246.9},{"x":532.4,"y":247.7},{"x":534.2,"y":248.2},{"x":533.9,"y":249.6},{"x":534.4,"y":251.3},{"x":535.1,"y":253},{"x":535.8,"y":255.1},{"x":535.8,"y":256.4},{"x":537,"y":257.2},{"x":537.6,"y":258.9},{"x":538.1,"y":260.6},{"x":538.1,"y":262.1},{"x":538.2,"y":263.9},{"x":538.3,"y":266},{"x":539.5,"y":267.1},{"x":540.5,"y":269.2},{"x":540.5,"y":270.7},{"x":540.6,"y":272.3},{"x":541.4,"y":274.5},{"x":541.5,"y":276.1},{"x":541.8,"y":277.5},{"x":541.9,"y":280.1},{"x":541.1,"y":281.2},{"x":542.5,"y":282.4},{"x":542.8,"y":283.8},{"x":543.8,"y":284.8},{"x":544.4,"y":286.5},{"x":544.9,"y":288.8},{"x":546.8,"y":290.1},{"x":548.1,"y":292.5},{"x":547.7,"y":293.8},{"x":549.3,"y":294.7},{"x":542.6,"y":294.7},{"x":535.3,"y":294.7},{"x":522,"y":294.6},{"x":507.9,"y":294.3},{"x":499.6,"y":294.1},{"x":485.8,"y":293.6},{"x":472.5,"y":293},{"x":467.2,"y":292.8},{"x":454.3,"y":292},{"x":455.5,"y":273.3},{"x":448.5,"y":272.8},{"x":441.8,"y":272.3},{"x":427.7,"y":271.2}]],"x":427.7,"y":234,"w":121.6,"h":60.7,"cx":487.2,"cy":264.9},"SC":{"shapes":[[{"x":733.5,"y":375.3},{"x":738.1,"y":373.1},{"x":739.9,"y":372.2},{"x":741.4,"y":371.2},{"x":742.7,"y":370.7},{"x":745.1,"y":369.9},{"x":755.3,"y":368.9},{"x":760.9,"y":368.3},{"x":763.9,"y":368},{"x":763.9,"y":369.7},{"x":765.6,"y":368.5},{"x":768.4,"y":371.3},{"x":768.5,"y":373.5},{"x":778,"y":372.1},{"x":782,"y":371.5},{"x":785.3,"y":371},{"x":790.8,"y":375},{"x":792.8,"y":376.5},{"x":799.5,"y":381.2},{"x":805.4,"y":385.5},{"x":803,"y":386.9},{"x":801.7,"y":388.3},{"x":800.1,"y":390.5},{"x":799.4,"y":391.9},{"x":798.4,"y":393.8},{"x":797.9,"y":395.4},{"x":797.7,"y":398.3},{"x":797.8,"y":399.9},{"x":796,"y":401.7},{"x":795.8,"y":403.3},{"x":794,"y":403.7},{"x":792.5,"y":403.9},{"x":792.3,"y":405.5},{"x":791.2,"y":407.1},{"x":789.2,"y":409.3},{"x":788.8,"y":410.6},{"x":787.6,"y":411.7},{"x":785.5,"y":413},{"x":784.7,"y":414.1},{"x":782.6,"y":415.6},{"x":781.1,"y":415.5},{"x":781.4,"y":417.5},{"x":779.6,"y":420},{"x":777.2,"y":419.4},{"x":778.2,"y":421.3},{"x":777.6,"y":422.4},{"x":776.3,"y":423.6},{"x":775.1,"y":424.9},{"x":773.5,"y":424.3},{"x":771.7,"y":424.3},{"x":771.4,"y":422.9},{"x":771.1,"y":421.1},{"x":769.2,"y":418.6},{"x":767.9,"y":416.9},{"x":766.4,"y":416.3},{"x":765.8,"y":415},{"x":765.3,"y":413.4},{"x":764.8,"y":411.6},{"x":763.2,"y":409.8},{"x":762.1,"y":408.1},{"x":760.6,"y":407.4},{"x":759,"y":406.8},{"x":758.5,"y":405.5},{"x":757.1,"y":405.1},{"x":755.5,"y":403.5},{"x":755.6,"y":401.6},{"x":754.5,"y":401},{"x":753.3,"y":399.7},{"x":751.6,"y":399.3},{"x":750.6,"y":398.2},{"x":749.7,"y":396.6},{"x":747.9,"y":395.3},{"x":746.2,"y":394.7},{"x":745,"y":393.7},{"x":743.7,"y":392.2},{"x":742.2,"y":390.6},{"x":741,"y":389.3},{"x":740.2,"y":387.7},{"x":739.2,"y":386.5},{"x":738.3,"y":384.6},{"x":736.4,"y":384.9},{"x":735,"y":384.3},{"x":733.5,"y":382.8},{"x":730.8,"y":381.7},{"x":730.9,"y":380.2},{"x":731.9,"y":377.8}]],"x":730.8,"y":368,"w":74.6,"h":56.9,"cx":769.8,"cy":390.6},"ID":{"shapes":[[{"x":271.4,"y":153.2},{"x":271.2,"y":151.6},{"x":272.1,"y":150.1},{"x":271.9,"y":148.4},{"x":271.1,"y":146.1},{"x":275.9,"y":126.1},{"x":278.5,"y":114.4},{"x":279.6,"y":110},{"x":281.1,"y":103.2},{"x":282.1,"y":98.8},{"x":289.5,"y":100.4},{"x":294,"y":101.4},{"x":291.3,"y":113.8},{"x":290.9,"y":115.4},{"x":290.1,"y":119.8},{"x":291.3,"y":122.5},{"x":291.9,"y":124.4},{"x":293,"y":125.7},{"x":293,"y":127.6},{"x":292.6,"y":129.6},{"x":291.5,"y":130.5},{"x":293.8,"y":132.4},{"x":295.2,"y":134.3},{"x":296.5,"y":135.4},{"x":296.9,"y":136.8},{"x":297.9,"y":138.1},{"x":298.5,"y":139.5},{"x":299.9,"y":141.7},{"x":300,"y":143.9},{"x":301.4,"y":145.1},{"x":302.8,"y":145.8},{"x":302.8,"y":147.6},{"x":304.7,"y":148.1},{"x":306.1,"y":147.7},{"x":305.6,"y":150.7},{"x":304.4,"y":152.7},{"x":304,"y":154.5},{"x":303.3,"y":156.5},{"x":302.2,"y":157.2},{"x":302.2,"y":158.7},{"x":303,"y":160.2},{"x":303,"y":161.8},{"x":301.4,"y":162.3},{"x":300.3,"y":163.5},{"x":301,"y":164.8},{"x":299.9,"y":166},{"x":299.8,"y":167.4},{"x":301.3,"y":168.7},{"x":303.2,"y":169.3},{"x":305.1,"y":168.5},{"x":306.2,"y":167.4},{"x":307,"y":166.3},{"x":308.4,"y":167.5},{"x":309.4,"y":168.5},{"x":308.8,"y":169.9},{"x":309.2,"y":171.2},{"x":309.6,"y":172.5},{"x":309.8,"y":174.6},{"x":310.6,"y":176.5},{"x":311.5,"y":178.1},{"x":312.1,"y":179.3},{"x":311.8,"y":181.1},{"x":311.4,"y":182.8},{"x":312.5,"y":183.9},{"x":313.9,"y":184.1},{"x":315.3,"y":185.2},{"x":315.8,"y":187.1},{"x":315.3,"y":188.6},{"x":316.1,"y":190.1},{"x":315.9,"y":191.5},{"x":317.2,"y":192.7},{"x":318.9,"y":191.4},{"x":320.5,"y":191.6},{"x":322,"y":191.9},{"x":323.9,"y":192.9},{"x":324.7,"y":191.4},{"x":326.3,"y":191.2},{"x":327.5,"y":191.8},{"x":328.8,"y":191.9},{"x":331,"y":192},{"x":332.9,"y":192.7},{"x":334.7,"y":192.6},{"x":336.1,"y":193.3},{"x":336.6,"y":190.7},{"x":337.9,"y":189.5},{"x":339.6,"y":192.3},{"x":340.4,"y":194},{"x":341.4,"y":195.4},{"x":341,"y":197.6},{"x":340.4,"y":201.8},{"x":339.1,"y":210},{"x":336.3,"y":227.7},{"x":335.9,"y":230.2},{"x":334.2,"y":241},{"x":328.4,"y":240.1},{"x":318.9,"y":238.5},{"x":309.4,"y":236.8},{"x":296.6,"y":234.7},{"x":293.7,"y":234},{"x":288,"y":232.8},{"x":286.2,"y":232.5},{"x":283.5,"y":231.8},{"x":280.4,"y":231.3},{"x":276.6,"y":230.5},{"x":262.5,"y":227.6},{"x":253.7,"y":225.5},{"x":261.1,"y":192.6},{"x":262.1,"y":190.8},{"x":263,"y":189.6},{"x":262.9,"y":187.7},{"x":264.2,"y":186.7},{"x":263.5,"y":184.9},{"x":262,"y":183.8},{"x":260.6,"y":183.3},{"x":260.7,"y":181.2},{"x":261.3,"y":179.7},{"x":263,"y":178.2},{"x":263.7,"y":176.8},{"x":264.7,"y":175.5},{"x":266.3,"y":175.1},{"x":267.5,"y":173.7},{"x":268,"y":171.8},{"x":269.1,"y":170.5},{"x":270.3,"y":169.2},{"x":271.1,"y":167.5},{"x":271.7,"y":166.2},{"x":273.3,"y":164.1},{"x":274.1,"y":163},{"x":275.6,"y":161.6},{"x":275,"y":159.8},{"x":274.6,"y":158},{"x":273.5,"y":157},{"x":272.2,"y":155.5}]],"x":253.7,"y":98.8,"w":87.7,"h":142.2,"cx":294.5,"cy":189.4},"NV":{"shapes":[[{"x":214,"y":216.1},{"x":224.5,"y":218.8},{"x":231.4,"y":220.5},{"x":245.7,"y":223.7},{"x":253.7,"y":225.5},{"x":262.5,"y":227.6},{"x":276.6,"y":230.5},{"x":280.4,"y":231.3},{"x":283.5,"y":231.8},{"x":286.2,"y":232.5},{"x":288,"y":232.8},{"x":293.7,"y":234},{"x":290.2,"y":252.3},{"x":289.4,"y":256.5},{"x":287.4,"y":266.4},{"x":286.9,"y":268.7},{"x":281.9,"y":295},{"x":280.9,"y":300},{"x":280,"y":304.8},{"x":279.4,"y":307.5},{"x":278.7,"y":311.8},{"x":275.9,"y":325.9},{"x":274.6,"y":332.8},{"x":273.9,"y":337.1},{"x":273.1,"y":340.8},{"x":271,"y":343.6},{"x":268.7,"y":342.5},{"x":268.2,"y":340.8},{"x":266.2,"y":340.6},{"x":264.6,"y":340.3},{"x":262.4,"y":340.6},{"x":262.5,"y":342},{"x":262.5,"y":344.3},{"x":262,"y":346},{"x":261.8,"y":347.7},{"x":262.1,"y":349.6},{"x":261.8,"y":351.2},{"x":261.4,"y":352.7},{"x":261.9,"y":354.6},{"x":261.8,"y":357.5},{"x":260.4,"y":359.1},{"x":260.2,"y":361},{"x":254,"y":351.7},{"x":251.1,"y":347.2},{"x":241.4,"y":332.7},{"x":228.6,"y":313.5},{"x":223.6,"y":305.8},{"x":221.1,"y":302.2},{"x":216.2,"y":294.7},{"x":212.3,"y":288.9},{"x":209.8,"y":285.2},{"x":205.4,"y":278.6},{"x":201,"y":271.9},{"x":200,"y":270.4},{"x":201,"y":266.3},{"x":201.5,"y":264.4},{"x":203.4,"y":257.3},{"x":205.1,"y":251},{"x":208.1,"y":239.2}]],"x":200,"y":216.1,"w":93.7,"h":144.9,"cx":248.2,"cy":275.6},"VT":{"shapes":[[{"x":833.9,"y":165.8},{"x":837.2,"y":165},{"x":842.4,"y":163.7},{"x":844.3,"y":163.3},{"x":847.1,"y":162.7},{"x":849.7,"y":162},{"x":857.3,"y":159.9},{"x":857.9,"y":161.7},{"x":857.4,"y":163.1},{"x":857,"y":165.1},{"x":857.9,"y":166.5},{"x":858.7,"y":168.1},{"x":858.1,"y":169.8},{"x":857.5,"y":171.4},{"x":856.4,"y":172.8},{"x":853.8,"y":174.1},{"x":854,"y":175.6},{"x":854.7,"y":177.5},{"x":854.6,"y":179.5},{"x":854.5,"y":181.6},{"x":853.9,"y":182.9},{"x":854.1,"y":184.6},{"x":853.2,"y":186.3},{"x":853.3,"y":188.1},{"x":852.8,"y":190},{"x":853.2,"y":192.7},{"x":853.5,"y":194.7},{"x":853.8,"y":196.9},{"x":854,"y":198.4},{"x":854.3,"y":200},{"x":853.8,"y":202.4},{"x":854.7,"y":203.9},{"x":844.9,"y":206.6},{"x":844.4,"y":205.1},{"x":842.8,"y":197.3},{"x":841.5,"y":191.9},{"x":840.5,"y":190.8},{"x":839.6,"y":192.1},{"x":838.9,"y":190},{"x":839.3,"y":188.3},{"x":838.5,"y":186.5},{"x":837.4,"y":183.9},{"x":837,"y":182.3},{"x":836.9,"y":180.9},{"x":837.5,"y":179.7},{"x":836.8,"y":177.4},{"x":837.1,"y":176},{"x":835.4,"y":173.8},{"x":835,"y":172.2},{"x":834.8,"y":170.8},{"x":834.2,"y":169.1},{"x":834.4,"y":167.5}]],"x":833.9,"y":159.9,"w":24.8,"h":46.7,"cx":846.8,"cy":180.7},"LA":{"shapes":[[{"x":569.9,"y":425.3},{"x":580.1,"y":425},{"x":584.9,"y":424.9},{"x":593.6,"y":424.7},{"x":602.2,"y":424.5},{"x":614.3,"y":424},{"x":613.7,"y":425.6},{"x":614.9,"y":424.4},{"x":616,"y":425.4},{"x":614.8,"y":426.9},{"x":614.6,"y":428.7},{"x":616.3,"y":429.1},{"x":615.4,"y":430.1},{"x":615.1,"y":431.5},{"x":616.6,"y":431.3},{"x":617.3,"y":433},{"x":615.8,"y":432.8},{"x":617,"y":434.5},{"x":617.6,"y":436},{"x":618.9,"y":436.2},{"x":618.1,"y":437.8},{"x":616.7,"y":438.5},{"x":615.2,"y":438.9},{"x":617,"y":440.3},{"x":616.3,"y":441.7},{"x":615.4,"y":443},{"x":613.9,"y":445.5},{"x":612.4,"y":447.1},{"x":614.1,"y":447.2},{"x":612.6,"y":447.7},{"x":612,"y":449.9},{"x":610.4,"y":449.6},{"x":611.7,"y":450.4},{"x":610.2,"y":451.8},{"x":611.1,"y":454.2},{"x":609.8,"y":453.5},{"x":609.9,"y":455.2},{"x":610.5,"y":456.4},{"x":608.5,"y":456.7},{"x":609.4,"y":458.4},{"x":609.9,"y":460.4},{"x":608.8,"y":461.7},{"x":621.7,"y":461},{"x":629.3,"y":460.6},{"x":638.7,"y":460},{"x":638.8,"y":461.6},{"x":638.1,"y":464},{"x":637.5,"y":466.4},{"x":638.3,"y":468.1},{"x":639.1,"y":469.2},{"x":640.4,"y":470.1},{"x":641.4,"y":472.2},{"x":641.8,"y":474.3},{"x":643.3,"y":475},{"x":641.9,"y":475.5},{"x":641,"y":476.5},{"x":640.4,"y":478},{"x":638.8,"y":477.9},{"x":638.6,"y":479.7},{"x":640.3,"y":479.3},{"x":640.7,"y":480.8},{"x":642.3,"y":480.8},{"x":642.8,"y":478.7},{"x":644,"y":477.5},{"x":645.9,"y":477.1},{"x":645,"y":478.1},{"x":646.2,"y":479.8},{"x":647.5,"y":478.2},{"x":648.3,"y":479.4},{"x":646.9,"y":480.2},{"x":647.1,"y":482},{"x":645.4,"y":483},{"x":645.4,"y":484.6},{"x":644.5,"y":483.4},{"x":644.6,"y":485.3},{"x":643,"y":484.8},{"x":641.7,"y":485.1},{"x":642.8,"y":486.2},{"x":641.4,"y":485.5},{"x":641.6,"y":487.1},{"x":643.5,"y":487.8},{"x":644.1,"y":489},{"x":645.4,"y":489.5},{"x":647.6,"y":489.9},{"x":649,"y":490.8},{"x":651.1,"y":491.7},{"x":652.6,"y":492.3},{"x":651.7,"y":493.3},{"x":652.1,"y":494.7},{"x":650.8,"y":495.9},{"x":649.6,"y":495.2},{"x":647.4,"y":497.3},{"x":647.7,"y":495.7},{"x":648.1,"y":494.5},{"x":647.9,"y":492.9},{"x":646.8,"y":494.4},{"x":645.2,"y":492.8},{"x":643.2,"y":492.3},{"x":639.3,"y":491.3},{"x":635.9,"y":494},{"x":633.4,"y":496},{"x":632.4,"y":495},{"x":631.8,"y":492.7},{"x":630.3,"y":493.4},{"x":629.7,"y":491.4},{"x":628.2,"y":492.3},{"x":627.7,"y":493.6},{"x":626.4,"y":494.9},{"x":625.2,"y":495.6},{"x":623.9,"y":497.4},{"x":622.4,"y":495.8},{"x":621.3,"y":494.9},{"x":619.1,"y":494.9},{"x":617.1,"y":494.3},{"x":615.1,"y":493.1},{"x":616.2,"y":491.9},{"x":617.4,"y":492.8},{"x":618.7,"y":493.8},{"x":618.3,"y":492.1},{"x":617,"y":491.2},{"x":615,"y":491.3},{"x":615.2,"y":489.7},{"x":612.9,"y":490},{"x":612.3,"y":488.7},{"x":611.3,"y":487},{"x":609.8,"y":487.1},{"x":610.1,"y":485.2},{"x":608.2,"y":485},{"x":606.4,"y":485.9},{"x":606.4,"y":484.3},{"x":605,"y":483.9},{"x":603,"y":484.9},{"x":600.8,"y":485.2},{"x":602.4,"y":486.3},{"x":602.4,"y":487.8},{"x":603.8,"y":487.7},{"x":601.6,"y":488.4},{"x":600.1,"y":489.2},{"x":594.2,"y":488.6},{"x":592.1,"y":488},{"x":588.8,"y":486.5},{"x":587.4,"y":486},{"x":585,"y":485.5},{"x":583.1,"y":485.4},{"x":580.2,"y":485.6},{"x":576.9,"y":486.1},{"x":574.4,"y":487.2},{"x":573.4,"y":485.8},{"x":574,"y":484.1},{"x":574.7,"y":482.9},{"x":575.1,"y":481.7},{"x":576.5,"y":480.2},{"x":576.6,"y":478.8},{"x":576.1,"y":477.5},{"x":576.3,"y":476.1},{"x":575.6,"y":474.1},{"x":576,"y":471.8},{"x":576.6,"y":470.3},{"x":577.3,"y":468.8},{"x":578,"y":466.6},{"x":578.2,"y":465},{"x":578.2,"y":463.2},{"x":578.8,"y":461.4},{"x":578.6,"y":459.3},{"x":577.2,"y":457.7},{"x":576.5,"y":456.2},{"x":575.9,"y":454.7},{"x":575.2,"y":453.1},{"x":573.9,"y":452.5},{"x":573.8,"y":450.5},{"x":573.7,"y":449},{"x":572.9,"y":447.6},{"x":572.4,"y":446.2},{"x":570.7,"y":444.6}]],"x":569.9,"y":424,"w":82.7,"h":73.4,"cx":603.6,"cy":461.1},"RI":{"shapes":[[{"x":870.1,"y":227.8},{"x":869.9,"y":226.1},{"x":869.8,"y":222.5},{"x":869.1,"y":220.2},{"x":868.1,"y":216.8},{"x":867.7,"y":215.1},{"x":873.1,"y":213.5},{"x":873.7,"y":215.8},{"x":874.5,"y":216.8},{"x":876,"y":217.9},{"x":876.8,"y":219.2},{"x":874.7,"y":218.3},{"x":874.9,"y":219.7},{"x":874.9,"y":221.3},{"x":875.3,"y":223.5},{"x":874.9,"y":225.6},{"x":873.1,"y":226.2},{"x":871.9,"y":227.1}]],"x":867.7,"y":213.5,"w":9.1,"h":14.3,"cx":872.5,"cy":220.3}};

  const BREAKING_NEWS = [
    { title: "Debate Night Fallout", text: "Public speeches are moving voters faster during this news cycle.", effect: "speech" },
    { title: "Local Ground Game Surge", text: "District Office networks are drawing fresh volunteers across competitive states.", effect: "cash" },
    { title: "Police Sweep Ordered", text: "Authorities temporarily slow illegal campaign operations across contested states.", effect: "court" },
    { title: "Jobs Report Released", text: "Manufacturing and logistics-heavy states are reacting to the new labor numbers.", effect: "jobs" },
  ];

  const CLICKBAIT_TEMPLATES = {
    MINDSHARE_CAST: [
      {
        headline: "YOU WON'T BELIEVE WHAT {{faction}}'S CANDIDATE JUST SAID LIVE IN {{state}}!",
        subtext: "A hot mic picked up strange carrier noise during the rally. Locals report sudden, inexplicable loyalty.",
      },
      {
        headline: "SHOCKING: LEAKED AUDIO FROM {{state}} RALLY REVEALS BRAINWAVE FREQUENCIES!",
        subtext: "Alternative analysts claim the signal matches neurolinguistic persuasion patterns. {{faction}} denies everything.",
      },
    ],
    DEPLOY_REPEATER: [
      {
        headline: "MYSTERIOUS REPEATERS SPOTTED IN {{state}}! CAMPAIGN SIGNAL OR MIND GRID?",
        subtext: "Residents report headaches and a sudden urge to donate to {{faction}}. Local airwaves are getting crowded.",
      },
      {
        headline: "THE SILENT INVADER: {{faction}} BUILDS A WIRELESS BEACHHEAD IN {{state}}!",
        subtext: "Hidden campaign towers are appearing overnight. Voters are asking who approved the new signal network.",
      },
    ],
    BACKDOOR_HACK: [
      {
        headline: "CRITICAL BREACH: {{opponent}} SIPHONED FOR {{value}} IN DIRTY CASH!",
        subtext: "A netrunner breach drained campaign reserves straight into {{faction}}'s black-budget wallet.",
      },
      {
        headline: "BREAKING: {{opponent}} LEFT EXPOSED AFTER {{state}} LEDGER SIPHON!",
        subtext: "Insiders say the campaign passwords were catastrophically weak. The war chest damage is already visible.",
      },
    ],
    INCITE_STRIKE: [
      {
        headline: "ANARCHY ALERT: RAGING MOBS TARGET OUTPOSTS IN {{state}}!",
        subtext: "Synthetic agitation pushed local crowds into open rebellion against {{opponent}}'s campaign structure.",
      },
      {
        headline: "CHAOS INSTIGATED: HOW {{faction}} ENGINEERED THE {{state}} RIOT!",
        subtext: "Leaked memos suggest coordinated social signals manufactured the strike wave from behind the curtain.",
      },
    ],
    ENFORCER_PATROL: [
      {
        headline: "POLICE STATE INCOMING? ENFORCERS TAKE CONTROL OF {{state}}!",
        subtext: "{{faction}} calls it defensive security. Critics call it a campaign fortress with sirens.",
      },
      {
        headline: "SHUTTING DOWN THE OPPOSITION: {{faction}} LOCKS DOWN A {{state}} NODE!",
        subtext: "Active patrols are blocking standard hacks and local strikes. Rivals say the state just became expensive.",
      },
    ],
    SIGNAL_SEVER: [
      {
        headline: "OMG! THE COGNITIVE SIGNAL WAS SEVERED LIVE! {{opponent}}'S LEADER DROPS OFFLINE!",
        subtext: "A black-budget payload knocked the candidate dark. The party enters a national mourning blackout.",
      },
      {
        headline: "NATIONAL COLLAPSE: VOTER DROP ACROSS ALL 50 STATES AFTER ATTACK ON {{opponent}}!",
        subtext: "Shockwaves ripple through the electorate. Security experts warn that no candidate is untouchable.",
      },
    ],
  };

  const TERRAIN_BY_REGION = {
    west: "#0b3a20",
    sunbelt: "#0e4426",
    south: "#0c3c22",
    midwest: "#10492c",
    northeast: "#0a3a23",
  };
  const TERRAIN_DEFAULT = "#0d4025";
  const SMALL_STATE_HIT_RADIUS = {
    RI: 16,
    DE: 16,
    MD: 15,
    NJ: 15,
    CT: 14,
    VT: 13,
    NH: 13,
    MA: 15,
  };
  const STATE_LABEL_OFFSETS = {
    RI: { dx: 12, dy: -8 },
    DE: { dx: 12, dy: 2 },
    MD: { dx: -12, dy: 0 },
    NJ: { dx: -8, dy: 0 },
    CT: { dx: 5, dy: 0 },
    VT: { dx: -7, dy: -8 },
    NH: { dx: 9, dy: -8 },
    LA: { dx: -3, dy: 5 },
    MA: { dx: 0, dy: -8 },
  };

  const canvas = document.querySelector("#gameCanvas");
  const ctx = canvas.getContext("2d");
  const usWorldMapImage = new Image();
  usWorldMapImage.src = "us_world_map.png?v=5";
  usWorldMapImage.onload = () => { if (gameStarted) render(); };
  const matchModeInput = document.querySelector("#matchMode");
  const playerCountInput = document.querySelector("#playerCount");
  const difficultyInput = document.querySelector("#difficulty");
  const modeNote = document.querySelector("#modeNote");
  const difficultyNote = document.querySelector("#difficultyNote");
  const newGameButton = document.querySelector("#newGameButton");
  const createLobbyButton = document.querySelector("#createLobbyButton");
  const copyInviteButton = document.querySelector("#copyInviteButton");
  const mainMenuAddBotButton = document.querySelector("#mainMenuAddBotButton");
  
  const multiplayerStatus = document.querySelector("#multiplayerStatus");
  const multiplayerInvite = document.querySelector("#multiplayerInvite");
  const lobbyParty = document.querySelector("#lobbyParty");
  const lobbyLeaderStrip = document.querySelector("#lobbyLeaderStrip");
  const pauseButton = document.querySelector("#endTurnButton");
  const factionName = document.querySelector("#turnName");
  const hqHint = document.querySelector("#turnHint");
  const cashStat = document.querySelector("#troopStat");
  const heatStat = document.querySelector("#incomeStat");
  const timeStat = document.querySelector("#landStat");
  const voteStat = document.querySelector("#waterStat");
  const playerList = document.querySelector("#playerList");
  const opPanel = document.querySelector("#cardHand");
  const eventTicker = document.querySelector("#eventTicker");
  const eventStrip = document.querySelector(".event-strip");
  const cityLog = document.querySelector("#cityLog");
  const mainMenu = document.querySelector("#mainMenu");
  const gameShell = document.querySelector("#gameShell");
  const mapStage = document.querySelector(".map-stage");
  const calendarCountdown = document.querySelector("#calendarCountdown");
  const calendarDayProgress = document.querySelector("#calendarDayProgress");
  const intelPanel = document.querySelector("#intelPanel");
  const intelToggle = document.querySelector("#intelToggle");
  const intelBody = document.querySelector("#intelBody");
  const opponentTray = document.querySelector("#opponentTray");
  const rivalTalentViewer = document.querySelector("#rivalTalentViewer");
  const newsPanel = document.querySelector(".news-panel");
  const newsChannelName = document.querySelector("#newsChannelName");
  const newsReporter = document.querySelector("#newsReporter");
  const newsSubtitle = document.querySelector("#newsSubtitle");
  const channelMarket = document.querySelector("#channelMarket");
  const stateActionMenu = document.querySelector("#stateActionMenu");
  const pauseOverlay = document.querySelector("#pauseOverlay");
  const reporterVolumeSlider = document.querySelector("#reporterVolumeSlider");
  const reporterVolumeValue = document.querySelector("#reporterVolumeValue");
  const musicVolumeSlider = document.querySelector("#musicVolumeSlider");
  const musicVolumeValue = document.querySelector("#musicVolumeValue");
  const sfxVolumeSlider = document.querySelector("#sfxVolumeSlider");
  const sfxVolumeValue = document.querySelector("#sfxVolumeValue");
  const colorBlindToggle = document.querySelector("#colorBlindToggle");
  const settingsCloseButton = document.querySelector("#settingsCloseButton");
  const clickbaitTicker = document.querySelector("#clickbaitTicker");
  const assassinationOverlay = document.querySelector("#assassinationOverlay");
  const assassinationGif = document.querySelector("#assassinationGif");
  const newsSoundButtons = document.querySelectorAll(".sound-toggle");
  const toast = document.querySelector("#toast");
  const partyRoster = document.querySelector("#partyRoster");
  const talentPreview = document.querySelector("#talentPreview");

  let players = [];
  let states = [];
  let channels = [];
  let selectedParty = 0;
  let partyNameDraw = makePartyNameDraw();
  let customPartyNames = {};
  let selectedLeaderProfile = normalizeLeaderProfile(loadLeaderProfile() || { gender: "neutral", skin: SKIN_PRESETS[1], hairstyle: "charmer", facialHair: "none", hat: "none" });
  let selectedState = 2;
  let armedAction = null;
  let selectedPanelOpen = true;
  let hoveredState = -1;
  let hoveredChannel = -1;
  const MAP_INFO_MODES = [
    { id: "code", label: "State codes" },
    { id: "percent", label: "Lead %" },
    { id: "votes", label: "Votes" },
    { id: "flag", label: "Party flags" },
  ];
  let mapInfoMode = 0;
  let menuState = -1;
  let mouseCanvas = { x: 0, y: 0 };
  let mouseScreen = { x: 0, y: 0 };
  const mapPanKeys = { w: false, a: false, s: false, d: false, q: false, e: false };
  let elapsed = 0;
  let phase = "base";
  let baseTimer = HOME_BASE_SECONDS;
  let paused = false;
  let matchOver = false;
  let news = null;
  let newsTimer = 0;
  let latestClickbait = null;
  let clickbaitTimer = 0;
  let activeChannel = 0;
  let currentMatchMode = MATCH_MODES.campaign100;
  let nextNewsAt = NEWS_INTERVAL;
  let lastFrame = performance.now();
  let lastUi = 0;
  let lastBgmCheck = 0;
  let toastTimer = null;
  let assassinationTimer = null;
  let alerts = [];
  let missions = [];
  let actionEffects = [];
  let alertVersion = 0;
  let gameStarted = false;
  let loopStarted = false;
  let soundOn = localStorage.getItem("riggedSoundEnabled") !== "0";
  const savedSoundVolume = localStorage.getItem("riggedSoundVolume") ?? localStorage.getItem("riggedVoiceVolume") ?? "70";
  let reporterVolume = Number(localStorage.getItem("riggedReporterVolume") ?? savedSoundVolume) / 100;
  let musicVolume = Number(localStorage.getItem("riggedMusicVolume") ?? savedSoundVolume) / 100;
  let sfxVolume = Number(localStorage.getItem("riggedSfxVolume") ?? savedSoundVolume) / 100;
  let colorBlindMode = localStorage.getItem("riggedColorBlindMode") === "1";
  let settingsOpen = false;
  let settingsWasPaused = false;
  let audioContext = null;
  let speakTimer = null;
  const BGM_FADE_SECONDS = 2.8;
  const BGM_TRACKS = {
    menu: { src: "bgm-main-menu.mp3", loop: true },
    early: { src: "bgm-early-game.mp3", loop: true },
    mid: { src: "bgm-mid-game.mp3", loop: true },
    end: { src: "bgm-end-game.mp3", loop: true },
    victory: { src: "bgm-victory.mp3", loop: true },
  };
  let bgm = {};
  let currentBgm = "";
  let pendingBgm = "";
  let bgmFade = null;
  let resultBgm = "";
  let audioUnlocked = false;
  let rivalTalentPlayerId = -1;
  let crazySdkPromise = null;
  const multiplayerState = {
    enabled: false,
    host: false,
    roomId: "",
    inviteUrl: "",
    sdkReady: false,
    joinedFromInvite: false,
    hostParty: "",
    hostLeader: "",
    friendJoined: false,
    localReady: false,
    guests: [],
    slots: [],
    countdown: 0,
    countdownTimer: null,
  };
  const lobbyClientId = (() => {
    const key = "riggedLobbyClientId";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  })();
  let lobbyChannel = null;
  let lobbyPulseTimer = null;
  let lobbyListenersReady = false;

  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.cursor = "grab";
  layoutCanvasViewport();
  window.addEventListener("resize", layoutCanvasViewport);
  if (typeof ResizeObserver !== "undefined" && mapStage) {
    const stageResizeObserver = new ResizeObserver(() => layoutCanvasViewport());
    stageResizeObserver.observe(mapStage);
  }

  if (newGameButton) newGameButton.addEventListener("click", beginSelectedGame);
  if (createLobbyButton) createLobbyButton.addEventListener("click", handleInviteFriendClick);
  if (copyInviteButton) copyInviteButton.addEventListener("click", copyInviteLink);
  if (mainMenuAddBotButton) {
    mainMenuAddBotButton.addEventListener("click", async () => {
      if (mainMenuAddBotButton.disabled) return;
      mainMenuAddBotButton.disabled = true;
      mainMenuAddBotButton.textContent = 'Adding…';
      try {
        if (!currentLobby?.id) {
          const settings = window.lobbySettings || {};
          const result = await createLobby(
            'Host',
            matchModeInput?.value || settings.mode || 'campaign100',
            difficultyInput?.value || settings.difficulty || 'medium',
            Number(playerCountInput?.value || settings.maxPlayers || 4),
            settings.lobbyName || "Host's Lobby",
            settings.isPublic === true,
          );
          if (!result?.lobbyId) return;
          startServerLobbyPolling(renderServerLobbyInMainMenu);
        }
        await addBotToServerLobby();
        renderServerLobbyInMainMenu();
      } finally {
        syncMainMenuAddBotButton();
      }
    });
  }
  if (lobbyLeaderStrip) {
    lobbyLeaderStrip.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-remove-lobby-bot]');
      if (!button || button.disabled) return;
      button.disabled = true;
      const removed = await removeBotFromServerLobby(button.dataset.removeLobbyBot);
      if (!removed && button.isConnected) button.disabled = false;
    });
  }
  if (lobbyParty) {
    lobbyParty.addEventListener("click", (event) => {
      const button = event.target.closest("[data-lobby-slot-action]");
      if (!button || !multiplayerState.host) return;
      setLobbySlotMode(Number(button.dataset.lobbySlotAction), button.dataset.nextMode);
    });
  }
  if (intelToggle && intelPanel) {
    intelToggle.addEventListener("click", () => {
      const nextOpen = !intelPanel.classList.contains("is-open");
      intelPanel.classList.toggle("is-open", nextOpen);
      intelToggle.setAttribute("aria-expanded", String(nextOpen));
    });
  }
  if (opponentTray) {
    opponentTray.addEventListener("mouseover", (event) => {
      const card = event.target.closest("[data-leader-player]");
      if (!card || !opponentTray.contains(card)) return;
      const playerId = Number(card.dataset.leaderPlayer);
      if (playerId === HUMAN) return;
      showLeaderIntelTip(playerId, card);
    });
    opponentTray.addEventListener("mousemove", (event) => {
      const card = event.target.closest("[data-leader-player]");
      if (!card || Number(card.dataset.leaderPlayer) === HUMAN) return;
      positionLeaderIntelTip(card);
    });
    opponentTray.addEventListener("mouseout", (event) => {
      if (opponentTray.contains(event.relatedTarget)) return;
      hideLeaderIntelTip();
    });
    opponentTray.addEventListener("pointerdown", (event) => {
      const card = event.target.closest("[data-leader-player]");
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      inspectLeaderPortrait(Number(card.dataset.leaderPlayer));
    });
    opponentTray.addEventListener("click", (event) => {
      const card = event.target.closest("[data-leader-player]");
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      inspectLeaderPortrait(Number(card.dataset.leaderPlayer));
    });
  }
  if (rivalTalentViewer) {
    rivalTalentViewer.addEventListener("click", (event) => {
      if (event.target === rivalTalentViewer || event.target.closest("[data-rival-close]")) {
        closeRivalTalentViewer();
      }
    });
  }
  if (partyRoster) {
    partyRoster.addEventListener("click", (event) => {
      const card = event.target.closest("[data-party-index]");
      if (!card) return;
      selectMenuParty(Number(card.dataset.partyIndex), true);
    });
  }
  if (talentPreview) {
    talentPreview.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-preview-action]");
      if (!button) return;
      if (button.dataset.previewAction === "close") {
        talentPreview.classList.add("is-closed");
        talentPreview.style.display = "none";
        return;
      }
      if (button.dataset.previewAction === "randomize") {
        selectedLeaderProfile = createRandomLeaderProfile();
        renderPartyRoster();
        renderTalentPreview(selectedParty);
        scheduleServerLobbyPlayerUpdate();
        return;
      }
      if (button.dataset.previewAction === "start") {
        if (isServerLobbyGuest()) {
          toggleServerLobbyReady();
          return;
        }
        if (multiplayerState.enabled && !multiplayerState.host) {
          toggleLobbyReady();
          return;
        }
        if (multiplayerState.enabled && multiplayerState.host) startLobbyCountdown();
        else beginSelectedGame();
      }
    });
    talentPreview.addEventListener("input", (event) => {
      const input = event.target.closest("[data-party-name-input]");
      if (!input) return;
      const index = Number(input.dataset.partyNameInput);
      customPartyNames[index] = cleanPartyName(input.value);
      const startButton = talentPreview.querySelector("[data-preview-action='start']");
      if (startButton) startButton.textContent = lobbyStartButtonLabel(index);
      if (multiplayerState.enabled) {
        if (multiplayerState.host && multiplayerState.countdown > 0) cancelLobbyCountdown("Countdown canceled. Leader changed.");
        multiplayerState.localReady = false;
        publishLobbyPresence("select");
        refreshMultiplayerUi();
      }
      if (isServerLobbyGuest()) {
        multiplayerState.localReady = false;
        updateLobbyStartButtons();
      }
      scheduleServerLobbyPlayerUpdate();
    });
    talentPreview.addEventListener("change", (event) => {
      const control = event.target.closest("[data-leader-custom]");
      if (!control) return;
      selectedLeaderProfile = normalizeLeaderProfile({
        ...selectedLeaderProfile,
        [control.dataset.leaderCustom]: control.value,
      });
      if (multiplayerState.enabled) {
        if (multiplayerState.host && multiplayerState.countdown > 0) cancelLobbyCountdown("Countdown canceled. Leader changed.");
        multiplayerState.localReady = false;
      }
      if (isServerLobbyGuest()) multiplayerState.localReady = false;
      renderPartyRoster();
      renderTalentPreview(selectedParty);
      if (multiplayerState.enabled) publishLobbyPresence("select");
      scheduleServerLobbyPlayerUpdate();
    });
  }
  async function beginSelectedGame(options = {}) {
    if (isServerLobbyGuest() && !options.fromHost) {
      toggleServerLobbyReady();
      return;
    }
    if (multiplayerState.enabled && !options.fromHost) {
      if (!multiplayerState.host) {
        toggleLobbyReady();
        return;
      }
      if (!options.afterCountdown) {
        startLobbyCountdown();
        return;
      }
      if (!lobbyCanHostStart()) {
        showToast(lobbyStartBlockReason(), "compact");
        refreshMultiplayerUi();
        return;
      }
      publishLobbyPresence("start");
    }
    if (multiplayerState.enabled) markCrazyRoomJoinable(false);
    if (multiplayerState.countdownTimer) window.clearInterval(multiplayerState.countdownTimer);
    multiplayerState.countdownTimer = null;
    multiplayerState.countdown = 0;
    saveLeaderProfile(selectedLeaderProfile);

    if (window.isServerLobbyHost && currentLobby?.id && !options.fromHost) {
      gameStarted = false;
      const button = document.querySelector("[data-preview-action='start']");
      await startServerGameWithBots(button);
      return;
    }

    gameStarted = true;
    
    console.log('Game started, lobbySettings:', window.lobbySettings, 'isJoiner:', window.isJoiner);
    
    // If joiner, go to waiting screen
    if (window.isJoiner) {
      console.log('Joiner going to waiting screen');
      showWaitingScreenFull();
      return;
    }
    
    // If hosting, create lobby with stored settings
    if (window.lobbySettings) {
      const { mode, difficulty, maxPlayers, lobbyName, isPublic } = window.lobbySettings;
      console.log('Creating lobby:', { mode, difficulty, maxPlayers, lobbyName, isPublic });
      createLobby('Host', mode, difficulty, maxPlayers, lobbyName, isPublic).then(result => {
        console.log('Lobby creation result:', result);
        if (result && result.lobbyId) {
          console.log('Lobby created; returning host to party selection');
          returnHostToLeaderSelection();
        } else {
          console.error('No lobbyId in result');
        }
      }).catch(err => {
        console.error('Lobby creation error:', err);
      });
      return;
    }
    
    console.log('Not hosting, no lobbySettings found');
    // Initialize multiplayer WebSocket for joining
    playerId = Math.random().toString(36).substr(2, 9);
    initWebSocket();
    
    mainMenu.classList.add("is-hidden");
    gameShell.classList.remove("is-hidden");
    startGame();
    setSoundEnabled(soundOn, { announce: false, fade: 1.2 });
    if (!loopStarted) {
      loopStarted = true;
      lastFrame = performance.now();
      requestAnimationFrame(loop);
    }
  }
  refreshMultiplayerUi();
  detectMultiplayerInvite();
  window.addEventListener('pagehide', leaveHostedServerLobby);
  if (multiplayerInvite) {
    multiplayerInvite.addEventListener('click', copyDisplayedInviteCode);
    multiplayerInvite.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      copyDisplayedInviteCode();
    });
  }
  newsSoundButtons.forEach((button) => button.addEventListener("click", toggleNewsSound));
  syncSoundButtons();
  queueAudioUnlock();
  if (pauseButton) pauseButton.addEventListener("click", togglePause);
  if (reporterVolumeSlider) reporterVolumeSlider.addEventListener("input", updateSoundVolume);
  if (musicVolumeSlider) musicVolumeSlider.addEventListener("input", updateSoundVolume);
  if (sfxVolumeSlider) sfxVolumeSlider.addEventListener("input", updateSoundVolume);
  if (colorBlindToggle) colorBlindToggle.addEventListener("change", toggleColorBlindMode);
  if (settingsCloseButton) settingsCloseButton.addEventListener("click", closeSettingsPanel);
  hydrateSettingsControls();
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const screen = canvasScreenPoint(event);
    const world = screenToWorld(screen);
    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
    Camera.zoom = Math.max(Camera.minZoom, Math.min(Camera.maxZoom, Camera.zoom * zoomFactor));
    Camera.offsetX = screen.x - world.x * Camera.zoom;
    Camera.offsetY = screen.y - world.y * Camera.zoom;
    clampCamera();
  }, { passive: false });
  canvas.addEventListener("click", (event) => {
    if (Camera.dragMoved) {
      Camera.dragMoved = false;
      return;
    }
    const point = canvasPoint(event);
    const miniHit = hitMiniBase(point, HUMAN);
    const hit = hitState(point);
    if (armedAction === "upgradeMiniBase") {
      if (miniHit) {
        selectedState = miniHit.state;
        selectedPanelOpen = true;
        executeArmed(miniHit.state);
        updateUi(true);
        return;
      }
      if (hit >= 0) {
        selectedState = hit;
        selectedPanelOpen = true;
        showToast("Click the District Office icon itself to upgrade it.");
        updateUi(true);
        return;
      }
      selectedPanelOpen = false;
      clearArmed();
      return;
    }
    if (hit >= 0) {
      selectedState = hit;
      selectedPanelOpen = true;
      if (phase === "base") chooseHomeBase(HUMAN, hit);
      else if (armedAction) executeArmed(hit);
      updateUi(true);
    } else {
      selectedPanelOpen = false;
      if (armedAction) clearArmed();
    }
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const point = canvasPoint(event);
    const hit = hitState(point);
    if (hit >= 0) {
      selectedState = hit;
      selectedPanelOpen = true;
      closeStateMenu();
      updateUi(true);
    }
  });
  canvas.addEventListener("mousedown", (event) => {
    if (event.button === 0) {
      const screen = canvasScreenPoint(event);
      Camera.isDragging = true;
      Camera.dragMoved = false;
      canvas.style.cursor = "grabbing";
      Camera.startX = screen.x - Camera.offsetX;
      Camera.startY = screen.y - Camera.offsetY;
      return;
    }
    if (event.button === 2) {
      event.preventDefault();
      const point = canvasPoint(event);
      const hit = hitState(point);
      if (hit >= 0) {
        selectedState = hit;
        selectedPanelOpen = true;
        closeStateMenu();
        updateUi(true);
      }
    }
  });
  canvas.addEventListener("mousemove", (event) => {
    const screen = canvasScreenPoint(event);
    mouseScreen = screen;
    if (Camera.isDragging) {
      const nextX = screen.x - Camera.startX;
      const nextY = screen.y - Camera.startY;
      if (Math.abs(nextX - Camera.offsetX) + Math.abs(nextY - Camera.offsetY) > 2) Camera.dragMoved = true;
      Camera.offsetX = nextX;
      Camera.offsetY = nextY;
      clampCamera();
    }
    mouseCanvas = canvasPoint(event);
    hoveredState = hitState(mouseCanvas);
  });
  window.addEventListener("mouseup", () => {
    Camera.isDragging = false;
    canvas.style.cursor = "grab";
  });
  canvas.addEventListener("mouseleave", () => {
    Camera.isDragging = false;
    canvas.style.cursor = "grab";
    hoveredState = -1;
  });
  if (stateActionMenu) {
    stateActionMenu.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    stateActionMenu.addEventListener("click", (event) => {
      event.stopPropagation();
      closeStateMenu();
    });
  }
  document.addEventListener("click", (event) => {
    if (stateActionMenu && !stateActionMenu.contains(event.target)) closeStateMenu();
    if (gameStarted && !canvas.parentElement.contains(event.target)) selectedPanelOpen = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    const isSpace = event.code === "Space" || event.key === " ";
    const tag = event.target?.tagName?.toLowerCase();
    if (gameStarted && key in mapPanKeys && !pipOpen && !settingsOpen && !["input", "select", "textarea"].includes(tag)) {
      mapPanKeys[key] = true;
      event.preventDefault();
      return;
    }
    if (!["p", "k"].includes(key) && !isSpace) return;
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (isSpace && !gameStarted) return;
    if (pipOpen && key !== "p") return;
    event.preventDefault();
    if (key === "p") togglePause();
    else if (key === "k") assassinate(HUMAN, selectedState);
    else if (isSpace) cycleMapInfoMode();
  });
  document.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    if (key in mapPanKeys) mapPanKeys[key] = false;
  });
  window.addEventListener("blur", () => {
    Object.keys(mapPanKeys).forEach((key) => { mapPanKeys[key] = false; });
  });

  function cycleMapInfoMode() {
    mapInfoMode = (mapInfoMode + 1) % MAP_INFO_MODES.length;
    showToast("Map info: " + MAP_INFO_MODES[mapInfoMode].label, "compact");
    updateUi(true);
  }

  function difficultySummary(value) {
    if (value === "hard") return "Hard bots start with +$10M and pay 15% less for most actions. Assassinations and news channel takeovers stay full price.";
    if (value === "medium") return "Medium bots start with +$5M and pay 10% less for most actions. Assassinations and news channel takeovers stay full price.";
    return "Easy bots get no bonus cash and no action discount.";
  }

  function modeSummary(value) {
    if (value === "majority50") return "50% Mode runs until someone is first to reach 50% of electoral votes. No campaign-day countdown.";
    return "100 Days mode uses the campaign countdown. When time runs out, the party with the most electoral votes wins.";
  }

  function refreshDifficultyNote() {
    if (!difficultyNote || !difficultyInput) return;
    difficultyNote.textContent = difficultySummary(difficultyInput.value);
  }

  function refreshModeNote() {
    if (!modeNote || !matchModeInput) return;
    modeNote.textContent = modeSummary(matchModeInput.value);
  }

  if (difficultyInput) {
    difficultyInput.addEventListener("change", () => {
      refreshDifficultyNote();
      updateHostedLobbySettings();
    });
    refreshDifficultyNote();
  }

  if (playerCountInput) {
    playerCountInput.addEventListener("change", () => {
      updateHostedLobbySettings();
      if (multiplayerState.enabled && multiplayerState.host) {
        resetLobbySlots();
        publishLobbyPresence("slots");
        refreshMultiplayerUi();
      } else if (!currentLobby?.id) {
        refreshMultiplayerUi();
      }
    });
  }

  if (matchModeInput) {
    matchModeInput.addEventListener("change", () => {
      refreshModeNote();
      updateHostedLobbySettings();
    });
    refreshModeNote();
  }

  function makeRoomId() {
    return `rigged-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  function fallbackInviteUrl(roomId) {
    const url = new URL(window.location.href);
    const hostFaction = factionForMenu(selectedParty);
    url.searchParams.set("roomName", roomId);
    url.searchParams.set("riggedRoom", roomId);
    url.searchParams.set("mode", matchModeInput?.value || "campaign100");
    url.searchParams.set("players", playerCountInput?.value || "4");
    url.searchParams.set("party", String(selectedParty));
    url.searchParams.set("hostParty", hostFaction.name);
    url.searchParams.set("hostLeader", hostFaction.leader);
    return url.href;
  }

  function multiplayerInviteParams(roomId) {
    const hostFaction = factionForMenu(selectedParty);
    return {
      roomName: roomId,
      riggedRoom: roomId,
      mode: matchModeInput?.value || "campaign100",
      players: playerCountInput?.value || "4",
      party: String(selectedParty),
      hostParty: hostFaction.name,
      hostLeader: hostFaction.leader,
    };
  }

  function serverLobbyRoomId(lobby = currentLobby) {
    return lobby?.id ? `rigged-server-${String(lobby.id)}` : '';
  }

  function serverLobbyInviteParams(lobby = currentLobby) {
    return {
      lobbyId: String(lobby?.id || ''),
      inviteCode: normalizedInviteCode(lobby?.inviteCode),
    };
  }

  function serverLobbyIsJoinable(lobby = currentLobby) {
    if (!lobby?.id || serverLobbyHasStarted(lobby)) return false;
    const normalized = normalizeServerLobby(lobby);
    return normalized.players.length < normalized.maxPlayers;
  }

  async function syncServerLobbyWithCrazyGames(options = {}) {
    if (!currentLobby?.id) return null;
    const sdkGame = await ensureCrazySdk();
    if (!sdkGame) return null;

    const isJoinable = options.isJoinable ?? serverLobbyIsJoinable(currentLobby);
    const inviteParams = serverLobbyInviteParams(currentLobby);
    sdkGame.updateRoom?.({
      roomId: serverLobbyRoomId(currentLobby),
      isJoinable,
      inviteParams,
    });
    lastCrazyServerJoinable = isJoinable;

    if (!isJoinable || options.showInviteButton === false) {
      sdkGame.hideInviteButton?.();
    } else if (options.showInviteButton !== false) {
      try {
        const inviteLink = await sdkGame.inviteLink?.(inviteParams);
        if (inviteLink) multiplayerState.inviteUrl = inviteLink;
      } catch (error) {
        console.warn('CrazyGames invite link was unavailable:', error);
      }
      sdkGame.showInviteButton?.(inviteParams);
    }
    multiplayerState.sdkReady = true;
    return sdkGame;
  }

  async function handleInviteFriendClick() {
    if (!currentLobby?.id) {
      await createMultiplayerLobby();
      return;
    }

    const sdkGame = await syncServerLobbyWithCrazyGames({ showInviteButton: true });
    if (sdkGame) {
      showToast('CrazyGames Invite friends is now available.', 'compact');
    } else {
      showToast('CrazyGames invites are available in the CrazyGames preview.', 'compact');
    }
  }

  function getCrazyGameSdk() {
    return window.CrazyGames?.SDK?.game || window.ConstructCrazySDK?.game || null;
  }

  function ensureCrazySdk() {
    if (crazySdkPromise) return crazySdkPromise;
    crazySdkPromise = new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(null), 2500);
      const finish = (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      };
      const existing = getCrazyGameSdk();
      if (existing) {
        Promise.resolve(window.CrazyGames?.SDK?.init?.()).catch(() => null).finally(() => finish(getCrazyGameSdk()));
        return;
      }
      const script = document.createElement("script");
      script.src = "https://sdk.crazygames.com/crazygames-sdk-v3.js";
      script.async = true;
      script.onload = () => {
        Promise.resolve(window.CrazyGames?.SDK?.init?.()).catch(() => null).finally(() => finish(getCrazyGameSdk()));
      };
      script.onerror = () => finish(null);
      document.head.appendChild(script);
    });
    return crazySdkPromise;
  }

  function refreshMultiplayerUi() {
    if (!multiplayerStatus || !multiplayerInvite) return;
    if (currentLobby?.id && (window.isServerLobbyHost || window.isJoiner)) {
      if (window.isServerLobbyHost) renderServerLobbyInMainMenu();
      else renderJoinedLobbyInMainMenu();
      if (copyInviteButton) copyInviteButton.disabled = false;
      if (mainMenuAddBotButton) {
        syncMainMenuAddBotButton();
      }
      if (createLobbyButton) createLobbyButton.textContent = 'Invite Friend';
      return;
    }
    pruneLobbyGuests();
    if (!multiplayerState.enabled) {
      if (createLobbyButton) createLobbyButton.hidden = false;
      [matchModeInput, playerCountInput, difficultyInput].forEach((control) => {
        if (!control) return;
        control.disabled = false;
        control.setAttribute('aria-disabled', 'false');
        control.closest('.control')?.classList.remove('is-guest-locked');
      });
      multiplayerStatus.textContent = "Solo ready";
      setClickableInviteCode('');
      if (copyInviteButton) copyInviteButton.disabled = true;
      if (mainMenuAddBotButton) {
        syncMainMenuAddBotButton();
      }
      if (lobbyParty) lobbyParty.innerHTML = pendingHostLobbyRosterHtml();
      renderLobbyLeaderStrip();
      return;
    }
    multiplayerStatus.textContent = multiplayerState.joinedFromInvite ? "Friend lobby" : "Lobby open";
    if (createLobbyButton) createLobbyButton.hidden = !multiplayerState.host;
    setClickableInviteCode(multiplayerState.roomId.replace(/^rigged-/i, ""));
    if (copyInviteButton) copyInviteButton.disabled = !multiplayerState.inviteUrl;
    if (createLobbyButton) createLobbyButton.textContent = "Invite Friend";
    renderLobbyParty();
    updateLobbyStartButtons();
  }

  function setClickableInviteCode(code) {
    if (!multiplayerInvite) return;
    const normalized = normalizedInviteCode(code);
    multiplayerInvite.dataset.inviteCode = normalized;
    multiplayerInvite.textContent = normalized;
    if (normalized) {
      multiplayerInvite.tabIndex = 0;
      multiplayerInvite.setAttribute('role', 'button');
      multiplayerInvite.setAttribute('aria-label', `Copy invite code ${normalized}`);
      multiplayerInvite.title = 'Click to copy invite code';
    } else {
      multiplayerInvite.removeAttribute('tabindex');
      multiplayerInvite.removeAttribute('role');
      multiplayerInvite.removeAttribute('aria-label');
      multiplayerInvite.removeAttribute('title');
    }
  }

  async function copyDisplayedInviteCode() {
    const code = multiplayerInvite?.dataset.inviteCode || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      multiplayerInvite.textContent = 'COPIED!';
      showToast('Invite code copied.', 'compact');
      window.setTimeout(() => {
        if (multiplayerInvite?.dataset.inviteCode === code) multiplayerInvite.textContent = code;
      }, 1200);
    } catch {
      showToast(`Invite code: ${code}`, 'compact');
    }
  }

  function lobbySlotHtml(name, badge, color, waiting = false, actionHtml = "") {
    return `
      <div class="lobby-slot${waiting ? " is-waiting" : ""}">
        <span class="lobby-slot-marker" style="color:${color || "#34ff86"}"></span>
        <span class="lobby-slot-name">${escapeHtml(name)}</span>
        <span class="lobby-slot-badge">${badge}</span>
        ${actionHtml}
      </div>`;
  }

  function renderLobbyParty() {
    if (!lobbyParty) return;
    if (!multiplayerState.enabled) {
      lobbyParty.innerHTML = lobbySlotHtml("No lobby party yet", "SOLO", "#34ff86", true);
      return;
    }
    const hostFaction = multiplayerState.host
      ? factionForMenu(selectedParty)
      : { name: multiplayerState.hostParty || "Host Party", leader: multiplayerState.hostLeader || "Host Leader", color: "#34ff86" };
    if (!multiplayerState.host) {
      lobbyParty.innerHTML = [
        lobbySlotHtml(`${hostFaction.leader} - ${hostFaction.name}`, "HOST", hostFaction.color || "#34ff86"),
        lobbySlotHtml(`${factionForMenu(selectedParty).leader} - You`, multiplayerState.localReady ? "READY" : "PICKING", factionForMenu(selectedParty).color, !multiplayerState.localReady),
      ].join("");
      return;
    }
    ensureLobbySlots();
    lobbyParty.innerHTML = multiplayerState.slots.map((slot, index) => renderHostLobbySlot(slot, index)).join("");
  }

  function renderHostLobbySlot(slot, index) {
    if (slot.type === "host") {
      const faction = factionForMenu(selectedParty);
      return lobbySlotHtml(`${index + 1}. ${faction.leader} - ${faction.name}`, "HOST", faction.color);
    }
    if (slot.type === "bot") {
      const botIndex = (selectedParty + index) % FACTIONS.length;
      const faction = factionForMenu(botIndex);
      return lobbySlotHtml(`${index + 1}. Bot - ${faction.name}`, "BOT", faction.color, false, lobbySlotButton(index, "open", "Open"));
    }
    if (slot.type === "player" && slot.guest) {
      return lobbySlotHtml(`${index + 1}. ${slot.guest.leader} - ${slot.guest.party}`, slot.guest.ready ? "READY" : "PICKING", slot.guest.color || "#bfffe0", !slot.guest.ready, lobbySlotButton(index, "bot", "Bot"));
    }
    return lobbySlotHtml(`${index + 1}. Open for friend`, "OPEN", "#bfffe0", true, lobbySlotButton(index, "bot", "Bot"));
  }

  function lobbySlotButton(index, nextMode, label) {
    return `<button class="lobby-slot-action" type="button" data-lobby-slot-action="${index}" data-next-mode="${nextMode}">${label}</button>`;
  }

  function isServerLobbyGuest() {
    return !!(window.isJoiner && !window.isServerLobbyHost && currentLobby?.id);
  }

  function lobbyStartButtonLabel(index = selectedParty) {
    const faction = factionForMenu(index);
    if (window.isServerLobbyHost && currentLobby?.id) return "START GAME";
    if (isServerLobbyGuest()) return multiplayerState.localReady ? "CANCEL READY" : "READY";
    if (multiplayerState.countdown > 0) return `Starting in ${multiplayerState.countdown}`;
    if (multiplayerState.enabled && !multiplayerState.host) {
      return multiplayerState.localReady ? "Cancel Ready - Reselect Leader" : `Save Leader and Ready as ${faction.name}`;
    }
    if (multiplayerState.enabled && multiplayerState.host && !lobbyCanHostStart()) {
      return lobbyStartBlockReason();
    }
    return multiplayerState.enabled ? "Host Ready - Start Countdown" : `Save Leader and Start as ${faction.name}`;
  }

  function updateLobbyStartButtons() {
    const buttons = document.querySelectorAll("[data-preview-action='start']");
    buttons.forEach((button) => {
      button.textContent = lobbyStartButtonLabel(selectedParty);
      button.disabled = multiplayerState.enabled && multiplayerState.host && !lobbyCanHostStart();
    });
  }

  function lobbyCanHostStart() {
    if (!multiplayerState.enabled || !multiplayerState.host) return true;
    pruneLobbyGuests();
    ensureLobbySlots();
    return multiplayerState.slots.every((slot) => {
      if (slot.type === "host" || slot.type === "bot") return true;
      return slot.type === "player" && slot.guest?.ready;
    });
  }

  function lobbyStartBlockReason() {
    ensureLobbySlots();
    if (multiplayerState.slots.some((slot) => slot.type === "open")) return "Fill open lobby slots";
    return "Waiting for all leaders to ready";
  }

  function toggleLobbyReady() {
    saveLeaderProfile(selectedLeaderProfile);
    multiplayerState.localReady = !multiplayerState.localReady;
    publishLobbyPresence(multiplayerState.localReady ? "ready" : "unready");
    refreshMultiplayerUi();
    renderTalentPreview(selectedParty);
    showToast(multiplayerState.localReady ? "Leader ready. Waiting for host to start." : "Ready canceled. Reselect your leader.", "compact");
  }

  async function toggleServerLobbyReady() {
    saveLeaderProfile(selectedLeaderProfile);
    const previousReady = multiplayerState.localReady;
    multiplayerState.localReady = !previousReady;
    updateLobbyStartButtons();
    renderTalentPreview(selectedParty);
    try {
      const res = await fetch(`${REST_BACKEND_URL}/api/lobby/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: currentLobby.id, playerId: currentPlayerId, ready: multiplayerState.localReady }),
      });
      if (!res.ok) throw new Error(`Ready update failed: ${res.status}`);
      const data = await res.json();
      if (data.lobby) currentLobby = normalizeServerLobby(data.lobby, currentLobby);
      renderJoinedLobbyInMainMenu();
      showToast(multiplayerState.localReady ? "Ready. Waiting for the host to start." : "Ready canceled.", "compact");
    } catch (error) {
      console.error(error);
      multiplayerState.localReady = previousReady;
      updateLobbyStartButtons();
      renderTalentPreview(selectedParty);
      showToast('Could not update ready status.', 'compact');
    }
  }

  function startLobbyCountdown() {
    if (!multiplayerState.enabled || !multiplayerState.host) return;
    if (multiplayerState.countdown > 0) {
      cancelLobbyCountdown("Countdown canceled.");
      return;
    }
    if (!lobbyCanHostStart()) {
      showToast(lobbyStartBlockReason(), "compact");
      refreshMultiplayerUi();
      return;
    }
    multiplayerState.countdown = 5;
    publishLobbyPresence("countdown");
    refreshMultiplayerUi();
    showToast("Match starts in 5.", "compact");
    multiplayerState.countdownTimer = window.setInterval(() => {
      multiplayerState.countdown -= 1;
      publishLobbyPresence("countdown");
      refreshMultiplayerUi();
      if (multiplayerState.countdown <= 0) {
        window.clearInterval(multiplayerState.countdownTimer);
        multiplayerState.countdownTimer = null;
        multiplayerState.countdown = 0;
        beginSelectedGame({ afterCountdown: true });
      }
    }, 1000);
  }

  function cancelLobbyCountdown(message = "Countdown canceled.") {
    if (multiplayerState.countdownTimer) window.clearInterval(multiplayerState.countdownTimer);
    multiplayerState.countdownTimer = null;
    multiplayerState.countdown = 0;
    publishLobbyPresence("cancelCountdown");
    refreshMultiplayerUi();
    showToast(message, "compact");
  }

  function currentLobbyMember(extra = {}) {
    const faction = factionForMenu(selectedParty);
    return {
      clientId: lobbyClientId,
      roomId: multiplayerState.roomId,
      host: multiplayerState.host,
      party: faction.name,
      leader: faction.leader,
      color: faction.color,
      factionIndex: selectedParty,
      leaderProfile: normalizeLeaderProfile(selectedLeaderProfile),
      ready: multiplayerState.host ? true : multiplayerState.localReady,
      countdown: multiplayerState.countdown,
      ts: Date.now(),
      ...extra,
    };
  }

  function startLobbyPresence() {
    setupLobbyListeners();
    if (!lobbyPulseTimer) {
      lobbyPulseTimer = window.setInterval(() => publishLobbyPresence("pulse"), 1200);
    }
    publishLobbyPresence(multiplayerState.host ? "host" : "join");
  }

  function setupLobbyListeners() {
    if (lobbyListenersReady) return;
    lobbyListenersReady = true;
    if ("BroadcastChannel" in window) {
      lobbyChannel = new BroadcastChannel("riggedLobby");
      lobbyChannel.addEventListener("message", (event) => handleLobbyMessage(event.data));
    }
    window.addEventListener("storage", (event) => {
      if (event.key !== "riggedLobbyEvent" || !event.newValue) return;
      try {
        handleLobbyMessage(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed lobby pings.
      }
    });
  }

  function publishLobbyPresence(type) {
    if (!multiplayerState.enabled || !multiplayerState.roomId) return;
    const message = currentLobbyMember({ type });
    try {
      lobbyChannel?.postMessage(message);
    } catch {
      // BroadcastChannel can be unavailable for some file:// contexts.
    }
    try {
      localStorage.setItem("riggedLobbyEvent", JSON.stringify(message));
    } catch {
      // Private browsing may block localStorage; the SDK invite still works.
    }
  }

  function handleLobbyMessage(message) {
    if (!message || message.roomId !== multiplayerState.roomId || message.clientId === lobbyClientId) return;
    if (message.type === "start" && !multiplayerState.host) {
      beginSelectedGame({ fromHost: true });
      return;
    }
    if ((message.type === "countdown" || message.type === "cancelCountdown") && !multiplayerState.host) {
      multiplayerState.countdown = message.type === "cancelCountdown" ? 0 : Math.max(0, Number(message.countdown || 0));
      refreshMultiplayerUi();
      if (multiplayerState.countdown <= 0 && message.type === "countdown") beginSelectedGame({ fromHost: true });
      return;
    }
    if (multiplayerState.host) {
      upsertLobbyGuest(message);
      multiplayerState.friendJoined = multiplayerState.guests.length > 0;
      refreshMultiplayerUi();
      return;
    }
    if (message.host) {
      multiplayerState.hostParty = message.party || multiplayerState.hostParty;
      multiplayerState.hostLeader = message.leader || multiplayerState.hostLeader;
      refreshMultiplayerUi();
    }
  }

  function upsertLobbyGuest(message) {
    const next = {
      clientId: message.clientId,
      party: message.party || "Friend Party",
      leader: message.leader || "Friend Leader",
      color: message.color || "#bfffe0",
      factionIndex: Number.isFinite(Number(message.factionIndex)) ? Number(message.factionIndex) : 0,
      leaderProfile: message.leaderProfile || null,
      ready: !!message.ready,
      ts: message.ts || Date.now(),
    };
    const existing = multiplayerState.guests.findIndex((guest) => guest.clientId === next.clientId);
    if (existing >= 0) multiplayerState.guests[existing] = next;
    else multiplayerState.guests.push(next);
    assignGuestToLobbySlot(next);
  }

  function pruneLobbyGuests() {
    if (!multiplayerState.guests.length) {
      multiplayerState.slots.forEach((slot) => {
        if (slot.type === "player") {
          slot.type = "open";
          slot.guest = null;
        }
      });
      multiplayerState.friendJoined = false;
      return;
    }
    const now = Date.now();
    multiplayerState.guests = multiplayerState.guests.filter((guest) => now - (guest.ts || 0) < 7000);
    const liveIds = new Set(multiplayerState.guests.map((guest) => guest.clientId));
    multiplayerState.slots.forEach((slot) => {
      if (slot.type === "player" && slot.guest && !liveIds.has(slot.guest.clientId)) {
        slot.type = "open";
        slot.guest = null;
      }
    });
    multiplayerState.friendJoined = multiplayerState.guests.length > 0;
  }

  function lobbySlotCount() {
    return Math.max(2, Math.min(Number(playerCountInput?.value || 4), FACTIONS.length));
  }

  function resetLobbySlots() {
    const count = lobbySlotCount();
    multiplayerState.slots = Array.from({ length: count }, (_, index) => ({
      type: index === 0 ? "host" : "open",
      guest: null,
    }));
  }

  function ensureLobbySlots() {
    if (!multiplayerState.host) return;
    const count = lobbySlotCount();
    if (!multiplayerState.slots.length) resetLobbySlots();
    while (multiplayerState.slots.length < count) multiplayerState.slots.push({ type: "bot", guest: null });
    if (multiplayerState.slots.length > count) multiplayerState.slots.length = count;
    multiplayerState.slots[0] = { type: "host", guest: null };
  }

  function setLobbySlotMode(index, mode) {
    ensureLobbySlots();
    if (index <= 0 || index >= multiplayerState.slots.length) return;
    multiplayerState.slots[index] = { type: mode === "open" ? "open" : "bot", guest: null };
    if (mode === "open") showToast(`Slot ${index + 1} opened for a friend.`, "compact");
    else showToast(`Slot ${index + 1} filled by bot.`, "compact");
    publishLobbyPresence("slots");
    markCrazyRoomJoinable(lobbyHasOpenPlayerSlot());
    refreshMultiplayerUi();
  }

  function assignGuestToLobbySlot(guest) {
    ensureLobbySlots();
    const existing = multiplayerState.slots.find((slot) => slot.type === "player" && slot.guest?.clientId === guest.clientId);
    if (existing) {
      existing.guest = guest;
      return;
    }
    const open = multiplayerState.slots.find((slot) => slot.type === "open");
    if (!open) return;
    open.type = "player";
    open.guest = guest;
    showToast(`${guest.leader} joined an open slot.`, "compact");
    markCrazyRoomJoinable(lobbyHasOpenPlayerSlot());
  }

  function lobbyHasOpenPlayerSlot() {
    ensureLobbySlots();
    return multiplayerState.slots.some((slot) => slot.type === "open");
  }

  async function createMultiplayerLobby(options = {}) {
    // Check if using new lobby system
    if (window.lobbySettings) {
      console.log('Using new lobby system with settings:', window.lobbySettings);
      const { mode, difficulty, maxPlayers, lobbyName, isPublic } = window.lobbySettings;
      const result = await createLobby('Host', mode, difficulty, maxPlayers, lobbyName, isPublic);
      console.log('New lobby created:', result);
      if (result && result.lobbyId) {
        returnHostToLeaderSelection();
        return;
      }
    }
    
    // Original CrazyGames multiplayer system
    const roomId = makeRoomId();
    multiplayerState.enabled = true;
    multiplayerState.host = true;
    multiplayerState.joinedFromInvite = false;
    multiplayerState.roomId = roomId;
    multiplayerState.inviteUrl = fallbackInviteUrl(roomId);
    multiplayerState.hostParty = factionForMenu(selectedParty).name;
    multiplayerState.hostLeader = factionForMenu(selectedParty).leader;
    multiplayerState.friendJoined = false;
    multiplayerState.localReady = true;
    multiplayerState.guests = [];
    resetLobbySlots();
    startLobbyPresence();
    refreshMultiplayerUi();

    const sdkGame = await ensureCrazySdk();
    multiplayerState.sdkReady = !!sdkGame;
    if (sdkGame?.updateRoom) {
      sdkGame.updateRoom({
        roomId,
        isJoinable: lobbyHasOpenPlayerSlot(),
        inviteParams: multiplayerInviteParams(roomId),
      });
    }
    syncCrazyInviteButton(sdkGame, lobbyHasOpenPlayerSlot());
    if (sdkGame?.inviteLink) {
      try {
        multiplayerState.inviteUrl = await sdkGame.inviteLink(multiplayerInviteParams(roomId));
      } catch {
        multiplayerState.inviteUrl = fallbackInviteUrl(roomId);
      }
    }
    refreshMultiplayerUi();
    showToast(options.instant ? "Instant multiplayer lobby ready." : "Lobby ready. Invite link created.", "compact");
  }

  async function copyInviteLink() {
    const serverCode = currentLobby?.id ? normalizedInviteCode(currentLobby.inviteCode) : '';
    const invitation = serverCode || multiplayerState.inviteUrl;
    if (!invitation) return;
    try {
      const sdkGame = serverCode ? null : await ensureCrazySdk();
      if (sdkGame?.copyToClipboard) sdkGame.copyToClipboard(invitation);
      else await navigator.clipboard.writeText(invitation);
      showToast(serverCode ? 'Invite code copied.' : 'Invite link copied.', 'compact');
    } catch {
      multiplayerInvite.textContent = serverCode ? `Invite code: ${serverCode}` : invitation;
      showToast('Copy blocked. Invitation shown in lobby box.', 'compact');
    }
  }

  function applyJoinedRoom(params) {
    params = normalizeInviteParams(params);
    const roomId = params?.riggedRoom || params?.roomName || params?.roomId || "";
    if (!roomId) return false;
    multiplayerState.enabled = true;
    multiplayerState.host = false;
    multiplayerState.joinedFromInvite = true;
    multiplayerState.roomId = String(roomId);
    multiplayerState.inviteUrl = fallbackInviteUrl(multiplayerState.roomId);
    multiplayerState.hostParty = params.hostParty || multiplayerState.hostParty || "";
    multiplayerState.hostLeader = params.hostLeader || multiplayerState.hostLeader || "";
    multiplayerState.friendJoined = true;
    multiplayerState.localReady = false;
    multiplayerState.guests = [];
    if (params.mode && matchModeInput) matchModeInput.value = params.mode;
    if (params.players && playerCountInput) playerCountInput.value = params.players;
    if (params.party && Number.isFinite(Number(params.party))) selectedParty = Number(params.party);
    refreshModeNote();
    startLobbyPresence();
    refreshMultiplayerUi();
    renderPartyRoster();
    renderTalentPreview(selectedParty);
    showToast("Friend lobby loaded.", "compact");
    return true;
  }

  function normalizeInviteParams(params) {
    if (!params) return {};
    if (typeof params === "string") {
      try {
        return normalizeInviteParams(JSON.parse(params));
      } catch {
        return Object.fromEntries(new URLSearchParams(params));
      }
    }
    if (params instanceof URLSearchParams) return Object.fromEntries(params);
    return params;
  }

  async function applyCrazyInviteParams(params) {
    const normalized = normalizeInviteParams(params);
    if (normalized?.lobbyId) {
      const result = await joinLobby(String(normalized.lobbyId), 'Player');
      if (result) {
        showJoinerPartySelection();
        showToast('Joined your friend\'s lobby.', 'compact');
        return true;
      }
      showToast('That multiplayer lobby is no longer available.', 'compact');
      return false;
    }
    return applyJoinedRoom(normalized);
  }

  async function detectMultiplayerInvite() {
    window.riggedTestJoinRoom = (inviteParams) => applyJoinedRoom(inviteParams);
    const urlParams = new URLSearchParams(window.location.search);
    await applyCrazyInviteParams({
      lobbyId: urlParams.get("lobbyId"),
      riggedRoom: urlParams.get("riggedRoom"),
      roomName: urlParams.get("roomName"),
      roomId: urlParams.get("roomId"),
      mode: urlParams.get("mode"),
      players: urlParams.get("players"),
      party: urlParams.get("party"),
      hostParty: urlParams.get("hostParty"),
      hostLeader: urlParams.get("hostLeader"),
    });

    const sdkGame = await ensureCrazySdk();
    if (!sdkGame) return;
    multiplayerState.sdkReady = true;
    if (sdkGame.inviteParams) await applyCrazyInviteParams(sdkGame.inviteParams);
    if (isCrazyInstantMultiplayer(sdkGame, urlParams) && !multiplayerState.enabled) {
      if (multiplayerStatus) multiplayerStatus.textContent = "Instant lobby";
      createMultiplayerLobby({ instant: true });
    }
    registerCrazyRoomJoinListener(sdkGame);
  }

  function registerCrazyRoomJoinListener(sdkGame) {
    const listener = (inviteParams) => {
      applyCrazyInviteParams(inviteParams).catch((error) => {
        console.error('Could not join CrazyGames room:', error);
      });
    };
    if (sdkGame.addJoinRoomListener) sdkGame.addJoinRoomListener(listener);
    else if (sdkGame.addJoinListener) sdkGame.addJoinListener(listener);
    else if (sdkGame.addRoomJoinListener) sdkGame.addRoomJoinListener(listener);
    else if (sdkGame.onRoomJoin) sdkGame.onRoomJoin(listener);
  }

  function isCrazyInstantMultiplayer(sdkGame, urlParams) {
    return !!sdkGame?.isInstantMultiplayer || urlParams.get("instantMultiplayer") === "1";
  }

  function markCrazyRoomJoinable(isJoinable) {
    if (!multiplayerState.enabled || !multiplayerState.roomId) return;
    ensureCrazySdk().then((sdkGame) => {
      if (sdkGame?.updateRoom) {
        sdkGame.updateRoom({
          roomId: multiplayerState.roomId,
          isJoinable,
          inviteParams: multiplayerInviteParams(multiplayerState.roomId),
        });
      }
      syncCrazyInviteButton(sdkGame, isJoinable);
    });
  }

  function syncCrazyInviteButton(sdkGame, isJoinable) {
    if (!sdkGame) return;
    if (!isJoinable) {
      if (sdkGame.hideInviteButton) sdkGame.hideInviteButton();
      return;
    }
    if (!sdkGame.showInviteButton) return;
    try {
      const link = sdkGame.showInviteButton(multiplayerInviteParams(multiplayerState.roomId));
      if (link) multiplayerState.inviteUrl = link;
    } catch {
      multiplayerState.inviteUrl = fallbackInviteUrl(multiplayerState.roomId);
    }
  }

  window.riggedTestInviteButton = (isJoinable = true) => {
    const calls = [];
    syncCrazyInviteButton({
      showInviteButton: (params) => {
        calls.push({ method: "showInviteButton", params });
        return fallbackInviteUrl(params.roomName || params.riggedRoom || multiplayerState.roomId || makeRoomId());
      },
      hideInviteButton: () => calls.push({ method: "hideInviteButton" }),
    }, isJoinable);
    return calls;
  };

  function startGame() {
    currentMatchMode = MATCH_MODES[matchModeInput?.value] || MATCH_MODES.campaign100;
    const lobbyPlayers = currentLobby?.id ? normalizeServerLobby(currentLobby).players : null;
    const count = Math.min(lobbyPlayers?.length || Number(playerCountInput.value), FACTIONS.length);
    const partyOrder = lobbyPlayers
      ? lobbyPlayers.slice(0, count).map((member, index) => Number.isFinite(Number(member.factionIndex)) ? Number(member.factionIndex) : index % FACTIONS.length)
      : [selectedParty, ...FACTIONS.map((_, index) => index).filter((index) => index !== selectedParty)].slice(0, count);
    players = partyOrder.map((factionIndex, id) => {
      const lobbyMember = lobbyPlayers?.[id] || null;
      const faction = factionForMenu(factionIndex);
      const isHumanMember = !!lobbyMember && !lobbyMember.isBot;
      const isBotMember = lobbyMember ? lobbyMember.isBot === true : id !== HUMAN;
      const leaderProfile = lobbyMember?.leaderProfile
        ? cloneLeaderProfile(lobbyMember.leaderProfile)
        : id === HUMAN
        ? cloneLeaderProfile(selectedLeaderProfile)
        : createAiLeaderProfile(faction, id);
      return ({
      ...faction,
      name: lobbyMember?.party || faction.name,
      leader: lobbyMember?.leader || faction.leader,
      color: partyColor(factionIndex),
      glow: partyGlow(factionIndex),
      id,
      lobbyPlayerId: lobbyMember?.id || '',
      isBot: isBotMember,
      isHumanMember,
      factionIndex,
      leaderProfile,
      aiPersonality: isHumanMember || id === HUMAN ? AI_PERSONALITIES[0] : AI_PERSONALITIES[(Math.max(1, id) - 1) % AI_PERSONALITIES.length],
      cash: (isHumanMember || id === HUMAN ? 15000 : 14000) + botCashBonus({ id, isBot: isBotMember }),
      heat: 0,
      locked: 0,
      leaderDeaths: 0,
      assassinDay: -1,
      assassinationsToday: 0,
      action: null,
      aiDelay: 1 + Math.random() * 2.2,
      insetDelay: 14 + id * 5 + Math.random() * 8,
      policeShortageTime: 0,
      basePickDelay: isHumanMember || id === HUMAN ? 0 : 1.2 + Math.random() * 6.5,
      homeBase: -1,
      mainBaseLevel: 0,
      talents: {},
      hypeNext: false,
      talentTree: faction.talentTree || TALENT_ORDER[factionIndex % TALENT_ORDER.length],
    });
    });
    assignDistinctPartyColors();
    states = STATE_DATA.map((state, index) => {
      const geo = GEO_STATES[state.abbr];
      const shapes = geo ? geo.shapes : [makeStateShape(state, index)];
      const box = geo
        ? { x: geo.x, y: geo.y, w: geo.w, h: geo.h, cx: geo.cx, cy: geo.cy }
        : { x: state.x, y: state.y, w: state.w, h: state.h, cx: state.x + state.w / 2, cy: state.y + state.h / 2 };
      return {
        ...state,
        ...box,
        index,
        influence: Array(count).fill(0),
        offices: Array(count).fill(0),
        police: Array(count).fill(false),
        cashFreeze: {},
        sabotageCooldown: 0,
        activePulse: 0,
        shapes,
        points: shapes[0],
      };
    });
    channels = CHANNELS.map((channel, index) => ({
      ...channel,
      index,
      owner: -1,
      pulse: 0,
    }));
    selectedState = states.findIndex((state) => state.abbr === "CA");
    selectedPanelOpen = true;
    hoveredState = -1;
    hoveredChannel = -1;
    resetCamera();
    menuState = -1;
    pipOpen = false;
    pipHoverKey = "";
    if (pipEl) pipEl.classList.remove("is-open");
    document.body.classList.remove("pip-active");
    elapsed = 0;
    phase = "base";
    baseTimer = HOME_BASE_SECONDS;
    paused = false;
    localPauseRequested = false;
    matchOver = false;
    resultBgm = "";
    if (victoryEl) victoryEl.classList.remove("is-open");
    closeRivalTalentViewer();
    news = null;
    newsTimer = 0;
    activeChannel = 0;
    nextNewsAt = NEWS_INTERVAL;
    alerts = [];
    missions = [];
    actionEffects = [];
    alertVersion = 0;
    closeStateMenu();
    broadcast(0, "Home-base selection is open. Pick a state before the national campaign goes live.");
    addAlert("Home-base draft started. Everyone begins with zero influence.");
    refreshBgm();
    updateUi(true);
    render();
    layoutCanvasViewport();
  }

  function layoutCanvasViewport() {
    if (!canvas || !mapStage) return;
    const stageRect = mapStage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;
    const ratio = CANVAS_W / CANVAS_H;
    let drawWidth = stageRect.width;
    let drawHeight = drawWidth / ratio;
    if (drawHeight > stageRect.height) {
      drawHeight = stageRect.height;
      drawWidth = drawHeight * ratio;
    }
    canvas.style.width = `${Math.max(1, Math.floor(drawWidth))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(drawHeight))}px`;
  }

  function resetCamera() {
    Camera.zoom = 1;
    Camera.offsetX = 0;
    Camera.offsetY = 0;
    Camera.isDragging = false;
    Camera.dragMoved = false;
    clampCamera();
  }

  function clampCamera() {
    const scaledW = CANVAS_W * Camera.zoom;
    const scaledH = CANVAS_H * Camera.zoom;
    const margin = 80;

    if (scaledW + margin * 2 <= CANVAS_W) {
      Camera.offsetX = (CANVAS_W - scaledW) / 2;
    } else {
      const minX = CANVAS_W - scaledW - margin;
      const maxX = margin;
      Camera.offsetX = Math.max(minX, Math.min(maxX, Camera.offsetX));
    }

    if (scaledH + margin * 2 <= CANVAS_H) {
      Camera.offsetY = (CANVAS_H - scaledH) / 2;
    } else {
      const minY = CANVAS_H - scaledH - margin;
      const maxY = margin;
      Camera.offsetY = Math.max(minY, Math.min(maxY, Camera.offsetY));
    }
  }

  function visualById(id) {
    return LEADER_VISUALS.find((item) => item.id === id) || LEADER_VISUALS[0];
  }

  function flagById(id) {
    return PARTY_FLAGS.find((item) => item.id === id) || PARTY_FLAGS[0];
  }

  function normalizeLeaderProfile(profile) {
    const visual = visualById(profile?.hairstyle);
    return {
      gender: "neutral",
      skin: SKIN_PRESETS.includes(profile?.skin) ? profile.skin : SKIN_PRESETS[1],
      hairstyle: visual.id,
      facialHair: visual.forceFacial || (FACIAL_HAIR.some((item) => item.id === profile?.facialHair) ? profile.facialHair : "none"),
      hat: LEADER_HATS.some((item) => item.id === profile?.hat) ? profile.hat : "none",
      flag: flagById(profile?.flag).id,
      facialLocked: !!visual.forceFacial,
    };
  }

  function cloneLeaderProfile(profile) {
    return normalizeLeaderProfile({ ...profile });
  }

  function loadLeaderProfile() {
    try {
      return JSON.parse(localStorage.getItem("rigged.leaderProfile") || "null");
    } catch (error) {
      return null;
    }
  }

  function saveLeaderProfile(profile) {
    try {
      localStorage.setItem("rigged.leaderProfile", JSON.stringify(normalizeLeaderProfile(profile)));
    } catch (error) {
      // The match can still start if browser storage is unavailable.
    }
  }

  function pickFrom(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function createRandomLeaderProfile() {
    return normalizeLeaderProfile({
      skin: pickFrom(SKIN_PRESETS),
      hairstyle: pickFrom(LEADER_VISUALS).id,
      facialHair: pickFrom(FACIAL_HAIR).id,
      hat: pickFrom(LEADER_HATS).id,
      flag: pickFrom(PARTY_FLAGS).id,
    });
  }

  function createAiLeaderProfile(faction, id) {
    const tree = faction.talentTree || "";
    const pool = ["vanguard", "machine"].includes(tree)
      ? AGGRESSIVE_VISUALS
      : ["oligarchy", "ledger"].includes(tree)
      ? DEFENSIVE_VISUALS
      : EXPANSIONIST_VISUALS;
    return normalizeLeaderProfile({
      gender: id % 3 === 0 ? "fem" : id % 2 === 0 ? "neutral" : "masc",
      skin: SKIN_PRESETS[(id + Math.floor(Math.random() * SKIN_PRESETS.length)) % SKIN_PRESETS.length],
      hairstyle: pickFrom(pool),
      facialHair: pickFrom(FACIAL_HAIR).id,
      hat: Math.random() < 0.45 ? pickFrom(LEADER_HATS).id : "none",
      flag: PARTY_FLAGS[((faction.factionIndex ?? id) + id) % PARTY_FLAGS.length].id,
    });
  }

  function replaceDeadLeader(player) {
    if (!player) return { oldLeader: "", newLeader: "" };
    const oldLeader = player.leader || "Unknown Leader";
    let newLeader = pickFrom(REPLACEMENT_LEADERS);
    for (let tries = 0; tries < 10 && players.some((candidate) => candidate !== player && candidate.leader === newLeader); tries++) {
      newLeader = pickFrom(REPLACEMENT_LEADERS);
    }
    player.leader = newLeader;
    player.leaderDeaths = (player.leaderDeaths || 0) + 1;
    player.leaderProfile = createAiLeaderProfile(player, player.id + player.leaderDeaths + Math.floor(Math.random() * 99));
    return { oldLeader, newLeader };
  }

  function optionsHtml(items, selected) {
    return items.map((item) => '<option value="' + item.id + '"' + (item.id === selected ? " selected" : "") + ">" + escapeHtml(item.label) + "</option>").join("");
  }

  function skinOptionsHtml(selected) {
    return SKIN_PRESETS.map((skin, index) => '<option value="' + skin + '"' + (skin === selected ? " selected" : "") + ">Tone " + (index + 1) + "</option>").join("");
  }

  function partyFlagSvg(factionIndex, flagId, className = "party-flag") {
    const faction = factionForMenu(factionIndex);
    const flag = flagById(flagId);
    const color = faction.color || "#34ff86";
    const dark = mix(color, "#020c06", 0.72);
    const bright = mix(color, "#ffffff", 0.34);
    const motifs = {
      campaign_stripes: `<rect x="0" y="0" width="96" height="12" fill="${color}"/><rect x="0" y="12" width="96" height="12" fill="#e9fff1"/><rect x="0" y="24" width="96" height="12" fill="${dark}"/><circle cx="48" cy="18" r="8" fill="${bright}" stroke="#04160b" stroke-width="2"/>`,
      red_disc: `<rect x="0" y="0" width="96" height="36" fill="#7f1111"/><circle cx="48" cy="18" r="13" fill="#f0eadc"/><path d="M48 8 L51 16 L60 16 L53 21 L56 29 L48 24 L40 29 L43 21 L36 16 L45 16 Z" fill="${dark}"/>`,
      central_star: `<rect x="0" y="0" width="96" height="36" fill="#8b1010"/><path d="M19 8 L22 16 L31 16 L24 21 L27 30 L19 25 L11 30 L14 21 L7 16 L16 16 Z" fill="#ffd76a"/><rect x="40" y="10" width="42" height="4" fill="#ffd76a"/><rect x="40" y="19" width="34" height="4" fill="#ffd76a"/>`,
      hermit_ray: `<rect x="0" y="0" width="96" height="36" fill="#123c8a"/><rect x="0" y="5" width="96" height="6" fill="#f0eadc"/><rect x="0" y="25" width="96" height="6" fill="#f0eadc"/><circle cx="48" cy="18" r="10" fill="#c81f28"/><path d="M48 9 L50 16 L57 16 L51 20 L54 27 L48 23 L42 27 L45 20 L39 16 L46 16 Z" fill="#f0eadc"/>`,
      eagle_seal: `<rect x="0" y="0" width="96" height="36" fill="#7f1111"/><circle cx="48" cy="18" r="13" fill="#f0eadc"/><path d="M48 8 H57 V14 H51 V28 H45 V22 H36 V16 H48 Z" fill="#111111"/><rect x="7" y="7" width="82" height="22" fill="none" stroke="#111111" stroke-width="2" opacity=".55"/>`,
      workers_gear: `<rect x="0" y="0" width="96" height="36" fill="#7a1515"/><circle cx="30" cy="18" r="11" fill="none" stroke="#ffd76a" stroke-width="4"/><rect x="27" y="4" width="6" height="28" fill="#ffd76a"/><path d="M54 9 H81 V15 H54 Z M54 21 H75 V27 H54 Z" fill="#ffd76a"/>`,
      corporate_grid: `<rect x="0" y="0" width="96" height="36" fill="${dark}"/><path d="M0 12 H96 M0 24 H96 M24 0 V36 M48 0 V36 M72 0 V36" stroke="${color}" stroke-width="2" opacity=".75"/><rect x="37" y="9" width="22" height="18" fill="#06140b" stroke="${bright}" stroke-width="2"/>`,
      green_laurel: `<rect x="0" y="0" width="96" height="36" fill="#0c4424"/><circle cx="48" cy="18" r="11" fill="none" stroke="${bright}" stroke-width="3"/><path d="M21 25 C30 14 34 10 45 8 M75 25 C66 14 62 10 51 8" stroke="${color}" stroke-width="4" fill="none"/>`,
    };
    return `<span class="${className}" title="${escapeHtml(flag.label + ": " + flag.desc)}"><svg viewBox="0 0 96 36" aria-hidden="true">${motifs[flag.id] || motifs.campaign_stripes}</svg></span>`;
  }

  function selectMenuParty(index, openPreview) {
    selectedParty = Math.max(0, Math.min(FACTIONS.length - 1, index));
    if (multiplayerState.enabled) multiplayerState.localReady = multiplayerState.host;
    if (isServerLobbyGuest()) multiplayerState.localReady = false;
    renderPartyRoster();
    renderTalentPreview(selectedParty);
    if (newGameButton) newGameButton.textContent = `Start as ${factionForMenu(selectedParty).name}`;
    if (talentPreview) {
      talentPreview.classList.toggle("is-closed", !openPreview);
      talentPreview.style.display = openPreview ? "grid" : "none";
    }
    if (multiplayerState.enabled) {
      publishLobbyPresence("select");
      refreshMultiplayerUi();
    }
    scheduleServerLobbyPlayerUpdate();
  }

  function renderPartyRoster() {
    if (!partyRoster || typeof TALENTS === "undefined") return;
    partyRoster.setAttribute("style", "display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px");
    partyRoster.innerHTML = FACTIONS.map((_, index) => {
      const faction = factionForMenu(index);
      const tree = TALENTS[faction.talentTree];
      const selected = index === selectedParty;
      const cardFlag = selected ? normalizeLeaderProfile(selectedLeaderProfile).flag : PARTY_FLAGS[index % PARTY_FLAGS.length].id;
      return `
        <button class="party-card${selected ? " is-selected" : ""}" type="button" data-party-index="${index}" aria-pressed="${selected}">
          <span class="party-card-visual">
            ${partyFlagSvg(index, cardFlag)}
            <span class="leader-portrait" style="--party:${faction.color};--skin:${faction.portrait.skin};--hair:${faction.portrait.hair};--suit:${faction.portrait.suit};--accent:${faction.portrait.accent};display:block;overflow:hidden">
              ${leaderPortraitSvg(index)}
            </span>
          </span>
          <span class="party-card-copy">
            <strong>${escapeHtml(faction.name)}</strong>
            <span>${faction.leader}</span>
            <em>${tree.name}</em>
          </span>
        </button>
      `;
    }).join("");
  }

  function renderTalentPreview(index) {
    if (!talentPreview || typeof TALENTS === "undefined") return;
    const faction = factionForMenu(index);
    const tree = TALENTS[faction.talentTree];
    if (!tree) return;
    const profile = normalizeLeaderProfile(selectedLeaderProfile);
    selectedLeaderProfile = profile;
    const visual = visualById(profile.hairstyle);
    const hat = LEADER_HATS.find((item) => item.id === profile.hat) || LEADER_HATS[0];
    const flag = flagById(profile.flag);
    const palette = faction.portrait || FACTIONS[index].portrait;
    const tiers = tree.tiers.map((tier, tierIndex) => {
      const nodes = ["left", "right"].map((side) => {
        const opt = tier[side];
        return `
          <div class="menu-talent-node${opt.ult ? " is-ult" : ""}">
            <div><strong>${opt.name}</strong>${opt.ult ? "<span>ULT</span>" : ""}</div>
            <p>${opt.desc}</p>
          </div>
        `;
      }).join('<div class="menu-talent-vs">or</div>');
      return `
        <article class="menu-talent-tier">
          <div class="menu-tier-day">Unlocks at HQ L${TALENT_REQ_LEVEL[tierIndex]}</div>
          <div class="menu-tier-nodes">${nodes}</div>
        </article>
      `;
    }).join("");

    talentPreview.innerHTML = `
      <div class="talent-preview-head">
        <div>
          <span>${faction.full}</span>
          <h2>${faction.leader}</h2>
          <p>${faction.title} - ${tree.name} - ${tree.sub}</p>
          <p>${tree.theme}</p>
        </div>
        <button class="secondary-button" type="button" data-preview-action="close">Close</button>
      </div>
      <label class="party-name-editor">
        <span>Your party name</span>
        <input type="text" data-party-name-input="${index}" maxlength="28" value="${escapeHtml(faction.name)}" placeholder="${escapeHtml(partyNameDraw[index]?.name || FACTIONS[index].name)}">
      </label>
      <section class="leader-customizer" aria-label="Party leader character customization">
        <div class="leader-custom-preview">
          <span class="leader-custom-visual">
            ${partyFlagSvg(index, profile.flag)}
            <span class="leader-portrait" style="--party:${faction.color};--skin:${profile.skin};--hair:${palette.hair};--suit:${palette.suit};--accent:${palette.accent};display:block;overflow:hidden">
              ${leaderPortraitSvg(index, profile)}
            </span>
            <button class="secondary-button leader-random-button" type="button" data-preview-action="randomize" title="Random appearance and flag" aria-label="Random appearance and flag">&#8635;</button>
          </span>
          <div>
            <strong>Leader Appearance</strong>
            <span>${escapeHtml(flag.label)} - ${escapeHtml(visual.label)} - ${escapeHtml(hat.label)}</span>
            <span>${escapeHtml(flag.desc)} - ${escapeHtml(visual.desc)}</span>
            <em>${profile.facialLocked ? "Facial hair locked: " + FACIAL_HAIR.find((item) => item.id === profile.facialHair).label : "Facial hair unlocked"}</em>
          </div>
        </div>
        <div class="leader-custom-controls">
          <label><span>Flag</span><select data-leader-custom="flag">${optionsHtml(PARTY_FLAGS, profile.flag)}</select></label>
          <label><span>Hat</span><select data-leader-custom="hat">${optionsHtml(LEADER_HATS, profile.hat)}</select></label>
          <label><span>Skin</span><select data-leader-custom="skin">${skinOptionsHtml(profile.skin)}</select></label>
          <label><span>Hairstyle</span><select data-leader-custom="hairstyle">${optionsHtml(LEADER_VISUALS, profile.hairstyle)}</select></label>
          <label><span>Facial Hair</span><select data-leader-custom="facialHair" ${profile.facialLocked ? "disabled" : ""}>${optionsHtml(FACIAL_HAIR, profile.facialHair)}</select></label>
        </div>
      </section>
      <div class="menu-talent-tree">${tiers}</div>
      <div class="talent-preview-foot">
        <button class="primary-button" type="button" data-preview-action="start">${escapeHtml(lobbyStartButtonLabel(index))}</button>
      </div>
    `;
    updateLobbyStartButtons();
  }

  function renderRivalTalentViewer(playerId) {
    if (!rivalTalentViewer) return;
    const player = players.find((candidate) => candidate.id === playerId && candidate.id !== HUMAN);
    const tree = player ? TALENTS[player.talentTree] : null;
    if (!player || !tree) {
      rivalTalentViewer.innerHTML = "";
      rivalTalentViewer.classList.remove("is-open");
      rivalTalentViewer.setAttribute("aria-hidden", "true");
      rivalTalentPlayerId = -1;
      return;
    }
    const tiers = tree.tiers.map((tier, tierIndex) => `
      <article class="rival-tier">
        <div class="rival-tier-label">Unlocks at HQ L${TALENT_REQ_LEVEL[tierIndex]}</div>
        <div class="rival-tier-nodes">
          <div class="rival-node">
            <strong>${tier.left.name}${tier.left.ult ? " [ULT]" : ""}</strong>
            <p>${tier.left.desc}</p>
          </div>
          <div class="rival-tier-vs">OR</div>
          <div class="rival-node">
            <strong>${tier.right.name}${tier.right.ult ? " [ULT]" : ""}</strong>
            <p>${tier.right.desc}</p>
          </div>
        </div>
      </article>
    `).join("");
    rivalTalentViewer.innerHTML = `
      <div class="rival-talent-head">
        ${leaderPortraitMarkup(player, "leader-portrait")}
        <div class="rival-talent-copy">
          <strong style="color:${player.color}">${escapeHtml(player.name)}</strong>
          <span>${escapeHtml(player.leader)}</span>
          <em>${escapeHtml(tree.name)} - ${escapeHtml(tree.sub)}</em>
        </div>
        <button class="rival-talent-close" type="button" data-rival-close>ESC</button>
      </div>
      <div class="rival-talent-theme">${escapeHtml(tree.theme)}</div>
      <div class="rival-talent-grid">${tiers}</div>
    `;
    rivalTalentViewer.classList.add("is-open");
    rivalTalentViewer.setAttribute("aria-hidden", "false");
    rivalTalentPlayerId = playerId;
  }

  function openRivalTalentViewer(playerId) {
    renderRivalTalentViewer(playerId);
  }

  function closeRivalTalentViewer() {
    if (!rivalTalentViewer) return;
    rivalTalentViewer.classList.remove("is-open");
    rivalTalentViewer.setAttribute("aria-hidden", "true");
    rivalTalentPlayerId = -1;
  }

  function refreshTalentInterfaces() {
    if (pipOpen) renderPip();
    if (rivalTalentPlayerId >= 0) renderRivalTalentViewer(rivalTalentPlayerId);
  }

  function inspectLeaderPortrait(playerId) {
    if (playerId === HUMAN) {
      closeRivalTalentViewer();
      openPip();
      return;
    }
    openRivalTalentViewer(playerId);
  }

  function leaderPortraitSvg(index, profile = null) {
    const fallbackHair = [
      '<rect x="24" y="18" width="32" height="8" fill="var(--hair)"/><rect x="18" y="28" width="8" height="18" fill="var(--hair)"/><rect x="54" y="28" width="8" height="18" fill="var(--hair)"/>',
      '<rect x="20" y="20" width="40" height="8" fill="var(--hair)"/><rect x="30" y="12" width="20" height="10" fill="var(--hair)"/>',
      '<rect x="18" y="18" width="44" height="10" fill="var(--hair)"/><rect x="18" y="28" width="9" height="22" fill="var(--hair)"/><rect x="53" y="28" width="9" height="22" fill="var(--hair)"/>',
      '<rect x="22" y="16" width="36" height="8" fill="var(--hair)"/><rect x="16" y="24" width="48" height="6" fill="var(--hair)"/>',
    ];
    const p = profile ? normalizeLeaderProfile(profile) : null;
    const hair = p ? ({
      mogul: '<rect x="20" y="18" width="44" height="9" fill="var(--hair)"/><rect x="30" y="10" width="30" height="12" fill="var(--hair)"/><rect x="42" y="7" width="16" height="7" fill="var(--hair)"/>',
      supreme: '<rect x="24" y="11" width="32" height="18" fill="var(--hair)"/><rect x="19" y="28" width="7" height="14" fill="var(--hair)"/><rect x="54" y="28" width="7" height="14" fill="var(--hair)"/>',
      secretary: '<rect x="20" y="19" width="42" height="8" fill="var(--hair)"/><rect x="19" y="27" width="8" height="18" fill="var(--hair)"/><rect x="50" y="25" width="10" height="12" fill="var(--hair)"/>',
      strongman: '<rect x="27" y="20" width="26" height="5" fill="var(--hair)"/><rect x="21" y="28" width="7" height="10" fill="var(--hair)"/><rect x="52" y="28" width="7" height="10" fill="var(--hair)"/>',
      chancellor: '<rect x="18" y="18" width="44" height="9" fill="var(--hair)"/><rect x="17" y="27" width="10" height="27" fill="var(--hair)"/><rect x="53" y="27" width="10" height="27" fill="var(--hair)"/><rect x="26" y="24" width="28" height="8" fill="var(--hair)"/>',
      disruptor: '<rect x="17" y="16" width="12" height="10" fill="var(--hair)"/><rect x="25" y="9" width="16" height="14" fill="var(--hair)"/><rect x="38" y="13" width="18" height="12" fill="var(--hair)"/><rect x="53" y="18" width="10" height="15" fill="var(--hair)"/>',
      anarcho: '<rect x="16" y="15" width="48" height="12" fill="var(--hair)"/><rect x="13" y="27" width="14" height="30" fill="var(--hair)"/><rect x="53" y="27" width="14" height="30" fill="var(--hair)"/><rect x="25" y="10" width="30" height="9" fill="var(--hair)"/>',
      iron_helmet: '<rect x="17" y="15" width="46" height="16" fill="var(--hair)"/><rect x="18" y="31" width="44" height="9" fill="var(--hair)"/><rect x="20" y="40" width="9" height="12" fill="var(--hair)"/><rect x="51" y="40" width="9" height="12" fill="var(--hair)"/>',
      charmer: '<rect x="19" y="19" width="42" height="8" fill="var(--hair)"/><rect x="29" y="12" width="25" height="9" fill="var(--hair)"/><rect x="50" y="25" width="9" height="13" fill="var(--hair)"/>',
      academic: '<rect x="15" y="34" width="10" height="20" fill="var(--hair)"/><rect x="55" y="34" width="10" height="20" fill="var(--hair)"/><rect x="18" y="25" width="9" height="9" fill="var(--hair)"/><rect x="53" y="25" width="9" height="9" fill="var(--hair)"/>',
      orator: '<rect x="22" y="21" width="36" height="5" fill="var(--hair)"/><rect x="20" y="26" width="40" height="5" fill="var(--hair)"/>',
      generalissimo: '<rect x="18" y="17" width="44" height="10" fill="var(--hair)"/><rect x="24" y="10" width="32" height="7" fill="var(--accent)"/><rect x="17" y="27" width="10" height="18" fill="var(--hair)"/><rect x="53" y="27" width="9" height="13" fill="var(--hair)"/>',
      demagogue: '<rect x="17" y="19" width="46" height="7" fill="var(--hair)"/><rect x="18" y="26" width="12" height="11" fill="var(--hair)"/><rect x="42" y="16" width="18" height="5" fill="var(--hair)"/>',
      steel: '<rect x="18" y="17" width="44" height="10" fill="var(--hair)"/><rect x="22" y="10" width="36" height="9" fill="var(--hair)"/><rect x="18" y="27" width="9" height="15" fill="var(--hair)"/><rect x="53" y="27" width="9" height="15" fill="var(--hair)"/>',
    }[p.hairstyle] || fallbackHair[index % fallbackHair.length]) : fallbackHair[index % fallbackHair.length];
    const facial = p ? ({
      toothbrush: '<rect x="35" y="50" width="10" height="5" fill="var(--hair)"/>',
      walrus: '<rect x="26" y="49" width="28" height="7" fill="var(--hair)"/><rect x="28" y="55" width="9" height="5" fill="var(--hair)"/><rect x="43" y="55" width="9" height="5" fill="var(--hair)"/>',
      mustache: '<rect x="29" y="50" width="22" height="5" fill="var(--hair)"/>',
      goatee: '<rect x="34" y="52" width="12" height="4" fill="var(--hair)"/><rect x="36" y="58" width="8" height="8" fill="var(--hair)"/>',
      beard: '<rect x="24" y="52" width="32" height="13" fill="var(--hair)" opacity="0.92"/>',
    }[p.facialHair] || "") : "";
    const hat = p ? ({
      keffiyeh: '<rect x="18" y="14" width="44" height="18" fill="#e9efe5"/><rect x="15" y="26" width="12" height="34" fill="#e9efe5"/><rect x="53" y="26" width="12" height="34" fill="#e9efe5"/><rect x="20" y="18" width="40" height="5" fill="var(--party)" opacity="0.78"/><rect x="25" y="14" width="5" height="46" fill="var(--party)" opacity="0.46"/><rect x="49" y="14" width="5" height="46" fill="var(--party)" opacity="0.46"/>',
      campaign_cap: '<rect x="22" y="15" width="36" height="13" fill="var(--party)"/><rect x="54" y="24" width="16" height="5" fill="var(--party)"/><rect x="34" y="18" width="12" height="7" fill="var(--accent)"/>',
      fedora: '<rect x="14" y="22" width="52" height="6" fill="var(--hair)"/><rect x="23" y="12" width="34" height="14" fill="var(--hair)"/><rect x="24" y="21" width="32" height="4" fill="var(--accent)"/>',
      beret: '<rect x="17" y="15" width="43" height="14" fill="var(--party)"/><rect x="48" y="11" width="11" height="7" fill="var(--party)"/><rect x="33" y="13" width="6" height="4" fill="var(--accent)"/>',
      cowboy: '<rect x="11" y="22" width="58" height="6" fill="#8b5a2b"/><rect x="25" y="10" width="30" height="17" fill="#9b6a36"/><rect x="29" y="21" width="22" height="4" fill="var(--accent)"/>',
      military_cap: '<rect x="20" y="14" width="40" height="13" fill="#1f3b2d"/><rect x="55" y="24" width="14" height="5" fill="#1f3b2d"/><rect x="36" y="17" width="8" height="7" fill="var(--accent)"/>',
      visor: '<rect x="20" y="17" width="40" height="7" fill="var(--party)"/><rect x="51" y="23" width="18" height="5" fill="var(--party)"/><rect x="25" y="13" width="30" height="4" fill="var(--accent)"/>',
    }[p.hat] || "") : "";
    const torsoX = p?.gender === "fem" ? 21 : p?.gender === "masc" ? 16 : 18;
    const torsoW = p?.gender === "fem" ? 38 : p?.gender === "masc" ? 48 : 44;
    return `
      <svg viewBox="0 0 80 96" aria-hidden="true">
        <rect x="6" y="6" width="68" height="84" fill="rgba(0,0,0,0.28)" stroke="var(--party)" stroke-width="3"/>
        <rect x="${torsoX}" y="60" width="${torsoW}" height="24" fill="var(--suit)"/>
        <rect x="32" y="60" width="16" height="24" fill="var(--accent)" opacity="0.85"/>
        <rect x="22" y="24" width="36" height="38" fill="var(--skin)"/>
        ${hair}
        ${hat}
        <rect x="29" y="40" width="5" height="5" fill="#06120c"/>
        <rect x="46" y="40" width="5" height="5" fill="#06120c"/>
        ${facial}
        <rect x="34" y="53" width="12" height="4" fill="#7a2f2f"/>
        <rect x="12" y="78" width="56" height="6" fill="var(--party)"/>
      </svg>
    `;
  }

  function makePartyNameDraw() {
    const used = new Set();
    return FACTIONS.map((_, index) => {
      const pool = PARTY_NAME_BANK[index] || PARTY_NAME_BANK.flat();
      let pick = pool[Math.floor(Math.random() * pool.length)];
      for (let tries = 0; tries < 12 && used.has(pick.name); tries++) {
        pick = pool[Math.floor(Math.random() * pool.length)];
      }
      used.add(pick.name);
      return pick;
    });
  }

  function factionForMenu(index) {
    const faction = FACTIONS[index];
    const identity = partyNameDraw[index] || { name: faction.name, full: faction.full, source: "RIGGED default" };
    const customName = customPartyNames[index] || "";
    return {
      ...faction,
      name: customName || identity.name,
      full: identity.full,
      parodyOf: identity.source,
    };
  }

  function cleanPartyName(value) {
    return String(value || "").replace(/[<>`]/g, "").replace(/\s+/g, " ").trimStart().slice(0, 28);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function colorizeAlertMessage(message) {
    let html = escapeHtml(message);
    const names = players
      .filter((player) => player && player.name)
      .map((player) => ({ name: escapeHtml(player.name), color: player.color }))
      .sort((a, b) => b.name.length - a.name.length);
    names.forEach((entry) => {
      const pattern = new RegExp("(^|[^\\w])(" + escapeRegExp(entry.name) + ")(?=$|[^\\w])", "g");
      html = html.replace(pattern, (_, prefix, name) =>
        prefix + '<span class="log-party-name" style="color:' + entry.color + '">' + name + '</span>'
      );
    });
    return html;
  }

  function loop(now) {
    if (!gameStarted) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    updateKeyboardPan(dt);
    updatePlayerPosition(); // Sync position to multiplayer server
    if (!paused && !matchOver && !pipOpen) {
      if (isServerLobbyGuest()) updateGuestPresentation(dt);
      else update(Math.min(0.5, dt));
    }
    if (now - lastUi > 180) {
      updateUi();
      lastUi = now;
    }
    if (now - lastBgmCheck > 1200) {
      refreshBgm();
      lastBgmCheck = now;
    }
    render();
    requestAnimationFrame(loop);
  }

  function updateKeyboardPan(dt) {
    if (!gameStarted || pipOpen || settingsOpen) return;
    const dx = (mapPanKeys.d ? 1 : 0) - (mapPanKeys.a ? 1 : 0);
    const dy = (mapPanKeys.s ? 1 : 0) - (mapPanKeys.w ? 1 : 0);
    if (dx || dy) {
      const length = Math.hypot(dx, dy) || 1;
      const speed = 360 * Camera.zoom * dt;
      Camera.offsetX -= (dx / length) * speed;
      Camera.offsetY -= (dy / length) * speed;
      clampCamera();
    }
    const zoomDir = (mapPanKeys.q ? 1 : 0) - (mapPanKeys.e ? 1 : 0);
    if (zoomDir) {
      const screen = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
      const world = screenToWorld(screen);
      const zoomFactor = Math.pow(1.9, zoomDir * dt);
      Camera.zoom = Math.max(Camera.minZoom, Math.min(Camera.maxZoom, Camera.zoom * zoomFactor));
      Camera.offsetX = screen.x - world.x * Camera.zoom;
      Camera.offsetY = screen.y - world.y * Camera.zoom;
      clampCamera();
    }
  }

  function togglePause() {
    if (!gameStarted || matchOver) return;
    if (routeGuestGameCommand('togglePause', [])) {
      showToast('Pause request sent to host.', 'compact');
      return;
    }
    if (settingsOpen) closeSettingsPanel();
    if (paused && !localPauseRequested) {
      showToast('Only the player who paused can resume the match.', 'compact');
      return;
    }
    localPauseRequested = !localPauseRequested;
    paused = localPauseRequested;
    pauseButton.disabled = false;
    pauseButton.textContent = localPauseRequested ? 'Resume Everyone' : 'Pause';
    lastPositionSync = 0;
    updatePlayerPosition();
    updateUi(true);
  }

  function hydrateSettingsControls() {
    if (reporterVolumeSlider) reporterVolumeSlider.value = String(Math.round(reporterVolume * 100));
    if (reporterVolumeValue) reporterVolumeValue.textContent = Math.round(reporterVolume * 100) + "%";
    if (musicVolumeSlider) musicVolumeSlider.value = String(Math.round(musicVolume * 100));
    if (musicVolumeValue) musicVolumeValue.textContent = Math.round(musicVolume * 100) + "%";
    if (sfxVolumeSlider) sfxVolumeSlider.value = String(Math.round(sfxVolume * 100));
    if (sfxVolumeValue) sfxVolumeValue.textContent = Math.round(sfxVolume * 100) + "%";
    if (colorBlindToggle) colorBlindToggle.checked = colorBlindMode;
    document.body.classList.toggle("color-blind-mode", colorBlindMode);
  }

  function updateSoundVolume() {
    reporterVolume = Math.max(0, Math.min(1, Number(reporterVolumeSlider?.value ?? 70) / 100));
    musicVolume = Math.max(0, Math.min(1, Number(musicVolumeSlider?.value ?? 70) / 100));
    sfxVolume = Math.max(0, Math.min(1, Number(sfxVolumeSlider?.value ?? 70) / 100));
    localStorage.setItem("riggedReporterVolume", String(Math.round(reporterVolume * 100)));
    localStorage.setItem("riggedMusicVolume", String(Math.round(musicVolume * 100)));
    localStorage.setItem("riggedSfxVolume", String(Math.round(sfxVolume * 100)));
    if (reporterVolumeValue) reporterVolumeValue.textContent = Math.round(reporterVolume * 100) + "%";
    if (musicVolumeValue) musicVolumeValue.textContent = Math.round(musicVolume * 100) + "%";
    if (sfxVolumeValue) sfxVolumeValue.textContent = Math.round(sfxVolume * 100) + "%";
    updateBgmVolume();
  }

  function toggleColorBlindMode() {
    colorBlindMode = !!colorBlindToggle?.checked;
    localStorage.setItem("riggedColorBlindMode", colorBlindMode ? "1" : "0");
    applyColorBlindMode();
  }

  function openSettingsPanel() {
    if (!gameStarted || matchOver) return;
    settingsWasPaused = paused;
    settingsOpen = true;
    paused = true;
    hydrateSettingsControls();
    if (pauseOverlay) pauseOverlay.classList.add("is-settings");
    updateUi(true);
  }

  function closeSettingsPanel() {
    if (!settingsOpen) return;
    settingsOpen = false;
    paused = settingsWasPaused;
    if (pauseOverlay) pauseOverlay.classList.remove("is-settings");
    updateUi(true);
  }

  function partyColor(factionIndex) {
    return colorBlindMode
      ? COLOR_BLIND_PALETTE[factionIndex % COLOR_BLIND_PALETTE.length].color
      : FACTIONS[factionIndex]?.color || FACTION_VISUALS.default.color;
  }

  function partyGlow(factionIndex) {
    return colorBlindMode
      ? COLOR_BLIND_PALETTE[factionIndex % COLOR_BLIND_PALETTE.length].glow
      : FACTION_VISUALS[FACTIONS[factionIndex]?.talentTree]?.glow || FACTION_VISUALS.default.glow;
  }

  function colorDistance(a, b) {
    const ar = parseHex(a);
    const br = parseHex(b);
    return Math.hypot(ar[0] - br[0], ar[1] - br[1], ar[2] - br[2]);
  }

  function colorsOverlap(a, b) {
    return colorDistance(a, b) < 92;
  }

  function assignDistinctPartyColors() {
    if (!players.length) return;
    const human = players[HUMAN];
    if (!human) return;
    human.color = partyColor(human.factionIndex);
    human.glow = partyGlow(human.factionIndex);
    const used = [human.color];
    players.forEach((player) => {
      if (!player || player.id === HUMAN) return;
      const candidates = [
        { color: partyColor(player.factionIndex), glow: partyGlow(player.factionIndex) },
        ...DISTINCT_BOT_COLORS,
        ...COLOR_BLIND_PALETTE,
      ];
      const picked = candidates.find((candidate) =>
        !colorsOverlap(candidate.color, human.color) &&
        !used.some((color) => colorsOverlap(candidate.color, color))
      ) || candidates.find((candidate) => !colorsOverlap(candidate.color, human.color)) || candidates[0];
      player.color = picked.color;
      player.glow = picked.glow;
      used.push(picked.color);
    });
  }

  function applyColorBlindMode() {
    document.body.classList.toggle("color-blind-mode", colorBlindMode);
    players.forEach((player) => {
      if (!player) return;
      player.color = partyColor(player.factionIndex);
      player.glow = partyGlow(player.factionIndex);
    });
    assignDistinctPartyColors();
    updateUi(true);
    render();
  }

  function update(dt) {
    if (phase === "base") {
      baseTimer = Math.max(0, baseTimer - dt);
      players.forEach((player) => {
        if (!player.isBot || player.homeBase >= 0) return;
        player.basePickDelay -= dt;
        if (player.basePickDelay <= 0) chooseHomeBase(player.id, chooseAiBase(player.id));
      });
      if (baseTimer <= 0) finalizeHomeBases();
      return;
    }

    elapsed += dt;
    newsTimer = Math.max(0, newsTimer - dt);
    tickClickbait(dt);
    channels.forEach((channel) => {
      channel.pulse = Math.max(0, channel.pulse - dt * 2.2);
    });
    if (elapsed >= nextNewsAt) {
      triggerBreakingNews();
      nextNewsAt += NEWS_INTERVAL + Math.random() * 18;
    }

    players.forEach((player) => {
      player.locked = Math.max(0, player.locked - dt);
      player.heat = Math.max(0, player.heat - dt * 0.32);
      player.signalLeakBoost = Math.max(0, (player.signalLeakBoost || 0) - dt);
      tickFunding(player, dt);
      tickAction(player, dt);
      tickPassive(player, dt);
      if (player.isBot) tickAi(player, dt);
    });
    tickMissions(dt);
    tickActionEffects(dt);

    states.forEach((state) => {
      state.activePulse = Math.max(0, state.activePulse - dt * 2);
      if (state.cashFreeze) {
        Object.keys(state.cashFreeze).forEach((playerId) => {
          state.cashFreeze[playerId] = Math.max(0, state.cashFreeze[playerId] - dt);
          if (state.cashFreeze[playerId] <= 0) delete state.cashFreeze[playerId];
        });
      }
      state.sabotageCooldown = Math.max(0, (state.sabotageCooldown || 0) - dt);
    });

    checkWinCondition();
    if (currentMatchMode.timed && elapsed >= currentMatchMode.seconds) finishElection();
  }

  // The host owns gameplay rules, but guests still advance visual-only timers
  // between snapshots so action icons and countdown effects cannot freeze.
  function updateGuestPresentation(dt) {
    elapsed += dt;
    players.forEach((player) => {
      if (!player?.action) return;
      player.action.left = Math.max(0, Number(player.action.left || 0) - dt);
      if (player.action.vulnerableLeft !== undefined) {
        player.action.vulnerableLeft = Math.max(0, Number(player.action.vulnerableLeft || 0) - dt);
      }
      if (player.action.left <= 0) player.action = null;
    });
    missions.forEach((mission) => {
      mission.left = Math.max(0, Number(mission.left || 0) - dt);
    });
    missions = missions.filter((mission) => mission.left > 0);
    actionEffects.forEach((effect) => {
      effect.left = Math.max(0, Number(effect.left || 0) - dt);
    });
    actionEffects = actionEffects.filter((effect) => effect.left > 0);
    states.forEach((state) => {
      state.activePulse = Math.max(0, Number(state.activePulse || 0) - dt * 2);
    });
  }

  function chooseHomeBase(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('chooseHomeBase', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || player.homeBase >= 0 || phase !== "base") return false;
    const alreadyTaken = players.some((candidate) => candidate.homeBase === stateIndex);
    if (alreadyTaken) {
      if (playerId === HUMAN) showToast(`${state.name} already has a home base.`);
      return false;
    }
    player.homeBase = stateIndex;
    player.mainBaseLevel = 1;
    state.activePulse = 1;
    addAlert(`${player.name} selected ${state.name} as home base.`);
    if (playerId === HUMAN) broadcast(regionChannelIndex(state.region), `${player.name} plants campaign headquarters in ${state.name}. The first local cameras are rolling.`);
    return true;
  }

  function finalizeHomeBases() {
    players.forEach((player) => {
      if (player.homeBase < 0) {
        const picked = chooseAiBase(player.id);
        if (picked >= 0) chooseHomeBase(player.id, picked);
      }
    });
    players.forEach((player) => {
      const state = states[player.homeBase];
      if (!state) return;
      state.activePulse = 1;
    });
    phase = "play";
    elapsed = 0;
    nextNewsAt = NEWS_INTERVAL;
    broadcast(0, "The base draft is over. Campaign operations are now live across all 50 states.");
    addAlert("Campaign live. Right-click states for actions; hover states to inspect influence.");
    refreshBgm();
  }

  function chooseAiBase(playerId) {
    const preferred = {
      west: ["CA", "WA", "AZ", "CO", "AK", "HI"],
      south: ["TX", "FL", "GA", "NC"],
      northeast: ["NY", "PA", "MA", "NJ"],
      midwest: ["IL", "OH", "MI", "WI"],
      sunbelt: ["FL", "AZ", "NV", "TX"],
    }[players[playerId].region] || ["TX", "CA", "NY", "FL"];
    const openPreferred = preferred
      .map((abbr) => states.findIndex((state) => state.abbr === abbr))
      .filter((index) => index >= 0 && !players.some((player) => player.homeBase === index));
    if (openPreferred.length > 0) return openPreferred[Math.floor(Math.random() * openPreferred.length)];
    const open = states.filter((state) => !players.some((player) => player.homeBase === state.index));
    if (open.length > 0) return open[Math.floor(Math.random() * open.length)].index;
    return states[selectedState]?.index ?? 0;
  }

  function tickAction(player, dt) {
    if (!player.action) return;
    player.action.left -= dt;
    const state = states[player.action.state];
    const speechBoost = news?.effect === "speech" && newsTimer > 0 ? 1.35 : 1;

    if (player.action.vulnerableLeft !== undefined) player.action.vulnerableLeft = Math.max(0, player.action.vulnerableLeft - dt);
    if (player.action.type === "speech") {
      const echoMult = hasTalent(player, "echo_chamber") ? 1.05 : 1;
      const modelPollingMult = hasTalent(player, "model_polling") && state.ev >= 10 ? 1.08 : 1;
      const hypeMult = player.action.hypeBoost || 1;
      const siphonMult = 1;
      applyInfluenceGain(state, player.id, SPEECH_RATE * player.speechBias * speechBoost * echoMult * modelPollingMult * hypeMult, dt, true, siphonMult);
      state.activePulse = 1;
    }
    if (player.action.left <= 0) {
      const finishedType = player.action.type;
      if (finishedType === "speech" && hasTalent(player, "hype_train")) player.hypeNext = true;
      if (finishedType === "speech" && hasTalent(player, "great_awakening")) splashAdjacentInfluence(player, state.index, 3);
      addAlert(`${player.name} finished ${labelAction(finishedType)} in ${state.name}.`);
      player.action = null;
    }
  }

  function tickFunding(player, dt) {
    if (player.mainBaseLevel > 0) {
      player.cash += hqIncomeRate(player) * dt;
    }
    player.cash += (fundingPerDay(player) / CAMPAIGN_DAY_SECONDS) * dt;
    let policeCount = 0;
    states.forEach((st) => { if (st.police[player.id]) policeCount++; });
    if (policeCount > 0) {
      player.cash -= policeUpkeepPerTick(player, policeCount, dt);
      if (player.cash < 0) player.cash = 0;
      if (policeAtRisk(player)) {
        player.policeShortageTime = (player.policeShortageTime || 0) + dt;
        if (player.policeShortageTime >= CAMPAIGN_DAY_SECONDS * 2) {
          player.policeShortageTime -= CAMPAIGN_DAY_SECONDS * 2;
          const lostState = removeRandomPoliceProtection(player);
          if (lostState) {
            addAlert(player.name + " could not afford police upkeep for 2 days and lost protection in " + lostState.name + ".");
            if (player.id === HUMAN) showToast("Police protection lost in " + lostState.abbr + " - upkeep ran dry.");
          } else {
            player.policeShortageTime = 0;
          }
        }
      } else {
        player.policeShortageTime = 0;
      }
    } else {
      player.policeShortageTime = 0;
    }
  }

  function tickPassive(player, dt) {
    states.forEach((state) => {
      const level = officeLevel(state, player.id);
      if (level > 0) {
        applyInfluenceGain(state, player.id, level * AD_HUB_RATE, dt, false);
        state.activePulse = 1;
      }
    });
    channels.forEach((channel) => {
      if (channel.owner !== player.id) return;
      states.forEach((state) => {
        if (stateInChannelCoverage(state, channel)) {
          const signalLeak = player.signalLeakBoost > 0 ? 1.25 : 1;
          const channelRate = (CHANNEL_INFLUENCE_RATE + state.ev * 0.0012)
            * (hasTalent(player, "media_magnate") ? 1.4 : 1)
            * (hasTalent(player, "trend_engine") ? 1.15 : 1)
            * signalLeak;
          applyInfluenceGain(state, player.id, channelRate, dt, false);
          state.activePulse = Math.max(state.activePulse, 0.35);
        }
      });
    });
  }

  function tickMissions(dt) {
    missions.forEach((mission) => {
      mission.left -= dt;
      states[mission.state].activePulse = 1;
    });
    const finished = missions.filter((mission) => mission.left <= 0);
    missions = missions.filter((mission) => mission.left > 0);
    finished.forEach((mission) => completeMission(mission));
  }

  function completeMission(mission) {
    const player = players[mission.player];
    const state = states[mission.state];
    if (!player || !state) return;
    if (mission.type === "adDeploy") {
      if (officeLevel(state, player.id) <= 0) {
        state.offices[player.id] = 1;
        state.activePulse = 1;
        addAlert(`${player.name} deployed a Level 1 District Office in ${state.name}.`);
        if (player.id === HUMAN) showToast(`District Office complete: ${state.abbr} is now Level 1.`);
      }
      return;
    }
    if (mission.type === "officeUpgrade") {
      const nextLevel = Math.max(2, mission.level || 2);
      if (officeLevel(state, player.id) < nextLevel) {
        state.offices[player.id] = nextLevel;
        state.activePulse = 1;
        addAlert(`${player.name} upgraded a District Office to Level ${nextLevel} in ${state.name}.`);
        if (hasTalent(player, "cascade_effect")) splashAdjacentInfluence(player, state.index, 2);
        if (player.id === HUMAN) showToast(`District Office upgrade complete: ${state.abbr} is now Level ${nextLevel}.`);
      }
      return;
    }
    if (mission.type === "baseUpgrade") {
      player.mainBaseLevel = mission.level;
      state.activePulse = 1;
      addAlert(`${player.name} completed Main Base upgrade to Level ${mission.level} in ${state.name}.`);
      if (player.id === HUMAN) showToast(`HQ upgrade complete: Level ${mission.level} online.`);
      return;
    }
    if (mission.type === "sabotage") {
      completeSabotageOperation(mission);
      return;
    }
    const target = players[mission.target];
    if (!target) return;
    if (mission.type === "riot") {
      if (states[mission.state].police[target.id]) {
        if (target.cash >= POLICE_RIOT_BLOCK_COST) {
          target.cash -= POLICE_RIOT_BLOCK_COST;
          addAlert(player.name + "'s riot in " + state.name + " was suppressed by " + target.name + "'s police for " + formatMoney(POLICE_RIOT_BLOCK_COST) + ".");
          if (player.id === HUMAN) showToast("Riot blocked: " + target.name + " paid police " + formatMoney(POLICE_RIOT_BLOCK_COST) + ".");
          if (target.id === HUMAN) showToast("Police response complete: riot blocked in " + state.abbr + " for " + formatMoney(POLICE_RIOT_BLOCK_COST) + ".");
          return;
        }
        states[mission.state].police[target.id] = false;
        addAlert(target.name + " could not pay " + formatMoney(POLICE_RIOT_BLOCK_COST) + " for police response in " + state.name + ". Police withdrew and the riot broke through.");
        if (player.id === HUMAN) showToast("Riot broke through: " + target.name + " could not pay police. Protection removed.");
        if (target.id === HUMAN) showToast("Police failed: could not pay " + formatMoney(POLICE_RIOT_BLOCK_COST) + ". Protection removed in " + state.abbr + ".");
      }
      const affected = players
        .filter((candidate) => candidate.id !== player.id && officeLevel(state, candidate.id) > 0);
      if (affected.length) {
        const results = [];
        affected.forEach((candidate) => {
          const level = officeLevel(state, candidate.id);
          if (level <= 1) {
            state.offices[candidate.id] = 0;
            results.push(candidate.name + " L1 base wiped out");
          } else {
            state.offices[candidate.id] = level - 1;
            results.push(candidate.name + " base dropped to L" + (level - 1));
          }
          if (hasTalent(candidate, "decentralized_hive") || hasTalent(candidate, "backlash_cells")) {
            state.cashFreeze[player.id] = Math.max(state.cashFreeze[player.id] || 0, 3 * CAMPAIGN_DAY_SECONDS);
            addAlert(candidate.name + "'s backlash cells froze " + player.name + "'s cash flow in " + state.name + " for 3 days.");
          }
        });
        if (hasTalent(player, "strike_fund")) {
          const refund = Math.round((mission.cost || 0) * 0.5);
          if (refund > 0) {
            player.cash += refund;
            addAlert(player.name + "'s Strike Fund recovered " + formatMoney(refund) + " after the riot in " + state.name + ".");
            results.push("refunded " + formatMoney(refund));
          }
        }
        state.activePulse = 1;
        addAlert(player.name + "'s riot hit " + state.name + ": " + results.join("; ") + ".");
        if (player.id === HUMAN) showToast("Riot landed in " + state.abbr + ": " + results.join("; ") + ".");
        broadcast(regionChannelIndex(state.region), "Violent unrest in " + state.name + " battered rival campaign outposts, knocking weaker bases offline and downgrading the rest.");
      } else if (player.id === HUMAN) {
        showToast("Riot landed in " + state.abbr + ": no rival District Office remained.");
      }
      return;
    }
  }

  function tickActionEffects(dt) {
    actionEffects.forEach((effect) => { effect.left -= dt; });
    actionEffects = actionEffects.filter((effect) => effect.left > 0);
  }

  function applyInfluenceGain(state, playerId, rate, dt, canSiphon, siphonMult = 1) {
    const efficiency = influenceEfficiency(adjustedInfluence(state, playerId));
    const amount = rate * efficiency * dt;
    const undecided = undecidedInfluence(state);
    if (undecided > 0) {
      state.influence[playerId] = clampInfluence(state.influence[playerId] + Math.min(amount, undecided));
      return;
    }
    if (!canSiphon) return;
    const target = strongestRivalByInfluence(playerId, state);
    if (!target) return;
    const floor = influenceFloor(target, state);
    const siphon = Math.min(SPEECH_RIVAL_RATE * efficiency * dt * siphonMult, Math.max(0, state.influence[target.id] - floor));
    state.influence[target.id] = clampInfluence(Math.max(floor, state.influence[target.id] - siphon));
    state.influence[playerId] = clampInfluence(state.influence[playerId] + siphon);
  }

  function influenceFloor(player, state) {
    const officeFloor = miniBaseDefense(officeLevel(state, player.id));
    const ironCurtainFloor = hasTalent(player, "iron_curtain") && player.homeBase === state.index && player.mainBaseLevel >= 3 ? 30 : 0;
    return Math.max(officeFloor, ironCurtainFloor);
  }

  function splashAdjacentInfluence(player, stateIndex, amount = 3) {
    const origin = states[stateIndex];
    if (!origin) return;
    const nearby = states
      .filter((state) => state.index !== stateIndex && Math.hypot((state.cx || 0) - (origin.cx || 0), (state.cy || 0) - (origin.cy || 0)) < 92)
      .sort((a, b) => Math.hypot((a.cx || 0) - (origin.cx || 0), (a.cy || 0) - (origin.cy || 0)) - Math.hypot((b.cx || 0) - (origin.cx || 0), (b.cy || 0) - (origin.cy || 0)))
      .slice(0, 5);
    nearby.forEach((state) => {
      const room = undecidedInfluence(state);
      state.influence[player.id] = clampInfluence(state.influence[player.id] + Math.min(amount, room));
      state.activePulse = 1;
    });
    if (nearby.length) addAlert(player.name + "'s Great Awakening spilled into " + nearby.map((state) => state.abbr).join(", ") + ".");
  }

  function influenceEfficiency(value) {
    if (value <= 30) return 1;
    if (value <= 60) return 0.5;
    return 0.25;
  }

  function strongestRivalByInfluence(playerId, state) {
    return players
      .filter((player) => player.id !== playerId && adjustedInfluence(state, player.id) > 0)
      .sort((a, b) => adjustedInfluence(state, b.id) - adjustedInfluence(state, a.id))[0] || null;
  }

  function tickAi(player, dt) {
    pipMaybePick(player);
    player.aiDelay -= dt;
    player.insetDelay -= dt;
    if (player.locked > 0 || player.action || player.aiDelay > 0) return;
    const rules = AI_RULES[difficultyInput.value];
    if (player.mainBaseLevel >= 1 && player.mainBaseLevel < 3 && Math.random() < 0.5) upgradeMainBase(player.id);
    const speakingRival = players.find((c) => c.id !== player.id && isSpeaking(c) && canInterruptAction(c));
    if (speakingRival && player.cash >= assassinateCost(player, speakingRival) && Math.random() < 0.05) {
      if (assassinate(player.id, speakingRival.action.state)) { player.aiDelay = AI_RULES[difficultyInput.value].delay + Math.random() * 2; return; }
    }
    const channelIndex = bestChannelForPlayer(player.id);
    if (player.cash > channelTakeoverCost(player.id, channels[channelIndex]) + 1200 && Math.random() < 0.14) {
      if (buyChannel(player.id, channelIndex)) {
        player.aiDelay = rules.delay + Math.random();
        return;
      }
    }
    const stateIndex = player.insetDelay <= 0 ? chooseAiInsetState(player.id) : chooseAiState(player.id);
    if (player.insetDelay <= 0) player.insetDelay = 24 + Math.random() * 18;
    const roll = Math.random();
    const officeLvl = officeLevel(states[stateIndex], player.id);
    if (officeLvl > 0 && officeLvl < MINI_BASE_MAX_LEVEL && Math.random() < 0.32) {
      upgradeMiniBase(player.id, stateIndex);
    } else if (roll < rules.sabotage + rules.ad && player.cash >= adHubCost(player) && officeLvl < 1) {
      placeAdHub(player.id, stateIndex);
    } else {
      startAction(player.id, "speech", stateIndex);
    }
    player.aiDelay = rules.delay + Math.random() * 1.5;
  }

  function activeSpeechInState(stateIndex) {
    return players.find((candidate) =>
      candidate.action &&
      candidate.action.type === "speech" &&
      candidate.action.state === stateIndex
    ) || null;
  }

  function assassinatedToday(player) {
    return !!player &&
      player.assassinDay === Math.floor(campaignDaysElapsed()) &&
      (player.assassinationsToday || 0) > 0;
  }


  function canUseCampaignActions(player, playerId) {
    if (!player) return false;
    if (player.locked > 0) {
      if (playerId === HUMAN) showToast("Your party is in assassination blackout for " + formatCampaignDuration(player.locked) + ".");
      return false;
    }
    return true;
  }
  function startAction(playerId, type, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('startAction', [type, stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || phase !== "play" || paused || matchOver || !canUseCampaignActions(player, playerId) || player.action || !state) {
      if (playerId === HUMAN && phase === "base") showToast("Pick a home base first.");
      return false;
    }
    const times = { speech: SPEECH_SECONDS };
    const costs = { speech: 0 };
    if (!times[type]) {
      if (playerId === HUMAN) showToast("Choose a campaign action.");
      return false;
    }
    if (type === "speech") {
      const currentSpeaker = activeSpeechInState(stateIndex);
      if (currentSpeaker) {
        if (playerId === HUMAN) showToast(`${state.abbr} already has a live public speech.`);
        return false;
      }
    }
    if (player.cash < costs[type]) {
      if (playerId === HUMAN) showToast(`Need ${formatMoney(costs[type])}.`);
      return false;
    }
    player.cash -= costs[type];
    const vulnerableLeft = type === "speech" ? times[type] * (hasTalent(player, "executive_immunity") ? 0.5 : 1) : undefined;
    const hypeBoost = type === "speech" && player.hypeNext ? 1.4 : 1;
    if (type === "speech") player.hypeNext = false;
    player.action = { type, state: stateIndex, left: times[type], total: times[type], vulnerableLeft, hypeBoost };
    state.activePulse = 1;
    addAlert(`${player.name} started ${labelAction(type)} in ${state.name}.`);
    if (type === "speech") {
      triggerClickbait("MINDSHARE_CAST", {
        player: playerId,
        state: stateIndex,
        stateName: state.name,
        factionName: player.name,
        heat: 10,
      });
    }
    return true;
  }

  function placeAdHub(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('placeAdHub', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (phase !== "play" || paused || matchOver || !player || !state || !canUseCampaignActions(player, playerId)) {
      if (playerId === HUMAN && phase === "base") showToast("Pick a home base first.");
      return false;
    }
    if (officeLevel(state, playerId) >= 1) {
      if (playerId === HUMAN) showToast(`${state.abbr} already has your District Office.`);
      return false;
    }
    if (missions.some((mission) => mission.type === "adDeploy" && mission.player === playerId && mission.state === stateIndex)) {
      if (playerId === HUMAN) showToast(`${state.abbr} District Office is already deploying.`);
      return false;
    }
    const cost = adHubCost(player);
    if (player.cash < cost) {
      if (playerId === HUMAN) showToast(`Need ${formatMoney(cost)}.`);
      return false;
    }
    player.cash -= cost;
    const deploySeconds = districtOfficeBuildTime(player, AD_HUB_DEPLOY_SECONDS);
    missions.push({ type: "adDeploy", player: playerId, state: stateIndex, cost, left: deploySeconds, total: deploySeconds });
    if (hasTalent(player, "compliance_forms")) {
      const gain = Math.min(5, undecidedInfluence(state));
      if (gain > 0) {
        state.influence[playerId] = clampInfluence((state.influence[playerId] || 0) + gain);
        if (playerId === HUMAN) showToast("Compliance Forms filed: +" + gain + "% influence in " + state.abbr + ".");
      }
    }
    state.activePulse = 1;
    addAlert(`${player.name} started deploying a District Office in ${state.name}.`);
    triggerClickbait("DEPLOY_REPEATER", {
      player: playerId,
      state: stateIndex,
      stateName: state.name,
      factionName: player.name,
      heat: 6,
      level: "MEDIUM",
    });
    return true;
  }

  function upgradeMiniBase(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('upgradeMiniBase', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || paused || matchOver || !canUseCampaignActions(player, playerId)) return false;
    const currentLevel = officeLevel(state, playerId);
    if (currentLevel <= 0) {
      if (playerId === HUMAN) showToast("Build a District Office here first.");
      return false;
    }
    if (currentLevel >= MINI_BASE_MAX_LEVEL) {
      if (playerId === HUMAN) showToast("District Office already at maximum Level 3.");
      return false;
    }
    if (missions.some((mission) => mission.type === "officeUpgrade" && mission.player === playerId && mission.state === stateIndex)) {
      if (playerId === HUMAN) showToast(`${state.abbr} District Office upgrade already underway.`);
      return false;
    }
    const nextLevel = currentLevel + 1;
    const req = miniBaseUpgradeReq(player, nextLevel);
    const localInf = state.influence[playerId] || 0;
    if (!req || player.cash < req.cash || localInf < req.infl) {
      if (playerId === HUMAN) showToast(`District Office L${nextLevel} needs ${formatMoney(req?.cash || 0)} + ${req?.infl || 0}% local influence (have ${Math.floor(localInf)}%).`);
      return false;
    }
    player.cash -= req.cash;
    const time = districtOfficeBuildTime(player, req.days * CAMPAIGN_DAY_SECONDS);
    missions.push({ type: "officeUpgrade", player: playerId, state: stateIndex, level: nextLevel, left: time, total: time });
    state.activePulse = 1;
    addAlert(`${player.name} began upgrading a District Office to Level ${nextLevel} in ${state.name}.`);
    return true;
  }

  function tuneChannel(channelIndex) {
    if (!channels[channelIndex]) return;
    broadcast(channelIndex, regionalReport(channelIndex));
    updateUi(true);
  }

  function regionalReport(channelIndex) {
    const channel = channels[channelIndex] || channels[0];
    const regionStates = states.filter((state) => stateInChannelCoverage(state, channel));
    const standings = players
      .map((player) => ({
        player,
        score: regionStates.reduce((sum, state) => sum + stateShare(state, player.id) * state.ev, 0),
      }))
      .sort((a, b) => b.score - a.score);
    const leader = standings[0];
    const contested = regionStates
      .map((state) => {
        const ranked = players.map((player) => stateShare(state, player.id)).sort((a, b) => b - a);
        return { state, margin: ranked[0] - (ranked[1] || 0) };
      })
      .sort((a, b) => a.margin - b.margin)[0]?.state;
    if (!leader || leader.score <= 0) {
      return `${channel.reporter} is monitoring the ${channel.section}. No campaign has built measurable influence in this region yet.`;
    }
    return `${channel.reporter} reports ${leader.player.name} currently has the strongest regional operation in the ${channel.section}. ${contested ? `${contested.name} is the closest watch state tonight.` : "Most states remain lightly contested."}`;
  }

  function buyChannel(playerId, channelIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('buyChannel', [channelIndex])) return true;
    const player = players[playerId];
    const channel = channels[channelIndex];
    if (!player || !channel) return false;
    if (!canUseCampaignActions(player, playerId)) return false;
    if (phase !== "play") {
      if (playerId === HUMAN) showToast("Channels unlock after home-base selection.");
      return false;
    }
    const cost = channelTakeoverCost(playerId, channel);
    if (player.cash < cost) {
      if (playerId === HUMAN) showToast(`Need ${formatMoney(cost)}.`);
      return false;
    }
    if (channel.owner === playerId) {
      if (playerId === HUMAN) showToast(`${channel.name} is already aligned with your party.`);
      return false;
    }
    const previousOwner = channel.owner >= 0 ? players[channel.owner] : null;
    player.cash -= cost;
    channel.owner = playerId;
    channel.pulse = 1;
    broadcast(channelIndex, previousOwner
      ? `${player.name} just seized control of ${channel.name} from ${previousOwner.name}. The ${channel.section} desk is now pushing a fresh influence wave across its regional states.`
      : `${player.name} purchased ${channel.name}. The ${channel.section} desk is now carrying messaging for their campaign across the region.`);
    addAlert(previousOwner
      ? `${player.name} took over ${channel.name} from ${previousOwner.name} for ${formatMoney(cost)}.`
      : `${player.name} bought ${channel.name} for ${formatMoney(cost)}.`);
    updateUi(true);
    return true;
  }

  function channelTakeoverCost(playerId, channel) {
    const buyer = players[playerId];
    const owner = channel?.owner >= 0 ? players[channel.owner] : null;
    const protectedTakeover = owner && owner.id !== playerId && hasTalent(owner, "broadcast_moat");
    const mediaRetainer = hasTalent(buyer, "media_retainer") ? 0.75 : 1;
    return Math.round(CHANNEL_COST * (protectedTakeover ? 1.5 : 1) * mediaRetainer);
  }

  function bestChannelForPlayer(playerId) {
    const player = players[playerId];
    const byRegion = channels.find((channel) => channel.coverage.includes(states[player.homeBase]?.abbr || ""));
    if (byRegion) return byRegion.index;
    return channels
      .map((channel) => ({
        index: channel.index,
        score: states
          .filter((state) => stateInChannelCoverage(state, channel))
          .reduce((sum, state) => sum + state.ev * (1 - stateShare(state, playerId)), 0),
      }))
      .sort((a, b) => b.score - a.score)[0].index;
  }

  function broadcast(channelIndex, subtitle) {
    activeChannel = channelIndex;
    const channel = channels[channelIndex] || CHANNELS[channelIndex] || CHANNELS[0];
    const owner = channel.owner >= 0 ? players[channel.owner] : null;
    newsPanel.dataset.channel = channel.id;
    newsChannelName.textContent = owner ? `${channel.name} - ${owner.name}` : channel.name;
    newsChannelName.style.color = owner ? owner.color : "";
    newsReporter.textContent = owner ? `${channel.reporter} for ${owner.name}` : channel.reporter;
    newsSubtitle.textContent = subtitle;
    speakReporter(subtitle);
  }

  function toggleNewsSound() {
    const inMainMenu = !gameStarted || !mainMenu?.classList.contains("is-hidden");
    setSoundEnabled(!soundOn, { announce: !inMainMenu });
  }

  function syncSoundButtons() {
    document.querySelectorAll(".sound-toggle").forEach((button) => {
      const lobbyLabel = button.querySelector(".lobby-sound-label");
      if (lobbyLabel) lobbyLabel.textContent = soundOn ? "Sound // On" : "Sound // Off";
      else button.textContent = soundOn ? "Sound On" : "Sound Off";
      button.setAttribute("aria-pressed", String(soundOn));
      button.setAttribute("aria-label", soundOn ? "Turn sound off" : "Turn sound on");
    });
    document.body.classList.toggle("sound-on", soundOn);
  }

  function queueAudioUnlock() {
    if (!soundOn) return;
    ensureBgm();
    transitionBgm(selectBgmTrack(), 0.8);
    const unlock = () => {
      if (audioUnlocked || !soundOn) return;
      audioUnlocked = true;
      ensureAudio();
      ensureBgm();
      transitionBgm(selectBgmTrack(), 0.8);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
  }

  function setSoundEnabled(enabled, options = {}) {
    soundOn = !!enabled;
    localStorage.setItem("riggedSoundEnabled", soundOn ? "1" : "0");
    syncSoundButtons();
    if (soundOn) {
      ensureAudio();
      ensureBgm();
      transitionBgm(selectBgmTrack(), options.fade || 1.2);
      if (options.announce !== false) speakReporter(newsSubtitle.textContent || "Live from the campaign desk.");
    } else {
      stopBgm(options.fade || 1.2);
    }
  }

  function ensureAudio() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
  }

  function ensureBgm() {
    Object.entries(BGM_TRACKS).forEach(([key, track]) => {
      if (bgm[key]) return;
      const audio = new Audio(track.src);
      audio.loop = !!track.loop;
      audio.preload = "auto";
      audio.volume = 0;
      bgm[key] = audio;
    });
  }

  function bgmTargetVolume(trackKey = currentBgm) {
    if (!soundOn || musicVolume <= 0 || !trackKey) return 0;
    const mix = trackKey === "victory" ? 0.78 : 0.46;
    return Math.max(0, Math.min(1, musicVolume * mix));
  }

  function updateBgmVolume() {
    if (!bgm || !Object.keys(bgm).length) return;
    Object.entries(bgm).forEach(([key, audio]) => {
      if (!audio) return;
      if (!bgmFade && key === currentBgm) audio.volume = bgmTargetVolume(key);
      if (!soundOn) audio.volume = 0;
    });
  }

  function selectBgmTrack() {
    if (matchOver) return resultBgm || currentBgm || "menu";
    if (!gameStarted || mainMenu?.classList.contains("is-hidden") === false) return "menu";
    if (phase === "base") return "early";
    const progress = currentMatchMode?.days ? campaignDaysElapsed() / currentMatchMode.days : 0;
    if (progress >= 0.72 || daysUntilElection() <= Math.max(3, currentMatchMode.days * 0.18)) return "end";
    if (progress >= 0.36) return "mid";
    return "early";
  }

  function transitionBgm(trackKey, fadeSeconds = BGM_FADE_SECONDS) {
    if (!soundOn || !trackKey) return;
    ensureBgm();
    if (pendingBgm === trackKey || currentBgm === trackKey) {
      const current = bgm[trackKey];
      if (current) {
        current.volume = bgmTargetVolume(trackKey);
        if (current.paused) current.play().catch(() => {});
      }
      return;
    }
    const next = bgm[trackKey];
    if (!next) return;
    const fromKey = currentBgm;
    const from = fromKey ? bgm[fromKey] : null;
    pendingBgm = trackKey;
    next.currentTime = Number.isFinite(next.currentTime) && next.currentTime > 0 && !next.ended ? next.currentTime : 0;
    next.volume = 0;
    next.play().catch(() => {});
    const startedAt = performance.now();
    const duration = Math.max(0.1, fadeSeconds) * 1000;
    if (bgmFade) cancelAnimationFrame(bgmFade);
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = t * t * (3 - 2 * t);
      if (from) from.volume = bgmTargetVolume(fromKey) * (1 - eased);
      next.volume = bgmTargetVolume(trackKey) * eased;
      if (t < 1) {
        bgmFade = requestAnimationFrame(step);
        return;
      }
      if (from && from !== next) {
        from.pause();
        from.volume = 0;
      }
      currentBgm = trackKey;
      pendingBgm = "";
      bgmFade = null;
      next.volume = bgmTargetVolume(trackKey);
    };
    bgmFade = requestAnimationFrame(step);
  }

  function stopBgm(fadeSeconds = BGM_FADE_SECONDS) {
    if (!Object.keys(bgm).length) return;
    if (bgmFade) cancelAnimationFrame(bgmFade);
    const startedAt = performance.now();
    const duration = Math.max(0.1, fadeSeconds) * 1000;
    const starts = Object.fromEntries(Object.entries(bgm).map(([key, audio]) => [key, audio?.volume || 0]));
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      Object.entries(bgm).forEach(([key, audio]) => {
        if (audio) audio.volume = starts[key] * (1 - t);
      });
      if (t < 1) {
        bgmFade = requestAnimationFrame(step);
        return;
      }
      Object.values(bgm).forEach((audio) => {
        if (!audio) return;
        audio.pause();
        audio.volume = 0;
      });
      currentBgm = "";
      pendingBgm = "";
      bgmFade = null;
    };
    bgmFade = requestAnimationFrame(step);
  }

  function refreshBgm() {
    if (!soundOn) return;
    transitionBgm(selectBgmTrack());
  }

  function speakReporter(text) {
    if (!soundOn) return;
    ensureAudio();
    const voice = CHANNELS[activeChannel]?.voice || CHANNELS[0].voice;
    const base = voice.pitch;
    const letters = String(text).toUpperCase().replace(/[^A-Z ]/g, "");
    const max = Math.min(letters.length, 90);
    const begin = audioContext.currentTime + 0.02;
    let t = begin;
    for (let i = 0; i < max; i += 1) {
      const ch = letters[i];
      if (ch === " ") {
        t += voice.speed * 1.7;
        continue;
      }
      const code = ch.charCodeAt(0) - 65;
      const semitone = code % 8;
      const jitter = 0.98 + hashUnit(i + code) * 0.04;
      const freq = base * Math.pow(2, semitone / 12) * jitter;
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = voice.type;
      osc.frequency.setValueAtTime(freq * 1.04, t);
      osc.frequency.exponentialRampToValueAtTime(freq, t + voice.speed * 0.55);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(voice.volume * reporterVolume, t + 0.007);
      gain.gain.exponentialRampToValueAtTime(0.0006, t + voice.speed * 0.92);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(t);
      osc.stop(t + voice.speed);
      t += voice.speed;
    }
    const durationMs = Math.max(300, (t - begin) * 1000);
    document.body.classList.add("speaking");
    clearTimeout(speakTimer);
    speakTimer = setTimeout(() => document.body.classList.remove("speaking"), durationMs);
  }

  function regionChannelIndex(region) {
    const anchorByRegion = { west: "CA", sunbelt: "FL", south: "TX", midwest: "IL", northeast: "NY" };
    const anchor = anchorByRegion[region];
    const index = CHANNELS.findIndex((channel) => channel.coverage.includes(anchor));
    return index >= 0 ? index : 0;
  }

  function stateInChannelCoverage(state, channel) {
    if (!state || !channel) return false;
    return Array.isArray(channel.coverage) && channel.coverage.includes(state.abbr);
  }

  function addHeat(player, amount) {
    player.heat += amount * player.heatBias;
    if (player.heat >= 100) {
      player.heat = 100;
      player.locked = Math.max(player.locked, 18);
      player.action = null;
      addAlert(`${player.name} triggered a federal investigation.`);
    }
  }

  function triggerBreakingNews() {
    news = BREAKING_NEWS[Math.floor(Math.random() * BREAKING_NEWS.length)];
    newsTimer = 42;
    if (news.effect === "jobs") {
      states.filter((state) => state.region === "south" || state.region === "midwest").forEach((state) => {
        const leader = leadingPlayer(state.index);
        if (leader >= 0) applyInfluenceGain(state, leader, 3, 1, false);
      });
    }
    broadcast(Math.floor(Math.random() * CHANNELS.length), `${news.title}: ${news.text}`);
    addAlert(`Breaking: ${news.title}. ${news.text}`);
  }

  function fillClickbait(text, data) {
    return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");
  }

  function triggerClickbait(eventType, data = {}) {
    const templates = CLICKBAIT_TEMPLATES[eventType];
    if (!templates || !templates.length) return;
    const template = templates[Math.floor(Math.random() * templates.length)];
    const state = data.stateName || (Number.isInteger(data.state) && states[data.state] ? states[data.state].name : "the map");
    const faction = data.factionName || (Number.isInteger(data.player) && players[data.player] ? players[data.player].name : "Unknown Faction");
    const opponent = data.opponentName || (Number.isInteger(data.target) && players[data.target] ? players[data.target].name : "Rival Factions");
    const value = data.cashValue ? formatMoney(data.cashValue) : "$0";
    const tokens = { state, faction, opponent, value, level: data.baseLevel || 1 };
    latestClickbait = {
      id: `news_${Date.now()}_${Math.floor(Math.random() * 999)}`,
      day: Math.max(1, Math.ceil(campaignDaysElapsed())),
      level: data.level || "HIGH",
      heat: data.heat ?? 10,
      headline: fillClickbait(template.headline, tokens),
      subtext: fillClickbait(template.subtext, tokens),
    };
    clickbaitTimer = 9;
    const channelIndex = Number.isInteger(data.state) && states[data.state] ? regionChannelIndex(states[data.state].region) : activeChannel;
    broadcast(channelIndex, `[!!! ALERT !!!] ${latestClickbait.headline} ${latestClickbait.subtext}`);
    if (eventTicker) eventTicker.textContent = latestClickbait.headline;
    renderClickbaitTicker();
    addAlert(`[CLICKBAIT] ${latestClickbait.headline} ${latestClickbait.subtext}`);
  }

  function tickClickbait(dt) {
    if (clickbaitTimer <= 0) return;
    clickbaitTimer -= dt;
    if (clickbaitTimer <= 0) renderClickbaitTicker();
  }

  function dismissClickbait() {
    clickbaitTimer = 0;
    renderClickbaitTicker();
  }

  function renderClickbaitTicker() {
    if (!clickbaitTicker) return;
    clickbaitTicker.classList.remove("is-visible", "news-flicker-alert");
    clickbaitTicker.innerHTML = "";
  }

  function showAssassinationBroadcast() {
    if (!assassinationOverlay || !assassinationGif) return;
    assassinationOverlay.classList.remove("is-on");
    if (assassinationTimer) {
      window.clearTimeout(assassinationTimer);
      assassinationTimer = null;
    }
    assassinationGif.src = `assassinate_broadcast.gif?v=${Date.now()}`;
    void assassinationOverlay.offsetWidth;
    assassinationOverlay.classList.add("is-on");
    assassinationTimer = window.setTimeout(() => {
      assassinationOverlay.classList.remove("is-on");
      assassinationTimer = null;
    }, 3000);
  }

  function finishElection(winnerId = null, reason = "time expired") {
    if (matchOver) return;
    matchOver = true;
    const standings = players
      .map((player) => ({ player, electoral: electoralVotes(player.id), vote: projectedVote(player.id), states: statesHeld(player.id) }))
      .sort((a, b) => b.electoral - a.electoral || b.vote - a.vote);
    const winner = winnerId === null ? standings[0] : standings.find((item) => item.player.id === winnerId);
    addAlert(`${winner.player.name} wins: ${reason}. Electoral vote ${winner.electoral}/${totalElectoralVotes()}.`);
    showToast(`${winner.player.name} wins the electoral vote.`);
    showVoteCountingScreen(standings, winner, reason);
    resultBgm = winner.player.id === HUMAN ? "victory" : "";
    if (resultBgm) transitionBgm(resultBgm, 1.6);
    updateUi(true);
  }

  function checkWinCondition() {
    if (matchOver || phase !== "play") return;
    if (currentMatchMode.id === "majority50") {
      const target = electoralVoteTarget();
      const leader = players
        .map((player) => ({ player, electoral: electoralVotes(player.id), vote: projectedVote(player.id) }))
        .sort((a, b) => b.electoral - a.electoral || b.vote - a.vote)[0];
      if (leader && leader.electoral >= target) {
        finishElection(leader.player.id, "reached " + target + " electoral votes first");
      }
    }
  }

  function chooseAiState(playerId) {
    const player = players[playerId];
    const personality = player?.aiPersonality || AI_PERSONALITIES[0];
    const minEv = 3;
    const maxEv = Math.max(...states.map((state) => state.ev || minEv));
    return states
      .map((state, index) => {
        const share = stateShare(state, playerId);
        const leader = leadingPlayer(index);
        const isLeader = leader === playerId;
        const swing = Math.abs(0.5 - share);
        const lowVoteScore = 1 - ((state.ev - minEv) / Math.max(1, maxEv - minEv));
        const openScore = leader < 0 ? personality.openBias : leader === playerId ? -4 : 0;
        const smallStateBonus = state.ev <= 8 ? personality.lowVoteBias * 0.55 : 0;
        const value =
          state.ev * (isLeader ? 0.25 : personality.evBias) +
          lowVoteScore * personality.lowVoteBias +
          smallStateBonus +
          openScore +
          (1 - swing) * 18 +
          Math.random() * 8;
        return { index, value };
      })
      .sort((a, b) => b.value - a.value)[0].index;
  }

  function chooseAiInsetState(playerId) {
    return states
      .filter((state) => state.inset)
      .map((state) => {
        const share = stateShare(state, playerId);
        const leader = leadingPlayer(state.index);
        const hasHub = officeLevel(state, playerId) > 0;
        const value = (1 - share) * 18 + (hasHub ? -4 : 8) + (leader === playerId ? -3 : 5) + Math.random() * 6;
        return { index: state.index, value };
      })
      .sort((a, b) => b.value - a.value)[0].index;
  }

  function leadingOpponent(playerId, stateIndex) {
    const opponents = players
      .filter((player) => player.id !== playerId)
      .sort((a, b) => adjustedInfluence(states[stateIndex], b.id) - adjustedInfluence(states[stateIndex], a.id));
    return adjustedInfluence(states[stateIndex], opponents[0].id) > 0 ? opponents[0] : null;
  }

  function leadingOpponentWithHub(playerId, stateIndex) {
    const state = states[stateIndex];
    return players
      .filter((player) => player.id !== playerId && officeLevel(state, player.id) > 0)
      .sort((a, b) => adjustedInfluence(state, b.id) - adjustedInfluence(state, a.id))[0] || null;
  }

  function leadingPlayer(stateIndex) {
    const state = states[stateIndex];
    const ranked = players
      .map((player) => ({ id: player.id, value: adjustedInfluence(state, player.id) }))
      .sort((a, b) => b.value - a.value);
    return ranked[0].value > 0 ? ranked[0].id : -1;
  }

  function capturedPlayer(stateIndex) {
    return leadingPlayer(stateIndex);
  }

  function labelAction(type) {
    return {
      speech: "a public speech",
    }[type];
  }

  function projectedVote(playerId) {
    const totalEv = states.reduce((sum, state) => sum + state.ev, 0);
    const weighted = states.reduce((sum, state) => sum + stateShare(state, playerId) * state.ev, 0);
    return weighted / totalEv;
  }

  function totalElectoralVotes() {
    return states.reduce((sum, state) => sum + (state.ev || 0), 0);
  }

  function electoralVoteTarget() {
    return Math.ceil(totalElectoralVotes() * 0.5);
  }

  function electoralVotes(playerId) {
    return states.reduce((sum, state) => leadingPlayer(state.index) === playerId ? sum + (state.ev || 0) : sum, 0);
  }

  function electoralVoteShare(playerId) {
    return electoralVotes(playerId) / Math.max(1, totalElectoralVotes());
  }

  function statesHeld(playerId) {
    return states.filter((state) => leadingPlayer(state.index) === playerId).length;
  }

  function stateShare(state, playerId) {
    return adjustedInfluence(state, playerId) / 100;
  }

  function adjustedInfluence(state, playerId) {
    return Math.max(0, state.influence[playerId]);
  }

  function totalInfluence(state) {
    return players.reduce((sum, player) => sum + adjustedInfluence(state, player.id), 0);
  }

  function undecidedInfluence(state) {
    return Math.max(0, 100 - totalInfluence(state));
  }

  function clampInfluence(value) {
    return Math.min(100, Math.max(0, value));
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value < edge0 ? 0 : 1;
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  function semanticZoomState() {
    const macroAlpha = 1 - smoothstep(SEMANTIC_ZOOM.macroMax, SEMANTIC_ZOOM.macroFadeEnd, Camera.zoom);
    const mesoAlpha = smoothstep(SEMANTIC_ZOOM.mesoStart, SEMANTIC_ZOOM.mesoFull, Camera.zoom);
    const microAlpha = smoothstep(SEMANTIC_ZOOM.microFadeStart, SEMANTIC_ZOOM.microFull, Camera.zoom);
    const detailAlpha = smoothstep(1, 1.55, Camera.zoom);
    const shareAlpha = smoothstep(0.96, 1.3, Camera.zoom);
    const labelAlpha = Math.max(mesoAlpha, microAlpha * 0.65);
    return {
      macroAlpha,
      mesoAlpha,
      microAlpha,
      detailAlpha,
      shareAlpha,
      labelAlpha,
      isMacro: macroAlpha > 0.55,
      isMeso: mesoAlpha > 0.45 && microAlpha < 0.5,
      isMicro: microAlpha > 0.55,
    };
  }

  function setLayerAlpha(alpha) {
    ctx.save();
    ctx.globalAlpha *= clamp01(alpha);
  }

  function updateSemanticZoomHud(zoomState) {
    [newsPanel, intelPanel, opponentTray, eventStrip, hotbarEl].forEach((el) => {
      if (!el) return;
      el.style.opacity = "1";
    });
    const calendarCard = calendarCountdown ? calendarCountdown.closest(".election-calendar") : null;
    if (calendarCard) calendarCard.style.opacity = "1";
  }

  function addAlert(message) {
    alerts.unshift({ message, time: formatCampaignLogTime() });
    alerts = alerts.slice(0, 42);
    alertVersion += 1;
  }

  function updateUi(forceLog = false) {
    const human = players[HUMAN];
    const state = states[selectedState];
    const leaderId = leadingPlayer(selectedState);
    const leader = leaderId >= 0 ? players[leaderId] : null;
    factionName.textContent = `${human.name} - ${human.full}`;
    factionName.style.color = human.color;
    hqHint.textContent = phase === "base"
      ? `${Math.ceil(baseTimer)}s to pick a home base. Click any open state. Everyone starts at 0 influence.`
      : `${state.name} (${state.ev} EV): ${leader ? `${leader.name} leads ${Math.round(adjustedInfluence(state, leader.id))}%` : "undecided"}. Your support ${Math.round(stateShare(state, HUMAN) * 100)}%. ${currentMatchMode.id === "majority50" ? "First party to 50% electoral votes wins." : "Most electoral votes on election day wins."}`;
    cashStat.textContent = formatMoney(human.cash);
    if (heatStat) heatStat.textContent = `${Math.floor(human.heat)}%`;
    timeStat.textContent = phase === "base" ? `${Math.ceil(baseTimer)}s` : (currentMatchMode.timed ? `${Math.ceil(daysUntilElection())}d` : "ENDLESS");
    voteStat.textContent = `${electoralVotes(HUMAN)}`;
    if (calendarCountdown) {
      const calendarCard = calendarCountdown.closest(".election-calendar");
      if (calendarCard) calendarCard.style.display = currentMatchMode.timed ? "block" : "none";
      if (currentMatchMode.timed) {
        calendarCountdown.textContent = String(Math.ceil(phase === "base" ? currentMatchMode.days : daysUntilElection()));
        if (calendarCard) {
          const progress = phase === "base" ? 0 : Math.max(0, Math.min(1, campaignDaysElapsed() % 1));
          calendarCard.style.setProperty("--day-progress", (progress * 100).toFixed(1) + "%");
        }
      } else if (calendarCard) {
        calendarCard.style.setProperty("--day-progress", "0%");
      }
    }
    eventTicker.textContent = phase === "base" ? "Home base draft" : news ? news.title : "State race live";
    if (intelBody) {
      intelBody.innerHTML = players
        .filter((player) => player.id !== HUMAN)
        .map((player) => {
          const home = player.homeBase >= 0 ? states[player.homeBase].abbr : "--";
          const vote = electoralVotes(player.id);
          const cashFlow = formatPerDay(projectedCashPerDay(player));
          return `
            <article class="intel-card">
              <div class="intel-head">
                <strong style="color:${player.color}">${player.name}</strong>
                <span class="intel-home">${home}</span>
              </div>
              <div class="intel-metric"><span>Cash</span><strong>${formatMoney(player.cash)}</strong></div>
              <div class="intel-metric"><span>Per Day</span><strong>${cashFlow}</strong></div>
              <div class="intel-metric"><span>EV</span><strong>${vote}</strong></div>
              <div class="intel-metric"><span>HQ</span><strong>L${player.mainBaseLevel || 0}</strong></div>
            </article>
          `;
        }).join("");
    }
    if (opponentTray) {
      opponentTray.innerHTML = players
        .map((player) => `
          <button class="opponent-chip${player.id === HUMAN ? " is-human" : ""}${player.locked > 0 ? " is-blackout" : ""}${isSpeaking(player) ? " is-speaking" : ""}${assassinatedToday(player) ? " is-assassin" : ""}" type="button" data-leader-player="${player.id}" aria-label="${player.id === HUMAN ? "Open your talent terminal" : `Inspect ${escapeHtml(player.name)} talent tree`}">
            ${leaderPortraitMarkup(player, "leader-portrait")}
            ${player.locked > 0 ? '<span class="leader-blackout-mark">X</span>' : ""}
            ${isSpeaking(player) ? '<span class="leader-speaking-mark">LIVE</span>' : ""}
            ${assassinatedToday(player) ? '<span class="leader-assassin-mark">HIT</span>' : ""}
          </button>
        `).join("");
    }
    playerList.innerHTML = players.map((player) => `
      <div class="player-row">
        <span class="player-dot" style="background:${player.color}"></span>
        <span class="player-name">${player.name}</span>
        <span class="player-count">${player.homeBase >= 0 ? states[player.homeBase].abbr : "--"}</span>
      </div>
    `).join("");
    opPanel.innerHTML = "";
    channelMarket.innerHTML = channels.map((channel) => {
      const owner = channel.owner >= 0 ? players[channel.owner] : null;
      const border = channel.owner >= 0 ? players[channel.owner].color : "#30394d";
      const active = channel.index === activeChannel ? " is-active" : "";
      const ownerLine = owner ? `Owned by ${owner.name}` : `Open market`;
      const buyCost = channelTakeoverCost(HUMAN, channel);
      const buyLabel = owner ? `Take ${formatMoney(buyCost)}` : `Buy ${formatMoney(buyCost)}`;
      return `
        <div class="channel-card${active}" data-channel-hover="${channel.index}" style="border-color:${border}">
          <button class="channel-tune" type="button" data-tune="${channel.index}">
            <strong>${channel.name}</strong>
            <span>${channel.section} - ${ownerLine}</span>
          </button>
          <button class="channel-buy" type="button" data-buy="${channel.index}">${buyLabel}</button>
        </div>
      `;
    }).join("");
    channelMarket.querySelectorAll("[data-channel-hover]").forEach((card) => {
      card.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        const buyButton = event.target.closest("[data-buy]");
        if (buyButton && card.contains(buyButton)) {
          buyChannel(HUMAN, Number(buyButton.dataset.buy));
          return;
        }
        tuneChannel(Number(card.dataset.channelHover));
      });
      card.addEventListener("mouseenter", () => {
        hoveredChannel = Number(card.dataset.channelHover);
        showChannelTip(card);
      });
      card.addEventListener("mousemove", () => positionHotTip(card));
      card.addEventListener("mouseleave", () => {
        if (hoveredChannel === Number(card.dataset.channelHover)) hoveredChannel = -1;
        if (hotTipEl) hotTipEl.classList.remove("is-on");
      });
    });
    if (forceLog || cityLog.dataset.version !== String(alertVersion)) {
      cityLog.innerHTML = alerts.map((entry) => `
        <div class="log-entry"><strong>${entry.time}</strong> ${colorizeAlertMessage(entry.message)}</div>
      `).join("");
      cityLog.dataset.version = String(alertVersion);
      cityLog.scrollTop = 0;
    }
    pauseButton.textContent = paused ? "Resume" : "Pause";
    document.body.classList.toggle("player-blackout", !!human && human.locked > 0 && gameStarted && !matchOver);
    if (pauseOverlay) pauseOverlay.classList.toggle("is-visible", paused && gameStarted && !matchOver);
  }

  function render() {
    const zoomState = semanticZoomState();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground();
    ctx.save();
    ctx.translate(Camera.offsetX, Camera.offsetY);
    ctx.scale(Camera.zoom, Camera.zoom);
    drawWorldMapBackground();
    drawCoastalHalo(zoomState);
    states.forEach((state) => drawState(state, zoomState));
    drawConnectedPartyFlagFills();
    drawStateLabels(zoomState);
    if (zoomState.mesoAlpha > 0.02) {
      setLayerAlpha(Math.max(zoomState.mesoAlpha * 0.9, zoomState.microAlpha));
      drawAllMainBases();
      drawAllMiniBases();
      ctx.restore();
    }
    if (zoomState.microAlpha > 0.02) {
      setLayerAlpha(zoomState.microAlpha);
      drawTacticalMicroLayers(zoomState);
      drawActiveTacticalOverlays();
      ctx.restore();
    }
    ctx.restore();
    updateSemanticZoomHud(zoomState);
    drawSelectedPanel();
    drawHoverPanel();
    drawAssassinEdgeAlert();
  }

  function drawAssassinEdgeAlert() {
    if (!gameStarted || matchOver || phase !== "play") return;
    if (!assassinatedToday(players[HUMAN])) return;
    const pulse = 0.55 + Math.sin(elapsed * 7) * 0.18;
    const width = 12;
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = "#ff2222";
    ctx.shadowColor = "#ff1111";
    ctx.shadowBlur = 24;
    ctx.lineWidth = width;
    ctx.strokeRect(width / 2 + 1, width / 2 + 1, CANVAS_W - width - 2, CANVAS_H - width - 2);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "rgba(45,4,4,0.86)";
    ctx.strokeStyle = "#ff3434";
    ctx.lineWidth = 1;
    const text = "ASSASSINATION HEAT: repeat kill today triggers -5% influence";
    ctx.font = "bold 11px Courier New";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const boxW = Math.min(CANVAS_W - 36, Math.max(310, text.length * 7.4));
    const boxH = 26;
    const x = CANVAS_W / 2 - boxW / 2;
    const y = 12;
    ctx.fillRect(x, y, boxW, boxH);
    ctx.strokeRect(x, y, boxW, boxH);
    ctx.fillStyle = "#ff6a6a";
    ctx.fillText(text, CANVAS_W / 2, y + boxH / 2 + 1);
    ctx.restore();
  }

  function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    grad.addColorStop(0, "#04190d");
    grad.addColorStop(1, "#010c06");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  function drawWorldMapBackground() {
    if (!usWorldMapImage.complete || !usWorldMapImage.naturalWidth) return;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(usWorldMapImage, 0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "rgba(0, 18, 10, 0.18)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
  }

  function zoomThinLine(baseWidth, minWidth = 0.18) {
    const zoom = Math.max(1, Camera.zoom);
    return Math.max(minWidth, baseWidth / Math.pow(zoom, 1.35));
  }

  function drawCoastalHalo(zoomState) {
    if (!states.length) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = `rgba(57,255,158,${0.07 + zoomState.microAlpha * 0.04})`;
    ctx.lineWidth = zoomThinLine(4, 0.28);
    states.forEach((state) => {
      pathState(state);
      ctx.stroke();
    });
    ctx.strokeStyle = `rgba(150,255,190,${0.28 + zoomState.microAlpha * 0.1})`;
    ctx.lineWidth = zoomThinLine(1.4 + zoomState.microAlpha * 0.55, 0.16);
    states.forEach((state) => {
      pathState(state);
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawState(state, zoomState) {
    const selected = state.index === selectedState;
    const hovered = state.index === hoveredState;
    const leaderId = leadingPlayer(state.index);
    const leader = leaderId >= 0 ? players[leaderId] : null;
    const ownerId = capturedPlayer(state.index);
    const owner = ownerId >= 0 ? players[ownerId] : null;

    let fill;
    let border;
    if (owner) {
      fill = owner.color;
      border = mix(owner.color, "#03140a", 0.5);
    } else {
      const terrain = TERRAIN_BY_REGION[state.region] || TERRAIN_DEFAULT;
      fill = leader ? mix(terrain, leader.color, 0.24) : terrain;
      border = "rgba(38,46,30,0.55)";
    }

    pathState(state);
    ctx.save();
    ctx.globalAlpha *= owner ? 0.62 : 0.34;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    pathState(state);
    ctx.lineJoin = "round";
    ctx.strokeStyle = border;
    ctx.lineWidth = zoomThinLine(owner ? 2.2 : 1, 0.16);
    ctx.stroke();

    if (selected) {
      pathState(state);
      ctx.strokeStyle = "#8dffb6";
      ctx.lineWidth = zoomThinLine(2.6, 0.22);
      ctx.stroke();
    }

    if (hovered) {
      pathState(state);
      ctx.save();
      ctx.strokeStyle = "#ffd76a";
      ctx.lineWidth = zoomThinLine(selected ? 4.2 : 3.4, 0.26);
      ctx.shadowColor = "#ffd76a";
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = "#ffd76a";
      ctx.fill();
      ctx.restore();
    }
    const hoveredCoverage = hoveredChannel >= 0 && stateInChannelCoverage(state, channels[hoveredChannel]);
    if (hoveredCoverage) {
      const channelOwner = channels[hoveredChannel]?.owner >= 0 ? players[channels[hoveredChannel].owner] : null;
      pathState(state);
      ctx.strokeStyle = channelOwner ? channelOwner.color : "#ffd76a";
      ctx.lineWidth = zoomThinLine(3.2, 0.24);
      ctx.shadowColor = channelOwner ? channelOwner.color : "#ffd76a";
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (state.activePulse > 0) {
      pathState(state);
      ctx.strokeStyle = `rgba(255,255,255,${state.activePulse * 0.8})`;
      ctx.lineWidth = zoomThinLine(4, 0.28);
      ctx.stroke();
    }

    if (MAP_INFO_MODES[mapInfoMode]?.id !== "flag" && zoomState.shareAlpha > 0.03 && state.w > 40 && state.h > 26) drawStateShareBar(state, zoomState.shareAlpha);
  }

  function drawStateLabels(zoomState) {
    if (MAP_INFO_MODES[mapInfoMode]?.id === "flag") return;
    const farZoomVisibility = zoomState.macroAlpha * 0.95;
    const labelVisibility = Math.max(zoomState.labelAlpha, farZoomVisibility) * (1 - smoothstep(2.1, 4.2, Camera.zoom));
    states.forEach((state) => {
      const selected = state.index === selectedState;
      if (labelVisibility > 0.05 || (selected && Camera.zoom < 4.2)) {
        const ownerId = capturedPlayer(state.index);
        const owner = ownerId >= 0 ? players[ownerId] : null;
        const leaderId = leadingPlayer(state.index);
        const leader = leaderId >= 0 ? players[leaderId] : null;
        drawStateLabel(state, leader, owner, labelVisibility);
      }
    });
  }

  function mapFlagPlayerForState(state) {
    const ownerId = capturedPlayer(state.index);
    if (ownerId >= 0) return players[ownerId];
    const leaderId = leadingPlayer(state.index);
    return leaderId >= 0 ? players[leaderId] : null;
  }

  function statesTouchForFlagFill(a, b) {
    if (!!a.inset !== !!b.inset) return false;
    const tolerance = 6;
    return !(
      a.x + a.w + tolerance < b.x ||
      b.x + b.w + tolerance < a.x ||
      a.y + a.h + tolerance < b.y ||
      b.y + b.h + tolerance < a.y
    );
  }

  function drawConnectedPartyFlagFills() {
    if (MAP_INFO_MODES[mapInfoMode]?.id !== "flag") return;
    const entries = states.map((state) => ({ state, player: mapFlagPlayerForState(state) }));
    const visited = new Set();
    entries.forEach((entry, startIndex) => {
      if (!entry.player || visited.has(startIndex)) return;
      const group = [];
      const stack = [startIndex];
      visited.add(startIndex);
      while (stack.length) {
        const currentIndex = stack.pop();
        const current = entries[currentIndex];
        group.push(current.state);
        entries.forEach((candidate, candidateIndex) => {
          if (visited.has(candidateIndex) || !candidate.player) return;
          if (candidate.player.id !== entry.player.id) return;
          if (!statesTouchForFlagFill(current.state, candidate.state)) return;
          visited.add(candidateIndex);
          stack.push(candidateIndex);
        });
      }
      const bounds = group.reduce((box, state) => ({
        x: Math.min(box.x, state.x),
        y: Math.min(box.y, state.y),
        r: Math.max(box.r, state.x + state.w),
        b: Math.max(box.b, state.y + state.h),
      }), { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity });
      ctx.save();
      ctx.beginPath();
      group.forEach(traceStatePath);
      ctx.clip();
      drawMapPartyFlag(bounds.x, bounds.y, bounds.r - bounds.x, bounds.b - bounds.y, entry.player, 0.92, { border: false, backdrop: false });
      ctx.restore();
    });
    drawFlagModeStateOutlines();
  }

  function drawFlagModeStateOutlines() {
    ctx.save();
    states.forEach((state) => {
      const selected = state.index === selectedState;
      const hovered = state.index === hoveredState;
      const ownerId = capturedPlayer(state.index);
      const owner = ownerId >= 0 ? players[ownerId] : null;
      pathState(state);
      ctx.lineJoin = "round";
      ctx.strokeStyle = owner ? "rgba(255,255,255,0.64)" : "rgba(57,255,158,0.28)";
      ctx.lineWidth = zoomThinLine(owner ? 1.7 : 0.9, 0.15);
      ctx.stroke();
      if (selected) {
        pathState(state);
        ctx.strokeStyle = "#8dffb6";
        ctx.lineWidth = zoomThinLine(2.6, 0.22);
        ctx.stroke();
      }
      if (hovered) {
        pathState(state);
        ctx.strokeStyle = "#ffd76a";
        ctx.lineWidth = zoomThinLine(selected ? 4.2 : 3.4, 0.26);
        ctx.shadowColor = "#ffd76a";
        ctx.shadowBlur = 18;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    });
    ctx.restore();
  }

  function drawStateLabel(state, leader, owner, alpha = 1) {
    const small = state.w < 40 || state.h < 30;
    const offset = STATE_LABEL_OFFSETS[state.abbr] || { dx: 0, dy: 0 };
    const cx = state.cx + offset.dx;
    const cy = state.cy + offset.dy;
    const labelY = cy - (small ? 0 : 5);
    const baseFont = small ? 10 : 13;
    const sizeFromState = Math.min(state.w * 0.24, state.h * 0.38);
    const zoomShrink = smoothstep(1.15, 4.2, Camera.zoom);
    const targetSize = Math.max(baseFont, Math.min(baseFont + 10, sizeFromState));
    const mode = MAP_INFO_MODES[mapInfoMode]?.id || "code";
    const fontSize = mode === "code" ? 10 : Math.round(targetSize - zoomShrink * Math.max(0, targetSize - (small ? 7 : 8)));
    if (mode === "flag") {
      const player = owner || leader;
      if (!player) return;
      const w = Math.max(16, Math.min(small ? 30 : 42, state.w * 0.42));
      const h = Math.max(10, Math.min(small ? 18 : 26, state.h * 0.3));
      drawMapPartyFlag(cx - w / 2, labelY - h / 2, w, h, player, alpha);
      return;
    }
    const text = mapInfoText(state, leader, owner, true);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${fontSize}px Courier New`;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(9,14,10,0.9)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(text, cx, labelY);
    ctx.fillText(text, cx, labelY);
    ctx.restore();
  }

  function mapInfoText(state, leader, owner, compact = false) {
    const mode = MAP_INFO_MODES[mapInfoMode]?.id || "code";
    if (mode === "percent") {
      const share = leader ? Math.round(adjustedInfluence(state, leader.id)) : 0;
      return share + "%";
    }
    if (mode === "votes") return String(state.ev);
    return state.abbr;
  }

  function drawStateMacroInfo(state, leader, owner, alpha) {
    const mode = MAP_INFO_MODES[mapInfoMode]?.id || "code";
    if (mode === "flag") {
      return;
    }
    const text = mapInfoText(state, leader, owner, true);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const macroFont = mode === "code" ? 10 : Math.round(Math.max(9, Math.min(24, Math.min(state.w * 0.18, state.h * 0.26) + clamp01((Camera.zoom - 0.8) / 3) * 8)));
    ctx.font = `bold ${macroFont}px Courier New`;
    ctx.fillStyle = owner ? owner.color : "#b7ffd3";
    ctx.strokeStyle = "rgba(3, 11, 7, 0.92)";
    ctx.lineWidth = 3;
    ctx.strokeText(text, state.cx, state.cy + 10);
    ctx.fillText(text, state.cx, state.cy + 10);
    ctx.restore();
  }

  function drawMapPartyFlag(x, y, w, h, player, alpha = 1, options = {}) {
    const flag = flagById(player?.leaderProfile?.flag);
    const color = player?.color || "#34ff86";
    const dark = mix(color, "#020c06", 0.72);
    const bright = mix(color, "#ffffff", 0.34);
    const px = (value) => x + value * w / 96;
    const py = (value) => y + value * h / 36;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = dark;
    ctx.fillRect(x, y, w, h);
    const rect = (rx, ry, rw, rh, fill) => {
      ctx.fillStyle = fill;
      ctx.fillRect(px(rx), py(ry), rw * w / 96, rh * h / 36);
    };
    const circle = (cx, cy, r, fill) => {
      ctx.beginPath();
      ctx.fillStyle = fill;
      ctx.arc(px(cx), py(cy), r * Math.min(w / 96, h / 36), 0, Math.PI * 2);
      ctx.fill();
    };
    if (options.backdrop !== false) {
      ctx.fillStyle = "rgba(2,12,6,0.72)";
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    }
    if (flag.id === "campaign_stripes") {
      rect(0, 0, 96, 12, color); rect(0, 12, 96, 12, "#e9fff1"); rect(0, 24, 96, 12, dark); circle(48, 18, 7, bright);
    } else if (flag.id === "red_disc" || flag.id === "eagle_seal") {
      rect(0, 0, 96, 36, "#7f1111"); circle(48, 18, 12, "#f0eadc"); rect(40, 10, 16, 16, flag.id === "eagle_seal" ? "#111111" : dark);
    } else if (flag.id === "central_star") {
      rect(0, 0, 96, 36, "#8b1010"); drawStar(px(20), py(18), Math.min(w, h) * 0.18, "#ffd76a"); rect(40, 10, 42, 4, "#ffd76a"); rect(40, 20, 34, 4, "#ffd76a");
    } else if (flag.id === "hermit_ray") {
      rect(0, 0, 96, 36, "#123c8a"); rect(0, 5, 96, 6, "#f0eadc"); rect(0, 25, 96, 6, "#f0eadc"); circle(48, 18, 9, "#c81f28"); drawStar(px(48), py(18), Math.min(w, h) * 0.14, "#f0eadc");
    } else if (flag.id === "workers_gear") {
      rect(0, 0, 96, 36, "#7a1515"); circle(30, 18, 9, "#ffd76a"); rect(54, 10, 27, 5, "#ffd76a"); rect(54, 22, 21, 5, "#ffd76a");
    } else if (flag.id === "corporate_grid") {
      rect(0, 0, 96, 36, dark); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, w / 80); [24, 48, 72].forEach((gx) => { ctx.beginPath(); ctx.moveTo(px(gx), y); ctx.lineTo(px(gx), y + h); ctx.stroke(); }); [12, 24].forEach((gy) => { ctx.beginPath(); ctx.moveTo(x, py(gy)); ctx.lineTo(x + w, py(gy)); ctx.stroke(); });
    } else {
      rect(0, 0, 96, 36, "#0c4424"); circle(48, 18, 10, bright); rect(18, 24, 60, 4, color);
    }
    if (options.border !== false) {
      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = Math.max(1, w / 48);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  }

  function drawStar(cx, cy, radius, fill) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const r = i % 2 ? radius * 0.45 : radius;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  function drawLocalTerrainDetails(state, zoomState) {
    const alpha = zoomState.microAlpha * 0.5;
    if (alpha <= 0) return;
    const motifs = {
      west: [[-14, -10], [2, -2], [16, 8]],
      south: [[-18, 6], [-2, -4], [14, 10]],
      sunbelt: [[-16, 10], [0, 0], [14, -8]],
      midwest: [[-15, -3], [1, 7], [15, -1]],
      northeast: [[-10, 8], [4, -4], [16, 2]],
    }[state.region] || [[-12, -8], [2, 0], [14, 8]];
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = "rgba(137,255,188,0.45)";
    ctx.lineWidth = 1;
    motifs.forEach(([dx, dy], index) => {
      const x = state.cx + dx;
      const y = state.cy + dy;
      if (state.region === "west") {
        ctx.beginPath();
        ctx.moveTo(x, y + 5);
        ctx.lineTo(x + 5, y - 4);
        ctx.lineTo(x + 10, y + 5);
        ctx.stroke();
      } else if (state.region === "south" || state.region === "sunbelt") {
        ctx.beginPath();
        ctx.arc(x + index, y, 4, Math.PI, 0);
        ctx.stroke();
      } else if (state.region === "midwest") {
        ctx.strokeRect(x - 4, y - 4, 8, 8);
      } else {
        ctx.beginPath();
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x + 5, y);
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y + 5);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  function drawLocalizedAssetPaths(zoomState) {
    ctx.save();
    ctx.globalAlpha *= zoomState.microAlpha * 0.68;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.3;
    eachMiniBase((state, player, index, total) => {
      const office = miniBasePoint(state, player, index, total);
      const hubState = player.homeBase >= 0 ? states[player.homeBase] : null;
      const hub = hubState ? mainBasePoint(hubState) : { x: state.cx, y: state.cy - 14 };
      const visual = factionVisual(player);
      ctx.strokeStyle = visual.glow;
      ctx.beginPath();
      ctx.moveTo(hub.x, hub.y);
      ctx.lineTo(office.x, office.y);
      ctx.stroke();
    });
    ctx.restore();
  }

  function stateScreenMetrics(state) {
    const a = worldToScreen({ x: state.x, y: state.y });
    const b = worldToScreen({ x: state.x + state.w, y: state.y + state.h });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  function stateVisibleForMicro(state) {
    const screen = stateScreenMetrics(state);
    if (screen.x + screen.w < 0 || screen.y + screen.h < 0 || screen.x > CANVAS_W || screen.y > CANVAS_H) return false;
    return screen.w >= 90 && screen.h >= 72;
  }

  function tacticalGridSpec(state) {
    const cols = Math.max(3, Math.min(8, Math.round(state.w / 16)));
    const rows = Math.max(3, Math.min(7, Math.round(state.h / 16)));
    return {
      cols,
      rows,
      cellW: state.w / cols,
      cellH: state.h / rows,
    };
  }

  function heatCellColor(state, col, row) {
    const shares = players.map((player) => ({ player, value: adjustedInfluence(state, player.id) }));
    shares.sort((a, b) => b.value - a.value);
    const lead = shares[0];
    const next = shares[1];
    const leaderStrength = clamp01((lead?.value || 0) / 100);
    const edge = clamp01(((lead?.value || 0) - (next?.value || 0)) / 40);
    const variance = hashUnit(state.index * 97 + col * 13 + row * 29);
    const intensity = clamp01(0.24 + leaderStrength * 0.5 + edge * 0.2 + variance * 0.1);
    if (!lead || lead.value <= 0) return `rgba(140,170,150,${0.08 + variance * 0.06})`;
    return hexToRgba(lead.player.color, intensity * 0.22);
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace("#", "");
    const size = value.length === 3 ? 1 : 2;
    const parse = (offset) => parseInt(size === 1 ? value[offset] + value[offset] : value.slice(offset * 2, offset * 2 + 2), 16);
    const r = parse(0);
    const g = parse(1);
    const b = parse(2);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function drawTacticalMicroLayers(zoomState) {
    return;
  }

  function drawMicroHeatGrid(state, zoomState) {
    const grid = tacticalGridSpec(state);
    ctx.save();
    ctx.globalAlpha *= zoomState.microAlpha * 0.9;
    for (let col = 0; col < grid.cols; col += 1) {
      for (let row = 0; row < grid.rows; row += 1) {
        const x = state.x + col * grid.cellW;
        const y = state.y + row * grid.cellH;
        ctx.fillStyle = heatCellColor(state, col, row);
        ctx.fillRect(x + 0.5, y + 0.5, grid.cellW - 1, grid.cellH - 1);
      }
    }
    ctx.strokeStyle = "rgba(130,255,188,0.18)";
    ctx.lineWidth = 0.8;
    for (let col = 1; col < grid.cols; col += 1) {
      const x = state.x + col * grid.cellW;
      ctx.beginPath();
      ctx.moveTo(x, state.y);
      ctx.lineTo(x, state.y + state.h);
      ctx.stroke();
    }
    for (let row = 1; row < grid.rows; row += 1) {
      const y = state.y + row * grid.cellH;
      ctx.beginPath();
      ctx.moveTo(state.x, y);
      ctx.lineTo(state.x + state.w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function factionVisual(player) {
    if (!player) return FACTION_VISUALS.default;
    const visual = FACTION_VISUALS[player.talentTree] || FACTION_VISUALS.default;
    return { ...visual, color: player.color || visual.color, glow: player.glow || visual.glow };
  }

  function mapIconScale() {
    return Math.max(0.34, 1 / Math.pow(Math.max(1, Camera.zoom), 0.38));
  }

  function mainBasePoint(state) {
    return { x: state.cx, y: Math.max(state.y + 12, state.cy - 17) };
  }

  function miniBasePoint(state, player, index, total) {
    const step = Math.min(18, Math.max(10, state.w / Math.max(2, total + 1)));
    const x = state.cx - (total - 1) * step / 2 + index * step;
    const y = Math.max(state.y + 8, Math.min(state.y + state.h - 8, state.cy + 18));
    return { x, y };
  }

  function eachMiniBase(callback) {
    states.forEach((state) => {
      const hubs = players.filter((player) => officeLevel(state, player.id) > 0);
      hubs.forEach((player, index) => callback(state, player, index, hubs.length));
    });
  }

  function hitMiniBase(point, ownerId = null) {
    for (let i = states.length - 1; i >= 0; i -= 1) {
      const state = states[i];
      const hubs = players.filter((player) => officeLevel(state, player.id) > 0);
      for (let h = hubs.length - 1; h >= 0; h -= 1) {
        const player = hubs[h];
        if (ownerId !== null && player.id !== ownerId) continue;
        const basePoint = miniBasePoint(state, player, h, hubs.length);
        const dx = point.x - basePoint.x;
        const dy = point.y - basePoint.y;
        if (dx * dx + dy * dy <= MINI_BASE_HIT_RADIUS * MINI_BASE_HIT_RADIUS) {
          return { state: state.index, player: player.id, level: officeLevel(state, player.id), x: basePoint.x, y: basePoint.y };
        }
      }
    }
    return null;
  }

  function drawAllMainBases() {
    players.forEach((player) => {
      if (player.homeBase < 0) return;
      const state = states[player.homeBase];
      const point = mainBasePoint(state);
      if (state.police[player.id]) {
        drawPoliceShield(point.x, point.y, 22, player);
        if (policeAtRisk(player)) drawPoliceRiskWarning(point.x + 18, point.y - 18);
      }
      drawMainBaseIcon(point.x, point.y, player);
    });
  }

  function drawAllMiniBases() {
    eachMiniBase((state, player, index, total) => {
      const point = miniBasePoint(state, player, index, total);
      const level = officeLevel(state, player.id);
      if (state.police[player.id]) {
        drawPoliceShield(point.x, point.y, 16, player);
        if (policeAtRisk(player)) drawPoliceRiskWarning(point.x + 14, point.y - 14);
      }
      if (armedAction === "upgradeMiniBase" && player.id === HUMAN) {
        drawMiniBaseUpgradeGlow(point.x, point.y, player, level < MINI_BASE_MAX_LEVEL);
      }
      drawMiniBaseIcon(point.x, point.y, player, level);
      const upgradeMission = officeUpgradeMissionFor(state.index, player.id);
      if (upgradeMission) {
        const progress = 1 - upgradeMission.left / upgradeMission.total;
        drawCountdownBar(point.x - 25, point.y - 22, 50, progress, factionVisual(player).glow, upgradeMission.left);
      }
    });
  }

  function officeUpgradeMissionFor(stateIndex, playerId) {
    return missions.find((mission) =>
      mission.type === "officeUpgrade" &&
      mission.state === stateIndex &&
      mission.player === playerId
    );
  }

  function drawMainBaseIcon(x, y, player) {
    const visual = factionVisual(player);
    const s = mapIconScale() * 0.64;
    const fill = mix(visual.color, "#ffffff", 0.18);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.shadowColor = visual.glow;
    ctx.shadowBlur = 10 / Math.max(s, 0.1);
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(18, 15);
    ctx.lineTo(-18, 15);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.restore();
  }
  function drawMiniBaseIcon(x, y, player, level = 1) {
    const visual = factionVisual(player);
    const s = mapIconScale() * MINI_BASE_ICON_SCALE;
    const fill = mix(visual.color, "#ffffff", 0.2);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.shadowColor = visual.glow;
    ctx.shadowBlur = 9 / Math.max(s, 0.1);
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
    drawLevelBadge(0, 18, String(level), visual, s);
    ctx.restore();
  }

  function drawMiniBaseUpgradeGlow(x, y, player, upgradeable) {
    const visual = factionVisual(player);
    const pulse = 0.55 + Math.sin(performance.now() / 170) * 0.25;
    const s = mapIconScale();
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.globalAlpha = upgradeable ? pulse : 0.4;
    ctx.strokeStyle = upgradeable ? "#ffd76a" : "#355643";
    ctx.fillStyle = upgradeable ? "rgba(255,215,106,0.08)" : "rgba(12,28,18,0.18)";
    ctx.shadowColor = upgradeable ? "#ffd76a" : visual.glow;
    ctx.shadowBlur = (upgradeable ? 16 : 6) / s;
    ctx.lineWidth = upgradeable ? 2.2 : 1.4;
    ctx.beginPath();
    ctx.arc(0, -1, upgradeable ? 17 : 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (upgradeable) {
      ctx.font = "10px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#ffd76a";
      ctx.fillText("UP", 0, -18);
    }
    ctx.restore();
  }

  function drawLevelBadge(x, y, text, visual, parentScale = 1) {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.max(7, Math.round(8 / parentScale))}px 'Share Tech Mono', monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = Math.max(24, text.length * Math.max(5, 5 / parentScale) + 8);
    ctx.fillStyle = "rgba(214,255,224,0.92)";
    ctx.fillRect(x - width / 2, y - 6, width, 12);
    ctx.strokeStyle = "rgba(0,0,0,0.82)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - width / 2, y - 6, width, 12);
    ctx.fillStyle = "#050505";
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  function drawPoliceShield(x, y, radius, player) {
    const visual = factionVisual(player);
    const s = mapIconScale();
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = "#A6FFD0";
    ctx.fillStyle = "rgba(0,255,102,0.09)";
    ctx.shadowColor = visual.glow;
    ctx.shadowBlur = 10 / s;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      const px = Math.cos(a) * radius;
      const py = Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawPoliceRiskWarning(x, y) {
    const pulse = 0.55 + Math.sin(elapsed * 8) * 0.25;
    const s = mapIconScale();
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = "#ffd76a";
    ctx.strokeStyle = "#17213d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(10, 8);
    ctx.lineTo(-10, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#17213d";
    ctx.font = "bold 12px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", 0, 2);
    ctx.restore();
  }

  function drawStateShareBar(state, alpha = 1) {
    const compactBars = {
      WI: { width: 32, dx: -11 },
    };
    const barLayout = compactBars[state.abbr] || {};
    const barW = Math.max(18, Math.min(state.w - 8, barLayout.width || 46));
    const barX = Math.max(state.x + 5, Math.min(state.x + state.w - barW - 5, state.cx - barW / 2 + (barLayout.dx || 0)));
    const hasOffice = players.some((player) => officeLevel(state, player.id) > 0);
    const preferredY = hasOffice ? state.cy + 7 : state.cy + 22;
    const barY = Math.max(state.y + 8, Math.min(state.y + state.h - 6, preferredY));
    let cursor = barX;
    ctx.save();
    pathState(state);
    ctx.clip();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "rgba(18,26,14,0.5)";
    ctx.fillRect(barX, barY, barW, 3);
    players.forEach((player) => {
      const width = stateShare(state, player.id) * barW;
      ctx.fillStyle = player.color;
      ctx.fillRect(cursor, barY, width, 3);
      cursor += width;
    });
    ctx.restore();
  }

  function drawActiveTacticalOverlays() {
    players.forEach((player) => {
      if (!player.action) return;
      const state = states[player.action.state];
      const secondsLeft = guestDisplaySecondsLeft(player.action);
      if (secondsLeft <= 0) return;
      const progress = 1 - secondsLeft / player.action.total;
      const x = state.cx;
      const y = state.cy;
      if (player.action.type === "speech") {
        drawSpeechBroadcast(x, y, player);
        drawCountdownBar(x - 28, y - 32, 56, progress, factionVisual(player).glow, secondsLeft);
      }
    });
    missions.forEach((mission) => {
      const state = states[mission.state];
      const player = players[mission.player];
      const progress = 1 - mission.left / mission.total;
      if (mission.type === "riot") {
        drawRiotHazard(state, player, progress);
        drawCountdownBar(state.cx - 27, state.cy - 5, 54, progress, factionVisual(player).glow, mission.left);
      } else if (mission.type === "adDeploy") {
        const point = miniBasePoint(state, player, 0, 1);
        drawMiniBaseIcon(point.x, point.y, player);
        drawCountdownBar(point.x - 27, point.y + 26, 54, progress, factionVisual(player).glow, mission.left);
      } else if (mission.type === "baseUpgrade") {
        const point = mainBasePoint(state);
        drawSabotageCrosshair(point.x, point.y, player, progress);
        drawCountdownBar(point.x - 27, point.y + 34, 54, progress, factionVisual(player).glow, mission.left);
      }
    });
    actionEffects.forEach(drawActionEffect);
  }

  function drawActionEffect(effect) {
    const state = states[effect.state];
    const player = players[effect.player];
    const target = players[effect.target] || strongestRivalByInfluence(player.id, state);
    const point = target && target.homeBase === state.index ? mainBasePoint(state) : { x: state.cx, y: state.cy };
    drawSabotageCrosshair(point.x, point.y, player, 1 - effect.left / effect.total);
  }

  function drawSpeechBroadcast(x, y, player) {
    const visual = factionVisual(player);
    const pulse = ((performance.now() / 1000) * 1.2) % 1;
    ctx.save();
    ctx.strokeStyle = visual.glow;
    ctx.fillStyle = visual.glow;
    ctx.shadowColor = visual.glow;
    ctx.shadowBlur = 8;
    for (let i = 0; i < 3; i += 1) {
      const r = 16 + ((pulse + i / 3) % 1) * 36;
      ctx.globalAlpha = 0.65 * (1 - (r - 16) / 36);
      ctx.lineWidth = 2;
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.font = "bold 8px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("[ LIVE FEED ]", x, y - 42);
    ctx.restore();
  }

  function guestDisplaySecondsLeft(action) {
    if (!isServerLobbyGuest() || !Number.isFinite(action?._guestReceivedAt)) {
      return Math.max(0, Number(action?.left || 0));
    }
    const sinceSnapshot = Math.max(0, (performance.now() - action._guestReceivedAt) / 1000);
    return Math.max(0, Number(action._guestInitialLeft || 0) - sinceSnapshot);
  }

  function drawSabotageCrosshair(x, y, player, progress) {
    const visual = factionVisual(player);
    ctx.save();
    ctx.strokeStyle = progress % 0.2 < 0.1 ? visual.glow : "#EF4444";
    ctx.shadowColor = visual.glow;
    ctx.shadowBlur = 9;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 3]);
    const box = 18;
    ctx.strokeRect(x - box, y - box, box * 2, box * 2);
    ctx.beginPath();
    ctx.moveTo(x - box, y - box);
    ctx.lineTo(x - box + box * 2 * Math.max(0.05, progress), y - box);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 24, y);
    ctx.lineTo(x + 24, y);
    ctx.moveTo(x, y - 24);
    ctx.lineTo(x, y + 24);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawRiotHazard(state, player, progress) {
    ctx.save();
    pathState(state);
    ctx.clip();
    const flash = 0.35 + 0.35 * Math.sin(elapsed * 12);
    ctx.fillStyle = `rgba(239,68,68,${flash * 0.7})`;
    ctx.fillRect(state.x - 4, state.y - 4, state.w + 8, state.h + 8);
    ctx.strokeStyle = "rgba(10,30,18,0.92)";
    ctx.lineWidth = 3;
    for (let x = state.x - state.h; x < state.x + state.w + state.h; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, state.y + state.h + 8);
      ctx.lineTo(x + state.h, state.y - 8);
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(255,215,106,${0.35 + flash * 0.35})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(state.x + 4, state.y + 4, Math.max(10, state.w - 8), Math.max(10, state.h - 8));
    ctx.restore();
    drawSabotageCrosshair(state.cx, state.cy, player, progress);
  }

  function drawCountdownBar(x, y, width, progress, color, secondsLeft) {
    ctx.fillStyle = "rgba(3,18,9,0.94)";
    roundRect(x, y, width, 9, 2);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(x, y, width * Math.max(0, Math.min(1, progress)), 9, 2);
    ctx.fill();
    ctx.strokeStyle = "#8fe9b6";
    ctx.lineWidth = 1;
    roundRect(x, y, width, 9, 2);
    ctx.stroke();
    ctx.fillStyle = "#d8ffe8";
    ctx.font = "bold 8px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(formatCampaignDuration(secondsLeft), x + width / 2, y + 4.5);
  }

  function drawMapIcon(type, x, y, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(247,248,251,0.95)";
    roundRect(x - 12, y - 12, 24, 24, 5);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    roundRect(x - 12, y - 12, 24, 24, 5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#17213d";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (type === "speech") {
      ctx.fillRect(x - 4, y - 8, 8, 12);
      ctx.beginPath();
      ctx.moveTo(x - 8, y + 1);
      ctx.quadraticCurveTo(x, y + 10, x + 8, y + 1);
      ctx.moveTo(x, y + 10);
      ctx.lineTo(x, y + 14);
      ctx.stroke();
    }
    if (type === "ad") {
      ctx.fillRect(x - 8, y - 8, 16, 10);
      ctx.fillRect(x - 2, y + 2, 4, 8);
      ctx.fillRect(x - 8, y + 9, 16, 2);
    }
    if (type === "riot") {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.35);
      ctx.fillRect(-7, -8, 14, 12);
      ctx.fillRect(-2, 4, 4, 7);
      ctx.restore();
    }
    if (type === "sabotage") {
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 7);
      ctx.lineTo(x + 8, y + 7);
      ctx.moveTo(x + 8, y - 7);
      ctx.lineTo(x - 8, y + 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSelectedPanel() {
    if (!selectedPanelOpen) return;
    const state = states[selectedState];
    const leaderId = leadingPlayer(selectedState);
    const leader = leaderId >= 0 ? players[leaderId] : null;
    const humanShare = Math.round(stateShare(state, HUMAN) * 100);
    const leaderShare = leader ? Math.round(adjustedInfluence(state, leader.id)) : 0;
    ctx.fillStyle = "rgba(247,248,251,0.95)";
    roundRect(24, 72, 260, 112, 8);
    ctx.fill();
    ctx.strokeStyle = "#17213d";
    ctx.lineWidth = 2;
    roundRect(24, 72, 260, 112, 8);
    ctx.stroke();
    ctx.fillStyle = "#17213d";
    ctx.textAlign = "left";
    ctx.font = "bold 16px Courier New";
    ctx.fillText(`${state.name.toUpperCase()} (${state.ev})`, 38, 100);
    ctx.fillStyle = leader ? leader.color : "#586174";
    ctx.font = "bold 13px Courier New";
    ctx.fillText(leader && leaderShare > 0 ? `${leader.name} leads ${leaderShare}%` : "No influence yet", 38, 124);
    ctx.fillStyle = "#586174";
    ctx.font = "bold 11px Courier New";
    ctx.fillText(phase === "base" ? `Base draft ${Math.ceil(baseTimer)}s` : `Your support ${humanShare}%`, 38, 145);
    const officeLvl = officeLevel(state, HUMAN);
    ctx.fillText(`District Office ${officeLvl ? "L" + officeLvl : "none"}`, 38, 164);
  }

  function drawHoverPanel() {
    if (hoveredState < 0) return;
    const state = states[hoveredState];
    const x = Math.min(CANVAS_W - 238, mouseScreen.x + 16);
    const y = Math.min(CANVAS_H - 126, mouseScreen.y + 16);
    ctx.fillStyle = "rgba(247,248,251,0.96)";
    roundRect(x, y, 222, 108, 8);
    ctx.fill();
    ctx.strokeStyle = "#17213d";
    ctx.lineWidth = 2;
    roundRect(x, y, 222, 108, 8);
    ctx.stroke();
    ctx.fillStyle = "#17213d";
    ctx.textAlign = "left";
    ctx.font = "bold 13px Courier New";
    ctx.fillText(`${state.name} (${state.ev})`, x + 12, y + 22);
    players.forEach((player, index) => {
      const share = Math.round(stateShare(state, player.id) * 100);
      ctx.fillStyle = player.color;
      ctx.fillRect(x + 12, y + 38 + index * 14, 8, 8);
      ctx.fillStyle = "#273044";
      ctx.font = "bold 10px Courier New";
      ctx.fillText(`${player.name}: ${share}%`, x + 26, y + 46 + index * 14);
    });
    ctx.fillStyle = "#667085";
    ctx.font = "bold 10px Courier New";
    ctx.fillText(`Undecided: ${Math.round(undecidedInfluence(state))}%`, x + 12, y + 100);
  }

  function drawThresholdLine() {
    const y = 548;
    const x = 314;
    const w = 650;
    ctx.fillStyle = "rgba(247,248,251,0.88)";
    roundRect(x, y, w, 26, 7);
    ctx.fill();
    let cursor = x + 8;
    players.forEach((player) => {
      const width = electoralVoteShare(player.id) * (w - 16);
      ctx.fillStyle = player.color;
      ctx.fillRect(cursor, y + 8, width, 10);
      cursor += width;
    });
    ctx.strokeStyle = "#17213d";
    ctx.strokeRect(x + 8, y + 8, w - 16, 10);
    ctx.fillStyle = "#17213d";
    ctx.font = "bold 11px Courier New";
    ctx.textAlign = "left";
    ctx.fillText("ELECTORAL VOTE MIX - 50% CONTROL LINE", x + 10, y - 7);
  }

  function pathState(state) {
    ctx.beginPath();
    traceStatePath(state);
  }

  function traceStatePath(state) {
    state.shapes.forEach((ring) => {
      ring.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
    });
  }

  function makeStateShape(state, index) {
    const custom = {
      CA: [[0.22, 0], [0.96, 0.03], [0.84, 0.34], [0.92, 0.55], [0.72, 1], [0.36, 0.96], [0.08, 0.48], [0, 0.08]],
      TX: [[0.1, 0], [0.86, 0.02], [0.92, 0.36], [1, 0.54], [0.76, 0.58], [0.68, 0.98], [0.42, 0.78], [0.24, 0.86], [0, 0.55]],
      FL: [[0, 0.14], [0.68, 0.04], [0.78, 0.22], [1, 0.34], [0.92, 0.72], [0.78, 1], [0.62, 0.66], [0.32, 0.42], [0.02, 0.42]],
      MI: [[0.08, 0.3], [0.38, 0], [0.74, 0.06], [1, 0.38], [0.86, 0.92], [0.48, 0.82], [0.34, 0.52], [0, 0.58]],
      NY: [[0, 0.56], [0.28, 0.18], [0.68, 0.08], [1, 0.24], [0.9, 0.64], [0.46, 0.86], [0.12, 0.84]],
      AK: [[0, 0.44], [0.18, 0.14], [0.5, 0], [0.94, 0.18], [1, 0.48], [0.74, 0.74], [0.36, 0.66], [0.2, 1]],
      HI: [[0, 0.52], [0.22, 0.2], [0.5, 0.42], [0.72, 0.08], [1, 0.38], [0.82, 0.86], [0.38, 0.78]],
      ME: [[0.24, 0], [0.8, 0.08], [1, 0.48], [0.72, 1], [0.2, 0.84], [0, 0.36]],
    }[state.abbr];
    if (custom) {
      return custom.map(([x, y]) => ({ x: state.x + x * state.w, y: state.y + y * state.h }));
    }
    const dent = Math.min(8, Math.max(2, Math.min(state.w, state.h) * 0.12));
    const a = hashUnit(index * 7 + 1) * dent;
    const b = hashUnit(index * 7 + 2) * dent;
    const c = hashUnit(index * 7 + 3) * dent;
    const d = hashUnit(index * 7 + 4) * dent;
    return [
      { x: state.x + a, y: state.y },
      { x: state.x + state.w - b, y: state.y + c * 0.4 },
      { x: state.x + state.w, y: state.y + d },
      { x: state.x + state.w - c * 0.5, y: state.y + state.h - b },
      { x: state.x + state.w * 0.55, y: state.y + state.h },
      { x: state.x + a * 0.5, y: state.y + state.h - d },
      { x: state.x, y: state.y + state.h * 0.52 },
      { x: state.x + b * 0.45, y: state.y + a },
    ];
  }

  function hitState(point) {
    const assisted = hitSmallStateAssist(point);
    if (assisted >= 0) return assisted;
    for (let i = states.length - 1; i >= 0; i -= 1) {
      const shapes = states[i].shapes;
      for (let s = 0; s < shapes.length; s += 1) {
        if (pointInPolygon(point, shapes[s])) return i;
      }
    }
    return -1;
  }

  function hitSmallStateAssist(point) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < states.length; i += 1) {
      const state = states[i];
      const radius = SMALL_STATE_HIT_RADIUS[state.abbr];
      if (!radius) continue;
      const dx = point.x - state.cx;
      const dy = point.y - state.cy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const score = dist / radius;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  function pointInPolygon(point, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      const intersects = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function openStateMenu(event, stateIndex) {
    menuState = stateIndex;
    closeStateMenu();
  }

  function closeStateMenu() {
    menuState = -1;
    stateActionMenu.classList.remove("is-open");
  }

  function canvasScreenPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function screenToWorld(point) {
    return {
      x: (point.x - Camera.offsetX) / Camera.zoom,
      y: (point.y - Camera.offsetY) / Camera.zoom,
    };
  }

  function worldToScreen(point) {
    return {
      x: point.x * Camera.zoom + Camera.offsetX,
      y: point.y * Camera.zoom + Camera.offsetY,
    };
  }

  function canvasPoint(event) {
    return screenToWorld(canvasScreenPoint(event));
  }

  function formatMoney(thousands) {
    const dollars = Math.max(0, thousands * 1000);
    if (dollars >= 1000000000) {
      const billions = dollars / 1000000000;
      return `$${billions >= 10 ? Math.round(billions) : billions.toFixed(1)}B`;
    }
    if (dollars >= 1000000) {
      const millions = dollars / 1000000;
      return `$${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
    }
    return `$${Math.round(dollars / 1000)}k`;
  }

  function campaignDaysElapsed() {
    return Math.min(currentMatchMode.days, elapsed / CAMPAIGN_DAY_SECONDS);
  }

  function daysUntilElection() {
    return Math.max(0, currentMatchMode.days - campaignDaysElapsed());
  }

  function formatCampaignDuration(seconds) {
    return `${Math.max(0, seconds / CAMPAIGN_DAY_SECONDS).toFixed(1)}d`;
  }

  function formatCampaignLogTime() {
    return `D-${Math.ceil(daysUntilElection())}`;
  }

  function showToast(message, variant = "") {
    toast.textContent = message;
    toast.classList.toggle("is-compact", variant === "compact");
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
      toast.classList.remove("is-compact");
    }, 2200);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function mix(hex, target, amount) {
    const a = parseHex(hex);
    const b = parseHex(target);
    const m = Math.max(0, Math.min(1, amount));
    const rgb = a.map((value, index) => Math.round(value * (1 - m) + b[index] * m));
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  function parseHex(hex) {
    return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  }

  function hashUnit(seed) {
    const value = Math.sin(seed * 999.17) * 10000;
    return value - Math.floor(value);
  }

  // ===================== PIP-CAMPAIGN 3000 : TALENT TERMINAL =====================
  const TALENT_ORDER = ["oligarchy", "populist", "syndicate", "vanguard"];
  const TALENTS = {
    oligarchy: { name: "CORPORATE OLIGARCHY", sub: "CYBER-PLUTOCRATS", theme: "Fast capital, high-yield extraction, executive defense.", tiers: [
      { left:{id:"aggressive_portfolio",name:"AGGRESSIVE PORTFOLIO",desc:"District Offices cost 30% less to deploy.",live:true},
        right:{id:"hostile_liquidation",name:"HOSTILE LIQUIDATION",desc:"Successful sabotage siphons 50% extra capital from the rival treasury.",live:true} },
      { left:{id:"rapid_construction",name:"RAPID CONSTRUCTION",desc:"Main and District Office build or upgrade timers complete 33% faster.",live:true},
        right:{id:"private_security",name:"PRIVATE SECURITY",desc:"Police upkeep is cut 50%; guarded structures punish enemy sabotage windows.",live:true} },
      { left:{id:"shadow_lobbying",name:"SHADOW LOBBYING",desc:"Level 3 HQ income +50% and global state funding yield x1.25.",live:true,ult:true},
        right:{id:"executive_immunity",name:"EXECUTIVE IMMUNITY",desc:"Public speeches expose your candidate to interrupts for only half the speech window.",live:true,ult:true} },
    ]},
    populist: { name: "POPULIST COALITION", sub: "NEURAL HIVE", theme: "Crowd mobilization, riot pressure, collective shielding.", tiers: [
      { left:{id:"echo_chamber",name:"ECHO CHAMBER",desc:"Public Speeches gain a flat +5% local influence burst.",live:true},
        right:{id:"crowdsourcing",name:"CROWDSOURCING",desc:"District Offices earn +1% passive income per 5% local influence you hold.",live:true} },
      { left:{id:"general_strike",name:"GENERAL STRIKE",desc:"Riots cost 50% less and destroy structures 25% faster.",live:true},
        right:{id:"human_shield",name:"HUMAN SHIELD",desc:"Assassinating your speaking leader costs rivals $50M instead of $40M.",live:true} },
      { left:{id:"great_awakening",name:"THE GREAT AWAKENING",desc:"Completed speeches splash +3% influence into adjacent states.",live:true,ult:true},
        right:{id:"decentralized_hive",name:"DECENTRALIZED HIVE",desc:"If your District Office is destroyed, enemy bases in that state freeze for 3 days.",live:false,ult:true} },
    ]},
    syndicate: { name: "TECHNOCRATIC SYNDICATE", sub: "NETRUNNERS", theme: "Invisible operations, system siphoning, data redundancy.", tiers: [
      { left:{id:"system_overclock",name:"SYSTEM OVERCLOCK",desc:"HQ and District Office upgrades require 20% less local influence.",live:true},
        right:{id:"signal_scrambler",name:"SIGNAL SCRAMBLER",desc:"Sabotage bypasses enemy Police Force protection.",live:true} },
      { left:{id:"backdoor_exploits",name:"BACKDOOR EXPLOITS",desc:"Sabotage cancels a target's District Office upgrade, forcing them to pay again.",live:true},
        right:{id:"ghost_servers",name:"GHOST SERVERS",desc:"Your speaking candidate's exact state is hidden on the global map.",live:false} },
      { left:{id:"skynet_protocol",name:"SKYNET PROTOCOL",desc:"Raises active sabotage or riot operations from 1 to 3.",live:true,ult:true},
        right:{id:"blackout_bypass",name:"BLACKOUT BYPASS",desc:"Assassination blackout drops from 3 campaign days to 1.",live:true,ult:true} },
    ]},
    vanguard: { name: "IRON VANGUARD", sub: "CENTRAL AUTHORITY", theme: "Fortification, martial taxes, immediate retribution.", tiers: [
      { left:{id:"fortified_outposts",name:"FORTIFIED OUTPOSTS",desc:"District Offices take 100% longer to destroy with Riots or Strikes.",live:true},
        right:{id:"martial_law_taxes",name:"MARTIAL LAW TAXES",desc:"Police-guarded bases generate +15% extra cash per day.",live:true} },
      { left:{id:"bureaucratic_hold",name:"BUREAUCRATIC HOLD",desc:"Sabotaging an upgrading enemy base freezes progress for 2 campaign days.",live:true},
        right:{id:"checkpoint_grid",name:"CHECKPOINT GRID",desc:"Police-guarded states make enemy sabotage and riot operations take 35% longer.",live:true} },
      { left:{id:"iron_curtain",name:"IRON CURTAIN",desc:"Level 3 base states are immune to siphoning and cannot drop below 30% influence.",live:true,ult:true},
        right:{id:"retributive_strike",name:"RETRIBUTIVE STRIKE",desc:"Assassination costs only $25M while any rival is speaking.",live:true,ult:true} },
    ]},
    futurist: { name: "CIVIC FUTURISTS", sub: "POLICY LAB", theme: "Scenario planning, policy cascades, resilient messaging.", tiers: [
      { left:{id:"model_polling",name:"MODEL POLLING",desc:"Speeches are 8% stronger in states worth 10+ votes.",live:true},
        right:{id:"hype_train",name:"FEEDBACK LOOP",desc:"Finishing a speech supercharges your next speech by 40%.",live:true} },
      { left:{id:"fast_track_zoning",name:"FAST-TRACK ZONING",desc:"District Office upgrades cost 15% less cash.",live:true},
        right:{id:"damage_control",name:"DAMAGE CONTROL",desc:"If assassinated, nationwide influence loss drops from 5% to 3%.",live:true} },
      { left:{id:"cascade_effect",name:"CASCADE EFFECT",desc:"District Office upgrades add +2% influence into nearby states.",live:true,ult:true},
        right:{id:"continuity_office",name:"CONTINUITY OFFICE",desc:"Assassination blackout is reduced by 1 campaign day.",live:true,ult:true} },
    ]},
    machine: { name: "CINDER MACHINE", sub: "STRIKE APPARATUS", theme: "Industrial discipline, coordinated disruption, hard territorial lockups.", tiers: [
      { left:{id:"picket_lines",name:"PICKET LINES",desc:"Rivals pay 25% more to riot against your District Offices.",live:true},
        right:{id:"wildcat_cells",name:"WILDCAT CELLS",desc:"Riots resolve 35% faster.",live:true} },
      { left:{id:"assembly_line",name:"ASSEMBLY LINE",desc:"District Office deploy and upgrade timers complete 40% faster.",live:true},
        right:{id:"red_tape_trap",name:"RED TAPE TRAP",desc:"Your sabotage operations leave states on 1 less day of cooldown.",live:true} },
      { left:{id:"strike_fund",name:"STRIKE FUND",desc:"Successful riots refund 50% of their launch cost.",live:true,ult:true},
        right:{id:"backlash_cells",name:"BACKLASH CELLS",desc:"If rivals riot your District Office, their cash flow from that state freezes for 3 days.",live:true,ult:true} },
    ]},
    signal: { name: "TEAL WIRE ACCORD", sub: "SIGNAL CARTEL", theme: "Broadcast theft, interception, stealthy message control.", tiers: [
      { left:{id:"dark_fiber",name:"DARK FIBER",desc:"Sabotage operations cost 25% less.",live:true},
        right:{id:"signal_leak",name:"SIGNAL LEAK",desc:"Successful sabotage boosts your news channel influence 25% for 1 day.",live:true} },
      { left:{id:"listening_posts",name:"LISTENING POSTS",desc:"Police-guarded states generate +10% influence cash.",live:true},
        right:{id:"media_magnate",name:"CARRIER LOCK",desc:"Owned news channels push 40% more influence across their coverage states.",live:true} },
      { left:{id:"trend_engine",name:"TREND ENGINE",desc:"Owned news channels push 15% more influence and earn $2M/day each.",live:true,ult:true},
        right:{id:"broadcast_moat",name:"BROADCAST MOAT",desc:"Rivals pay 50% more to take your owned news channels.",live:true,ult:true} },
    ]},
    ledger: { name: "IVORY LEDGER CLUB", sub: "BUDGET COMMITTEE", theme: "Quiet money, procedural control, closed-door efficiency.", tiers: [
      { left:{id:"compliance_forms",name:"COMPLIANCE FORMS",desc:"Starting a District Office grants +5% local influence immediately.",live:true},
        right:{id:"rainy_day_fund",name:"RAINY DAY FUND",desc:"When cash is below $5M, your Main Base generates +$1M/day.",live:true} },
      { left:{id:"permit_stack",name:"FAST-TRACK PERMITS",desc:"Main Base upgrades cost 20% less cash.",live:true},
        right:{id:"media_retainer",name:"MEDIA RETAINER",desc:"News channel buys and takeovers cost 25% less.",live:true} },
      { left:{id:"budget_surplus",name:"BUDGET SURPLUS",desc:"Main Base passive cash output rises by 25% at every HQ level.",live:true,ult:true},
        right:{id:"procurement_office",name:"PROCUREMENT OFFICE",desc:"Normal campaign actions cost 15% less.",live:true,ult:true} },
    ]},
  };

  const HQ_INCOME_DAY = [0, 600, 1500, 3500];
  const HQ_UPGRADE = { 2: { cash: 9000, infl: 15, days: 2 }, 3: { cash: 60000, infl: 60, days: 4 } };
  const TALENT_REQ_LEVEL = [1, 2, 3];
  const ASSASSINATE_COST = 40000;
  const ASSASSINATE_BLACKOUT_DAYS = 3;
  const ASSASSINATE_STRIP = 5;
  const ASSASSINATE_REPEAT_STRIP = 5;
  let pipOpen = false;
  let pipFocusTier = 0;
  let pipFocusSide = 0;
  let pipEl = null;
  let pipHoverKey = "";
  let pipAudio = null;
  let victoryEl = null;
  const pipClamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function botCashBonus(player) {
    if (!player || !player.isBot) return 0;
    const difficulty = difficultyInput?.value || "medium";
    if (difficulty === "hard") return 10000;
    if (difficulty === "medium") return 5000;
    return 0;
  }

  function botActionDiscount(player) {
    if (!player || !player.isBot) return 1;
    const difficulty = difficultyInput?.value || "medium";
    if (difficulty === "hard") return 0.85;
    if (difficulty === "medium") return 0.9;
    return 1;
  }

  function discountedCost(base, player) {
    const procurement = hasTalent(player, "procurement_office") ? 0.85 : 1;
    return Math.round(base * botActionDiscount(player) * procurement);
  }

  function hasTalent(player, id) {
    if (!player || !player.talents || !player.talentTree) return false;
    const tree = TALENTS[player.talentTree];
    if (!tree) return false;
    for (const t in player.talents) {
      const opt = tree.tiers[t] && tree.tiers[t][player.talents[t]];
      if (opt && opt.id === id) return true;
    }
    return false;
  }
  function adHubCost(player) {
    return discountedCost(AD_HUB_COST * (hasTalent(player, "aggressive_portfolio") ? 0.7 : 1), player);
  }
  function mainBaseUpgradeCash(player, nextLevel) {
    const req = HQ_UPGRADE[nextLevel];
    if (!req) return 0;
    return discountedCost(req.cash * (hasTalent(player, "permit_stack") ? 0.8 : 1), player);
  }
  function officeLevel(state, playerId) {
    return Math.max(0, Number(state?.offices?.[playerId] || 0));
  }
  function miniBaseUpgradeReq(player, nextLevel) {
    const req = MINI_BASE_UPGRADE[nextLevel];
    if (!req) return null;
    return {
      cash: discountedCost(req.cash * (hasTalent(player, "fast_track_zoning") ? 0.85 : 1), player),
      infl: Math.ceil(req.infl * (hasTalent(player, "system_overclock") ? 0.8 : 1)),
      days: req.days,
    };
  }
  function miniBaseCashDay(level) {
    return MINI_BASE_CASH_DAY[Math.max(0, Math.min(MINI_BASE_MAX_LEVEL, level))] || 0;
  }
  function miniBaseDefense(level) {
    return MINI_BASE_DEFENSE[Math.max(0, Math.min(MINI_BASE_MAX_LEVEL, level))] || 0;
  }
  function constructionTime(player, seconds) {
    return seconds * (hasTalent(player, "rapid_construction") ? 0.67 : 1);
  }
  function districtOfficeBuildTime(player, seconds) {
    return constructionTime(player, seconds) * (hasTalent(player, "assembly_line") ? 0.6 : 1);
  }
  function policeUpkeepDay(player) {
    return Math.round(POLICE_UPKEEP_DAY * (hasTalent(player, "private_security") ? 0.5 : 1));
  }
  function hqIncomeDay(player) {
    if (!player || player.mainBaseLevel <= 0) return 0;
    const base = HQ_INCOME_DAY[player.mainBaseLevel] || 0;
    const mult = (hasTalent(player, "shadow_lobbying") && player.mainBaseLevel >= 3 ? 1.5 : 1) * (hasTalent(player, "budget_surplus") ? 1.25 : 1);
    const reserve = hasTalent(player, "rainy_day_fund") && player.cash < 5000 ? 1000 : 0;
    return base * mult + reserve;
  }
  function hqIncomeRate(player) {
    return hqIncomeDay(player) / CAMPAIGN_DAY_SECONDS;
  }
  function policeUpkeepRate(player) {
    return policeUpkeepDay(player) / CAMPAIGN_DAY_SECONDS;
  }
  function policeUpkeepPerTick(player, policeCount, dt) {
    return policeUpkeepRate(player) * policeCount * dt;
  }
  function policeAtRisk(player) {
    return !!player && projectedCashPerDay(player) < 0;
  }
  function removeRandomPoliceProtection(player) {
    if (!player) return null;
    const guarded = states.filter((st) => st.police[player.id]);
    if (!guarded.length) return null;
    const picked = guarded[Math.floor(Math.random() * guarded.length)];
    picked.police[player.id] = false;
    picked.activePulse = 1;
    return picked;
  }
  function riotCost(player, target = null) {
    const picketTax = target && hasTalent(target, "picket_lines") ? 1.25 : 1;
    return discountedCost(RIOT_COST * (hasTalent(player, "general_strike") ? 0.5 : 1) * picketTax, player);
  }
  function guardedOperationTime(attacker, target, state, seconds) {
    if (target && state && state.police[target.id] && hasTalent(target, "checkpoint_grid") && !hasTalent(attacker, "signal_scrambler")) {
      return seconds * 1.35;
    }
    return seconds;
  }
  function riotTime(attacker, target, state) {
    let seconds = RIOT_SECONDS;
    if (hasTalent(attacker, "general_strike")) seconds *= 0.75;
    if (hasTalent(attacker, "wildcat_cells")) seconds *= 0.65;
    if (hasTalent(target, "fortified_outposts")) seconds *= 2;
    seconds = guardedOperationTime(attacker, target, state, seconds);
    return seconds;
  }
  function sabotageFreezeDays(player) {
    return hasTalent(player, "bureaucratic_hold") ? 2 : SABOTAGE_FREEZE_DAYS;
  }
  function sabotageCost(player, base) {
    return discountedCost(base * (hasTalent(player, "dark_fiber") ? 0.75 : 1), player);
  }
  function canInterruptAction(player) {
    if (!player || !player.action) return false;
    return player.action.type === "speech" && (player.action.vulnerableLeft ?? player.action.left) > 0;
  }
  function assassinateCost(attacker, target) {
    let cost = ASSASSINATE_COST;
    if (hasTalent(attacker, "retributive_strike") && players.some((p) => p.id !== attacker.id && isSpeaking(p))) cost = 25000;
    if (hasTalent(target, "human_shield") && isSpeaking(target)) cost = Math.max(cost, 50000);
    return cost;
  }
  function tierUnlocked(i, player) {
    player = player || players[HUMAN];
    return !!player && player.mainBaseLevel >= TALENT_REQ_LEVEL[i];
  }
  function pipPoints(player) {
    let n = 0;
    const total = TALENTS[player.talentTree]?.tiers.length || 0;
    for (let i = 0; i < total; i++) if (tierUnlocked(i, player) && player.talents[i] === undefined) n++;
    return n;
  }
  function pipNextUnlock(player) {
    player = player || players[HUMAN];
    const total = TALENTS[player.talentTree]?.tiers.length || 0;
    for (let i = 0; i < total; i++) if (!tierUnlocked(i, player)) return TALENT_REQ_LEVEL[i];
    return null;
  }
  function pipMaybePick(player) {
    if (!player || !player.isBot) return;
    const total = TALENTS[player.talentTree]?.tiers.length || 0;
    for (let i = 0; i < total; i++) {
      if (tierUnlocked(i, player) && player.talents[i] === undefined) {
        const t = TALENTS[player.talentTree].tiers[i];
        let side;
        if (t.left.live && !t.right.live) side = "left";
        else if (t.right.live && !t.left.live) side = "right";
        else side = Math.random() < 0.5 ? "left" : "right";
        player.talents[i] = side;
        return;
      }
    }
  }

  function isSpeaking(player) {
    return !!player && !!player.action && player.action.type === "speech";
  }
  function fundingPerDay(player) {
    if (!player || !states.length) return 0;
    let total = 0;
    for (const st of states) {
      if (st.cashFreeze?.[player.id] > 0) continue;
      const inf = st.influence[player.id];
      const level = officeLevel(st, player.id);
      if (inf > 0) {
        let daily = (1 + (st.ev || 8) * 0.05) * 90 * (inf / 100);
        if (level > 0 && hasTalent(player, "crowdsourcing")) daily *= 1 + (Math.floor(inf / 5) * 0.01);
        if ((level > 0 || player.homeBase === st.index) && st.police[player.id] && hasTalent(player, "martial_law_taxes")) daily *= 1.15;
        if ((level > 0 || player.homeBase === st.index) && st.police[player.id] && hasTalent(player, "listening_posts")) daily *= 1.1;
        total += daily;
      }
      total += miniBaseCashDay(level);
    }
    if (hasTalent(player, "shadow_lobbying")) total *= 1.25;
    if (hasTalent(player, "trend_engine")) total += channels.filter((channel) => channel.owner === player.id).length * 2000;
    return total;
  }

  function financeBreakdown(player) {
    if (!player || !states.length) {
      return { influence: 0, offices: 0, hq: 0, police: 0, net: 0 };
    }
    let influence = 0;
    let offices = 0;
    let policeCount = 0;
    for (const st of states) {
      if (st.cashFreeze?.[player.id] > 0) {
        if (st.police[player.id]) policeCount += 1;
        continue;
      }
      const inf = st.influence[player.id];
      const level = officeLevel(st, player.id);
      if (inf > 0) {
        let daily = (1 + (st.ev || 8) * 0.05) * 90 * (inf / 100);
        if (level > 0 && hasTalent(player, "crowdsourcing")) daily *= 1 + (Math.floor(inf / 5) * 0.01);
        if ((level > 0 || player.homeBase === st.index) && st.police[player.id] && hasTalent(player, "martial_law_taxes")) daily *= 1.15;
        if ((level > 0 || player.homeBase === st.index) && st.police[player.id] && hasTalent(player, "listening_posts")) daily *= 1.1;
        influence += daily;
      }
      offices += miniBaseCashDay(level);
      if (st.police[player.id]) policeCount += 1;
    }
    if (hasTalent(player, "shadow_lobbying")) {
      influence *= 1.25;
      offices *= 1.25;
    }
    if (hasTalent(player, "trend_engine")) influence += channels.filter((channel) => channel.owner === player.id).length * 2000;
    const hq = hqIncomeDay(player);
    const police = policeUpkeepDay(player) * policeCount;
    const net = Math.round(influence + offices + hq - police);
    return {
      influence: Math.round(influence),
      offices: Math.round(offices),
      hq: Math.round(hq),
      police: Math.round(police),
      net,
    };
  }

  function projectedCashPerDay(player) {
    if (!player) return 0;
    let total = fundingPerDay(player) + hqIncomeDay(player);
    let policeCount = 0;
    for (const st of states) {
      if (st.cashFreeze?.[player.id] > 0) {
        if (st.police[player.id]) policeCount += 1;
        continue;
      }
      if (st.police[player.id]) policeCount += 1;
    }
    total -= policeUpkeepDay(player) * policeCount;
    return Math.round(total);
  }

  function formatPerDay(value) {
    const rounded = Math.round(value);
    const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "+";
    return `${sign}${formatMoney(Math.abs(rounded))}/day`;
  }
  function upgradeMainBase(playerId) {
    if (playerId === HUMAN && routeGuestGameCommand('upgradeMainBase', [])) return true;
    const player = players[playerId];
    if (!player || phase !== "play" || matchOver || !canUseCampaignActions(player, playerId)) return false;
    if (player.mainBaseLevel < 1) { if (playerId === HUMAN) showToast("Select a home base first."); return false; }
    if (player.mainBaseLevel >= 3) { if (playerId === HUMAN) showToast("Main Base already at maximum Level 3."); return false; }
    if (missions.some((m) => m.type === "baseUpgrade" && m.player === playerId)) { if (playerId === HUMAN) showToast("Main Base upgrade already under construction."); return false; }
    const next = player.mainBaseLevel + 1;
    const req = { ...HQ_UPGRADE[next], cash: mainBaseUpgradeCash(player, next) };
    const homeInf = states[player.homeBase] ? states[player.homeBase].influence[playerId] : 0;
    const influenceReq = Math.ceil(req.infl * (hasTalent(player, "system_overclock") ? 0.8 : 1));
    if (player.cash < req.cash || homeInf < influenceReq) {
      if (playerId === HUMAN) showToast("HQ L" + next + " needs " + formatMoney(req.cash) + " + " + influenceReq + "% home influence (have " + Math.floor(homeInf) + "%).");
      return false;
    }
    player.cash -= req.cash;
    const time = constructionTime(player, req.days * CAMPAIGN_DAY_SECONDS);
    missions.push({ type: "baseUpgrade", player: playerId, state: player.homeBase, level: next, left: time, total: time });
    states[player.homeBase].activePulse = 1;
    addAlert(player.name + " began upgrading Main Base to Level " + next + ".");
    if (playerId === HUMAN) showToast("Main Base upgrade to L" + next + " underway (" + req.days + " in-game days).");
    return true;
  }
  function assassinate(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('assassinate', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || matchOver || !canUseCampaignActions(player, playerId)) return false;
    const target = players.find((c) => c.id !== playerId && isSpeaking(c) && c.action.state === stateIndex && canInterruptAction(c));
    if (!target) { if (playerId === HUMAN) showToast("Assassination requires a rival giving a SPEECH in this state."); return false; }
    const cost = assassinateCost(player, target);
    if (player.cash < cost) { if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " to authorize this."); return false; }
    player.cash -= cost;
    const casualty = replaceDeadLeader(target);
    target.action = null;
    const blackoutDays = hasTalent(target, "blackout_bypass")
      ? 1
      : Math.max(1, ASSASSINATE_BLACKOUT_DAYS - (hasTalent(target, "continuity_office") ? 1 : 0));
    const targetStrip = hasTalent(target, "damage_control") ? 3 : ASSASSINATE_STRIP;
    target.locked = Math.max(target.locked, blackoutDays * CAMPAIGN_DAY_SECONDS);
    states.forEach((st) => {
      const floor = influenceFloor(target, st);
      st.influence[target.id] = clampInfluence(Math.max(floor, st.influence[target.id] - targetStrip));
    });
    const assassinDay = Math.floor(campaignDaysElapsed());
    if (player.assassinDay !== assassinDay) {
      player.assassinDay = assassinDay;
      player.assassinationsToday = 0;
    }
    player.assassinationsToday += 1;
    if (player.assassinationsToday > 1) {
      states.forEach((st) => {
        const floor = influenceFloor(player, st);
        st.influence[player.id] = clampInfluence(Math.max(floor, st.influence[player.id] - ASSASSINATE_REPEAT_STRIP));
      });
      addAlert(player.name + " triggered a backlash for repeated assassinations (-" + ASSASSINATE_REPEAT_STRIP + "% influence nationwide).");
      if (playerId === HUMAN) showToast("Backlash: repeated assassination today costs -5% influence nationwide.");
    }
    state.activePulse = 1;
    if (target.id === HUMAN) playAssassinationSfx("incoming");
    else playAssassinationSfx("outgoing");
    showAssassinationBroadcast();
    refreshTalentInterfaces();
    broadcast(0, casualty.oldLeader + " of " + target.name + " was killed mid-speech in " + state.name + ". " + casualty.newLeader + " takes over as leader while the campaign goes dark for " + blackoutDays + " days.");
    addAlert(player.name + " assassinated " + casualty.oldLeader + " of " + target.name + " in " + state.name + ". " + casualty.newLeader + " is the new leader (-" + targetStrip + "% nationwide, " + blackoutDays + "-day blackout).");
    triggerClickbait("SIGNAL_SEVER", {
      player: playerId,
      target: target.id,
      state: stateIndex,
      stateName: state.name,
      factionName: player.name,
      opponentName: target.name,
      heat: 25,
      level: "EXTREME",
    });
    return true;
  }

  function playAssassinationSfx(kind) {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const vol = Math.min(1.35, sfxVolume * 1.35);
    const t = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(1, t);
    master.connect(ac.destination);
    const noise = (start, length, gainLevel, decay = 2.4) => {
      const src = ac.createBufferSource();
      const buffer = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * length)), ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, decay);
      }
      const gain = ac.createGain();
      gain.gain.setValueAtTime(gainLevel * vol, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      src.buffer = buffer;
      src.connect(gain).connect(master);
      src.start(start);
    };
    const tone = (type, freq, start, length, gainLevel, endFreq = null) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + length);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(gainLevel * vol, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + length + 0.02);
    };
    if (kind === "incoming") {
      tone("sawtooth", 620, t, 0.5, 0.46, 88);
      tone("square", 96, t + 0.02, 0.72, 0.42, 34);
      noise(t + 0.05, 0.68, 0.62, 1.35);
      tone("triangle", 1180, t + 0.42, 0.28, 0.26, 260);
    } else {
      tone("square", 860, t, 0.1, 0.32, 480);
      noise(t + 0.035, 0.24, 0.54, 2.8);
      tone("sine", 82, t + 0.04, 0.42, 0.4, 32);
      tone("triangle", 1480, t + 0.19, 0.14, 0.22, 620);
    }
  }

  function ensurePipAudio() {
    if (!pipAudio) { try { pipAudio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { pipAudio = null; } }
    if (pipAudio && pipAudio.state === "suspended") pipAudio.resume();
    return pipAudio;
  }
  function pipSfx(kind) {
    if (!soundOn || sfxVolume <= 0) return;
    const ac = ensurePipAudio();
    if (!ac) return;
    const vol = sfxVolume;
    const t = ac.currentTime;
    if (kind === "clunk") {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "square"; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.24);
      const nb = ac.createBufferSource(), buf = ac.createBuffer(1, ac.sampleRate * 0.25, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const ng = ac.createGain(); ng.gain.setValueAtTime(0.25 * vol, t + 0.05); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      nb.buffer = buf; nb.connect(ng).connect(ac.destination); nb.start(t + 0.04);
    } else if (kind === "click") {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "square"; o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(700, t + 0.04);
      g.gain.setValueAtTime(0.22 * vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.07);
    } else if (kind === "inject") {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sawtooth"; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(660, t + 0.18);
      g.gain.setValueAtTime(0.3 * vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.28);
    } else if (kind === "deny") {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "square"; o.frequency.setValueAtTime(140, t); o.frequency.linearRampToValueAtTime(70, t + 0.18);
      g.gain.setValueAtTime(0.28 * vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.22);
    } else if (kind === "glitch") {
      const nb = ac.createBufferSource(), buf = ac.createBuffer(1, ac.sampleRate * 0.6, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (0.6 + 0.4 * Math.sin(i / 40));
      const ng = ac.createGain(); ng.gain.setValueAtTime(0.4 * vol, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      nb.buffer = buf; nb.connect(ng).connect(ac.destination); nb.start(t);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sawtooth"; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.6);
      g.gain.setValueAtTime(0.25 * vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.6);
    }
  }

  function leaderPortraitMarkup(player, className = "leader-portrait") {
    if (!player) return "";
    const palette = player.portrait || FACTIONS[player.factionIndex || 0]?.portrait || FACTIONS[0].portrait;
    const factionIndex = Number.isFinite(player.factionIndex) ? player.factionIndex : 0;
    const profile = player.leaderProfile ? normalizeLeaderProfile(player.leaderProfile) : null;
    const skin = profile?.skin || palette.skin;
    return `<span class="${className}" style="--party:${player.color};--skin:${skin};--hair:${palette.hair};--suit:${palette.suit};--accent:${palette.accent};display:block;overflow:hidden">${leaderPortraitSvg(factionIndex, profile)}</span>`;
  }

  function pipMascot(player) {
    return leaderPortraitMarkup(player, "leader-portrait pip-leader-portrait");
  }

  function buildVictoryDom() {
    if (victoryEl) return;
    victoryEl = document.createElement("div");
    victoryEl.className = "victory-overlay";
    victoryEl.innerHTML = '<div class="victory-card">' +
      '<div class="victory-kicker">ELECTION NIGHT</div>' +
      '<div class="victory-body" id="victoryBody"></div>' +
      '<button class="primary-button victory-close" type="button" data-victory-close>Close</button>' +
      '</div>';
    document.body.appendChild(victoryEl);
    victoryEl.addEventListener("click", (event) => {
      if (event.target === victoryEl || event.target.closest("[data-victory-close]")) {
        victoryEl.classList.remove("is-open");
      }
    });
  }

  function showVictoryScreen(winner, reason) {
    buildVictoryDom();
    if (!victoryEl || !winner) return;
    const body = victoryEl.querySelector("#victoryBody");
    if (!body) return;
    body.innerHTML =
      '<div class="victory-portrait-wrap">' + leaderPortraitMarkup(winner.player, "leader-portrait victory-portrait") + '</div>' +
      '<div class="victory-copy">' +
      `<h2>${escapeHtml(winner.player.name)} Wins</h2>` +
      `<p>${escapeHtml(winner.player.leader)} leads the winning ticket.</p>` +
      `<div class="victory-reason">${escapeHtml(reason)}</div>` +
      '<div class="victory-stats">' +
      `<div><span>Electoral Vote</span><strong>${winner.electoral}/${totalElectoralVotes()}</strong></div>` +
      `<div><span>States Led</span><strong>${winner.states}</strong></div>` +
      `<div><span>HQ Level</span><strong>${winner.player.mainBaseLevel}</strong></div>` +
      '</div></div>';
    victoryEl.classList.add("is-open");
  }

  function showVoteCountingScreen(standings, winner, reason) {
    buildVictoryDom();
    if (!victoryEl || !winner) return;
    const body = victoryEl.querySelector("#victoryBody");
    if (!body) return;
    const totalEv = totalElectoralVotes();
    const rows = standings.map((item, index) => `
      <div class="count-row" style="--party:${item.player.color}">
        <span class="count-rank">${index + 1}</span>
        <span class="count-name">${escapeHtml(item.player.name)}</span>
        <span class="count-bar"><i style="width:0%"></i></span>
        <strong data-count-votes="${item.player.id}">0</strong>
      </div>
    `).join("");
    body.innerHTML =
      '<div class="counting-screen">' +
      '<div class="counting-title">COUNTING ELECTORAL VOTES</div>' +
      '<div class="counting-subtitle">Precinct feeds syncing...</div>' +
      `<div class="counting-total">${totalEv} TOTAL ELECTORAL VOTES</div>` +
      `<div class="counting-rows">${rows}</div>` +
      '</div>';
    victoryEl.classList.add("is-open");
    const startedAt = performance.now();
    const duration = 3600;
    const tick = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      standings.forEach((item) => {
        const number = body.querySelector(`[data-count-votes="${item.player.id}"]`);
        const row = number?.closest(".count-row");
        const bar = row?.querySelector(".count-bar i");
        const votes = Math.round(item.electoral * eased);
        if (number) number.textContent = String(votes);
        if (bar) bar.style.width = `${Math.max(2, (votes / Math.max(1, totalEv)) * 100)}%`;
      });
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }
      window.setTimeout(() => showVictoryScreen(winner, reason), 850);
    };
    requestAnimationFrame(tick);
  }

  function buildPipDom() {
    pipEl = document.createElement("div");
    pipEl.className = "pip-terminal";
    pipEl.innerHTML = '<div class="pip-screen"><div class="pip-scan"></div>' +
      '<div class="pip-head"><div class="pip-brand" id="pipBrand">[ PIP-CAMPAIGN 3000 ]</div><div class="pip-stats" id="pipStats"></div></div>' +
      '<div class="pip-sub"><div id="pipFaction"></div><div class="pip-mascot" id="pipMascot"></div></div>' +
      '<div class="pip-controls" id="pipControls"></div>' +
      '<div class="pip-tree" id="pipTree"></div>' +
      '<div class="pip-foot">[W/S] TIER &nbsp; [A/D] OPTION &nbsp; [ENTER] INJECT TALENT &nbsp; [U] UPGRADE HQ &nbsp; [TAB] EXIT TERMINAL</div>' +
      '</div>';
    document.body.appendChild(pipEl);
    pipEl.addEventListener("mouseover", (event) => {
      const node = event.target.closest("[data-pip-tier][data-pip-side]");
      if (!node) return;
      const nextTier = Number(node.dataset.pipTier) || 0;
      const nextSide = node.dataset.pipSide === "right" ? 1 : 0;
      const nextKey = `${nextTier}:${nextSide}`;
      if (nextKey === pipHoverKey && pipFocusTier === nextTier && pipFocusSide === nextSide) return;
      pipHoverKey = nextKey;
      pipFocusTier = nextTier;
      pipFocusSide = nextSide;
      pipSfx("click");
      renderPip();
    });
    pipEl.addEventListener("mouseleave", () => {
      pipHoverKey = "";
    });
    pipEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-pip-action]");
      const node = event.target.closest("[data-pip-tier][data-pip-side]");
      if (!button && !node) return;
      if (node) {
        pipFocusTier = Number(node.dataset.pipTier) || 0;
        pipFocusSide = node.dataset.pipSide === "right" ? 1 : 0;
        pipSelect();
        if (typeof updateUi === "function") updateUi(true);
        return;
      }
      const action = button.dataset.pipAction;
      if (action === "upgrade-hq") upgradeMainBase(HUMAN);
      renderPip();
      if (typeof updateUi === "function") updateUi(true);
    });
  }

  function renderPip() {
    if (!pipEl) buildPipDom();
    const human = players[HUMAN];
    if (!human) return;
    const tree = TALENTS[human.talentTree];
    const days = typeof daysUntilElection === "function" ? Math.ceil(daysUntilElection()) : 60;
    const next = pipNextUnlock(human);
    const hqUnlocked = human.mainBaseLevel >= 1;
    const nextHq = hqUnlocked && human.mainBaseLevel < 3 ? human.mainBaseLevel + 1 : null;
    const hqReq = nextHq ? { ...HQ_UPGRADE[nextHq], cash: mainBaseUpgradeCash(human, nextHq) } : null;
    const homeState = human.homeBase >= 0 ? states[human.homeBase] : null;
    const homeInfluence = homeState ? Math.floor(homeState.influence[HUMAN] || 0) : 0;
    const hqInfluenceReq = hqReq ? Math.ceil(hqReq.infl * (hasTalent(human, "system_overclock") ? 0.8 : 1)) : 0;
    const hqBaseReq = nextHq === 3 ? ' &middot; Base req $60M / 60%' : '';
    const hqUpgradeBusy = missions.some((mission) => mission.type === "baseUpgrade" && mission.player === HUMAN);
    pipEl.querySelector("#pipBrand").textContent = "[ " + human.name.toUpperCase() + " ]";
    pipEl.querySelector("#pipStats").innerHTML =
      "CASH: " + formatMoney(human.cash) + " &nbsp;|&nbsp; DAYS: " + days;
    const fund = Math.round(fundingPerDay(human) + hqIncomeDay(human));
    pipEl.querySelector("#pipFaction").innerHTML =
      "FACTION PROTOCOL: [ " + tree.name + " / " + tree.sub + " ]<br>" +
      "LEADER: [ " + escapeHtml(human.leader) + " ]<br>" +
      "THEME: " + tree.theme + "<br>" +
      "MAIN BASE: [ LEVEL " + human.mainBaseLevel + " ]  PASSIVE: " + formatMoney(hqIncomeDay(human)) + "/day<br>" +
      "PROJECTED FUNDING: ~" + formatMoney(fund) + "/day";
    pipEl.querySelector("#pipMascot").innerHTML = pipMascot(human);
    pipEl.querySelector("#pipControls").innerHTML =
      '<div class="pip-control-card">' +
      '<div class="pip-control-title">MAIN BASE CONTROL</div>' +
      '<div class="pip-control-copy">' +
      (!hqUnlocked
        ? 'Select your home base on the map to bring the Main Base online.'
        : nextHq
        ? ('Next Tier: HQ L' + nextHq + ' &middot; Cost ' + formatMoney(hqReq.cash) + ' &middot; Needs ' + hqInfluenceReq + '% home influence (have ' + homeInfluence + '%)' + hqBaseReq)
        : 'Main Base is already at maximum Level 3.') +
      '</div>' +
      '<button class="primary-button pip-control-button" type="button" data-pip-action="upgrade-hq"' +
      ((nextHq && !hqUpgradeBusy && human.cash >= hqReq.cash && homeInfluence >= hqInfluenceReq) ? '' : ' disabled') + '>' +
      (!hqUnlocked
        ? 'SELECT HOME BASE FIRST'
        : nextHq
        ? (hqUpgradeBusy ? 'HQ UPGRADE UNDERWAY' : ('UPGRADE TO HQ L' + nextHq + ' - ' + formatMoney(hqReq.cash) + ' - ' + hqInfluenceReq + '%'))
        : 'HQ MAXED') +
      '</button></div>';
    const rows = tree.tiers.map((tier, i) => {
      const unlocked = tierUnlocked(i, human);
      const chosen = human.talents[i];
      const sides = ["left", "right"].map((side, si) => {
        const opt = tier[side];
        const isChosen = chosen === side;
        const isStamped = chosen && chosen !== side;
        const focus = pipFocusTier === i && pipFocusSide === si;
        const mark = isChosen ? "(x)" : unlocked ? "( )" : "[ ]";
        let cls = "pip-node";
        if (isChosen) cls += " selected";
        if (isStamped) cls += " stamped";
        if (!unlocked) cls += " locked";
        if (opt.ult) cls += " ult";
        if (focus) cls += " focus";
        if (!opt.live) cls += " inert";
        return '<div class="' + cls + '" data-pip-tier="' + i + '" data-pip-side="' + side + '" role="button" tabindex="0" aria-label="Select ' + opt.name + '"><div class="pip-node-h">' + mark + " " + opt.name +
          (opt.ult ? ' <span class="pip-ult-tag">ULT</span>' : "") +
          (opt.live ? "" : ' <span class="pip-inert-tag">SPEC</span>') + '</div>' +
          '<div class="pip-node-d">' + opt.desc + "</div></div>";
      }).join('<div class="pip-vs">&lt;-&gt;</div>');
      const status = chosen ? "INJECTED" : unlocked ? "AVAILABLE" : "LOCKED - NEEDS HQ L" + TALENT_REQ_LEVEL[i];
      return '<div class="pip-tier' + (unlocked ? "" : " is-locked") + '">' +
        '<div class="pip-tier-tag">[HQ L' + TALENT_REQ_LEVEL[i] + '] <span>' + status + '</span></div>' +
        '<div class="pip-row">' + sides + '</div></div>' +
        (i < tree.tiers.length - 1 ? '<div class="pip-wire' + (tierUnlocked(i + 1, human) ? " hot" : "") + '">|</div>' : "");
    }).join("");
    pipEl.querySelector("#pipTree").innerHTML = rows;
  }

  function openPip() {
    if (!gameStarted) return;
    closeRivalTalentViewer();
    pipOpen = true;
    if (!pipEl) buildPipDom();
    const human = players[HUMAN];
    pipFocusTier = 0; pipFocusSide = 0;
    const total = TALENTS[human.talentTree]?.tiers.length || 0;
    for (let i = 0; i < total; i++) { if (tierUnlocked(i, human) && human.talents[i] === undefined) { pipFocusTier = i; break; } }
    pipHoverKey = `${pipFocusTier}:${pipFocusSide}`;
    pipEl.classList.add("is-open");
    document.body.classList.add("pip-active");
    pipSfx("clunk");
    renderPip();
  }
  function closePip() {
    pipOpen = false;
    pipHoverKey = "";
    if (pipEl) pipEl.classList.remove("is-open");
    document.body.classList.remove("pip-active");
    pipSfx("clunk");
  }
  function togglePip() { pipOpen ? closePip() : openPip(); }

  function pipMove(dTier, dSide) {
    const human = players[HUMAN];
    const total = TALENTS[human?.talentTree]?.tiers.length || 1;
    pipFocusTier = pipClamp(pipFocusTier + dTier, 0, total - 1);
    pipFocusSide = pipClamp(pipFocusSide + dSide, 0, 1);
    pipSfx("click");
    renderPip();
  }
  function pipSelect() {
    const human = players[HUMAN];
    const i = pipFocusTier, side = pipFocusSide ? "right" : "left";
    if (!tierUnlocked(i, human)) { pipSfx("deny"); flashPip("LOCKED - needs Main Base Level " + TALENT_REQ_LEVEL[i]); return; }
    if (human.talents[i] !== undefined) { pipSfx("deny"); flashPip("TIER ALREADY INJECTED - choice is permanent"); return; }
    if (routeGuestGameCommand('selectTalent', [i, side])) {
      pipSfx('inject');
      flashPip('Talent choice sent to host.');
      return;
    }
    human.talents[i] = side;
    const opt = TALENTS[human.talentTree].tiers[i][side];
    pipSfx("inject");
    if (opt.ult) {
      document.body.classList.add("pip-glitch");
      pipSfx("glitch");
      addAlert("TIER 3 ALERT: " + human.name + " activated " + opt.name + ".");
      broadcast(0, "PIP-CAMPAIGN emergency bulletin: " + human.name + " has reached Tier 3 and injected " + opt.name + ".");
      setTimeout(() => document.body.classList.remove("pip-glitch"), 700);
    }
    renderPip();
    if (typeof showToast === "function") showToast("TALENT INJECTED: " + opt.name + (opt.live ? "" : " (spec only - mechanic not in this build)"));
  }
  function flashPip(msg) {
    if (typeof showToast === "function") showToast(msg);
  }

  document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.key === "Tab") { e.preventDefault(); togglePip(); return; }
    if (!pipOpen) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") { e.preventDefault(); closePip(); }
    else if (k === "u") { e.preventDefault(); upgradeMainBase(HUMAN); renderPip(); if (typeof updateUi === "function") updateUi(true); }
    else if (k === "w" || e.key === "ArrowUp") { e.preventDefault(); pipMove(-1, 0); }
    else if (k === "s" || e.key === "ArrowDown") { e.preventDefault(); pipMove(1, 0); }
    else if (k === "a" || e.key === "ArrowLeft") { e.preventDefault(); pipMove(0, -1); }
    else if (k === "d" || e.key === "ArrowRight") { e.preventDefault(); pipMove(0, 1); }
    else if (e.key === "Enter") { e.preventDefault(); pipSelect(); }
  });


  // ===================== ACTION HOTBAR + NEW OPERATIONS =====================
  const SABOTAGE_COST = 8000;
  const SABOTAGE_FREEZE_DAYS = 1;
  const SABOTAGE_STATE_COOLDOWN_DAYS = 3;
  const SABOTAGE_CASH_STEAL_RATE = 0.06;
  const SABOTAGE_SECONDS = 6;
  const RIOT_COST = 15000;
  const RIOT_SECONDS = 10;
  const POLICE_RIOT_BLOCK_COST = 500000;
  const POLICE_UPKEEP_DAY = 1500;
  const POLICE_UPKEEP_RATE = POLICE_UPKEEP_DAY / CAMPAIGN_DAY_SECONDS;

  function operationLimit(player) {
    return hasTalent(player, "skynet_protocol") ? 3 : 1;
  }

  function activeDisruptionOps(playerId) {
    return missions.filter((mission) =>
      mission.player === playerId &&
      (mission.type === "sabotage" || mission.type === "riot")
    ).length;
  }

  function canStartDisruptionOp(player, playerId) {
    return activeDisruptionOps(playerId) < operationLimit(player);
  }

  function sabotage(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('sabotage', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || matchOver || !canUseCampaignActions(player, playerId)) return false;
    if (!canStartDisruptionOp(player, playerId)) {
      if (playerId === HUMAN) showToast("Operation limit reached (" + activeDisruptionOps(playerId) + "/" + operationLimit(player) + ").");
      return false;
    }
    if (state.sabotageCooldown > 0) {
      if (playerId === HUMAN) showToast(`${state.abbr} is on sabotage cooldown (${Math.ceil(state.sabotageCooldown / CAMPAIGN_DAY_SECONDS)}d).`);
      return false;
    }
    const rivalsHere = players.filter((candidate) => candidate.id !== playerId && (officeLevel(state, candidate.id) > 0 || candidate.homeBase === stateIndex));
    if (!rivalsHere.length) { if (playerId === HUMAN) showToast("No rival structure in this state to sabotage."); return false; }
    const cost = sabotageCost(player, SABOTAGE_COST);
    if (player.cash < cost) { if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " for a sabotage op."); return false; }
    const officeUpgradeMission = hasTalent(player, "backdoor_exploits")
      ? missions.find((mission) =>
        mission.type === "officeUpgrade" &&
        mission.state === stateIndex &&
        mission.player !== playerId &&
        rivalsHere.some((candidate) => candidate.id === mission.player)
      )
      : null;
    let target = officeUpgradeMission ? players[officeUpgradeMission.player] : rivalsHere.find((candidate) => candidate.homeBase === stateIndex && missions.some((mission) => mission.type === "baseUpgrade" && mission.player === candidate.id));
    const backdoor = !!officeUpgradeMission;
    const freeze = !backdoor && !!target;
    if (!target) target = rivalsHere.slice().sort((a, b) => (state.influence[b.id] || 0) - (state.influence[a.id] || 0))[0];
    player.cash -= cost;
    const seconds = guardedOperationTime(player, target, state, SABOTAGE_SECONDS);
    missions.push({ type: "sabotage", player: playerId, target: target.id, state: stateIndex, backdoor, freeze, left: seconds, total: seconds });
    state.sabotageCooldown = Math.max(1, SABOTAGE_STATE_COOLDOWN_DAYS - (hasTalent(player, "red_tape_trap") ? 1 : 0)) * CAMPAIGN_DAY_SECONDS;
    state.activePulse = 1;
    addAlert(player.name + " launched a sabotage operation against " + target.name + " in " + state.name + ".");
    return true;
  }

  function completeSabotageOperation(mission) {
    const player = players[mission.player];
    const state = states[mission.state];
    const target = players[mission.target];
    if (!player || !state || !target) return;
    addHeat(player, 12);
    if (hasTalent(target, "iron_curtain") && target.homeBase === state.index && target.mainBaseLevel >= 3) {
      addAlert(player.name + "'s siphon attempt bounced off " + target.name + "'s Iron Curtain in " + state.name + ".");
      if (player.id === HUMAN) showToast("Iron Curtain blocks siphoning in this Level 3 base state.");
      return;
    }
    if (state.police[target.id] && !hasTalent(player, "signal_scrambler")) {
      addAlert(player.name + "'s operative was caught by " + target.name + "'s police in " + state.name + ".");
      if (player.id === HUMAN) showToast("Operative caught - police were guarding that state.");
      return;
    }
    if (mission.backdoor) {
      const officeUpgradeMission = missions.find((candidate) =>
        candidate.type === "officeUpgrade" &&
        candidate.state === mission.state &&
        candidate.player === target.id
      );
      if (!officeUpgradeMission) {
        addAlert(player.name + "'s backdoor found no active District Office upgrade in " + state.name + ".");
        if (player.id === HUMAN) showToast("Sabotage landed: no active District Office upgrade found in " + state.abbr + ".");
        return;
      }
      missions = missions.filter((candidate) => candidate !== officeUpgradeMission);
      addAlert(player.name + " backdoored " + target.name + "'s District Office upgrade in " + state.name + ". The upgrade fee must be paid again.");
      if (player.id === HUMAN) showToast("Sabotage landed: " + target.name + "'s District Office upgrade canceled. They must pay again.");
      if (target.id === HUMAN) showToast("District Office upgrade canceled by sabotage. Upgrade fee must be paid again.");
    } else if (mission.freeze) {
      const days = sabotageFreezeDays(player);
      missions.filter((candidate) => candidate.type === "baseUpgrade" && candidate.player === target.id).forEach((candidate) => { candidate.left += days * CAMPAIGN_DAY_SECONDS; });
      addAlert(player.name + " froze " + target.name + "'s Main Base upgrade in " + state.name + " for " + days + " days.");
      if (player.id === HUMAN) showToast("Sabotage landed: " + target.name + "'s HQ upgrade delayed " + days + " days.");
    } else {
      const siphon = Math.min(target.cash, Math.round(target.cash * SABOTAGE_CASH_STEAL_RATE * (hasTalent(player, "hostile_liquidation") ? 1.5 : 1)));
      target.cash -= siphon;
      player.cash += siphon;
      addAlert(player.name + " siphoned " + formatMoney(siphon) + " from " + target.name + "'s war chest in " + state.name + ".");
      if (player.id === HUMAN) showToast("Sabotage landed: stole " + formatMoney(siphon) + " from " + target.name + ".");
      triggerClickbait("BACKDOOR_HACK", {
        player: player.id,
        target: target.id,
        state: state.index,
        stateName: state.name,
        factionName: player.name,
        opponentName: target.name,
        cashValue: siphon,
        heat: 12,
      });
    }
    if (hasTalent(player, "signal_leak")) {
      player.signalLeakBoost = Math.max(player.signalLeakBoost || 0, CAMPAIGN_DAY_SECONDS);
      addAlert(player.name + "'s Signal Leak boosted owned news channels for 1 day.");
    }
    state.activePulse = 1;
    actionEffects.push({ type: "sabotage", player: player.id, target: target.id, state: state.index, left: 1.8, total: 1.8 });
  }
  function instigateRiot(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('instigateRiot', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || matchOver || !canUseCampaignActions(player, playerId)) return false;
    if (!canStartDisruptionOp(player, playerId)) {
      if (playerId === HUMAN) showToast("Operation limit reached (" + activeDisruptionOps(playerId) + "/" + operationLimit(player) + ").");
      return false;
    }
    const target = players.filter((c) => c.id !== playerId && officeLevel(state, c.id) > 0)
      .sort((a, b) => (state.influence[b.id] || 0) - (state.influence[a.id] || 0))[0];
    if (!target) { if (playerId === HUMAN) showToast("No rival District Office here to riot against."); return false; }
    const cost = riotCost(player, target);
    if (player.cash < cost) { if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " to incite unrest."); return false; }
    if (missions.some((m) => m.type === "riot" && m.player === playerId && m.state === stateIndex)) { if (playerId === HUMAN) showToast("A riot is already brewing here."); return false; }
    player.cash -= cost;
    const seconds = riotTime(player, target, state);
    missions.push({ type: "riot", player: playerId, target: target.id, state: stateIndex, cost, left: seconds, total: seconds });
    state.activePulse = 1;
    addAlert(player.name + " is inciting a riot against " + target.name + "'s District Office in " + state.name + ".");
    if (playerId === HUMAN && hasTalent(target, "picket_lines")) {
      showToast("Picket Lines active: riot cost increased to " + formatMoney(cost) + ".");
    }
    triggerClickbait("INCITE_STRIKE", {
      player: playerId,
      target: target.id,
      state: stateIndex,
      stateName: state.name,
      factionName: player.name,
      opponentName: target.name,
      heat: 15,
    });
    return true;
  }

  function togglePolice(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('togglePolice', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || matchOver || !canUseCampaignActions(player, playerId)) return false;
    const owns = player.homeBase === stateIndex || officeLevel(state, playerId) > 0;
    if (!owns) { if (playerId === HUMAN) showToast("No friendly base in this state to protect."); return false; }
    state.police[playerId] = !state.police[playerId];
    addAlert(player.name + (state.police[playerId] ? " deployed police to " : " pulled police from ") + state.name + (state.police[playerId] ? " (" + formatMoney(policeUpkeepDay(player)) + "/day upkeep)." : "."));
    if (playerId === HUMAN) {
      showToast(state.police[playerId]
        ? "Police deployed: " + state.abbr + " guarded for " + formatMoney(policeUpkeepDay(player)) + "/day."
        : "Police removed: " + state.abbr + " is no longer guarded.");
    }
    if (state.police[playerId]) {
      triggerClickbait("ENFORCER_PATROL", {
        player: playerId,
        state: stateIndex,
        stateName: state.name,
        factionName: player.name,
        heat: 5,
        level: "MEDIUM",
      });
    }
    state.activePulse = 1;
    return true;
  }

  function executeArmed(stateIndex) {
    const a = armedAction;
    clearArmed();
    if (a === "deployMiniBase") placeAdHub(HUMAN, stateIndex);
    else if (a === "publicSpeech") startAction(HUMAN, "speech", stateIndex);
    else if (a === "upgradeMiniBase") upgradeMiniBase(HUMAN, stateIndex);
    else if (a === "sabotage") sabotage(HUMAN, stateIndex);
    else if (a === "instigateRiot") instigateRiot(HUMAN, stateIndex);
    else if (a === "togglePolice") togglePolice(HUMAN, stateIndex);
    else if (a === "assassinate") assassinate(HUMAN, stateIndex);
    if (typeof updateUi === "function") updateUi(true);
  }
  function clearArmed() {
    armedAction = null;
    const b = document.getElementById("hotBanner");
    if (b) b.classList.remove("is-on");
    refreshHotbar();
  }

  const HOTBAR = [
    { key: "1", action: "deployMiniBase", icon: "\u2302", name: "DISTRICT OFFICE", cost: 2000,
      tip: ["DEPLOY DISTRICT OFFICE", "Build a Level 1 office in this state.", "Takes half a campaign day.", "Adds daily cash, passive influence, and local defense."] },
    { key: "2", action: "publicSpeech", icon: "\u25C9", name: "SPEECH", cost: 0,
      tip: ["PUBLIC SPEECH", "Send your leader to rally here.", "Lasts 1 campaign day.", "Fast influence, but your leader is exposed."] },
    { key: "3", action: "upgradeMiniBase", icon: "\u25B3", name: "UPGRADE", cost: null,
      tip: ["UPGRADE DISTRICT OFFICE", "Improve one of your offices.", "Click the office icon after arming.", "More cash, influence pressure, and defense."] },
    { key: "4", action: "sabotage", icon: "\u2715", name: "SABOTAGE", cost: 8000,
      tip: ["SABOTAGE", "Timed operation against a rival state.", "Can delay upgrades or steal cash.", "Uses an operation slot until it lands."] },
    { key: "5", action: "instigateRiot", icon: "\u26A0", name: "RIOT", cost: 15000,
      tip: ["INSTIGATE RIOT", "Damage rival offices in this state.", "Lands after 10 seconds.", "Police blocks only if defender pays $500K."] },
    { key: "6", action: "togglePolice", icon: "\u25EC", name: "POLICE", cost: 0,
      tip: ["DEPLOY POLICE", "Protect a state where you have a base.", "Blocks riots for $500K each.", "If unpaid, riot lands and police leaves that state."] },
    { key: "7", action: "assassinate", icon: "\u2297", name: "ASSASSIN", cost: 40000,
      tip: ["ASSASSINATION", "Kill a rival leader during a speech.", "Target gets a new leader and portrait.", "Target loses 5%; repeat kills same day cost you 5%."] },
  ];

  let hotbarEl = null;
  let hotTipEl = null;
  let influenceBarEl = null;
  let hotFinanceEl = null;
  function hotbarCost(slot, human) {
    if (!human) return slot.cost;
    if (slot.action === "deployMiniBase") return adHubCost(human);
    if (slot.action === "upgradeMiniBase") {
      const state = states[selectedState];
      const level = state ? officeLevel(state, HUMAN) : 0;
      const req = level > 0 && level < MINI_BASE_MAX_LEVEL ? miniBaseUpgradeReq(human, level + 1) : null;
      return req ? req.cash : null;
    }
    if (slot.action === "instigateRiot") {
      const state = states[selectedState];
      const target = state ? players.filter((candidate) => candidate.id !== HUMAN && officeLevel(state, candidate.id) > 0)
        .sort((a, b) => (state.influence[b.id] || 0) - (state.influence[a.id] || 0))[0] : null;
      return riotCost(human, target);
    }
    if (slot.action === "sabotage") return sabotageCost(human, SABOTAGE_COST);
    if (slot.action === "togglePolice") return 0;
    if (slot.action === "assassinate") return ASSASSINATE_COST;
    return slot.cost;
  }
  function buildHotbar() {
    const stage = document.querySelector(".map-stage");
    if (!stage) return;
    hotbarEl = document.createElement("div");
    hotbarEl.className = "hotbar";
    hotbarEl.innerHTML =
      '<div class="hot-banner" id="hotBanner">\u25B6 TARGET A STATE &middot; press ESC to cancel</div>' +
      '<div class="global-influence" id="globalInfluenceBar" aria-label="Electoral vote totals">' +
      '<div class="global-influence-head"><span>ELECTORAL VOTES</span><strong>50% CONTROL LINE</strong></div>' +
      '<div class="global-influence-track"></div></div>' +
      '<div class="hot-bottom"><div class="hot-finance" id="hotFinanceBar">CASH $0 (+$0/day)</div><div class="hot-slots">' +
      HOTBAR.map((s, i) =>
        '<button class="hotslot" data-i="' + i + '"><span class="hk">' + s.key + '</span>' +
        '<span class="hic">' + s.icon + '</span><span class="hnm">' + s.name + '</span>' +
        '<span class="hcost">' + (s.cost === null ? "VARIES" : s.cost === 0 ? (s.action === "togglePolice" ? "$1.5M/D" : "FREE") : formatMoney(s.cost)) + '</span></button>'
      ).join("") + '</div></div>';
    stage.appendChild(hotbarEl);
    influenceBarEl = hotbarEl.querySelector("#globalInfluenceBar");
    hotFinanceEl = hotbarEl.querySelector("#hotFinanceBar");
    hotTipEl = document.createElement("div");
    hotTipEl.className = "hot-tooltip";
    document.body.appendChild(hotTipEl);
    if (influenceBarEl) {
      influenceBarEl.addEventListener("mouseenter", () => showInfluenceTip());
      influenceBarEl.addEventListener("mousemove", () => positionHotTip(influenceBarEl));
      influenceBarEl.addEventListener("mouseleave", () => { hotTipEl.classList.remove("is-on"); });
    }
    if (hotFinanceEl) {
      hotFinanceEl.addEventListener("mouseenter", () => showFinanceTip());
      hotFinanceEl.addEventListener("mousemove", () => positionHotTip(hotFinanceEl));
      hotFinanceEl.addEventListener("mouseleave", () => { hotTipEl.classList.remove("is-on"); });
    }
    hotbarEl.querySelectorAll(".hotslot").forEach((btn) => {
      const i = Number(btn.dataset.i);
      btn.addEventListener("click", () => armSlot(i));
      btn.addEventListener("mouseenter", () => showHotTip(i, btn));
      btn.addEventListener("mousemove", () => positionHotTip(btn));
      btn.addEventListener("mouseleave", () => { hotTipEl.classList.remove("is-on"); });
    });
    refreshHotbar();
    setInterval(refreshHotbar, 400);
  }
  function showHotTip(i, btn) {
    const s = HOTBAR[i];
    const human = players[HUMAN];
    const cost = hotbarCost(s, human);
    const costLabel = s.action === "upgradeMiniBase"
      ? `${formatMoney(adHubCost(human))}/${formatMoney(miniBaseUpgradeReq(human, 2)?.cash || 0)}/${formatMoney(miniBaseUpgradeReq(human, 3)?.cash || 0)}`
      : s.action === "togglePolice"
      ? `${formatMoney(policeUpkeepDay(human))}/D`
      : cost === 0
      ? "FREE"
      : formatMoney(cost);
    hotTipEl.innerHTML =
      '<div class="htt"><span>' + s.tip[0] + '</span><strong>' + costLabel + '</strong></div>' +
      s.tip.slice(1).map((line) => '<div class="htl">' + line + "</div>").join("");
    hotTipEl.classList.add("is-on");
    positionHotTip(btn);
  }
  function showFinanceTip() {
    const human = players[HUMAN];
    if (!human || !hotFinanceEl) return;
    const flow = financeBreakdown(human);
    hotTipEl.innerHTML =
      '<div class="htt"><span>CASH FLOW</span><strong>' + formatPerDay(flow.net) + '</strong></div>' +
      '<div class="htl">HQ income: ' + formatMoney(flow.hq) + '/day</div>' +
      '<div class="htl">Influence income: ' + formatMoney(flow.influence) + '/day</div>' +
      '<div class="htl">District Offices: ' + formatMoney(flow.offices) + '/day</div>' +
      '<div class="htl">Police upkeep: -' + formatMoney(flow.police) + '/day</div>';
    hotTipEl.classList.add("is-on");
    positionHotTip(hotFinanceEl);
  }
  function showChannelTip(card) {
    if (!hotTipEl) return;
    hotTipEl.innerHTML =
      '<div class="htt"><span>NEWS CHANNEL</span><strong>' + formatMoney(CHANNEL_COST) + '</strong></div>' +
      '<div class="htl">Buy or take control of this network.</div>' +
      '<div class="htl">It slowly builds influence across its covered states.</div>';
    hotTipEl.classList.add("is-on");
    positionHotTip(card);
  }
  function positionHotTip(btn) {
    const r = btn.getBoundingClientRect();
    hotTipEl.style.left = Math.round(r.left + r.width / 2) + "px";
    hotTipEl.style.top = "auto";
    hotTipEl.style.bottom = Math.round(window.innerHeight - r.top + 18) + "px";
  }
  function refreshHotbar() {
    if (!hotbarEl) return;
    hotbarEl.style.display = gameStarted ? "block" : "none";
    const human = players[HUMAN];
    refreshInfluenceBar();
    if (hotFinanceEl && human) {
      hotFinanceEl.textContent = `CASH ${formatMoney(human.cash)} (${formatPerDay(projectedCashPerDay(human))})`;
    }
    hotbarEl.querySelectorAll(".hotslot").forEach((btn) => {
      const s = HOTBAR[Number(btn.dataset.i)];
      const cost = hotbarCost(s, human);
      btn.classList.toggle("is-armed", armedAction === s.action);
      const costEl = btn.querySelector(".hcost");
      if (costEl) {
        if (s.action === "upgradeMiniBase") {
          const state = states[selectedState];
          const level = state ? officeLevel(state, HUMAN) : 0;
          costEl.textContent = level <= 0 ? "NO BASE" : level >= MINI_BASE_MAX_LEVEL ? "MAXED" : formatMoney(cost);
        } else {
          costEl.textContent = cost === null ? "VARIES" : s.action === "togglePolice" ? formatMoney(policeUpkeepDay(human)) + "/D" : cost === 0 ? "FREE" : formatMoney(cost);
        }
      }
      const poor = human && typeof cost === "number" && cost > 0 && human.cash < cost;
      btn.classList.toggle("is-poor", !!poor);
    });
  }
  function refreshInfluenceBar() {
    if (!influenceBarEl || !players.length || !states.length) return;
    const track = influenceBarEl.querySelector(".global-influence-track");
    const totals = players.map((player) => ({ player, value: electoralVoteShare(player.id) }));
    const used = totals.reduce((sum, entry) => sum + entry.value, 0);
    const undecided = Math.max(0, 1 - used);
    track.innerHTML = totals.map((entry) => {
      const width = Math.max(0, entry.value * 100);
      return '<span class="global-influence-segment" style="width:' + width.toFixed(2) + '%;background:' + entry.player.color + ';box-shadow:0 0 12px ' + entry.player.color + '"></span>';
    }).join("") + '<span class="global-influence-segment undecided" style="width:' + (undecided * 100).toFixed(2) + '%"></span>';
  }
  function influenceTotalsHtml() {
    const totalEv = totalElectoralVotes();
    const rows = players.map((player) => {
      const total = electoralVotes(player.id);
      return '<div class="influence-tip-row"><span class="influence-tip-dot" style="background:' + player.color + '"></span>' +
        '<span>' + player.name + '</span><strong>' + total + ' EV</strong></div>';
    }).join("");
    const undecided = Math.max(0, totalEv - players.reduce((sum, player) => sum + electoralVotes(player.id), 0));
    return '<div class="htt">ELECTORAL VOTE TOTALS</div>' + rows +
      '<div class="influence-tip-row muted"><span class="influence-tip-dot undecided"></span><span>Unled</span><strong>' + undecided + ' EV</strong></div>';
  }
  function showInfluenceTip() {
    if (!hotTipEl) return;
    hotTipEl.innerHTML = influenceTotalsHtml();
    hotTipEl.classList.add("is-on");
    positionHotTip(influenceBarEl);
  }

  function showLeaderIntelTip(playerId, card) {
    const player = players.find((candidate) => candidate.id === playerId);
    if (!player || !hotTipEl) return;
    const home = player.homeBase >= 0 ? states[player.homeBase].abbr : "--";
    const vote = electoralVotes(player.id);
    const status = player.locked > 0 ? "BLACKOUT" : "";
    hotTipEl.className = "hot-tooltip leader-intel-tip is-on";
    hotTipEl.innerHTML =
      '<div class="htt"><span style="color:' + player.color + '">' + escapeHtml(player.name) + '</span>' + (status ? '<strong>' + status + '</strong>' : '') + '</div>' +
      '<div class="leader-tip-row"><span>Leader</span><strong>' + escapeHtml(player.leader) + '</strong></div>' +
      '<div class="leader-tip-row"><span>Home</span><strong>' + home + '</strong></div>' +
      '<div class="leader-tip-row"><span>Cash</span><strong>' + formatMoney(player.cash) + '</strong></div>' +
      '<div class="leader-tip-row"><span>Per Day</span><strong>' + formatPerDay(projectedCashPerDay(player)) + '</strong></div>' +
      '<div class="leader-tip-row"><span>EV</span><strong>' + vote + '</strong></div>' +
      '<div class="leader-tip-row"><span>HQ</span><strong>L' + (player.mainBaseLevel || 0) + '</strong></div>';
    positionLeaderIntelTip(card);
  }

  function positionLeaderIntelTip(card) {
    if (!hotTipEl) return;
    const r = card.getBoundingClientRect();
    const trayRect = opponentTray?.getBoundingClientRect();
    const clearTop = trayRect ? trayRect.bottom + 10 : r.bottom + 8;
    hotTipEl.style.left = Math.round(Math.min(window.innerWidth - 154, Math.max(154, r.left + r.width / 2))) + "px";
    hotTipEl.style.top = Math.round(Math.max(r.bottom + 8, clearTop)) + "px";
    hotTipEl.style.bottom = "auto";
  }

  function hideLeaderIntelTip() {
    if (!hotTipEl) return;
    hotTipEl.className = "hot-tooltip";
    hotTipEl.classList.remove("is-on");
  }

  function armSlot(i) {
    if (!gameStarted || pipOpen) return;
    const s = HOTBAR[i];
    if (phase !== "play") { showToast("Actions unlock once the campaign goes live."); return; }
    pipSfx("click");
    const human = players[HUMAN];
    if (human?.locked > 0) {
      clearArmed();
      showToast("Your party is in assassination blackout for " + formatCampaignDuration(human.locked) + ".");
      return;
    }
    const cost = hotbarCost(s, human);
    if (typeof cost === "number" && cost > 0 && human.cash < cost) {
      showToast("INSUFFICIENT STRATEGIC RESERVES - need " + formatMoney(cost) + ".");
      return;
    }
    armedAction = s.action;
    const banner = document.getElementById("hotBanner");
    if (banner) {
      banner.textContent = s.action === "upgradeMiniBase"
        ? "\u25B6 UPGRADE ARMED \u2014 click one of your glowing District Offices (ESC to cancel)"
        : "\u25B6 " + s.name + " ARMED \u2014 click a target state (ESC to cancel)";
      banner.classList.add("is-on");
    }
    refreshHotbar();
  }

  document.addEventListener("keydown", (event) => {
    if (!gameStarted || pipOpen) return;
    if (event.key === "Escape" && settingsOpen) { event.preventDefault(); closeSettingsPanel(); return; }
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (event.key === "Escape" && rivalTalentPlayerId >= 0) { event.preventDefault(); closeRivalTalentViewer(); return; }
    if (event.key === "Escape" && armedAction) { event.preventDefault(); clearArmed(); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      if (event.repeat) return;
      togglePause();
      return;
    }
    const idx = HOTBAR.findIndex((s) => s.key === event.key);
    if (idx === -1) return;
    event.preventDefault();
    armSlot(idx);
  });

  selectMenuParty(selectedParty, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildHotbar);
  else buildHotbar();

  // Show lobby interface as first screen
  setTimeout(() => {
    const mainMenu = document.getElementById('mainMenu');
    const gameShell = document.getElementById('gameShell');
    if (mainMenu) {
      mainMenu.style.display = 'none';
      mainMenu.style.visibility = 'hidden';
    }
    if (gameShell) {
      gameShell.style.display = 'block';
      gameShell.style.visibility = 'visible';
    }
    showLobbyInterface();
  }, 500);

})();
