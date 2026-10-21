/* Small shared helpers. No dependencies. */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const nowMs = () => Date.now();

/** Room codes avoid I/O/0/1 so they survive being read out loud or typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBytes(n) {
  const b = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

export function makeRoomCode(len = 5) {
  const buf = randomBytes(len);
  let s = '';
  for (const b of buf) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

export function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

export function randomId(bytes = 8) {
  return Array.from(randomBytes(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- binary <-> base64 (chunked: 20k+ cells would blow String.fromCharCode's arg limit) ---------- */

export function bytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
  }
  return btoa(s);
}

export function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Pack a list of cell indices (all < 65536, i.e. grids up to 256x256) into base64. */
export function indicesToB64(indices) {
  const u16 = new Uint16Array(indices.length);
  for (let i = 0; i < indices.length; i++) u16[i] = indices[i];
  return bytesToB64(new Uint8Array(u16.buffer));
}

export function b64ToIndices(str) {
  const u8 = b64ToBytes(str);
  const u16 = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  return u16;
}

/* ---------- colour helpers ---------- */

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbaStr(hex, a = 1) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** WCAG relative luminance of a colour (0..1). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colours, 1..21. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Pick the ink (dark or light) that actually contrasts with a swatch.
 * The usual "luminance > 0.5 ? black : white" shortcut fails on mid-tone
 * oranges and greens, which is exactly where Heartopia's palette is densest,
 * so compare both candidates properly.
 */
export function readableInk(hex) {
  const DARK = '#2a2118';
  const LIGHT = '#fffdf7';
  return contrastRatio(hex, DARK) >= contrastRatio(hex, LIGHT) ? DARK : LIGHT;
}

/* ---------- misc ---------- */

/** FNV-1a over a byte buffer, as 8 hex chars. Cheap enough to run every few seconds. */
export function fnv1a(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function throttle(fn, ms) {
  let last = 0,
    timer = null,
    pending = null;
  return function (...args) {
    const t = Date.now();
    const wait = ms - (t - last);
    if (wait <= 0) {
      last = t;
      fn.apply(null, args);
    } else {
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(null, pending);
        }, wait);
      }
    }
  };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export function initials(nick) {
  const parts = String(nick || '?').trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

export function detectDevice() {
  const ua = navigator.userAgent || '';
  const coarse = matchMedia?.('(pointer: coarse)')?.matches;
  const iPadLike = /iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && coarse);
  if (/Android/.test(ua)) return 'android';
  if (iPadLike) return 'ipad';
  if (/iPhone/.test(ua)) return 'iphone';
  if (coarse) return 'touch';
  return 'desktop';
}

export const isTouchFirst = () => detectDevice() !== 'desktop';
