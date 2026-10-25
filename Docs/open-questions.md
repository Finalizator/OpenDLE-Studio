# OpenDLE tasklist — open questions and assumptions

Written while working the tasklist without user input. Each item lists what I
did or assumed, and what to confirm. Reply to any item here (or in chat) and the
assumption will be corrected.

Location history: this started in the Copilot session workspace; it now lives in
the repository at `Docs/open-questions.md` so it is versioned with the code.

## 1. "Nothing is hardcoded except engine tweaks"

Assumption: gameplay behaviour stays in editable events; engine tweaks remain
per-browser editor preferences (FOV, resolution, brightness, mute, jumping,
bunnyhop). Some behaviour is still compiled engine code that events call:
movement integration, collision, hitscan geometry, sector motion, menu
navigation and save serialization. Events choose *when/how much*, code executes
*the primitive*. Questions:

- Should movement integration itself become an event-controlled action (e.g.
  "apply local move with acceleration"), and if so should the starter keep the
  current feel?
- Are browser-only settings acceptable in Engine tweaks, or should they move into
  the exported build's own settings file?

## 2. "Imported maps must be transformed to 3d objects so each point can be movable"

Doom geometry has no per-vertex heights: floors/ceilings are per-sector. I treated
"each point movable vertically" as: every sector floor and ceiling is a draggable
3D surface with a numeric readout, and walls span between them. True per-vertex
slopes (triangulated sloped floors/ceilings, as GZDoom supports) would need a new
geometry model in the renderer and collision mesh.

- Do you want real slopes (UDMF vertex height offsets / slope things), or is
  sector-level vertical editing enough for now?
- If slopes are wanted, should they be a first-class OpenDLE feature rather than a
  faithful Doom import?

## 3. "One click import everything"

Implemented: a **Quick import game** button lists local WAD/PK3/IPK3 files and
imports the chosen one with automatic entry level, standalone/declared base
policy and the decompiled cache. Still required from the user: the files must
already exist under `Projects/`. Questions:

- Should OpenDLE also accept a drag-and-dropped WAD/PK3 onto the window and
  import immediately? (Browser file access exists but the file would not be
  copied into `Projects/` unless we add that.)
- Should a game be importable by Steam/installed-folder path detection, or is
  `Projects/` the accepted workflow?

## 4. Vulkan

Browsers do not expose Vulkan to pages. WebGPU is the only modern path and Chrome
maps it to Vulkan on Linux/Windows, D3D12 on Windows, Metal on macOS. I therefore
did not add a "Vulkan" renderer option; the engine prefers WebGPU and reports the
active backend/adapter. See `Docs/renderer-backends.md`.

- Confirm this is acceptable, or say whether you want the *desktop export* to
  launch Chrome with explicit GPU flags (`--use-angle=vulkan`/`--enable-features=Vulkan`)
  as a best-effort default.

## 5. Multiplayer

Only a plan exists (`Docs/multiplayer-plan.md`): authoritative tick server, input
commands, visual lobby/round rules as editable HUD events. Nothing is
implemented yet, because it changes the runtime contract (determinism, ownership,
interpolation) and would need its own multi-day workstream plus decisions:

- Peer-hosted (one player's browser is the server) or a separate headless
  `server/` process?
- How many players per room (affects interest management and bandwidth)?
- Is PvP combat required at launch, or cooperative campaign first?

## 6. Photocraft

Integration plan only (`Docs/photocraft-integration-plan.md`), since Photocraft is
not in this repository. Needed from you: its URL/protocol, whether it can run as a
separate local web app, and whether edits must round-trip as PNG only or also keep
layers/source files in the project.

## 7. Custom GZDoom script compatibility, enemy and weapon fidelity

Imports still cannot execute ACS/ZScript/DECORATE. Current state: classic/UDMF
geometry, textures/flats/sprites/weapons/sounds, SBARINFO HUDs, MENUDEF menus,
episodes, save/load UI and supported exits are converted; scripted actors,
custom weapon state machines, DECORATE/ZScript health/attack tables and scripted
level exits are not. Raising this needs interpreter-level work (a bounded ACS VM
plus a DECORATE/ZScript actor parser) and is the largest single remaining item.

- Should the next milestone be "ACS subset + DECORATE actor tables" before
  multiplayer, or is gameplay feel already acceptable?

## 8. Performance

The stutter fix rewrites hot renderer paths (asset/clip lookups, per-frame
allocations, redundant material writes). If a stall remains after this, the next
suspects are whole-library `structuredClone(project)` on preview start and
validating every inactive level on every preview start — these are one-off costs,
not per-frame, but feel like stalls on very large games.

## 9. Multi-second stalls (answered, with a caveat)

The reproducible in-game stall was one-time shader compilation when doors/lifts
first revealed upper/lower/middle surfaces (857 ms), now prewarmed to ~12 ms.
Remaining costs are load-time (JSON parse + texture decode + deliberate pipeline
prewarm, 1.5-3 s for a 67 MB campaign) and per-frame HUD DOM writes on very large
layouts. If you still see multi-second stalls *during play*, tell me which map and
whether it happens on the first door/lift, because that would point at a surface
that `surfaceMaterials()` does not enumerate (for example scripted texture swaps).

## 10. Save games

Saves are six browser-local slots (IndexedDB), not GZDoom `.zds`. They restore
level, player, inventory, enemies, pickups, timers, sector motion, spawned objects
and Rapier body transforms. They intentionally do not preserve GPU state, audio
playback position, or menu history.

- Do you want more slots / named saves / export-import of save files?
