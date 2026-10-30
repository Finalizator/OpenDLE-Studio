import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGameEpisodes } from '../shared/game-episodes.js';
import { installGameMenu } from '../shared/game-menu.js';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { assembleGameLevels, selectGameLevel } from '../shared/game-levels.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';

const source = `clearepisodes
episode TESTMAP { name = "Testing Map" key = "2" }
episode FURDM01 { name = "Furdoom" key = "1" }`;
const definitions = [{ name: 'MENUDEF', source: `ListMenu "MainMenu" {
  TextItem "New game", "n", "EpisodeMenu"
}
ListMenu "EpisodeMenu" {
  StaticTextCentered 160, 20, "Choose episode"
  Position 32, 64
  LineSpacing 20
}
ListMenu "SkillMenu" {
  Position 32, 64
  LineSpacing 16
}` }];
function campaign(episodeInfo, menus = definitions) {
  const entries = episodeInfo.levelIds.map(id => {
    const project = installEngineScripts(createProject());
    installGameMenu(project, null, menus, [], episodeInfo);
    return { id, project };
  });
  return assembleGameLevels(entries, episodeInfo.levelIds[0], 'Episodes').project;
}
function click(p, s, label) {
  stepRuntime(p, s, 0, new Set());
  const item = p.hud.elements.find(item => item.name === label && item.interactive &&
    s.hudState.elements.get(item.id).visible);
  assert.ok(item, `${label} visible on ${s.gameScreen}`);
  s.hudState.clicked.add(item.id);
  stepRuntime(p, s, 0, new Set());
}

test('MAPINFO episodes retain names, patches, order, includes and clear/remove semantics', () => {
  const included = 'episode MAP01 { name = "First" picname = "M_EPI1" noskillmenu }';
  const parsed = parseGameEpisodes([{ name: 'MAPINFO', source: `include "episodes"
    episode MAP02 { name = "Second" }
    episode MAP02 { remove }
    episode MAP03 { name = "Unavailable" }`,
  resolve: name => name === 'episodes' ? { name, source: included } : null }], ['MAP01', 'MAP02']);
  assert.deepEqual(parsed.episodes, [{ levelId: 'MAP01', name: 'First', patch: 'M_EPI1', noSkillMenu: true }]);
  assert.equal(parsed.sources.length, 2);
  assert.match(parsed.warnings.join(), /MAP03.*unavailable/);
  assert.equal(parseGameEpisodes(['episode MAP01 { name = "Discard" }\nclearepisodes'], ['MAP01']).episodes.length, 0);
  assert.throws(() => parseGameEpisodes(['include "missing"'], []), /missing MAPINFO include/);
  assert.throws(() => parseGameEpisodes(['episode MAP01 {'], ['MAP01']), /unterminated/);
});

test('Doom episodes generate selection but Doom II does not acquire an invented menu', () => {
  const doom = parseGameEpisodes([], ['E1M1', 'E2M1']);
  assert.deepEqual(doom.episodes.map(item => item.patch), ['M_EPI1', 'M_EPI2']);
  const doom2 = parseGameEpisodes([], ['MAP01', 'MAP02']);
  assert.deepEqual(doom2.episodes, []);
  const p = campaign(doom2, []);
  assert.equal(p.gameMenus.screens.includes('episode'), false);
  assert.equal(p.hud.elements.some(item => item.name === 'Which episode? heading'), false);
  validateProject(p);
});

test('original dynamic EpisodeMenu and SkillMenu become editable rows with original layout and working new game', () => {
  const info = parseGameEpisodes([source], ['TESTMAP', 'FURDM01']);
  const p = campaign(info);
  validateProject(p);
  const row = p.hud.elements.find(item => item.name === 'Furdoom' && item.interactive);
  const other = p.hud.elements.find(item => item.name === 'Testing Map' && item.interactive);
  const sx = p.hud.width / 320, sy = p.hud.height / 200;
  assert.deepEqual([other.x, other.y, row.x, row.y], [32 * sx, 64 * sy, 32 * sx, 84 * sy]);
  assert.ok(p.gameMenus.elementIds.includes(row.id));
  assert.equal(p.gameMenus.episodeSources[0].source, source);
  const s = createRuntime(p, { screen: 'title', gameMode: true });
  click(p, s, 'New game');
  assert.equal(s.gameScreen, 'episode');
  click(p, s, 'Furdoom');
  assert.equal(s.gameScreen, 'difficulty');
  const skill = p.hud.elements.find(item => item.name === 'Hurt me plenty' && item.interactive);
  assert.deepEqual([skill.x, skill.y], [32 * sx, 96 * sy]);
  click(p, s, 'Hurt me plenty');
  assert.equal(s.settings.difficulty, 3);
  assert.deepEqual(s.menuRequests, [{ type: 'start', levelId: 'FURDM01' }]);
  selectGameLevel(p, 'FURDM01');
  validateProject(JSON.parse(JSON.stringify(p)));
});

test('declared single episode skips selection; noskillmenu starts its actual map', () => {
  const info = parseGameEpisodes(['episode MAP02 { name = "Campaign" noskillmenu }'], ['MAP01', 'MAP02']);
  const p = campaign(info, []);
  const s = createRuntime(p, { screen: 'title' });
  click(p, s, 'New game');
  assert.deepEqual(s.menuRequests, [{ type: 'start', levelId: 'MAP02' }]);
});

test('original direct-map commands convert to native no-code level actions, not console execution', () => {
  const info = parseGameEpisodes([], ['MAP01', 'MAP02']);
  const p = campaign(info, [{ name: 'MENUDEF', source: `OptionMenu "MainMenu" {
    Command "Second level", "map MAP02"
    Command "Unsafe", "map MAP01; quit"
  }` }]);
  validateProject(p);
  const s = createRuntime(p, { screen: 'title' });
  click(p, s, 'Second level');
  assert.deepEqual(s.menuRequests, [{ type: 'level', levelId: 'MAP02', carryProgress: false }]);
  assert.equal(p.hud.elements.some(item => item.name === 'Unsafe'), false);
  const broken = structuredClone(p);
  broken.gameMenus.episodes = [{ levelId: 'MISSING', name: 'Missing', noSkillMenu: false }];
  assert.throws(() => validateProject(broken), /unknown game level/);
});

test('GZDoom episode syntax survives assignment, Strife teasers and repeated includes', () => {
  // Stock Strife MAPINFO writes `episode MAP02 teaser MAP33 { ... }`, and gzdoom.pk3 includes
  // the same shared MAPINFO files from every game's file. Both used to refuse the package.
  const parses = (definition, levels = ['MAP01', 'MAP02']) =>
    parseGameEpisodes([definition], levels, { inferClassic: false });
  assert.equal(parses('episode MAP01 { name = "Plain" }').episodes[0].levelId, 'MAP01');
  assert.equal(parses('episode = "MAP01" { name = "Assigned" }').episodes[0].name, 'Assigned');
  const teaser = parses('episode MAP02 teaser MAP33 { name = "Quest" }');
  assert.equal(teaser.episodes.length, 1);
  assert.equal(teaser.episodes[0].levelId, 'MAP02');
  assert.equal(teaser.episodes[0].name, 'Quest');
  // An episode whose block is missing must still be refused rather than swallow the next rule.
  assert.throws(() => parses('episode MAP01\nmap MAP02 "Two" { next = "MAP03" }'), /expected episode block for MAP01/);

  const shared = { name: 'mapinfo/common.txt', source: 'episode MAP01 { name = "Shared" }' };
  const parent = (name, includes) => ({ name, source: includes.map(path => `include "${path}"`).join('\n'),
    resolve: path => path === 'mapinfo/common.txt' ? shared : null });
  const many = parseGameEpisodes([parent('mapinfo/doom2.txt', ['mapinfo/common.txt']),
    parent('mapinfo/doom1.txt', ['mapinfo/common.txt']), parent('mapinfo/heretic.txt', ['mapinfo/common.txt'])],
  ['MAP01'], { inferClassic: false });
  assert.equal(many.sources.filter(item => item.name === 'mapinfo/common.txt').length, 1);
  assert.equal(many.episodes.length, 1);
});
