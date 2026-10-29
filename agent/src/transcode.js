// STRETCH: on-the-fly ffmpeg transcoding for files the monitor can't play
// natively (typically MKV with HEVC/DTS audio). Output is an MPEG-TS stream of
// H.264 + AAC, which Samsung renderers accept. Streams aren't byte-seekable, so
// seeking re-requests /transcode/<file>?t=<seconds> and ffmpeg starts there.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
    const first = (type) => info.streams.find((s) => s.codec_type === type)?.codec_name ?? null;
    const result = { duration: Number(info.format?.duration) || 0, video: first('video'), audio: first('audio') };
    probes.set(file, result);
    return result;
  }

  async function stream(file, startSeconds, req, res) {
    let info;
    try {
      info = await probe(file);
    } catch (err) {
      res.writeHead(500);
      return res.end(`ffprobe failed: ${err.message}`);
    }
    const audioOnly = !info.video;
    const contentType = audioOnly ? 'audio/mpeg' : 'video/mp2t';
    res.writeHead(200, {
      'Content-Type': contentType,
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': TS_FEATURES,
    });
    if (req.method === 'HEAD') return res.end();

    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, startSeconds)), '-i', file];
    if (audioOnly) {
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', 'pipe:1');
    } else {
      // Copy streams that are already Samsung-friendly; only re-encode what isn't.
      const copyVideo = info.video === 'h264';
      const copyAudio = ['aac', 'mp3', 'ac3'].includes(info.audio);
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn');
      args.push(...(copyVideo ? ['-c:v', 'copy'] : videoEncoder));
      args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
      args.push('-f', 'mpegts', 'pipe:1');
    }
    console.log(`[transcode] ${file} from ${startSeconds}s (video ${info.video ?? '-'}, audio ${info.audio ?? '-'})`);
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill('SIGKILL')); // renderer disconnected or seeked
  }

  return { probe, stream };
}
