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

### Phase 1 — scripted input (the blocker)

Everything about movement, doors, lifts, monster movement and combat needs input. The tracer
cannot fake it (proven above), so input has to be a **demo**.

GZDoom can record and play back demos: `-record <file>` writes a `.lmp` of the real TicCmds,
and `-playdemo <file>` replays them deterministically at any speed. OpenDLE replays the same
input through its own key state.

1. Add `demo` to a scenario: `{ "demo": "demos/map01-walk", "tics": 350 }`.
2. `run.mjs` passes `-playdemo <file>` instead of `+map`, and the trace handler detects demo
   playback and skips the `aim` step.
3. Record the reference demos once, by hand, with a fixed config: `-record`, walk forward,
   open the first door, fire at the first monster, quit. Each demo becomes a fixture.
4. `opendle-trace.mjs` replays the same tick timeline as key presses. A demo's TicCmds are
   not portable as raw input, so a demo is paired with a hand-written equivalent
   (`keys`: a list of `{ from, to, keys }`) — recorded once, then versioned with the demo.

**Acceptance:** `npm run gzdoom:diff -- map01-walk` reports either no divergence, or a
divergence that is a genuine OpenDLE bug worth fixing.

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
