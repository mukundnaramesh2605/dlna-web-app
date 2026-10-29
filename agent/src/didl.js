// DIDL-Lite metadata sent alongside SetAVTransportURI. Samsung renderers use
// the <res protocolInfo> to decide whether they can play the URL, and the
// sec:CaptionInfoEx element to pick up external subtitles.
import { DLNA_FEATURES } from './media-server.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const UPNP_CLASS = {
  video: 'object.item.videoItem',
  audio: 'object.item.audioItem.musicTrack',
};

// Renderers name some containers differently; use whichever spelling the
// renderer advertises in its ConnectionManager sink list.
const MIME_ALIASES = {
  'video/x-matroska': ['video/x-matroska', 'video/x-mkv', 'video/mkv'],
  'video/x-msvideo': ['video/x-msvideo', 'video/avi', 'video/x-avi', 'video/divx'],
  'video/quicktime': ['video/quicktime', 'video/mp4'],
  'video/mp2t': ['video/mp2t', 'video/vnd.dlna.mpeg-tts', 'video/mpeg'],
  'video/x-ms-wmv': ['video/x-ms-wmv', 'video/x-ms-asf'],
  'audio/aac': ['audio/aac', 'audio/vnd.dlna.adts', 'audio/x-aac'],
  'audio/flac': ['audio/flac', 'audio/x-flac'],
  'audio/wav': ['audio/wav', 'audio/x-wav', 'audio/l16'],
};

/**
 * Pick the MIME spelling to advertise. Returns {mime, supported} where
 * supported is false only when the renderer published a sink list without it.
 */
export function pickMime(mime, sink) {
  if (!sink || sink.size === 0 || sink.has('*')) return { mime, supported: true };
  const match = (MIME_ALIASES[mime] ?? [mime]).find((m) => sink.has(m));
  return match ? { mime: match, supported: true } : { mime, supported: false };
}

export function buildDidl({ title, url, mime, kind, size, duration, subtitleUrl, seekable = true }) {
  const features = seekable ? DLNA_FEATURES : 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  const attrs = [`protocolInfo="http-get:*:${esc(mime)}:${features}"`];
  if (size) attrs.push(`size="${size}"`);
  if (duration) attrs.push(`duration="${formatDuration(duration)}"`);
  const subs = subtitleUrl
    ? `<sec:CaptionInfoEx sec:type="srt">${esc(subtitleUrl)}</sec:CaptionInfoEx>` +
      `<res protocolInfo="http-get:*:text/srt:*">${esc(subtitleUrl)}</res>`
    : '';
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<upnp:class>${UPNP_CLASS[kind] ?? UPNP_CLASS.video}</upnp:class>` +
    `<res ${attrs.join(' ')}>${esc(url)}</res>` +
    subs +
    '</item></DIDL-Lite>'
  );
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}.000`;
}
