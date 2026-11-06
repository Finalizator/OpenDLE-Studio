# Visual-script migration: all imported logic into event sheets

The engine rule is that a project's gameplay is readable and editable in its event
sheets. This file is the working plan for the parts of an imported game that still run
inside engine code, written so a session can pick up where the last one stopped.

Status legend: `[x]` done and committed · `[~]` partly done · `[ ]` not started.

## Landed

- [x] **Weapons** — every imported weapon is a rule in the Weapons sheet, written from
      its own states (ammo, shot, projectile class, cadence, `AltFire`).
      `shared/weapon-script.js`, commit `eee8814`.
- [x] **Monsters** — every archetype gets notice / chase / attack / melee rules in the
      Enemies sheet, and the machine stops taking those decisions (`AI_ACTIONS`).
      `shared/enemy-script.js`, commit `7624854`.
- [x] **Blast** — `explodeArea` action, shared with `A_Explode` (`explodeAt`).
      Commit `2a676a4`.
- [x] **Homing** — `homeMissile` shared with `A_Tracer`. Commit `3edaba2`.
- [x] Already rule-driven before this work: Input, Player, Combat, HUD, World (line
      specials), Pickups (20 rules per Doom thing), game menus, level intermission.

## 1. Missiles and effects (blasting, homing, BFG spray)

The remaining blocker is that rules iterate **entities** while missiles live in
`state.projectiles`.

- [x] `forEachType: 'projectile'` in the event runtime: iterate `state.projectiles`,
      give each rule instance `ownerId` = the projectile id, and let `findTarget`
      resolve ids from the projectile list as well as the entity list.
- [x] `projectileState` condition (label), mirroring `actorState`.
- [x] `PROJECTILE_ACTIONS` suppression set (mirroring `AI_ACTIONS`) so a translated
      missile's state stops calling `A_Tracer`, `A_Explode`, `A_BFGSpray`,
      `A_SpawnItemEx`.
- [x] `homeMissile` and `bfgSpray` actions in the catalogue, targeting `$self`.
- [x] `bfgSpray` extracted as a function shared with `A_BFGSpray`.
- [x] `shared/projectile-script.js`: per missile actor, the rules that fly and detonate
      it, wired into `installEngineScripts` (RevenantTracer, Rocket, BFGBall).
- [x] Tests: the generated rules carry the mod's numbers and the actor set is marked.

## 2. Props and item actors

- [x] Shootable props: `ExplosiveBarrel` is a real actor (health 20, `Death` with
      `A_Scream`/`A_Explode`/`A_NoBlocking`) instead of a flat decoration, and its blast
      and solidity are rules (`PROP_FUNCTIONS` suppression).
- [ ] Emit `entityDamaged` → `playSound` (the actor's own pain sound) for item archetypes.
      Take behaviour is already 20 rules in the Pickups sheet.

## 3. ACS (`BEHAVIOR`) decompiler

The compiled map scripts need a decompiler, not a translation pass. Three steps, each
useful alone:

- [x] **Step 1 — script becomes a rule.** `OPEN`/`ENTER` scripts are rules in the World
      sheet (`runScript`, numbers in `mapScripts.ruleScripts`); linedef-triggered ones
      already ran from their line's rule. The body stays the module, linked in the
      Scripts tab.
- [~] **Step 2 — straight-line bodies become rules.** `shared/acs-decompile.js` walks
      `instructionAt` and translates a body into steps: pushes and line specials become
      `runLineSpecial`, a wait splits the script (each step waits on the timer the one
      before it started), map/world/global variables become `setAcsVariable` / `acsVariable`
      / `acsvar("map", n)`, and an `IFNOTGOTO` guard becomes a **sub-event** of its step
      (all 11 scripts of Ascent MAP05, and 30 of the 54 scripts across the whole Ascension
      campaign today; `node /tmp/cov.mjs`-style scans are cheap to redo — decompile every
      script of every map and count). The builtins a script calls directly are
      actions that use the interpreter's host functions: `setSectorFlat`
      (`ChangeFloor`/`ChangeCeiling`), `setLineTexture`, `setLineBlocking`,
      `setLineMonsterBlocking`, `setLineSpecial`; `Random` becomes the expression
      `floor(random(min, max))` over the script's own bounds, and a flat or texture kept in a
      variable is the expression `acsflat("map", n)` — the name read from the module's string
      table when the rule runs. The inventory and damage calls are actions too
      (`giveInventory`, `takeInventory`, `damageThing`, `sectorDamage`, with `acsInventory`
      for `CheckInventory`). Still to add: loops (backward jumps), `SetThingSpecial`,
      `Spawn`, `ClearInventory`, and arrays. The remaining blockers, in the order the corpus
      hits them: **loops** (`TeleportNorth`, `TeleportSouth`, `DieAltar`, `BossStart` — ACC
      compiles `for` as a header test jumping *into* the body with a `GOTO exit` on the false
      path, then an increment block and a back edge, so the linear walker must learn that
      shape or the sheets need an iteration construct), **`CALLFUNC`** (user functions such as
      `StarDraw`, which draw HUD art through `HudMessage`), **`GETACTORPROPERTY`**
      (`BossHealth` reads health and max health into script variables), **`ASSIGNSCRIPTARRAY`**
      and **`SETHUDSIZE`** (`BossStart`), and `REPLACETEXTURES` (the interpreter itself does
      nothing for it — translating it would bake that gap into the sheet).
- [~] **Step 3 — control flow.** `if` is done: an `IFNOTGOTO` guard is a sub-event of the
      rule that runs before it, so the counter-increment-then-test order of the script
      survives (`openLabDoor` in MAP05 reads exactly as its bytecode did). Still open:
      `while`/`for` (backward jumps) as a timer-driven loop, and an `else` (a forwarded
      `GOTO` over one branch). Where bytecode cannot be expressed (raw stack juggling,
      `ScriptWait` across call frames), the rule keeps a `runScript(n)` action — never a
      silent drop.
- [~] Tests: `test/acs.test.js` covers the counter-and-guard script both as rules and at
      run time, and a rule reading and writing the interpreter's own ACS variables.

## 4. ZScript functions

- [x] Class defaults and states are already parsed into actor records.
- [~] Function bodies (a `States` frame that calls a user function) are executed by
      `shared/actor-functions.js`: declarations, arithmetic, comparisons, `if`/`else`, and
      engine actions called from inside the body (`A_PlaySound("x")`), all against the
      actor the frame belongs to. Still missing: loops, calls to other user functions, and
      reading another actor — each of those is named in `actor_unsupported` and changes
      nothing, so the report keeps telling the truth. The next step is to compile the body
      into rules (`runFunction` with the actions it performs) so a creator can edit it.
- [x] The `actor_unsupported` report names them, per actor, and never says "unsupported by
      design".

## Definition of done

For a Doom II import: no gameplay decision is taken by engine code that a creator
cannot see, edit or delete in a sheet. Presentation (frames, sounds, sprites) stays data;
decisions are rules. Anything the compiler cannot express must appear as an explicit
`runScript`/`runFunction` rule with a reason, never as silence.
