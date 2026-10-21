/*
 * Serverless room transport: WebRTC star, first player in the room hosts it.
 *
 * No backend anywhere. The room code *is* the peer id, so the first client to
 * claim `hmpaint-v1-<CODE>` becomes the room's authority and relays traffic to
 * everyone else. Anyone who finds the id taken connects to it as a guest.
 *
 * If the host leaves, guests race to re-claim the id; the winner promotes
 * itself using the snapshot it already has, so the picture survives a host
 * swap instead of the room dying.
 */

import CONFIG from '../config.js';
import { randomId } from '../util.js';

let peerLibPromise = null;
function loadPeerLib() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (peerLibPromise) return peerLibPromise;
  peerLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CONFIG.peer.cdn;
    s.async = true;
    s.onload = () => resolve(window.Peer);
    s.onerror = () => reject(new Error(`could not load PeerJS from ${CONFIG.peer.cdn}`));
    document.head.appendChild(s);
  });
  return peerLibPromise;
}

export function roomIdFor(code) {
  return `${CONFIG.prefix}-${code}`;
}

export function createPeerTransport({ roomCode, me, onMessage, onStatus, onAuthority }) {
  const target = roomIdFor(roomCode);
  let peer = null;
  let conns = new Map(); // remoteClientId -> DataConnection
  let hostConn = null;
  let authority = false;
  let closed = false;
  let claimTimer = null;
  let lastHostSeen = 0;

  function status(s, detail) {
    onStatus(s, detail);
  }

  function deliver(msg, fromClientId) {
    if (!msg || typeof msg !== 'object') return;
    // The host relaying a guest's packet must not rewrite who sent it.
    const from = msg.__from || fromClientId || me.clientId;
    delete msg.__from;
    onMessage(msg, from);
  }

  function send(obj) {
    const payload = { ...obj, __from: me.clientId };
    if (authority) {
      let n = 0;
      for (const c of conns.values()) {
        if (c.open) {
          try {
            c.send(payload);
            n++;
          } catch (_) {}
        }
      }
      return n;
    }
    if (hostConn && hostConn.open) {
      try {
        hostConn.send(payload);
        return 1;
      } catch (_) {}
    }
    return 0;
  }

  /* ---------------- host duties ---------------- */

  function acceptGuest(conn) {
    const guestId = conn.peer;
    conn.on('open', () => {
      conns.set(guestId, conn);
      conn.on('data', (data) => {
        lastHostSeen = Date.now();
        // Fan out to every *other* guest, and to nobody else if we are the
        // originator ourselves.
        const msg = typeof data === 'string' ? safeParse(data) : data;
        if (!msg) return;
        const origin = msg.__from || guestId;
        msg.__from = origin;
        for (const [id, c] of conns) {
          if (id !== guestId && c.open) {
            try {
              c.send(msg);
            } catch (_) {}
          }
        }
        deliver(msg, origin);
      });
      conn.on('close', () => {
        conns.delete(guestId);
        onMessage({ k: 'peer-gone', id: guestId }, guestId);
      });
      conn.on('error', () => {
        conns.delete(guestId);
      });
      onMessage({ k: 'peer-hello', id: guestId }, guestId);
    });
    conn.on('error', () => conns.delete(guestId));
  }

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }

  /* ---------------- becoming host ---------------- */

  async function tryClaim(attempt = 0) {
    if (closed) return;
    const Peer = await loadPeerLib().catch((e) => {
      status('error', e.message);
    });
    if (!Peer) return;
    destroyPeer();

    const p = new Peer(target, {
      host: CONFIG.peer.host,
      port: CONFIG.peer.port,
      path: CONFIG.peer.path,
      key: CONFIG.peer.key,
      secure: CONFIG.peer.secure,
      debug: CONFIG.peer.debug,
      config: { iceServers: CONFIG.peer.iceServers },
    });
    peer = p;

    p.on('open', () => {
      authority = true;
      conns = new Map();
      status('online', 'host');
      onAuthority(true);
    });
    p.on('connection', acceptGuest);
    p.on('disconnected', () => {
      status('reconnecting', 'broker');
      try {
        p.reconnect();
      } catch (_) {}
    });
    p.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // Someone else already owns this room. Join them.
        authority = false;
        onAuthority(false);
        connectAsGuest();
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        status('reconnecting', err.type);
        scheduleRetry(attempt + 1);
      } else if (err.type === 'browser-incompatible' || err.type === 'ssl-unavailable') {
        status('error', err.type);
      } else {
        status('error', err.type || String(err));
      }
    });
  }

  function scheduleRetry(attempt) {
    if (closed) return;
    clearTimeout(claimTimer);
    const wait = Math.min(8000, 500 * 2 ** Math.min(attempt, 4)) + Math.random() * 400;
    claimTimer = setTimeout(() => tryClaim(0), wait);
  }

  /* ---------------- guest side ---------------- */

  function connectAsGuest(attempt = 0) {
    if (closed) return;
    status('connecting', 'guest');
    loadPeerLib()
      .then((Peer) => {
        destroyPeer();
        const p = new Peer(`${CONFIG.prefix}-g-${randomId(6)}`, {
          host: CONFIG.peer.host,
          port: CONFIG.peer.port,
          path: CONFIG.peer.path,
          key: CONFIG.peer.key,
          secure: CONFIG.peer.secure,
          debug: CONFIG.peer.debug,
          config: { iceServers: CONFIG.peer.iceServers },
        });
        peer = p;
        p.on('open', () => openGuestChannel(p, attempt));
        p.on('disconnected', () => {
          try {
            p.reconnect();
          } catch (_) {}
        });
        p.on('error', (err) => {
          if (err.type === 'peer-unavailable') {
            // The room really is empty now -> we should own it.
            tryClaim(0);
          } else {
            status('error', err.type);
            scheduleRetry(attempt + 1);
          }
        });
      })
      .catch((e) => status('error', e.message));
  }

  function openGuestChannel(p, attempt) {
    const conn = p.connect(target, { reliable: true, serialization: 'json', metadata: { nick: me.nick } });
    hostConn = conn;
    conn.on('open', () => {
      authority = false;
      onAuthority(false);
      lastHostSeen = Date.now();
      status('online', 'guest');
    });
    conn.on('data', (data) => {
      lastHostSeen = Date.now();
      const msg = typeof data === 'string' ? safeParse(data) : data;
      if (!msg) return;
      const origin = msg.__from || target;
      delete msg.__from;
      deliver(msg, origin);
    });
    conn.on('close', () => {
      hostConn = null;
      status('reconnecting', 'host-gone');
      // Back off differently per peer so exactly one of us wins the claim race.
      clearTimeout(claimTimer);
      claimTimer = setTimeout(() => tryClaim(0), 300 + Math.random() * 1200 + attempt * 500);
    });
    conn.on('error', () => {
      hostConn = null;
      status('reconnecting', 'host-error');
      clearTimeout(claimTimer);
      claimTimer = setTimeout(() => (authority ? null : connectAsGuest(attempt + 1)), 800);
    });
  }

  function destroyPeer() {
    const p = peer;
    peer = null;
    if (!p) return;
    try {
      for (const c of conns.values()) c.close();
    } catch (_) {}
    conns = new Map();
    hostConn = null;
    try {
      p.destroy();
    } catch (_) {}
  }

  // Health check: a silent host (crashed tab, dropped network) never fires
  // conn.on('close') quickly, so watch the traffic ourselves too.
  const watchdog = setInterval(() => {
    if (closed || authority) return;
    if (!hostConn || !hostConn.open) return;
    if (Date.now() - lastHostSeen > CONFIG.timings.hostTimeoutMs) {
      try {
        hostConn.close();
      } catch (_) {}
    }
  }, 2000);

  tryClaim(0);

  return {
    kind: 'peer',
    get isAuthority() {
      return authority;
    },
    peerCount: () => (authority ? conns.size : hostConn ? 1 : 0),
    send,
    close() {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(claimTimer);
      destroyPeer();
      status('offline', 'closed');
    },
  };
}
