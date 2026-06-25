(() => {
  "use strict";

  let HUMAN = 0;
  
  // ===== WEBSOCKET MULTIPLAYER INTEGRATION =====
  const LOCAL_MULTIPLAYER = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const DEFAULT_REST_BACKEND_URL = LOCAL_MULTIPLAYER ? 'http://localhost:3001' : 'https://api.riggedio.com:3000';
  const DEFAULT_WS_BACKEND_URL = LOCAL_MULTIPLAYER ? 'ws://localhost:3001' : 'wss://api.riggedio.com:3000';
  const CONFIG = window.RiggedConfig || {};
  const URL_PARAMS = new URLSearchParams(window.location.search);
  const REST_BACKEND_URL = String(URL_PARAMS.get('api') || CONFIG.apiUrl || localStorage.getItem('rigged.apiUrl') || DEFAULT_REST_BACKEND_URL).replace(/\/+$/, '');
  const BACKEND_URL = String(URL_PARAMS.get('ws') || CONFIG.wsUrl || localStorage.getItem('rigged.wsUrl') || DEFAULT_WS_BACKEND_URL).replace(/\/+$/, '');
  const NETWORK_PAUSE_X = -987654321;
  const EMOTE_DURATION = 3.2;
  const EMOTE_OPTIONS = [
    { id: "cheer", label: "Cheer", icon: "★" },
    { id: "laugh", label: "Laugh", icon: "☻" },
    { id: "rage", label: "Rage", icon: "⚡" },
    { id: "sus", label: "Sus", icon: "?" },
    { id: "gg", label: "GG", icon: "GG" },
    { id: "rip", label: "RIP", icon: "RIP" },
  ];
  let ws = null;
  let playerId = null;
  let lastPositionSync = 0;
  let localPauseRequested = false;
  const POSITION_SYNC_INTERVAL = 100; // ms

  async function lobbyFetch(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        credentials: 'include',
        headers: {
          ...(window.RiggedAuth?.getToken?.() ? { Authorization: `Bearer ${window.RiggedAuth.getToken()}` } : {}),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
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
        name: playerDisplayName(),
        authToken: window.RiggedAuth?.getToken?.() || '',
        x: humanPlayer?.x || 0,
        y: humanPlayer?.y || 0
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
        x: humanPlayer.x || 0,
        y: humanPlayer.y || 0
      }));
      lastPositionSync = now;
    }
  }

  function syncRemotePlayers(allPlayers) {
    if (!Array.isArray(allPlayers)) return;

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
  const PLAYER_NAME_STORAGE_KEY = 'rigged.playerName';
  function cleanPlayerName(value) {
    return String(value || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  }
  let currentPlayerName = cleanPlayerName(localStorage.getItem(PLAYER_NAME_STORAGE_KEY)) || 'Player';
  function playerDisplayName() {
    return cleanPlayerName(currentPlayerName) || 'Player';
  }
  function bindPlayerNameInput() {
    const input = document.getElementById('playerNameInput');
    if (!input) return;
    input.value = currentPlayerName === 'Player' ? '' : currentPlayerName;
    if (input.dataset.nameBound === 'true') return;
    input.dataset.nameBound = 'true';
    input.addEventListener('input', () => {
      currentPlayerName = cleanPlayerName(input.value) || 'Player';
      try { localStorage.setItem(PLAYER_NAME_STORAGE_KEY, currentPlayerName); } catch {}
      const localLobbyPlayer = currentLobby?.players?.find((player) => String(player.id) === String(currentPlayerId));
      if (localLobbyPlayer) localLobbyPlayer.name = currentPlayerName;
      scheduleServerLobbyPlayerUpdate();
    });
  }
  let serverLobbyPollTimer = null;
  let publicLobbyPollTimer = null;
  let serverLobbyHeartbeatTimer = null;
  let serverLobbySettingsQueue = Promise.resolve();
  let serverLobbyPlayerUpdateTimer = null;
  let lastCrazyServerJoinable = null;
  let gameStatePublishTimer = null;
  let gameStatePollTimer = null;
  let gameCommandPollTimer = null;
  let serverGamePresenceTimer = null;
  let gameStateVersion = 0;
  let gameStatePublishPending = false;
  let gameStatePollPending = false;
  let gameCommandDrainPending = false;
  let applyingRemoteGameCommand = false;
  let assassinationEventCounter = 0;
  let latestAssassinationEvent = null;
  let lastPresentedAssassinationEventId = 0;
  let powerGrabEventCounter = 0;
  let latestPowerGrabEvent = null;
  let lastPresentedPowerGrabEventId = 0;
  let debateEventCounter = 0;
  let latestDebateEvent = null;
  let lastPresentedDebateEventId = 0;
  let debateResultEventCounter = 0;
  let latestDebateResultEvent = null;
  let lastPresentedDebateResultEventId = 0;
  let matchResultCounter = 0;
  let matchResult = null;
  let lastPresentedMatchResultId = 0;
  let broadcastEventCounter = 0;
  let latestBroadcastEvent = null;
  let lastPresentedBroadcastEventId = 0;
  let victoryPresentationToken = 0;
  let emoteWheelOpen = false;
  let emoteWheelPointer = { x: 180, y: 180 };

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
    lobbyFetch(`${REST_BACKEND_URL}/api/lobby/heartbeat`, {
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
      lobbyFetch(`${REST_BACKEND_URL}/api/lobby/leave`, {
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
        const normalizedPlayer = {
          ...player,
          emote: {
            id: String(player?.emote?.id || ""),
            icon: String(player?.emote?.icon || ""),
            until: Math.max(0, Number(player?.emote?.until) || 0),
          },
        };
        if (!playerMetadata) return normalizedPlayer;
        return { ...normalizedPlayer, name: index === 0 ? playerMetadata.hostName : (player.name || player.playerName) };
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
      players: [{ id: currentPlayerId, name: playerDisplayName(), host: true }],
    });
  }

  function isCurrentServerLobbyHost(lobby = currentLobby) {
    if (!lobby?.id) return window.isServerLobbyHost === true;
    const normalized = normalizeServerLobby(lobby);
    return window.isServerLobbyHost === true || normalized.hostId === currentPlayerId || normalized.players.some((player) => player.id === currentPlayerId && player.host === true);
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
    const lobbyEmote = player?.emote?.until > Date.now() && player?.emote?.icon ? `<span class="leader-emote-bubble">${escapeHtml(player.emote.icon)}</span>` : "";
    return `<span class="leader-portrait-frame leader-portrait-frame-bright"><span class="leader-portrait" style="--party:${faction.color};--skin:${profile?.skin || palette.skin};--hair:${palette.hair};--suit:${palette.suit};--accent:${palette.accent};display:block;overflow:hidden">${leaderPortraitSvg(factionIndex, profile)}</span>${lobbyEmote}</span>`;
  }

  function currentLobbyPlayer() {
    if (!currentLobby?.players || !currentPlayerId) return null;
    return currentLobby.players.find((player) => String(player.id) === String(currentPlayerId)) || null;
  }

  function canUseEmotes() {
    if (matchOver || pipOpen || settingsOpen || (gameStarted && paused)) return false;
    if (currentLobby?.id && !gameStarted) return true;
    if (!gameStarted) return false;
    return phase === "base" || phase === "play";
  }

  function applyLobbyEmote(playerId, emoteId) {
    if (!currentLobby?.players) return false;
    const lobbyPlayer = currentLobby.players.find((player) => String(player.id) === String(playerId));
    const option = emoteOptionById(emoteId);
    if (!lobbyPlayer || !option) return false;
    lobbyPlayer.emote = {
      id: option.id,
      icon: option.icon,
      until: Date.now() + EMOTE_DURATION * 1000,
    };
    renderLobbyLeaderStrip();
    window.setTimeout(() => {
      if (!currentLobby?.players) return;
      const latest = currentLobby.players.find((player) => String(player.id) === String(playerId));
      if (!latest?.emote?.until || latest.emote.until > Date.now()) return;
      renderLobbyLeaderStrip();
    }, Math.ceil(EMOTE_DURATION * 1000) + 80);
    return true;
  }

  async function publishLobbyEmote(emoteId) {
    if (!currentLobby?.id || !currentPlayerId) return false;
    const faction = factionForMenu(selectedParty);
    const option = emoteOptionById(emoteId);
    if (!option) return false;
    applyLobbyEmote(currentPlayerId, emoteId);
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/player`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lobbyId: currentLobby.id,
          playerId: currentPlayerId,
          name: playerDisplayName(),
          factionIndex: selectedParty,
          party: faction.name,
          leader: faction.leader,
          color: faction.color,
          leaderProfile: normalizeLeaderProfile(selectedLeaderProfile),
          emote: {
            id: option.id,
            icon: option.icon,
            until: Date.now() + EMOTE_DURATION * 1000,
          },
        }),
      });
      if (!res.ok) throw new Error(`Lobby emote update failed: ${res.status}`);
      const data = await res.json();
      if (data.lobby) currentLobby = normalizeServerLobby(data.lobby, currentLobby);
      renderLobbyLeaderStrip();
      return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  async function addBotFromLeaderSlot() {
    if (!currentLobby?.id) {
      const settings = window.lobbySettings || {};
      const result = await createLobby(
        playerDisplayName(),
        matchModeInput?.value || settings.mode || 'campaign100',
        difficultyInput?.value || settings.difficulty || 'medium',
        Number(playerCountInput?.value || settings.maxPlayers || 4),
        settings.lobbyName || "Host's Lobby",
        settings.isPublic === true,
      );
      if (!result?.lobbyId) return false;
      startServerLobbyPolling(renderServerLobbyInMainMenu);
    }
    const added = await addBotToServerLobby();
    renderServerLobbyInMainMenu();
    syncMainMenuAddBotButton();
    return added;
  }

  function renderLobbyLeaderStrip() {
    const strip = document.getElementById('lobbyLeaderStrip');
    if (!strip || typeof FACTIONS === 'undefined') return;
    const pending = !currentLobby?.id;
    const lobby = pending
      ? { maxPlayers: Number(playerCountInput?.value || window.lobbySettings?.maxPlayers || 4), players: [{ id: currentPlayerId, name: playerDisplayName(), host: true, ready: false, factionIndex: selectedParty, leaderProfile: selectedLeaderProfile }] }
      : normalizeServerLobby(currentLobby);
    const slots = Array.from({ length: Math.max(1, Number(lobby.maxPlayers || 4)) }, (_, index) => lobby.players[index] || null);
    strip.innerHTML = slots.map((source, index) => {
      if (!source) {
        const canAddBot = pending || isCurrentServerLobbyHost(lobby);
        if (canAddBot) {
          return `<button class="lobby-leader-slot is-empty is-add-bot" type="button" data-add-lobby-bot data-slot-index="${index}" onclick="window.riggedAddBotFromSlot && window.riggedAddBotFromSlot(this)" title="Add an anonymous bot to this open slot"><span class="lobby-leader-player is-placeholder">Empty Slot</span>${anonymousLobbyPortraitMarkup('Add anonymous bot')}<span class="lobby-add-bot-plus" aria-hidden="true">+</span><span class="lobby-leader-party">Anonymous Party</span><span class="lobby-leader-name">Add Bot</span><span class="lobby-leader-state">Click to Fill</span></button>`;
        }
        return `<article class="lobby-leader-slot is-empty"><span class="lobby-leader-player is-placeholder">Empty Slot</span>${anonymousLobbyPortraitMarkup('Open player slot')}<span class="lobby-leader-party">No Party</span><span class="lobby-leader-name">Open Slot</span><span class="lobby-leader-state">Waiting</span></article>`;
      }
      const player = { ...source };
      if (!player.isBot && player.id === currentPlayerId) {
        const faction = factionForMenu(selectedParty);
        Object.assign(player, { factionIndex: selectedParty, party: faction.name, leader: faction.leader, color: faction.color, leaderProfile: selectedLeaderProfile });
        player.name = playerDisplayName();
        player.ready = player.host ? true : multiplayerState.localReady;
        const livePlayer = currentLobbyPlayer();
        if (livePlayer?.emote) player.emote = { ...livePlayer.emote };
      }
      player.isBot = player.isBot === true || /^Bot\b/i.test(player.name || player.playerName || '');
      const ready = player.isBot || player.host || player.ready === true;
      const factionIndex = Math.max(0, Math.min(FACTIONS.length - 1, Number(player.factionIndex) || 0));
      const faction = factionForMenu(factionIndex);
      const color = player.isBot ? '#789485' : (player.color || faction.color || '#34ff86');
      const playerName = player.isBot ? `Bot ${index + 1}` : (player.name || player.playerName || `Player ${index + 1}`);
      const leaderName = player.isBot ? 'Anonymous Leader' : (player.leader || faction.leader || `Leader ${index + 1}`);
      const partyName = player.isBot ? 'Anonymous Party' : (player.party || faction.name || 'Unnamed Party');
      const role = player.isBot ? 'BOT' : player.host ? 'HOST' : ready ? 'READY' : 'PICKING';
      const stateClass = player.isBot ? 'is-bot' : ready ? 'is-ready' : 'is-picking';
      const botAction = player.isBot && isCurrentServerLobbyHost(lobby)
        ? `<button class="lobby-bot-open" type="button" data-remove-lobby-bot="${escapeHtml(player.id)}">Empty Slot</button>`
        : '';
      return `<article class="lobby-leader-slot ${stateClass}" style="--slot-color:${color}" title="${escapeHtml(playerName)} — ${escapeHtml(partyName)}"><span class="lobby-leader-player">${escapeHtml(playerName)}</span>${lobbyLeaderPortraitMarkup(player, factionIndex)}<span class="lobby-leader-party">${escapeHtml(partyName)}</span><span class="lobby-leader-name">${escapeHtml(leaderName)}</span><span class="lobby-leader-state">${role}</span>${botAction}</article>`;
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
        playerDisplayName(),
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
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/settings`, {
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
        const localEmote = currentLobbyPlayer()?.emote;
        const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lobbyId: currentLobby.id,
            playerId: currentPlayerId,
            name: playerDisplayName(),
            factionIndex: selectedParty,
            party: faction.name,
            leader: faction.leader,
            color: faction.color,
            leaderProfile: normalizeLeaderProfile(selectedLeaderProfile),
            emote: localEmote && localEmote.until > Date.now() ? localEmote : { id: "", icon: "", until: 0 },
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
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobbies`, { cache: 'no-store' });
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
      let res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobbies?public=1`, { cache: 'no-store' });
      // The original RIGGED backend matches request URLs literally and returns
      // 404 when a query string is present. Fall back and filter client-side.
      if (res.status === 404) res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobbies`, { cache: 'no-store' });
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
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/start`, {
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
          <div class="lobby-entry-logo"><img src="rigged-logo.png?v=2" alt="" aria-hidden="true"><strong>RIGGED</strong></div>
          <h1><span>Your vote matters</span><em>Unless we disagree</em></h1>
          <section class="lobby-entry-account-slot" aria-label="Account access">
            <div id="authPanel" class="auth-panel"></div>
          </section>
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
            <span class="lobby-route-icon">◎</span>
            <span><strong>Browse Public Lobbies</strong><small>Scan live public rooms and join instantly</small></span>
            <b>→</b>
          </button>

          <div id="lobbyContent" class="lobby-entry-content" hidden></div>
          <footer><span>RIGGED://MATCHMAKING</span><span>BUILD 31.2</span></footer>
        </section>
      </main>
    `;
    
    document.body.appendChild(lobbyUI);
    window.RiggedAuth?.refresh?.();
    
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
      bindPlayerNameInput();
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

      <label class="host-difficulty-field" style="display: block; margin-bottom: 15px; color: #34ff86;">
        <div style="margin-bottom: 5px;">Difficulty:</div>
        <select id="diffSelect" aria-describedby="hostDifficultyTooltip" style="width: 100%; background: #333; color: #34ff86; border: 1px solid #34ff86; padding: 8px; font-family: monospace;">
          <option value="easy" title="Slower, conservative bots with no starting cash or action discount.">Easy</option>
          <option value="medium" title="Faster bots start with $5M and receive 10% off most actions.">Medium</option>
          <option value="hard" title="Aggressive bots start with $10M and receive 15% off most actions.">Hard</option>
        </select>
        <span id="hostDifficultyTooltip" class="difficulty-tooltip host-difficulty-tooltip" role="tooltip"></span>
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
      const hostDifficultySelect = document.getElementById('diffSelect');
      const hostDifficultyTooltip = document.getElementById('hostDifficultyTooltip');
      const syncHostDifficultyTooltip = () => {
        if (!hostDifficultySelect || !hostDifficultyTooltip) return;
        hostDifficultyTooltip.textContent = DIFFICULTY_TOOLTIPS[hostDifficultySelect.value] || DIFFICULTY_TOOLTIPS.medium;
      };
      syncHostDifficultyTooltip();
      hostDifficultySelect?.addEventListener('input', syncHostDifficultyTooltip);
      hostDifficultySelect?.addEventListener('change', syncHostDifficultyTooltip);
      
      if (confirmBtn) {
        confirmBtn.onclick = () => {
          const mode = 'campaign100';
          const difficulty = document.getElementById('diffSelect').value;
          const maxPlayers = document.getElementById('playerSelect').value;
          const lobbyName = document.getElementById('lobbyNameInput').value.trim().slice(0, 32) || "Host's Lobby";
          const isPublic = document.querySelector('input[name="lobbyVisibility"]:checked')?.value === 'public';
          
          console.log('Host settings:', { mode, difficulty, maxPlayers, lobbyName, isPublic });
          
          // Store settings
          window.lobbySettings = { mode, difficulty, maxPlayers, lobbyName, isPublic };
          if (matchModeInput) matchModeInput.value = mode;
          if (difficultyInput) difficultyInput.value = difficulty;
          syncDifficultyTooltip();
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
          const result = await joinLobby(button.dataset.publicLobbyId, playerDisplayName());
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
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobbies`, { cache: 'no-store' });
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
              const result = await joinLobby(lobby.id, playerDisplayName());
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
      activeWorldEvent,
      worldEventTimer,
      nextWorldEventAt,
      latestClickbait,
      clickbaitTimer,
      nextNewsAt,
      matchOver,
      latestAssassinationEvent,
      latestPowerGrabEvent,
      latestDebateEvent,
      latestDebateResultEvent,
      matchResult,
      latestBroadcastEvent,
      paused,
      selectedState,
      mode: currentMatchMode.id,
      publishedAt: Date.now(),
    };
  }

  function applyGameStateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.states)) return;
    const wasPaused = paused;
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
    activeWorldEvent = snapshot.activeWorldEvent ?? activeWorldEvent;
    worldEventTimer = Number(snapshot.worldEventTimer ?? worldEventTimer);
    nextWorldEventAt = Number(snapshot.nextWorldEventAt ?? nextWorldEventAt);
    latestClickbait = snapshot.latestClickbait ?? latestClickbait;
    clickbaitTimer = Number(snapshot.clickbaitTimer ?? clickbaitTimer);
    nextNewsAt = Number(snapshot.nextNewsAt ?? nextNewsAt);
    matchOver = snapshot.matchOver === true;
    latestAssassinationEvent = snapshot.latestAssassinationEvent ?? latestAssassinationEvent;
    latestPowerGrabEvent = snapshot.latestPowerGrabEvent ?? latestPowerGrabEvent;
    powerGrabEventCounter = Math.max(powerGrabEventCounter, Number(latestPowerGrabEvent?.id || 0));
    latestDebateEvent = snapshot.latestDebateEvent ?? latestDebateEvent;
    debateEventCounter = Math.max(debateEventCounter, Number(latestDebateEvent?.id || 0));
    latestDebateResultEvent = snapshot.latestDebateResultEvent ?? latestDebateResultEvent;
    debateResultEventCounter = Math.max(debateResultEventCounter, Number(latestDebateResultEvent?.id || 0));
    matchResult = snapshot.matchResult ?? matchResult;
    latestBroadcastEvent = snapshot.latestBroadcastEvent ?? latestBroadcastEvent;
    paused = snapshot.paused === true;
    if (paused && !wasPaused) hydrateSettingsControls();
    selectedState = Number.isFinite(Number(snapshot.selectedState)) ? Number(snapshot.selectedState) : selectedState;
    if (snapshot.mode && MATCH_MODES[snapshot.mode]) currentMatchMode = MATCH_MODES[snapshot.mode];
    if (latestAssassinationEvent && Number(latestAssassinationEvent.id || 0) > lastPresentedAssassinationEventId) {
      lastPresentedAssassinationEventId = Number(latestAssassinationEvent.id);
      presentAssassinationEvent(latestAssassinationEvent);
    }
    if (latestPowerGrabEvent && Number(latestPowerGrabEvent.id || 0) > lastPresentedPowerGrabEventId) {
      lastPresentedPowerGrabEventId = Number(latestPowerGrabEvent.id);
      presentPowerGrabEvent(latestPowerGrabEvent);
    }
    if (latestDebateEvent && Number(latestDebateEvent.id || 0) > lastPresentedDebateEventId) {
      lastPresentedDebateEventId = Number(latestDebateEvent.id);
      presentDebateEvent(latestDebateEvent);
    }
    if (latestDebateResultEvent && Number(latestDebateResultEvent.id || 0) > lastPresentedDebateResultEventId) {
      lastPresentedDebateResultEventId = Number(latestDebateResultEvent.id);
      presentDebateResultEvent(latestDebateResultEvent);
    }
    if (matchResult && Number(matchResult.id || 0) > lastPresentedMatchResultId) {
      lastPresentedMatchResultId = Number(matchResult.id);
      presentElectionResult(Number(matchResult.winnerId), String(matchResult.reason || "election complete"), false);
    }
    if (latestBroadcastEvent && Number(latestBroadcastEvent.id || 0) > lastPresentedBroadcastEventId) {
      lastPresentedBroadcastEventId = Number(latestBroadcastEvent.id);
      presentBroadcast(Number(latestBroadcastEvent.channelIndex), String(latestBroadcastEvent.subtitle || ""), { worldEvent: latestBroadcastEvent.worldEvent === true });
    }
    updateUi(true);
  }

  async function publishAuthoritativeGameState() {
    if (!gameStarted || !isCurrentServerLobbyHost() || !currentLobby?.id || gameStatePublishPending) return;
    gameStatePublishPending = true;
    try {
      gameStateVersion += 1;
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/game/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: currentLobby.id, hostId: currentPlayerId, version: gameStateVersion, state: gameStateSnapshot() }),
      }, 4000);
      if (res.status === 403) {
        await refreshServerGameHost();
        return;
      }
      if (!res.ok) throw new Error(`Game state publish failed: ${res.status}`);
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
      handleServerHostMigration(data.hostId);
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

  function emoteOptionById(id) {
    return EMOTE_OPTIONS.find((option) => option.id === id) || null;
  }

  function triggerEmote(playerId, emoteId) {
    const player = players[playerId];
    const option = emoteOptionById(emoteId);
    if (!player || !option) return false;
    player.emoteId = option.id;
    player.emoteIcon = option.icon;
    player.emoteUntil = EMOTE_DURATION;
    if (playerId === HUMAN) showToast(`Emote sent: ${option.label}`, "compact");
    return true;
  }

  function sendEmote(emoteId) {
    if (!canUseEmotes()) return false;
    if (currentLobby?.id && !gameStarted) {
      void publishLobbyEmote(emoteId);
      closeEmoteWheel();
      return true;
    }
    if (HUMAN !== undefined && isServerLobbyGuest() && routeGuestGameCommand("emitEmote", [emoteId])) {
      closeEmoteWheel();
      return true;
    }
    const sent = triggerEmote(HUMAN, emoteId);
    if (sent) closeEmoteWheel();
    return sent;
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
      slowDistrictOffices: () => slowDistrictOffices(lobbyIndex, Number(args[0])),
      sabotage: () => sabotage(lobbyIndex, Number(args[0])),
      instigateRiot: () => instigateRiot(lobbyIndex, Number(args[0])),
      disrupt: () => disrupt(lobbyIndex, Number(args[0])),
      powerGrab: () => powerGrab(lobbyIndex, Number(args[0])),
      togglePolice: () => togglePolice(lobbyIndex, Number(args[0]), String(args[1] || 'office')),
      selectTalent: () => {
        const player = players[lobbyIndex];
        const tier = Number(args[0]);
        const side = args[1] === 'right' ? 'right' : 'left';
        if (player && tierUnlocked(tier, player) && player.talents[tier] === undefined) player.talents[tier] = side;
      },
      togglePause: () => {
        paused = !paused;
        localPauseRequested = paused;
        if (paused) hydrateSettingsControls();
        if (pauseButton) pauseButton.textContent = paused ? 'Resume Everyone' : 'Pause';
      },
      emitEmote: () => triggerEmote(lobbyIndex, String(args[0] || "")),
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
    window.clearInterval(serverGamePresenceTimer);
    gameStateVersion = 0;
    sendServerGamePresence();
    serverGamePresenceTimer = window.setInterval(sendServerGamePresence, 2000);
    if (isCurrentServerLobbyHost()) {
      publishAuthoritativeGameState();
      gameStatePublishTimer = window.setInterval(publishAuthoritativeGameState, 200);
      gameCommandPollTimer = window.setInterval(drainGuestGameCommands, 120);
    } else {
      pollAuthoritativeGameState();
      gameStatePollTimer = window.setInterval(pollAuthoritativeGameState, 200);
    }
  }

  function stopServerGameSync() {
    window.clearInterval(gameStatePublishTimer);
    window.clearInterval(gameStatePollTimer);
    window.clearInterval(gameCommandPollTimer);
    window.clearInterval(serverGamePresenceTimer);
    gameStatePublishTimer = null;
    gameStatePollTimer = null;
    gameCommandPollTimer = null;
    serverGamePresenceTimer = null;
    gameStatePublishPending = false;
    gameStatePollPending = false;
    gameCommandDrainPending = false;
  }

  async function sendServerGamePresence() {
    if (!gameStarted || !currentLobby?.id || !currentPlayerId) return;
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: currentLobby.id, playerId: currentPlayerId }),
      }, 3500);
      if (!res.ok) return;
      const data = await res.json();
      handleServerHostMigration(data.hostId);
    } catch {}
  }

  async function refreshServerGameHost() {
    if (!currentLobby?.id) return;
    try {
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/game/state?lobbyId=${encodeURIComponent(currentLobby.id)}`, { cache: 'no-store' }, 4000);
      if (!res.ok) return;
      const data = await res.json();
      if (data.state && Number(data.version || 0) >= gameStateVersion) {
        gameStateVersion = Number(data.version || 0);
        applyGameStateSnapshot(data.state);
      }
      handleServerHostMigration(data.hostId);
    } catch {}
  }

  function handleServerHostMigration(nextHostId) {
    nextHostId = String(nextHostId || '');
    if (!gameStarted || !currentLobby?.id || !nextHostId || nextHostId === currentLobby.hostId) return;
    const wasHost = isCurrentServerLobbyHost();
    currentLobby.hostId = nextHostId;
    currentLobby.players = (currentLobby.players || []).map((player) => ({ ...player, host: player.id === nextHostId }));
    const isHost = nextHostId === currentPlayerId;
    window.isServerLobbyHost = isHost;
    window.isJoiner = !isHost;
    const hostName = currentLobby.players.find((player) => player.id === nextHostId)?.name || 'Next player';
    showToast(isHost ? 'Host disconnected. You are now the host.' : `${hostName} is now the host.`, 'compact');
    if (wasHost !== isHost) startServerGameSync();
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
  const MATCH_SECONDS = 900;
  const CAMPAIGN_TOTAL_DAYS = 90;
  const CAMPAIGN_DAY_SECONDS = MATCH_SECONDS / CAMPAIGN_TOTAL_DAYS;
  const MATCH_MODES = {
    campaign100: { id: "campaign100", label: "90 Days", timed: true, days: 90, seconds: MATCH_SECONDS },
  };
  const HOME_BASE_SECONDS = 60;
  const NEWS_INTERVAL = 85;
  const WORLD_EVENT_FIRST_DAYS_TO_ELECTION = 79;
  const WORLD_EVENT_LAST_DAY_BUFFER = 10;
  const WORLD_EVENT_MIN_GAP_DAYS = 5;
  const WORLD_EVENT_MAX_GAP_DAYS = 10;
  const WORLD_EVENT_DURATION_DAYS = 10;
  const WORLD_EVENT_SHORT_DURATION_DAYS = 5;
  const WORLD_EVENT_REPORT_DAYS = 2;
  const CAPTURE_THRESHOLD = 50;
  const CHANNEL_COST = 10000;
  const CHANNEL_INFLUENCE_RATE = 0.14;
  const MID_CHANNEL_SUPPRESSION_RATE = 0.07;
  const SPEECH_SECONDS = CAMPAIGN_DAY_SECONDS;
  const SPEECH_COOLDOWN_DAYS = 1;
  const DEBATE_SPEECH_COOLDOWN_DAYS = 2;
  const SPEECH_RATE = 10 / SPEECH_SECONDS;
  const SPEECH_RIVAL_RATE = 10 / (CAMPAIGN_DAY_SECONDS * 2);
  const DEBATE_SECONDS = CAMPAIGN_DAY_SECONDS * 0.5;
  const DEBATE_WIN_BONUS = 15;
  const WORLD_DEBATE_WIN_BONUS = 22;
  const EARLY_STAGE_DAYS_LEFT = 79;
  const LATE_STAGE_DAYS_LEFT = 40;
  const MID_STAGE_MONEY_MIN_EV = 10;
  const MID_STAGE_MONEY_MAX_EV = 20;
  const MID_STAGE_MONEY_PER_EV_DAY = 150;
  const LATE_SMALL_STATE_EV_BONUS = 2;
  const GHOST_INFLUENCE_STATES = new Set(["CA", "TX", "FL", "NY"]);
  const GHOST_INFLUENCE_CAP = 130;
  const AD_HUB_COST = 2000;
  const AD_HUB_DEPLOY_SECONDS = CAMPAIGN_DAY_SECONDS * 0.5;
  const AD_HUB_RATE = 1 / CAMPAIGN_DAY_SECONDS;
  const MINI_BASE_MAX_LEVEL = 3;
  const MINI_BASE_ICON_SCALE = 0.5;
  const MINI_BASE_HIT_RADIUS = 9;
  const MINI_BASE_DEFENSE = [0, 5, 10, 15];
  const MINI_BASE_CASH_DAY = [0, 154, 308, 462];
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
    { name: "Crimson", color: "#F59E0B", full: "Redline Compact", leader: "Mara Voss", title: "Donor War Room", region: "west", talentTree: "oligarchy", cashBias: 1.18, speechBias: 1, portrait: { skin: "#e7b28d", hair: "#3a1a16", suit: "#6b1f29", accent: "#ffb6b8" } },
    { name: "Azure", color: "#22D3EE", full: "Bluewater Front", leader: "Jonas Reed", title: "Coalition Speaker", region: "south", talentTree: "populist", cashBias: 1, speechBias: 1.16, portrait: { skin: "#d49c72", hair: "#182338", suit: "#173c8c", accent: "#a7c7ff" } },
    { name: "Verdant", color: "#00FF66", full: "Green Cities Bloc", leader: "Elena Park", title: "Civic Organizer", region: "northeast", talentTree: "syndicate", cashBias: 0.95, speechBias: 1.08, portrait: { skin: "#c98f68", hair: "#123424", suit: "#16633d", accent: "#a4f0bb" } },
    { name: "Gold", color: "#EF4444", full: "Liberty Exchange", leader: "Silas Grant", title: "Market Governor", region: "midwest", talentTree: "vanguard", cashBias: 1.08, speechBias: 0.98, portrait: { skin: "#e0ad7a", hair: "#5a3718", suit: "#7a5a13", accent: "#ffe08a" } },
    { name: "Violet", color: "#8250d6", full: "Civic Futures", leader: "Nia Vale", title: "Policy Futurist", region: "sunbelt", talentTree: "futurist", cashBias: 1, speechBias: 1.12, portrait: { skin: "#d2a289", hair: "#2c174e", suit: "#4b2c93", accent: "#c7adff" } },
    { name: "Cinder", color: "#f97316", full: "Cinder Machine", leader: "Petra Knox", title: "Strike Marshal", region: "midwest", talentTree: "machine", cashBias: 1.06, speechBias: 0.94, portrait: { skin: "#d5a17f", hair: "#231715", suit: "#5f2a17", accent: "#ffb067" } },
    { name: "Teal", color: "#14b8a6", full: "Teal Wire Accord", leader: "Imani Quill", title: "Signal Cartographer", region: "northeast", talentTree: "signal", cashBias: 0.97, speechBias: 1.1, portrait: { skin: "#b8805f", hair: "#102a2a", suit: "#0d5a5b", accent: "#7ff4ea" } },
    { name: "Ivory", color: "#e5e7eb", full: "Ivory Ledger Club", leader: "Rafael Sol", title: "Sunbelt Treasurer", region: "south", talentTree: "ledger", cashBias: 1.14, speechBias: 0.99, portrait: { skin: "#c98a62", hair: "#5e5a4e", suit: "#6c6d71", accent: "#fff4c7" } },
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
  const LEADER_OUTFITS = [
    { id: "campaign_suit", label: "Campaign Suit", desc: "Classic suit, tie, and party-color trim." },
    { id: "power_suit", label: "Power Suit", desc: "Broad shoulders and sharp executive lapels." },
    { id: "field_jacket", label: "Field Jacket", desc: "Utility pockets for the permanent campaign trail." },
    { id: "rolled_sleeves", label: "Rolled Sleeves", desc: "Populist shirt with sleeves ready for work." },
    { id: "tech_blazer", label: "Tech Blazer", desc: "Asymmetric neon trim for terminal politics." },
    { id: "ceremonial_uniform", label: "Ceremonial Uniform", desc: "Command tunic with bright epaulettes." },
  ];
  const LEADER_EYEWEAR = [
    { id: "none", label: "None", desc: "No eyewear equipped." },
    { id: "aviators", label: "Aviators", desc: "Power optics with mirrored lenses." },
    { id: "wireframes", label: "Wireframes", desc: "Thin policy-wonk spectacles." },
    { id: "visor_scope", label: "Visor Scope", desc: "Broadcast-grade tactical display." },
    { id: "square_frames", label: "Square Frames", desc: "Heavy campaign office frames." },
  ];
  const LEADER_PINS = [
    { id: "none", label: "None", desc: "No chest cosmetic equipped." },
    { id: "party_star", label: "Party Star", desc: "Bright party insignia pinned to the lapel." },
    { id: "victory_ribbon", label: "Victory Ribbon", desc: "A stitched ribbon from last cycle." },
    { id: "flag_bar", label: "Flag Bar", desc: "Compact patriotic service bar." },
    { id: "signal_chip", label: "Signal Chip", desc: "Futurist campaign-network transponder." },
  ];
  const LEADER_EXPRESSIONS = [
    { id: "neutral", label: "Neutral", desc: "Calm campaign face for the default look." },
    { id: "smile", label: "Smile", desc: "Friendly confident grin for the cameras." },
    { id: "smirk", label: "Smirk", desc: "A sly side-smile for smug debate moments." },
    { id: "angry", label: "Angry", desc: "Sharp brows and a hard mouth for pressure." },
    { id: "frown", label: "Frown", desc: "Worried downturn that reads more serious." },
    { id: "surprised", label: "Surprised", desc: "Raised brows and an open mouth reaction." },
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
    easy: { delay: 4.4, disrupt: 0.1, powerGrab: 0.08, police: 0.05, channel: 0.1, assassinate: 0.035, hq: 0.2, office: 0.24, maxPolice: 1, reserve: 5000 },
    medium: { delay: 3.1, disrupt: 0.22, powerGrab: 0.15, police: 0.1, channel: 0.15, assassinate: 0.065, hq: 0.32, office: 0.34, maxPolice: 2, reserve: 3500 },
    hard: { delay: 2.15, disrupt: 0.36, powerGrab: 0.24, police: 0.16, channel: 0.2, assassinate: 0.1, hq: 0.45, office: 0.44, maxPolice: 3, reserve: 2000 },
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

  const WORLD_EVENTS = [
    { id: "foreign_wire", title: "Foreign Wire Transfer", text: "Lowest-influence party receives $20M once.", durationDays: 0 },
    { id: "disaster_relief", title: "Six-State Disaster Relief", text: "Six states are hit. Offices above L1 lose 1 level. Upgrades there cost more and grant +10 influence.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "police_strike", title: "Blackout Walkout", text: "Police protection is disabled.", durationDays: WORLD_EVENT_SHORT_DURATION_DAYS },
    { id: "inflation", title: "Campaign Inflation", text: "Office upgrades and police upkeep cost 10% more.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "irs_audit", title: "IRS Vibe Check", text: "Every party loses 20% cash once.", durationDays: 0 },
    { id: "news_multiplier", title: "Ratings Fever", text: "News channels generate triple influence.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "debate_royale", title: "Debate Royale", text: "Up to 3 parties can join one debate. Winners get extra bonus influence.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "disrupt_siphon", title: "Total Destruction Week", text: "DISRUPT steals 5% influence from targeted rivals.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "anti_front_runner", title: "Martyr Protocol", text: "Parties may self-assassinate a speaking leader for +15 influence nationwide.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "martyrdom_cycle", title: "Front-Runner Muzzle", text: "Parties cannot give speeches in states where they lead. Speeches give double influence.", durationDays: WORLD_EVENT_DURATION_DAYS },
    { id: "reckless_power_grab", title: "Reckless Mandate", text: "Power Grab gains 10% more influence but loses 5% influence in two random states.", durationDays: WORLD_EVENT_DURATION_DAYS },
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
  const newGameButton = document.querySelector("#newGameButton");
  const createLobbyButton = document.querySelector("#createLobbyButton");
  const copyInviteButton = document.querySelector("#copyInviteButton");
  const mainMenuAddBotButton = document.querySelector("#mainMenuAddBotButton");
  
  const multiplayerStatus = document.querySelector("#multiplayerStatus");
  const multiplayerInvite = document.querySelector("#multiplayerInvite");
  const lobbyParty = document.querySelector("#lobbyParty");
  const lobbyLeaderStrip = document.querySelector("#lobbyLeaderStrip");
  const pauseButton = document.querySelector("#endTurnButton");
  const playerIdentityLabel = document.querySelector("#playerIdentityLabel");
  const factionName = document.querySelector("#turnName");
  const hqHint = document.querySelector("#turnHint");
  const cashStat = document.querySelector("#troopStat");
  const timeStat = document.querySelector("#landStat");
  const voteStat = document.querySelector("#waterStat");
  let upgradeStatusBox = null;
  const playerList = document.querySelector("#playerList");
  const opPanel = document.querySelector("#cardHand");
  const eventTicker = document.querySelector("#eventTicker");
  const eventStrip = document.querySelector(".event-strip");
  const cityLog = document.querySelector("#cityLog");
  const mainMenu = document.querySelector("#mainMenu");
  const gameShell = document.querySelector("#gameShell");
  const mapStage = document.querySelector(".map-stage");
  const calendarCountdown = document.querySelector("#calendarCountdown");
  const calendarLabel = document.querySelector(".election-calendar .calendar-label");
  const calendarDayProgress = document.querySelector("#calendarDayProgress");
  const intelPanel = document.querySelector("#intelPanel");
  const intelToggle = document.querySelector("#intelToggle");
  const intelBody = document.querySelector("#intelBody");
  const opponentTray = document.querySelector("#opponentTray");
  const rivalTalentViewer = document.querySelector("#rivalTalentViewer");
  const talentDraftOverlay = document.querySelector("#talentDraftOverlay");
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
  const powerGrabOverlay = document.querySelector("#powerGrabOverlay");
  const powerGrabGif = document.querySelector("#powerGrabGif");
  const debatePowerOverlay = document.querySelector("#debatePowerOverlay");
  const newsSoundButtons = document.querySelectorAll(".sound-toggle");
  const toast = document.querySelector("#toast");
  const talentHistoryHud = document.querySelector("#talentHistoryHud");
  const partyRoster = document.querySelector("#partyRoster");
  const talentPreview = document.querySelector("#talentPreview");
  const homeBaseConfirmOverlay = document.querySelector("#homeBaseConfirmOverlay");

  function ensureEmoteWheel() {
      let wheel = document.getElementById("emoteWheel");
      if (wheel) return wheel;
      wheel = document.createElement("section");
      wheel.id = "emoteWheel";
      wheel.className = "emote-wheel";
      wheel.setAttribute("aria-label", "Emote wheel");
      wheel.innerHTML = `
        <div class="emote-wheel-ring">
          ${EMOTE_OPTIONS.map((option, index) => `
            <button class="emote-wheel-option emote-wheel-option-${index + 1}" type="button" data-emote-id="${option.id}">
              <span class="emote-wheel-key">${index + 1}</span>
              <span class="emote-wheel-icon">${option.icon}</span>
              <span class="emote-wheel-label">${option.label}</span>
            </button>
          `).join("")}
          <div class="emote-wheel-core">
            <strong>C</strong>
            <span>HOLD</span>
          </div>
        </div>
      `;
    mapStage?.appendChild(wheel);
      wheel.querySelectorAll("[data-emote-id]").forEach((button) => {
        button.addEventListener("click", () => sendEmote(String(button.dataset.emoteId || "")));
      });
      return wheel;
    }

  function positionEmoteWheel() {
    const wheel = document.getElementById("emoteWheel");
    if (!wheel || !mapStage) return;
    const stageRect = mapStage.getBoundingClientRect();
    const wheelSize = Math.min(360, Math.max(220, Math.min(stageRect.width, stageRect.height, window.innerWidth) - 32));
    const half = wheelSize / 2;
    const minX = 12 + half;
    const maxX = Math.max(minX, stageRect.width - 12 - half);
    const minY = 12 + half;
    const maxY = Math.max(minY, stageRect.height - 12 - half);
    const localX = Math.max(minX, Math.min(maxX, Number(emoteWheelPointer.x) || stageRect.width / 2));
    const localY = Math.max(minY, Math.min(maxY, Number(emoteWheelPointer.y) || stageRect.height / 2));
    wheel.style.width = `${wheelSize}px`;
    wheel.style.height = `${wheelSize}px`;
    wheel.style.left = `${localX}px`;
    wheel.style.top = `${localY}px`;
  }

  function closeEmoteWheel() {
    emoteWheelOpen = false;
    ensureEmoteWheel()?.classList.remove("is-open");
  }

  function toggleEmoteWheel(force = null) {
    if (!canUseEmotes()) return;
    emoteWheelOpen = force === null ? !emoteWheelOpen : !!force;
    if (emoteWheelOpen) positionEmoteWheel();
    ensureEmoteWheel()?.classList.toggle("is-open", emoteWheelOpen);
  }

  function updatePlayerIdentityLabel() {
    if (!playerIdentityLabel) return;
    const accountUser = window.RiggedAuth?.getUser?.();
    const username = typeof accountUser?.username === "string" ? accountUser.username.trim() : "";
    playerIdentityLabel.textContent = username || "PLAYER";
  }

  updatePlayerIdentityLabel();
  window.addEventListener("rigged:auth", updatePlayerIdentityLabel);

  let players = [];
  let states = [];
  let channels = [];
  let selectedParty = 0;
  let partyNameDraw = makePartyNameDraw();
  let customPartyNames = {};
  let selectedLeaderProfile = normalizeLeaderProfile(loadLeaderProfile() || { gender: "neutral", skin: SKIN_PRESETS[1], hairstyle: "charmer", facialHair: "none", hat: "none", outfit: "campaign_suit" });
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
  let activeWorldEvent = null;
  let worldEventTimer = 0;
  let nextWorldEventAt = 0;
  let worldEventCounter = 0;
  let lastCampaignStage = "base";
  let stageSplashEl = null;
  let stageSplashTimer = null;
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
  let assassinationStartTimer = null;
  let powerGrabTimer = null;
  let powerGrabStartTimer = null;
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
  let sfxPreviewAt = 0;
  let colorBlindMode = localStorage.getItem("riggedColorBlindMode") === "1";
  let settingsOpen = false;
  let settingsWasPaused = false;
  let audioContext = null;
  let reporterGainNode = null;
  let debateBellAudio = null;
  let speakTimer = null;
  const BGM_FADE_SECONDS = 2.8;
  const BGM_TRACKS = {
    menu: { src: "bgm-main-menu.mp3", loop: true },
    early: { src: "bgm-early-game.mp3", loop: true },
    mid1: { src: "bgm-mid-game-1.mp3", loop: true },
    mid2: { src: "bgm-mid-game-2.mp3", loop: true },
    end1: { src: "bgm-end-game-1.mp3", loop: true },
    end2: { src: "bgm-end-game-2.mp3", loop: true },
    victory: { src: "bgm-victory.mp3", loop: true },
  };
  const CAMPAIGN_STAGE_INFO = {
    early: {
      name: "KISSING BABIES PHASE",
      kicker: "PEACEFUL OPENING",
      effect: "Undecided states love speeches. Speech influence x2.",
      icon: "baby",
    },
    mid: {
      name: "CABLE NEWS KNIFE FIGHT",
      kicker: "MEDIA WAR",
      effect: "Owned channels suppress rivals. 10-20 EV strongholds print cash.",
      icon: "broadcast",
    },
    late: {
      name: "RIGGED OVERTIME",
      kicker: "NO MORE PRETENDING",
      effect: "Small states can gain +2 EV. Mega-states unlock ghost influence.",
      icon: "ballot",
    },
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
            playerDisplayName(),
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
      const addButton = event.target.closest('[data-add-lobby-bot]');
      if (addButton && !addButton.disabled) {
        addButton.disabled = true;
        addButton.classList.add('is-adding');
        const stateLabel = addButton.querySelector('.lobby-leader-state');
        if (stateLabel) stateLabel.textContent = 'Adding…';
        try {
          if (!currentLobby?.id) {
            const settings = window.lobbySettings || {};
            const result = await createLobby(
              playerDisplayName(),
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
          if (addButton.isConnected) {
            addButton.disabled = false;
            addButton.classList.remove('is-adding');
            if (stateLabel) stateLabel.textContent = 'Click to Fill';
          }
        }
        return;
      }
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
      if (armedAction === "officeSlow") {
        executeLeaderArmed(Number(card.dataset.leaderPlayer));
        return;
      }
      inspectLeaderPortrait(Number(card.dataset.leaderPlayer));
    });
    opponentTray.addEventListener("click", (event) => {
      const card = event.target.closest("[data-leader-player]");
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      if (armedAction === "officeSlow") return;
      inspectLeaderPortrait(Number(card.dataset.leaderPlayer));
    });
  }
  if (rivalTalentViewer) {
    rivalTalentViewer.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-rival-action]");
      if (actionButton) {
        const action = actionButton.dataset.rivalAction;
        if (action === "upgrade-hq" && rivalTalentPlayerId === HUMAN) {
          upgradeMainBase(HUMAN);
          renderRivalTalentViewer(HUMAN);
          if (typeof updateUi === "function") updateUi(true);
        }
        return;
      }
      if (event.target === rivalTalentViewer || event.target.closest("[data-rival-close]")) {
        closeRivalTalentViewer();
      }
    });
  }
  if (talentDraftOverlay) {
    talentDraftOverlay.addEventListener("click", (event) => {
      const card = event.target.closest("[data-talent-draft-pick]");
      if (!card || !activeTalentDraft || talentDraftResolving) return;
      talentDraftResolving = true;
      card.classList.add("is-confirming");
      window.setTimeout(() => {
        finalizeTalentDraft(activeTalentDraft.playerId, activeTalentDraft.tierIndex, String(card.dataset.talentDraftPick || ""));
      }, 180);
    });
  }
  if (homeBaseConfirmOverlay) {
    homeBaseConfirmOverlay.addEventListener("click", (event) => {
      const action = event.target.closest("[data-home-base-confirm]");
      if (!action) return;
      if (action.dataset.homeBaseConfirm === "cancel") {
        pendingHomeBaseStateIndex = -1;
        renderHomeBaseConfirmOverlay();
        return;
      }
      if (action.dataset.homeBaseConfirm === "confirm") {
        const stateIndex = pendingHomeBaseStateIndex;
        pendingHomeBaseStateIndex = -1;
        renderHomeBaseConfirmOverlay();
        if (stateIndex >= 0) chooseHomeBase(HUMAN, stateIndex, true);
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
      renderPartyRoster();
      renderLobbyLeaderStrip();
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
      createLobby(playerDisplayName(), mode, difficulty, maxPlayers, lobbyName, isPublic).then(result => {
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
  if (settingsCloseButton) settingsCloseButton.addEventListener("click", togglePause);
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
    const hqHit = hitMainBase(point, HUMAN);
    const hit = hitState(point);
    if (armedAction === "togglePolice") {
      if (miniHit) executeArmed(miniHit.state, "office");
      else if (hqHit) executeArmed(hqHit.state, "hq");
      else showToast("Click your HQ or District Office icon to deploy police.");
      updateUi(true);
      return;
    }
    if (armedAction === "deployMiniBase" && miniHit) {
      if (miniHit) {
        selectedState = miniHit.state;
        selectedPanelOpen = true;
        clearArmed();
        upgradeMiniBase(HUMAN, miniHit.state);
        updateUi(true);
        return;
      }
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
      if (mapStage) {
        const stageRect = mapStage.getBoundingClientRect();
        emoteWheelPointer = {
          x: event.clientX - stageRect.left,
          y: event.clientY - stageRect.top,
        };
        if (emoteWheelOpen) positionEmoteWheel();
      }
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
    updateArmedTargetBanner(hoveredState);
  });
  window.addEventListener("mouseup", () => {
    Camera.isDragging = false;
    canvas.style.cursor = "grab";
  });
  canvas.addEventListener("mouseleave", () => {
    Camera.isDragging = false;
    canvas.style.cursor = "grab";
    hoveredState = -1;
    updateArmedTargetBanner(-1);
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
    const rawKey = typeof event.key === "string" ? event.key : "";
    const key = rawKey.toLowerCase();
    const isSpace = event.code === "Space" || event.key === " ";
    const tag = event.target?.tagName?.toLowerCase();
    if (gameStarted && key in mapPanKeys && !pipOpen && !settingsOpen && !["input", "select", "textarea"].includes(tag)) {
      mapPanKeys[key] = true;
      event.preventDefault();
      return;
    }
    if (key !== "k" && !isSpace) return;
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (isSpace && !gameStarted) return;
    if (pipOpen) return;
    event.preventDefault();
    if (key === "k") assassinate(HUMAN, selectedState);
    else if (isSpace) cycleMapInfoMode();
  });
  document.addEventListener("keyup", (event) => {
    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
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

  const DIFFICULTY_TOOLTIPS = {
    easy: "EASY — Bots act about every 4.4 seconds, play conservatively, and receive no starting cash or action discount.",
    medium: "MEDIUM — Bots act about every 3.1 seconds, start with $5M, and receive 10% off most actions.",
    hard: "HARD — Bots act about every 2.15 seconds, start with $10M, receive 15% off most actions, and use aggressive operations more often.",
  };

  function syncDifficultyTooltip() {
    const tooltip = document.querySelector("#difficultyTooltip");
    if (!tooltip || !difficultyInput) return;
    tooltip.textContent = DIFFICULTY_TOOLTIPS[difficultyInput.value] || DIFFICULTY_TOOLTIPS.medium;
  }

  if (difficultyInput) {
    syncDifficultyTooltip();
    difficultyInput.addEventListener("change", () => {
      syncDifficultyTooltip();
      updateHostedLobbySettings();
    });
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
      const res = await lobbyFetch(`${REST_BACKEND_URL}/api/lobby/ready`, {
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
      const result = await createLobby(playerDisplayName(), mode, difficulty, maxPlayers, lobbyName, isPublic);
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
      const result = await joinLobby(String(normalized.lobbyId), playerDisplayName());
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
      locked: 0,
      disruptCooldown: 0,
      officeSlowCooldown: 0,
      officeInfluenceSlow: 0,
      speechCooldown: 0,
      speechCooldownTotal: 0,
      emoteId: lobbyMember?.emote?.until > Date.now() ? String(lobbyMember.emote.id || "") : "",
      emoteIcon: lobbyMember?.emote?.until > Date.now() ? String(lobbyMember.emote.icon || "") : "",
      emoteUntil: lobbyMember?.emote?.until > Date.now() ? Math.max(0, (Number(lobbyMember.emote.until) - Date.now()) / 1000) : 0,
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
      formerOwners: [],
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
    lastCampaignStage = "base";
    window.clearTimeout(stageSplashTimer);
    if (stageSplashEl) stageSplashEl.classList.remove("is-on");
    baseTimer = HOME_BASE_SECONDS;
    paused = false;
    localPauseRequested = false;
    matchOver = false;
    resultBgm = "";
    assassinationEventCounter = 0;
    latestAssassinationEvent = null;
    lastPresentedAssassinationEventId = 0;
    if (assassinationStartTimer) window.clearTimeout(assassinationStartTimer);
    assassinationStartTimer = null;
    if (assassinationTimer) window.clearTimeout(assassinationTimer);
    assassinationTimer = null;
    if (assassinationOverlay) assassinationOverlay.classList.remove("is-on");
    powerGrabEventCounter = 0;
    latestPowerGrabEvent = null;
    lastPresentedPowerGrabEventId = 0;
    debateEventCounter = 0;
    latestDebateEvent = null;
    lastPresentedDebateEventId = 0;
    debateResultEventCounter = 0;
    latestDebateResultEvent = null;
    lastPresentedDebateResultEventId = 0;
    if (powerGrabStartTimer) window.clearTimeout(powerGrabStartTimer);
    powerGrabStartTimer = null;
    if (powerGrabTimer) window.clearTimeout(powerGrabTimer);
    powerGrabTimer = null;
    if (powerGrabOverlay) powerGrabOverlay.classList.remove("is-on");
    matchResultCounter = 0;
    matchResult = null;
    lastPresentedMatchResultId = 0;
    broadcastEventCounter = 0;
    latestBroadcastEvent = null;
    lastPresentedBroadcastEventId = 0;
    if (victoryEl) victoryEl.classList.remove("is-open");
    closeRivalTalentViewer();
    news = null;
    newsTimer = 0;
    activeWorldEvent = null;
    worldEventTimer = 0;
    worldEventCounter = 0;
    activeChannel = 0;
    nextNewsAt = NEWS_INTERVAL;
    nextWorldEventAt = worldEventFirstElapsedDay() * CAMPAIGN_DAY_SECONDS;
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

  function eyewearById(id) {
    return LEADER_EYEWEAR.find((item) => item.id === id) || LEADER_EYEWEAR[0];
  }

  function pinById(id) {
    return LEADER_PINS.find((item) => item.id === id) || LEADER_PINS[0];
  }

  function expressionById(id) {
    return LEADER_EXPRESSIONS.find((item) => item.id === id) || LEADER_EXPRESSIONS[0];
  }

  function normalizeLeaderProfile(profile) {
    const visual = visualById(profile?.hairstyle);
    return {
      gender: "neutral",
      skin: SKIN_PRESETS.includes(profile?.skin) ? profile.skin : SKIN_PRESETS[1],
      hairstyle: visual.id,
      facialHair: visual.forceFacial || (FACIAL_HAIR.some((item) => item.id === profile?.facialHair) ? profile.facialHair : "none"),
      hat: LEADER_HATS.some((item) => item.id === profile?.hat) ? profile.hat : "none",
      outfit: LEADER_OUTFITS.some((item) => item.id === profile?.outfit) ? profile.outfit : "campaign_suit",
      eyewear: eyewearById(profile?.eyewear).id,
      pin: pinById(profile?.pin).id,
      expression: expressionById(profile?.expression).id,
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
      outfit: pickFrom(LEADER_OUTFITS).id,
      eyewear: Math.random() < 0.42 ? pickFrom(LEADER_EYEWEAR.slice(1)).id : "none",
      pin: Math.random() < 0.55 ? pickFrom(LEADER_PINS.slice(1)).id : "none",
      expression: pickFrom(LEADER_EXPRESSIONS).id,
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
      outfit: pickFrom(LEADER_OUTFITS).id,
      eyewear: Math.random() < 0.3 ? pickFrom(LEADER_EYEWEAR.slice(1)).id : "none",
      pin: Math.random() < 0.6 ? pickFrom(LEADER_PINS.slice(1)).id : "none",
      expression: LEADER_EXPRESSIONS[id % LEADER_EXPRESSIONS.length].id,
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
    if (!partyRoster) return;
    partyRoster.innerHTML = "";
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
    const outfit = LEADER_OUTFITS.find((item) => item.id === profile.outfit) || LEADER_OUTFITS[0];
    const eyewear = eyewearById(profile.eyewear);
    const pin = pinById(profile.pin);
    const expression = expressionById(profile.expression);
    const flag = flagById(profile.flag);
    const palette = faction.portrait || FACTIONS[index].portrait;
    talentPreview.innerHTML = `
      <div class="talent-preview-head">
        <div>
          <input class="party-name-inline" type="text" data-party-name-input="${index}" maxlength="28" value="${escapeHtml(customPartyNames[index] || faction.full)}" aria-label="Edit your party name" title="Edit your party name">
          <h2>${faction.leader}</h2>
        </div>
        <button class="secondary-button" type="button" data-preview-action="close">Close</button>
      </div>
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
            <span>${escapeHtml(flag.label)} - ${escapeHtml(visual.label)} - ${escapeHtml(hat.label)} - ${escapeHtml(outfit.label)}</span>
            <span>${escapeHtml(eyewear.label)} - ${escapeHtml(pin.label)} - ${escapeHtml(expression.label)}</span>
            <span>${escapeHtml(flag.desc)} - ${escapeHtml(visual.desc)} - ${escapeHtml(expression.desc)}</span>
            <em>${profile.facialLocked ? "Facial hair locked: " + FACIAL_HAIR.find((item) => item.id === profile.facialHair).label : "Facial hair unlocked"}</em>
          </div>
        </div>
        <div class="leader-custom-controls">
          <label><span>Flag</span><select data-leader-custom="flag">${optionsHtml(PARTY_FLAGS, profile.flag)}</select></label>
          <label><span>Hat</span><select data-leader-custom="hat">${optionsHtml(LEADER_HATS, profile.hat)}</select></label>
          <label><span>Face Expression</span><select data-leader-custom="expression">${optionsHtml(LEADER_EXPRESSIONS, profile.expression)}</select></label>
          <label><span>Skin</span><select data-leader-custom="skin">${skinOptionsHtml(profile.skin)}</select></label>
          <label><span>Hairstyle</span><select data-leader-custom="hairstyle">${optionsHtml(LEADER_VISUALS, profile.hairstyle)}</select></label>
          <label><span>Eyewear</span><select data-leader-custom="eyewear">${optionsHtml(LEADER_EYEWEAR, profile.eyewear)}</select></label>
          <label><span>Facial Hair</span><select data-leader-custom="facialHair" ${profile.facialLocked ? "disabled" : ""}>${optionsHtml(FACIAL_HAIR, profile.facialHair)}</select></label>
          <label><span>Lapel Pin</span><select data-leader-custom="pin">${optionsHtml(LEADER_PINS, profile.pin)}</select></label>
          <label><span>Outfit</span><select data-leader-custom="outfit">${optionsHtml(LEADER_OUTFITS, profile.outfit)}</select></label>
        </div>
      </section>
      <div class="talent-preview-foot">
        <button class="primary-button" type="button" data-preview-action="start">${escapeHtml(lobbyStartButtonLabel(index))}</button>
      </div>
    `;
    updateLobbyStartButtons();
  }

  function talentTierClass(tierIndex) {
    return ["amber", "cyan", "magenta"][tierIndex] || "amber";
  }

  function talentCardArtSvg(talent) {
    const text = `${talent.id} ${talent.name} ${talent.desc}`.toLowerCase();
    const palette = text.includes("assassin") || text.includes("blackout")
      ? { base: "#2d0814", glow: "#ff5878", line: "#ff9ab4" }
      : text.includes("speech") || text.includes("crowd")
      ? { base: "#11221c", glow: "#52ffb4", line: "#ccffe5" }
      : text.includes("channel") || text.includes("broadcast") || text.includes("signal")
      ? { base: "#071d28", glow: "#53d7ff", line: "#b9f4ff" }
      : text.includes("office") || text.includes("base") || text.includes("upgrade")
      ? { base: "#211909", glow: "#ffd86b", line: "#fff0c1" }
      : text.includes("disrupt") || text.includes("riot") || text.includes("sabotage")
      ? { base: "#1f0b22", glow: "#f06cff", line: "#ffd2ff" }
      : { base: "#102616", glow: "#63ff8d", line: "#d2ffe0" };
    const motif = text.includes("speech") || text.includes("crowd")
      ? '<circle cx="44" cy="42" r="18" fill="none" stroke="currentColor" stroke-width="3"/><path d="M31 44 Q44 22 57 44 M26 55 Q44 34 62 55" fill="none" stroke="currentColor" stroke-width="3"/>'
      : text.includes("channel") || text.includes("broadcast") || text.includes("signal")
      ? '<rect x="18" y="24" width="52" height="34" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 57 L36 43 L44 49 L57 32 L64 39" fill="none" stroke="currentColor" stroke-width="3"/><rect x="34" y="62" width="20" height="4" fill="currentColor"/>'
      : text.includes("office") || text.includes("base") || text.includes("upgrade")
      ? '<path d="M44 18 L66 31 V66 H22 V31 Z" fill="none" stroke="currentColor" stroke-width="3"/><path d="M33 66 V44 H55 V66 M29 36 H59" fill="none" stroke="currentColor" stroke-width="3"/>'
      : text.includes("assassin") || text.includes("blackout")
      ? '<path d="M22 62 L44 18 L66 62" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="44" cy="44" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M44 26 V62 M26 44 H62" fill="none" stroke="currentColor" stroke-width="3"/>'
      : text.includes("disrupt") || text.includes("riot") || text.includes("sabotage")
      ? '<path d="M30 18 H58 L44 40 H61 L29 70 L39 46 H24 Z" fill="currentColor"/><rect x="22" y="72" width="44" height="4" fill="currentColor" opacity=".45"/>'
      : '<circle cx="44" cy="44" r="20" fill="none" stroke="currentColor" stroke-width="3"/><path d="M25 44 H63 M44 25 V63" fill="none" stroke="currentColor" stroke-width="3"/>';
    return `
      <svg viewBox="0 0 88 88" aria-hidden="true">
        <defs>
          <radialGradient id="talentCardGlow-${escapeHtml(talent.id)}" cx="50%" cy="35%" r="65%">
            <stop offset="0%" stop-color="${palette.glow}" stop-opacity=".42"/>
            <stop offset="100%" stop-color="${palette.base}" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect x="4" y="4" width="80" height="80" rx="10" fill="${palette.base}" stroke="${palette.line}" stroke-width="2"/>
        <rect x="8" y="8" width="72" height="72" rx="8" fill="url(#talentCardGlow-${escapeHtml(talent.id)})"/>
        <g style="color:${palette.glow}">
          ${motif}
        </g>
        <rect x="14" y="14" width="60" height="6" fill="${palette.line}" opacity=".18"/>
        <rect x="14" y="68" width="60" height="4" fill="${palette.line}" opacity=".18"/>
      </svg>
    `;
  }

  function talentCardArtStyle(talent) {
    if (!talent?.atlas) return "";
    const index = Math.max(0, Number(talent.artIndex) || 0);
    const col = index % 3;
    const row = Math.floor(index / 3);
    return `--atlas-x:${col};--atlas-y:${row};`;
  }

  function talentTreeBadge(tree) {
    switch (String(tree || "")) {
      case "oligarchy": return "$";
      case "populist": return "M";
      case "syndicate": return "N";
      case "vanguard": return "+";
      case "futurist": return ">";
      case "machine": return "*";
      case "signal": return "~";
      case "ledger": return "=";
      default: return "#";
    }
  }

  function talentCardMarkup(talent, options = {}) {
    const tierIndex = Number(options.tierIndex ?? talent.tierIndex ?? 0);
    const picked = !!options.picked;
    const compact = !!options.compact;
    const action = options.action || "";
    const countdown = options.showCountdownChip
      ? `<div class="talent-draft-chip" data-talent-draft-auto-chip>${escapeHtml(options.countdown || "")}</div>`
      : "";
    return `
        <article class="talent-draft-card talent-draft-card--${talentTierClass(tierIndex)}${picked ? " is-picked" : ""}${compact ? " is-compact" : ""}" data-talent-tree="${escapeHtml(String(talent.tree || ""))}"${action ? ` data-talent-draft-pick="${escapeHtml(talent.id)}"` : ""}>
          <div class="talent-draft-card-art">${talent?.atlas ? `<div class="talent-draft-card-art-image" style="${talentCardArtStyle(talent)}"><img class="talent-draft-card-atlas" src="${escapeHtml(talent.atlas)}" alt=""></div>` : talentCardArtSvg(talent)}</div>
        <div class="talent-draft-card-body">
          <div class="talent-draft-card-top">
            <div class="talent-draft-card-topline">
              <span class="talent-draft-tree-badge" aria-hidden="true">${escapeHtml(talentTreeBadge(talent.tree))}</span>
              <span class="talent-draft-tier">${TALENT_TIER_LABELS[tierIndex]}</span>
            </div>
            ${countdown}
          </div>
          <strong>${escapeHtml(talent.name)}</strong>
          <span class="talent-draft-origin">${escapeHtml(talent.treeName)} // ${escapeHtml(talent.treeSub)}</span>
          <p>${escapeHtml(talent.desc)}</p>
          ${picked ? '<em>Chosen</em>' : action ? '<em>Pick this card</em>' : '<em>Drafted ability</em>'}
        </div>
      </article>
    `;
  }

  function renderChosenTalentCards(player) {
    const cards = chosenTalentCards(player);
    if (!cards.length) {
      return `<div class="talent-card-empty">No drafted cards yet. HQ unlocks will deal new choices.</div>`;
    }
    return TALENT_REQ_LEVEL.map((_, tierIndex) => {
      const card = cards.find((entry) => entry.tierIndex === tierIndex);
      return `
        <section class="talent-card-tier-block">
          <div class="talent-card-tier-label">${TALENT_TIER_LABELS[tierIndex]}</div>
          ${card ? talentCardMarkup(card, { tierIndex, picked: true, compact: true }) : '<div class="talent-card-empty">No card drafted for this tier yet.</div>'}
        </section>
      `;
      }).join("");
  }

  function renderTalentHistoryHud(player) {
    if (!talentHistoryHud) return;
    if (!gameStarted || !player) {
      talentHistoryHud.innerHTML = "";
      talentHistoryHud.classList.remove("is-visible");
      return;
    }
    const cards = chosenTalentCards(player);
    if (!cards.length) {
      talentHistoryHud.innerHTML = `
        <div class="talent-history-title">DOCTRINES</div>
        <div class="talent-history-empty">No drafted doctrines yet.</div>
      `;
      talentHistoryHud.classList.add("is-visible");
      return;
    }
    talentHistoryHud.innerHTML = `
      <div class="talent-history-title">DOCTRINES</div>
      <div class="talent-history-track">
        ${cards.map(({ tierIndex, card }) => `
          <article class="talent-history-chip" data-talent-tree="${escapeHtml(String(card.tree || ""))}">
            <span class="talent-history-chip-tier">${escapeHtml(TALENT_TIER_LABELS[tierIndex])}</span>
            <strong>${escapeHtml(card.name)}</strong>
          </article>
        `).join("")}
      </div>
    `;
    talentHistoryHud.classList.add("is-visible");
  }

  function renderRivalTalentViewer(playerId) {
    if (!rivalTalentViewer) return;
    const player = players.find((candidate) => candidate.id === playerId);
    const tree = player ? TALENTS[player.talentTree] : null;
    if (!player || !tree) {
      rivalTalentViewer.innerHTML = "";
      rivalTalentViewer.classList.remove("is-open");
      rivalTalentViewer.setAttribute("aria-hidden", "true");
      rivalTalentPlayerId = -1;
      return;
    }
    const isHumanProfile = player.id === HUMAN;
    const nextHq = player.mainBaseLevel < 3 ? player.mainBaseLevel + 1 : 0;
    const hqReq = nextHq ? HQ_UPGRADE[nextHq] : null;
    const hqUnlocked = Number.isInteger(player.homeBase) && player.homeBase >= 0;
    const homeState = hqUnlocked ? states[player.homeBase] : null;
    const homeInfluence = homeState ? Math.round(adjustedInfluence(homeState, player.id)) : 0;
    const hqInfluenceReq = hqReq ? Math.ceil((hqReq.infl || 0) * (hasTalent(player, "system_overclock") ? 0.8 : 1)) : 0;
    const hqUpgradeBusy = missions.some((mission) => mission.type === "baseUpgrade" && mission.player === player.id);
    const canUpgradeHq = !!(isHumanProfile && hqUnlocked && nextHq && !hqUpgradeBusy && player.cash >= hqReq.cash && homeInfluence >= hqInfluenceReq);
    const hqMeta = !isHumanProfile
      ? `<div class="rival-talent-theme">${escapeHtml(tree.theme)}</div>`
      : `
      <div class="rival-talent-theme rival-talent-theme-hq">
        <button class="primary-button rival-hq-button" type="button" data-rival-action="upgrade-hq"${canUpgradeHq ? "" : " disabled"}>
          ${!hqUnlocked
            ? "SELECT HOME BASE FIRST"
            : nextHq
              ? (hqUpgradeBusy ? "HQ UPGRADE UNDERWAY" : `UPGRADE HQ TO L${nextHq}`)
              : "HQ MAXED"}
        </button>
        <div class="rival-hq-copy">
          ${!hqUnlocked
            ? "Choose your HQ state first before upgrading."
            : nextHq
              ? `Next tier costs ${formatMoney(hqReq.cash)} and needs ${hqInfluenceReq}% home influence. You have ${homeInfluence}%.`
              : `HQ Level ${player.mainBaseLevel} is fully upgraded.`}
        </div>
      </div>`;
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
      ${hqMeta}
      <div class="rival-talent-grid talent-card-collection">${renderChosenTalentCards(player)}</div>
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

  function clearActiveTalentDraftTimer() {
    if (activeTalentDraftTimer) {
      clearTimeout(activeTalentDraftTimer);
      activeTalentDraftTimer = null;
    }
  }

  function renderTalentDraftOverlay() {
    if (!talentDraftOverlay) return;
    if (!activeTalentDraft) {
      talentDraftResolving = false;
      activeTalentDraftRenderKey = "";
      talentDraftOverlay.innerHTML = "";
      talentDraftOverlay.classList.remove("is-open");
      talentDraftOverlay.setAttribute("aria-hidden", "true");
      return;
    }
    const player = players[activeTalentDraft.playerId];
    if (!player) {
      activeTalentDraft = null;
      renderTalentDraftOverlay();
      return;
    }
    const renderKey = `${activeTalentDraft.playerId}:${activeTalentDraft.tierIndex}:${activeTalentDraft.options.map((talent) => talent.id).join("|")}`;
    if (activeTalentDraftRenderKey === renderKey) {
      talentDraftOverlay.classList.add("is-open");
      talentDraftOverlay.setAttribute("aria-hidden", "false");
      return;
    }
    activeTalentDraftRenderKey = renderKey;
    talentDraftOverlay.innerHTML = `
      <div class="talent-draft-panel is-dealing">
        <div class="talent-draft-grid">
          ${activeTalentDraft.options.map((talent) => talentCardMarkup(talent, { tierIndex: activeTalentDraft.tierIndex, action: "pick" })).join("")}
        </div>
      </div>
    `;
    talentDraftOverlay.classList.add("is-open");
    talentDraftOverlay.setAttribute("aria-hidden", "false");
  }

  function finalizeTalentDraft(playerId, tierIndex, chosenTalentId = "") {
    const player = players[playerId];
    if (!player || !tierNeedsTalentPick(player, tierIndex)) return false;
    const draft = activeTalentDraft && activeTalentDraft.playerId === playerId && activeTalentDraft.tierIndex === tierIndex
      ? activeTalentDraft
      : { options: draftOptionsForTier(player, tierIndex) };
    const chosen = draft.options.find((talent) => talent.id === chosenTalentId)
      || ((player.isBot || playerId !== HUMAN) ? autoPickDraftTalent(player, draft.options) : null);
    if (!chosen) return false;
    player.talents[tierIndex] = chosen.id;
    if (activeTalentDraft && activeTalentDraft.playerId === playerId && activeTalentDraft.tierIndex === tierIndex) {
      clearActiveTalentDraftTimer();
      activeTalentDraft = null;
      renderTalentDraftOverlay();
    }
    addAlert(`${player.name} drafted ${chosen.name} from ${TALENT_TIER_LABELS[tierIndex]}.`);
      if (playerId === HUMAN) {
        playTalentDraftPickSfx();
        showToast(`${TALENT_TIER_LABELS[tierIndex]} doctrine chosen: ${chosen.name}.`, "draft");
        updateUi(true);
      }
    refreshTalentInterfaces();
    return true;
  }

  function startTalentDraft(playerId, tierIndex) {
    const player = players[playerId];
    if (!player || !tierNeedsTalentPick(player, tierIndex)) return false;
    const options = draftOptionsForTier(player, tierIndex);
    if (!options.length) return false;
    if (player.isBot || playerId !== HUMAN) {
      return finalizeTalentDraft(playerId, tierIndex, autoPickDraftTalent(player, options)?.id || "");
    }
    clearActiveTalentDraftTimer();
    activeTalentDraft = {
      playerId,
      tierIndex,
      options,
    };
    renderTalentDraftOverlay();
    updateUi(true);
    return true;
  }

  function checkTalentDraftUnlocks(player) {
    if (!player) return;
    for (let tierIndex = 0; tierIndex < TALENT_REQ_LEVEL.length; tierIndex += 1) {
      if (tierNeedsTalentPick(player, tierIndex)) {
        startTalentDraft(player.id, tierIndex);
        if (player.id === HUMAN) break;
      }
    }
  }

  function refreshTalentInterfaces() {
    if (pipOpen) renderPip();
    if (rivalTalentPlayerId >= 0) renderRivalTalentViewer(rivalTalentPlayerId);
    renderTalentHistoryHud(players[HUMAN]);
    renderTalentDraftOverlay();
  }

  function inspectLeaderPortrait(playerId) {
    closePip();
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
    const eyewear = p ? ({
      aviators: '<rect x="24" y="38" width="13" height="10" rx="2" fill="#dffcf0" opacity=".12" stroke="#c7f9de" stroke-width="2"/><rect x="43" y="38" width="13" height="10" rx="2" fill="#dffcf0" opacity=".12" stroke="#c7f9de" stroke-width="2"/><rect x="37" y="41" width="6" height="2" fill="#8ff7c4"/><rect x="27" y="40" width="7" height="2" fill="#ffffff" opacity=".18"/><rect x="46" y="40" width="7" height="2" fill="#ffffff" opacity=".18"/>',
      wireframes: '<rect x="24" y="39" width="13" height="9" rx="2" fill="none" stroke="#c7f9de" stroke-width="2"/><rect x="43" y="39" width="13" height="9" rx="2" fill="none" stroke="#c7f9de" stroke-width="2"/><rect x="37" y="42" width="6" height="2" fill="#c7f9de"/>',
      visor_scope: '<rect x="20" y="36" width="40" height="11" rx="3" fill="#dffcf0" opacity=".08" stroke="var(--party)" stroke-width="2"/><rect x="25" y="39" width="11" height="5" fill="var(--accent)" opacity=".45"/><rect x="39" y="39" width="16" height="5" fill="#eafff2" opacity=".18"/>',
      square_frames: '<rect x="23" y="38" width="14" height="11" fill="#dffcf0" opacity=".08" stroke="#0d2218" stroke-width="3"/><rect x="43" y="38" width="14" height="11" fill="#dffcf0" opacity=".08" stroke="#0d2218" stroke-width="3"/><rect x="37" y="42" width="6" height="3" fill="#0d2218"/>',
    }[p.eyewear] || "") : "";
    const torsoX = p?.gender === "fem" ? 21 : p?.gender === "masc" ? 16 : 18;
    const torsoW = p?.gender === "fem" ? 38 : p?.gender === "masc" ? 48 : 44;
    const outfit = p ? ({
      campaign_suit: '<rect x="' + torsoX + '" y="60" width="' + torsoW + '" height="24" fill="var(--suit)"/><rect x="32" y="60" width="16" height="24" fill="var(--accent)" opacity="0.85"/>',
      power_suit: '<rect x="12" y="64" width="56" height="20" fill="var(--suit)"/><rect x="18" y="59" width="18" height="25" fill="var(--suit)"/><rect x="44" y="59" width="18" height="25" fill="var(--suit)"/><path d="M25 60 L39 74 L31 84 H18 V62 Z" fill="var(--accent)" opacity=".72"/><path d="M55 60 L41 74 L49 84 H62 V62 Z" fill="var(--accent)" opacity=".72"/><rect x="37" y="64" width="6" height="20" fill="var(--party)"/>',
      field_jacket: '<rect x="15" y="60" width="50" height="24" fill="var(--suit)"/><rect x="38" y="60" width="4" height="24" fill="var(--accent)"/><rect x="20" y="68" width="13" height="9" fill="var(--accent)" opacity=".62"/><rect x="47" y="68" width="13" height="9" fill="var(--accent)" opacity=".62"/><rect x="25" y="62" width="4" height="4" fill="var(--party)"/><rect x="51" y="62" width="4" height="4" fill="var(--party)"/>',
      rolled_sleeves: '<rect x="20" y="59" width="40" height="25" fill="var(--accent)"/><rect x="12" y="64" width="13" height="14" fill="var(--accent)"/><rect x="55" y="64" width="13" height="14" fill="var(--accent)"/><rect x="12" y="75" width="13" height="9" fill="var(--skin)"/><rect x="55" y="75" width="13" height="9" fill="var(--skin)"/><rect x="38" y="59" width="4" height="25" fill="var(--party)"/>',
      tech_blazer: '<rect x="17" y="60" width="46" height="24" fill="var(--suit)"/><path d="M17 60 H36 L48 84 H36 Z" fill="var(--party)" opacity=".72"/><path d="M63 60 H45 L36 84 H48 Z" fill="var(--accent)" opacity=".58"/><rect x="21" y="64" width="4" height="15" fill="var(--accent)"/><rect x="55" y="64" width="4" height="15" fill="var(--party)"/>',
      ceremonial_uniform: '<rect x="15" y="60" width="50" height="24" fill="var(--suit)"/><rect x="12" y="59" width="20" height="6" fill="var(--accent)"/><rect x="48" y="59" width="20" height="6" fill="var(--accent)"/><rect x="38" y="60" width="4" height="24" fill="var(--party)"/><rect x="24" y="68" width="7" height="4" fill="#ffd76a"/><rect x="49" y="68" width="7" height="4" fill="#ffd76a"/><rect x="24" y="76" width="32" height="3" fill="var(--accent)"/>',
    }[p.outfit] || '') : '<rect x="' + torsoX + '" y="60" width="' + torsoW + '" height="24" fill="var(--suit)"/><rect x="32" y="60" width="16" height="24" fill="var(--accent)" opacity="0.85"/>';
    const pin = p ? ({
      party_star: '<path d="M58 69 L60 74 L66 74 L61 77 L63 83 L58 79 L53 83 L55 77 L50 74 L56 74 Z" fill="#ffd76a" stroke="#24180a" stroke-width="1"/>',
      victory_ribbon: '<rect x="54" y="68" width="8" height="7" fill="#f0eadc"/><path d="M55 75 L58 82 L61 75" fill="var(--party)"/>',
      flag_bar: '<rect x="53" y="69" width="12" height="5" fill="#f0eadc"/><rect x="53" y="69" width="4" height="5" fill="var(--party)"/><rect x="57" y="69" width="4" height="5" fill="var(--accent)"/><rect x="61" y="69" width="4" height="5" fill="#0a1610"/>',
      signal_chip: '<rect x="54" y="68" width="10" height="10" fill="#07140d" stroke="var(--party)" stroke-width="2"/><rect x="57" y="71" width="4" height="4" fill="var(--accent)"/>',
    }[p.pin] || "") : "";
    const expression = p?.expression || "neutral";
    const brow = ({
      smile: '<rect x="27" y="35" width="10" height="2" fill="#09140d"/><rect x="43" y="35" width="10" height="2" fill="#09140d"/>',
      smirk: '<rect x="27" y="35" width="10" height="2" fill="#09140d"/><rect x="43" y="34" width="10" height="2" fill="#09140d"/>',
      angry: '<rect x="26" y="36" width="11" height="2" fill="#09140d" transform="rotate(-10 31.5 37)"/><rect x="43" y="36" width="11" height="2" fill="#09140d" transform="rotate(10 48.5 37)"/>',
      frown: '<rect x="27" y="34" width="10" height="2" fill="#09140d"/><rect x="43" y="34" width="10" height="2" fill="#09140d"/>',
      surprised: '<rect x="27" y="32" width="10" height="2" fill="#09140d"/><rect x="43" y="32" width="10" height="2" fill="#09140d"/>',
      neutral: p?.gender === "fem"
        ? '<rect x="27" y="35" width="10" height="2" fill="#09140d"/><rect x="43" y="35" width="10" height="2" fill="#09140d"/>'
        : '<rect x="26" y="34" width="12" height="3" fill="#09140d"/><rect x="42" y="34" width="12" height="3" fill="#09140d"/>',
    }[expression] || '<rect x="26" y="34" width="12" height="3" fill="#09140d"/><rect x="42" y="34" width="12" height="3" fill="#09140d"/>');
    const mouth = ({
      smile: '<path d="M32 53 Q40 60 48 53" fill="none" stroke="#8c3840" stroke-width="3" stroke-linecap="square"/>',
      smirk: '<path d="M33 54 Q39 56 47 52" fill="none" stroke="#8c3840" stroke-width="3" stroke-linecap="square"/>',
      angry: '<rect x="34" y="54" width="12" height="3" fill="#8c3840"/>',
      frown: '<path d="M32 57 Q40 51 48 57" fill="none" stroke="#8c3840" stroke-width="3" stroke-linecap="square"/>',
      surprised: '<rect x="36" y="52" width="8" height="8" rx="3" fill="#8c3840"/>',
      neutral: '<rect x="34" y="54" width="12" height="3" fill="#8c3840"/>',
    }[expression] || '<rect x="34" y="54" width="12" height="3" fill="#8c3840"/>');
    const neck = '<rect x="33" y="58" width="14" height="8" fill="var(--skin)"/>';
    return `
      <svg viewBox="0 0 80 96" aria-hidden="true">
        <rect x="6" y="6" width="68" height="84" fill="rgba(255,255,255,0.03)" stroke="var(--party)" stroke-width="3"/>
        <rect x="10" y="10" width="60" height="76" fill="var(--accent)" opacity=".03"/>
        ${outfit}
        ${neck}
        <rect x="19" y="28" width="6" height="14" fill="var(--skin)" opacity=".96"/>
        <rect x="55" y="28" width="6" height="14" fill="var(--skin)" opacity=".96"/>
        <rect x="22" y="24" width="36" height="38" fill="var(--skin)"/>
        ${hair}
        ${hat}
        ${brow}
        <rect x="29" y="40" width="5" height="5" fill="#06120c"/>
        <rect x="46" y="40" width="5" height="5" fill="#06120c"/>
        <rect x="30" y="41" width="2" height="2" fill="#effff4" opacity=".5"/>
        <rect x="47" y="41" width="2" height="2" fill="#effff4" opacity=".5"/>
        ${eyewear}
        ${facial}
        ${mouth}
        ${pin}
        <rect x="12" y="78" width="56" height="6" fill="var(--party)"/>
        <rect x="12" y="82" width="56" height="2" fill="#ffffff" opacity=".18"/>
      </svg>
    `;
  }

  function leaderPortraitMiniSvg(index, profile = null) {
    const p = profile ? normalizeLeaderProfile(profile) : null;
    const hairBand = p ? ({
      mogul: '<rect x="18" y="14" width="44" height="10" fill="var(--hair)"/><rect x="40" y="10" width="18" height="6" fill="var(--hair)"/>',
      supreme: '<rect x="24" y="10" width="32" height="16" fill="var(--hair)"/>',
      secretary: '<rect x="18" y="15" width="44" height="9" fill="var(--hair)"/><rect x="18" y="24" width="8" height="12" fill="var(--hair)"/>',
      strongman: '<rect x="24" y="17" width="32" height="6" fill="var(--hair)"/>',
      chancellor: '<rect x="17" y="15" width="46" height="9" fill="var(--hair)"/><rect x="17" y="24" width="9" height="18" fill="var(--hair)"/><rect x="54" y="24" width="9" height="18" fill="var(--hair)"/>',
      disruptor: '<rect x="16" y="12" width="48" height="12" fill="var(--hair)"/><rect x="18" y="24" width="8" height="11" fill="var(--hair)"/><rect x="54" y="24" width="8" height="11" fill="var(--hair)"/>',
      anarcho: '<rect x="14" y="12" width="52" height="12" fill="var(--hair)"/><rect x="14" y="24" width="11" height="20" fill="var(--hair)"/><rect x="55" y="24" width="11" height="20" fill="var(--hair)"/>',
      iron_helmet: '<rect x="16" y="12" width="48" height="16" fill="var(--hair)"/><rect x="20" y="28" width="40" height="7" fill="var(--hair)"/>',
      charmer: '<rect x="18" y="15" width="44" height="8" fill="var(--hair)"/><rect x="33" y="11" width="21" height="6" fill="var(--hair)"/>',
      academic: '<rect x="16" y="24" width="8" height="18" fill="var(--hair)"/><rect x="56" y="24" width="8" height="18" fill="var(--hair)"/>',
      orator: '<rect x="22" y="18" width="36" height="5" fill="var(--hair)"/>',
      generalissimo: '<rect x="17" y="13" width="46" height="10" fill="var(--hair)"/><rect x="24" y="9" width="32" height="4" fill="var(--accent)"/>',
      demagogue: '<rect x="17" y="16" width="46" height="7" fill="var(--hair)"/>',
      steel: '<rect x="16" y="13" width="48" height="10" fill="var(--hair)"/><rect x="22" y="9" width="36" height="6" fill="var(--hair)"/>',
    }[p.hairstyle] || '<rect x="18" y="15" width="44" height="8" fill="var(--hair)"/>') : '<rect x="18" y="15" width="44" height="8" fill="var(--hair)"/>';
    const facial = p ? ({
      toothbrush: '<rect x="35" y="46" width="10" height="3" fill="var(--hair)"/>',
      walrus: '<rect x="28" y="45" width="24" height="4" fill="var(--hair)"/>',
      mustache: '<rect x="30" y="45" width="20" height="3" fill="var(--hair)"/>',
      goatee: '<rect x="35" y="46" width="10" height="3" fill="var(--hair)"/><rect x="37" y="50" width="6" height="6" fill="var(--hair)"/>',
      beard: '<rect x="26" y="45" width="28" height="11" fill="var(--hair)" opacity=".88"/>',
    }[p.facialHair] || "") : "";
    const hat = p ? ({
      keffiyeh: '<rect x="18" y="12" width="44" height="14" fill="#eef3ea"/><rect x="16" y="22" width="10" height="22" fill="#eef3ea"/><rect x="54" y="22" width="10" height="22" fill="#eef3ea"/><rect x="21" y="15" width="38" height="4" fill="var(--party)" opacity=".74"/>',
      campaign_cap: '<rect x="22" y="12" width="36" height="11" fill="var(--party)"/><rect x="52" y="21" width="14" height="4" fill="var(--party)"/><rect x="35" y="15" width="10" height="5" fill="var(--accent)"/>',
      fedora: '<rect x="15" y="19" width="50" height="5" fill="var(--hair)"/><rect x="24" y="10" width="32" height="13" fill="var(--hair)"/><rect x="25" y="18" width="30" height="3" fill="var(--accent)"/>',
      beret: '<rect x="18" y="12" width="42" height="12" fill="var(--party)"/><rect x="47" y="9" width="10" height="6" fill="var(--party)"/><rect x="33" y="11" width="5" height="3" fill="var(--accent)"/>',
      cowboy: '<rect x="12" y="20" width="56" height="5" fill="#8b5a2b"/><rect x="26" y="10" width="28" height="14" fill="#9b6a36"/><rect x="30" y="18" width="20" height="3" fill="var(--accent)"/>',
      military_cap: '<rect x="20" y="12" width="40" height="11" fill="#1f3b2d"/><rect x="53" y="21" width="13" height="4" fill="#1f3b2d"/><rect x="36" y="15" width="8" height="5" fill="var(--accent)"/>',
      visor: '<rect x="20" y="14" width="40" height="6" fill="var(--party)"/><rect x="50" y="20" width="16" height="4" fill="var(--party)"/><rect x="26" y="10" width="28" height="3" fill="var(--accent)"/>',
    }[p.hat] || "") : "";
    const eyewear = p ? ({
      aviators: '<rect x="24" y="31" width="12" height="8" rx="2" fill="#e8fff0" opacity=".14" stroke="#d2ffe8" stroke-width="2"/><rect x="44" y="31" width="12" height="8" rx="2" fill="#e8fff0" opacity=".14" stroke="#d2ffe8" stroke-width="2"/><rect x="36" y="34" width="8" height="2" fill="#baf7d6"/>',
      wireframes: '<rect x="24" y="31" width="12" height="8" rx="2" fill="none" stroke="#d2ffe8" stroke-width="2"/><rect x="44" y="31" width="12" height="8" rx="2" fill="none" stroke="#d2ffe8" stroke-width="2"/><rect x="36" y="34" width="8" height="2" fill="#d2ffe8"/>',
      visor_scope: '<rect x="20" y="30" width="40" height="10" rx="3" fill="#e8fff0" opacity=".08" stroke="var(--party)" stroke-width="2"/><rect x="25" y="33" width="12" height="4" fill="var(--accent)" opacity=".42"/>',
      square_frames: '<rect x="23" y="31" width="13" height="8" fill="#e8fff0" opacity=".08" stroke="#0d2218" stroke-width="3"/><rect x="44" y="31" width="13" height="8" fill="#e8fff0" opacity=".08" stroke="#0d2218" stroke-width="3"/><rect x="36" y="34" width="8" height="2" fill="#0d2218"/>',
    }[p.eyewear] || "") : "";
    const pin = p ? ({
      party_star: '<path d="M58 66 L60 70 L65 70 L61 73 L63 78 L58 75 L53 78 L55 73 L51 70 L56 70 Z" fill="#ffd76a" stroke="#24180a" stroke-width="1"/>',
      victory_ribbon: '<rect x="55" y="65" width="7" height="6" fill="#f0eadc"/><path d="M56 71 L58 76 L61 71" fill="var(--party)"/>',
      flag_bar: '<rect x="54" y="66" width="11" height="4" fill="#f0eadc"/><rect x="54" y="66" width="4" height="4" fill="var(--party)"/><rect x="58" y="66" width="3" height="4" fill="var(--accent)"/><rect x="61" y="66" width="4" height="4" fill="#0a1610"/>',
      signal_chip: '<rect x="55" y="65" width="8" height="8" fill="#07140d" stroke="var(--party)" stroke-width="2"/><rect x="58" y="68" width="2" height="2" fill="var(--accent)"/>',
    }[p.pin] || "") : "";
    const expression = p?.expression || "neutral";
    const miniBrow = ({
      smile: '<rect x="26" y="29" width="10" height="2" fill="#09140d"/><rect x="44" y="29" width="10" height="2" fill="#09140d"/>',
      smirk: '<rect x="26" y="29" width="10" height="2" fill="#09140d"/><rect x="44" y="28" width="10" height="2" fill="#09140d"/>',
      angry: '<rect x="26" y="30" width="10" height="2" fill="#09140d" transform="rotate(-10 31 31)"/><rect x="44" y="30" width="10" height="2" fill="#09140d" transform="rotate(10 49 31)"/>',
      frown: '<rect x="26" y="28" width="10" height="2" fill="#09140d"/><rect x="44" y="28" width="10" height="2" fill="#09140d"/>',
      surprised: '<rect x="26" y="26" width="10" height="2" fill="#09140d"/><rect x="44" y="26" width="10" height="2" fill="#09140d"/>',
      neutral: '<rect x="26" y="29" width="10" height="2" fill="#09140d"/><rect x="44" y="29" width="10" height="2" fill="#09140d"/>',
    }[expression] || '<rect x="26" y="29" width="10" height="2" fill="#09140d"/><rect x="44" y="29" width="10" height="2" fill="#09140d"/>');
    const miniMouth = ({
      smile: '<path d="M34 46 Q40 51 46 46" fill="none" stroke="#94444b" stroke-width="3" stroke-linecap="square"/>',
      smirk: '<path d="M34 47 Q39 49 46 45" fill="none" stroke="#94444b" stroke-width="3" stroke-linecap="square"/>',
      angry: '<rect x="34" y="46" width="12" height="3" fill="#94444b"/>',
      frown: '<path d="M34 49 Q40 44 46 49" fill="none" stroke="#94444b" stroke-width="3" stroke-linecap="square"/>',
      surprised: '<rect x="37" y="44" width="6" height="7" rx="3" fill="#94444b"/>',
      neutral: '<rect x="34" y="46" width="12" height="3" fill="#94444b"/>',
    }[expression] || '<rect x="34" y="46" width="12" height="3" fill="#94444b"/>');
    return `
      <svg viewBox="0 0 80 96" aria-hidden="true">
        <rect x="8" y="8" width="64" height="80" fill="#f2fff7" opacity=".05" stroke="var(--party)" stroke-width="2"/>
        <rect x="16" y="56" width="48" height="24" fill="var(--suit)"/>
        <rect x="34" y="56" width="12" height="24" fill="var(--accent)" opacity=".78"/>
        <rect x="31" y="51" width="18" height="8" fill="var(--skin)"/>
        <rect x="20" y="20" width="40" height="32" fill="var(--skin)"/>
        ${hairBand}
        ${hat}
        ${miniBrow}
        <rect x="29" y="34" width="6" height="6" fill="#08140d"/>
        <rect x="45" y="34" width="6" height="6" fill="#08140d"/>
        <rect x="31" y="35" width="2" height="2" fill="#ffffff" opacity=".55"/>
        <rect x="47" y="35" width="2" height="2" fill="#ffffff" opacity=".55"/>
        ${eyewear}
        ${facial}
        ${miniMouth}
        ${pin}
        <rect x="14" y="74" width="52" height="5" fill="var(--party)"/>
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
    if (paused) hydrateSettingsControls();
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

  function updateSoundVolume(event) {
    reporterVolume = Math.max(0, Math.min(1, Number(reporterVolumeSlider?.value ?? 70) / 100));
    musicVolume = Math.max(0, Math.min(1, Number(musicVolumeSlider?.value ?? 70) / 100));
    sfxVolume = Math.max(0, Math.min(1, Number(sfxVolumeSlider?.value ?? 70) / 100));
    localStorage.setItem("riggedReporterVolume", String(Math.round(reporterVolume * 100)));
    localStorage.setItem("riggedMusicVolume", String(Math.round(musicVolume * 100)));
    localStorage.setItem("riggedSfxVolume", String(Math.round(sfxVolume * 100)));
    if (reporterVolumeValue) reporterVolumeValue.textContent = Math.round(reporterVolume * 100) + "%";
    if (musicVolumeValue) musicVolumeValue.textContent = Math.round(musicVolume * 100) + "%";
    if (sfxVolumeValue) sfxVolumeValue.textContent = Math.round(sfxVolume * 100) + "%";
    if (reporterGainNode && audioContext) {
      reporterGainNode.gain.cancelScheduledValues(audioContext.currentTime);
      reporterGainNode.gain.setTargetAtTime(soundOn ? reporterVolume : 0, audioContext.currentTime, 0.015);
    }
    updateBgmVolume();
    if (event?.target === sfxVolumeSlider && soundOn && performance.now() - sfxPreviewAt > 90) {
      sfxPreviewAt = performance.now();
      pipSfx("click");
    }
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
    tickCampaignStageEffects(true);
    newsTimer = Math.max(0, newsTimer - dt);
    tickWorldEvent(dt);
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
      player.disruptCooldown = Math.max(0, Number(player.disruptCooldown || 0) - dt);
      player.officeSlowCooldown = Math.max(0, Number(player.officeSlowCooldown || 0) - dt);
      player.officeInfluenceSlow = Math.max(0, Number(player.officeInfluenceSlow || 0) - dt);
      player.speechCooldown = Math.max(0, Number(player.speechCooldown || 0) - dt);
      if (player.speechCooldown <= 0) player.speechCooldownTotal = 0;
      player.emoteUntil = Math.max(0, Number(player.emoteUntil || 0) - dt);
      if (player.emoteUntil <= 0) {
        player.emoteId = "";
        player.emoteIcon = "";
      }
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

    if (elapsed >= currentMatchMode.seconds) finishElection();
  }

  function tickCampaignStageEffects(announce = true) {
    if (phase !== "play") return;
    const stage = campaignStage();
    if (stage === lastCampaignStage) return;
    lastCampaignStage = stage;
    refreshBgm(4.2);
    showCampaignStageSplash(stage);
    if (!announce) return;
    const info = CAMPAIGN_STAGE_INFO[stage] || CAMPAIGN_STAGE_INFO.early;
    if (stage === "early") {
      addAlert(info.name + ": Speeches give 2x influence in states with undecided votes.");
      broadcast(0, info.name + ": undecided states are extra receptive. Speeches there give 2x influence.");
    } else if (stage === "mid") {
      addAlert(info.name + ": Owned news channels suppress rival influence. Mid-size states pay extra cash to dominant parties.");
      broadcast(0, info.name + ": news channels now suppress rivals, and 10-20 EV states fund parties above 60% influence.");
    } else if (stage === "late") {
      addAlert(info.name + ": Small controlled states gain +2 EV. CA/TX/FL/NY can hold ghost influence up to 130% with L3 District Offices.");
      broadcast(0, info.name + ": small states can gain bonus electoral votes, and mega-states unlock ghost influence with L3 District Offices.");
    }
  }

  function showCampaignStageSplash(stage) {
    const info = CAMPAIGN_STAGE_INFO[stage];
    if (!info || !mapStage || matchOver) return;
    if (!stageSplashEl) {
      stageSplashEl = document.createElement("div");
      stageSplashEl.className = "campaign-stage-splash";
      stageSplashEl.setAttribute("aria-live", "polite");
      mapStage.appendChild(stageSplashEl);
    }
    stageSplashEl.className = "campaign-stage-splash is-on is-" + stage;
    stageSplashEl.innerHTML =
      '<div class="stage-splash-card">' +
        '<div class="stage-splash-image stage-splash-image-' + info.icon + '" aria-hidden="true">' +
          '<span class="stage-splash-sun"></span>' +
          '<span class="stage-splash-screen"></span>' +
          '<span class="stage-splash-ballot"></span>' +
        '</div>' +
        '<div class="stage-splash-copy">' +
          '<span>' + info.kicker + '</span>' +
          '<strong>' + info.name + '</strong>' +
          '<p>' + info.effect + '</p>' +
        '</div>' +
      '</div>';
    window.clearTimeout(stageSplashTimer);
    stageSplashTimer = window.setTimeout(() => {
      if (stageSplashEl) stageSplashEl.classList.remove("is-on");
    }, 2000);
  }

  // The host owns gameplay rules, but guests still advance visual-only timers
  // between snapshots so action icons and countdown effects cannot freeze.
  function updateGuestPresentation(dt) {
    elapsed += dt;
    tickCampaignStageEffects(false);
    newsTimer = Math.max(0, newsTimer - dt);
    worldEventTimer = Math.max(0, worldEventTimer - dt);
    if (activeWorldEvent && worldEventTimer <= 0) activeWorldEvent = null;
    tickClickbait(dt);
    players.forEach((player) => {
      if (!player) return;
      player.disruptCooldown = Math.max(0, Number(player.disruptCooldown || 0) - dt);
      player.officeSlowCooldown = Math.max(0, Number(player.officeSlowCooldown || 0) - dt);
      player.officeInfluenceSlow = Math.max(0, Number(player.officeInfluenceSlow || 0) - dt);
      player.speechCooldown = Math.max(0, Number(player.speechCooldown || 0) - dt);
      if (player.speechCooldown <= 0) player.speechCooldownTotal = 0;
      player.emoteUntil = Math.max(0, Number(player.emoteUntil || 0) - dt);
      if (player.emoteUntil <= 0) {
        player.emoteId = "";
        player.emoteIcon = "";
      }
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

  function chooseHomeBase(playerId, stateIndex, confirmed = false) {
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || player.homeBase >= 0 || phase !== "base") return false;
    if (playerId === HUMAN) {
      if (!confirmed) {
        pendingHomeBaseStateIndex = stateIndex;
        renderHomeBaseConfirmOverlay();
        return false;
      }
      pendingHomeBaseStateIndex = -1;
      renderHomeBaseConfirmOverlay();
      if (routeGuestGameCommand('chooseHomeBase', [stateIndex])) return true;
    }
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
    checkTalentDraftUnlocks(player);
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
    lastCampaignStage = "base";
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
    if (player.action.type === "speech" && !player.action.debateId) {
      const echoMult = hasTalent(player, "echo_chamber") ? 1.05 : 1;
      const modelPollingMult = hasTalent(player, "model_polling") && state.ev >= 10 ? 1.08 : 1;
      const hypeMult = player.action.hypeBoost || 1;
      const speechRateMult = player.action.speechRateMult || 1;
      const debateSpeechMult = player.action.debateId && hasTalent(player, "prime_time_rhetoric") ? 1.2 : 1;
      const frontRunnerSpeechMult = worldEventActive("martyrdom_cycle") ? 2 : 1;
      const peacefulStageMult = isEarlyStage() && leadingPlayer(state.index) < 0 ? 2 : 1;
      const siphonMult = 1;
      applyInfluenceGain(state, player.id, SPEECH_RATE * speechRateMult * player.speechBias * speechBoost * echoMult * modelPollingMult * hypeMult * debateSpeechMult * frontRunnerSpeechMult * peacefulStageMult, dt, true, siphonMult);
      state.activePulse = 1;
    }
    if (player.action.left <= 0) {
      const finishedType = player.action.type;
      if (finishedType === "speech" && player.action.debateId) {
        const debateId = player.action.debateId;
        const activeContenders = players.filter((candidate) => candidate.action?.debateId === debateId);
        if (activeContenders.every((candidate) => candidate.action.left <= 0)) {
          resolveDebateNight(debateId, state.index);
        }
        return;
      }
      if (finishedType === "speech" && hasTalent(player, "hype_train")) player.hypeNext = true;
      if (finishedType === "speech" && hasTalent(player, "great_awakening")) splashAdjacentInfluence(player, state.index, 3);
      addAlert(`${player.name} finished ${labelAction(finishedType)} in ${state.name}.`);
      player.action = null;
    }
  }

  function debateSpeechBonus(player, state, action = player?.action) {
    if (!player || !state) return 0;
    let bonus = ((Number(player.speechBias) || 1) - 1) * 25;
    if (hasTalent(player, "echo_chamber")) bonus += 5;
    if (hasTalent(player, "model_polling") && state.ev >= 10) bonus += 5;
    if ((action?.hypeBoost || 1) > 1) bonus += 8;
    if (hasTalent(player, "executive_immunity")) bonus += 5;
    if (channels.some((channel) => channel.owner === player.id && stateInChannelCoverage(state, channel))) bonus += 6;
    bonus += officeLevel(state, player.id) * 2;
    return bonus;
  }

  function debateScore(player, state) {
    if (!player || !state || !player.action?.debateId) return 0;
    return adjustedInfluence(state, player.id) * 0.3
      + player.mainBaseLevel * 8
      + debateSpeechBonus(player, state, player.action)
      + (Number(player.action.debateRoll) || 0);
  }

  function debateParticipantLimit() {
    return worldEventActive("debate_royale") ? 3 : 2;
  }

  function debateVictoryBonus() {
    return worldEventActive("debate_royale") ? WORLD_DEBATE_WIN_BONUS : DEBATE_WIN_BONUS;
  }

  function resolveDebateNight(debateId, stateIndex) {
    const state = states[stateIndex];
    if (!state) return;
    const contenders = players.filter((candidate) =>
      candidate.action &&
      candidate.action.type === "speech" &&
      candidate.action.debateId === debateId &&
      candidate.action.state === stateIndex
    );
    if (!contenders.length) return;

    contenders.forEach((candidate) => { candidate.action.debateScore = debateScore(candidate, state); });
    const ranked = contenders.slice().sort((a, b) => b.action.debateScore - a.action.debateScore);
    const winner = ranked[0];
    const loserNames = contenders.filter((candidate) => candidate.id !== winner.id).map((candidate) => candidate.name);
    const scoreSummary = ranked.map((candidate) => candidate.name + " " + Math.round(candidate.action.debateScore)).join("–");
    const gained = grantFlatStateInfluence(state, winner.id, debateVictoryBonus());
    latestDebateResultEvent = {
      id: ++debateResultEventCounter,
      winnerId: winner.id,
      contenderIds: contenders.map((candidate) => candidate.id),
      loserIds: contenders.filter((candidate) => candidate.id !== winner.id).map((candidate) => candidate.id),
      playAt: Date.now(),
    };
    lastPresentedDebateResultEventId = latestDebateResultEvent.id;
    presentDebateResultEvent(latestDebateResultEvent);

    contenders.forEach((candidate) => {
      if (hasTalent(candidate, "hype_train")) candidate.hypeNext = true;
      if (hasTalent(candidate, "great_awakening")) splashAdjacentInfluence(candidate, state.index, 3);
      candidate.speechCooldown = DEBATE_SPEECH_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS;
      candidate.speechCooldownTotal = candidate.speechCooldown;
      candidate.action = null;
    });
    state.activePulse = 1;
    const result = loserNames.length
      ? winner.name + " defeated " + loserNames.join(" and ")
      : winner.name + " won by forfeit";
    addAlert("DEBATE NIGHT: " + result + " in " + state.name + " (" + scoreSummary + ") and gained " + Math.round(gained) + "% influence.");
    broadcast(regionChannelIndex(state.region), "DEBATE NIGHT in " + state.name + ": " + winner.name + " won the stage and seized a " + Math.round(gained) + "% influence surge.");
    if (winner.id === HUMAN) showToast("DEBATE WON — +" + Math.round(gained) + "% influence in " + state.abbr + ".");
    if (contenders.some((candidate) => candidate.id === HUMAN) && winner.id !== HUMAN) {
      showToast("DEBATE LOST — " + winner.name + " won the stage in " + state.abbr + ".");
    }
  }

  function tickFunding(player, dt) {
    if (player.mainBaseLevel > 0) {
      player.cash += hqIncomeRate(player) * dt;
    }
    player.cash += (fundingPerDay(player) / CAMPAIGN_DAY_SECONDS) * dt;
    const policeUpkeep = totalPoliceUpkeepDay(player);
    if (policeUpkeep > 0) {
      player.cash -= policeUpkeepPerTick(player, dt);
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
    if (hasTalent(player, "listening_posts")) {
      states.forEach((state) => {
        const guardedBuildings = Number(policeGuards(state, player.id, "hq")) + Number(policeGuards(state, player.id, "office"));
        if (guardedBuildings <= 0) return;
        state.influence[player.id] = clampInfluenceForState(state, player.id, (state.influence[player.id] || 0)
          + POLICE_OUTREACH_INFLUENCE_DAY * guardedBuildings / CAMPAIGN_DAY_SECONDS * dt);
      });
    }
  }

  function tickPassive(player, dt) {
    states.forEach((state) => {
      const level = officeLevel(state, player.id);
      if (level > 0) {
        const slowMult = player.officeInfluenceSlow > 0 ? 0.5 : 1;
        applyInfluenceGain(state, player.id, level * AD_HUB_RATE * slowMult, dt, false);
        state.activePulse = 1;
      }
    });
    channels.forEach((channel) => {
      if (channel.owner !== player.id) return;
      states.forEach((state) => {
        if (stateInChannelCoverage(state, channel)) {
          const signalLeak = player.signalLeakBoost > 0 ? 1.25 : 1;
          const channelRate = (CHANNEL_INFLUENCE_RATE + state.ev * 0.0012)
            * (hasTalent(player, "fast_track_zoning") ? 1.25 : 1)
            * (hasTalent(player, "media_magnate") ? 1.4 : 1)
            * (hasTalent(player, "trend_engine") ? 1.15 : 1)
            * (worldEventActive("news_multiplier") ? 3 : 1)
            * signalLeak;
          applyInfluenceGain(state, player.id, channelRate, dt, false);
          if (isMidStage()) {
            players.forEach((rival) => {
              if (rival.id === player.id) return;
              const floor = influenceFloor(rival, state);
              const loss = MID_CHANNEL_SUPPRESSION_RATE * dt;
              if (adjustedInfluence(state, rival.id) > floor) {
                state.influence[rival.id] = clampInfluenceForState(state, rival.id, Math.max(floor, adjustedInfluence(state, rival.id) - loss));
              }
            });
          }
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
      if (nextLevel > player.mainBaseLevel) {
        if (player.id === HUMAN) showToast(`District Office upgrade paused: HQ Level ${nextLevel} required.`);
      } else if (officeLevel(state, player.id) < nextLevel) {
        state.offices[player.id] = nextLevel;
        state.activePulse = 1;
        addAlert(`${player.name} upgraded a District Office to Level ${nextLevel} in ${state.name}.`);
        if (worldEventActive("disaster_relief") && (activeWorldEvent.stateIndexes || []).includes(state.index)) {
          const bonus = grantFlatStateInfluence(state, player.id, 10);
          if (bonus > 0) addAlert(`${player.name} unlocked disaster relief in ${state.name} (+${Math.round(bonus)}% influence).`);
        }
        if (hasTalent(player, "cascade_effect")) splashAdjacentInfluence(player, state.index, 5);
        if (player.id === HUMAN) showToast(`District Office upgrade complete: ${state.abbr} is now Level ${nextLevel}.`);
      }
      return;
    }
    if (mission.type === "baseUpgrade") {
      player.mainBaseLevel = mission.level;
      state.activePulse = 1;
      addAlert(`${player.name} completed Main Base upgrade to Level ${mission.level} in ${state.name}.`);
      if (player.id === HUMAN) showToast(`HQ upgrade complete: Level ${mission.level} online.`);
      checkTalentDraftUnlocks(player);
      return;
    }
    if (mission.type === "sabotage") {
      completeSabotageOperation(mission);
      return;
    }
    if (mission.type === "disrupt") {
      completeDisruptOperation(mission);
      return;
    }
    if (mission.type === "riot") {
      completeRiotOperation(mission);
      return;
    }
  }

  function completeRiotOperation(mission) {
    const player = players[mission.player];
    const state = states[mission.state];
    if (!player || !state) return;
    const target = players[mission.target];
    if (!target) return;
    if (policeGuards(states[mission.state], target.id, "office")) {
        if (target.cash >= POLICE_RIOT_BLOCK_COST) {
          target.cash -= POLICE_RIOT_BLOCK_COST;
          addAlert(player.name + "'s riot in " + state.name + " was suppressed by " + target.name + "'s police for " + formatMoney(POLICE_RIOT_BLOCK_COST) + ".");
          if (player.id === HUMAN) showToast("Riot blocked: " + target.name + " paid police " + formatMoney(POLICE_RIOT_BLOCK_COST) + ".");
          if (target.id === HUMAN) showToast("Police response complete: riot blocked in " + state.abbr + " for " + formatMoney(POLICE_RIOT_BLOCK_COST) + ".");
          return;
        }
        setPoliceGuard(states[mission.state], target.id, "office", false);
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
          if (hasTalent(candidate, "backlash_cells")) {
            state.cashFreeze[player.id] = Math.max(state.cashFreeze[player.id] || 0, 3 * CAMPAIGN_DAY_SECONDS);
            addAlert(candidate.name + "'s backlash cells froze " + player.name + "'s cash flow in " + state.name + " for 3 days.");
          }
        });
        state.activePulse = 1;
        addAlert(player.name + "'s riot hit " + state.name + ": " + results.join("; ") + ".");
        if (player.id === HUMAN) showToast("Riot landed in " + state.abbr + ": " + results.join("; ") + ".");
        broadcast(regionChannelIndex(state.region), "Violent unrest in " + state.name + " battered rival campaign outposts, knocking weaker bases offline and downgrading the rest.");
    } else if (player.id === HUMAN) {
      showToast("Riot landed in " + state.abbr + ": no rival District Office remained.");
    }
  }

  function completeDisruptOperation(mission) {
    const player = players[mission.player];
    const state = states[mission.state];
    if (!player || !state) return;
    const targets = (mission.targets || [mission.target])
      .map((targetId) => players[targetId])
      .filter((target) =>
        target &&
        target.id !== player.id &&
        (officeLevel(state, target.id) > 0 || target.homeBase === state.index)
      );
    if (!targets.length) return;

    const results = [];
    let totalStolen = 0;
    targets.forEach((target) => {
      const policeBypassed = hasTalent(player, "signal_scrambler");
      const hqPoliceProtected = target.homeBase === state.index && policeGuards(state, target.id, "hq") && !policeBypassed;
      const protectedTreasury = hqPoliceProtected || (hasTalent(target, "iron_curtain") && target.homeBase === state.index && target.mainBaseLevel >= 3);
      if (protectedTreasury) {
        results.push(target.name + (hqPoliceProtected ? " HQ police protected treasury" : " treasury protected"));
      } else {
        const stealAmount = Math.round(DISRUPT_STEAL_PER_PARTY * (hasTalent(player, "hostile_liquidation") ? 1.5 : 1));
        const stolen = Math.min(target.cash, stealAmount);
        target.cash -= stolen;
        player.cash += stolen;
        totalStolen += stolen;
        results.push("stole " + formatMoney(stolen) + " from " + target.name);
        if (target.id === HUMAN) showToast("DISRUPT stole " + formatMoney(stolen) + " from your treasury in " + state.abbr + ".");
      }

      if (worldEventActive("disrupt_siphon")) {
        const floor = influenceFloor(target, state);
        const siphoned = Math.min(5, Math.max(0, adjustedInfluence(state, target.id) - floor));
        if (siphoned > 0) {
          state.influence[target.id] = clampInfluenceForState(state, target.id, adjustedInfluence(state, target.id) - siphoned);
          state.influence[player.id] = clampInfluenceForState(state, player.id, adjustedInfluence(state, player.id) + siphoned);
          results.push("stole " + Math.round(siphoned) + "% influence from " + target.name);
        }
      }

      if (hasTalent(player, "backdoor_exploits")) {
        const officeUpgradeMission = missions.find((candidate) =>
          candidate.type === "officeUpgrade" && candidate.state === state.index && candidate.player === target.id
        );
        if (officeUpgradeMission) {
          missions = missions.filter((candidate) => candidate !== officeUpgradeMission);
          results.push(target.name + " District Office upgrade canceled");
          if (target.id === HUMAN) showToast("Your District Office upgrade in " + state.abbr + " was canceled by DISRUPT.");
        }
      }

      if (target.homeBase === state.index && !hqPoliceProtected) {
        const baseUpgrades = missions.filter((candidate) => candidate.type === "baseUpgrade" && candidate.player === target.id);
        if (baseUpgrades.length) {
          const delayDays = sabotageFreezeDays(player);
          baseUpgrades.forEach((candidate) => { candidate.left += delayDays * CAMPAIGN_DAY_SECONDS; });
          results.push(target.name + " HQ upgrade delayed " + delayDays + "d");
          if (target.id === HUMAN) showToast("Your HQ upgrade was delayed " + delayDays + " day(s) by DISRUPT.");
        }
      }

      const level = officeLevel(state, target.id);
      if (level <= 0) return;
      const damageLevels = hasTalent(player, "double_demolition") ? 2 : 1;
      const policeBlockCost = POLICE_RIOT_BLOCK_COST * (hasTalent(player, "double_demolition") ? 2 : 1);
      if (policeGuards(state, target.id, "office") && !policeBypassed) {
        if (target.cash >= policeBlockCost) {
          target.cash -= policeBlockCost;
          results.push(target.name + " police blocked office destruction");
          if (target.id === HUMAN) showToast("Police protected your District Office in " + state.abbr + " for " + formatMoney(policeBlockCost) + ".");
          return;
        }
        setPoliceGuard(state, target.id, "office", false);
        results.push(target.name + " police withdrew (response unpaid)");
        if (target.id === HUMAN) showToast("Police could not fund the DISRUPT response in " + state.abbr + " and withdrew.");
      }

      const remainingLevel = Math.max(0, level - damageLevels);
      if (remainingLevel <= 0) {
        state.offices[target.id] = 0;
        results.push(target.name + " L" + level + " office destroyed");
      } else {
        state.offices[target.id] = remainingLevel;
        results.push(target.name + " office reduced to L" + remainingLevel);
      }
      if (hasTalent(target, "backlash_cells")) {
        state.cashFreeze[player.id] = Math.max(state.cashFreeze[player.id] || 0, 3 * CAMPAIGN_DAY_SECONDS);
        results.push(target.name + " froze attacker cash flow for 3d");
      }
    });

    if (hasTalent(player, "signal_leak")) {
      player.signalLeakBoost = Math.max(player.signalLeakBoost || 0, CAMPAIGN_DAY_SECONDS);
      results.push("Broadcast Surge active for 1d");
    }
    state.activePulse = 1;
    actionEffects.push({ type: "sabotage", player: player.id, target: targets[0].id, state: state.index, left: 1.8, total: 1.8 });
    addAlert(player.name + " completed a state-wide DISRUPT in " + state.name + ": " + results.join("; ") + ".");
    if (player.id === HUMAN) showToast("DISRUPT landed in " + state.abbr + ": stole " + formatMoney(totalStolen) + " total.");
    triggerClickbait("BACKDOOR_HACK", {
      player: player.id,
      target: targets[0].id,
      state: state.index,
      stateName: state.name,
      factionName: player.name,
      opponentName: targets.map((target) => target.name).join(", "),
      cashValue: totalStolen,
    });
  }

  function tickActionEffects(dt) {
    actionEffects.forEach((effect) => { effect.left -= dt; });
    actionEffects = actionEffects.filter((effect) => effect.left > 0);
  }

  function applyInfluenceGain(state, playerId, rate, dt, canSiphon, siphonMult = 1) {
    const efficiency = influenceEfficiency(adjustedInfluence(state, playerId));
    const amount = rate * efficiency * dt;
    const current = adjustedInfluence(state, playerId);
    const cap = influenceCap(state, playerId);
    const undecided = undecidedInfluence(state);
    if (undecided > 0 && current < cap) {
      state.influence[playerId] = clampInfluenceForState(state, playerId, current + Math.min(amount, undecided, cap - current));
      return;
    }
    if (!canSiphon) return;
    const target = strongestRivalByInfluence(playerId, state);
    if (!target) return;
    const floor = influenceFloor(target, state);
    const siphon = Math.min(SPEECH_RIVAL_RATE * efficiency * dt * siphonMult, Math.max(0, state.influence[target.id] - floor), Math.max(0, cap - current));
    state.influence[target.id] = clampInfluenceForState(state, target.id, Math.max(floor, state.influence[target.id] - siphon));
    state.influence[playerId] = clampInfluenceForState(state, playerId, state.influence[playerId] + siphon);
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
      state.influence[player.id] = clampInfluenceForState(state, player.id, state.influence[player.id] + Math.min(amount, room, Math.max(0, influenceCap(state, player.id) - adjustedInfluence(state, player.id))));
      state.activePulse = 1;
    });
    if (nearby.length) addAlert(player.name + "'s Rally Ripple spilled into " + nearby.map((state) => state.abbr).join(", ") + ".");
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

  function aiEarlyEconomyAction(player, rules, commit) {
    const day = campaignDaysElapsed();
    if (day >= 20) return false;
    const homeState = states[player.homeBase];
    const hqUpgradePending = missions.some((mission) => mission.type === "baseUpgrade" && mission.player === player.id);
    const offices = states.filter((state) => officeLevel(state, player.id) > 0);

    if (player.mainBaseLevel < 2 && !hqUpgradePending && homeState) {
      const nextLevel = player.mainBaseLevel + 1;
      const requirement = HQ_UPGRADE[nextLevel];
      const requiredInfluence = Math.ceil((requirement?.infl || 0) * (hasTalent(player, "system_overclock") ? 0.8 : 1));
      if (adjustedInfluence(homeState, player.id) < requiredInfluence && !activeSpeechInState(homeState.index)) {
        return commit("economy_home_speech", () => startAction(player.id, "speech", homeState.index), 0.4);
      }
      if (player.cash >= mainBaseUpgradeCash(player, nextLevel)) {
        return commit("economy_hq_upgrade", () => upgradeMainBase(player.id), 0.8);
      }
    }

    const aggressiveDeployTarget = bestAiOfficeDeployTarget(player);
    if (aggressiveDeployTarget && player.cash >= adHubCost(player)) {
      return commit("economy_office_deploy", () => placeAdHub(player.id, aggressiveDeployTarget.index), 0.2);
    }

    const upgradeTarget = offices
      .map((state) => {
        const level = officeLevel(state, player.id);
        const req = level < MINI_BASE_MAX_LEVEL && level + 1 <= player.mainBaseLevel ? miniBaseUpgradeReq(player, level + 1) : null;
        if (!req || missions.some((mission) => mission.type === "officeUpgrade" && mission.player === player.id && mission.state === state.index)) return null;
        if (adjustedInfluence(state, player.id) < req.infl || player.cash < req.cash + 5000) return null;
        return { state, req, score: state.ev + level * 12 + adjustedInfluence(state, player.id) * 0.25 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0];
    if (upgradeTarget) {
      return commit("economy_office_upgrade", () => upgradeMiniBase(player.id, upgradeTarget.state.index), 0.55);
    }

    const influenceFarmState = offices
      .filter((state) => officeLevel(state, player.id) < MINI_BASE_MAX_LEVEL && !activeSpeechInState(state.index))
      .map((state) => {
        const nextLevel = officeLevel(state, player.id) + 1;
        const req = nextLevel <= player.mainBaseLevel ? miniBaseUpgradeReq(player, nextLevel) : null;
        return { state, missing: Math.max(0, (req?.infl || 0) - adjustedInfluence(state, player.id)) };
      })
      .filter((entry) => entry.missing > 0)
      .sort((a, b) => b.missing - a.missing || b.state.ev - a.state.ev)[0]?.state;
    if (influenceFarmState) {
      return commit("economy_office_speech", () => startAction(player.id, "speech", influenceFarmState.index), 0.35);
    }

    player.aiDelay = Math.max(1, rules.delay * 0.55) + Math.random();
    return true;
  }

  function bestAiOfficeDeployTarget(player) {
    if (!player || !canBuildMoreDistrictOffices(player)) return null;
    return states
      .filter((state) =>
        officeLevel(state, player.id) <= 0 &&
        !missions.some((mission) => mission.type === "adDeploy" && mission.player === player.id && mission.state === state.index)
      )
      .map((state) => ({
        state,
        score: adjustedInfluence(state, player.id) * 0.55
          + state.ev * 0.45
          + (state.index === player.homeBase ? 30 : 0)
          + (leadingPlayer(state.index) !== player.id ? 10 : 0)
          + Math.random() * 3,
      }))
      .sort((a, b) => b.score - a.score)[0]?.state || null;
  }

  function tickAi(player, dt) {
    pipMaybePick(player);
    player.aiDelay -= dt;
    player.insetDelay -= dt;
    if (player.locked > 0 || player.action || player.aiDelay > 0) return;
    const baseRules = AI_RULES[difficultyInput.value];
    const campaignDay = campaignDaysElapsed();
    const strategicReserve = campaignDay < 20 ? 12000 : campaignDay < 70 ? 8000 : baseRules.reserve;
    const rules = { ...baseRules, reserve: Math.max(baseRules.reserve, strategicReserve) };
    const maxActions = campaignDay < 20 ? 3 : 2;
    let actionsTaken = 0;
    let maxDelayBonus = 0;
    const commit = (action, perform, delayBonus = 0) => {
      if (!perform()) return false;
      player.aiActionCounts = player.aiActionCounts || {};
      player.aiActionCounts[action] = (player.aiActionCounts[action] || 0) + 1;
      player.aiLastAction = action;
      actionsTaken += 1;
      maxDelayBonus = Math.max(maxDelayBonus, delayBonus);
      return true;
    };
    const shouldEndPass = () => !!player.action || actionsTaken >= maxActions;
    const finishPass = () => {
      player.aiDelay = rules.delay + maxDelayBonus + Math.random() * 1.5;
    };

    if (aiEarlyEconomyAction(player, rules, commit) && shouldEndPass()) {
      finishPass();
      return;
    }

    const officeDeployTarget = bestAiOfficeDeployTarget(player);
    if (officeDeployTarget && player.cash >= adHubCost(player)) {
      if (commit("office_deploy_chain", () => placeAdHub(player.id, officeDeployTarget.index), 0.15) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    const guardedBuildings = states.flatMap((state) => ["hq", "office"]
      .filter((building) => policeGuards(state, player.id, building))
      .map((building) => ({ state, building })));
    if (guardedBuildings.length && (player.cash < totalPoliceUpkeepDay(player) || projectedCashPerDay(player) < 0)) {
      const weakestGuard = guardedBuildings.sort((a, b) => policeUpkeepDay(player, b.state, b.building) - policeUpkeepDay(player, a.state, a.building))[0];
      if (commit("police_removed", () => togglePolice(player.id, weakestGuard.state.index, weakestGuard.building)) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    if (player.mainBaseLevel >= 1 && player.mainBaseLevel < 3 && Math.random() < rules.hq) {
      if (commit("hq_upgrade", () => upgradeMainBase(player.id), 1) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    const speakingRivals = players.filter((candidate) => candidate.id !== player.id && isSpeaking(candidate) && canInterruptAction(candidate));
    const speakingRival = speakingRivals.sort((a, b) => adjustedInfluence(states[b.action.state], b.id) - adjustedInfluence(states[a.action.state], a.id))[0];
    const repeatRisk = assassinatedToday(player) ? 0.18 : 1;
    const assassinTalentBoost = hasTalent(player, "retributive_strike") ? 1.45 : 1;
    if (speakingRival && player.cash >= assassinateCost(player, speakingRival) + rules.reserve && Math.random() < rules.assassinate * repeatRisk * assassinTalentBoost) {
      const visibleSpeechStates = [speakingRival.action.state, ...(speakingRival.action.decoyStates || [])];
      const assassinationState = visibleSpeechStates[Math.floor(Math.random() * visibleSpeechStates.length)];
      if (commit("assassinate", () => assassinate(player.id, assassinationState), 1.5) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    const channelIndex = bestChannelForPlayer(player.id);
    if (channelIndex >= 0 && player.cash >= channelTakeoverCost(player.id, channels[channelIndex]) + rules.reserve && Math.random() < rules.channel) {
      if (commit("news_channel", () => buyChannel(player.id, channelIndex), 0.5) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    if ((player.officeSlowCooldown || 0) <= 0 && player.cash >= OFFICE_SLOW_COST + rules.reserve) {
      const officeSlowTargets = players
        .filter((candidate) => candidate.id !== player.id && districtOfficeCount(candidate.id) > 0 && (candidate.officeInfluenceSlow || 0) <= 0)
        .map((candidate) => ({
          player: candidate,
          score: districtOfficeCount(candidate.id) * 8 + electoralVotes(candidate.id) * 0.35 + projectedCashPerDay(candidate) * 0.001 + Math.random() * 5,
        }))
        .sort((a, b) => b.score - a.score);
      if (officeSlowTargets.length && Math.random() < 0.08) {
        if (commit("district_jam", () => slowDistrictOffices(player.id, officeSlowTargets[0].player.id), 1) && shouldEndPass()) {
          finishPass();
          return;
        }
      }
    }

    const policeTargets = states
      .flatMap((state) => [
        ...(player.homeBase === state.index && !policeGuards(state, player.id, "hq") ? [{ state, building: "hq" }] : []),
        ...(officeLevel(state, player.id) > 0 && !policeGuards(state, player.id, "office") ? [{ state, building: "office" }] : []),
      ])
      .filter((target) => player.cash >= policeUpkeepDay(player, target.state, target.building) + rules.reserve)
      .map((target) => ({
        ...target,
        score: target.state.ev + officeLevel(target.state, player.id) * 5 + (target.building === "hq" ? 18 : 0)
          + (player.action?.type === "speech" && player.action.state === target.state.index ? 30 : 0),
      }))
      .sort((a, b) => b.score - a.score);
    if (guardedBuildings.length < rules.maxPolice && policeTargets.length && Math.random() < rules.police) {
      if (commit("police_deployed", () => togglePolice(player.id, policeTargets[0].state.index, policeTargets[0].building)) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    if ((player.disruptCooldown || 0) <= 0 && canStartDisruptionOp(player, player.id)) {
      const disruptTargets = states
        .map((state) => {
          const targets = disruptTargetsForState(player.id, state);
          if (!targets.length) return null;
          const cost = disruptCost(player, targets);
          return {
            state,
            targets,
            cost,
            score: state.ev * 1.5 + targets.length * 12 + targets.reduce((sum, target) =>
              sum + officeLevel(state, target.id) * 6 + (target.homeBase === state.index ? 10 : 0), 0
            ) + Math.random() * 6,
          };
        })
        .filter((entry) => entry && player.cash >= entry.cost + rules.reserve)
        .sort((a, b) => b.score - a.score);
      const disruptTalentBoost = (hasTalent(player, "ghost_servers") ? 0.12 : 0) + (hasTalent(player, "general_strike") ? 0.06 : 0);
      if (disruptTargets.length && Math.random() < rules.disrupt + disruptTalentBoost) {
        if (commit("disrupt", () => disrupt(player.id, disruptTargets[0].state.index), 1) && shouldEndPass()) {
          finishPass();
          return;
        }
      }
    }

    const powerGrabTargets = states
      .filter((state) => adjustedInfluence(state, player.id) < 90)
      .map((state) => ({
        state,
        cost: powerGrabCost(player, state),
        score: state.ev * 1.8 + (leadingPlayer(state.index) !== player.id ? 10 : 0) + (1 - stateShare(state, player.id)) * 12 + Math.random() * 5,
      }))
      .filter((entry) => player.cash >= entry.cost + rules.reserve)
      .sort((a, b) => b.score - a.score);
    const powerGrabTalentBoost = (hasTalent(player, "decentralized_hive") ? 0.12 : 0) + (hasTalent(player, "strike_fund") ? 0.08 : 0);
    if (powerGrabTargets.length && Math.random() < rules.powerGrab + powerGrabTalentBoost) {
      if (commit("power_grab", () => powerGrab(player.id, powerGrabTargets[0].state.index), 1.2) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    const stateIndex = player.insetDelay <= 0 ? chooseAiInsetState(player.id) : chooseAiState(player.id);
    if (player.insetDelay <= 0) player.insetDelay = 24 + Math.random() * 18;

    const upgradeTargets = states
      .map((state) => {
        const level = officeLevel(state, player.id);
        const req = level > 0 && level < MINI_BASE_MAX_LEVEL && level + 1 <= player.mainBaseLevel ? miniBaseUpgradeReq(player, level + 1) : null;
        if (!req || missions.some((mission) => mission.type === "officeUpgrade" && mission.player === player.id && mission.state === state.index)) return null;
        if (player.cash < req.cash || adjustedInfluence(state, player.id) < req.infl) return null;
        return { state, score: state.ev + adjustedInfluence(state, player.id) * 0.2 + level * 8 + Math.random() * 5 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (upgradeTargets.length && Math.random() < 0.38) {
      if (commit("office_upgrade", () => upgradeMiniBase(player.id, upgradeTargets[0].state.index), 0.8) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    const targetState = states[stateIndex];
    const officeLvl = officeLevel(targetState, player.id);
    const deployPending = missions.some((mission) => mission.type === "adDeploy" && mission.player === player.id && mission.state === stateIndex);
    if (canBuildMoreDistrictOffices(player) && officeLvl < 1 && !deployPending && player.cash >= adHubCost(player) && Math.random() < rules.office) {
      if (commit("office_deploy", () => placeAdHub(player.id, stateIndex), 0.6) && shouldEndPass()) {
        finishPass();
        return;
      }
    }

    const nextHqLevel = Math.min(3, player.mainBaseLevel + 1);
    const nextHqRequirement = HQ_UPGRADE[nextHqLevel]?.infl || 0;
    const needsHomeInfluence = player.mainBaseLevel < 3 && adjustedInfluence(states[player.homeBase], player.id) < nextHqRequirement;
    const preferredSpeechState = needsHomeInfluence && Math.random() < 0.65 ? player.homeBase : stateIndex;
    const debateState = states
      .filter((state) => realSpeechesInState(state.index).some((candidate) => candidate.id !== player.id) && realSpeechesInState(state.index).length === 1)
      .sort((a, b) => b.ev - a.ev)[0];
    const speechState = debateState && Math.random() < 0.32
      ? debateState
      : [states[preferredSpeechState], ...states]
        .filter(Boolean)
        .find((state, index, list) => list.findIndex((candidate) => candidate.index === state.index) === index && !activeSpeechInState(state.index));
    if (speechState && commit("speech", () => startAction(player.id, "speech", speechState.index)) && shouldEndPass()) {
      finishPass();
      return;
    }

    if (officeLvl > 0 && officeLvl < MINI_BASE_MAX_LEVEL && officeLvl + 1 <= player.mainBaseLevel) {
      if (commit("office_upgrade", () => upgradeMiniBase(player.id, stateIndex)) && shouldEndPass()) {
        finishPass();
        return;
      }
    }
    player.aiDelay = actionsTaken > 0
      ? rules.delay + maxDelayBonus + Math.random() * 1.5
      : Math.max(1, rules.delay * 0.5) + Math.random();
  }

  function activeSpeechInState(stateIndex) {
    return players.find((candidate) =>
      candidate.action &&
      candidate.action.type === "speech" &&
      (candidate.action.state === stateIndex || (candidate.action.decoyStates || []).includes(stateIndex))
    ) || null;
  }

  function realSpeechesInState(stateIndex) {
    return players.filter((candidate) =>
      candidate.action &&
      candidate.action.type === "speech" &&
      candidate.action.state === stateIndex
    );
  }

  function assassinatedToday(player) {
    return !!player &&
      player.assassinDay === Math.floor(campaignDaysElapsed()) &&
      (player.assassinationsToday || 0) > 0;
  }

  function chooseSpeechDecoyStates(realStateIndex, count = 3) {
    const candidates = states.filter((candidate) =>
      candidate.index !== realStateIndex &&
      !activeSpeechInState(candidate.index)
    );
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
    }
    return candidates.slice(0, count).map((candidate) => candidate.index);
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
    const executiveSpeech = type === "speech" && hasTalent(player, "executive_immunity");
    const times = { speech: SPEECH_SECONDS * (executiveSpeech ? 0.5 : 1) };
    const costs = { speech: 0 };
    if (!times[type]) {
      if (playerId === HUMAN) showToast("Choose a campaign action.");
      return false;
    }
    const liveSpeakers = type === "speech" ? realSpeechesInState(stateIndex) : [];
    const debateOpponent = liveSpeakers.find((candidate) => candidate.id !== playerId) || null;
    if (type === "speech") {
      if (worldEventActive("martyrdom_cycle") && leadingPlayer(stateIndex) === playerId) {
        if (playerId === HUMAN) showToast("WORLD EVENT: You cannot speech in a state you already lead.");
        return false;
      }
      if ((player.speechCooldown || 0) > 0) {
        if (playerId === HUMAN) showToast(`SPEECH cooldown: ${campaignDaysLabel(player.speechCooldown)} remaining.`);
        return false;
      }
      if (liveSpeakers.length >= debateParticipantLimit()) {
        if (playerId === HUMAN) showToast(`${state.abbr} already has a full Debate Night.`);
        return false;
      }
    }
    if (player.cash < costs[type]) {
      if (playerId === HUMAN) showToast(`Need ${formatMoney(costs[type])}.`);
      return false;
    }
    player.cash -= costs[type];
    const vulnerableLeft = type === "speech" ? times[type] : undefined;
    const hypeBoost = type === "speech" && player.hypeNext ? 1.4 : 1;
    const speechRateMult = executiveSpeech ? 4 : 1;
    if (type === "speech") player.hypeNext = false;
    const decoyStates = type === "speech" && !debateOpponent && hasTalent(player, "skynet_protocol")
      ? chooseSpeechDecoyStates(stateIndex, 3)
      : [];
    player.action = { type, state: stateIndex, decoyStates, left: times[type], total: times[type], vulnerableLeft, hypeBoost, speechRateMult };
    if (type === "speech") {
      player.speechCooldown = SPEECH_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS;
      player.speechCooldownTotal = player.speechCooldown;
    }
    state.activePulse = 1;
    if (type === "speech" && debateOpponent) {
      const debateId = debateOpponent.action?.debateId || "debate-" + Math.round(elapsed * 1000) + "-" + debateOpponent.id + "-" + player.id;
      const contenders = [...liveSpeakers.filter((candidate) => candidate.id !== player.id), player];
      contenders.forEach((candidate) => {
        candidate.action.debateId = debateId;
        candidate.action.debateRoll = Number(candidate.action.debateRoll ?? (Math.random() * 20));
        candidate.action.decoyStates = [];
        candidate.action.left = DEBATE_SECONDS;
        candidate.action.total = DEBATE_SECONDS;
        candidate.action.vulnerableLeft = DEBATE_SECONDS;
        candidate.action.speechRateMult = (SPEECH_SECONDS / DEBATE_SECONDS) * (hasTalent(candidate, "executive_immunity") ? 2 : 1);
      });
      debateEventCounter = Math.max(debateEventCounter, Number(latestDebateEvent?.id || 0)) + 1;
      latestDebateEvent = { id: debateEventCounter, playAt: Date.now() };
      lastPresentedDebateEventId = latestDebateEvent.id;
      presentDebateEvent(latestDebateEvent);
      addAlert("DEBATE NIGHT: " + player.name + " challenged " + debateOpponent.name + " in " + state.name + ". Winner earns a +" + debateVictoryBonus() + "% influence surge.");
      broadcast(regionChannelIndex(state.region), "DEBATE NIGHT is live in " + state.name + ": " + contenders.map((candidate) => candidate.name).join(" versus ") + ".");
      if (playerId === HUMAN) showToast("DEBATE NIGHT — beat " + debateOpponent.name + " for +" + debateVictoryBonus() + "% influence.");
    } else {
      addAlert(`${player.name} started ${labelAction(type)} in ${state.name}.`);
    }
    if (type === "speech") {
      triggerClickbait("MINDSHARE_CAST", {
        player: playerId,
        state: stateIndex,
        stateName: state.name,
        factionName: player.name,
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
    if (!canBuildMoreDistrictOffices(player)) {
      if (playerId === HUMAN) showToast(`District Office limit reached: ${districtOfficeCount(playerId) + pendingDistrictOfficeCount(playerId)}/${districtOfficeCap(player)}. Upgrade HQ to build more.`);
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
        state.influence[playerId] = clampInfluenceForState(state, playerId, (state.influence[playerId] || 0) + gain);
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
    if (nextLevel > player.mainBaseLevel) {
      if (playerId === HUMAN) showToast(`Upgrade HQ to Level ${nextLevel} before upgrading this District Office.`);
      return false;
    }
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
    presentBroadcast(channelIndex, regionalReport(channelIndex));
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
    if (previousOwner && !(channel.formerOwners || []).includes(previousOwner.id)) {
      channel.formerOwners = [...(channel.formerOwners || []), previousOwner.id];
    }
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
    return Math.round(CHANNEL_COST * (protectedTakeover ? 2 : 1) * mediaRetainer);
  }

  function bestChannelForPlayer(playerId) {
    const player = players[playerId];
    const available = channels.filter((channel) => channel.owner !== playerId);
    if (!available.length) return -1;
    const byRegion = available.find((channel) => channel.coverage.includes(states[player.homeBase]?.abbr || ""));
    if (byRegion) return byRegion.index;
    return available
      .map((channel) => ({
        index: channel.index,
        score: states
          .filter((state) => stateInChannelCoverage(state, channel))
          .reduce((sum, state) => sum + state.ev * (1 - stateShare(state, playerId)), 0),
      }))
      .sort((a, b) => b.score - a.score)[0].index;
  }

  function broadcast(channelIndex, subtitle, options = {}) {
    const worldReport = activeWorldEventReport();
    const reportIsActive = !!worldReport && options.worldEvent !== true;
    const finalSubtitle = reportIsActive ? worldReport : subtitle;
    const finalWorldEvent = options.worldEvent === true || reportIsActive;
    latestBroadcastEvent = { id: ++broadcastEventCounter, channelIndex, subtitle: finalSubtitle, worldEvent: finalWorldEvent };
    lastPresentedBroadcastEventId = latestBroadcastEvent.id;
    presentBroadcast(channelIndex, finalSubtitle, { ...options, worldEvent: finalWorldEvent });
  }

  function presentBroadcast(channelIndex, subtitle, options = {}) {
    activeChannel = channelIndex;
    const channel = channels[channelIndex] || CHANNELS[channelIndex] || CHANNELS[0];
    const owner = channel.owner >= 0 ? players[channel.owner] : null;
    const worldReport = activeWorldEventReport();
    const finalSubtitle = worldReport || subtitle;
    const finalWorldEvent = options.worldEvent === true || !!worldReport;
    newsPanel.dataset.channel = channel.id;
    newsPanel.classList.toggle("is-world-event", finalWorldEvent);
    newsChannelName.textContent = owner ? `${channel.name} - ${owner.name}` : channel.name;
    newsChannelName.style.color = owner ? owner.color : "";
    newsReporter.textContent = owner ? `${channel.reporter} for ${owner.name}` : channel.reporter;
    newsSubtitle.textContent = finalSubtitle;
    speakReporter(finalSubtitle);
  }

  function activeWorldEventReport() {
    return news?.isWorldEvent === true && newsTimer > 0 ? `${news.title}: ${news.text}` : "";
  }

  function toggleNewsSound() {
    const inMainMenu = !gameStarted || !mainMenu?.classList.contains("is-hidden");
    setSoundEnabled(!soundOn, { announce: !inMainMenu });
  }

  function syncSoundButtons() {
    document.querySelectorAll(".sound-toggle").forEach((button) => {
      const lobbyLabel = button.querySelector(".lobby-sound-label");
      if (lobbyLabel) lobbyLabel.textContent = soundOn ? "Sound // On" : "Sound // Off";
      else if (button.classList.contains("sound-icon-toggle")) {
        button.innerHTML = '<span aria-hidden="true">♪</span>';
        button.title = soundOn ? "Sound on — click to mute" : "Sound off — click to enable";
      } else button.textContent = soundOn ? "Sound On" : "Sound Off";
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
      if (reporterGainNode && audioContext) reporterGainNode.gain.setTargetAtTime(reporterVolume, audioContext.currentTime, 0.02);
      ensureBgm();
      transitionBgm(selectBgmTrack(), options.fade || 1.2);
      if (options.announce !== false) speakReporter(newsSubtitle.textContent || "Live from the campaign desk.");
    } else {
      if (reporterGainNode && audioContext) reporterGainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.02);
      stopBgm(options.fade || 1.2);
    }
  }

  function ensureAudio() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (!reporterGainNode) {
      reporterGainNode = audioContext.createGain();
      reporterGainNode.gain.value = soundOn ? reporterVolume : 0;
      reporterGainNode.connect(audioContext.destination);
    }
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

  function bgmTrackForCampaignStage(stage = campaignStage()) {
    if (stage === "late") return "end1";
    if (stage === "mid") return "mid1";
    return "early";
  }

  function selectBgmTrack() {
    if (matchOver) return resultBgm || currentBgm || "menu";
    if (!gameStarted || mainMenu?.classList.contains("is-hidden") === false) return "menu";
    if (phase === "base") return "early";
    return bgmTrackForCampaignStage();
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

  function refreshBgm(fadeSeconds = BGM_FADE_SECONDS) {
    if (!soundOn) return;
    transitionBgm(selectBgmTrack(), fadeSeconds);
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
      gain.gain.linearRampToValueAtTime(voice.volume, t + 0.007);
      gain.gain.exponentialRampToValueAtTime(0.0006, t + voice.speed * 0.92);
      osc.connect(gain);
      gain.connect(reporterGainNode);
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

  function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function scheduleNextWorldEventDay(fromDay = campaignDaysElapsed()) {
    const firstDay = worldEventFirstElapsedDay();
    const latest = Math.max(firstDay, currentMatchMode.days - WORLD_EVENT_LAST_DAY_BUFFER);
    const next = Math.max(firstDay, fromDay) + WORLD_EVENT_MIN_GAP_DAYS
      + Math.random() * (WORLD_EVENT_MAX_GAP_DAYS - WORLD_EVENT_MIN_GAP_DAYS);
    return Math.min(next, latest + 1);
  }

  function worldEventFirstElapsedDay() {
    return Math.max(0, currentMatchMode.days - WORLD_EVENT_FIRST_DAYS_TO_ELECTION);
  }

  function worldEventActive(id) {
    return !!activeWorldEvent && activeWorldEvent.id === id && worldEventTimer > 0;
  }

  function totalInfluenceScore(playerId) {
    return states.reduce((sum, state) => sum + stateShare(state, playerId) * (state.ev || 0), 0);
  }

  function worldEventDurationLabel() {
    return worldEventTimer > 0 ? " (" + campaignDaysLabel(worldEventTimer) + " remaining)" : "";
  }

  function worldEventReportText(template, detail = "") {
    const durationDays = Number(template.durationDays || 0);
    const duration = durationDays > 0 ? ` Lasts ${durationDays} days.` : " One-time event.";
    return `${template.text}${detail ? " " + detail : ""}${duration}`;
  }

  function tickWorldEvent(dt) {
    if (activeWorldEvent && worldEventTimer > 0) {
      worldEventTimer = Math.max(0, worldEventTimer - dt);
      if (worldEventTimer <= 0) {
        addAlert("[WORLD EVENT ENDED] " + activeWorldEvent.title + " has expired.");
        activeWorldEvent = null;
      }
    }
    const day = campaignDaysElapsed();
    const tooEarly = daysUntilElection() > WORLD_EVENT_FIRST_DAYS_TO_ELECTION;
    const tooLate = daysUntilElection() <= WORLD_EVENT_LAST_DAY_BUFFER;
    if (tooEarly || tooLate || elapsed < nextWorldEventAt) return;
    triggerWorldEvent();
  }

  function triggerWorldEvent(forcedId = "") {
    if (daysUntilElection() <= WORLD_EVENT_LAST_DAY_BUFFER) return false;
    const pool = WORLD_EVENTS.filter((event) => {
      if (forcedId && event.id !== forcedId) return false;
      if (activeWorldEvent && worldEventTimer > 0 && Number(event.durationDays || 0) > 0) return false;
      return true;
    });
    const template = pool[Math.floor(Math.random() * pool.length)];
    if (!template) {
      nextWorldEventAt = scheduleNextWorldEventDay(campaignDaysElapsed()) * CAMPAIGN_DAY_SECONDS;
      return false;
    }
    const durationSeconds = Math.max(0, Number(template.durationDays || 0) * CAMPAIGN_DAY_SECONDS);
    const eventState = {
      id: template.id,
      title: template.title,
      text: template.text,
      startedDay: campaignDaysElapsed(),
      stateIndexes: [],
      eventId: ++worldEventCounter,
    };
    if (durationSeconds > 0) {
      activeWorldEvent = eventState;
      worldEventTimer = durationSeconds;
    }
    let detail = "";
    if (template.id === "foreign_wire") {
      const weakest = players.slice().sort((a, b) => totalInfluenceScore(a.id) - totalInfluenceScore(b.id) || a.cash - b.cash)[0];
      if (weakest) {
        weakest.cash += 20000;
        detail = weakest.name + " received " + formatMoney(20000) + ".";
      }
    } else if (template.id === "disaster_relief") {
      const picked = shuffle(states).slice(0, 6);
      picked.forEach((state) => {
        players.forEach((player) => {
          const level = officeLevel(state, player.id);
          if (level > 1) state.offices[player.id] = level - 1;
        });
        state.activePulse = 1;
      });
      eventState.stateIndexes = picked.map((state) => state.index);
      if (durationSeconds > 0) activeWorldEvent.stateIndexes = eventState.stateIndexes;
      detail = "Affected states: " + picked.map((state) => state.abbr).join(", ") + ".";
    } else if (template.id === "irs_audit") {
      players.forEach((player) => { player.cash = Math.max(0, player.cash * 0.8); });
      detail = "All campaign cash reserves dropped by 20%.";
    }
    const brief = worldEventReportText(template, detail);
    news = { title: "WORLD EVENT: " + template.title, text: brief, effect: "world", isWorldEvent: true };
    newsTimer = WORLD_EVENT_REPORT_DAYS * CAMPAIGN_DAY_SECONDS;
    latestClickbait = {
      id: `world_${Date.now()}_${Math.floor(Math.random() * 999)}`,
      day: Math.max(1, Math.ceil(campaignDaysElapsed())),
      level: "WORLD EVENT",
      headline: "WORLD EVENT: " + template.title,
      subtext: brief,
      worldEvent: true,
    };
    clickbaitTimer = WORLD_EVENT_REPORT_DAYS * CAMPAIGN_DAY_SECONDS;
    renderClickbaitTicker();
    broadcast(Math.floor(Math.random() * CHANNELS.length), "WORLD EVENT - " + template.title + ": " + brief, { worldEvent: true });
    addAlert("[WORLD EVENT] " + template.title + ": " + brief);
    nextWorldEventAt = scheduleNextWorldEventDay(campaignDaysElapsed()) * CAMPAIGN_DAY_SECONDS;
    return true;
  }

  function triggerBreakingNews() {
    if (activeWorldEventReport()) return;
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
    clickbaitTicker.classList.remove("is-visible", "news-flicker-alert", "is-world-event");
    clickbaitTicker.innerHTML = "";
  }

  function showAssassinationBroadcast() {
    if (!assassinationOverlay || !assassinationGif) return;
    assassinationOverlay.classList.remove("is-on");
    if (assassinationTimer) {
      window.clearTimeout(assassinationTimer);
      assassinationTimer = null;
    }
    assassinationGif.src = `assassinate_broadcast_v3.gif?v=${Date.now()}`;
    void assassinationOverlay.offsetWidth;
    assassinationOverlay.classList.add("is-on");
    assassinationTimer = window.setTimeout(() => {
      assassinationOverlay.classList.remove("is-on");
      assassinationTimer = null;
    }, 3000);
  }

  function presentAssassinationEvent(event) {
    if (!event) return;
    if (assassinationStartTimer) window.clearTimeout(assassinationStartTimer);
    const startBroadcast = () => {
      assassinationStartTimer = null;
      playAssassinationSfx(Number(event.targetId) === HUMAN ? "incoming" : "outgoing");
      showAssassinationBroadcast();
    };
    const delay = Math.max(0, Number(event.playAt || 0) - Date.now());
    if (delay > 8) assassinationStartTimer = window.setTimeout(startBroadcast, delay);
    else startBroadcast();
  }

  function showPowerGrabBroadcast() {
    if (!powerGrabOverlay || !powerGrabGif) return;
    powerGrabOverlay.classList.remove("is-on");
    if (powerGrabTimer) {
      window.clearTimeout(powerGrabTimer);
      powerGrabTimer = null;
    }
    powerGrabGif.src = `power_grab_broadcast_v2.gif?v=${Date.now()}`;
    void powerGrabOverlay.offsetWidth;
    powerGrabOverlay.classList.add("is-on");
    powerGrabTimer = window.setTimeout(() => {
      powerGrabOverlay.classList.remove("is-on");
      powerGrabTimer = null;
    }, 3000);
  }

  function presentPowerGrabEvent(event) {
    if (!event) return;
    if (powerGrabStartTimer) window.clearTimeout(powerGrabStartTimer);
    const startBroadcast = () => {
      powerGrabStartTimer = null;
      pipSfx("inject");
      showPowerGrabBroadcast();
    };
    const delay = Math.max(0, Number(event.playAt || 0) - Date.now());
    if (delay > 8) powerGrabStartTimer = window.setTimeout(startBroadcast, delay);
    else startBroadcast();
  }

  function finishElection(winnerId = null, reason = "time expired") {
    if (matchOver) return;
    matchOver = true;
    const resolvedWinnerId = winnerId === null
      ? players
          .map((player) => ({ player, electoral: electoralVotes(player.id), vote: projectedVote(player.id) }))
          .sort((a, b) => b.electoral - a.electoral || b.vote - a.vote)[0]?.player.id
      : winnerId;
    matchResult = { id: ++matchResultCounter, winnerId: resolvedWinnerId, reason };
    lastPresentedMatchResultId = matchResult.id;
    presentElectionResult(resolvedWinnerId, reason, true);
  }

  function localCandidateId() {
    const lobbyCandidate = players.find((player) => String(player.lobbyPlayerId || "") === String(currentPlayerId || ""));
    return Number.isFinite(Number(lobbyCandidate?.id)) ? Number(lobbyCandidate.id) : HUMAN;
  }

  function presentElectionResult(winnerId, reason, announce) {
    const standings = players
      .map((player) => ({ player, electoral: electoralVotes(player.id), vote: projectedVote(player.id), states: statesHeld(player.id) }))
      .sort((a, b) => b.electoral - a.electoral || b.vote - a.vote);
    const winner = standings.find((item) => item.player.id === winnerId) || standings[0];
    if (!winner) return;
    if (announce) {
      addAlert(`${winner.player.name} wins: ${reason}. Electoral vote ${winner.electoral}/${totalElectoralVotes()}.`);
      showToast(`${winner.player.name} wins the electoral vote.`);
    }
    showVoteCountingScreen(standings, winner, reason);
    resultBgm = winner.player.id === localCandidateId() ? "victory" : "";
    if (resultBgm) {
      playVictorySfx();
      transitionBgm(resultBgm, 1.6);
    }
    else playDefeatSfx();
    updateUi(true);
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
    return states.reduce((sum, state) => sum + effectiveStateElectoralVotes(state), 0);
  }

  function electoralVoteTarget() {
    return Math.ceil(totalElectoralVotes() * 0.5);
  }

  function electoralVotes(playerId) {
    return states.reduce((sum, state) => leadingPlayer(state.index) === playerId ? sum + effectiveStateElectoralVotes(state) : sum, 0);
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

  function influenceCap(state, playerId) {
    return state && isLateStage() && GHOST_INFLUENCE_STATES.has(state.abbr) && officeLevel(state, playerId) >= 3
      ? GHOST_INFLUENCE_CAP
      : 100;
  }

  function clampInfluenceForState(state, playerId, value) {
    return Math.min(influenceCap(state, playerId), Math.max(0, value));
  }

  function effectiveStateElectoralVotes(state) {
    if (!state) return 0;
    const leaderId = leadingPlayer(state.index);
    const riggedBonus = isLateStage() &&
      (state.ev || 0) < 10 &&
      leaderId >= 0 &&
      adjustedInfluence(state, leaderId) >= 60
      ? LATE_SMALL_STATE_EV_BONUS
      : 0;
    return (state.ev || 0) + riggedBonus;
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

  function isPlayerActionAlert(message) {
    const text = String(message || "");
    if (/^\[WORLD EVENT(?: ENDED)?\]/i.test(text)) return true;
    if (!players.some((player) => text.includes(player.name))) return false;
    if (/^(?:Breaking:|\[CLICKBAIT\])/i.test(text)) return false;
    // Completion/result messages replace these temporary action-start notices.
    if (/\b(?:started|began|launched|is inciting)\b/i.test(text)) return false;
    if (/^DEBATE NIGHT: .* challenged /i.test(text)) return false;
    return true;
  }

  function simplePlayerAction(message) {
    return String(message || "")
      .replace(/^\[WORLD EVENT\]\s*/i, "World Event: ")
      .replace(/^\[WORLD EVENT ENDED\]\s*/i, "Event Ended: ")
      .replace(/^DEBATE NIGHT:\s*/i, "Debate: ")
      .replace(/\s+\([^)]*\) and gained (\d+)% influence\.$/i, " (+$1% influence).")
      .replace(/ finished a public speech in /i, " spoke in ")
      .replace(/ completed Main Base upgrade to Level /i, " upgraded Main Base to Level ")
      .replace(/ completed a state-wide DISRUPT in /i, " used DISRUPT in ")
      .replace(/ executed a power grab in ([^.]+) for \+(\d+)% influence at a cost of [^.]+\./i, " used Power Grab in $1 (+$2% influence).")
      .replace(/ deployed a Level 1 District Office in /i, " built a District Office in ")
      .replace(/ upgraded a District Office to Level /i, " upgraded their District Office to Level ")
      .replace(/ for police response in ([^.]+)\. Police withdrew and the riot broke through\./i, " for police response in $1; the riot succeeded.")
      .replace(/ for \$[\d.,]+(?:[KMB])?\./i, ".")
      .replace(/\s{2,}/g, " ")
      .trim();
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
      : `${state.name} (${state.ev} EV): ${leader ? `${leader.name} leads ${Math.round(adjustedInfluence(state, leader.id))}%` : "undecided"}. Your support ${Math.round(stateShare(state, HUMAN) * 100)}%. Most electoral votes on election day wins.`;
    cashStat.textContent = formatMoney(human.cash);
    timeStat.textContent = phase === "base" ? `${Math.ceil(baseTimer)}s` : `${Math.ceil(daysUntilElection())}d`;
    voteStat.textContent = `${electoralVotes(HUMAN)}`;
    renderUpgradeStatus(human);
    renderDebatePowerOverlay(human);
    renderTalentDraftOverlay();
    if (calendarCountdown) {
      const calendarCard = calendarCountdown.closest(".election-calendar");
      if (calendarCard) calendarCard.style.display = "block";
      calendarCountdown.textContent = String(Math.ceil(phase === "base" ? baseTimer : daysUntilElection()));
      if (calendarLabel) calendarLabel.textContent = phase === "base" ? "SECONDS TO SELECT HQ" : "DAYS TO ELECTION";
      if (calendarCard) {
        const progress = phase === "base"
          ? Math.max(0, Math.min(1, 1 - baseTimer / HOME_BASE_SECONDS))
          : Math.max(0, Math.min(1, campaignDaysElapsed() % 1));
        calendarCard.style.setProperty("--day-progress", (progress * 100).toFixed(1) + "%");
      }
    }
    eventTicker.textContent = phase === "base" ? "Home base draft" : activeWorldEvent ? "WORLD EVENT: " + activeWorldEvent.title + worldEventDurationLabel() : news ? news.title : "State race live";
    document.body.classList.toggle("world-event-live", news?.isWorldEvent === true && newsTimer > 0);
    document.body.classList.toggle("district-jammed-screen", !!human && (human.officeInfluenceSlow || 0) > 0);
    if (newsPanel) newsPanel.classList.toggle("is-world-event", news?.isWorldEvent === true && newsTimer > 0);
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
          <button class="opponent-chip${player.id === HUMAN ? " is-human" : ""}${player.locked > 0 ? " is-blackout" : ""}${player.officeInfluenceSlow > 0 ? " is-jammed" : ""}${isSpeaking(player) ? " is-speaking" : ""}${assassinatedToday(player) ? " is-assassin" : ""}" type="button" data-leader-player="${player.id}" aria-label="${player.id === HUMAN ? "Open your talent terminal" : `Inspect ${escapeHtml(player.name)} talent tree`}">
              <span class="leader-portrait-frame leader-portrait-frame-bright">
               ${leaderPortraitMarkup(player, "leader-portrait")}
                ${player.emoteUntil > 0 && player.emoteIcon ? `<span class="leader-emote-bubble">${escapeHtml(player.emoteIcon)}</span>` : ""}
              </span>
            ${player.locked > 0 ? '<span class="leader-blackout-mark">X</span>' : ""}
            ${player.officeInfluenceSlow > 0 ? '<span class="leader-jam-mark">JAM</span>' : ""}
            ${isSpeaking(player) ? '<span class="leader-speaking-mark">LIVE</span>' : ""}
            ${assassinatedToday(player) ? '<span class="leader-assassin-mark">HIT</span>' : ""}
          </button>
        `).join("");
    }
    playerList.innerHTML = players.map((player) => `
      <div class="player-row">
        <span class="player-dot" style="background:${player.color}"></span>
        <span class="player-name">${player.name}</span>
        ${player.emoteUntil > 0 && player.emoteIcon ? `<span class="player-emote">${escapeHtml(player.emoteIcon)}</span>` : ""}
        <span class="player-count">${player.homeBase >= 0 ? states[player.homeBase].abbr : "--"}</span>
      </div>
    `).join("");
    opPanel.innerHTML = "";
    channelMarket.innerHTML = channels.map((channel) => {
      const owner = channel.owner >= 0 ? players[channel.owner] : null;
      const ownerColor = owner?.color || "#34ff86";
      const ownerBorder = hexToRgba(ownerColor, owner ? 0.52 : 0.22);
      const ownerWash = hexToRgba(ownerColor, owner ? 0.12 : 0.025);
      const active = channel.index === activeChannel ? " is-active" : "";
      const ownerLine = owner ? `Owned by ${owner.name}` : `Open market`;
      const buyCost = channelTakeoverCost(HUMAN, channel);
      const buyLabel = owner ? `Take ${formatMoney(buyCost)}` : `Buy ${formatMoney(buyCost)}`;
      return `
        <div class="channel-card${active}" data-channel-hover="${channel.index}" style="--channel-owner:${ownerColor};--channel-owner-border:${ownerBorder};--channel-owner-wash:${ownerWash}">
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
      cityLog.innerHTML = alerts.filter((entry) => isPlayerActionAlert(entry.message)).map((entry) => `
        <div class="log-entry"><strong>${entry.time}</strong><span>${colorizeAlertMessage(simplePlayerAction(entry.message))}</span></div>
      `).join("");
      cityLog.dataset.version = String(alertVersion);
      cityLog.scrollTop = 0;
    }
    pauseButton.textContent = paused ? "Resume" : "Pause";
    document.body.classList.toggle("player-blackout", !!human && human.locked > 0 && gameStarted && !matchOver);
    document.body.classList.toggle("game-paused", paused && gameStarted && !matchOver);
    if (pauseOverlay) pauseOverlay.classList.toggle("is-visible", paused && gameStarted && !matchOver);
    ensureEmoteWheel()?.classList.toggle("is-open", emoteWheelOpen && canUseEmotes() && (!gameStarted || !paused));
  }

  function renderDebatePowerOverlay(human) {
    if (!debatePowerOverlay) return;
    const debateId = human?.action?.debateId;
    const participants = debateId
      ? players.filter((candidate) => candidate.action?.debateId === debateId && candidate.action.type === "speech")
      : [];
    if (!debateId || participants.length < 2) {
      debatePowerOverlay.classList.remove("is-visible");
      debatePowerOverlay.setAttribute("aria-hidden", "true");
      debatePowerOverlay.innerHTML = "";
      return;
    }
    const state = states[human.action.state];
    if (!state) return;
    const ranked = participants
      .map((player) => ({ player, score: debateScore(player, state) }))
      .sort((a, b) => b.score - a.score);
    const total = Math.max(1, ranked.reduce((sum, entry) => sum + Math.max(0, entry.score), 0));
    const leader = ranked[0];
    const tied = ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 0.5;
    const secondsLeft = Math.max(0, ...participants.map((candidate) => guestDisplaySecondsLeft(candidate.action)));
    debatePowerOverlay.innerHTML =
      '<div class="debate-power-head"><span>DEBATE NIGHT // ' + escapeHtml(state.name.toUpperCase()) + '</span><strong>' + formatCampaignDuration(secondsLeft) + '</strong></div>' +
      '<div class="debate-power-contenders">' + ranked.map((entry, index) =>
        '<div class="debate-power-party' + (index === 0 && !tied ? ' is-leading' : '') + '" style="--debate-color:' + entry.player.color + '">' +
          '<span>' + escapeHtml(entry.player.name) + '</span>' +
          '<small>' + escapeHtml(entry.player.leader) + '</small>' +
          '<strong>' + Math.round(entry.score) + '</strong>' +
        '</div>'
      ).join('') + '</div>' +
      '<div class="debate-power-track">' + ranked.map((entry) =>
        '<i style="--debate-color:' + entry.player.color + ';flex-basis:' + (Math.max(0, entry.score) / total * 100).toFixed(2) + '%"></i>'
      ).join('') + '</div>' +
      '<div class="debate-power-result">' + (tied ? 'TOO CLOSE TO CALL' : escapeHtml(leader.player.name.toUpperCase()) + ' IS CURRENTLY WINNING') + '</div>';
    debatePowerOverlay.classList.add("is-visible");
    debatePowerOverlay.setAttribute("aria-hidden", "false");
  }

  function renderUpgradeStatus(player) {
    if (!upgradeStatusBox || !player) return;
    const notices = [];
    const talentChoices = pipPoints(player);
    if (talentChoices > 0) {
      notices.push({
        kind: "talent",
        title: talentChoices === 1 ? "TALENT CHOICE READY" : `${talentChoices} TALENT CHOICES READY`,
        detail: "Press TAB to select a talent",
      });
    }

    const nextLevel = player.mainBaseLevel >= 1 && player.mainBaseLevel < 3 ? player.mainBaseLevel + 1 : null;
    const upgrading = missions.some((mission) => mission.type === "baseUpgrade" && mission.player === player.id);
    if (talentChoices === 0 && nextLevel && !upgrading) {
      const req = { ...HQ_UPGRADE[nextLevel], cash: mainBaseUpgradeCash(player, nextLevel) };
      const influenceReq = Math.ceil(req.infl * (hasTalent(player, "system_overclock") ? 0.8 : 1));
      const homeInfluence = player.homeBase >= 0 && states[player.homeBase]
        ? Number(states[player.homeBase].influence[player.id] || 0)
        : 0;
      if (player.cash >= req.cash) {
        const ready = homeInfluence >= influenceReq;
        notices.push({
          kind: "hq",
          title: ready ? `HQ L${nextLevel} UPGRADE READY` : `HQ L${nextLevel} FUNDS READY`,
          detail: ready
            ? "Press TAB, then U to begin upgrade"
            : `Need ${influenceReq}% home influence (currently ${Math.floor(homeInfluence)}%)`,
        });
      }
    }

    upgradeStatusBox.innerHTML = notices.map((notice) => `
      <div class="upgrade-status-item is-${notice.kind}">
        <strong>${notice.title}</strong>
        <span>${notice.detail}</span>
      </div>
    `).join("");
    upgradeStatusBox.classList.toggle("is-visible", notices.length > 0);
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
      drawAllPoliceDeployments();
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
    const text = "ASSASSINATION HEAT: another kill today triggers -5% influence nationwide";
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

    if (isDisasterReliefState(state)) {
      drawDisasterReliefBorder(state);
    }

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
      pathState(state);
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = zoomThinLine(6.4, 0.6);
      ctx.lineJoin = "round";
      ctx.shadowColor = "#000000";
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }

    if (state.activePulse > 0) {
      pathState(state);
      ctx.strokeStyle = `rgba(255,255,255,${state.activePulse * 0.8})`;
      ctx.lineWidth = zoomThinLine(4, 0.28);
      ctx.stroke();
    }

    const supportsShareBar = (state.w > 40 && state.h > 26)
      || ["NJ", "DE", "VT", "NH", "MA", "CT", "RI"].includes(state.abbr);
    if (MAP_INFO_MODES[mapInfoMode]?.id !== "flag" && zoomState.shareAlpha > 0.03 && supportsShareBar) drawStateShareBar(state, zoomState.shareAlpha);
  }

  function isDisasterReliefState(state) {
    return worldEventActive("disaster_relief") && Array.isArray(activeWorldEvent?.stateIndexes) && activeWorldEvent.stateIndexes.includes(state.index);
  }

  function drawDisasterReliefBorder(state) {
    const flash = Math.sin(performance.now() / 95) > 0 ? 1 : 0;
    pathState(state);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.96)";
    ctx.lineWidth = zoomThinLine(9.5, 0.78);
    ctx.lineJoin = "round";
    ctx.shadowColor = "#000000";
    ctx.shadowBlur = 10;
    ctx.stroke();
    pathState(state);
    ctx.globalAlpha = flash ? 1 : 0.72;
    ctx.strokeStyle = flash ? "#ff2a2a" : "rgba(255,42,42,0.52)";
    ctx.lineWidth = zoomThinLine(flash ? 7.4 : 5.4, 0.56);
    ctx.lineJoin = "round";
    ctx.shadowColor = "#ff1f1f";
    ctx.shadowBlur = flash ? 30 : 14;
    ctx.stroke();
    pathState(state);
    ctx.globalAlpha = flash ? 0.24 : 0.1;
    ctx.fillStyle = "#ff1f1f";
    ctx.fill();
    ctx.restore();
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
    const hitRadius = armedAction === "togglePolice" || armedAction === "deployMiniBase" ? 18 : MINI_BASE_HIT_RADIUS;
    for (let i = states.length - 1; i >= 0; i -= 1) {
      const state = states[i];
      const hubs = players.filter((player) => officeLevel(state, player.id) > 0);
      for (let h = hubs.length - 1; h >= 0; h -= 1) {
        const player = hubs[h];
        if (ownerId !== null && player.id !== ownerId) continue;
        const basePoint = miniBasePoint(state, player, h, hubs.length);
        const dx = point.x - basePoint.x;
        const dy = point.y - basePoint.y;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          return { state: state.index, player: player.id, level: officeLevel(state, player.id), x: basePoint.x, y: basePoint.y };
        }
      }
    }
    return null;
  }

  function hitMainBase(point, ownerId = null) {
    const hitRadius = armedAction === "togglePolice" ? 24 : 15;
    for (let index = players.length - 1; index >= 0; index -= 1) {
      const player = players[index];
      if (ownerId !== null && player.id !== ownerId) continue;
      if (player.homeBase < 0 || !states[player.homeBase]) continue;
      const pointOnMap = mainBasePoint(states[player.homeBase]);
      const dx = point.x - pointOnMap.x;
      const dy = point.y - pointOnMap.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) return { state: player.homeBase, player: player.id, x: pointOnMap.x, y: pointOnMap.y };
    }
    return null;
  }

  function drawAllMainBases() {
    players.forEach((player) => {
      if (player.homeBase < 0) return;
      const state = states[player.homeBase];
      const point = mainBasePoint(state);
      drawMainBaseIcon(point.x, point.y, player);
    });
  }

  function drawAllMiniBases() {
    eachMiniBase((state, player, index, total) => {
      const point = miniBasePoint(state, player, index, total);
      const level = officeLevel(state, player.id);
      if (armedAction === "deployMiniBase" && player.id === HUMAN) {
        drawMiniBaseUpgradeGlow(point.x, point.y, player, level < MINI_BASE_MAX_LEVEL && level + 1 <= player.mainBaseLevel);
      }
      drawMiniBaseIcon(point.x, point.y, player, level);
      const upgradeMission = officeUpgradeMissionFor(state.index, player.id);
      if (upgradeMission) {
        const progress = 1 - upgradeMission.left / upgradeMission.total;
        drawCountdownBar(point.x - 25, point.y - 22, 50, progress, factionVisual(player).glow, upgradeMission.left);
      }
    });
  }

  function drawAllPoliceDeployments() {
    players.forEach((player) => {
      states.forEach((state) => {
        if (policeGuards(state, player.id, "hq") && player.homeBase === state.index) {
          const point = mainBasePoint(state);
          drawPoliceShield(point.x, point.y, 15, player);
          if (policeAtRisk(player)) drawPoliceRiskWarning(point.x + 16, point.y - 16);
        }
        if (policeGuards(state, player.id, "office") && officeLevel(state, player.id) > 0) {
          const hubs = players.filter((candidate) => officeLevel(state, candidate.id) > 0);
          const officeIndex = hubs.findIndex((candidate) => candidate.id === player.id);
          if (officeIndex < 0) return;
          const point = miniBasePoint(state, player, officeIndex, hubs.length);
          drawPoliceShield(point.x, point.y, 13, player);
          drawPoliceProtectionBadge(point.x + 12, point.y - 12, player);
          if (policeAtRisk(player)) drawPoliceRiskWarning(point.x + 14, point.y - 14);
        }
      });
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

  function drawPoliceProtectionBadge(x, y, player) {
    const visual = factionVisual(player);
    const s = mapIconScale();
    const pulse = 0.72 + Math.sin(performance.now() / 180) * 0.12;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.globalAlpha = pulse;
    ctx.shadowColor = "#A6FFD0";
    ctx.shadowBlur = 8 / Math.max(s, 0.1);
    ctx.fillStyle = "rgba(2, 12, 6, 0.92)";
    ctx.strokeStyle = "#A6FFD0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-8, -7, 16, 14, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = mix(visual.color, "#ffffff", 0.5);
    ctx.font = "bold 10px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("P", 0, 0.5);
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
      NJ: { width: 52, dx: -8, dy: 7, clip: false },
      DE: { width: 40, dx: 0, dy: 0, clip: false },
      MD: { width: 50, dx: 12, dy: -9, clip: false },
      VT: { width: 16, dx: 0, dy: 4, clip: false },
      NH: { width: 15, dx: -3, dy: 0, clip: false },
      MA: { width: 20, dx: -8, dy: 0, clip: false },
      CT: { width: 18, dx: 0, dy: -3, clip: false },
      RI: { width: 8, dx: 0, dy: -3, clip: false },
    };
    const barLayout = compactBars[state.abbr] || {};
    const barW = barLayout.width || Math.max(18, Math.min(state.w - 8, 46));
    const preferredX = state.cx - barW / 2 + (barLayout.dx || 0);
    const barX = barLayout.clip === false
      ? preferredX
      : Math.max(state.x + 5, Math.min(state.x + state.w - barW - 5, preferredX));
    const hasOffice = players.some((player) => officeLevel(state, player.id) > 0);
    const preferredY = Number.isFinite(barLayout.dy)
      ? state.cy + barLayout.dy
      : hasOffice ? state.cy + 7 : state.cy + 22;
    const barY = barLayout.clip === false
      ? preferredY
      : Math.max(state.y + 8, Math.min(state.y + state.h - 6, preferredY));
    let cursor = barX;
    ctx.save();
    if (barLayout.clip !== false) {
      pathState(state);
      ctx.clip();
    }
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "rgba(18,26,14,0.5)";
    ctx.fillRect(barX, barY, barW, 3);
    players.forEach((player) => {
      const width = Math.max(0, Math.min(barW - (cursor - barX), stateShare(state, player.id) * barW));
      if (width <= 0) return;
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
        const debateParticipants = player.action.debateId
          ? players.filter((candidate) => candidate.action?.debateId === player.action.debateId)
          : [];
        const debateIndex = debateParticipants.findIndex((candidate) => candidate.id === player.id);
        const debateOffset = debateParticipants.length > 1 ? (debateIndex === 0 ? -15 : 15) : 0;
        drawSpeechBroadcast(x + debateOffset, y, player);
        drawCountdownBar(x + debateOffset - 25, y - 32, 50, progress, factionVisual(player).glow, secondsLeft);
        if (player.action.debateId && debateIndex === 0) {
          const scoreText = debateParticipants
            .map((candidate) => Math.round(debateScore(candidate, state)))
            .join("  vs  ");
          ctx.save();
          ctx.font = "bold 10px 'Share Tech Mono', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#fff36a";
          ctx.shadowColor = "#000";
          ctx.shadowBlur = 4;
          ctx.fillText("DEBATE NIGHT", x, y - 43);
          ctx.font = "bold 8px 'Share Tech Mono', monospace";
          ctx.fillStyle = "#ffffff";
          ctx.fillText(scoreText, x, y - 34);
          ctx.restore();
        }
        (player.action.decoyStates || []).forEach((decoyStateIndex) => {
          const decoyState = states[decoyStateIndex];
          if (decoyState) {
            drawSpeechBroadcast(decoyState.cx, decoyState.cy, player);
            drawCountdownBar(decoyState.cx - 28, decoyState.cy - 32, 56, progress, factionVisual(player).glow, secondsLeft);
          }
        });
      }
    });
    missions.forEach((mission) => {
      const state = states[mission.state];
      const player = players[mission.player];
      const progress = 1 - mission.left / mission.total;
      if (mission.type === "riot" || mission.type === "disrupt") {
        drawRiotHazard(state, player, progress);
        if (mission.type === "disrupt") {
          const target = players[mission.target];
          const point = target && target.homeBase === state.index ? mainBasePoint(state) : { x: state.cx, y: state.cy };
          drawSabotageCrosshair(point.x, point.y, player, progress);
        }
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
      if (state.abbr === "HI" && armedAction === "assassinate") {
        const padding = 26;
        if (point.x >= state.x - padding && point.x <= state.x + state.w + padding
          && point.y >= state.y - padding && point.y <= state.y + state.h + padding) {
          return i;
        }
      }
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

  function campaignStage() {
    const left = daysUntilElection();
    if (left > EARLY_STAGE_DAYS_LEFT) return "early";
    if (left <= LATE_STAGE_DAYS_LEFT) return "late";
    return "mid";
  }

  function isEarlyStage() {
    return phase === "play" && campaignStage() === "early";
  }

  function isMidStage() {
    return phase === "play" && campaignStage() === "mid";
  }

  function isLateStage() {
    return phase === "play" && campaignStage() === "late";
  }

  function formatCampaignDuration(seconds) {
    return `${Math.max(0, seconds / CAMPAIGN_DAY_SECONDS).toFixed(1)}d`;
  }

  function formatCampaignLogTime() {
    return `D-${Math.ceil(daysUntilElection())}`;
  }

  function showToast(message, variant = "") {
      if (!toast) return;
      toast.textContent = message;
      toast.classList.toggle("is-compact", variant === "compact");
      toast.classList.toggle("is-draft", variant === "draft");
      toast.classList.remove("is-visible");
      void toast.offsetWidth;
      toast.classList.add("is-visible");
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toast.classList.remove("is-visible");
        toast.classList.remove("is-compact");
        toast.classList.remove("is-draft");
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
  const TALENT_ORDER = ["oligarchy", "populist", "syndicate", "vanguard", "futurist", "machine", "signal", "ledger"];
  const TALENT_ATLAS_BY_TREE = {
    oligarchy: "oligarchy-atlas.png?v=2",
    populist: "populist-atlas.png?v=2",
    syndicate: "syndicate-atlas.png?v=2",
    vanguard: "vanguard-atlas.png?v=2",
    futurist: "futurist-atlas.png?v=2",
    machine: "machine-atlas.png?v=2",
    signal: "signal-atlas.png?v=2",
    ledger: "ledger-atlas.png?v=2",
  };
  const TALENTS = {
    oligarchy: { name: "CORPORATE OLIGARCHY", sub: "DONOR WAR ROOM", theme: "Cheap expansion builds a cash engine, then converts money into brutal tempo.", tiers: [
      { left:{id:"aggressive_portfolio",name:"FRANCHISE PERMITS",desc:"District Offices deploy 20% cheaper.",live:true},
        right:{id:"hostile_liquidation",name:"HOSTILE AUDIT",desc:"DISRUPT steals 50% more cash from rival treasuries.",live:true} },
      { left:{id:"rapid_construction",name:"PROCUREMENT DESK",desc:"District Office upgrades cost 30% less cash.",live:true},
        right:{id:"private_security",name:"RETAINER CONTRACTS",desc:"Police upkeep is cut 50%.",live:true} },
      { left:{id:"shadow_lobbying",name:"BOARDROOM STATE",desc:"Level 3 HQ boosts HQ income by 50% and all state funding by 25%.",live:true,ult:true},
        right:{id:"executive_immunity",name:"EXECUTIVE BLITZ",desc:"Speeches run at 2x speed, gain extra influence, and finish debates faster.",live:true,ult:true} },
    ]},
    populist: { name: "POPULIST COALITION", sub: "STREET HIVE", theme: "Speeches seed crowds, crowds fund offices, offices make Power Grab terrifying.", tiers: [
      { left:{id:"echo_chamber",name:"CHANT LOOP",desc:"Public Speeches gain +5 local influence and 5% stronger speech output.",live:true},
        right:{id:"crowdsourcing",name:"DONATION SWARM",desc:"District Offices earn +1% passive income per 5% local influence you hold.",live:true} },
      { left:{id:"general_strike",name:"PICKET ENGINE",desc:"DISRUPT office damage costs 50% less and resolves 25% faster.",live:true},
        right:{id:"human_shield",name:"CROWD COVER",desc:"Assassinating your speaking leader costs rivals $50M instead of $40M.",live:true} },
      { left:{id:"great_awakening",name:"RALLY RIPPLE",desc:"Completed speeches splash +3 influence into adjacent states.",live:true,ult:true},
        right:{id:"decentralized_hive",name:"MASS MANDATE",desc:"POWER GRAB takes 30 influence instead of 20 and bots favor it more.",live:true,ult:true} },
    ]},
    syndicate: { name: "TECHNOCRATIC SYNDICATE", sub: "NETRUNNERS", theme: "Lower upgrade friction, overload DISRUPT, then weaponize misinformation.", tiers: [
      { left:{id:"system_overclock",name:"PATCHED BUREAUCRACY",desc:"HQ and Office upgrades require 20% less cash and 20% less local influence.",live:true},
        right:{id:"signal_scrambler",name:"BLUE-LIGHT BYPASS",desc:"DISRUPT office destruction ignores enemy Police protection.",live:true} },
      { left:{id:"backdoor_exploits",name:"QUEUE INJECTION",desc:"DISRUPT cancels a target's District Office upgrade, forcing them to pay again.",live:true},
        right:{id:"ghost_servers",name:"BOTNET OPS",desc:"Active DISRUPT limit rises from 1 to 3, cost drops by $2M, and bots favor it more.",live:true} },
      { left:{id:"skynet_protocol",name:"PHANTOM CANDIDATE",desc:"Speeches create 3 decoys. Assassinating a decoy wastes the full cost.",live:true,ult:true},
        right:{id:"blackout_bypass",name:"HOT-SWAP HEIR",desc:"Assassination blackout is reduced from 3 days to 0.",live:true,ult:true} },
    ]},
    vanguard: { name: "IRON VANGUARD", sub: "CENTRAL AUTHORITY", theme: "Police makes money, delays sabotage, then locks territory or executes rivals.", tiers: [
      { left:{id:"fortified_outposts",name:"REINFORCED OUTPOSTS",desc:"Enemy DISRUPT office damage takes 100% longer against your District Offices.",live:true},
        right:{id:"martial_law_taxes",name:"SECURITY LEVY",desc:"Police-guarded HQs and Offices generate +15% extra cash per day.",live:true} },
      { left:{id:"bureaucratic_hold",name:"PERMIT FREEZE",desc:"DISRUPT freezes an upgrading enemy base for 2 campaign days.",live:true},
        right:{id:"checkpoint_grid",name:"CHECKPOINT GRID",desc:"Police-guarded District Offices make enemy DISRUPT take 50% longer.",live:true} },
      { left:{id:"iron_curtain",name:"FORTRESS STATE",desc:"Level 3 HQ state is immune to siphoning and cannot drop below 30 influence.",live:true,ult:true},
        right:{id:"retributive_strike",name:"EXECUTION WINDOW",desc:"Assassination costs $25M while any rival is speaking, and bots favor assassinations more.",live:true,ult:true} },
    ]},
    futurist: { name: "CIVIC FUTURISTS", sub: "POLICY LAB", theme: "Predict big states, chain speeches, then make upgrades or deaths reshape the map.", tiers: [
      { left:{id:"model_polling",name:"MEGA-STATE MODEL",desc:"Speeches gain +5 influence and 8% stronger output in states worth 10+ electoral votes.",live:true},
        right:{id:"hype_train",name:"MOMENTUM SCRIPT",desc:"Finishing a speech supercharges your next speech by 40%.",live:true} },
      { left:{id:"fast_track_zoning",name:"BROADCAST ZONING",desc:"Owned news channels generate 25% more influence across covered states.",live:true},
        right:{id:"prime_time_rhetoric",name:"DEBATE PREP",desc:"Speech influence is 20% stronger during Debate Night.",live:true} },
      { left:{id:"cascade_effect",name:"POLICY CASCADE",desc:"District Office upgrades add +5 influence into nearby states.",live:true,ult:true},
        right:{id:"continuity_office",name:"SUCCESSION TRAP",desc:"Rivals who assassinate your leader suffer a 2-day blackout.",live:true,ult:true} },
    ]},
    machine: { name: "CINDER MACHINE", sub: "STRIKE APPARATUS", theme: "Punish enemy disruption, build faster, then convert labor pressure into map control.", tiers: [
      { left:{id:"picket_lines",name:"PICKET TAX",desc:"Rivals pay 25% more for DISRUPT office damage against you.",live:true},
        right:{id:"wildcat_cells",name:"WILDCAT CREWS",desc:"DISRUPT office damage resolves 35% faster.",live:true} },
      { left:{id:"assembly_line",name:"ASSEMBLY LINE",desc:"District Office deploy and upgrade timers complete 40% faster.",live:true},
        right:{id:"red_tape_trap",name:"PAPERWORK JAM",desc:"Your DISRUPT leaves states on 1 fewer day of cooldown.",live:true} },
      { left:{id:"strike_fund",name:"SEIZURE FUND",desc:"POWER GRAB costs 15% less.",live:true,ult:true},
        right:{id:"backlash_cells",name:"REVENUE LOCKOUT",desc:"Rivals that DISRUPT your Office lose cash flow from that state for 3 days.",live:true,ult:true} },
    ]},
    signal: { name: "TEAL WIRE ACCORD", sub: "SIGNAL CARTEL", theme: "DISRUPT feeds broadcasts; broadcasts feed influence; influence protects channels.", tiers: [
      { left:{id:"dark_fiber",name:"DARK FIBER",desc:"DISRUPT cash-siphon cost component is 25% lower.",live:true},
        right:{id:"signal_leak",name:"LEAKED SIGNAL",desc:"Successful DISRUPT or sabotage boosts your news channel influence by 25% for 1 day.",live:true} },
      { left:{id:"listening_posts",name:"LISTENING POSTS",desc:"Each police-guarded HQ or Office generates +0.5 local influence per day.",live:true},
        right:{id:"media_magnate",name:"COVERAGE STACK",desc:"Owned news channels push 40% more influence across covered states.",live:true} },
      { left:{id:"trend_engine",name:"TREND ENGINE",desc:"Owned channels push 15% more influence and earn $2M/day each.",live:true,ult:true},
        right:{id:"broadcast_moat",name:"BROADCAST MOAT",desc:"Rivals pay 100% more to take your owned news channels.",live:true,ult:true} },
    ]},
    ledger: { name: "IVORY LEDGER CLUB", sub: "BUDGET COMMITTEE", theme: "Efficient paperwork stabilizes money, then turns procedure into demolition.", tiers: [
      { left:{id:"compliance_forms",name:"OPENING GRANT",desc:"Starting a District Office grants +5 local influence immediately.",live:true},
        right:{id:"rainy_day_fund",name:"RAINY DAY FUND",desc:"When cash is below $5M, your Main Base generates +$1M/day.",live:true} },
      { left:{id:"permit_stack",name:"CAPITAL PERMITS",desc:"Main Base upgrades cost 20% less cash.",live:true},
        right:{id:"media_retainer",name:"MEDIA RETAINER",desc:"News channel buys and takeovers cost 25% less.",live:true} },
      { left:{id:"budget_surplus",name:"BUDGET SURPLUS",desc:"Main Base passive cash output rises by 25% at every HQ level.",live:true,ult:true},
        right:{id:"double_demolition",name:"AUDIT DEMOLITION",desc:"DISRUPT removes 2 Office levels. Police pay double to block it.",live:true,ult:true} },
    ]},
  };

  const HQ_INCOME_DAY = [0, 660, 1650, 3850];
  const HQ_UPGRADE = { 2: { cash: 9000, infl: 15, days: 2 }, 3: { cash: 60000, infl: 60, days: 4 } };
  const TALENT_REQ_LEVEL = [1, 2, 3];
  const TALENT_DRAFT_SECONDS = 10;
  const TALENT_DRAFT_CHOICES = 4;
  const TALENT_TIER_LABELS = ["Tier 1", "Tier 2", "Tier 3"];
  const TALENT_CARD_LIBRARY = Object.entries(TALENTS).flatMap(([treeId, tree]) =>
    tree.tiers.flatMap((tier, tierIndex) =>
      ["left", "right"].map((side) => ({
        ...tier[side],
        treeId,
        treeName: tree.name,
        treeSub: tree.sub,
        treeTheme: tree.theme,
        tierIndex,
        tierLevel: TALENT_REQ_LEVEL[tierIndex],
        sourceSide: side,
      }))
    )
  );
  const TALENT_ART_INDEX_BY_ID = {
    aggressive_portfolio: 1,
    hostile_liquidation: 2,
    rapid_construction: 3,
    private_security: 4,
    shadow_lobbying: 0,
    executive_immunity: 5,

    echo_chamber: 0,
    crowdsourcing: 1,
    general_strike: 3,
    human_shield: 2,
    great_awakening: 4,
    decentralized_hive: 5,

    system_overclock: 0,
    signal_scrambler: 1,
    backdoor_exploits: 2,
    ghost_servers: 3,
    skynet_protocol: 4,
    blackout_bypass: 5,

    fortified_outposts: 0,
    martial_law_taxes: 1,
    bureaucratic_hold: 3,
    checkpoint_grid: 2,
    iron_curtain: 4,
    retributive_strike: 5,

    model_polling: 0,
    hype_train: 1,
    fast_track_zoning: 2,
    prime_time_rhetoric: 3,
    cascade_effect: 4,
    continuity_office: 5,

    picket_lines: 1,
    wildcat_cells: 4,
    assembly_line: 0,
    red_tape_trap: 2,
    strike_fund: 5,
    backlash_cells: 3,

    dark_fiber: 0,
    signal_leak: 1,
    listening_posts: 2,
    media_magnate: 3,
    trend_engine: 4,
    broadcast_moat: 5,

    compliance_forms: 3,
    rainy_day_fund: 0,
    permit_stack: 1,
    media_retainer: 2,
    budget_surplus: 4,
    double_demolition: 5,
  };
  TALENT_CARD_LIBRARY.forEach((talent) => {
    talent.artIndex = TALENT_ART_INDEX_BY_ID[talent.id] ?? (talent.tierIndex * 2 + (talent.sourceSide === "right" ? 1 : 0));
    talent.atlas = TALENT_ATLAS_BY_TREE[talent.treeId] || "";
  });
  const TALENT_CARDS_BY_TIER = TALENT_REQ_LEVEL.map((_, tierIndex) =>
    TALENT_CARD_LIBRARY.filter((talent) => talent.tierIndex === tierIndex)
  );
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
  let activeTalentDraft = null;
  let activeTalentDraftTimer = null;
  let talentDraftResolving = false;
  let activeTalentDraftRenderKey = "";
  let pendingHomeBaseStateIndex = -1;
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
    return Math.round(base * botActionDiscount(player));
  }

  function renderHomeBaseConfirmOverlay() {
    if (!homeBaseConfirmOverlay) return;
    const state = pendingHomeBaseStateIndex >= 0 ? states[pendingHomeBaseStateIndex] : null;
    if (!state || phase !== "base") {
      homeBaseConfirmOverlay.innerHTML = "";
      homeBaseConfirmOverlay.classList.remove("is-open");
      homeBaseConfirmOverlay.setAttribute("aria-hidden", "true");
      return;
    }
    homeBaseConfirmOverlay.innerHTML = `
      <div class="home-base-confirm-panel">
        <div class="home-base-confirm-kicker">HQ Deployment</div>
        <div class="home-base-confirm-title">Deploy HQ in ${escapeHtml(state.name)}?</div>
        <div class="home-base-confirm-copy">This locks in your campaign headquarters and starts your run from ${escapeHtml(state.abbr)}.</div>
        <div class="home-base-confirm-actions">
          <button class="secondary-button" type="button" data-home-base-confirm="cancel">Cancel</button>
          <button class="primary-button" type="button" data-home-base-confirm="confirm">Confirm Deploy</button>
        </div>
      </div>
    `;
    homeBaseConfirmOverlay.classList.add("is-open");
    homeBaseConfirmOverlay.setAttribute("aria-hidden", "false");
  }

  function talentCardById(id) {
    return TALENT_CARD_LIBRARY.find((talent) => talent.id === id) || null;
  }

  function chosenTalentCard(player, tierIndex) {
    if (!player || !player.talents) return null;
    const chosenId = player.talents[tierIndex];
    return typeof chosenId === "string" ? talentCardById(chosenId) : null;
  }

  function chosenTalentCards(player) {
    if (!player?.talents) return [];
    return Object.keys(player.talents)
      .map((key) => {
        const tierIndex = Number(key);
        const card = chosenTalentCard(player, tierIndex);
        return card ? { ...card, tierIndex, card } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.tierIndex - b.tierIndex || a.name.localeCompare(b.name));
  }

  function hasTalent(player, id) {
    if (!player || !player.talents) return false;
    if (chosenTalentCards(player).some((talent) => talent.id === id)) return true;
    if (!player.talentTree) return false;
    const tree = TALENTS[player.talentTree];
    if (!tree) return false;
    for (const t in player.talents) {
      const opt = tree.tiers[t] && tree.tiers[t][player.talents[t]];
      if (opt && opt.id === id) return true;
    }
    return false;
  }

  function tierNeedsTalentPick(player, tierIndex) {
    return !!player && tierUnlocked(tierIndex, player) && !chosenTalentCard(player, tierIndex);
  }

  function talentKeywordScore(talent, personalityId = "powerBroker") {
    const keywordWeights = {
      powerBroker: { cash: 3, income: 3, cost: 2, channel: 2, "power grab": 3, hq: 2 },
      grassroots: { speech: 3, influence: 3, office: 2, nearby: 2, passive: 1.5 },
      countyBuilder: { office: 3, upgrade: 3, police: 2.5, base: 2, deploy: 2 },
      spoiler: { disrupt: 3, assassination: 3, siphon: 2.5, blackout: 2, rival: 1.5 },
    };
    const weights = keywordWeights[personalityId] || keywordWeights.powerBroker;
    const text = `${talent.name} ${talent.desc}`.toLowerCase();
    return Object.entries(weights).reduce((sum, [keyword, weight]) => sum + (text.includes(keyword) ? weight : 0), Math.random() * 1.5);
  }

  function draftOptionsForTier(player, tierIndex, count = TALENT_DRAFT_CHOICES) {
    const pool = shuffle(TALENT_CARDS_BY_TIER[tierIndex] || []);
    const unique = [];
    const used = new Set(chosenTalentCards(player).map((talent) => talent.id));
    for (const talent of pool) {
      if (used.has(talent.id)) continue;
      unique.push(talent);
      if (unique.length >= count) break;
    }
    return unique;
  }

  function autoPickDraftTalent(player, options) {
    if (!player || !Array.isArray(options) || !options.length) return null;
    return options
      .slice()
      .sort((a, b) => talentKeywordScore(b, player.aiPersonality?.id) - talentKeywordScore(a, player.aiPersonality?.id))[0] || options[0];
  }
  function adHubCost(player) {
    return discountedCost(AD_HUB_COST * (hasTalent(player, "aggressive_portfolio") ? 0.8 : 1), player);
  }
  function mainBaseUpgradeCash(player, nextLevel) {
    const req = HQ_UPGRADE[nextLevel];
    if (!req) return 0;
    const overclockDiscount = hasTalent(player, "system_overclock") ? 0.8 : 1;
    return discountedCost(req.cash * (hasTalent(player, "permit_stack") ? 0.8 : 1) * overclockDiscount, player);
  }
  function officeLevel(state, playerId) {
    return Math.max(0, Number(state?.offices?.[playerId] || 0));
  }
  function districtOfficeCap(player) {
    return Math.max(0, Math.min(3, Number(player?.mainBaseLevel || 0))) * 10;
  }
  function districtOfficeCount(playerId) {
    return states.reduce((sum, state) => sum + (officeLevel(state, playerId) > 0 ? 1 : 0), 0);
  }
  function pendingDistrictOfficeCount(playerId) {
    return missions.filter((mission) => mission.type === "adDeploy" && mission.player === playerId).length;
  }
  function canBuildMoreDistrictOffices(player) {
    if (!player) return false;
    return districtOfficeCount(player.id) + pendingDistrictOfficeCount(player.id) < districtOfficeCap(player);
  }
  function policeAssignment(state, playerId) {
    const value = state?.police?.[playerId];
    if (value && typeof value === "object") return { hq: value.hq === true, office: value.office === true };
    // Older saves used one state-wide flag; preserve that protection on both buildings.
    return { hq: value === true, office: value === true };
  }
  function policeGuards(state, playerId, building) {
    if (worldEventActive("police_strike")) return false;
    return policeAssignment(state, playerId)[building] === true;
  }
  function setPoliceGuard(state, playerId, building, enabled) {
    const assignment = policeAssignment(state, playerId);
    assignment[building] = enabled === true;
    state.police[playerId] = assignment;
  }
  function hasAnyPoliceGuard(state, playerId) {
    const assignment = policeAssignment(state, playerId);
    return assignment.hq || assignment.office;
  }
  function miniBaseUpgradeReq(player, nextLevel) {
    const req = MINI_BASE_UPGRADE[nextLevel];
    if (!req) return null;
    const disasterSurcharge = worldEventActive("disaster_relief") ? 1.25 : 1;
    const inflationSurcharge = worldEventActive("inflation") ? 1.1 : 1;
    return {
      cash: discountedCost(req.cash * disasterSurcharge * inflationSurcharge * (hasTalent(player, "rapid_construction") ? 0.7 : 1) * (hasTalent(player, "system_overclock") ? 0.8 : 1), player),
      infl: Math.ceil(req.infl * (hasTalent(player, "system_overclock") ? 0.8 : 1)),
      days: req.days,
    };
  }
  function miniBaseCashDay(level) {
    return (MINI_BASE_CASH_DAY[Math.max(0, Math.min(MINI_BASE_MAX_LEVEL, level))] || 0) * 1.2;
  }
  function miniBaseDefense(level) {
    return MINI_BASE_DEFENSE[Math.max(0, Math.min(MINI_BASE_MAX_LEVEL, level))] || 0;
  }
  function constructionTime(player, seconds) {
    return seconds;
  }
  function districtOfficeBuildTime(player, seconds) {
    return constructionTime(player, seconds) * (hasTalent(player, "assembly_line") ? 0.6 : 1);
  }
  function policeUpkeepDay(player, state, building = "office") {
    if (!player || !state) return 0;
    if (worldEventActive("police_strike")) return 0;
    const maxElectoralVotes = Math.max(1, ...states.map((candidate) => Number(candidate.ev) || 0));
    const electoralCost = (Number(state.ev) || 0) / maxElectoralVotes * POLICE_MAX_STATE_BASE_DAY;
    const officeCost = building === "office" ? officeLevel(state, player.id) * POLICE_OFFICE_LEVEL_DAY : 0;
    const rawCost = Math.max(POLICE_MIN_STATE_DAY, electoralCost + officeCost);
    return Math.round(rawCost * 0.7 * (worldEventActive("inflation") ? 1.1 : 1) * (hasTalent(player, "private_security") ? 0.5 : 1));
  }
  function totalPoliceUpkeepDay(player) {
    if (!player) return 0;
    return states.reduce((total, state) => total
      + (policeGuards(state, player.id, "hq") ? policeUpkeepDay(player, state, "hq") : 0)
      + (policeGuards(state, player.id, "office") ? policeUpkeepDay(player, state, "office") : 0), 0);
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
  function policeUpkeepPerTick(player, dt) {
    return totalPoliceUpkeepDay(player) / CAMPAIGN_DAY_SECONDS * dt;
  }
  function policeAtRisk(player) {
    return !!player && projectedCashPerDay(player) < 0;
  }
  function removeRandomPoliceProtection(player) {
    if (!player) return null;
    const guarded = states.flatMap((state) => ["hq", "office"]
      .filter((building) => policeGuards(state, player.id, building))
      .map((building) => ({ state, building })));
    if (!guarded.length) return null;
    const picked = guarded[Math.floor(Math.random() * guarded.length)];
    setPoliceGuard(picked.state, player.id, picked.building, false);
    picked.state.activePulse = 1;
    return picked.state;
  }
  function riotCost(player, target = null) {
    const picketTax = target && hasTalent(target, "picket_lines") ? 1.25 : 1;
    const baseCost = Math.max(0, RIOT_COST - (hasTalent(player, "ghost_servers") ? 2000 : 0));
    return discountedCost(baseCost * (hasTalent(player, "general_strike") ? 0.5 : 1) * picketTax, player);
  }
  function guardedOperationTime(attacker, target, state, seconds) {
    if (target && state && policeGuards(state, target.id, "office") && hasTalent(target, "checkpoint_grid") && !hasTalent(attacker, "signal_scrambler")) {
      return seconds * 1.5;
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
    const baseCost = Math.max(0, base - (hasTalent(player, "ghost_servers") ? 2000 : 0));
    return discountedCost(baseCost * (hasTalent(player, "dark_fiber") ? 0.75 : 1), player);
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
    checkTalentDraftUnlocks(player);
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
        if (isMidStage() && st.ev >= MID_STAGE_MONEY_MIN_EV && st.ev <= MID_STAGE_MONEY_MAX_EV && inf >= 60) {
          daily += st.ev * MID_STAGE_MONEY_PER_EV_DAY;
        }
        if (level > 0 && hasTalent(player, "crowdsourcing")) daily *= 1 + (Math.floor(inf / 5) * 0.01);
        if ((level > 0 || player.homeBase === st.index) && hasAnyPoliceGuard(st, player.id) && hasTalent(player, "martial_law_taxes")) daily *= 1.15;
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
    let police = 0;
    for (const st of states) {
      if (st.cashFreeze?.[player.id] > 0) {
        if (policeGuards(st, player.id, "hq")) police += policeUpkeepDay(player, st, "hq");
        if (policeGuards(st, player.id, "office")) police += policeUpkeepDay(player, st, "office");
        continue;
      }
      const inf = st.influence[player.id];
      const level = officeLevel(st, player.id);
      if (inf > 0) {
        let daily = (1 + (st.ev || 8) * 0.05) * 90 * (inf / 100);
        if (isMidStage() && st.ev >= MID_STAGE_MONEY_MIN_EV && st.ev <= MID_STAGE_MONEY_MAX_EV && inf >= 60) {
          daily += st.ev * MID_STAGE_MONEY_PER_EV_DAY;
        }
        if (level > 0 && hasTalent(player, "crowdsourcing")) daily *= 1 + (Math.floor(inf / 5) * 0.01);
        if ((level > 0 || player.homeBase === st.index) && hasAnyPoliceGuard(st, player.id) && hasTalent(player, "martial_law_taxes")) daily *= 1.15;
        influence += daily;
      }
      offices += miniBaseCashDay(level);
      if (policeGuards(st, player.id, "hq")) police += policeUpkeepDay(player, st, "hq");
      if (policeGuards(st, player.id, "office")) police += policeUpkeepDay(player, st, "office");
    }
    if (hasTalent(player, "shadow_lobbying")) {
      influence *= 1.25;
      offices *= 1.25;
    }
    if (hasTalent(player, "trend_engine")) influence += channels.filter((channel) => channel.owner === player.id).length * 2000;
    const hq = hqIncomeDay(player);
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
    total -= totalPoliceUpkeepDay(player);
    return Math.round(total);
  }

  function formatPerDay(value) {
    const rounded = Math.round(value);
    const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "+";
    return `${sign}${formatMoney(Math.abs(rounded))}/day`;
  }

  function applyNationwideInfluencePenalty(player, amount) {
    if (!player || amount <= 0) return;
    states.forEach((state) => {
      const floor = influenceFloor(player, state);
      state.influence[player.id] = clampInfluenceForState(state, player.id, Math.max(floor, state.influence[player.id] - amount));
    });
  }

  function chargePoliceAssassinationBlock(defenders) {
    const fundedDefender = (defenders || []).find((candidate) => candidate.cash >= POLICE_ASSASSINATION_BLOCK_COST);
    if (!fundedDefender) return null;
    fundedDefender.cash -= POLICE_ASSASSINATION_BLOCK_COST;
    return fundedDefender;
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
    if (player.action?.type === "speech") {
      if (canSelfAssassinateForMuzzle(player, stateIndex)) return selfAssassinateForMuzzle(playerId, stateIndex);
      if (playerId === HUMAN) showToast(player.action.debateId
        ? "You cannot authorize an assassination during a debate."
        : "You cannot authorize an assassination while giving a speech.");
      return false;
    }
    const target = players.find((c) =>
      c.id !== playerId &&
      isSpeaking(c) &&
      canInterruptAction(c) &&
      (c.action.state === stateIndex || (c.action.decoyStates || []).includes(stateIndex))
    );
    if (!target) { if (playerId === HUMAN) showToast("Assassination requires a rival giving a SPEECH in this state."); return false; }
    const cost = assassinateCost(player, target);
    if (player.cash < cost) { if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " to authorize this."); return false; }
    player.cash -= cost;
    if ((target.action.decoyStates || []).includes(stateIndex)) {
      target.action.decoyStates = target.action.decoyStates.filter((decoyStateIndex) => decoyStateIndex !== stateIndex);
      state.activePulse = 1;
      addAlert(player.name + " struck a speech decoy for " + target.name + " in " + state.name + ". The assassination budget is gone.");
      if (playerId === HUMAN) showToast("DECOY HIT — assassination cost was not refunded.");
      return true;
    }
    const debateId = target.action.debateId;
    const threatenedSpeakers = debateId
      ? players.filter((candidate) => candidate.id !== playerId && candidate.action?.debateId === debateId && candidate.action.state === stateIndex)
      : [target];
    const policeDefenders = threatenedSpeakers.filter((candidate) => hasAnyPoliceGuard(state, candidate.id));
    const fundedDefender = chargePoliceAssassinationBlock(policeDefenders);
    if (fundedDefender) {
      state.activePulse = 1;
      addAlert(fundedDefender.name + "'s police blocked " + player.name + "'s assassination in " + state.name + " for " + formatMoney(POLICE_ASSASSINATION_BLOCK_COST) + ".");
      if (playerId === HUMAN) showToast("ASSASSINATION BLOCKED — the authorization cost was not refunded.");
      if (fundedDefender.id === HUMAN) showToast("POLICE INTERCEPT — assassination blocked for " + formatMoney(POLICE_ASSASSINATION_BLOCK_COST) + ".");
      return true;
    }
    policeDefenders.forEach((candidate) => {
      setPoliceGuard(state, candidate.id, "hq", false);
      setPoliceGuard(state, candidate.id, "office", false);
      addAlert(candidate.name + " could not fund the " + formatMoney(POLICE_ASSASSINATION_BLOCK_COST) + " assassination response in " + state.name + "; police withdrew.");
      if (candidate.id === HUMAN) showToast("Police withdrew in " + state.abbr + " — assassination response could not be funded.");
    });
    const victims = debateId
      ? players.filter((candidate) =>
        candidate.id !== playerId &&
        candidate.action?.type === "speech" &&
        candidate.action.debateId === debateId &&
        candidate.action.state === stateIndex
      )
      : [target];
    const debateMassacre = victims.length > 1;
    const casualties = victims.map((victim) => {
      const casualty = replaceDeadLeader(victim);
      victim.action = null;
      const blackoutDays = hasTalent(victim, "blackout_bypass") ? 0 : ASSASSINATE_BLACKOUT_DAYS;
      const targetStrip = ASSASSINATE_STRIP;
      victim.locked = Math.max(victim.locked, blackoutDays * CAMPAIGN_DAY_SECONDS);
      if (hasTalent(victim, "continuity_office")) {
        player.locked = Math.max(player.locked, 2 * CAMPAIGN_DAY_SECONDS);
        addAlert(victim.name + "'s Assassin's Curfew forced " + player.name + " into a 2-day campaign blackout.");
        if (playerId === HUMAN) showToast("ASSASSIN'S CURFEW — your campaign is blacked out for 2 days.");
      }
      states.forEach((campaignState) => {
        if (worldEventActive("martyrdom_cycle")) {
          grantFlatStateInfluence(campaignState, victim.id, targetStrip);
        } else {
          const floor = influenceFloor(victim, campaignState);
          campaignState.influence[victim.id] = clampInfluenceForState(campaignState, victim.id, Math.max(floor, campaignState.influence[victim.id] - targetStrip));
        }
      });
      return { victim, casualty, blackoutDays, targetStrip };
    });
    const assassinDay = Math.floor(campaignDaysElapsed());
    if (player.assassinDay !== assassinDay) {
      player.assassinDay = assassinDay;
      player.assassinationsToday = 0;
    }
    player.assassinationsToday += victims.length;
    const backlashStrip = debateMassacre
      ? ASSASSINATE_REPEAT_STRIP * 3
      : (player.assassinationsToday > 1 ? ASSASSINATE_REPEAT_STRIP : 0);
    if (backlashStrip > 0) {
      applyNationwideInfluencePenalty(player, backlashStrip);
      addAlert(player.name + " triggered " + (debateMassacre ? "a triple Debate Night backlash" : "a repeated-assassination backlash") + " (-" + backlashStrip + "% influence nationwide).");
      if (playerId === HUMAN) showToast((debateMassacre ? "TRIPLE BACKLASH" : "BACKLASH") + " — -" + backlashStrip + "% influence nationwide.");
    }
    state.activePulse = 1;
    latestAssassinationEvent = {
      id: ++assassinationEventCounter,
      assassinId: player.id,
      targetId: target.id,
      targetIds: victims.map((victim) => victim.id),
      debateMassacre,
      stateIndex,
      playAt: Date.now() + 800,
    };
    lastPresentedAssassinationEventId = latestAssassinationEvent.id;
    presentAssassinationEvent(latestAssassinationEvent);
    refreshTalentInterfaces();
    const casualtySummary = casualties.map(({ victim, casualty, blackoutDays }) =>
      casualty.oldLeader + " of " + victim.name + " was killed; " + casualty.newLeader + " takes over (" + blackoutDays + "-day blackout)"
    ).join(". ");
    broadcast(0, (debateMassacre ? "DEBATE NIGHT MASSACRE in " : "ASSASSINATION in ") + state.name + ": " + casualtySummary + ".");
    addAlert(player.name + " assassinated " + casualties.map(({ victim, casualty }) => casualty.oldLeader + " of " + victim.name).join(" and ") + " in " + state.name + (debateMassacre ? " and suffered a triple nationwide backlash." : "."));
    triggerClickbait("SIGNAL_SEVER", {
      player: playerId,
      target: target.id,
      state: stateIndex,
      stateName: state.name,
      factionName: player.name,
      opponentName: victims.map((victim) => victim.name).join(" and "),
      level: "EXTREME",
    });
    return true;
  }

  function canSelfAssassinateForMuzzle(player, stateIndex) {
    return !!player &&
      worldEventActive("anti_front_runner") &&
      player.action?.type === "speech" &&
      !player.action.debateId &&
      player.action.state === stateIndex &&
      canInterruptAction(player);
  }

  function selfAssassinateForMuzzle(playerId, stateIndex) {
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || !canSelfAssassinateForMuzzle(player, stateIndex)) return false;
    const casualty = replaceDeadLeader(player);
    player.action = null;
    const blackoutDays = hasTalent(player, "blackout_bypass") ? 0 : ASSASSINATE_BLACKOUT_DAYS;
    player.locked = Math.max(player.locked, blackoutDays * CAMPAIGN_DAY_SECONDS);
    let totalGain = 0;
    states.forEach((campaignState) => {
      totalGain += grantFlatStateInfluence(campaignState, player.id, 15);
    });
    state.activePulse = 1;
    latestAssassinationEvent = {
      id: ++assassinationEventCounter,
      assassinId: player.id,
      targetId: player.id,
      targetIds: [player.id],
      selfAssassination: true,
      stateIndex,
      playAt: Date.now() + 800,
    };
    lastPresentedAssassinationEventId = latestAssassinationEvent.id;
    presentAssassinationEvent(latestAssassinationEvent);
    refreshTalentInterfaces();
    addAlert(player.name + " self-assassinated under Martyr Protocol and gained +15 influence nationwide.");
    if (playerId === HUMAN) showToast("MARTYR PROTOCOL — +15 influence nationwide. New leader deployed.");
    broadcast(0, "MARTYR PROTOCOL in " + state.name + ": " + casualty.oldLeader + " was sacrificed; " + casualty.newLeader + " takes over. +" + Math.round(totalGain) + " total influence gained nationwide.");
    return true;
  }

  function sfxLevel(multiplier = 1) {
    if (!soundOn) return 0;
    return Math.max(0, Math.min(1.35, sfxVolume * multiplier));
  }

  function playVictorySfx() {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(sfxLevel(0.78), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 2.35);
    master.connect(ac.destination);

    [262, 330, 392, 523].forEach((frequency, index) => {
      const start = now + index * 0.2;
      const oscillator = ac.createOscillator();
      const gain = ac.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.58);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.62);
    });

    [523, 659, 784].forEach((frequency) => {
      const start = now + 0.82;
      const oscillator = ac.createOscillator();
      const gain = ac.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.35);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 1.4);
    });
  }

  function playDefeatSfx() {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(sfxLevel(0.82), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 2.45);
    master.connect(ac.destination);

    [392, 330, 262, 196].forEach((frequency, index) => {
      const start = now + index * 0.28;
      const oscillator = ac.createOscillator();
      const gain = ac.createGain();
      oscillator.type = index < 2 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.94, start + 0.62);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.72);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.75);
    });

    const lowNote = ac.createOscillator();
    const lowGain = ac.createGain();
    lowNote.type = "sine";
    lowNote.frequency.setValueAtTime(92, now + 0.82);
    lowNote.frequency.exponentialRampToValueAtTime(58, now + 2.15);
    lowGain.gain.setValueAtTime(0.0001, now + 0.82);
    lowGain.gain.exponentialRampToValueAtTime(0.24, now + 0.88);
    lowGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
    lowNote.connect(lowGain);
    lowGain.connect(master);
    lowNote.start(now + 0.82);
    lowNote.stop(now + 2.22);
  }

  function playDebateBellSfx() {
    if (!soundOn || sfxVolume <= 0) return;
    if (!debateBellAudio) {
      debateBellAudio = new Audio("debate-night-bell.mp3");
      debateBellAudio.preload = "auto";
    }
    debateBellAudio.pause();
    debateBellAudio.currentTime = 0;
    debateBellAudio.volume = Math.max(0, Math.min(1, sfxVolume * 0.6));
    debateBellAudio.play().catch(() => {});
  }

  function presentDebateEvent(event) {
    const delay = Math.max(0, Number(event?.playAt || Date.now()) - Date.now());
    window.setTimeout(playDebateBellSfx, Math.min(delay, 1200));
  }

  function playDebateLossBooSfx() {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(sfxLevel(0.72), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 2.1);
    master.connect(ac.destination);

    [126, 139, 151, 164, 178].forEach((frequency, index) => {
      const start = now + index * 0.055;
      const voice = ac.createOscillator();
      const gain = ac.createGain();
      voice.type = index % 2 ? "sawtooth" : "triangle";
      voice.frequency.setValueAtTime(frequency, start);
      voice.frequency.exponentialRampToValueAtTime(frequency * 0.62, start + 1.45);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.075, start + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.65);
      voice.connect(gain);
      gain.connect(master);
      voice.start(start);
      voice.stop(start + 1.7);
    });

    const noise = ac.createBufferSource();
    const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * 1.7), ac.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) samples[index] = (Math.random() * 2 - 1) * (1 - index / samples.length);
    const filter = ac.createBiquadFilter();
    const noiseGain = ac.createGain();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(420, now);
    filter.Q.value = 0.7;
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.12, now + 0.12);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.7);
    noise.buffer = buffer;
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(now);
  }

  function playDebateWinnerApplauseSfx() {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(sfxLevel(0.68), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 2.25);
    master.connect(ac.destination);

    for (let index = 0; index < 22; index += 1) {
      const start = now + index * 0.075 + Math.random() * 0.045;
      const duration = 0.045 + Math.random() * 0.055;
      const source = ac.createBufferSource();
      const buffer = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * duration)), ac.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let sample = 0; sample < samples.length; sample += 1) {
        const envelope = Math.sin(Math.PI * sample / samples.length);
        samples[sample] = (Math.random() * 2 - 1) * envelope;
      }
      const filter = ac.createBiquadFilter();
      const gain = ac.createGain();
      filter.type = "bandpass";
      filter.frequency.value = 950 + Math.random() * 1150;
      filter.Q.value = 0.7;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22 + Math.random() * 0.12, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.buffer = buffer;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(start);
    }
  }

  function presentDebateResultEvent(event) {
    const localId = localCandidateId();
    if (Number(event?.winnerId) === localId) {
      playDebateWinnerApplauseSfx();
      return;
    }
    const losers = Array.isArray(event?.loserIds) ? event.loserIds.map(Number) : [];
    if (!losers.includes(localId)) return;
    const delay = Math.max(0, Number(event?.playAt || Date.now()) - Date.now());
    window.setTimeout(playDebateLossBooSfx, Math.min(delay, 800));
  }

  function playAssassinationSfx(kind) {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const vol = sfxLevel(1.35);
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

  function playTalentDraftPickSfx() {
    if (!soundOn || sfxVolume <= 0) return;
    ensureAudio();
    const ac = audioContext;
    if (!ac || ac.state === "suspended") return;
    const now = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(sfxLevel(0.58), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.92);
    master.connect(ac.destination);

    const lead = ac.createOscillator();
    const leadGain = ac.createGain();
    lead.type = "triangle";
    lead.frequency.setValueAtTime(392, now);
    lead.frequency.exponentialRampToValueAtTime(587.33, now + 0.16);
    leadGain.gain.setValueAtTime(0.0001, now);
    leadGain.gain.linearRampToValueAtTime(0.13, now + 0.018);
    leadGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    lead.connect(leadGain).connect(master);
    lead.start(now);
    lead.stop(now + 0.32);

    const sparkle = ac.createOscillator();
    const sparkleGain = ac.createGain();
    sparkle.type = "sine";
    sparkle.frequency.setValueAtTime(783.99, now + 0.1);
    sparkle.frequency.exponentialRampToValueAtTime(1046.5, now + 0.26);
    sparkleGain.gain.setValueAtTime(0.0001, now + 0.1);
    sparkleGain.gain.linearRampToValueAtTime(0.07, now + 0.13);
    sparkleGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    sparkle.connect(sparkleGain).connect(master);
    sparkle.start(now + 0.1);
    sparkle.stop(now + 0.46);
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
    const vol = sfxLevel();
    const t = ac.currentTime;
    if (kind === "tab") {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(420, t);
      o.frequency.exponentialRampToValueAtTime(280, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.11 * vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.2);
      const chime = ac.createOscillator(), chimeGain = ac.createGain();
      chime.type = "triangle";
      chime.frequency.setValueAtTime(560, t + 0.035);
      chimeGain.gain.setValueAtTime(0.0001, t + 0.035);
      chimeGain.gain.linearRampToValueAtTime(0.055 * vol, t + 0.05);
      chimeGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      chime.connect(chimeGain).connect(ac.destination);
      chime.start(t + 0.035);
      chime.stop(t + 0.18);
    } else if (kind === "clunk") {
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
    const svg = String(className || "").includes("leader-portrait-mini")
      ? leaderPortraitMiniSvg(factionIndex, profile)
      : leaderPortraitSvg(factionIndex, profile);
    return `<span class="${className}" style="--party:${player.color};--skin:${skin};--hair:${palette.hair};--suit:${palette.suit};--accent:${palette.accent};display:block;overflow:hidden">${svg}</span>`;
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
      '<div class="victory-actions">' +
      '<button class="primary-button victory-menu" type="button" data-victory-menu>Return to Lobby Menu</button>' +
      '<button class="secondary-button victory-close" type="button" data-victory-close>Close Results</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(victoryEl);
    victoryEl.addEventListener("click", (event) => {
      if (event.target.closest("[data-victory-menu]")) {
        returnToLobbyMenu();
        return;
      }
      if (event.target === victoryEl || event.target.closest("[data-victory-close]")) {
        victoryEl.classList.remove("is-open");
      }
    });
  }

  function returnToLobbyMenu() {
    victoryPresentationToken += 1;
    if (window.isServerLobbyHost && currentLobby?.id) leaveHostedServerLobby();
    else {
      try { getCrazyGameSdk()?.leftRoom?.(); } catch {}
    }
    stopServerGameSync();
    stopServerLobbyPolling();
    stopServerLobbyHeartbeat();
    stopPublicLobbyPolling();
    if (serverLobbyPlayerUpdateTimer) window.clearTimeout(serverLobbyPlayerUpdateTimer);
    serverLobbyPlayerUpdateTimer = null;
    gameStarted = false;
    loopStarted = false;
    paused = false;
    matchOver = false;
    settingsOpen = false;
    localPauseRequested = false;
    currentLobby = null;
    currentPlayerId = Math.random().toString(36).substr(2, 9);
    window.isJoiner = false;
    window.isServerLobbyHost = false;
    window.lobbySettings = null;
    window.playerReadyStatus = {};
    multiplayerState.localReady = false;
    multiplayerState.countdown = 0;
    multiplayerState.host = false;
    multiplayerState.enabled = false;
    if (victoryEl) victoryEl.classList.remove("is-open");
    if (assassinationOverlay) assassinationOverlay.classList.remove("is-on");
    if (assassinationStartTimer) window.clearTimeout(assassinationStartTimer);
    assassinationStartTimer = null;
    if (assassinationTimer) window.clearTimeout(assassinationTimer);
    assassinationTimer = null;
    if (powerGrabOverlay) powerGrabOverlay.classList.remove("is-on");
    if (powerGrabStartTimer) window.clearTimeout(powerGrabStartTimer);
    powerGrabStartTimer = null;
    if (powerGrabTimer) window.clearTimeout(powerGrabTimer);
    powerGrabTimer = null;
    if (pauseOverlay) pauseOverlay.classList.remove("is-visible", "is-settings");
    document.getElementById("waitScreenFull")?.remove();
    document.getElementById("hostScreen")?.remove();
    document.getElementById("codeScreen")?.remove();
    document.getElementById("joinedLobbyScreen")?.remove();
    mainMenu.classList.add("is-hidden");
    mainMenu.style.display = "none";
    mainMenu.style.visibility = "hidden";
    gameShell.classList.remove("is-hidden");
    gameShell.style.display = "block";
    gameShell.style.visibility = "visible";
    resultBgm = "";
    transitionBgm("menu", 0.8);
    showLobbyInterface();
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
    const presentationToken = ++victoryPresentationToken;
    const startedAt = performance.now();
    const duration = 3600;
    const tick = (now) => {
      if (presentationToken !== victoryPresentationToken) return;
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
      window.setTimeout(() => {
        if (presentationToken === victoryPresentationToken) showVictoryScreen(winner, reason);
      }, 850);
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
      "PROJECTED FUNDING: ~" + formatMoney(fund) + "/day" +
      '<div class="pip-inline-actions">' +
      '<button class="primary-button pip-inline-button" type="button" data-pip-action="upgrade-hq"' +
      ((nextHq && !hqUpgradeBusy && human.cash >= hqReq.cash && homeInfluence >= hqInfluenceReq) ? '' : ' disabled') + '>' +
      (!hqUnlocked
        ? 'SELECT HOME BASE FIRST'
        : nextHq
        ? (hqUpgradeBusy ? 'HQ UPGRADE UNDERWAY' : ('UPGRADE HQ TO L' + nextHq))
        : 'HQ MAXED') +
      '</button></div>';
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
    pipSfx("tab");
    renderPip();
  }
  function closePip() {
    pipOpen = false;
    pipHoverKey = "";
    if (pipEl) pipEl.classList.remove("is-open");
    document.body.classList.remove("pip-active");
    pipSfx("tab");
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
    if (e.key === "Tab") {
      e.preventDefault();
      if (rivalTalentPlayerId === HUMAN) closeRivalTalentViewer();
      else inspectLeaderPortrait(HUMAN);
      return;
    }
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
  const SABOTAGE_COST = 10000;
  const SABOTAGE_FREEZE_DAYS = 1;
  const SABOTAGE_STATE_COOLDOWN_DAYS = 3;
  const DISRUPT_COOLDOWN_DAYS = 1;
  const SABOTAGE_SECONDS = 6;
  const RIOT_COST = 8000;
  const RIOT_SECONDS = 10;
  const DISRUPT_COST = 10000;
  const DISRUPT_STEAL_PER_PARTY = 3000;
  const OFFICE_SLOW_COST = 6000;
  const OFFICE_SLOW_DAYS = 3;
  const OFFICE_SLOW_COOLDOWN_DAYS = 2;
  const POWER_GRAB_BASE_COST = 2000;
  const POWER_GRAB_COST_PER_EV = 1000;
  const POLICE_RIOT_BLOCK_COST = 350;
  const POLICE_ASSASSINATION_BLOCK_COST = 3500;
  const POLICE_MAX_STATE_BASE_DAY = 7000;
  const POLICE_OFFICE_LEVEL_DAY = 1000;
  const POLICE_MIN_STATE_DAY = 500;
  const POLICE_OUTREACH_INFLUENCE_DAY = 0.5;

  function operationLimit(player) {
    return hasTalent(player, "ghost_servers") ? 3 : 1;
  }

  function activeDisruptionOps(playerId) {
    return missions.filter((mission) =>
      mission.player === playerId &&
      (mission.type === "sabotage" || mission.type === "riot" || mission.type === "disrupt")
    ).length;
  }

  function canStartDisruptionOp(player, playerId) {
    return activeDisruptionOps(playerId) < operationLimit(player);
  }

  function sabotageCashStealRate(influence) {
    if (influence >= 60) return 0.06;
    if (influence >= 30) return 0.04;
    return 0.02;
  }

  function disruptTargetsForState(playerId, state) {
    if (!state) return [];
    return players.filter((candidate) =>
      candidate.id !== playerId &&
      candidate.id >= 0 &&
      (officeLevel(state, candidate.id) > 0 || candidate.homeBase === state.index)
    );
  }

  function disruptCostParts(player, targetOrTargets = null) {
    const targets = Array.isArray(targetOrTargets)
      ? targetOrTargets
      : (targetOrTargets ? [targetOrTargets] : []);
    const picketTax = targets.some((target) => hasTalent(target, "picket_lines")) ? 1.25 : 1;
    const ghostDiscountPerHalf = hasTalent(player, "ghost_servers") ? 1000 : 0;
    const cashSiphon = Math.max(0, DISRUPT_COST / 2 * (hasTalent(player, "dark_fiber") ? 0.75 : 1) - ghostDiscountPerHalf);
    const officeDamage = Math.max(0, DISRUPT_COST / 2 * (hasTalent(player, "general_strike") ? 0.5 : 1) * picketTax - ghostDiscountPerHalf);
    const discountedCashSiphon = Math.round(discountedCost(cashSiphon, player) * 0.7);
    const discountedOfficeDamage = Math.round(discountedCost(officeDamage, player) * 0.7);
    return {
      cashSiphon: discountedCashSiphon,
      officeDamage: discountedOfficeDamage,
      total: discountedCashSiphon + discountedOfficeDamage,
    };
  }

  function disruptCost(player, target = null) {
    return disruptCostParts(player, target).total;
  }

  function disrupt(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('disrupt', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || paused || matchOver || !canUseCampaignActions(player, playerId)) return false;
    if (!canStartDisruptionOp(player, playerId)) {
      if (playerId === HUMAN) showToast("Operation limit reached (" + activeDisruptionOps(playerId) + "/" + operationLimit(player) + ").");
      return false;
    }
    if ((player.disruptCooldown || 0) > 0) {
      if (playerId === HUMAN) showToast(`DISRUPT cooldown: ${campaignDaysLabel(player.disruptCooldown)} remaining.`);
      return false;
    }
    const targets = disruptTargetsForState(playerId, state);
    if (!targets.length) {
      if (playerId === HUMAN) showToast("DISRUPT requires a rival District Office or HQ in this state.");
      return false;
    }
    const costParts = disruptCostParts(player, targets);
    const cost = costParts.total;
    if (player.cash < cost) {
      if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " for a combined disruption.");
      return false;
    }
    const riotPortion = costParts.officeDamage;
    const seconds = Math.max(...targets.map((target) =>
      Math.max(guardedOperationTime(player, target, state, SABOTAGE_SECONDS), riotTime(player, target, state))
    ));
    player.cash -= cost;
    missions.push({
      type: "disrupt",
      player: playerId,
      target: targets[0].id,
      targets: targets.map((target) => target.id),
      state: stateIndex,
      cost: riotPortion,
      left: seconds,
      total: seconds,
    });
    player.disruptCooldown = DISRUPT_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS;
    state.activePulse = 1;
    const targetNames = targets.map((target) => target.name).join(", ");
    addAlert(player.name + " launched a state-wide DISRUPT against " + targetNames + " in " + state.name + ".");
    triggerClickbait("INCITE_STRIKE", { player: playerId, target: targets[0].id, state: stateIndex, stateName: state.name, factionName: player.name, opponentName: targetNames });
    return true;
  }

  function slowDistrictOffices(playerId, targetPlayerId) {
    if (playerId === HUMAN && routeGuestGameCommand('slowDistrictOffices', [targetPlayerId])) return true;
    const player = players[playerId];
    const target = players[targetPlayerId];
    if (!player || !target || phase !== "play" || paused || matchOver || !canUseCampaignActions(player, playerId)) return false;
    if (target.id === player.id) {
      if (playerId === HUMAN) showToast("Pick a rival leader for District Jam.");
      return false;
    }
    if ((player.officeSlowCooldown || 0) > 0) {
      if (playerId === HUMAN) showToast(`DISTRICT JAM cooldown: ${campaignDaysLabel(player.officeSlowCooldown)} remaining.`);
      return false;
    }
    if (player.cash < OFFICE_SLOW_COST) {
      if (playerId === HUMAN) showToast("Need " + formatMoney(OFFICE_SLOW_COST) + " to jam District Offices.");
      return false;
    }
    const officeCount = districtOfficeCount(target.id);
    if (officeCount <= 0) {
      if (playerId === HUMAN) showToast(target.name + " has no District Offices to slow.");
      return false;
    }
    player.cash -= OFFICE_SLOW_COST;
    player.officeSlowCooldown = OFFICE_SLOW_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS;
    target.officeInfluenceSlow = Math.max(Number(target.officeInfluenceSlow || 0), OFFICE_SLOW_DAYS * CAMPAIGN_DAY_SECONDS);
    addAlert(player.name + " jammed " + target.name + "'s District Office influence for " + OFFICE_SLOW_DAYS + " days.");
    if (playerId === HUMAN) showToast("DISTRICT JAM — " + target.name + "'s office influence slowed for " + OFFICE_SLOW_DAYS + " days.");
    if (target.id === HUMAN) showToast("Your District Office influence is slowed for " + OFFICE_SLOW_DAYS + " days.");
    broadcast(0, "DISTRICT JAM: " + target.name + "'s District Office influence is slowed nationwide for " + OFFICE_SLOW_DAYS + " days.");
    return true;
  }

  function powerGrabCost(player, state) {
    if (!state) return null;
    const strikeFundDiscount = hasTalent(player, "strike_fund") ? 0.85 : 1;
    return Math.round(discountedCost(POWER_GRAB_BASE_COST + Math.max(0, Number(state.ev) || 0) * POWER_GRAB_COST_PER_EV, player) * strikeFundDiscount * 0.7);
  }

  function grantFlatStateInfluence(state, playerId, amount) {
    const current = adjustedInfluence(state, playerId);
    const cap = influenceCap(state, playerId);
    const gain = Math.min(amount, cap - current);
    if (gain <= 0) return 0;
    let remaining = gain;
    remaining -= Math.min(remaining, undecidedInfluence(state));
    const rivals = players
      .filter((candidate) => candidate.id !== playerId)
      .sort((a, b) => adjustedInfluence(state, b.id) - adjustedInfluence(state, a.id));
    for (const rival of rivals) {
      if (remaining <= 0) break;
      const taken = Math.min(remaining, adjustedInfluence(state, rival.id));
      state.influence[rival.id] = clampInfluenceForState(state, rival.id, adjustedInfluence(state, rival.id) - taken);
      remaining -= taken;
    }
    const applied = gain - Math.max(0, remaining);
    state.influence[playerId] = clampInfluenceForState(state, playerId, current + applied);
    return applied;
  }

  function powerGrab(playerId, stateIndex) {
    if (playerId === HUMAN && routeGuestGameCommand('powerGrab', [stateIndex])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || paused || matchOver || !canUseCampaignActions(player, playerId)) return false;
    const cost = powerGrabCost(player, state);
    if (player.cash < cost) {
      if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " for a " + state.ev + " EV power grab.");
      return false;
    }
    if (adjustedInfluence(state, playerId) >= influenceCap(state, playerId)) {
      if (playerId === HUMAN) showToast("You already have max influence in " + state.abbr + ".");
      return false;
    }
    player.cash -= cost;
    const grabAmount = (hasTalent(player, "decentralized_hive") ? 30 : 20) * (worldEventActive("reckless_power_grab") ? 1.1 : 1);
    const gained = grantFlatStateInfluence(state, playerId, grabAmount);
    let backlashStates = [];
    if (worldEventActive("reckless_power_grab")) {
      backlashStates = shuffle(states.filter((candidate) => candidate.index !== state.index && adjustedInfluence(candidate, playerId) > 0)).slice(0, 2);
      backlashStates.forEach((candidate) => {
        candidate.influence[playerId] = clampInfluenceForState(candidate, playerId, Math.max(influenceFloor(player, candidate), adjustedInfluence(candidate, playerId) - 5));
        candidate.activePulse = 1;
      });
    }
    state.activePulse = 1;
    powerGrabEventCounter = Math.max(powerGrabEventCounter, Number(latestPowerGrabEvent?.id || 0)) + 1;
    latestPowerGrabEvent = {
      id: powerGrabEventCounter,
      playerId: player.id,
      stateIndex,
      gained: Math.round(gained),
      playAt: Date.now() + 800,
    };
    lastPresentedPowerGrabEventId = latestPowerGrabEvent.id;
    presentPowerGrabEvent(latestPowerGrabEvent);
    addAlert(player.name + " executed a power grab in " + state.name + " for +" + Math.round(gained) + "% influence at a cost of " + formatMoney(cost) + (backlashStates.length ? " Reckless blowback hit " + backlashStates.map((candidate) => candidate.abbr).join(", ") + "." : "."));
    if (playerId === HUMAN) showToast("POWER GRAB: +" + Math.round(gained) + "% in " + state.abbr + " for " + formatMoney(cost) + ".");
    triggerClickbait("MINDSHARE_CAST", { player: playerId, state: stateIndex, stateName: state.name, factionName: player.name, level: "EXTREME" });
    return true;
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
    const leaderId = leadingPlayer(stateIndex);
    const target = leaderId >= 0 ? players[leaderId] : null;
    if (!target || target.id === playerId) {
      if (playerId === HUMAN) showToast("Sabotage can only target the rival currently leading this state.");
      return false;
    }
    if (officeLevel(state, target.id) <= 0 && target.homeBase !== stateIndex) {
      if (playerId === HUMAN) showToast("The leading rival has no structure in this state to sabotage.");
      return false;
    }
    const cost = sabotageCost(player, SABOTAGE_COST);
    if (player.cash < cost) { if (playerId === HUMAN) showToast("Need " + formatMoney(cost) + " for a sabotage op."); return false; }
    const officeUpgradeMission = hasTalent(player, "backdoor_exploits")
      ? missions.find((mission) =>
        mission.type === "officeUpgrade" &&
        mission.state === stateIndex &&
        mission.player === target.id
      )
      : null;
    const backdoor = !!officeUpgradeMission;
    const freeze = !backdoor && target.homeBase === stateIndex && missions.some((mission) => mission.type === "baseUpgrade" && mission.player === target.id);
    const targetInfluence = adjustedInfluence(state, target.id);
    const siphonRate = sabotageCashStealRate(targetInfluence);
    player.cash -= cost;
    const seconds = guardedOperationTime(player, target, state, SABOTAGE_SECONDS);
    missions.push({ type: "sabotage", player: playerId, target: target.id, state: stateIndex, backdoor, freeze, targetInfluence, siphonRate, left: seconds, total: seconds });
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
    if (hasTalent(target, "iron_curtain") && target.homeBase === state.index && target.mainBaseLevel >= 3) {
      addAlert(player.name + "'s siphon attempt bounced off " + target.name + "'s Influence Fortress in " + state.name + ".");
      if (player.id === HUMAN) showToast("Influence Fortress blocks siphoning in this Level 3 base state.");
      return;
    }
    if (policeGuards(state, target.id, "office") && !hasTalent(player, "signal_scrambler")) {
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
      const siphonRate = Number(mission.siphonRate) || sabotageCashStealRate(Number(mission.targetInfluence) || 0);
      const siphon = Math.min(target.cash, Math.round(target.cash * siphonRate * (hasTalent(player, "hostile_liquidation") ? 1.5 : 1)));
      target.cash -= siphon;
      player.cash += siphon;
      addAlert(player.name + " siphoned " + formatMoney(siphon) + " (" + Math.round(siphonRate * 100) + "% at " + Math.round(mission.targetInfluence || 0) + "% state influence) from " + target.name + "'s war chest in " + state.name + ".");
      if (player.id === HUMAN) showToast("Sabotage landed: stole " + formatMoney(siphon) + " (" + Math.round(siphonRate * 100) + "%) from " + target.name + ".");
      triggerClickbait("BACKDOOR_HACK", {
        player: player.id,
        target: target.id,
        state: state.index,
        stateName: state.name,
        factionName: player.name,
        opponentName: target.name,
        cashValue: siphon,
      });
    }
    if (hasTalent(player, "signal_leak")) {
      player.signalLeakBoost = Math.max(player.signalLeakBoost || 0, CAMPAIGN_DAY_SECONDS);
      addAlert(player.name + "'s Broadcast Surge boosted owned news channels for 1 day.");
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
    });
    return true;
  }

  function togglePolice(playerId, stateIndex, building = "office") {
    building = building === "hq" ? "hq" : "office";
    if (playerId === HUMAN && routeGuestGameCommand('togglePolice', [stateIndex, building])) return true;
    const player = players[playerId];
    const state = states[stateIndex];
    if (!player || !state || phase !== "play" || matchOver || !canUseCampaignActions(player, playerId)) return false;
    if (building === "hq" && player.homeBase !== stateIndex) return false;
    if (building === "office" && officeLevel(state, playerId) <= 0) return false;
    const enabled = !policeGuards(state, playerId, building);
    setPoliceGuard(state, playerId, building, enabled);
    const buildingLabel = building === "hq" ? "HQ" : "District Office";
    addAlert(player.name + (enabled ? " deployed police to " : " pulled police from ") + buildingLabel + " in " + state.name + (enabled ? " (" + formatMoney(policeUpkeepDay(player, state, building)) + "/day upkeep)." : "."));
    if (playerId === HUMAN) {
      showToast(enabled
        ? "Police deployed on " + buildingLabel + " in " + state.abbr + " for " + formatMoney(policeUpkeepDay(player, state, building)) + "/day."
        : "Police removed from " + buildingLabel + " in " + state.abbr + ".");
    }
    if (enabled) {
      triggerClickbait("ENFORCER_PATROL", {
        player: playerId,
        state: stateIndex,
        stateName: state.name,
        factionName: player.name,
        level: "MEDIUM",
      });
    }
    state.activePulse = 1;
    return true;
  }

  function executeArmed(stateIndex, building = null) {
    const a = armedAction;
    clearArmed();
    if (a === "deployMiniBase") placeAdHub(HUMAN, stateIndex);
    else if (a === "publicSpeech") startAction(HUMAN, "speech", stateIndex);
    else if (a === "disrupt") disrupt(HUMAN, stateIndex);
    else if (a === "powerGrab") powerGrab(HUMAN, stateIndex);
    else if (a === "togglePolice") togglePolice(HUMAN, stateIndex, building || "office");
    else if (a === "assassinate") assassinate(HUMAN, stateIndex);
    if (typeof updateUi === "function") updateUi(true);
  }
  function executeLeaderArmed(targetPlayerId) {
    const a = armedAction;
    clearArmed();
    if (a === "officeSlow") {
      if (targetPlayerId === HUMAN) showToast("Pick a rival leader for District Jam.");
      else slowDistrictOffices(HUMAN, targetPlayerId);
    }
    if (typeof updateUi === "function") updateUi(true);
  }
  function clearArmed() {
    armedAction = null;
    const b = document.getElementById("hotBanner");
    if (b) b.classList.remove("is-on");
    refreshHotbar();
  }

  function updateArmedTargetBanner(stateIndex = -1) {
    const banner = document.getElementById("hotBanner");
    if (!banner || !armedAction) return;
    const human = players[HUMAN];
    const hoveredOffice = hitMiniBase(mouseCanvas, HUMAN);
    const hoveredHq = hitMainBase(mouseCanvas, HUMAN);
    if (armedAction === "deployMiniBase") {
      if (hoveredOffice && human) {
        const state = states[hoveredOffice.state];
        const nextLevel = hoveredOffice.level + 1;
        const req = nextLevel <= MINI_BASE_MAX_LEVEL ? miniBaseUpgradeReq(human, nextLevel) : null;
        banner.textContent = nextLevel > human.mainBaseLevel
          ? "\u25B6 " + state.abbr + " OFFICE L" + nextLevel + " \u2014 REQUIRES HQ LEVEL " + nextLevel
          : req
          ? "\u25B6 UPGRADE " + state.abbr + " OFFICE TO L" + nextLevel + " \u2014 COST " + formatMoney(req.cash) + " + " + req.infl + "% INFLUENCE \u2014 click to confirm"
          : "\u25B6 " + state.abbr + " DISTRICT OFFICE \u2014 MAX LEVEL";
      } else {
        const state = states[stateIndex];
        banner.textContent = state
          ? "\u25B6 DISTRICT OFFICE \u2014 " + state.abbr + " \u00B7 BUILD COST " + formatMoney(adHubCost(human)) + " \u2014 click empty state to build"
          : "\u25B6 DISTRICT OFFICE ARMED \u2014 click an empty state to build, or your office icon to upgrade";
      }
      return;
    }
    if (armedAction === "officeSlow") {
      banner.textContent = "\u25B6 DISTRICT JAM \u2014 click a rival leader portrait top-right \u00B7 COST " + formatMoney(OFFICE_SLOW_COST) + " \u00B7 2d cooldown";
      return;
    }
    if (armedAction === "powerGrab") {
      const state = states[stateIndex];
      const cost = state && human ? powerGrabCost(human, state) : null;
      banner.textContent = state
        ? "\u25B6 POWER GRAB \u2014 " + state.abbr + " \u00B7 " + state.ev + " EV \u00B7 COST " + formatMoney(cost || 0) + " \u2014 click to execute"
        : "\u25B6 POWER GRAB ARMED \u2014 hover a state to inspect its electoral value, then click to execute (ESC to cancel)";
      return;
    }
    if (armedAction === "togglePolice") {
      const target = hoveredOffice
        ? { stateIndex: hoveredOffice.state, building: "office", label: "DISTRICT OFFICE" }
        : hoveredHq
          ? { stateIndex: hoveredHq.state, building: "hq", label: "HQ" }
          : null;
      if (target && human) {
        const state = states[target.stateIndex];
        const guarded = policeGuards(state, HUMAN, target.building);
        const upkeep = formatMoney(policeUpkeepDay(human, state, target.building)) + "/DAY";
        banner.textContent = guarded
          ? "\u25B6 POLICE \u2014 " + state.abbr + " " + target.label + " \u00B7 COST " + upkeep + " \u00B7 GUARDED \u2014 click to withdraw"
          : "\u25B6 POLICE \u2014 " + state.abbr + " " + target.label + " \u00B7 COST " + upkeep + " \u2014 click to deploy";
      } else {
        banner.textContent = "\u25B6 POLICE ARMED \u2014 click your HQ or District Office to deploy; click a guarded one again to withdraw (ESC to cancel)";
      }
      return;
    }
    const slot = HOTBAR.find((candidate) => candidate.action === armedAction);
    banner.textContent = "\u25B6 " + (slot?.name || armedAction.toUpperCase()) + " ARMED \u2014 click a target state (ESC to cancel)";
  }

  const HOTBAR = [
    { key: "1", action: "deployMiniBase", icon: "\u2302", name: "DISTRICT OFFICE", cost: 2000,
      tip: ["DISTRICT OFFICE", "Click empty state to build.", "Click your District Office icon to upgrade.", "Office cap depends on HQ level."] },
    { key: "2", action: "publicSpeech", icon: "\u25C9", name: "SPEECH", cost: 0,
      tip: ["SPEECH", "Gain influence over 1 day.", "Speaking over a rival starts Debate Night.", "Cooldown: 1 day; debate: 2 days."] },
    { key: "3", action: "officeSlow", icon: "\u25CE", name: "DISTRICT JAM", cost: OFFICE_SLOW_COST,
      tip: ["DISTRICT JAM", "Click a rival leader portrait top-right.", "Their District Office influence is slowed nationwide for 3 days.", "Cost $6M. Cooldown: 2 days."] },
    { key: "4", action: "disrupt", icon: "\u26A0", name: "DISRUPT", cost: null,
      tip: ["DISRUPT", "Target a state with a rival HQ or office.", "Steals $3M per rival, damages offices, and disrupts upgrades.", "Police can block office damage."] },
    { key: "5", action: "powerGrab", icon: "\u25C6", name: "POWER GRAB", cost: null,
      tip: ["POWER GRAB", "Instantly add 20% influence in one state.", "Cost rises with electoral votes."] },
    { key: "6", action: "togglePolice", icon: "\u25EC", name: "POLICE", cost: 0,
      tip: ["POLICE", "Guard one HQ or District Office.", "Click a guarded HQ or office again to withdraw.", "Blocks assassination and DISRUPT damage when funded.", "Upkeep scales with state votes and office level."] },
    { key: "7", action: "assassinate", icon: "\u2297", name: "ASSASSIN", cost: 40000,
      tip: ["ASSASSINATE", "Kill a rival leader speaking in this state.", "Debate Night kills both speakers and triples backlash.", "Repeat kills add nationwide influence penalties."] },
  ];

  let hotbarEl = null;
  let hotTipEl = null;
  let influenceBarEl = null;
  let hotFinanceEl = null;
  function hotbarCost(slot, human) {
    if (!human) return slot.cost;
    if (slot.action === "deployMiniBase") {
      const state = states[selectedState];
      const level = state ? officeLevel(state, HUMAN) : 0;
      const req = level > 0 && level < MINI_BASE_MAX_LEVEL && level + 1 <= human.mainBaseLevel ? miniBaseUpgradeReq(human, level + 1) : null;
      return req ? req.cash : adHubCost(human);
    }
    if (slot.action === "officeSlow") return OFFICE_SLOW_COST;
    if (slot.action === "disrupt") {
      const state = states[selectedState];
      return disruptCost(human, disruptTargetsForState(HUMAN, state));
    }
    if (slot.action === "powerGrab") return powerGrabCost(human, states[selectedState]);
    if (slot.action === "togglePolice") return 0;
    if (slot.action === "assassinate" && states[selectedState] && canSelfAssassinateForMuzzle(human, states[selectedState].index)) return 0;
    if (slot.action === "assassinate") return ASSASSINATE_COST;
    return slot.cost;
  }
  function hotbarCostDetails(slot, human) {
    const state = states[selectedState];
    if (!slot || !human) return { label: "", line: "" };
    if (slot.action === "deployMiniBase") {
      const level = state ? officeLevel(state, HUMAN) : 0;
      if (level > 0) {
        const nextLevel = level + 1;
        const req = level < MINI_BASE_MAX_LEVEL && nextLevel <= human.mainBaseLevel ? miniBaseUpgradeReq(human, nextLevel) : null;
        if (!req) return { label: "MAX / LOCKED", line: state ? "Cost: maxed, or requires higher HQ level." : "Cost: select your District Office." };
        return { label: formatMoney(req.cash) + " + " + req.infl + "%", line: "Cost: upgrade to L" + nextLevel + " for " + formatMoney(req.cash) + " and " + req.infl + "% local influence." };
      }
      return { label: formatMoney(adHubCost(human)), line: "Cost: build District Office for " + formatMoney(adHubCost(human)) + "." };
    }
    if (slot.action === "publicSpeech") {
      return { label: "FREE", line: "Cost: free. Cooldown: 1 day." };
    }
    if (slot.action === "officeSlow") {
      return { label: formatMoney(OFFICE_SLOW_COST), line: "Cost: " + formatMoney(OFFICE_SLOW_COST) + ". Cooldown: 2 days." };
    }
    if (slot.action === "disrupt") {
      const targets = state ? disruptTargetsForState(HUMAN, state) : [];
      const cost = state ? disruptCost(human, targets) : null;
      return {
        label: state ? formatMoney(cost) : "VARIES",
        line: state ? "Cost: " + formatMoney(cost) + " in " + state.abbr + "." : "Cost: varies by targets in the selected state.",
      };
    }
    if (slot.action === "powerGrab") {
      const cost = state ? powerGrabCost(human, state) : null;
      return {
        label: state ? formatMoney(cost) : "BY EV",
        line: state ? "Cost: " + formatMoney(cost) + " for " + state.abbr + " (" + state.ev + " EV)." : "Cost: scales with the state's electoral votes.",
      };
    }
    if (slot.action === "togglePolice") {
      const hqCost = state && human.homeBase === state.index ? policeUpkeepDay(human, state, "hq") : Infinity;
      const officeCost = state && officeLevel(state, HUMAN) > 0 ? policeUpkeepDay(human, state, "office") : Infinity;
      const cheapest = Math.min(hqCost, officeCost);
      return Number.isFinite(cheapest)
        ? { label: formatMoney(cheapest) + "/DAY", line: "Cost: from " + formatMoney(cheapest) + "/day here. Hover HQ or office after arming for exact upkeep." }
        : { label: "UPKEEP", line: "Cost: daily upkeep scales with state EV and building level." };
    }
    if (slot.action === "assassinate") {
      const freeSelf = state && canSelfAssassinateForMuzzle(human, state.index);
      return {
        label: freeSelf ? "FREE" : formatMoney(ASSASSINATE_COST),
        line: freeSelf ? "Cost: free self-assassination during Martyr Protocol." : "Cost: " + formatMoney(ASSASSINATE_COST) + ".",
      };
    }
    const cost = hotbarCost(slot, human);
    return { label: cost === 0 ? "FREE" : cost == null ? "VARIES" : formatMoney(cost), line: "" };
  }
  function buildHotbar() {
    const stage = document.querySelector(".map-stage");
    if (!stage) return;
    hotbarEl = document.createElement("div");
    hotbarEl.className = "hotbar";
    hotbarEl.innerHTML =
      '<div id="upgradeStatusBox" class="upgrade-status-box" role="status" aria-live="polite"></div>' +
      '<div class="hot-banner" id="hotBanner">\u25B6 TARGET A STATE &middot; press ESC to cancel</div>' +
      '<div class="global-influence" id="globalInfluenceBar" aria-label="Electoral vote totals">' +
      '<div class="global-influence-head"><span>ELECTORAL VOTES</span><strong>50% CONTROL LINE</strong></div>' +
      '<div class="global-influence-track"></div></div>' +
      '<div class="hot-bottom"><div class="hot-finance" id="hotFinanceBar">CASH $0 (+$0/day)</div><div class="hot-slots">' +
      HOTBAR.map((s, i) =>
        '<button class="hotslot" data-i="' + i + '"><span class="hot-cooldown-fill" aria-hidden="true"></span>' +
        '<span class="hot-cooldown-label" aria-hidden="true"></span><span class="hk">' + s.key + '</span>' +
        '<span class="hic">' + s.icon + '</span><span class="hnm">' + s.name + '</span></button>'
      ).join("") + '</div></div>';
    stage.appendChild(hotbarEl);
    upgradeStatusBox = hotbarEl.querySelector("#upgradeStatusBox");
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
    if (eventStrip) {
      eventStrip.addEventListener("mouseenter", (event) => showEventTickerTip(event));
      eventStrip.addEventListener("mousemove", (event) => showEventTickerTip(event));
      eventStrip.addEventListener("mouseleave", () => { hotTipEl.classList.remove("is-on"); });
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
    const cost = hotbarCostDetails(s, human);
    hotTipEl.innerHTML =
      '<div class="htt"><span>' + s.tip[0] + '</span><strong>' + cost.label + '</strong></div>' +
      (cost.line ? '<div class="htl hot-cost-line">' + cost.line + '</div>' : "") +
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
  function showEventTickerTip(event) {
    if (!hotTipEl || !eventStrip) return;
    let heading = "LIVE EVENTS";
    let label = "MONITOR";
    const lines = [];
    if (phase === "base") {
      label = "HQ DRAFT";
      lines.push("You are choosing the opening state for your headquarters.");
      lines.push("Hover states on the map, then confirm the deployment point.");
      if (baseTimer > 0) lines.push("Selection window: " + Math.ceil(baseTimer) + "s remaining.");
    } else if (activeWorldEvent && worldEventTimer > 0) {
      heading = "WORLD EVENT";
      label = activeWorldEvent.title;
      lines.push(activeWorldEvent.text || "A temporary global rule is changing the campaign.");
      lines.push("Duration left: " + campaignDaysLabel(worldEventTimer) + ".");
    } else if (news) {
      heading = "LIVE UPDATE";
      label = news.title || "Campaign News";
      lines.push(news.text || "A fresh campaign development is reshaping the map.");
      if (newsTimer > 0) lines.push("Broadcast window: " + campaignDaysLabel(newsTimer) + ".");
    } else {
      lines.push("This feed announces world events, breaking news, and live campaign updates.");
      lines.push("Check it when the rules of the match suddenly change.");
    }
    hotTipEl.innerHTML =
      '<div class="htt"><span>' + heading + '</span><strong>' + label + '</strong></div>' +
      lines.map((line) => '<div class="htl">' + line + "</div>").join("");
    hotTipEl.classList.add("is-on");
    positionHotTipAt(event.clientX, event.clientY);
  }
  function positionHotTip(btn) {
    const r = btn.getBoundingClientRect();
    hotTipEl.style.left = Math.round(r.left + r.width / 2) + "px";
    hotTipEl.style.top = "auto";
    hotTipEl.style.bottom = Math.round(window.innerHeight - r.top + 18) + "px";
  }
  function positionHotTipAt(x, y) {
    if (!hotTipEl) return;
    hotTipEl.style.left = Math.round(x) + "px";
    hotTipEl.style.top = Math.round(y + 18) + "px";
    hotTipEl.style.bottom = "auto";
  }

  function hotbarActionAvailable(slot, human, state) {
    if (!slot || !human || !state || phase !== "play" || paused || matchOver || human.locked > 0) return false;
    if (slot.action === "deployMiniBase") {
      const level = officeLevel(state, HUMAN);
      if (level > 0) {
        const req = level < MINI_BASE_MAX_LEVEL && level + 1 <= human.mainBaseLevel ? miniBaseUpgradeReq(human, level + 1) : null;
        return !!req &&
          !missions.some((mission) => mission.type === "officeUpgrade" && mission.player === HUMAN && mission.state === state.index) &&
          human.cash >= req.cash && (state.influence[HUMAN] || 0) >= req.infl;
      }
      return canBuildMoreDistrictOffices(human) &&
        !missions.some((mission) => mission.type === "adDeploy" && mission.player === HUMAN && mission.state === state.index) &&
        human.cash >= adHubCost(human);
    }
    if (slot.action === "publicSpeech") {
      return (human.speechCooldown || 0) <= 0 && !human.action && realSpeechesInState(state.index).length < 2;
    }
    if (slot.action === "officeSlow") {
      return (human.officeSlowCooldown || 0) <= 0 &&
        human.cash >= OFFICE_SLOW_COST &&
        players.some((candidate) => candidate.id !== HUMAN && districtOfficeCount(candidate.id) > 0);
    }
    if (slot.action === "disrupt") {
      const targets = disruptTargetsForState(HUMAN, state);
      return (human.disruptCooldown || 0) <= 0 && canStartDisruptionOp(human, HUMAN) && targets.length > 0 && human.cash >= disruptCost(human, targets);
    }
    if (slot.action === "powerGrab") {
      const cost = powerGrabCost(human, state);
      return Number.isFinite(cost) && human.cash >= cost && adjustedInfluence(state, HUMAN) < 100;
    }
    if (slot.action === "togglePolice") {
      const ownsHq = human.homeBase === state.index;
      const ownsOffice = officeLevel(state, HUMAN) > 0;
      const alreadyGuarded = (ownsHq && policeGuards(state, HUMAN, "hq")) || (ownsOffice && policeGuards(state, HUMAN, "office"));
      const cheapestUpkeep = Math.min(
        ownsHq ? policeUpkeepDay(human, state, "hq") : Infinity,
        ownsOffice ? policeUpkeepDay(human, state, "office") : Infinity
      );
      return alreadyGuarded || ((ownsHq || ownsOffice) && human.cash >= cheapestUpkeep);
    }
    if (slot.action === "assassinate") {
      if (canSelfAssassinateForMuzzle(human, state.index)) return true;
      if (human.action?.type === "speech") return false;
      const target = players.find((candidate) =>
        candidate.id !== HUMAN && isSpeaking(candidate) && canInterruptAction(candidate) &&
        (candidate.action.state === state.index || (candidate.action.decoyStates || []).includes(state.index))
      );
      return !!target && human.cash >= assassinateCost(human, target);
    }
    return false;
  }

  function hotbarCooldown(slot, human, state) {
    if (!slot || !human) return null;
    if (human.locked > 0) {
      return { left: human.locked, total: Math.max(human.locked, ASSASSINATE_BLACKOUT_DAYS * CAMPAIGN_DAY_SECONDS) };
    }
    if (slot.action === "disrupt" && (human.disruptCooldown || 0) > 0) {
      return { left: human.disruptCooldown, total: DISRUPT_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS };
    }
    if (slot.action === "officeSlow" && (human.officeSlowCooldown || 0) > 0) {
      return { left: human.officeSlowCooldown, total: OFFICE_SLOW_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS };
    }
    if (slot.action === "publicSpeech" && (human.speechCooldown || 0) > 0) {
      return {
        left: human.speechCooldown,
        total: human.speechCooldownTotal || SPEECH_COOLDOWN_DAYS * CAMPAIGN_DAY_SECONDS,
      };
    }
    return null;
  }

  function campaignDaysLabel(seconds) {
    const days = Math.max(0, Number(seconds) || 0) / CAMPAIGN_DAY_SECONDS;
    return (days >= 10 ? Math.ceil(days) : Math.max(0.1, Math.ceil(days * 10) / 10)) + "D";
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
      const state = states[selectedState];
      const cost = hotbarCost(s, human);
      btn.classList.toggle("is-armed", armedAction === s.action);
      const costEl = btn.querySelector(".hcost");
      if (costEl) {
        if (s.action === "deployMiniBase") {
          const state = states[selectedState];
          const level = state ? officeLevel(state, HUMAN) : 0;
          costEl.textContent = level <= 0 ? formatMoney(adHubCost(human)) : level >= MINI_BASE_MAX_LEVEL ? "MAXED" : "UP " + formatMoney(cost);
        } else if (s.action === "powerGrab") {
          const state = states[selectedState];
          costEl.textContent = state ? state.abbr + " " + formatMoney(cost) : "BY EV";
        } else {
          costEl.textContent = cost === null ? "VARIES" : s.action === "togglePolice" ? formatMoney(policeUpkeepDay(human, states[selectedState])) + "/D" : cost === 0 ? "FREE" : formatMoney(cost);
        }
      }
      const available = hotbarActionAvailable(s, human, state);
      const poor = human && typeof cost === "number" && cost > 0 && human.cash < cost && !available;
      btn.classList.toggle("is-poor", !!poor);
      btn.classList.toggle("is-available", available);
      btn.classList.toggle("is-unavailable", !available);
      btn.setAttribute("aria-label", s.name + (available ? " available" : " unavailable"));

      const cooldown = hotbarCooldown(s, human, state);
      const cooldownFill = btn.querySelector(".hot-cooldown-fill");
      const cooldownLabel = btn.querySelector(".hot-cooldown-label");
      if (cooldown) {
        const remaining = Math.max(0, Math.min(1, cooldown.left / Math.max(0.001, cooldown.total)));
        btn.classList.add("is-cooling-down");
        btn.classList.toggle("is-action-cooldown", s.action === "publicSpeech" || s.action === "disrupt" || s.action === "officeSlow");
        btn.style.setProperty("--cooldown-remaining", (remaining * 100).toFixed(2) + "%");
        if (cooldownLabel) cooldownLabel.innerHTML = '<strong>COOLDOWN</strong><span>' + campaignDaysLabel(cooldown.left) + '</span>';
        if (cooldownFill) cooldownFill.hidden = false;
      } else {
        btn.classList.remove("is-cooling-down");
        btn.classList.remove("is-action-cooldown");
        btn.style.setProperty("--cooldown-remaining", "0%");
        if (cooldownLabel) cooldownLabel.textContent = "";
        if (cooldownFill) cooldownFill.hidden = true;
      }
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
    if (paused) { showToast("GAME PAUSED — action tooltips remain available, but actions cannot be armed."); return; }
    pipSfx("click");
    const human = players[HUMAN];
    if (human?.locked > 0) {
      clearArmed();
      showToast("Your party is in assassination blackout for " + formatCampaignDuration(human.locked) + ".");
      return;
    }
    const cost = hotbarCost(s, human);
    if (s.action !== "powerGrab" && typeof cost === "number" && cost > 0 && human.cash < cost) {
      showToast("INSUFFICIENT STRATEGIC RESERVES - need " + formatMoney(cost) + ".");
      return;
    }
    armedAction = s.action;
    const banner = document.getElementById("hotBanner");
    if (banner) {
      updateArmedTargetBanner(-1);
      banner.classList.add("is-on");
    }
    refreshHotbar();
  }

  document.addEventListener("keydown", (event) => {
    if ((!gameStarted && !currentLobby?.id) || pipOpen) return;
    if (event.key === "Escape" && settingsOpen) { event.preventDefault(); closeSettingsPanel(); return; }
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (String(event.key || "").toLowerCase() === "c") {
      event.preventDefault();
      toggleEmoteWheel(true);
      return;
    }
    if (emoteWheelOpen) {
      const numericIndex = Number.parseInt(String(event.key || ""), 10);
      if (numericIndex >= 1 && numericIndex <= EMOTE_OPTIONS.length) {
        event.preventDefault();
        sendEmote(EMOTE_OPTIONS[numericIndex - 1].id);
        return;
      }
    }
    if (event.key === "Escape" && rivalTalentPlayerId >= 0) { event.preventDefault(); closeRivalTalentViewer(); return; }
    if (event.key === "Escape" && emoteWheelOpen) { event.preventDefault(); closeEmoteWheel(); return; }
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
  }, true);

  document.addEventListener("keyup", (event) => {
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (String(event.key || "").toLowerCase() === "c") {
      event.preventDefault();
      closeEmoteWheel();
    }
  });

  selectMenuParty(selectedParty, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildHotbar);
  else buildHotbar();

  window.riggedAddBotFromSlot = async (button) => {
    if (!button || button.disabled) return false;
    button.disabled = true;
    button.classList.add('is-adding');
    const stateLabel = button.querySelector('.lobby-leader-state');
    const previousLabel = stateLabel?.textContent || '';
    if (stateLabel) stateLabel.textContent = 'Adding...';
    try {
      return await addBotFromLeaderSlot();
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove('is-adding');
        if (stateLabel) stateLabel.textContent = previousLabel || 'Click to Fill';
      }
    }
  };

  document.addEventListener("pointerdown", (event) => {
    const wheel = document.getElementById("emoteWheel");
    if (!emoteWheelOpen || !wheel) return;
    if (wheel.contains(event.target)) return;
    closeEmoteWheel();
  });

  // Render matchmaking before the browser's first paint. Keeping the party
  // selector hidden until a lobby route opens prevents a startup flash.
  mainMenu.style.display = 'none';
  mainMenu.style.visibility = 'hidden';
  gameShell.style.display = 'none';
  gameShell.style.visibility = 'hidden';
  showLobbyInterface();

})();
