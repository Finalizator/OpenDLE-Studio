import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrace } from '../tools/gzdoom/trace.mjs';
import { compareTraces, report } from '../tools/gzdoom/compare.mjs';
import { compareActor, compareClip, readAnimation, frameLetter } from '../tools/gzdoom/animation.mjs';

const line = (tic, tag, fields) => `ODT ${tic} ${tag} cls=DoomPlayer ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')}`;

const trace = (...samples) => parseTrace([
  'ODT START map=MAP01 tics=2 action=idle watch= tid=0',
  ...samples,
  'ODT END tics=2',
].join('\n'));

test('a trace is parsed into per-tic samples and a self-describing header', () => {
  const parsed = trace(line(0, 'player', { x: -96, y: 784, z: 56, health: 100 }));
  assert.equal(parsed.header.map, 'MAP01');
  assert.equal(parsed.header.tics, 2);
  assert.equal(parsed.ended, true);
  assert.equal(parsed.samples.length, 1);
  assert.equal(parsed.samples[0].x, -96, 'numbers are numbers, not strings');
  assert.equal(parsed.samples[0].health, 100);
});

test('identical traces compare clean', () => {
  const sample = { x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 0, angle: 90, pitch: 0 };
  const result = compareTraces(trace(line(0, 'player', sample)), trace(line(0, 'player', sample)));
  assert.equal(result.first, null);
  assert.equal(result.paired.length, 1);
});

test('the first divergence is the earliest tic beyond tolerance, with both values', () => {
  const base = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, angle: 90, pitch: 0 };
  const left = trace(
    line(0, 'player', base),
    line(1, 'player', { ...base, x: 8 }),
    line(2, 'player', { ...base, x: 16 }),
  );
  const right = trace(
    line(0, 'player', base),
    line(1, 'player', { ...base, x: 8 }),
    line(2, 'player', { ...base, x: 9 }),
  );
  const result = compareTraces(left, right);
  assert.equal(result.first.tic, 2);
  assert.equal(result.first.field, 'x');
  assert.equal(result.first.left, 16);
  assert.equal(result.first.right, 9);
});

test('floating point wobble under the tolerance is not a difference', () => {
  const base = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, angle: 90, pitch: 0 };
  const result = compareTraces(
    trace(line(0, 'player', base)),
    trace(line(0, 'player', { ...base, x: 0.004 })),
    { tolerance: 0.01 },
  );
  assert.equal(result.first, null);
});

test('a field can be ignored, and a missing sample is reported rather than skipped', () => {
  const base = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, angle: 90, pitch: 0 };
  const left = trace(line(0, 'player', base), line(1, 'player', { ...base, pitch: 5 }));
  const right = trace(line(0, 'player', base));
  const ignoringPitch = compareTraces(left, right, { fields: ['x', 'y', 'z'] });
  assert.equal(ignoringPitch.first, null, 'pitch is not compared when it is not in the field list');
  assert.deepEqual(ignoringPitch.missing, ['1/player'], 'the tic the other trace lacks is listed');
  assert.match(report(ignoringPitch), /unmatched: 1/);
});

test('event lines are kept as events, not mistaken for tics', () => {
  const parsed = parseTrace([
    'ODT START map=MAP01 tics=2 action=idle watch= tid=0',
    'ODT EVENT 5 damaged=Zombieman damage=12 health=8 type=Normal',
    'ODT EVENT 5 died=Zombieman inflictor=Player',
  ].join('\n'));
  assert.equal(parsed.samples.length, 0);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[1].died, 'Zombieman');
  assert.equal(parsed.events[0].health, 8);
});

const state = (name, label, i, spr, frame, tics) => `ODT STATE ${name} label=${label} i=${i} spr=${spr} frame=${frame} tics=${tics}`;

test('a trace becomes an animation table: frames, letters and durations per label', () => {
  const animation = readAnimation([
    state('Zombieman', 'See', 0, 31, 0, 4),
    state('Zombieman', 'See', 1, 31, 1, 4),
    state('Zombieman', 'Death', 0, 31, 7, 5),
    state('Zombieman', 'Death', 1, 31, 8, -1),
  ].join('\n'));
  assert.deepEqual(animation.Zombieman.See.map(frame => frame.letter), ['A', 'B']);
  assert.equal(animation.Zombieman.Death[1].tics, -1, 'a hold-forever state keeps its -1');
  assert.equal(frameLetter(0), 'A');
  assert.equal(frameLetter(25), 'Z');
});

test('a measured clip is compared with an actor record by frames, letters and durations', () => {
  const record = { states: { labels: { See: 0 }, frames: [
    { kind: 'frame', label: 'See', letter: 'A', duration: 4 },
    { kind: 'frame', label: 'See', letter: 'B', duration: 4 },
    { kind: 'loop', label: 'See', target: 'See' },
  ] } };
  const matching = compareActor('Zombieman', { See: [{ letter: 'A', tics: 4 }, { letter: 'B', tics: 4 }] }, record);
  assert.deepEqual(matching, [], 'a matching actor reports nothing');

  const wrong = compareActor('Zombieman', { See: [{ letter: 'A', tics: 4 }, { letter: 'C', tics: 8 }] }, record);
  assert.equal(wrong.length, 2, 'one letter and one duration differ');
  assert.equal(wrong[0].kind, 'letter');
  assert.equal(wrong[1].kind, 'tics');
});

test('a frame GZDoom skips immediately counts as one tic on both sides', () => {
  // Doom writes `Tics 0` for "no delay"; the actor still spends the tic it entered on, and
  // OpenDLE's runtime advances it in one tic, so the two must compare as equal.
  const problems = compareClip('Missile', [{ letter: 'F', tics: 0 }], [{ letter: 'F', tics: 0 }]);
  assert.deepEqual(problems, []);
});
