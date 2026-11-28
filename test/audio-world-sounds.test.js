/**
 * Positioned one-shot effects.
 *
 * A monster's shot, a door and a pickup all carry a place, and the panner that puts them there was
 * set up through a helper that only existed inside the *other* audio closure. Every positioned
 * effect therefore threw `positionNode is not defined` and was dropped — silently, because the
 * throw happened inside a promise's `then` and surfaced as a status-line error rather than a
 * missing sound. The fake contexts in the other audio tests have no `createPanner`, so nothing
 * reached the branch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPlayer } from '../public/audio.js';

const soundProject = () => ({
  environment: {},
  assets: [{ id: 'snd_shot', name: 'DSPISTOL', kind: 'sound', src: 'data:audio/wav;base64,AAAA' }],
});

/** A context whose panner records where it was put, in both Web Audio shapes. */
function pannerContext({ modern }) {
  const placed = [];
  const started = [];
  class Context {
    constructor() {
      this.destination = {}; this.sampleRate = 8000; this.currentTime = 0;
      this.listener = modern
        ? { positionX: { value: 0, setValueAtTime(v) { this.value = v; } },
          positionY: { value: 0, setValueAtTime(v) { this.value = v; } },
          positionZ: { value: 0, setValueAtTime(v) { this.value = v; } },
          forwardX: { value: 0, setValueAtTime(v) { this.value = v; } },
          forwardY: { value: 0, setValueAtTime(v) { this.value = v; } },
          forwardZ: { value: 0, setValueAtTime(v) { this.value = v; } },
          upX: { value: 0, setValueAtTime(v) { this.value = v; } },
          upY: { value: 0, setValueAtTime(v) { this.value = v; } },
          upZ: { value: 0, setValueAtTime(v) { this.value = v; } } }
        : { setOrientation() {} };
    }
    decodeAudioData() { return Promise.resolve({ duration: 1 }); }
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() { started.push('start'); }, stop() {} };
    }
    createPanner() {
      const node = { connect() {}, disconnect() {}, setPosition(x, y, z) { placed.push([x, y, z]); } };
      if (modern) node.positionX = { value: 0, setValueAtTime(v) { this.value = v; placed.push(['x', v]); } },
        node.positionY = { value: 0, setValueAtTime(v) { this.value = v; placed.push(['y', v]); } },
        node.positionZ = { value: 0, setValueAtTime(v) { this.value = v; placed.push(['z', v]); } };
      return node;
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  return { Context, placed, started };
}

for (const modern of [false, true]) {
  test(`a sound with a place is panned there (${modern ? 'AudioParam' : 'setPosition'} panners)`, async () => {
    const { Context, placed, started } = pannerContext({ modern });
    const errors = [];
    const player = createAudioPlayer(soundProject(), message => errors.push(message), Context);
    // The listener is placed first, then the effect at (128, 0, 64) — Doom (x, y) with z up.
    player.update({ settings: { muted: false, volume: 1, musicVolume: 0 }, sounds: [], soundOverflow: 0,
      player: { x: 0, y: 0, z: 0, angle: 0, pitch: 0 }, gameScreen: 'playing' });
    player.update({ settings: { muted: false, volume: 1, musicVolume: 0 }, soundOverflow: 0,
      player: { x: 0, y: 0, z: 0, angle: 0, pitch: 0 }, gameScreen: 'playing',
      sounds: [{ name: 'DSPISTOL', volume: 1, position: { x: 128, y: 64, z: 0 } }] });
    await new Promise(resolve => setImmediate(resolve));
    player.dispose();
    assert.deepEqual(errors, [], `the effect reported no error: ${errors.join(' / ')}`);
    assert.ok(started.length >= 1, 'the effect started');
    if (modern) {
      const x = placed.filter(entry => entry[0] === 'x').at(-1);
      const y = placed.filter(entry => entry[0] === 'y').at(-1);
      const z = placed.filter(entry => entry[0] === 'z').at(-1);
      assert.equal(x?.[1], 128, 'the panner sits at the sound');
      assert.equal(y?.[1], 0, 'Doom z is the vertical axis');
      assert.equal(z?.[1], 64, 'Doom y is the other ground axis');
    } else {
      assert.deepEqual(placed.at(-1), [128, 0, 64], 'the panner sits at the sound');
    }
  });
}

test('a sound with no place plays unpanned and is not dropped', async () => {
  const { Context, placed, started } = pannerContext({ modern: true });
  const errors = [];
  const player = createAudioPlayer(soundProject(), message => errors.push(message), Context);
  player.update({ settings: { muted: false, volume: 1, musicVolume: 0 }, soundOverflow: 0,
    player: { x: 0, y: 0, z: 0, angle: 0, pitch: 0 }, gameScreen: 'playing',
    sounds: [{ name: 'DSPISTOL', volume: 1 }] });
  await new Promise(resolve => setImmediate(resolve));
  player.dispose();
  assert.deepEqual(errors, []);
  assert.ok(started.length >= 1, 'an unpanned effect still plays');
  assert.equal(placed.length, 0, 'nothing was placed');
});
