# GZDoom parity: tracing behaviour differences

OpenDLE imports Doom levels and plays them. The question this document answers is not "does
it look the same" but "does it **behave** the same" — the same tic, the same position, the
same monster waking, the same door opening. GZDoom is the reference; this is how we compare
against it without guessing.

It is written as a plan because the harness exists and the remaining work is staged.

## What exists today

`tools/gzdoom/` runs the real GZDoom 4.14.2 on this machine, built from the official release,
and records what happened:

| piece | what it does |
| --- | --- |
| `fetch.mjs` | downloads the pinned release and unpacks it into `tools/gzdoom/dist` (no root, no package manager) |
| `trace/` | a ZScript `StaticEventHandler` registered from MAPINFO that prints one `ODT` line per tic for the player and any watched actor, plus `ODT EVENT` lines for damage and death |
| `run.mjs` | runs a scenario in GZDoom and keeps its trace (`logs/gzdoom/<name>.trace`) |
| `opendle-trace.mjs` | runs the *same scenario* in OpenDLE's headless runtime and writes the same format (`logs/opendle/<name>.trace`) |
| `compare.mjs` | pairs the two traces tic by tic and reports the first divergence, the field and both values |
| `diff.mjs` | runs both engines and compares, in one command |
| `animation.mjs` | turns a trace into an animation table, and diffs it against OpenDLE's actors (`--all`) |
| `measure-actors.mjs` | measures every classic monster and writes `shared/vanilla-animations.js` |

```
npm run gzdoom:fetch
npm run gzdoom:diff -- map01-idle
```

A scenario is a JSON file: IWAD, map, skill, tic budget, and an action.

```json
{ "name": "map01-aim", "iwad": "Projects/Doom2.wad", "map": "MAP01",
  "skill": 3, "tics": 140, "action": "aim", "angle": 90 }
```

Both sides speak the same line format, and OpenDLE's own conventions are normalised on the
way out (y flipped, angles negated), so "no divergence" means the engines agree, not that
the comparison was blind. The animation side is no longer a plan: `npm run gzdoom:measure` asks GZDoom for the real
state table of all eighteen classic monsters and writes `shared/vanilla-animations.js`, which
the actor state machines and the sprite clips are built from. `npm run gzdoom:animation --
--all` compares that measurement with what OpenDLE actually plays and reports every
difference; it currently reports none.

Two scenarios already agree for 140 tics: `map01-idle` and
`map01-aim`. The harness has also been shown to *detect* a real difference — it caught a
wrong angle conversion in the tracer itself, which was then fixed.

## Hard-won facts about driving GZDoom

Each of these cost an hour; none is guessable, all are in comments next to the code:

* **`+map`, never `-warp`.** For a `mapxx` game GZDoom runs `atoi("MAP01")` on the `-warp`
  argument (`src/d_main.cpp`), gets `0`, and looks for MAP00. The game never starts and the
  trace is silently empty.
* **Disable the mouse and gamepad** (`+set use_mouse 0`). The window is on a real desktop, so
  an "idle" trace came back with the camera turning and the player walking away.
* **Disable the background throttle** (`+set vid_lowerinbackground 0`). An unfocused window
  waits between tics on purpose (`src/d_net.cpp`), which makes a run crawl.
* **Read `+logfile`, not stdout.** Piped stdout is block-buffered, so lines arrive in bursts
  and a working run looks hung. With the log file, 140 tics take about six seconds.
* **A trace may observe the player, never animate it.** Writing `player.vel` every tic made
  GZDoom wedge against a wall; writing `player.angle` every tic hung it after a few seconds.
  Aim is therefore set once at load, and anything more has to be real input (see phase 2).
* **ZScript is not C.** `#` is not a comment, `action` is a reserved word, `GetCvarInt` does
  not exist (`CVar.GetCVar('name').GetInt()`), and cvars must be declared in `CVARINFO.txt`
  before `+name value` works.

## The plan

### Phase 1 — scripted input: done

Everything about movement, doors, lifts, monster movement and combat needs input. The tracer
cannot fake it (proven above), so input has to be a **demo**.

The demos are now *generated* rather than recorded. `tools/gzdoom/make-demo.mjs` writes the
format GZDoom reads (`G_ProcessIFFDemo` / `G_ReadDemoTiccmd` in `src/g_game.cpp`):

```
FORM <len> ZDEM
  ZDHD  version:int16, min:int8, kind:int8, map:string, rngseed:int32, console:int8
  UINF  player:int8, "\"           a bare backslash means "every userinfo value is default"
  BODY  per tic: 1 (DEM_USERCMD), a flags byte, then the fields the flags name
```

A timeline is a description of the input, so both engines can be driven from one source:
`TIMELINES` in `make-demo.mjs` is what GZDoom plays and what `opendle-trace.mjs` replays as key
presses. Four facts about the format cost real time:

- **The stream is big-endian.** `UncheckedWriteInt16` puts the high byte first. Little-endian
  lengths produced a file GZDoom read as a mangled form and then segfaulted on.
- **A ticcmd is a difference, not a snapshot.** `UnpackUserCmd` starts from the previous command
  and writes only the fields the flags name, so `DEM_EMPTYUSERCMD` means "unchanged", not "no
  input". A timeline that released a key by writing empty commands kept the player walking. A
  field that becomes zero has to be written as a zero with its flag set.
- **Movement fields are in 1/256 of a unit.** `G_BuildTiccmd` ends with `cmd->forwardmove <<= 8`,
  so a walk is 6400 and a run 12800. Writing the familiar 25 produced a demo whose player never
  moved, because 25/256 of a unit is a thousandth of what a key press gives.
- **Yaw is counter-clockwise.** A positive `yaw` turns left, so a timeline that means to hold the
  turn-right key has a negative yaw.

GZDoom also discards a demo's **first eight commands** while the level is starting — none of them
reach the player. A timeline therefore begins with eight idle tics (`DEMO_PREROLL`) so that
command *N* is the command for tic *N* in both engines.

**Result:** `npm run gzdoom:diff -- player-stop` compares 77 tics of "walk six tics, let go" and
finds **identical velocity on 76 of them** and at most 1.3 map units of position drift. The
player's acceleration, top speed, friction and stop threshold now match GZDoom exactly.

### What measuring player movement found

Doom does not set a velocity from the keys. Every tic it adds a thrust to the player's momentum
and multiplies the momentum by friction, `momentum = momentum * 0.90625 + thrust`, which is why
it takes about thirty tics to reach full speed and a moment to coast to a stop. The constants
come from `src/doomdef.h` and `src/playsim/player.zs`, and the traces confirm them to three
decimals:

| | value | where |
| --- | --- | --- |
| friction | `0xE800 / 65536` = 0.90625 | `ORIG_FRICTION` |
| thrust per unit of input | `2048 / 65536` = 0.03125 | `ORIG_FRICTION_FACTOR` |
| walk / run input | 25 / 50 forward, 24 / 40 side | `normforwardmove`, `normsidemove` |
| walk terminal speed | 8.333 units/tic = 291.6/s | measured |
| run terminal speed | 16.667 units/tic = 583.2/s | measured |
| strafe terminal speed | 8.0 units/tic = 280/s | measured |
| stop speed | `0x1000 / 65536` = 0.0625 | `STOPSPEED` |
| airborne thrust | 1/256 of the ground thrust | `sv_aircontrol` |
| gravity | 1 map unit/tic² = 1225/s² | `sv_gravity` 800 × 0.00125 |
| ledge gravity | doubled for one tic | `AActor::FallAndSink` |
| jump | 8 units/tic, a 32-unit apex | `Player.JumpZ` |
| turn | 640/65536 of a turn per tic, 320 for the first six | `turnspeedwalkfast`, `SLOWTURNTICS` |

OpenDLE had been moving the player at a fixed **160 units a second** — 55% of Doom's walk and
27% of its run — reached in a single frame instead of over thirty tics. Its gravity was 9.81 m/s²,
which in this engine's scale (64 map units to a metre) is 627.8 units/s², exactly half of Doom's,
so every drop took √2 times as long.

All of it is now `shared/player-motion.js`, used by both the key path and the `movePlayer`
actions of a scripted project, and the editable Engine input sheet asks for Doom's speeds rather
than 160.

**Still different, and measured:**

- **Steps.** Walking down MAP01's staircase, GZDoom is briefly airborne on every step and keeps
  its speed (no friction in the air); the Rapier character controller keeps the player grounded
  and applies friction throughout, so OpenDLE decelerates over the steps. This is the largest
  remaining difference in the traces: `player-walk` diverges at tic 24, where the staircase
  starts.
- **A wall GZDoom stops at and OpenDLE walks through** near y = 1098 on MAP01, and another in
  `player-strafe` at x = 48. These look like collision geometry rather than player physics and
  need their own investigation. Monsters, at least, no longer pass through: an imported actor
  whose actor table calls it solid gets a kinematic capsule the player is stopped by, and a
  corpse stops blocking the way Doom's `A_NoBlocking` does.

### What playing found that the trace cannot

Two things the tic-by-tic trace says nothing about, both of which were wrong:

- **Momentum has to be dropped when a wall stops the player, and only then.** The rule exists
  so a player cannot bank speed against a door. It was judged from where the player ended up
  each frame, but the character controller only runs a substep when its 1/60 s accumulator
  fills: at a hundred frames a second most frames move the capsule nowhere, and every one of
  those looked like a wall. The player's momentum was reset ten times in three seconds and it
  never reached walking speed. `physics.blocked` now reports how many *consecutive* substeps
  each axis was stopped for, and only a streak of three or more drops momentum, which outlasts
  the substep or two that climbing a step takes.
- **The bob is part of the movement.** Doom bobs the weapon and the view with the player's
  speed — `player.bob` is the squared speed *times `movebob`*, capped at 16, the weapon swings
  a cosine in x and a sine in y every five and five eighths degrees of `BobTimer` — and without
  it walking reads as gliding. `shared/player-motion.js` holds the maths; the renderer applies
  it to the weapon overlay and the eye height.

  The `movebob` quarter is easy to miss and was missed here first: `movebob` defaults to
  **0.25**, so a walking player's bob is a fifth of the squared speed, not all of it. Without
  the factor the weapon swung 27 map units across a 320 unit screen instead of 10, which is
  exactly the "swings too much" a player notices. The trace settles it: GZDoom reported
  `bob = 10.9` while the player moved 6.6 units a tic, and 6.6² × 0.25 = 10.9.

  Two more of GZDoom's constants are not what a reading of the name suggests: the view bob's
  step is `360 / ViewBobSpeed` with `ViewBobSpeed` defaulting to **20** — eighteen degrees a
  tic, not the third of a degree the formula suggests at a glance — and the weapon's multiplier
  (`Player.ViewBob`) is 1.

### What measuring animation changed

### What measuring animation changed

The classic actor table was a hand-written summary — `walkFrames: 'ABCD', walkTics: 4` — and
nothing compared it with the engine. Measuring it found, for the Zombieman alone, fifteen
differences:

| label | Doom plays | the summary said |
| --- | --- | --- |
| Spawn | `A×10 B×10` | one frame |
| See | `AABBCCDD` at 4 tics (8 states) | `ABCD` at 4 tics — half the animation |
| Missile | `E×10 F×8 E×8` | `EF` at 6 and 4 |
| Pain | `G×3 G×3` | one frame |
| Death | `H I J K` then `L` forever | `HIJK`, so the corpse frame was missing |
| XDeath | nine frames | absent |

The same class of error was in every monster, because the table was written by hand. The
measured table is generated, and the sprite clips are built from it as well: a repeated pose
(`A A B B`) collapses to one frame of double duration when building a clip, because a clip has
one duration for all its frames, while the state machine keeps every state — those carry
separate actions.

Two things the tracer cannot see, and how they are handled: an action's *name* is not exposed,
so the loop/jump structure and the action names still come from OpenDLE's own runtime; and a
sprite's *name* is not exposed either, so a sprite is identified by GZDoom's index, which is
enough to tell that a label changes sprite but not which one.

### What measuring movement found

A watched actor is now placed by the tracer itself — in front of the player, facing it — and
both engines trace it: `actor-zombieman-chase.json` runs a Zombieman alone on MAP01 and prints
its position, velocity, facing, health and current frame every tic. Three real bugs fell out
of building that:

* **GZDoom writes the tracer's cvars into its config.** A run that spawned an actor left
  `odt_spawn=Zombieman` behind, and the *next* scenario — a baseline that asked for no actor at
  all — quietly spawned and watched one too. The config is now rebuilt from defaults for every
  run; the tracer's knobs live on the command line only.
* **`A_Look` belongs on every Spawn frame.** Doom writes `POSS AB 10 A_Look`, which is two
  states that each look. Ours put the action on the last frame only, so a monster was blind for
  a whole extra frame: the traced Zombieman noticed the player and walked at tic 6 while ours
  was still waiting out its Spawn.
* **Doom seeds its RNG from the clock**, so two runs of the same scenario took different paths
  and an actor comparison meant nothing — GZDoom moved the same Zombieman 72 units in one run
  and 218 in the next. `-rngseed` is passed for every scenario now, so a trace is reproducible
  to the byte; two runs of the chase scenario now produce identical traces.
* **An actor placed above its floor cannot move.** `moveEnemy` refuses to step down more than
  24 units, so an actor started at GZDoom's mid-air spawn height never walked in the headless
  runtime, which has no gravity. Height is therefore not carried into the OpenDLE trace and the
  vertical fields are excluded from the comparison; vertical motion is a physics question and
  needs Rapier running in the trace.

What the comparison can and cannot say is now explicit in `diff.mjs`:

| comparison | verdict |
| --- | --- |
| the player, every tic | must match; a divergence fails the run |
| the watched actor, every tic | reported, not enforced — `A_Chase` strafes with Doom's random number generator, so the path differs between two runs *of GZDoom itself* |
| the watched actor, aggregate | distance closed and the number of frame changes, printed side by side |

With the seed pinned, the aggregate is stable: GZDoom closes 65.4 units over 33 frame changes,
OpenDLE 55.8 over 44. The frame-change count is now a concrete lead — our actor runs through its
animation more often than GZDoom's over the same tics, which points at the state machine rather
than at movement — and the first divergence is a 45° facing difference at tic 10, i.e. the
strafe direction.

### Phase 2 — actor movement and combat

Animation is measured; movement is next, and the trace already carries it: a chase scenario
(`tools/gzdoom/scenarios/actor-zombieman-chase.json`) records `vx/vy/vz` and the position every
tic, and a Zombieman moves 8 units every four tics — the same rate OpenDLE's `A_Chase` produces,
so the two can now be compared for drift over a whole chase rather than by inspection. What is
missing is the OpenDLE side of that scenario: the runtime has to spawn the same actor at the
same spot so both traces line up tic for tic.


The player alone proves physics; monsters prove behaviour.

1. A scenario already summons actors by name (`"summon": ["Zombieman"]`, GZDoom's own
   command) and turns them to face the player once (`"face": true`) so they can see it — ZScript
   can only name a class as a literal, so spawning by name belongs to the console, not the tracer.
2. Watching them works: `"watch": "Zombieman"` prints position, velocity, angle, health, the
   remaining state tics and the current sprite/frame every tic.
3. Use `ODT EVENT` damage/death lines to compare combat: who hit whom, for how much, on
   which tic.
4. Compare **state durations** rather than sprites: `tics` (ticks left in the current state)
   is the portable signal, and a state machine that is off by one tic shows up immediately.

**Acceptance:** a scenario where a zombie wakes, walks and fires, and the health curve of the
player matches for 300+ tics.

### Phase 3 — read GZDoom's own source, not just its output

`Ancestors/gzdoom-master` is in the workspace. A trace tells us *what* differs; the source
tells us *why*, and reading it is cheaper than bisecting numbers.

1. When a divergence appears, find the relevant code first: `p_mobj.cpp` (movement, blockmap),
   `p_enemy.cpp` (sight, chase, attacks), `p_doors.cpp`, `p_floor.cpp`, `p_interaction.cpp`
   (damage, armour, pain), `g_game.cpp` (tic order).
2. Record the constants and the tic order in `DEVELOPMENT.md` next to our implementation, so
   the next reader does not have to re-derive them.
3. Prefer matching GZDoom's arithmetic (integer fixed-point where it matters) over matching
   its output by tuning floats.

**Acceptance:** every divergence fixed in phase 2 is explained by a source reference in the
commit message.

### Phase 4 — make it a habit

1. `npm run gzdoom:diff -- <scenario>` becomes part of the release checklist; a scenario
   suite runs a handful of maps.
2. A failing diff prints the first divergent tic; that tic is the input to phase 3.
3. The scenario files are small and reviewed like tests: a scenario is a claim about
   behaviour, and it belongs in review.

### Out of scope for now

* Rendering parity (the glass shader saga is separate and parked).
* Demo *recording* automation: the reference demos are recorded by hand, once.
* Maps that need a specific GZDoom gameplay mod; the harness loads only the IWAD and its own
  trace PK3.

## Cost and risks

* A run needs a display (GZDoom has no headless mode) and opens a window. CI would need Xvfb;
  locally it is just a window that never takes focus.
* The trace is a fixed set of fields. Adding a field means changing both emitters, which is
  why the format is deliberately flat `key=value`.
* Demos are version-sensitive: a demo recorded on GZDoom 4.14.2 may not replay on a later
  release. `tools/gzdoom/version.json` pins what the traces came from.
