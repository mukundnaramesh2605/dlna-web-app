// Monitor Cast UI. Talks only to the relay over one WebSocket:
//   -> {type:'auth', token}           first message
//   -> {type:'cmd', id, action, params}
//   <- {type:'hello'|'agent', ...}     relay / agent connection status
//   <- {type:'state', state}           pushed by the agent on every change
//   <- {type:'result', id, ok, data|error}
'use strict';

const $ = (sel) => document.querySelector(sel);

const ui = {
  relay: 'connecting', // 'connecting' | 'connected' | 'disconnected'
  agentConnected: false,
  state: null, // latest agent state
  files: [],
  filesRoot: '',
  filter: '',
  selectedFile: null,
  deviceId: null,
  seeking: false,
  picking: false, // a Finder dialog is open on the Mac
  casting: false, // a play/continue command is in flight
  dismissedError: null, // "code|message" of the error the user closed
};

// --- storage (may be unavailable in private windows) ----------------------

const memory = {}; // fallback so pairing still works for this tab when storage is blocked
const storage = {
  get(k) { try { return localStorage.getItem(k) ?? memory[k] ?? null; } catch { return memory[k] ?? null; } },
  set(k, v) { memory[k] = v; try { localStorage.setItem(k, v); } catch {} },
  del(k) { delete memory[k]; try { localStorage.removeItem(k); } catch {} },
};

// --- relay connection -----------------------------------------------------

let ws = null;
let nextId = 1;
const waiting = new Map();
let reconnectTimer = null;

function connect() {
  const token = storage.get('pairingToken');
  if (!token) return showLogin();
  clearTimeout(reconnectTimer);
  ui.relay = 'connecting';
  render();

  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };
  ws.onclose = (e) => {
    for (const { reject } of waiting.values()) reject(new Error('Lost connection to the relay.'));
    waiting.clear();
    ui.relay = 'disconnected';
    ui.agentConnected = false;
    render();
    if (e.code === 4001) {
      storage.del('pairingToken');
      showLogin('That pairing token was rejected.');
    } else {
      reconnectTimer = setTimeout(connect, 2000);
    }
  };
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      ui.relay = 'connected';
      setAgent(msg.agentConnected);
      break;
    case 'agent':
      setAgent(msg.connected);
      break;
    case 'state':
      ui.state = msg.state;
      render();
      break;
    case 'result': {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.data);
      else w.reject(Object.assign(new Error(msg.error?.message ?? 'Command failed'), { code: msg.error?.code }));
      break;
    }
  }
}

function setAgent(connected) {
  const was = ui.agentConnected;
  ui.agentConnected = connected;
  render();
  if (connected && !was) refresh();
}

function cmd(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to the relay.'));
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'cmd', id, action, params }));
    // Long, because Finder pickers wait for someone at the Mac.
    setTimeout(() => {
      if (waiting.delete(id)) reject(new Error(`No reply for "${action}".`));
    }, 330_000);
  });
}

/** Run a command and surface any failure as a toast. */
async function run(action, params) {
  try {
    return await cmd(action, params);
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

async function refresh() {
  const state = await run('getState');
  if (state) ui.state = state;
  await loadFiles();
  render();
}

async function loadFiles() {
  const res = await run('listFiles');
  if (!res) return;
  ui.files = res.files;
  ui.filesRoot = res.root;
  if (ui.selectedFile && !ui.files.some((f) => f.path === ui.selectedFile)) ui.selectedFile = null;
  renderFiles();
}

// --- rendering --------------------------------------------------------------

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function pill(id, cls, label) {
  const p = $(id);
  p.className = `pill ${cls}`;
  p.querySelector('span').textContent = label;
}

function currentDeviceId() {
  const devices = ui.state?.devices ?? [];
  const pick = ui.deviceId ?? ui.state?.session?.deviceId ?? ui.state?.lastDeviceId;
  if (devices.some((d) => d.id === pick)) return pick;
  return devices.length === 1 ? devices[0].id : null;
}

function render() {
  const s = ui.state;
  const online = ui.relay === 'connected' && ui.agentConnected;

  pill('#pill-relay', { connected: 'ok', connecting: 'warn', disconnected: 'bad' }[ui.relay],
    { connected: 'Relay connected', connecting: 'Connecting…', disconnected: 'Relay offline' }[ui.relay]);
  pill('#pill-agent', online ? 'ok' : 'bad', online ? 'Agent online' : 'Agent offline');
  $('#offline').hidden = online || ui.relay !== 'connected';

  const err = online ? s?.error : null;
  // Hidden straight away on close, without waiting for the agent's state push.
  $('#error').hidden = !err || `${err.code}|${err.message}` === ui.dismissedError;
  if (err) {
    $('#error-title').textContent = errorTitle(err.code);
    $('#error-text').textContent = err.message;
  }

  $('#folder').textContent = ui.filesRoot || s?.agent?.mediaDir || '—';
  $('#change-folder').disabled = !online;
  $('#pick-folder').disabled = !online || ui.picking;
  $('#pick-file').disabled = !online || ui.picking;
  $('#filter').disabled = !online && !ui.files.length;

  renderContinue(online);
  renderDevices(online);
  renderCast(online);
  renderNowPlaying(online);
  renderFiles();
}

function errorTitle(code) {
  return {
    RENDERER_OFFLINE: 'Monitor offline.',
    URL_UNREACHABLE: 'Monitor can’t reach the Mac.',
    RENDERER_ERROR: 'Playback problem.',
    UNSUPPORTED_FORMAT: 'Unsupported format.',
  }[code] ?? 'Problem.';
}

function renderDevices(online) {
  const list = $('#device-list');
  const devices = ui.state?.devices ?? [];
  const sel = currentDeviceId();
  list.replaceChildren(
    ...devices.map((d) => {
      const li = el('li', { className: d.id === sel ? 'sel' : '', title: d.id },
        el('span', { className: 'dot' }),
        el('div', {}, el('div', { textContent: d.name }), el('div', { className: 'sub', textContent: `${d.ip} · ${d.manufacturer} ${d.model}`.trim() })));
      li.onclick = () => {
        ui.deviceId = d.id;
        render();
        run('selectDevice', { deviceId: d.id });
      };
      return li;
    }),
  );
  const scanning = ui.state?.scanning;
  $('#devices-empty').hidden = devices.length > 0 || !online || scanning;
  $('#rescan').disabled = !online || scanning;
  $('#rescan').textContent = scanning ? 'Scanning…' : 'Rescan';
}

function renderCast(online) {
  const file = ui.files.find((f) => f.path === ui.selectedFile);
  $('#selected').textContent = file ? file.path : 'Pick a file from the list.';
  const saved = file && savedProgress(file.path);
  $('#cast').disabled = !online || !file || !currentDeviceId() || ui.casting;
  $('#cast').textContent = ui.casting ? 'Casting…' : saved ? `Resume at ${fmtTime(saved.position)}` : 'Cast to monitor';
  $('#start-over').hidden = !saved;
  $('#start-over').disabled = $('#cast').disabled;
  $('#browser').disabled = !online || !file;
  const canTranscode = Boolean(ui.state?.agent?.transcoding);
  $('#mode').disabled = !canTranscode;
  $('#mode-wrap').title = canTranscode
    ? 'Auto: play the original when the monitor can decode it, otherwise convert it with ffmpeg on the Mac. Always: always convert. Never: always send the original.'
    : 'Install ffmpeg on the Mac (brew install ffmpeg) to enable transcoding';
}

function renderNowPlaying(online) {
  const s = ui.state;
  const session = online ? s?.session : null;
  const transport = s?.transport ?? 'STOPPED';
  $('#now-title').textContent = session ? session.name : 'Nothing playing';
  $('#now-sub').textContent = session
    ? `on ${session.deviceName} · ${prettyTransport(transport)}${session.transcode ? ` · transcoding (${session.transcodeReason})` : ''}`
    : '';
  $('#now-warning').hidden = !session?.warning;
  $('#now-warning').textContent = session?.warning ?? '';

  const busy = transport === 'TRANSITIONING';
  const duration = session ? s.duration : 0;
  const seek = $('#seek');
  seek.max = String(Math.max(0, Math.floor(duration)));
  seek.disabled = !session || !duration || busy;
  if (!ui.seeking) {
    seek.value = String(session ? Math.floor(s.position) : 0);
    $('#pos').textContent = fmtTime(session ? s.position : 0);
  }
  $('#dur').textContent = fmtTime(duration);

  const pp = $('#playpause');
  const playing = transport === 'PLAYING';
  pp.textContent = playing ? '❚❚' : '▶';
  pp.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  pp.disabled = !session || busy;
  $('#stop').disabled = !session;

  const vol = $('#volume');
  const hasVol = session && s.volume != null;
  vol.disabled = !hasVol;
  if (hasVol && document.activeElement !== vol) vol.value = String(s.volume);
  $('#vol-val').textContent = hasVol ? String(s.volume) : '–';
}

function prettyTransport(t) {
  return { PLAYING: 'Playing', PAUSED_PLAYBACK: 'Paused', STOPPED: 'Stopped', TRANSITIONING: 'Loading…', NO_MEDIA_PRESENT: 'Idle' }[t] ?? t;
}

let lastFilesKey = '';
function renderFiles() {
  const terms = ui.filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = ui.files.filter((f) => terms.every((t) => f.path.toLowerCase().includes(t)));
  const playing = ui.state?.session?.file;
  // Rebuilding a long list on every 1s state push is wasteful; only do it when something visible changed.
  const key = `${ui.files.length}|${ui.filter}|${ui.selectedFile}|${playing}|${ui.filesRoot}|${JSON.stringify(ui.state?.folderProgress)}`;
  if (key === lastFilesKey) return;
  lastFilesKey = key;

  const frag = document.createDocumentFragment();
  for (const f of shown) {
    const slash = f.path.lastIndexOf('/');
    const li = el('li', { className: [f.path === ui.selectedFile && 'sel', f.path === playing && 'playing'].filter(Boolean).join(' '), title: f.path },
      el('span', { textContent: f.kind === 'audio' ? '♪' : '▶' }),
      el('div', {},
        el('div', { className: 'name', textContent: f.name }),
        slash > 0 ? el('div', { className: 'dir', textContent: f.path.slice(0, slash) }) : null,
        savedProgress(f.path) ? progressBar(savedProgress(f.path).position, savedProgress(f.path).duration) : null),
      el('div', { className: 'meta' }, f.subtitles ? el('span', { className: 'tag', textContent: 'SRT', title: 'Subtitles found' }) : null, ` ${fmtSize(f.size)}`));
    li.onclick = () => { ui.selectedFile = f.path; render(); };
    li.ondblclick = () => { ui.selectedFile = f.path; castSelected(); };
    frag.append(li);
  }
  $('#file-list').replaceChildren(frag);
  const empty = $('#files-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = !ui.agentConnected && !ui.files.length
    ? 'Files appear when the agent is online.'
    : ui.files.length ? 'No files match the filter.' : 'No video or audio files in this folder.';
}

// --- toasts -------------------------------------------------------------------

function toast(text, kind = 'info') {
  const t = el('div', { className: `toast ${kind}`, textContent: text, role: 'status' });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 4500);
}

// --- actions --------------------------------------------------------------------

/** Cast the selected file; resumes from its saved position unless fromStart. */
async function castSelected({ fromStart = false } = {}) {
  const deviceId = currentDeviceId();
  if (!ui.selectedFile || !deviceId) return;
  const startAt = fromStart ? 0 : savedProgress(ui.selectedFile)?.position ?? 0;
  ui.casting = true;
  render();
  const res = await run('play', { file: ui.selectedFile, deviceId, mode: $('#mode').value, startAt });
  ui.casting = false;
  render();
  if (res?.warning) toast(res.warning, 'warn');
}

async function continueWatching(item) {
  const deviceId = currentDeviceId();
  if (!deviceId) return toast('Pick a device first.', 'warn');
  ui.casting = true;
  render();
  const res = await run('continue', { id: item.id, deviceId, mode: $('#mode').value });
  ui.casting = false;
  if (res) {
    ui.files = res.files;
    ui.filesRoot = res.root;
    ui.selectedFile = res.file;
  }
  render();
  if (res?.warning) toast(res.warning, 'warn');
}

function savedProgress(relPath) {
  return ui.state?.folderProgress?.[relPath] ?? null;
}

function progressBar(position, duration) {
  const pct = duration ? Math.min(100, Math.max(2, (position / duration) * 100)) : 0;
  const bar = el('div', { className: 'progress' }, el('i'));
  bar.firstChild.style.width = `${pct}%`;
  return bar;
}

let lastContinueKey = '';
function renderContinue(online) {
  const items = online ? ui.state?.continueWatching ?? [] : [];
  $('#continue').hidden = items.length === 0;
  const key = JSON.stringify(items) + ui.casting;
  if (key === lastContinueKey) return;
  lastContinueKey = key;
  $('#continue-list').replaceChildren(
    ...items.map((item) => {
      const forget = el('button', { className: 'forget', textContent: '×', title: 'Remove from Continue watching' });
      forget.setAttribute('aria-label', `Remove ${item.name} from Continue watching`);
      forget.onclick = (e) => {
        e.stopPropagation();
        run('forget', { id: item.id });
      };
      const li = el('li', { title: item.id },
        forget,
        el('div', { className: 'title', textContent: item.name }),
        el('div', { className: 'sub', textContent: `${item.folder} · ${fmtTime(item.position)} of ${fmtTime(item.duration)}` }),
        progressBar(item.position, item.duration));
      li.onclick = () => !ui.casting && continueWatching(item);
      return li;
    }),
  );
}

async function openInBrowser() {
  if (!ui.selectedFile) return;
  const res = await run('browserLink', { file: ui.selectedFile });
  if (!res) return;
  // Shown as an <img> so the agent-generated SVG can't run anything.
  $('#qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(res.qrSvg)}`;
  $('#fallback-url').href = res.playerUrl;
  $('#fallback-url').textContent = res.playerUrl;
  $('#fallback').hidden = false;
}

function applyFolder(res) {
  if (!res || res.cancelled) return;
  ui.files = res.files;
  ui.filesRoot = res.root;
  ui.selectedFile = null;
  render();
}

/** Run a Finder-picker action, with a hint that the dialog is on the Mac's screen. */
async function withPicker(button, fn) {
  const btn = $(button);
  const label = btn.textContent;
  btn.textContent = 'Waiting for Finder on the Mac…';
  ui.picking = true;
  render();
  toast('A Finder dialog is open on the Mac. Make your choice there.');
  try {
    await fn();
  } finally {
    ui.picking = false;
    btn.textContent = label;
    render();
  }
}

function bind() {
  $('#cast').onclick = () => castSelected();
  $('#start-over').onclick = () => castSelected({ fromStart: true });
  $('#error-close').onclick = () => {
    const err = ui.state?.error;
    if (err) ui.dismissedError = `${err.code}|${err.message}`;
    render();
    run('dismissError');
  };
  $('#mode').value = storage.get('castMode') ?? 'auto';
  $('#mode').onchange = () => storage.set('castMode', $('#mode').value);
  $('#browser').onclick = openInBrowser;
  $('#copy-url').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#fallback-url').textContent);
      toast('URL copied');
    } catch {
      toast('Could not copy. Select the URL and copy it manually.', 'error');
    }
  };
  $('#rescan').onclick = () => run('rescan');
  $('#change-folder').onclick = async () => {
    const dir = prompt('Media folder on the Mac (absolute path or ~/…):', ui.filesRoot);
    if (!dir) return;
    applyFolder(await run('setFolder', { path: dir }));
  };
  $('#pick-folder').onclick = () => withPicker('#pick-folder', async () => {
    applyFolder(await run('pickFolder'));
  });
  $('#pick-file').onclick = () => withPicker('#pick-file', async () => {
    const res = await run('pickFile');
    if (!res || res.cancelled) return;
    applyFolder(res);
    ui.selectedFile = res.file;
    render();
    if (currentDeviceId()) await castSelected();
    else toast('File selected. Pick a device, then press Cast.');
  });
  $('#filter').oninput = (e) => {
    ui.filter = e.target.value;
    renderFiles();
  };
  $('#playpause').onclick = () => run(ui.state?.transport === 'PLAYING' ? 'pause' : 'resume');
  $('#stop').onclick = () => run('stop');

  const seek = $('#seek');
  seek.oninput = () => {
    ui.seeking = true;
    $('#pos').textContent = fmtTime(Number(seek.value));
  };
  seek.onchange = async () => {
    await run('seek', { seconds: Number(seek.value) });
    ui.seeking = false;
  };

  const vol = $('#volume');
  vol.oninput = () => ($('#vol-val').textContent = vol.value);
  vol.onchange = () => run('volume', { level: Number(vol.value) });

  $('#logout').onclick = () => {
    storage.del('pairingToken');
    ws?.close();
    location.reload();
  };

  $('#login-form').onsubmit = () => {
    storage.set('pairingToken', $('#token').value.trim());
    $('#token').value = '';
    connect();
  };
}

function showLogin(message = '') {
  ui.relay = 'disconnected';
  render();
  $('#login-error').textContent = message;
  const dlg = $('#login');
  if (!dlg.open) dlg.showModal();
}

bind();
render();
connect();
