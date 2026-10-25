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
  const index = spriteIndex(project);
  if (!index.clips.has(clipId)) return null;
  return index.frame(clipId, elapsed);
}

const indexCache = new WeakMap();

// Sprite lookups are per entity per frame; the index turns the two linear scans
// (clip by id and asset by id) into map hits and reuses one result object.
export function spriteIndex(project) {
  const assets = project.assets, clips = project.spriteClips;
  const cached = indexCache.get(project);
  if (cached && cached.assetList === assets && cached.clipList === clips &&
    cached.assetCount === (assets?.length || 0) && cached.clipCount === (clips?.length || 0)) return cached;
  const index = createSpriteIndex(project);
  index.assetList = assets; index.clipList = clips;
  index.assetCount = assets?.length || 0; index.clipCount = clips?.length || 0;
  indexCache.set(project, index);
  return index;
}

export function createSpriteIndex(project) {
  const assetById = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const clipById = new Map((project.spriteClips || []).map(clip => [clip.id, clip]));
  const frameResult = { assetId: null, finished: false };
  const viewResult = { assetId: null, flip: false };
  function frame(clipId, elapsed) {
    const clip = clipById.get(clipId);
    if (!clip) { frameResult.assetId = null; frameResult.finished = false; return frameResult; }
    const duration = clip.frames.length * clip.seconds;
    const time = clip.loop ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 1e-8);
    frameResult.assetId = clip.frames[Math.floor(time / clip.seconds)];
    frameResult.finished = !clip.loop && elapsed >= duration;
    return frameResult;
  }
  function asset(id) { return assetById.get(id); }
  function clip(id) { return clipById.get(id); }
  function view(state, entity, viewer = state.player) {
    const animation = state.spriteAnimations?.get(entity.id);
    const clipId = animation?.clipId || entity.spriteStates?.stand;
    let assetId = entity.spriteAsset;
    if (clipId) {
      const current = frame(clipId, animation ? state.time - animation.start : state.time);
      if (current.assetId) assetId = current.assetId;
    }
    const rotations = assetById.get(assetId)?.rotations;
    if (!rotations) { viewResult.assetId = assetId; viewResult.flip = false; return viewResult; }
    const bearing = Math.atan2(viewer.y - entity.y, viewer.x - entity.x) * 180 / Math.PI;
    const rotation = ((Math.floor(((entity.angle || 0) - bearing + 22.5) / 45) % 8) + 8) % 8;
    const sprite = rotations[rotation];
    viewResult.assetId = sprite.assetId;
    viewResult.flip = Boolean(sprite.flip);
    return viewResult;
  }
  return { assets: assetById, clips: clipById, asset, clip, frame, view };
}

export function setSpriteState(project, state, entity, name, restart = false) {
  const clipId = entity.spriteStates?.[name];
  if (!clipId) return;
  const index = spriteIndex(project);
  const current = state.spriteAnimations.get(entity.id);
  if (current?.name === name && !restart) return;
  if (current && !['death', 'pain'].includes(name) && !index.frame(current.clipId, state.time - current.start).finished &&
    !index.clip(current.clipId)?.loop) return;
  state.spriteAnimations.set(entity.id, { clipId, name, start: state.time });
}

export function spriteAsset(project, state, entity) {
  const index = spriteIndex(project);
  const animation = state.spriteAnimations.get(entity.id);
  const clipId = animation?.clipId || entity.spriteStates?.stand;
  return (clipId ? index.frame(clipId, animation ? state.time - animation.start : state.time).assetId : null) || entity.spriteAsset;
}

export function spriteView(project, state, entity, viewer = state.player) {
  const view = spriteIndex(project).view(state, entity, viewer);
  return { assetId: view.assetId, flip: view.flip };
}

export function installSpriteAnimations(project, assets) {
  project.spriteClips ||= [];
  const used = new Set([...project.assets, ...project.events, ...project.eventSheets, ...project.eventGroups,
    ...project.map.vertices, ...project.map.walls, ...project.map.sectors, ...project.map.entities,
    ...(project.hud ? [...project.hud.elements, ...project.hud.fonts, ...project.hud.animations] : [])].map(item => item.id));
  const assetById = new Map(project.assets.map(asset => [asset.id, asset]));
  const existingClips = new Map(project.spriteClips.map(clip => [clip.id, clip]));
  function clip(prefix, name, letters, seconds, loop, kind = 'sprite') {
    const frames = [];
    for (const letter of letters) {
      const frame = assets.spriteFrame ? assets.spriteFrame(prefix, letter, kind)
        : [`${prefix}${letter}0`, `${prefix}${letter}1`].find(name => assets.has(name));
      if (frame) frames.push(assets.spriteFrame ? frame : assets.get(frame, kind));
    }
    if (!frames.length) return null;
    let id = `clip_${prefix}_${name}`;
    if (existingClips.has(id)) return id;
    while (used.has(id)) id += '_';
    used.add(id);
    const created = { id, name: `${prefix} / ${name}`, frames, seconds, loop };
    project.spriteClips.push(created); existingClips.set(id, created);
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
    const asset = assetById.get(entity.spriteAsset);
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
