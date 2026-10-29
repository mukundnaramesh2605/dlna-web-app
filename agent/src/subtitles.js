// SubRip -> WebVTT, for the HTML5 <track> in the browser fallback player.
// (DLNA renderers get the original .srt via CaptionInfo.sec instead.)
export function srtToVtt(srt) {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}
