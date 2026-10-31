import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { parseDecorate, resolveActorInheritance, compileActorStates, frameBodyActions } from '../shared/decorate.js';
import { parseZScript, parseActorDefinitions } from '../shared/zscript.js';
import { parseDehacked, dehackedChanges, mergeDehackedPatches, thingName } from '../shared/dehacked.js';
import { buildVanillaActors, importActors, applyDehacked, actorIndex, parseEditorNumbers } from '../shared/actors.js';
import { actorOf, actorStateOf, actorTic, setActorState, labelIndex, initialiseActorEntities, stepActors, spawnActorProjectile,
  unsupportedActorActions, actionSupported, WEAPON_ACTION_NAMES } from '../shared/actor-runtime.js';
import { actorProjectileClips, installActorSpriteStates } from '../shared/sprite-animation.js';
import { importActorSprites, importWadMap, readWad } from '../shared/wad.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createActorsPanel } from '../public/actors-panel.js';

const DECORATE = `
actor TestImp replaces DoomImp 9999
{
  Health 80
  Speed 9
  PainChance 128
  Radius 20
  Height 56
  Mass 100
  Monster
  +FLOORCLIP
  SeeSound "imp/sight"
  States
  {
  Spawn:
    TROO AB 10 A_Look
    Loop
  See:
    TROO AABBCCDD 3 A_Chase
    Loop
  Melee:
  Missile:
    TROO EF 8 A_FaceTarget
    TROO G 6 A_TroopAttack
    Goto See
  Pain:
    TROO H 2
    TROO H 2 A_Pain
    Goto See
  Death:
    TROO I 8
    TROO J 8 A_Scream
    TROO K 6 A_NoBlocking
    TROO L 6
    TROO M -1
    Stop
  }
}
`;

const ZSCRIPT = `
class MeleeBase : Actor
{
  Default
  {
    Radius 16;
    Height 56;
    Mass 100;
    Monster;
    Health 100;
    Speed 25;
    Scale 0.9;
  }
  States
  {
  Spawn:
    TNT1 A 0;
    TNT1 A 5 { A_LookEx(fov: 360); }
    Wait;
  See:
    TNT1 ABCD 5 A_Chase('_a_chase_default', '', CHF_NORANDOMTURN);
    Loop;
  Melee:
  Missile:
    TNT1 A 1 A_FaceTarget();
    TNT1 A 0 A_CustomMeleeAttack(12, "m_melee");
    Goto See;
  }
}

class TestZMonster : MeleeBase
{
  Default { Speed 30; Health 160; }
  override void BeginPlay(void) { sprite = GetSpriteIndex("MRED"); }
  states { Nothing: MRED A 0; stop; }
}
`;

test('DECORATE actors compile into stats, flags and an executable frame list', () => {
  const parsed = parseDecorate(DECORATE, { source: 'test.dec' });
  assert.equal(parsed.actors.length, 1);
  const [record] = parsed.actors;
  assert.equal(record.name, 'TestImp');
  assert.equal(record.replaces, 'DoomImp');
  assert.equal(record.doomedNum, 9999);
  assert.equal(record.properties.Health, 80);
  assert.equal(record.flags.FLOORCLIP, true);
  const resolved = resolveActorInheritance(parsed.actors);
  const actor = resolved.actors.get('TestImp');
  const compiled = compileActorStates(actor);
  // `TROO AABBCCDD 3 A_Chase` is eight executable frames.
  const see = compiled.frames.slice(compiled.labels.get('See'), compiled.labels.get('Melee'));
  assert.equal(see.filter(frame => frame.kind === 'frame').length, 8);
  assert.ok(see.filter(frame => frame.kind === 'frame').every(frame => frame.action?.name === 'A_Chase'));
  const goto = compiled.frames.find(frame => frame.kind === 'goto');
  assert.equal(goto.target, 'See');
  assert.equal(compiled.frames[goto.targetIndex].label, 'See');
});

test('ZScript classes, defaults, inline frame bodies and inheritance are read without an interpreter', () => {
  const parsed = parseZScript(ZSCRIPT, { source: 'test.zc' });
  assert.equal(parsed.actors.length, 2);
  const base = parsed.actors.find(actor => actor.name === 'MeleeBase');
  assert.equal(base.properties.Health, 100);
  assert.equal(base.properties.Scale, 0.9);
  const derived = parsed.actors.find(actor => actor.name === 'TestZMonster');
  assert.equal(derived.parent, 'MeleeBase');
  assert.equal(derived.properties.Speed, 30);
  assert.equal(derived.functions.length, 1);
  const resolved = parseActorDefinitions([{ name: 'test.zc', text: ZSCRIPT }]);
  const monster = resolved.actors.get('TestZMonster');
  assert.equal(monster.properties.Health, 160, 'derived Default overrides the parent value');
  const compiled = compileActorStates(monster, { parentLookup: name => resolved.actors.get(name) });
  assert.ok(compiled.frames.length > 0);
  const bodyFrame = compiled.frames.find(frame => frame.body);
  assert.match(bodyFrame.body.source, /A_LookEx/);
  const actions = frameBodyActions(bodyFrame.body);
  assert.equal(actions.actions[0].name, 'A_LookEx');
  assert.equal(actions.actions[0].named.fov, 360);
});

test('a ZScript class written in lowercase keeps its defaults', () => {
  // GZDoom's own actors are spelled lowercase — `default { +NOGRAVITY }`, `States { ... }` —
  // and requiring the capitalised section keywords dropped every default in them. That is how
  // Lullaby's SecurityCamera lost `+NOGRAVITY` and fell out of the sky when the title map
  // started, which read on screen as the whole scene sliding upwards.
  const source = [
    'class SecurityCamera : Actor',
    '{',
    '\tdefault',
    '\t{',
    '\t\t+NOBLOCKMAP ',
    '\t\t+NOGRAVITY',
    '\t\t+DONTSPLASH',
    '\t\tRenderStyle "None";',
    '\t\tCameraHeight 0;',
    '\t}',
    '',
    '\tStates',
    '\t{',
    '\tSpawn:',
    '\t\tTNT1 A 1;',
    '\t\tStop;',
    '\t}',
    '}',
  ].join('\n');
  const camera = parseZScript(source).actors.find(actor => actor.name === 'SecurityCamera');
  assert.equal(camera.flags.NOGRAVITY, true, 'the flag without a semicolon is read');
  assert.equal(camera.flags.NOBLOCKMAP, true);
  assert.equal(camera.flags.DONTSPLASH, true);
  assert.equal(camera.properties.RenderStyle, 'None');
  assert.equal(camera.properties.CameraHeight, 0);
  assert.equal(camera.states.length, 1, 'the lowercase States block still yields a state table');
  assert.equal(camera.states[0].label, 'Spawn');
});

test('two flags on one line are two flags', () => {
  const source = 'class Bobbing : Actor { default { +FLOAT +NOGRAVITY } }';
  const actor = parseZScript(source).actors.find(entry => entry.name === 'Bobbing');
  assert.deepEqual(Object.keys(actor.flags).sort(), ['FLOAT', 'NOGRAVITY']);
});

test('inline frame bodies with statements report exactly what cannot run', () => {
  assert.deepEqual(frameBodyActions({ source: 'A_StartSound("fire");A_FireBullets(1,2,3,4)' }).actions.map(action => action.name),
    ['A_StartSound', 'A_FireBullets']);
  const complex = frameBodyActions({ source: 'let d = majorPlayer(invoker.owner).dmg;' });
  assert.equal(complex.actions.length, 0);
  assert.match(complex.unsupported, /let d =/);
});

test('DEHACKED patches bind through mobjinfo indexes and editor numbers', () => {
  assert.equal(thingName(11), 'DoomImp', 'mobjinfo index 11 is the Imp');
  assert.equal(thingName(3001), 'DoomImp', 'editor numbers still resolve');
  assert.equal(thingName(999999), null);
  const patch = parseDehacked([
    'Patch File for DeHackEd v3.0', 'Doom version = 21', 'Patch format = 6', '',
    'Thing 11 (Imp)', 'Hit points = 999', 'Pain chance = 0', 'Speed = 20', '',
    '[CODEPTR]', 'Frame 100 = A_Look', '',
    'Misc', 'Initial Health = 150',
  ].join('\n'));
  assert.deepEqual(patch.warnings, []);
  const changes = dehackedChanges(patch);
  assert.equal(changes.things.get(11).health, 999);
  assert.equal(changes.misc.initialHealth, 150);
  const merged = mergeDehackedPatches([{ name: 'test', patch }]);
  const actors = structuredClone(buildVanillaActors());
  const warnings = [];
  applyDehacked(actors, merged, warnings);
  const imp = actors.find(actor => actor.name === 'DoomImp');
  assert.equal(imp.health, 999);
  assert.equal(imp.speed, 20);
  assert.equal(imp.painChance, 0);
  assert.equal(imp.dehacked, true);
});

test('DEHACKED frame patches honour the classic fullbright muzzle-flash use', () => {
  const patch = parseDehacked(['Patch File for DeHackEd v3.0', 'Frame 185', 'Sprite subnumber = 32773'].join('\n'));
  const changes = dehackedChanges(patch);
  const frame = changes.frames.get(185);
  assert.equal(frame.letter, 'F', '32773 packs letter F');
  assert.equal(frame.fullbright, true);
  const actors = structuredClone(buildVanillaActors());
  applyDehacked(actors, mergeDehackedPatches([{ name: 'test', patch }]), []);
  const brightAttackFrames = actors.flatMap(actor => actor.states.frames)
    .filter(state => state.kind === 'frame' && state.letter === 'F' && state.actions.length);
  assert.ok(brightAttackFrames.length > 0);
  assert.ok(brightAttackFrames.every(state => state.bright));
});

test('DoomEdNums declarations bind editor numbers and prefer the Doom definitions', () => {
  const numbers = parseEditorNumbers([
    { name: 'a.pk3:mapinfo/chex.txt', text: 'DoomEdNums { 3001 = ArmoredFlemoidus }' },
    { name: 'a.pk3:mapinfo/doomitems.txt', text: 'DoomEdNums\n{\n  3001 = DoomImp\n  3004 = Zombieman\n}\n' },
  ]);
  assert.deepEqual(numbers.get(3001), ['DoomImp', 'ArmoredFlemoidus']);
  const { actors } = importActors({
    sources: [{ name: 'items.txt', text: 'DoomEdNums { 3001 = DoomImp }' },
      { name: 'm.zs', text: 'class DoomImp : Actor { Default { Health 60; Monster; } States { Spawn: TROO A 10 A_Look; Loop; } }' }],
    warnings: [],
  });
  assert.equal(actors.find(actor => actor.name === 'DoomImp').doomedNum, 3001);
});

test('a project with an actor table validates and round-trips', () => {
  const project = createProject();
  project.actors = buildVanillaActors();
  validateProject(project);
  const restored = validateProject(JSON.parse(JSON.stringify(project)));
  const imp = restored.actors.find(actor => actor.name === 'DoomImp');
  assert.equal(imp.health, 60);
  assert.ok(imp.states.labels.See !== undefined);
});

test('imported actors drive enemy behaviour: see, chase and fire', () => {
  const project = createProject();
  project.actors = buildVanillaActors();
  const state = createRuntime(project);
  const player = state.player;
  const imp = state.entities.find(entity => entity.doomType === 3001) ||
    { id: 'imp', type: 'enemy', name: 'DoomImp', doomType: 3001, x: player.x + 160, y: player.y, health: 60, elevation: 0, angle: 180 };
  if (!state.entities.includes(imp)) state.entities.push(imp);
  initialiseActorEntities(project, state.entities);
  const actor = actorOf(project, imp);
  assert.equal(actor.name, 'DoomImp');
  assert.equal(imp.health, 60);
  // Wake the monster and run two seconds of tics.
  setActorState(project, imp, 'See');
  const start = { x: imp.x, y: imp.y };
  for (let tic = 0; tic < 70; tic++) actorTic(project, state, imp);
  assert.ok(Math.hypot(imp.x - start.x, imp.y - start.y) > 16, 'the imp closes distance towards the player');
  assert.ok(state.projectiles.length > 0 || imp.stateLabel === 'Missile', 'the imp attacks with its own missile state');
  assert.ok(state.sounds.length > 0, 'actor sounds are emitted');
});

test('actor deaths run the Death state and stop at its end', () => {
  const project = createProject();
  project.actors = buildVanillaActors();
  const state = createRuntime(project);
  const imp = { id: 'imp2', type: 'enemy', name: 'DoomImp', actorId: 'actor_doomimp', x: 0, y: 0, health: 60, elevation: 0 };
  state.entities.push(imp);
  imp.health = 0;
  stepActors(project, state, 1 / 35);
  assert.equal(imp.stateLabel, 'Death');
  for (let tic = 0; tic < 200; tic++) stepActors(project, state, 1 / 35);
  const runtime = actorStateOf(imp);
  const actor = actorOf(project, imp);
  const frame = actor.states.frames[runtime.index];
  assert.equal(frame.kind, 'frame');
  assert.equal(frame.duration, -1, 'a corpse rests on its permanent frame instead of looping');
  assert.equal(frame.label, 'Death');
});

test('imported weapon state machines fire with their own ammo use and cadence', () => {
  const weaponSource = `
class Shotgun : Weapon
{
  Default { Weapon.AmmoType "Shell"; Weapon.AmmoUse 1; }
  States
  {
  Ready: SHTG A 1 A_WeaponReady; Loop;
  Fire:
    SHTG A 3;
    SHTG A 7 A_FireShotgun;
    SHTG B 5;
    SHTG A 7 A_ReFire;
    Goto Ready;
  }
}`;
  const { actors } = importActors({ sources: [{ name: 'w.zs', text: weaponSource }], warnings: [] });
  const project = createProject();
  project.actors = actors;
  const shotgun = actors.find(actor => actor.name === 'Shotgun');
  assert.equal(shotgun?.flags.WEAPON, true);
  assert.equal(shotgun.weaponAmmoType, 'Shell');
  const state = createRuntime(project);
  state.playerStats.shells = 20;
  state.inventory.weapons.add('shotgun');
  state.inventory.selectedWeapon = 'shotgun';
  state.player.angle = 0;
  const enemy = { id: 'target', type: 'enemy', name: 'Target', actorId: 'actor_shotgun', x: state.player.x + 96, y: state.player.y, health: 500, elevation: 0 };
  state.entities.push(enemy);
  const keys = new Set(['Mouse0']);
  let fired = 0, shells = state.playerStats.shells;
  for (let frame = 0; frame < 120; frame++) {
    stepRuntime(project, state, 1 / 60, keys);
    if (state.playerStats.shells !== shells) { fired++; shells = state.playerStats.shells; }
  }
  // The Fire block is 22 tics long, so two seconds hold about three shots; the
  // point is that the cadence comes from the actor's own states.
  // A_ReFire restarts the Fire sequence immediately (as in Doom), so the cycle is
  // the sum of the frame durations before it: A 3 + A 7 + B 5 = 15 tics. Two
  // seconds at 35 Hz is 70 tics, which holds five shots.
  assert.equal(fired, 5, `fire cadence comes from the actor states (fired ${fired})`);
  assert.equal(state.playerStats.shells, 20 - fired, 'each shot spends the declared ammo');
  assert.ok(enemy.health < 500, 'the shotgun damages the target');
});

test('GZDoom actor definitions import with their real vanilla stats when available', { skip: !existsSync(new URL('../Projects/intoOblivion/gzdoom.pk3', import.meta.url)) }, async () => {
  const { loadGzdoomActors } = await import('../server/actor-sources.js');
  const gzdoom = loadGzdoomActors(new URL('../Projects', import.meta.url).pathname);
  assert.equal(gzdoom.available, true);
  const warnings = [];
  const { actors } = importActors({ sources: gzdoom.sources, dehacked: gzdoom.dehacked, warnings });
  const index = actorIndex(actors);
  const imp = index.byName.get('doomimp');
  assert.equal(imp.health, 60);
  assert.equal(imp.doomedNum, 3001, 'editor numbers come from DoomEdNums');
  assert.equal(imp.sounds.see, 'imp/sight');
  assert.ok(imp.states.frames.some(frame => frame.actions?.some(action => action.name === 'A_TroopAttack')));
  const shotgun = index.byName.get('shotgun');
  assert.equal(shotgun.weaponAmmoType, 'Shell');
  assert.ok(shotgun.states.frames.some(frame => frame.actions?.some(action => action.name === 'A_FireShotgun')));
  const archvile = index.byName.get('archvile');
  assert.ok(archvile.states.frames.some(frame => frame.actions?.some(action => action.name === 'A_VileChase')));
  assert.equal(warnings.some(warning => /could not be parsed/i.test(warning)), false);
});

test('LANGUAGE keyword strings resolve imported level and menu text', async () => {
  const { parseLanguage, resolveString, isKeyword } = await import('../shared/language.js');
  const strings = parseLanguage([
    '[default]',
    'TXT_MAP1 = "Maintenance Tunnels";',
    'GOTSHOTGUN = "You got the shotgun!";',
    '[enu default]',
    'TXT_MAP2 = "Reactor Core";',
  ].join('\n'));
  assert.equal(strings.TXT_MAP1, 'Maintenance Tunnels');
  assert.equal(resolveString(strings, '$TXT_MAP1'), 'Maintenance Tunnels');
  assert.equal(resolveString(strings, '$TXT_MAP2'), 'Reactor Core');
  assert.equal(resolveString(strings, '$MISSING_KEY'), 'Key', 'unknown keywords degrade to readable text');
  assert.equal(resolveString(strings, 'MAP01'), 'MAP01', 'literal text passes through');
  assert.equal(isKeyword('$TXT_MAP1'), true);
  assert.equal(isKeyword('Maintenance'), false);
});

function spriteAsset(name) {
  return { id: `asset_${name}`, name, kind: 'sprite', width: 24, height: 24, offsetX: 12, offsetY: 24,
    src: 'data:image/png;base64,iVBORw0KGgo=' };
}

function projectileProject() {
  const project = createProject();
  project.assets = ['BAL1A0', 'BAL1B0', 'BAL1C0', 'BAL1D0', 'BAL1E0'].map(spriteAsset);
  project.actors = [{
    id: 'actor_doomimpball', name: 'DoomImpBall', flags: { PROJECTILE: true, MISSILE: true, NOGRAVITY: true },
    speed: 10, damage: 3, radius: 6, height: 8,
    states: { labels: { Spawn: 0, Death: 3 }, frames: [
      { kind: 'frame', sprite: 'BAL1', letter: 'A', duration: 4, actions: [], label: 'Spawn' },
      { kind: 'frame', sprite: 'BAL1', letter: 'B', duration: 4, actions: [], label: 'Spawn' },
      { kind: 'loop', label: 'Spawn' },
      { kind: 'frame', sprite: 'BAL1', letter: 'C', duration: 6, actions: [], label: 'Death' },
      { kind: 'frame', sprite: 'BAL1', letter: 'D', duration: 6, actions: [], label: 'Death' },
      { kind: 'frame', sprite: 'BAL1', letter: 'E', duration: 6, actions: [], label: 'Death' },
      { kind: 'stop', label: 'Death' },
    ] },
  }];
  return project;
}

test('a projectile actor animates its Spawn states in flight and its Death states on impact', () => {
  const project = projectileProject();
  const clips = actorProjectileClips(project, project.actors[0]);
  assert.equal(clips.fly, 'clip_actor_actor_doomimpball_fly');
  assert.equal(clips.impact, 'clip_actor_actor_doomimpball_impact');
  const fly = project.spriteClips.find(clip => clip.id === clips.fly);
  assert.deepEqual(fly.frames, ['asset_BAL1A0', 'asset_BAL1B0']);
  assert.equal(fly.loop, true);
  assert.equal(fly.seconds, 4 / 35, 'frame duration comes from the actor at 35 tics per second');
  const impact = project.spriteClips.find(clip => clip.id === clips.impact);
  assert.deepEqual(impact.frames, ['asset_BAL1C0', 'asset_BAL1D0', 'asset_BAL1E0']);
  assert.equal(impact.loop, false);
  // Asking twice reuses the stored clip instead of appending duplicates.
  actorProjectileClips(project, project.actors[0]);
  assert.equal(project.spriteClips.filter(clip => clip.id === clips.fly).length, 1);
});

test('enemy missiles travel at the actor speed instead of crawling', () => {
  const project = projectileProject();
  const state = createRuntime(project);
  const owner = { id: 'imp', x: state.player.x + 200, y: state.player.y, height: 56 };
  spawnActorProjectile(project, state, owner, 'DoomImpBall');
  const [ball] = state.projectiles;
  assert.equal(ball.speed, 350, 'Speed 10 is 10 map units per tic, so 350 per second');
  assert.equal(ball.clipId, 'clip_actor_actor_doomimpball_fly');
  assert.equal(ball.impactClipId, 'clip_actor_actor_doomimpball_impact');
});

test('weapon actors play the firing sounds GZDoom\'s action functions start', () => {
  const project = createProject();
  project.actors = [{
    id: 'actor_pistol', name: 'Pistol', flags: { WEAPON: true }, weaponAmmoType: 'Clip', weaponAmmoUse: 1,
    states: { labels: { Ready: 0, Fire: 2 }, frames: [
      { kind: 'frame', sprite: 'PISG', letter: 'A', duration: 1, actions: [{ name: 'A_WeaponReady' }], label: 'Ready' },
      { kind: 'loop', label: 'Ready' },
      { kind: 'frame', sprite: 'PISG', letter: 'B', duration: 6, actions: [{ name: 'A_FirePistol' }], label: 'Fire' },
      { kind: 'frame', sprite: 'PISG', letter: 'C', duration: 5, actions: [{ name: 'A_ReFire' }], label: 'Fire' },
      { kind: 'stop', label: 'Fire' },
    ] },
  }];
  const state = createRuntime(project);
  state.inventory.weapons.add('pistol');
  state.inventory.selectedWeapon = 'pistol';
  state.playerStats.bullets = 20;
  const heard = new Set();
  for (let frame = 0; frame < 40; frame++) {
    stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
    for (const sound of state.sounds) heard.add(sound.name);
  }
  assert.ok(heard.has('weapons/pistol'), `the pistol has to be audible, heard ${[...heard].join(', ') || 'nothing'}`);
  assert.ok(state.playerStats.bullets < 20, 'the pistol spends bullets');
});

test('vanilla weapon sound aliases resolve to real lumps', async () => {
  const { soundTable, soundCandidates, VANILLA_SOUNDS } = await import('../shared/sndinfo.js');
  const aliases = soundTable(VANILLA_SOUNDS);
  const expected = { 'weapons/pistol': 'DSPISTOL', 'weapons/shotgf': 'DSSHOTGN', 'weapons/sshotf': 'DSDSHTGN',
    'weapons/chngun': 'DSPISTOL', 'weapons/rocklf': 'DSRLAUNC', 'weapons/plasmaf': 'DSPLASMA',
    'weapons/bfgf': 'DSBFG', 'weapons/sawfull': 'DSSAWFUL', '*fist': 'DSPUNCH' };
  for (const [name, lump] of Object.entries(expected)) {
    assert.ok(soundCandidates(name.toUpperCase(), aliases).includes(lump), `${name} must map to ${lump}`);
  }
});

test('unsupported action functions are reported with the actors that call them', () => {
  const project = createProject();
  project.actors = [
    { id: 'actor_imp', name: 'TestImp', flags: { MONSTER: true }, health: 60, speed: 8, radius: 20, height: 56,
      states: { labels: { Spawn: 0, See: 1 }, frames: [
        { kind: 'frame', sprite: 'TROO', letter: 'A', duration: 10, actions: [{ name: 'A_Look', args: [] }], label: 'Spawn' },
        { kind: 'frame', sprite: 'TROO', letter: 'B', duration: 3, actions: [{ name: 'A_CustomComboAttack', args: [] }], label: 'See' },
        { kind: 'loop', label: 'See' },
      ] } },
    { id: 'actor_pistol', name: 'Pistol', flags: { WEAPON: true }, weaponAmmoType: 'Clip',
      states: { labels: { Ready: 0, Fire: 1 }, frames: [
        { kind: 'frame', sprite: 'PISG', letter: 'A', duration: 1, actions: [{ name: 'A_WeaponReady', args: [] }], label: 'Ready' },
        { kind: 'frame', sprite: 'PISG', letter: 'B', duration: 6, actions: [{ name: 'A_FirePistol', args: [] }, { name: 'A_JumpIf', args: [1, 2] }], label: 'Fire' },
      ] } },
    // Never placed in the map and never spawned, so its gaps are not this level's problem.
    { id: 'actor_heretic', name: 'UnusedWizard', flags: { MONSTER: true },
      states: { labels: { Spawn: 0 }, frames: [
        { kind: 'frame', sprite: 'WIZR', letter: 'A', duration: 4, actions: [{ name: 'A_FireGoldWandPL1', args: [] }], label: 'Spawn' },
      ] } },
  ];
  project.map.entities.push({ id: 'imp1', type: 'enemy', x: 64, y: 64, angle: 0, elevation: 0, health: 60, actorId: 'actor_imp' });
  const gaps = unsupportedActorActions(project);
  const names = gaps.map(gap => gap.name);
  assert.deepEqual(names.sort(), ['A_CustomComboAttack', 'A_JumpIf']);
  const jump = gaps.find(gap => gap.name === 'A_JumpIf');
  assert.deepEqual(jump.actors, ['Pistol'], 'the weapon path ignores general actions, so the pistol is named');
  assert.equal(jump.calls, 1);
  // A monster may jump: the shared action table runs it there, while a weapon may not.
  assert.equal(actionSupported('A_JumpIf', false), true);
  assert.equal(actionSupported('A_JumpIf', true), false);
  assert.equal(actionSupported('A_FirePistol', true), true);
  assert.equal(actionSupported('A_FirePistol', false), false, 'a monster cannot fire a weapon action');
  assert.equal(actionSupported('A_CustomComboAttack', false), false);
});

test('the declared weapon action set matches the weapon state machine', () => {
  const source = readFileSync(new URL('../shared/actor-runtime.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function runWeaponAction'), source.indexOf('function teleportWeapon'));
  const implemented = new Set([...body.matchAll(/case '([^']+)'/g)].map(match => match[1]));
  assert.deepEqual([...WEAPON_ACTION_NAMES].sort(), [...implemented].sort(),
    'WEAPON_ACTION_NAMES has to list exactly the actions the weapon machine handles');
});

test('MCP actor tools answer with their own payload, including the action gaps', async () => {
  const { applyTool } = await import('../server/tools.js');
  const project = createProject();
  project.actors = [{ id: 'actor_pistol', name: 'Pistol', flags: { WEAPON: true }, weaponAmmoType: 'Clip',
    states: { labels: { Ready: 0 }, frames: [
      { kind: 'frame', sprite: 'PISG', letter: 'A', duration: 1, actions: [{ name: 'A_WeaponReady' }, { name: 'A_JumpIf', args: [1, 2] }], label: 'Ready' },
    ] } }];
  project.map.entities.push({ id: 'imp1', type: 'enemy', x: 64, y: 64, angle: 0, elevation: 0, health: 60, doomType: 3001 });
  const gaps = applyTool(project, 'actor_unsupported', {});
  assert.equal(gaps.changed, false);
  assert.equal(gaps.project, undefined, 'read-only tools do not hand back the project');
  assert.equal(gaps.report.actions[0].name, 'A_JumpIf');
  assert.equal(gaps.report.total, gaps.report.actions.length);
  const listed = applyTool(project, 'actor_list', {});
  assert.equal(listed.project, undefined, 'actor_list answers with its report, not the project');
  assert.equal(listed.report.actors[0].name, 'Pistol');
  assert.equal(applyTool(project, 'actor_get', { name: 'pistol' }).report.actor.name, 'Pistol');
});

test('the Actors panel notes the action functions the runtime cannot run', () => {
  const node = () => ({ hidden: false, textContent: '', children: [], value: '', dataset: {}, tabIndex: -1,
    classList: { toggle() {} }, addEventListener() {}, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; } });
  const nodes = { list: node(), summary: node(), gaps: node(), search: node(), filter: node(), form: node(),
    title: node(), fields: node(), states: node() };
  globalThis.document = { createElement: () => node(), createTextNode: () => node() };
  try {
    const actor = { name: 'Pistol', doomedNum: null, health: 0, flags: { WEAPON: true }, states: { labels: {}, frames: [] } };
    const panel = createActorsPanel(nodes, { actors: () => [actor], edit: () => {},
      unsupported: () => [{ name: 'A_JumpIf', calls: 4, actors: ['Pistol'] }] });
    panel.render();
    assert.equal(nodes.gaps.hidden, false);
    assert.match(nodes.gaps.textContent, /1 action function used by this level's actors/);
    assert.match(nodes.gaps.textContent, /A_JumpIf \(Pistol\)/);
    const clean = createActorsPanel(nodes, { actors: () => [actor], edit: () => {}, unsupported: () => [] });
    clean.render();
    assert.equal(nodes.gaps.hidden, true);
    assert.equal(nodes.gaps.textContent, '');
  } finally { delete globalThis.document; }
});

test('actor parents resolve regardless of case, so inherited stats and states survive', () => {
  const text = [
    'ACTOR FURFireBall', '{', ' Speed 10', ' Health 20', ' Projectile', ' States', ' {', ' Spawn:',
    '  FBAL A 3', '  Loop', ' }', '}',
    'ACTOR FURFireball2 : FURFireball', '{', ' Translation "168:185=208:223"', ' States', ' {', ' Spawn:',
    '  FBAL A 3', '  Loop', ' }', '}',
  ].join('\n');
  const resolved = resolveActorInheritance(parseDecorate(text).actors);
  const child = resolved.actors.get('FURFireball2');
  assert.ok(child, 'the child actor exists');
  assert.equal(child.parent, 'FURFireball');
  assert.equal(child.flags.Projectile, true, 'a differently cased parent still contributes its flags');
  assert.deepEqual([...child.labels.keys()], ['Spawn'], 'and its state labels');
});

function actorSpriteProject() {
  const project = createProject();
  project.assets = ['FBALA0', 'FBALB0', 'FBALC0', 'FBALD0', 'FSPRA0', 'FSPRB0'].map(spriteAsset);
  project.actors = [{
    id: 'actor_fireball', name: 'Fireball', flags: { PROJECTILE: true, MISSILE: true }, speed: 10, damage: 4,
    states: { labels: { Spawn: 0, Death: 2 }, frames: [
      { kind: 'frame', sprite: 'FBAL', letter: 'A', duration: 3, actions: [], label: 'Spawn' },
      { kind: 'frame', sprite: 'FBAL', letter: 'B', duration: 3, actions: [], label: 'Spawn' },
      { kind: 'loop', label: 'Spawn' },
      { kind: 'frame', sprite: 'FBAL', letter: 'C', duration: 6, actions: [], label: 'Death' },
      { kind: 'frame', sprite: 'FBAL', letter: 'D', duration: 6, actions: [], label: 'Death' },
      { kind: 'stop', label: 'Death' },
    ] },
  }, {
    id: 'actor_imp', name: 'TestImp', flags: { MONSTER: true }, doomedNum: 9999, health: 60,
    states: { labels: { Spawn: 0, See: 1, Missile: 3, Death: 5 }, frames: [
      { kind: 'frame', sprite: 'FSPR', letter: 'A', duration: 10, actions: [], label: 'Spawn' },
      { kind: 'frame', sprite: 'FSPR', letter: 'B', duration: 4, actions: [], label: 'See' },
      { kind: 'loop', label: 'See' },
      { kind: 'frame', sprite: 'FSPR', letter: 'A', duration: 8, actions: [], label: 'Missile' },
      { kind: 'goto', label: 'Missile' },
      { kind: 'frame', sprite: 'FSPR', letter: 'B', duration: 6, actions: [], label: 'Death' },
      { kind: 'stop', label: 'Death' },
    ] },
  }];
  return project;
}

test('actor state artwork is imported for spawned actors and drives their animation', () => {
  const project = actorSpriteProject();
  project.map.entities.push({ id: 'imp1', type: 'enemy', doomType: 9999, x: 0, y: 0, angle: 0, health: 60 });
  const requested = [];
  const stub = { spriteFrame: (prefix, letter) => {
    requested.push(`${prefix}${letter}`);
    return project.assets.find(asset => asset.name === `${prefix}${letter}0`)?.id || null;
  } };
  const warnings = [];
  importActorSprites(project, stub, warnings);
  assert.deepEqual([...new Set(requested)].sort(), ['FBALA', 'FBALB', 'FBALC', 'FBALD', 'FSPRA', 'FSPRB'],
    'the projectile is included even though nothing places it');
  importActorSprites(project, { spriteFrame: () => null }, warnings);
  assert.ok(warnings.some(warning => /Actor state artwork missing/.test(warning)));

  const applied = installActorSpriteStates(project);
  assert.equal(applied, 1);
  const imp = project.map.entities.find(entity => entity.id === 'imp1');
  const states = imp.spriteStates;
  assert.deepEqual(Object.keys(states).sort(), ['attack', 'death', 'stand', 'walk']);
  const frames = id => project.spriteClips.find(clip => clip.id === id).frames;
  assert.deepEqual(frames(states.stand), ['asset_FSPRA0'], 'the stand clip is the actor Spawn frame');
  assert.deepEqual(frames(states.walk), ['asset_FSPRB0']);
  assert.deepEqual(frames(states.attack), ['asset_FSPRA0']);
  assert.deepEqual(frames(states.death), ['asset_FSPRB0']);
  assert.equal(imp.spriteAsset, 'asset_FSPRA0', 'the editor sprite follows the actor');
  assert.equal(project.spriteClips.find(clip => clip.id === states.walk).loop, true);
  assert.equal(project.spriteClips.find(clip => clip.id === states.death).loop, false);
});

test('a mod thing is mapped through its DECORATE class, not left as a grey placeholder', () => {
  // Lullaby places 3,214 things under its own editor numbers. Without reading the actor
  // table when the map is mapped, every one of them was an unnamed placeholder with no
  // artwork, and the invisible ones (dynamic lights, sector actions) drew grey boxes.
  const wad = (lumps) => {
    const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
    const buffer = Buffer.alloc(directory + lumps.length * 16);
    buffer.write('PWAD'); buffer.writeUInt32LE(lumps.length, 4); buffer.writeUInt32LE(directory, 8);
    let offset = 12;
    lumps.forEach(([name, data], index) => {
      data.copy(buffer, offset);
      const entry = directory + index * 16;
      buffer.writeUInt32LE(offset, entry); buffer.writeUInt32LE(data.length, entry + 4); buffer.write(name, entry + 8, 8);
      offset += data.length;
    });
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  };
  const vertices = Buffer.alloc(16);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
  });
  const lines = Buffer.alloc(56);
  for (let i = 0; i < 4; i++) {
    lines.writeUInt16LE(i, i * 14); lines.writeUInt16LE((i + 1) % 4, i * 14 + 2);
    lines.writeUInt16LE(65535, i * 14 + 12);
  }
  const sector = Buffer.alloc(26); sector.writeInt16LE(128, 2);
  const things = Buffer.alloc(10 * 4);
  // player start, a custom monster, a custom decoration, a GZDoom dynamic light
  [[1, 0], [10003, 100], [10002, 200], [9500, 300]].forEach(([type, x], index) => {
    things.writeUInt16LE(x, index * 10); things.writeUInt16LE(0, index * 10 + 2);
    things.writeUInt16LE(type, index * 10 + 6); things.writeUInt16LE(7, index * 10 + 8);
  });
  const decorate = Buffer.from([
    'actor ModImp 10003', '{', '  Health 80', '  Radius 20', '  Height 56', '  Monster',
    '  States', '  {', '  Spawn:', '    POSS A 4 A_Look', '    Loop', '  See:',
    '    POSS A 4 A_Chase', '    Loop', '  }', '}',
    'actor ModCandle 10002', '{', '  Radius 16', '  Height 32', '  States', '  {',
    '  Spawn:', '    POSS B 4', '    Loop', '  }', '}',
    'actor ModLight 9500 : DynamicLight', '{', '  Radius 16', '  Height 16', '  +INVISIBLE', '}',
  ].join('\n'), 'latin1');
  const read = readWad(wad([['DECORATE', decorate], ['MAP01', Buffer.alloc(0)], ['THINGS', things],
    ['LINEDEFS', lines], ['SIDEDEFS', Buffer.alloc(30)], ['VERTEXES', vertices], ['SECTORS', sector]]));
  const { project, warnings } = importWadMap(read, 'MAP01');
  const byDoomType = new Map(project.map.entities.map(entity => [entity.doomType, entity]));
  const monster = byDoomType.get(10003);
  assert.equal(monster.type, 'enemy');
  assert.equal(monster.name, 'ModImp');
  assert.equal(monster.health, 80);
  assert.equal(monster.actorId, 'actor_modimp');
  assert.equal(monster.actorName, 'ModImp');
  const candle = byDoomType.get(10002);
  assert.equal(candle.type, 'decoration', 'a decoration with no artwork of its own is still placed');
  assert.equal(candle.name, 'ModCandle');
  assert.equal(byDoomType.has(9500), false, 'an invisible dynamic light is not a grey box on the map');
  assert.match(warnings.join('\n'), /1 marker things that draw nothing/);
});
