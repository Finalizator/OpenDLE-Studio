import { validateHUDStyle } from './hud-style.js';
import { HUD_PLAYER_BINDINGS, playerBinding, initialPlayerStats } from './player-state.js';
import { GAME_HUD_BINDINGS, GAME_SETTINGS } from './game-settings.js';

export const HUD_PROPERTIES = ['x', 'y', 'width', 'height', 'opacity', 'scale', 'rotation', 'value', 'frame', 'fontSize'];
export const HUD_STATS = ['health', 'armor', 'bullets'];
const limits = {
  x: [-16384, 16384], y: [-16384, 16384], width: [-16384, 16384], height: [-16384, 16384],
  opacity: [0, 1], scale: [.01, 20], rotation: [-3600, 3600], value: [-1e9, 1e9],
  frame: [0, 4095], fontSize: [1, 512],
};

export function validateHUDProperty(property, value, element, assert) {
  assert(HUD_PROPERTIES.includes(property), 'Unknown HUD property');
  const [min, max] = limits[property];
  assert(Number.isFinite(value) && value >= min && value <= max, `HUD ${property} must be between ${min} and ${max}`);
  if (property === 'width' && element.anchors.left === element.anchors.right ||
    property === 'height' && element.anchors.top === element.anchors.bottom) assert(value >= 1, 'Fixed HUD dimensions must be positive');
  if (property === 'frame' && element.sprite) assert(value < element.sprite.columns * element.sprite.rows, 'HUD frame exceeds sprite grid');
}

export function validateHUD(hud, { unique, assets, variables, assert }) {
  if (hud === undefined) return;
  const obj = (value, label) => assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const num = (value, min, max, label) => assert(Number.isFinite(value) && value >= min && value <= max, `HUD ${label} must be between ${min} and ${max}`);
  const text = (value, max, label) => assert(typeof value === 'string' && value.length <= max, `HUD ${label} must be text up to ${max} characters`);
  const list = (value, max, label) => assert(Array.isArray(value) && value.length <= max, `HUD ${label} must contain at most ${max} items`);
  const image = id => {
    const asset = assets.find(asset => asset.id === id);
    assert(asset && !['model', 'font', 'sound'].includes(asset.kind), 'HUD image references an unknown image asset');
    return asset;
  };
  const color = value => assert(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value), 'HUD color must be #rrggbb or #rrggbbaa');
  obj(hud, 'HUD'); num(hud.width, 64, 4096, 'width'); num(hud.height, 64, 4096, 'height');
  assert(['fit', 'stretch', 'integer'].includes(hud.scaleMode), 'Unknown HUD scaling mode');
  if (hud.reserveBottom !== undefined) num(hud.reserveBottom, 0, hud.height - 1, 'reserved game-view bottom');
  if (hud.pixelated !== undefined) assert(typeof hud.pixelated === 'boolean', 'HUD pixelated must be boolean');
  if (hud.sources !== undefined) {
    list(hud.sources, 64, 'imported sources');
    let size = 0;
    for (const source of hud.sources) {
      obj(source, 'imported source'); text(source.name, 512, 'source name'); text(source.source, 1024 * 1024, 'source');
      size += source.source.length;
    }
    assert(size <= 2 * 1024 * 1024, 'HUD imported sources exceed 2 MiB');
  }
  list(hud.fonts, 64, 'fonts'); list(hud.elements, 256, 'elements'); list(hud.animations, 128, 'animations');
  if (hud.styles !== undefined) {
    list(hud.styles, 128, 'CSS classes');
    const names = new Set();
    for (const style of hud.styles) {
      validateHUDStyle(style, assert);
      assert(!names.has(style.name), 'Duplicate HUD CSS class'); names.add(style.name);
    }
  }
  for (const font of hud.fonts) {
    unique(font, 'HUD font'); text(font.name, 100, 'font name');
    assert(['web', 'bitmap'].includes(font.type), 'Unknown HUD font type');
    if (font.type === 'web') assert(assets.some(asset => asset.id === font.assetId && asset.kind === 'font'), 'HUD web font requires an embedded font asset');
    else {
      const asset = image(font.assetId);
      for (const key of ['cellWidth', 'cellHeight', 'columns']) {
        num(font[key], 1, 2048, key); assert(Number.isInteger(font[key]), 'Bitmap font cells and columns must be integers');
      }
      text(font.chars, 4096, 'bitmap character order'); assert(font.chars.length > 0, 'Bitmap font needs characters');
      assert(new Set([...font.chars]).size === [...font.chars].length, 'Bitmap font characters must be unique');
      if (font.spaceWidth !== undefined) num(font.spaceWidth, 1, 512, 'font space width');
      if (font.widths !== undefined) {
        list(font.widths, 4096, 'glyph widths');
        assert(font.widths.length === [...font.chars].length, 'HUD font glyph widths must match character order');
        for (const width of font.widths) num(width, 1, 512, 'glyph width');
      }
      assert(font.columns * font.cellWidth <= asset.width &&
        Math.ceil([...font.chars].length / font.columns) * font.cellHeight <= asset.height, 'Bitmap font cells exceed its atlas');
    }
  }
  const seen = new Set();
  for (const element of hud.elements) {
    unique(element, 'HUD element'); text(element.name, 100, 'element name');
    assert(['panel', 'text', 'image', 'bar', 'button'].includes(element.type), 'Unknown HUD element type');
    if (element.parentId !== undefined) assert(seen.has(element.parentId), 'HUD parent must precede its children');
    seen.add(element.id);
    let depth = 0, parent = element;
    while (parent.parentId) {
      assert(++depth <= 16, 'HUD hierarchy is too deep');
      parent = hud.elements.find(item => item.id === parent.parentId);
    }
    obj(element.anchors, 'HUD anchors');
    for (const key of ['left', 'top', 'right', 'bottom']) num(element.anchors[key], 0, 1, `anchor ${key}`);
    assert(element.anchors.left <= element.anchors.right && element.anchors.top <= element.anchors.bottom, 'HUD anchors are inverted');
    for (const key of ['x', 'y', 'width', 'height', 'opacity', 'scale', 'rotation', 'value', 'frame', 'fontSize']) {
      validateHUDProperty(key, element[key], element, (ok, message) => assert(ok, `${element.name}: ${message} (received ${element[key]})`));
    }
    num(element.pivotX, 0, 1, 'pivot X'); num(element.pivotY, 0, 1, 'pivot Y'); num(element.z, -10000, 10000, 'layer');
    num(element.maximum, .001, 1e9, 'bar maximum');
    if (element.fillDirection !== undefined)
      assert(['right', 'left', 'up', 'down'].includes(element.fillDirection), 'Unknown HUD bar fill direction');
    if (element.fillAssetId !== undefined && element.fillAssetId !== '') {
      assert(element.type === 'bar', 'HUD fill image requires a bar element'); image(element.fillAssetId);
    }
    if (element.imageRepeat !== undefined) assert(element.imageRepeat === 'repeat-x', 'Unknown HUD image repeat mode');
    assert(typeof element.visible === 'boolean' && typeof element.interactive === 'boolean', 'HUD visible/interactive must be boolean');
    for (const key of ['statusbar', 'menuSelectable', 'menuSelector']) if (element[key] !== undefined)
      assert(typeof element[key] === 'boolean', `HUD ${key} must be boolean`);
    assert(['always', 'game', 'cursor'].includes(element.display), 'Unknown HUD display mode');
    text(element.text, 2000, 'text'); text(element.binding, 100, 'binding');
    const bindings = [...HUD_PLAYER_BINDINGS, ...GAME_HUD_BINDINGS, 'message', ...Object.keys(variables).map(key => `var:${key}`)];
    assert(['', ...bindings].includes(element.binding), 'HUD binding references an unknown engine value');
    if (element.visibilityBinding !== undefined) assert(['', ...bindings.filter(binding => binding !== 'message')].includes(element.visibilityBinding), 'HUD visibility binding references an unknown engine value');
    if (element.visibilityInverted !== undefined) assert(typeof element.visibilityInverted === 'boolean', 'HUD visibility inversion must be boolean');
    if (element.maxLength !== undefined) {
      num(element.maxLength, 1, 32, 'maximum text length');
      assert(Number.isInteger(element.maxLength), 'HUD maximum text length must be an integer');
    }
    for (const match of element.text.matchAll(/\{([^{}]+)\}/g)) {
      assert(bindings.includes(match[1]), `Unknown HUD text binding: ${match[1]}`);
    }
    color(element.color); color(element.background);
    assert(['left', 'center', 'right'].includes(element.align), 'Unknown HUD text alignment');
    if (element.fontId) assert(hud.fonts.some(font => font.id === element.fontId), 'HUD element references an unknown font');
    if (element.styleClass) assert(hud.styles?.some(style => style.name === element.styleClass), 'Unknown HUD CSS class');
    if (element.assetId) {
      const asset = image(element.assetId);
      if (element.slice) {
        obj(element.slice, 'Nine-patch borders');
        for (const key of ['left', 'top', 'right', 'bottom']) num(element.slice[key], 0, 2048, `nine-patch ${key}`);
        assert(element.slice.left + element.slice.right < asset.width && element.slice.top + element.slice.bottom < asset.height, 'Nine-patch borders must leave a center region');
      }
      if (element.sprite) {
        obj(element.sprite, 'HUD sprite');
        for (const key of ['columns', 'rows']) {
          num(element.sprite[key], 1, 64, `sprite ${key}`);
          assert(Number.isInteger(element.sprite[key]), 'Sprite grid must be integers');
        }
        assert(element.frame < element.sprite.columns * element.sprite.rows, 'HUD sprite frame exceeds its grid');
      }
      assert(!(element.slice && element.sprite), 'Choose nine-patch or sprite frames, not both');
    } else assert(!element.slice && !element.sprite, 'Nine-patch and sprite frames need an image');
  }
  for (const clip of hud.animations) {
    unique(clip, 'HUD animation'); text(clip.name, 100, 'animation name');
    num(clip.duration, .001, 3600, 'animation duration');
    assert(typeof clip.loop === 'boolean' && typeof clip.autoPlay === 'boolean', 'HUD animation loop/autoplay must be boolean');
    if (clip.phase !== undefined) assert(['game', 'interface'].includes(clip.phase), 'Unknown HUD animation phase');
    list(clip.tracks, 64, 'animation tracks');
    const targets = new Set();
    for (const track of clip.tracks) {
      obj(track, 'HUD track');
      const element = hud.elements.find(item => item.id === track.elementId);
      assert(element, 'HUD animation references an unknown element');
      assert(HUD_PROPERTIES.includes(track.property), 'Unknown HUD animation property');
      const key = `${track.elementId}:${track.property}`;
      assert(!targets.has(key), 'Duplicate HUD animation track'); targets.add(key);
      assert(['linear', 'step', 'easeInOut'].includes(track.easing), 'Unknown HUD animation easing');
      list(track.keys, 128, 'keyframes'); assert(track.keys.length >= 2, 'HUD track needs at least two keys');
      let previous = -1;
      for (const key of track.keys) {
        obj(key, 'HUD keyframe'); num(key.time, 0, clip.duration, 'key time');
        assert(key.time > previous, 'HUD keyframes must be strictly time ordered'); previous = key.time;
        num(key.value, ...limits[track.property], 'key value');
        validateHUDProperty(track.property, key.value, element, assert);
        if (track.property === 'frame' && element.sprite) assert(key.value < element.sprite.columns * element.sprite.rows, 'Animation frame exceeds sprite grid');
      }
    }
  }
}

export function hudElement(id, type = 'text', name = type) {
  return { id, name, type, anchors: { left: 0, top: 0, right: 0, bottom: 0 }, pivotX: 0, pivotY: 0,
    x: 20, y: 20, width: 180, height: 40, opacity: 1, scale: 1, rotation: 0, z: 0,
    visible: true, interactive: type === 'button', display: 'always', text: type === 'text' || type === 'button' ? 'Text' : '',
    binding: '', value: 100, maximum: 100, frame: 0, fontSize: 24, align: 'center', color: '#f7d9a0',
    background: type === 'panel' || type === 'button' ? '#252a30ee' : '#00000000' };
}

export function hudViewport(hud, width, height) {
  let sx = width / hud.width, sy = height / hud.height;
  if (hud.scaleMode !== 'stretch') {
    let scale = Math.min(sx, sy);
    if (hud.scaleMode === 'integer' && scale >= 1) scale = Math.floor(scale);
    sx = sy = scale;
  }
  return { width: width / sx, height: height / sy, sx, sy };
}

export function hudRect(element, width, height) {
  const w = Math.max(1, element.width + (element.anchors.right - element.anchors.left) * width);
  const h = Math.max(1, element.height + (element.anchors.bottom - element.anchors.top) * height);
  return { x: element.anchors.left * width + element.x - element.pivotX * w,
    y: element.anchors.top * height + element.y - element.pivotY * h, width: w, height: h };
}

export function hudBinding(binding, state) {
  if (binding.startsWith('setting:')) return state.settings?.[binding.slice(8)] ?? GAME_SETTINGS[binding.slice(8)]?.value;
  if (binding.startsWith('key:') && state.settings?.bindings?.[binding.slice(4)]) return state.settings.bindings[binding.slice(4)];
  if (binding === 'game:screen') return state.gameScreen || 'playing';
  if (binding === 'game:binding') return state.bindingKey ? `Press a key or mouse button for ${state.bindingKey}; Escape cancels` : 'Select a binding to change it';
  if (binding === 'message') return state.settings?.messages === false ? '' : state.messageTime > 0 ? state.message : '';
  if (binding.startsWith('var:')) return state.variables[binding.slice(4)];
  return playerBinding(binding, state);
}

export function hudText(element, state) {
  const text = element.binding ? String(hudBinding(element.binding, state))
    : element.text.replace(/\{([^{}]+)\}/g, (_, key) => String(hudBinding(key, state)));
  return element.maxLength ? text.slice(-element.maxLength) : text;
}

export function bitmapGlyph(font, char) {
  const chars = [...font.chars], exact = chars.indexOf(char), index = exact >= 0 ? exact : chars.indexOf(char.toUpperCase());
  const advance = char === ' ' && font.spaceWidth !== undefined ? font.spaceWidth
    : index >= 0 ? font.widths?.[index] ?? font.cellWidth : font.cellWidth;
  return { index, advance };
}

export function createHUDState(project) {
  const hud = { elements: new Map((project.hud?.elements || []).map(element => [element.id, structuredClone(element)])),
    playing: new Map(),
    finished: new Set(), clicked: new Set(), cursor: false, initialStats: initialPlayerStats(), statSamples: new Map() };
  for (const clip of project.hud?.animations || []) if (clip.autoPlay) playHUDAnimation(project, hud, clip.id);
  return hud;
}

function applyHUDPose(clip, hud, time) {
  for (const track of clip.tracks) {
    const keys = track.keys;
    let a = keys[0], b = keys.at(-1);
    for (let i = 1; i < keys.length; i++) if (time < keys[i].time) { a = keys[i - 1]; b = keys[i]; break; } else a = keys[i];
    let t = a === b ? 0 : Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
    if (track.easing === 'step') t = 0;
    if (track.easing === 'easeInOut') t = t * t * (3 - 2 * t);
    hud.elements.get(track.elementId)[track.property] = a.value + (b.value - a.value) * t;
  }
}

export function playHUDAnimation(project, hud, id) {
  const clip = project.hud.animations.find(clip => clip.id === id);
  hud.playing.delete(id); hud.playing.set(id, { time: 0 });
  applyHUDPose(clip, hud, 0);
}

export function advanceHUD(project, hud, dt, phase = 'game') {
  hud.finished.clear();
  for (const [id, playback] of hud.playing) {
    const clip = project.hud.animations.find(clip => clip.id === id);
    if ((clip.phase || 'game') !== phase) continue;
    playback.time += dt;
    const done = playback.time + 1e-9 >= clip.duration;
    const time = clip.loop ? playback.time % clip.duration : Math.min(playback.time, clip.duration);
    applyHUDPose(clip, hud, time);
    if (done && !clip.loop) { hud.playing.delete(id); hud.finished.add(id); }
  }
}

export function installDefaultHUD(project) {
  if (project.hud) throw new Error('HUD already exists; edit it rather than replacing authored content');
  const used = new Set([
    ...['vertices', 'walls', 'sectors', 'entities'].flatMap(key => (project.map[key] || []).map(item => item.id)),
    ...['assets', 'events', 'eventSheets', 'eventGroups'].flatMap(key => (project[key] || []).map(item => item.id)),
  ]);
  const id = name => {
    name = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    let value = name, suffix = 1;
    while (used.has(value)) value = `${name}_${suffix++}`;
    used.add(value); return value;
  };
  const elements = [];
  const add = (name, type, props) => {
    const element = { ...hudElement(id(`hud_${name}`), type, name), ...props };
    elements.push(element); return element;
  };
  const bottom = { left: 0, right: 1, top: 1, bottom: 1 };
  add('Status bar', 'panel', { anchors: bottom, x: 0, y: -68, width: 0, height: 68, background: '#20262df5', z: 10 });
  for (const [stat, x, label] of [['bullets', .18, 'AMMO'], ['health', .4, 'HEALTH'], ['armor', .62, 'ARMOR']]) {
    const anchors = { left: x, right: x, top: 1, bottom: 1 };
    add(`${label} label`, 'text', { anchors, x: -65, y: -23, width: 130, height: 18, text: label, fontSize: 12, z: 11, color: '#b5bdc7' });
    add(`${label} value`, 'text', { anchors, x: -65, y: -63, width: 130, height: 38, text: `{${stat}}${stat === 'bullets' ? '' : '%'}`, fontSize: 32, z: 11, color: '#ee7755' });
  }
  add('Health meter', 'bar', { anchors: bottom, x: 0, y: -71, width: 0, height: 3, binding: 'health', color: '#dc6549', background: '#101216', z: 11 });
  add('Engine label', 'text', { anchors: { left: .84, right: .84, top: 1, bottom: 1 }, x: -60, y: -56,
    width: 120, height: 42, text: 'OpenDLE', fontSize: 19, z: 11 });
  const crosshair = add('Crosshair', 'text', { anchors: { left: .5, right: .5, top: .5, bottom: .5 },
    x: -12, y: -12, width: 24, height: 24, text: '+', color: '#e0e7d6', fontSize: 24, display: 'game', z: 5, pivotX: 0, pivotY: 0 });
  add('Messages', 'text', { anchors: { left: 0, right: 1, top: 0, bottom: 0 }, x: 16, y: 16, width: -32, height: 44,
    binding: 'message', fontSize: 15, align: 'left', z: 20 });
  const flash = add('Damage flash', 'panel', { anchors: { left: 0, right: 1, top: 0, bottom: 1 },
    x: 0, y: 0, width: 0, height: 0, background: '#d72d1e', opacity: 0, z: 2 });
  const resume = add('Resume', 'button', { anchors: { left: .5, right: .5, top: .5, bottom: .5 },
    x: -100, y: 45, width: 200, height: 48, text: 'RESUME', display: 'cursor', z: 30 });
  const damage = { id: id('hud_damage'), name: 'Damage flash', duration: .35, loop: false, autoPlay: false,
    tracks: [{ elementId: flash.id, property: 'opacity', easing: 'linear', keys: [{ time: 0, value: .45 }, { time: .35, value: 0 }] }] };
  const shot = { id: id('hud_shot'), name: 'Crosshair shot pulse', duration: .14, loop: false, autoPlay: false,
    tracks: [{ elementId: crosshair.id, property: 'opacity', easing: 'linear', keys: [{ time: 0, value: .25 }, { time: .14, value: 1 }] }] };
  project.hud = { width: 800, height: 450, scaleMode: 'fit', fonts: [], elements, animations: [damage, shot] };
  let sheet = project.eventSheets?.find(sheet => sheet.section === 'engine' && sheet.name === 'HUD');
  if (!sheet) {
    sheet = { id: id('hud_sheet'), name: 'HUD', section: 'game', phase: 'afterPhysics', enabled: true };
    (project.eventSheets ||= []).push(sheet);
  }
  const rules = [];
  const rule = (name, condition, actions) => rules.push({ id: id(`hud_rule_${name}`), name, sheetId: sheet.id,
    enabled: true, once: false, condition, actions });
  rule('damage_feedback', { type: 'hudStatChanged', stat: 'health', direction: 'decreased' }, [{ type: 'playHUDAnimation', animationId: damage.id }]);
  rule('shot_feedback', { type: 'hudStatChanged', stat: 'bullets', direction: 'decreased' }, [{ type: 'playHUDAnimation', animationId: shot.id }]);
  rule('cursor', { type: 'keyPressed', key: 'Tab' }, [{ type: 'setHUDCursor', mode: 'toggle' }]);
  rule('resume', { type: 'hudClicked', elementId: resume.id }, [{ type: 'setHUDCursor', mode: 'game' }]);
  project.events.unshift(...rules);
  return project;
}
