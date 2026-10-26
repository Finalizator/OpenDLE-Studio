import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseSndInfo, soundTable, resolveSoundName, soundAliasNames, VANILLA_SOUNDS } from '../shared/sndinfo.js';

test('SNDINFO maps logical names onto lumps and keeps random groups', () => {
  const text = `
// comment
$alias misc/keytry   *usefail
weapons/pistol       DSPISTOL
$random grunt/sight  { grunt/sight1  grunt/sight2 }
grunt/sight1         dsposit1
grunt/sight2         dsposit2
$limit grunt/sight1 2
$rolloff * 200 1200
`;
  const table = parseSndInfo(text);
  assert.equal(table.aliases['weapons/pistol'], 'DSPISTOL');
  assert.equal(table.aliases['misc/keytry'], '*usefail');
  assert.deepEqual(table.random['grunt/sight'], ['grunt/sight1', 'grunt/sight2']);
  assert.equal(table.aliases['grunt/sight1'], 'DSPOSIT1');
  assert.equal(resolveSoundName('weapons/pistol', table), 'DSPISTOL');
  assert.equal(resolveSoundName('grunt/sight', table, () => 0), 'DSPOSIT1');
  assert.equal(resolveSoundName('grunt/sight', table, () => 0.99), 'DSPOSIT2');
});

test('resolution follows alias chains without looping and leaves unknown names alone', () => {
  const table = parseSndInfo(`
$playersounddup player male *pain50 *pain100
$playersound player male *pain100 dsplpain
*cycle *cycle
`);
  assert.equal(resolveSoundName('*pain50', table), 'DSPLPAIN');
  assert.equal(resolveSoundName('*cycle', table), '*cycle', 'a self-reference terminates');
  assert.equal(resolveSoundName('unknown/sound', table), 'unknown/sound');
  assert.equal(resolveSoundName('', table), '');
  assert.equal(resolveSoundName(undefined, table), '');
});

test('the built-in vanilla table resolves the standard monster and weapon sounds', () => {
  assert.ok(Object.keys(VANILLA_SOUNDS.aliases).length > 100);
  const table = soundTable(VANILLA_SOUNDS);
  const expected = {
    'grunt/sight': 'DSPOSIT1', 'grunt/active': 'DSPOSACT', 'grunt/death': 'DSPODTH1',
    'imp/sight': 'DSBGSIT1', 'imp/active': 'DSBGACT', 'imp/death': 'DSBGDTH1',
    'demon/sight': 'DSSGTSIT', 'baron/death': 'DSBRSDTH', 'cyber/sight': 'DSCYBSIT',
    'weapons/pistol': 'DSPISTOL', 'weapons/shotgf': 'DSSHOTGN',
  };
  for (const [name, lump] of Object.entries(expected)) assert.equal(resolveSoundName(name, table, () => 0), lump, name);
  // A lump name passes through untouched, in either case.
  assert.equal(resolveSoundName('DSPISTOL', table), 'DSPISTOL');
  assert.equal(resolveSoundName('dspistol', table), 'dspistol');
});

test('game definitions win over the vanilla defaults', () => {
  const table = soundTable(VANILLA_SOUNDS, parseSndInfo('grunt/sight MY_SIGHT\n'));
  assert.equal(resolveSoundName('grunt/sight', table), 'MY_SIGHT');
  assert.equal(resolveSoundName('imp/sight', table, () => 0), 'DSBGSIT1', 'untouched defaults remain');
  assert.ok(soundAliasNames(table).includes('imp/sight'));
});

test('the real gzdoom tables resolve vanilla names', { skip: !existsSync(new URL('../Projects/intoOblivion/gzdoom.pk3', import.meta.url)) }, async () => {
  const { loadGzdoomActors } = await import('../server/actor-sources.js');
  const gzdoom = loadGzdoomActors(new URL('../Projects', import.meta.url).pathname);
  assert.ok(gzdoom.available);
  assert.ok(gzdoom.sndinfo.length >= 5, `sndinfo texts ${gzdoom.sndinfo.length}`);
  const table = soundTable(VANILLA_SOUNDS, ...gzdoom.sndinfo.map(parseSndInfo));
  assert.equal(resolveSoundName('grunt/sight', table, () => 0), 'DSPOSIT1');
  assert.equal(resolveSoundName('*pain50', table), 'DSPLPAIN', 'playersounddup chains are followed');
  assert.equal(resolveSoundName('weapons/bfgf', table), 'DSBFG');
});

test('the audio player resolves logical names, lump names and reports an unknown name once', async () => {
  const { createAudioPlayer } = await import('../public/audio.js');
  const sources = [], errors = [];
  class Context {
    destination = {};
    get currentTime() { return 0; }
    resume() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ decoded: true }); }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.onended?.(); } };
      sources.push(source); return source;
    }
    close() { return Promise.resolve(); }
  }
  // A project like an older import: lumps only, no SNDINFO table stored.
  const project = {
    assets: [
      { id: 's1', name: 'DSPOSIT1', kind: 'sound', src: 'data:audio/wav;base64,AAAA' },
      { id: 's2', name: 'DSPISTOL', kind: 'sound', src: 'data:audio/wav;base64,AAAA' },
    ],
    environment: {},
  };
  const state = { settings: {}, sounds: [], player: { x: 0, y: 0 }, soundOverflow: 0 };
  const audio = createAudioPlayer(project, message => errors.push(message), Context);
  state.sounds.push({ name: 'grunt/sight', volume: 1 });      // SNDINFO logical name
  state.sounds.push({ name: 'dspistol', volume: 1 });         // lower-case lump name
  state.sounds.push({ name: 'impossible/sound', volume: 1 }); // nothing can resolve this
  audio.update(state);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sources.length, 2, `two sounds played, sources: ${sources.length}`);
  assert.deepEqual(errors, ['Audio: Unknown embedded sound: impossible/sound']);

  // A second occurrence of the unknown name is not reported again.
  state.sounds.push({ name: 'impossible/sound', volume: 1 });
  audio.update(state);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['Audio: Unknown embedded sound: impossible/sound']);
  audio.dispose();
});
