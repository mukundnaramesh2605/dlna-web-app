// Cloud relay + UI host.
//
//   Browser UI  --wss /ui-->   relay   <--wss /agent--  Mac agent (dials out)
//
// The relay holds the agent's socket, authenticates both sides with the
// pairing token, and forwards JSON control messages. It keeps no state beyond
// the open sockets and in-flight command ids, and never sees media bytes.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.PAIRING_TOKEN || '';
const COMMAND_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 15_000;

if (TOKEN.length < 16) {
  console.error('PAIRING_TOKEN must be set to a random string of at least 16 characters (e.g. `openssl rand -hex 24`).');
  process.exit(1);
}

function tokenOk(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const send = (ws, msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

// --- HTTP: static UI + health check ---------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  // Behind Render/Caddy the original scheme is in X-Forwarded-Proto: force HTTPS.
  if (process.env.FORCE_HTTPS === '1' && req.protocol === 'http') return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true, agentConnected: Boolean(agent) }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

// --- WebSocket routing ------------------------------------------------------

let agent = null; // the single connected agent socket
const uis = new Set(); // authenticated UI sockets
const pending = new Map(); // relay id -> { ui, id, timer }
let nextId = 1;

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://relay');
  if (pathname === '/agent') {
    // The agent sends the token as a bearer header; reject before upgrading.
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(auth)) {
      console.warn(`[relay] rejected agent from ${req.socket.remoteAddress}: bad token`);
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, onAgent);
  } else if (pathname === '/ui') {
    // Browsers can't set WebSocket headers, so the UI authenticates in its first message.
    wss.handleUpgrade(req, socket, head, onUi);
  } else {
    socket.destroy();
  }
});

function broadcast(msg) {
  for (const ui of uis) send(ui, msg);
}

function onAgent(ws) {
  if (agent) agent.terminate(); // newest connection wins (e.g. agent restarted)
  agent = ws;
  watch(ws);
  console.log('[relay] agent connected');
  broadcast({ type: 'agent', connected: true });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      send(p.ui, { ...msg, id: p.id }); // restore the UI's own id
    } else if (msg.type === 'state') {
      broadcast(msg);
    }
  });

  ws.on('close', () => {
    if (agent !== ws) return;
    agent = null;
    console.log('[relay] agent disconnected');
    broadcast({ type: 'agent', connected: false });
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      send(p.ui, { type: 'result', id: p.id, ok: false, error: { code: 'AGENT_DISCONNECTED', message: 'The agent disconnected before replying.' } });
      pending.delete(id);
    }
  });
}

function onUi(ws) {
  let authed = false;
  watch(ws);
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!authed) {
      clearTimeout(authTimer);
      if (msg.type !== 'auth' || !tokenOk(msg.token)) return ws.close(4001, 'bad token');
      authed = true;
      uis.add(ws);
      return send(ws, { type: 'hello', agentConnected: Boolean(agent) });
    }

    if (msg.type !== 'cmd') return;
    if (!agent) {
      return send(ws, {
        type: 'result',
        id: msg.id,
        ok: false,
        error: { code: 'AGENT_OFFLINE', message: 'The Mac agent is not connected (Mac asleep, offline, or agent stopped).' },
      });
    }
    // Re-number so ids from different browser tabs can't collide.
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      send(ws, { type: 'result', id: msg.id, ok: false, error: { code: 'TIMEOUT', message: 'The agent did not reply in time.' } });
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { ui: ws, id: msg.id, timer });
    send(agent, { type: 'cmd', id, action: String(msg.action), params: msg.params ?? {} });
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    uis.delete(ws);
  });
}

// Ping every socket; terminate those that miss a pong. This is how a sleeping
// Mac (whose TCP connection silently dies) gets noticed within ~30s.
function watch(ws) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
}
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
