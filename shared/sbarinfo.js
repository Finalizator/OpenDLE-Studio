import { hudElement, bitmapGlyph, MAX_HUD_ELEMENTS } from './hud.js';
import { ammoMaximum } from './player-state.js';

const MAX_SOURCE = 1024 * 1024;
const ammo = { clip: 'bullets', shell: 'shells', rocketammo: 'rockets', cell: 'cells' };
const weapons = { fist: 'fist', pistol: 'pistol', shotgun: 'shotgun', supershotgun: 'superShotgun',
  chaingun: 'chaingun', rocketlauncher: 'rocketLauncher', plasmarifle: 'plasmaRifle', bfg9000: 'bfg', chainsaw: 'chainsaw' };
const keys = { bluecard: 'blueCard', yellowcard: 'yellowCard', redcard: 'redCard',
  blueskull: 'blueSkull', yellowskull: 'yellowSkull', redskull: 'redSkull' };
const keySlots = { 1: 'redCard', 2: 'blueCard', 3: 'yellowCard', 4: 'redSkull', 5: 'blueSkull', 6: 'yellowSkull' };
const colors = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#00ff00',
  blue: '#0000ff', gold: '#ffd700', gray: '#808080', orange: '#ff8000', untranslated: '#ffffff' };
const value = tokens => tokens?.map(token => token.value).join('') ?? '';
const lower = tokens => value(tokens).toLowerCase();
const integer = tokens => /^-?\d+$/.test(value(tokens)) ? Number(value(tokens)) : NaN;
const lookup = (table, name) => Object.hasOwn(table, name) ? table[name] : undefined;

export function parseSBarInfo(source, name = 'SBARINFO', resolve) {
  const sources = [], active = new Set();
  let budget = 0, count = 0;
  function parse(source, name, depth) {
    const fail = (line, message) => { throw new Error(`${name}:${line}: ${message}`); };
    if (typeof source !== 'string' || source.length > MAX_SOURCE) fail(1, 'SBARINFO exceeds 1 MiB');
    if (depth > 16 || active.has(name.toLowerCase())) fail(1, 'SBARINFO include cycle or depth exceeds 16');
    budget += source.length;
    if (budget > 2 * MAX_SOURCE || sources.length >= 64) fail(1, 'SBARINFO include budget exceeded');
    active.add(name.toLowerCase());
    sources.push({ name, source });
    const tokens = [];
    const lexer = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[{}(),;#]|[^\s{}(),;#"]+/gy;
    let line = 1, offset = 0;
    while (offset < source.length) {
      lexer.lastIndex = offset;
      const match = lexer.exec(source);
      if (!match) fail(line, 'Unterminated string or comment');
      const text = match[0], quoted = text.startsWith('"');
      if (text.startsWith('/*') && !text.endsWith('*/')) fail(line, 'Unterminated comment');
      if (!/^\s/.test(text) && !text.startsWith('//') && !text.startsWith('/*')) {
        let decoded = text;
        if (quoted) {
          decoded = text.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
        }
        tokens.push({ value: decoded, quoted, line });
        if (tokens.length > 100000) fail(line, 'Too many SBARINFO tokens');
      }
      line += (text.match(/\n/g) || []).length; offset = lexer.lastIndex;
    }
    let index = 0;
    const is = symbol => tokens[index]?.value === symbol && !tokens[index]?.quoted;
    function statements(nesting = 0) {
      if (nesting > 16) fail(tokens[index]?.line || line, 'SBARINFO nesting exceeds 16');
      const nodes = [];
      while (index < tokens.length && !is('}')) {
        if (is(';')) { index++; continue; }
        const token = tokens[index++];
        if (token.value === '#' && !token.quoted) {
          const command = tokens[index++], path = tokens[index++];
          if (command?.value.toLowerCase() !== 'include' || !path?.quoted) fail(token.line, 'Expected #include "resource"');
          const included = resolve?.(path.value, name);
          if (!included) fail(token.line, `Missing SBARINFO include: ${path.value}`);
          nodes.push(...parse(included.source, included.name, depth + 1));
          continue;
        }
        const node = { command: token.value.toLowerCase(), args: [[]], name, line: token.line };
        let parens = 0;
        while (index < tokens.length && (parens || !is(';') && !is('{') && !is('}'))) {
          if (is('(')) parens++;
          if (is(')') && --parens < 0) fail(tokens[index].line, 'Unexpected closing parenthesis');
          if (!parens && is(',')) { node.args.push([]); index++; }
          else node.args.at(-1).push(tokens[index++]);
        }
        if (parens) fail(token.line, 'Unclosed parenthesis');
        if (is('{')) {
          index++; node.children = statements(nesting + 1);
          if (!is('}')) fail(token.line, 'Unclosed SBARINFO block');
          index++;
        } else if (is(';')) index++;
        else fail(token.line, 'Expected semicolon or block');
        nodes.push(node);
        if (++count > 4096) fail(token.line, 'SBARINFO command budget exceeded');
      }
      return nodes;
    }
    const nodes = statements();
    if (index !== tokens.length) fail(tokens[index].line, 'Unexpected closing brace');
    active.delete(name.toLowerCase());
    return nodes;
  }
  return { nodes: parse(source, name, 0), sources };
}

function binding(tokens) {
  const text = lower(tokens);
  if (['health', 'armor'].includes(text)) return text;
  if (text === 'ammo1') return 'ammo';
  const match = /^(ammocapacity|ammo)(?:\(([^()]+)\)|([a-z]+))$/.exec(text);
  const type = match && lookup(ammo, match[2] || match[3]);
  return type ? match[1] === 'ammo' ? type : ammoMaximum(type) : null;
}

// Definitions compile to ordinary HUD elements and visual events, never evaluated source.
export function importSBarInfo(project, assets, definitions, warnings = []) {
  if (!definitions.length) return false;
  const definition = definitions.at(-1);
  const parsed = parseSBarInfo(definition.source, definition.name, definition.resolve);
  const warn = (node, message) => warnings.push(`${node.name}:${node.line}: ${message}`);
  const bars = parsed.nodes.filter(node => node.command === 'statusbar');
  const selected = bars.findLast(node => lower(node.args[0]) === 'normal') ||
    bars.findLast(node => lower(node.args[0]) === 'fullscreen');
  if (!selected) {
    warnings.push(`${definition.name}: no normal/fullscreen SBARINFO block; using the classic editable HUD.`);
    return false;
  }
  if (definitions.length > 1) warnings.push(`${definition.name}: last SBARINFO resource overrides ${definitions.length - 1} earlier resource(s).`);
  const hud = { width: 320, height: 200, reserveBottom: 0, scaleMode: 'fit', pixelated: true,
    elements: [], fonts: [], animations: [], sources: parsed.sources };
  for (const node of parsed.nodes.filter(node => node.command === 'resolution')) {
    const [width, height] = node.args.map(integer);
    if (node.args.length !== 2 || ![width, height].every(n => Number.isInteger(n) && n >= 64 && n <= 4096))
      throw new Error(`${node.name}:${node.line}: invalid SBARINFO resolution`);
    hud.width = width; hud.height = height;
  }
  for (const node of parsed.nodes) {
    if (node.command === 'height') {
      const height = integer(node.args[0]);
      if (node.args.length !== 1 || !Number.isInteger(height) || height < 0 || height >= hud.height)
        throw new Error(`${node.name}:${node.line}: invalid SBARINFO height`);
      hud.reserveBottom = height;
    } else if (!['statusbar', 'resolution'].includes(node.command)) {
      if (node.command === 'monospacefonts' && node.args.length === 2 && lower(node.args[0]) === 'true' && value(node.args[1]) === '0') continue;
      warn(node, `Unsupported SBARINFO global ${node.command}; not applied.`);
    }
  }
  const fullscreen = lower(selected.args[0]) === 'fullscreen';
  if (fullscreen) hud.reserveBottom = 0;
  for (const bar of bars) if (bar !== selected)
    warn(bar, `SBARINFO ${value(bar.args[0])} layout retained in source; only the ${value(selected.args[0])} layout is active.`);
  const flags = selected.args.slice(1).map(lower);
  if (flags.some(flag => !['fullscreenoffsets', 'forcescaled'].includes(flag))) {
    warn(selected, 'Unsupported statusbar flags; custom HUD not activated.');
    return false;
  }
  const offsets = flags.includes('fullscreenoffsets');
  const used = new Set([...project.events, ...project.eventSheets, ...(project.eventGroups || []),
    ...project.assets, ...Object.values(project.map).filter(Array.isArray).flat()].map(item => item.id));
  function id() {
    let name = `sbar_${used.size}`;
    while (used.has(name)) name += '_';
    used.add(name); return name;
  }
  const sheet = project.eventSheets.find(sheet => sheet.name === 'HUD');
  const group = { id: id(), name: 'Imported SBARINFO', sheetId: sheet.id, enabled: true,
    description: 'Custom HUD drawing and conditional visibility translated into editable elements and events.' };
  const events = [], fonts = new Map();
  function rule(name, actions, conditions = []) {
    events.push({ id: id(), name: name.slice(0, 100), sheetId: sheet.id, groupId: group.id, enabled: true, once: false,
      condition: { type: 'always' }, conditions, actions });
  }
  function position(x, y) {
    return offsets ? { x, y, anchors: { left: x < 0 ? 1 : 0, right: x < 0 ? 1 : 0, top: y < 0 ? 1 : 0, bottom: y < 0 ? 1 : 0 } }
      : { x: x - hud.width / 2, y: y - hud.height, anchors: { left: .5, right: .5, top: 1, bottom: 1 } };
  }
  function add(node, type, properties, conditions) {
    const element = { ...hudElement(id(), type, `${node.command} (${node.name}:${node.line})`.slice(0, 100)),
      ...properties, z: hud.elements.length + 10 };
    hud.elements.push(element);
    if (conditions.length) {
      element.visible = false;
      rule(`Hide ${element.name}`, [{ type: 'setHUDVisible', elementId: element.id, visible: 'no' }]);
      rule(`Show ${element.name}`, [{ type: 'setHUDVisible', elementId: element.id, visible: 'yes' }], conditions);
    }
    return element;
  }
  function image(node, name) {
    const key = name.toUpperCase();
    if (!assets.has(key)) { warn(node, `Missing SBARINFO image ${name}; drawing omitted.`); return null; }
    const assetId = assets.get(key, 'sprite');
    return assets.assets.find(asset => asset.id === assetId);
  }
  function font(node, name, translation) {
    const key = `${name}:${translation}`;
    if (fonts.has(key)) return fonts.get(key);
    const imported = assets.font?.(name);
    if (imported) {
      const result = { ...imported, id: id() };
      if (translation !== 'untranslated') warn(node, `SBARINFO ${name}/${translation} uses the font's source palette; color-range translation is not implemented.`);
      hud.fonts.push(result); fonts.set(key, result); return result;
    }
    const prefix = translation === 'untranslated' && lookup({ hudfont_doom: 'STTNUM', indexfont_doom: 'STYSNUM', indexfont: 'STYSNUM' }, name);
    const patches = prefix && Array.from({ length: 10 }, (_, i) => `${prefix}${i}`);
    if (!patches || patches.some(name => !assets.has(name))) {
      warn(node, `SBARINFO font ${name}/${translation} not available as translated bitmap glyphs; using editable monospace text and approximate text color.`);
      fonts.set(key, null); return null;
    }
    const atlas = assets.atlas(`ODLE_SBAR_${hud.fonts.length}`, patches);
    const result = { id: id(), name, type: 'bitmap', assetId: atlas.assetId, cellWidth: atlas.cellWidth,
      cellHeight: atlas.cellHeight, columns: atlas.columns, chars: '0123456789' };
    hud.fonts.push(result); fonts.set(key, result); return result;
  }
  function predicate(node) {
    let args = node.args.map(tokens => [...tokens]), inverted = false;
    if (args[0]?.[0]?.value.toLowerCase() === 'not') { args[0].shift(); inverted = true; }
    let result;
    if (node.command === 'ifhealth' && args.length === 1 && Number.isInteger(integer(args[0])))
      result = { type: 'playerStat', stat: 'health', operator: '>=', value: integer(args[0]) };
    if (node.command === 'ifinvulnerable' && args.length === 1 && !value(args[0]))
      result = { type: 'playerStat', stat: 'invulnerable', operator: '>', value: 0 };
    if (node.command === 'gamemode' && args.every(tokens => ['singleplayer', 'cooperative', 'deathmatch', 'teamgame'].includes(lower(tokens))))
      result = { type: 'expressionCompare', left: args.some(tokens => lower(tokens) === 'singleplayer'), operator: '=', right: true };
    if (['ininventory', 'isselected'].includes(node.command)) {
      const item = lower(args[0]), amount = args.length === 1 ? 1 : integer(args[1]);
      const weapon = lookup(weapons, item), key = lookup(keys, item), ammoType = lookup(ammo, item);
      if (node.command === 'isselected' && args.length === 1 && weapon)
        result = { type: 'weaponSelected', weapon };
      if (node.command === 'ininventory' && args.length <= 2 && Number.isInteger(amount) && amount >= 0) {
        if (ammoType) result = { type: 'playerStat', stat: ammoType, operator: '>=', value: Math.max(1, amount) };
        else if (amount <= 1 && weapon) result = { type: 'weaponOwned', weapon };
        else if (amount <= 1 && key) result = { type: 'keyOwned', key };
        else if (amount <= 1 && item === 'backpack') result = { type: 'backpackOwned' };
      }
    }
    return result ? { ...result, ...(inverted ? { inverted } : {}) } : null;
  }
  function compile(nodes, conditions = []) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], a = node.args, command = node.command;
      if (node.children) {
        const condition = predicate(node);
        const alternative = nodes[i + 1]?.command === 'else' ? nodes[++i] : null;
        if (!condition) { warn(node, `Unsupported SBARINFO condition ${command}; entire conditional block omitted.`); continue; }
        compile(node.children, [...conditions, condition]);
        if (alternative?.children) compile(alternative.children, [...conditions, { ...condition, inverted: !condition.inverted }]);
        continue;
      }
      if (command === 'drawswitchableimage') {
        const match = /^(keyslot|weaponslot)([1-7])(?:&&([1-7]))?$/.exec(lower(a[0]));
        const count = match?.[3] ? 4 : 2, coordinate = count + 1;
        if (!match || match[1] === 'weaponslot' && (match[3] || Number(match[2]) < 2) ||
          match[1] === 'keyslot' && (!keySlots[match[2]] || match[3] && !keySlots[match[3]]) ||
          a.length < coordinate + 2 || a.length > coordinate + 3 ||
          !a.slice(1, coordinate).every(tokens => tokens.length === 1 && tokens[0].quoted)) {
          warn(node, 'Unsupported drawswitchableimage condition or arguments; drawing omitted.'); continue;
        }
        const alternatives = [];
        if (match[1] === 'weaponslot') {
          for (let state = 0; state < 2; state++) alternatives.push({
            conditions: [], visibilityBinding: `slot:${match[2]}`, visibilityInverted: state === 0,
          });
        } else {
          const key = { type: 'keyOwned', key: keySlots[match[2]] };
          const second = match[3] && { type: 'keyOwned', key: keySlots[match[3]] };
          for (let state = 0; state < count; state++) alternatives.push({ conditions: second
            ? [{ ...key, inverted: !(state & 1) }, { ...second, inverted: !(state & 2) }]
            : [{ ...key, inverted: state === 0 }] });
        }
        for (const [index, alternative] of alternatives.entries()) {
          const name = value(a[index + 1]);
          if (!name || name.toLowerCase() === 'nullimage') continue;
          const start = hud.elements.length;
          compile([{ ...node, command: 'drawimage', args: [a[index + 1], ...a.slice(coordinate)] }],
            [...conditions, ...alternative.conditions]);
          if (hud.elements.length > start && alternative.visibilityBinding)
            Object.assign(hud.elements.at(-1), { visibilityBinding: alternative.visibilityBinding, visibilityInverted: alternative.visibilityInverted });
        }
      } else if (command === 'drawimage' && a[0]?.length === 1 && a[0][0].quoted && a.length >= 3 && a.length <= 4) {
        const x = integer(a[1]), y = integer(a[2]), alignment = lower(a[3]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !['', 'center', 'centerbottom'].includes(alignment)) {
          warn(node, 'Unsupported drawimage coordinates or alignment; drawing omitted.'); continue;
        }
        const asset = image(node, value(a[0]));
        if (!asset) continue;
        const pos = position(x, y);
        pos.x -= alignment ? asset.width / 2 : asset.offsetX || 0;
        pos.y -= alignment === 'centerbottom' ? asset.height : alignment === 'center' ? asset.height / 2 : asset.offsetY || 0;
        add(node, 'image', { ...pos, width: asset.width, height: asset.height, assetId: asset.id }, conditions);
      } else if (command === 'drawnumber') {
        const digits = integer(a[0]), bound = binding(a[3]);
        const coordinate = a.findIndex((tokens, index) => index >= 4 && Number.isFinite(integer(tokens)));
        const x = integer(a[coordinate]), y = integer(a[coordinate + 1]);
        const options = a.slice(4, coordinate).flatMap(tokens => lower(tokens).split('|'));
        const alignment = options.find(flag => /^alignment\((left|center|right)\)$/.test(flag));
        if (!Number.isInteger(digits) || digits <= 0 || !bound || coordinate < 4 || a.length !== coordinate + 2 ||
          !Number.isFinite(x) || !Number.isFinite(y) || options.some(flag => flag !== 'whennotzero' && flag !== alignment) ||
          !Object.hasOwn(colors, lower(a[2]))) {
          warn(node, 'Unsupported drawnumber value, translation, flags or arguments; drawing omitted.'); continue;
        }
        const fontName = lower(a[1]), raster = font(node, fontName, lower(a[2]));
        const size = raster?.cellHeight || (['indexfont', 'indexfont_doom', 'smallfont'].includes(fontName) ? 6 : 16);
        const count = Math.min(10, digits);
        const width = (raster?.cellWidth || size * .65) * count, pos = position(x, y);
        const align = alignment?.slice(10, -1) || 'right';
        pos.x -= align === 'left' ? 0 : align === 'center' ? width / 2 : width;
        add(node, 'text', { ...pos, width, height: size, fontSize: size, align, color: colors[lower(a[2])], text: '', binding: bound,
          maxLength: count, ...(raster ? { fontId: raster.id } : {}),
          ...(options.includes('whennotzero') ? { visibilityBinding: bound } : {}) }, conditions);
      } else if (command === 'drawstring' && a.length === 5 && a[2]?.length === 1 && a[2][0].quoted &&
        lower(a[1]) === 'untranslated' && Number.isFinite(integer(a[3])) && Number.isFinite(integer(a[4]))) {
        const text = value(a[2]);
        if (/[{}]/.test(text)) { warn(node, 'Literal braces in SBARINFO strings are not supported; drawing omitted.'); continue; }
        const raster = assets.font?.(value(a[0])) ? font(node, value(a[0]), 'untranslated') : null;
        if (!raster) warn(node, `SBARINFO string font ${value(a[0])} uses editable monospace text; font resource is unavailable.`);
        const size = raster?.cellHeight || 12;
        const lines = text.split('\n');
        const width = Math.max(1, ...lines.map(line => raster
          ? [...line].reduce((width, char) => width + bitmapGlyph(raster, char).advance, 0) +
            Math.max(0, raster.cellWidth - (line.length ? bitmapGlyph(raster, [...line].at(-1)).advance : raster.cellWidth))
          : line.length * 8));
        add(node, 'text', { ...position(integer(a[3]), integer(a[4])), width,
          height: size * lines.length, fontSize: size, align: 'left', text, ...(raster ? { fontId: raster.id } : {}) }, conditions);
      } else if (command === 'drawbar') {
        const bound = binding(a[2]), direction = lower(a[3]), reverse = lower(a[4]) === 'reverse';
        const coord = reverse ? 5 : 4, x = integer(a[coord]), y = integer(a[coord + 1]);
        if (!['health', 'armor'].includes(bound) || !['horizontal', 'vertical'].includes(direction) ||
          a.length !== coord + 2 || !a[0]?.[0]?.quoted || !a[1]?.[0]?.quoted || !Number.isFinite(x) || !Number.isFinite(y)) {
          warn(node, 'Unsupported drawbar source, direction or arguments; drawing omitted.'); continue;
        }
        const foreground = image(node, value(a[0]));
        const background = value(a[1]) ? image(node, value(a[1])) : null;
        if (!foreground || value(a[1]) && !background) continue;
        const pos = position(x, y);
        if (background) add(node, 'image', { ...pos, width: foreground.width, height: foreground.height, assetId: background.id }, conditions);
        add(node, 'bar', { ...pos, width: foreground.width, height: foreground.height, fillAssetId: foreground.id,
          binding: bound, maximum: 100, color: '#ffffff', background: '#00000000',
          fillDirection: direction === 'horizontal' ? reverse ? 'left' : 'right' : reverse ? 'down' : 'up' }, conditions);
      } else warn(node, `Unsupported SBARINFO ${command}; drawing omitted.`);
    }
  }
  compile(selected.children || []);
  if (hud.elements.length > MAX_HUD_ELEMENTS) throw new Error(`${definition.name}: SBARINFO exceeds ${MAX_HUD_ELEMENTS} editable HUD elements`);
  project.hud = hud;
  project.eventGroups.push(group);
  project.events.push(...events);
  return true;
}
