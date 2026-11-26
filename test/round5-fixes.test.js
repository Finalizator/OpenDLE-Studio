// Eleven defects found by probing the import, the save format, the ACS host and the switch table.
//
// Each was reproduced against the real module before its fix; the assertions below are the ones that
// failed first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, runtimeEntities } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { serializeSaveFile, saveFileDocument } from '../shared/save-files.js';
import { doomPickups } from '../shared/doom-hud.js';
import { switchPairs, wallSwitchRepeats } from '../shared/switches.js';
import { createMapScripts } from '../shared/map-scripts.js';
import { doomSpecialBehaviour } from '../shared/doom-specials.js';
import { installWorldScripts } from '../shared/world-motion.js';

test('a stimpack says it is a stimpack', () => {
  const rules = new Map(doomPickups());
  const message = type => rules.get(type).find(action => action.type === 'showMessage').message;
  assert.equal(message(2011), 'Picked up a stimpack.');
  assert.equal(message(2012), 'Picked up a medikit.');
  assert.equal(message(2014), 'Picked up a health bonus.');
});

test('a one-shot Hexen switch stays pressed, a repeatable one flickers back', () => {
  assert.equal(wallSwitchRepeats({ special: 22, specialFormat: 'zdoom' }), false);
  assert.equal(wallSwitchRepeats({ special: 22, specialFormat: 'zdoom', repeatable: true }), true);
});

test('a declared switch pair is not overwritten by the SW1/SW2 naming convention', () => {
  const project = createProject();
  project.assets = [
    { id: 'sw1', kind: 'texture', name: 'SW1DOOR' }, { id: 'sw2', kind: 'texture', name: 'SW2DOOR' },
    { id: 'on', kind: 'texture', name: 'SW2OTHER' },
  ];
  project.switches = [{ off: 'SW1DOOR', on: 'SW2OTHER' }];
  const pairs = switchPairs(project);
  assert.equal(pairs.on.get('sw1'), 'on', 'the declared pair wins');
  assert.equal(pairs.on.has('sw1') && pairs.on.get('sw1') === 'sw2', false);
});

test('the drop history travels with a save', () => {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  const state = createRuntime(project);
  state.droppedItems = new Map([['2011', 1]]);
  const record = captureGameSave(project, state, 'game');
  const restored = restoreGameSave(project, record, 'game').runtime;
  assert.deepEqual([...(restored.droppedItems || new Map())], [['2011', 1]]);
});

test('a long frame does not leave an ACS clock its own loader refuses', () => {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  const state = createRuntime(project);
  const api = createMapScripts(project, state, {});
  api.step(1.5);
  const record = captureGameSave(project, state, 'game');
  assert.ok(record, 'the save is accepted after a 1.5 s frame');
  assert.ok(restoreGameSave(project, record, 'game').runtime, 'and loads again');
});

test('GetPlayerInput reports pitch as input 2 and yaw as input 3, in BAM', () => {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  const state = createRuntime(project);
  const api = createMapScripts(project, state, {});
  state.player.angle = Math.PI / 2;
  assert.equal(api.host.playerInput(0, 3), 1073741824, 'a quarter turn is a quarter of 2^32');
  state.player.angle = -Math.PI / 2;
  assert.equal(api.host.playerInput(0, 3), -1073741824, 'and a negative yaw stays negative');
});

test('a skill mask of zero is every skill, and validates', () => {
  const project = createProject();
  project.events = [];
  project.map.entities[1].skillMask = 0;
  validateProject(project);
  assert.ok(runtimeEntities(project, { difficulty: 5 }).some(entity => entity.id === project.map.entities[1].id));
});

test('a save file is measured in bytes, not UTF-16 units', () => {
  const document = saveFileDocument({ kind: 'variables', name: 'big', variables: { blurb: '漢'.repeat(6 * 1024 * 1024) } });
  assert.throws(() => serializeSaveFile(document), /larger than the 16 MiB limit/);
});

test('the import report does not call the specials it turned into rules unsupported', () => {
  const source = readFileSync(new URL('../shared/wad.js', import.meta.url), 'utf8');
  for (const key of ["'special'", "'playercross'", "'offsetx_mid'", "'repeatspecial'"])
    assert.ok(source.includes(key), `${key} is in the supported list`);
});

test('a HUD bar bound to text draws nothing instead of freezing at its last width', () => {
  const source = readFileSync(new URL('../public/hud-view.js', import.meta.url), 'utf8');
  assert.match(source, /const amount = Number\.isFinite\(value\) \? Math\.max\(0, Math\.min\(1, value \/ element\.maximum\)\) : 0;/);
});

test('a camera texture films from the height its own object stands at', () => {
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(source, /subject\.z \?\? \(sectorOf\(subject\)\?\.floorHeight \?\? 0\) \+ \(subject\.elevation \|\| 0\)/);
});

test('classic crushers run at Doom’s own ceiling speed', () => {
  // CEILSPEED is one unit a tic — 35 a second — and only line 6's "fast" crusher uses twice that.
  // Every classic crusher here was written at twice Doom's speed.
  const speed = special => doomSpecialBehaviour(special).effect.speed;
  assert.equal(speed(6), 70, 'fast crush and raise');
  for (const special of [25, 49, 73, 141]) assert.equal(speed(special), 35, `line ${special}`);
});

test('monster attacks do Doom’s damage, not a profile written the other way round', async () => {
  // From `p_enemy.c`: `((P_Random()%N)+1)*base` — base damage, N sides. The Zombieman is 3 with 5
  // sides, not 5 with 3; the Demon bites 4 with 10; the Revenant's fist is 6 with 10; and the
  // Archvile's attack is a flat 20, not twenty with eight sides.
  const { ACTIONS } = await import('../shared/actor-runtime.js');
  const sample = name => {
    const project = createProject();
    project.events = [];
    installEngineScripts(project);
    const state = createRuntime(project);
    const attacker = { ...state.entities[0], id: 'm', actorName: 'Monster', health: 100,
      x: state.player.x + 40, y: state.player.y, angle: 0 };
    const seen = new Set();
    for (let roll = 0; roll < 400; roll++) {
      state.playerStats.health = 1000;
      ACTIONS[name]({ project, state, entity: attacker, actor: { name: 'Monster' } });
      seen.add(1000 - state.playerStats.health);
    }
    return { low: Math.min(...seen), high: Math.max(...seen) };
  };
  assert.deepEqual(sample('A_PosAttack'), { low: 3, high: 15 });
  assert.deepEqual(sample('A_CPosAttack'), { low: 3, high: 15 });
  assert.deepEqual(sample('A_SargAttack'), { low: 4, high: 40 });
  assert.deepEqual(sample('A_SkelFist'), { low: 6, high: 60 });
  assert.deepEqual(sample('A_VileAttack'), { low: 20, high: 20 });
});

test('a secret exit you walk through is a walk line, not a switch', () => {
  // Doom's line 51 is W1 (crossed); only 11 is pressed. It was wired to `use`, so walking over a
  // secret exit did nothing.
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-128, -64], [128, -64], [128, 64], [-128, 64]].map(([x, y], index) => ({ id: `v${index}`, x, y }));
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 }];
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 128, color: '#888888', solid: true, ...(index === 0 ? { special: 51 } : {}) }));
  project.map.entities = [{ ...project.map.entities[0], x: 0, y: 0, angle: 0 }];
  installWorldScripts(project, []);
  const rule = project.events.find(event => event.name.startsWith('Exit level'));
  assert.equal(rule.condition.mode, 'cross');
  assert.equal(rule.actions[0].exit, 'secret');
});
