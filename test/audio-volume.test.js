import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPlayer } from '../public/audio.js';
import { gameSettings } from '../shared/game-settings.js';
import { engineTweaks } from '../shared/engine-tweaks.js';

// Records every gain node so the effective levels can be asserted.
class RecordingContext {
  constructor() { this.gains = []; }
  destination = {};
  resume() { return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve({ decoded: true }); }
  createGain() {
    const node = { gain: { value: 1 }, connect() {}, disconnect() {} };
    this.gains.push(node);
    return node;
  }
  createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
  close() { return Promise.resolve(); }
}
function player(settings) {
  const context = new RecordingContext();
  const audio = createAudioPlayer({ assets: [], environment: {} }, () => {}, RecordingContext, context);
  const state = { settings: gameSettings(settings), sounds: [], musicRequest: null, soundOverflow: 0 };
  audio.update(state);
  const [effects, music] = context.gains;
  return { audio, effects: effects.gain.value, music: music.gain.value, state };
}

test('the overall sound level scales every sound and the soundtrack', () => {
  const full = player({ volume: .8, musicVolume: .5 });
  assert.equal(full.effects, .8);
  assert.equal(full.music, .5);
  assert.equal(full.audio.musicInfo().volume, .5);
  const quiet = player({ volume: .8, musicVolume: .5, masterVolume: .25 });
  assert.equal(quiet.effects, .2);
  assert.equal(quiet.music, .125);
  assert.equal(quiet.audio.musicInfo().volume, .125);
  const silent = player({ volume: .8, musicVolume: .5, masterVolume: 0 });
  assert.equal(silent.effects, 0);
  assert.equal(silent.music, 0);
  // Mute still wins over the overall level.
  const muted = player({ volume: .8, musicVolume: .5, masterVolume: .5, muted: true });
  assert.equal(muted.effects, 0);
  assert.equal(muted.music, 0);
  // A live change applies on the next update, without restarting the player.
  const live = player({ volume: .8, musicVolume: .5 });
  live.state.settings.masterVolume = .5;
  live.audio.update(live.state);
  assert.equal(live.audio.musicInfo().volume, .25);
});

test('the overall sound level is an engine tweak remembered between sessions', () => {
  assert.equal(engineTweaks({}).masterVolume, 1);
  // Engine tweaks are stored as JSON in the browser, so a round trip is the save.
  const stored = JSON.stringify(engineTweaks({ masterVolume: .35 }));
  assert.equal(engineTweaks(JSON.parse(stored)).masterVolume, .35);
  assert.throws(() => engineTweaks({ masterVolume: 2 }), /Invalid game setting masterVolume/);
  assert.throws(() => engineTweaks({ masterVolume: '0.5' }), /Invalid game setting masterVolume/);
});
