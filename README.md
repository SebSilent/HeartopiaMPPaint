# Heartopia Multiplayer Paint

Paint together on one shared board.

**→ https://sebsilent.github.io/HeartopiaMPPaint/**

Pick a nickname, get a room code, send it to people. Everyone paints at once, live.

## What it does

- **The real Heartopia palette**, 13 groups and 125 shades: black, grey, white, brown, red, orange,
  yellow, green, cyan, blue, purple, pink, special
- **Every board size the game allows**
- **Everyone's cursor on the board**, drawn as a touch, a pen or a mouse, moving in real time
- **A chip on every avatar showing the shade that player is holding**, with the group code and hex on
  hover, so a room painting in four blues can tell who is who
- **Your board is kept on your device**, and if the room comes back empty it asks before it touches
  anything - decline and your picture is still there next time
- **Pinch to zoom, two fingers to pan**, so you can rest your hand on the screen
- **Apple Pencil aware**: touches stop painting while the pen is down
- **Eyedropper, eraser, four brush sizes**, and four brush shapes: square, round, the hard spray, and a
  soft **airbrush** that fades through real palette shades, because a Heartopia board has no alpha
- **Fill, fill-similar, line, rectangle, ellipse, polygon, mirror painting** - each one a single undo
  step, each one broadcast as one op
- **PNG export at the board's exact pixel size**, ready to copy into the game
- **The game's own items**, clothing, furniture and the book, on their real faces at their real sizes
- **Game silhouettes enforced**, the cells Heartopia refuses to paint stay unpaintable for everyone in the room,
  and the outline you see is traced from exactly those cells, so the line and the brush cannot disagree
- **The garment's own 3D shape**, the fabric mesh the game wears, orbit by drag, zoom by wheel, repainted on every stroke
- **Phone, tablet, desktop. Nothing to install.**

| Ratio | S | M | L | XL |
|---|---|---|---|---|
| 16:9 | 30×18 | 50×28 | 100×56 | 150×84 |
| 4:3 | 30×24 | 50×38 | 100×76 | 150×114 |
| 1:1 | 30×30 | 50×50 | 100×100 | 150×150 |
| 3:4 | 24×30 | 38×50 | 76×100 | 114×150 |
| 9:16 | 18×30 | 28×50 | 56×100 | 84×150 |

## Keys

`B` brush · `E` eraser · `I` eyedropper · `F` bucket · `L` line · `R` rectangle · `O` ellipse · `P` polygon
`G` grid · `[` `]` brush size · `+` `−` zoom · `0` fit · `Space`-drag pan · `Ctrl+S` export

`?local=1` opens a board that never touches the network.
