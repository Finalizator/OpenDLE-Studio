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

For a practical walkthrough, see
[Node editor, terminals and doors](node-editor.md). It includes importing the
saved keypad, authoring a local script and connecting a signal to a specific door.

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
One-shot/edge triggers cannot be inverted; the editor hides NOT for them and
validation rejects it, including periodic, area-entry and zone-entry triggers.

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
Changing a root event's **Owner** or **For each** also updates its descendants;
change the parent rather than assigning a child a different object context.
Reusable scenes validate the same hierarchy before they are placed.

Deleting an object used by scripts lists the affected rules and timeline cues,
including `object("id", "variable")` and `property("id", "x")` references in
expressions. **Delete them too** removes any affected condition's entire branch,
not just the condition: its old actions must never become unconditional. Pure
action references are removed individually; unrelated actions and parent gates
with surviving children remain.

**Keep them and put an empty object in its place** re-points explicit and
expression references to a stand-in. It retains object type, local variables,
declared signals, health, interaction area and rigid body so the kept script
still validates. Artwork is removed unless model-animation rules need the model.
Deletion or replacement is one undoable edit, restoring objects and scripts
together. Removing a route or timeline also cleans its reusable-scene references;
removing a waypoint adjusts scene-script indices as well.

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

### Picking instances (GDevelop and Construct semantics)

A rule is about a **set of instances**, and its conditions narrow that set. This
is the model both GDevelop and Construct use, and it is why a single rule can act
on "the enemies below 5 health" without a loop:

| Rule piece | Command | Effect |
| --- | --- | --- |
| pick every instance | **Pick all instances** | resets the type to all of them |
| pick by a property | **Pick instances by property** | keeps the instances where `health > 0`, `x < 400`, … |
| pick by a local variable | **Pick instances by local variable** | keeps the instances whose variable matches |
| pick the nearest / furthest | **Pick nearest instance** | keeps the closest N to the player or to another object |
| pick a few at random | **Pick random instances** | keeps N distinct instances |
| how many are picked | **Picked instance count** | a condition to branch on |
| act on the pick | **Set picked instances' …** | position, angle, scale, sprite state, local variable, removal |

Semantics that matter when you write a rule:

- **Sub-events inherit the pick.** A child rule acts on the parent's narrowed set,
  never on every instance of the type. Each sibling starts with the parent's set,
  not the previous sibling's narrowing.
- **Owned rules start with their owner picked.** Descendants retain the parent's
  selection, including an explicit **Pick all** or a newly spawned instance.
- **NOT filters individual instances.** An inverted property or variable pick keeps
  the instances that fail its predicate, within the incoming selection.
- **OR unions successful selections.** Branches evaluate independently; a successful
  non-picking condition retains the incoming selection.
- **An empty pick is not "all instances".** If a pick selected nothing, the rule
  does not run. This is what "no enemies left to hurt" has to mean.
- **A for-each rule iterates the pick.** `for each (enemy)` under a pick visits
  only the picked enemies, and inside the loop the pick is narrowed to that one
  instance, so `$self` and the picked-instance actions agree.
- **A spawned instance becomes the pick.** After **Object: spawn a new object from a template**, the following
  actions apply to the new instance only, exactly as in GDevelop.
  Non-player templates also supply their object-owned rules and autoplay animation.
  Each copy has independent once flags, including across saved games.
- **Expressions follow the pick.** `property("enemy", "health")` and
  `count("enemy")` read the instances the current rule is about; outside a rule
  they mean every instance of the type. Picked actions evaluate expressions once
  per target: setting `score` to `property("enemy", "health")` copies each enemy's
  own health, rather than copying the first enemy's health to everyone.
  `count("enemy")` still counts the entire picked group during those assignments.
  Counting a destroyed authored instance by ID returns zero.
- For-each `$self` pickers offer local variables, signals and model clips shared
  by the matching instances. Editing a plain ancestor preserves an independently
  nested for-each scope; incompatible context changes are rejected without
  partially changing the branch.
- **Variables keep their declared scalar type.** Numeric addition never concatenates
  text; booleans support equality and inequality, not ordering comparisons.
- Reading a variable from an instance that lacks it picks nothing rather than
  failing, the way an undeclared object variable behaves in GDevelop. Authoring
  still refuses a pick where no instance of the type carries the variable at all.

Read-only properties (`property("id", "name")`) cover position (`x`, `y`, `z`,
`elevation`, `floorHeight`), orientation (`angle`, `pitch`, `roll`, `facing`),
size (`scale`, `width`, `height`, `depth`, `radius`), state (`health`, `alive`,
`speed`, `vx`, `vy`, `vz`, `grounded`, `opacity`), animation (`animation`,
`animationClip`, `animationTime`, `animationFrame`), identity (`type`, `name`,
`id`, `doomType`, `count`) and per-type extras (`lightIntensity`, `lightRadius`,
`cameraFov`, `cameraPitch`, `cameraHeight`). `shared/instance-properties.js` owns
the list, so the picker, the comparison, the assignment and the pick all answer
the same question the same way.

Position, floor height, elevation and player health follow the live world.
Velocities and speed use map units per second; angles use degrees.
Floor/elevation include solid 3D-floor platforms. Orientation follows live model
rotation, and sizes include visual nodes and the built-in player capsule.
Animation frames are zero-based, wrap for looping clips and clamp to the final
frame for non-looping clips, including the implicit stand animation.
Scale and opacity read the actual sprite/model/node visual settings.

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

**Delete sheet and rules**, including removal through Engine scriptlets, also
removes the sheet's groups and its rules in reusable scenes. If another rule or a
timeline cue still references one of those groups, deletion is refused without
changing the project. Remove those references first.

### Engine scriptlet files

The **Engine scriptlets** window loads modules from the engine's top-level
`scriptlets/` folder. Each built-in is a separate file. To add your own, place a
`.js` or `.mjs` file there and open the window or click **Reload folder**; there is
no central list to edit and no server restart required. Follow the
[module format and example](../scriptlets/README.md).
The [scriptlet guide](scriptlets.md) covers installation, updates, removal and
testing; [extensions (addons)](extensions.md) explains how to add new condition
and action types rather than just generate existing events.

Invalid modules are reported by filename without hiding valid scriptlets.
Scriptlets execute with the editor's privileges: only use code you trust.
Installation, reinstallation and removal remain undoable project edits.
Installed events are saved with the project and run without the original module;
deleting the module does not remove rules already installed.
Built-in sheets keep a stable scriptlet identity, so renaming them does not create
duplicates or redirect removal to an unrelated same-named sheet. Empty scriptlet
sheets (and leftover surf ramps after deleting rules) remain removable from the
window. Custom install/remove edits isolate campaign data, assets and actors so
errors cannot leak changes into the live project or its undo history.

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

**Arrays** are 2D grids owned by the project, drawn cell by cell in the
**Environment** tab. A rule reads a cell with
`array("grid", row, column)` — both indexes count from zero, first is the row —
and asks a grid its size with `arrayrows("grid")` and `arraycolumns("grid")`.
The name is always literal; the row and column may be any expression, so a
counter can walk a grid. `setArrayCell` writes a cell (its value may be
`=…`, so `=array("grid", 0, 0) + 1` copies a cell upwards), `addToArrayCell`
adds to a numeric cell, and `expressionCompare` branches on one. Every array
holds one type of value — numbers or text — and a row or column outside the grid
is refused while the rule is being written rather than when it runs.
Exponentiation precedes a leading sign (`-2 ^ 2` is `-4`). Text slice counts
and offsets truncate fractional values; replacement text is literal, including `$`.

---

## 5. Common patterns

**Pickup** (object scope, `forEachType: pickup`)

```
condition: playerReachesEntity(distance 36, height 56, below 8)
actions:   addVariable score 1
           playSound DSITEMUP
           destroyEntity $self
```

**Picked wave** (game scope, acts on a set of instances without a loop)

```
condition: everySeconds(2)
condition: pickByProperty(enemy, health > 0)         // narrow to the living ones
actions:   setPickedVariable enemy score 1           // every living enemy
           setVariable living = count("enemy")     // before narrowing further
  sub-event:
  condition: pickNearest(enemy, to $player, nearest, count 1)
  actions: movePicked enemy dx 0 dy 0 dz 8          // only the nearest lifts
           setVariable nearestHealth = property("enemy", "health")
```

All conditions in a rule run before its actions; use a sub-event when an action
must run before a further pick.

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

### Save files a rule writes and reads

The save slots above are the *player's* saves, reached through the game's SAVE and
LOAD menus. A rule can also keep something of its own, as a `.json` document:

| What | Action | What it does |
|---|---|---|
| Variables | `saveVariables` (`file`, optional `variables`) | Writes the project variables — all of them, or the comma-separated ones named — into a save file. |
| Variables | `loadVariables` (`file`) | Reads the file back and **replaces the live variables** with the saved values. A value that no longer fits — a variable that was renamed, or a number that became text — is skipped and reported instead of being written. |
| Whole game | `saveGameState` (`file`) | Writes the whole runtime — the very record a save slot holds — with no menu and no overwrite prompt: the checkpoint a rule decides on. |
| Whole game | `loadGameState` (`file`) | Resumes that file, including the campaign level it names. |

Both kinds of read happen **inside the rule that asked for them**, so an action after a
`loadVariables` already sees the loaded numbers — a checkpoint restored and then added to
gives the expected total, not one added to the values it replaced. The whole-game kind is
the exception: resuming restarts the preview, so it is a request the host handles after the
rule finished, and the actions after it still run on the game it is replacing.

A `variables` file remembers the game that wrote it, and a rule that loads one written by a
different game is refused with the file's name rather than overwriting the live variables
with a stranger's numbers. A saving rule also hears about a value JSON cannot hold: `NaN`,
`Infinity` and `undefined` have no place in a `.json` document, so the save fails with
`Cannot save score: a number has to be finite` instead of quietly writing `null` for the
load to refuse later. The identity is a digest of the project; on a page the browser does
not treat as secure (`http://` on a LAN address, where `crypto.subtle` is missing) it is a
plain checksum with its own prefix, so previews still run and saves still match their game.

Two conditions read the same index: `saveFileExists` (`file`) asks whether a save
file of that name is stored, and `saveFileFailed` reports that the last write or
read did not complete (a full disk, a corrupt document, a name the host does not
have). A rule can therefore save, branch on whether it worked, and load a
checkpoint only when one exists.

The document is plain JSON — `format: "opendle-save-file"`, `version: 1`, and a
`kind` of `variables` or `game` — so it is a file a player can keep. **Save
files…** in the play toolbar downloads any of them as `<name>.json`, deletes one,
or imports a file back; importing validates the document before storing it, so a
hand-edited or foreign file is refused with the reason rather than half-loaded,
and importing over a name the browser already holds asks first instead of throwing
the player's own save away.

The running game holds only the *names* of the files it may read, so a whole-game
save never carries every other save file inside it. Both kinds live with the host
(the browser for a preview or an exported game) under the name the action gave.

---

### Imported monsters are rules too

The same split applies to every imported monster: what it **decides** is a rule, what it
**is** stays its DECORATE states. Each archetype in the actor table gets four rules in the
Enemies sheet:

| Rule | Condition | Actions |
|---|---|---|
| notices the player | `enemySeesPlayer` (the actor's own `LOOKALLAROUND` picks 180° or 360°) | `playActorState` (`See`), start the alert timer |
| chases | the alert timer is running | `moveEnemy` at the actor's own speed, `playActorState` (`See`) |
| attacks | alerted, not already in `Melee`/`Missile`, `oncePerTic`, the Doom distance roll (`enemyAttackChance`) allows it, the last attack finished | `facePlayer`, `playActorState` (`Missile`, or `Melee` for a claw-only monster) |
| melee when close | alerted, not already attacking, `oncePerTic`, within `P_CheckMeleeRange` of the actor's radius | `facePlayer`, `playActorState` (`Melee`) |

Two conditions in those rows exist for the same reason: Doom decides once a tic and plays an
attack out to its end. `oncePerTic` keeps the attack roll at 35 Hz however fast the machine
draws frames, and the not-attacking test stops the rule re-entering `Missile` while it is
already there — a restart instead of a play, which froze monsters in their firing pose and made
them look like they were flapping. The walk itself carries no such gate: `moveEnemy` takes the
frame time, so a monster covers 8 map units a tic (280 a second) at 30, 60 or 144 frames.

A UDMF or Hexen line is a rule too: the import writes `Linedef <id> / <Special_Name>` with
the line's activation modes as conditions and `runLineSpecial` (`special`, `arg1`…`arg5`)
carrying the special and its arguments, then marks the wall so the engine does not run the
same line a second time. The special table itself is the one the runtime uses, so the rule
and the line cannot disagree.

An ACS script can be started from a rule with `runScript` (`script`, `arg1`…`arg3`). A level's
`OPEN` and `ENTER` scripts are written that way at import: one rule per script in the World
sheet, whose number is recorded in `mapScripts.ruleScripts` so the interpreter no longer
starts it — one script, one starter. Where a script's body is constants, line specials, waits
and counters, the rules describe it instead of starting the script at all
(`shared/acs-decompile.js`): the specials appear as `runLineSpecial` actions, and a wait splits
the script into steps — a delay becomes the next step's `startTimer`/`timerReady`, a `TagWait`
becomes `sectorTagMoving` staying false, a line whose `ACS_Execute` names such a script carries
the script's steps itself (with timers named after the line), and each step clears the timer it
waited on so it runs once.

The script's variables stay where the level keeps them, so a rule and a script that was not
decompiled see the same numbers: `setAcsVariable` (`scope`, `index`, `mode` `set`/`add`,
`value`) writes one, `acsVariable` (`scope`, `index`, `operator`, `value`) asks about one, and
`acsvar("map", 2)` reads one inside any expression. An array element is reachable the same
way: `ASSIGNSCRIPTARRAY` is the `setAcsArray` action (`scope`, `id`, `index`, `mode`
`set`/`add`, `value`) and `PUSHSCRIPTARRAY` is `acsarray("script", 1, 0)` in an expression,
both against the store the interpreter keeps, so a script that was not decompiled and a rule
that was read the same elements. A guard — ACS `if`, compiled as
`IFNOTGOTO` — becomes a sub-event of the step, evaluated after the actions above it, so
`count += 1; if (count >= 2) open the door` reads exactly as it does in the script, and an
`if`/`else` becomes two sub-events with opposite tests, so exactly one branch acts. A body
with a loop, or one that only *increments* an array element, is left as the compiled module,
shown disassembled in the Scripts tab,
because a rule that ran half a script would be worse than one that runs none. A flat or texture
the script kept in a variable is read when the rule runs, with `acsflat("map", 12)` — the same
string table, the same index, so `ChangeFloor(map11, map12)` is still that call. A script that
takes arguments (`script 5 (int tag, int tics)`) is read with the numbers its line passes in
`ACS_Execute(5, map, tag, tics)`; a caller that passes nothing leaves the script as bytecode,
because a rule cannot invent an argument.

The builtins a script calls directly are actions too, and they run the interpreter's own host
functions so a decompiled script and a bytecode one change the level identically:
`setSectorFlat` (`surface`, `tag`, `flat` — ACS `ChangeFloor`/`ChangeCeiling`),
`setLineTexture` (`line`, `side`, `part`, `texture`),
`replaceTextures` (`from`, `to`, `flags` — ACS `ReplaceTextures`, where the flags name the
surfaces to leave alone: 1 upper, 2 middle, 4 lower, 8 floor, 16 ceiling), `setLineBlocking` (`tag`, `blocking`),
`setLineMonsterBlocking` (`tag`, `monsters`) and `setLineSpecial` (`tag`, `special`,
`arg1`…`arg5`), and ACS `FadeTo` is the `fadeTo` action (`red`, `green`, `blue`, `amount`,
`seconds`) — a constant is converted out of ACS's 16.16 fixed point in the sheet, a variable is
divided at run time — and `fadeRange` (`redFrom`, `greenFrom`, `blueFrom`, `amountFrom`, `red`,
`green`, `blue`, `amount`, `seconds`) is its two-ended form, from one tint to another.
ACS `HudMessage` is the `showHudMessage` action (`text`, `messageType`, `id`, `color`, `x`, `y`,
`holdTime`, `fade`, and the `hudWidth`/`hudHeight`/`font` a script set before it): the words a
script draws on the screen, at a fraction of the view, kept for a while — and `id` lets a later
message replace the one before it. `setActorPosition` (`tid`, `x`, `y`, `z`, `fog`) moves every thing carrying
a tag, with 16.16 fixed-point coordinates as ACS means them.

The reads a script makes are expressions, so a rule reads live state instead of a copy:
`acsactor(tid, "z")` (also `"x"`, `"y"`, `"floorZ"`, `"ceilingZ"`, `"angle"`, `"pitch"`,
`"light"`), `acsactorproperty(tid, index)` for an `APROP_` property, and
`acssectorz(tag, x, y, "floor")` — each one going through the interpreter's own host function.
ACS's fixed-point arithmetic and trigonometry (`x >> 16`, `FixedMul`, `Sin`, `Cos`) are
expressions too, so `GetActorZ(tid) >> 16` reads as `floor(acsactor(tid, "z") / 65536)`. The inventory and health calls work the same way: `giveInventory` and
`takeInventory` (`item`, `amount`) give and take the items a script names (`"Shells"`,
`"BlueCard"`, `"Shotgun"`), `damageThing` (`tid`, `amount`, `kind`) hurts the things with a tag,
`sectorDamage` (`tag`, `amount`, `kind`, `protection`) hurts everything standing in a tagged
sector, and `acsInventory` (`item`, `operator`, `value`) asks how many of an item the player
has — which is what `CheckInventory` asks. A random roll becomes the expression `floor(random(min, max))` where the script
used `Random`, so `SetLineSpecial(Random(map6, map6 + 2), 70, …)` keeps its own range.

Shootable props are actors too: a barrel imports with 20 health and a `Death` state, and
the import writes two rules from that state — `ExplosiveBarrel: explodes` (`explodeArea`
128/128, once per barrel, guarded by its own timer) and `ExplosiveBarrel: stops blocking`
(`setEntitySolid`, `solid: no`). `PROP_FUNCTIONS` is the set a translated prop's state no longer
performs itself.

A rule can also be about a **missile**: `forEachType: "projectile"` iterates the ones in
flight and `projectileState` (`state`) asks which of its imported states one is in, so a
missile's flight and its death can be described the same way an actor's are. The import
uses this for the missiles that do more than fly straight: `RevenantTracer: homing
flight` (`homeMissile` at 16.875°), `Rocket: explodes` (`explodeArea` 128/128) and
`BFGBall: sprays` (`bfgSpray` with the mod's ray and damage counts). Those three
functions are no longer called by the missile's state machine for a translated missile.

`explodeArea` (`damage`, `radius`) throws what it damages, the way Doom's
`P_RadiusAttack` does — `damage * 12.5 / Mass` units a tic away from the blast, slid along the
floor and slowed by friction — which is why a row of barrels scatters as it chain-reacts
instead of exploding where it stands. `homeMissile` (`turn`) and
`bfgSpray` are the missile functions as actions; `explodeArea` is the blast a missile's `Death` state performs, as an
action: the rocket's own `A_Explode` frame and a rule that wants something to blow up call
the same code, so a translated explosion cannot drift from a hand-written one.

`playActorState` enters a state the actor is not already in, so a rule can say "be in
See" every frame without restarting the animation under it, and the walking rules stand
down while an attack state plays rather than cutting it short. The attack itself still
runs from the state — `A_TroopAttack` keeps choosing claw or fireball exactly as the mod
wrote it — so a translated monster decides in the sheet and acts with its own functions.

Two conditions make this readable: `entityActorName` (which archetype a rule is about)
and `actorState` (which state the actor is playing). A monster whose states have no `See`
or no `Melee`/`Missile` to attack from keeps its machine and the import says so.

The pictures belong to the state the actor is in: every tic the machine sets the clip its
current state names (`Spawn` stands, `See` walks, `Pain` flinches, `Death` dies), so a
monster that a hit put in `Pain` goes back to its walking frames when the state hands it to
`See`, and a barrel whose `Spawn` is one frame that never ends still shows every explosion
frame. A project with an actor table therefore gets no `Enemy sprite / …` rules — those
write the clip for a scripted enemy and would overwrite the machine — and a project saved
before this rule drops them the next time it is opened.

### Imported weapons are rules

A WAD's weapons arrive as DECORATE states, and the engine's rule is that gameplay is
readable in the event sheets — so an import **writes each weapon into the Weapons
sheet** instead of leaving it to run inside the actor machine. Every imported weapon
gets one rule, built from that weapon's own states:

| Part of the rule | Where it comes from |
|---|---|
| Condition | `Mouse0` held (and a second rule with `Mouse2` when the states have an `AltFire`) |
| Conditions | alive, weapon selected, weapon owned, enough ammo, `timerReady` on the weapon's own timer |
| `addAmmo` | `Weapon.AmmoType` and `Weapon.AmmoUse` of the actor |
| `weaponAnimation` | the state the weapon fires from — it plays the shot sound, the reload and the flash, and nothing else |
| `hitscan` / `launchProjectile` | the `A_FirePistol`/`A_FireShotgun`/`A_FireBullets`/`A_FireCustomMissile` arguments the mod wrote; a missile keeps its actor class, so the mod's explosion is the one that happens |
| `startTimer` | the tics the firing state's frames add up to, divided by 35 |

A weapon that fires twice in one pass — the chaingun, the chainsaw — spends and shoots
twice in its rule and waits a whole pass, so ammo and shots a second are exact.

The muzzle flash is the weapon's own `Flash` state, drawn as a second psprite over the gun
for the tics its frames last, exactly as GZDoom's `A_GunFlash` does — a fire function starts
it whether the shot came from the states or from a rule, so a weapon fired by a rule flashes
too. The gun itself is drawn from the same states (`Ready`, `Fire`, `Select`, …), so the two
psprites are always on the same tic and the flash lands on the barrel of the recoil frame the
weapon is really showing; a weapon with no actor record falls back to the clip a rule plays. Its frames carry `A_Light1`/`A_Light0`, and a `Flash` state that loops back to a picture
it has already shown is ended rather than left glowing for ever.

The cadence is the mod's, not a guess: pistol 15 tics, shotgun 38, super shotgun 58,
chaingun 9 for two shots, rocket launcher 21, plasma rifle 4, BFG 41, fist 18,
chainsaw 9 for two shots. A rule fires its first shot the frame the trigger is held,
where the states spend a few tics raising the weapon, so the very first press can be
up to one pass earlier than the animation suggests.

Two actions make this possible, and both are in the catalogue for your own rules:

- `weaponAnimation` (`weapon`, `state`) runs an imported weapon's named state
  (`Fire`, `AltFire`, `Ready`, `Flash`) — its pictures, its shot sound, its reload and
  its flash — without firing or spending anything.
- `weaponTrigger` (`weapon`, `trigger` = `fire`/`alt`) holds an imported weapon's
  trigger for the frame, which lets the weapon's own states decide the rate when you
  want them to.

A rule that names an actor in its `weaponActor` field owns that weapon: the state
machine then runs for pictures and sounds only, so the weapon is fired once and not
twice. Deleting the rule hands the weapon back to its states unchanged; editing the
rule changes the weapon — the ammo cost, the damage, the cadence, the projectile are
all just actions and fields. Two things stay in the actor, because they are what the
actor is: its state pictures and its sounds. A weapon whose states a single rule
cannot promise — two different shots in one pass, a class the project does not
contain, a state that stops or jumps out of the cycle — keeps its state machine and
the import says which weapon and why.

### Controllers

A PlayStation 5, PlayStation 4, Xbox or Switch Pro controller works without any setup:
browsers report all of them with the same standard layout, and the engine translates them into
the key codes the keyboard produces, so a pad drives events, ACS button bits, the weapon slots
and the menus with no controller-specific rule at all.

| Input | Action |
| --- | --- |
| Left stick | Forward / back / strafe |
| Right stick | Look and turn |
| D-pad | Arrow keys — turning, and menu navigation |
| Cross / A | Jump, and confirm on a menu |
| Circle / B | Use, and back on a menu |
| Square / X | Run |
| R2 / RT | Fire |
| L2 / LT | Alt fire |
| Options / Menu | Pause |

A pad button presses the **action** its key is bound to, so rebinding Forward to the up arrow
moves the left stick with it. The pad's own settings — deadzone, look speed, inverted look and
whether it rumbles — are in the editor's **Engine tweaks**, because an imported game's classic
menus have no Controls page.

```text
Enemy dies:
  Controller: rumble (strength = 0.8, seconds = 0.3)
```

`rumbleController` is the one thing a rule has to ask for: a game decides what is worth a buzz,
and the engine does not guess that being shot should be one.

### Cameras

A camera is an object with `type: 'camera'` — place one in the level, add a
**Camera3D** node to a scene, or create one during play with `createCamera`. It
has a field of view, a pitch and an eye height, and it is invisible in play: it
is a point of view, not a thing.

Rules name a camera three ways, so a cutscene does not depend on editor ids:

| Reference | Means |
| --- | --- |
| `$player` | the player's own eyes (back to normal play) |
| `$active` | whichever camera the view is on |
| an object id or a camera's name | that camera |

```text
On start:
  Camera: create a camera (x = 512, y = 1024, z = 320, angle = 180, fov = 70, name = Flyby, activate = yes)
  Camera: move over time (camera = Flyby, x = 512, y = 512, z = 320, seconds = 6, easing = easeInOut)

Every 1 seconds:
  if Camera: this object is the active view (Flyby) is false -> Camera: switch the view to a camera (camera = $player)
```

A camera placed in a level and marked **Look through this camera when the level
starts** opens the level on that view. `followCamera` makes a camera ride an
object (the player included), and `cameraFovCompare` reads the field of view the
view is actually using, which is how a zoom rule can wait for its own end.

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

The tables below are maintained against `shared/engine-script.js` and the legacy
command lists in `shared/project.js`; the documentation test checks command
coverage. "Needs object" means the action/condition needs an object (`entityId`);
`$self` is available inside object rules. Wall and sector commands instead name
`wallId` and `sectorId`.

### Conditions

Named-signal connections use `onSignal` (`entityId`, `signal`) as the first,
non-inverted condition of a top-level AND rule. Signals are declared in an object's
**Signals** property (`signals[]`) or by its terminal's `submitSignal`.
`signalValueCompare` (`operator`, `value`) filters the emitted primitive payload;
values of a different type do not match. Additional local-variable conditions and
ordinary sub-events work alongside the trigger.

Door conditions select an automatically detected imported door or a sector with explicit `door` settings:
`sectorDoorOpen`, `sectorDoorClosed`, and `sectorDoorMoving` each take `sectorId`.
They report the live state, not just the authored starting state.
Elevator conditions `sectorElevatorRaised`, `sectorElevatorLowered` and
`sectorElevatorMoving` similarly take `sectorId` and target an imported moving
floor/lift or a configured `elevator`.

The player runs by default, as Doom ships it (`always_run` on, GZDoom's `cl_run` defaulting to
1) and the speed key walks instead; the input sheet's `movePlayer` speed is a *walking* speed
and running doubles it, the same ratio as Doom's `normforwardmove` 25 and 50.

A monster's chase speed follows its own states, not a guess: `A_Chase` moves `Speed` map units
**once per See frame**, and classic See states are frames of three or four tics — a Zombieman
covers 8 units every four tics (70 a second), an imp 8 every three (93), a demon 10 every two
(175). The import writes that average into `moveEnemy`'s `speed`, because the rule moves the
monster every frame; moving it by `Speed` per frame walked it four times too fast.

`oncePerTic` passes at most once per 35 Hz simulation tic, per rule and per object instance, so
a decision Doom takes once a tic (an attack roll) keeps that rate on a 144 Hz machine. The
walk is not gated by it: `moveEnemy` takes the frame time and covers the same ground at any
frame rate.

`everySeconds` fires immediately on its first evaluation, then waits for its
interval. Each condition and each object instance has an independent clock,
including sub-events of for-each rules. Game saves retain those deadlines, so
loading does not cause an extra early firing.

For an eligible rule, periodic, entry, damage and HUD-stat samplers still observe
the current frame when another AND/OR condition short-circuits the result.
Changing a filter therefore does not replay an old entry or damage transition.
Ordinary comparisons, random conditions and addon conditions retain short-circuit
evaluation. Disabled rules and children of unmatched parents are not evaluated.

Area/zone-entry samples are independent per condition and per for-each instance,
and survive save/load while the player stays inside. Interaction areas use the
object's live height after movement. Zones must reference existing zone objects;
deleting a referenced zone offers the same reference protection as other objects.
Keeping its rules preserves the replacement zone's trigger volume.
`distanceBetween` reads the player's live position and accepts the player in
either object slot.

`wallActivated` in `cross` mode is a movement-edge trigger: standing still after
crossing a line does not activate it again. Moving back across it can trigger a
repeatable rule again.
In `shoot` mode, gameplay hitscan shots (including automatic Doom weapons) are
delivered on the next gameplay tick to both before/after-physics rules, regardless
of rule order. Multiple pellets hitting one linedef in a frame coalesce into one
pulse; pauses and saves retain pending pulses. Native ACS shoot specials still
activate in the shot's original frame.

| Trigger / comparison | Type | Needs object | Parameters |
| --- | --- | --- | --- |
| a named signal is emitted | `onSignal` | yes | signal |
| compare current signal payload | `signalValueCompare` | — | operator, value |
| level entered with campaign inventory | `levelTransition` | — | — |
| a timesheet cue was reached (generated by a timeline, never picked by hand) | `timesheetCue` | — | timesheetId, cueId |
| active menu / gameplay screen | `gameScreen` | — | screen |
| Interacting with screen (aiming at a reachable terminal; blocks weapon fire) | `interactingWithScreen` | — | — |
| effect is enabled | `shaderEnabled` | — | — |
| shader engine pass is on | `postFxPassEnabled` | — | kind |
| compare a shader engine parameter | `postFxParamCompare` | — | kind, param, operator, value |
| compare math / text expressions | `expressionCompare` | — | left, operator, right |
| compare local variable | `objectVariableCompare` | yes | variable, operator, value |
| overlaps pickup reach | `playerReachesEntity` | yes | distance, height, below |
| touching a surface | `playerTouchingSurface` | — | surface |
| is on the ground / airborne | `playerAirborne` | — | state |
| inside this object interaction area | `playerInArea` | yes | — |
| entered this object interaction area | `playerEnteredArea` | yes | — |
| inside a zone | `playerInZone` | zone | — |
| entered a zone | `playerEnteredZone` | zone | — |
| health decreased | `entityDamaged` | yes | — |
| is alive (health above zero) | `entityAlive` | yes | — |
| compare distance between two objects | `distanceBetween` | yes | otherId, operator, distance |
| sprite animation state | `spriteState` | yes | state |
| remembers player | `enemyAlert` | yes | — |
| hears player weapon through open sectors | `enemyHearsPlayer` | yes | — |
| player uses, crosses or shoots linedef | `wallActivated` | — | wallId, mode |
| sector surface is moving | `sectorMoving` | — | sectorId, surface |
| door is fully open | `sectorDoorOpen` | — | sectorId |
| door is fully closed | `sectorDoorClosed` | — | sectorId |
| door is moving | `sectorDoorMoving` | — | sectorId |
| elevator is lowered | `sectorElevatorLowered` | — | sectorId |
| elevator is raised | `sectorElevatorRaised` | — | sectorId |
| elevator is moving | `sectorElevatorMoving` | — | sectorId |
| player visible in range | `enemySeesPlayer` | yes | range, fov |
| Doom distance-based attack decision | `enemyAttackChance` | yes | — |
| owns weapon | `weaponOwned` | — | weapon |
| selected weapon | `weaponSelected` | — | weapon |
| owns key | `keyOwned` | — | key |
| owns backpack | `backpackOwned` | — | — |
| ammo below capacity | `ammoBelowCapacity` | — | ammo |
| every N seconds | `everySeconds` | — | seconds |
| at most once a simulation tic | `oncePerTic` | — | — |
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
| pick every instance of a type | `pickAll` | — | objectType |
| pick instances where a property matches | `pickByProperty` | — | objectType, property, operator, value |
| pick instances where a local variable matches | `pickByVariable` | — | objectType, variable, operator, value |
| pick the nearest / furthest instances | `pickNearest` | — | objectType, to, order, count |
| pick a random instance | `pickRandom` | — | objectType, count |
| compare how many instances are picked | `pickedCount` | — | objectType, operator, value |
| this object is the active view | `cameraActive` | yes | — |
| compare the view field of view | `cameraFovCompare` | — | operator, value |
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

`emitSignal` (`entityId`, `signal`, `value`) emits a declared signal with one text,
number or boolean payload. Each listener receives each emission once in its
enabled sheet's phase, FIFO; emissions to already-completed phases wait until the
next tick. Signal chains are bounded to 256 emissions per tick, with explicit
loop errors. Pending emissions are transient, not game-save data.

`openSectorDoor`, `closeSectorDoor`, and `toggleSectorDoor` take `sectorId` and
deliberately operate that door, including existing imported and event-only doors.
No authoring step is required for imported doors. `raiseSectorElevator`,
`lowerSectorElevator` and `toggleSectorElevator` operate existing lifts and floor
barriers by sector ID. The inspector exposes initial state, activation, radius,
heights and speed; see the [door setup guide](node-editor.md#configure-a-level-door).
Unchanged movers retain native triggers, locks and cycles. Explicit custom activation
replaces native activation; restoring imported behavior removes only the override.

A saved [Access terminal](../public/examples/access-terminal.node) stores entered
digits as a per-instance text variable and emits `submitted` on Enter (correct
or incorrect). Default PIN: **1234**. To connect it to a particular door:

1. Import/place the node and configure the destination door as **event-only**.
2. Add **On signal**, choosing that terminal instance and `submitted`.
3. Add `objectVariableCompare` for its `digits`, operator `=`, text value `1234`.
4. Add `openSectorDoor`, choosing the destination sector.

The door binding stays in the destination layout, because portable node files
cannot assume another project's sector IDs. Local variables/signals survive node
export/import and instance remapping. Legacy terminals without local/signal fields
keep their existing global-variable output.

| Action | Type | Needs object | Parameters |
| --- | --- | --- | --- |
| emit a named signal | `emitSignal` | yes | signal, value |
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
| enable / disable the shader engine stack | `setPostFxStack` | — | enabled |
| enable / disable one shader engine pass | `setPostFxPass` | — | kind, enabled |
| set a shader engine parameter | `setPostFxParam` | — | kind, param, value |
| set a local variable on picked instances | `setPickedVariable` | — | objectType, variable, value |
| add to a local variable on picked instances | `addPickedVariable` | — | objectType, variable, value |
| set position of picked instances | `setPickedPosition` | — | objectType, x, y, z |
| move picked instances by an offset | `movePicked` | — | objectType, dx, dy, dz |
| set facing angle of picked instances | `setPickedAngle` | — | objectType, angle |
| set visual scale of picked instances | `scalePicked` | — | objectType, scale |
| play a sprite state on picked instances | `setPickedSpriteState` | — | objectType, state, restart |
| remove picked instances | `removePicked` | — | objectType |
| rumble the controller | `rumbleController` | — | strength, seconds |
| create a camera | `createCamera` | — | x, y, z, angle, pitch, fov, name, activate |
| switch the view to a camera | `switchCamera` | — | camera |
| set camera position | `setCameraPosition` | — | camera, x, y, z |
| set camera angle and pitch | `setCameraAngle` | — | camera, angle, pitch |
| set camera field of view | `setCameraFov` | — | camera, fov |
| move a camera over time | `moveCamera` | — | camera, x, y, z, angle, pitch, seconds, easing |
| make a camera follow an object | `followCamera` | — | camera, target, copyAngle |
| set local variable | `setObjectVariable` | yes | variable, value |
| add to local variable | `addObjectVariable` | yes | variable, value |
| play sprite state | `setSpriteState` | yes | state, restart |
| play firing animation | `playWeaponClip` | — | weapon |
| move sector surface | `moveSector` | — | sectorId, surface, height, speed, wait, returnMode, returnHeight, sound |
| open sector door | `openSectorDoor` | — | sectorId |
| close sector door | `closeSectorDoor` | — | sectorId |
| toggle sector door | `toggleSectorDoor` | — | sectorId |
| raise elevator | `raiseSectorElevator` | — | sectorId |
| lower elevator | `lowerSectorElevator` | — | sectorId |
| toggle elevator | `toggleSectorElevator` | — | sectorId |
| play embedded sound by name | `playSound` | — | sound, volume |
| play imported sound (WAV / OGG / Opus / FLAC / MP3) | `playAssetSound` | — | assetId, volume |
| start a timeline | `startTimesheet` | — | timesheetId, restart, loop |
| stop a timeline | `stopTimesheet` | — | timesheetId, all |
| pause or resume a timeline | `setTimesheetPaused` | — | timesheetId, paused |
| move an object between two waypoints of a route | `followPath` | yes | pathId, fromPoint, toPoint, seconds, easing, faceDirection |
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
| show / hide a HUD screen | `showHudScreen` | — | mode, screen |
| set element visible | `setHUDVisible` | yes | visible |
| set text (clears binding) | `setHUDText` | yes | text |
| bind text / bar to engine value | `setHUDBinding` | yes | binding |
| set numeric property | `setHUDProperty` | yes | property, value |
| play / restart animation | `playHUDAnimation` | — | — |
| stop animation (hold pose) | `stopHUDAnimation` | — | — |
| set a cell in an array | `setArrayCell` | — | array, row, column, value |
| add to a cell in an array | `addToArrayCell` | — | array, row, column, value |
| set group active | `setGroupActive` | — | active |
| add local movement | `movePlayer` | — | forward, strafe |
| turn (degrees / second) | `turnPlayer` | — | speed |
| apply mouse movement | `mouseLook` | — | sensitivity, vertical |
| request jump | `jumpPlayer` | — | — |
| rotate by (degrees, relative) | `rotateEntityBy` | yes | angle |
| set model tilt (pitch / roll) | `setEntityTilt` | yes | pitch, roll |
| set view pitch (degrees) | `setPlayerPitch` | — | pitch |
| spray an image on the wall | `sprayImage` | — | assetId (asset-library image), distance, size, duration |
| set gravity direction (walk on that surface) | `setPlayerGravity` | — | mode, reach |
| movement model (Doom or Half-Life / Source) | `setMotionModel` | — | model, gravity, jumpSpeed, maxSpeed, accelerate, airAccelerate, friction, stopSpeed, airSpeedCap |
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

Object types usable with **For each**: `player`, `enemy`, `pickup`, `light`, `decoration`, `ramp`, `zone`.

Object-type commands that need a wall, sector, HUD element or sprite clip validate those references too; a rule that points at a deleted object fails validation with a specific message instead of silently doing nothing.
