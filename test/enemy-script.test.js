import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { buildVanillaActors } from '../shared/actors.js';
import { AI_ACTIONS, explodeAt, hurtActor, setActorState } from '../shared/actor-runtime.js';
import { analyseMonster, chaseStepTics, enemyEventActors, enemyScriptRules, propEventActors, stateSeconds } from '../shared/enemy-script.js';
import { projectileEventActors } from '../shared/projectile-script.js';

function imported() {
  const project = createProject();
  project.events = [];
  project.actors = buildVanillaActors();
  installEngineScripts(project, { includeHUD: false });
  return project;
}

test('a monster state that animates an attack states its own length in seconds', () => {
  const imp = buildVanillaActors().find(actor => actor.name === 'DoomImp');
  const seconds = stateSeconds(imp, 'Missile');
  assert.ok(seconds > 0 && seconds < 15, `the missile state lasts ${seconds}s`);
  assert.equal(stateSeconds(imp, 'NoSuchState'), null);
});

test('each imported monster archetype becomes rules that decide, not animate', () => {
  const project = imported();
  const sheet = project.eventSheets.find(entry => entry.name === 'Enemies');
  const rules = project.events.filter(event => event.sheetId === sheet.id && event.enemyActor);
  const names = new Set(rules.map(rule => rule.enemyActor));
  assert.ok(names.has('DoomImp') && names.has('BaronOfHell'), 'the monsters on the map are translated');
  const imp = rules.filter(rule => rule.enemyActor === 'DoomImp');
  assert.deepEqual(imp.map(rule => rule.name), ['DoomImp: notices the player', 'DoomImp: chases',
    'DoomImp: attacks', 'DoomImp: melee when close']);
  // Every rule names its archetype and applies to the level's enemies.
  for (const rule of rules) {
    assert.equal(rule.forEachType, 'enemy');
    assert.ok(rule.conditions.some(condition => condition.type === 'entityActorName' && condition.actor === rule.enemyActor));
  }
  // The walk uses the actor's own speed *as `A_Chase` applies it*: 8 map units once per See
  // frame, and an imp's See frames last 3 tics — 8 × 35 / 3 = 93 a second, not 280.
  const chase = imp.find(rule => rule.name === 'DoomImp: chases');
  assert.equal(chase.actions.find(action => action.type === 'moveEnemy').speed, 93);
  // The attack goes through the actor's own state, which is where its attack lives.
  const attack = imp.find(rule => rule.name === 'DoomImp: attacks');
  assert.deepEqual(attack.actions.find(action => action.type === 'playActorState'), { type: 'playActorState', entityId: '$self', state: 'Missile' });
  validateProject(project);
});

test('a translated monster stops deciding in its state machine', () => {
  const project = imported();
  const machine = imported();
  const sheet = machine.eventSheets.find(entry => entry.name === 'Enemies');
  machine.events = machine.events.filter(event => event.sheetId !== sheet.id);
  assert.ok(enemyEventActors(project).includes('doomimp'));
  assert.deepEqual(enemyEventActors(machine), [], 'without the rules the machine decides again');
  // The decisions the rules took over are exactly the AI actions.
  for (const name of ['A_Look', 'A_Chase', 'A_FaceTarget', 'A_AlertMonsters']) assert.ok(AI_ACTIONS.has(name));
  assert.equal(AI_ACTIONS.has('A_TroopAttack'), false, 'the attack function stays with the state');
});

test('a translated monster wakes, walks and fires from its states', () => {
  const project = imported();
  const state = createRuntime(project);
  state.hasGame = true;
  const player = state.entities.find(entity => entity.type === 'player');
  const enemy = { id: 'imp1', type: 'enemy', name: 'Imp', actorName: 'DoomImp', doomType: 3001,
    x: player.x + 160, y: player.y, z: 0, elevation: 0, health: 60, radius: 20, height: 56, angle: 180, solid: true };
  state.entities.push(enemy);
  let fired = false;
  for (let tic = 0; tic < 60 && !fired; tic++) {
    stepRuntime(project, state, 1 / 35, new Set());
    fired = state.projectiles.length > 0;
  }
  assert.ok(state.time < (state.timers.get(`${enemy.id}:alert`) || 0), 'the notice rule alarmed it');
  assert.notEqual(enemy.stateLabel, 'Spawn', 'its states moved on from standing');
  // A wall-free test map lets it see the player, so it should eventually throw a ball.
  assert.ok(fired, 'the imp attacked through its own Missile state');
});

test('a monster with nothing to attack with keeps its machine and is reported', () => {
  const project = { actors: [{ name: 'Statue', flags: { MONSTER: true }, states: { labels: { Spawn: 0 }, frames: [] }, health: 10 }],
    events: [], eventSheets: [], eventGroups: [], variables: {}, map: { entities: [] }, assets: [] };
  const actor = project.actors[0];
  const plan = analyseMonster(project, actor);
  assert.equal(plan.expressible, false);
  assert.match(plan.reasons[0], /no See state/);
  const { events, skipped } = enemyScriptRules(project);
  assert.equal(events.length, 0);
  assert.deepEqual(skipped.map(item => item.name), ['Statue']);
});

test('an explosion is one action a rule can take, not a function only the machine runs', () => {
  // The rocket's Death state calls `A_Explode`; a rule that wants a barrel to blow up, or a
  // translated blast of its own, takes the same action with the same numbers.
  const project = imported();
  const state = createRuntime(project);
  state.hasGame = true;
  const player = state.entities.find(entity => entity.type === 'player');
  const barrel = { id: 'barrel', type: 'enemy', name: 'Barrel', x: player.x + 40, y: player.y, z: 0,
    elevation: 0, health: 500, radius: 20, height: 56, angle: 0, solid: true };
  state.entities.push(barrel);
  const before = state.playerStats.health;
  explodeAt(project, state, barrel, 128, 128);
  assert.ok(state.playerStats.health < before, 'a blast beside the player hurts him');
  assert.ok(state.sounds.some(sound => sound.name === 'DSBAREXP'), 'and it makes the blast sound');
});

test('missiles that do more than fly straight are rules now', () => {
  // The rocket's blast, the revenant's homing and the BFG's spray were the last gameplay
  // the projectile machine ran out of sight; each is generated as a rule about the missile.
  const project = imported();
  const world = project.eventSheets.find(entry => entry.name === 'World');
  const rules = project.events.filter(event => event.sheetId === world.id && event.projectileActor);
  assert.deepEqual(rules.map(rule => rule.actions[0].type).sort(), ['bfgSpray', 'explodeArea', 'homeMissile']);
  const rocket = rules.find(rule => rule.projectileActor === 'Rocket');
  assert.deepEqual(rocket.condition, { type: 'projectileState', entityId: '$self', state: 'Death' });
  assert.deepEqual(rocket.actions[0], { type: 'explodeArea', entityId: '$self', damage: 128, radius: 128 });
  assert.ok(rocket.conditions.some(condition => condition.type === 'entityActorName' && condition.actor === 'Rocket'));
  assert.deepEqual(projectileEventActors(project), ['bfgball', 'revenanttracer', 'rocket']);
  validateProject(project);
});

test('a barrel is a shootable prop whose blast is a rule', () => {
  // Without an actor record a barrel imported as a flat decoration nobody could shoot;
  // it now has health, a Death state, and two rules generated from that state.
  const { actors } = { actors: buildVanillaActors() };
  const barrel = actors.find(actor => actor.name === 'ExplosiveBarrel');
  assert.ok(barrel, 'the classic barrel is in the actor table');
  assert.equal(barrel.doomedNum, 2035);
  assert.equal(barrel.health, 20);
  assert.equal(barrel.flags.SHOOTABLE, true);

  const project = imported();
  const world = project.eventSheets.find(entry => entry.name === 'World');
  const rules = project.events.filter(event => event.sheetId === world.id && event.propActor);
  assert.deepEqual(rules.map(rule => rule.name), ['ExplosiveBarrel: explodes', 'ExplosiveBarrel: stops blocking']);
  assert.deepEqual(propEventActors(project), ['explosivebarrel']);
  const blast = rules.find(rule => rule.name === 'ExplosiveBarrel: explodes');
  assert.deepEqual(blast.actions[1], { type: 'explodeArea', entityId: '$self', damage: 128, radius: 128 });
  validateProject(project);

  // It explodes once, not once a frame, and it stops blocking.
  const state = createRuntime(project);
  state.hasGame = true;
  const player = state.entities.find(entity => entity.type === 'player');
  const target = { id: 'barrel1', type: 'enemy', name: 'Barrel', doomType: 2035, actorName: 'ExplosiveBarrel',
    actorId: 'actor_explosivebarrel', x: player.x + 40, y: player.y, z: 0, elevation: 0, radius: 10,
    height: 32, angle: 0, solid: true, health: 20, maxHealth: 20 };
  state.entities.push(target);
  stepRuntime(project, state, 1 / 35, new Set());
  hurtActor(project, state, target, 20);
  // In play `stepActors` moves a dead actor into its Death state; this map has no
  // geometry for that loop to walk, so the same state change is made directly.
  setActorState(project, target, 'Death');
  for (let tic = 0; tic < 30; tic++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(target.stateLabel, 'Death');
  assert.equal(target.solid, false, 'the corpse stops blocking');
  // 128 damage falls off over a 128 radius, so 40 units away is 88: one blast, not seven.
  assert.equal(state.playerStats.health, 12);
});

test('a translated monster cannot restart its attack, and rolls the dice once a tic', () => {
  // Two problems this pins down, both reported from play as "movement broken and too fast":
  //
  // - Re-entering `Missile` while already in it restarted the animation instead of playing it,
  //   so the monster stood in its firing pose for good and looked like it was flapping. The
  //   attack has to wait until the states are back in `See`, which is what `notAttacking` says.
  // - Doom rolls `P_CheckMissileRange` once a tic (35 Hz). Evaluated once a frame it fired more
  //   often the faster the machine drew, so the rule carries `oncePerTic`.
  const project = imported();
  const rules = project.events.filter(event => event.enemyActor === 'DoomImp');
  for (const name of ['DoomImp: attacks', 'DoomImp: melee when close']) {
    const rule = rules.find(event => event.name === name);
    assert.ok(rule, `${name} exists`);
    const kinds = rule.conditions.map(condition => condition.type);
    assert.ok(kinds.includes('oncePerTic'), `${name} decides at most once a tic`);
    for (const state of ['Melee', 'Missile'])
      assert.ok(rule.conditions.some(condition => condition.type === 'actorState' &&
        condition.state === state && condition.inverted === true), `${name} waits out ${state}`);
  }
  const chase = rules.find(event => event.name === 'DoomImp: chases');
  assert.ok(!chase.conditions.some(condition => condition.type === 'oncePerTic'),
    'the walk itself keeps moving every frame, because `moveEnemy` takes the frame time');
});

test('a translated monster walks at Doom speed whatever the frame rate', () => {
  // `moveEnemy` takes the frame time, so a walk has to cover the same ground at 30, 60 and
  // 144 frames a second. An imp walks 8 units per 3-tic See frame, which is 93 a second.
  const travel = fps => {
    const project = imported();
    // A room with room to walk: the starter map is small enough that a walker would reach the
    // player in a fraction of a second and stop, which would measure nothing.
    project.map.vertices = [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]]
      .map(([x, y], index) => ({ id: `v${index}`, x, y }));
    const side = { sectorId: 'room', offsetX: 0, offsetY: 0 };
    project.map.walls = [['v0', 'v1'], ['v1', 'v2'], ['v2', 'v3'], ['v3', 'v0']].map(([a, b], index) => ({
      id: `w${index}`, a, b, right: side, left: null, solid: true, height: 256, color: '#888888', flags: 0 }));
    project.map.sectors = [{ id: 'room', floorHeight: 0, ceilingHeight: 256, light: 255, sky: false }];
    const state = createRuntime(project);
    const player = state.entities.find(entity => entity.type === 'player');
    const enemy = { id: 'walker', type: 'enemy', name: 'Imp', actorName: 'DoomImp', doomType: 3001,
      x: player.x - 1800, y: player.y, z: 0, elevation: 0, health: 60, radius: 20, height: 56, angle: 0, solid: true };
    state.entities.push(enemy);
    // Alert without attacking: a far-away walker only rolls for an attack a fifth of the time,
    // which would blur the measurement. The walk rule is what is being measured.
    state.timers.set(`${enemy.id}:alert`, 999);
    project.events = project.events.filter(event => !/: attacks$/.test(event.name || ''));
    const start = { x: enemy.x, y: enemy.y };
    for (let frame = 0; frame < fps; frame++) stepRuntime(project, state, 1 / fps, new Set());
    return Math.hypot(enemy.x - start.x, enemy.y - start.y);
  };
  const thirty = travel(30), sixty = travel(60), fast = travel(144);
  for (const [name, moved] of [['30 fps', thirty], ['60 fps', sixty], ['144 fps', fast]])
    assert.ok(Math.abs(moved - 93) < 4, `${name} covers ${moved.toFixed(1)} units a second, not 93`);
});

test('a translated monster waits out its attack before it decides on another', () => {
  // The bug this pins: the attack rule re-entered `Missile` every time its timer was ready, so
  // the state restarted instead of playing, and the monster never walked again.
  const project = imported();
  const state = createRuntime(project);
  const player = state.entities.find(entity => entity.type === 'player');
  const enemy = { id: 'imp2', type: 'enemy', name: 'Imp', actorName: 'DoomImp', doomType: 3001,
    x: player.x + 120, y: player.y, z: 0, elevation: 0, health: 60, radius: 20, height: 56, angle: 180, solid: true };
  state.entities.push(enemy);
  let entries = 0, previous = null;
  for (let tic = 0; tic < 120; tic++) {
    stepRuntime(project, state, 1 / 35, new Set());
    if (enemy.stateLabel === 'Missile' && previous !== 'Missile') entries++;
    previous = enemy.stateLabel;
  }
  // A 22-tic Missile state in a 120-tic window can be entered a handful of times, but a rule
  // that restarts it every frame would enter it dozens of times.
  assert.ok(entries >= 1, 'the imp attacked through its own Missile state');
  assert.ok(entries <= 6, `the attack plays out instead of restarting: ${entries} entries`);
});

test('a translated monster walks at the pace its own See frames give it', () => {
  // The regression that made monsters four times too fast. `A_Chase` moves `Speed` map units
  // once per **state frame**, and classic See states are frames of four tics — GZDoom's own
  // trace in `Docs/gzdoom-parity.md` records "a Zombieman moves 8 units every four tics". A
  // rule that moved the monster every tic therefore walked it at 280 a second instead of 70.
  const actors = buildVanillaActors();
  const expected = { ZombieMan: 4, DoomImp: 3, Demon: 2, BaronOfHell: 3, LostSoul: 6 };
  for (const [name, tics] of Object.entries(expected)) {
    const actor = actors.find(candidate => candidate.name === name);
    assert.ok(actor, `${name} is in the vanilla table`);
    assert.equal(chaseStepTics(actor), tics, `${name} calls A_Chase every ${tics} tics`);
    const plan = analyseMonster({}, actor);
    assert.equal(plan.speed, Math.round(actor.speed * 35 / tics),
      `${name} walks ${plan.speed} units a second: ${actor.speed} units every ${tics} tics`);
  }
  // A Zombieman is the number the parity doc measured: 8 units every four tics is 70 a second.
  const zombie = analyzeZombie(actors.find(actor => actor.name === 'ZombieMan'));
  assert.equal(zombie, 70);
});

/** The Zombieman's walking speed in units a second, as the rules give it. */
function analyzeZombie(actor) {
  return analyseMonster({}, actor).speed;
}
