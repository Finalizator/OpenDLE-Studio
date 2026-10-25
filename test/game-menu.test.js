import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installGameMenu, parseMenuDefinitions, attachMenuElement } from '../shared/game-menu.js';
import { gameSettings, changeSetting, mappedKeys, bindKey } from '../shared/game-settings.js';
import { createRuntime, stepRuntime, lookPlayer } from '../shared/runtime.js';
import { hudElement, hudBinding } from '../shared/hud.js';
import { damagePlayer } from '../shared/combat.js';
import { importWad } from '../server/import.js';
import { importWadMap, readWad } from '../shared/wad.js';
import { encodeImage } from '../server/import.js';
import { createAudioPlayer } from '../public/audio.js';

const freedoom = new URL('../Projects/freedoom2.wad', import.meta.url);
const step = (p, s, keys = []) => stepRuntime(p, s, 1 / 35, new Set(keys));
function click(p, s, label) {
  step(p, s);
  const item = p.hud.elements.find(item => item.name === label && p.gameMenus.elementIds.includes(item.id) &&
    s.hudState.elements.get(item.id).visible && item.interactive);
  assert.ok(item, `visible button ${label} on ${s.gameScreen}`);
  s.hudState.clicked.add(item.id); step(p, s);
}
function menuProject() {
  return installGameMenu(installEngineScripts(createProject()));
}
test('title menus execute editable interface events while gameplay, timers, weapons and physics are paused', () => {
  const p = menuProject(), s = createRuntime(p, { screen: 'title', gameMode: true });
  validateProject(p);
  const initial = structuredClone(s.entities);
  let physicsSteps = 0;
  s.physics = { step() { physicsSteps++; } };
  for (let i = 0; i < 100; i++) step(p, s, ['Mouse0', 'KeyW']);
  assert.equal(s.time, 0); assert.equal(s.started, false);
  assert.equal(s.playerStats.bullets, 50);
  assert.deepEqual(s.entities, initial); assert.equal(physicsSteps, 0);
  assert.ok(s.hudState.cursor);
  click(p, s, 'Options'); assert.equal(s.gameScreen, 'settings');
  assert.equal(p.gameMenus.screens.includes('engine_tweaks'), false);
  assert.equal(p.hud.elements.some(item => item.name === 'Engine tweaks'), false);
  s.settings.jumping = false;
  click(p, s, 'Reset settings');
  assert.equal(s.settings.jumping, false, 'game reset preserves editor engine override');
  click(p, s, 'Sound'); assert.equal(s.gameScreen, 'audio');
  click(p, s, 'Sound volume -'); assert.equal(s.settings.volume, .7);
  click(p, s, 'Toggle'); assert.equal(s.settings.muted, true);
  assert.equal(hudBinding('setting:muted', s), true);
  click(p, s, 'Back'); click(p, s, 'Back'); assert.equal(s.gameScreen, 'title');
  click(p, s, 'New game'); assert.equal(s.gameScreen, 'difficulty');
  click(p, s, 'Hurt me plenty');
  assert.equal(s.settings.difficulty, 3); assert.deepEqual(s.menuRequests, ['start']);
  assert.equal(s.started, false, 'new game initialization is not consumed by menu rendering');
});
test('Play level starts immediately; pause freezes simulation and resumes the same instance', () => {
  const p = menuProject(), s = createRuntime(p);
  step(p, s, ['Mouse0']);
  assert.ok(s.time > 0); assert.equal(s.started, true);
  const position = { ...s.player }, time = s.time, ammo = s.playerStats.bullets;
  s.gameScreen = 'pause'; s.hudState.cursor = true;
  for (let i = 0; i < 35; i++) step(p, s, ['KeyW', 'Mouse0']);
  assert.deepEqual(s.player, position); assert.equal(s.time, time); assert.equal(s.playerStats.bullets, ammo);
  click(p, s, 'Options'); click(p, s, 'Back');
  assert.equal(s.gameScreen, 'pause');
  click(p, s, 'Resume'); assert.equal(s.gameScreen, 'playing');
  assert.equal(s.hudState.cursor, false);
});
test('typed settings, sensitivity, inverted Y, key swaps and persistent serialization have real effects', () => {
  const p = menuProject(), s = createRuntime(p);
  changeSetting(s, 'volume', -10, true); assert.equal(s.settings.volume, 0);
  changeSetting(s, 'volume', 10, true); assert.equal(s.settings.volume, 1);
  for (const [key, value] of [['unknown', 1], ['muted', 1], ['fov', 500], ['difficulty', 1.5]]) assert.throws(() => changeSetting(s, key, value));
  s.settings.sensitivity = 2; s.settings.invertY = true;
  lookPlayer(s, 10, 5); assert.equal(s.input.mouseX, 20); assert.equal(s.input.mouseY, -10);
  s.bindingKey = 'KeyW'; bindKey(s, 'KeyS');
  assert.equal(s.settings.bindings.KeyW, 'KeyS'); assert.equal(s.settings.bindings.KeyS, 'KeyW');
  assert.deepEqual([...mappedKeys(new Set(['KeyS']), s.settings)], ['KeyW']);
  s.bindingKey = 'KeyW'; assert.throws(() => bindKey(s, 'Escape'));
  assert.deepEqual(gameSettings(JSON.parse(JSON.stringify(s.settings))), s.settings);
  assert.throws(() => gameSettings({ bindings: { KeyW: 'KeyS' } }), /Duplicate/);
  assert.throws(() => gameSettings({ volume: NaN }));
  const slow = createRuntime(p), fast = createRuntime(p, { settings: { alwaysRun: true } });
  step(p, slow, ['KeyW']); step(p, fast, ['KeyW']);
  const start = p.map.entities.find(e => e.type === 'player');
  assert.ok(Math.abs((fast.player.x - start.x) / (slow.player.x - start.x) - 2) < .0001);
});
test('difficulty uses retained skill masks and easy damage, without changing authored entities', () => {
  const p = menuProject();
  p.map.entities.push(...[1, 2, 4].map(mask => ({ id: `skill_${mask}`, type: 'decoration', name: 'Skill', angle: 0, x: 0, y: 0, skillMask: mask })));
  for (const [difficulty, bit] of [[1, 1], [2, 1], [3, 2], [4, 4], [5, 4]]) {
    const s = createRuntime(p, { settings: { difficulty } });
    assert.deepEqual(s.entities.filter(e => e.id.startsWith('skill_')).map(e => e.skillMask), [bit]);
    damagePlayer(s, 20);
    assert.equal(s.playerStats.health, difficulty === 1 ? 90 : 80);
  }
  assert.equal(p.map.entities.filter(e => e.id.startsWith('skill_')).length, 3);
});
test('MENUDEF directives become editable per-game HUDs, links and live settings; unsupported commands are diagnosed', () => {
  const definitions = [{ name: 'mod/menudef', source: `
    ListMenu "MainMenu"
    {
      Position 50, 60
      LineSpacing 22
      TextItem "Begin adventure", "b", "SkillMenu"
      TextItem "Mod options", "o", "ModOptions"
    }
    OptionMenu "ModOptions"
    {
      Title "https://example.test/my-game"
      Slider "Loudness", "snd_sfxvolume", 0, 1, 0.05
      Option "Reverse aim", "invertmouse", "OnOff"
      Command "Do not run console", "exec dangerous.cfg"
      Option "Unsupported renderer", "gl_fake_feature", "OnOff"
    }` }];
  const p = installEngineScripts(createProject()), warnings = [];
  installGameMenu(p, null, definitions, warnings); validateProject(p);
  assert.ok(warnings.some(w => w.includes('exec dangerous.cfg')));
  assert.ok(warnings.some(w => w.includes('gl_fake_feature')));
  assert.equal(p.gameMenus.sources[0].source, definitions[0].source);
  const s = createRuntime(p, { screen: 'title' });
  click(p, s, 'Mod options'); assert.equal(s.gameScreen, 'mod_ModOptions');
  click(p, s, 'Loudness -'); assert.equal(s.settings.volume, .75);
  assert.ok(p.hud.elements.some(item => item.text === 'https://example.test/my-game'));
  assert.ok(p.events.some(event => event.condition.type === 'hudClicked' && event.actions[0].type === 'adjustGameSetting'));
  const extra = hudElement('custom_menu_button', 'button', 'My custom button');
  p.hud.elements.push(extra); attachMenuElement(p, extra, 'title');
  validateProject(p);
  s.gameScreen = 'title';
  const next = createRuntime(p, { screen: 'title' }); step(p, next);
  assert.equal(next.hudState.elements.get(extra.id).visible, true);
  assert.throws(() => parseMenuDefinitions('ListMenu "Broken" { TextItem "x"'), /unterminated/);
  assert.ok(parseMenuDefinitions('ListMenu "Conditions" {\n IfGame(Doom) {\n Position 10,20\n }\n}').warnings.length);
  const invalid = structuredClone(p);
  invalid.events.find(event => event.actions.some(action => action.type === 'adjustGameSetting')).actions[0].setting = 'unsupported';
  assert.throws(() => validateProject(invalid));
});
test('classic WAD menus import their own title, option and skill patches and survive serialization', { skip: !existsSync(freedoom) }, () => {
  const { project: p, warnings } = importWad(readFileSync(freedoom), 'MAP01');
  const title = p.hud.elements.find(item => item.name === `${p.title} background`);
  assert.equal(p.assets.find(asset => asset.id === title.assetId).name, 'TITLEPIC');
  assert.equal(p.hud.elements.some(item => item.name === `${p.title} heading`), false);
  for (const background of p.hud.elements.filter(item => p.gameMenus.elementIds.includes(item.id) && item.name.endsWith(' background'))) {
    assert.deepEqual(background.anchors, { left: 0, top: 0, right: 1, bottom: 1 });
    assert.equal(background.width, 0); assert.equal(background.height, 0);
  }
  assert.ok(p.assets.some(asset => asset.name === 'M_OPTION'));
  assert.ok(p.hud.elements.some(item => item.interactive && item.assetId && p.assets.find(a => a.id === item.assetId).name === 'M_NGAME'));
  assert.ok(p.map.entities.some(entity => entity.skillMask));
  assert.ok(warnings.some(w => /MUS\/MIDI/.test(w)));
  validateProject(JSON.parse(JSON.stringify(p)));
  const bytes = readFileSync(freedoom);
  const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const custom = importWadMap(readWad(array), 'MAP01', { encodeImage, menuDefinitions: [
    { name: 'mod/menudef', source: 'ListMenu "MainMenu"\n{\n TextItem "Mod-owned start", "s", "SkillMenu"\n}' },
  ] }).project;
  assert.ok(custom.hud.elements.some(item => item.name === 'Mod-owned start'));
  assert.equal(custom.hud.elements.some(item => item.name === 'New game'), true, 'pause menu retains New game');
});
test('volume/mute feed actual gain nodes, and browser music loops independently from effect voices', async () => {
  const p = menuProject(), gains = [], sources = [];
  const sound = p.assets.find(asset => asset.kind === 'sound');
  p.assets.push({ ...sound, id: 'test_music', name: 'music/test.wav', music: true });
  class Context {
    destination = {};
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createGain() { const gain = { gain: {}, connect() {}, disconnect() {} }; gains.push(gain); return gain; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, start() {}, stop() {} }; sources.push(source); return source; }
  }
  const s = createRuntime(p), audio = createAudioPlayer(p, error => { throw new Error(error); }, Context);
  s.settings.volume = .3; s.settings.musicVolume = .7; audio.update(s);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gains[0].gain.value, .3); assert.equal(gains[1].gain.value, .7);
  assert.equal(sources[0].loop, true);
  s.settings.muted = true; audio.update(s);
  assert.equal(gains[0].gain.value, 0); assert.equal(gains[1].gain.value, 0);
  audio.dispose();
});
