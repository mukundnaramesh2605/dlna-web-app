// The agent's single outbound connection to the cloud relay. Nothing on the
// home network listens for the internet: the agent dials out and keeps this
// socket open, and the relay pushes UI commands down it.
import WebSocket from 'ws';

export function connectRelay({ url, token, onCommand, onConnect }) {
  let ws;
  let attempt = 0;

  function open() {
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    let watchdog;
    // The relay pings every 15s. If nothing arrives for 45s (e.g. after the Mac
    // wakes from sleep with a dead TCP connection), drop it and reconnect.
    const feedWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), 45_000);
    };

    ws.on('open', () => {
      attempt = 0;
      console.log(`[relay] connected to ${url}`);
      feedWatchdog();
      onConnect?.();
    });
    ws.on('ping', feedWatchdog);
    ws.on('message', async (raw) => {
      feedWatchdog();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type !== 'cmd') return;
      try {
        const data = await onCommand(msg.action, msg.params ?? {});
        send({ type: 'result', id: msg.id, ok: true, data });
      } catch (err) {
        console.warn(`[cmd] ${msg.action} failed: ${err.message}`);
        send({ type: 'result', id: msg.id, ok: false, error: { code: err.code ?? 'ERROR', message: err.message } });
      }
    });
    ws.on('error', (err) => {
      // Connection-refused arrives as an AggregateError with an empty message.
      const text = err.message || err.code || err.errors?.[0]?.message || 'connection failed';
      const hint = /401/.test(text) ? ' — PAIRING_TOKEN does not match the relay' : '';
      console.warn(`[relay] ${text}${hint}`);
    });
    ws.on('close', () => {
      clearTimeout(watchdog);
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      console.log(`[relay] disconnected; reconnecting in ${delay / 1000}s`);
      setTimeout(open, delay);
    });
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  open();
  return { send };
}
