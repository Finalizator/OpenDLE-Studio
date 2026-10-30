import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSurfaceAnimations } from '../shared/animdefs.js';

test('ANIMDEFS range, block and single-picture forms keep their own timings', () => {
  const { sequences, switches, effects } = parseSurfaceAnimations([`
    // Lullaby's own file
    Texture Optional   TFALL1   Range   TFALL4   Tics 4
    Texture Optional   PSTAR01  Range   PSTAR12  Tics 4
    Switch  Doom 1     ZKMBGSW1 On Pic  ZKMBGSW2 Tics 0
    Texture SWATER1 { pic SWATER1 tics 8 pic SWATER2 tics 3 }
    flat  STILL1
    warp2 texture FWATER1
  `]);
  assert.deepEqual(sequences.map(sequence => [sequence.kind, sequence.frames.map(frame => `${frame.name}@${frame.tics}`)]), [
    ['texture', ['TFALL1@4', 'TFALL4@4']],
    ['texture', ['PSTAR01@4', 'PSTAR12@4']],
    ['texture', ['SWATER1@8', 'SWATER2@3']],
    ['flat', ['STILL1@8']],
  ]);
  // The range is recorded so the caller can expand it against the artwork it imported.
  assert.deepEqual(sequences[0].range, { from: 'TFALL1', to: 'TFALL4', tics: 4 });
  assert.equal(switches, 1, 'a switch is not an animation');
  assert.deepEqual(effects, ['FWATER1'], 'shader animations are named, not faked');
});

test('ANIMDEFS that GZDoom accepts but this importer cannot draw is reported, not refused', () => {
  const warnings = [];
  const parsed = parseSurfaceAnimations(['warp flat WATR1\nwarp2 texture WATR2\nfbm flat WATR3\nnoise flat WATR4', 'Texture A1 tics 2'], { warn: message => warnings.push(message) });
  assert.equal(parsed.sequences.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /shader effects/);
});

test('ANIMDEFS parsing is bounded and tolerant of truncated input', () => {
  const many = Array.from({ length: 400 }, (unused, index) => `texture T${index} Range T${index}4 tics 4`).join('\n');
  const parsed = parseSurfaceAnimations([many]);
  assert.ok(parsed.sequences.length <= 256, 'the sequence budget bounds the work');
  const truncated = parseSurfaceAnimations(['texture A { pic A tics 4 pic B']);
  assert.equal(truncated.sequences[0].frames.length, 2);
  assert.deepEqual(parseSurfaceAnimations([]).sequences, []);
  assert.deepEqual(parseSurfaceAnimations([null, undefined, '']).sequences, []);
});
