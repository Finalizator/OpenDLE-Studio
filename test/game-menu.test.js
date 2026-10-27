import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installGameMenu, parseMenuDefinitions, attachMenuElement, rebuildGameMenu } from '../shared/game-menu.js';
import { gameSettings, changeSetting, mappedKeys, bindKey, setGameScreen } from '../shared/game-settings.js';
import { createRuntime, stepRuntime, lookPlayer } from '../shared/runtime.js';
import { hudElement, hudBinding, hudRect, hudViewport } from '../shared/hud.js';
import { damagePlayer } from '../shared/combat.js';
import { importWad } from '../server/import.js';
import { importWadMap, readWad } from '../shared/wad.js';
import { encodeImage } from '../server/import.js';
import { createAudioPlayer } from '../public/audio.js';
import { createDoomAssets } from '../shared/doom-assets.js';

const freedoom = new URL('../Projects/freedoom2.wad', import.meta.url);
test('Escape/return follows the actual imported submenu ancestry without discarding the running game', () => {
  const p = menuProject(), s = createRuntime(p, { screen: 'title' });
  for (const name of ['mod_Settings', 'mod_Input', 'mod_Keys']) setGameScreen(s, name);
  setGameScreen(s, 'return'); assert.equal(s.gameScreen, 'mod_Input');
  setGameScreen(s, 'return'); assert.equal(s.gameScreen, 'mod_Settings');
  setGameScreen(s, 'return'); assert.equal(s.gameScreen, 'title');
  s.hasGame = true; setGameScreen(s, 'playing'); setGameScreen(s, 'pause');
  setGameScreen(s, 'settings'); setGameScreen(s, 'audio'); setGameScreen(s, 'return');
  assert.equal(s.gameScreen, 'settings');
  setGameScreen(s, 'return'); assert.equal(s.gameScreen, 'pause');
  assert.equal(s.hasGame, true); assert.equal(s.hudState.cursor, true);
});
test('MENUDEF includes resolve nested resource files and preserve original editable sources', () => {
  const resources = {
    first: '#include "second"',
    second: 'ListMenu "MainMenu"\n{\nTextItem "Imported start", "s", "SkillMenu"\n}',
  };
  const resolve = name => resources[name] ? { name, source: resources[name] } : null;
  const source = '// #include "ignored"\n#include "first"\n';
  const parsed = parseMenuDefinitions(source, 'MENUDEF', resolve);
  assert.equal(parsed.menus.length, 1);
  assert.deepEqual(parsed.sources.map(source => source.name), ['MENUDEF', 'first', 'second']);
  const project = installEngineScripts(createProject());
  installGameMenu(project, null, [{ name: 'MENUDEF', source, resolve }]);
  assert.ok(project.hud.elements.some(element => element.name === 'Imported start'));
  assert.deepEqual(project.gameMenus.sources, parsed.sources);
  validateProject(project);
  assert.throws(() => parseMenuDefinitions('#include "missing"'), /missing MENUDEF include/);
  assert.throws(() => parseMenuDefinitions('#include "first"', 'first', resolve), /include cycle/);
  assert.throws(() => parseMenuDefinitions('ListMenu "Unterminated'), /unterminated/);
});
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
test('rebuilding generated menus preserves map, gameplay HUD, scripts and unrelated assets', () => {
  const p = menuProject();
  const map = structuredClone(p.map), hud = structuredClone(p.hud.elements.filter(item => !p.gameMenus.elementIds.includes(item.id)));
  const gameplay = structuredClone(p.events.filter(event => event.sheetId !== 'game_menu_sheet'));
  rebuildGameMenu(p, null);
  assert.deepEqual(p.map, map);
  assert.deepEqual(p.hud.elements.filter(item => !p.gameMenus.elementIds.includes(item.id)), hud);
  assert.deepEqual(p.events.filter(event => event.sheetId !== 'game_menu_sheet'), gameplay);
  assert.equal(p.gameMenus.presentation, 2);
  assert.equal(p.hud.elements.filter(item => item.name === 'Game menu canvas').length, 1);
  validateProject(p);
});
test('menu rebuilding supports lazy source assets without replacing existing authored assets', { skip: !existsSync(freedoom) }, () => {
  const p = menuProject(), bytes = readFileSync(freedoom);
  const source = createDoomAssets(readWad(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), encodeImage);
  const original = structuredClone(p.assets);
  const include = id => {
    if (!p.assets.some(asset => asset.id === id)) p.assets.push(source.assets.find(asset => asset.id === id));
    return id;
  };
  rebuildGameMenu(p, { has: source.has, get: (name, kind) => include(source.get(name, kind)),
    atlas: (...args) => { const result = source.atlas(...args); include(result.assetId); return result; } });
  validateProject(p);
  assert.ok(p.hud.fonts.some(font => font.name === 'Imported menu small font' && font.widths.length === font.chars.length));
  for (const asset of original) assert.deepEqual(p.assets.find(item => item.id === asset.id), asset);
});
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
  assert.equal(p.hud.elements.some(item => item.name === 'Reset settings' || item.name === 'Fullscreen'), false);
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
test('interface animation clocks advance on menus without advancing gameplay HUD animation clocks', () => {
  const p = menuProject();
  for (const phase of ['game', 'interface']) {
    const item = hudElement(`clock_${phase}`, 'panel', phase); p.hud.elements.push(item);
    p.hud.animations.push({ id: `clip_${phase}`, name: phase, phase, duration: 1, autoPlay: true, loop: false,
      tracks: [{ elementId: item.id, property: 'opacity', easing: 'linear', keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] });
  }
  validateProject(p);
  const s = createRuntime(p, { screen: 'title' });
  stepRuntime(p, s, .05, new Set()); stepRuntime(p, s, .05, new Set());
  assert.equal(s.time, 0);
  assert.equal(s.hudState.elements.get('clock_game').opacity, 0);
  assert.equal(s.hudState.elements.get('clock_interface').opacity, .1);
  setGameScreen(s, 'playing'); stepRuntime(p, s, .05, new Set());
  assert.equal(s.hudState.elements.get('clock_game').opacity, .05);
  assert.ok(Math.abs(s.hudState.elements.get('clock_interface').opacity - .15) < 1e-9);
  p.hud.animations[0].phase = 'unknown';
  assert.throws(() => validateProject(p), /animation phase/);
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
  const frame = p.hud.elements.find(item => item.name === 'Game menu canvas');
  for (const background of p.hud.elements.filter(item => item.parentId === frame.id && item.name.endsWith(' background'))) {
    assert.deepEqual(background.anchors, { left: 0, top: 0, right: 1, bottom: 1 });
    assert.equal(background.width, 0); assert.equal(background.height, 0);
  }
  assert.ok(p.assets.some(asset => asset.name === 'M_OPTION'));
  for (const name of ['M_LOADG', 'M_SAVEG', 'M_LSLEFT', 'M_LSCNTR', 'M_LSRGHT'])
    assert.ok(p.assets.some(asset => asset.name === name), `original save/load artwork ${name}`);
  assert.ok(p.hud.elements.some(item => item.name === 'save slot 1 border' && item.imageRepeat === 'repeat-x'));
  assert.ok(p.hud.elements.some(item => item.interactive && item.assetId && p.assets.find(a => a.id === item.assetId).name === 'M_NGAME'));
  assert.ok(p.map.entities.some(entity => entity.skillMask));
  // The import report says which track the level plays instead of claiming MIDI/MUS
  // music is unsupported, which is what made a soundtrack look like a missing feature.
  assert.ok(warnings.some(w => /^Music: D_RUNNIN \(classic MAP01 track\)\.$/.test(w)), 'music report names the track');
  assert.equal(warnings.some(w => /MUS\/MIDI music is not synthesized/.test(w)), false);
  const help = p.hud.elements.find(item => item.name === 'Imported help artwork');
  assert.equal(help.parentId, frame.id);
  assert.deepEqual([help.x, help.y, help.width, help.height], [0, 0, 320, 200]);
  assert.equal(p.hud.elements.some(item => item.name === 'Read this heading'), false);
  const visibleHelp = createRuntime(p, { screen: 'help' }); step(p, visibleHelp);
  assert.deepEqual(p.hud.elements.filter(item => p.gameMenus.elementIds.includes(item.id) &&
    visibleHelp.hudState.elements.get(item.id).visible).map(item => item.name).sort(),
  ['Game menu canvas', 'Game menu letterbox', 'Imported help artwork', 'Read this background'].sort());
  for (const [width, height] of [[320, 200], [1600, 900], [900, 1600]]) {
    const viewport = hudViewport(p.hud, width, height), frameRect = hudRect(frame, viewport.width, viewport.height);
    const helpRect = hudRect(help, frameRect.width, frameRect.height);
    assert.equal(helpRect.width / helpRect.height, 1.6);
    assert.ok(Math.abs((frameRect.x + helpRect.x + helpRect.width / 2) * viewport.sx - width / 2) < 1e-9);
  }
  for (const label of ['Reset settings', 'Fullscreen', 'Field of view', 'Render resolution', 'Brightness'])
    assert.equal(p.hud.elements.some(item => item.name === label), false, label);
  assert.ok(p.hud.fonts.some(font => font.name === 'Imported menu small font'));
  assert.ok(p.hud.elements.some(item => item.name === 'Messages' &&
    p.assets.find(asset => asset.id === item.assetId)?.name === 'M_MESSG'));
  const settings = createRuntime(p, { screen: 'settings' });
  const marker = p.hud.elements.find(item => item.name === 'Mouse sensitivity thermometer marker');
  step(p, settings); const before = settings.hudState.elements.get(marker.id).x;
  settings.settings.sensitivity = 5; step(p, settings);
  assert.ok(settings.hudState.elements.get(marker.id).x > before);
  click(p, settings, 'Messages'); assert.equal(settings.settings.messages, false);
  click(p, settings, 'Detail'); assert.equal(settings.settings.lowDetail, true);
  const detail = p.hud.elements.find(item => item.name === 'Detail');
  settings.hudState.focused = detail.id;
  stepRuntime(p, settings, .05, new Set(), new Set(['ArrowLeft']));
  assert.equal(settings.settings.lowDetail, false);
  const size = p.hud.elements.find(item => item.name === 'Screen size');
  settings.hudState.focused = size.id;
  stepRuntime(p, settings, .05, new Set(), new Set(['ArrowRight']));
  assert.equal(settings.settings.viewSize, 11);
  stepRuntime(p, settings, .05, new Set(), new Set(['ArrowLeft']));
  assert.equal(settings.settings.viewSize, 10);
  const cursor = p.hud.elements.find(item => item.menuSelector);
  assert.equal(settings.hudState.elements.get(cursor.id).x, size.x - 32);
  assert.equal(settings.hudState.elements.get(cursor.id).y, size.y - 5);
  const blink = p.hud.animations.find(clip => clip.tracks.some(track => track.elementId === cursor.id));
  assert.equal(blink.phase, 'interface'); assert.ok(settings.hudState.playing.get(blink.id).time > 0);
  assert.equal(settings.time, 0);
  click(p, settings, 'Sound volume'); assert.equal(settings.gameScreen, 'audio');
  click(p, settings, 'Sound volume -'); assert.equal(settings.settings.volume, .7);
  validateProject(JSON.parse(JSON.stringify(p)));
  const bytes = readFileSync(freedoom);
  const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const custom = importWadMap(readWad(array), 'MAP01', { encodeImage, menuDefinitions: [
    { name: 'mod/menudef', source: 'ListMenu "MainMenu"\n{\n TextItem "Mod-owned start", "s", "SkillMenu"\n}' },
  ] }).project;
  assert.ok(custom.hud.elements.some(item => item.name === 'Mod-owned start'));
  assert.equal(custom.hud.elements.some(item => item.name === 'New game'), true, 'pause menu retains New game');
});
test('MENUDEF default fonts, selectors and line spacing become editable HUD and focus events', () => {
  const p = installEngineScripts(createProject());
  const asset = { id: 'import_font', name: 'Imported atlas', kind: 'sprite', width: 4, height: 2,
    src: encodeImage({ width: 4, height: 2, pixels: new Uint8Array(32).fill(255) }) };
  p.assets.push(asset);
  const assets = { has: name => name === 'CURSOR01', get: () => asset.id,
    font: name => name === 'BIGFONT' ? { name, type: 'bitmap', assetId: asset.id,
      cellWidth: 2, cellHeight: 2, columns: 2, chars: 'AB', widths: [2, 1], spaceWidth: 1 } : null };
  const source = `DefaultListMenu {
    Font "BigFont", "Untranslated"
    Selector "CURSOR01", -12, -3
    LineSpacing 22
  }
  ListMenu "MainMenu" {
    Position 40, 70
    TextItem "A", "a", "SkillMenu"
    TextItem "B", "b", "OptionsMenu"
  }`;
  installGameMenu(p, assets, [{ name: 'MENUDEF', source }]); validateProject(p);
  const a = p.hud.elements.find(item => item.name === 'A'), b = p.hud.elements.find(item => item.name === 'B');
  assert.equal(a.fontId, b.fontId); assert.equal(p.hud.fonts.find(font => font.id === a.fontId).name, 'BIGFONT');
  const sx = p.hud.width / 320, sy = p.hud.height / 200;
  assert.deepEqual([a.x, a.y, b.y], [40 * sx, 70 * sy, 92 * sy]);
  const s = createRuntime(p, { screen: 'title' }); s.hudState.focused = b.id; step(p, s);
  const cursor = p.hud.elements.find(item => item.menuSelector);
  assert.equal(s.hudState.elements.get(cursor.id).visible, true);
  assert.deepEqual([s.hudState.elements.get(cursor.id).x, s.hudState.elements.get(cursor.id).y], [28 * sx, 89 * sy]);
  s.gameScreen = 'playing'; step(p, s); assert.equal(s.hudState.elements.get(cursor.id).visible, false);
  rebuildGameMenu(p, assets, [{ name: 'MENUDEF', source }]); validateProject(p);
  assert.equal(p.hud.fonts.filter(font => font.name === 'BIGFONT').length, 1);
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
