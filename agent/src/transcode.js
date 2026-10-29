// On-the-fly ffmpeg transcoding for files the monitor can't play natively
// (DTS/Opus audio, DivX 3/RealVideo/ProRes video, RMVB/MXF containers, ...).
// Output is MPEG-TS with H.264/HEVC + AAC, which Samsung renderers accept. Streams aren't byte-seekable, so
// seeking re-requests /transcode/<file>?t=<seconds> and ffmpeg starts there.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TS_COPY_VIDEO, TS_COPY_AUDIO } from './compat.js';

const run = promisify(execFile);
const TS_FEATURES = 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';

/** Returns a transcoder, or null when ffmpeg/ffprobe aren't installed. */
export async function createTranscoder() {
  let encoders;
  try {
    await run('ffprobe', ['-version']);
    encoders = (await run('ffmpeg', ['-hide_banner', '-encoders'], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
  // Apple Silicon/Intel hardware encoder is far faster than libx264 on a laptop.
  const videoEncoder = encoders.includes('h264_videotoolbox')
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-vf', 'format=yuv420p']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'];
  const probes = new Map();

  async function probe(file) {
    if (probes.has(file)) return probes.get(file);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    const info = JSON.parse(stdout);
    // Album art in audio files shows up as a one-frame "video" stream: ignore it.
    const first = (type) => info.streams.find((s) => s.codec_type === type && !s.disposition?.attached_pic)?.codec_name ?? null;
    const result = { duration: Number(info.format?.duration) || 0, video: first('video'), audio: first('audio') };
    probes.set(file, result);
    return result;
  }

  /** format: 'ts' (for DLNA renderers, default) or 'mp4' (fragmented MP4 for web browsers). */
  async function stream(file, startSeconds, req, res, format = 'ts') {
    let info;
    try {
      info = await probe(file);
    } catch (err) {
      res.writeHead(500);
      return res.end(`ffprobe failed: ${err.message}`);
    }
    const audioOnly = !info.video;
    const forBrowser = format === 'mp4';
    const contentType = audioOnly ? 'audio/mpeg' : forBrowser ? 'video/mp4' : 'video/mp2t';
    // The length is unknown, and Node would normally use chunked encoding.
    // Samsung's player chokes on chunked streams partway through, so send a
    // plain byte stream that ends when the connection closes (HTTP/1.0 style).
    res.useChunkedEncodingByDefault = false;
    res.shouldKeepAlive = false;
    res.writeHead(200, {
      'Content-Type': contentType,
      Connection: 'close',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': TS_FEATURES,
    });
    if (req.method === 'HEAD') return res.end();

    // +genpts rebuilds missing timestamps (common in old AVI/VOB files).
    const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-ss', String(Math.max(0, startSeconds)), '-i', file];
    if (audioOnly) {
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', 'pipe:1');
    } else {
      // Copy streams that are already Samsung-friendly; only re-encode what isn't.
      // E.g. HEVC + DTS in MKV keeps the HEVC and only converts DTS to AAC.
      // Browsers reliably decode only H.264 + AAC, so the mp4 flavour is stricter.
      const copyVideo = forBrowser ? info.video === 'h264' : TS_COPY_VIDEO.has(info.video);
      const copyAudio = forBrowser ? info.audio === 'aac' : TS_COPY_AUDIO.has(info.audio);
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn');
      args.push(...(copyVideo ? ['-c:v', 'copy'] : videoEncoder));
      args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
      if (forBrowser) args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
      else args.push('-f', 'mpegts', 'pipe:1');
    }
    console.log(`[transcode] ${file} from ${startSeconds}s (video ${info.video ?? '-'}, audio ${info.audio ?? '-'})`);
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill('SIGKILL')); // renderer disconnected or seeked
  }

  return { probe, stream };
}
