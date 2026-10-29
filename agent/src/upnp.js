// UPnP AV control: SOAP calls to a renderer's AVTransport / RenderingControl.
//
// Casting a file is always:
//   SetAVTransportURI(InstanceID=0, CurrentURI=<http url>, CurrentURIMetaData=<DIDL-Lite>)
//   Play(InstanceID=0, Speed=1)
// and progress comes from polling GetTransportInfo + GetPositionInfo.
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// UPnP AVTransport error codes -> something a person can act on.
const UPNP_ERRORS = {
  701: 'The monitor refused that action in its current state',
  702: 'No media loaded on the monitor',
  704: 'The monitor cannot play this format',
  710: 'The monitor does not support seeking this way',
  711: 'Seek position is out of range',
  714: 'The monitor does not support this file type (codec/container unsupported) — try Transcode or browser mode',
  715: 'The monitor reports the media is busy',
  716: 'The monitor could not fetch the media URL — check the Mac firewall and that both are on the same network',
  718: 'The monitor rejected the playback instance',
};

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function soap(service, action, args = {}) {
  if (!service) throw new AgentError('UNSUPPORTED', `This renderer does not support ${action}`);
  // Argument order matters to some renderers: keep it as given (InstanceID first).
  const params = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service.type}">${params}</u:${action}></s:Body></s:Envelope>`;

  let res;
  try {
    res = await fetch(service.controlURL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service.type}#${action}"` },
      body,
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    throw new AgentError('RENDERER_OFFLINE', `The monitor is not responding (${err.cause?.code || err.name}). Is it on and on this network?`);
  }
  const text = await res.text();
  const doc = xml.parse(text);
  if (!res.ok) {
    const e = doc.Envelope?.Body?.Fault?.detail?.UPnPError;
    const code = Number(e?.errorCode);
    const detail = UPNP_ERRORS[code] ?? e?.errorDescription ?? `HTTP ${res.status}`;
    throw new AgentError(code === 714 || code === 704 ? 'UNSUPPORTED_FORMAT' : 'UPNP_ERROR', `${action} failed: ${detail}${code ? ` (UPnP ${code})` : ''}`);
  }
  return doc.Envelope?.Body?.[`${action}Response`] ?? {};
}

export function toHms(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function fromHms(str) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/.exec(String(str ?? ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Renderer {
  constructor(device) {
    this.device = device;
    this.s = device.services;
  }

  avt(action, args = {}) {
    return soap(this.s.avTransport, action, { InstanceID: 0, ...args });
  }

  /** Load a URL + DIDL-Lite metadata, then start playback. */
  async cast(url, didl) {
    // Some Samsung firmware rejects SetAVTransportURI while something is playing.
    await this.avt('Stop').catch(() => {});
    await this.avt('SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: didl });
    // Right after loading, the TV can be TRANSITIONING and answer 701; retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.play();
      } catch (err) {
        if (attempt >= 5 || !/UPnP 701/.test(err.message)) throw err;
        await sleep(500);
      }
    }
  }

  play() {
    return this.avt('Play', { Speed: 1 });
  }
  pause() {
    return this.avt('Pause');
  }
  stop() {
    return this.avt('Stop');
  }
  seek(seconds) {
    return this.avt('Seek', { Unit: 'REL_TIME', Target: toHms(seconds) });
  }

  async transportInfo() {
    const r = await this.avt('GetTransportInfo');
    return { state: r.CurrentTransportState, status: r.CurrentTransportStatus };
  }

  async positionInfo() {
    const r = await this.avt('GetPositionInfo');
    return { position: fromHms(r.RelTime), duration: fromHms(r.TrackDuration), uri: r.TrackURI };
  }

  async getVolume() {
    const r = await soap(this.s.renderingControl, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    return Number(r.CurrentVolume);
  }

  setVolume(level) {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    return soap(this.s.renderingControl, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: v });
  }

  /** MIME types the renderer says it can play (from ConnectionManager Sink). */
  async sinkMimeTypes() {
    if (this._sink) return this._sink;
    const r = await soap(this.s.connectionManager, 'GetProtocolInfo');
    // Each entry looks like "http-get:*:video/mp4:DLNA.ORG_PN=..."
    this._sink = new Set(
      String(r.Sink ?? '')
        .split(',')
        .map((p) => p.split(':')[2]?.trim().toLowerCase())
        .filter(Boolean),
    );
    return this._sink;
  }
}
