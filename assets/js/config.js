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
 * A number setting that stays a number. `Number('abc')` is NaN, and `x > NaN`
 * is false for every x, so a mistyped param does not merely misconfigure a
 * guard - it switches the guard off. Anything unusable falls back.
 */
/**
 * A boolean setting. `Boolean('0')` is true, and so is every other non-empty
 * string, so a naive parse would make `?gapFill=0` turn the feature ON. Words
 * that mean off win, words that mean on win, and anything else falls back.
 */
function flag(key, urlParam, fallback) {
  const v = setting(key, urlParam, undefined);
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  return fallback;
}

function num(key, urlParam, fallback, min = 0) {
  const n = Number(setting(key, urlParam, fallback));
  return Number.isFinite(n) && n >= min ? n : fallback;
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

/**
 * How far behind room time remote activity is drawn. One number for cursors and
 * strokes, so the ink always arrives where the cursor already is.
 */
const remoteDelay = Number(setting('renderDelay', 'renderDelay', 90));

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
    // 0 by default. Becoming a guest is normal, but PeerJS logs the host id it
    // tried to claim as a console error on the way, which reads to a visitor
    // like a crash. ?peerDebug=1 brings the noise back when you are debugging.
    debug: Number(setting('peerDebug', 'peerDebug', 0)),
    cdn: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  },

  /** Namespace so our ids/keys cannot collide with anything else on the broker. */
  prefix: 'hmpaint-v1',

  timings: {
    cursorHz: 20, // outbound pointer updates per second
    timeSyncMs: 2000, // clock ping interval (multiplayerpiano-style)
    repairMs: 8000, // state checksum compare interval
    // One delay for everything remote: cursors and ink replay on the same
    // timeline, so paint appears where the cursor already is, not behind it.
    renderDelayMs: remoteDelay,
    hostTimeoutMs: 12000, // no traffic from host for this long -> re-elect
    joinTimeoutMs: 15000,
  },

  /**
   * Remote strokes only: how long a burst waits, and how long it then takes to
   * paint in. Raise delayMs for a laggy link, lower it if the lag bothers you.
   * Your own drawing is never delayed by any of this.
   */
  smooth: {
    delayMs: remoteDelay,
    spreadMs: Number(setting('smoothSpread', 'smoothSpread', 55)),
    backlogCells: Number(setting('smoothBacklog', 'smoothBacklog', 900)),
  },

  d3: {
    // The pass that paints the backdrop trapped inside a garment's silhouette
    // (game/coverage.js). On by default; `?gapFill=0` turns it off, which exists
    // so the claim "it only ever fills backdrop" can be measured against the same
    // frame rather than argued, and so a weak device can skip the per-frame work.
    gapFill: flag('gapFill', 'gapFill', true),
  },

  limits: {
    nickMin: 2,
    nickMax: 16,
    maxCells: 256 * 256, // guards against a malformed snapshot allocating 400 MB
    maxRoster: 64,
    // An import is read pixel by pixel, so a phone photo dropped on the wrong
    // tab is a frozen tab, not a bug to chase. The cap that matters is pixels,
    // since that is what the rasteriser touches; bytes only catch a file that
    // would take forever to decode at all. Both are tunable for testing -
    // `?importMaxMP=1` lets a probe prove the refusal without shipping a 40 MP
    // image.
    importMaxBytes: num('importMaxMB', 'importMaxMB', 40, 1) * 1024 * 1024,
    importMaxPixels: num('importMaxMP', 'importMaxMP', 40, 0.1) * 1e6,
  },

  /** Stable per-tab id: survives reloads, unique across tabs on one device. */
  clientId: randomId(8),
};

export default CONFIG;
