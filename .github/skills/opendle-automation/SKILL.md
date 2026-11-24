---
name: opendle-automation
description: Drive the real OpenDLE editor window (Electron/Chromium over CDP) to verify UI behaviour. Use when a change touches the editor UI, brushes, tools, menus, dialogs, or anything that only exists in the rendered page, and whenever a user reports "the button does nothing" or asks for the editor to be verified end to end.
---

# Driving OpenDLE

OpenDLE is a browser-native editor. Static checks cannot tell whether a button works, so UI changes
are verified in **the editor's own window**, driven over the Chrome DevTools Protocol.

**Never use page-snapshot browser tools** (opening a page and reading a full accessibility
snapshot). One snapshot is ~140 KB of session history and this machine has taken the editor down
that way. The harness below returns a few hundred bytes per step.

## Quick start

```sh
npm run automation:brushes        # 15 checks: draw, move in 2D (Top + Front), grip resize, 3D move, 3D face drag
npm run automation:menus          # 12 checks: brush commands are in the right-click menu, not the toolbar
```

Both print one JSON line and exit non-zero on the first failed step.

Ad-hoc driving, one line per idea:

```sh
node tools/automation/drive.mjs 'eval:__opendle.state()' layout
node tools/automation/drive.mjs 'new' 'tool:room' 'drag:w:-160,-96|w:96,96' 'eval:__opendle.state().brushes'
node tools/automation/drive.mjs 'ui:#inspector h2' 'click:#undo' 'eval:__opendle.state().brushes'
node tools/automation/drive.mjs 'right-click:w:0,0' menu
node tools/automation/drive.mjs 'click:#environment' 'ui:#environment-panel h1' shot:/tmp/env.png
```

Quote any step containing `(` `)` `[` `]` so bash keeps it whole.

## What `drive.mjs` accepts

`<command>:<argument>` steps, run in order:

| Step | Effect |
| --- | --- |
| `eval:<js>` | evaluate in the page, return the value |
| `wait-js:<expr>` / `wait:<ms>` | wait for a condition / sleep |
| `click:<selector>` / `click-text:<text>` | DOM click by CSS selector, ref, or visible text |
| `set:<selector>=<value>` / `check:<selector>=<true\|false>` | edit a field / tick a box, firing `input`+`change` |
| `key:<Code>` | synthetic key press on the focused element |
| `drag:<x1>,<y1>|<x2>,<y2>` | real mouse drag in CSS pixels |
| `drag:w:<x>,<y>|w:<x>,<y>` | real mouse drag given in **world** coordinates (page converts) |
| `right-click:<x>,<y>` or `right-click:w:<x>,<y>` | real right click — this is how context menus open |
| `ui:<selector>` / `menu` / `layout` / `dialogs` | describe elements / the open menu / the chrome |
| `tool:<name>`, `brush-mode:<object\|face\|vertex>`, `projection:<xy\|xz\|yz>`, `view:<2d\|3d>`, `new` | editor commands |
| `shot:<path>` | write a PNG to disk (only view it when the question is visual) |

Flags: `--port <n>` (default 3000), `--attach <cdpPort>` (reuse a window), `--timeout <ms>`,
`--allow-errors`.

## `window.__opendle` — what the editor knows

- `state()` → counts, selection, `projection`, `brushMode`, `view`, `zoom`, `sceneReady`
- `brushes()` → per brush `bounds`, face count, and every face's `normal` + `centroid`
- `selection()`, `errors()`, `lastDrag()`, `status()`, `ready()`
- `worldToScreen(x, y, z)` / `screenToWorld(x, y)` — the only correct way to turn world into pixels
- `tool()`, `brushMode()`, `projection()`, `view('2d'|'3d')`, `focus(point, { distance, angle })`, `newDocument()`
- `importMap(text, { mode: 'project' | 'layout', name })` — the same paths the `.map` picker takes
- `getLayouts()` → `{ active, levels: [{ id, name, brushes, entities }], listed }`

## `window.__opendle.ui` — the universal hook

- `describe(selector, { within, limit, hidden })` → `{ count, items: [{ ref, tag, id, name, text, value, checked, options, disabled, rect }] }`
- `find(text, { selector, within })` → ref
- `click(ref|selector)`, `set(ref|selector, value)`, `check(ref|selector, bool)`, `press(code)`
- `text(ref|selector, { max })`, `exists(selector)`, `count(selector)`
- `menu()` → the open context menu's items; `dialogs()` → open dialogs and their buttons
- `layout()` → header buttons, tabs, map-tool controls and inspector headings, each with a ref

Refs (`r12`) are written to the element as `data-opendle-ref` on first description, so
describe-then-act never repeats a fragile selector.

## Writing a scenario

Put it in `tools/automation/scenarios/<name>.mjs` exporting `run({ page })`, register it in
`run.mjs`, and use the `check(name, ok, detail)` pattern from `brushes.mjs` so a failure names the
step and prints the trail.

## Traps that produced false results before

- **Canvas not settled**: coordinates computed before layout finishes are wrong by tens of pixels.
  Wait until `#map` keeps the same rect twice (`stableCanvas()` in `brushes.mjs`).
- **Gizmo vs brush in 3D**: a press on the selection gizmo starts an axis-constrained transform.
  To test "drag the object", press away from its centre — a face centroid works.
- **Grid snapping**: a 2D drag snaps its *end* to the grid, so the distance travelled is a grid
  multiple, not an exact pixel ratio.
- **Licence gate**: the text is fetched, so `#license-accept` can stay disabled for many seconds on
  a cold profile. `studio.mjs` allows 45 s; do not shorten it.
- **No GPU adapter**: `navigator.gpu` can exist while `requestAdapter()` returns null. The backend
  falls back to WebGL 2, but if the scene still cannot be built `state().sceneReady` stays false and
  every 3D step times out. Read `canvas#scene-3d.dataset.rendererBackend` and `dataset.rendererFallback`
  before suspecting the code you just changed.
- **Layout data**: an imported layout may not nest `version`/`title`/`assets`/`game` in its `data`.
  If `importMap` throws "must not nest shared game fields", that is why.
- **A face pointing at the camera** cannot be dragged in that 2D view (the drag has no direction).
  Face editing is a 3D test, or the numeric "Push along normal" field.
- **Closing the window saves.** The harness kills the process on purpose; automation mode also
  starts from a blank project and disables autosave so the library is never touched.
- Automation mode is opt-in: `?automation=1` is added by `--automation-port` only.
