# Heartopia Multiplayer Paint

A shared painting board for [Heartopia](https://www.heartopia.com) players. Open a link, pick a
nickname, and you are painting on the same board as everyone else in the room, at the same time, on
a phone, a tablet or a desktop.

**Live site:** <https://sebsilent.github.io/HeartopiaMPPaint/>

No install, no account, no build step. The published site is plain static files.

---

## What it does

- **Nickname before painting.** The gate will not let you touch the board until you have a name, so
  every cursor on the canvas belongs to somebody.
- **Everyone paints at once.** Strokes appear on every screen as they happen.
- **Live cursors that show the real tool.** A mouse is an arrow, a stylus is a nib, a finger is a
  disc. It is read from `PointerEvent.pointerType` per pointer, not guessed from the user agent.
- **Every finger counts as its own cursor.** Two-finger drawing on an iPad works, and remote players
  see both touches.
- **The Heartopia palette, all of it.** 13 colour groups, 125 shades, sampled from the game's own
  palette data rather than eyeballed.
- **Heartopia board sizes.** The five ratios and four precision levels the game uses, so a board you
  paint here maps onto a board you can reproduce in game.
- **Zoom and pan.** Wheel, pinch (with the hand tool), space-drag, middle-drag, or the buttons.
- **PNG export** at the board's native pixel size.
- **Works offline for practice.** Open it with `?local=1` for a board that never talks to the network.

---

## How the sync works

The model is borrowed from how Multiplayer Piano keeps a room feeling live.

**1. The canvas is a set of idempotent cell writes.** Every cell stores a palette index plus a
`(lamport stamp, author slot)` pair. A write wins only if its stamp is newer, ties broken by author
slot. That means packet order between two players does not matter: if you both paint the same pixel
at the same moment, every screen in the room converges on the same answer without a central lock.

**2. One clock, not many.** The room's authority stamps its own `Date.now()` into a reply to a
periodic request from each client. The client measures the round trip and trusts the sample with the
lowest latency. That is the same trick Multiplayer Piano uses with its `{m:"t"}` messages.

**3. Remote events replay slightly in the past.** Each pointer position arrives stamped on the room
clock and is kept in a short history. Every screen draws the room at `now - 70ms`, interpolating
between samples. Packets that arrive late or in bursts still land in the right order, so cursors
glide instead of stuttering. Your own cursor is drawn immediately with no delay; only remote ones
are buffered.

**4. New joiners get one snapshot.** The authority serialises the board (base64 over the cell array,
about 30 KB at the largest size) and the newcomer paints from it.

**5. Drift is detected and repaired, not trusted.** The authority publishes a version counter and an
FNV-1a checksum of the picture every 8 seconds. Any client whose checksum disagrees asks for a fresh
snapshot. A dropped packet heals itself within one cycle. There is a test that corrupts a client's
grid on purpose and confirms it recovers.

**6. Reconnect, not reload.** Both transports back off exponentially and re-announce themselves; the
relay keeps a room's picture for 10 minutes after the last player leaves.

---

## Two ways to run a room

| | Serverless (default) | Relay |
|---|---|---|
| Needs a backend | No | Yes, `server/relay.js` |
| Works on GitHub Pages alone | Yes | No, host the relay separately |
| Topology | First player hosts over WebRTC and relays | WebSocket fan-out from the server |
| Room survives the host closing the tab | Yes, guests race to re-claim the room id | Yes |
| Room survives everyone leaving | No | Yes, for 10 minutes |

Both speak one message contract, so the game code does not care which is in use. The relay reuses the
browser's `Grid` class directly rather than reimplementing it, so the two cannot drift apart.

The serverless path uses the public PeerJS broker. It is free and needs no signup, but it is shared
with everyone else using it. If rooms ever stop forming, either point `CONFIG.peer.host` at your own
peer server or deploy the relay.

### Using your own relay

1. Deploy `server/relay.js`. It reads `PORT` from the environment, so Render, Railway and Fly all
   work. There is a `render.yaml` in this repo for Render.
2. Set the URL once, either in `index.html`:
   ```html
   <script>window.HMP_CONFIG = { relayUrl: 'wss://your-relay.onrender.com' };</script>
   ```
   or per visit with `?relay=wss://your-relay.onrender.com`. Passing a relay URL switches the
   transport to it automatically.
3. `GET /health` on the relay reports room and client counts.

---

## Where the Heartopia data comes from

The palette and the board sizes were extracted from
[Heartopia Painting Tools](https://zerochansy.github.io/Heartopia-Painting-Tools/) by zerochansy,
which catalogues the game's own values.

- `tools/extract_palette.cjs` parses `assets/color/color.svg` from that site into
  `assets/data/heartopia-palette.json` (13 groups, 125 shades).
- `tools/build_palette_module.cjs` turns that JSON into `assets/js/data/heartopia-palette.js`, so the
  site loads its palette as a module with no fetch.
- Board dimensions come from that site's `gridDimensions` table and are reproduced verbatim in
  `assets/js/presets.js`:

| Ratio | S | M | L | XL |
|---|---|---|---|---|
| 16:9 | 30×18 | 50×28 | 100×56 | 150×84 |
| 4:3 | 30×24 | 50×38 | 100×76 | 150×114 |
| 1:1 | 30×30 | 50×50 | 100×100 | 150×150 |
| 3:4 | 24×30 | 38×50 | 76×100 | 114×150 |
| 9:16 | 18×30 | 28×50 | 56×100 | 84×150 |

Brush sizes are 1, 2, 3 and 5 cells. One cell is one in-game paint tap, which is why the boards are
measured in cells and not pixels.

The chrome is deliberately not a beige wash. It uses the darkest teals of the game's own palette as a
studio surround so paint colours are judged against a dark neutral frame, and the board itself keeps
the warm canvas paper it has in game.

---

## Running it locally

```bash
npm install        # only for the relay and the tests; the site itself has no dependencies
npm run dev        # http://localhost:8080
npm test           # 32 tests
npm run relay      # optional WebSocket relay on :8787
```

`npm test` covers three layers:

- `test/grid.test.js`, `test/palette.test.js`: the canvas model and the palette data, including
  convergence under out-of-order writes, snapshot round-trips, stroke rasterisation and a contrast
  check on every one of the 125 shades.
- `test/relay.test.js`: the real browser `Room` class driven against the real relay server over real
  WebSockets. Fan-out, late join, concurrent edits, cursor routing, clock sync, automatic repair
  after deliberate corruption, and board inheritance.
- `test/peer-protocol.test.js`: the serverless path through a fake star transport, covering host
  slot assignment, guest-to-guest relay, roster, clock adoption and what happens when the host tab
  closes mid-painting.

The WebRTC transport itself cannot run in Node, so `transport-peer.js` is covered at the protocol
level and not end to end. Real WebRTC behaviour needs a browser and a reachable broker.

Design quality is checked with [Impeccable](https://impeccable.style):

```bash
npx impeccable detect index.html "http://localhost:8080/?local=1"
```

Both runs are currently clean.

---

## Deploying to GitHub Pages

The site is static, so Pages serves it from the repository root:

**Settings → Pages → Source: Deploy a branch → `main` / `/ (root)`**

Or from the CLI:

```bash
gh api -X POST repos/OWNER/HeartopiaMPPaint/pages -f "source[branch]=main" -f "source[path]=/"
```

Room codes live in the URL (`?room=ABCDE`), so an invite link is just a link.

---

## Known limits

Worth knowing before you rely on it:

- **The host is a player too.** In serverless rooms everyone's traffic routes through one person's
  tab. If that machine is slow or their network is bad, the whole room feels it. The relay exists for
  exactly this case.
- **No undo.** Strokes are final. A mis-drag is fixed by painting back over it or clearing the board.
- **Board changes are destructive and global.** Resizing wipes the picture for everyone, after a
  confirmation.
- **State lives in the room, not in an account.** Close every tab in a serverless room and the board
  is gone. Export a PNG if you want to keep it.
- **Public STUN only.** Most home and mobile networks connect fine. Some symmetric-NAT networks
  (certain corporate and carrier setups) will not establish peer connections until you add a TURN
  server in `CONFIG.peer.iceServers`.
- **Rooms cap at 24 players on the relay**, and the largest board (150×150) makes the biggest
  snapshots.
- **Colour accuracy across devices is not guaranteed.** Screens differ; the hex readout in the dock is
  there so you can check what you are actually picking.

---

## Licence

Unlicensed, all rights reserved, for now. Pick a licence before reusing or redistributing this.
