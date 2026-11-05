import test from 'node:test';
import assert from 'node:assert/strict';
import { framesToText, textToFrames, visibleActors } from '../public/actors-panel.js';

// The actor panel's state machine editor round-trips DECORATE frames through
// `framesToText` (the textarea) and `textToFrames` (the Apply button). Applying
// without editing must not change the actor, and editing must not lose what the
// text format claims to carry.

const roundTrip = frames => {
  const text = framesToText({ states: { frames } });
  return { text, parsed: textToFrames(text) };
};

test('editor state 01: a bright frame round-trips without becoming a bogus action', () => {
  const frames = [
    { kind: 'frame', sprite: 'BAL1', letter: 'A', duration: 4, bright: true, label: 'Spawn', actions: [] },
  ];
  const { parsed } = roundTrip(frames);
  assert.deepEqual(parsed.frames, [
    { kind: 'frame', sprite: 'BAL1', letter: 'A', duration: 4, bright: true, label: 'Spawn', actions: [] },
  ]);
});

test('editor state 02: a bright frame with an action is readable, not rejected', () => {
  const frames = [
    { kind: 'frame', sprite: 'FATB', letter: 'A', duration: 2, bright: true, label: 'Spawn',
      actions: [{ name: 'A_Tracer', args: [], named: {} }] },
  ];
  const { text, parsed } = roundTrip(frames);
  assert.doesNotMatch(text, /Unreadable/);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].bright, true);
  assert.deepEqual(parsed.frames[0].actions, [{ name: 'A_Tracer', args: [], named: {} }]);
});

test('editor state 03: action arguments survive the state editor round trip', () => {
  const frames = [
    { kind: 'frame', sprite: 'TNT1', letter: 'A', duration: 3, bright: false, label: 'Missile',
      actions: [{ name: 'A_FireBullets', args: [5, 5, 1, 6], named: {} }] },
  ];
  const { parsed } = roundTrip(frames);
  assert.deepEqual(parsed.frames[0].actions, [{ name: 'A_FireBullets', args: [5, 5, 1, 6], named: {} }]);
});

test('editor state 03b: string, boolean and named arguments survive too', () => {
  const frames = [
    { kind: 'frame', sprite: 'TNT1', letter: 'A', duration: 8, bright: false, label: 'Pain',
      actions: [{ name: 'A_Jump', args: [256, 'Spawn', true, null, 'a, b) c'], named: { chance: 128 } }] },
  ];
  const { parsed } = roundTrip(frames);
  assert.deepEqual(parsed.frames[0].actions, [
    { name: 'A_Jump', args: [256, 'Spawn', true, null, 'a, b) c'], named: { chance: 128 } },
  ]);
});

test('editor state 04: a state that begins with Goto keeps its label', () => {
  const frames = [
    { kind: 'goto', target: 'See', targetIndex: 1, label: 'Spawn' },
    { kind: 'frame', sprite: 'TNT1', letter: 'A', duration: 3, bright: false, label: 'See', actions: [] },
    { kind: 'loop', target: null, targetIndex: 1, label: 'See' },
  ];
  const { parsed } = roundTrip(frames);
  assert.equal(parsed.labels.Spawn, 0, 'the Spawn label survives the round trip');
  assert.equal(parsed.frames[0].label, 'Spawn');
  assert.equal(parsed.frames[0].kind, 'goto');
  assert.equal(parsed.frames[0].target, 'See');
});

test('editor state 05: actor filters separate monsters, weapons and pickups', () => {
  const actors = [
    { name: 'Zombie', doomedNum: 3004, flags: { MONSTER: true } },
    { name: 'Pistol', doomedNum: 5010, flags: { WEAPON: true } },
    { name: 'HealthBonus', doomedNum: 2014, flags: {} },
  ];
  assert.deepEqual(visibleActors(actors, { filter: 'monster' }).map(a => a.name), ['Zombie']);
  assert.deepEqual(visibleActors(actors, { filter: 'weapon' }).map(a => a.name), ['Pistol']);
  assert.deepEqual(visibleActors(actors, { filter: 'item' }).map(a => a.name), ['HealthBonus']);
  assert.deepEqual(visibleActors(actors, { search: '3004' }).map(a => a.name), ['Zombie']);
});
