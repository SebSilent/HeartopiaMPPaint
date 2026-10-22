# Heartopia Multiplayer Paint

Paint together on one shared board.

**→ https://sebsilent.github.io/HeartopiaMPPaint/**

Pick a nickname, get a room code, send it to people. Everyone paints at once, live.

## What it does

- **The real Heartopia palette** — 13 groups, 125 shades: black, grey, white, brown, red, orange,
  yellow, green, cyan, blue, purple, pink, special
- **Everything you can design in the game.** Canvases, 11 garments, 10 pieces of furniture, and the
  book — each with its own faces, tabbed. A T-shirt is four boards, not one, and it looks like that.
- **Everyone's cursor on the board**, drawn as a touch, a pen or a mouse, moving in real time
- **Paint on a face someone else is standing on** — the tab shows who
- **Pinch to zoom, two fingers to pan** — rest your hand on the screen
- **Apple Pencil aware** — touches stop painting while the pen is down
- Brush, eraser, eyedropper, bucket, line, rectangle, ellipse, triangle, star, heart, arrow, spray,
  polygon, select, mirror · four brush sizes · square or round tip
- **Undo and redo, one step per stroke** — and it travels, so the room loses the same stroke
- **Blueprint mode** — blocks, numbered shades, and a legend that says what is left to key in
- **Photo import** — quantised to the palette, colours merged down until it is buildable
- **Screenshot import** — finds the grid in a game screenshot and lifts the colours out of it
- **3D preview** — every face where the game puts it, at its real proportions
- **PNG export at the board's exact pixel size**, ready to copy into the game
- **Phone, tablet, desktop. Nothing to install.**

## The slots

| Ratio | S | M | L | XL |
|---|---|---|---|---|
| 16:9 | 30×18 | 50×28 | 100×56 | 150×84 |
| 4:3 | 30×24 | 50×38 | 100×76 | 150×114 |
| 1:1 | 30×30 | 50×50 | 100×100 | 150×150 |
| 3:4 | 24×30 | 38×50 | 76×100 | 114×150 |
| 9:16 | 18×30 | 28×50 | 56×100 | 84×150 |

A dress is 102×154 + 76×154 + 168×102. A cap is three faces. The duvet on a double bed is 256×128.
All 51 of them are in the app.

## Keys

`B` brush · `E` eraser · `I` eyedropper · `F` bucket · `L` line · `R` rect · `O` ellipse · `V` select
`[` `]` brush size · `M` mirror · `G` grid · `.` tick a block · `0` fit · `+` `−` zoom
`Space`-drag pan · `Ctrl+Z` undo · `Ctrl+Y` redo · `Ctrl+S` export

`?local=1` opens a board that never touches the network.

## Running it

GitHub Pages serves plain files, so the site itself needs no build: push, done.

```bash
npm run dev          # http://localhost:8080
npm test             # 131 checks
```

Rooms are serverless by default — the first player in a code hosts it over WebRTC. For bigger rooms
or a link that works no matter who is holding it, run the small relay and point the site at it:

```bash
npm run relay
# then, in index.html:  relayUrl: 'wss://your-host/'
```
