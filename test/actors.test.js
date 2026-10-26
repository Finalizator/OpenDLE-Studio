import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { parseDecorate, resolveActorInheritance, compileActorStates, frameBodyActions } from '../shared/decorate.js';
import { parseZScript, parseActorDefinitions } from '../shared/zscript.js';
import { parseDehacked, dehackedChanges, mergeDehackedPatches, thingName } from '../shared/dehacked.js';
import { buildVanillaActors, importActors, applyDehacked, actorIndex, parseEditorNumbers } from '../shared/actors.js';
import { actorOf, actorStateOf, actorTic, setActorState, labelIndex, initialiseActorEntities, stepActors } from '../shared/actor-runtime.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';

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
