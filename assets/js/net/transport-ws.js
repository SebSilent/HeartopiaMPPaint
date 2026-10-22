/*
 * Optional relay transport: a tiny WebSocket server (server/relay.js) holds the
 * room, assigns slots and answers snapshot requests. Same message contract as
 * the WebRTC transport, so nothing else in the app changes.
 *
 * Use it when you want rooms that outlive every player's tab, or rooms bigger
 * than a laptop can relay. Set `relayUrl` in config.js or pass ?relay=wss://...
 */

import { clamp } from '../util.js';

export function createWSTransport({ url, roomCode, me, board, onMessage, onStatus }) {
  const withParams = (base) => {
    const u = new URL(base);
    u.searchParams.set('room', roomCode);
    u.searchParams.set('id', me.clientId);
    u.searchParams.set('nick', me.nick);
    u.searchParams.set('color', me.color);
    u.searchParams.set('device', me.device);
    // Only meaningful for the very first player: the relay ignores it once the
    // room exists, so later joiners always inherit the room's board.
    if (board) {
      u.searchParams.set('ratio', board.ratio);
      u.searchParams.set('level', String(board.level));
      if (board.item) u.searchParams.set('item', board.item);
    }
    return u.toString();
  };

  let ws = null;
  let closed = false;
  let attempt = 0;
  let openAt = 0;

  function connect() {
    if (closed) return;
    onStatus(attempt === 0 ? 'connecting' : 'reconnecting', 'ws');
    let sock;
    try {
      sock = new WebSocket(withParams(url));
    } catch (e) {
      onStatus('error', `bad relay url: ${e.message}`);
      return;
    }
    ws = sock;

    sock.onopen = () => {
      attempt = 0;
      openAt = Date.now();
      onStatus('online', 'relay');
    };
    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      onMessage(msg, msg.from || 'relay');
    };
    sock.onclose = (ev) => {
      ws = null;
      if (closed) return;
      // Back off, but reset the delay if we did manage to stay up a while -
      // that way a long-lived room that finally drops reconnects promptly.
      if (Date.now() - openAt > 15000) attempt = 0;
      attempt++;
      const wait = clamp(400 * 2 ** Math.min(attempt, 5), 400, 8000) + Math.random() * 300;
      onStatus('reconnecting', `closed(${ev.code || 'no-code'}) in ${Math.round(wait)}ms`);
      setTimeout(connect, wait);
    };
    sock.onerror = () => {
      onStatus('reconnecting', 'ws-error');
    };
  }

  connect();

  return {
    kind: 'ws',
    isAuthority: false, // the relay is the authority
    peerCount: () => (ws && ws.readyState === 1 ? 1 : 0),
    send(obj) {
      if (!ws || ws.readyState !== 1) return 0;
      ws.send(JSON.stringify(obj));
      return 1;
    },
    close() {
      closed = true;
      try {
        ws && ws.close();
      } catch (_) {}
      onStatus('offline', 'closed');
    },
  };
}
