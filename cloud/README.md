# Cloud relay + UI

A small Express + `ws` server that:

- serves the single-page UI from `public/` (plain HTML/JS/CSS, no build step);
- accepts **one** agent WebSocket at `/agent` (bearer token checked before upgrade);
- accepts UI WebSockets at `/ui` (token sent as the first message);
- forwards `cmd` messages UI → agent and routes `result` replies back to the
  tab that asked; broadcasts agent `state` pushes to every open UI;
- pings every socket every 15s and drops dead ones, so a sleeping Mac shows
  as **Agent offline** within about 30s.

It never touches media and stores nothing beyond the open sockets.

## Run locally

```bash
npm install
cp .env.example .env    # set PAIRING_TOKEN
npm start               # http://localhost:8080, agent RELAY_URL=ws://localhost:8080/agent
```

## Deploy on Render

1. Push this repo to GitHub.
2. In Render: **New › Blueprint**, select the repo. It reads
   [`render.yaml`](render.yaml) (Docker, `rootDir: cloud`, health check
   `/healthz`).
3. Set `PAIRING_TOKEN` in the service's Environment tab (the same value as
   the agent's).
4. Once it's live, set the agent's `RELAY_URL=wss://<service>.onrender.com/agent`.

Render terminates TLS, so the UI is served over HTTPS and the sockets over
WSS automatically. `FORCE_HTTPS=1` redirects any plain-HTTP request.

**Plan choice:** Render's free web services spin down after about 15 minutes
without inbound HTTP traffic and take roughly a minute to wake. The agent's
WebSocket may not count as traffic, and a spin-down drops it until the next
page load. Use the `starter` plan (the Blueprint default), or a VPS, for a
relay that's always on.

## Deploy on a VPS

```bash
docker build -t dlna-cloud .
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e PAIRING_TOKEN=... -e FORCE_HTTPS=1 --name dlna-cloud dlna-cloud
```

Put Caddy in front for automatic HTTPS. See
[`Caddyfile.example`](Caddyfile.example). Caddy proxies WebSocket upgrades
with no extra config.

## Message protocol

| Direction | Message |
|-----------|---------|
| UI → relay | `{type:"auth", token}` (first message), then `{type:"cmd", id, action, params}` |
| relay → UI | `{type:"hello", agentConnected}`, `{type:"agent", connected}`, `{type:"state", state}`, `{type:"result", id, ok, data \| error}` |
| relay → agent | `{type:"cmd", id, action, params}` (ids re-numbered so tabs can't collide) |
| agent → relay | `{type:"result", id, ok, data \| error}`, `{type:"state", state}` |

Commands time out after 30s. If the agent drops mid-command, the UI gets an
`AGENT_DISCONNECTED` error straight away.
