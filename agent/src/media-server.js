// LAN HTTP server the monitor pulls media from. Media bytes only ever flow
// Mac -> monitor through this server; nothing here talks to the cloud.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { playerPage, indexPage } from './pages.js';
import { srtToVtt } from './subtitles.js';

export const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
};
const SUBTITLE_MIME = { '.srt': 'text/srt' };

export function kindOf(name) {
  const mime = MIME[path.extname(name).toLowerCase()];
  return mime ? mime.split('/')[0] : null; // 'video' | 'audio' | null
}

export function mimeOf(name) {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// DLNA.ORG_OP=01 advertises byte-range seeking; FLAGS marks it streamable.
// Samsung renderers check these before they'll offer a seek bar.
export const DLNA_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

/** Resolve a client-supplied relative path inside root, or null if it escapes. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

/** Sibling subtitle file for a video (movie.mkv -> movie.srt), if one exists. */
export function findSubtitle(fullPath) {
  const srt = fullPath.slice(0, -path.extname(fullPath).length) + '.srt';
  return fs.existsSync(srt) ? srt : null;
}

/** Recursively list playable files under root (relative POSIX paths). */
export async function listMedia(root, { maxDepth = 8, maxFiles = 5000 } = {}) {
  const files = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
        continue;
      }
      const kind = kindOf(e.name);
      if (!e.isFile() || !kind) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      const base = e.name.slice(0, -path.extname(e.name).length);
      files.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        name: e.name,
        kind,
        size: st.size,
        mtime: st.mtimeMs,
        subtitles: names.has(base + '.srt'),
      });
    }
  }
  await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Parse a single-range "Range: bytes=..." header.
 * Returns {start, end} (inclusive), null to serve the whole file, or 'invalid' for a 416.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or junk: spec allows ignoring and sending 200
  let start;
  let end;
  if (m[1] === '') {
    if (m[2] === '') return 'invalid';
    start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

/**
 * Routes:
 *   GET/HEAD /media/<path>       raw file with Range support (what the renderer fetches)
 *   GET      /subs/<path>.vtt    .srt converted to WebVTT for the browser player
 *   GET      /transcode/<path>   ffmpeg stream (only when a transcoder is supplied)
 *   GET      /player?f=<path>    HTML5 player page (Mode B browser fallback)
 *   GET      /                   file index for the monitor's browser
 */
export function createMediaServer({ getRoot, baseUrl, transcoder }) {
  const events = new EventEmitter(); // 'fetch' {path, remote} lets the controller confirm the monitor reached us

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const root = getRoot();
    try {
      if (url.pathname.startsWith('/media/')) {
        const rel = decodeURIComponent(url.pathname.slice('/media/'.length));
        return await serveFile(req, res, root, rel);
      }
      if (url.pathname.startsWith('/subs/') && url.pathname.endsWith('.vtt')) {
        const rel = decodeURIComponent(url.pathname.slice('/subs/'.length, -'.vtt'.length));
        const full = resolveInside(root, rel);
        if (!full || path.extname(full).toLowerCase() !== '.srt') return notFound(res);
        const vtt = srtToVtt(await fsp.readFile(full, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(vtt);
      }
      if (url.pathname.startsWith('/transcode/') && transcoder) {
        const rel = decodeURIComponent(url.pathname.slice('/transcode/'.length));
        const full = resolveInside(root, rel);
        if (!full || !kindOf(full) || !fs.existsSync(full)) return notFound(res);
        events.emit('fetch', { path: rel, remote: req.socket.remoteAddress });
        return transcoder.stream(full, Number(url.searchParams.get('t') || 0), req, res);
      }
      if (url.pathname === '/player') {
        const rel = url.searchParams.get('f') ?? '';
        const full = resolveInside(root, rel);
        if (!full || !kindOf(full) || !fs.existsSync(full)) return notFound(res);
        const sub = findSubtitle(full);
        const subRel = sub && path.relative(root, sub).split(path.sep).join('/');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          playerPage({
            title: path.basename(full),
            src: `/media/${encodePath(rel)}`,
            subtitles: subRel ? `/subs/${encodePath(subRel)}.vtt` : null,
          }),
        );
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(indexPage(await listMedia(root)));
      }
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, baseUrl }));
      }
      notFound(res);
    } catch (err) {
      console.error('[media] error', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  async function serveFile(req, res, root, rel) {
    const full = resolveInside(root, rel);
    const ext = full ? path.extname(full).toLowerCase() : '';
    // Only media and subtitle files are ever served: this port is open to the whole LAN.
    if (!full || !(MIME[ext] || SUBTITLE_MIME[ext])) return notFound(res);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile()) return notFound(res);

    events.emit('fetch', { path: rel, remote: req.socket.remoteAddress });

    const size = st.size;
    const headers = {
      'Content-Type': MIME[ext] ?? SUBTITLE_MIME[ext],
      'Accept-Ranges': 'bytes',
      'Last-Modified': st.mtime.toUTCString(),
      'Access-Control-Allow-Origin': '*',
      // DLNA headers: Samsung asks for these and some firmware refuses streams without them.
      'transferMode.dlna.org': MIME[ext] ? 'Streaming' : 'Interactive',
      'contentFeatures.dlna.org': DLNA_FEATURES,
    };
    // Samsung-specific subtitle hand-off: the TV sends getCaptionInfo.sec and
    // expects the subtitle URL back in CaptionInfo.sec.
    if (req.headers['getcaptioninfo.sec'] && MIME[ext]) {
      const sub = findSubtitle(full);
      if (sub) {
        const subRel = path.relative(root, sub).split(path.sep).join('/');
        headers['CaptionInfo.sec'] = `${baseUrl}/media/${encodePath(subRel)}`;
      }
    }

    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, headers);

    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(full, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy()); // renderer seeked away or disconnected
    stream.pipe(res);
  }

  return { server, events };
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}
