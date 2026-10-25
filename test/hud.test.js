import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { hudElement, hudViewport, hudRect, createHUDState, advanceHUD, hudText, installDefaultHUD } from '../shared/hud.js';
import { parseHUDCSS } from '../shared/hud-style.js';
import { createRuntime, stepRuntime, lookPlayer } from '../shared/runtime.js';
import { applyTool } from '../server/tools.js';
import { ProjectStore } from '../server/store.js';

const fixture = () => installEngineScripts(createProject());
function rule(project, condition, actions, extra = {}) {
  project.events.push({ id: `hud_test_${project.events.length}`, enabled: true, once: false, condition, actions, ...extra });
}
test('HUD is opt-in for old projects, default for new stores and never overwrites content', () => {
  const old = createProject();
  assert.equal(validateProject(old).hud, undefined);
  const project = installDefaultHUD(old);
  assert.ok(project.hud.elements.some(element => element.type === 'bar'));
  assert.ok(project.hud.elements.some(element => element.interactive));
  validateProject(project);
  assert.throws(() => installDefaultHUD(project), /already exists/);
  const fresh = new ProjectStore().snapshot().project;
  assert.ok(fresh.hud);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(fresh))).hud, fresh.hud);
  const collision = createProject(); collision.events[0].id = 'hud_Crosshair';
  validateProject(installEngineScripts(collision));
  assert.notEqual(collision.hud.elements.find(element => element.name === 'Crosshair').id, 'hud_Crosshair');
});
test('HUD layouts use responsive anchors, pivots and separate scale modes at exact sizes', () => {
  const hud = fixture().hud, element = hudElement('test');
  element.anchors = { left: 1, right: 1, top: 1, bottom: 1 };
  Object.assign(element, { x: -10, y: -10, width: 100, height: 30, pivotX: 1, pivotY: 1 });
  assert.deepEqual(hudRect(element, 800, 450), { x: 690, y: 410, width: 100, height: 30 });
  assert.deepEqual(hudViewport(hud, 1600, 900), { sx: 2, sy: 2, width: 800, height: 450 });
  assert.deepEqual(hudViewport(hud, 1200, 450), { sx: 1, sy: 1, width: 1200, height: 450 });
  hud.scaleMode = 'stretch';
  assert.deepEqual(hudViewport(hud, 1600, 450), { sx: 2, sy: 1, width: 800, height: 450 });
  hud.scaleMode = 'integer';
  assert.deepEqual(hudViewport(hud, 1200, 675), { sx: 1, sy: 1, width: 1200, height: 675 });
  assert.equal(hudViewport(hud, 400, 225).sx, .5);
});
test('HUD bindings display actual engine stats, variables and expiring messages without mutating the project', () => {
  const project = fixture(), state = createRuntime(project), element = hudElement('test');
  element.text = 'HP {health} / {armor} / {bullets} / {var:score} {message}';
  state.playerStats.health = 71; state.variables.score = 3; state.message = 'Hit'; state.messageTime = 1;
  assert.equal(hudText(element, state), 'HP 71 / 0 / 50 / 3 Hit');
  element.binding = 'health'; assert.equal(hudText(element, state), '71');
  element.binding = 'message'; state.messageTime = 0; assert.equal(hudText(element, state), '');
  state.message = 'Literal {text}'; state.messageTime = 1; assert.equal(hudText(element, state), 'Literal {text}');
  assert.equal(project.variables.score, 0);
});
test('HUD animations interpolate, loop, finish once, hold final values and support discrete frames', () => {
  const project = fixture(), target = project.hud.elements[0];
  const clip = { id: 'test_clip', name: 'Test', duration: 1, loop: false, autoPlay: true,
    tracks: [{ elementId: target.id, property: 'opacity', easing: 'linear', keys: [{ time: 0, value: 0 }, { time: .5, value: 1 }, { time: 1, value: 0 }] }] };
  project.hud.animations.push(clip);
  const hud = createHUDState(project);
  advanceHUD(project, hud, .25); assert.equal(hud.elements.get(target.id).opacity, .5);
  advanceHUD(project, hud, .75); assert.equal(hud.elements.get(target.id).opacity, 0);
  assert.ok(hud.finished.has(clip.id)); assert.equal(hud.playing.size, 0);
  advanceHUD(project, hud, .1); assert.equal(hud.finished.size, 0);
  clip.loop = true; clip.tracks[0].easing = 'step'; hud.playing.set(clip.id, { time: 0 });
  advanceHUD(project, hud, .75); assert.equal(hud.elements.get(target.id).opacity, 1);
  advanceHUD(project, hud, .5); assert.equal(hud.elements.get(target.id).opacity, 0);
  assert.equal(hud.finished.size, 0);
  clip.tracks[0].easing = 'easeInOut'; hud.playing.set(clip.id, { time: 0 });
  advanceHUD(project, hud, .125); assert.equal(hud.elements.get(target.id).opacity, .15625);
});
test('HUD visual actions edit runtime only and animation completion triggers exactly once', () => {
  const project = fixture(), target = project.hud.elements[0], clip = project.hud.animations[0];
  rule(project, { type: 'onStart' }, [
    { type: 'setHUDText', elementId: target.id, text: 'Score {var:score}' },
    { type: 'setHUDVisible', elementId: target.id, visible: 'no' },
    { type: 'setHUDProperty', elementId: target.id, property: 'x', value: 42 },
    { type: 'setHUDBinding', elementId: target.id, binding: 'var:score' },
    { type: 'playHUDAnimation', animationId: clip.id },
  ]);
  rule(project, { type: 'hudAnimationFinished', animationId: clip.id }, [{ type: 'addVariable', variable: 'score', value: 1 }]);
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.hudState.elements.get(target.id).text, 'Score {var:score}');
  assert.equal(state.hudState.elements.get(target.id).x, 42);
  assert.equal(state.hudState.elements.get(target.id).visible, false);
  assert.equal(hudText(state.hudState.elements.get(target.id), state), '0');
  for (let i = 0; i < 10; i++) stepRuntime(project, state, .05, new Set());
  assert.equal(state.variables.score, 1); assert.equal(target.visible, true); assert.equal(target.x, 0);
});
test('default HUD feedback is ordinary editable visual rules; clicks clear each tick and cursor gates game input', () => {
  const project = fixture(), state = createRuntime(project), resume = project.hud.elements.find(element => element.interactive);
  const flash = project.hud.elements.find(element => element.name === 'Damage flash');
  stepRuntime(project, state, .01, new Set());
  rule(project, { type: 'keyPressed', key: 'KeyF' }, [{ type: 'damagePlayer', damage: 20 }]);
  stepRuntime(project, state, .01, new Set(), new Set(['KeyF']));
  stepRuntime(project, state, .01, new Set());
  assert.ok(state.hudState.elements.get(flash.id).opacity > 0);
  const x = state.player.x, bullets = state.playerStats.bullets;
  stepRuntime(project, state, .01, new Set(), new Set(['Tab']));
  assert.equal(state.hudState.cursor, true);
  const angle = state.player.angle; lookPlayer(state, 100, 100);
  assert.equal(state.player.angle, angle); assert.equal(state.input.mouseX, 0);
  stepRuntime(project, state, .05, new Set(['KeyW', 'Mouse0']));
  assert.equal(state.player.x, x); assert.equal(state.playerStats.bullets, bullets);
  state.hudState.clicked.add(resume.id);
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.hudState.cursor, false); assert.equal(state.hudState.clicked.size, 0);
  stepRuntime(project, state, .05, new Set(['KeyW']));
  assert.ok(state.player.x > x);
});
test('HUD play restarts immediately and stop holds the last sampled pose without a completion trigger', () => {
  const project = fixture(), clip = project.hud.animations[0], target = clip.tracks[0].elementId;
  rule(project, { type: 'keyPressed', key: 'KeyF' }, [{ type: 'playHUDAnimation', animationId: clip.id }]);
  rule(project, { type: 'keyPressed', key: 'KeyE' }, [{ type: 'stopHUDAnimation', animationId: clip.id }]);
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set(), new Set(['KeyF']));
  assert.equal(state.hudState.elements.get(target).opacity, .45);
  stepRuntime(project, state, .05, new Set(), new Set(['KeyE']));
  const held = state.hudState.elements.get(target).opacity;
  assert.ok(held > 0 && held < .45);
  for (let i = 0; i < 20; i++) stepRuntime(project, state, .05, new Set());
  assert.equal(state.hudState.elements.get(target).opacity, held);
  assert.equal(state.hudState.finished.size, 0);
  stepRuntime(project, state, .01, new Set(), new Set(['KeyF']));
  assert.equal(state.hudState.elements.get(target).opacity, .45);
});
test('font assets stay portable and cannot be assigned as world or HUD images', () => {
  const project = fixture();
  project.assets.unshift({ id: 'font_file', name: 'Web font', kind: 'font', src: 'data:font/woff2;base64,d09GMg==' });
  project.hud.fonts.push({ id: 'web_font', name: 'Test', type: 'web', assetId: 'font_file' });
  project.hud.elements[0].fontId = 'web_font'; validateProject(project);
  project.hud.elements[0].assetId = 'font_file'; assert.throws(() => validateProject(project), /image/);
  delete project.hud.elements[0].assetId;
  project.environment.weaponAsset = 'font_file'; assert.throws(() => validateProject(project), /image/);
  delete project.environment.weaponAsset;
  project.assets[0].src = 'https://example.invalid/font.woff2'; assert.throws(() => validateProject(project), /embedded/);
});
test('HUD schema rejects duplicate IDs, broken anchors, missing references and unsafe or out-of-range commands', () => {
  const mutations = [
    p => { p.hud.width = 0; },
    p => { p.hud.elements[0].id = 'player'; },
    p => { p.hud.elements[0].anchors.left = 2; },
    p => { p.hud.elements[0].anchors.left = 1; p.hud.elements[0].anchors.right = 0; },
    p => { p.hud.elements[0].parentId = p.hud.elements[0].id; },
    p => { p.hud.elements[0].fontId = 'missing'; },
    p => { p.hud.elements[0].binding = 'var:missing'; },
    p => { p.hud.elements[0].text = '{unimplemented_stat}'; },
    p => { p.hud.elements[0].assetId = 'missing'; },
    p => { p.hud.elements[0].opacity = NaN; },
    p => { p.hud.animations[0].tracks[0].keys[1].time = 0; },
    p => { p.hud.animations[0].tracks[0].keys[1].value = 2; },
    p => { p.hud.elements.pop(); },
    p => { rule(p, { type: 'always' }, [{ type: 'setHUDProperty', elementId: p.hud.elements[0].id, property: 'opacity', value: 2 }]); },
    p => { rule(p, { type: 'always' }, [{ type: 'setHUDText', elementId: p.hud.elements[0].id, text: '{unknown}' }]); },
    p => { rule(p, { type: 'always' }, [{ type: 'setHUDBinding', elementId: p.hud.elements[0].id, binding: 'var:missing' }]); },
    p => { rule(p, { type: 'hudClicked', elementId: p.hud.elements[0].id }, []); },
    p => { rule(p, { type: 'hudAnimationFinished', animationId: 'missing' }, []); },
    p => { rule(p, { type: 'hudStatChanged', stat: 'health', direction: 'changed', inverted: true }, []); },
  ];
  for (const mutate of mutations) { const project = fixture(); mutate(project); assert.throws(() => validateProject(project)); }
});
test('nine-patch, sprite grids and bitmap fonts validate their actual atlas extents', () => {
  const project = fixture(), image = { id: 'hud_atlas', name: 'Test atlas', kind: 'sprite', width: 64, height: 64, src: 'data:image/png;base64,AAAA' };
  project.assets.unshift(image);
  const element = project.hud.elements[0]; element.assetId = image.id;
  element.slice = { top: 8, right: 8, bottom: 8, left: 8 };
  project.hud.fonts.push({ id: 'bitmap', name: 'Digits', type: 'bitmap', assetId: image.id, columns: 4, cellWidth: 8, cellHeight: 8, chars: '0123456789' });
  element.fontId = 'bitmap'; validateProject(project);
  element.slice.left = 56; assert.throws(() => validateProject(project), /center region/);
  delete element.slice; element.sprite = { columns: 2, rows: 2 }; element.frame = 3; validateProject(project);
  element.frame = 4; assert.throws(() => validateProject(project), /frame exceeds/);
  element.frame = 0; project.hud.fonts[0].columns = 100;
  assert.throws(() => validateProject(project), /atlas/);
});
test('scoped CSS supports visual declarations, merges repeated classes and rejects page/network/code rules', () => {
  const styles = parseHUDCSS('/* HUD */ .status { color: #fff; border-radius: 4px; } .status { font-weight: bold; }');
  assert.deepEqual(styles, [{ name: 'status', properties: { color: '#fff', 'border-radius': '4px', 'font-weight': 'bold' } }]);
  for (const css of [
    'body { color: red; }', '.a:hover { color: red; }', '@import "remote";', '.a { position: fixed; }',
    '.a { color: url(https://example.invalid); }', '.a { color: expression(alert(1)); }', '.a { color: var(--global); }',
    '.a { background-image: url(x); }', '.a { __proto__: red; }', '.a { color: red; } malformed', '',
  ]) assert.throws(() => parseHUDCSS(css));
});
test('MCP HUD tools produce validated complete elements and reject broken references atomically', () => {
  const original = createProject();
  let project = applyTool(original, 'hud_install_default', {}).project;
  assert.equal(original.hud, undefined);
  project = applyTool(project, 'hud_element_add', { type: 'button', name: 'Menu', properties: { x: 10 } }).project;
  const button = project.hud.elements.at(-1);
  assert.equal(button.interactive, true); assert.equal(button.x, 10);
  project = applyTool(project, 'hud_import_css', { css: '.menu { color: #ffeeaa; }' }).project;
  project = applyTool(project, 'hud_element_update', { id: button.id, properties: { styleClass: 'menu' } }).project;
  assert.equal(project.hud.elements.at(-1).styleClass, 'menu');
  assert.throws(() => applyTool(project, 'hud_element_update', { id: button.id, properties: { fontId: 'missing' } }), /unknown font/);
  assert.equal(project.hud.elements.at(-1).fontId, undefined);
  project = applyTool(project, 'hud_animation_set', { animation: { id: 'new_clip', name: 'Fade', duration: 1, loop: false, autoPlay: false,
    tracks: [{ elementId: button.id, property: 'opacity', easing: 'linear', keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] } }).project;
  assert.equal(project.hud.animations.at(-1).id, 'new_clip');
  assert.deepEqual(applyTool(project, 'hud_set_layout', { hud: project.hud }).project.hud, project.hud);
});
test('HUD clicks and finished triggers are observable in both script phases but never replay next tick', () => {
  const project = fixture(), resume = project.hud.elements.find(element => element.interactive);
  const state = createRuntime(project);
  for (const sheet of [project.eventSheets[0], project.eventSheets.at(-1)]) {
    rule(project, { type: 'hudClicked', elementId: resume.id }, [{ type: 'addVariable', variable: 'score', value: 1 }], { sheetId: sheet.id });
  }
  state.hudState.clicked.add(resume.id);
  stepRuntime(project, state, .01, new Set()); assert.equal(state.variables.score, 2);
  stepRuntime(project, state, .01, new Set()); assert.equal(state.variables.score, 2);
});
test('repeated stat-change conditions observe the same change and fire once per net change', () => {
  const project = fixture(), condition = { type: 'hudStatChanged', stat: 'health', direction: 'decreased' };
  rule(project, condition, [{ type: 'addVariable', variable: 'score', value: 1 }], { conditions: [{ ...condition }] });
  const state = createRuntime(project);
  stepRuntime(project, state, .01, new Set());
  state.playerStats.health = 70;
  stepRuntime(project, state, .01, new Set()); assert.equal(state.variables.score, 1);
  stepRuntime(project, state, .01, new Set()); assert.equal(state.variables.score, 1);
});
