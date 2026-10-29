// Which codecs a Samsung Tizen renderer decodes natively over DLNA, and which
// ones ffmpeg can pass through untouched when it has to transcode anyway.
// Auto mode uses this with the renderer's own MIME list to decide, per file,
// whether to stream the original or an ffmpeg-converted version.

export const DIRECT_VIDEO = new Set([
  'h264', 'hevc', 'mpeg4', 'mpeg2video', 'mpeg1video', 'vp8', 'vp9', 'av1', 'wmv3', 'vc1', 'h263',
]);
export const DIRECT_AUDIO = new Set([
  'aac', 'mp3', 'mp2', 'ac3', 'eac3', 'flac', 'vorbis', 'alac', 'wmav2', 'wmapro',
  'pcm_s16le', 'pcm_s24le', 'pcm_s16be', 'pcm_u8',
]);

// Streams that can be copied into the MPEG-TS output without re-encoding.
export const TS_COPY_VIDEO = new Set(['h264', 'hevc', 'mpeg2video']);
// MP3 is deliberately not copied: Samsung's player stops MPEG-TS streams that
// carry MP3 audio after a few seconds (seen with Xvid AVIs), so it's re-encoded to AAC.
export const TS_COPY_AUDIO = new Set(['aac', 'ac3', 'eac3']);

/**
 * Why a file needs transcoding, or null if it should play as-is.
 * info: ffprobe summary { video, audio }; containerOk: the renderer lists the file's MIME type.
 */
export function transcodeReason(info, containerOk) {
  if (!containerOk) return 'container not supported by the monitor';
  if (info.video && !DIRECT_VIDEO.has(info.video)) return `${info.video} video`;
  if (info.audio && !DIRECT_AUDIO.has(info.audio)) return `${info.audio} audio`;
  return null;
}
