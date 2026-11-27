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

## Bosses and ghosts

Two pieces of Doom are not geometry, monsters or weapons, and both used to import silently and do
nothing. They are now driven from the imported classes like everything else.

### The Spectre is see-through because of its class

Doom draws a Spectre through `COLORMAP 32`; the picture is the Demon's own `SARG` frames, so
nothing in the artwork says "ghost". The property lives on the class — `MF_SHADOW` in vanilla,
`RenderStyle Fuzzy`/`Alpha` in a DECORATE or ZScript port — and the engine was ignoring it, which
is why every Spectre came back as a solid pinky.

`actorSpriteLook()` (`shared/actors.js`) turns a class into one of four looks:

| class says | look | drawn as |
| --- | --- | --- |
| nothing | opaque | alpha-tested, depth-writing, as before |
| `MF_SHADOW`, `MF_STEALTH`, `RenderStyle Fuzzy` | fuzz | blended at 0.5 opacity (never more), no depth write |
| `RenderStyle Translucent` or `Alpha < 1` | blend | blended at the authored alpha |
| `RenderStyle Add` | add | additive |

A stealth monster's class arrives as `RenderStyle Translucent` with `Alpha 0`, where zero is "the
class did not say" rather than "invisible" — GZDoom draws those see-through — so a ghost with no
authored alpha still gets half opacity.

Both viewports ask it: the game view (`public/render.js`) and the editor's 3D view
(`public/scene-3d-view.js`, which is told the actor table through `callbacks.actors`). A ghost that
is only a ghost in one of them is still a solid rectangle in the other.

**Not replicated:** Doom's fuzz is a column dither that shifts every tic, not a flat alpha. The
sprite is drawn as a half-transparent blend, which is what "you can see the wall through it" means
in practice; the shimmer is cosmetic and currently absent.

### The Icon of Sin: three classes, one fight

MAP30's boss is not a monster with a big health bar. It is:

- **`BossBrain`** (editor number 88) — the head on the wall. `SOLID|SHOOTABLE`, 250 health in the
  imported data, and its Death states call `A_BrainScream` and finally `A_BrainDie`.
- **`BossEye`** (89) — the invisible spitter at the top of the tower. Its Spawn state is `A_Look`;
  its See block calls `A_BrainAwake` once, then `A_BrainSpit` every 150 tics, for ever.
- **`BossTarget`** (87) — a marker spot. Thirteen of them in MAP30, and nothing else.

None of the three carries `MF_MONSTER`, so all of them imported as decorations and never thought:
no cubes, no monsters out of them, and shooting the head did nothing. Two changes fix that:

1. `actorRoleOf()` (`shared/wad.js`) promotes a class whose states call an `A_Brain*` action to
   `enemy`, and `initialiseActorEntities()` does the same at runtime, so a campaign imported before
   this change plays correctly without a re-import.
2. The action pointers are implemented in `shared/actor-runtime.js`:

| action | what it does |
| --- | --- |
| `A_BrainAwake` | collects every live `BossTarget`, resets the cursor, plays `DSBOSSIT` |
| `A_BrainSpit` | skips every other shot on the two easiest skills, aims the next spot in turn, spawns a `SpawnShot` cube and sets its flight |
| `A_SpawnSound` | plays `DSBOSCUB`, then runs `A_SpawnFly` (Doom's first frame does both) |
| `A_SpawnFly` | on arrival: `SpawnFire` at the spot, `DSTELEPT`, a monster from Doom's decreasing-likelihood table, and a telefrag for anything standing there |
| `A_BrainScream` / `A_BrainExplode` | the death spectacle: fire effects across the face, `DSBOSDTH` |
| `A_BrainDie` | `G_ExitLevel` — the runtime's `state.finishLevel`, the same intermission an exit line starts |
| `A_BrainPain` | `DSBOSPN` |

Details that matter to the fight feeling right:

- **Flight time comes from distance and speed**, not a fixed count: `A_BrainSpit` computes
  `distance / speed` from the class's own `speed` (10) and gives the cube that many tics of travel,
  clipped to the three-tic state cycles `A_SpawnFly` runs on. A spot across the map takes longer
  than one beside the tower.
- **The cube is a real entity**, not a projectile record: it renders its `BOSF` frames and walks
  its own states, which is what calls `A_SpawnFly` at all.
- **The spawn table resolves names**, so a class replaced by a mod is the one that appears:
  imp, shotgun guy, spectre, pain elemental, cacodemon, arch-vile, revenant, arachnotron, mancubus,
  hell knight, baron — with the same thresholds Doom uses.
- **A landing kills what stands there**, the player included, through god mode: that is Doom's
  telefrag, and it is why a boss spot is a dangerous place to stand.
- **The spots are marker things**, so `BossTarget` stays a decoration: it is found by its editor
  number (87), never drawn, never hit.

### The action pointers a monster is written in

A codepointer with no handler is not an error here: the frame runs, the name is recorded as
unsupported, and nothing happens. Imported classes reach for names this engine did not answer, and
the failures were invisible until every monster in a level was made to fight. `runActions` now
answers these (each has a test in `test/monster-attacks.test.js`):

| action | who | what was broken |
| --- | --- | --- |
| `A_SPosAttackUseAtkSound`, `A_SposAttackUseAtkSound` | Spider Mastermind | GZDoom renames its attack; its states call the new name, so the biggest boss in Doom II stood in front of the player firing nothing |
| `A_SpidRefire` | Spider Mastermind | never stopped firing at something it could not see |
| `A_SkelFist`, `A_SkelWhoosh` | Revenant | the punch did nothing and the swing was silent |
| `A_PainDie` | Pain Elemental | a killing produced none of the three Lost Souls it is famous for |
| `A_FatRaise`, `A_Metal`, `A_BabyMetal`, `A_Hoof` | Mancubus, Spider, Arachnotron, Cyberdemon | the heavies walked and raised their guns in silence |

`A_SetFloorClip`/`A_UnSetFloorClip` are answered too: the flag is stored and the sprite is cut at
the sector floor in `spritePlacement`. They were the last two action names the campaign's placed
monsters called.

`A_BossDeath` runs the level's own ending rather than only latching `bossDefeated`: it lowers the
sectors tagged 666, which is what E1M8's Barons, MAP07's Mancubi and Arachnotron pair and the
Cyberdemon's E2M8 exit all ask for. A map with no such tag keeps playing, as it does in Doom.

### The audit of every monster a level places

Twenty-two classes appear in the campaign's maps. Their action names were all answered, so the
missing features were in *how* an answered action behaved. Each row is a test in
`test/monster-features.test.js`, driven by the campaign's own actor table rather than a fixture.

| monster | what was missing |
| --- | --- |
| Archvile | `A_VileChase` was `A_Chase`: no corpse ever stood up, and the Heal state was unreachable. `P_CheckForResurrection` is implemented now — a body in reach whose class has a Raise state returns at full health, blocking again through a rebuilt collider, and the Archvile spends Heal doing it |
| Archvile | `A_VileStart` and `A_VileTarget` were empty stubs and `A_VileAttack` was a plain 20-damage hitscan. The flame is dropped on the target, follows the player while the Archvile holds sight, and bursts for 20 direct plus 70 in a 70-unit radius — 66 damage at the 24 units Doom places it |
| Mancubus | one shot per attack instead of two, with no `FATSPREAD` fan: every volley did half damage |
| Lost Soul | `A_SkullAttack` wrote an `entity.charge` that nothing read, so the lunge was silent. It is a real flight at `DEFSKULLSPEED` (20 units a tic) that slams for `3 * (1..8)` on contact |
| Pain Elemental | the spit appeared at the Elemental's own centre with no target and no charge. It spawns `4 + (r1+r2)*1.5` ahead, is sent at the player and charges on the tic it appears, with Doom's ceiling check and 21-skull limit |
| Cyberdemon, Spider Mastermind | `+NORADIUSDMG` was ignored, so a rocket at their feet hurt them |
| Zombieman, Shotgun Guy, Chaingunner, Imp, Wolfenstein SS | health was clamped at zero, so `XDeath` could never be chosen and nothing ever gibbed |
| Cacodemon | `A_SetFloorClip`/`A_UnSetFloorClip` unanswered |
| CommanderKeen | `+SPAWNCEILING` ignored: he stood on the floor instead of hanging from the ceiling |

Two known-accepted differences remain, both in AI detail rather than in what a player sees: Doom
only switches a monster's target when hurt if it has `+QUICKTORETALIATE` (this engine always does,
which is the more responsive of the two), and `+NOTARGET` does not exempt a thing from another
monster's autoaim.

**The campaign's stored actor table is older than the compiler.** Three of the twenty-two classes
are corpses — `DeadZombieMan`, `DeadShotgunGuy`, `DeadCacodemon`, seven of which hang in Doom II's
maps — and the table on disk gives them the *living* monster's states, so `Spawn` is its `See` and
a hanging corpse walks at the player. The compiler resolves `Spawn: Goto Super::Death+4` correctly
now (verified against a fresh import of `gzdoom.pk3`), so re-importing the game fixes it. Every
other placed monster in the stored table matches a fresh import field for field.

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

**Still different, and measured.** Re-measured after the bug-hunt rounds (`player-stop` agrees to
1.1 units, `map01-idle` to 0.4):

- **One ZombieMan decides `player-walk` and `player-run`.** At tic 55 the map's first ZombieMan —
  `-112, 1136` in trace coordinates, room floor 24 — wakes in both engines. In GZDoom it walks
  *east* (`-112 → 0` by tic 110) and the player's path clears at tic 84; in OpenDLE it never moves
  and the player wedges against it at `(-92, -1109)` for the rest of the trace. `state.enemyBlocked`
  has it: every one of the eight `ENEMY_DIRECTIONS` is refused, so it cannot step aside. The
  player's body is the reason it is boxed in —
- **the player capsule is 12 units in radius; Doom's is 16** (`PLAYER_CYLINDER` in
  `shared/gravity.js`, and `radius = player ? 12` in `shared/physics.js`). A 12-unit body stands
  four units inside a 20-radius monster, where `PIT_CheckThing` would have refused the move, so the
  pair overlap and neither can move. Widening the body is **not** a one-line change: the pickup rule
  measures a fixed 36-unit *box* plus a wall trace (`playerReachesEntity`), so a 16-unit body stops
  ~0.3 units short of a Freedoom ledge bonus that is collected today
  (`test/world-motion.test.js`, "Freedoom shelf bonuses"). Widen the body and the pickup rule
  together, and re-run `npm run gzdoom:diff -- player-walk` after each half.
- **Steps.** Walking down MAP01's staircase, GZDoom is briefly airborne on every step and keeps its
  speed (no friction in the air); the Rapier character controller keeps the player grounded and
  applies friction throughout, so OpenDLE decelerates over the steps. After the wedge above this is
  the smaller difference: `player-walk` agrees to about a unit through the staircase until the
  ZombieMan stops the player.

A watched actor is how to see this: `scenario.watch` names a class and the trace mod prints its
position every tic (`{ "watch": "ZombieMan" }` in a scenario that replays the `walk` demo), so the
two engines' monsters can be compared directly instead of inferred from the player.

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
