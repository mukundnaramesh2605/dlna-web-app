import os from 'node:os';
import path from 'node:path';

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// The monitor must reach us over Wi-Fi, so localhost is useless here.
// Prefer en0 (Wi-Fi on most Macs), then any other private IPv4 address.
export function detectLanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  candidates.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : 0));
  return candidates[0]?.address ?? '127.0.0.1';
}

export const config = {
  mediaDir: path.resolve(expandHome(process.env.MEDIA_DIR || '~/Movies')),
  port: Number(process.env.HTTP_PORT || 8200),
  host: process.env.AGENT_HOST || detectLanIp(),
  relayUrl: process.env.RELAY_URL || 'ws://localhost:8080/agent',
  token: process.env.PAIRING_TOKEN || '',
  stateFile: path.join(os.homedir(), '.config', 'dlna-agent', 'state.json'),
};

export { expandHome };
