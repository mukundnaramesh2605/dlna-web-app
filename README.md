# Monitor Cast

Control playback on a Samsung Smart Monitor (or any UPnP/DLNA renderer) from a
web page you can open anywhere, while your MacBook serves the files over the
home LAN.

```
  Browser (anywhere)                         Cloud relay + UI (Render / VPS)
  ┌──────────────┐  HTTPS + WSS /ui          ┌──────────────────────────┐
  │  Web UI      │ ────────────────────────► │ relay: forwards JSON     │
  └──────────────┘   control messages only   │ commands, holds 1 agent  │
                                             └────────────▲─────────────┘
                                                          │ one outbound WSS /agent
  Home LAN                                                │ (token auth, auto-reconnect)
  ┌───────────────────────────────────────────────────────┴───────────┐
  │  MacBook: agent                                                   │
  │   • HTTP media server on <LAN-IP>:8200 (Range, DLNA headers)      │
  │   • SSDP discovery + UPnP AVTransport/RenderingControl (SOAP)     │
  │   • /player page for browser fallback                             │
  └──────────────┬────────────────────────────────────────────────────┘
                 │ media bytes: HTTP over Wi-Fi, never via the cloud
                 ▼
         Samsung Smart Monitor (DLNA MediaRenderer)
```

**Why it's split in three:** a web page can't do SSDP multicast, open UPnP
control sockets, or serve local files, and a cloud server can't reach your
home network. So all DLNA work happens in a small **agent** on the Mac. The
**relay** only passes control messages between your browser and the agent.
The **monitor** pulls media straight from the Mac over the LAN.

| Part | Folder | Runs on |
|------|--------|---------|
| Agent | [`agent/`](agent/README.md) | Your MacBook (Node ≥ 22.9) |
| Relay + UI | [`cloud/`](cloud/README.md) | Render, or any VPS with Docker |

No inbound ports are opened on your home network. The agent dials out to the
relay and keeps that one WebSocket open.

## How a cast works

1. The UI sends `{type:"cmd", action:"play", params:{file, deviceId}}` to the relay.
2. The relay forwards it down the agent's WebSocket.
3. The agent builds `http://<mac-lan-ip>:8200/media/<file>` plus DIDL-Lite
   metadata and calls `SetAVTransportURI`, then `Play`, on the monitor.
4. The monitor fetches the file from the Mac (Range requests for seeking).
5. The agent polls `GetTransportInfo` and `GetPositionInfo` every second and
   pushes `{type:"state"}` to the UI through the relay.

## Pairing token

One shared secret authenticates both sides:

- the **agent** sends it as `Authorization: Bearer <token>` when it connects;
- the **UI** asks for it once, keeps it in the browser's localStorage, and
  sends it as its first WebSocket message.

Generate it once and set the same value as `PAIRING_TOKEN` on the agent and
the relay:

```bash
openssl rand -hex 24
```

To rotate it, change it in both places and use **Sign out** in the UI to enter
the new one.

## First run, end to end

**1. Start the agent on the Mac and check it on the LAN alone.**

```bash
cd agent
npm install
cp .env.example .env      # set PAIRING_TOKEN, MEDIA_DIR; leave RELAY_URL for now
npm run discover          # should list your monitor
npm run cast -- ~/Movies/some-video.mp4 "Smart Monitor"
```

The first time a new device casts, the monitor may show an **Allow** prompt.
Accept it with the remote. macOS may also ask whether `node` may accept
incoming connections and access the local network. Allow both, otherwise the
monitor can't fetch files and discovery finds nothing.

**2. Deploy the relay.** Follow [`cloud/README.md`](cloud/README.md). On
Render it's a Blueprint deploy plus setting `PAIRING_TOKEN` in the dashboard.
You'll get a URL like `https://dlna-cloud.onrender.com`.

**3. Point the agent at the relay.** In `agent/.env`:

```
RELAY_URL=wss://dlna-cloud.onrender.com/agent
```

Then run `npm start`. The log should say `[relay] connected`. To keep it
running across reboots and sleep, run `npm run install-service` (details in
[`agent/README.md`](agent/README.md)).

**4. Open the UI.** Go to `https://dlna-cloud.onrender.com` and paste the
pairing token. Both status pills should go green.

**5. Cast.** Pick a file, pick the monitor, press **Cast to monitor**. Use the
seek bar, pause, stop and volume as usual.

**If DLNA doesn't work** (no renderer found, or the monitor rejects the
format), select the file and press **Open in monitor's browser**. Open the
LAN URL shown, or scan the QR code, in the monitor's built-in Internet app.
It plays in a plain HTML5 player served by the agent.

## Status and errors the UI shows

| Situation | What you see |
|-----------|--------------|
| Mac asleep, agent stopped, or Mac offline | Yellow **Agent offline** banner; controls disabled. The relay notices within about 30s (ping timeout). |
| Monitor off or off the network | **Monitor offline**: SOAP calls time out or 3 polls fail in a row |
| Monitor never fetched the media URL | **Monitor can't reach the Mac** after 10s: usually the macOS firewall |
| Unsupported codec or container | In Auto mode it's converted with ffmpeg automatically, and the status line says why ("transcoding (dts audio)"). Without ffmpeg, UPnP error 714/704 is explained and a warning appears before casting when the monitor doesn't list the format. |
| Relay unreachable | Red **Relay offline** pill; the UI reconnects every 2s |

Every error banner has a **×** to dismiss it. Errors are raised once, when
the problem starts, so a dismissed error doesn't come back unless something
new goes wrong.

## Stretch features (optional; the core works without them)

- **Any video format (ffmpeg).** About 60 video and audio extensions are
  listed, including AVI, MKV, WMV, VOB, MTS, RMVB, MXF, OGV and FLAC. The
  **Transcode** selector has three modes:
  - **Auto** (default): ffprobe reads each file's codecs and compares them
    with the formats the monitor advertises. Files it can decode are
    streamed unchanged; anything else is converted on the fly.
  - **Always**: always convert.
  - **Never**: always send the original file.

  If an unconverted file still fails (the monitor errors or stops within
  the first seconds), Auto switches to transcoding by itself. It also
  remembers that file extension for that monitor, so the next file of the
  same type converts straight away. Your Samsung needed this for Xvid AVIs
  ("packed bitstream"). Conversion keeps H.264, HEVC and MPEG-2 video and
  AAC/AC3 audio as-is, re-encodes anything else with the Mac's hardware
  encoder (`h264_videotoolbox`), and outputs MPEG-TS. Seeking restarts
  ffmpeg at the new timestamp. The browser-fallback player gets a
  fragmented-MP4 conversion for containers browsers can't open, which
  can't be seeked. Needs `brew install ffmpeg`.
- **External `.srt` subtitles.** When `movie.srt` sits next to `movie.mp4`,
  it's offered to Samsung renderers (`CaptionInfo.sec` header +
  `sec:CaptionInfoEx`) and to the browser player (converted to WebVTT).
- **Remembered settings.** The last folder (changed with **Change folder**)
  and the last selected device are saved in `~/.config/dlna-agent/state.json`.
- **Audio track choice.** When the selected file has more than one audio
  track, an **Audio** picker appears in the Cast card, showing each track's
  language, title, codec and channels. DLNA has no standard way to switch
  tracks, and the monitor always plays the file's default one. So any other
  track is streamed through ffmpeg with only that track mapped in; the video
  is passed through unchanged when possible, so this is cheap. Changing the
  track while that file plays switches it at the current position. Seeking
  keeps the track, the browser player honours it, and Continue watching
  resumes with the track you last used.
- **Continue watching.** While something plays, the agent saves its position
  every 10 seconds, and again on pause or stop, including stopping from the
  monitor's remote. The UI shows a **Continue watching** row of the 12 most
  recent unfinished videos from any folder; click one to resume. Files with
  a saved position get a progress bar in the list, and the Cast button
  becomes **Resume at mm:ss**, with **Start over** next to it. A video counts
  as finished in its last 90 seconds (or last 5%) and drops off the row. The
  × on a card removes it.

## Security notes

- The relay rejects agents and UIs without the token, and compares tokens in
  constant time.
- The agent's LAN media server can't require auth, because DLNA renderers
  can't send credentials. It only serves files with media or subtitle
  extensions inside the media folder, and blocks path traversal. Anyone on
  your home Wi-Fi can read those files while the agent runs.
- **Change folder** lets the UI point the agent at any folder on the Mac,
  which is another reason to keep the token secret.

## Tested with

Samsung Smart Monitor M8 (LS32CM80GUWXXL) on macOS with Node 23: discovery,
cast, pause/resume, seek, volume, stop, HEVC MKV direct play, transcoded
playback with seek, and the browser fallback player with subtitles.
