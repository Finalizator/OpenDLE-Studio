/**
 * Sound/music playback regressions beyond the container-format fixes.
 *
 * Each finding is reproduced against the implementation before its fix: the fixture
 * reaches the real public path, fails for the claimed reason, then the production
 * code is corrected without weakening any existing expectation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMusic } from '../shared/sound.js';
import { createAudioPlayer } from '../public/audio.js';

function vlq(value) {
  const out = [value & 0x7f];
  while ((value >>= 7)) out.unshift((value & 0x7f) | 0x80);
  return out;
}

/** Minimal one-track type-0 MIDI with a single melody note (tempo 500000 us/quarter). */
function midiBytes() {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
  const body = [
    ...[0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20].flatMap((v, i) => (i === 0 ? vlq(v) : [v])),
    ...[0, 0x90, 64, 100].flatMap((v, i) => (i === 0 ? vlq(v) : [v])),
    ...[480, 0x80, 64, 0].flatMap((v, i) => (i === 0 ? vlq(v) : [v])),
    ...[0, 0xff, 0x2f, 0x00].flatMap((v, i) => (i === 0 ? vlq(v) : [v])),
  ];
  const length = body.length;
  const track = [0x4d, 0x54, 0x72, 0x6b, (length >> 24) & 255, (length >> 16) & 255, (length >> 8) & 255, length & 255, ...body];
  return new Uint8Array([...header, ...track]);
}

function midiAndStreamProject() {
  return {
    environment: { music: 'D_TEST', musicAsset: 'music_D_TEST' },
    assets: [
      { id: 'music_D_TEST', name: 'D_TEST', kind: 'music', format: 'midi', src: encodeMusic(midiBytes(), 'midi') },
      { id: 'snd_ogg', name: 'music/level2.ogg', kind: 'sound', music: true, src: 'data:audio/ogg;base64,bGV2ZWwy' },
    ],
  };
}

/** Fake Web Audio context that counts synthesizer oscillators and streamed sources. */
class MusicSwitchContext {
  constructor() {
    this.destination = {};
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.oscillators = 0;
    this.streams = 0;
  }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createOscillator() {
    this.oscillators++;
    return { type: 'sine', frequency: { value: 0 }, detune: { value: 0 }, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} };
  }
  createBufferSource() {
    const context = this;
    return {
      buffer: null, loop: false, connect() {}, disconnect() {}, stop() {},
      start() { this.started = true; if (this.loop) context.streams++; },
    };
  }
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
  createBiquadFilter() { return { connect() {}, frequency: { value: 0 }, Q: { value: 1 } }; }
  decodeAudioData() { return Promise.resolve({}); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

test('switching from a synthesized MIDI track to an embedded streamed track stops the synthesizer', async t => {
  const context = new MusicSwitchContext();
  const errors = [];
  const player = createAudioPlayer(midiAndStreamProject(), message => errors.push(message), MusicSwitchContext, context);
  t.after(() => player.dispose());
  const update = extra => player.update({ settings: { muted: false, volume: 1, musicVolume: 1 }, sounds: [], soundOverflow: 0, ...extra });
  update({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.musicInfo().playing, true, 'the MIDI score is synthesized');
  assert.ok(context.oscillators > 0, 'melody notes were scheduled');
  // ACS SetMusic switches to the embedded OGG track.
  update({ musicRequest: { name: 'music/level2.ogg' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.musicInfo().playing, false, 'the synthesizer stops when a streamed track takes over');
  assert.equal(context.streams, 1, 'the streamed track is started');
  assert.deepEqual(errors, [], 'no errors reported');
});

test('a sound that fails to decode is reported once, not on every play', async t => {
  const errors = [];
  class BrokenContext {
    destination = {};
    resume() { return Promise.resolve(); }
    decodeAudioData() { return Promise.reject(new Error('malformed PCM')); }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
    close() { return Promise.resolve(); }
  }
  const project = { environment: {}, assets: [{ id: 's1', name: 'DSPISTOL', kind: 'sound', src: 'data:audio/wav;base64,AAAA' }] };
  const player = createAudioPlayer(project, message => errors.push(message), BrokenContext);
  t.after(() => player.dispose());
  const state = { settings: {}, sounds: [], player: { x: 0, y: 0 }, soundOverflow: 0 };
  for (let i = 0; i < 3; i++) { state.sounds.push({ name: 'DSPISTOL', volume: 1 }); player.update(state); }
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1, `decode failure reported once, got ${errors.length}: ${errors.join(' | ')}`);
  assert.match(errors[0], /malformed PCM/);
});
