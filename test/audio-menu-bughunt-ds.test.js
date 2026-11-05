/**
 * Audio / gamepad / game-menu bughunt regressions.
 *
 * Each finding here is reproduced against the implementation before its fix: the
 * fixture reaches the real public path, fails for the claimed reason, then the
 * production code is corrected so the assertion passes without weakening any
 * validator or existing expectation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { doomSound, wavSound, encodeSound } from '../shared/sound.js';
import { parseMus, parseMusic } from '../shared/music.js';
import { createAudioPlayer } from '../public/audio.js';
import { createMusicScheduler } from '../public/music-player.js';

const bytes = (...values) => {
  const flat = [];
  for (const value of values) {
    if (value instanceof Uint8Array) flat.push(...value);
    else if (Array.isArray(value)) flat.push(...value);
    else flat.push(value);
  }
  return new Uint8Array(flat);
};

/** Decodes the little-endian RIFF/WAVE `doomSound`/`wavSound` emits into its samples. */
function wavSamples(dataUri) {
  const wav = Buffer.from(dataUri.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const size = view.getUint32(40, true);
  return { rate: view.getUint32(24, true), samples: [...wav.subarray(44, 44 + size)] };
}

function doomSoundBytes(sampleCount, fill) {
  // Doom DMX PCM: 8-byte header {format, rate, count}, then `count` samples.
  // Real IWAD lumps confirm `count === lump.size - 8` (no leading pad).
  const lump = new Uint8Array(8 + sampleCount);
  const view = new DataView(lump.buffer);
  view.setUint16(0, 3, true);
  view.setUint16(2, 11025, true);
  view.setUint32(4, sampleCount, true);
  if (fill) lump.set(fill, 8);
  return lump;
}

// ---------------------------------------------------------------------------
// doomSound: sample data must be read from offset 8, not a notional 24-byte pad.
// ---------------------------------------------------------------------------
test('doomSound reads every DMX sample from offset 8, with no leading pad', () => {
  const samples = Array.from({ length: 48 }, (_, i) => (i * 5) % 256);
  const lump = doomSoundBytes(48, samples);
  const wav = wavSamples(doomSound(lump));
  assert.equal(wav.rate, 11025);
  // The first sample is the first byte after the 8-byte header, and all 48 are kept.
  assert.deepEqual(wav.samples, samples);
});

test('doomSound keeps the final samples and rejects a count that overruns the lump', () => {
  const samples = Array.from({ length: 33 }, (_, i) => 200 - i);
  const lump = doomSoundBytes(33, samples);
  assert.deepEqual(wavSamples(doomSound(lump)).samples, samples);
  // count is validated against the lump size minus the 8-byte header.
  assert.throws(() => doomSound(doomSoundBytes(33, samples).subarray(0, 8 + 32)), /count/);
  const bad = doomSoundBytes(33, samples); bad[0] = 1;
  assert.throws(() => doomSound(bad), /DMX/);
});

// ---------------------------------------------------------------------------
// parseMus: truncated score data must be rejected, not silently read as empty.
// ---------------------------------------------------------------------------
const musHeader = length => bytes(0x4d, 0x55, 0x53, 0x1a, length & 255, (length >> 8) & 255, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0);

test('parseMus rejects a note-on whose velocity byte is missing', () => {
  // 0x10 = note on, channel 0; bit 7 of the data byte asks for a velocity byte
  // that the score does not contain (no delay bit set).
  assert.throws(() => parseMus(bytes(musHeader(2), [0x10, 0x80]), 'trunc.mus'), /truncated MUS/);
});

test('parseMus rejects a program/controller event whose data byte is missing', () => {
  // 0x40 value 0 = program change, which must be followed by the program byte.
  assert.throws(() => parseMus(bytes(musHeader(2), [0x40, 0x00]), 'trunc.mus'), /truncated MUS/);
  // 0x40 with a controller number still carries a value byte.
  assert.throws(() => parseMus(bytes(musHeader(2), [0x40, 0x03]), 'trunc.mus'), /truncated MUS/);
});

test('parseMus still accepts complete note-on and program events', () => {
  assert.doesNotThrow(() => parseMus(bytes(musHeader(3), [0x40, 0x00, 42]), 'ok.mus'));
  // note on (velocity flag), then a release of the same note, then score end.
  const note = parseMus(bytes(musHeader(6), [0x10, 0xbc, 100, 0x00, 60, 0x60]), 'note.mus');
  assert.equal(note.notes.length, 1);
  assert.equal(note.notes[0].note, 60);
});

// ---------------------------------------------------------------------------
// createAudioPlayer: embedded WAV/OGG/MP3 music must honour the requested track.
// ---------------------------------------------------------------------------
function fakeAudioContextClass(decoded) {
  return class {
    constructor() { this.destination = {}; this.sampleRate = 8000; this.currentTime = 0; }
    decodeAudioData(buffer) { decoded.push({ buffer }); return Promise.resolve({}); }
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
}

test('embedded music plays the track the level asks for, not the first music sound', async () => {
  const decoded = [];
  const base64 = text => Buffer.from(text).toString('base64');
  const project = {
    environment: { music: 'music/level2.ogg', musicAsset: 'snd_level2' },
    assets: [
      { id: 'snd_intro', name: 'music/intro.wav', kind: 'sound', music: true, src: `data:audio/wav;base64,${base64('intro-bytes')}` },
      { id: 'snd_level2', name: 'music/level2.ogg', kind: 'sound', music: true, src: `data:audio/ogg;base64,${base64('level2-bytes')}` },
    ],
  };
  const player = createAudioPlayer(project, () => {}, fakeAudioContextClass(decoded));
  player.update({ settings: { muted: false, volume: 1, musicVolume: 1 }, sounds: [], soundOverflow: 0 });
  await new Promise(resolve => setImmediate(resolve));
  player.dispose();
  assert.equal(decoded.length, 1);
  assert.match(Buffer.from(decoded[0].buffer).toString('latin1'), /level2-bytes/,
    'the second track is decoded, not the first music sound asset');
});

test('switching embedded music stops the previous source before starting the next', async () => {
  const started = [], stopped = [];
  class Context {
    constructor() { this.destination = {}; }
    decodeAudioData() { return Promise.resolve({}); }
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() { started.push('start'); }, stop() { stopped.push('stop'); } };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  const project = {
    environment: { music: 'music/intro.wav', musicAsset: 'snd_intro' },
    assets: [
      { id: 'snd_intro', name: 'music/intro.wav', kind: 'sound', music: true, src: 'data:audio/wav;base64,aW50cm8=' },
      { id: 'snd_level2', name: 'music/level2.ogg', kind: 'sound', music: true, src: 'data:audio/ogg;base64,bGV2ZWwy' },
    ],
  };
  const player = createAudioPlayer(project, () => {}, Context);
  player.update({ settings: { muted: false, volume: 1, musicVolume: 1 }, sounds: [], soundOverflow: 0 });
  await new Promise(resolve => setImmediate(resolve));
  player.update({ settings: { muted: false, volume: 1, musicVolume: 1 }, sounds: [], soundOverflow: 0,
    musicRequest: { name: 'music/level2.ogg' } });
  await new Promise(resolve => setImmediate(resolve));
  player.dispose();
  assert.deepEqual(started, ['start', 'start'], 'both tracks are started in turn');
  assert.ok(stopped.length >= 1, 'the previous embedded source is stopped before the next one plays');
});

test('scheduler and helpers keep their documented contracts', async () => {
  // Guard rails for the neighbouring helpers, not new findings.
  const wav = wavSamples(wavSound(new Uint8Array(100).fill(128), 11025));
  assert.equal(wav.samples.length, 100);
  assert.equal(wav.rate, 11025);
  const scheduler = createMusicScheduler({ currentTime: 0, sampleRate: 8000,
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }), createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { value: 0 }, detune: { value: 0 } }),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {} }), createBuffer: () => ({ getChannelData: () => new Float32Array(8) }),
    createBiquadFilter: () => ({ connect() {}, frequency: { value: 0 }, Q: { value: 1 } }) }, { destination: {} });
  assert.equal(scheduler.start({ seconds: 0, notes: [] }), false);
  scheduler.dispose();
  assert.throws(() => parseMusic(bytes(1, 2, 3, 4), 'x'), /unsupported music format/);
});

test('a slow earlier music load cannot replace the track requested after it', async () => {
  // Two embedded tracks whose decodes resolve out of order: the first request must not
  // start after the second one has already been chosen.
  const pending = [];
  const started = [];
  class SlowContext {
    constructor() { this.destination = {}; }
    decodeAudioData(buffer) {
      const tag = Buffer.from(buffer).toString('latin1');
      return new Promise(resolve => pending.push(() => resolve({ tag })));
    }
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() { started.push(this.buffer?.tag); }, stop() {} };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  const base64 = text => Buffer.from(text).toString('base64');
  const project = {
    environment: { music: 'music/intro.wav', musicAsset: 'snd_intro' },
    assets: [
      { id: 'snd_intro', name: 'music/intro.wav', kind: 'sound', music: true, src: `data:audio/wav;base64,${base64('intro')}` },
      { id: 'snd_level2', name: 'music/level2.ogg', kind: 'sound', music: true, src: `data:audio/ogg;base64,${base64('level2')}` },
    ],
  };
  const player = createAudioPlayer(project, () => {}, SlowContext);
  const update = extra => player.update({ settings: { muted: false, volume: 1, musicVolume: 1 }, sounds: [], soundOverflow: 0, ...extra });
  update({});
  await new Promise(resolve => setImmediate(resolve));
  // The level asks for the second track before the first one has finished decoding.
  update({ musicRequest: { name: 'music/level2.ogg' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, 'both tracks are decoding');
  // Resolve the newer request first, then the stale one.
  pending[1](); await new Promise(resolve => setImmediate(resolve));
  pending[0](); await new Promise(resolve => setImmediate(resolve));
  player.dispose();
  assert.equal(started.at(-1), 'level2', `the last track started must be the one asked for, not ${started.at(-1)}`);
});
