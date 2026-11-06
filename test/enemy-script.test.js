import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { buildVanillaActors } from '../shared/actors.js';
import { AI_ACTIONS, explodeAt } from '../shared/actor-runtime.js';
import { analyseMonster, enemyEventActors, enemyScriptRules, stateSeconds } from '../shared/enemy-script.js';

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
  // The walk uses the actor's own speed (8 map units a tic is 280 a second).
  const chase = imp.find(rule => rule.name === 'DoomImp: chases');
  assert.equal(chase.actions.find(action => action.type === 'moveEnemy').speed, 280);
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
