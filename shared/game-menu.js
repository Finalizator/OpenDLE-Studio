import { hudElement, installDefaultHUD, MAX_HUD_ELEMENTS } from './hud.js';
import { GAME_SETTINGS, GAME_BINDINGS } from './game-settings.js';
import { installIntermission } from './intermission.js';

const aliases = {
  mainmenu: 'title', optionsmenu: 'settings', skillmenu: 'difficulty', playerclassmenu: 'difficulty',
  episodemenu: 'episode', quitmenu: 'quit', readthismenu: 'help',
  savegamemenu: 'save', loadgamemenu: 'load',
  soundoptions: 'audio', mouseoptions: 'controls', controls: 'controls', videomode: 'display',
};
const cvars = { snd_sfxvolume: 'volume', snd_musicvolume: 'musicVolume', mouse_sensitivity: 'sensitivity',
  invertmouse: 'invertY', fov: 'fov', vid_brightness: 'brightness', show_messages: 'messages', cl_run: 'alwaysRun',
  detaillevel: 'lowDetail', screenblocks: 'viewSize' };
export const menuScreen = name => aliases[name.toLowerCase()] || `mod_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;

export function rebuildGameMenu(project, assets, definitions = [], warnings = [], episodeInfo) {
  episodeInfo ||= { episodes: project.gameMenus?.episodes || [], sources: project.gameMenus?.episodeSources || [],
    levelIds: project.game?.levels.map(level => level.id) || [] };
  const removed = new Set(project.gameMenus?.elementIds || []);
  project.hud.elements = project.hud.elements.filter(item => !removed.has(item.id));
  project.hud.fonts = project.hud.fonts.filter(font => (!font.id.startsWith('menu_') && font.name !== 'Imported menu small font') ||
    project.hud.elements.some(element => element.fontId === font.id));
  project.hud.animations = project.hud.animations.filter(clip => !clip.tracks.some(track => removed.has(track.elementId)));
  const generatedSheets = new Set(['game_menu_sheet', 'intermission_sheet']);
  project.events = project.events.filter(event => !generatedSheets.has(event.sheetId));
  project.eventGroups = project.eventGroups.filter(group => !generatedSheets.has(group.sheetId));
  project.eventSheets = project.eventSheets.filter(sheet => !generatedSheets.has(sheet.id));
  delete project.gameMenus;
  return installGameMenu(project, assets, definitions, warnings, episodeInfo);
}

export function attachMenuElement(project, item, screen) {
  if (!project.gameMenus?.screens.includes(screen)) throw new Error(`Unknown menu screen ${screen}`);
  const used = new Set([...project.events, ...project.hud.elements].map(value => value.id));
  const id = suffix => { let name = `${item.id}_${suffix}`; while (used.has(name)) name += '_'; used.add(name); return name; };
  project.gameMenus.elementIds.push(item.id); item.visible = false;
  for (const [condition, visible] of [[{ type: 'always' }, 'no'], [{ type: 'gameScreen', screen }, 'yes']]) {
    project.events.push({ id: id(visible), name: `${item.name} / ${screen} / ${visible}`, enabled: true, once: false,
      sheetId: 'game_menu_sheet', condition, conditions: [], actions: [{ type: 'setHUDVisible', elementId: item.id, visible }] });
  }
}

// MENUDEF is a data language. Unsupported constructs are preserved as diagnostics, never executed.
export function parseMenuDefinitions(source, label = 'MENUDEF', resolve) {
  const sources = [], active = new Set();
  let budget = 0, tokenCount = 0;
  function tokenize(source, name, depth = 0) {
    if (typeof source !== 'string' || source.length > 1024 * 1024) throw new Error(`${name}: menu definition exceeds 1 MiB`);
    if (depth > 16 || active.has(name.toLowerCase())) throw new Error(`${name}: MENUDEF include cycle or depth exceeds 16`);
    budget += source.length;
    if (budget > 2 * 1024 * 1024 || sources.length >= 64) throw new Error(`${name}: MENUDEF include budget exceeded`);
    sources.push({ name, source }); active.add(name.toLowerCase());
    const lexer = /[^\S\n]+|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|[{}(),\n]|[^\s{}(),"#]+|#/gy;
    const raw = [];
    let offset = 0;
    while (offset < source.length) {
      lexer.lastIndex = offset;
      const match = lexer.exec(source);
      if (!match) throw new Error(`${name}: unterminated MENUDEF string`);
      const token = match[0];
      if (token.startsWith('/*') && !token.endsWith('*/')) throw new Error(`${name}: unterminated MENUDEF comment`);
      if (token === '\n' || !/^\s/.test(token) && !token.startsWith('//') && !token.startsWith('/*')) raw.push(token);
      if (++tokenCount > 100000) throw new Error(`${name}: MENUDEF token budget exceeded`);
      offset = lexer.lastIndex;
    }
    const result = [];
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] !== '#') { result.push(raw[index]); continue; }
      const directive = raw[++index], path = raw[++index];
      if (directive?.toLowerCase() !== 'include' || !path?.startsWith('"')) throw new Error(`${name}: expected #include "resource"`);
      const target = JSON.parse(path), included = resolve?.(target, name);
      if (!included) throw new Error(`${name}: missing MENUDEF include ${target}`);
      result.push('\n', ...tokenize(included.source, included.name, depth + 1), '\n');
    }
    active.delete(name.toLowerCase()); return result;
  }
  const tokens = tokenize(source, label);
  const menus = [], warnings = [], defaults = [];
  let i = 0;
  const text = token => token?.startsWith('"') ? JSON.parse(token) : token;
  while (i < tokens.length) {
    const kind = tokens[i++]?.toLowerCase();
    if (kind === '\n') continue;
    if (!['listmenu', 'optionmenu', 'defaultlistmenu', 'defaultoptionmenu'].includes(kind)) {
      warnings.push(`${label}: unsupported top-level directive ${kind}`);
      while (i < tokens.length && tokens[i] !== '\n' && tokens[i] !== '{') i++;
      if (tokens[i] === '{') { let depth = 1; i++; while (i < tokens.length && depth) { const t = tokens[i++]; if (t === '{') depth++; if (t === '}') depth--; } }
      continue;
    }
    const isDefault = kind.startsWith('default');
    const name = isDefault ? kind : text(tokens[i++]);
    while (tokens[i] === '\n') i++;
    if (!name || tokens[i++] !== '{') throw new Error(`${label}: expected menu name and opening brace`);
    const directives = [];
    let depth = 1;
    while (i < tokens.length && depth) {
      const token = tokens[i++];
      if (token === '\n') continue;
      if (token === '}') { depth--; continue; }
      if (token === '{') { depth++; continue; }
      const args = [];
      while (i < tokens.length && !['\n', '{', '}'].includes(tokens[i])) {
        const value = tokens[i++]; if (![',', '(', ')'].includes(value)) args.push(text(value));
      }
      if (depth === 1 && !/^(ifgame|ifoption|else)$/i.test(token)) directives.push({ type: token.toLowerCase(), args });
      else warnings.push(`${label}/${name}: conditional or nested directive ${token} requires further translation`);
    }
    if (depth) throw new Error(`${label}/${name}: unterminated menu`);
    if (isDefault) defaults.push({ kind: kind.slice(7), directives });
    else menus.push({ name, kind, directives });
    if (menus.length > 64) throw new Error(`${label}: more than 64 menus`);
  }
  return { menus, warnings, sources, defaults };
}

export function installGameMenu(project, assets, definitions = [], warnings = [], episodeInfo = { episodes: [], sources: [] }) {
  if (project.eventSheets.some(sheet => sheet.id === 'game_menu_sheet')) return project;
  if (!project.hud) installDefaultHUD(project);
  const hud = project.hud, sx = hud.width / 320, sy = hud.height / 200;
  const episodes = episodeInfo.episodes;
  const newGameScreen = episodes.length > 1 ? 'episode' : 'difficulty';
  const newGameActions = () => episodes.length === 1 && episodes[0].noSkillMenu
    ? episodeActions(episodes[0]) : [go(newGameScreen)];
  const skills = ['I am too young to die', 'Hey, not too rough', 'Hurt me plenty', 'Ultra-Violence', 'Nightmare!'];
  const skillPatches = ['M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE'];
  const used = new Set([...project.assets, ...project.events, ...project.eventSheets, ...project.eventGroups,
    ...Object.values(project.map).filter(Array.isArray).flat(), ...hud.elements, ...hud.fonts, ...hud.animations].map(item => item.id));
  let sequence = 0;
  const id = () => { let value; do { value = `menu_${sequence++}`; } while (used.has(value)); used.add(value); return value; };
  const backdrop = { ...hudElement(id(), 'panel', 'Game menu letterbox'), width: 0, height: 0, x: 0, y: 0,
    anchors: { left: 0, right: 1, top: 0, bottom: 1 }, background: '#000000ff', z: 8999, visible: false };
  hud.elements.push(backdrop);
  const frame = { ...hudElement(id(), 'panel', 'Game menu canvas'), width: hud.width, height: hud.height,
    anchors: { left: .5, right: .5, top: .5, bottom: .5 }, x: -hud.width / 2, y: -hud.height / 2,
    background: '#00000000', z: 9000 };
  hud.elements.push(frame);
  let menuFont;
  if (assets?.atlas) {
    const glyphs = Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33))
      .map(char => ({ char, patch: `STCFN${String(char.toUpperCase().charCodeAt(0)).padStart(3, '0')}` }))
      .filter(glyph => assets.has(glyph.patch));
    if (glyphs.some(glyph => glyph.char === 'A') && glyphs.some(glyph => glyph.char === '0')) {
      const atlas = assets.atlas('ODLE_MENU_TEXT', glyphs.map(glyph => glyph.patch));
      menuFont = { id: id(), name: 'Imported menu small font', type: 'bitmap', assetId: atlas.assetId,
        cellWidth: atlas.cellWidth, cellHeight: atlas.cellHeight, columns: atlas.columns,
        chars: glyphs.map(glyph => glyph.char).join(''), spaceWidth: 4,
        widths: glyphs.map(glyph => {
          const assetId = assets.get(glyph.patch, 'sprite');
          return project.assets.find(asset => asset.id === assetId).width;
        }) };
      hud.fonts.push(menuFont);
    }
  }
  const sheet = { id: 'game_menu_sheet', name: 'Game menus', section: 'game', enabled: true, phase: 'interface' };
  project.eventSheets.push(sheet);
  const group = { id: id(), name: 'Imported game menus and settings', sheetId: sheet.id, enabled: true };
  project.eventGroups.push(group);
  const screen = name => ({ type: 'gameScreen', screen: name });
  const go = name => ({ type: 'setGameScreen', screen: name });
  function rule(name, condition, actions, conditions = []) {
    project.events.push({ id: id(), name: name.slice(0, 100), sheetId: sheet.id, groupId: group.id, enabled: true, once: false, condition, conditions, actions });
  }
  rule('Hide menu letterbox during gameplay', { type: 'always' },
    [{ type: 'setHUDVisible', elementId: backdrop.id, visible: 'no' }]);
  rule('Show menu letterbox on menu screens', { type: 'gameScreen', screen: 'playing', inverted: true },
    [{ type: 'setHUDVisible', elementId: backdrop.id, visible: 'yes' }]);
  function element(page, type, name, x, y, width, height, extra = {}) {
    const item = { ...hudElement(id(), type, name.slice(0, 100)), x: x * sx, y: y * sy, width: width * sx, height: height * sy,
      parentId: frame.id, fontSize: (menuFont?.cellHeight || 8) * sy, z: 9000, visible: false,
      ...(menuFont && ['text', 'button'].includes(type) ? { fontId: menuFont.id } : {}), ...extra };
    hud.elements.push(item);
    rule(`Show ${name} on ${page}`, { type: 'always' }, [{ type: 'setHUDVisible', elementId: item.id, visible: 'no' }]);
    rule(`Display ${name}`, screen(page), [{ type: 'setHUDVisible', elementId: item.id, visible: 'yes' }]);
    return item;
  }
  function art(name) {
    if (!assets?.has(name)) return null;
    const assetId = assets.get(name, 'sprite');
    return project.assets.find(asset => asset.id === assetId);
  }
  function button(page, label, y, actions, patch, x = 86, width = 148) {
    const image = patch && art(patch);
    const item = element(page, 'button', label, x, y, image?.width || width, image?.height || 12,
      { text: image ? '' : label, align: 'left', background: '#00000000', ...(image ? { assetId: image.id } : {}) });
    rule(label, { type: 'hudClicked', elementId: item.id }, actions, [screen(page)]);
    return item;
  }
  const pages = new Set();
  const selectors = new Map(), adjustments = new Map();
  const classicSelector = assets?.has('M_SKULL1') ? { patch: 'M_SKULL1', second: assets.has('M_SKULL2') ? 'M_SKULL2' : null, x: -32, y: -5 } : null;
  function page(name, title, back = 'settings', titlePatch, hideHeading = false) {
    if (pages.has(name)) return;
    pages.add(name);
    element(name, 'panel', `${title} background`, 0, 0, 0, 0,
      { background: '#000000ff', anchors: { left: 0, top: 0, right: 1, bottom: 1 } });
    const image = titlePatch && art(titlePatch);
    if (!hideHeading) element(name, image ? 'image' : 'text', `${title} heading`, image ? (320 - image.width) / 2 : 20, 8,
      image?.width || 280, image?.height || 18, { text: image ? '' : title, fontSize: 12 * sy, ...(image ? { assetId: image.id } : {}) });
    if (back) button(name, 'Back', 184, [go(back)]);
  }
  const title = art('TITLEPIC') || art('INTERPIC');
  page('title', project.title, null, 'M_DOOM', title?.name === 'TITLEPIC');
  if (title) {
    const background = hud.elements.find(item => item.name === `${project.title} background`);
    Object.assign(background, { type: 'image', assetId: title.id });
  }
  button('title', 'New game', 64, newGameActions(), 'M_NGAME');
  button('title', 'Options', 80, [go('settings')], 'M_OPTION');
  button('title', 'Load game', 96, [go('load')], 'M_LOADG');
  button('title', 'Save game', 112, [go('save')], 'M_SAVEG');
  button('title', 'Read this', 128, [go('help')], 'M_RDTHIS');
  button('title', 'Quit', 144, [go('quit')], 'M_QUITG');
  page('pause', 'Paused', null);
  button('pause', 'Resume', 42, [go('playing')]);
  button('pause', 'Save game', 62, [go('save')], 'M_SAVEG');
  button('pause', 'Load game', 82, [go('load')], 'M_LOADG');
  button('pause', 'Options', 102, [go('settings')], 'M_OPTION');
  button('pause', 'New game', 122, newGameActions(), 'M_NGAME');
  button('pause', 'Main menu', 142, [go('title')]);
  for (const name of ['save', 'load']) {
    page(name, name === 'save' ? 'Save game' : 'Load game', 'return', name === 'save' ? 'M_SAVEG' : 'M_LOADG');
    saveRows(name, 50, 48, 20);
  }
  page('save_confirm', 'Overwrite this saved game?', 'save');
  button('save_confirm', 'Overwrite save', 80, [{ type: 'confirmSaveGame' }]);
  button('save_confirm', 'Cancel', 110, [go('save')]);
  element('save_confirm', 'text', 'Save result', 16, 145, 288, 28, { binding: 'game:saveStatus' });
  page('settings', 'Options', 'return', 'M_OPTTTL');
  for (const [index, [label, name]] of [['Sound', 'audio'], ['Display', 'display'], ['Controls', 'controls']].entries())
    button('settings', label, 48 + index * 25, [go(name)]);
  page('audio', 'Sound options', 'settings', 'M_SVOL');
  page('display', 'Display options');
  page('controls', 'Controls');
  page('keys', 'Key bindings', 'controls');
  function setting(pageName, key, label, y, step = GAME_SETTINGS[key].step) {
    const spec = GAME_SETTINGS[key];
    const item = button(pageName, label, y, [typeof spec.value === 'boolean'
      ? { type: 'toggleGameSetting', setting: key } : { type: 'adjustGameSetting', setting: key, amount: step }], null, 24, 150);
    adjustments.set(item.id, { key, step });
    element(pageName, 'text', `${label} value`, 174, y, 74, 10, { binding: `setting:${key}` });
    if (typeof spec.value === 'boolean') {
      button(pageName, 'Toggle', y, [{ type: 'toggleGameSetting', setting: key }], null, 252, 46).menuSelectable = false;
    } else {
      const minus = button(pageName, `${label} -`, y, [{ type: 'adjustGameSetting', setting: key, amount: -step }], null, 252, 20);
      const plus = button(pageName, `${label} +`, y, [{ type: 'adjustGameSetting', setting: key, amount: step }], null, 278, 20);
      minus.text = '-'; plus.text = '+'; minus.menuSelectable = plus.menuSelectable = false;
    }
    return item;
  }
  setting('audio', 'volume', 'Sound volume', 45);
  setting('audio', 'musicVolume', 'Music volume', 70);
  setting('audio', 'muted', 'Mute', 95);
  element('audio', 'text', 'Music compatibility', 20, 128, 280, 36,
    { text: 'Music: embedded WAV / OGG / MP3 only.\nDoom MUS / MIDI playback not translated yet.', fontSize: 7 * sy });
  element('display', 'text', 'Display compatibility', 24, 42, 272, 64,
    { text: 'Browser rendering overrides are in the editor Engine tweaks. Imported renderer-specific controls require translation.', align: 'left' });
  setting('controls', 'sensitivity', 'Mouse sensitivity', 45);
  setting('controls', 'invertY', 'Invert mouse Y', 70);
  setting('controls', 'alwaysRun', 'Always run', 95);
  button('controls', 'Key bindings', 130, [go('keys')]);
  Object.entries(GAME_BINDINGS).forEach(([key, label], index) => {
    const y = 31 + index * 13;
    element('keys', 'text', label, 30, y, 140, 11, { text: label, align: 'left' });
    const item = button('keys', label, y, [{ type: 'captureGameBinding', key }], null, 180, 110);
    item.binding = `key:${key}`;
  });
  element('keys', 'text', 'Binding capture status', 20, 164, 280, 14, { binding: 'game:binding', fontSize: 7 * sy });
  page('difficulty', 'Choose skill', 'return', 'M_SKILL');
  skills.forEach((label, index) => {
    button('difficulty', label, 45 + index * 24, [
      { type: 'setGameSetting', setting: 'difficulty', value: index + 1 }, { type: 'startGame' },
    ], skillPatches[index]);
  });
  if (episodes.length > 1) {
    page('episode', 'Which episode?', 'return', 'M_EPISOD');
    episodes.forEach((episode, index) => button('episode', episode.name, 50 + index * 20,
      episodeActions(episode), episode.patch));
  }
  page('quit', 'Return to editor?', 'return');
  button('quit', 'Return to editor', 80, [{ type: 'quitGame' }]);
  const help = art('HELP1') || art('HELP') || art('CREDIT');
  page('help', 'Read this', help ? null : 'return', null, Boolean(help));
  if (help) {
    const scale = Math.min(320 / help.width, 200 / help.height);
    const item = element('help', 'button', 'Imported help artwork', (320 - help.width * scale) / 2,
      (200 - help.height * scale) / 2, help.width * scale, help.height * scale,
      { assetId: help.id, text: '', background: '#00000000', menuSelectable: false });
    rule('Dismiss imported help', { type: 'hudClicked', elementId: item.id }, [go('return')], [screen('help')]);
  }
  else element('help', 'text', 'Controls help', 20, 40, 280, 120,
    { text: 'WASD: move\nMouse: look / fire\nSpace: jump / E: use\n1-9: weapons\nEscape: pause\nOptions: change controls and settings' });
  // Existing gameplay HUD is suppressed on menus without changing its authored state.
  project.gameMenus = { version: 1, presentation: 2, entry: 'title', screens: [...pages], sources: [],
    episodes, episodeSources: episodeInfo.sources };
  if (assets) installClassicOptions();
  translateDefinitions();
  installSelectors();
  const existingElements = new Set(hud.elements.map(item => item.id));
  installIntermission(project, assets);
  pages.add('intermission');
  project.gameMenus.screens = [...pages];
  project.gameMenus.elementIds = hud.elements.filter(item => item.id.startsWith('menu_') || !existingElements.has(item.id)).map(item => item.id);
  if (hud.elements.length > MAX_HUD_ELEMENTS) throw new Error(`Imported menus exceed the editable HUD element limit (${MAX_HUD_ELEMENTS})`);
  return project;

  function episodeActions(episode) {
    return [{ type: 'selectGameEpisode', levelId: episode.levelId },
      episode.noSkillMenu ? { type: 'startGame' } : go('difficulty')];
  }
  function saveRows(name, x, y, spacing, font = item => item) {
    const left = art('M_LSLEFT'), middle = art('M_LSCNTR'), right = art('M_LSRGHT');
    for (let slot = 1; slot <= 6; slot++) {
      if (left && middle && right) {
        element(name, 'image', `${name} slot ${slot} border left`, x - left.width, y + 7,
          left.width, left.height, { assetId: left.id });
        element(name, 'image', `${name} slot ${slot} border`, x, y + 7,
          middle.width * 24, middle.height, { assetId: middle.id, imageRepeat: 'repeat-x' });
        element(name, 'image', `${name} slot ${slot} border right`, x + middle.width * 24, y + 7,
          right.width, right.height, { assetId: right.id });
      }
      const item = button(name, `${name === 'save' ? 'Save' : 'Load'} slot ${slot}`, y,
        [{ type: name === 'save' ? 'saveGame' : 'loadGame', slot }], null, x, middle ? middle.width * 24 : 248);
      item.text = `${slot}. {game:save${slot}}`; font(item);
      y += spacing;
    }
    element(name, 'text', `${name} game status`, 16, 166, 288, 16,
      { binding: 'game:saveStatus', fontSize: 7 * sy });
  }
  function clearPage(name) {
    const removed = new Set(hud.elements.filter(item => project.events.some(event =>
      event.condition.type === 'gameScreen' && event.condition.screen === name &&
      event.actions.some(action => action.elementId === item.id))).map(item => item.id));
    hud.elements = hud.elements.filter(item => !removed.has(item.id));
    project.events = project.events.filter(event => !event.actions.some(action => removed.has(action.elementId)) && !removed.has(event.condition.elementId));
    pages.delete(name);
  }
  function installClassicOptions() {
    clearPage('settings'); clearPage('audio');
    page('settings', 'Options', null, 'M_OPTTTL');
    page('audio', 'Sound volume', null, 'M_SVOL');
    const optionsHeading = hud.elements.find(item => item.name === 'Options heading');
    Object.assign(optionsHeading, { x: 108 * sx, y: 15 * sy });
    const soundHeading = hud.elements.find(item => item.name === 'Sound volume heading');
    Object.assign(soundHeading, { x: 60 * sx, y: 38 * sy });
    const native = (pageName, label, patch, y, actions) => {
      const image = art(patch);
      const item = actions ? button(pageName, label, y, actions, patch, 60)
        : element(pageName, image ? 'image' : 'text', label, 60, y, image?.width || 148, image?.height || 12,
          { text: image ? '' : label, ...(image ? { assetId: image.id } : {}), opacity: .5 });
      return item;
    };
    native('settings', 'End game', 'M_ENDGAM', 37, [go('end_game')]);
    native('settings', 'Messages', 'M_MESSG', 53, [{ type: 'toggleGameSetting', setting: 'messages' }]);
    for (const [patch, inverted] of [['M_MSGON', false], ['M_MSGOFF', true]]) {
      const image = art(patch);
      if (image) element('settings', 'image', `Messages ${inverted ? 'off' : 'on'}`, 180, 53, image.width, image.height,
        { assetId: image.id, visibilityBinding: 'setting:messages', visibilityInverted: inverted });
    }
    const detailRow = native('settings', 'Detail', 'M_DETAIL', 69, [{ type: 'toggleGameSetting', setting: 'lowDetail' }]);
    adjustments.set(detailRow.id, { key: 'lowDetail' });
    for (const [patch, inverted, label] of [['M_GDHIGH', true, 'High detail'], ['M_GDLOW', false, 'Low detail']]) {
      const detail = art(patch);
      if (detail) element('settings', 'image', label, 235, 69, detail.width, detail.height,
        { assetId: detail.id, visibilityBinding: 'setting:lowDetail', visibilityInverted: inverted });
    }
    const sizeRow = native('settings', 'Screen size', 'M_SCRNSZ', 85, [{ type: 'adjustGameSetting', setting: 'viewSize', amount: 1 }]);
    adjustments.set(sizeRow.id, { key: 'viewSize', step: 1 });
    thermometer('settings', 'viewSize', 'Screen size', 101, 3, 11);
    native('settings', 'Mouse sensitivity', 'M_MSENS', 117,
      [{ type: 'adjustGameSetting', setting: 'sensitivity', amount: .1 }]);
    thermometer('settings', 'sensitivity', 'Mouse sensitivity', 133, .1, 5);
    native('settings', 'Sound volume', 'M_SVOL', 149, [go('audio')]);
    native('audio', 'Sound volume', 'M_SFXVOL', 64, [{ type: 'adjustGameSetting', setting: 'volume', amount: .1 }]);
    thermometer('audio', 'volume', 'Sound volume', 80, 0, 1);
    native('audio', 'Music volume', 'M_MUSVOL', 112, [{ type: 'adjustGameSetting', setting: 'musicVolume', amount: .1 }]);
    thermometer('audio', 'musicVolume', 'Music volume', 128, 0, 1);
    page('end_game', 'End the current game?', null);
    button('end_game', 'Yes', 90, [go('title')]);
    button('end_game', 'No', 114, [go('return')]);
    warnings.push('Classic Detail reduces horizontal world resolution; Screen size changes the centered game viewport (3–11, 11 hides the classic status bar). These browser-native controls do not emulate the original software renderer. Browser fullscreen, resolution, FOV, brightness and reset remain editor controls.');
  }
  function thermometer(pageName, key, label, y, min, max) {
    const left = art('M_THERML'), middle = art('M_THERMM'), right = art('M_THERMR'), dot = art('M_THERMO');
    if (!left || !middle || !right || !dot) {
      warnings.push(`Missing original thermometer artwork for ${label}; using editable text controls.`);
      if (key) setting(pageName, key, label, y);
      return;
    }
    let x = 60;
    for (const [name, image, count] of [['left', left, 1], ['middle', middle, 16], ['right', right, 1]]) {
      element(pageName, 'image', `${label} thermometer ${name}`, x, y, image.width * count, image.height,
        { assetId: image.id, ...(count > 1 ? { imageRepeat: 'repeat-x' } : {}), ...(!key ? { opacity: .5 } : {}) });
      x += image.width * count;
    }
    const thumb = element(pageName, 'image', `${label} thermometer marker`, 60 + left.width, y,
      dot.width, dot.height, { assetId: dot.id });
    if (!key) { thumb.x += middle.width * 7 * sx; thumb.opacity = .5; return; }
    const row = hud.elements.find(item => item.name === label && item.interactive && project.events.some(event =>
      event.condition.type === 'gameScreen' && event.condition.screen === pageName && event.actions.some(action => action.elementId === item.id)));
    if (row) adjustments.set(row.id, { key, step: GAME_SETTINGS[key].step });
    for (const [suffix, amount, offset] of [['-', -GAME_SETTINGS[key].step, 0], ['+', GAME_SETTINGS[key].step, 8]]) {
      const buttonItem = button(pageName, `${label} ${suffix}`, y, [{ type: 'adjustGameSetting', setting: key, amount }],
        null, 60 + left.width + middle.width * offset, middle.width * 8);
      buttonItem.text = ''; buttonItem.menuSelectable = false;
    }
    rule(`${label} thermometer value`, screen(pageName), [{
      type: 'setHUDProperty', elementId: thumb.id, property: 'x',
      value: { expr: `${(60 + left.width) * sx} + clamp((setting("${key}") - ${min}) / ${max - min}, 0, 1) * ${middle.width * 15 * sx}` },
    }]);
  }
  function translateDefinitions() {
    const defaults = new Map();
    const importedFonts = new Map();
    function resolveFont(name, context) {
      const key = name.toUpperCase();
      if (importedFonts.has(key)) return importedFonts.get(key);
      const source = assets?.font?.(key);
      if (!source) {
        warnings.push(`${context}: menu font ${name} is unavailable; retained imported small font fallback.`);
        importedFonts.set(key, menuFont); return menuFont;
      }
      const font = { ...source, id: id() };
      hud.fonts.push(font); importedFonts.set(key, font); return font;
    }
    for (const definition of definitions) {
      const parsed = parseMenuDefinitions(definition.source, definition.name, definition.resolve);
      project.gameMenus.sources.push(...parsed.sources.filter(source => source.source.trim()));
      if (project.gameMenus.sources.length > 64) throw new Error('MENUDEF exceeds 64 retained source resources');
      warnings.push(...parsed.warnings);
      for (const block of parsed.defaults) defaults.set(block.kind, [...(defaults.get(block.kind) || []), ...block.directives]);
      for (const menu of parsed.menus) {
        const pageName = menuScreen(menu.name);
        if (pages.has(pageName)) {
          clearPage(pageName);
        }
        selectors.delete(pageName);
        page(pageName, menu.name, null, null, menu.kind === 'listmenu');
        let x = 86, y = 40, spacing = 16, activePage = pageName, pageNumber = 1;
        let currentFont = menuFont;
        const applyFont = item => {
          if (currentFont && ['text', 'button'].includes(item.type) && !item.assetId) {
            item.fontId = currentFont.id; item.fontSize = currentFont.cellHeight * sy;
            item.height = currentFont.cellHeight * sy;
          }
        };
        const row = () => {
          if (menu.kind === 'listmenu') return;
          if (y < 24) y = 32;
          if (y + 12 <= 174) return;
          const next = `${pageName}_page${++pageNumber}`;
          button(activePage, 'Next page', 169, [go(next)]);
          page(next, menu.name, activePage);
          activePage = next; y = 32;
          warnings.push(`${definition.name}/${menu.name}: long menu paginated into editable HUD screens`);
        };
        for (const { type, args } of [...(defaults.get(menu.kind) || []), ...menu.directives]) {
          if (type === 'position') {
            if (menu.kind === 'optionmenu' && args.length === 1) y = Number(args[0]);
            else { x = Number(args[0]); y = Number(args[1]); }
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              warnings.push(`${definition.name}/${menu.name}: invalid Position; using readable fallback coordinates`);
              x = 86; y = 40;
            }
          }
          else if (type === 'font') {
            if (!args[0]) throw new Error(`${definition.name}/${menu.name}: missing Font name`);
            currentFont = resolveFont(args[0], `${definition.name}/${menu.name}`);
            if (args[1] && !/^untranslated$/i.test(args[1]))
              warnings.push(`${definition.name}/${menu.name}: ${args[1]} font translation uses source palette; color-range translation is not implemented.`);
          }
          else if (type === 'selector') {
            const dx = Number(args[1]), dy = Number(args[2]);
            if (args.length !== 3 || !Number.isFinite(dx) || !Number.isFinite(dy))
              throw new Error(`${definition.name}/${menu.name}: invalid Selector`);
            selectors.set(pageName, { patch: args[0], x: dx, y: dy });
          }
          else if (type === 'linespacing') {
            spacing = Number(args[0]);
            if (!Number.isFinite(spacing) || spacing <= 0 || spacing > 512)
              throw new Error(`${definition.name}/${menu.name}: invalid LineSpacing`);
          }
          else if (type === 'title') {
            const heading = hud.elements.find(item => item.name === `${menu.name} heading`);
            if (heading) heading.text = args[0];
          } else if (type === 'statictext' && menu.kind === 'optionmenu') {
            row();
            applyFont(element(activePage, 'text', args[0] || `${menu.name} spacer`, 20, y, 280, 12, { text: args[0] || '' }));
            y += spacing;
          } else if (['staticpatch', 'staticpatchcentered', 'statictext', 'statictextcentered'].includes(type)) {
            const image = type.startsWith('staticpatch') && art(args[2]);
            if (type.startsWith('staticpatch') && !image) { warnings.push(`${definition.name}/${menu.name}: missing patch ${args[2]}`); continue; }
            applyFont(element(pageName, image ? 'image' : 'text', args[2], Number(args[0]) - (type === 'staticpatchcentered' ? image.width / 2 : type === 'statictextcentered' ? 100 : 0), Number(args[1]),
              image?.width || 200, image?.height || 12, { text: image ? '' : args[2],
                align: type === 'statictextcentered' ? 'center' : 'left', ...(image ? { assetId: image.id } : {}) }));
          } else if (['patchitem', 'textitem', 'submenu', 'command'].includes(type)) {
            const target = args[type === 'patchitem' || type === 'textitem' ? 2 : 1];
            const mapCommand = /^map\s+([a-zA-Z0-9_-]+)$/i.exec(target || '');
            if (mapCommand) {
              const levelId = mapCommand[1].toUpperCase();
              if (!episodeInfo.levelIds?.includes(levelId)) {
                warnings.push(`${definition.name}/${menu.name}: level command ${levelId} is unavailable; omitted`);
                continue;
              }
              row();
              applyFont(button(activePage, args[0], y, [{ type: 'loadGameLevel', levelId }],
                type === 'patchitem' ? args[0] : null, x));
              y += spacing; continue;
            }
            const action = /^(?:menu_)?savegame$/i.test(target) ? go('save')
              : /^(?:menu_)?loadgame$/i.test(target) ? go('load')
              : /^newgame$/i.test(target) ? go(newGameScreen)
              : /^(quit|exit)$/i.test(target) ? go('quit')
                : go(menuScreen(target || 'MainMenu'));
            const supported = /menu$/i.test(target || '') || ['submenu', 'patchitem', 'textitem'].includes(type) || /^(newgame|quit|exit|(?:menu_)?savegame|(?:menu_)?loadgame)$/i.test(target || '');
            if (!supported) { warnings.push(`${definition.name}/${menu.name}: command ${target} is not executable; omitted`); continue; }
            row();
            applyFont(button(activePage, args[0], y, /^newgame$/i.test(target) ? newGameActions() : [action],
              type === 'patchitem' ? args[0] : null, x)); y += spacing;
          } else if (['slider', 'option'].includes(type)) {
            const key = cvars[String(args[1]).toLowerCase()];
            if (!key) { warnings.push(`${definition.name}/${menu.name}: setting ${args[1]} has no engine implementation; omitted`); continue; }
            const increment = type === 'slider' && Number.isFinite(Number(args[4])) && Number(args[4]) > 0 ? Number(args[4]) : undefined;
            row();
            applyFont(setting(activePage, key, args[0], y, increment));
            y += spacing;
          } else if (type === 'control') {
            const key = { '+forward': 'KeyW', '+back': 'KeyS', '+moveleft': 'KeyA', '+moveright': 'KeyD',
              '+left': 'ArrowLeft', '+right': 'ArrowRight', '+use': 'KeyE', '+jump': 'Space', '+speed': 'ShiftLeft', '+attack': 'Mouse0' }[args[1]];
            if (!key) { warnings.push(`${definition.name}/${menu.name}: unsupported control ${args[1]}`); continue; }
            row();
            const item = button(activePage, args[0], y, [{ type: 'captureGameBinding', key }], null, x);
            item.text = `${args[0]}: {key:${key}}`; applyFont(item); y += spacing;
          } else if (['netgamemessage', 'playermessage'].includes(type)) {
            // These gate multiplayer-only flows; the imported runtime is single-player.
          } else
            warnings.push(`${definition.name}/${menu.name}: unsupported directive ${type}`);
        }
        // GZDoom populates these rows at runtime, outside the MENUDEF text.
        if (menu.name.toLowerCase() === 'episodemenu') {
          for (const episode of episodes) {
            applyFont(button(activePage, episode.name, y, episodeActions(episode), episode.patch, x));
            y += spacing;
          }
        } else if (menu.name.toLowerCase() === 'skillmenu') {
          skills.forEach((label, index) => {
            applyFont(button(activePage, label, y, [
              { type: 'setGameSetting', setting: 'difficulty', value: index + 1 }, { type: 'startGame' },
            ], null, x));
            y += spacing;
          });
        } else if (['savegamemenu', 'loadgamemenu'].includes(menu.name.toLowerCase())) {
          saveRows(activePage, x, y, spacing, applyFont);
        }
      }
      for (const event of project.events.filter(event => event.sheetId === sheet.id)) for (const action of event.actions) {
        if (action.type === 'setGameScreen' && !['playing', 'return'].includes(action.screen) && !pages.has(action.screen)) {
          warnings.push(`${definition.name}: unresolved submenu ${action.screen}; opens an explicit compatibility notice`);
          const missing = action.screen;
          page(missing, 'Menu not translated');
          element(missing, 'text', 'Unsupported submenu', 20, 45, 280, 100,
            { text: `This game's submenu ${missing} is not translated yet.\nNo console command was executed.` });
        }
      }
    }
  }
  function installSelectors() {
    const cursors = new Map();
    for (const name of pages) {
      const targets = hud.elements.filter(item => item.interactive && item.menuSelectable !== false && project.events.some(event =>
        event.condition.type === 'gameScreen' && event.condition.screen === name && event.actions.some(action => action.elementId === item.id)));
      for (const target of targets) {
        const adjustment = adjustments.get(target.id);
        if (adjustment) for (const [key, sign] of [['ArrowLeft', -1], ['ArrowRight', 1]]) {
          const action = typeof GAME_SETTINGS[adjustment.key].value === 'boolean'
            ? { type: 'toggleGameSetting', setting: adjustment.key }
            : { type: 'adjustGameSetting', setting: adjustment.key, amount: adjustment.step * sign };
          rule(`${target.name} ${key}`, { type: 'keyPressed', key }, [action],
            [screen(name), { type: 'hudFocused', elementId: target.id }]);
        }
      }
      const config = selectors.get(name) || classicSelector;
      if (!config || !targets.length) continue;
      const key = JSON.stringify([config.patch, config.second || null]);
      let cursor = cursors.get(key);
      if (!cursor) {
        const image = art(config.patch);
        if (!image) { warnings.push(`Menu ${name}: missing selector artwork ${config.patch}`); continue; }
        cursor = element(name, 'image', `${config.patch} selection cursor`, 0, 0, image.width, image.height,
          { assetId: image.id, z: 9500, menuSelector: true });
        cursors.set(key, cursor);
        rule(`Hide ${config.patch} selector until focused`, { type: 'always' },
          [{ type: 'setHUDVisible', elementId: cursor.id, visible: 'no' }]);
        if (config.second && assets?.atlas) {
          const atlas = assets.atlas(`ODLE_SELECTOR_${cursors.size}`, [config.patch, config.second]);
          Object.assign(cursor, { assetId: atlas.assetId, width: atlas.cellWidth * sx, height: atlas.cellHeight * sy,
            sprite: { columns: atlas.columns, rows: atlas.rows } });
          hud.animations.push({ id: id(), name: `${config.patch} cursor blink`, phase: 'interface', duration: .32, loop: true, autoPlay: true,
            tracks: [{ elementId: cursor.id, property: 'frame', easing: 'step', keys: [
              { time: 0, value: 0 }, { time: .16, value: 1 }, { time: .32, value: 0 }] }] });
        }
      }
      for (const target of targets) rule(`${target.name} selector`, { type: 'hudFocused', elementId: target.id }, [
        { type: 'setHUDVisible', elementId: cursor.id, visible: 'yes' },
        { type: 'setHUDProperty', elementId: cursor.id, property: 'x', value: target.x + config.x * sx },
        { type: 'setHUDProperty', elementId: cursor.id, property: 'y', value: target.y + config.y * sy },
      ], [screen(name)]);
    }
  }
}
