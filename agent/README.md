# Agent (runs on your Mac)

Does all the DLNA work: serves your media folder over HTTP on the LAN,
discovers renderers with SSDP, controls them over UPnP, and connects out to
the cloud relay.

## Run it

```bash
npm install
cp .env.example .env   # fill in PAIRING_TOKEN, RELAY_URL, MEDIA_DIR
npm start
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `PAIRING_TOKEN` | (required) | Shared secret; same value as on the relay |
| `RELAY_URL` | `ws://localhost:8080/agent` | Relay's agent endpoint (`wss://…/agent` in production) |
| `MEDIA_DIR` | `~/Movies` | Folder to serve (searched recursively). The UI can change it later. |
| `HTTP_PORT` | `8200` | LAN port the monitor streams from |
| `AGENT_HOST` | auto (en0 IPv4) | LAN IP to put in media URLs, if auto-detect picks the wrong one |
| `STATE_FILE` | `~/.config/dlna-agent/state.json` | Where the folder, device, learned formats and watch progress are saved |
| `KEEPALIVE_MINUTES` | `10` | How often to request the relay's `/healthz` so a free Render instance doesn't sleep; `0` disables |

## Testing on the LAN without the cloud

```bash
npm run discover                                  # list renderers
npm run cast -- ~/Movies/clip.mp4 "Smart Monitor" # serve + play, live status line
npm run cast -- ~/Movies/film.mkv "Smart" --transcode
```

## Run it persistently (launchd)

```bash
npm run install-service     # writes ~/Library/LaunchAgents/com.dlna.agent.plist and starts it
tail -f ~/Library/Logs/dlna-agent.log
npm run uninstall-service
```

It's a per-user LaunchAgent. It starts at login, is restarted if it exits
(`KeepAlive`), and reconnects to the relay after the Mac wakes. pm2 works
too, if you prefer it:

```bash
npx pm2 start src/index.js --name dlna-agent --node-args="--env-file=.env" && npx pm2 save && npx pm2 startup
```

### macOS permissions and sleep

- **Firewall:** if the macOS firewall is on, allow incoming connections for
  `node`, or the monitor can't fetch media. The UI then reports "Monitor
  can't reach the Mac".
- **Local Network:** recent macOS versions ask before an app may use the LAN.
  If discovery finds nothing when running under launchd, enable the entry in
  System Settings › Privacy & Security › Local Network.
- **Sleep:** while something is playing the agent runs `caffeinate -i`, so the
  Mac won't idle-sleep mid-stream. Closing the lid still sleeps it on battery.
  When the Mac sleeps, the UI shows **Agent offline** until it wakes. To keep
  it reachable at all times, turn on "Prevent automatic sleeping when the
  display is off" for power adapter use.

## How the DLNA flow works

| Step | File | What happens |
|------|------|--------------|
| Discover | [`src/discovery.js`](src/discovery.js) | M-SEARCH to `239.255.255.250:1900` for `MediaRenderer:1`, fetch each `LOCATION` XML, read control URLs |
| Check formats | [`src/upnp.js`](src/upnp.js) | `ConnectionManager.GetProtocolInfo` gives the MIME types the renderer accepts |
| Describe | [`src/didl.js`](src/didl.js) | DIDL-Lite with `protocolInfo` + DLNA flags (+ Samsung subtitle tags) |
| Load & play | [`src/upnp.js`](src/upnp.js) | `Stop` → `SetAVTransportURI` → `Play` (retried on 701 while the TV is transitioning) |
| Serve | [`src/media-server.js`](src/media-server.js) | Range/206 responses, `contentFeatures.dlna.org`, `transferMode.dlna.org` |
| Track | [`src/controller.js`](src/controller.js) | 1s poll of `GetTransportInfo` / `GetPositionInfo`, volume every 3s |
| Relay | [`src/relay-client.js`](src/relay-client.js) | One outbound WebSocket, backoff reconnect (1s → 30s), own 15s pings + 45s dead-socket watchdog |

SSDP is implemented on `node:dgram` instead of the `node-ssdp` package:
that package has been unmaintained since 2020 and depends on a vulnerable
`ip` module. The SOAP calls are hand-written for the same reason, and because
Samsung firmware wants specific DLNA headers and flags.

## Commands the relay can send

`getState`, `listFiles`, `setFolder {path}`, `rescan`, `selectDevice {deviceId}`,
`play {file, deviceId, mode: auto|transcode|direct}`, `pause`, `resume`, `stop`, `seek {seconds}`,
`volume {level}`, `browserLink {file}`, `play {…, startAt}`, `continue {id, deviceId, mode}`,
`forget {id}`, `dismissError`, `pickFolder`, `pickFile`.
