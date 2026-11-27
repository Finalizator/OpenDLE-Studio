# Several windows, one document

A second monitor is the reason this exists: right-click a tab to move that editor into a window of
its own. The tab, the panel body and the header of a detachable dialog all offer it.

## Opening and bringing back

- **Right-click a tab** → *Open* / *Open in a new window*. In a detached window the tab in the
  main window is marked `⧉`, and clicking it brings the editor home (the window closes).
- **Right-click inside a panel** → the same two items, unless something inside the panel claimed
  the right click (a tile, a row, a tree — they all have their own menu).
- **Right-click a script editor's header** → *Open this editor in a new window*; it reopens on the
  same script. A detached dialog is `?view=dialog&dialog=<name>&args=<json>`.
- The detached window carries a slim bar: the panel's name, **Move back to the main window** and
  **Close window**. On a machine with more than one display, the new window opens on the next
  display; otherwise it cascades on the same one.

## One document, not two copies

Detaching is **moving** an editor, not duplicating it. The window that opened first is the hub and
holds the whole project; a detached window receives that project — unsaved edits included — and
sends back only what its own panel changed. `shared/window-sync.js` is the rule:

| Panel | Owns |
| --- | --- |
| Layout | `map`, `paths`, `variables`, `worldLockedEntityIds` |
| Event sheet | `events`, `eventSheets`, `eventGroups`, `variables`, `arrays` |
| Environment | `environment`, `shaders`, `variables`, `assets`, `materialAnimations` |
| Shaders | `shaders`, `environment`, `assets` |
| Actors | `actors`, `assets` |
| Scripts | `mapScripts` |
| HUD | `hud`, `assets`, `spriteClips`, `gameMenus` |
| Terrain | `terrain`, `assets` |
| Timesheet | `timesheets`, `paths` |
| Scene | `scenes`, `actors`, `assets` |
| Assets | `assets` |
| Logs, Scriptlets, Tweaks, About, Addons | nothing (a read-only view) |

Everything a panel does **not** own is taken from the hub, so a wall drag in the main window can
never erase a HUD change made on the second monitor. A change a detached window makes outside its
own section is re-synchronised with the hub's version rather than overwriting it. Undo undoes the
edits that window made; Save, Play and imports stay in the main window, because they act on the
whole document.

Because the same section is edited in one window at a time, opening a detached tab in the main
window is the way back: it closes the other window and takes the panel over.

## Drag and drop between windows

Chromium does not carry custom drag data across windows, so a drag announces its payload over the
editor's channel and a drop in another window asks for it by token (`public/windows.js`, `drag`).
Dropping a scene node onto the scene tree of another window therefore works. Files dragged from
the desktop are native drags and already cross windows.

## In Electron and in a browser

The desktop shell allows a same-origin `window.open` as a real window
(`server/studio-window.js`), and closes those windows with the one that opened them. In plain
browser mode the same `window.open` opens a normal tab or window; the channel and the merge rules
are identical. Pop-up blocking reports itself in the status bar.

## Testing it

`shared/window-sync.js` is pure, and `test/window-sync.test.js` covers the merge rules, the section
table and the URL forms. The windows themselves are verified through the automation harness: open a
tab in a window, check that the main window marks the tab, that a title change reaches the detached
window and that a terrain generated there appears in the main window when the tab comes home.
