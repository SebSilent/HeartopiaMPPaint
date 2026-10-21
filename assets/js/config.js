/*
 * Runtime configuration.
 *
 * Everything here can be overridden per-page with a query string, or globally
 * by setting `window.HMP_CONFIG = {...}` in a <script> before main.js loads
 * (see index.html). Nothing needs a build step.
 *
 *   ?relay=wss://my-relay.onrender.com   -> use your own WebSocket relay
 *   ?transport=peer                       -> force serverless WebRTC rooms
 *   ?room=ABCDE                           -> join a room directly
 */

import { randomId } from './util.js';

// Guarded so this module can also be imported by Node (tests, tooling).
const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const global = (typeof window !== 'undefined' && window.HMP_CONFIG) || {};

function setting(key, urlParam, fallback) {
  if (q.has(urlParam)) return q.get(urlParam);
  if (global[key] !== undefined) return global[key];
  return fallback;
}

/**
 * 'peer'  = serverless. First player in a room hosts it over WebRTC and
 *           relays to everyone else. Works with GitHub Pages alone.
 * 'ws'    = a small relay server (server/relay.js) holds the room. More
 *           reliable, needed for big rooms, but you have to host it.
 */
let transport = setting('transport', 'transport', 'peer');
const relayUrl = setting('relayUrl', 'relay', '');
// A relay URL is only useful if we actually use it, and asking for one is an
// explicit instruction to use it.
if (relayUrl && transport === 'peer') transport = 'ws';

export const CONFIG = {
  transport,
  relayUrl,

  peer: {
    // Public PeerJS broker. Free, no signup, but shared with everyone - if
    // rooms ever stop forming, point this at your own peer server.
    host: setting('peerHost', 'peerHost', '0.peerjs.com'),
    port: Number(setting('peerPort', 'peerPort', 443)),
    path: setting('peerPath', 'peerPath', '/'),
    key: setting('peerKey', 'peerKey', 'peerjs'),
    secure: true,
    // STUN only: enough for the vast majority of home/mobile NATs. Add a TURN
    // server here if your users are behind symmetric NAT.
    iceServers: global.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    debug: Number(setting('peerDebug', 'peerDebug', 1)),
    cdn: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  },

  /** Namespace so our ids/keys cannot collide with anything else on the broker. */
  prefix: 'hmpaint-v1',

  timings: {
    cursorHz: 20, // outbound pointer updates per second
    timeSyncMs: 2000, // clock ping interval (multiplayerpiano-style)
    repairMs: 8000, // state checksum compare interval
    renderDelayMs: 70, // remote events are drawn this far in the past, so
    // jitter arrives in order instead of stuttering
    hostTimeoutMs: 12000, // no traffic from host for this long -> re-elect
    joinTimeoutMs: 15000,
  },

  limits: {
    nickMin: 2,
    nickMax: 16,
    maxCells: 256 * 256, // guards against a malformed snapshot allocating 400 MB
    maxRoster: 64,
  },

  /** Stable per-tab id: survives reloads, unique across tabs on one device. */
  clientId: randomId(8),
};

export default CONFIG;
