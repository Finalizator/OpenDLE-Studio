import { hudElement, installDefaultHUD } from './hud.js';
import { AMMO_TYPES, ammoMaximum, WEAPON_SPRITES } from './player-state.js';

// Classic status-bar coordinates are authored in the 320x200 Doom screen space.
export function importDoomHUD(project, assets) {
  if (!assets.has('STBAR')) {
    assets.warnings.add('No STBAR status-bar patch found; installed the editable OpenDLE HUD instead.');
    installDefaultHUD(project); return false;
  }
  const hud = project.hud = { width: 320, height: 200, scaleMode: 'fit', reserveBottom: 32, pixelated: true,
    fonts: [], elements: [], animations: [] };
  const sheet = project.eventSheets.find(sheet => sheet.name === 'HUD');
  const used = new Set([...project.events, ...project.eventSheets, ...(project.eventGroups || []),
    ...project.map.entities, ...project.map.vertices, ...project.map.walls, ...(project.map.sectors || []), ...assets.assets].map(item => item.id));
  const id = base => {
    let value = `wad_hud_${base}`, suffix = 1;
    while (used.has(value)) value = `wad_hud_${base}_${suffix++}`;
    used.add(value); return value;
  };
  const add = (name, type, properties = {}) => {
    const element = { ...hudElement(id(name.replace(/[^a-zA-Z0-9_-]/g, '_')), type, name), ...properties };
    hud.elements.push(element); return element;
  };
  const groups = new Map();
  const rule = (name, condition, actions, conditions = []) => {
    const title = name.startsWith('face_') ? 'Face expression priority'
      : name.includes('_face') ? 'Face frames and idle animation' : 'Keys and cursor';
    if (!groups.has(title)) {
      const group = { id: id(`group_${groups.size}`), name: title, sheetId: sheet.id, enabled: true,
        description: title === 'Face expression priority' ? 'Later matching rules take priority. Editable feedback thresholds; not Doom RNG or exact GZDoom mugshot logic.' : 'Editable imported status-bar rules.' };
      project.eventGroups.push(group); groups.set(title, group.id);
    }
    project.events.push({ id: id(name), name: name.replaceAll('_', ' '), sheetId: sheet.id,
      groupId: groups.get(title), enabled: true, once: false, condition, conditions, actions });
  };
  const panel = add('Status bar', 'panel', { x: -160, y: -32, width: 320, height: 32,
    anchors: { left: .5, right: .5, top: 1, bottom: 1 }, z: 10, background: '#000000' });
  add('Status bar widescreen backing', 'panel', { anchors: { left: 0, right: 1, top: 1, bottom: 1 },
    x: 0, y: -32, width: 0, height: 32, background: '#272a2e', z: 9 });
  function patch(name, label, x, y, extra = {}) {
    if (!assets.has(name)) { assets.warnings.add(`Missing HUD patch ${name}; omitted ${label}.`); return null; }
    const assetId = assets.get(name, 'sprite'), asset = assets.assets.find(asset => asset.id === assetId);
    return add(label, 'image', { parentId: panel.id, x: x - asset.offsetX, y: y - asset.offsetY,
      width: asset.width, height: asset.height, assetId, z: 1, ...extra });
  }
  patch('STBAR', 'WAD status-bar artwork', 0, 0, { z: 0 });
  patch('STARMS', 'Weapon slots artwork', 104, 0);
  patch('STTPRCNT', 'Health percent', 90, 3);
  patch('STTPRCNT', 'Armor percent', 221, 3);
  function font(prefix, label) {
    const names = Array.from({ length: 10 }, (_, digit) => `${prefix}${digit}`);
    const missing = names.filter(name => !assets.has(name));
    if (missing.length) {
      assets.warnings.add(`Incomplete ${label} HUD digit font (${missing.join(', ')}); numeric fields use readable text.`);
      return null;
    }
    const atlas = assets.atlas(`ODLE_${prefix}`, names);
    const font = { id: id(prefix), name: label, type: 'bitmap', assetId: atlas.assetId,
      cellWidth: atlas.cellWidth, cellHeight: atlas.cellHeight, columns: atlas.columns, chars: '0123456789' };
    hud.fonts.push(font); return font;
  }
  const large = font('STTNUM', 'WAD large red digits'), small = font('STYSNUM', 'WAD small yellow digits');
  function number(label, binding, right, top, raster, digits = 3) {
    const fontSize = raster?.cellHeight || (label.startsWith('Reserve') || label.startsWith('Capacity') ? 6 : 16);
    return add(label, 'text', { parentId: panel.id, x: right - (raster?.cellWidth || fontSize * .65) * digits, y: top,
      width: (raster?.cellWidth || fontSize * .65) * digits, height: fontSize, fontSize, align: 'right',
      binding, text: '', maxLength: digits, ...(raster ? { fontId: raster.id } : {}), z: 2 });
  }
  number('Selected weapon ammo', 'ammo', 44, 3, large);
  number('Health', 'health', 90, 3, large);
  number('Armor', 'armor', 221, 3, large);
  AMMO_TYPES.forEach((ammo, index) => {
    number(`Reserve ${ammo}`, ammo, 288, 5 + index * 6, small);
    number(`Capacity ${ammo}`, ammoMaximum(ammo), 314, 5 + index * 6, small);
  });
  for (let slot = 2; slot <= 7; slot++) {
    const x = 111 + (slot - 2) % 3 * 12, y = slot < 5 ? 4 : 14;
    patch(`STGNUM${slot}`, `Unowned weapon slot ${slot}`, x, y, { visibilityBinding: `slot:${slot}`, visibilityInverted: true });
    patch(`STYSNUM${slot}`, `Owned weapon slot ${slot}`, x, y, { visibilityBinding: `slot:${slot}` });
  }
  for (const [index, color] of ['blue', 'yellow', 'red'].entries()) {
    const card = `key:${color}Card`, skull = `key:${color}Skull`;
    const cardIcon = patch(`STKEYS${index}`, `${color} keycard`, 239, 3 + index * 10, { visibilityBinding: card });
    const skullIcon = patch(`STKEYS${index + 3}`, `${color} skull key`, 239, 3 + index * 10, { visibilityBinding: skull });
    if (assets.has(`STKEYS${index + 6}`)) {
      patch(`STKEYS${index + 6}`, `${color} combined keys`, 239, 3 + index * 10, { visible: false });
      const combined = hud.elements.at(-1);
      for (const icon of [cardIcon, skullIcon, combined].filter(Boolean)) {
        rule(`keys_${icon.id}_reset`, { type: 'always' }, [{ type: 'setHUDVisible', elementId: icon.id, visible: icon === combined ? 'no' : 'yes' }]);
      }
      rule(`combined_${color}`, { type: 'keyOwned', key: `${color}Card` }, [
        ...[cardIcon, skullIcon].filter(Boolean).map(icon => ({ type: 'setHUDVisible', elementId: icon.id, visible: 'no' })),
        { type: 'setHUDVisible', elementId: combined.id, visible: 'yes' },
      ], [{ type: 'keyOwned', key: `${color}Skull` }]);
    } else if (cardIcon && skullIcon) {
      // Vanilla patches have no combined icon; a skull takes precedence when both are owned.
      rule(`card_${color}`, { type: 'always' }, [{ type: 'setHUDVisible', elementId: cardIcon.id, visible: 'yes' }]);
      rule(`skull_${color}`, { type: 'keyOwned', key: `${color}Skull` }, [{ type: 'setHUDVisible', elementId: cardIcon.id, visible: 'no' }]);
    }
  }
  const expressions = ['STFST00', 'STFST01', 'STFST02'];
  const names = [];
  for (let pain = 0; pain < 5; pain++) {
    names.push(...expressions.map(name => name.replace('0', String(pain))),
      `STFTR${pain}0`, `STFTL${pain}0`, `STFOUCH${pain}`, `STFEVL${pain}`, `STFKILL${pain}`);
  }
  names.push('STFGOD0', 'STFDEAD0');
  const available = names.filter(name => assets.has(name));
  const missing = names.filter(name => !assets.has(name));
  if (missing.length) assets.warnings.add(`Missing HUD face frames: ${missing.join(', ')}. Available idle frames are used for missing expressions.`);
  if (available.length) {
    const atlas = assets.atlas('ODLE_FACES', available, { offsets: true });
    const face = add('Player face', 'image', { parentId: panel.id, x: 143 + atlas.left, y: atlas.top,
      width: atlas.cellWidth, height: atlas.cellHeight, assetId: atlas.assetId,
      sprite: { columns: atlas.columns, rows: atlas.rows }, frame: 0, z: 3 });
    installFaceRules(hud, face, atlas, id, rule);
  }
  add('Messages', 'text', { anchors: { left: 0, right: 1, top: 0, bottom: 0 }, x: 4, y: 4, width: -8,
    height: 15, fontSize: 6, align: 'left', binding: 'message', text: '', z: 20 });
  const resume = add('Resume', 'button', { anchors: { left: .5, right: .5, top: .5, bottom: .5 },
    x: -40, y: -12, width: 80, height: 24, fontSize: 10, text: 'RESUME', display: 'cursor', z: 30 });
  rule('cursor', { type: 'keyPressed', key: 'Tab' }, [{ type: 'setHUDCursor', mode: 'toggle' }]);
  rule('resume', { type: 'hudClicked', elementId: resume.id }, [{ type: 'setHUDCursor', mode: 'game' }]);
  return true;
}

function installFaceRules(hud, face, atlas, id, rule) {
  const setFace = expression => [{ type: 'setPlayerFace', expression }];
  const compare = (signal, operator, value) => ({ type: 'playerFeedback', signal, operator, value });
  rule('face_idle', { type: 'always' }, setFace('idle'));
  rule('face_attack', compare('attackTime', '>=', 2), setFace('rampage'));
  rule('face_new_weapon', compare('weaponPickup', '>', 0), setFace('grin'));
  rule('face_hurt', compare('damage', '>', 0), setFace('hurt'));
  for (const [expression, direction] of [['left', -1], ['right', 1]]) {
    rule(`face_${expression}`, compare('damage', '>', 0), setFace(expression), [compare('damageDirection', '=', direction)]);
  }
  rule('face_ouch', compare('damage', '>', 20), setFace('ouch'));
  rule('face_god', { type: 'playerStat', stat: 'invulnerable', operator: '>', value: 0 }, setFace('god'));
  rule('face_dead', { type: 'playerStat', stat: 'health', operator: '<=', value: 0 }, setFace('dead'));
  const frame = name => atlas.frames[name] ?? atlas.frames.STFST00 ?? 0;
  const clips = [];
  for (let pain = 0; pain < 5; pain++) {
    const clip = { id: id(`face_idle_${pain}`), name: `Idle face / pain ${pain}`, duration: 1.5, loop: true, autoPlay: false,
      tracks: [{ elementId: face.id, property: 'frame', easing: 'step', keys: [
        { time: 0, value: frame(`STFST${pain}0`) }, { time: .5, value: frame(`STFST${pain}1`) },
        { time: 1, value: frame(`STFST${pain}2`) }, { time: 1.5, value: frame(`STFST${pain}0`) },
      ] }] };
    hud.animations.push(clip); clips.push(clip);
  }
  const stop = clips.map(clip => ({ type: 'stopHUDAnimation', animationId: clip.id }));
  for (let pain = 0; pain < 5; pain++) {
    const conditions = [{ type: 'playerStat', stat: 'health', operator: '>', value: pain === 4 ? 0 : 80 - pain * 20 }];
    if (pain > 0) conditions.push({ type: 'playerStat', stat: 'health', operator: '<=', value: 100 - pain * 20 });
    rule(`idle_face_${pain}`, { type: 'playerFace', expression: 'idle' }, [
      ...stop.filter(action => action.animationId !== clips[pain].id), { type: 'playHUDAnimation', animationId: clips[pain].id },
    ], [...conditions, { type: 'hudAnimationPlaying', animationId: clips[pain].id, inverted: true }]);
    for (const [expression, name] of Object.entries({ hurt: `STFKILL${pain}`, left: `STFTL${pain}0`, right: `STFTR${pain}0`,
      ouch: `STFOUCH${pain}`, grin: `STFEVL${pain}`, rampage: `STFKILL${pain}` })) {
      rule(`${expression}_face_${pain}`, { type: 'playerFace', expression }, [
        ...stop, { type: 'setHUDProperty', elementId: face.id, property: 'frame', value: frame(name) },
      ], conditions);
    }
  }
  for (const [expression, name] of [['god', 'STFGOD0'], ['dead', 'STFDEAD0']]) {
    rule(`${expression}_face`, { type: 'playerFace', expression }, [
      ...stop, { type: 'setHUDProperty', elementId: face.id, property: 'frame', value: frame(name) },
    ]);
  }
}

export function installDoomInventoryScripts(project) {
  const sheet = name => project.eventSheets.find(sheet => sheet.name === name).id;
  const groups = new Map();
  let sequence = 0;
  const rule = (section, name, condition, actions, conditions = [], extra = {}) => {
    if (!groups.has(section)) {
      const group = { id: `wad_inventory_group_${section}`, name: section === 'Input' ? 'Owned weapon selection' : 'Doom inventory pickups',
        sheetId: sheet(section), enabled: true, description: 'Imported editable inventory rules. Full Doom weapon/power-up behavior is not implemented.' };
      project.eventGroups.push(group); groups.set(section, group.id);
    }
    project.events.push({ id: `wad_inventory_${sequence++}`, name, sheetId: sheet(section), groupId: groups.get(section),
      enabled: true, once: false, condition, conditions, actions, ...extra });
  };
  for (const [key, weapon] of [['Digit1', 'fist'], ['Digit2', 'pistol'], ['Digit3', 'shotgun'], ['Digit4', 'chaingun'],
    ['Digit5', 'rocketLauncher'], ['Digit6', 'plasmaRifle'], ['Digit7', 'bfg'], ['Digit8', 'chainsaw'], ['Digit9', 'superShotgun']]) {
    if (project.events.some(event => event.condition.type === 'keyPressed' && event.condition.key === key &&
      event.actions.some(action => action.type === 'selectWeapon' && action.weapon === weapon))) continue;
    rule('Input', `Select ${weapon}`, { type: 'keyPressed', key }, [{ type: 'selectWeapon', weapon }], [{ type: 'weaponOwned', weapon }]);
  }
  const ammo = (ammo, amount) => ({ type: 'addAmmo', ammo, amount });
  const stat = (stat, value) => ({ type: 'setPlayerStat', stat, value });
  const capped = (stat, value, maximum) => ({ type: 'addPlayerStat', stat, value, maximum });
  const below = (stat, value) => ({ type: 'playerStat', stat, operator: '<', value });
  const pickups = [
    ...[[2007, 'bullets', 10], [2048, 'bullets', 50], [2008, 'shells', 4], [2049, 'shells', 20],
      [2010, 'rockets', 1], [2046, 'rockets', 5], [2047, 'cells', 20], [17, 'cells', 100]]
      .map(([type, kind, amount]) => [type, [ammo(kind, amount)], [{ type: 'ammoBelowCapacity', ammo: kind }]]),
    ...[[2001, 'shotgun', 'shells', 8], [82, 'superShotgun', 'shells', 8], [2002, 'chaingun', 'bullets', 20],
      [2003, 'rocketLauncher', 'rockets', 2], [2004, 'plasmaRifle', 'cells', 40], [2006, 'bfg', 'cells', 40], [2005, 'chainsaw', null, 0]]
      .map(([type, weapon, kind, amount]) => [type,
        [{ type: 'setWeaponOwned', weapon, owned: 'yes' }, ...(kind ? [ammo(kind, amount)] : []), { type: 'selectWeapon', weapon }],
        [{ type: 'weaponOwned', weapon, inverted: true }, ...(kind ? [{ type: 'ammoBelowCapacity', ammo: kind }] : [])]]),
    ...[[5, 'blueCard'], [6, 'yellowCard'], [13, 'redCard'], [40, 'blueSkull'], [39, 'yellowSkull'], [38, 'redSkull']]
      .map(([type, key]) => [type, [{ type: 'setKeyOwned', key, owned: 'yes' }], [{ type: 'keyOwned', key, inverted: true }]]),
    [2011, [capped('health', 10, 100)], [below('health', 100)]],
    [2012, [capped('health', 25, 100)], [below('health', 100)]],
    [2013, [capped('health', 100, 200)], [below('health', 200)]],
    [2014, [capped('health', 1, 200)], [below('health', 200)]],
    [2015, [capped('armor', 1, 200)], [below('armor', 200)]],
    [2018, [stat('armor', 100), stat('armorDivisor', 3)], [below('armor', 100)]],
    [2019, [stat('armor', 200), stat('armorDivisor', 2)], [below('armor', 200)]],
    [83, [stat('health', 200), stat('armor', 200), stat('armorDivisor', 2)], [below('health', 200), below('armor', 200)]],
    [8, [{ type: 'giveBackpack' }, ammo('bullets', 10), ammo('shells', 4), ammo('rockets', 1), ammo('cells', 20)],
      [{ type: 'backpackOwned', inverted: true }, ...AMMO_TYPES.map(ammo => ({ type: 'ammoBelowCapacity', ammo }))]],
  ];
  const present = new Set(project.map.entities.filter(entity => entity.type === 'pickup').map(entity => entity.doomType));
  for (const [type, actions, needs] of pickups) {
    if (!present.has(type)) continue;
    const parentId = `wad_inventory_${sequence}`;
    rule('Pickups', `Doom pickup ${type} / proximity`, { type: 'entityDoomType', entityId: '$self', doomType: type }, [],
      [{ type: 'playerReachesEntity', entityId: '$self', distance: 36, height: 56, below: 8 }, { type: 'playerStat', stat: 'health', operator: '>', value: 0 }],
      { forEachType: 'pickup' });
    rule('Pickups', `Doom pickup ${type} / collect`, needs[0] || { type: 'always' },
      [...actions, { type: 'playSound', sound: 'DSITEMUP', volume: .7 }, { type: 'removeEntity', entityId: '$self' }], needs.slice(1),
      { forEachType: 'pickup', parentId, conditionMode: 'or' });
  }
  project.environment.weaponAssets = Object.fromEntries(Object.entries(WEAPON_SPRITES).flatMap(([weapon, prefix]) => {
    const asset = project.assets?.find(asset => asset.kind === 'weapon' && asset.name.startsWith(prefix));
    return asset ? [[weapon, asset.id]] : [];
  }));
}
