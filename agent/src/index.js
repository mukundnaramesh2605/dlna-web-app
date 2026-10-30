// Timestamp log lines (the launchd log is otherwise impossible to correlate).
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => original(new Date().toLocaleString('sv-SE'), ...args); // local "YYYY-MM-DD HH:MM:SS"
}

import { config } from './config.js';
import { createStore } from './store.js';
import { createTranscoder } from './transcode.js';
import { createController } from './controller.js';
import { createMediaServer } from './media-server.js';
import { connectRelay } from './relay-client.js';

if (!config.token) {
  console.error('PAIRING_TOKEN is not set. Copy .env.example to .env and set it to the same value as the cloud relay.');
  process.exit(1);
}

const store = createStore(config.stateFile);
const transcoder = await createTranscoder();
const controller = createController({ config, store, transcoder });

const { server, events } = createMediaServer({
  getRoot: controller.getRoot,
  baseUrl: controller.baseUrl,
  transcoder,
});
events.on('fetch', ({ path, remote }) => {
  console.log(`[media] ${remote} fetched ${path}`);
  controller.noteFetch(path);
});

// Listen on all interfaces; the LAN IP is what we advertise to the monitor.
server.listen(config.port, '0.0.0.0', () => {
  console.log(`[media] serving ${controller.getRoot()} at ${controller.baseUrl}`);
  console.log(`[media] transcoding ${transcoder ? 'available (ffmpeg found)' : 'unavailable (install ffmpeg to enable)'}`);
});
server.on('error', (err) => {
  console.error(`[media] cannot listen on port ${config.port}: ${err.message}`);
  process.exit(1);
});

const relay = connectRelay({
  url: config.relayUrl,
  token: config.token,
  onCommand: (action, params) => controller.handle(action, params),
  onConnect: () => relay.send({ type: 'state', state: controller.state() }),
});

// Push state to the UI whenever it changes (deduplicated).
let lastSent = '';
controller.onChange((state) => {
  const json = JSON.stringify(state);
  if (json === lastSent) return;
  lastSent = json;
  relay.send({ type: 'state', state });
});

controller.rescan().catch((err) => console.error('[ssdp] scan failed:', err.message));
