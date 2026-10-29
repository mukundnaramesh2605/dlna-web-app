// SSDP discovery of UPnP MediaRenderers (Samsung Tizen TVs/monitors expose one).
//
// Flow:
//   1. Multicast an M-SEARCH to 239.255.255.250:1900 asking for MediaRenderer devices.
//   2. Each renderer replies (unicast UDP) with a LOCATION header: the URL of its
//      device-description XML.
//   3. Fetch that XML to get the friendly name and the control URLs of the
//      AVTransport (play/pause/seek), RenderingControl (volume) and
//      ConnectionManager (supported formats) services.
//
// Implemented on node:dgram directly: the protocol is a few lines, and the
// npm SSDP clients are unmaintained.
import dgram from 'node:dgram';
import { XMLParser } from 'fast-xml-parser';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
];

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

function mSearch(st) {
  return Buffer.from(
    ['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', ''].join('\r\n'),
  );
}

/** Send M-SEARCHes from the LAN interface and collect LOCATION URLs for timeoutMs. */
function collectLocations(lanIp, timeoutMs) {
  return new Promise((resolve) => {
    const locations = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg) => {
      const m = /^location:\s*(.+)$/im.exec(msg.toString());
      if (m) locations.add(m[1].trim());
    });
    sock.on('error', (err) => {
      console.error('[ssdp] socket error:', err.message);
      sock.close();
      resolve(locations);
    });
    // Choosing the LAN interface makes macOS send the multicast out of Wi-Fi
    // rather than whichever interface (VPN, Docker bridge...) is the default.
    // Note: binding to lanIp *and* setting it as the multicast interface makes
    // macOS fail the send with EHOSTUNREACH, so bind to all addresses.
    sock.bind(0, '0.0.0.0', () => {
      try {
        sock.setMulticastInterface(lanIp);
      } catch {}
      // UDP is lossy: send each search twice.
      for (const st of SEARCH_TARGETS) {
        for (const delay of [0, 300]) {
          setTimeout(() => sock.send(mSearch(st), SSDP_PORT, SSDP_ADDR), delay);
        }
      }
      setTimeout(() => {
        sock.close();
        resolve(locations);
      }, timeoutMs);
    });
  });
}

function* walkDevices(device) {
  if (!device) return;
  yield device;
  for (const child of [].concat(device.deviceList?.device ?? [])) yield* walkDevices(child);
}

/** Fetch and parse a device description; returns null if it has no AVTransport. */
export async function describe(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const doc = xml.parse(await res.text());
  const base = doc.root?.URLBase || location;

  for (const d of walkDevices(doc.root?.device)) {
    const services = [].concat(d.serviceList?.service ?? []);
    const find = (name) => {
      const s = services.find((s) => String(s.serviceType).includes(`:service:${name}:`));
      return s && { type: s.serviceType, controlURL: new URL(s.controlURL, base).href };
    };
    const avTransport = find('AVTransport');
    if (!avTransport) continue;
    return {
      id: d.UDN,
      name: d.friendlyName || 'Unknown renderer',
      manufacturer: d.manufacturer || '',
      model: d.modelName || '',
      ip: new URL(location).hostname,
      location,
      services: {
        avTransport,
        renderingControl: find('RenderingControl'),
        connectionManager: find('ConnectionManager'),
      },
    };
  }
  return null;
}

/** Discover renderers on the LAN. Resolves to a list of device objects. */
export async function discoverRenderers(lanIp, { timeoutMs = 3500 } = {}) {
  const locations = await collectLocations(lanIp, timeoutMs);
  const described = await Promise.all(
    [...locations].map((loc) =>
      describe(loc).catch((err) => {
        console.warn(`[ssdp] could not read ${loc}: ${err.message}`);
        return null;
      }),
    ),
  );
  const byId = new Map();
  for (const d of described) if (d && !byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()];
}
