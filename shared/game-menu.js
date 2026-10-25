import { hudElement, installDefaultHUD } from './hud.js';
import { GAME_SETTINGS, GAME_BINDINGS } from './game-settings.js';

const aliases = {
  mainmenu: 'title', optionsmenu: 'settings', skillmenu: 'difficulty', playerclassmenu: 'difficulty',
  episodemenu: 'difficulty', quitmenu: 'quit', readthismenu: 'help',
  soundoptions: 'audio', mouseoptions: 'controls', controls: 'controls', videomode: 'display',
};
const cvars = { snd_sfxvolume: 'volume', snd_musicvolume: 'musicVolume', mouse_sensitivity: 'sensitivity',
  invertmouse: 'invertY', fov: 'fov', vid_brightness: 'brightness', show_messages: 'messages', cl_run: 'alwaysRun' };
export const menuScreen = name => aliases[name.toLowerCase()] || `mod_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;

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
export function parseMenuDefinitions(source, label = 'MENUDEF') {
  if (typeof source !== 'string' || source.length > 1024 * 1024) throw new Error(`${label}: menu definition exceeds 1 MiB`);
  const tokens = (source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|[{}(),\n]|[^\s{}(),]+/g) || [])
    .filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const menus = [], warnings = [];
  let i = 0;
  const text = token => token?.startsWith('"') ? JSON.parse(token) : token;
  while (i < tokens.length) {
    const kind = tokens[i++]?.toLowerCase();
    if (kind === '\n') continue;
    if (!['listmenu', 'optionmenu'].includes(kind)) {
      warnings.push(`${label}: unsupported top-level directive ${kind}`);
      while (i < tokens.length && tokens[i] !== '\n' && tokens[i] !== '{') i++;
      if (tokens[i] === '{') { let depth = 1; i++; while (i < tokens.length && depth) { const t = tokens[i++]; if (t === '{') depth++; if (t === '}') depth--; } }
      continue;
    }
    const name = text(tokens[i++]);
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
    menus.push({ name, kind, directives });
    if (menus.length > 64) throw new Error(`${label}: more than 64 menus`);
  }
  return { menus, warnings };
}

export function installGameMenu(project, assets, definitions = [], warnings = []) {
  if (project.eventSheets.some(sheet => sheet.id === 'game_menu_sheet')) return project;
  if (!project.hud) installDefaultHUD(project);
  const hud = project.hud, sx = hud.width / 320, sy = hud.height / 200;
  const used = new Set([...project.assets, ...project.events, ...project.eventSheets, ...project.eventGroups,
    ...Object.values(project.map).filter(Array.isArray).flat(), ...hud.elements, ...hud.fonts, ...hud.animations].map(item => item.id));
  let sequence = 0;
  const id = () => { let value; do { value = `menu_${sequence++}`; } while (used.has(value)); used.add(value); return value; };
  const sheet = { id: 'game_menu_sheet', name: 'Game menus', section: 'game', enabled: true, phase: 'interface' };
  project.eventSheets.push(sheet);
  const group = { id: id(), name: 'Imported game menus and settings', sheetId: sheet.id, enabled: true };
  project.eventGroups.push(group);
  const screen = name => ({ type: 'gameScreen', screen: name });
  const go = name => ({ type: 'setGameScreen', screen: name });
  function rule(name, condition, actions, conditions = []) {
    project.events.push({ id: id(), name, sheetId: sheet.id, groupId: group.id, enabled: true, once: false, condition, conditions, actions });
  }
  function element(page, type, name, x, y, width, height, extra = {}) {
    const item = { ...hudElement(id(), type, name), x: x * sx, y: y * sy, width: width * sx, height: height * sy,
      fontSize: 8 * sy, z: 9000, visible: false, ...extra };
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
      { text: image ? '' : label, background: image ? '#00000000' : '#24202aff', ...(image ? { assetId: image.id } : {}) });
    rule(label, { type: 'hudClicked', elementId: item.id }, actions, [screen(page)]);
    return item;
  }
  const pages = new Set();
  function page(name, title, back = 'settings', titlePatch, hideHeading = false) {
    if (pages.has(name)) return;
    pages.add(name);
    element(name, 'panel', `${title} background`, 0, 0, 0, 0,
      { background: '#100e16ff', anchors: { left: 0, top: 0, right: 1, bottom: 1 } });
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
  button('title', 'New game', 68, [go('difficulty')], 'M_NGAME');
  button('title', 'Options', 90, [go('settings')], 'M_OPTION');
  button('title', 'Read this', 112, [go('help')], 'M_RDTHIS');
  button('title', 'Quit', 134, [go('quit')], 'M_QUITG');
  page('pause', 'Paused', null);
  button('pause', 'Resume', 55, [go('playing')]);
  button('pause', 'Options', 80, [go('settings')], 'M_OPTION');
  button('pause', 'New game', 105, [go('difficulty')], 'M_NGAME');
  button('pause', 'Main menu', 130, [go('title')]);
  page('settings', 'Options', 'return', 'M_OPTTTL');
  for (const [index, [label, name]] of [['Sound', 'audio'], ['Display', 'display'], ['Controls', 'controls']].entries())
    button('settings', label, 48 + index * 25, [go(name)]);
  button('settings', 'Fullscreen', 125, [{ type: 'requestFullscreen' }]);
  button('settings', 'Reset settings', 150, [{ type: 'resetGameSettings' }]);
  page('audio', 'Sound options', 'settings', 'M_SVOL');
  page('display', 'Display options');
  page('controls', 'Controls');
  page('keys', 'Key bindings', 'controls');
  function setting(pageName, key, label, y, step = GAME_SETTINGS[key].step) {
    const spec = GAME_SETTINGS[key];
    element(pageName, 'text', label, 24, y, 150, 10, { text: label, align: 'left' });
    element(pageName, 'text', `${label} value`, 174, y, 74, 10, { binding: `setting:${key}` });
    if (typeof spec.value === 'boolean') {
      button(pageName, 'Toggle', y, [{ type: 'toggleGameSetting', setting: key }], null, 252, 46);
    } else {
      button(pageName, `${label} -`, y, [{ type: 'adjustGameSetting', setting: key, amount: -step }], null, 252, 20).text = '-';
      button(pageName, `${label} +`, y, [{ type: 'adjustGameSetting', setting: key, amount: step }], null, 278, 20).text = '+';
    }
  }
  setting('audio', 'volume', 'Sound volume', 45);
  setting('audio', 'musicVolume', 'Music volume', 70);
  setting('audio', 'muted', 'Mute', 95);
  element('audio', 'text', 'Music compatibility', 20, 128, 280, 36,
    { text: 'Music: embedded WAV / OGG / MP3 only.\nDoom MUS / MIDI playback not translated yet.', fontSize: 7 * sy });
  setting('display', 'fov', 'Field of view', 42);
  setting('display', 'resolution', 'Render resolution', 67);
  setting('display', 'brightness', 'Brightness', 92);
  setting('display', 'messages', 'Messages', 117);
  button('display', 'Fullscreen', 146, [{ type: 'requestFullscreen' }]);
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
  ['I am too young to die', 'Hey, not too rough', 'Hurt me plenty', 'Ultra-Violence', 'Nightmare!'].forEach((label, index) => {
    button('difficulty', label, 45 + index * 24, [
      { type: 'setGameSetting', setting: 'difficulty', value: index + 1 }, { type: 'startGame' },
    ], ['M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE'][index]);
  });
  page('quit', 'Return to editor?', 'return');
  button('quit', 'Return to editor', 80, [{ type: 'quitGame' }]);
  page('help', 'Read this', 'return');
  const help = art('HELP1') || art('HELP') || art('CREDIT');
  if (help) element('help', 'image', 'Imported help artwork', 0, 28, 320, 150, { assetId: help.id });
  else element('help', 'text', 'Controls help', 20, 40, 280, 120,
    { text: 'WASD: move\nMouse: look / fire\nSpace: jump / E: use\n1-9: weapons\nEscape: pause\nOptions: change controls and settings' });
  // Existing gameplay HUD is suppressed on menus without changing its authored state.
  project.gameMenus = { version: 1, entry: 'title', screens: [...pages],
    sources: definitions.filter(definition => definition.source.trim()).map(definition => ({ name: definition.name, source: definition.source })) };
  translateDefinitions();
  project.gameMenus.screens = [...pages];
  project.gameMenus.elementIds = hud.elements.filter(item => item.id.startsWith('menu_')).map(item => item.id);
  if (hud.elements.length > 256) throw new Error('Imported menus exceed the editable HUD element limit (256)');
  return project;

  function translateDefinitions() {
    for (const definition of definitions) {
      const parsed = parseMenuDefinitions(definition.source, definition.name);
      warnings.push(...parsed.warnings);
      for (const menu of parsed.menus) {
        const pageName = menuScreen(menu.name);
        if (pages.has(pageName)) {
          const removed = new Set(hud.elements.filter(item => project.events.some(event =>
            event.condition.type === 'gameScreen' && event.condition.screen === pageName &&
            event.actions.some(action => action.elementId === item.id))).map(item => item.id));
          hud.elements = hud.elements.filter(item => !removed.has(item.id));
          project.events = project.events.filter(event => !event.actions.some(action => removed.has(action.elementId)) && !removed.has(event.condition.elementId));
          pages.delete(pageName);
        }
        page(pageName, menu.name, pageName === 'title' ? null : 'settings');
        let x = 86, y = 40, spacing = 16, activePage = pageName, pageNumber = 1;
        const row = () => {
          if (y < 24) y = 32;
          if (y + 12 <= 174) return;
          const next = `${pageName}_page${++pageNumber}`;
          button(activePage, 'Next page', 169, [go(next)]);
          page(next, menu.name, activePage);
          activePage = next; y = 32;
          warnings.push(`${definition.name}/${menu.name}: long menu paginated into editable HUD screens`);
        };
        for (const { type, args } of menu.directives) {
          if (type === 'position') {
            if (menu.kind === 'optionmenu' && args.length === 1) y = Number(args[0]);
            else { x = Number(args[0]); y = Number(args[1]); }
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              warnings.push(`${definition.name}/${menu.name}: invalid Position; using readable fallback coordinates`);
              x = 86; y = 40;
            }
          }
          else if (type === 'linespacing') spacing = Number(args[0]);
          else if (type === 'title') {
            const heading = hud.elements.find(item => item.name === `${menu.name} heading`); heading.text = args[0];
          } else if (type === 'statictext' && menu.kind === 'optionmenu') {
            row();
            element(activePage, 'text', args[0] || `${menu.name} spacer`, 20, y, 280, 12, { text: args[0] || '' });
            y += spacing;
          } else if (['staticpatch', 'staticpatchcentered', 'statictext'].includes(type)) {
            const image = type !== 'statictext' && art(args[2]);
            if (type !== 'statictext' && !image) { warnings.push(`${definition.name}/${menu.name}: missing patch ${args[2]}`); continue; }
            element(pageName, image ? 'image' : 'text', args[2], Number(args[0]) - (type === 'staticpatchcentered' ? image.width / 2 : 0), Number(args[1]),
              image?.width || 200, image?.height || 12, { text: image ? '' : args[2], ...(image ? { assetId: image.id } : {}) });
          } else if (['patchitem', 'textitem', 'submenu', 'command'].includes(type)) {
            const target = args[type === 'patchitem' || type === 'textitem' ? 2 : 1];
            const action = /^newgame$/i.test(target) ? { type: 'setGameScreen', screen: 'difficulty' }
              : /^(quit|exit)$/i.test(target) ? go('quit')
                : go(menuScreen(target || 'MainMenu'));
            const supported = /menu$/i.test(target || '') || ['submenu', 'patchitem', 'textitem'].includes(type) || /^(newgame|quit|exit)$/i.test(target || '');
            if (!supported) { warnings.push(`${definition.name}/${menu.name}: command ${target} is not executable; omitted`); continue; }
            row();
            button(activePage, args[0], y, [action], type === 'patchitem' ? args[0] : null, x); y += spacing;
          } else if (['slider', 'option'].includes(type)) {
            const key = cvars[String(args[1]).toLowerCase()];
            if (!key) { warnings.push(`${definition.name}/${menu.name}: setting ${args[1]} has no engine implementation; omitted`); continue; }
            const increment = type === 'slider' && Number.isFinite(Number(args[4])) && Number(args[4]) > 0 ? Number(args[4]) : undefined;
            row();
            setting(activePage, key, args[0], y, increment); y += spacing;
          } else if (type === 'control') {
            const key = { '+forward': 'KeyW', '+back': 'KeyS', '+moveleft': 'KeyA', '+moveright': 'KeyD',
              '+left': 'ArrowLeft', '+right': 'ArrowRight', '+use': 'KeyE', '+jump': 'Space', '+speed': 'ShiftLeft', '+attack': 'Mouse0' }[args[1]];
            if (!key) { warnings.push(`${definition.name}/${menu.name}: unsupported control ${args[1]}`); continue; }
            row();
            const item = button(activePage, args[0], y, [{ type: 'captureGameBinding', key }], null, x);
            item.text = `${args[0]}: {key:${key}}`; y += spacing;
          } else
            warnings.push(`${definition.name}/${menu.name}: unsupported directive ${type}`);
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
}
