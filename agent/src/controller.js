// Playback controller: owns discovered devices and the current cast session,
// executes commands coming from the relay, and polls the renderer for state.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { discoverRenderers } from './discovery.js';
import { Renderer, AgentError } from './upnp.js';
import { buildDidl, pickMime } from './didl.js';
import { listMedia, resolveInside, kindOf, mimeOf, findSubtitle, encodePath } from './media-server.js';
import { expandHome } from './config.js';
import { chooseInFinder } from './finder.js';

import { transcodeReason } from './compat.js';

export function createController({ config, store, transcoder }) {
  const baseUrl = `http://${config.host}:${config.port}`;
  let mediaDir = validDir(store.get('mediaDir')) ? store.get('mediaDir') : config.mediaDir;
  const devices = new Map();
  let scanning = false;
  let session = null; // see startCast()
  let live = { transport: 'NO_MEDIA_PRESENT', position: 0, duration: 0, volume: null };
  let error = null; // async problems discovered while polling: { code, message }
  let listener = () => {};
  let pollTimer = null;
  let pollFailures = 0;
  let pollTick = 0;
  let pollGeneration = 0;
  let caffeinate = null;
  const lastFetch = new Map(); // relative path -> time the media server last served it

  const mediaUrl = (rel) => `${baseUrl}/media/${encodePath(rel)}`;
  const transcodeUrl = (rel, t) => `${baseUrl}/transcode/${encodePath(rel)}?t=${Math.floor(t)}`;

  function state() {
    return {
      agent: { mediaDir, baseUrl, transcoding: Boolean(transcoder) },
      devices: [...devices.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name, manufacturer, model, ip, services }) => ({
        id,
        name,
        manufacturer,
        model,
        ip,
        volume: Boolean(services.renderingControl),
      })),
      lastDeviceId: store.get('lastDeviceId') ?? null,
      scanning,
      session: session && {
        file: session.file,
        name: session.name,
        kind: session.kind,
        deviceId: session.device.id,
        deviceName: session.device.name,
        url: session.url,
        mode: session.mode,
        transcode: session.transcode,
        transcodeReason: session.reason,
        warning: session.warning,
      },
      ...live,
      error,
    };
  }

  const changed = () => listener(state());

  // Per-monitor memory of file types that failed to play directly, so Auto
  // goes straight to transcoding next time instead of failing first.
  const learnedFailures = (deviceId) => store.get('directFailures')?.[deviceId] ?? [];
  function learnFailure(deviceId, ext) {
    const all = store.get('directFailures') ?? {};
    if (all[deviceId]?.includes(ext)) return;
    all[deviceId] = [...(all[deviceId] ?? []), ext];
    store.set('directFailures', all);
    console.log(`[cast] remembering that ${ext} needs transcoding on this monitor`);
  }

  async function rescan() {
    if (scanning) return;
    scanning = true;
    changed();
    try {
      const found = await discoverRenderers(config.host);
      devices.clear();
      for (const d of found) devices.set(d.id, d);
      // Keep the device we're casting to, even if it missed this scan.
      if (session && !devices.has(session.device.id)) devices.set(session.device.id, session.device);
      console.log(`[ssdp] found ${found.length} renderer(s): ${found.map((d) => `${d.name} (${d.ip})`).join(', ') || 'none'}`);
    } finally {
      scanning = false;
      changed();
    }
  }

  function requireFile(rel) {
    const full = resolveInside(mediaDir, rel);
    if (!full || !kindOf(full) || !fs.existsSync(full)) throw new AgentError('FILE_NOT_FOUND', `File not found: ${rel}`);
    return full;
  }

  function requireSession() {
    if (!session) throw new AgentError('NO_SESSION', 'Nothing is playing');
    return session;
  }

  /**
   * mode: 'auto' (default) streams the original when the monitor can decode it
   * and an ffmpeg conversion when it can't; 'transcode' always converts;
   * 'direct' never does. `transcode: true` is the older spelling of mode 'transcode'.
   */
  async function play({ file, deviceId, mode, transcode }) {
    mode = mode ?? (transcode ? 'transcode' : 'auto');
    const full = requireFile(file);
    const device = devices.get(deviceId);
    if (!device) throw new AgentError('DEVICE_UNKNOWN', 'That device is no longer known — rescan and pick it again');
    if (mode === 'transcode' && !transcoder) throw new AgentError('NO_FFMPEG', 'Transcoding needs ffmpeg installed on the Mac (brew install ffmpeg)');

    const renderer = new Renderer(device);
    // The renderer's advertised formats: used to pick MIME spellings it knows
    // and, with ffprobe's codec info, to decide whether the file plays as-is.
    const sink = await renderer.sinkMimeTypes().catch(() => null);
    const picked = pickMime(mimeOf(full), sink);

    const ext = path.extname(full).toLowerCase();
    let reason = null; // why we're transcoding; null = stream the original
    if (mode === 'transcode') reason = 'Transcode set to Always';
    else if (mode === 'auto' && transcoder && learnedFailures(device.id).includes(ext)) {
      reason = `${ext} files didn't play directly on this monitor before`;
    } else if (mode === 'auto' && transcoder) {
      const info = await transcoder.probe(full).catch(() => null);
      reason = info ? transcodeReason(info, picked.supported) : picked.supported ? null : 'container not supported by the monitor';
    }
    let warning = null;
    if (!reason && !picked.supported) {
      warning = `The monitor doesn't list ${picked.mime} as supported; playback may fail.`;
      warning += transcoder ? ' Set Transcode to Always if it does.' : ' Install ffmpeg (brew install ffmpeg) so the agent can convert it.';
    }

    const params = { file, full, device, renderer, sink, mime: picked.mime, mode, warning };
    try {
      await startCast({ ...params, reason });
    } catch (err) {
      // The monitor refused the original outright: convert it instead.
      if (err.code !== 'UNSUPPORTED_FORMAT' || reason || mode !== 'auto' || !transcoder) throw err;
      console.log(`[cast] monitor rejected ${file} (${err.message}); retrying with transcoding`);
      learnFailure(device.id, ext);
      await startCast({ ...params, warning: null, reason: 'the monitor rejected the original file' });
    }
    return { warning: session.warning, transcodeReason: session.reason };
  }

  /** Load a file on the renderer (original or transcoded) and start a new session. */
  async function startCast({ file, full, device, renderer, sink, mime, mode, reason, warning }) {
    const transcode = Boolean(reason);
    const kind = kindOf(full);
    let duration = 0;
    if (transcode) {
      const info = await transcoder.probe(full);
      duration = info.duration;
      mime = pickMime(info.video ? 'video/mp2t' : 'audio/mpeg', sink).mime;
    }

    const url = transcode ? transcodeUrl(file, 0) : mediaUrl(file);
    const sub = kind === 'video' ? findSubtitle(full) : null;
    const subtitleUrl = sub ? mediaUrl(path.relative(mediaDir, sub).split(path.sep).join('/')) : null;
    const didl = buildDidl({
      title: path.basename(full),
      url,
      mime,
      kind,
      size: transcode ? 0 : fs.statSync(full).size,
      duration,
      subtitleUrl,
      seekable: !transcode,
    });

    console.log(`[cast] ${file} -> ${device.name} ${transcode ? `(transcoding: ${reason})` : '(original file)'}`);
    const startedAt = Date.now();
    await renderer.cast(url, didl);

    session = {
      file, full, name: path.basename(full), kind, mime, sink, device, renderer, url, mode,
      transcode, reason, offset: 0, duration, startedAt, warning, seenActive: false, retried: false,
    };
    error = null;
    live = { transport: 'TRANSITIONING', position: 0, duration, volume: live.volume };
    store.set('lastDeviceId', device.id);
    startPolling();
    changed();
  }

  async function seek({ seconds }) {
    const s = requireSession();
    const target = Math.max(0, Number(seconds) || 0);
    if (s.transcode) {
      // A transcoded stream can't byte-seek: restart ffmpeg at the new offset.
      const didl = buildDidl({ title: s.name, url: transcodeUrl(s.file, target), mime: s.mime, kind: s.kind, duration: s.duration, seekable: false });
      await s.renderer.cast(transcodeUrl(s.file, target), didl);
      s.offset = target;
      if (error?.code === 'RENDERER_ERROR') error = null; // fresh stream, fresh start
    } else {
      await s.renderer.seek(target);
    }
    live.position = target;
    changed();
  }

  async function browserLink({ file }) {
    requireFile(file);
    const playerUrl = `${baseUrl}/player?f=${encodeURIComponent(file)}`;
    return {
      playerUrl,
      mediaUrl: mediaUrl(file),
      indexUrl: `${baseUrl}/`,
      qrSvg: await QRCode.toString(playerUrl, { type: 'svg', margin: 1 }),
    };
  }

  async function setFolder({ path: dir }) {
    const resolved = cleanPath(dir);
    checkReadable(resolved);
    mediaDir = resolved;
    store.set('mediaDir', resolved);
    changed();
    return { root: mediaDir, files: await listMedia(mediaDir) };
  }

  async function pickFolder() {
    const picked = await chooseInFinder({ kind: 'folder', defaultDir: mediaDir });
    return picked ? setFolder({ path: picked }) : { cancelled: true };
  }

  /** Pick one file in Finder. Keeps the current folder if the file is inside it, else switches to the file's folder. */
  async function pickFile() {
    const picked = await chooseInFinder({ kind: 'file', defaultDir: mediaDir });
    if (!picked) return { cancelled: true };
    if (!kindOf(picked)) throw new AgentError('UNSUPPORTED_FORMAT', `Not a video or audio file: ${path.basename(picked)}`);
    if (!resolveInside(mediaDir, path.relative(mediaDir, picked))) await setFolder({ path: path.dirname(picked) });
    return { root: mediaDir, files: await listMedia(mediaDir), file: path.relative(mediaDir, picked).split(path.sep).join('/') };
  }

  // --- polling -------------------------------------------------------------

  function startPolling() {
    clearTimeout(pollTimer);
    pollFailures = 0;
    const generation = ++pollGeneration; // a newer startPolling() retires this loop
    const loop = async () => {
      await poll();
      if (session && generation === pollGeneration) pollTimer = setTimeout(loop, 1000);
    };
    pollTimer = setTimeout(loop, 500);
  }

  async function poll() {
    const s = session;
    if (!s) return;
    try {
      const t = await s.renderer.transportInfo();
      const p = await s.renderer.positionInfo();
      if (s !== session) return; // a new cast started while we waited
      live.transport = t.state;
      live.position = p.position + s.offset;
      live.duration = s.duration || p.duration;
      if (pollTick++ % 3 === 0 && s.device.services.renderingControl) {
        live.volume = await s.renderer.getVolume().catch(() => live.volume);
      }
      pollFailures = 0;
      if (error?.code === 'RENDERER_OFFLINE') error = null;

      // Auto mode: if the monitor gives up on the original file right after
      // starting (error status, or back to STOPPED without playing), it most
      // likely can't decode it. Recast once through ffmpeg.
      if (['PLAYING', 'TRANSITIONING', 'PAUSED_PLAYBACK'].includes(t.state)) s.seenActive = true;
      const gaveUp =
        (t.status && t.status !== 'OK') ||
        (s.seenActive && ['STOPPED', 'NO_MEDIA_PRESENT'].includes(t.state) && p.position < 3);
      if (gaveUp && s.mode === 'auto' && !s.transcode && !s.retried && transcoder && Date.now() - s.startedAt < 30_000) {
        s.retried = true;
        console.log(`[cast] monitor stopped ${s.file} (${t.state}/${t.status}); retrying with transcoding`);
        learnFailure(s.device.id, path.extname(s.full).toLowerCase());
        startCast({ ...s, warning: null, reason: 'the monitor could not play the original file' }).catch((err) => {
          error = { code: err.code ?? 'ERROR', message: err.message };
          changed();
        });
        return;
      }

      if (t.status && t.status !== 'OK') {
        error = { code: 'RENDERER_ERROR', message: `The monitor reported "${t.status}" — the file may use an unsupported codec/container.` };
      } else if (!((lastFetch.get(s.file) ?? 0) >= s.startedAt) && Date.now() - s.startedAt > 10_000 && !error) {
        error = {
          code: 'URL_UNREACHABLE',
          message: `The monitor hasn't requested ${s.url}. Check that the Mac firewall allows incoming connections for node, and that both are on the same network.`,
        };
      }
    } catch (err) {
      if (++pollFailures >= 3) error = { code: 'RENDERER_OFFLINE', message: 'Lost contact with the monitor. Is it switched on and connected to Wi-Fi?' };
    }
    updateCaffeinate();
    changed();
  }

  // Keep the Mac from idle-sleeping while it's serving a stream (macOS only).
  function updateCaffeinate() {
    const busy = session && ['PLAYING', 'TRANSITIONING'].includes(live.transport);
    if (busy && !caffeinate && process.platform === 'darwin') {
      caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      caffeinate.on('exit', () => (caffeinate = null));
    } else if (!busy && caffeinate) {
      caffeinate.kill();
      caffeinate = null;
    }
  }

  // --- command dispatch ----------------------------------------------------

  const handlers = {
    getState: () => state(),
    listFiles: async () => ({ root: mediaDir, files: await listMedia(mediaDir) }),
    setFolder,
    pickFolder,
    pickFile,
    rescan: async () => {
      await rescan();
      return state().devices;
    },
    selectDevice: ({ deviceId }) => {
      store.set('lastDeviceId', deviceId);
      changed();
    },
    play,
    pause: async () => {
      await requireSession().renderer.pause();
      live.transport = 'PAUSED_PLAYBACK';
      changed();
    },
    resume: async () => {
      await requireSession().renderer.play();
      live.transport = 'PLAYING';
      changed();
    },
    stop: async () => {
      const s = requireSession();
      session = null;
      clearTimeout(pollTimer);
      live = { transport: 'STOPPED', position: 0, duration: 0, volume: live.volume };
      error = null;
      updateCaffeinate();
      changed();
      await s.renderer.stop().catch(() => {}); // already gone from our side either way
    },
    seek,
    volume: async ({ level }) => {
      await requireSession().renderer.setVolume(level);
      live.volume = Math.round(level);
      changed();
    },
    browserLink,
  };

  return {
    baseUrl,
    getRoot: () => mediaDir,
    state,
    rescan,
    onChange: (fn) => (listener = fn),
    async handle(action, params) {
      const fn = handlers[action];
      if (!fn) throw new AgentError('UNKNOWN_ACTION', `Unknown action: ${action}`);
      return (await fn(params)) ?? null;
    },
    /** Called by the media server whenever someone fetches a file. */
    noteFetch(rel) {
      lastFetch.set(rel, Date.now());
      if (session?.file === rel && error?.code === 'URL_UNREACHABLE') error = null;
    },
  };
}

/**
 * Turn a pasted path into an absolute one. Handles what Finder and Terminal
 * produce: surrounding quotes ('/Volumes/My Drive'), backslash-escaped spaces
 * (/Volumes/My\ Drive) and file:// URLs.
 */
export function cleanPath(input) {
  let p = String(input ?? '').trim();
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  else p = p.replace(/\\(.)/g, '$1');
  if (p.startsWith('file://')) p = decodeURIComponent(new URL(p).pathname);
  p = expandHome(p);
  if (!path.isAbsolute(p)) throw new AgentError('BAD_FOLDER', `Use a full path starting with / or ~ (got "${input}")`);
  return path.resolve(p);
}

function checkReadable(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) throw new AgentError('BAD_FOLDER', `Not a folder: ${dir}`);
    fs.readdirSync(dir);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    if (err.code === 'ENOENT') throw new AgentError('BAD_FOLDER', `No such folder on the Mac: ${dir}`);
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      throw new AgentError(
        'NO_PERMISSION',
        `macOS blocked the agent from reading ${dir}. Allow "node" under System Settings › Privacy & Security › Files and Folders (Removable Volumes) or Full Disk Access, then restart the agent.`,
      );
    }
    throw new AgentError('BAD_FOLDER', `Cannot read ${dir}: ${err.message}`);
  }
}

function validDir(p) {
  try {
    return Boolean(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
