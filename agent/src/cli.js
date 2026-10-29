// Standalone LAN test tool, no cloud needed (build-order step 1):
//   npm run discover                       list renderers on the network
//   npm run cast -- <file> [device-name]   serve <file> and play it on a renderer
import path from 'node:path';
import { config } from './config.js';
import { discoverRenderers } from './discovery.js';
import { createController } from './controller.js';
import { createMediaServer } from './media-server.js';
import { createTranscoder } from './transcode.js';

const [cmd, fileArg, deviceArg] = process.argv.slice(2);
const devices = await discoverRenderers(config.host);

if (cmd === 'discover') {
  if (!devices.length) console.log('No renderers found. Is the monitor on and on the same Wi-Fi?');
  for (const d of devices) {
    console.log(`${d.name}  ${d.ip}  ${d.manufacturer} ${d.model}`);
    console.log(`  ${d.id}`);
    console.log(`  AVTransport: ${d.services.avTransport.controlURL}`);
  }
  process.exit(0);
}

if (cmd === 'cast') {
  if (!fileArg) throw new Error('usage: npm run cast -- <file> [device-name] [--transcode]');
  const full = path.resolve(fileArg);
  const device = deviceArg && !deviceArg.startsWith('--')
    ? devices.find((d) => d.name.toLowerCase().includes(deviceArg.toLowerCase()))
    : devices[0];
  if (!device) throw new Error('No matching renderer found');

  const memory = new Map();
  const store = { get: (k) => memory.get(k), set: (k, v) => memory.set(k, v) };
  const transcoder = await createTranscoder();
  const controller = createController({ config: { ...config, mediaDir: path.dirname(full) }, store, transcoder });
  const { server, events } = createMediaServer({ getRoot: controller.getRoot, baseUrl: controller.baseUrl, transcoder });
  events.on('fetch', ({ path: p, remote }) => {
    console.log(`[media] ${remote} fetched ${p}`);
    controller.noteFetch(p);
  });
  await new Promise((r) => server.listen(config.port, '0.0.0.0', r));

  await controller.rescan();
  const result = await controller.handle('play', {
    file: path.basename(full),
    deviceId: device.id,
    transcode: process.argv.includes('--transcode'),
  });
  if (result.warning) console.warn('warning:', result.warning);
  controller.onChange((s) => {
    const line = `${s.transport} ${Math.round(s.position)}/${Math.round(s.duration)}s vol=${s.volume ?? '?'}${s.error ? '  ERROR: ' + s.error.message : ''}`;
    process.stdout.write(`\r${line.padEnd(100)}`);
  });
  console.log('Casting. Ctrl+C to stop.');
  process.on('SIGINT', async () => {
    await controller.handle('stop').catch(() => {});
    process.exit(0);
  });
} else if (cmd !== 'discover') {
  console.log('usage: node src/cli.js discover | cast <file> [device-name] [--transcode]');
}
