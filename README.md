# Heartopia Multiplayer Paint

Paint together on one shared board. [Try it →](https://sebsilent.github.io/HeartopiaMPPaint/)

Pick a nickname, get a room code, send it to people. Everyone paints at once and you can see each
other's cursors move. Phone, tablet, desktop, stylus, all fine. Nothing to install.

## It's the real palette

[Heartopia](https://heartopia.xd.com/) painting boards use 13 colour groups, 125 shades, and fixed
grid sizes. None of it is eyeballed here: it is lifted from
[Heartopia Painting Tools](https://zerochansy.github.io/Heartopia-Painting-Tools/), which mirrors the
game's own data, and `node tools/verify_palette.cjs` diffs our copy against theirs to prove it.

| Ratio | S | M | L | XL |
|---|---|---|---|---|
| 16:9 | 30×18 | 50×28 | 100×56 | 150×84 |
| 4:3 | 30×24 | 50×38 | 100×76 | 150×114 |
| 1:1 | 30×30 | 50×50 | 100×100 | 150×150 |
| 3:4 | 24×30 | 38×50 | 76×100 | 114×150 |
| 9:16 | 18×30 | 28×50 | 56×100 | 84×150 |

## How to use it

- One finger paints. Two fingers zoom, so you can rest your hand.
- With a stylus down, touches are ignored. Palm rejection, free.
- Wheel or `+` `−` to zoom, `0` to fit, `Space`-drag or two-finger drag to pan.
- `B` brush · `E` eraser · `I` eyedropper · `G` grid · `[` `]` brush size
- `Ctrl+S` saves a PNG at the board's pixel size, ready to copy into the game.
- `?local=1` opens a board that never touches the network.

## Running it

```bash
npm run dev     # http://localhost:8080
npm test        # 41 tests
```

The site is plain static files with no build step. `npm install` is only for the tests and the
optional relay.

## Rooms

By default the first player in a room hosts it over WebRTC and relays to the others. No backend, so
GitHub Pages alone is enough. If the host leaves, someone else takes over and the picture carries on.

There is an optional relay in `server/relay.js` if you want rooms that outlive every tab, or rooms
bigger than one laptop can carry. Deploy it (there's a `render.yaml`), then set it once:

```html
<script>window.HMP_CONFIG = { relayUrl: 'wss://your-relay.onrender.com' };</script>
```

## The honest bits

- No undo yet.
- Changing the board size wipes it for everyone.
- Close every tab in a peer room and the board is gone. Export a PNG.
- Some strict networks won't connect peer-to-peer until you add a TURN server.

## Also

Design is checked with [Impeccable](https://impeccable.style): `npx impeccable detect index.html`.
Not affiliated with [the game](https://heartopia.xd.com/). Licence: none chosen yet.
