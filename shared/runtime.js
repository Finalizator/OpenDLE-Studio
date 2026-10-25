import { eventConditions, resolveEntityId } from './project.js';
import { sectorAt, sectorGeometry } from './sectors.js';
import { pairKey } from './physics.js';
import { compareValues, engineCommand } from './engine-script.js';
import { isExpression, evaluateExpression, expressionContext, scalar } from './expressions.js';
import { createHUDState, advanceHUD, playHUDAnimation, validateHUDProperty } from './hud.js';
import { initialPlayerStats, initialInventory, addAmmo, recordDamage, playerFeedback, ammoMaximum } from './player-state.js';
import { damagePlayer, canSeePlayer, canHearPlayer, moveEnemy, launchProjectile, advanceProjectiles, soundEvent, randomDamage, geometryDistance, entityDistance, playerReachesEntity, enemyHitscan, enemyAttackChance } from './combat.js';
import { useWall, crossedWalls, moveSector, advanceSectors } from './world-motion.js';
import { clipFrame, setSpriteState } from './sprite-animation.js';
import { gameSettings, changeSetting } from './game-settings.js';

export function distanceToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}

export function wallSegments(project) {
  const vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  return project.map.walls.map(wall => ({ ...wall, start: vertices.get(wall.a), end: vertices.get(wall.b) }));
}

export function castRay(x, y, dx, dy, walls) {
  let nearest = null;
  for (const wall of walls) {
    if (!wall.solid) continue;
    const sx = wall.end.x - wall.start.x, sy = wall.end.y - wall.start.y;
    const cross = dx * sy - dy * sx;
    if (Math.abs(cross) < 1e-9) continue;
    const qx = wall.start.x - x, qy = wall.start.y - y;
    const distance = (qx * sy - qy * sx) / cross;
    const u = (qx * dy - qy * dx) / cross;
    if (distance > 0.001 && u >= 0 && u <= 1 && (!nearest || distance < nearest.distance)) {
      nearest = { distance, wall };
    }
  }
  return nearest;
}

export function createRuntime(project, { settings = {}, screen = 'playing', gameMode = false } = {}) {
  const spawn = project.map.entities.find(entity => entity.type === 'player');
  const userSettings = gameSettings(settings);
  const skillBit = userSettings.difficulty <= 2 ? 1 : userSettings.difficulty === 3 ? 2 : 4;
  return {
    settings: userSettings, settingsRevision: 0, gameScreen: screen, gameMode,
    hasGame: screen === 'playing', bindingKey: null,
    menuRequests: [], interfaceStarted: false,
    player: { x: spawn.x, y: spawn.y, angle: spawn.angle * Math.PI / 180, pitch: 0 },
    playerStats: initialPlayerStats(),
    inventory: initialInventory(),
    face: 'idle',
    feedback: { damage: null, weaponPickupTime: -Infinity, attackTime: 0, health: 100 },
    scriptedInput: project.playerControl === 'events',
    input: { mouseX: 0, mouseY: 0, forward: 0, strafe: 0, jump: false },
    time: 0,
    timers: new Map(),
    groups: new Map((project.eventGroups || []).map(group => [group.id, group.enabled])),
    hud: Boolean(project.hud),
    hudState: createHUDState(project),
    randomSeed: 1,
    sounds: [],
    soundOverflow: 0,
    projectiles: [],
    projectileSequence: 0,
    worldRevision: 0,
    shaderEnabled: true,
    shaderUniforms: new Map(Object.entries(project.shaders?.find(shader => shader.id === project.environment.shaderId)?.uniforms || {})),
    sectorMotions: new Map(),
    spriteAnimations: new Map(),
    weaponAnimations: new Map(),
    entitySamples: new Map(),
    enemyMoves: new Map(),
    impacts: [],
    worldTriggers: { use: null, cross: new Set(), shoot: new Set() },
    variables: { ...project.variables },
    entities: structuredClone(project.map.entities).filter(entity => !entity.skillMask || (entity.skillMask & skillBit))
      .map(entity => ({ ...entity, variables: { ...(entity.variables || {}) } })),
    fired: new Set(),
    started: false,
    message: '',
    messageTime: 0,
    walls: wallSegments(project),
    sectors: sectorGeometry(project),
    animations: new Map(project.map.entities.filter(entity => entity.animation?.autoPlay).map(entity => [entity.id, { ...entity.animation, playing: true, revision: 0 }])),
    animationFinished: new Set(),
    physics: null,
  };
}

export function lookPlayer(state, movementX, movementY) {
  if (!Number.isFinite(movementX) || !Number.isFinite(movementY)) throw new Error('Mouse movement must be finite');
  if (state.hudState.cursor) return;
  movementX *= state.settings.sensitivity;
  movementY *= state.settings.sensitivity * (state.settings.invertY ? -1 : 1);
  if (state.scriptedInput) {
    state.input.mouseX += movementX; state.input.mouseY += movementY; return;
  }
  state.player.angle += movementX * .002;
  const limit = 85 * Math.PI / 180;
  state.player.pitch = Math.max(-limit, Math.min(limit, state.player.pitch - movementY * .002));
}

export function stepRuntime(project, state, dt, keys, pressed = new Set()) {
  dt = Math.max(0, Math.min(0.05, dt));
  const player = state.player, hud = state.hudState;
  state.sounds.length = 0;
  runRules('interface');
  state.interfaceStarted = true;
  state.hudState.cursor = state.gameScreen !== 'playing' || state.hudState.cursor;
  if (state.gameScreen !== 'playing') {
    state.hudState.clicked.clear(); return;
  }
  state.time += dt;
  state.impacts = state.impacts.filter(effect => !clipFrame(project, effect.clipId, state.time - effect.start)?.finished);
  state.input.forward = 0; state.input.strafe = 0; state.input.jump = false;
  if (state.playerStats.health < state.feedback.health) recordDamage(state, state.feedback.health - state.playerStats.health);
  state.feedback.attackTime = !hud.cursor && keys.has('Mouse0') ? state.feedback.attackTime + dt : 0;
  advanceHUD(project, hud, dt);
  advanceSectors(state, dt);
  state.worldTriggers.use = !hud.cursor && state.playerStats.health > 0 && pressed.has('KeyE') ? useWall(state) : null;
  state.worldTriggers.shoot.clear();
  runRules('beforePhysics');
  if (!state.scriptedInput && !hud.cursor) player.angle += ((keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0)) * dt * 2.2;
  const forward = hud.cursor ? 0 : state.scriptedInput ? state.input.forward : ((keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)) * 160;
  const strafe = hud.cursor ? 0 : state.scriptedInput ? state.input.strafe : ((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)) * 160;
  const scale = dt / (state.scriptedInput ? 1 : Math.max(1, Math.hypot(forward, strafe) / 160));
  const dx = (Math.cos(player.angle) * forward - Math.sin(player.angle) * strafe) * scale;
  const dy = (Math.sin(player.angle) * forward + Math.cos(player.angle) * strafe) * scale;
  const runMultiplier = state.settings.alwaysRun !== keys.has('ShiftLeft') ? 2 : 1;
  const currentSector = sectorAt(state.sectors, player.x, player.y);
  const sectors = new Map(state.sectors.map(sector => [sector.id, sector]));
  const canMove = (x, y) => {
    const destination = sectorAt(state.sectors, x, y);
    if (state.sectors.length && (!destination || destination.ceilingHeight - destination.floorHeight < 56 ||
      destination.floorHeight - (currentSector?.floorHeight ?? destination.floorHeight) > 24)) return false;
    return !state.walls.some(wall => {
      if (distanceToSegment(x, y, wall.start, wall.end) >= 12) return false;
      if (wall.solid) return true;
      const front = sectors.get(wall.right?.sectorId), back = sectors.get(wall.left?.sectorId);
      if (!front || !back) return false;
      const floor = Math.max(front.floorHeight, back.floorHeight), ceiling = Math.min(front.ceilingHeight, back.ceilingHeight);
      return ceiling - floor < 56 || floor - (currentSector?.floorHeight ?? floor) > 24;
    });
  };
  const previousPosition = { x: player.x, y: player.y };
  state.physics?.syncWorld();
  if (state.physics) state.physics.step(dt, { x: dt ? dx * runMultiplier / dt : 0, y: dt ? dy * runMultiplier / dt : 0,
    jump: state.settings.jumping && !hud.cursor && state.playerStats.health > 0 && (state.scriptedInput ? state.input.jump : pressed.has('Space')) });
  else {
    if (canMove(player.x + dx * runMultiplier, player.y)) player.x += dx * runMultiplier;
    if (canMove(player.x, player.y + dy * runMultiplier)) player.y += dy * runMultiplier;
  }
  state.worldTriggers.cross = crossedWalls(state, previousPosition);
  state.messageTime = Math.max(0, state.messageTime - dt);
  runRules('afterPhysics');
  advanceProjectiles(state, dt);
  state.input.mouseX = 0; state.input.mouseY = 0;
  state.animationFinished.clear();
  state.feedback.health = state.playerStats.health;
  hud.clicked.clear();
  state.started = true;
  function runRules(phase) {
    const children = new Map();
    for (const event of project.events) {
      if (!children.has(event.parentId)) children.set(event.parentId, []);
      children.get(event.parentId).push(event);
    }
    function visit(source, ownerId) {
      if (source.groupId && !state.groups.get(source.groupId)) return;
      const instances = ownerId ? [{ ...source, ownerId }] : source.forEachType
        ? state.entities.filter(entity => entity.type === source.forEachType).map(entity => ({ ...source, ownerId: entity.id })) : [source];
      for (const event of instances) {
        if (!runEvent(event, Boolean(source.forEachType), phase)) continue;
        for (const child of children.get(source.id) || []) visit(child, event.ownerId);
      }
    }
    for (const source of project.events) {
      if (source.parentId) continue;
      const sheet = project.eventSheets?.find(sheet => sheet.id === source.sheetId);
      if (sheet?.enabled === false || (sheet?.phase || 'afterPhysics') !== phase) continue;
      visit(source);
    }
  }
  function runEvent(event, perInstance, phase) {
    const eventKey = perInstance ? `${event.id}:${event.ownerId}` : event.id;
    if (!event.enabled || (event.once && state.fired.has(eventKey))) return;
    if (event.ownerId && !state.entities.some(entity => entity.id === event.ownerId)) return;
    const findTarget = id => state.entities.find(entity => entity.id === resolveEntityId(event, id));
    const context = expressionContext(project, event, state, dt);
    const resolveCommand = command => {
      if (!Object.values(command).some(isExpression)) return command;
      const resolved = { ...command };
      for (const [key, value] of Object.entries(command)) if (isExpression(value)) {
        try {
          const result = evaluateExpression(value, context);
          const field = engineCommand(command.type)?.fields.find(field => field.name === key);
          if (field?.kind === 'number') {
            if (typeof result !== 'number' || result < field.min || result > field.max || ['pellets', 'diceSides', 'doomType'].includes(key) && !Number.isInteger(result)) throw new Error(`Invalid numeric result for ${key}`);
          } else if (field?.kind === 'string' || key === 'message') {
            if (typeof result !== 'string' || result.length > (key === 'message' ? 500 : 2000)) throw new Error(`Invalid text result for ${key}`);
          } else if (!field && !['setVariable', 'addVariable'].includes(command.type)) {
            const physics = ['applyImpulse', 'applyForce', 'setVelocity'].includes(command.type);
            const min = key === 'distance' ? 1 : key === 'speed' ? .01 : key === 'angle' ? -3600 : !physics && key === 'z' ? -32768 : physics ? -100000 : -65536;
            const max = key === 'distance' ? 4096 : key === 'speed' ? 10 : key === 'angle' ? 3600 : !physics && key === 'z' ? 32767 : physics ? 100000 : 65536;
            if (typeof result !== 'number' || result < min || result > max) throw new Error(`Invalid numeric result for ${key}`);
          }
          if (command.type === 'setPlayerStat' && command.stat === 'armorDivisor' && result < 1) throw new Error('Armor divisor must be at least 1');
          if (command.type === 'setHUDProperty' && key === 'value') validateHUDProperty(command.property, result,
            project.hud.elements.find(e => e.id === command.elementId), (ok, message) => { if (!ok) throw new Error(message); });
          resolved[key] = result;
        } catch (error) { throw new Error(`Event "${event.name || event.id}", ${command.type}.${key}: ${error.message}`, { cause: error }); }
      }
      return resolved;
    };
    function assignVariable(record, name, value, add) {
      if (!Object.hasOwn(record, name)) throw new Error(`Event "${event.name || event.id}" references missing variable "${name}"`);
      if (typeof value !== typeof record[name] || add && typeof value !== 'number') throw new Error(`Event "${event.name || event.id}": variable "${name}" type mismatch`);
      record[name] = scalar(add ? record[name] + value : value);
    }
    function compare(a, operator, b) {
      if (typeof a !== typeof b || !['number', 'string', 'boolean'].includes(typeof a) || typeof a === 'boolean' && !['=', '!='].includes(operator)) throw new Error(`Event "${event.name || event.id}": incompatible comparison types`);
      return compareValues(a, operator, b);
    }
    const statChanges = new Map();
    function matchCondition(condition) {
      condition = resolveCommand(condition);
      if (condition.type === 'gameScreen') return state.gameScreen === condition.screen;
      if (condition.type === 'shaderEnabled') return state.shaderEnabled;
      if (condition.type === 'expressionCompare') return compare(condition.left, condition.operator, condition.right);
      if (condition.type === 'objectVariableCompare') {
        const target = findTarget(condition.entityId);
        return target && compare(target.variables[condition.variable], condition.operator, condition.value);
      }
      if (condition.type === 'playerReachesEntity') {
        const entity = findTarget(condition.entityId);
        return entity && playerReachesEntity(state, entity, condition.distance, condition.height, condition.below);
      }
      if (condition.type === 'enemyAlert') return state.time < (state.timers.get(`${resolveEntityId(event, condition.entityId)}:alert`) || 0);
      if (condition.type === 'enemyHearsPlayer') {
        const entity = findTarget(condition.entityId);
        return entity && canHearPlayer(state, entity);
      }
      if (condition.type === 'spriteState') return state.spriteAnimations.get(resolveEntityId(event, condition.entityId))?.name === condition.state;
      if (condition.type === 'entityDamaged') {
        const entity = findTarget(condition.entityId);
        if (!entity) return false;
        const key = `${eventKey}:${entity.id}`, old = state.entitySamples.get(key) ?? entity.health;
        state.entitySamples.set(key, entity.health);
        return entity.health < old;
      }
      if (condition.type === 'wallActivated') return condition.mode === 'use' ? state.worldTriggers.use === condition.wallId : state.worldTriggers[condition.mode].has(condition.wallId);
      if (condition.type === 'sectorMoving') return state.sectorMotions.has(`${condition.sectorId}:${condition.surface}`);
      if (condition.type === 'enemySeesPlayer') {
        const entity = findTarget(condition.entityId);
        const alerted = entity && state.time < (state.timers.get(`${entity.id}:alert`) || 0);
        return entity && canSeePlayer(state, entity, condition.range, alerted ? 360 : condition.fov ?? 360);
      }
      if (condition.type === 'enemyAttackChance') {
        const entity = findTarget(condition.entityId);
        return entity && enemyAttackChance(state, entity);
      }
      if (condition.type === 'weaponOwned') return state.inventory.weapons.has(condition.weapon);
      if (condition.type === 'weaponSelected') return state.inventory.selectedWeapon === condition.weapon;
      if (condition.type === 'keyOwned') return state.inventory.keys.has(condition.key);
      if (condition.type === 'backpackOwned') return state.inventory.backpack;
      if (condition.type === 'ammoBelowCapacity') return state.playerStats[condition.ammo] < state.playerStats[ammoMaximum(condition.ammo)];
      if (condition.type === 'playerFeedback') return compareValues(playerFeedback(state, condition.signal), condition.operator, condition.value);
      if (condition.type === 'playerFace') return state.face === condition.expression;
      if (condition.type === 'entityDoomType') {
        const entity = findTarget(condition.entityId);
        return entity && (entity.doomType ?? 0) === condition.doomType;
      }
      if (condition.type === 'hudAnimationPlaying') return hud.playing.has(condition.animationId);
      if (condition.type === 'hudClicked') return hud.clicked.has(condition.elementId);
      if (condition.type === 'hudAnimationFinished') return hud.finished.has(condition.animationId);
      if (condition.type === 'hudStatChanged') {
        const key = `${eventKey}:${condition.stat}:${condition.direction}`;
        if (!statChanges.has(key)) {
          statChanges.set(key, state.playerStats[condition.stat] - (hud.statSamples.get(key) ?? hud.initialStats[condition.stat]));
          hud.statSamples.set(key, state.playerStats[condition.stat]);
        }
        const delta = statChanges.get(key);
        return condition.direction === 'decreased' ? delta < 0 : condition.direction === 'increased' ? delta > 0 : delta !== 0;
      }
      if (condition.type === 'onStart') return phase === 'interface' ? !state.interfaceStarted : !state.started;
      if (condition.type === 'always') return true;
      if (condition.type === 'keyPressed') return (condition.key === 'Tab' || !hud.cursor) && pressed.has(condition.key);
      if (condition.type === 'keyHeld') return !hud.cursor && keys.has(condition.key);
      if (condition.type === 'mouseMoved') return !hud.cursor && (state.input.mouseX !== 0 || state.input.mouseY !== 0);
      if (condition.type === 'playerStat') return compareValues(state.playerStats[condition.stat], condition.operator, condition.value);
      if (condition.type === 'entityHealth') {
        const target = findTarget(condition.entityId);
        return target && compareValues(target.health ?? 20, condition.operator, condition.value);
      }
      if (condition.type === 'entityHasHealth') return findTarget(condition.entityId)?.health !== undefined;
      if (condition.type === 'variableCompare') return compare(state.variables[condition.variable], condition.operator, condition.value);
      if (condition.type === 'timerReady') return state.time + 1e-9 >= (state.timers.get(`${event.ownerId || '$scene'}:${condition.timer}`) || 0);
      if (condition.type === 'timerExists') return state.timers.has(`${event.ownerId || '$scene'}:${condition.timer}`);
      if (condition.type === 'groupActive') return state.groups.get(condition.groupId);
      if (condition.type === 'playerGrounded') {
        if (!state.physics) throw new Error('Grounded conditions require an initialized Rapier world');
        return state.physics.grounded;
      }
      if (condition.type === 'animationFinished') return state.animationFinished.has(resolveEntityId(event, condition.entityId));
      if (['collisionStarted', 'collisionEnded', 'isTouching'].includes(condition.type)) {
        if (!state.physics) throw new Error('Collision conditions require an initialized Rapier world');
        const set = condition.type === 'collisionStarted' ? state.physics.started : condition.type === 'collisionEnded' ? state.physics.ended : state.physics.contacts;
        return set.has(pairKey(resolveEntityId(event, condition.entityId), resolveEntityId(event, condition.otherId)));
      }
      const entity = findTarget(condition.entityId);
      const position = entity?.type === 'player' ? player : entity;
      return position && Math.hypot(position.x - player.x, position.y - player.y) <= condition.distance;
    }
    const matchesCondition = condition => condition.inverted ? !matchCondition(condition) : Boolean(matchCondition(condition));
    const matches = event.conditionMode === 'or' ? eventConditions(event).some(matchesCondition) : eventConditions(event).every(matchesCondition);
    if (!matches) return;
    state.fired.add(eventKey);
    for (const sourceAction of event.actions) {
      const action = resolveCommand(sourceAction);
      switch (action.type) {
        case 'setGameScreen': {
          let screen = action.screen;
          if (screen === 'return') screen = state.hasGame ? 'pause' : 'title';
          if (screen !== 'playing') state.bindingKey = null;
          if (screen === 'title') state.hasGame = false;
          state.gameScreen = screen; hud.cursor = screen !== 'playing';
          break;
        }
        case 'startGame': state.menuRequests.push('start'); break;
        case 'quitGame': state.menuRequests.push('quit'); break;
        case 'requestFullscreen': state.menuRequests.push('fullscreen'); break;
        case 'captureGameBinding': state.bindingKey = action.key; break;
        case 'setGameSetting': changeSetting(state, action.setting, action.value); break;
        case 'adjustGameSetting': changeSetting(state, action.setting, action.amount, true); break;
        case 'toggleGameSetting': changeSetting(state, action.setting, !state.settings[action.setting]); break;
        case 'resetGameSettings': state.settings = gameSettings({ jumping: state.settings.jumping }); state.settingsRevision++; break;
        case 'setShaderEnabled': state.shaderEnabled = action.enabled === 'yes'; break;
        case 'setShaderUniform': state.shaderUniforms.set(action.uniform, action.value); break;
        case 'setObjectVariable': case 'addObjectVariable': {
          const entity = findTarget(action.entityId);
          if (entity) assignVariable(entity.variables, action.variable, action.value, action.type === 'addObjectVariable');
          break;
        }
        case 'setSpriteState': {
          const entity = findTarget(action.entityId);
          if (entity) setSpriteState(project, state, entity, action.state, action.restart === 'yes');
          break;
        }
        case 'playWeaponClip': state.weaponAnimations.set(action.weapon, { clipId: action.clipId, start: state.time }); break;
        case 'moveSector': moveSector(state, action); break;
        case 'setWeaponOwned': {
          if (action.owned === 'yes') {
            if (!state.inventory.weapons.has(action.weapon)) state.feedback.weaponPickupTime = state.time;
            state.inventory.weapons.add(action.weapon);
          } else {
            if (action.weapon === state.inventory.selectedWeapon) throw new Error('Select another owned weapon before removing the current weapon');
            state.inventory.weapons.delete(action.weapon);
          }
          break;
        }
        case 'selectWeapon':
          if (!state.inventory.weapons.has(action.weapon)) throw new Error(`Cannot select unowned weapon: ${action.weapon}`);
          state.inventory.selectedWeapon = action.weapon; break;
        case 'setKeyOwned':
          if (action.owned === 'yes') state.inventory.keys.add(action.key); else state.inventory.keys.delete(action.key);
          break;
        case 'addAmmo': addAmmo(state, action.ammo, action.amount > 0 && [1, 5].includes(state.settings.difficulty) ? action.amount * 2 : action.amount); break;
        case 'giveBackpack':
          if (!state.inventory.backpack) {
            for (const ammo of ['bullets', 'shells', 'rockets', 'cells']) state.playerStats[ammoMaximum(ammo)] *= 2;
            state.inventory.backpack = true;
          }
          break;
        case 'setPlayerFace': state.face = action.expression; break;
        case 'setGroupActive': state.groups.set(action.groupId, action.active === 'yes'); break;
        case 'movePlayer': state.input.forward += action.forward; state.input.strafe += action.strafe; break;
        case 'turnPlayer': player.angle += action.speed * Math.PI / 180 * dt; break;
        case 'mouseLook':
          player.angle += state.input.mouseX * action.sensitivity;
          if (action.vertical === 'enabled') player.pitch = Math.max(-85 * Math.PI / 180, Math.min(85 * Math.PI / 180, player.pitch - state.input.mouseY * action.sensitivity));
          break;
        case 'jumpPlayer':
          state.input.jump = true; break;
        case 'setPlayerStat':
          if (action.stat === 'health') recordDamage(state, state.playerStats.health - action.value);
          state.playerStats[action.stat] = action.value; break;
        case 'addPlayerStat': {
          const value = Math.max(0, Math.min(action.maximum, state.playerStats[action.stat] + action.value));
          if (action.stat === 'health') recordDamage(state, state.playerStats.health - value);
          state.playerStats[action.stat] = value; break;
        }
        case 'damagePlayer': damagePlayer(state, action.damage, action.direction); break;
        case 'playSound': soundEvent(state, action.sound, action.volume, event.ownerId ? findTarget(event.ownerId) : undefined); break;
        case 'facePlayer': {
          const entity = findTarget(action.entityId);
          if (entity) entity.angle = Math.atan2(state.player.y - entity.y, state.player.x - entity.x) * 180 / Math.PI;
          break;
        }
        case 'moveEnemy': {
          const entity = findTarget(action.entityId);
          if (entity) moveEnemy(state, entity, action.speed, dt);
          break;
        }
        case 'enemyHitscan': {
          const entity = findTarget(action.entityId);
          if (entity) enemyHitscan(state, entity, action);
          break;
        }
        case 'launchProjectile': launchProjectile(state, action); break;
        case 'enemyProjectile': {
          const entity = findTarget(action.entityId);
          if (entity && entity.health > 0 && canSeePlayer(state, entity, 65536)) launchProjectile(state, action, entity);
          break;
        }
        case 'setEntityHealth': {
          const target = findTarget(action.entityId);
          if (target) target.health = action.health;
          break;
        }
        case 'hitscan': fireHitscan(state, action); break;
        case 'startTimer': state.timers.set(`${event.ownerId || '$scene'}:${action.timer}`, state.time + action.seconds); break;
        case 'clearTimer': state.timers.delete(`${event.ownerId || '$scene'}:${action.timer}`); break;
        case 'showPlayerHUD': state.hud = action.visible === 'yes'; break;
        case 'setHUDCursor': hud.cursor = action.mode === 'toggle' ? !hud.cursor : action.mode === 'cursor'; break;
        case 'setHUDVisible': hud.elements.get(action.elementId).visible = action.visible === 'yes'; break;
        case 'setHUDText': Object.assign(hud.elements.get(action.elementId), { text: action.text, binding: '' }); break;
        case 'setHUDBinding': hud.elements.get(action.elementId).binding = action.binding; break;
        case 'setHUDProperty': hud.elements.get(action.elementId)[action.property] = action.value; break;
        case 'playHUDAnimation': playHUDAnimation(project, hud, action.animationId); break;
        case 'stopHUDAnimation': hud.playing.delete(action.animationId); break;
        case 'showMessage': state.message = action.message; state.messageTime = 6; break;
        case 'setVariable': assignVariable(state.variables, action.variable, action.value, false); break;
        case 'addVariable': assignVariable(state.variables, action.variable, action.value, true); break;
        case 'teleport':
          player.x = action.x; player.y = action.y;
          state.physics?.teleport(state.entities.find(entity => entity.type === 'player').id, action.x, action.y, action.z);
          break;
        case 'removeEntity': {
          const id = resolveEntityId(event, action.entityId);
          state.physics?.remove(id); state.animations.delete(id);
          state.spriteAnimations.delete(id);
          state.entities = state.entities.filter(item => item.id !== id);
          break;
        }
        case 'setEntityPosition': {
          const target = findTarget(action.entityId);
          if (target) {
            target.x = action.x; target.y = action.y;
            if (target.type === 'player') { player.x = action.x; player.y = action.y; }
            if (action.z !== undefined) target.z = action.z;
            state.physics?.teleport(target.id, action.x, action.y, action.z);
          }
          break;
        }
        case 'rotateEntity': {
          const target = findTarget(action.entityId);
          if (target) {
            target.angle = action.angle;
            if (target.type === 'player') player.angle = action.angle * Math.PI / 180;
            state.physics?.rotate(target.id, action.angle);
          }
          break;
        }
        case 'applyImpulse': case 'applyForce': case 'setVelocity': {
          const target = findTarget(action.entityId);
          if (!target) break;
          if (!state.physics) throw new Error('Physics actions require an initialized Rapier world');
          const method = action.type === 'applyImpulse' ? 'impulse' : action.type === 'applyForce' ? 'force' : 'velocity';
          state.physics[method](target.id, action);
          break;
        }
        case 'playAnimation':
          if (findTarget(action.entityId)) {
            const id = resolveEntityId(event, action.entityId);
            state.animations.set(id, { clip: action.clip, speed: action.speed, loop: action.loop, playing: true, revision: (state.animations.get(id)?.revision || 0) + 1 });
          }
          break;
        case 'stopAnimation': {
          const animation = state.animations.get(resolveEntityId(event, action.entityId));
          if (animation) { animation.playing = false; animation.revision++; }
          break;
        }
      }
    }
    return true;
  }
}

function fireHitscan(state, action) {
  const player = state.player;
  const eye = (player.z ?? sectorAt(state.sectors, player.x, player.y)?.floorHeight ?? 0) + 48;
  const random = () => {
    state.randomSeed = (Math.imul(state.randomSeed, 1664525) + 1013904223) >>> 0;
    return state.randomSeed / 4294967296;
  };
  state.lastShot = { time: state.time, hits: [] };
  for (let pellet = 0; pellet < action.pellets; pellet++) {
    const angle = player.angle + (action.spread ? (random() - .5) * action.spread * Math.PI / 180 : 0);
    const dx = Math.cos(angle) * Math.cos(player.pitch), dy = Math.sin(angle) * Math.cos(player.pitch), dz = Math.sin(player.pitch);
    let nearest = geometryDistance(state, { x: player.x, y: player.y, z: eye }, { x: dx, y: dy, z: dz }, action.range);
    const wallHit = { x: player.x + dx * (nearest + .01), y: player.y + dy * (nearest + .01) };
    const shotWalls = crossedWalls({ ...state, player: wallHit }, player);
    let target = null;
    for (const entity of state.entities) {
      if (entity.type !== 'enemy' || (entity.health ?? 20) <= 0) continue;
      const distance = entityDistance(state, { x: player.x, y: player.y, z: eye }, { x: dx, y: dy, z: dz }, entity, nearest);
      if (distance !== null) { nearest = distance; target = entity; }
    }
    const damage = action.damage * (1 + Math.floor(random() * action.diceSides));
    if (!target) for (const id of shotWalls) state.worldTriggers.shoot.add(id);
    if (target) {
      target.health = Math.max(0, (target.health ?? 20) - damage);
      state.lastShot.hits.push({ id: target.id, damage });
    }
  }
  if (action.range > 64 || state.lastShot.hits.length) state.playerNoise = { time: state.time, x: player.x, y: player.y };
}
