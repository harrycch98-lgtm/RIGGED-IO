# RIGGED Server Multiplayer Build

Open or upload `index.html` from this folder for the custom-backend multiplayer version.

The production client connects to `https://api.riggedio.com:3000` and
`wss://api.riggedio.com:3000`. Localhost automatically uses port 3001.

## Local auth + database setup

The backend expects Postgres plus two required environment variables:

- `DATABASE_URL`
- `JWT_SECRET`

Start from `.env.example`:

```powershell
Copy-Item .env.example .env
```

Create the local database:

```powershell
createdb riggedio
```

Or with `psql`:

```sql
CREATE DATABASE riggedio;
```

Point `DATABASE_URL` at that database, for example:

```txt
DATABASE_URL=postgres://postgres:postgres@localhost:5432/riggedio
JWT_SECRET=replace-with-a-long-random-secret
```

`backend-server.js` will create the `users` table automatically on startup by calling `initDb()`, so you do not need to run a separate schema file for auth.

Run the local backend:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/riggedio"
$env:JWT_SECRET="replace-with-a-long-random-secret"
node backend-server.js
```

## Route smoke tests

With the backend running on `http://localhost:3001`:

```powershell
npm test
npm run test:auth
```

`npm test` covers the lobby flow. `npm run test:auth` covers:

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`

## Multiplayer compatibility routes

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

When the page is served from `localhost` or `127.0.0.1`, `game.js` automatically uses this server on port 3001. Deploy `backend-server.js` behind your production API host to enable the same lobby flow online.
