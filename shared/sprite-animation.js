const deathFrames = {
  POSS: 'HIJKL', SPOS: 'HIJKL', CPOS: 'HIJKLMN', TROO: 'IJKLM', SARG: 'IJKLMN',
  SKUL: 'FGHIJK', HEAD: 'GHIJK', BOSS: 'IJKLMNO', BOS2: 'IJKLMNO', BSPI: 'JKLMNOP',
  PAIN: 'HIJKLM', SKEL: 'LMNOPQ', FATT: 'KLMNOPQRST', VILE: 'QRSTUVWXYZ',
  CYBR: 'HIJKLMNOP', SPID: 'JKLMNOPQRS',
};
const attackFrames = {
  POSS: 'EFE', SPOS: 'EFE', CPOS: 'EFE', TROO: 'EFG', SARG: 'EFG', SKUL: 'CD',
  HEAD: 'BCD', BOSS: 'EFG', BOS2: 'EFG', BSPI: 'DEEF', PAIN: 'DEFF', SKEL: 'JJKK',
  FATT: 'GHIGHIGHIG', VILE: 'GGHIJKLMNOP', CYBR: 'EFEFEF', SPID: 'AGHH',
};
const painFrames = { TROO: 'H', SARG: 'H', SKUL: 'E', HEAD: 'EF', BOSS: 'H', BOS2: 'H',
  BSPI: 'I', SKEL: 'L', FATT: 'J', VILE: 'Q', SPID: 'I' };
export const doomWalk = {
  POSS: ['ABCD', 8 / 35, 70], SPOS: ['ABCD', 6 / 35, 280 / 3], CPOS: ['ABCD', 6 / 35, 280 / 3],
  TROO: ['ABCD', 6 / 35, 280 / 3], SARG: ['ABCD', 4 / 35, 175],
  SKUL: ['AB', 6 / 35, 140 / 3], HEAD: ['A', 3 / 35, 280 / 3],
  BOSS: ['ABCD', 6 / 35, 280 / 3], BOS2: ['ABCD', 6 / 35, 280 / 3],
  BSPI: ['ABCDEF', 6 / 35, 350 / 3], PAIN: ['ABC', 6 / 35, 280 / 3],
  SKEL: ['ABCDEF', 4 / 35, 175], FATT: ['ABCDEF', 8 / 35, 70],
  VILE: ['ABCDEF', 4 / 35, 262.5], CYBR: ['ABCD', 6 / 35, 140], SPID: ['ABCDEF', 6 / 35, 105],
};

export function clipFrame(project, clipId, elapsed) {
  const clip = project.spriteClips?.find(clip => clip.id === clipId);
  if (!clip) return null;
  const duration = clip.frames.length * clip.seconds;
  const time = clip.loop ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 1e-8);
  return { assetId: clip.frames[Math.floor(time / clip.seconds)], finished: !clip.loop && elapsed >= duration };
}

export function setSpriteState(project, state, entity, name, restart = false) {
  const clipId = entity.spriteStates?.[name];
  if (!clipId) return;
  const current = state.spriteAnimations.get(entity.id);
  if (current?.name === name && !restart) return;
  if (current && !['death', 'pain'].includes(name) && !clipFrame(project, current.clipId, state.time - current.start)?.finished &&
    !project.spriteClips.find(clip => clip.id === current.clipId).loop) return;
  state.spriteAnimations.set(entity.id, { clipId, name, start: state.time });
}

export function spriteAsset(project, state, entity) {
  const animation = state.spriteAnimations.get(entity.id);
  return clipFrame(project, animation?.clipId || entity.spriteStates?.stand, animation ? state.time - animation.start : state.time)?.assetId || entity.spriteAsset;
}

export function spriteView(project, state, entity, viewer = state.player) {
  const assetId = spriteAsset(project, state, entity);
  const rotations = project.assets.find(asset => asset.id === assetId)?.rotations;
  if (!rotations) return { assetId, flip: false };
  const bearing = Math.atan2(viewer.y - entity.y, viewer.x - entity.x) * 180 / Math.PI;
  const rotation = ((Math.floor(((entity.angle || 0) - bearing + 22.5) / 45) % 8) + 8) % 8;
  return rotations[rotation];
}

export function installSpriteAnimations(project, assets) {
  project.spriteClips ||= [];
  const used = new Set([...project.assets, ...project.events, ...project.eventSheets, ...project.eventGroups,
    ...project.map.vertices, ...project.map.walls, ...project.map.sectors, ...project.map.entities,
    ...(project.hud ? [...project.hud.elements, ...project.hud.fonts, ...project.hud.animations] : [])].map(item => item.id));
  function clip(prefix, name, letters, seconds, loop, kind = 'sprite') {
    const frames = [];
    for (const letter of letters) {
      const frame = assets.spriteFrame ? assets.spriteFrame(prefix, letter, kind)
        : [`${prefix}${letter}0`, `${prefix}${letter}1`].find(name => assets.has(name));
      if (frame) frames.push(assets.spriteFrame ? frame : assets.get(frame, kind));
    }
    if (!frames.length) return null;
    let id = `clip_${prefix}_${name}`;
    const existing = project.spriteClips.find(clip => clip.id === id);
    if (existing) return id;
    while (used.has(id)) id += '_';
    used.add(id); project.spriteClips.push({ id, name: `${prefix} / ${name}`, frames, seconds, loop });
    return id;
  }
  project.materialAnimations = [];
  for (const sequence of assets.materialSequences()) {
    const frames = sequence.names.map(name => assets.get(name, sequence.kind));
    let id = `clip_material_${project.spriteClips.length}`;
    while (used.has(id)) id += '_';
    used.add(id);
    project.spriteClips.push({ id, name: `${sequence.start} / surface`, frames, seconds: sequence.seconds, loop: true });
    for (const assetId of sequence.used) {
      project.materialAnimations = project.materialAnimations.filter(entry => entry.assetId !== assetId);
      project.materialAnimations.push({ assetId, clipId: id, offset: frames.indexOf(assetId) * sequence.seconds });
    }
  }
  for (const entity of project.map.entities) {
    const asset = project.assets.find(asset => asset.id === entity.spriteAsset);
    if (!asset) continue;
    const prefix = asset.name.slice(0, 4);
    const [walkLetters, walkSeconds] = doomWalk[prefix] || ['ABCD', 8 / 35];
    const states = entity.type === 'enemy'
      ? { stand: clip(prefix, 'stand', prefix === 'HEAD' || prefix === 'PAIN' ? 'A' : 'AB', 10 / 35, true),
        walk: clip(prefix, 'walk', walkLetters, walkSeconds, true),
        attack: clip(prefix, 'attack', attackFrames[prefix] || 'EF', 6 / 35, false), pain: clip(prefix, 'pain', painFrames[prefix] || 'G', 4 / 35, false),
        death: clip(prefix, 'death', deathFrames[prefix] || 'HIJKLMN', 6 / 35, false) }
      : { stand: clip(prefix, 'idle', 'ABCD', 6 / 35, true) };
    entity.spriteStates = Object.fromEntries(Object.entries(states).filter(([, id]) => id));
  }
  const weapons = { fist: ['PUNG', 'BCD'], pistol: ['PISG', 'BC'], shotgun: ['SHTG', 'BCDEFGHI'],
    superShotgun: ['SHT2', 'BCDEFGHIJK'], chaingun: ['CHGG', 'AB'], rocketLauncher: ['MISG', 'BC'],
    plasmaRifle: ['PLSG', 'AB'], bfg: ['BFGG', 'BC'], chainsaw: ['SAWG', 'CD'] };
  for (const [weapon, [prefix, letters]] of Object.entries(weapons)) {
    const event = project.events.find(event => event.name === weapon);
    const id = clip(prefix, 'fire', letters, 3 / 35, false, 'weapon');
    if (id && event) event.actions.push({ type: 'playWeaponClip', weapon, clipId: id });
  }
  const projectile = {
    rocket: [clip('MISL', 'fly', 'A', 4 / 35, true), clip('MISL', 'impact', 'BCD', 6 / 35, false)],
    plasma: [clip('PLSS', 'fly', 'AB', 6 / 35, true), clip('PLSE', 'impact', 'ABCDE', 4 / 35, false)],
    bfg: [clip('BFS1', 'fly', 'AB', 4 / 35, true), clip('BFE1', 'impact', 'ABCDEF', 6 / 35, false)],
    imp: [clip('BAL1', 'fly', 'AB', 4 / 35, true), clip('BAL1', 'impact', 'CDE', 6 / 35, false)],
  };
  for (const event of project.events) for (const action of event.actions) {
    if (!['launchProjectile', 'enemyProjectile'].includes(action.type)) continue;
    const kind = action.type === 'enemyProjectile' ? 'imp' : event.name === 'bfg' ? 'bfg' : event.name === 'plasmaRifle' ? 'plasma' : 'rocket';
    const [fly, impact] = projectile[kind];
    if (fly) action.clipId = fly;
    if (impact) action.impactClipId = impact;
  }
  const death = project.events.find(event => event.name === 'remove_dead_enemies');
  death.name = 'animate_dead_enemies';
  death.once = true;
  death.actions = [death.actions[0], { type: 'setSpriteState', entityId: '$self', state: 'death', restart: 'no' }];
  const enemySheet = project.eventSheets.find(sheet => sheet.name === 'Enemies').id;
  const enemyGroup = project.eventGroups.find(group => group.sheetId === enemySheet).id;
  for (const event of project.events.filter(event => event.name?.endsWith('_chase') || event.name?.endsWith('_attack'))) {
    event.actions.push({ type: 'setSpriteState', entityId: '$self', state: event.name.endsWith('_chase') ? 'walk' : 'attack', restart: event.name.endsWith('_chase') ? 'no' : 'yes' });
  }
  let sequence = 0;
  for (const [name, condition, stateName, conditions] of [
    ['rest', { type: 'enemyAlert', entityId: '$self', inverted: true }, 'stand', []],
    ['pain', { type: 'entityDamaged', entityId: '$self' }, 'pain', []],
  ]) {
    let id;
    do { id = `sprite_rule_${sequence++}`; } while (used.has(id));
    used.add(id);
    project.events.push({ id, name: `Enemy sprite / ${name}`, sheetId: enemySheet, groupId: enemyGroup, enabled: true, once: false,
      forEachType: 'enemy', condition, conditions: [...conditions, { type: 'entityHealth', entityId: '$self', operator: '>', value: 0 }],
      actions: [{ type: 'setSpriteState', entityId: '$self', state: stateName, restart: 'no' }] });
  }
}
