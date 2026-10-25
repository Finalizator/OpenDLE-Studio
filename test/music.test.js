import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMusic, parseMidi, parseMus, defaultLevelMusic, resolveLevelMusic, resolveMusicName } from '../shared/music.js';
import { encodeMusic } from '../shared/sound.js';
import { applyLevelMusic } from '../shared/game-levels.js';
import { instrumentPatch, noteFrequency } from '../public/music-player.js';

const bytes = (...values) => new Uint8Array(values.flat());

function vlq(value) {
  const out = [value & 0x7f];
  while ((value >>= 7)) out.unshift((value & 0x7f) | 0x80);
  return out;
}

function midiTrack(events) {
  // events: [deltaTicks, ...bytes]
  const body = events.flatMap(([delta, ...event]) => [...vlq(delta), ...event]);
  const length = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (length >> 24) & 255, (length >> 16) & 255, (length >> 8) & 255, length & 255, ...body];
}

export function buildMidi() {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]; // one track, 480 ticks/quarter
  const track = midiTrack([
    [0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20], // 500000 us/quarter = 120 bpm, 1 tick = 500000/480 us
    [0, 0xc0, 56],                           // program 56 -> brass on channel 0
    [0, 0x90, 64, 100],                      // note on
    [480, 0x80, 64, 0],                      // one quarter later: off (0.5 s)
    [0, 0xc9, 0],                            // channel 9 program
    [0, 0x99, 38, 90],                       // percussion hit
    [480, 0x89, 38, 0],
    [0, 0xff, 0x2f, 0x00],                   // end of track
  ]);
  return bytes(header, track);
}

export function buildMus() {
  // Descriptor bits 4-6 select the event type; a variable-length delay follows
  // each event and advances the 140 Hz tick clock.
  const score = [
    0x90, 60, 100, ...vlq(140),  // note on ch0 note 60, then wait 140 ticks (1s)
    0x9f, 40, 90, ...vlq(0),     // percussion note on ch15
    0x00, 60, ...vlq(0),         // release note 60
    0x0f, 40, ...vlq(0),         // release percussion
    0x60,                        // score end
  ];
  const header = [0x4d, 0x55, 0x53, 0x1a, score.length & 255, (score.length >> 8) & 255, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return bytes(header, score);
}

test('MIDI parsing produces timed notes with program families and drum mapping', () => {
  const score = parseMidi(buildMidi(), 'test.mid');
  assert.equal(score.format, 'midi');
  assert.equal(score.notes.length, 2);
  const melody = score.notes.find(note => !note.drum);
  assert.equal(melody.note, 64);
  assert.equal(melody.family, 'brass');
  assert.equal(melody.time, 0);
  assert.ok(Math.abs(melody.duration - .5) < 1e-6, `duration ${melody.duration}`);
  assert.ok(Math.abs(melody.velocity - 100 / 127) < 1e-6);
  const drum = score.notes.find(note => note.drum);
  assert.equal(drum.channel, 9);
  assert.ok(Math.abs(score.seconds - 1) < 1e-6, `length ${score.seconds}`);
});

test('MUS parsing handles note on/off, percussion channel and 140 Hz timing', () => {
  const score = parseMusic(buildMus(), 'test.mus');
  assert.equal(score.format, 'mus');
  assert.equal(score.notes.length, 2);
  const melody = score.notes.find(note => !note.drum);
  assert.equal(melody.note, 60);
  assert.equal(melody.time, 0);
  assert.ok(Math.abs(melody.duration - 1) < 1e-9, `duration ${melody.duration}`);
  const drum = score.notes.find(note => note.drum);
  assert.equal(drum.channel, 15);
  assert.equal(drum.note, 40);
  assert.ok(score.seconds > 0);
});

test('music parsing rejects unknown, truncated and oversized input', () => {
  assert.throws(() => parseMusic(bytes([1, 2, 3, 4]), 'x'), /unsupported music format/);
  assert.throws(() => parseMidi(bytes([0x4d, 0x54, 0x68, 0x64]), 'bad'), /missing MIDI header|malformed/);
  assert.throws(() => parseMus(bytes([0x4d, 0x55, 0x53, 0x1a]), 'bad'), /missing MUS header|malformed/);
  const huge = new Uint8Array(2 * 1024 * 1024 + 1);
  huge.set([0x4d, 0x54, 0x68, 0x64]);
  assert.throws(() => encodeMusic(huge, 'midi'), /exceeds 2 MiB/);
  assert.throws(() => encodeMusic(bytes([0, 1, 2, 3]), 'midi'), /Invalid MIDI/);
});

test('classic level music tables resolve Doom II and episode tracks', () => {
  assert.equal(defaultLevelMusic('MAP01'), 'D_RUNNIN');
  assert.equal(defaultLevelMusic('MAP30'), 'D_OPENIN');
  assert.equal(defaultLevelMusic('MAP32'), 'D_ULTIMA');
  assert.equal(defaultLevelMusic('E1M1'), 'D_E1M1');
  assert.equal(defaultLevelMusic('nothing'), null);
  assert.equal(resolveLevelMusic('MAP01', 'custom_track'), 'CUSTOM_TRACK');
  assert.equal(resolveLevelMusic('MAP02', null), 'D_STALKS');
});

test('applyLevelMusic only points at an existing music asset and never invents one', () => {
  const assets = [{ id: 'music_D_RUNNIN', name: 'D_RUNNIN', kind: 'music' }];
  const data = { environment: { sky: '#000' } };
  applyLevelMusic(data, 'MAP01', null, assets);
  assert.deepEqual(data.environment.music, 'D_RUNNIN');
  assert.equal(data.environment.musicAsset, 'music_D_RUNNIN');
  const missing = { environment: {} };
  applyLevelMusic(missing, 'MAP02', null, assets);
  assert.deepEqual(missing.environment, {});
  const explicit = { environment: {} };
  applyLevelMusic(explicit, 'MAP02', 'D_RUNNIN', assets);
  assert.equal(explicit.environment.musicAsset, 'music_D_RUNNIN');
});

test('instrument patches and frequencies stay in a playable range', () => {
  for (const family of ['piano', 'strings', 'brass', 'percussive', 'unknown']) {
    const patch = instrumentPatch(family);
    assert.ok(patch.gain > 0 && patch.gain < .5);
    assert.ok(patch.attack >= 0 && patch.release > 0);
  }
  assert.ok(Math.abs(noteFrequency(69) - 440) < 1e-9);
  assert.ok(Math.abs(noteFrequency(57) - 220) < 1e-9);
});

test('resolution prefers an explicit track then the first track the game ships', () => {
  const shipped = new Set(['D_RUNNIN', 'D_E1M2']);
  assert.equal(resolveMusicName('MAP01', null, name => shipped.has(name)), 'D_RUNNIN');
  assert.equal(resolveMusicName('E1M1', null, name => shipped.has(name)), 'D_E1M2');
  assert.equal(resolveMusicName('E1M1', 'D_OTHER', name => shipped.has(name)), 'D_E1M2',
    'a missing explicit track falls back to the level default');
  assert.equal(resolveMusicName('E1M1', 'D_RUNNIN', name => shipped.has(name)), 'D_RUNNIN');
});

test('the scheduler starts voices for notes inside its lookahead window and stops cleanly', async t => {
  const { createMusicScheduler } = await import('../public/music-player.js');
  const started = [];
  const node = (extra = {}) => ({ connect() {}, disconnect() {}, start(when) { started.push(when); }, stop() {}, ...extra });
  const context = {
    currentTime: 0, sampleRate: 8000,
    createGain: () => node({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 1 } }),
    createOscillator: () => node({ type: 'sine', frequency: { value: 0 }, detune: { value: 0 }, onended: null }),
    createBufferSource: () => node({ buffer: null }),
    createBuffer: () => ({ getChannelData: () => new Float32Array(8) }),
    createBiquadFilter: () => node({ type: 'bandpass', frequency: { value: 0 }, Q: { value: 1 } }),
  };
  const scheduler = createMusicScheduler(context, { destination: node() });
  t.after(() => scheduler.dispose());
  const score = parseMidi(buildMidi(), 'schedule.mid');
  assert.equal(scheduler.start(score), true);
  assert.ok(started.length >= 1, 'a note was scheduled immediately');
  assert.ok(Math.min(...started) >= 0, 'notes are scheduled in the future');
  assert.ok(Math.max(...started) <= 2, `only the lookahead window is scheduled, got ${Math.max(...started)}`);
  scheduler.stop();
  assert.equal(scheduler.playing, false);
  scheduler.dispose();
  assert.equal(scheduler.start(score), false, 'a disposed scheduler refuses new scores');
});

test('the scheduler ignores empty scores instead of creating a timer', async t => {
  const { createMusicScheduler } = await import('../public/music-player.js');
  const context = { currentTime: 0, sampleRate: 8000, createGain: () => ({ connect() {}, gain: {} }) };
  const scheduler = createMusicScheduler(context, { destination: {} });
  t.after(() => scheduler.dispose());
  assert.equal(scheduler.start({ seconds: 0, notes: [] }), false);
  assert.equal(scheduler.start(null), false);
});

test('the audio player starts level music through the scheduler, not as a sound effect', async t => {
  const { createAudioPlayer } = await import('../public/audio.js');
  const created = { oscillators: 0, sounds: 0 };
  const node = (extra = {}) => ({ connect() {}, disconnect() {}, start() {}, stop() {},
    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 1 }, ...extra });
  class FakeContext {
    constructor() { this.currentTime = 0; this.sampleRate = 8000; this.destination = node(); this.state = 'running'; }
    createGain() { return node(); }
    createOscillator() { created.oscillators++; return node({ type: 'sine', frequency: { value: 0 }, detune: { value: 0 }, onended: null }); }
    createBufferSource() { created.sounds++; return node({ buffer: null }); }
    createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
    createBiquadFilter() { return node({ frequency: { value: 0 }, Q: { value: 1 } }); }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  const errors = [];
  const project = { environment: { music: 'D_TEST', musicAsset: 'music_D_TEST' }, assets: [
    { id: 'music_D_TEST', name: 'D_TEST', kind: 'music', format: 'midi', src: encodeMusic(buildMidi(), 'midi') },
  ] };
  const player = createAudioPlayer(project, message => errors.push(message), FakeContext);
  t.after(() => player.dispose());
  const state = { settings: { muted: false, volume: .8, musicVolume: .5 }, sounds: [], soundOverflow: 0 };
  player.update(state);
  player.update(state);
  assert.deepEqual(errors, [], 'music assets are never looked up as sound effects');
  assert.ok(created.oscillators > 0, 'music notes were scheduled');
  // Only the percussion voice uses a buffer source; melody notes are oscillators.
  assert.ok(created.sounds <= 1, `music must not be decoded as a sound effect (${created.sounds} buffer sources)`);
});
