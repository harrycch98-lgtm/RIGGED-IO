# RIGGED Server Multiplayer Build

Open or upload `index.html` from this folder for the custom-backend multiplayer version.

Before upload, edit `multiplayer-server.js` and replace:

```js
const BACKEND_URL = 'https://yourdomain-backend.com';
```

with your real backend URL.

Expected backend routes:

```txt
POST /api/join
Body: { "name": "Player Name", "id": "stable-player-id" }

POST /api/move
Body: { "id": "stable-player-id", "x": 123, "y": 456 }

GET /api/players
Returns: [{ "id": "other-player-id", "name": "Other Player", "x": 123, "y": 456 }]
```

The game page loads `multiplayer-server.js` before `game.js`, so these functions are available globally:

```js
joinGame(playerName)
updatePosition(x, y)
getOtherPlayers()
RiggedServerMultiplayer.pollPlayers(1000)
```

Local test backend (includes named public/private lobbies and public browsing):

```powershell
node backend-server.js
```

When the page is served from `localhost` or `127.0.0.1`, `game.js` automatically uses this server on port 3001. Deploy `backend-server.js` behind your production API host to enable the same lobby flow online.
