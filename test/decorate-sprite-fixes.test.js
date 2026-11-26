// Four parser and cache mistakes, each a different root cause.
//
// A DECORATE `States { … } }` whose closing braces share a line — the shape every minified or
// generated file has — never closed the actor, so the following actor vanished with its doomed
// number. A state label redefined in a different case (`see:` for `See`) was kept beside the
// inherited one and could never be reached. The sprite-name cache never noticed an asset added
// after it was built. And an effect clip remembered its own miss, so a puff whose artwork arrived
// later never animated.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecorate, resolveActorInheritance, compileActorStates } from '../shared/decorate.js';
import { spriteAssetNames, actorEffectClip } from '../shared/sprite-animation.js';
import { weaponScriptRules } from '../shared/weapon-script.js';
import { createProject } from '../shared/project.js';
import { buildVanillaActors } from '../shared/actors.js';

const labels = text => {
  const { actors } = parseDecorate(text);
  return resolveActorInheritance(actors);
};

test('a States block closing on the same line as its actor does not swallow the next actor', () => {
  const { byName, warnings } = labels([
    'actor A 9001 {', 'States {', '  See:', '    TROO A 4 A_Look', '    Loop', '} }',
    'actor B 9002 { Health 5 }',
  ].join('\n'));
  assert.ok(byName.get('A'), 'the first actor is read');
  assert.ok(byName.get('B'), 'and so is the one after it');
  assert.equal(byName.get('B').doomedNum, 9002, 'with its own doomed number');
  assert.deepEqual(warnings.filter(warning => /swallow|unterminated/i.test(warning)), []);
});

test('a property on the line that opens the block is kept', () => {
  const { byName } = labels(['actor A 9001', '{ Health 5', '  States { See: TROO A 4 A_Look Loop } }'].join('\n'));
  assert.equal(byName.get('A').properties.Health, 5);
});

test('a state label redefined in another case replaces the inherited one', () => {
  const { actors, byName } = labels(`actor Base 9001
{
  Health 10
  States
  {
  See:
    TROO A 4 A_Look
    Loop
  }
}
actor Child : Base 9002
{
  States
  {
  see:
    TROO C 4 A_Chase
    Loop
  }
}
`);
  assert.ok(byName.get('Child'), 'both actors are read');
  const child = actors.get('Child');
  assert.deepEqual([...child.labels.keys()], ['see'], 'one label, not two');
  const compiled = compileActorStates(child, { parentLookup: name => actors.get(name) });
  assert.equal(compiled.frames[0].letter, 'C', 'the child’s own frames run, not the inherited ones');
});

test('the sprite-name cache notices an asset added after it was built', () => {
  const project = { assets: [{ id: 'a1', kind: 'sprite', name: 'PUFFA0' }], spriteClips: [] };
  const first = spriteAssetNames(project);
  assert.ok(first.has('PUFFA0'));
  project.assets.push({ id: 'a2', kind: 'sprite', name: 'PUFFB0' });
  assert.ok(spriteAssetNames(project).has('PUFFB0'), 'a sprite imported later is found');
});

test('an effect clip whose artwork has not arrived yet is not remembered as a miss', () => {
  const actor = { id: 'puff', name: 'Puff', states: { frames: [
    { kind: 'frame', sprite: 'PUFF', letter: 'B', duration: 4, label: 'Spawn', actions: [] }],
    labels: { Spawn: 0 } } };
  const project = { assets: [{ id: 'a1', kind: 'sprite', name: 'PUFFA0' }], spriteClips: [] };
  assert.equal(actorEffectClip(project, actor), null, 'nothing to draw yet');
  project.assets.push({ id: 'b1', kind: 'sprite', name: 'PUFFB0' });
  assert.ok(actorEffectClip(project, actor), 'and it draws once the sprite is imported');
});

test('two actors for one weapon slot do not become two rules sharing one cooldown', () => {
  const project = createProject();
  project.actors = buildVanillaActors();
  const fist = project.actors.find(actor => actor.name === 'Fist');
  project.actors.push({ ...structuredClone(fist), name: 'Punch' });
  const { events, skipped } = weaponScriptRules(project, { sheetId: 's', groupId: 'g' });
  assert.equal(events.filter(event => event.name === 'fist').length, 1, 'one rule drives the slot');
  assert.ok(skipped.some(item => item.name === 'Punch'), 'and the duplicate is reported, not silently dead');
});
