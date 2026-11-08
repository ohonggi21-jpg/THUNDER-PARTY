# THUNDER PARTY MVP

A first independent web-app build for THUNDER PARTY. It includes:

- Main landing screen and server settings
- Create room / join room with a 6-character code
- Lobby, participant list, host controls, invite link
- Spectator read-only view
- Reaction test, 10-target accuracy challenge, quick quiz
- Server-side result scoring and cumulative room leaderboard
- Cloudflare Worker + D1 backend starter

## Important separation

Create a **new** Cloudflare Worker and a **new** D1 database for THUNDER PARTY. Do not point this project at the existing THUNDER ROYALE database or overwrite its Worker.

## Deploy without a command line (Cloudflare dashboard)

1. In Cloudflare, open **Workers & Pages** and create a new Worker named `thunder-party-api`.
2. Open the Worker editor, replace its starter code with the full contents of `worker.js`, then deploy.
3. Open **D1 SQL Database** and create a new database named `thunder-party-db`.
4. Open that database's Console and run the full contents of `schema.sql`.
5. Return to the Worker → **Settings** → **Bindings** → **Add** → **D1 database**. Set the variable name to exactly `DB` and select `thunder-party-db`. Save and redeploy if prompted.
6. Open `https://YOUR-WORKER.workers.dev/health`. It should return a JSON response containing `"ok":true` and `"database":"connected"`.
7. In the THUNDER PARTY webpage, press the gear icon and save the Worker base URL (do not add `/health`).

The `wrangler.toml` file is provided for the optional CLI deployment route.

## Deploy the front end

1. Create a new GitHub repository named `THUNDER-PARTY` (or another name you prefer).
2. Upload `index.html` to the repository root.
3. Enable GitHub Pages from the repository's main branch and root folder.
4. Open the published page and use the gear button to enter the Worker URL after deploying the API.

## Deploy the Cloudflare D1 database

Create a new D1 database named `thunder-party-db` in Cloudflare.

Using Wrangler CLI from this folder:

```bash
npx wrangler d1 create thunder-party-db
```

Copy the returned database ID into `wrangler.toml` in place of `PASTE_YOUR_NEW_D1_DATABASE_ID_HERE`.

Apply the schema:

```bash
npx wrangler d1 execute thunder-party-db --remote --file=./schema.sql
```

Deploy the Worker:

```bash
npx wrangler deploy
```

Open the Worker URL plus `/health`. Expected response:

```json
{"ok":true,"service":"thunder-party-api","database":"connected","version":"mvp-1"}
```

Paste the Worker base URL (without `/health`) into the gear/settings window in the web app.

## How to test

1. Open the GitHub Pages URL in one browser and create a room.
2. Copy the six-character room code.
3. Open another browser/device and join using that code and a different nickname.
4. Start a game from the host device.
5. Open `?room=ROOMCODE&spectate=1` in another browser to test the spectator view.

## MVP notes / limitations

- Live room state is synchronized by polling approximately once per second. It is suitable for a first playable test, but a later high-attendance festival build should move to Durable Objects/WebSockets for lower latency and better concurrency.
- The accuracy challenge uses server-checked target positions and server-side scoring. Reaction and quiz results are also scored by the Worker.
- This MVP has no persistent global TOP 30 or cross-room Hall of Fame yet. Scores are cumulative only inside each room. The next planned backend milestone is event-wide rankings, player profiles, QR-code generation, and admin event controls.
- The current API uses simple room codes and bearer tokens. Before a public festival launch, add stronger rate limiting, room expiration/cleanup, moderation controls, and operational monitoring.
