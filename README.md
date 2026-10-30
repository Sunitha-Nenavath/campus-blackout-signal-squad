# CAMPUS BLACKOUT: SIGNAL SQUAD

One Campus. Five Players. One Mission.

A cooperative browser puzzle game for 2–5 players. Create or join a room, share clues, and restore three campus systems before the 180-second reserve runs out.

## Run locally

Requires Node.js 20 or newer. No package installation is needed.

```sh
npm start
```

Open <http://localhost:4173>. The server listens on `0.0.0.0`, so another device on your Wi-Fi can open `http://YOUR-COMPUTER-LAN-IP:4173` (allow inbound port 4173 in the computer firewall if prompted). For a public server, set `PORT` to the host-provided port. HTTPS at the host edge is detected automatically and the browser uses WSS for `/ws`.

## How to play

Create a room and send its six-character code to 1–4 teammates. The host can launch once two players have joined. Each player receives a distinct role and a role-specific clue. Share clues with the squad; smaller teams receive multiple role clues each, and everyone can submit answers. The server checks submissions, advances missions, keeps the shared timer, and calculates score. Correctly finishing a level earns 100 points plus a time bonus; victory also awards two points per remaining second. The team has three minutes.

## Architecture

- `server.js`: Node HTTP server and small RFC 6455 WebSocket implementation; owns room membership, role assignment, host handoff, reconnect window, timer, puzzle validation, level progression, and score.
- `index.html`: responsive browser client; uses a native WebSocket connection to `/ws` and displays server snapshots.
- Room state lives in memory. A room with no connected players is removed after one minute. `MISSION_SECONDS` can shorten the timer for local QA; it defaults to 180. There are no accounts, third-party services, or secrets.

## Deployment with Netlify and Render

Netlify serves the frontend from `dist/`; Render runs the persistent Node/WebSocket server from the same Git repository. This split is necessary because Netlify's static deployment does not run this long-lived multiplayer process.

1. Push this project to a GitHub repository.
2. In Render, create a Blueprint from that repository. The root `render.yaml` creates the backend service. Copy the service's actual `https://…onrender.com` URL when its deploy succeeds.
3. Set `window.SIGNAL_WS_URL` in `config.js` to `wss://YOUR-RENDER-SERVICE.onrender.com/ws`, then commit and push that change.
4. In Netlify, choose **Add new project → Import an existing project**, connect the same repository, and deploy. The root `netlify.toml` copies `index.html` and `config.js` into `dist/`, which Netlify publishes.
5. Open the Netlify URL in two browser sessions, create a room in one, and join it from the other.

The WebSocket URL is public configuration, not a secret. The client uses same-origin `/ws` locally when `SIGNAL_WS_URL` is blank. No public deployment has been performed from this workspace.

## Current scope

The rooms and score are memory-only and reset when the server restarts. Reconnection works while the server process remains up and the player remains in the room. Player names are unique within a room. There is no account system or persistent leaderboard.
