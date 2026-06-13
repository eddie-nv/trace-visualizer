# Graph research 1B — Mermaid sequence diagram renderer

- **Repo:** mermaid-js/mermaid (shallow clone at `workspace/mermaid`)
- **Commit:** `9f9566a` (`9f9566ab45dfc5c5c8dbdb05da66f52ea7da8102`, "Merge pull request #7845 …", 2026-06-12)
- **Clone date:** 2026-06-12
- **Files studied:** `packages/mermaid/src/diagrams/sequence/sequenceRenderer.ts` (2150 lines), `sequenceDb.ts` (729), `svgDraw.js` (2037), `types.ts` (95), plus sequence defaults in `packages/mermaid/src/schemas/config.schema.yaml`.

All paths below are relative to the repo root. All line numbers are for this commit.

Key config defaults used throughout (from `packages/mermaid/src/schemas/config.schema.yaml:2096-2215`): `activationWidth: 10`, `diagramMarginX: 50`, `diagramMarginY: 10`, `actorMargin: 50`, `width: 150` (actor box width), `height: 65` (actor box height), `boxMargin: 10`, `boxTextMargin: 5`, `noteMargin: 10`, `messageMargin: 35`, `mirrorActors: true`, `wrapPadding: 10`, `labelBoxWidth: 50`, `labelBoxHeight: 20`.

---

## 1. Core layout algorithm

### 1.1 Architecture: one mutable `bounds` singleton

The whole renderer is organized around a module-level mutable `bounds` object that holds (a) the overall diagram extent, (b) the running y cursor, (c) the stack of *open* fragments (`sequenceItems`), and (d) the stack of *open* activations:

`packages/mermaid/src/diagrams/sequence/sequenceRenderer.ts:17-27`
```ts
export const bounds = {
  data: {
    startx: undefined,   // overall diagram extent, min/max-accumulated
    stopx: undefined,
    starty: undefined,
    stopy: undefined,
  },
  verticalPos: 0,        // <-- the running y "cursor"
  sequenceItems: [],     // <-- stack of OPEN fragments (loop/alt/opt/par/...)
  activations: [],       // <-- stack of OPEN activation bars
```

The cursor only ever moves down; `bumpVerticalPos` is the single advance primitive:

`sequenceRenderer.ts:212-218`
```ts
bumpVerticalPos: function (bump) {
  this.verticalPos = this.verticalPos + bump;
  this.data.stopy = common.getMax(this.data.stopy, this.verticalPos);
},
getVerticalPos: function () {
  return this.verticalPos;
},
```

(The only "rewind" is `saveVerticalPos`/`resetVerticalPos` at `sequenceRenderer.ts:202-211`, used exclusively for `par_over` fragments whose sections overlap vertically — `bounds.resetVerticalPos()` is called on NOTE at line 1150 and `saveVerticalPos()` on PAR_OVER_START at line 1251.)

Every drawn shape is folded into the diagram extent via `insert`, which min/max-accumulates `bounds.data` and notifies all open fragments/activations:

`sequenceRenderer.ts:135-147`
```ts
insert: function (startx, starty, stopx, stopy) {
  const _startx = common.getMin(startx, stopx);
  const _stopx = common.getMax(startx, stopx);
  const _starty = common.getMin(starty, stopy);
  const _stopy = common.getMax(starty, stopy);

  this.updateVal(bounds.data, 'startx', _startx, Math.min);
  this.updateVal(bounds.data, 'starty', _starty, Math.min);
  this.updateVal(bounds.data, 'stopx', _stopx, Math.max);
  this.updateVal(bounds.data, 'stopy', _stopy, Math.max);

  this.updateBounds(_startx, _starty, _stopx, _stopy);
},
```

### 1.2 Actor (column) x positions: computed from label widths, in two pre-passes, BEFORE any message is drawn

Actor x is *not* fixed per actor; it is a running sum of `width + margin`, where each actor's `margin` is widened by the **widest message label that spans the gap to its neighbor**. This is the heart of why Mermaid needs the full message list up front.

**Pre-pass A — `getMaxMessageWidthPerActor`** (`sequenceRenderer.ts:1487-1586`) iterates *every* message, measures its rendered text width, and records the max per actor-gap:

`sequenceRenderer.ts:1494-1518` (annotated)
```ts
for (const msg of messages) {
  if (actors.get(msg.to) && actors.get(msg.from)) {
    const actor = actors.get(msg.to);
    ...
    const messageDimensions = hasKatex(wrappedMessage)
      ? await calculateMathMLDimensions(msg.message, getConfig())
      : utils.calculateTextDimensions(wrappedMessage, textFont);  // text measured per message
    const messageWidth = messageDimensions.width + 2 * conf.wrapPadding;
```
and the gap assignment (`sequenceRenderer.ts:1536-1555`):
```ts
if (isMessage && msg.from === actor.nextActor) {
  // right-to-left message: widen the gap owned by the *receiving* actor
  maxMessageWidthPerActor[msg.to] = common.getMax(maxMessageWidthPerActor[msg.to] || 0, messageWidth);
} else if (isMessage && msg.from === actor.prevActor) {
  // left-to-right message: widen the gap owned by the *sending* actor
  maxMessageWidthPerActor[msg.from] = common.getMax(maxMessageWidthPerActor[msg.from] || 0, messageWidth);
} else if (isMessage && msg.from === msg.to) {
  // self message: half the label width pushes both neighbors
  maxMessageWidthPerActor[msg.from] = common.getMax(..., messageWidth / 2);
  maxMessageWidthPerActor[msg.to]   = common.getMax(..., messageWidth / 2);
}
```
(notes contribute via `PLACEMENT.RIGHTOF` / `LEFTOF` / `OVER` at lines 1556-1580; `prevActor`/`nextActor` are linked-list pointers set at parse time in `sequenceDb.ts:213-230`.)

**Pre-pass B — `calculateActorMargins`** (`sequenceRenderer.ts:1613-1690`) sets each actor's own width from its label, then converts the max message width into the actor's right margin:

`sequenceRenderer.ts:1632-1660`
```ts
actor.width = actor.wrap
  ? conf.width
  : common.getMax(conf.width, actDims.width + 2 * conf.wrapPadding); // min 150, grows with name
...
const messageWidth = actorToMessageWidth[actorKey];
const actorWidth = messageWidth + conf.actorMargin - actor.width / 2 - nextActor.width / 2;
actor.margin = common.getMax(actorWidth, conf.actorMargin);   // gap >= 50, widened by labels
```

**Placement — `addActorRenderingData`** (`sequenceRenderer.ts:742-810`) then walks the actor list once and assigns x as a running sum (this is the only place `actor.x` is set):

`sequenceRenderer.ts:751-809` (extract)
```ts
let prevWidth = 0;
let prevMargin = 0;
...
for (const actorKey of actorKeys) {
  const actor = actors.get(actorKey);
  ...
  actor.width = common.getMax(actor.width || conf.width, conf.width);
  actor.height = common.getMax(actor.height || conf.height, conf.height);
  actor.margin = actor.margin || conf.actorMargin;
  ...
  if (createdActors.get(actor.name)) {     // actors created mid-diagram get extra room
    prevMargin += actor.width / 2;
  }

  actor.x = prevWidth + prevMargin;        // <-- running-sum column position
  actor.starty = bounds.getVerticalPos();
  bounds.insert(actor.x, verticalPos, actor.x + actor.width, actor.height);
  prevWidth += actor.width + prevMargin;
  ...
  prevMargin = actor.margin;               // next gap = this actor's (label-widened) margin
  ...
}
// Add a margin between the actor boxes and the first arrow
bounds.bumpVerticalPos(maxHeight);
```

So: **columns are computed from label widths** (actor description width and the widest message/note label crossing each gap), with floors `width=150` and `actorMargin=50`.

### 1.3 The core message loop

`draw()` (`sequenceRenderer.ts:1042-1474`) runs the pre-passes (lines 1072-1073 and 1099-1100):

`sequenceRenderer.ts:1072-1073, 1099-1100`
```ts
const maxMessageWidthPerActor = await getMaxMessageWidthPerActor(actors, messages, diagObj);
conf.height = await calculateActorMargins(actors, maxMessageWidthPerActor, boxes);
...
addActorRenderingData(diagram, actors, createdActors, actorKeys, 0, messages, false);
const loopWidths = await calculateLoopBounds(messages, actors, maxMessageWidthPerActor, diagObj);
```

then walks the flat message list once. Note that fragments, activations, and notes are encoded as pseudo-messages in the same list, distinguished by `msg.type` (the `LINETYPE` codes — see §2.1):

`sequenceRenderer.ts:1140-1340` (condensed, annotated)
```ts
let sequenceIndex = 1;
const messagesToDraw = [];
const backgrounds = [];
let index = 0;
for (const msg of messages) {
  switch (msg.type) {
    case diagObj.db.LINETYPE.NOTE:
      bounds.resetVerticalPos();
      await drawNote(diagram, msg.noteModel, msg.id);          // draws + bumps cursor
      break;
    case diagObj.db.LINETYPE.ACTIVE_START:
      bounds.newActivation(msg, diagram, actors);              // push open activation
      break;
    case diagObj.db.LINETYPE.ACTIVE_END:
      activeEnd(msg, bounds.getVerticalPos());                 // pop + draw rect
      break;
    case diagObj.db.LINETYPE.LOOP_START:                       // (same shape for OPT/ALT/PAR/...)
      adjustLoopHeightForWrap(loopWidths, msg, conf.boxMargin,
        conf.boxMargin + conf.boxTextMargin, (m) => bounds.newLoop(m)); // push fragment + bump
      break;
    case diagObj.db.LINETYPE.LOOP_END:
      loopModel = bounds.endLoop();                            // pop fragment
      await svgDraw.drawLoop(diagram, loopModel, 'loop', conf, msg);    // draw box NOW
      bounds.bumpVerticalPos(loopModel.stopy - bounds.getVerticalPos()); // sync cursor to box bottom
      bounds.models.addLoop(loopModel);
      break;
    case diagObj.db.LINETYPE.ALT_ELSE:
      adjustLoopHeightForWrap(loopWidths, msg, conf.boxMargin + conf.boxTextMargin,
        conf.boxMargin, (m) => bounds.addSectionToLoop(m));    // record divider y on open fragment
      break;
    ...
    default:                                                   // an actual arrow
      msgModel = msg.msgModel;                                 // x-geometry precomputed in calculateLoopBounds
      msgModel.starty = bounds.getVerticalPos();
      const lineStartY = await boundMessage(diagram, msgModel); // advance cursor, compute line y
      adjustCreatedDestroyedData(msg, msgModel, lineStartY, index, actors, createdActors, destroyedActors);
      messagesToDraw.push({ messageModel: msgModel, lineStartY, msg }); // DEFERRED draw
      bounds.models.addMessage(msgModel);
  }
  index++;
}
```

The per-arrow cursor advance lives in `boundMessage` ("Process a message by adding its dimensions to the bound … We do not draw the message at this point so the arrowhead can be on top of the activation box", `sequenceRenderer.ts:397-400`):

`sequenceRenderer.ts:406-450` (annotated)
```ts
async function boundMessage(_diagram, msgModel): Promise<number> {
  bounds.bumpVerticalPos(10);                          // fixed pre-gap
  const { startx, stopx, message } = msgModel;
  const lines = common.splitBreaks(message).length;
  const textDims = ... utils.calculateTextDimensions(message, messageFont(conf));
  if (!isKatexMsg) {
    const lineHeight = textDims.height / lines;
    msgModel.height += lineHeight;
    bounds.bumpVerticalPos(lineHeight);                // room for first label line
  }
  let lineStartY;
  let totalOffset = textDims.height - 10;              // remaining label height
  if (startx === stopx) {                              // ---- SELF MESSAGE ----
    lineStartY = bounds.getVerticalPos() + totalOffset;
    if (!conf.rightAngles) {
      totalOffset += conf.boxMargin;                   // +10
      lineStartY = bounds.getVerticalPos() + totalOffset;
    }
    totalOffset += 30;                                 // +30 for the loop-back curve
    const dx = common.getMax(textWidth / 2, conf.width / 2);
    bounds.insert(startx - dx, ..., stopx + dx, ...);  // widen extent to the side
  } else {                                             // ---- NORMAL MESSAGE ----
    totalOffset += conf.boxMargin;                     // +10
    lineStartY = bounds.getVerticalPos() + totalOffset;
    bounds.insert(startx, lineStartY - 10, stopx, lineStartY);
  }
  bounds.bumpVerticalPos(totalOffset);                 // advance cursor past line
  msgModel.height += totalOffset;
  msgModel.stopy = msgModel.starty + msgModel.height;
  bounds.insert(msgModel.fromBounds, msgModel.starty, msgModel.toBounds, msgModel.stopy);
  return lineStartY;
}
```

So a plain one-line message consumes `10 + lineHeight + (textHeight − 10 + boxMargin)` ≈ `textHeight + lineHeight + 10` vertical px; the arrow line is drawn at the *bottom* of that band (label above the line). After the loop, queued arrows are drawn (`sequenceRenderer.ts:1388-1390`):

```ts
for (const e of messagesToDraw) {
  await drawMessage(diagram, e.messageModel, e.lineStartY, diagObj, e.msg, id);
}
```

### 1.4 Bounds accumulation model

- `bounds.data.{startx,starty,stopx,stopy}` start `undefined` and are min/max-folded by `updateVal` (`sequenceRenderer.ts:98-104`) on every `insert` and every `bumpVerticalPos` (`:214`).
- `bounds.models` (`:27-84`) is a passive record of every actor/box/loop/message/note model drawn, used at the end for boxes and debugging.
- Final size: `draw()` reads `bounds.getBounds()` and derives width/height/viewBox (`sequenceRenderer.ts:1416-1471`), e.g. `height = (box.stopy - box.starty) + 2 * conf.diagramMarginY` (`:1437`) and `width = boxWidth + 2 * conf.diagramMarginX` (`:1447`).

---

## 2. Message rendering

### 2.1 LINETYPE enum — solid/dashed and arrowhead family

`packages/mermaid/src/diagrams/sequence/sequenceDb.ts:34-96` (extract)
```ts
const LINETYPE = {
  SOLID: 0,          // ->>  solid line, filled triangle arrowhead
  DOTTED: 1,         // -->> dashed line, filled triangle (the conventional "return")
  NOTE: 2,
  SOLID_CROSS: 3,    // -x   cross head
  DOTTED_CROSS: 4,   // --x
  SOLID_OPEN: 5,     // ->   no arrowhead at all
  DOTTED_OPEN: 6,    // -->
  LOOP_START: 10, LOOP_END: 11,
  ALT_START: 12, ALT_ELSE: 13, ALT_END: 14,
  OPT_START: 15, OPT_END: 16,
  ACTIVE_START: 17, ACTIVE_END: 18,
  PAR_START: 19, PAR_AND: 20, PAR_END: 21,
  RECT_START: 22, RECT_END: 23,
  SOLID_POINT: 24, DOTTED_POINT: 25,   // -) / --) "filled point" async style
  AUTONUMBER: 26,
  CRITICAL_START: 27, ... BREAK_END: 31, PAR_OVER_START: 32,
  BIDIRECTIONAL_SOLID: 33, BIDIRECTIONAL_DOTTED: 34,
  /* 41-58: UML2-style top/bottom-half ("stick"/"solid") and reverse variants */
  CENTRAL_CONNECTION: 59, ...
} as const;

const ARROWTYPE = { FILLED: 0, OPEN: 1 } as const;
```

Note that fragment delimiters and activations are themselves LINETYPE codes interleaved into the one flat `messages` array — the renderer has no tree.

**Dashed vs solid** is a stroke-dasharray decision in `drawMessage` (`sequenceRenderer.ts:548-567`):
```ts
if (
  type === diagObj.db.LINETYPE.DOTTED ||
  type === diagObj.db.LINETYPE.DOTTED_CROSS ||
  type === diagObj.db.LINETYPE.DOTTED_POINT ||
  type === diagObj.db.LINETYPE.DOTTED_OPEN ||
  type === diagObj.db.LINETYPE.BIDIRECTIONAL_DOTTED || ...
) {
  line.style('stroke-dasharray', '3, 3');
  line.attr('class', 'messageLine1');
} else {
  line.attr('class', 'messageLine0');
}
```

**Arrowheads** are SVG `<marker>` defs inserted once per diagram (`sequenceRenderer.ts:1103-1110`), then referenced by `marker-end`/`marker-start` per type (`sequenceRenderer.ts:627-643`):
```ts
if (type === diagObj.db.LINETYPE.SOLID || type === diagObj.db.LINETYPE.DOTTED) {
  line.attr('marker-end', 'url(' + url + '#' + diagramId + '-arrowhead)');
}
if (type === BIDIRECTIONAL_SOLID || type === BIDIRECTIONAL_DOTTED) {
  line.attr('marker-start', ...'-arrowhead)');
  line.attr('marker-end', ...'-arrowhead)');
}
if (type === SOLID_POINT || type === DOTTED_POINT) {
  line.attr('marker-end', ...'-filled-head)');
}
if (type === SOLID_CROSS || type === DOTTED_CROSS) {
  line.attr('marker-end', ...'-crosshead)');
}
```
`SOLID_OPEN`/`DOTTED_OPEN` match none of these → bare line. Marker shapes: filled triangle `M -1 0 L 10 5 L 0 10 z` (`svgDraw.js:1551-1564`), "filled point" `M 18,7 L9,13 L14,7 L9,1 Z` (`svgDraw.js:1571-1583`), cross `M 1,2 L 6,7 M 6,2 L 1,7` (`svgDraw.js:1612-1631`).

### 2.2 Message x-geometry (`buildMessageModel`)

Endpoints are not lifeline centers — they are the outer edges of any active activation bars, computed via `activationBounds` (`sequenceRenderer.ts:895-913`, see §4.1) in `buildMessageModel`:

`sequenceRenderer.ts:1897-1901`
```ts
const [fromLeft, fromRight] = activationBounds(msg.from, actors);
const [toLeft, toRight] = activationBounds(msg.to, actors);
const isArrowToRight = fromLeft <= toLeft;
let startx = isArrowToRight ? fromRight : fromLeft;
let stopx = isArrowToRight ? toLeft : toRight;
```
plus small ±3px arrowhead-clearance nudges (`:1951-1992`). For self-messages it forces `stopx = startx` (`:1930-1934`). The model also records `fromBounds`/`toBounds` = min/max of all four edges (`:2020-2021`) for the autonumber bubble and bounds insertion.

Important: `buildMessageModel` is invoked inside the pre-pass `calculateLoopBounds` (`sequenceRenderer.ts:2108-2110`: `msgModel = buildMessageModel(msg, actors, diagObj); msg.msgModel = msgModel;`), which replays ACTIVE_START/ACTIVE_END to simulate the activation stack (`:2073-2095`) — so all arrow x-coordinates are fixed before the main render loop runs.

### 2.3 Self-messages

Detected by `startx === stopx`. Vertical cost (from `boundMessage`, `sequenceRenderer.ts:425-438`, quoted in §1.3): label height + `boxMargin`(10) + **30px** for the curve — noticeably taller than a normal message. Horizontally they widen the bounds by `max(textWidth/2, conf.width/2)` to the side (`:432-438`).

Drawing is a cubic Bézier that bulges 60px to the right and comes back 20px lower (`sequenceRenderer.ts:509-530`):
```ts
line = diagram.append('path').attr('d',
  'M ' + lineStartX + ',' + lineStartY +
  ' C ' + (lineStartX + 60) + ',' + (lineStartY - 10) +   // control 1: 60px right
  ' '   + (startx + 60)     + ',' + (lineStartY + 30) +   // control 2
  ' '   + startx            + ',' + (lineStartY + 20));   // returns 20px below start
```
(`rightAngles` mode draws an `H/V/H` path instead, `:500-508`.)

### 2.4 Label placement

Labels are drawn **above** the arrow line, horizontally **centered between the two endpoints** (default `messageAlign: 'center'`): `drawMessage` builds a text object spanning `[min(startx,stopx), max]` at the *top* of the message band, while the line itself is at `lineStartY` = bottom of the band:

`sequenceRenderer.ts:470-482`
```ts
const textObj = svgDrawCommon.getTextObj();
textObj.x = Math.min(startx, stopx);
textObj.y = starty + 10;                    // top of the message band (line is lower, at lineStartY)
textObj.width = Math.abs(stopx - startx);   // label box spans the gap
textObj.class = 'messageText';
...
textObj.anchor = conf.messageAlign;         // default 'center' → centered between lifelines
```

Wrapping: if `msg.wrap`, the text is re-wrapped to the actual gap width at model build time — `utils.wrapLabel(msg.message, max(boundedWidth + 2*wrapPadding, conf.width), ...)` (`sequenceRenderer.ts:1997-2003`); multi-line labels add height in `boundMessage` via `textDims.height`.

---

## 3. Fragments (loop / alt / opt / par / critical / break / rect)

### 3.1 Open → accumulate → close lifecycle

**Open.** `*_START` pushes a fragment with known `starty` but *unknown* x-extent onto the `sequenceItems` stack:

`sequenceRenderer.ts:170-188`
```ts
createLoop: function (title = {...}, fill) {
  return {
    startx: undefined,           // x-extent unknown until inner content arrives
    starty: this.verticalPos,    // y fixed at open time = current cursor
    stopx: undefined,
    stopy: undefined,
    title: title.message, ..., height: 0, fill: fill,
  };
},
newLoop: function (title, fill) {
  this.sequenceItems.push(this.createLoop(title, fill));
},
endLoop: function () {
  return this.sequenceItems.pop();
},
```
The `*_START` case wraps this in `adjustLoopHeightForWrap` (`sequenceRenderer.ts:915-933`), which charges the title space to the cursor: bump `preMargin` (= `boxMargin` 10), wrap the title text to the precomputed fragment width (`loopWidths[msg.id]`, from the pre-pass), then bump `postMargin + titleTextHeight` where `postMargin = boxMargin + boxTextMargin` (15) and `titleTextHeight = max(textDims.height, labelBoxHeight=20)`:
```ts
function adjustLoopHeightForWrap(loopWidths, msg, preMargin, postMargin, addLoopFn) {
  bounds.bumpVerticalPos(preMargin);
  let heightAdjust = postMargin;
  if (msg.id && msg.message && loopWidths[msg.id]) {
    const loopWidth = loopWidths[msg.id].width;
    msg.message = utils.wrapLabel(`[${msg.message}]`, loopWidth - 2 * conf.wrapPadding, textConf);
    ...
    const totalOffset = common.getMax(textDims.height, conf.labelBoxHeight);
    heightAdjust = postMargin + totalOffset;
  }
  addLoopFn(msg);                  // push fragment (or add section) AFTER pre-bump
  bounds.bumpVerticalPos(heightAdjust);
}
```
So a fragment header costs ≈ `boxMargin + boxTextMargin + max(titleHeight, 20)` ≈ 35px minimum on open, and `endLoop` adds a trailing `boxMargin` per nesting level via `updateBounds` (below).

**Accumulate.** Every inner `bounds.insert(...)` fans out to *all* open fragments through `updateBounds`, expanding each by `n * boxMargin` where `n` is the item's depth from the top of the stack — this is what makes outer boxes wrap inner boxes with growing padding:

`sequenceRenderer.ts:105-134` (annotated)
```ts
updateBounds: function (startx, starty, stopx, stopy) {
  const _self = this;
  let cnt = 0;
  function updateFn(type?: 'activation') {
    return function updateItemBounds(item) {
      cnt++;
      // stack order: the outermost fragment gets the biggest margin
      const n = _self.sequenceItems.length - cnt + 1;
      _self.updateVal(item, 'starty', starty - n * conf.boxMargin, Math.min);
      _self.updateVal(item, 'stopy',  stopy  + n * conf.boxMargin, Math.max);
      _self.updateVal(bounds.data, 'startx', startx - n * conf.boxMargin, Math.min);
      _self.updateVal(bounds.data, 'stopx',  stopx  + n * conf.boxMargin, Math.max);
      if (!(type === 'activation')) {
        _self.updateVal(item, 'startx', startx - n * conf.boxMargin, Math.min);
        _self.updateVal(item, 'stopx',  stopx  + n * conf.boxMargin, Math.max);
        ...
      }
    };
  }
  this.sequenceItems.forEach(updateFn());
  this.activations.forEach(updateFn('activation'));
},
```
A fragment's box is therefore the min/max envelope of everything drawn while it was open, inflated by `boxMargin` per nesting level. Nested fragments need no special code: the inner box is itself `insert`ed when drawn, which expands the outer one.

**Close.** `*_END` pops, draws the box *immediately* (the box is the only thing drawn after its content), and snaps the cursor to the box's (margin-expanded) bottom edge:

`sequenceRenderer.ts:1175-1180`
```ts
case diagObj.db.LINETYPE.LOOP_END:
  loopModel = bounds.endLoop();
  await svgDraw.drawLoop(diagram, loopModel, 'loop', conf, msg);
  bounds.bumpVerticalPos(loopModel.stopy - bounds.getVerticalPos()); // cursor := box bottom
  bounds.models.addLoop(loopModel);
  break;
```
ALT/OPT/PAR/CRITICAL/BREAK are byte-for-byte the same pattern with a different label string (`:1203-1315`). `rect` backgrounds are the same lifecycle but the popped model goes into `backgrounds[]` and is drawn at the very end behind everything (`:1197-1202`, drawn at `:1394`).

### 3.2 `else` / `and` / `option` sections

A section divider does not pop the fragment; it records a divider y and title on the *open* fragment:

`sequenceRenderer.ts:194-201`
```ts
addSectionToLoop: function (message) {
  const loop = this.sequenceItems.pop();
  loop.sections = loop.sections || [];
  loop.sectionTitles = loop.sectionTitles || [];
  loop.sections.push({ y: bounds.getVerticalPos(), height: 0 });
  loop.sectionTitles.push(message);
  this.sequenceItems.push(loop);
},
```
(`ALT_ELSE` at `:1227-1235`, `PAR_AND` at `:1253-1261`, `CRITICAL_OPTION` at `:1286-1294`, each also via `adjustLoopHeightForWrap` so the divider+title consumes cursor space.) `par_over` additionally saves the cursor at section start so parallel sections overlap (`saveVerticalPos`, `:1251`; restored on NOTE via `resetVerticalPos`, `:1150` — gated on the top fragment's `overlap` flag, `:189-193`).

**Drawing** (`svgDraw.js:1389-1470`): four border lines, dashed `3,3` divider lines at each recorded `sections[i].y`, a pentagon-ish label box ("loop"/"alt"/...) of `labelBoxWidth=50 × labelBoxHeight=20` at the top-left, the `[condition]` title centered at `starty + boxMargin + boxTextMargin`, and each section title centered at `sections[idx].y + boxMargin + boxTextMargin`:
```js
drawLoopLine(loopModel.startx, loopModel.starty, loopModel.stopx, loopModel.starty);
drawLoopLine(loopModel.stopx,  loopModel.starty, loopModel.stopx, loopModel.stopy);
drawLoopLine(loopModel.startx, loopModel.stopy,  loopModel.stopx, loopModel.stopy);
drawLoopLine(loopModel.startx, loopModel.starty, loopModel.startx, loopModel.stopy);
if (loopModel.sections !== undefined) {
  loopModel.sections.forEach(function (item) {
    drawLoopLine(loopModel.startx, item.y, loopModel.stopx, item.y).style('stroke-dasharray', '3, 3');
  });
}
```

### 3.3 The fragment-width pre-pass (`calculateLoopBounds`)

Before the render loop, `calculateLoopBounds` (`sequenceRenderer.ts:2032-2142`) replays the whole message list with its own fragment stack purely to learn each fragment's final *width* (needed to wrap `[condition]` titles at open time, i.e. before the contents have been rendered):

`sequenceRenderer.ts:2037-2071, 2108-2136` (extract)
```ts
for (const msg of messages) {
  switch (msg.type) {
    case LOOP_START: case ALT_START: ... case BREAK_START:
      stack.push({ id: msg.id, from: Number.MAX_SAFE_INTEGER, to: Number.MIN_SAFE_INTEGER, width: 0 });
      break;
    case LOOP_END: ... case BREAK_END:
      current = stack.pop();
      loops[current.id] = current;          // final width keyed by START-marker id
      break;
    ...
  }
  ...
  msgModel = buildMessageModel(msg, actors, diagObj);
  msg.msgModel = msgModel;                  // x-geometry cached on the message here
  if (msgModel.startx && msgModel.stopx && stack.length > 0) {
    stack.forEach((stk) => {
      current.from = common.getMin(msgModel.startx, current.from);
      current.to   = common.getMax(msgModel.stopx,  current.to);
      current.width = common.getMax(current.width, msgModel.width) - conf.labelBoxWidth;
    });
  }
}
```
This is a second full-list dependency: the title wrap width of a fragment depends on messages that appear *later inside it*.

---

## 4. Activation bars and notes

### 4.1 Activations

**Open** (`ACTIVE_START` → `bounds.newActivation`, `sequenceRenderer.ts:148-160`): pushed onto `bounds.activations`; nested activations on the same actor are offset right by `activationWidth/2 = 5px` each:
```ts
newActivation: function (message, diagram, actors) {
  const actorRect = actors.get(message.from);
  const stackedSize = actorActivations(message.from).length || 0;   // how many already open on this actor
  const x = actorRect.x + actorRect.width / 2 + ((stackedSize - 1) * conf.activationWidth) / 2;
  this.activations.push({
    startx: x,
    starty: this.verticalPos + 2,
    stopx: x + conf.activationWidth,     // bars are 10px wide
    stopy: undefined,
    actor: message.from,
    anchored: svgDraw.anchorElement(diagram),   // placeholder <g> so the rect z-orders correctly
  });
},
```
Note `anchored`: an empty `<g>` is appended to the SVG *at open time*, so when the rect is finally drawn (at close) it sits *under* later arrows — a DOM-order trick standing in for z-index.

**Close** (`ACTIVE_END` → `activeEnd`, `sequenceRenderer.ts:1120-1137`): pop the most recent activation for that actor (`endActivation` uses `lastIndexOf`, `:161-168` — proper LIFO per actor), enforce a minimum visible height, draw the rect from `starty` to the current cursor:
```ts
function activeEnd(msg: any, verticalPos: number) {
  const activationData = bounds.endActivation(msg);
  if (activationData.starty + 18 > verticalPos) {   // retro-fix: too short → move starty UP
    activationData.starty = verticalPos - 6;
    verticalPos += 12;
  }
  svgDraw.drawActivation(diagram, activationData, verticalPos, conf, actorActivations(msg.from).length, diagObj, actorIndexMap);
  bounds.insert(activationData.startx, verticalPos - 10, activationData.stopx, verticalPos);
}
```
`drawActivation` (`svgDraw.js:1347-1378`) is a plain rect of width `stopx - startx` and height `verticalPos - starty`, class `activation0/1/2` cycling with stack depth (`:1363`). Activations do **not** themselves advance the y cursor (except the +12 minimum-height fix); they only span whatever the messages consumed.

**Interaction with arrows:** message endpoints attach to the outermost activation edge via `activationBounds` (`sequenceRenderer.ts:895-913`):
```ts
const left = activations.reduce((acc, a) => common.getMin(acc, a.startx),
  actorObj.x + actorObj.width / 2 - 1);
const right = activations.reduce((acc, a) => common.getMax(acc, a.stopx),
  actorObj.x + actorObj.width / 2 + 1);
return [left, right];
```

### 4.2 Notes

x/width is computed in `buildNoteModel` (`sequenceRenderer.ts:1692-1762`) per placement:
```ts
if (msg.placement === diagObj.db.PLACEMENT.RIGHTOF) {
  noteModel.width = ... common.getMax(fromActor.width / 2 + toActor.width / 2,
    textDimensions.width + 2 * conf.noteMargin);
  noteModel.startx = startx + (fromActor.width + conf.actorMargin) / 2;   // right of lifeline
} else if (msg.placement === diagObj.db.PLACEMENT.LEFTOF) {
  ...
  noteModel.startx = startx - noteModel.width + (fromActor.width - conf.actorMargin) / 2;
} else if (msg.to === msg.from) {        // "note over A" (single actor): centered on lifeline
  noteModel.startx = startx + (fromActor.width - noteModel.width) / 2;
} else {                                 // "note over A,B": spans both lifelines + margin
  noteModel.width = Math.abs(startx + fromActor.width / 2 - (stopx + toActor.width / 2)) + conf.actorMargin;
  noteModel.startx = startx < stopx
    ? startx + fromActor.width / 2 - conf.actorMargin / 2
    : stopx + toActor.width / 2 - conf.actorMargin / 2;
}
```
y is purely cursor-driven in `drawNote` (`sequenceRenderer.ts:242-285`): bump `boxMargin` (10), place rect at the cursor, draw text, *measure rendered text height from the DOM* (`getBBox()`), set rect height = `textHeight + 2 * noteMargin`, bump that, and `insert`:
```ts
bounds.bumpVerticalPos(conf.boxMargin);
noteModel.starty = bounds.getVerticalPos();
...
const textHeight = Math.round(textElem.map((te) => (te._groups || te)[0][0].getBBox().height)...);
rectElem.attr('height', textHeight + 2 * conf.noteMargin);
bounds.bumpVerticalPos(textHeight + 2 * conf.noteMargin);
noteModel.stopy = noteModel.starty + textHeight + 2 * conf.noteMargin;
bounds.insert(noteModel.startx, noteModel.starty, noteModel.stopx, noteModel.stopy);
```
So a note costs `boxMargin + textHeight + 2*noteMargin` ≈ `30 + textHeight` vertical px. Notes also feed the actor-margin pre-pass (`getMaxMessageWidthPerActor` PLACEMENT branches, `:1556-1580`), i.e. wide notes push columns apart too.

---

## 5. Static (one-pass) design vs streaming

### 5.1 Why the current design requires the full message list

The `draw()` entrypoint hard-codes three full-list passes *before* the first message-band pixel is placed:

1. **Label-measuring pass** — `getMaxMessageWidthPerActor(actors, messages, ...)` (`sequenceRenderer.ts:1072`) reads *every* message/note label to size the gaps.
2. **Margin/placement pass** — `calculateActorMargins` (`:1073`) + `addActorRenderingData` (`:1099`) freeze every `actor.x` from those measurements. After this point actor x never changes.
3. **Fragment-width + message-x pass** — `calculateLoopBounds(messages, ...)` (`:1100`, body `:2032-2142`) replays the entire list (including a simulated activation stack, `:2073-2095`) to (a) compute each fragment's final width for title wrapping at *open* time and (b) cache `msg.msgModel` x-geometry for all messages.

Then the main loop (`:1145-1382`) runs, and finally a batch of **post-passes** that also depend on totality:

4. Deferred arrow drawing — all arrows queued in `messagesToDraw` and drawn only after `drawActors` (`:1386-1390`) so arrowheads paint over activation rects (the stated reason at `:397-400`).
5. `drawActors(..., isFooter=true)` mirrored bottom actor row (`:1391-1393`, default `mirrorActors: true`).
6. `backgrounds.forEach(... drawBackgroundRect ...)` (`:1394`) — `rect` fills drawn last (DOM-first via ordering, painted behind by CSS).
7. `fixLifeLineHeights(diagram, actors, actorKeys, conf)` (`:1395`, impl `svgDraw.js:317-330`) — mutates each lifeline's `y2` attribute once the final diagram height is known:
   ```js
   actorKeys.forEach((actorKey) => {
     const actor = actors.get(actorKey);
     const actorDOM = diagram.select('#actor' + actor.actorCnt);
     if (!conf.mirrorActors && actor.stopy) {
       actorDOM.attr('y2', actor.stopy + actor.height / 2);
     } else if (conf.mirrorActors) {
       actorDOM.attr('y2', actor.stopy);
     }
   });
   ```
8. Participant-group boxes get their height only now: `box.height = bounds.getVerticalPos() - box.y` (`:1397-1407`).
9. `viewBox`/`width`/`height` computed from final `bounds.data` (`:1416-1471`).

### 5.2 The good news: the y model is append-only

`bumpVerticalPos` (`:212-215`) only adds; `verticalPos` is never reduced except by the narrowly-scoped `par_over` save/restore (`:202-211`, used at `:1150`/`:1251`). Messages, notes, fragment headers, and fragment closes each consume a deterministic band of vertical space computed from *local* information (their own label dims + open-fragment nesting depth). Nothing about message *N* changes the y of messages `1..N-1` (the single exception: `activeEnd`'s minimum-height fix moves an activation's `starty` up by a few px, `:1122-1125`, and `adjustCreatedDestroyedData` shifts a created/destroyed actor's `starty`/`stopy` to the current line, `:1007`/`:1017`/`:1029` — both are local, bounded retro-edits). So the **vertical** half of the algorithm is directly reusable for incremental live rendering.

The **horizontal** half is the problem: every x in the system (`actor.x`, activation x, message startx/stopx, note x, fragment startx/stopx) derives from the label-measured `actor.margin`s frozen in step 2.

### 5.3 (a) State an incremental version must persist between appends

Reading off the `bounds` object (`sequenceRenderer.ts:17-27` and methods), an append-only renderer needs exactly:

1. **The y cursor** — `bounds.verticalPos` (`:24`).
2. **The open-fragment stack** — `bounds.sequenceItems` (`:25`), each entry carrying `{startx?, starty, stopx?, stopy?, title, sections[], sectionTitles[], fill}` (`createLoop`, `:170-182`; `addSectionToLoop`, `:194-201`). Min/max accumulation per `updateBounds` (`:105-134`) works fine incrementally — it already is incremental.
3. **The open-activation stack** — `bounds.activations` (`:26`), entries `{startx, starty, stopx, stopy?, actor, anchored}` (`:148-160`), with per-actor LIFO close semantics (`endActivation` `lastIndexOf`, `:161-168`) and per-actor stack depth for the +5px nesting offset (`actorActivations`, `:889-893`).
4. **The overall extent** — `bounds.data.{startx,starty,stopx,stopy}` (`:18-23`) for viewBox growth.
5. **The actor table** — `Map<name, {x, width, height, margin, prevActor, nextActor, starty}>` (fields set in `:778-799` / `calculateActorMargins`), which must be *fixed* (or explicitly re-laid-out) once drawn.
6. Minor counters: `sequenceIndex`/`sequenceIndexStep` for autonumber (`:1140-1141`, `:1268-1275`, `:1379`), and the `par_over` `savedVerticalPos` if that fragment kind is supported (`:204`).

That is the complete inter-message state: the main loop touches nothing else across iterations.

### 5.4 (b) Mermaid behaviors that must be dropped/changed for streaming

Retro-adjustments (later input changes earlier geometry) — these are the streaming-breakers:

1. **Label-width-driven actor gaps** — `getMaxMessageWidthPerActor` (`:1487-1586`) + `calculateActorMargins` (`:1640-1661`, `actor.margin = max(messageWidth + actorMargin − halfWidths, 50)`). A long label on message 500 widens the gap between two actors drawn at t=0, shifting *every* x to the right of that gap. Streaming replacement: fixed/uniform column gap with label truncation+tooltip or wrapping to the available gap (Mermaid already has the wrap path: `wrapLabel` to `boundedWidth` at `:1998-2002`).
2. **New actors appearing mid-stream** — Mermaid lays out all participants up front (`addActorRenderingData`, `:742-810`); `createdActors` get extra margin pre-allocated (`:785-787`) and `adjustCreatedDestroyedData` (`:945-1032`) shifts the new actor's header to the message line. For streaming, appending a new lifeline at the right edge is cheap (running-sum x), but an OTel trace can introduce an actor that "should" sit between existing ones — either always append rightmost, or accept a full re-layout on actor insertion.
3. **Fragment title wrapping needs final fragment width** — `calculateLoopBounds` pre-pass (`:2032-2142`) feeding `adjustLoopHeightForWrap` (`:915-933`): the `[condition]` label is wrapped to the fragment's *final* width at the moment the fragment *opens*. Streaming: wrap to current/estimated width, or render title unwrapped and re-wrap on close (header height would then have to be reserved conservatively, since header height feeds the cursor).
4. **Fragment boxes are drawn only at close** (`endLoop` + `drawLoop` at `*_END`, `:1175-1180`) and their x-extent grows with every inner `insert` (`updateBounds`, `:105-134`). Streaming: draw a provisional open box (top edge + growing sides) per stream tick and finalize on close — the accumulation math is already incremental; only the draw timing changes.
5. **Deferred arrow drawing for z-order** — `messagesToDraw` drained after the loop + actors (`:1388-1390`) and the activation `anchored` placeholder trick (`:158`) exist purely so arrowheads/rects layer correctly. Streaming: draw immediately into separate SVG layers (`<g class="activations">`, `<g class="arrows">`, …) instead of relying on append order.
6. **Lifeline lengths fixed post-hoc** — `fixLifeLineHeights` (`svgDraw.js:317-330`) sets `y2` after total height is known; mirrored footer actors are drawn at the end (`:1391-1393`); group-box heights closed at the end (`:1397-1404`); viewBox sized at the end (`:1437-1471`). Streaming: extend lifeline `y2`, footer y, box bottoms, and viewBox on every append (cheap attribute updates), or drop `mirrorActors`.
7. **`rect` backgrounds drawn last** (`backgrounds`, `:1199`, `:1394`) — same layering fix as (5).
8. **Small local retro-edits** to keep: `activeEnd` min-height fix (`:1122-1125`, moves `starty` up ≤12px) and created/destroyed actor `starty/stopy` shifts (`:1007`, `:1017`, `:1029`) — both touch only the element being closed, so they are streaming-safe as long as that element's SVG node is still addressable.

### 5.5 Assessment

Mermaid's sequence renderer is ~80% an incremental algorithm wearing a batch coat. The y axis is a pure fold over the message stream with a six-item state tuple (cursor, fragment stack, activation stack, extent, actor table, counters); fragments and activations are already open/accumulate/close stacks. The only *fundamental* batch dependency is horizontal: actor column positions are a function of the maximum label width per gap over the entire future. A live visualizer that (a) fixes column gaps (constant or quantized, wrapping/truncating labels to fit) and (b) appends new lifelines at the right edge can reuse the band-height arithmetic (`boundMessage`, `adjustLoopHeightForWrap`, `drawNote`) and the `updateBounds` fragment-envelope math essentially verbatim, drawing each band exactly once. Everything else that breaks (z-order deferral, lifeline/viewBox finalization) is replaceable with layered `<g>` groups and per-append attribute updates rather than algorithmic change.
