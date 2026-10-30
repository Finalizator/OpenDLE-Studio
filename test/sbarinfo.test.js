import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSBarInfo, importSBarInfo } from '../shared/sbarinfo.js';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installEngineSounds } from '../shared/sound.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { hudText, hudRect } from '../shared/hud.js';

function fixture(source) {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  installEngineSounds(project);
  const warnings = [];
  const assets = {
    assets: project.assets,
    has: name => ['CUSTOM', 'FILL', 'EMPTY'].includes(name),
    get(name) {
      if (!project.assets.some(asset => asset.id === name)) project.assets.push({
        id: name, name, kind: 'sprite', width: 20, height: 10, offsetX: 2, offsetY: 3,
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1S8AAAAASUVORK5CYII=',
      });
      return name;
    },
  };
  const imported = importSBarInfo(project, assets, [{ name: 'test/SBARINFO', source }], warnings);
  if (imported) validateProject(project);
  return { project, warnings, imported };
}
const step = (project, state) => stepRuntime(project, state, 1 / 35, new Set(), new Set());
test('SBARINFO parser handles comments, strings, multiline arguments and nested includes in order', () => {
  const resources = {
    first: 'height 24; #include "second"',
    second: 'statusbar normal { drawstring SMALLFONT, untranslated, "/* literal */,; {}", 4, 5; }',
  };
  const parsed = parseSBarInfo('// ignored\n#include "first"', 'SBARINFO', name =>
    resources[name] ? { name, source: resources[name] } : null);
  assert.deepEqual(parsed.nodes.map(node => node.command), ['height', 'statusbar']);
  assert.equal(parsed.nodes[1].children[0].args[2][0].value, '/* literal */,; {}');
  assert.deepEqual(parsed.sources.map(source => source.name), ['SBARINFO', 'first', 'second']);
});
test('SBARINFO malformed sources, missing includes, include cycles and budgets fail explicitly', () => {
  for (const source of ['statusbar normal {', 'height 32', '}', 'height (32;', '/* broken', 'height "broken'])
    assert.throws(() => parseSBarInfo(source, 'broken'), /broken:\d+:/);
  assert.throws(() => parseSBarInfo('#include "missing"'), /Missing SBARINFO include/);
  assert.throws(() => parseSBarInfo('#include "SBARINFO"', 'SBARINFO', name =>
    ({ name, source: '#include "SBARINFO"' })), /cycle/);
  assert.throws(() => parseSBarInfo(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
  assert.throws(() => parseSBarInfo('height 1;'.repeat(4097)), /command budget/);
});
test('custom HUD uses bottom-centered normal coordinates, image offsets and live health/ammo bindings', () => {
  const source = `height 36;
statusbar normal {
  drawimage "CUSTOM", 6, 170;
  drawnumber 3, HUDFONT_DOOM, untranslated, health, 90, 171;
  drawnumber 3, INDEXFONT_DOOM, untranslated, ammo(Clip), 288, 173;
  drawnumber 3, INDEXFONT_DOOM, untranslated, ammocapacity(Cell), 314, 191;
}`;
  const { project, warnings, imported } = fixture(source), state = createRuntime(project);
  assert.equal(imported, true); assert.equal(project.hud.reserveBottom, 36);
  assert.deepEqual(project.hud.sources, [{ name: 'test/SBARINFO', source }]);
  const [image, health, bullets, maxCells] = project.hud.elements;
  assert.deepEqual(hudRect(image, 320, 200), { x: 4, y: 167, width: 20, height: 10 });
  assert.equal(hudRect(image, 480, 200).x, 84);
  assert.equal(hudText(health, state), '100');
  state.playerStats.health = 27; state.playerStats.bullets = 82;
  assert.equal(hudText(health, state), '27'); assert.equal(hudText(bullets, state), '82');
  assert.equal(hudText(maxCells, state), '300');
  assert.ok(warnings.some(message => message.includes('monospace')));
  validateProject(JSON.parse(JSON.stringify(project)));
});
test('SBARINFO inventory, selected weapon, health threshold, not, nested conditions and else update through visual rules', () => {
  const { project } = fixture(`statusbar normal {
    ifhealth 50 { ininventory BlueCard { drawimage "CUSTOM", 0, 0; } }
    else { drawimage "EMPTY", 0, 0; }
    isselected Shotgun { drawimage "FILL", 0, 0; }
    ininventory not Clip, 10 { drawimage "CUSTOM", 30, 0; }
    ifinvulnerable { drawimage "FILL", 30, 0; }
  }`);
  const state = createRuntime(project), [key, low, selected, ammo, god] = project.hud.elements;
  const shown = element => state.hudState.elements.get(element.id).visible;
  step(project, state);
  assert.deepEqual([key, low, selected, ammo, god].map(shown), [false, false, false, false, false]);
  state.inventory.keys.add('blueCard'); step(project, state); assert.equal(shown(key), true);
  state.playerStats.health = 49; step(project, state);
  assert.equal(shown(key), false); assert.equal(shown(low), true);
  state.inventory.selectedWeapon = 'shotgun'; state.playerStats.bullets = 9; state.playerStats.invulnerable = 1;
  step(project, state); assert.deepEqual([selected, ammo, god].map(shown), [true, true, true]);
  state.playerStats.health = 50; state.inventory.keys.delete('blueCard'); step(project, state);
  assert.equal(shown(key), false); assert.equal(shown(low), false);
  assert.ok(project.events.every(event => !event.id.startsWith('sbar_') || event.sheetId && event.groupId));
});
test('a normal SBARINFO layout is the status bar and hides at screen size 11', () => {
  const { project } = fixture(`height 32;
statusbar normal {
  drawimage "CUSTOM", -160, 168;
  drawnumber 3, INDEXFONT, untranslated, health, 90, 171;
}`);
  assert.equal(project.hud.reserveBottom, 32);
  assert.ok(project.hud.elements.every(element => element.statusbar === true),
    'the imported bar has to behave like the classic status bar');
  validateProject(JSON.parse(JSON.stringify(project)));
});

test('fullscreen offsets, alignment and textured horizontal/vertical bars survive serialization', () => {
  const { project } = fixture(`height 32;
statusbar fullscreen, fullscreenoffsets {
  drawimage "CUSTOM", -10, -4, centerbottom;
  drawbar "FILL", "EMPTY", health, horizontal, 10, 20;
  drawbar "FILL", "", armor, vertical, reverse, 40, 20;
}`);
  assert.equal(project.hud.reserveBottom, 0);
  const [image, background, horizontal, vertical] = project.hud.elements;
  assert.ok(project.hud.elements.every(element => element.statusbar === undefined),
    'a fullscreen layout is an overlay, not the reservable status bar');
  assert.deepEqual(hudRect(image, 480, 200), { x: 460, y: 186, width: 20, height: 10 });
  assert.equal(background.assetId, 'EMPTY'); assert.equal(horizontal.fillAssetId, 'FILL');
  assert.equal(horizontal.fillDirection, 'right'); assert.equal(vertical.fillDirection, 'down');
  assert.equal(vertical.binding, 'armor');
  validateProject(JSON.parse(JSON.stringify(project)));
  vertical.fillDirection = 'sideways';
  assert.throws(() => validateProject(project), /fill direction/);
});
test('unsupported condition branches are omitted as units, not displayed unconditionally', () => {
  const { project, warnings } = fixture(`statusbar normal {
    ininventory CustomCounter { drawimage "CUSTOM", 0, 0; } else { drawimage "EMPTY", 0, 0; }
    ifhealth < 20 { drawimage "CUSTOM", 0, 0; }
    drawimage ammoicon1, 0, 0;
    drawimage "MISSING", 0, 0;
    drawnumber 3, HUDFONT_DOOM, untranslated, health, fillzeros, 10, 10;
    drawnumber 3, HUDFONT_DOOM, unknownTranslation, health, 10, 10;
  }`);
  assert.equal(project.hud.elements.length, 0);
  assert.ok(warnings.some(message => message.includes('CustomCounter') || message.includes('ininventory')));
  assert.ok(warnings.some(message => message.includes('ifhealth')));
  assert.ok(warnings.some(message => message.includes('MISSING')));
  assert.ok(warnings.every(message => message.includes('test/SBARINFO:')));
  assert.equal(fixture('statusbar automap {}').imported, false);
  assert.throws(() => fixture('height 200; statusbar normal {}'), /invalid SBARINFO height/);
  assert.equal(fixture('statusbar normal { ininventory constructor { drawimage "CUSTOM", 0, 0; } }').project.hud.elements.length, 0);
});
test('Furdoom-style numbers, key combinations, weapon slots and singleplayer branches remain live and editable', () => {
  const { project, warnings } = fixture(`resolution 640, 400;
  height 32;
  monospacefonts true, "0";
  statusbar normal {
    drawnumber 3, BIGFONT, white, health, alignment(center), 77, 375;
    drawnumber 3, INDEXFONT, white, ammo Clip, 294, 373;
    drawnumber 3, INDEXFONT, white, ammocapacity Shell, 315, 379;
    drawswitchableimage keyslot 2 && 5, "", "CUSTOM", "FILL", "EMPTY", 239, 371;
    gamemode deathmatch, teamgame { drawimage "EMPTY", 0, 0; }
    gamemode cooperative, singleplayer {
      drawswitchableimage weaponslot 3, "EMPTY", "CUSTOM", 110, 372;
    }
  }`);
  const state = createRuntime(project), [health, bullets, capacity, card, skull, both, deathmatch, unowned, owned] = project.hud.elements;
  assert.deepEqual([project.hud.width, project.hud.height], [640, 400]);
  assert.equal(health.align, 'center'); assert.ok(Math.abs(hudRect(health, 640, 400).x + health.width / 2 - 77) < 1e-9);
  assert.equal(bullets.fontSize, 6); assert.equal(hudText(capacity, state), '50');
  const shown = element => {
    const runtime = state.hudState.elements.get(element.id);
    return runtime.visible && (!runtime.visibilityBinding || Boolean(state.inventory.weapons.has('shotgun') ||
      state.inventory.weapons.has('superShotgun')) !== Boolean(runtime.visibilityInverted));
  };
  step(project, state);
  assert.deepEqual([card, skull, both, deathmatch, unowned, owned].map(shown), [false, false, false, false, true, false]);
  state.inventory.keys.add('blueCard'); step(project, state);
  assert.deepEqual([card, skull, both].map(shown), [true, false, false]);
  state.inventory.keys.add('blueSkull'); step(project, state);
  assert.deepEqual([card, skull, both].map(shown), [false, false, true]);
  state.inventory.keys.delete('blueCard'); state.inventory.weapons.add('superShotgun'); step(project, state);
  assert.deepEqual([card, skull, both, unowned, owned].map(shown), [false, true, false, false, true]);
  assert.ok(warnings.every(message => message.includes('monospace')));
});

test('a braced value list is read as a mugshot state, not as a nested block', () => {
  // The stock gzdoom and zandronum SBARINFOs draw a mugshot's three directional faces as
  // `{ST00, ST01, ST02} 17;`. Treating the braces as a block refused the whole SBARINFO.
  const parsed = parseSBarInfo(`mugshot "Normal", health2
{
	{ST00, ST01, ST02} 17;
}
mugshot "Pain", healthspecial, directional
{
	KILL0 1;
}
statusbar normal { height 32; }`);
  assert.deepEqual(parsed.nodes.map(node => node.command), ['mugshot', 'mugshot', 'statusbar']);
  const group = parsed.nodes[0].children[0];
  assert.equal(group.command, '{');
  assert.deepEqual(group.args.slice(0, 2).map(part => part.map(token => token.value)), [['ST00'], ['ST01']]);
  assert.deepEqual(group.args.at(-1).map(token => token.value), ['ST02', '17']);
  assert.equal(parsed.nodes[1].children[0].command, 'kill0');
  assert.throws(() => parseSBarInfo('mugshot "x", health { {ST00, ST01'), /Unclosed SBARINFO group/);
  assert.throws(() => parseSBarInfo('mugshot "x", health { {ST00, ST01 } }'), /Expected semicolon after a braced group/);
});
