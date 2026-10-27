# OpenDLE: Studio — Development Guide

OpenDLE: Studio is an experimental, source-available, browser-native game engine
and visual editor inspired
by GZDoom's moddability, Construct 3's editor workflow and GDevelop's
condition/action scripting.

OpenDLE is the short engine name; OpenDLE: Studio is the product name.
Source inspection, private modifications and voluntary contributions are
permitted under the [custom commercial license](./LICENSE), not an open-source
license. Commercial game royalties and source-redistribution restrictions apply.

**This is a runnable foundation, not a complete Doom II-compatible engine.**
The first-person preview uses a Three.js sector renderer with WebGPU preferred
and WebGL 2 fallback, not
GZDoom or a WebAssembly port. Classic WAD geometry and referenced visual assets
are imported; Doom gameplay compatibility is not. No commercial game data is
included. The local `Projects/freedoom2.wad` is user-supplied and ignored by Git.

## Compatibility target

The product goal is **one-way, full GZDoom game import into OpenDLE**, not just
asset extraction or classic Doom map support. GZDoom-authored games should retain
their behavior and presentation after import while becoming editable and
extendable with OpenDLE's own tools and functionality. OpenDLE-authored changes
do **not** have to export back to GZDoom or remain runnable in GZDoom.

This target includes UDMF maps, resource packages and load order, custom actors,
ZScript/DECORATE/ACS behavior, map specials, audio, and custom HUD definitions,
including SBARINFO and ZScript status bars. Classic status-bar reconstruction is
an initial importer, not the limit of HUD support. Imported HUD behavior must
ultimately be represented by editable layout, animation and scripting rather
than a flattened screenshot or a replacement generic HUD.

**Target is not current capability.** Statements below that a feature is
unsupported describe implementation gaps, not exclusions from product scope.
Full compatibility has not been implemented or verified. Import diagnostics must
continue to identify behavior that cannot yet be reproduced; a partial import
must not be described as a faithful playable conversion.

The chosen implementation direction is **native OpenDLE compatibility**, not an
embedded GZDoom player. Importers and compatible runtime semantics must integrate
with OpenDLE's editable world, HUD and scripting systems. Preserved source data
is provenance, not a substitute for executing or translating its behavior.

## Run locally

On first editor launch, read the complete license and choose **I accept the
license** to continue. Acceptance of the exact document is saved locally in that
browser; clearing browser storage or changing the local license text prompts
again. Declining leaves the editor hidden and attempts to close the tab; if the
browser blocks tab closing, a closed-editor message remains. The shared local
server is not stopped. This browser startup prompt is not the planned online
license-update service, does not collect identity or send an acceptance record,
and does not gate external MCP/API clients.

### Engine version

Edit the root `version.ini` file:

```ini
[engine]
version=0.1.0
```

Use Semantic Versioning, for example `0.2.0` or `0.2.0-beta.1`. Open **Menu → About**
to read the current file; no server restart is required after editing. The health
API and new MCP requests also read the current value. A missing or invalid file
fails startup explicitly and produces an explicit error if changed while running.
This is the engine's displayed version, not the saved-project revision or the
npm package release version in `package.json`.

Requires Node.js 22 or newer and npm.

On Linux/macOS, run the executable [launch.sh](./launch.sh) (choose **Run as
program** in your file manager, or use the terminal). It changes to the engine
directory, installs locked dependencies if `node_modules` is absent, reads
`.env`, starts the local editor/API/MCP service, waits for readiness and opens
the browser. Keep its terminal open; Ctrl+C stops the server it started.

```sh
./launch.sh
# Headless / don't open a browser:
./launch.sh --no-browser
# A different port (also configurable in .env):
PORT=3001 ./launch.sh
```

On Linux, launching again **restarts** the existing OpenDLE server: the launcher
identifies the listening PID and verifies it is Node running this workspace's
server entry point before sending SIGTERM. It waits for shutdown, starts the
updated backend, checks readiness, then opens the exact editor URL in your
system browser. Unrelated listeners are never terminated; ambiguous ownership
or a server that will not stop is an explicit error (no forced kill). Legacy
instances with authenticated health endpoints are supported through the same
process verification. Save/export edits before refreshing after a restart.
Automatic legacy-process restart currently requires Linux; on other platforms
stop the old server manually. Missing Node/npm, startup failure or a failed
browser opener is reported explicitly. Browser-opening failure does not stop a healthy service; its URL
can be opened manually. DeepSeek still requires your `.env` API key; the
launcher does not download game data or enable third-party requests.

If **Local package library** reports a missing `/api/packages` endpoint or an
older backend, save/export your edits, run `./launch.sh` again, and refresh the
editor. Refreshing alone updates browser files but does not reload Node's server
routes. `npm start` alone does not restart an existing process.

The launcher and **Open in system browser** use the same browser helper. Linux
tries `xdg-open`, then `gio open`, then available Brave/Firefox/Chrome/Chromium
commands on failure, always with the full `http://127.0.0.1:PORT/` URL. Browser
commands have a timeout and failures include the URL and desktop-association
guidance. A successful OS launch request cannot prove that a visible tab opened;
check the printed URL if your desktop has a broken default-browser association.

Manual equivalent:

```sh
npm install
npm start
```

Open <http://127.0.0.1:3000>. The server binds only to `127.0.0.1`. No separate
frontend build is needed: the browser runs native JavaScript modules.

```sh
npm run check
npm test
# Optional: checks every map in your local Projects/freedoom2.wad
npm run test:freedoom
```

Most tests use generated map/image data and mocked provider responses. Optional
Freedoom tests run when your local WAD is present and otherwise skip. No API key,
provider credits or network access are required for tests.

## What works

- **Visual scripting scopes:** every behaviour is an editable event. Rules are
  authored in two explicit scopes — **game/engine-wide** rules and **object-local**
  rules (`ownerId` for one instance, `forEachType` for a whole object type) — while
  both execute in one deterministic top-to-bottom order. Object script sheets
  enforce that they only contain object rules. See
  [Docs/visual-scripting.md](Docs/visual-scripting.md) for the model, phases,
  patterns and the complete generated condition/action catalogue.

- **Construct-inspired workspace:** compact neutral-gray panels, Properties
  on the left, Menu and document tabs across the top, a searchable Project
  tree and a single world-layer object list on the right, and a persistent
  Asset Browser below the editing surface. Asset categories, search and an
  Expand/Restore button keep materials available while editing. The UI is an original implementation, not copied
  Construct software, assets or branding. Every panel edge is a draggable
  separator: drag the gutters beside Properties or the Project tree, or the one
  above the Asset Browser, or use the arrow keys on a focused separator
  (Shift for bigger steps). Double-click, Enter or Home restores that panel's
  default size. Sizes live in `opendle-layout` in this browser's storage and are
  clamped so the editor keeps a usable width; they are per browser, not per
  project. Panels dock rather than float: they are not freely rearrangeable
  windows, and additional editable layers are not implemented.
- **World editor:** draw rectangular rooms, place objects, move vertices and
  objects with live visual feedback, edit wall colors/heights/collision, edit
  spawn position/angle, zoom, pan, snap to grid, fit to scene and undo/redo.
- **3D scene editor:** switch between 2D and 3D on the Layout toolbar.
  Fly freely, select rendered objects/walls/sectors or vertex markers, edit
  Properties, drag colored transform handles, place objects and draw rooms.
  Both views edit the same project and share undo/redo and save/export.
  Drag textures or flats from the Asset Browser straight onto wall sides and
  floor/ceiling surfaces, drag sprite or model assets onto objects to assign
  them, and drag objects from the object list onto the floor. Dropping a model
  onto empty space, a wall or a floor places a new **decoration** object that
  already carries it, selected and ready to retype in Properties. Transform handles
  and floors/ceilings follow the pointer while you drag: geometry, the selection
  box and the gizmo update every frame, and the whole drag is a single undo step.
  Floors and ceilings can be raised and lowered in 3D with a live numeric readout
  (undone through the normal edit path), so imported geometry is movable
  vertically as well as horizontally; per-vertex slopes are not implemented. Ceilings are
  visible from below, off-screen selection helpers are culled, and vertex
  markers only appear for the selected vertex or the endpoints of the selected
  wall.
- **Actors (imported game behaviour):** DECORATE and ZScript actor definitions
  from the imported WAD/PK3 chain are compiled into an editable actor table:
  health, speed, damage, pain chance, radius/height/mass, reaction time, flags,
  sounds, drop items and the full state machine (labels, frames, durations,
  fullbright, action functions). When the game folder contains `gzdoom.pk3`, its
  own definitions are used, so vanilla monsters and weapons run their real state
  machines; a plain WAD import falls back to built-in classic Doom actor data.
  The runtime executes those states at Doom's 35 Hz tic rate: `A_Look`,
  `A_Chase`, `A_FaceTarget`, the missile/melee branch selection, the classic
  attack functions, `A_Jump`/`A_JumpIf*`, `A_Pain`/`A_Scream`/`A_NoBlocking`,
  projectiles and the weapon `Ready`/`Fire`/`Flash` cycle with `A_WeaponReady`,
  `A_ReFire`, `A_FireBullets`/`A_FireShotgun`/`A_FireMissile`/`A_FirePlasma`,
  `A_GunFlash` and `A_Light0-2`. Action functions without an engine equivalent
  are collected by name and reported instead of silently ignored.

  Two details decide whether an imported weapon feels like the original. First,
  GZDoom's native weapon action functions start their own `CHAN_WEAPON` sound;
  a DECORATE/ZScript state only names `A_FirePistol`, so the runtime plays the
  matching SNDINFO name (`weapons/pistol`, `weapons/shotgf`, `weapons/sshotf`,
  `weapons/chngun`, `weapons/rocklf`, `weapons/plasmaf`, `weapons/bfgf`,
  `weapons/sawfull`, `*fist`) or the shot would be silent. Second, an actor's
  `Speed` is map units per 35 Hz tic while the runtime moves things per second,
  so a missile multiplies by 35 (an imp ball's `Speed 10` is 350 units/s, a
  rocket's `Speed 20` is 700). Missile artwork comes from the actor too: the
  `Spawn` frames become the in-flight sprite clip and the `Death` frames the
  impact clip, so a mod's fireball looks like the mod drew it instead of
  falling back to a plain sphere.

  Action functions the runtime cannot execute are skipped at the frame that calls
  them, so they are reported instead of silently doing nothing. The import report
  names them (once per game rather than once per level), the Actors tab shows a
  note listing each missing function with the actors that use it, playtest logs
  record every one that actually ran together with those actors, and the read-only
  `actor_unsupported` MCP tool returns the full set. The scan covers the
  actors the level really runs — things placed in the map, the weapon slots and the
  actors their actions name — rather than every actor gzdoom.pk3 describes, which
  would otherwise report Heretic and Hexen weapons a Doom level never uses. Weapon
  states are checked against the weapon state machine rather than the shared action
  table, because the two paths differ: a weapon calling `A_JumpIf` reports a gap
  while a monster calling it does not. The actor
  table is edited in the Actors tab (stats, flags, sounds, state frames in
  DECORATE syntax) and by the `actor_list`, `actor_get`, `actor_unsupported`,
  `actor_update` and `actor_reset` MCP tools. `DoomEdNums` blocks bind editor numbers, and LANGUAGE
  keyword strings (`$TXT_MAP01`, `$GOTSHOTGUN`) resolve through the project
  string table. DEHACKED patches are applied too: `Thing N` (mobjinfo indexes and
  editor numbers), `Misc`, `Ammo`, `Weapon`, `[CODEPTR]`/`Pointer` and the
  classic fullbright frame usage. ACS map scripts run natively (below) and ZScript code beyond
  defaults/state blocks are still not executed.
- **Playtest logs:** playing a map writes its failures to `logs/playtest/`, one
  newline-delimited JSON file per play session, because an error in a playtest is
  gone the moment the tab closes. The browser logger (`public/playtest-log.js`)
  captures uncaught errors and rejected promises, editor operations that throw, ACS
  scripts that stop, line specials the runtime does not perform, action functions
  with no engine equivalent, and audio/renderer failures; the service
  (`server/playtest-logs.js`) appends them with an `index.json` cache for the panel.
  Records carry the level, project, renderer, difficulty and play-time so a single
  line is readable on its own, and a repeating failure is stored once with a repeat
  count instead of once per frame. Frame stalls are logged too: `shared/perf.js`
  keeps session-wide stall and worst-frame totals beside its rolling window, and the
  app writes a `performance` warning naming the stalled frame with the entities,
  projectiles and effects that were live at the time; the stop record summarises
  frames, stalls and the worst frame. A stutter therefore leaves evidence in the
  same file as every other playtest failure. Bounds are enforced on both sides — 400 records
  per request, 240 records per minute, 20,000 records and 4 MiB per session file,
  the 60 most recent sessions — and a session that reaches its limit records that
  fact instead of silently dropping the rest. When the service is unreachable (or
  the game runs as an exported build with no service) records are kept in browser
  storage and retried on the next page load. The Logs tab lists sessions with their
  error and warning counts and shows each record with its details; the
  `playtest_log_list` and `playtest_log_read` MCP tools expose the same data to the
  assistant, so a failure can be diagnosed from the log instead of guessed at.
- **Map scripts (ACS):** a level's compiled `BEHAVIOR` module is parsed and
  executed by a real ACS interpreter, not translated by hand: the script
  directory (`SPTR`/`SNAM`/`SFLG`/`SVCT`), string table (`STRL`/`STRE`, including
  the encrypted form), functions (`FUNC`/`JUMP`) and initial map variables
  (`MINI`) are read, and the p-code table GZDoom uses is implemented for
  stack/arithmetic/logic/variables (script, map, world and global, scalar and
  array), control flow (`goto`/`if`/`case`/`call`/`restart`), `delay`,
  `tagwait`, `scriptwait`, prints and HUD messages, `LSPEC` line-special calls,
  actor queries and mutation, `GetPlayerInput` (Doom button bits), inventory,
  sounds, music, and `ACS_Execute`,
  `ACS_Suspend`, `ACS_Terminate`, `ACS_ExecuteWithResult` and the always/named
  variants. OPEN and ENTER scripts start when the level does; scripts tick at
  35 Hz with per-tic `Delay` and `TagWait` semantics, resuming suspended scripts
  on a second execute exactly like GZDoom. Interpreted state (variables plus each
  script's program counter) is saved and restored with the game, and DECORATE
  `ACS_Execute*` actions in actor states call into the same interpreter. The
  Scripts tab (and the `script_list`, `script_get` and `script_specials` MCP
  tools) shows the script directory and a disassembly of each script, because
  the map ships bytecode rather than source. Unsupported instructions stop the
  script with a named report instead of hanging.
- **ACS libraries (`LOADACS`):** a game's `acs/*.o` modules are loaded in the
  order its `LOADACS` list names them and run alongside the map's own module.
  Each module keeps its own script numbers, string table, functions and map
  variables, so a library's `print(s:"text")` prints the library's string and not
  the map's: `TAGSTRING` interns a module's string into the shared pool with a
  tag, exactly as GZDoom does. Library scripts are addressable as `12`,
  `"name"` or `"library:12"`, their `OPEN`/`ENTER`/`RESPAWN` scripts start with
  the level (Furdoom's double jump lives in `acs/DoubleJump.o`), and a `LOAD`
  chunk's `#include`d function is resolved by name through `FNAM` into the module
  that really defines it, including cross-module calls. Libraries whose `LOADACS`
  dependency is missing behave like GZDoom's: the dependency is reported at import
  and the affected call stops with a named error. `LOADACS` text is also read from
  WAD `LOADACS` lumps with `A_START`/`A_END` modules.
- **Line specials:** Hexen/ZDoom specials on UDMF and Hexen-format lines execute
  through the same table ACS uses (`Door_*`, `Floor_*`, `Ceiling_*`, platforms,
  stairs, `Generic_Door`/`Generic_Lift`, `Teleport`, `Thing_Spawn`/`Projectile`/
  `Damage`/`Remove`/`Activate`, lights, `Sector_SetDamage`, `Player_Set*`,
  exits, and the `ACS_*` entry points), honouring the line's UDMF activation
  flags. Specials the runtime does not perform are reported by number and name
  at import and in the Scripts tab instead of silently doing nothing. Teleport
  destination things (editor number 14) and UDMF thing IDs (`id` → TID) are
  imported so scripts can address things.

  Binary Doom maps are a different language: their lines carry Doom's own
  numbers, where 19 lowers a floor and Hexen's 19 stops a thing. The importer
  names them from Doom's table (`shared/doom-specials.js`), so a report never
  claims a Hexen meaning for a Doom number, and it only calls a special missing
  when the translator that owns that numbering really cannot perform it.
- **Event sheet:** scene-wide and object-attached ordered rules, multiple AND
  or OR conditions, optional NOT on non-triggers, nested sub-events,
  comments, active/collapsible groups, ordered actions, enabled/once flags
  and owner-aware targets. Compact object/condition/action rows open searchable
  command and parameter dialogs instead of showing all controls inline.
  Conditions: scene start, every frame, key-down edge, proximity to an object.
  Actions: message, set/add variables, object-local variables, math/text expressions, teleport the player, destroy an
  object, set an object's position and set its angle. Physics adds contact/
  trigger enter, exit and overlap, player grounded, impulse, force and velocity.
  Models add animation-finished conditions and play/stop clip actions.
- **Editable Engine defaults:** fresh projects have an Engine branch in the
  Project tree with Input, Player, Combat, Weapons, Enemies, Pickups, World and
  HUD sub-event sheets. See the scope and execution details below; these are
  an FPS scripting foundation, **not complete Doom gameplay**.
- **Environment:** editable sky/floor colors, typed global variables and GLSL effects.
- **HUD designer:** independent responsive overlay layouts, drag/resize editing,
  anchors/pivots, parent panels, layers, nine-patch images, sprite frames,
  web/grid-bitmap fonts, scoped CSS, keyframed animation and clickable visual scripts.
  The default original FPS status bar shows real health, armor, ammo and messages,
  with a crosshair, scripted shot/damage feedback and a cursor-mode Resume control.
- **Assets & sectors:** import PNG/JPEG/WebP images, browse decoded WAD textures,
  flats, skies, object sprites and weapon images; select sectors and edit their
  floor/ceiling heights, surface materials, light level and sky flag.
- **Play preview:** click the view to capture the mouse for horizontal/vertical
  mouse-look (pitch limited to +/-85 degrees). Escape releases the cursor;
  Escape again opens the pause menu; Stop exits preview. **Capture mouse** also explicitly requests
  capture and the status inside the preview explains success or denial.
  If an embedded browser refuses pointer lock, **Open in system browser**
  opens the local editor in your desktop browser (asks to save unsaved edits
  first); click Play and Capture mouse there. This does not bypass browser
  security or grant permissions automatically. With capture unavailable,
  right-drag looks in event-driven projects; legacy projects use left-drag.
  WASD movement, arrow-key turning, wall collision, colored
  or textured sector geometry, floors/ceilings, two-sided openings, masked
  midtextures, animated billboard sprites, weapon overlay, sector light
  and up to 16 colored point lights without shadows. Movement checks 56-unit
  headroom and at most 24-unit upward steps. Preview state resets each session.
- **Rapier 3D:** fixed-step sector collision, a gravity-driven capsule player
  (Space jumps), and opt-in fixed, dynamic or kinematic object bodies with
  box/ball/capsule colliders, sensors, mass, friction, restitution and rotation
  locking. Scripts synchronize teleports, rotation and object destruction.
- **Blockbench models:** import `.bbmodel` projects (cubes, groups with pivots,
  per-face atlas and box UVs, embedded textures, baked animation clips) or
  uncompressed GLB/glTF 2.0 with meshes, UVs, PNG/JPEG/WebP textures, PBR
  materials, node hierarchy, skins, morph targets and exported animation clips.
  Import by file picker, folder or drag & drop onto the asset browser. Instances
  have independent skeletons/mixers.
- **Projects:** validated JSON import/export, explicit local-server saves,
  browser draft backups, revision conflict detection and explicit draft restore.
- **WAD import:** map selection, bounded parsing of little-endian classic Doom
  records, `PLAYPAL` palettes, `PNAMES` and composed `TEXTURE1/2` wall textures,
  64x64 flats and column/post sprite/weapon decoding, including transparency.
  Images used by the map, its selected sky, representative weapon frames and
  classic status-bar artwork are imported, not the entire WAD asset library.
  WAD status bars become editable layouts with raster digits, animated face
  frames and actual inventory bindings, alongside editable pickup/input scripts.
- **DeepSeek:** server-side function-calling loop with shared validated tools,
  bounded requests, explanatory drafts and explicit approval. An AI request saves
  the current project locally first. Applying a draft is undoable and remains
  unsaved until you save it.
- **MCP:** authenticated Streamable HTTP tools and an active-project resource,
  tested using the official SDK client.

### HUD overlays

Open **HUD** in the document tabs or **HUD overlays / Game HUD** in Project.
Fresh projects include an original Doom-inspired status bar, not commercial Doom
artwork. New WAD imports reconstruct the WAD's classic status bar automatically.
Existing saved projects remain unchanged: reimport their WAD to obtain its
status bar (save/export edits first), or choose **Install editable game HUD**
for the generic overlay. HUDs share project save/export, draft backup,
undo/redo and approved AI/MCP edits. They composite above the WebGL scene and its
weapon overlay; they are not text below the game canvas.

- Add **text, panel, image, bar or button** elements. Select in the element list
  or canvas; drag to move and use the cyan corner to resize. Properties expose
  exact position, size, rotation, scale, opacity, z-order, visibility, colors and
  text alignment. Edit transformed elements numerically; direct drag/resize
  currently requires unrotated, unit-scale elements and parents.
- **Anchors** are normalized left/top/right/bottom fractions of the screen or
  parent panel. Equal pairs pin an element; different pairs stretch it. Position
  is an offset from the first anchor, and size is added to the anchor span
  (negative stretch sizes provide margins). Pivot fractions position the box
  relative to that anchor and define the rotation/scale origin. Parents must
  precede their children. Layer order is local to each parent.
- The layout has a virtual **design resolution**. **Fit** scales uniformly and
  extends the logical viewport on wider/taller screens, so anchors stay at screen
  edges; **Stretch** scales X/Y independently. **Integer** chooses whole pixel-art
  scale factors when space permits, with fractional downscaling on small screens.
  Preview 16:9, 4:3, portrait or ultrawide in the designer.
- Assign an image from the Asset Browser, or **Import Canva / image** using
  PNG/JPG/WebP exports (at most 2048 x 2048). Transparency is preserved after PNG
  normalization. Canva artwork is imported as a **flattened image**, not a native
  Canva document or recovered editable layers. SVG, PDF, arbitrary HTML and
  proprietary Canva project imports are not supported.
- Enable **Nine-patch** on an image and set four source-pixel borders: corners
  remain fixed while edges and center stretch. Alternatively use **Sprite
  frames**, specify a regular columns/rows grid and animate the frame property
  with step interpolation. Nine-patch and sprite mode are mutually exclusive.
- **Import web font** embeds WOFF/WOFF2/TTF/OTF (up to 4 MiB before base64).
  **Bitmap font** registers an existing image atlas using fixed cell dimensions,
  columns and explicit character order. Raster glyphs retain atlas colors;
  missing characters occupy blank cells. Imported fonts and metadata can be
  edited/deleted under **Fonts**; referenced fonts cannot be removed. Use only
  fonts/artwork you have permission to embed. External font URLs are not loaded.
- **Import .css** merges named visual classes; **Edit CSS** replaces the authored
  class collection. Assign a **CSS class** to an element. Only `.class { ... }`
  rules are supported, with colors, borders, radius, shadows, padding,
  letter-spacing, line-height, font weight/style, text transform/decoration and
  outlines. Page selectors, pseudo-selectors, `@rules`, URLs, variables and layout
  overrides are rejected. Geometry/font size remain explicit HUD properties.
  CSS is stored as scoped declarations, never injected as a page stylesheet.
- **Animation timeline** creates named clips with duration, loop/autoplay,
  target/property tracks, editable time/value keys and linear/ease-in-out/step
  interpolation. Preview/reset without running gameplay. Animate position, size,
  opacity, scale, rotation, bar value, font size or sprite frame. Playback applies
  the first pose immediately, holds the final pose, and fires a completion
  trigger once for a non-looping clip. Stop holds the current pose; replay
  restarts. If clips target the same property, the most recently started active
  clip is applied last. Image tiling, skeletal UI animation and rich-text/font
  shaping for bitmap atlases are not implemented.

**Bindings and visual scripts:** text accepts `{health}`, `{armor}`, `{bullets}`,
`{message}` and `{var:score}` (replace `score` with an existing variable). The
Binding property can bind a whole text/bar directly to one engine value; bars
also expose a maximum. These display real runtime values, reset with each Play.
Additional bindings include `shells`, `rockets`, `cells`, `maxBullets`,
`maxShells`, `maxRockets`, `maxCells`, `ammo` (selected weapon ammo; empty for
melee), `weapon:shotgun`, `slot:3`, `key:blueCard` and `backpack`.
**Visibility binding** shows an element when a numeric/ownership binding is
nonzero; inversion shows its unowned counterpart. **Maximum text characters**
keeps the last N characters for classic three-digit fields.

Choose **Open / attach visual script** on an element, or **HUD scripts** to edit
the ordinary HUD event sheet. Conditions include `hudClicked(elementId)`,
`hudAnimationFinished(animationId)` and
`hudStatChanged(stat,direction:decreased|increased|changed)`. Stat-change rules
observe the net difference since that rule last evaluated, including changes
later in the preceding tick; disabled/skipped rules catch up on their next
evaluation. Actions include `setHUDVisible(elementId,visible)`,
`setHUDText(elementId,text)` (clears direct binding),
`setHUDBinding(elementId,binding)` (empty binding restores authored text/value),
`setHUDProperty(elementId,property,value)`,
`playHUDAnimation(animationId)`, `stopHUDAnimation(animationId)` and
`setHUDCursor(mode:cursor|game|toggle)`. `showPlayerHUD` controls overlay visibility.
All element/clip/font/asset/variable references and property limits are validated.
Bindings take precedence over authored text/bar values until cleared.
Remove referencing rules/tracks before deleting their targets.

**Play input:** press **Tab** (editable default HUD rule) or **HUD cursor / Tab**
to release mouse capture and interact with clickable HUD elements. Resume/Tab
returns to gameplay; capture requires another user click. Cursor mode suppresses
player keyboard/mouse bindings and movement but **does not pause simulation**.
HUD clicks do not fire weapons. Click and animation-completion triggers last one
simulation update. The editor and Play use the same overlay renderer.

MCP and DeepSeek share `hud_install_default`, `hud_set_layout`,
`hud_element_add`, `hud_element_update`, `hud_animation_set` and `hud_import_css`,
plus the usual validated event-sheet/rule tools. HUD font records, CSS classes,
bindings and animation tracks are portable JSON in `project.hud`; embedded font
files join images/models in `project.assets`. No JavaScript is stored in HUDs.

### World workflow

1. Open the editor and click **Play world** to try the starter scene. Walk to the
   energy cell to run the proximity event, remove the cell and increment `score`.
2. Stop preview, choose **Draw room**, then drag a rectangle of at least 32 units
   on each side. Rooms are independent closed rectangles: this is not a CSG or
   sector-joining editor.
3. Select a wall to adjust collision, sidedef upper/middle/lower materials and
   texture offsets. Imported walls use their sector heights; the legacy Height
   field only controls walls without sidedefs. Drag endpoints to reshape the
   layout. Rooms are not automatically merged into portals.
4. Place an object and select it to edit its Properties. Double-click it in the
   layout, right-hand world-layer object list or Project objects list, or click **Edit object script**,
   to open its attached visual script. Add conditions and actions using dropdowns
   and fields. The Project tree lists each object's script and event count.
5. **Save** persists to `data/project.json`. **Export project** downloads a
   portable JSON document. Browser drafts are separate; **Restore local draft**
   explicitly restores the most recently edited draft on this origin.

File operations, **Import WAD + assets**, **Local WAD library** and draft
restore/reload are in the top **Menu**. WAD import shows progress and errors
inside its dialog. Network/format failures leave the current project unchanged;
retry remains available. Cancel/Escape aborts the browser request and discards
late results (server-side decoding may finish independently). Requests time out
after 90 seconds. Successful imports show expandable notes below the layout.
The imported project remains unsaved until Save.

If an old tab cannot import and reports a connection failure, run `npm start`
and use the URL printed by that process (normally <http://127.0.0.1:3000>).
Temporary validation servers, such as port 3029, are not the normal editor
service; an already-open page can remain visible even after its server stops.

Rule ordering matters. “Every frame” is frame-based, not a fixed-rate simulation.
“Once” applies per rule per play session. E, F, Q and Space are available as event
keys. Teleport places the player at the authored position without testing
collision, so choose a point inside a playable area.

### Editing in 3D

Click **3D** above the Layout; **2D** returns to the top-down map. This is an
editing view, not Play: scripts, gravity and animation playback do not run,
and no weapon overlay is shown. The player start is visible as an editable
marker. Physics bodies stay at their authored positions while editing.

- **Hold right mouse** and move the mouse to look. While held, **WASD** flies,
  **Q/E** moves down/up, **Shift** multiplies speed by four, and the **wheel**
  adjusts flight speed. Release right mouse to edit. **Fit world** resets the
  camera to an overview; camera position is preserved across project edits.
- **Select / move:** left-click an object, wall, floor/ceiling surface or
  yellow vertex marker. Properties edits update the scene. Double-click an
  object to open its visual script; Delete removes a selected non-player
  object subject to the same reference checks as 2D.
- **Move:** drag a colored axis (red = map X, blue = map Y, green = vertical Z).
  Objects can move in three axes; vertices and wall endpoint pairs move
  horizontally. Choose **Sector handle: Floor / Ceiling** to raise or lower
  that sector surface with the vertical handle. Handles stay visible through
  geometry. Moving an object horizontally preserves its absolute height across
  sectors by updating floor-relative elevation.
- **Rotate object / Scale visual:** select an object, choose a transform,
  then drag an axis handle. Rotation changes the existing yaw angle; scaling
  is uniform and changes sprite/model visual scale, not physics colliders.
  The player has a fixed size. Geometry uses Move; other properties remain
  available in Properties.
- **Place entity:** choose its type and click a visible surface or the ground
  plane. Positions/elevation snap to the selected grid. **Draw room:** drag
  a rectangle on a horizontal plane; the outline previews the rectangle.
  Like 2D, new rooms use floor 0 / ceiling 128 and remain separate sectors.
- **Show ceilings** defaults off so interiors remain accessible from above;
  toggle it for the complete enclosed scene. Ceiling height handles work even
  while ceilings are hidden. Escape, blur or cancelled gestures discard an
  uncommitted transform. Each completed drag is one undoable edit.
- **Show areas** draws every object's interaction area as an amber wireframe
  box, sphere or capsule, and **Show physics** draws physics colliders in cyan,
  with the player capsule in yellow as the volume events have to catch. Both are view-only overlays: they are
  drawn in a separate group, stay visible through geometry, are never exported
  and never affect selection or the playtest.

This retains the sector map's editing model: planar walls, horizontal floors
and ceilings, object yaw and uniform visual scaling. It is not a general
mesh modeller, sloped-sector editor or rig/animation authoring tool. A completed
edit reloads the scene's resources; large asset-heavy maps may briefly display
a loading overlay. Draft project validation errors are reported without
committing malformed geometry.

### Editable Engine event sheets

**New project** and a fresh server store include editable Engine sheets.
Existing saved projects, including previously imported WADs, are **not silently migrated**:
click **Engine → Install editable FPS starter** to opt in, with undo support.
It preserves authored rules and rejects reinstalling over edited Engine
defaults. Newly imported WADs now include Engine scripts, their reconstructed
status bar, inventory/pickup rules and weapon-selection bindings automatically.
This is still not a complete Doom gameplay conversion. No existing saved project
is changed on startup.

The Engine section contains ordinary persisted JSON rules using the same
condition/action editor as object scripts. There is no hidden `runDoomGame`
command. You can rename sheets/rules, change parameters, add/remove/reorder
rules, disable a whole sheet, and create Game or Engine sheets with **+ Sheet**.
Each rule can be assigned to a sheet and an object, or run **For each**
enemy/pickup/decoration with `$self` referring to that instance.

Sheets are organizational views of one ordered rule list, not implicit
include graphs. Enabled **beforePhysics** rules execute in list order,
movement/physics runs, then **afterPhysics** rules execute in list order.
Unfiled legacy events execute after physics. `onStart` is true in both phases
on the first simulation update. Once flags and named simulation-time timers
are scoped per owner/for-each instance; unowned rules share scene timers.
Disabled sheets do not execute. Conditions evaluate when each row is reached;
later rows see earlier changes. A deleted owner cannot run later rules.

#### Construct-style sheet workflow

The event editor is an original implementation informed by the official
[Event Sheet View](https://www.construct.net/en/make-games/manuals/construct-3/interface/event-sheet-view),
[Add condition/action dialog](https://www.construct.net/en/make-games/manuals/construct-3/interface/dialogs/add-condition-action),
[Groups](https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/events/groups)
and [Sub-events](https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/events/sub-events)
manual pages. No Construct code, icons or proprietary project format is used.

- Read conditions on the left and ordered actions on the right. Each compact
  row identifies its system category or referenced object. Click to select;
  **double-click or Enter** opens a parameter dialog. Changes apply together
  with **Done**; Cancel/Escape leaves the command unchanged.
- **Add event / Add condition / Add action** uses a three-step dialog:
  category, searchable command list, parameters. Only implemented OpenDLE
  commands are offered, not nonfunctional copies of Construct commands.
- Open the **numbered margin** for event options: name, sheet, group,
  object/for-each context, comment, AND/OR mode, enabled/once, branch movement,
  deletion and **Add sub-event**. Comments display above the event.
  Action dialogs also allow deletion and up/down ordering.
- **+ Group** creates an active group in the current sheet. Edit its name and
  description, assign events through their margin, collapse with its title,
  or toggle Active. Collapse is editor-only. `groupActive` and `setGroupActive`
  expose runtime activity to visual rules; each Play resets authored defaults.
  Deleting a group keeps its events; references must first be removed.
- **Sub-events** are indented and run immediately after matching parent
  actions, before the next sibling. They do not run if the parent is false,
  disabled, already consumed by Once, or its owner was removed. Nested
  for-each events inherit the matching parent instance. A branch shares its
  sheet, group and object context; incompatible changes are rejected.
  Empty action lists are allowed for filtering parents. Nesting is limited
  to 16 levels. Moving/deleting a branch includes all descendants.
- **AND** remains the legacy default. **OR** accepts any matching condition;
  non-trigger conditions can be inverted in their parameter dialog and display
  NOT. Edge triggers such as On start, On key pressed and contact-enter cannot
  be inverted. Existing ungrouped, unnested projects preserve their behavior.

This is not full Construct event-system compatibility: no general object
selection-list propagation, Else blocks, include graphs, expression parser,
functions/local variables, multi-selection/copy-paste, or drag-and-drop
reordering yet. The supported nested object context is explicit owner/for-each,
not Construct's full instance-picking algorithm. Groups are displayed in
execution order; disjoint runs of the same group show repeated headers rather
than silently reordering rules.

The `playerControl: "events"` project setting disables native WASD/arrow/Space
and direct mouse-look handling; before-physics event actions supply them.
Disabling Input really disables authored controls rather than falling back
to hardcoded movement. Legacy projects retain their existing controls.
Rendering, ray intersections, Rapier collision/gravity and event execution
remain native engine primitives.

**Implemented starter and commands**

- **Input:** editable held-key/mouse conditions, local forward/strafe speed,
  turn speed, mouse sensitivity and vertical-look toggle. In Play, left
  mouse fires; click to request mouse capture, or **right-drag** to look in
  browsers without capture. WASD/arrows are ordinary editable rows.
  Space requests a grounded jump through an editable `jumpPlayer` row;
  The editor's **Engine tweaks / Enable jumping** gates it and defaults to enabled.
- **Player:** initial health 100, armor 0, armor divisor 3 and bullets 50 are
  visible initialization actions. Compare/set/add capped player stats and
  compare project variables. Damage absorbs `floor(damage / armorDivisor)`
  armor points, limited by remaining armor; the rest reduces health.
  Divisor 3 represents green armor, 2 blue armor. Pickup rules can change it.
- **Weapons (starter projects only):** nine firing rules check selected/owned weapon, held left mouse,
  positive health, sufficient ammo and a shared refire timer. Fist/chainsaw use
  short-range traces; pistol/chaingun trace bullets; shotguns fire 7/20 pellets.
  Launcher/plasma/BFG spawn visible, swept-collision projectiles. Super shotgun
  requires two shells; BFG requires 40 cells. Rocket/BFG impacts apply
  distance-based, wall-occluded splash, including self-damage. On this scripted
  path the BFG splash is an approximation. Every imported project — including a
  plain WAD — now has an actor table with the classic weapons in it, so these
  rules only appear in the untouched starter template; see *Classic weapons for a
  plain WAD* below. Costs, damage dice, pellets, spread,
  range, projectile speed/radius, sound and timing are separate editable actions.
  Number keys 1-9 select owned weapons; switching cannot bypass refire time.
- **Combat:** editable for-each enemy death/removal and player-death message.
  Imported enemy health is initialized by editable archetype rules in Player,
  unless explicit instance health was authored in Properties. Hitscan uses
  player yaw/pitch, nearest live enemies and map wall/floor/ceiling occlusion;
  each enemy currently uses a 20-radius, 56-high hit cylinder. It ignores
  model meshes and non-enemy rigid-body prop occlusion.
- **Pickup reach:** a pickup is collected when the player overlaps it: 36 units per
  axis (Doom's own touch radius), up to 112 units above the player's floor and 32
  below, and — for anything raised more than a step — without tracing a line
  through the wall around a shelf or ledge. That last part matters: a chainsaw on
  a ledge is enclosed by solid walls, so the previous "nearest 36 units and no wall
  in between" rule could never take it from the floor below. Projects imported
  before this carry the old values in their generated rules; `upgradePickupReach`
  widens only the untouched generated numbers (36/56/8) when a project is loaded,
  leaving hand-edited rules alone, and the reach stays editable in Engine →
  Pickups (`playerReachesEntity`, with `reachOverSteps`).
- **Pickups / World:** fresh starter projects organize the original
  object-owned score pickup and welcome event into these sheets. Legacy
  opt-in leaves authored sheet associations intact.
- **Enemies:** imported archetypes receive editable health, visibility/range,
  target memory maintained by an editable renewal rule, collision-aware eight-way chase,
  hitscan/melee or projectile attacks and independent per-instance cooldowns.
  Idle guards use a 180-degree forward view (except at melee distance); damage
  alerts them, and alerted guards can track visible players in any direction.
  Weapon fire wakes rear-facing guards through connected open sectors. Closed
  doors stop noise, one sound-block linedef is crossed but two stop propagation;
  ambush-flagged monsters require line of sight. The `hear_weapon` and
  `remember_target` rules can be disabled or edited independently.
  Chase uses persistent compass directions and obstacle detours; actor facing
  follows actual movement, while `facePlayer` turns toward the player for attacks.
  Imported speeds and walking-frame durations follow classic actor chase cadence
  (for example, the zombie's 8 units per 4 tics becomes 70 units/second).
  Closed doors block sight. Attack decisions use a Doom-style distance/random
  check, evaluated every 8 tics rather than every rendered frame.
  Separate decision, wind-up and fire sub-events expose reaction delay,
  attack-pose movement pauses and recovery timers. Cover reached during wind-up
  prevents a hitscan hit or missile launch. Hitscan attacks trace real scattered
  rays (triangular spread up to 22.5 degrees); shotgun guards fire three pellets.
  Spread/pellets, timing and range are editable; old authored `enemyHitscan`
  commands without spread/pellets preserve zero-spread, one-pellet behavior.
  `timerExists`/`clearTimer` implement per-instance pending wind-ups; timerReady
  alone still treats an absent timer as ready.
  A generic profile supports newly placed enemies.
  This is not exact Doom state graphs: movement turn cadence, exact sound-target timing,
  infighting, continuous chaingunner bursts, flying/charging monsters, pain
  interruption/chance, resurrection, lost-soul spawning and arch-vile specials remain.
- **Audio:** `playSound(sound,volume)` refers to an embedded sound by name.
  WAD DMX PCM effects become portable WAV assets; package WAV/OGG/MP3 and DMX
  files import by basename. Custom SNDINFO aliases/random/channel rules are
  reported but not translated yet. Missing standard effects use clearly labeled
  generated OpenDLE sounds, never bundled commercial audio. Import WAV/OGG/MP3
  through **Import sounds**; matching names replace effects without changing rules.
  Assets have audition controls. Play initializes Web Audio from the user gesture,
  attenuates object sounds by distance, limits overlapping voices and stops them
  on Stop. Decode/playback failures appear in editor status.
- **HUD:** an editable action enables the separate HUD layout. WAD imports use
  reconstructed classic artwork and live inventory/face bindings.
  Imported pickup rules use `playerReachesEntity`: 36-unit horizontal axis
  overlap (player plus item radius), with the item between 8 units below the
  player's feet and 56 units above. This reaches bonuses on low shelves without
  jumping, while rejecting items on other storeys or behind blocking walls.
  Distance and vertical limits remain editable; generic `nearEntity` rules
  retain their existing center-distance behavior.
- **World:** classic binary linedef specials/tags are preserved. Imported
  Engine/World rules explicitly connect use/cross/shoot triggers to concrete
  sector-height actions. **E** uses the nearest wall within64 map units;
  manual colored doors accept the matching card or skull key. Supported classic
  door, lift and floor specials become `moveSector` actions with editable
  floor/ceiling, target height, speed, wait and stay/return/cycle mode.
  Teleports (`39`, `97`), blazing key doors (`99`, `133`-`137`), crush ceilings
  (`6`, `25`, `44`, `49`, `72`, `73`, `77`, `141`), stairs (`7`, `8`, `100`,
  `127`) and the raise-to-neighbour / raise-by-value floors (`14`, `20`, `22`,
  `40`, `68`, `140`) are translated too; a teleport's landing position and
  facing come from the tagged sector's destination marker and are baked into the
  rule because that geometry never moves. Monster-only teleports (`125`, `126`),
  texture scrolling (`48`, `85`), donuts and Boom's generalized numbers still
  report by name, since they need thing-crossing, surface UV animation or a Boom
  interpreter rather than a rule. Optional
  `returnHeight` sets a distinct upper endpoint for perpetual platforms instead
  of returning to their initial height. Closing
  doors reverse on occupants; raising floors stop rather than crush. Platforms
  carry grounded players and objects. Changed surfaces and adjoining walls update
  in the renderer and Rapier collision, without changing the authored project.
  Other specials are reported by number; stairs, crushers, exits/level changes,
  teleports and generalized Boom/ZDoom actions are not translated yet. UDMF action
  numbers/arguments are preserved but not misinterpreted as classic Doom numbers.
- **Sprite animation:** imported patches become portable `spriteClips`
  (`frames`, seconds per frame, loop). Object Properties assigns stand/walk/
  attack/pain/death states. Engine actions set states and play weapon clips;
  missiles reference flight and impact clips, with spheres only when art is
  unavailable. Dead imported enemies play their death frames and retain a
  corpse, rather than disappearing. Classic monster death clips stop at their
  own normal corpse frame, excluding separate gib and resurrection sequences.
  The Assets animation section edits frame
  order, timing and loops. Classic animated surface ranges and Boom ANIMATED
  records create material clips for referenced liquids/walls. Doom's eight
  camera-relative rotations are imported for each animation frame, including
  mirrored dual-name patches such as A2A8; rotation-zero frames remain
  omnidirectional. Directional image assets retain an editable JSON `rotations`
  array of eight `{assetId, flip}` views through save/export and MCP.
  This is not arbitrary DECORATE/ZScript actor-state translation.
- Shared schema/default metadata drives editor command fields and validation.
  MCP/DeepSeek can install the starter, add/update sheets, add/update rules
  and replace projects, using the same validation and portable JSON.

### Object-local variables and event expressions

Object Properties has **Object-local variables**; Environment has **Global
variables**. Both accept numbers, text and booleans. Each object owns an
independent `variables` record, cloned on Play; runtime changes never modify
the authored initial values. Names and types are stable during Play.
`setObjectVariable`, `addObjectVariable` and `objectVariableCompare` target
an instance or `$self` in object-owned/for-each rules. Sub-events inherit that
owner. Existing `setVariable`/`addVariable`/`variableCompare` operate on globals;
addition requires numeric variables.

In numeric/free-text event parameters, prefix an expression with `=`:

```text
=local("speed") * dt
=clamp(player("health"), 0, 100)
="Hello " & upper(local("title")) & " / " & str(global("score"))
=distance(property("$self","x"), property("$self","y"), property("player","x"), property("player","y"))
```

Replace `"player"` in the last example with the actual player object's ID.
Expressions are stored as `{ "expr": "local(\"speed\") * dt" }`, not executable
JavaScript. Literal strings are unchanged unless explicitly marked as expressions.
Resource IDs, variable names, enum choices and bindings remain literal references.
Conditions can use **Compare math / text expressions** (`expressionCompare`).
Imported enemy distance/random attack decisions are explicit expressions in
Engine/Enemies rather than an opaque default AI command.

- References: `global("name")`, `local("name")` (event owner),
  `object("id","variable")`, `property("id","x")` (also `$self`),
  `player("health")` and other player stats, `time`, `dt`, `pi`, `e`,
  `true`, `false`. Object properties include x/y/z, angle (degrees), health,
  elevation, name, type and doomType.
- Math: `abs`, `min`, `max`, `clamp`, `lerp`, `floor`, `ceil`, `round`,
  `sqrt`, `pow`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`,
  `sign`, `log`, `exp`, `radians`, `degrees`, `distance(x1,y1,x2,y2)`,
  `random(min,max)`. Trigonometry uses radians; random uses seeded simulation
  state, not wall-clock randomness.
- Text: `str`, `number`, `concat`, `upper`, `lower`, `trim`, `len`,
  `left(text,count)`, `right(text,count)`, `mid(text,start,count?)`,
  `replace(text,from,to)`, `contains`, `find`. Indexes start at zero;
  `find` returns -1 when absent. `&` concatenates scalar values as text;
  `+` is numeric addition.
- Operators: `+ - * / % ^`, `== != < <= > >=`, `&& || !`, parentheses
  and `condition ? yes : no`. Boolean operators and conditional branches
  short-circuit. Comparisons require matching types.
- Expressions are bounded to 2048 source characters, 32 nesting levels and
  256 parsed operations; results are finite numbers within +/-1e12, text
  up to 4096 characters or booleans. Event fields impose their own tighter
  numeric/text limits. Missing references are rejected on validation;
  invalid evaluated values (division by zero, wrong type, out-of-range result)
  stop Play with the offending rule/field in the error.

MCP `variables_set` replaces a complete initial variable record (omit entityId
for globals). Existing event tools accept expression objects in the same
parameters as the editor. Save/export retains variables and expression source.

### Reloading and server restarts

Save persists the complete project, including Engine rules, to the local server;
opening the editor in another browser uses that saved project, not another
browser's unsaved draft. At startup, a differing browser draft based on the
current server revision is restored as unsaved work. Older/unversioned or
conflicting drafts prompt before replacement. Invalid drafts produce a warning
and remain in storage. Explicit Reload still asks before discarding unsaved work.

The editor refreshes its local session token once after a server restart before
retrying an unauthorized request, so Save does not remain broken in an existing
tab. Revision conflicts remain explicit and are never automatically overwritten.
Geometry-only Doom imports with no event rules require confirmation before Play,
instead of appearing to be a functioning gameplay import.

### Play game, imported menus and user settings

#### Full-game import and levels

The WAD/PK3 import dialogs and HTTP import endpoints now default to **Full game**,
not a single-map extraction. The map choice selects the starting level. Use
**Selected level only** (`scope:"level"` for JSON requests or `scope=level` for
uploads) when intentionally extracting one map. Image-only package extraction
is unchanged. The low-level `importWadMap` and explicit-map `importWad` helpers
remain single-map APIs; `importWad` without a map imports the full WAD.

A portable `project.game` stores entry/active level IDs, level names, normal and
secret exit destinations, and native per-level data. Assets are shared and
deduplicated; colliding generated atlases receive distinct IDs and their
references are remapped. All maps keep their editable geometry, environment,
variables, visual scripts, HUD/menu layouts, animation clips and provenance.
The root project is authoritative for the currently edited level; switching
levels stores those edits before restoring another level. Inactive snapshots
are validated, not treated as opaque unchecked blobs. Save/export includes all
levels. Full-game exports use compact JSON to stay within the 128 MiB file limit.
Large games may exceed browser localStorage draft capacity: the editor reports
backup failures explicitly; save to the local server or export instead.

**Editing level** selects an editable map. The adjoining controls configure
the new-game entry and normal/secret exit destinations. **Play level** tests the
edited map; **Play game** opens the campaign entry. The preview toolbar's **Level**
selector starts any imported level with fresh inventory without changing the
editor selection or original game artwork. New game resets to the configured
entry unless the imported game's episode menu selects another start map.
MCP exposes `game_level_select` and `game_level_set_routes`; visual scripts
can use `loadGameLevel(levelId)` or `finishLevel(exit:normal|secret)`.

Original episode selection is translated into native editable HUD elements and
interface event rules, not added as an engine overlay. MAPINFO/ZMAPINFO episode
blocks (including bounded includes, `clearepisodes`, removal, name, patch and
`noskillmenu`) populate the imported MENUDEF EpisodeMenu at its authored
position, font and line spacing. SkillMenu's engine-populated difficulty rows
are also converted; previously an otherwise empty MENUDEF template lost these
rows. Classic Doom uses its available episode start maps and M_EPI artwork;
Doom II does not acquire an invented level menu. A single episode normally
skips selection. MENUDEF commands consisting only of `map LEVEL` become native
`loadGameLevel` actions when that level is available; arbitrary console commands
are not executed. Original episode source text is retained under
`gameMenus.episodeSources`. Custom scripted menu classes and arbitrary
script-generated level lists still require translation.

Classic Doom exit specials 11/51 (use), 52/124 (cross) and 197/198 (shoot), plus
UDMF Exit_Normal/Exit_Secret (243/244) with explicit supported player activation
flags, compile into editable `finishLevel` rules. Transitions follow standard
Doom/Doom II normal/secret destinations or supported MAPINFO `next`/`secretnext`
fields; end-game destinations end the campaign. Health, armor, ammo and weapon
inventory carry across exits; keys and per-map world state reset. Generated
initial-player-stat rules use `levelTransition` so they do not erase carried
progress. Manual level selection starts fresh. Arbitrary scripted transitions,
hub persistence, old unbraced MAPINFO syntax and dependency loading remain
unsupported.

Finishing a level opens an editable native intermission before loading the next
map. Its HUD elements, bindings and interface events are available in the HUD
designer's **intermission** screen and **Level intermission** event sheet.
Original INTERPIC/WIMAP backgrounds, level-title and WI label artwork are used
when available; otherwise native text is used. Crowded imported HUDs use a
compact six-element layout. The editable HUD budget is 512 elements, shared by
gameplay, original menus, save/load slots and intermissions. Kills,
countable items, discovered secret sectors and elapsed time are collected from
the current runtime, not invented percentages. Continue (click, Enter or Space)
follows the configured normal/secret route and carries progress; final exits
show the results before completing the campaign. GZDoom custom intermission
scripts, multiplayer tallies and animated episode travel routes are not
translated yet. Existing projects need a full reimport (or a deliberate menu
rebuild) to install the new editable menu/intermission elements; restarting the
service alone does not rewrite saved projects.

For PK3 `maps/*.wad`, filenames define logical level names even when internal
markers duplicate or differ (as in the supplied Furdoom). A custom named
campaign imports its own maps plus explicitly referenced base destinations,
not an unrelated base campaign. Classic MAPxx/ExMy replacement packages retain
the base maps they do not replace; mapless resource mods use the base campaign.
No maps are silently discarded for unsupported formats: a full-game import
fails without replacing the current project. Limits remain 128 levels, 3000
shared assets, existing asset budgets and 128 MiB portable JSON. Full imports
can take substantially longer than one-map imports; dialogs allow five minutes.

#### Decompiled import cache

An import already produces the complete native project — decoded PNG images,
visual scripts, HUD and menus — so repeating that conversion for the same source
is wasted work. `server/import-cache.js` stores the finished import result under
`data/import-cache/<key>.json` and serves it on the next request:

- the key covers the source (SHA-256 of a WAD/archive, or a size+mtimestamp
  signature for unpacked package folders), map/scope/base options, and an
  engine fingerprint built from the importer source files plus `version.ini`, so
  upgrading engine code automatically invalidates stale entries;
- hits skip package reading and conversion entirely and answer immediately;
- entries are bounded (16 files / 384 MiB by default) and pruned oldest-first;
- a corrupt, tampered or version-mismatched entry is treated as a miss, never
  as data; a read-only or full data folder silently degrades to a normal import;
- `POST /api/import/...?fresh=1` (or `{"fresh":true}`) forces a real
  reconversion; `GET /api/import-cache` reports entries/bytes/hits/misses and
  `DELETE /api/import-cache` clears it;
- the import summary in the editor states when a result came from the cache.

The cache is not a second project format: it stores exactly what the importer
returns, so cached and fresh imports are interchangeable and both are validated.
GPU preview loads only assets referenced by the current level, including indirect
sprite rotation views (front/side/back and mirrored frames). Missing referenced
images report their asset name rather than rendering an untextured white sprite.

**Play level** still launches the current map immediately. **Play game** opens
the imported game's title menu first, then New game and skill selection.
Escape or **Pause / options** opens an in-game menu without advancing gameplay;
Resume keeps the same runtime, while New game starts the campaign entry or
selected episode from scratch. Stop preview / Quit returns to the editor.

Save game / Load game pages are native editable HUD and interface events,
including original `M_SAVEG` / `M_LOADG` patches and dynamic MENUDEF
SaveGameMenu / LoadGameMenu rows when provided. Six browser-local slots retain
the current map, player/inventory, enemies, collected objects, variables,
timers, moving sectors, animation and physics state. Imported actor state travels
too — each monster's state-machine position and inventory — so a restored fight
continues instead of resetting. The weapon machine is re-entered at its Ready
state and the unsupported-action diagnostics are rebuilt rather than saved. Saving requires an active,
living game, and overwriting an occupied slot requires an in-game confirmation.
Loading restores the saved map and runtime rather than restarting the level or
only restoring inventory. Saves use IndexedDB, not localStorage; browser storage
failures are displayed on the menu and in editor status. They survive closing
the preview or reloading Studio on the same browser origin. They are not
GZDoom `.zds` files or project saves. Slots are isolated by a content identity of
the editable game, so changed/imported content cannot accidentally load an
incompatible runtime. Clearing site data removes browser-local saves.

Imported menu elements now sit inside a centered, fixed virtual canvas rather
than spreading across a widescreen HUD. A separate black letterbox hides the
world outside menu artwork. Gameplay HUD anchors retain their existing responsive
behavior. Full-page help artwork keeps its source proportions and has no added
heading or Back button: click the artwork or press Escape to return. Menu
navigation tracks the actual submenu ancestry, including custom screens.

For classic WAD interfaces the Options/Sound pages use that WAD's `M_*` label
and thermometer patches, including live messages, sensitivity and volume
controls. Detail now halves horizontal world-render resolution without reducing
HUD resolution. Screen size (3–11) centers a smaller world viewport; size 11
hides the classic status bar. Both support mouse clicks and Left/Right on the
selected row. These are browser-native equivalents, not software-renderer
emulation; original border textures are not yet reproduced. Missing patches
are diagnosed. Distinct
`M_OPTION` and `M_OPTTTL` artwork is preserved, not recolored to match artificially.
Available `STCFN` glyphs supply proportional bitmap lettering for generated text.
Imported ListMenu positions are no longer shifted or paginated to fit our
generic layout, and no generated heading/Back button is added to such menus.
`DefaultListMenu` / `DefaultOptionMenu` font, selector and line-spacing directives
are inherited by translated menus. FON2 font resources in WADs and packages become
embedded, proportional bitmap atlases, including kerning and transparency.
`BigFont` can resolve the game's `DBIGFONT`. Original palette colors are retained;
named color-range translations, FONTDEFS, FON1 and scripted font classes remain
unsupported and are not claimed as exact reproductions.

Classic animated skull cursors and MENUDEF `Selector` patches are editable HUD
images driven by `hudFocused` visual conditions. Mouse hover and Up/Down choose
rows; Enter activates them. Auxiliary +/- hit regions are excluded from keyboard
row navigation (`menuSelectable:false`). Identical cursor artwork is shared
across pages to stay within the editable HUD budget. Cursor animations use the
`interface` playback clock, which continues while gameplay and its HUD animations
are paused. The HUD timeline exposes both playback clocks. Imported selectors
replace the browser focus outline only when visible; editor selection outlines
remain unchanged. Arbitrary scripted menu classes still require translation.

OpenDLE-only resolution, FOV, brightness, mute and reset controls are in the
editor's **Engine tweaks**, with fullscreen on the preview toolbar, not injected
into imported menus. Global browser preferences migrate from the earlier
jump-only preference object. An explicitly authored MENUDEF setting can still
use its mapped game setting; unsupported CVARs remain diagnosed.

WAD imports reconstruct classic menus from that WAD's own `TITLEPIC`, `M_*`,
skill and help patches, with editable text fallbacks for missing artwork. WAD
`MENUDEF` lumps and package `menudef` / `menudef.txt` files are translated per
game. Supported declarations include `ListMenu`, `OptionMenu`, position/spacing,
titles, static text/patches (including centered patches), patch/text items,
submenus, supported command links, mapped sliders/options and common control
bindings. Long OptionMenus become linked HUD pages; ListMenus retain their
authored positions. Source definitions remain in
`gameMenus.sources`; diagnostics identify unsupported directives, conditional
blocks, unresolved links, commands and CVARs. Arbitrary console commands are
never executed. Nested `#include` resources are resolved in WADs and packages;
original root and included sources remain in `gameMenus.sources`. Missing
includes, cycles, excessive depth or oversized sources fail import explicitly.
Custom scripted menu classes, LANGUAGE text lookups
and the full GZDoom option/CVAR system are **not** translated yet.

### Custom SBARINFO HUD import

WAD `SBARINFO` lumps and root package `sbarinfo` / `sbarinfo.txt` now compile
into ordinary editable HUD elements and the **Imported SBARINFO** visual-event
group. The last SBARINFO resource overrides earlier resources. Nested
`#include` directives resolve resource names case-insensitively; packages also
resolve paths relative to the including file. Arbitrary include filenames are
retained when at most 1 MiB, within the existing 128 MiB package budget.
Original definitions are retained in `hud.sources`, not executed by the runtime.

Current translation supports:

- `height`, `resolution`, `statusbar normal` or `fullscreen`, `forcescaled` and
  `fullscreenoffsets`; normal coordinates use a bottom-centered virtual space
  (320x200 by default). The `monospacefonts true, "0"` mode uses fixed glyph cells.
  A normal layout takes priority, otherwise fullscreen is used. Other modes
  remain in source and are diagnosed; runtime layout switching is not implemented.
- Static `drawimage`, signed patch offsets, `center` / `centerbottom` alignment
  and negative fullscreen coordinates anchored to the right/bottom edges.
- `drawnumber` health, armor, selected-weapon ammo (`ammo1`),
  `ammo(Clip|Shell|RocketAmmo|Cell)`, corresponding `ammocapacity(...)`,
  the unparenthesized forms, `alignment(left|center|right)` and `whennotzero`.
  Untranslated Doom digit fonts use imported bitmap atlases when complete;
  custom FON2 resources retain proportional metrics and their source palette.
  Missing fonts fall back to monospace with diagnostics. Named color-range
  translations are diagnosed (Doom digit fallback uses approximate text colors).
  Values use the
  existing editable HUD `maxLength` formatting, not full GZDoom number formatting.
- Literal `drawstring` in `font, untranslated, "text", x, y` form, using embedded
  FON2 resources when present, otherwise an explicit monospace-font fallback
  diagnostic.
- Textured health/armor `drawbar`, horizontal/vertical fill and `reverse`.
  The foreground is clipped rather than stretched as the value changes.
  **Fill direction** is editable in the HUD designer (`right|left|up|down`)
  and through HUD properties in MCP. **Fill image** / `fillAssetId` chooses
  its foreground; existing `assetId` bar backgrounds retain their behavior.
- `ifhealth N` means health **at least N**, not a comparison-operator syntax.
  `ifinvulnerable`, `isselected` with a standard Doom weapon, and `ininventory`
  with a standard Doom key, weapon, backpack or ammo type compile to live
  visual conditions. Ammo quantity thresholds, `not`, nested conditions and
  `else` are supported. Unknown conditions omit both branches with diagnostics,
  never accidentally display them unconditionally.
- `drawswitchableimage` for Doom key slots (including combined card/skull
  states) and weapon slots produces live, editable inventory-dependent images.
  `gamemode` branches evaluate for the engine's singleplayer runtime; this
  does not introduce multiplayer support.

Limits are 1 MiB per source, 2 MiB expanded definitions, 64 source resources,
16 include/block levels and 4096 parsed commands, plus existing HUD/event/asset
limits. Malformed syntax and unresolved includes fail import. Unsupported
drawing commands/options emit source/line diagnostics. A missing supported
statusbar block is explicitly diagnosed before classic-HUD fallback; an
intentionally empty supported block stays empty.

This is **not full SBARINFO or scripted-interface compatibility**: additional
inventory types, other dynamic icons, mugshot commands, inventory bars, popups,
translations, custom FONTDEFS, numeric flags/interpolation, other game families,
HUD mode switching and ZScript statusbar/menu classes remain to be implemented.
The classic HUD's existing reconstructed mugshot/inventory behavior is unchanged
when no custom SBARINFO is selected. Existing saved projects are not rewritten;
reimport to translate newly supported definitions.

### Menu and gameplay editing

Menus are ordinary HUD elements with an editable **Game menus** event sheet,
not a separate hard-coded HTML overlay. Its `interface` phase runs while the
title, pause or settings screens are active; gameplay sheets do not. In the
HUD designer choose **Game / menu screen** to edit a page. Adding or duplicating
an element there also creates editable visibility events. `gameScreen`,
`setGameScreen`, `startGame`, `quitGame` and the settings/binding/fullscreen
actions are available in the event editor and MCP. `game_menu_install` adds
fallback menus explicitly to an older project; `hud_element_add(screen:...)`
attaches a new element to a menu. The bounded event budget is 2048 rules.

Live options include effects/music volume, mute, sensitivity, invert Y, field
of view, render resolution, brightness, messages, always-run and key bindings.

**Render resolution** (`renderResolution`, `shared/render-resolution.js`) is the
selectable internal resolution the renderer draws at; the canvas is then scaled
by CSS to fit its panel. `display` renders at the panel's real pixel size with
the device pixel ratio capped at 2 — the sharpest option and the default, since
the game previously rendered a fixed 800×450 buffer however large the window
was. A preset (`1280x720`, `1600x900`, `1920x1080`, `2560x1440`, `3840x2160`)
fixes the vertical resolution and keeps the panel's aspect ratio instead of
stretching. The legacy `resolution` scale multiplies the result (0.5–1.5×, so
1.5 supersamples) and classic low detail still halves horizontal resolution; a
buffer smaller than the panel is upscaled with `image-rendering: pixelated`.
The editor preview follows the same policy, so imported models and artwork are
inspected at the resolution the game runs at.
**Overall sound level** (`masterVolume`) scales every sound effect and the
soundtrack on top of the project's own effect and music volumes: the Web Audio
player multiplies both gains, `muted` still wins, and 0 is silent. It is stored
with the other engine tweaks in `localStorage`, so it survives a reload or a new
session, and it overrides the imported project's saved volume when either preview
starts.

The editor's **Engine tweaks / Enable jumping** is enabled by default, independently
of the imported WAD or PK3. Space requests a normal grounded physics jump; E uses
doors and switches. Disable jumping for classic no-jump movement. Jumping can
bypass intended map puzzles and cannot escape arbitrarily deep pits or pass
through solid walls/low ceilings. The Input visual sheet contains the editable
Space-to-`jumpPlayer` rule; the user setting gates jump requests, not gravity.
Engine tweaks is an editor section, not an imported in-game menu. Its choice
persists for all projects in this browser and overrides the game's saved jump
setting when launching either preview mode. In-game Reset settings does not
reset this engine override.

`setting("volume")` and other typed setting expressions can drive ordinary
HUD-property actions (for example, the imported thermometer marker positions).
HUD bitmap fonts optionally retain proportional `widths` and `spaceWidth`;
`imageRepeat: "repeat-x"` tiles an imported thermometer strip without stretching
its individual pixels. These remain portable HUD properties, editable in the
designer and through MCP. `rebuildGameMenu` replaces only menu-owned elements and
the Game menus sheet; callers must validate the result and obtain confirmation
before replacing authored menu edits. Saved projects are not automatically
rewritten on load.
Render resolution scales the drawing buffer from 0.5x to 1.5x in both windowed
and fullscreen previews; the world and weapon stay above the reserved HUD area.
Rebinding swaps occupied keys rather than creating ambiguous duplicates.
Settings persist per project title in this browser's local storage and are
separate from authored project defaults. Fullscreen depends on browser
permission; embedded-browser restrictions produce an explicit message.
Music volume applies to every imported track: Doom MUS/MIDI is synthesised in the
browser (see Level music) and package WAV/OGG/MP3 plays through the same graph.

New game selects retained single-player skill placement flags, with reduced
incoming damage on skill 1 and doubled positive ammo grants on skills 1/5.
Skill 5 is **not yet exact Nightmare**: fast actor states and monster respawn
remain unimplemented. Other compatibility settings are not presented as if
OpenDLE could honor them.

### Level music

Doom soundtracks are stored as MIDI (`MThd`) or Doom MUS (`MUS\x1a`) lumps, not
as playable audio. OpenDLE imports every music lump as a `music` asset (bounded:
2 MiB per track, 32 MiB total, 128 tracks) and synthesises it in the browser:

- `shared/music.js` parses MIDI (variable-length deltas, running status, tempo
  map, program changes, note pairing) and MUS (140 Hz ticks, controller/program
  events, percussion on channel 15), returning one normalised score of timed
  notes with General MIDI families and a loop length. SMPTE-timed MIDI and
  arbitrary SysEx are rejected rather than guessed. A tempo map keeps one mark per
  distinct tick, so a file that changes tempo twice on tick 0 (six of Freedoom's
  35 tracks do) still parses instead of throwing mid-song.
- `public/music-player.js` schedules those notes on the Web Audio graph with a
  small per-family oscillator patch (attack/decay/sustain/release plus one
  harmonic) and filtered-noise percussion. It schedules a 1.5 s lookahead window,
  loops the score, caps concurrent voices, and never spins when a note lies
  outside the window. A stalled tab used to make the scheduler catch up by playing
  every overdue note at the current time, which is audible as one loud chord when
  the game resumes; lateness beyond 0.25 s now drops the backlog and re-anchors the
  timeline to the audio clock (and notes more than 0.05 s late are skipped), so a
  freeze costs a moment of silence instead of a bang. The scheduler counts both
  events for diagnostics.
- Track choice: `MAPINFO` `music = "D_XXX"` wins, then the classic Doom II table
  (MAP01 `D_RUNNIN` ... MAP32 `D_ULTIMA`) or the level's own `D_E<e>M<m>` lump
  with a fallback to `D_E<e>M2`. A level whose track is missing is silent rather
  than pointing at a non-existent asset. `shared/game-levels.js` stores the
  resolved track on each level, so every map of an imported campaign plays its
  own music and the selection survives level switches and saves.
- Volume and mute follow the existing Music volume setting; music is independent
  of sound effects and is disposed with the preview.

Verified: `D_RUNNIN` parses to 1361 notes over 133 s, `D_OPENIN` to 4116 notes,
and a browser preview schedules oscillators for the current level.

The editor status line reports the soundtrack on start ("Music: D_RUNNIN") and
names the cause when nothing plays: no music assets in the project (reimport
needed), a requested track that is not embedded, a score that failed to parse, or
a music volume of 0. Silent music is therefore diagnosable without a console. Importing
soundtracks is not sample-accurate OPL emulation: instruments are approximations,
and pitch bends, vibrato and tracker effects are not emulated.

### Actor translations

A DECORATE/ZScript `Translation` repaints an actor's sprites by remapping palette
colours (`128:151=80:111`), collapsing a range onto one colour (`208:223=1`) or
mapping direct RGB. Sprites are decoded with the game's palette at import, so
`shared/translation.js` turns the specs into a colour lookup and the importer bakes
translated copies of the affected frames as ordinary editable image assets. A
placed actor gets its own translated clips, because the same sprite prefix may
also be used by an untranslated actor; an actor that only ever spawns (a
projectile or effect) has its own `clip_actor_*` clips repainted in place.
Translations whose text this parser cannot model are reported by spec instead of
being guessed, and a numeric or named translation is resolved through the game's
`TRANSLATION`/`TRNSLATE` table (the number indexes it, one-based) or reported as
undefined. Actors are repainted only when their sprites were imported, which
today means placed things and weapons: a spawned-only actor whose sprites are not
in the project has nothing to repaint yet.

DECORATE and ZScript class names are case-insensitive, so parent lookup folds
case; `ACTOR FURFireBall` is a valid parent for `FURFireball2`, and without the
fold the child lost every inherited flag and state.

### Actor state sprites

Monsters and projectiles used to draw from artwork the importer happened to load
for a map thing, HUD element or weapon, animated with hardcoded classic letter
tables. Now the actor's own state frames decide both: the importer loads every
sprite lump the states of the level's actors name — placed things, the weapon
slots, actors named in action arguments and every missile actor whose art exists,
so a mod's fireball or summoned monster has frames at all — and
`installActorSpriteStates` builds each placed actor's `stand`/`walk`/`attack`/
`pain`/`death` clips from its `Spawn`/`See`/`Missile`/`Melee`/`Pain`/`Death`
states. Frames the game does not contain are reported once by name
(`TNT1A`, `####`) instead of silently collapsing a clip.

The actor runtime then keeps the sprite in step with the state machine. The
sprite rules that switch a monster between stand, walk and attack belong to the
scripted enemy AI, which an actor-driven monster never runs, so without this an
imported monster held its spawn frame forever — visible only once the frames
became faithful.

### Morphs

`A_Morph`, `A_UnMorphActor`, `A_UnMorph` and the ACS `MorphActor`/`UnMorphActor`
builtins turn a thing into another actor class. `shared/morph.js` keeps the
entity object, its id and its physics body and swaps what the actor runtime
drives: the class, the health ceiling (scaled so a wounded imp stays wounded),
radius and height, and the sprite clips, which are rebuilt from the new actor's
own states. What was replaced — class, health, bounds and clip bookkeeping — is
kept on the entity so an unmorph restores it, and a corpse is only restored when
the call forces it, as GZDoom does. `duration` counts Doom tics, matching the
action and ACS signatures; 0 morphs until something unmorphs. A player has no
class state machine here, so a player morph changes what the engine models
(health and the equipped weapon) and restores both on expiry. Timed morphs tick
in `stepRuntime` and the state rides along in save games.

The limit is that a morph does not change an actor's DECORATE behaviour beyond
that: flags, attacks and inventory are those of the original thing's runtime
entry where the two differ.

### Camera textures

`ANIMDEFS cameratexture NAME W H [fit] [worldpanning]` reserves a drawable
surface, and `SetCameraToTexture(tid, NAME, fov)` points it at a camera thing.
`shared/cameratextures.js` parses the declarations (later duplicates replace
earlier ones) and `bindCameraTexture` resolves a tag and name to
`state.cameraTextures`, which is saved with the game. The importer turns each
declaration into an editable texture asset whose pixels are a neutral placeholder,
so nothing has to know about cameras until a script binds one, and it reports the
declarations once per import.

`public/render.js` creates two render targets per declared camera (eight at most)
and renders the bound camera's view into one of them before the main pass,
pointing the asset's materials at the other; the pair alternates each frame
because a pass may not sample the surface it draws into, and swapping a material's
map is a uniform update, not a recompile. `fit` stretches the view over the
surface. A camera whose render throws reports through
`canvas.dataset.cameraTextureError` once instead of failing the frame.

### Classic weapons for a plain WAD

A WAD imported without gzdoom.pk3 had no weapon actors, so the player's guns fell
back to the scripted firing rules in Engine/Weapons — a fixed table of tic costs
and damage dice that could never behave like the game. The built-in classic table
now carries Doom's nine weapons, its nine projectiles and the three decorative
actors the native actions spawn, all with their real GZDoom frames, durations and
action functions. `installEngineScripts` already refused to generate scripted
weapon rules when the project has a weapon actor, so installing them is all that
was needed: a plain WAD import runs Doom's own Ready/Select/Fire/Flash machines,
and the projectiles bring their own explosions, spray and homing.

Because those weapons are actors, the trigger has to be consumed where GZDoom
consumes it — inside `A_WeaponReady`. The engine used to short-cut this by
re-entering Fire from outside the state machine whenever the trigger was held and
the weapon was ready; with real Doom states that fired every tic or two and spent
a whole clip in under a second. `A_WeaponReady` now starts Fire when the trigger
is held, `A_ReFire` decides refiring (that is what its frame duration means), and
`weaponTic` stops advancing the tic that a frame action jumped away from, so the
frame after a jump is not skipped. Measured cadences from the states: pistol 14
tics per shot, chaingun 4, shotgun 27, super shotgun 55 for two shells, plasma 4,
rocket 20, BFG 40 for forty cells, fist 22 and chainsaw 8 with no ammo at all.

`classFamily` also recognises the engine's base classes by name (`DoomWeapon`,
`HereticWeapon`, `DoomPlayer`, `BasicArmor`, …). Previously it only walked the
class chain, which needs gzdoom.pk3 to define those parents; without it a mod
whose weapon inherits `DoomWeapon` was not a weapon at all and never fired.

### Missiles and their own states

An imported projectile used to be a moving sprite with a damage number: its
`Spawn` and `Death` states were copied into flight and impact clips, and nothing
in them ran. Doom runs those states on the missile itself, and that is where a
missile's behaviour lives, so `projectileTic` in `shared/actor-runtime.js` now
keeps a state machine on each live projectile (`actorState`, saved with the game)
and `stepProjectiles` advances it at 35 Hz beside the flight update. Frame actions
run with the projectile as `self`, which is what makes the rest of this work:

- **Trails.** A missile whose states call `A_SpawnItemEx` (the steam spitter, the
  fart gun, modded plasma) leaves its particles. Decorative actors named that way
  become animated effects with the velocity and offsets the state passed; an actor
  that is `COUNTKILL` or a lost soul still spawns as a real fightable thing.
  Effects drift while their clip plays and are dropped when it ends. Their clips
  are built when the runtime starts, because the renderer reads the clip list once
  and a missile's first trail must already have artwork.
- **`A_Tracer`.** A homing missile turns 16.875 degrees toward the thing it was
  fired at, at most once every four of its own tics, and slews its climb by an
  eighth of a unit per tic, ported from GZDoom's `A_Tracer2`. It also leaves the
  smoke the vanilla tracer does (`BulletPuff` plus `RevenantTracerSmoke`).
  `A_Tracer2(angle)` runs the homing step directly.
- **`A_BFGSpray`.** On the BFG ball's `Death` state it sweeps 40 rays over a
  90 degree cone (1024 units, args: spray class, rays, damage rolls, spread,
  distance, vertical range, fixed damage) from whoever fired, and each target a
  ray reaches takes that many rolls of 1..8 damage plus the spray actor at its
  feet. Several rays can strike one target, as in GZDoom.
- **`A_Explode`.** A rocket or barrel explodes from its own `Death` state instead
  of an invented splash radius, so a projectile that does not call it does not
  explode. Monster projectiles therefore no longer carry a fake splash of their
  own damage.
- **`A_FireCustomMissile` / `A_FireProjectile`.** The class the mod names is
  spawned with that actor's damage, speed, artwork and states — no placeholder —
  honouring `angle`, `useammo` (a `false` third argument spends nothing),
  `spawnofs_xy` (fired from beside the player), `spawnheight`, `pitch` and
  `SXF`-style `+SEEKERMISSILE` lock-on. A weapon that names a class the project
  does not contain fires nothing and reports the name in the playtest log instead
  of faking a shot.

Two limits worth stating: a missile's `RenderStyle Add` and `Alpha` are still not
applied to its sprite (an imported plasma ball is drawn opaque), and the spray
runs where the ball lands rather than sixteen tics into its death animation.

Import side, one bug made all of this look smaller than it was: a frame line that
put a flag before its action (`STEA A 2 Bright A_SpawnItemEx(...)`, which is how
vanilla and every mod write them) lost both the flag and the action. The ZScript
state parser now peels flags on either side of the call; Furdoom's projectile
states went from no actions to their real `A_SpawnItemEx` and `A_Tracer` calls.

### Sky changes

ACS `ChangeSky(sky1, sky2)` names the sky a level should show. `shared/sky.js`
records the request on the runtime state (`skyRequest`, saved with the game) and
resolves a name to an image asset by name, case-insensitively; any sky, texture
or image asset qualifies, as in GZDoom, where a wall texture is a legal sky.

`public/render.js` builds the sky through `buildSky` instead of inline setup, so a
request is applied on the next frame: when a panorama is already on screen it
swaps the sampler image (and re-sets the material up, which reuses the cached
pipeline), and it only rebuilds the sky when nothing was drawn at all — a solid
colour, or a six-face skybox that the named texture replaces. The projection
stays the project's own sky mode, so a Doom sky keeps its Doom mapping. The
second name only concerns sectors flagged `sky2`, which this engine does not
model; it is recorded for diagnostics rather than drawn. A name with no matching
image reports through `canvas.dataset.skyError` once instead of failing the
frame, and the applied name is visible in `canvas.dataset.sky`.

Classic `SKYn` textures are imported whether or not the current map uses them, so
a script can switch to any of them; every sky image also travels with each level
in a full-game import rather than only the one the map starts with. Edits to the
sky in the editor now show up without reloading the preview, because the same
builder runs when the environment changes.

### Sound names and SNDINFO

DECORATE and ZScript states never name a sound file. They name a logical sound
(`grunt/sight`, `weapons/pistol`), and SNDINFO maps that onto a lump — sometimes
through a `$random` group of several. `shared/sndinfo.js` parses the format
(`$alias`, `name lump`, `$random` groups, `$playersound`, `$playersounddup`
chains; other commands are ignored) and the importer compiles the tables from the
game's own SNDINFO files, the base IWAD's `SNDINFO` lump and gzdoom.pk3's shared
and per-game filter tables into `project.soundAliases`. Later definitions replace
earlier ones outright, so a mod that redefines `grunt/sight` does not keep the
vanilla random group.

The table is a game-wide shared value (one copy per campaign, like the actor
table). A small built-in vanilla table ships with the engine, so a project
imported before SNDINFO support — or one whose game has no SNDINFO at all — still
resolves the standard monster and weapon sounds without being reimported. The
audio player resolves names case-insensitively, expands groups to the first member
that actually exists in the project, and reports an unknown name once instead of on
every encounter.

### Frame performance and stall fixes


The intermittent 1-5 second gameplay stalls were shader compiles, not geometry
cost. Three.js compiles a program the first time a material is drawn, and doors,
lifts and lowering floors reveal upper/lower/middle textures that only exist once
they move, so the first door opening compiled programs mid-game (measured 857 ms
for one sector height change; the same change afterwards 4.8 ms). `shared/sectors.js`
now exposes `surfaceMaterials()`, which enumerates every surface a level can ever
show, and `public/render.js` builds and `compileAsync`s those materials in the
warm-up scene; projectile materials are pooled and prewarmed the same way. The
same change now costs about 12 ms.

Per-frame work was also reduced: sorted sprite-clip/asset maps replace linear
`find` scans (`spriteView` 0.73 -> 0.044 ms/frame on a 576-sprite fixture),
`sectorAt` uses a uniform grid (1.92 -> 0.168 ms/frame across 513 entities), and
`public/hud-view.js` only writes a style, class, label or DOM attribute when the
computed value actually changes instead of rewriting every element every frame.

`compileAsync` projects a scene exactly like a rendered frame, so on its own it
only builds pipelines for what the spawn camera can see and skips invisible
objects; the warm-up scene of 1x1 quads at the origin was usually outside that
view, which left the rest of the world to compile the first time the player
looked at it. `shared/render-warmup.js` forces culling and visibility off for the
warm-up pass and restores exactly what it changed, so every pipeline exists
before the first frame.

Opt-in counters (`canvas.dataset.perfCounters = 'on'`) expose `frameMs`,
`frameMaxMs`, `frameStalls`, `worldRebuildMs` and `worldRebuilds`; `preview.perf()`
returns the same numbers plus `slowFrame`, the breakdown of the worst frame:
`update` and `draw` milliseconds, the last world rebuild, the geometry rebuild
count, the pipeline/texture/geometry totals and the JS heap size (Chromium), so a
pause with little update or draw work inside it reads as a collector pause. A playtest log entry for a stall
carries that breakdown, so a report says which phase was slow instead of only how
long it took. The render buffer also ignores changes of eight pixels or less, so a
scrollbar appearing or a fractional layout cannot reallocate the drawing buffer
every frame.

Remaining known hotspots, in order: HUD DOM updates for very large layouts,
`syncWorld()` rebuilding a moving-sector trimesh on each world revision, sector
advance allocations, and JSON `pairKey` collision keys.

### Renderer selection and GLSL effects


OpenDLE now prefers **WebGPU** when the browser can initialize a usable adapter
and device, and falls back to **WebGL2** otherwise. The preview reports the
actual initialized API and the reason for fallback; a device/backend failure
is not silently reported as WebGPU success. Browsers do not expose Vulkan
directly: a WebGPU implementation may use Vulkan internally, but OpenDLE cannot
select or promise that native driver API.

Environment contains a GLSL effect editor and the active **World shader**
selector. Effects are portable project data:

```json
{
  "id": "dim",
  "name": "World dimmer",
  "language": "glsl",
  "uniforms": { "strength": 0.8 },
  "source": "vec4 effect(vec4 color, vec2 uv, float time) { return vec4(color.rgb * strength, color.a); }"
}
```

Store these in `project.shaders` and select one with
`environment.shaderId`. Numeric uniforms are declared by the engine; do not
duplicate their declarations in source. This is a portable GLSL **effect
subset**, not an unrestricted GLSL vertex/fragment program or arbitrary
GZDoom shader importer. The shader is compiled through Three's node pipeline
for the selected backend, not interpreted as JavaScript. Unsupported constructs
produce explicit errors.

The current GLSL subset supports float/vec2/vec3/vec4, initialized locals and
`const`, whole-local reassignment/compound arithmetic, swizzles and a final
vec4 return. Intrinsics include abs/sign/floor/ceil/fract, trigonometry,
exp/log/exp2/log2/sqrt/inversesqrt, mod/min/max/pow/step/clamp/mix/smoothstep,
length/distance/dot/normalize. Loops, branches, texture sampling, helper
functions and assignment to inputs/uniforms are not supported yet. Source is
parsed/type-checked during project validation as well as renderer setup.

Visual scripts can use `shaderEnabled`, `setShaderEnabled(enabled:yes|no)`
and `setShaderUniform(uniform,value)` with expression-driven values, for
example `=sin(time) * 0.25 + 0.5`. Runtime overrides reset on Play and never
overwrite the shader's initial values. Effects and commands use the same
validation through editor, save/export and MCP `shaders_set`.

**Compatibility boundary:** this is the first scripting/mechanics layer
toward the requested Doom II/GZDoom target, not an accurate replica yet.
Movement still uses Rapier and render-frame timing, not Doom's 35-tic
momentum/friction/step semantics. Hitscan uses a deterministic prototype RNG,
not Doom's random table, autoaim, refire spread or weapon-state machine.
Not implemented: complete weapon state machines and power-ups,
full monster states/pathfinding/special attacks, music, gibs,
full Doom-specific pickup behavior, difficulty rules, generalized locked switches,
crushers and remaining linedef/sector specials, complete hazards/secrets/exits,
scripted GZDoom intermissions and original GZDoom save-file compatibility. These need
additional native primitives plus editable default rules and compatibility
tests; installing the starter does not make an imported WAD play like Doom.

Existing saved Engine sheets are never silently replaced. Restart the service
and reimport a game to receive updated default mechanics; save/export authored
changes first. You can then edit the installed rules without an importer
overwriting them.
Legacy WAD projects missing the HUD, audio or current combat starter show an
explicit reimport warning. The 3D layout is an editor with a fly camera, not a
running game: use **Play world** for HUD, sound and gameplay.

### Doors, lifts and moving sectors

ZDoom/UDMF linedef specials run through `shared/line-specials.js`, which follows
GZDoom's own units: a special's speed argument is `SPEED(a) = a/8` map units per
tic, and its delay is either `TICS(a)` (ticks) or `OCTICS(a)` (eighths of a
second), depending on the special. Reading the raw number as units per tic made
every door and lift eight times too fast; a real door in `Furdm05` (speed 82,
delay 34) opened in two frames and shut again in the same moment, because the
delay had been read from the argument before it. `Generic_Door` (202) and
`Generic_Lift` (203) also take their `kind`/`delay`/`target`/`height` from the
arguments GZDoom documents, and an unknown door kind does nothing. Maps without
ZDoom arguments (classic Doom lines, or ACS `LSPEC`) use Doom's own constants
instead: `VDOORSPEED` 2 units per tic, `VFLOORSPEED` 4, `VDOORWAIT` 150 tics.

Collision has to follow those moving sectors, and a Rapier trimesh cannot be
edited in place. `shared/physics.js` keeps a static collider for the level and a
dynamic one for sectors that have left their spawn heights. The movable set is
discovered from the *sectors themselves*, not from event `moveSector` actions, so
doors opened by line specials, ACS or events all work: the first time a sector
moves, the static mesh is rebuilt without it (about 10 ms on a 241-sector map)
and from then on only that sector's geometry is re-triangulated (about 0.2 ms per
frame). Before this, only sectors named by an editable `moveSector` action were
ever updated, so an imported door opened, animated and stayed solid: the visual
world moved through `state.worldRevision` while the collider did not.

### Physics and Blockbench models

1. In **Assets & sectors**, click **Import models**. The picker accepts a
   Blockbench **`.bbmodel`** project directly, a **GLB** (recommended) or a
   **`.gltf` 2.0** export plus its `.bin` and texture files. Files and whole
   folders can also be dropped anywhere on the Assets panel: a drop containing a
   model source is treated as a model import, so its buffers and textures travel
   with it. **Model folder** reads an export directory recursively. Resources are
   embedded for portable offline projects; remote URLs and parent-directory
   paths are rejected.
2. `.bbmodel` files are converted to an embedded GLB at import time
   (`shared/bbmodel.js`), so the renderer keeps a single glTF path. Blockbench
   cubes, `inflate`/`stretch`, per-face atlas UVs (including face rotation and box
   UV layouts), groups and pivots, element rotation, `rescale`, embedded textures
   and animation clips are kept. Atlas rectangles are used exactly as authored:
   Blockbench and glTF both measure V downwards from the top-left pixel, so a face
   samples the tile it covers instead of its mirror image (`1 - v` was applied for
   Blockbench's flipped-Y preview and landed every face on a neighbouring tile).
   Textures sample with nearest filtering and no mipmaps, because mipmapped
   sampling mixes the transparent atlas padding into the image and punches holes
   in alpha-tested faces. Animations are baked at the animation's snapping
   rate into glTF clips, so Molang expressions such as
   `math.sin(query.anim_time * 120) * 18` (degrees) and Bezier/Catmull-Rom
   keyframes play in the engine; a script this converter cannot evaluate is
   reported and baked as its first constant. Blockbench units are divided by 16
   (16 units = one block/metre), matching Blockbench's own glTF export default;
   RGBA textures import with alpha cutout so pixel-art transparency stays crisp.
3. Select a non-player object, assign its **3D model** in Properties and adjust
   **Model scale**. glTF uses +Y up; one glTF unit defaults to 32 map units.
   Imported model origins are retained, so put the origin at the feet in
   Blockbench. A model replaces that object's billboard sprite, and the
   selection box then follows the model's own bounds instead of the sprite's.
   Models are parsed with the preview, so the first assignment reloads the 3D
   scene once; later edits apply in place, and swapping one model for another
   replaces just that object.
4. Choose an initial animation, playback speed, loop and auto-play, or attach
   **Model: play animation / stop animation** actions. Non-looping clips hold
   their final pose and raise **Model: animation finished** on the next event
   tick. Play restarts a clip; stop resets to its authored pose. Disable
   “Once” for reusable key/contact rules; do not put a restarting play action
   on an unconditional every-tick rule.
5. In Properties, enable **Rapier physics** and choose a body/collider. Model
   geometry is visual: collision uses the separately configured primitive.
   Collider dimensions are map units, centered above the entity's floor-relative
   elevation. A ball's total height is twice its radius. Kinematic/fixed objects
   move via explicit position actions; only dynamic bodies accept forces,
   impulses and velocity. Model rotation follows the full physics quaternion.
6. Attach **contact / trigger entered**, **exited** or **touching / overlapping**
   conditions, selecting two physics objects or an object and **Sector geometry**.
   `$self` addresses the owner; `$world` addresses static sector collision.
   Sensors report the same conditions but never block the capsule.

Physics runs at 60 Hz, with 64 map units per metre and gravity 9.81 m/s².
Force/impulse/velocity actions use SI units (N, kg·m/s, m/s); X/Y are horizontal
and Z points up. A force applies for one fixed tick; repeat the action for a
continuous force. Position action Z is an **absolute world height**, while
Properties elevation is relative to the containing sector floor. Omitting Z
on teleport places the object on its destination floor plus authored elevation.
The player capsule is radius 12, total height 56, with up to 24-unit autosteps.
World colliders use sector floors, non-sky ceilings, solid walls and portal
height differences; explicitly omitted `wallsOnly` surfaces remain omitted.
Maps without sectors retain a bounded flat legacy ground plane.

Limits: 256 object bodies; 16 MiB per bundled model; 32 MiB decoded buffers;
10,000 nodes, 2,000 meshes, 512 skins, 256 clips and 256 images per model.
Embedded image/model sources share the existing 48 MiB project budget.
Model textures are limited to 4096x4096; when models are loaded the preview
checks a 32-million-pixel budget across all loaded textures.
Draco, Meshopt and KTX2/Basis compression require decoders and are rejected.
Unknown required extensions fail explicitly; optional unknown extensions warn.
For `.bbmodel`, Blockbench free-form mesh elements, armatures (they import as
empties), locators, particle/sound/timeline keyframes and Blockbench plugins are
reported and skipped rather than silently dropped; each cube becomes its own mesh,
so very large cube-heavy models cost one draw call per cube.
Imported models are shaded as physical surfaces, not with Doom's flat light
levels. `MODEL_LIGHTING` in `public/render.js` holds the whole model light rig: a
dim studio environment used only for reflections and a little fill, a hemisphere
light that lifts shadows predictably, a key light that separates faces, a cool
rim light, and the floor a dark sector may dim a model to. It is tuned so a lit
face renders near the texture's own tone instead of washing out to mid grey (the
old full-strength environment plus a 2.0 hemisphere light rendered models ~2.5x
brighter than their textures). The classic world shaders keep their own
palette-faithful sector light, so tuning this rig never changes how imported
wall, flat and sprite art looks. There is no mesh-derived collision,
ragdoll, physics joints, animation blending UI or model/rig authoring editor yet.

### Interaction areas and reusable scenes

An **interaction area** is an optional volume around any object that engine
events can test, so "player walked into this room" needs no geometry work and no
hidden trigger object. Properties → **Interaction area** picks the shape and
size: **Box** (width/depth/height), **Sphere** (radius) and **Capsule** (radius /
height). The volume is centered horizontally on the object and spans the
object's floor plus elevation plus half its height, matching how Rapier bodies
are created, so the overlay and the physics shape agree. `DEFAULT_AREA` and
`AREA_SHAPES` in `shared/areas.js` define the defaults; a new area defaults to a
96×96×96 box.

Two engine conditions test it: **Player: inside this object interaction area**
asks whether the player is inside right now, and **Player: entered this object
interaction area** fires once on the tick the player crosses in, so an
unconditional rule opens a door or starts music exactly once.
Containment expands the area horizontally by the player's radius and compares
vertical spans against the player's 56-unit height, which is why standing on the
floor of a room counts as inside even though the capsule's center is above it.
`areaEntries` in the runtime tracks who is already inside; it is session state,
so it is excluded from save files. Using either condition on an object without
an area raises a clear error instead of silently never firing.

**Scenes** generalize "one object" into a group. Select an object, a wall or a
room, then **Capture scene** in the Assets panel's Scenes folder: the objects and
the events that own them are copied into `project.scenes` as a reusable
definition, centered on the selection's centroid so placing it lands where it was
captured. **Place at view** (or dragging the scene tile into the 3D view) copies
that definition into the map at the drop point, rotated to face the view. A scene
instance is a plain copy with fresh ids — there is no live link back to the
definition, which keeps every placed instance fully editable with the existing
inspector, event editor and undo; re-placing is how you propagate a change.
Objects and events inside a scene cannot include the player. Captured events
keep their actions but drop their HUD `sheetId`, because a scene can be placed
in any level. Limits are 64 scenes, 128 objects and 256 events per scene.

### Model thumbnails

The asset library shows a snapshot of each model instead of a "3D" placeholder.
Importing a model rasterizes it once with `public/model-thumbnail.js`: it reads
the same embedded GLB the renderer uses, bakes node transforms, decodes the
embedded textures, and draws the triangles into a 128×128 canvas with a z-buffer,
nearest sampling, alpha cutout at 128 and a single Lambert shade, from a
three-quarter view that fits the model's bounding box, on a transparent
background. Only canvas 2D is used, so no WebGL context is created and importing
never disturbs the 3D view. The result is stored as `asset.preview`, a PNG data
URI validated against a 96 KiB cap.

Models imported before this existed, or captured when the browser refused to
decode a texture, are rendered lazily the first time their tile is displayed and
kept in a per-session cache (`modelPreviews` in `public/app.js`) rather than
written to the project. A failed capture leaves the plain "3D" placeholder and
never blocks the import.

### Gravity direction and wall walking

The player has their own up axis (`state.player.up`, world-up by default), so
events can turn gravity onto a wall or a ceiling and let the player walk on it.
Three commands drive it:

- **Player: touching a surface** — true while the capsule is in contact with a
  surface, with a `wall` / `floor` / `ceiling` / `any` choice. Surfaces are
  classified by their *world* normal, so the real floor still reads as a floor
  when the player is standing on a wall next to it.
- **Player: is on the ground / airborne** — the same state Rapier reports, but
  measured along the player's own up axis, so it stays correct on a wall.
- **Player: set gravity direction** — `world` restores normal gravity, and
  `wall` / `floor` / `ceiling` / `nearest` rotate the up axis onto the nearest
  matching contact within `reach` map units. Nothing happens when that surface
  is not there, so a rule never needs a "was it really there" guard.

```text
If  Player: touching a surface = wall
And Player: is on the ground / airborne = airborne
Do  Player: set gravity direction = wall
```

Click **Add wall-walking experiment** in the Engine section of the project tree
(or call the `engine_add_wall_walk_demo` MCP tool) to install a ready sheet
built from those rules: jump at a wall or ceiling to start walking on it, touch
a real floor to fall back to normal gravity, and hold **F** to drop back at any
time. Removing the `airborne` condition makes it purely touch-driven; a
corridor then grabs the player on every wall they brush.

What changes underneath:

- `shared/gravity.js` owns the player frame: the heading/strafe basis for an
  arbitrary up, surface classification, the eye position and the view
  direction. `alignUp` points the up axis at a new surface while *keeping the
  world direction the player was facing*, so a gravity change reads as a roll,
  not a turn (facing straight into the new floor falls back to looking up it).
- Rapier capsules always grow along +Y, so `shared/physics.js` rotates the
  player capsule onto the up axis and slides it by the measured gap to the
  surface, landing its feet exactly where the surface is. Movement and gravity
  are then applied in the player's plane.
- Ground contact, wall contact and the ceiling above are found with short ray
  casts from the capsule (centre, four offsets and eight directions). Each hit
  is reported as a contact *clearance* — the gap between the capsule surface and
  the geometry — which is what "touching" and the action's `reach` measure. The
  probe only runs when the project has a rule that can read a surface, so other
  projects pay nothing for it.
- `public/render.js` puts the camera on the player's up axis, easing the roll
  over ~0.1 s. The weapon overlay is drawn in the screen-space overlay scene, so
  it stays upright. Hitscan attacks fire along `viewDirection`, so the crosshair
  keeps pointing where shots go.
- The up axis is stored in the physics snapshot and in `state.player`, so
  saving mid-wall and loading puts the player back on that wall. Saves made
  before this existed load with world-up.

Limits: Rapier's own autostep and snap-to-ground only understand world +Y, so on
a wall the player cannot step over ledges or stick to descending slopes as
smoothly as on the floor. Sectors, interaction areas, Doom line specials and
pickup reach all still measure height against world-up, and the capsule cannot
pass through a 56-unit gap sideways once it is lying horizontally. Treat this as
a scripting primitive for experiments, not as a guarantee that every Doom map
plays correctly upside down.

### Object-attached visual scripts

The event editor combines a Construct-style conditions/actions table with
GDevelop-style dropdown editing. Select **All events**, **Scene only**, or an
object in **Show scripts for**. Adding a rule inside an object's sheet assigns
that object as owner. In the all-events/scene views, new rules are scene-wide;
each rule's **Owner** dropdown can reassign it.

Use **+ AND condition** to require several conditions, for example *Player is
near This object* AND *On key pressed E*. All conditions must match in the same
runtime step. A scene-start condition only matches the initial step; combining
it with a key press does not wait for that key later.

**This object** targets the owning instance in proximity, destroy, position and
angle operations. Other targets can be picked explicitly by name. Removing an
owner stops its rules from running, including later rules in the same step,
but the remaining actions in the currently executing rule still finish.
Actions targeting an already destroyed object have no effect. Global and
object-local variables support numbers, text and booleans; object-local
values belong to individual instances and sub-events inherit their owner.

Scene and object events share one global execution order, shown by the row
numbers. Filtering does not change execution order. Up/Down swaps a row with
the next visible rule in that direction; hidden rules keep their positions.
Position and player teleport actions place objects directly without a collision
check. Angles are absolute degrees, not per-frame increments.

Deleting an object in the editor also removes its owned rules (with confirmation
when it has rules). References from other objects or scene rules block deletion
until removed. Undo restores both the object and its scripts. Removing an owner
or retargeting a rule to the player cannot leave invalid **This object** destroy
actions: validation rejects the edit and explains the problem. Change the action
targets first if you want to detach a rule to the scene.

Existing version-1 projects remain valid without migration. Rules still store a
primary `condition` and `actions`; optional `ownerId` attaches a rule to an
existing entity, and optional `conditions` holds up to 15 extra AND conditions.
`entityId: "$self"` resolves to that rule's owner. These fields survive browser
drafts, undo/redo, exports, server saves, MCP and DeepSeek drafts.

This is **instance-owned event-sheet scripting**, not a node-graph editor or the
complete Construct/GDevelop event engine. Nested/sub-events, OR groups, families,
automatic instance picking, expressions, reusable behavior templates and
Construct/GDevelop project import are not implemented.

### Import Freedoom and images

1. Put a legally obtained complete WAD in `Projects/`. Click **Local WAD library**,
   choose `freedoom2.wad` and a map, then **Import map & assets**. Alternatively,
   **Import WAD + assets** uploads a WAD selected from your computer. Import
   replaces the current project but can be undone; save/export your edits first.
2. **Play world** previews the imported map with its materials, playable combat
   and reconstructed WAD status bar. Editable nine-weapon, enemy, sound, inventory,
   ammo, key and pickup rules are installed automatically. Weapon frames for fists,
   pistol, shotgun, super shotgun, chaingun, launcher, plasma, BFG and chainsaw
   are imported when present. Number keys 1-9 select owned weapons (8=chainsaw,
   9=super shotgun). Full GZDoom weapon/actor state-machine fidelity is still
   incomplete. Per-weapon overlay
   assignments can be edited in **Environment & variables**.
3. In **Assets & sectors**, choose **Import as** and import ordinary PNG, JPEG or
   WebP images. Files must be at most 6 MiB and 2048x2048; up to 64 per batch.
   They are normalized to embedded PNG images, including alpha transparency.
4. Select a wall or object to assign an image in Properties. Click inside a
   sector's floor in the layout, or choose it from **Assets & sectors**, to edit
   its heights, surfaces, light level (0–255) and sky ceiling.
5. **Environment & variables** selects a solid sky color, Doom-style repeating
   sky, 360-degree panorama or a six-face skybox (`px,nx,py,ny,pz,nz` in renderer
   world axes: +Y is up). Import cube faces as Sky images and assign all six.
   A skybox takes priority over the panorama; use the provided button to remove
   it. Sky backgrounds show through sky-enabled ceilings and beyond geometry.
6. Place a Light object and edit its color, intensity and radius in Properties.
   Point lights contribute distance-attenuated color to surfaces and sprites;
   they do not cast shadows or test wall occlusion, so light can bleed through
   walls. Moving/removing light objects via visual scripts updates illumination.

Asset PNGs are embedded in portable project JSON, not linked to the local WAD.
User PNG weapon images are centered at the bottom; imported Doom weapon patch
offsets use the original 320x200 overlay coordinate system. Sprite offsets and
transparency are preserved; user sprites are bottom-centered by default.

### Imported classic WAD HUD and inventory

Both local-library and uploaded WAD imports decode `STBAR`, `STARMS`,
`STTNUM0..9`, `STYSNUM0..9`, `STGNUM2..7`, `STTPRCNT`, `STKEYS0..8` when
available, and the standard `STF*` face patches. Data comes only from the
user-supplied WAD, decoded with its first `PLAYPAL` palette. No game artwork is
bundled. Signed patch offsets and transparency are preserved, including in the
generated face atlas.

The HUD is authored in classic **320x200** screen coordinates: the status bar
occupies the bottom 32 design pixels, reserves matching space above it for the
game/weapon view, and uses nearest-neighbor images. On widescreens it stays
centered with backing at the sides instead of stretching the face/artwork.
Change **Reserve view bottom**, anchors, scaling or **Pixelated images** in the
HUD designer. All fields, icons, digit fonts, face clips and rules remain ordinary
editable project content, saved/exported with the scene.

- Large red digits show selected ammo, health and armor; small yellow digits
  show all four ammo reserves and capacities. Weapon slots change between gray
  and yellow based on ownership. All six key/card/skull states are real inventory
  flags. Combined-key patches are used if present; otherwise the skull icon
  takes precedence over its same-color card when both are owned.
- Five pain-band idle-face clips use the WAD's three look frames. Editable
  **Engine / HUD** groups select expressions for normal idle, hurt, left/right
  damage, heavy-damage ouch, new-weapon grin, sustained attack, invulnerability
  and death, then choose their frames. Thresholds and priority are visual rules:
  later matching expression rules win. This is **not exact Doom/GZDoom face
  timing/RNG** or a port of its mugshot state machine.
- **Engine / Pickups** contains type/proximity parent events and nested
  benefit-check/collection events. Imported rules cover loose/boxed bullets,
  shells, rockets and cells; the seven weapon pickups; all six card/skull keys;
  stimpacks, medikits, health/armor bonuses, soulspheres, green/blue armor,
  megaspheres and backpacks. Consumed instances are removed. Health/ammo pickups
  at their caps remain, and a backpack doubles capacities only on first pickup.
  These are editable prototype rules, not skill-scaled/network-compatible Doom
  pickup semantics. Power-up effects (invulnerability, berserk, invisibility,
  suit, automap, light goggles) remain unimplemented and are reported in import
  notes when present. Granting `invulnerable` through scripts displays the god
  face and bypasses the damage action.
- **Engine / Input** has owned-weapon selection events. Initial inventory is
  fists/pistol, 50 bullets, zero other ammo/keys, with capacities 200/50/50/300.
  `setWeaponOwned`, `selectWeapon`, `setKeyOwned`, `addAmmo`, `giveBackpack`,
  `setPlayerStat` and `setPlayerFace` are available in visual scripts/MCP.
  Conditions include `weaponOwned`, `weaponSelected`, `keyOwned`,
  `backpackOwned`, `ammoBelowCapacity`, `entityDoomType`, `playerFeedback`,
  `playerFace` and `hudAnimationPlaying`. Selecting an unowned weapon reports an
  error; input rules guard ownership. Removing a selected weapon requires first
  selecting another owned weapon. Inventory resets on each Play.
- `damagePlayer` optionally accepts `direction: front|left|right|self` (default
  front). `playerFeedback` exposes damage amount/direction for one second,
  continuous primary-fire hold time and recent new-weapon pickup. Direct
  health-stat loss also feeds damage feedback. Actual enemy attacks and weapon
  projectiles still need separate mechanics.

Missing optional patches produce explicit import warnings. Incomplete digit
sets use readable text; missing face expressions use available idle frames.
Without `STBAR`, the importer installs the generic editable OpenDLE HUD and
reports why. Present-but-malformed patches fail validation/import rather than
silently discarding corrupt data. Geometry-only imports without an image
encoder use the generic HUD with an explicit image warning.

### Current compatibility limits

WAD import preserves vertex positions (inverting Doom's Y axis), sector heights,
light levels, sidedef offsets and upper/lower pegging flags. Two-sided walls
render upper/lower spans around sector openings and optional alpha-masked middle
textures. Floors support concave polygons, holes and disjoint islands.
Duplicate coincident boundary vertices/edges are normalized for triangulation.
Open/non-polygon helper sectors are explicitly warned about and flagged
`wallsOnly`: metadata and walls remain, floor/ceiling surfaces are omitted.
In the supplied Freedoom file this affects MAP10 sectors95/113/114/128/130 and
MAP28 sector1020. **32/32 maps import**, but this is not a guarantee of perfect
rendering or playable traversal in every map; MAP01 is browser-tested.

The first player-one start and single-player thing placement are used. Skill
flags are retained; New game selects them (Play level defaults to skill 4
unless this browser has saved a different difficulty).
Common monster/pickup/decoration thing types map to imported sprite-frame clips.
Unknown types remain visible colored placeholders. Recognized lamps import as
light objects, with added approximate warm point lights for the first 16;
sector light values are retained throughout. Enemy chase avoids walls and other
living enemies; player-vs-monster body blocking and full actor physics are not supplied.

**Not implemented:** generalized sector movement,
remaining linedef/sector specials, full weapon/combat behavior,
complete monster behavior, music, Doom timing/demo fidelity, multiplayer, advanced UDMF semantics,
ACS, DECORATE or ZScript. Rapier supplies player gravity/collision; inventory,
basic pickups, weapons, enemy combat, classic moving sectors and sound playback use editable events, not exact Doom
semantics. Closed/inverted-height doors remain closed; teleports remain direct
placement. This is not a Doom-equivalent game conversion. Binary Hexen maps are
explicitly rejected; UDMF geometry imports natively with preserved source
properties and explicit warnings for remaining behavior gaps. Standalone WAD import still needs a complete base asset
set. Package map import can explicitly layer one base IWAD under package
resources; arbitrary multi-mod load orders are not implemented.

### PK3/IPK3 archives and unpacked resource packages

`.pk3` is GZDoom's **ZIP-based resource/mod container**, not a replacement game
engine or a different WAD map format. It can contain images, nested map WADs,
audio and gameplay definitions. `.pk7` uses 7z and is not supported here; `.k3`
is not the usual GZDoom package extension.

`.ipk3` uses the same archive format for standalone games. It is discovered and
imported directly, without running the bundled executable. A standalone game
does not acquire an unrelated Doom II campaign just because its map filename
is `map01.wad`; only explicitly referenced base destinations are added. Its base
selector defaults to **None**, rather than silently applying the installed
Freedoom IWAD; users can still choose an additional base explicitly.
The supplied `GZPT/GZPT.ipk3` imports both TITLEMAP and PT01, and
`intoOblivion/gameData.ipk3` imports its single packaged map. Both were verified
without an external base. These successful native imports do not imply complete
conversion of their ACS/ZScript/custom actors; compatibility warnings remain.

- **Import PK3 / IPK3** uploads an archive. **Local package library** discovers `.pk3`/`.ipk3`
  archives and unpacked package folders under `Projects/`, including nested
  distribution folders. Nothing is extracted or executed. Archive reading uses
  `yauzl`; PK3 CRC validation requires Node **22.2+** (Node 24 is recommended).
- The default **Import game** workflow asks for only the **Mod** and **Base
  game**. It reads GAMEINFO/MAPINFO metadata (including bounded includes),
  displays the declared title/base requirement and selects the first declared
  episode/start map automatically. Without an entry declaration it uses a
  declared map or conventional gameplay entry, avoiding title/ending/test maps
  when possible. Missing declared entries are explicit dependency errors.
  A matching available base filename is selected automatically; when a mod
  declares a base that is absent, select/provide the required IWAD rather than
  silently substituting Freedoom. Resource-only mods use the chosen base's
  MAP01/E1M1 entry. Referenced assets are resolved without manual image selection.
  **Current result is the imported entry level**, not a complete multi-level
  game conversion: scripting, custom HUD behavior and level progression remain
  runtime work. Metadata discovery is not full MAPINFO execution.
- **Advanced: choose a level or extract images** contains the previous manual
  map selection/category/search/image-batch controls. Compatibility diagnostics
  remain available in a separate collapsed details section.
- Choose **Add selected images to current project**, optionally filter by path,
  and select **1–64** resources per batch using Ctrl/Shift. Changing the filter
  clears selection. The importer recognizes `textures/`, `flats/`, `sprites/`,
  `graphics/`, `patches/` and `hires/`; it does not automatically apply brightmaps
  or engine-specific `filter/` overrides. Imported images remain assignable,
  editable project assets. **Image category** can override the namespace for a
  batch, for example to use a sprite as a weapon overlay or texture as a sky.
  Duplicate batches in the same category are reported rather than added twice.
- PNGs retain alpha and signed GZDoom `grAb` offsets. Legacy Doom patches and
  4096-byte raw flats need a **Base IWAD / palette** selection unless the package
  supplies `PLAYPAL`. Actual file signatures distinguish PNGs from Doom patches,
  even when a patch has a `.png` extension. JPEG/WebP/DDS/TGA/PCX package images
  currently report an explicit unsupported-format error; normalize these through
  the existing ordinary image importer instead.
- Map choices identify **Doom / UDMF / Hexen** format. Doom and UDMF geometry
  are enabled. Maps are read from `maps/*.wad`, including custom marker
  names. Map import replaces the scene with undo support. A chosen base IWAD,
  root-level resource WADs and the selected map are layered in that order;
  direct package image resources override matching classic material/sprite/HUD
  names. Short image aliases use the last entry in package enumeration order
  with explicit replacement notes; full relative paths remain addressable.
  Archives retain entry order; unpacked directories use sorted traversal.
  GZDoom's complete texture-type/filter/load-order resolution is not reproduced yet.
  Missing base palettes report an error. Map and image imports do not silently
  save over the server project.
- Binary Hexen maps remain visible but disabled. ACS sources compiled into a
  map (`BEHAVIOR`), DECORATE/ZScript actor definitions and DEHACKED patches are
  compiled into native data and executed. ZScript beyond defaults/state blocks,
  ACS libraries loaded through `LOADACS`, MAPINFO/GAMEINFO gameplay rules,
  TEXTURES, GLDEFS and other definitions are **not executed or translated**. Their presence is reported in import notes.
  MENUDEF and SBARINFO have the bounded partial translation described above;
  this does not execute ZScript or custom actors.
  Images imported from a mod do not automatically create its custom actors,
  scripted HUD or composite texture definitions. Sound/music/native model
  definitions are also outside this importer.
- Limits: 128 MiB archive/expanded input, 10,000 entries, bounded directory depth,
  2048×2048 images and 32 million decoded pixels per operation. Existing project
  limits still apply (3,000 assets; 6 MiB per image, 48 MiB combined image/model/font
  data, plus a separate 64 MiB embedded sound budget).
  Encrypted entries, unsupported ZIP compression, symlinks, traversal paths,
  case-insensitive duplicate paths, corrupt CRCs and malformed images fail
  explicitly. Package contents are never written to disk by import.

For the supplied examples, `Furdoom/furdoom_v0.1.1.pk3` contains **17 UDMF maps**
and custom actor/ACS/ZScript content; `ascentoftitan-1-1/` contains **12 UDMF maps**
and explicitly names Doom II as its base game. All **29 maps pass native geometry
import** using the supplied Freedoom II base assets. This checks import and
project validation, not visual or gameplay equivalence to Doom II/GZDoom.
`freedoom-0.13.0/` is a distribution of conventional IWADs, not a PK3.
Further native compatibility work is required for these games' actual scripts,
specials, custom actors and HUDs.

#### Native UDMF import

UDMF `TEXTMAP` is parsed as bounded declarative data, never JavaScript. The
parser supports comments, quoted strings/escapes, booleans, decimal/fractional/
exponent/hex numbers, global properties and named blocks. It rejects malformed
syntax, unsafe property names, non-finite numbers and excessive input. Repeated
properties use their last assignment, as found in the supplied maps.

- Fractional vertex/thing coordinates, floor/ceiling heights, texture names,
  light levels, sidedef offsets, player-blocking/unpegging flags and thing
  elevations become native editable map data. The first player-one start and
  single-player hard-skill thing selection are retained. Walls/floors feed the
  existing Three.js renderer and Rapier collider generation.
- Cross-use of WAD flats and composed wall textures, package texture/flat
  resources and relative image paths is supported. The package dialog selects
  the root `freedoom2.wad` base by default if present; this does not establish
  full Doom II or game-specific behavior compatibility.
- `project.importSource` stores `{format:"udmf",mapName,namespace,globals,blocks}`
  as a validated snapshot of all original UDMF scalar properties, including
  unknown blocks/fields, specials, arguments and custom actor identifiers.
  It survives save/export/reload. The object/vertex/wall/sector inspector exposes
  the corresponding original block as read-only provenance. Editing native
  geometry does not rewrite that original snapshot or execute its properties.
- Unsupported source properties are enumerated in import notes. Slopes,
  3D floors, surface panning/rotation/scaling and colored lighting are not
  implemented by this step; line specials and each map's ACS module do execute,
  and dialogue is imported as data but not played. Out-of-range light levels are explicitly reported and clamped
  to 0–255 for the current renderer, with originals preserved. Missing material
  resources still produce visible fallbacks with warnings.
- The UDMF parser accepts the known `doom`, `zdoom`, `zdoomtranslated`, `hexen`,
  `heretic` and `strife` namespace identifiers; it does not implement every
  namespace's gameplay semantics. Other namespaces fail explicitly. TEXTMAP is
  bounded to 16 MiB, provenance to 24 MiB; existing editor geometry limits apply.

Authenticated HTTP surfaces: `GET /api/packages`, `POST /api/packages/inspect`
with `{name}`, `POST /api/packages/upload/inspect` with a binary PK3,
`POST /api/import/local-package` with `{name,map?,paths?,base?}`, and
`POST /api/import/package?map=...&images=0,1&base=...` with a binary PK3.
Image indexes refer to the inspection response's `images` array; omit `map` for
image-only import. Results contain `{assets,warnings}` or `{project,warnings}`.
These filesystem imports are not exposed as DeepSeek/MCP project-editing tools;
subsequent editing uses the same validated asset/project tools as WAD imports.

The renderer prefers WebGPU and falls back to WebGL 2, reporting the actual
backend and initialization/
image errors. It has no BSP/PVS culling or production performance guarantee on
large maps. Texture painting, sprite animation, audio and HUD editors are future
work. “WYSIWYG for everything” remains a product direction.

## DeepSeek setup

Copy `.env.example` to `.env`, set `DEEPSEEK_API_KEY`, and restart the server.
The default model is `deepseek-chat`; set `DEEPSEEK_MODEL` to another provider
model supporting the Chat Completions function-calling interface if needed.

The API key is never served to the browser, stored in projects, or returned by
MCP. No key is needed for ordinary editing. Requests go to
`https://api.deepseek.com/chat/completions` only after the user confirms sending
the project and prompt. Provider charges and data-handling terms apply.

DeepSeek receives project geometry, asset metadata and the prompt, not base64
image/model sources or arbitrary files from this workspace. Existing sources
are restored by ID when it proposes a full-project replacement. Projects with
metadata exceeding 500,000 characters are explicitly rejected for AI requests;
use MCP's targeted tools for large maps. DeepSeek can
only call the project tools below; it cannot execute code, read arbitrary files,
or run a shell. Responses are bounded to eight provider rounds with a shared
90-second deadline. Failed requests do not apply partial drafts. This is a
single-request assistant, not a persistent conversation or a general autonomous
agent. Real provider calls require your key and have not been verified by the
offline tests.

## MCP integration

Endpoint: `http://127.0.0.1:3000/mcp`, using stateless Streamable HTTP POST.
The server prints a random local bearer token on startup. For a stable token,
set `OPENDLE_TOKEN` to a long random secret in `.env`. Treat it like a credential.

Configure a Streamable HTTP-capable MCP host with:

```json
{
  "servers": {
    "opendle": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your-local-OPENDLE_TOKEN>"
      }
    }
  }
}
```

The example uses VS Code's MCP configuration shape; other hosts may use
`mcpServers` or a different header configuration. Keep actual credentials out of
version-controlled configuration.

| Tool | Purpose |
| --- | --- |
| `project_get` | Read the whole active project and revision |
| `project_set_title` | Rename the project |
| `project_replace` | Validate and replace the whole project |
| `map_add_room` | Add a rectangular closed room |
| `map_add_entity` | Place an object or move the single player start |
| `map_update_wall` | Edit wall color, height and collision |
| `sector_update` | Edit sector heights, surface image IDs, light and sky |
| `entity_set_visual` | Assign sprite/model, scale, elevation, animation or point light |
| `entity_set_physics` | Configure an object's Rapier primitive rigid body or sensor |
| `environment_set_visuals` | Choose sky projection/image and weapon overlay |
| `events_add_rule` | Add a scene/object rule with optional `ownerId`, extra AND `conditions` and `$self` targets |

Resource: `opendle://project`, an `application/json` project/revision snapshot.
The same tool operations power DeepSeek. DeepSeek uses an approval-only draft;
**external MCP calls deliberately edit and persist the server project directly**.
Use trusted MCP clients. Click **Reload server** to see their changes. Saving
stale browser edits returns a conflict rather than overwriting newer changes.
There is no remote hosting, OAuth, multi-user access or browser push-sync in this
milestone. Do not expose this development server to a network or reverse proxy.

For example, an `events_add_rule` call can attach a proximity + E-key event:

```json
{
  "ownerId": "pickup",
  "condition": { "type": "nearEntity", "entityId": "$self", "distance": 40 },
  "conditions": [{ "type": "keyPressed", "key": "KeyE" }],
  "actions": [{ "type": "removeEntity", "entityId": "$self" }],
  "once": true
}
```

Use an existing non-player entity's ID as `ownerId`. Omit it for a scene rule.

## Architecture

- `shared/project.js`: versioned project model, validation and editing helpers.
- `shared/runtime.js`: deterministic condition/action stepping, collision and
  ray intersection primitives.
- `shared/physics.js`: Rapier sector colliders, capsule controller, body/event
  synchronization and fixed stepping.
- `shared/gltf.js`: portable GLB/glTF parsing, resource bundling and validation.
- `shared/scene-edit.js`: shared grid-aware scene transform operations.
- `shared/engine-script.js`: editable Engine starter and shared command metadata.
- `shared/events.js`: validated event hierarchy and branch operations.
- `public/event-sheet.js`: compact rows and searchable command/parameter dialogs.
- `public/pointer-lock.js`: user-gesture pointer-lock requests and explicit errors.
- `public/scene-editor.js`: fly camera, picking, edit handles and placement.
- `shared/wad.js`, `shared/doom-assets.js`: bounded WAD geometry/image readers.
- `shared/udmf.js`: bounded UDMF parser and native geometry record normalization.
- `server/packages.js`: bounded PK3/directory reading, resource inspection and base-IWAD layering.
- `shared/doom-hud.js`: WAD artwork-to-editable-HUD, face and pickup rule import.
- `shared/player-state.js`: ammo, weapon/key inventory and player feedback signals.
- `shared/hud.js`, `shared/hud-style.js`: HUD schema, bindings, animation and scoped CSS.
- `public/hud-editor.js`, `public/hud-view.js`: WYSIWYG authoring and shared Play overlay.
- `shared/sectors.js`: sector boundary extraction, hole grouping and spatial
  lookup shared by validation, movement and rendering.
- `public/`: browser editor, Canvas layout renderer and Three.js WebGPU/WebGL preview.
- `server/`: local persistence, optimistic revision checks, shared tool
  operations, DeepSeek adapter and official MCP SDK transport.
- `test/`: engine, importer, persistence, HTTP, DeepSeek and real MCP-client tests.
- `Ancestors/`: supplied reference trees; untouched and never served by HTTP.

Project files have `version: 1`, `title`, `map` (vertices/walls/entities),
`environment`, numeric `variables` and `events`, with optional embedded `assets`
and `map.sectors` for visuals. Older projects without these fields still load.
Every mutation is validated
before persistence. All IDs share a namespace. Projects allow up to 20,000
vertices, 20,000 walls, 5,000 objects, 500 rules and 100 variables. WAD imports are
limited to 128 MiB and project HTTP bodies to 128 MiB. Embedded PNG sources are
limited to 6 MiB per image and 48 MiB shared image/model/font data, with up to
3,000 assets. Embedded sounds have a separate 64 MiB total, 12 MiB per source;
ordinary sound file uploads and package WAV/OGG/MP3 resources are limited to
8 MiB before base64 encoding.
WAD image decoding is bounded to 32 million aggregate pixels; malformed image
offsets, counts and posts fail explicitly. Undo history is bounded to 10
snapshots for asset-bearing projects (40 otherwise) to limit memory use.

The server is intended for one local user and one server process. Saves use an
atomic file rename and persist the project together with its revision, including
across server restarts. Exported project files contain only the portable project,
not server revisions. Browser backups can fail when storage is full or restricted;
the UI reports this and keeps edits in memory.

## Next milestones

1. Physics and model integration, sprite animations and richer material editing.
2. Doom II actors, physics/timing, specials, combat and compatibility fixtures
   using user-supplied IWADs or appropriately licensed test data.
3. Richer sector/door/light/audio editors and reusable no-code behaviors.
4. Capability-based extension APIs, richer MCP editing/inspection, AI visual
   draft comparison and integration tests against an opt-in live provider.
5. Implement and verify the GZDoom compatibility target, including UDMF,
   ACS/ZScript/DECORATE, package load order and custom HUD semantics, with
   editable OpenDLE representations and no reverse-compatibility requirement.
   A new browser-native runtime does not inherit these semantics automatically;
   compatibility needs runtime implementation and representative game fixtures,
   not just additional archive readers.

Visual scripting reference: [Docs/visual-scripting.md](Docs/visual-scripting.md).

### Standalone playable export

**Export playable app** builds a self-contained ZIP (`server/export-build.js`)
containing first-party engine files, the browser assets the studio serves from
`node_modules` (Three.js build, Rapier WASM loader, GLTF loader closure), the
exported project under `data/project.json`, this LICENSE, a build manifest and
both `launch.sh` and `launch.cmd`. No `node_modules` tree is copied: a
dependency-free `server/export-launcher.js` serves the bundle, and the launch
script opens an installed Chromium-based browser in `--app` window mode so the
game looks like a native window, falling back to the default browser with a
message. Requirements: Node.js 22+ and a Chromium-based browser. The bundle is
bounded (128 MiB, 10,000 files), uses safe relative paths only, and writes a
zip that the project's own archive reader accepts. A 68 MB Freedoom campaign
exports to a 23 MB zip that boots and serves its health endpoint from the
extracted folder.

This is a *portable* build, not a signed installer: there is no embedded browser
runtime (an embedded WebView would add a licence and a 100+ MB runtime per
platform) and GPU support is whatever the user's browser provides.

## License and references

OpenDLE: Studio uses the **OpenDLE: Studio Source-Available Commercial License v1.0**;
see [LICENSE](./LICENSE). It replaces the earlier local GPL declaration before
any public release. It is **not open source**. The license is effective
25 October 2026 and is self-drafted, not represented as legally reviewed.
The licensor is **Oleksandr Prokuronov**, acting as an individual.
Contact and royalty reporting: **korbazster2@gmail.com**. Payment instructions
are disclosed privately, case by case; bank details need not be published.
Bulgarian law governs, subject to applicable mandatory protections; court
jurisdiction is determined by applicable law. Future accepted terms may choose
a different governing law without automatically rewriting existing agreements.
Third-party npm dependencies retain their respective licenses; these terms do
not relicense third-party code or reference trees.

### Publishing on GitHub

The license permits source inspection, private modifications and distributing games
with their required runtime, but not independent redistributed engine forks.
Public GitHub repositories necessarily carry GitHub's platform viewing/forking
permissions; contribution-only forks are allowed, not independent engine releases.
Keeping all source forks technically impossible is incompatible with a public
GitHub repository.

The royalty basis is per-game lifetime **developer receipts** after store/payment
fees, sales taxes and refunds, not accounting profit:

Games generating **no receipts throughout their lifetime** are permanently
exempt under this license version: no royalties, minimum/license fees or royalty
reports are owed to the licensor. This does not waive government taxes or
third-party obligations. Free-to-download or non-profit status alone is not an
exemption: ads, game-related donations, sponsorships and optional purchases count
as receipts. Later monetization follows the normal threshold without charging
for the earlier zero-receipts period; a zero-receipts month does not erase an
existing balance or an already-triggered reporting obligation.

| Lifetime receipts | Total royalty (without subsequent refunds) |
| --- | --- |
| USD 9,999 | USD 0 |
| USD 10,000 | USD 200 |
| USD 12,000 | USD 240 |

The USD 200 becomes payable at the threshold, not only after further sales.
Afterward, 2% of each month's receipts is payable. Reports/payments are due
within 30 days after calendar month end. There is no automatic store withholding.
Before a game first reaches USD 10,000, no registration, revenue disclosure,
reports or financial evidence must be provided to the licensor. Developers
track the threshold themselves; the first report includes lifetime totals,
without separate reports for earlier below-threshold months.
Reports are self-declared statements, not routine submissions of store or bank
documents. The licensor may expressly accept figures on trust, waive supporting
documents, or simplify/waive reporting in writing for specified games and periods.
For example, accepting a self-declared USD 13,000 total without proof still
means USD 260 total royalties before prior payments/credits, unless payment is
separately waived or reduced. Financial records required by law remain required.
Payment is due only after private payment instructions have been supplied.
Until then, royalties accrue without being late; reports remain due on schedule.
If instructions arrive after the normal deadline, agree a payment date in
writing. The licensor may expressly waive payments or agree to a lower amount
in writing for an identified game and periods; silence is not a waiver, and
future royalties remain unchanged unless expressly agreed.
Game creators keep their own content; publishing does not require releasing
their private source modifications. Read the license for scope and deductions.

Contributions are voluntary. Before merging, obtain explicit contributor
permission to use, sublicense and relicense the submitted code in future releases;
a pull request alone is not sufficient under this license. Contributors keep
copyright. There is **no annual expiry**. When updated license terms are
presented through the finalized notice procedure, tool use outside the
educational fallback requires explicit acceptance, including when using an
older engine version. Declining is not automatic acceptance of unknown terms.
Users may keep their already-obtained version for private, non-commercial
learning, teaching and research under their last accepted license, including
private exercises and prototypes, without annual expiry. This fallback does
not permit monetization, paid development services, development for commercial
release, new public game releases (even free ones), source redistribution or
access to newer engine versions. Existing royalties and reporting remain due.

Already-released game builds remain distributable/playable under their original
terms, including royalties on future receipts and the zero-receipts exemption.
Outside the private educational fallback, new games, updates, ports and DLC
developed after notice require acceptance and
follow the newly accepted terms, without retroactively changing older builds.
Acceptance does not reset game receipts or charge the threshold royalty twice;
mixed-release/bundle revenue allocation must be specified in updated terms.

Online license checking and changed-term acceptance prompts are **planned only,
not implemented**. Until the notice-and-acceptance mechanism is implemented and
actually presents updated terms, accepted tool permissions continue without a
time limit. Publishing new terms alone does not block tool use. No online check,
registration or periodic renewal is currently required. Notice, acceptance
records and offline behavior must be specified before activation. Qualified
legal review remains recommended, not a condition suspending the license grant.

Before publishing, inspect the actual upload: `.gitignore` excludes local
`Ancestors/`, `Projects/`, `data/`, `.env` and installed dependencies, but does not
remove previously tracked files and does not protect manual ZIP uploads.
Do not upload proprietary Construct distributions, commercial IWADs, mods without
redistribution permission, saved projects containing their assets, or secrets.
Keep dependency licenses/notices when redistributing those components and review
transitive dependencies and any copied code. This is licensing guidance, not a
completed provenance audit or legal advice.

The supplied GZDoom tree declares GPL v3 and includes additional component
notices. GDevelop's engine/editor code declares MIT; its name and logo are
reserved by their owner. Their references informed the WAD record layout and
condition/action design; no engine/editor implementation or branding was copied
into this foundation. `Ancestors/` retains its own licenses and notices;
its GPL components cannot simply be relicensed under these commercial terms.

The supplied `Ancestors/Construct2/` contains Windows distributions, not an
open-source reference implementation. Its executables were not run, decompiled,
copied into OpenDLE or served by the local server. Construct's name, software and
assets remain their owners' property. Workspace patterns were informed by the
[official Construct 3 interface documentation](https://www.construct.net/en/make-games/manuals/construct-3/overview/the-interface)
and implemented independently.

Doom and Doom II are names belonging to their respective owners. Users must
provide game data they are entitled to use. This project does not distribute
commercial IWADs or imply endorsement by the upstream projects.
