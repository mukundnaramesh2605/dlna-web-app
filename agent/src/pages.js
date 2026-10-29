// Tiny HTML pages served on the LAN for Mode B: open these in the monitor's
// built-in browser when DLNA casting isn't an option.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const style = `
  html,body{margin:0;height:100%;background:#000;color:#eee;font:20px/1.4 system-ui,sans-serif}
  a{color:#8cf}
  .wrap{max-width:1100px;margin:0 auto;padding:24px}
  video{width:100vw;height:100vh;background:#000;display:block}
  .bar{position:fixed;top:0;left:0;right:0;padding:12px 20px;background:linear-gradient(#000c,#0000);transition:opacity .5s}
  li{margin:8px 0}
`;

export function playerPage({ title, src, subtitles }) {
  const track = subtitles ? `<track kind="subtitles" src="${esc(subtitles)}" srclang="en" label="Subtitles" default>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${style}</style></head><body>
<div class="bar" id="bar"><a href="/">&larr; All files</a> &nbsp; ${esc(title)}</div>
<video id="v" src="${esc(src)}" controls autoplay playsinline>${track}</video>
<script>
  var v = document.getElementById('v'), bar = document.getElementById('bar'), t;
  function show(){ bar.style.opacity = 1; clearTimeout(t); t = setTimeout(function(){ bar.style.opacity = 0; }, 3000); }
  document.addEventListener('mousemove', show); document.addEventListener('keydown', show); show();
  v.addEventListener('error', function(){
    bar.style.opacity = 1;
    bar.innerHTML += '<div style="color:#f88">This browser cannot play this file (codec/container unsupported). Try casting with Transcode enabled.</div>';
  });
</script></body></html>`;
}

export function indexPage(files) {
  const items = files
    .map((f) => `<li><a href="/player?f=${encodeURIComponent(f.path)}">${esc(f.path)}</a></li>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Media on this Mac</title><style>${style}</style></head><body><div class="wrap">
<h1>Media on this Mac</h1><ul>${items || '<li>No media files found.</li>'}</ul></div></body></html>`;
}
