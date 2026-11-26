# Automating OpenDLE

Drives **OpenDLE's own desktop window** — the same Electron/Chromium page a person uses — over the
Chrome DevTools Protocol. No Playwright, no extra browser, no page snapshots: every step returns a
few numbers, which is what keeps a long automation session cheap for this machine.

```sh
npm run automation:brushes     # draw, move (Top + Front), grip-resize, 3D move, 3D face drag
npm run automation:menus       # the right-click menu carries the brush commands
npm run automation:maps        # a Quake .map as a new project, and as a layout beside the open one
npm run automation:game        # builds a bundled export and drives the real player window
node tools/automation/run.mjs brushes --port 3000
```

Output is one JSON line. A failure exits non-zero and names the failing step:

```json
{"ok":true,"scenario":"brushes","seconds":4.7,"result":{"ok":true,"steps":15,"view":"3d"}}
```

## How it works

- `studio.mjs` starts the studio server if nothing is listening, picks a free DevTools port, and
  launches `scripts/studio-desktop.js` with `--automation-port`. The window is **killed** when the
  scenario ends: its close handler would otherwise save, and an automation run must never write into
  the author's project library.
- `--automation-port` makes the shell add `?automation=1`, which installs `window.__opendle`
  (`public/automation.js`). In that mode the editor also opens a **blank** project instead of the
  stored campaign and disables autosave.
- `cdp.mjs` is a ~120-line CDP client built on Node's global `WebSocket` (`Runtime.evaluate`,
  `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`).
- **No dialog can block a run.** `cdp.mjs` enables the Page domain and answers every page dialog:
  a confirmation that follows a scenario's own click is accepted, a question about unsaved work
  ("discard", "restore", "overwrite") is dismissed so the project survives, and `page.dialogs`
  records what was answered. A dialog that opened during boot is cleared when the client attaches.
  The window is also spawned with `--no-close-prompt`, so the shell's own "close without saving?"
  box never appears either — a hidden window has nobody to click it, and it used to stay on screen,
  modal, after the run that spawned it had died. `dialogPolicy` (`accept`, `dismiss`, or
  `message => boolean`) overrides the default for a scenario that needs a specific answer.
- The licence dialog is accepted by clicking it, like a person does. The automation profile lives in
  `data/automation-profile` (gitignored), so it is remembered between runs. An already-accepted
  profile closes the dialog by itself and leaves the accept button disabled on purpose, so the
  helper waits for *closed or enabled* — waiting on the button alone hangs on every run after the
  first.
- **A run cannot outlive its own failure.** `lifecycle.mjs` tracks every process the harness spawns
  and kills them all when the run ends, however it ends (success, failure, a signal, the deadline).
  `run.mjs` puts the whole run behind a deadline — `OPENDLE_AUTOMATION_TIMEOUT_MS`, or `--timeout <ms>`,
  240 s by default, build included — and prints the usual
  one-line failure when it passes. Every CDP command is bounded too (`OPENDLE_CDP_TIMEOUT_MS`, 60 s): a page that
  stops answering used to hang an `await` forever, and the process then died on "unsettled top-level
  await" leaving the game window running.
- A game scenario waits through `waitForGame` (`scenarios/game.mjs`), which watches the page's own
  error screen as it polls: a boot that failed is reported in milliseconds with the game's words,
  not as a timeout 30 s later.
- **A run is invisible by default.** The harness starts the real window with `--hidden`: the same
  renderer, the same GPU surface, the same pixels — a window that is simply never shown and never
  takes the taskbar, so `npm test` and a scenario pass cannot interrupt work happening on the same
  machine. `backgroundThrottling: false` keeps a hidden window running at full speed, which is also
  why the page still reports `visibilityState: visible` inside it. `OPENDLE_AUTOMATION_VISIBLE=1`
  shows the window instead — the thing to do while writing a scenario, where watching it is the
  point. The exported game takes the same switches (`--hidden` / `--show`).
- `OPENDLE_AUTOMATION_ELECTRON_ARGS` adds Chromium switches to every window the harness opens —
  they go **before** the app path, because everything after it belongs to the app's own parser. It
  exists for a Wayland session that stops handing new Electron windows a connection (then
  `app.whenReady()` never settles and every scenario reports "No DevTools endpoint" while the
  desktop looks fine): `OPENDLE_AUTOMATION_ELECTRON_ARGS=--ozone-platform=x11` runs the same
  window on XWayland.
- A scenario that exports `needsStudio = false` is run **without** the studio window (`run.mjs`
  passes `{}` instead of a page). `game` does that: it builds a bundled export of the campaign in
  the editor's library, starts the build's own Electron (`main.js --automation-port <port>`), and
  drives the player window — so the licence gate, the studio window and the editor's storage cannot
  colour the result. With an empty library it falls back to a small authored fixture.

## The page hooks (`window.__opendle`)

| Hook | Returns |
| --- | --- |
| `ready()` / `status()` | whether the editor booted, plus the current view/selection |
| `state()` | counts, selection, projection, brush mode, `view`, `zoom`, `sceneReady` |
| `brushes()` | per brush: `bounds`, face count, `bases` (faces keeping an imported texture basis), and each face's `normal`, `centroid`, `basis` |
| `selection()` | current selection object |
| `errors()` | page errors collected since load (assert this is empty) |
| `lastDrag()` | the last completed 2D drag (from/to in view coordinates) |
| `worldToScreen(x, y, z)` | CSS pixels for the visible view (2D or 3D) |
| `screenToWorld(x, y)` | the inverse, in the current 2D view |
| `tool(name)`, `brushMode(mode)`, `projection(mode)`, `view('2d' \| '3d')` | editor commands |
| `focus(point, { distance, angle })` | places the 3D camera for a reproducible drag |
| `newDocument()` | a blank project |
| `importMap(text, { mode, name })` | the file picker's two modes: `project` or `layout`. Returns `{ ok, levelId, title, counts }` |
| `getLayouts()` | `{ active, levels: [{ id, name, brushes, entities }], listed }` — `listed` is what `#layout-levels` renders |

## Ad-hoc driving: `drive.mjs`

One line does one investigation, with no new file:

```sh
node tools/automation/drive.mjs 'eval:__opendle.state()' layout
node tools/automation/drive.mjs 'new' 'tool:room' 'drag:w:-160,-96|w:96,96' 'eval:__opendle.state().brushes'
node tools/automation/drive.mjs 'right-click:w:0,0' menu
node tools/automation/drive.mjs 'click:#environment' 'ui:#environment-panel h1' shot:/tmp/env.png
```

Drags and right clicks accept **world** coordinates (`w:x,y`), which the page converts, so no
pixel maths is needed. `--attach <cdpPort>` reuses a window started with `--keep`.

## The universal UI driver: `__opendle.ui`

| Call | Purpose |
| --- | --- |
| `describe(selector, { within, limit, hidden })` | `{ count, items: [{ ref, tag, id, name, text, value, checked, options, disabled, rect }] }` |
| `find(text, { selector, within })` | the ref of the first element whose text/label/value matches |
| `click(refOrSelector)` | a DOM click, focused first |
| `set(refOrSelector, value)` | input/select value plus `input` and `change` events |
| `check(refOrSelector, bool)` | checkbox/radio |
| `press(code)` | synthetic key press on the focused element |
| `text`, `exists`, `count` | small reads |
| `menu()` / `dialogs()` / `layout()` | the open context menu, open dialogs, the chrome with refs |

Refs (`r12`) are written as `data-opendle-ref`, so describe once and then act on the ref.

## Writing a scenario

```js
export async function run({ page }) {
  await page.evaluate('window.__opendle.newDocument()');
  await page.evaluate('window.__opendle.tool("room")');
  const from = await page.evaluate('window.__opendle.worldToScreen(-160, -96)');
  const to = await page.evaluate('window.__opendle.worldToScreen(96, 96)');
  await page.drag(from, to);                       // real mouse events
  const { brushes } = await page.evaluate('window.__opendle.state()');
  if (brushes !== 1) throw new Error('the drag did not create a brush');
}
```

Register it in `run.mjs`, then `node tools/automation/run.mjs <name>`.

`scenarios/maps.mjs` is the model for the map importer: it drives `importMap` in both modes,
then reads `getLayouts()` to prove the Layouts list and the dormant level agree with the import.
It also imports a Quake 3 brush primitive and checks that its six faces all kept a basis and all
have a polygon to draw — a fixture generated from `createBoxBrush`, because a hand-written "cube"
whose planes do not really enclose a volume imports as degenerate polygons and hides bugs.

## Traps

- **Never** add page-snapshot tooling here. A single whole-page snapshot is ~140 KB of session
  history, and that is what has taken the editor down before.
- Coordinates come from `worldToScreen`; a canvas that has not finished laying out gives silently
  wrong pixels. `brushes.mjs` has `stableCanvas()` for that reason.
- In 3D a press **on the gizmo** starts an axis-constrained transform. To test "drag the brush",
  press away from its centre — a face centroid, for example.
- A 2D drag snaps its *end* to the grid, so the travelled distance is a grid multiple, not an exact
  pixel ratio.
- The 3D view needs a GPU adapter. A machine can expose `navigator.gpu` and still return no adapter;
  `public/renderer-backend.js` probes for one and falls back to WebGL 2, but if neither backend can
  build the scene, `sceneReady` stays false and every 3D step times out. Check
  `canvas#scene-3d.dataset.rendererBackend` before blaming a scenario.
- An imported layout must not nest the shared project fields (`version`, `title`, `assets`, `game`)
  inside its `data`; the layout's name belongs in `level.name`.
- The licence dialog is fetched text: on a slow first load its Accept button stays disabled for a
  few seconds longer than usual, which is why that wait is 45 s and not 10.
