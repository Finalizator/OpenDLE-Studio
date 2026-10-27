/**
 * Hexen/ZDoom linedef specials.
 *
 * Classic Doom maps number their line types 1-141 and the importer translates
 * them into visual rules. UDMF and Hexen-format maps instead use the Hexen
 * special table (and scripts call the same table through ACS), so this module is
 * the one place that turns a special number plus its arguments into engine
 * actions: doors, platforms, floors, ceilings, lights, teleports, thing
 * manipulation, level exits, and the ACS entry points.
 */

import { moveSector, classicSpecialSupported } from './world-motion.js';
import { doomSpecialName } from './doom-specials.js';
import { floorAt, soundEvent } from './combat.js';
import { sectorAt } from './sectors.js';

const SPECIAL_NAMES = [
   'NOP', 'NOP', 'Polyobj_RotateLeft', 'Polyobj_RotateRight', 'Polyobj_Move', 'NOP', 'Polyobj_MoveTimes8',
  'Polyobj_DoorSwing', 'Polyobj_DoorSlide', 'NOP', 'Door_Close', 'Door_Open', 'Door_Raise',
  'Door_LockedRaise', 'Door_Animated', 'Autosave', 'NOP', 'Thing_Raise', 'StartConversation', 'Thing_Stop',
  'Floor_LowerByValue', 'Floor_LowerToLowest', 'Floor_LowerToNearest', 'Floor_RaiseByValue',
  'Floor_RaiseToHighest', 'Floor_RaiseToNearest', 'Stairs_BuildDown', 'Stairs_BuildUp', 'Floor_RaiseAndCrush',
  'Pillar_Build', 'Pillar_Open', 'Stairs_BuildDownSync', 'Stairs_BuildUpSync', 'ForceField',
  'ClearForceField', 'Floor_RaiseByValueTimes8', 'Floor_LowerByValueTimes8', 'Floor_MoveToValue',
  'Ceiling_Waggle', 'Teleport_ZombieChanger', 'Ceiling_LowerByValue', 'Ceiling_RaiseByValue',
  'Ceiling_CrushAndRaise', 'Ceiling_LowerAndCrush', 'Ceiling_CrushStop', 'Ceiling_CrushRaiseAndStay',
  'Floor_CrushStop', 'Ceiling_MoveToValue', 'NOP', 'GlassBreak', 'NOP', 'Sector_SetLink', 'Scroll_Wall',
  'Line_SetTextureOffset', 'Sector_ChangeFlags', 'Line_SetBlocking', 'Line_SetTextureScale', 'NOP', 'NOP',
  'Polyobj_OR_MoveToSpot', 'Plat_PerpetualRaise', 'Plat_Stop', 'Plat_DownWaitUpStay', 'Plat_DownByValue',
  'Plat_UpWaitDownStay', 'Plat_UpByValue', 'Floor_LowerInstant', 'Floor_RaiseInstant',
  'Floor_MoveToValueTimes8', 'Ceiling_MoveToValueTimes8', 'Teleport', 'Teleport_NoFog', 'ThrustThing',
  'DamageThing', 'Teleport_NewMap', 'Teleport_EndGame', 'TeleportOther', 'TeleportGroup', 'TeleportInSector',
  'Thing_SetConversation', 'ACS_Execute', 'ACS_Suspend', 'ACS_Terminate', 'ACS_LockedExecute',
  'ACS_ExecuteWithResult', 'ACS_LockedExecuteDoor', 'Polyobj_MoveToSpot', 'Polyobj_Stop', 'Polyobj_MoveTo',
  'Polyobj_OR_MoveTo', 'Polyobj_OR_RotateLeft', 'Polyobj_OR_RotateRight', 'Polyobj_OR_Move',
  'Polyobj_OR_MoveTimes8', 'Pillar_BuildAndCrush', 'FloorAndCeiling_LowerByValue',
  'FloorAndCeiling_RaiseByValue', 'Ceiling_LowerAndCrushDist', 'Sector_SetTranslucent',
  'Floor_RaiseAndCrushDoom', 'NOP', 'NOP', 'NOP', 'NOP', 'Ceiling_CrushAndRaiseSilentDist', 'Door_WaitRaise',
  'Door_WaitClose', 'Line_SetPortalTarget', 'NOP', 'Light_ForceLightning', 'Light_RaiseByValue',
  'Light_LowerByValue', 'Light_ChangeToValue', 'Light_Fade', 'Light_Glow', 'Light_Flicker', 'Light_Strobe',
  'Light_Stop', 'NOP', 'Thing_Damage', 'Radius_Quake', 'NOP', 'NOP', 'NOP', 'NOP', 'Thing_Move', 'NOP',
  'Thing_SetSpecial', 'ThrustThingZ', 'UsePuzzleItem', 'Thing_Activate', 'Thing_Deactivate', 'Thing_Remove',
  'Thing_Destroy', 'Thing_Projectile', 'Thing_Spawn', 'Thing_ProjectileGravity', 'Thing_SpawnNoFog',
  'Floor_Waggle', 'Thing_SpawnFacing', 'Sector_ChangeSound', 'NOP', 'NOP', 'NOP', 'NOP', 'NOP', 'NOP', 'NOP',
  'NOP', 'NOP', 'Line_SetHealth', 'Sector_SetHealth', 'NOP', 'NOP', 'Teleport_NoStop', 'NOP', 'NOP',
  'SetGlobalFogParameter', 'FS_Execute', 'Sector_SetPlaneReflection', 'NOP', 'NOP', 'NOP', 'NOP', 'NOP',
  'NOP', 'NOP', 'NOP', 'Ceiling_CrushAndRaiseDist', 'Generic_Crusher2', 'Sector_SetCeilingScale2',
  'Sector_SetFloorScale2', 'Plat_UpNearestWaitDownStay', 'NoiseAlert', 'SendToCommunicator',
  'Thing_ProjectileIntercept', 'Thing_ChangeTID', 'Thing_Hate', 'Thing_ProjectileAimed', 'ChangeSkill',
  'Thing_SetTranslation', 'NOP', 'NOP', 'Line_AlignCeiling', 'Line_AlignFloor', 'Sector_SetRotation',
  'Sector_SetCeilingPanning', 'Sector_SetFloorPanning', 'Sector_SetCeilingScale', 'Sector_SetFloorScale',
  'NOP', 'SetPlayerProperty', 'Ceiling_LowerToHighestFloor', 'Ceiling_LowerInstant', 'Ceiling_RaiseInstant',
  'Ceiling_CrushRaiseAndStayA', 'Ceiling_CrushAndRaiseA', 'Ceiling_CrushAndRaiseSilentA',
  'Ceiling_RaiseByValueTimes8', 'Ceiling_LowerByValueTimes8', 'Generic_Floor', 'Generic_Ceiling',
  'Generic_Door', 'Generic_Lift', 'Generic_Stairs', 'Generic_Crusher', 'Plat_DownWaitUpStayLip',
  'Plat_PerpetualRaiseLip', 'TranslucentLine', 'NOP', 'NOP', 'NOP', 'Sector_SetColor', 'Sector_SetFade',
  'Sector_SetDamage', 'Teleport_Line', 'Sector_SetGravity', 'Stairs_BuildUpDoom', 'Sector_SetWind',
  'Sector_SetFriction', 'Sector_SetCurrent', 'Scroll_Texture_Both', 'NOP', 'Scroll_Floor', 'Scroll_Ceiling',
  'NOP', 'ACS_ExecuteAlways', 'PointPush_SetForce', 'Plat_RaiseAndStayTx0', 'Thing_SetGoal',
  'Plat_UpByValueStayTx', 'Plat_ToggleCeiling', 'Light_StrobeDoom', 'Light_MinNeighbor', 'Light_MaxNeighbor',
  'Floor_TransferTrigger', 'Floor_TransferNumeric', 'ChangeCamera', 'Floor_RaiseToLowestCeiling',
  'Floor_RaiseByValueTxTy', 'Floor_RaiseByTexture', 'Floor_LowerToLowestTxTy', 'Floor_LowerToHighest',
  'Exit_Normal', 'Exit_Secret', 'Elevator_RaiseToNearest', 'Elevator_MoveToFloor', 'Elevator_LowerToNearest',
  'HealThing', 'Door_CloseWaitOpen', 'Floor_Donut', 'FloorAndCeiling_LowerRaise', 'Ceiling_RaiseToNearest',
  'Ceiling_LowerToLowest', 'Ceiling_LowerToFloor', 'Ceiling_CrushRaiseAndStaySilA', 'Floor_LowerToHighestEE',
  'Floor_RaiseToLowest', 'Floor_LowerToLowestCeiling', 'Floor_RaiseToCeiling', 'Floor_ToCeilingInstant',
  'Floor_LowerByTexture', 'Ceiling_RaiseToHighest', 'Ceiling_ToHighestInstant', 'Ceiling_LowerToNearest',
  'Ceiling_RaiseToLowest', 'Ceiling_RaiseToHighestFloor', 'Ceiling_ToFloorInstant', 'Ceiling_RaiseByTexture',
  'Ceiling_LowerByTexture', 'Stairs_BuildDownDoom', 'Stairs_BuildUpDoomSync', 'Stairs_BuildDownDoomSync',
  'Stairs_BuildUpDoomCrush', 'Door_AnimatedClose', 'Floor_Stop', 'Ceiling_Stop', 'Sector_SetFloorGlow',
  'Sector_SetCeilingGlow', 'Floor_MoveToValueAndCrush', 'Ceiling_MoveToValueAndCrush', 'Line_SetAutomapFlags',
  'Line_SetAutomapStyle', 'Polyobj_StopSound', 'Generic_CrusherDist',
];

/** Blocking modes for Line_SetBlocking. */
const BLOCK_NOTHING = 0, BLOCK_CREATURES = 1, BLOCK_EVERYTHING = 2, BLOCK_RAILING = 3, BLOCK_PLAYERS = 4;

/**
 * A special's name in the numbering of the map it came from. UDMF and Hexen maps
 * use GZDoom's table; binary Doom maps use Doom's own, where the same number means
 * something else entirely.
 */
export function specialName(special, format = 'zdoom') {
  if (format === 'classic') return doomSpecialName(special) || 'Boom/ZDoom extension';
  return SPECIAL_NAMES[special] || `special ${special}`;
}

/** `19 W1 Floor Lower to Lowest` for reports, with the format's own numbering. */
export function specialLabel(special, format = 'zdoom') {
  return `${special} ${specialName(special, format)}`;
}

/** Specials that are defined as "do nothing" in GZDoom's own table. */
const NOP_SPECIALS = new Set([0, 1, 5, 9, 16, 48, 50, 57, 58, 100, 101, 102, 103, 108, 118, 121, 122, 123, 124, 126,
  141, 142, 143, 144, 145, 146, 147, 148, 149, 152, 153, 155, 156, 160, 161, 162, 163, 164, 165, 166, 167, 181, 182,
  190, 209, 210, 211, 222, 225]);

/** Specials this runtime performs; used for import warnings and the editor. */
export const SUPPORTED_SPECIALS = new Set([
  10, 11, 12, 13, 20, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 35, 36, 37, 40, 41, 42, 43, 44, 45, 47, 53, 55, 60, 61,
  62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 73, 74, 75, 80, 81, 82, 83, 84, 85, 95, 96, 99, 105, 106, 109, 110, 111,
  112, 113, 114, 115, 116, 117, 119, 125, 130, 131, 132, 133, 134, 135, 136, 137, 139, 192, 196, 202, 206, 214, 226,
  228, 230,
  195, 203, 231, 232, 233, 234, 238, 241, 243, 244, 248, 249, 251, 252, 253, 254, 255, 257, 258, 259,
  ...NOP_SPECIALS,
]);

const TIC = 35;
// Classic Doom maps carry no arguments, so their movement uses Doom's own constants:
// VDOORSPEED is 2 units per tic, VFLOORSPEED is 4, and VDOORWAIT holds a door open
// for 150 tics.
const CLASSIC_DOOR_SPEED = 2, CLASSIC_PLANE_SPEED = 4, CLASSIC_DOOR_WAIT = 150 / TIC;

function liveSector(state, id) {
  return state.sectors.find(sector => sector.id === id);
}

function taggedSectors(state, tag) {
  return state.sectors.filter(sector => sector.tag === tag);
}

/** Sector ids that share a boundary with `sectorId`, ignoring self-references. */
function neighbourIds(project, sectorId) {
  const ids = new Set();
  for (const wall of project.map.walls) {
    const front = wall.right?.sectorId, back = wall.left?.sectorId;
    if (front === sectorId && back && back !== sectorId) ids.add(back);
    else if (back === sectorId && front && front !== sectorId) ids.add(front);
  }
  return [...ids];
}

function planeHeights(state, project, sector, surface) {
  const heights = neighbourIds(project, sector.id).map(id => liveSector(state, id))
    .filter(Boolean).map(neighbour => neighbour[surface]);
  return heights;
}

/** Starts a plane motion, converting Doom's units-per-tic into the engine's per-second speed. */
function movePlane(state, sector, surface, target, speedTics, { wait = 0, returnMode = 'stay', sound } = {}) {
  const current = sector[surface];
  if (!Number.isFinite(target) || Math.abs(target - current) < 0.5) return false;
  moveSector(state, {
    sectorId: sector.id, surface, height: target, speed: Math.max(TIC, speedTics * TIC),
    wait, returnMode, sound, returnHeight: current,
  });
  return true;
}

function targetFor(kind, sector, surface, others, amount) {
  switch (kind) {
    case 'byValue': return sector[surface] + amount;
    case 'toHighest': return Math.max(sector[surface], ...others);
    case 'toLowest': return Math.min(sector[surface], ...others);
    case 'toNearestUp': {
      const higher = others.filter(height => height > sector[surface]);
      return higher.length ? Math.min(...higher) : sector[surface];
    }
    case 'toNearestDown': {
      const lower = others.filter(height => height < sector[surface]);
      return lower.length ? Math.max(...lower) : sector[surface];
    }
    default: return sector[surface];
  }
}

function doorTarget(state, project, sector) {
  const ceilings = planeHeights(state, project, sector, 'ceilingHeight');
  return ceilings.length ? Math.min(...ceilings) - 4 : sector.ceilingHeight + 128;
}

function floorLowest(state, project, sector) {
  const floors = planeHeights(state, project, sector, 'floorHeight');
  return floors.length ? Math.min(...floors) : sector.floorHeight;
}

function damageActor(state, entity, amount, options) {
  if (!entity || !(amount > 0)) return false;
  if (entity.type === 'player' || entity === state.player) {
    state.playerStats.health = Math.max(0, state.playerStats.health - amount);
    state.feedback.health = state.playerStats.health;
    state.feedback.damage = { amount, time: state.time };
    return true;
  }
  if (entity.health === undefined) return false;
  entity.health = Math.max(0, entity.health - amount);
  if (!entity.health) options.onDeath?.(entity);
  return true;
}

function actorByTid(state, tid, activator) {
  if (!tid) return activator === 'player' ? null : state.entities.find(entity => entity.tid === tid) || null;
  return state.entities.find(entity => entity.tid === tid) || null;
}

function actorsByTid(state, tid) {
  return tid ? state.entities.filter(entity => entity.tid === tid) : [];
}

function teleportTo(state, sector) {
  // Doom places a "teleport destination" marker (thing 14) where the player
  // should arrive; without one, the middle of the tagged sector is used.
  const marker = state.entities.find(entity => entity.doomType === 14 &&
    sectorAt(state.sectors, entity.x, entity.y)?.id === sector.id);
  if (marker) return { x: marker.x, y: marker.y, z: floorAt(state, marker) + 24, angle: marker.angle };
  const centre = sector.bounds
    ? { x: (sector.bounds.minX + sector.bounds.maxX) / 2, y: (sector.bounds.minY + sector.bounds.maxY) / 2 }
    : { x: state.player.x, y: state.player.y };
  return { x: centre.x, y: centre.y, z: Math.min(sector.ceilingHeight - 48, sector.floorHeight + 24) };
}

function placeThing(state, entity, position) {
  entity.x = position.x; entity.y = position.y;
  if (entity.type === 'player') {
    state.player.x = position.x; state.player.y = position.y;
    const playerEntity = state.entities.find(other => other.type === 'player');
    if (state.physics && playerEntity) state.physics.teleport(playerEntity.id, position.x, position.y, position.z);
    else if (playerEntity) playerEntity.z = position.z;
    state.player.z = position.z;
    return;
  }
  entity.z = position.z;
  state.physics?.teleport(entity.id, position.x, position.y, position.z);
}

function teleportSound(state) {
  soundEvent(state, 'DSTELEPT', .7);
}

/**
 * Runs a line special. Returns the special's result value, which only
 * `ACS_ExecuteWithResult` actually consumes.
 */
export function executeSpecial(project, state, special, rawArgs = [], options = {}) {
  if (!special) return 0;
  const args = [0, 1, 2, 3, 4].map(index => Number(rawArgs[index]) | 0);
  const [arg1, arg2, arg3, arg4, arg5] = args;
  const scripts = options.scripts;
  const sectors = arg1 ? taggedSectors(state, arg1) : [];
  const line = options.line ? project.map.walls.find(wall => wall.id === options.line) : null;
  // GZDoom converts every special's numbers before using them: SPEED(a) is a/8 units
  // per tic, TICS(a) is a tics and OCTICS(a) is a/8 seconds. Reading the raw argument
  // as units per tic made every door and lift eight times too fast, which is why a
  // 120-unit door snapped open in two frames.
  const zdoom = (options.format || line?.specialFormat) === 'zdoom';
  const doorSpeed = zdoom ? Math.max(1, arg2) / 8 : CLASSIC_DOOR_SPEED;
  const planeSpeed = zdoom ? Math.max(1, arg2) / 8 : CLASSIC_PLANE_SPEED;
  const waitTics = value => Math.max(0, value || 0) / TIC;
  const waitOctics = value => Math.max(0, value || 0) / 8;
  const speed = doorSpeed;
  const planes = (kind, surface, amount, extra = {}) => {
    let moved = 0;
    for (const sector of sectors) {
      const others = planeHeights(state, project, sector, surface);
      const target = kind === 'absolute' ? amount : targetFor(kind, sector, surface, others, amount);
      if (movePlane(state, sector, surface, target, planeSpeed, extra)) moved++;
    }
    return moved;
  };

  switch (special) {
    case 10: // Door_Close
      for (const sector of sectors) movePlane(state, sector, 'ceilingHeight', sector.floorHeight, speed, { sound: 'DSDORCLS' });
      return 1;
    case 11: // Door_Open
      for (const sector of sectors) movePlane(state, sector, 'ceilingHeight', doorTarget(state, project, sector), speed, { sound: 'DSDOROPN' });
      return 1;
    case 12: case 13: case 105: case 249: // Door_Raise / LockedRaise / WaitRaise / CloseWaitOpen
      if (special === 13 && options.activator === 'player' && !hasLockKey(project, state, arg3)) {
        options.message?.('You need a key to open this door.');
        return 0;
      }
      // Door_Raise keeps the door open for a tic delay; CloseWaitOpen uses octics.
      for (const sector of sectors) {
        const wait = zdoom ? (special === 249 ? waitOctics(arg3) : waitTics(arg3)) : CLASSIC_DOOR_WAIT;
        movePlane(state, sector, 'ceilingHeight', doorTarget(state, project, sector), speed,
          { wait, returnMode: wait > 0 ? 'return' : 'stay', sound: 'DSDOROPN' });
      }
      return 1;
    case 106: { // Door_WaitClose — the wait is the second argument, in tics
      const wait = zdoom ? waitTics(arg3) : CLASSIC_DOOR_WAIT;
      for (const sector of sectors) {
        moveSector(state, { sectorId: sector.id, surface: 'ceilingHeight', height: sector.floorHeight,
          speed: Math.max(TIC, speed * TIC), wait, returnMode: 'return',
          returnHeight: doorTarget(state, project, sector), sound: 'DSDORCLS' });
      }
      return 1;
    }
    case 20: case 36: // Floor_LowerByValue(Times8)
      return planes('byValue', 'floorHeight', -(special === 36 ? arg3 * 8 : arg3), { sound: 'DSPSTART' });
    case 21: case 241: case 258: // Floor_LowerToLowest(-Ceiling)
      return planes('toLowest', 'floorHeight', 0, { sound: 'DSPSTART' });
    case 22: // Floor_LowerToNearest
      return planes('toNearestDown', 'floorHeight', 0, { sound: 'DSPSTART' });
    case 23: case 35: // Floor_RaiseByValue(Times8)
      return planes('byValue', 'floorHeight', special === 35 ? arg3 * 8 : arg3, { sound: 'DSPSTART' });
    case 24: case 238: // Floor_RaiseToHighest(/ToLowestCeiling)
      return planes('toHighest', 'floorHeight', 0, { sound: 'DSPSTART' });
    case 25: case 257: case 259: // Floor_RaiseToNearest(/ToLowest/ToCeiling)
      return planes('toNearestUp', 'floorHeight', 0, { sound: 'DSPSTART' });
    case 28: case 99: // Floor_RaiseAndCrush(Doom)
      return planes('byValue', 'floorHeight', arg3, { sound: 'DSPSTART' });
    case 37: case 68: // Floor_MoveToValue(Times8)
      return planes('absolute', 'floorHeight', arg4 ? -arg3 * (special === 68 ? 8 : 1) : arg3 * (special === 68 ? 8 : 1), { sound: 'DSPSTART' });
    case 66: case 67: { // Floor_LowerInstant / RaiseInstant
      for (const sector of sectors) {
        const others = planeHeights(state, project, sector, 'floorHeight');
        const target = special === 66 ? targetFor('toLowest', sector, 'floorHeight', others, 0)
          : targetFor('toHighest', sector, 'floorHeight', others, 0);
        sector.floorHeight = target;
        state.worldRevision++;
      }
      return 1;
    }
    case 40: case 253: case 254: // Ceiling_LowerByValue / ToLowest / ToFloor
      return planes(special === 40 ? 'byValue' : special === 253 ? 'toLowest' : 'toLowest', 'ceilingHeight',
        special === 40 ? -arg3 : 0, { sound: 'DSCNSTRT' });
    case 41: case 252: // Ceiling_RaiseByValue / ToNearest
      return planes(special === 41 ? 'byValue' : 'toNearestUp', 'ceilingHeight', special === 41 ? arg3 : 0, { sound: 'DSCNSTRT' });
    case 42: case 196: // Ceiling_CrushAndRaise
      for (const sector of sectors) {
        moveSector(state, { sectorId: sector.id, surface: 'ceilingHeight', height: sector.floorHeight + 4,
          speed: Math.max(TIC, speed * TIC), wait: 1, returnMode: 'return', returnHeight: sector.ceilingHeight, sound: 'DSCNSTRT' });
      }
      return 1;
    case 43: // Ceiling_LowerAndCrush
      for (const sector of sectors) movePlane(state, sector, 'ceilingHeight', sector.floorHeight + 4, speed, { sound: 'DSCNSTRT' });
      return 1;
    case 44: // Ceiling_CrushStop
      for (const sector of sectors) state.sectorMotions.delete(`${sector.id}:ceilingHeight`);
      return 1;
    case 45: case 195: case 255: // Ceiling_CrushRaiseAndStay
      for (const sector of sectors) {
        const others = planeHeights(state, project, sector, 'ceilingHeight');
        movePlane(state, sector, 'ceilingHeight', Math.max(sector.ceilingHeight, ...others, sector.floorHeight + 64), speed, { sound: 'DSCNSTRT' });
      }
      return 1;
    case 47: case 69: // Ceiling_MoveToValue(Times8)
      return planes('absolute', 'ceilingHeight', arg3 * (special === 69 ? 8 : 1), { sound: 'DSCNSTRT' });
    case 95: case 251: // FloorAndCeiling_LowerByValue
      for (const sector of sectors) {
        movePlane(state, sector, 'floorHeight', sector.floorHeight - arg3, speed, { sound: 'DSPSTART' });
        movePlane(state, sector, 'ceilingHeight', sector.ceilingHeight - arg3, speed, {});
      }
      return 1;
    case 96: // FloorAndCeiling_RaiseByValue
      for (const sector of sectors) {
        movePlane(state, sector, 'floorHeight', sector.floorHeight + arg3, speed, { sound: 'DSPSTART' });
        movePlane(state, sector, 'ceilingHeight', sector.ceilingHeight + arg3, speed, {});
      }
      return 1;
    case 60: case 62: case 64: case 206: { // platforms: down/up cycles
      const down = special !== 64;
      for (const sector of sectors) {
        const others = planeHeights(state, project, sector, 'floorHeight');
        const target = down ? targetFor('toLowest', sector, 'floorHeight', others, 0)
          : targetFor('toHighest', sector, 'floorHeight', others, 0);
        moveSector(state, { sectorId: sector.id, surface: 'floorHeight', height: target,
          speed: Math.max(TIC, speed * TIC), wait: Math.max(0, (arg3 || 0) / TIC), returnMode: 'return',
          returnHeight: sector.floorHeight, sound: 'DSPSTART' });
      }
      return 1;
    }
    case 63: case 65: case 228: case 230: // plat by value
      return planes('byValue', 'floorHeight', special === 63 || special === 230 ? -arg3 : arg3, { returnMode: 'return', sound: 'DSPSTART' });
    case 61: // Plat_Stop
      for (const sector of sectors) state.sectorMotions.delete(`${sector.id}:floorHeight`);
      return 1;
    case 231: { // Plat_ToggleCeiling
      for (const sector of sectors) {
        const open = Math.abs(sector.ceilingHeight - doorTarget(state, project, sector)) < 1;
        movePlane(state, sector, 'ceilingHeight', open ? sector.floorHeight : doorTarget(state, project, sector), speed,
          { sound: open ? 'DSDORCLS' : 'DSDOROPN' });
      }
      return 1;
    }
    case 70: case 71: { // Teleport / Teleport_NoFog
      const destination = sectors[0];
      if (!destination) return 0;
      const target = arg2 ? actorsByTid(state, arg2)[0] : null;
      const position = teleportTo(state, destination);
      const victim = target || (options.activator === 'player' || !arg2 ? { type: 'player', id: 'player' } : null);
      if (victim) {
        placeThing(state, victim, position);
        if (position.angle !== undefined) {
          if (victim.type === 'player') state.player.angle = position.angle * Math.PI / 180;
          else victim.angle = position.angle;
        }
      }
      if (special === 70) teleportSound(state);
      return 1;
    }
    case 74: // Teleport_NewMap
      options.changeLevel?.(arg1);
      return 1;
    case 75: case 243: // Teleport_EndGame / Exit_Normal
      options.finishLevel?.('normal');
      return 1;
    case 244: // Exit_Secret
      options.finishLevel?.('secret');
      return 1;
    case 73: { // DamageThing — damages the activating actor
      const entity = state.entities.find(entity => entity.type === 'player');
      if (entity) damageActor(state, entity, arg1, options);
      else {
        state.playerStats.health = Math.max(0, state.playerStats.health - arg1);
        state.feedback.health = state.playerStats.health;
        state.feedback.damage = { amount: arg1, time: state.time };
      }
      return 1;
    }
    case 119: { // Thing_Damage
      let damaged = 0;
      for (const entity of actorsByTid(state, arg1)) if (damageActor(state, entity, arg2, options)) damaged++;
      if (!damaged && (options.activator === 'player' || !arg1)) {
        state.playerStats.health = Math.max(0, state.playerStats.health - arg2);
        state.feedback.health = state.playerStats.health;
        damaged = 1;
      }
      return damaged;
    }
    case 248: // HealThing
      state.playerStats.health = Math.min(state.playerStats.healthMax || 100, state.playerStats.health + arg1);
      state.feedback.health = state.playerStats.health;
      return 1;
    case 130: case 131: { // Thing_Activate / Thing_Deactivate
      // Dormant monsters stand still until something activates them, which is
      // how Hexen maps stage reinforcements.
      let changed = 0;
      for (const entity of actorsByTid(state, arg1)) {
        entity.dormant = special === 131;
        entity.ambush = entity.ambush ?? false;
        changed++;
      }
      return changed;
    }
    case 132: case 133: { // Thing_Remove / Thing_Destroy
      let removed = 0;
      for (const entity of actorsByTid(state, arg1)) {
        options.onRemove?.(entity);
        removed++;
      }
      return removed;
    }
    case 134: case 136: { // Thing_Projectile(+Gravity)
      const origin = actorByTid(state, arg1);
      for (const entity of origin ? [origin] : []) {
        options.projectile?.({ entity, type: arg2, angle: arg3, speed: arg4, vspeed: arg5 });
      }
      return 1;
    }
    case 125: { // Thing_Move
      const entity = actorByTid(state, arg2 || arg1);
      const destination = sectors[0];
      if (entity && destination) placeThing(state, entity, teleportTo(state, destination));
      return 1;
    }
    case 135: case 137: case 139: { // Thing_Spawn / NoFog / SpawnFacing
      let spawned = 0;
      const spots = actorsByTid(state, arg1);
      for (const spot of spots) {
        const angle = special === 139 ? spot.angle : arg3 * 360 / 256;
        if (options.spawn?.({ x: spot.x, y: spot.y, z: floorAt(state, spot), type: arg2, angle, tid: 0 })) spawned++;
      }
      return spawned;
    }
    case 110: case 111: case 112: case 113: case 114: case 115: case 116: case 117: { // lights
      const amount = arg2;
      for (const sector of sectors) {
        const before = sector.light;
        if (special === 110) sector.light = Math.min(255, sector.light + amount);
        else if (special === 111) sector.light = Math.max(0, sector.light - amount);
        else if (special === 112 || special === 113) sector.light = Math.max(0, Math.min(255, amount));
        else if (special === 114 || special === 115 || special === 116) continue;
        if (sector.light !== before) state.worldRevision++;
      }
      return 1;
    }
    case 109: // Light_ForceLightning
      state.lightning = Math.max(state.lightning || 0, 1);
      return 1;
    case 232: case 233: case 234: { // Light_StrobeDoom / Min/MaxNeighbor
      for (const sector of sectors) {
        const neighbours = neighbourIds(project, sector.id).map(id => liveSector(state, id)).filter(Boolean);
        if (!neighbours.length) continue;
        const lights = neighbours.map(neighbour => neighbour.light);
        if (special === 233) sector.light = Math.min(...lights);
        if (special === 234) sector.light = Math.max(...lights);
      }
      state.worldRevision++;
      return 1;
    }
    case 53: { // Line_SetTextureOffset
      const offset = arg2, y = arg3;
      for (const wall of state.walls) if (wall.tag === arg1) {
        if (wall.right) { wall.right.offsetX = offset; wall.right.offsetY = y; }
      }
      state.worldRevision++;
      return 1;
    }
    case 55: { // Line_SetBlocking
      for (const wall of state.walls) {
        if (wall.tag !== arg1 && wall.id !== arg1) continue;
        const front = state.sectors.find(sector => sector.id === wall.right?.sectorId);
        const back = state.sectors.find(sector => sector.id === wall.left?.sectorId);
        if (arg2 === BLOCK_NOTHING) wall.solid = !front || !back;
        else if (arg2 === BLOCK_EVERYTHING || arg2 === BLOCK_PLAYERS || arg2 === BLOCK_CREATURES || arg2 === BLOCK_RAILING) wall.solid = true;
      }
      state.worldRevision++;
      return 1;
    }
    case 80: case 226: // ACS_Execute / ACS_ExecuteAlways
      return scripts?.execute(arg1, [arg3, arg4, arg5], { always: special === 226, activator: options.activator }) ? 1 : 0;
    case 84: case 228: // ACS_ExecuteWithResult(Always)
      return scripts?.execute(arg1, [arg3, arg4, arg5], { always: true, wantResult: true, activator: options.activator }) ?? 0;
    case 83: case 85: // ACS_LockedExecute(Door)
      if (!hasLockKey(project, state, arg2)) {
        options.message?.('You need a key to open this door.');
        return 0;
      }
      return scripts?.execute(arg3, [arg4, arg5, 0], { always: special === 85, activator: options.activator }) ? 1 : 0;
    case 81: // ACS_Suspend
      scripts?.suspend(arg3);
      return 1;
    case 82: // ACS_Terminate
      scripts?.terminate(arg3);
      return 1;
    case 26: case 27: case 31: case 32: { // Stairs_BuildDown / BuildUp(+Sync)
      const rising = special === 27 || special === 32;
      const step = Math.max(0, arg3 || 8);
      const ordered = [...sectors].sort((a, b) => stairOrder(a, b));
      ordered.forEach((sector, index) => {
        const target = sector.floorHeight + (rising ? 1 : -1) * step * (index + 1);
        movePlane(state, sector, 'floorHeight', target, speed, { sound: 'DSPSTART' });
      });
      return ordered.length;
    }
    case 202: { // Generic_Door — tag, speed, kind, delay (octics), lock
      // Kind and delay are the third and fourth arguments, after tag and speed. Reading
      // them one argument too early made the speed double as the kind bitfield (a speed
      // of 82 is kind 2, "close first") and dropped the authored delay, so a door opened
      // and shut again in the same moment and could never be walked through.
      const kind = arg3 & 63;
      if (kind > 3) return 0; // GZDoom performs 0 raise, 1 open, 2 close-wait-open, 3 close
      if (arg5 && !hasLockKey(project, state, arg5)) {
        options.message?.('You need a key to open this door.');
        return 0;
      }
      const wait = zdoom ? waitOctics(arg4) : CLASSIC_DOOR_WAIT;
      const closingFirst = kind === 2 || kind === 3, cycle = kind === 0 || kind === 2;
      for (const sector of sectors) {
        const open = doorTarget(state, project, sector), closed = sector.floorHeight;
        const first = closingFirst ? closed : open;
        moveSector(state, { sectorId: sector.id, surface: 'ceilingHeight', height: first,
          speed: Math.max(TIC, speed * TIC), wait: cycle ? wait : 0,
          returnMode: cycle ? 'return' : 'stay', returnHeight: closingFirst ? open : closed,
          sound: closingFirst ? 'DSDORCLS' : 'DSDOROPN' });
      }
      return 1;
    }
    case 203: { // Generic_Lift — tag, speed, delay (octics), target, height
      const kind = arg4, height = Math.max(0, arg5 || 0) * 8;
      const wait = zdoom ? waitOctics(arg3) : CLASSIC_DOOR_WAIT;
      for (const sector of sectors) {
        const others = planeHeights(state, project, sector, 'floorHeight');
        const lowest = targetFor('toLowest', sector, 'floorHeight', others, 0);
        const ceilings = planeHeights(state, project, sector, 'ceilingHeight');
        const target = kind === 2 ? targetFor('toNearestDown', sector, 'floorHeight', others, 0)
          : kind === 3 ? (ceilings.length ? Math.min(...ceilings) : sector.floorHeight)
            : kind === 4 ? sector.floorHeight + (height || 64)
              : kind === 1 ? lowest
                : sector.floorHeight + height;
        moveSector(state, { sectorId: sector.id, surface: 'floorHeight', height: target,
          speed: Math.max(TIC, speed * TIC), wait,
          returnMode: kind === 1 || kind === 2 ? 'return' : kind === 4 ? 'cycle' : 'stay',
          returnHeight: sector.floorHeight, sound: 'DSPSTART' });
      }
      return 1;
    }
    case 214: { // Sector_SetDamage
      for (const sector of sectors) sector.damage = arg2;
      state.worldRevision++;
      return 1;
    }
    case 249: { // Door_CloseWaitOpen
      for (const sector of sectors) {
        moveSector(state, { sectorId: sector.id, surface: 'ceilingHeight', height: sector.floorHeight,
          speed: Math.max(TIC, speed * TIC), wait: Math.max(0, (arg3 || 0) / TIC), returnMode: 'return',
          returnHeight: doorTarget(state, project, sector), sound: 'DSDORCLS' });
      }
      return 1;
    }
    default:
      return NOP_SPECIALS.has(special) ? 0 : undefined;
  }
}

/** Stairs are built outward from the activating line, so distance orders them. */
function stairOrder(a, b) {
  return (a.bounds?.minX ?? 0) - (b.bounds?.minX ?? 0) || (a.bounds?.minY ?? 0) - (b.bounds?.minY ?? 0);
}

const LOCK_KEYS = { 1: 'blueCard', 2: 'yellowCard', 3: 'redCard', 4: 'blueSkull', 5: 'yellowSkull', 6: 'redSkull',
  100: 'anyBlue', 101: 'anyYellow', 102: 'anyRed', 129: 'anyBlue', 130: 'anyYellow', 131: 'anyRed' };

/** Hexen key numbers map onto the inventory keys the runtime already tracks. */
function hasLockKey(project, state, lock) {
  if (!lock) return true;
  const key = LOCK_KEYS[lock];
  if (!key) return true;
  const keys = state.inventory?.keys;
  if (!keys) return false;
  if (key === 'anyBlue') return keys.has('blueCard') || keys.has('blueSkull');
  if (key === 'anyYellow') return keys.has('yellowCard') || keys.has('yellowSkull');
  if (key === 'anyRed') return keys.has('redCard') || keys.has('redSkull');
  return keys.has(key);
}

/**
 * Which of a map's specials this runtime cannot perform, named for the user.
 * Both linedef triggers and `LSPEC` calls inside scripts are reported.
 */
export function unsupportedSpecials(specials, { format = 'zdoom' } = {}) {
  const performed = format === 'classic' ? classicSpecialSupported : special => SUPPORTED_SPECIALS.has(special);
  const missing = new Set();
  for (const special of specials) {
    if (!special || performed(special)) continue;
    missing.add(specialLabel(special, format));
  }
  return [...missing];
}
