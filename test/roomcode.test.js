/*
 * Room codes: they must be random, and they must not collide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoomCode, normalizeRoomCode } from '../assets/js/util.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

test('a generated code is 7 characters from the unambiguous alphabet', () => {
  const c = makeRoomCode();
  assert.equal(c.length, 7);
  assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
});

test('no I, no O, no 0 - the ones people misread when typing', () => {
  for (let i = 0; i < 500; i++) {
    const c = makeRoomCode();
    assert.equal(/[IO0]/.test(c), false, c);
  }
});

test('codes are not hardcoded and do not repeat themselves', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(makeRoomCode());
  assert.ok(seen.size > 4900, `5000 draws gave ${seen.size} distinct codes`);
  assert.equal(seen.has('REELZ'), false, 'the old default is not special');
});

test('the generator is not leaning on Math.random', () => {
  // If crypto were missing, makeRoomCode would still work - but with crypto
  // present, Math.random must never be consulted.
  const real = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    return real();
  };
  try {
    assert.ok(globalThis.crypto?.getRandomValues, 'test assumes a real CSPRNG');
    for (let i = 0; i < 200; i++) makeRoomCode();
    assert.equal(calls, 0, 'room codes must come from the CSPRNG');
  } finally {
    Math.random = real;
  }
});

test('codes are uniform across the alphabet, not modulo-biased into a corner', () => {
  const counts = new Map([...ALPHABET].map((ch) => [ch, 0]));
  const slots = 7 * 20000;
  for (let i = 0; i < 20000; i++) for (const ch of makeRoomCode()) counts.set(ch, counts.get(ch) + 1);
  const expected = slots / ALPHABET.length;
  for (const [ch, n] of counts) {
    // 25% off on 4,500 draws would mean a broken generator, not noise.
    assert.ok(Math.abs(n - expected) / expected < 0.25, `${ch} appeared ${n} times vs ${expected.toFixed(0)}`);
  }
});

test('a pasted code is normalised, and a long one is truncated not rejected', () => {
  assert.equal(normalizeRoomCode(' abc-def '), 'ABCDEF');
  assert.equal(normalizeRoomCode('reelz'), 'REELZ');
  // We never generate I/O/0, but a human typing them should still reach the
  // room they meant, so normalising keeps every alphanumeric character.
  assert.equal(normalizeRoomCode('1O0I'), '1O0I');
  assert.equal(normalizeRoomCode(''), '');
  assert.equal(normalizeRoomCode(null), '');
  assert.equal(normalizeRoomCode('ABCDEFGH').length, 8);
});

test('the whole space is big enough for a 10k-person server', () => {
  const space = ALPHABET.length ** 7;
  const rooms = 10000;
  // Birthday estimate: P(any pair collides) ~= 1 - e^(-n^2 / 2N)
  const p = 1 - Math.exp(-(rooms * rooms) / (2 * space));
  assert.ok(space > 2e10, `space is ${space}`);
  assert.ok(p < 0.01, `collision chance across 10k rooms is ${(p * 100).toFixed(2)}%`);
  // And the odds the old 5-character code gave, for the record.
  const old = 1 - Math.exp(-(rooms * rooms) / (2 * ALPHABET.length ** 5));
  assert.ok(old > 0.7, 'five characters really was a coin flip');
});
