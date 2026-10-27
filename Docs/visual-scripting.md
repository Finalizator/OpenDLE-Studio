# Visual scripting

OpenDLE has no scripting language and no hidden built-in gameplay engine. Every
rule that makes a game behave is an editable **event**. Imported games arrive as
ordinary events, so you can inspect, disable, reorder or rewrite them.

This document is the reference for the event model, both authoring scopes, the
execution order, and the full condition/action catalogue. The catalogue is
written by hand but kept honest by `test/docs-catalogue.test.js`, which fails if
`shared/engine-script.js` or `shared/project.js` gains a command this file does
not list.

- Editor: **Events** panel (`public/index.html`, `public/event-sheet.js`)
- Model and validation: `shared/events.js`, `shared/project.js`
- Catalogue: `shared/engine-script.js`
- Execution: `shared/runtime.js` (`stepRuntime` → `runRules`)

---

## 1. The object model

```
Project
├── eventSheets[]      named sheets of rules (engine / game / object)
├── eventGroups[]      optional toggleable groups inside one sheet
├── events[]           flat list; order = execution order
│   ├── condition      trigger or comparison
│   ├── conditions[]   up to 15 additional conditions (AND/OR)
│   ├── actions[]      what happens
│   └── parentId       optional sub-event (nested, contiguous with parent)
├── variables{}        project-wide variables (`score`, `lives`, ...)
└── map.entities[]     objects; each may carry `variables{}` and `ownerId` rules
```

An event is a row of `condition → actions`. Conditions are evaluated with AND by
default; set **Condition logic = Any condition (OR)** on the event, or invert an
individual condition (**NOT**).

Every event has, at minimum:

| Field | Meaning |
| --- | --- |
| `id` | stable identifier, used by save games and sub-events |
| `condition` | the trigger (for example `onStart`, `keyPressed`, `always`) |
| `conditions[]` | extra filters (comparisons, ownership, state) |
| `actions[]` | ordered list executed top to bottom |
| `once` | run at most once per level instance |
| `enabled` | keep the rule but stop it running |
| `sheetId` | which sheet (and therefore phase) it belongs to |
| `groupId` | optional toggleable group |
| `parentId` | makes it a sub-event of another event |
| `ownerId` | object instance this rule belongs to (**object scope**) |
| `forEachType` | apply the rule to every object of a type (**object scope**) |

Sub-events run only when their parent's conditions pass and its actions finished,
which is how imported weapon and enemy state chains are expressed visually.

---

## 2. Two authoring scopes

Both scopes are the same kind of data and run in **one** top-to-bottom order. The
scope tells you (and the editor) who owns the behaviour.

| Scope | Created by | Use it for | Example |
| --- | --- | --- | --- |
| **Game** (engine-wide) | rules with no `ownerId` and no `forEachType` | input, camera, campaign flow, menus, HUD, scoring, global timers | `onStart → set game screen`, `keyPressed(Space) → jumpPlayer` |
| **Object** (local) | `ownerId` (one instance) or `forEachType` (a type) | behaviour that belongs to an object | "this pickup: when the player is near, add score and destroy itself" |

Rules of thumb:

- **Engine-wide** rules are the only ones that should change campaign state,
  game screens, settings or global variables that describe the whole session.
- **Object** rules should only touch *their own* object (use `$self`) unless they
  explicitly target another object. Destroying, moving, scaling, damaging or
  animating `$self` is local behaviour.
- Imported games follow this split automatically: player/input/weapon/HUD rules
  land in engine sheets, enemy and pickup behaviour is object-owned.

Object-scope **sheets** (`section: "object"`) enforce the split: they may only
contain object-owned or for-each rules. Engine/game sheets stay permissive so
imported projects remain valid. Create one from
**Project → Object scripts → + New object script sheet**.

`$self` inside an object rule means "the object this rule belongs to". In a
for-each rule, `$self` is each instance in turn.

---

## 3. Sheets and execution phases

A sheet groups rules and decides **when** they run in a frame:

| Phase | Runs | Typical contents |
| --- | --- | --- |
| `beforePhysics` | before movement and collision | input, jump, mouse look, player state |
| `afterPhysics` | after movement and collision | damage, pickups, enemy logic, doors |
| `interface` | every frame including menus | menus, HUD, save/load screens, pause flow |

Within a phase, sheets run in project order, and inside a sheet rules run top to
bottom. A disabled sheet, or a disabled group, skips its rules without deleting
them.

Frame order in `stepRuntime`:

1. advance HUD interface clock, run `interface` rules
2. if a menu is open, stop here (gameplay is paused)
3. advance sectors, handle "use"
4. run `beforePhysics` rules
5. player movement, physics step, bunnyhop (engine tweak), crossings
6. run `afterPhysics` rules
7. projectiles, statistics, timers sampling

If a rule changes the game screen to a menu or the intermission, remaining
gameplay rules in that frame stop immediately. This is intentional: a level
finish must not keep simulating.

---

## 4. Writing a rule (editor walkthrough)

1. **Events** tab → choose a scope in the tree: **Engine**, **Game event sheets**,
   **Object scripts**, or **All events**.
2. **+ Add event** → pick an object/system category → pick a trigger → pick
   actions. Parameters accept numbers, text, booleans or an **expression**
   (prefix with `=` in a text field).
3. Reorder with the branch commands; nest by making a sub-event.
4. Every change is validated and undoable. Save (Ctrl/Cmd+S) writes the project.

Expressions can read project variables (`score`), object variables
(`$self.health` style accessors where available), player stats (`health`,
`armor`, `bullets`), settings and time. See `shared/expressions.js` for the exact
supported grammar.

---

## 5. Common patterns

**Pickup** (object scope, `forEachType: pickup`)

```
condition: playerReachesEntity(distance 36, height 56, below 8)
actions:   addVariable score 1
           playSound DSITEMUP
           destroyEntity $self
```

**Timed trap** (game scope)

```
condition: wallActivated(mode use, wall w12)
actions:   startTimer trap 2
           moveSector(room0.ceilingHeight, height 0, speed 40, wait 3, return)
condition: timerReady trap        → showMessage "The ceiling lowers!"
```

**HUD button** (game scope, interface phase)

```
condition: hudClicked(element pause_button)
actions:   setGameScreen pause
```

**Save slot** (from imported menus)

```
condition: hudClicked(slot_1)
actions:   saveGame(slot 1)        // overwrite asks for confirmation first
           loadGame(slot 2)
```

---

## 6. Engine tweaks (the only non-project settings)

These are editor/browser preferences stored per browser, not part of a game:
field of view, render resolution, brightness, mute, jumping toggle, and the
optional **simulated bunnyhop** (speed gain while chaining jumps). Everything
that defines how a game plays lives in editable events; tweaks only affect the
local preview and the exported build's defaults.

Bunnyhop is deliberately simulated rather than an automatic jump hack: leaving
the ground while still chaining a jump keeps a speed multiplier that decays when
the chain breaks. It is off by default and tuned by `bunnyhopGain`.

---

## 7. Persistence and multiplayer notes

- Save games serialize the runtime produced by these events (player, inventory,
  entity health/variables, timers, sector motion, spawned objects). Rules that
  create objects at runtime mark them with `spawnedFrom` so a save can be
  validated against its template.
- Events are deterministic given the same inputs, which is the basis for the
  planned authoritative multiplayer mode; see `Docs/multiplayer-plan.md`.

---

## 8. Limits

- 2048 events, 100 sheets, 200 groups, 15 extra conditions per event.
- Sub-events nest at most 16 levels and must stay contiguous with their parent.
- There is no separate per-project rule cap: the 2048-event limit is the real
  bound. Prefer for-each rules over duplicating one rule per object instance.
- Expression evaluation is bounded (finite numbers, bounded depth) and cannot
  call arbitrary JavaScript.

---

## 9. Custom objects and Blockbench models

Imported or authored 3D objects are ordinary objects with a model asset, and they
use the same visual scripts as sprites:

| Task | How |
| --- | --- |
| Bring in a model | **Import model** (`#import-model`) accepts Blockbench `.glb`/`.gltf` with its `.bin` and textures; they are bundled into one portable asset (`shared/gltf.js`). |
| Place it | Set `modelAsset` on an object (Properties) or drag the model asset onto an object; `modelScale` scales it. |
| Animate it | `playAnimation` / `stopAnimation` select the glTF clip by name; `animationFinished` is a condition. |
| React to gameplay | Any target action works: `setEntityPosition`, `rotateEntity`, `applyImpulse`, `setVelocity`, `setGravityScale`, `setDamping`, `setEntityHealth`, `destroyEntity`, `setEntityScale`. |
| Duplicate at runtime | `spawnEntity` clones a template object (sprite or model) at a position; the copy keeps `spawnedFrom` so saves validate against the template. |
| Per-instance state | Object variables (`setObjectVariable`, `addObjectVariable`, `objectVariableCompare`) and `$self` targeting. |

Blockbench tips: export **GLB** (single file) unless you need external
textures; keep textures at or below 4096x4096 (the renderer caps per-texture size
and 32 million decoded pixels per preview); name clips exactly as the scripts
reference them (for example `walk`, `attack`) so `playAnimation` resolves them.

Physics scripts only affect objects whose Physics body is `dynamic` or
`kinematic`; a spawn without a body is visual-only until you add a body in
Properties.

## 10. Full catalogue

The tables below are generated from `shared/engine-script.js` and the legacy
command lists in `shared/project.js`. "Target" means the action/condition needs
an object (`entityId`); `$self` is available inside object rules.

### Conditions

| Trigger / comparison | Type | Needs object | Parameters |
| --- | --- | --- | --- |
| level entered with campaign inventory | `levelTransition` | — | — |
| active menu / gameplay screen | `gameScreen` | — | screen |
| effect is enabled | `shaderEnabled` | — | — |
| compare math / text expressions | `expressionCompare` | — | left, operator, right |
| compare local variable | `objectVariableCompare` | yes | variable, operator, value |
| overlaps pickup reach | `playerReachesEntity` | yes | distance, height, below |
| touching a surface | `playerTouchingSurface` | — | surface |
| is on the ground / airborne | `playerAirborne` | — | state |
| inside this object interaction area | `playerInArea` | yes | — |
| entered this object interaction area | `playerEnteredArea` | yes | — |
| health decreased | `entityDamaged` | yes | — |
| is alive (health above zero) | `entityAlive` | yes | — |
| compare distance between two objects | `distanceBetween` | yes | otherId, operator, distance |
| sprite animation state | `spriteState` | yes | state |
| remembers player | `enemyAlert` | yes | — |
| hears player weapon through open sectors | `enemyHearsPlayer` | yes | — |
| player uses, crosses or shoots linedef | `wallActivated` | yes | mode |
| sector surface is moving | `sectorMoving` | yes | surface |
| player visible in range | `enemySeesPlayer` | yes | range, fov |
| Doom distance-based attack decision | `enemyAttackChance` | yes | — |
| owns weapon | `weaponOwned` | — | weapon |
| selected weapon | `weaponSelected` | — | weapon |
| owns key | `keyOwned` | — | key |
| owns backpack | `backpackOwned` | — | — |
| ammo below capacity | `ammoBelowCapacity` | — | ammo |
| every N seconds | `everySeconds` | — | seconds |
| random chance (0-1) | `randomChance` | — | probability |
| count of live objects | `objectCount` | — | entityType, operator, value |
| compare facing angle | `entityAngle` | yes | operator, value |
| compare feedback signal | `playerFeedback` | — | signal, operator, value |
| face expression | `playerFace` | — | expression |
| Doom thing type | `entityDoomType` | yes | doomType |
| animation is playing | `hudAnimationPlaying` | — | — |
| on element clicked | `hudClicked` | — | — |
| element selected / focused | `hudFocused` | — | — |
| on animation finished | `hudAnimationFinished` | — | — |
| player stat changed | `hudStatChanged` | — | stat, direction |
| group is active | `groupActive` | — | — |
| key / mouse button held | `keyHeld` | — | key |
| mouse moved | `mouseMoved` | — | — |
| compare stat | `playerStat` | — | stat, operator, value |
| compare health | `entityHealth` | yes | operator, value |
| has explicit health | `entityHasHealth` | yes | — |
| timer ready | `timerReady` | — | timer |
| timer exists | `timerExists` | — | timer |
| compare variable | `variableCompare` | — | operator, value |
| onStart | `onStart` | — | — |
| always | `always` | — | — |
| keyPressed | `keyPressed` | — | — |
| nearEntity | `nearEntity` | yes | — |
| collisionStarted | `collisionStarted` | yes | — |
| collisionEnded | `collisionEnded` | yes | — |
| isTouching | `isTouching` | yes | — |
| playerGrounded | `playerGrounded` | — | — |
| animationFinished | `animationFinished` | — | — |

### Actions

| Action | Type | Needs object | Parameters |
| --- | --- | --- | --- |
| save to slot | `saveGame` | — | slot |
| load slot | `loadGame` | — | slot |
| confirm overwriting save | `confirmSaveGame` | — | — |
| open menu / resume | `setGameScreen` | — | screen |
| start a new game | `startGame` | — | — |
| select new game episode | `selectGameEpisode` | — | levelId |
| load a level | `loadGameLevel` | — | levelId |
| finish level / follow exit | `finishLevel` | — | exit |
| continue after level intermission | `continueIntermission` | — | — |
| return to editor | `quitGame` | — | — |
| toggle fullscreen | `requestFullscreen` | — | — |
| reset user settings | `resetGameSettings` | — | — |
| rebind a control | `captureGameBinding` | — | key |
| set user setting | `setGameSetting` | — | setting, value |
| adjust user setting | `adjustGameSetting` | — | setting, amount |
| toggle user setting | `toggleGameSetting` | — | setting |
| enable / disable effect | `setShaderEnabled` | — | enabled |
| set numeric uniform | `setShaderUniform` | — | uniform, value |
| set local variable | `setObjectVariable` | yes | variable, value |
| add to local variable | `addObjectVariable` | yes | variable, value |
| play sprite state | `setSpriteState` | yes | state, restart |
| play firing animation | `playWeaponClip` | — | weapon |
| move sector surface | `moveSector` | yes | surface, height, speed, wait, returnMode, returnHeight, sound |
| play embedded sound by name | `playSound` | — | sound, volume |
| spawn a new object from a template | `spawnEntity` | — | templateId, x, y, z, angle, name |
| set visual scale | `setEntityScale` | yes | scale |
| set gravity scale | `setGravityScale` | yes | scale |
| set linear damping | `setDamping` | yes | damping |
| move toward player with collision | `moveEnemy` | yes | speed |
| face player for attack | `facePlayer` | yes | — |
| trace shot at player | `enemyHitscan` | yes | damage, diceSides, range, spread, pellets |
| launch projectile from player | `launchProjectile` | — | speed, damage, diceSides, radius, color, sound, clipId, impactClipId |
| launch projectile at player | `enemyProjectile` | yes | speed, damage, diceSides, radius, color, sound, clipId, impactClipId |
| set weapon ownership | `setWeaponOwned` | — | weapon, owned |
| select owned weapon | `selectWeapon` | — | weapon |
| set key ownership | `setKeyOwned` | — | key, owned |
| add ammo (capacity limited) | `addAmmo` | — | ammo, amount |
| give backpack (double capacities once) | `giveBackpack` | — | — |
| set face expression | `setPlayerFace` | — | expression |
| set cursor / game input mode | `setHUDCursor` | — | mode |
| set element visible | `setHUDVisible` | yes | visible |
| set text (clears binding) | `setHUDText` | yes | text |
| bind text / bar to engine value | `setHUDBinding` | yes | binding |
| set numeric property | `setHUDProperty` | yes | property, value |
| play / restart animation | `playHUDAnimation` | — | — |
| stop animation (hold pose) | `stopHUDAnimation` | — | — |
| set group active | `setGroupActive` | — | active |
| add local movement | `movePlayer` | — | forward, strafe |
| turn (degrees / second) | `turnPlayer` | — | speed |
| apply mouse movement | `mouseLook` | — | sensitivity, vertical |
| request jump | `jumpPlayer` | — | — |
| rotate by (degrees, relative) | `rotateEntityBy` | yes | angle |
| set model tilt (pitch / roll) | `setEntityTilt` | yes | pitch, roll |
| set view pitch (degrees) | `setPlayerPitch` | — | pitch |
| set gravity direction (walk on that surface) | `setPlayerGravity` | — | mode, reach |
| set stat | `setPlayerStat` | — | stat, value |
| add capped stat | `addPlayerStat` | — | stat, value, maximum |
| damage through armor | `damagePlayer` | — | damage, direction |
| set health | `setEntityHealth` | yes | health |
| trace and damage enemies | `hitscan` | — | damage, diceSides, pellets, spread, range |
| start timer (seconds) | `startTimer` | — | timer, seconds |
| clear timer | `clearTimer` | — | timer |
| show / hide overlay (legacy stats) | `showPlayerHUD` | — | visible |
| showMessage | `showMessage` | — | — |
| setVariable | `setVariable` | — | — |
| addVariable | `addVariable` | — | — |
| teleport | `teleport` | — | — |
| removeEntity | `removeEntity` | yes | — |
| setEntityPosition | `setEntityPosition` | yes | — |
| rotateEntity | `rotateEntity` | yes | — |
| applyImpulse | `applyImpulse` | yes | — |
| applyForce | `applyForce` | yes | — |
| setVelocity | `setVelocity` | yes | — |
| playAnimation | `playAnimation` | yes | — |
| stopAnimation | `stopAnimation` | yes | — |

Object types usable with **For each**: `player`, `enemy`, `pickup`, `light`, `decoration`.

Object-type commands that need a wall, sector, HUD element or sprite clip validate those references too; a rule that points at a deleted object fails validation with a specific message instead of silently doing nothing.
