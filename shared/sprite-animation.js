import { SPRITE_ANIMATIONS } from './vanilla-animations.js';
import { actorModelFor } from './model-import.js';

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

const clipCache = new WeakMap(), nameCache = new WeakMap();

/**
 * The frames of one actor state block, in execution order. The run ends where the
 * block ends: goto/loop/stop records and the next label are not part of it.
 */
export function actorFrameRun(actor, label) {
  const frames = actor?.states?.frames;
  if (!frames?.length) return [];
  const labels = actor.states.labels || {};
  let start = labels[label];
  if (!Number.isInteger(start)) {
    const key = Object.keys(labels).find(candidate => candidate.toLowerCase() === String(label).toLowerCase());
    start = key === undefined ? null : labels[key];
  }
  if (!Number.isInteger(start) || !frames[start]) return [];
  const label0 = frames[start].label;
  const run = [];
  for (let index = start; index < frames.length && frames[index].kind === 'frame'; index++) {
    // Real state data terminates a block before the next label, but a list that
    // omits the terminator must not bleed into the following state.
    if (index > start && label0 && frames[index].label && frames[index].label !== label0) break;
    run.push(frames[index]);
    if (!(frames[index].duration > 0)) break;
  }
  return run;
}

/** The sprite and letter of every frame an actor's states draw. */
export function actorSpriteCells(actor) {
  const cells = new Map();
  for (const frame of actor?.states?.frames || []) {
    if (frame.kind !== 'frame' || !frame.sprite || !frame.letter) continue;
    const prefix = String(frame.sprite).toUpperCase();
    if (!cells.has(prefix)) cells.set(prefix, new Set());
    cells.get(prefix).add(frame.letter);
  }
  return cells;
}

/** Sprite asset name to asset id, so an actor's state frames can name their images. */
function spriteAssetNames(project) {
  let names = nameCache.get(project);
  if (names) return names;
  names = new Map();
  for (const asset of project.assets || []) {
    if (asset.kind !== 'sprite') continue;
    const key = String(asset.name).toUpperCase();
    if (!names.has(key)) names.set(key, asset.id);
  }
  nameCache.set(project, names);
  return names;
}

const effectClipCache = new WeakMap();

/**
 * A one-shot clip of an actor's `Spawn` frames, for decorative actors a missile
 * spawns as it flies (trail particles, spray puffs). Unlike a projectile's clip it
 * stops at the end, so the renderer can drop the effect when it finishes.
 */
export function actorEffectClip(project, actor) {
  let cached = effectClipCache.get(project);
  if (!cached) effectClipCache.set(project, cached = new Map());
  if (cached.has(actor.id)) return cached.get(actor.id);
  const names = spriteAssetNames(project);
  const assets = [];
  let duration = 0;
  const run = actorFrameRun(actor, 'Spawn');
  const frames = run.length ? run : actorFrameRun(actor, 'See');
  for (const frame of frames) {
    const sprite = String(frame.sprite || '').toUpperCase();
    const id = names.get(`${sprite}${frame.letter}0`) || names.get(`${sprite}${frame.letter}1`);
    if (!id) continue;
    assets.push(id);
    if (frame.duration > 0 && !duration) duration = frame.duration;
  }
  let clipId = null;
  if (assets.length) {
    clipId = `clip_actor_${actor.id}_effect`;
    if (!(project.spriteClips || []).some(clip => clip.id === clipId))
      (project.spriteClips ||= []).push({ id: clipId, name: `${actor.name} / effect`.slice(0, 100),
        frames: assets, seconds: Math.min(60, Math.max(.001, (duration || 1) / 35)), loop: false });
  }
  cached.set(actor.id, clipId);
  return clipId;
}

/**
 * The flying and impact sprite clips an imported projectile animates through: a
 * Doom missile draws its `Spawn` states while it travels and its `Death` states
 * when it explodes. The clips become project data so the renderer's sprite index
 * and the level asset list both see them.
 */
export function actorProjectileClips(project, actor) {
  let cached = clipCache.get(project);
  if (!cached) clipCache.set(project, cached = new Map());
  if (cached.has(actor.id)) return cached.get(actor.id);
  const result = { fly: null, impact: null };
  cached.set(actor.id, result);
  const frames = actor?.states?.frames;
  if (!frames?.length) return result;
  const labels = actor.states.labels || {};
  const labelIndex = name => {
    if (name in labels) return labels[name];
    const key = Object.keys(labels).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : labels[key];
  };
  const names = spriteAssetNames(project);
  function sequence(label) {
    return actorFrameRun(actor, label);
  }
  function clip(kind, label, loop) {
    const assets = [];
    let seconds = 0;
    for (const frame of sequence(label)) {
      const sprite = String(frame.sprite || '').toUpperCase();
      const id = names.get(`${sprite}${frame.letter}0`) || names.get(`${sprite}${frame.letter}1`);
      if (!id) continue;
      assets.push(id);
      if (frame.duration > 0 && !seconds) seconds = frame.duration;
    }
    if (!assets.length) return null;
    const id = `clip_actor_${actor.id}_${kind}`;
    if ((project.spriteClips || []).some(clip => clip.id === id)) return id;
    (project.spriteClips ||= []).push({ id, name: `${actor.name} / ${kind}`.slice(0, 100), frames: assets,
      seconds: Math.min(60, Math.max(.001, (seconds || 1) / 35)), loop });
    return id;
  }
  result.fly = clip('fly', 'Spawn', true) || clip('fly', 'See', true);
  result.impact = clip('impact', 'Death', false) || clip('impact', 'Crash', false);
  return result;
}

/**
 * Replaces the classic letter sequences with the actor's own state frames, and
 * gives a placed actor's clips real frames instead of guesses. Runs after
 * `installSpriteAnimations`, which still covers things with no actor record.
 */
export function installActorSpriteStates(project) {
  if (!project.actors?.length) return 0;
  const byId = new Map(), byName = new Map(), byDoomed = new Map();
  for (const actor of project.actors) {
    byId.set(actor.id, actor);
    byName.set(actor.name.toLowerCase(), actor);
    if (actor.doomedNum !== null && actor.doomedNum !== undefined) byDoomed.set(actor.doomedNum, actor);
  }
  let applied = 0;
  for (const entity of project.map.entities) {
    if (entity.type === 'player') continue;
    const actor = (entity.actorId && byId.get(entity.actorId)) ||
      (entity.actorName && byName.get(String(entity.actorName).toLowerCase())) ||
      (entity.doomType !== undefined && byDoomed.get(entity.doomType)) || null;
    if (!actor?.states?.frames?.length) continue;
    if (applyActorSpriteStates(project, entity, actor)) applied++;
  }
  return applied;
}

/**
 * Points one entity at an actor's own state frames. Shared with morphing, where
 * the actor changes while the entity stays the same object.
 */
export function applyActorSpriteStates(project, entity, actor) {
  if (!actor?.states?.frames?.length) return false;
  const states = { stand: 'Spawn', walk: 'See', attack: 'Missile', pain: 'Pain', death: 'Death' };
  const mapped = {};
  for (const [state, label] of Object.entries(states)) {
    // A melee-only monster has no Missile block; its attack frames live in Melee.
    const id = actorStateClip(project, actor, state, label) ||
      (state === 'attack' ? actorStateClip(project, actor, 'attack', 'Melee') : null);
    if (id) mapped[state] = id;
  }
  if (!Object.keys(mapped).length) return false;
  entity.spriteStates = mapped;
  const first = actorFrameRun(actor, 'Spawn')[0];
  if (first) {
    const names = spriteAssetNames(project);
    entity.spriteAsset = names.get(`${String(first.sprite).toUpperCase()}${first.letter}0`) || entity.spriteAsset;
    // A MODELDEF actor shows a mesh on that frame instead of a picture. The mesh is in map
    // units, so it is drawn at 1:1; the spin is the mod's own `ROTATING` declaration.
    const modelAsset = actorModelFor(actor, first.sprite, first.letter);
    if (modelAsset) {
      entity.modelAsset = modelAsset;
      // An OBJ is authored in map units, so it is drawn at 1:1; a MODELDEF `Scale` still
      // multiplies it, and a non-uniform one is reported rather than silently half-applied.
      const scale = actor.model.scale || [1, 1, 1];
      entity.modelScale = scale.every(value => value === scale[0]) ? scale[0] : 1;
      if (entity.modelScale !== 1 && !scale.every(value => value === scale[0])) {
        (project.warnings ||= []).push(`${actor.name}: non-uniform model scale ${scale.join(' ')} is drawn at 1:1.`);
      }
      if (actor.model.offset?.some(value => value)) entity.modelOffset = actor.model.offset;
      entity.modelSpin = {
        rotating: Boolean(actor.model.rotating),
        rotationVector: actor.model.rotationVector,
        rotationSpeed: actor.model.rotationSpeed,
        rollOffset: actor.model.rollOffset,
      };
    }
  }
  return true;
}

/** One clip for one actor state, built from that state's own frames. */
function actorStateClip(project, actor, state, label) {
  const names = spriteAssetNames(project), frames = [];
  let seconds = 0;
  let previous = null, run = 0;
  for (const frame of actorFrameRun(actor, label)) {
    const sprite = String(frame.sprite || '').toUpperCase();
    const id = names.get(`${sprite}${frame.letter}0`) || names.get(`${sprite}${frame.letter}1`);
    if (!id) continue;
    // Doom holds a walking pose for two states (`AABBCCDD`), and a clip has one duration
    // for all its frames, so a repeated picture becomes one longer frame: the animation
    // looks identical and stays uniform. Only runs of the *same* picture collapse.
    if (id === previous) { run += Math.max(1, frame.duration); continue; }
    if (previous && !seconds) seconds = run;
    previous = id;
    run = Math.max(1, frame.duration);
    frames.push(id);
  }
  if (previous && !seconds) seconds = run;
  if (!frames.length) return null;
  const id = `clip_actor_${actor.id}_${state}`;
  if (!(project.spriteClips || []).some(clip => clip.id === id)) {
    (project.spriteClips ||= []).push({ id, name: `${actor.name} / ${state}`.slice(0, 100), frames,
      seconds: Math.min(60, Math.max(.001, (seconds || 1) / 35)), loop: state === 'stand' || state === 'walk' });
  }
  return id;
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
    // A clip steps at one fixed rate, so a surface whose frames last different tics (an
    // ANIMDEFS block per picture) is laid out at one tic per step with each frame repeated
    // for its own duration. Equal durations keep the compact form.
    const tics = sequence.tics || [];
    const uniform = !tics.length || tics.every(tics_ => tics_ === tics[0]);
    const seconds = uniform ? (tics[0] || Math.round(sequence.seconds * 35)) / 35 : 1 / 35;
    const frames = [];
    for (let index = 0; index < sequence.names.length; index++) {
      const assetId = assets.get(sequence.names[index], sequence.kinds?.[index] || sequence.kind);
      const repeats = uniform ? 1 : Math.max(1, Math.min(255, Math.round(tics[index] || 1)));
      if (!assetId) continue;
      for (let repeat = 0; repeat < repeats; repeat++) frames.push(assetId);
    }
    if (!frames.length) continue;
    let id = `clip_material_${project.spriteClips.length}`;
    while (used.has(id)) id += '_';
    used.add(id);
    project.spriteClips.push({ id, name: `${sequence.start} / surface`, frames, seconds, loop: true });
    for (const assetId of sequence.used) {
      project.materialAnimations = project.materialAnimations.filter(entry => entry.assetId !== assetId);
      project.materialAnimations.push({ assetId, clipId: id, offset: frames.indexOf(assetId) * seconds });
    }
  }
  for (const entity of project.map.entities) {
    const asset = assetById.get(entity.spriteAsset);
    if (!asset) continue;
    const prefix = asset.name.slice(0, 4);
    // Measured from GZDoom where the prefix is one of Doom's monsters
    // (`shared/vanilla-animations.js`): the frames Doom actually plays, not a guess. The
    // tables below stay as the fallback for prefixes the measurement does not cover.
    const measured = SPRITE_ANIMATIONS[prefix];
    const sequence = (key, letters, seconds) => measured?.[key]
      ? { letters: measured[key].letters, seconds: measured[key].tics / 35 }
      : { letters, seconds };
    const walk = sequence('see', ...(doomWalk[prefix] || ['ABCD', 8 / 35]));
    const attack = sequence('missile', (attackFrames[prefix] || 'EF'), 6 / 35);
    const pain = sequence('pain', (painFrames[prefix] || 'G'), 4 / 35);
    const death = sequence('death', (deathFrames[prefix] || 'HIJKLMN'), 6 / 35);
    const states = entity.type === 'enemy'
      ? { stand: clip(prefix, 'stand', prefix === 'HEAD' || prefix === 'PAIN' ? 'A' : 'AB', 10 / 35, true),
        walk: clip(prefix, 'walk', walk.letters, walk.seconds, true),
        attack: clip(prefix, 'attack', attack.letters, attack.seconds, false),
        pain: clip(prefix, 'pain', pain.letters, pain.seconds, false),
        death: clip(prefix, 'death', death.letters, death.seconds, false) }
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
