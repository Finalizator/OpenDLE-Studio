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
      `instructionAt` and translates a body that is only pushes and line specials into
      `runLineSpecial` actions (2 of 11 scripts on Ascent MAP05 today). Still to add:
      assignments, `Print`/`HudMessage`, `ACS_Execute`, inventory and damage calls.
- [ ] **Step 3 — control flow.** `if`/`while`/`for` become sub-events; loops that wait
      become timers. Where bytecode cannot be expressed (raw stack juggling,
      `ScriptWait` across call frames), the rule keeps a `runScript(n)` action and says
      why — never silently dropped.
- [ ] Tests: a decompiled script runs and does what the bytecode did, for each step.

## 4. ZScript functions

- [ ] Class defaults and states are already parsed into actor records.
- [ ] Function bodies (a `States` frame that calls a user function) go through the same
      body compiler as ACS steps 2–3.
- [ ] Until then, the `actor_unsupported` report must keep naming them, and must not say
      "unsupported by design".

## Definition of done

For a Doom II import: no gameplay decision is taken by engine code that a creator
cannot see, edit or delete in a sheet. Presentation (frames, sounds, sprites) stays data;
decisions are rules. Anything the compiler cannot express must appear as an explicit
`runScript`/`runFunction` rule with a reason, never as silence.
