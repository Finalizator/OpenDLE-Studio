import { z } from 'zod';
import { addRoom, newId, validateProject, ENTITY_TYPES } from '../shared/project.js';
import { ENGINE_ACTIONS, ENGINE_CONDITIONS, installEngineScripts } from '../shared/engine-script.js';
import { eventBranch } from '../shared/events.js';
import { installDefaultHUD, hudElement } from '../shared/hud.js';
import { parseHUDCSS } from '../shared/hud-style.js';
import { PLAYER_STATS, WEAPONS, KEYS, AMMO_TYPES } from '../shared/player-state.js';
import { installGameMenu, attachMenuElement } from '../shared/game-menu.js';

const coordinate = z.number().min(-65536).max(65536);
export const toolDefinitions = [
  { name: 'project_get', description: 'Read the complete active OpenDLE project.', shape: {} },
  { name: 'game_menu_install', description: 'Install editable title/pause/settings HUDs and interface-phase visual rules on a project without game menus. Imported WAD/PK3 menus are installed by their importer; this explicit tool adds the no-artwork fallback. Does not overwrite existing menus. User settings are browser-local, not authored project variables.', shape: {} },
  { name: 'variables_set', description: 'Replace global or object-local initial variables with a complete record of numbers, text or booleans. Omit entityId for globals. Existing script/expression references are validated; types stay fixed during Play.',
    shape: { entityId: z.string().optional(), variables: z.record(z.union([z.number().finite(), z.string().max(4096), z.boolean()])) } },
  { name: 'shaders_set', description: 'Replace portable GLSL effect definitions [{id,name,language:"glsl",source,uniforms:{name:number}}] and optionally select shaderId (null disables). Source defines vec4 effect(vec4 color, vec2 uv, float time); numeric uniform declarations are supplied by the engine. This portable GLSL subset is compiled for WebGPU/WebGL; unsupported syntax and broken references are rejected. Shader visual actions setShaderUniform(uniform,value) and setShaderEnabled(enabled:yes|no) remain editable.',
    shape: { shaders: z.array(z.record(z.unknown())), shaderId: z.string().nullable().optional() } },
  { name: 'hud_install_default', description: 'Explicitly install the original editable FPS HUD and visual feedback rules. Refuses to overwrite an authored HUD.', shape: {} },
  { name: 'hud_set_layout', description: 'Set a complete portable HUD: {width,height,scaleMode:fit|stretch|integer,elements:[],fonts:[],animations:[],styles?:[]}. Read project_get first. Elements have globally unique IDs, type panel|text|image|bar|button, name, anchors:{left,top,right,bottom} (0..1), pivotX/Y (0..1), x/y,width/height,z,opacity,scale,rotation,visible,interactive,display:always|game|cursor,text,binding,value,maximum,frame,fontSize,align:left|center|right,color/background:#rrggbb[aa], optional parentId (parent precedes child), assetId, fontId, styleClass, slice:{left,top,right,bottom} in source pixels or sprite:{columns,rows}. hud_element_add supplies defaults. Binding: health|armor|bullets|message|var:NAME or empty. Text supports {binding}. Fonts: {id,name,type:web,assetId} or {id,name,type:bitmap,assetId,cellWidth,cellHeight,columns,chars}. Web assets use kind:font and embedded data:font/woff|woff2|ttf|otf;base64. Animations: {id,name,duration,loop,autoPlay,tracks:[{elementId,property:x|y|width|height|opacity|scale|rotation|value|frame|fontSize,easing:linear|step|easeInOut,keys:[{time,value},...]}]}. Scoped styles: [{name,properties:{CSS-property:value}}]. All references are validated.',
    shape: { hud: z.record(z.unknown()) } },
  { name: 'hud_element_add', description: 'Add a HUD element with complete defaults. Optional properties override defaults; ID is generated. Requires an installed HUD. Attach visual scripts with hudClicked(elementId), hudAnimationFinished(animationId), hudStatChanged(stat,direction); actions setHUDVisible/Text/Property, play/stopHUDAnimation, setHUDCursor. Read project_get to obtain generated IDs.',
    shape: { type: z.enum(['text', 'panel', 'image', 'bar', 'button']), name: z.string().min(1).max(100), properties: z.record(z.unknown()).optional(), screen: z.string().optional() } },
  { name: 'hud_element_update', description: 'Update HUD element properties by ID. Deleting referenced elements requires editing their rules/tracks first; use hud_set_layout for structural removal.',
    shape: { id: z.string(), properties: z.record(z.unknown()) } },
  { name: 'hud_animation_set', description: 'Add or replace an animation by its globally unique ID. Supply complete clip metadata and keyframed tracks as documented by hud_set_layout.',
    shape: { animation: z.record(z.unknown()) } },
  { name: 'hud_import_css', description: 'Import scoped .class { visual-property:value; } HUD CSS. Supports colors, borders, shadows, text styling and padding, not URLs, @rules or page/layout selectors. Assign styleClass on HUD elements.',
    shape: { css: z.string().max(131072) } },
  { name: 'project_set_title', description: 'Rename the project.', shape: { title: z.string().min(1).max(100) } },
  { name: 'engine_install_starter', description: 'Explicitly opt a legacy project into editable FPS starter sheets (NOT complete Doom compatibility). Preserves existing events. Adds Input/Player/Combat/Weapons/Enemies/Pickups/World/HUD sheets and event-driven controls. Throws if Engine sheets already exist.',
    shape: {} },
  { name: 'event_sheet_add', description: 'Create an editable Engine or Game sub-event sheet. Interface-phase rules run while paused; beforePhysics and afterPhysics rules run only during gameplay.',
    shape: { name: z.string().min(1).max(100), section: z.enum(['engine', 'game']).default('game'),
      phase: z.enum(['beforePhysics', 'afterPhysics', 'interface']).default('afterPhysics') } },
  { name: 'event_sheet_update', description: 'Rename, enable/disable or change the section/phase of an existing event sheet. Moving input commands out of beforePhysics is rejected.',
    shape: { id: z.string(), name: z.string().min(1).max(100).optional(), section: z.enum(['engine', 'game']).optional(),
      phase: z.enum(['beforePhysics', 'afterPhysics', 'interface']).optional(), enabled: z.boolean().optional() } },
  { name: 'event_group_add', description: 'Add a collapsible event group in a sheet, optionally active by default. Assign rules with groupId; runtime commands can test or change group activity.',
    shape: { name: z.string().min(1).max(100), sheetId: z.string().optional(), enabled: z.boolean().default(true),
      description: z.string().max(2000).optional() } },
  { name: 'event_group_update', description: 'Edit the title, description and initial activity of an event group. Collapse is editor-only; disabled groups skip execution.',
    shape: { id: z.string(), name: z.string().min(1).max(100).optional(), enabled: z.boolean().optional(), description: z.string().max(2000).optional() } },
  { name: 'map_add_room', description: 'Add a rectangular closed room. Existing walls are not joined or removed.',
    shape: { x: coordinate, y: coordinate, width: z.number().min(32).max(8192), depth: z.number().min(32).max(8192),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#597b9a') } },
  { name: 'map_add_entity', description: 'Place an entity, or move the single player start.',
    shape: { type: z.enum(ENTITY_TYPES), name: z.string().min(1).max(100), x: coordinate, y: coordinate,
      angle: z.number().min(-3600).max(3600).default(0), health: z.number().min(0).max(1000000).optional() } },
  { name: 'map_update_wall', description: 'Edit the color, height or collision of an existing wall.',
    shape: { id: z.string(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      height: z.number().min(8).max(4096).optional(), solid: z.boolean().optional(),
      assetId: z.string().nullable().optional(), right: z.record(z.unknown()).optional(), left: z.record(z.unknown()).optional() } },
  { name: 'sector_update', description: 'Edit an existing sector floor/ceiling height, light (0-255), sky ceiling or floor/ceiling material by existing asset ID. Closed/inverted sectors are static closed doors; they do not open automatically.',
    shape: { id: z.string(), floorHeight: z.number().min(-32768).max(32767).optional(), ceilingHeight: z.number().min(-32768).max(32767).optional(),
      floorAsset: z.string().nullable().optional(), ceilingAsset: z.string().nullable().optional(),
      light: z.number().min(0).max(255).optional(), sky: z.boolean().optional() } },
  { name: 'entity_set_visual', description: 'Assign an existing sprite or GLB/glTF model asset, scale, floor-relative elevation and initial animation (clip,speed,loop,autoPlay) to an object, or configure a light. A model replaces the sprite; default modelScale=32 map units per glTF unit. animation:null clears clip settings. At most16 lights, no shadows.',
    shape: { id: z.string(), spriteAsset: z.string().nullable().optional(), spriteScale: z.number().min(.05).max(16).optional(),
      modelAsset: z.string().nullable().optional(), modelScale: z.number().min(.001).max(4096).optional(), elevation: z.number().min(-32768).max(32767).optional(),
      animation: z.object({ clip: z.string(), speed: z.number().min(.01).max(10), loop: z.boolean(), autoPlay: z.boolean() }).nullable().optional(),
      light: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), intensity: z.number().min(0).max(10), radius: z.number().min(1).max(8192) }).optional() } },
  { name: 'entity_set_physics', description: 'Configure a non-player Rapier rigid body with a primitive collider. 64 map units = 1 metre. height is total height; ball height must be 2*radius; capsule height >=2*radius. Player always uses its built-in capsule. Sensors fire the same contact conditions without blocking. body:none disables physics. All collider fields have defaults.',
    shape: { id: z.string(), body: z.enum(['none', 'fixed', 'dynamic', 'kinematic']), shape: z.enum(['box', 'ball', 'capsule']).default('box'),
      width: z.number().min(.1).max(4096).default(24), height: z.number().min(.1).max(4096).default(32), depth: z.number().min(.1).max(4096).default(24),
      radius: z.number().min(.1).max(4096).default(12), mass: z.number().min(.01).max(100000).default(1), friction: z.number().min(0).max(10).default(.7),
      restitution: z.number().min(0).max(1).default(0), sensor: z.boolean().default(false), lockRotation: z.boolean().default(true) } },
  { name: 'environment_set_visuals', description: 'Choose existing sky/weapon image IDs and sky projection. Optional weaponAssets maps weapon names to image IDs/null, so selected owned weapons use their own overlay (null/missing hides that weapon). weaponAsset is the fixed overlay when no mapping is present. Visuals do not supply firing rules; new Engine starters/imports install nine editable weapon rules separately. Use project_replace for six-face skybox configuration.',
    shape: { skyAsset: z.string().nullable().optional(), skyMode: z.enum(['doom', 'panorama']).optional(), weaponAsset: z.string().nullable().optional(),
      weaponAssets: z.record(z.string().nullable()).optional() } },
  { name: 'events_add_rule', description: 'Add an ordered visual rule with optional ownerId and AND conditions. Conditions: onStart, always, keyPressed(key), nearEntity(entityId,distance), playerGrounded, collisionStarted/collisionEnded/isTouching(entityId,otherId; otherId may be "$world"; both targets need physics), animationFinished(entityId). Actions: showMessage(message), setVariable/addVariable(variable,value), teleport(x,y,z? player), removeEntity(entityId), setEntityPosition(entityId,x,y,z? absolute height), rotateEntity(entityId,angle degrees), applyImpulse/applyForce/setVelocity(entityId,x,y,z; dynamic bodies only, SI units kg*m/s,N,m/s; x/y horizontal,z up; force lasts one simulation tick), playAnimation(entityId,clip,speed,loop), stopAnimation(entityId). "$self" resolves owner. Rules stop when owner is destroyed. References must exist.',
    shape: { name: z.string().min(1).max(100).optional(), sheetId: z.string().optional(), groupId: z.string().optional(), parentId: z.string().optional(),
      comment: z.string().max(2000).optional(), conditionMode: z.enum(['and', 'or']).optional(), forEachType: z.enum(['enemy', 'pickup', 'decoration']).optional(),
      ownerId: z.string().optional(), condition: z.record(z.unknown()), conditions: z.array(z.record(z.unknown())).max(15).optional(),
      actions: z.array(z.record(z.unknown())).max(32), once: z.boolean().default(true) } },
  { name: 'events_update_rule', description: 'Edit existing visual rules, including Engine defaults. All references/commands are validated. Use project_replace to remove optional metadata such as an owner or sheet association.',
    shape: { id: z.string(), name: z.string().min(1).max(100).optional(), enabled: z.boolean().optional(), once: z.boolean().optional(),
      sheetId: z.string().optional(), groupId: z.string().optional(), comment: z.string().max(2000).optional(), conditionMode: z.enum(['and', 'or']).optional(),
      condition: z.record(z.unknown()).optional(), conditions: z.array(z.record(z.unknown())).max(15).optional(),
      actions: z.array(z.record(z.unknown())).max(32).optional() } },
  { name: 'project_replace', description: 'Replace the full project after validation. First read project_get to preserve existing content.',
    shape: { project: z.record(z.unknown()) } },
];
toolDefinitions.find(tool => tool.name === 'events_add_rule').description +=
  ' Values in numeric/free-text event fields can be expressions: {expr:"clamp(local(\\"speed\\") * dt, 0, 20)"}. No JavaScript. Functions global("name"), local("name") (owner/$self), object("id","name"), property("id","x|y|z|angle|health|name|type|elevation|doomType"), player("health"), time,dt,pi; math abs/min/max/clamp/lerp/floor/ceil/round/sqrt/pow/sin/cos/tan/atan2/random; text str/number/concat/upper/lower/trim/len/left/right/mid/replace/contains/find. Operators +,-,*,/,%,^,& (text concatenate),==,!=,<,<=,>,>=,&&,||,!,?:. Radians, zero-based text indexes. Resource IDs, variable names and enum choices remain literal. setObjectVariable/addObjectVariable/objectVariableCompare target entity.variables. expressionCompare compares scalar left/right. ' +
  ' Additional commands (fields in parentheses): ' +
  [...ENGINE_CONDITIONS, ...ENGINE_ACTIONS].map(command =>
    `${command.type}(${[...command.fields.map(field => field.name), ...(command.target ? ['entityId'] : []), ...(command.wall ? ['wallId'] : []), ...(command.sector ? ['sectorId'] : []), ...(command.spriteClip ? ['clipId'] : []), ...(command.variable ? ['variable'] : []), ...(command.group ? ['groupId'] : []), ...(command.hudElement ? ['elementId'] : []), ...(command.hudAnimation ? ['animationId'] : [])].join(',')})`).join('; ') +
  '. keyHeld accepts keyboard codes and Mouse0/Mouse2. Comparisons use <,<=,=,!=,>=,>. Player stats: health,armor,armorDivisor,bullets. ' +
  'Input actions need playerControl:"events" and a beforePhysics sheet. forEachType runs per matching live object; $self is each object. ' +
  'Timers are owner-scoped; seconds are simulation time. Hitscan is a prototype ray primitive, not a complete Doom weapon implementation.';
toolDefinitions.find(tool => tool.name === 'events_add_rule').description +=
  ' World: wallActivated uses player use (Space/E within64 units), line crossing or hitscan impact; moveSector changes floorHeight/ceilingHeight with height/speed/wait/returnMode:stay|return|cycle, synchronized to live render and collision. ' +
  'Sprites: project.spriteClips contains {id,name,frames:[existing image IDs],seconds,loop}. entity.spriteStates maps stand/walk/attack/pain/death to clip IDs. setSpriteState and playWeaponClip are editable actions. ' +
  'Enemy defaults separate decision/wind-up/fire with owner-scoped attack, attackPose and attackWindup timers. timerExists checks presence even after expiry; clearTimer consumes pending attacks. enemyAttackChance uses a Doom distance-based random decision and should be gated by a decision timer, not evaluated every frame. enemySeesPlayer optional fov applies only while unalerted. enemyHitscan optional spread/pellets traces triangular horizontal scatter and independent damage; omitted fields preserve zero spread/one pellet. ' +
  'playerReachesEntity uses horizontal axis overlap (distance, default36), vertical item origin limits (height above feet, default56; below feet, default8) and rejects blocking geometry; imported pickup rules use this rather than nearEntity. ' +
  'launchProjectile/enemyProjectile optionally reference clipId and impactClipId. Missing sprite clips use primitive projectile visuals. enemyAlert tests the owner-scoped alert timer; entityDamaged observes health loss. ' +
  ' Sub-events use parentId and must share the parent sheet/group/owner/forEachType. The tool inserts children after the parent branch. ' +
  'Parent actions execute before children, which only run after a match, inheriting that owner. conditionMode defaults and; or accepts any condition. ' +
  'Non-trigger conditions support inverted:true. Empty actions are allowed for filtering parents. Collapse has no runtime effect.';
toolDefinitions.find(tool => tool.name === 'events_add_rule').description +=
  ` Inventory: weapons=${WEAPONS.join('|')}; keys=${KEYS.join('|')}; ammo=${AMMO_TYPES.join('|')}; player stats=${PLAYER_STATS.join('|')}. ` +
  'setWeaponOwned/selectWeapon/setKeyOwned/addAmmo/giveBackpack are low-level inventory actions. selectWeapon requires ownership; remove an owned current weapon only after selecting another. ' +
  'damagePlayer accepts optional direction:front|left|right|self. playerFeedback signals: damage (last health loss for one second), damageDirection (-1 left,0 front/self/none,1 right), attackTime (continuous primary-fire hold), weaponPickup (new weapon within two seconds). ' +
  'setPlayerFace chooses idle|hurt|left|right|ouch|grin|rampage|god|dead; playerFace tests it. WAD HUD rules choose expression priority and pain bands explicitly. entityDoomType compares a non-player object doomType; inherited $self works in per-instance pickup sub-events.';
toolDefinitions.find(tool => tool.name === 'hud_set_layout').description +=
  ' Optional layout reserveBottom (design pixels) reserves game/weapon viewport space while visible; pixelated:true uses nearest-neighbor images. ' +
  'Elements may have maxLength (1..32, keep last characters), visibilityBinding and visibilityInverted. Bars support fillDirection:right|left|up|down; fillAssetId supplies a clipped foreground image instead of a solid color, while assetId retains its background-image role. Bindings also accept all player stat names, ammo (selected weapon ammo, empty for melee), backpack, weapon:NAME, key:NAME, slot:2..7 (numeric ownership). WAD imports install editable classic status-bar images/fonts/face rules, or partially translate a selected custom SBARINFO into elements and visual rules with original hud.sources. Preserve sources and generated rule references when editing. SBARINFO and MENUDEF include resources are retained; unsupported commands are diagnosed, not executed. No commercial art is bundled.';
toolDefinitions.find(tool => tool.name === 'hud_set_layout').description +=
  ' Bitmap fonts optionally have widths (one source-pixel advance per character) and spaceWidth. imageRepeat:repeat-x tiles artwork at its source dimensions. Menu elements use a centered parent canvas; preserve parentId and the separate letterbox. Do not add engine-only resolution/FOV/brightness/fullscreen/reset controls to imported game screens: these belong in editor Engine tweaks or the preview toolbar.';
toolDefinitions.find(tool => tool.name === 'hud_set_layout').description +=
  ' FON2 imports preserve proportional glyph advances, kerning, transparency and source palette; named color-range translations and scripted fonts remain unsupported. Optional element booleans: statusbar (hide at viewSize 11), menuSelectable (false excludes auxiliary hit targets from Up/Down), menuSelector (native cursor artwork). hudFocused(elementId) observes current mouse/keyboard menu selection. Animations optionally use phase:game|interface; game is the default, interface continues on paused/title screens. Classic menu lowDetail halves horizontal world resolution; viewSize is an integer 3..11. Imported selectors and their visual rules remain editable.';
toolDefinitions.find(tool => tool.name === 'events_add_rule').description +=
  ' setting("volume") and other typed setting expressions read live user settings. setGameScreen("return") follows the actual menu navigation history; use it instead of hard-coded back destinations for imported submenus.';

export function applyTool(project, name, args) {
  const definition = toolDefinitions.find(tool => tool.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  const input = z.object(definition.shape).strict().parse(args);
  let next = structuredClone(project);
  switch (name) {
    case 'project_get': return { project: next, changed: false };
    case 'game_menu_install':
      if (next.gameMenus) throw new Error('Game menus already exist; edit their HUD elements and interface events');
      installGameMenu(next); break;
    case 'hud_install_default': installDefaultHUD(next); break;
    case 'hud_set_layout': next.hud = input.hud; break;
    case 'hud_element_add': {
      if (!next.hud) throw new Error('Install a HUD first');
      const item = { ...hudElement('', input.type, input.name), ...input.properties, id: newId('hud') };
      next.hud.elements.push(item);
      if (input.screen) attachMenuElement(next, item, input.screen);
      break;
    }
    case 'hud_element_update': {
      const element = next.hud?.elements.find(element => element.id === input.id);
      if (!element) throw new Error('HUD element not found');
      Object.assign(element, input.properties); break;
    }
    case 'hud_animation_set': {
      if (!next.hud) throw new Error('Install a HUD first');
      const index = next.hud.animations.findIndex(clip => clip.id === input.animation.id);
      if (index < 0) next.hud.animations.push(input.animation); else next.hud.animations[index] = input.animation;
      break;
    }
    case 'hud_import_css': {
      if (!next.hud) throw new Error('Install a HUD first');
      next.hud.styles ||= [];
      for (const style of parseHUDCSS(input.css)) {
        const existing = next.hud.styles.find(item => item.name === style.name);
        if (existing) Object.assign(existing.properties, style.properties); else next.hud.styles.push(style);
      }
      break;
    }
    case 'project_set_title': next.title = input.title; break;
    case 'variables_set': {
      if (input.entityId) {
        const entity = next.map.entities.find(entity => entity.id === input.entityId);
        if (!entity) throw new Error('Entity not found');
        entity.variables = input.variables;
      } else next.variables = input.variables;
      break;
    }
    case 'shaders_set':
      next.shaders = input.shaders;
      if (input.shaderId === null) delete next.environment.shaderId;
      else if (input.shaderId !== undefined) next.environment.shaderId = input.shaderId;
      break;
    case 'engine_install_starter': installEngineScripts(next); break;
    case 'event_sheet_add':
      next.eventSheets ||= [];
      next.eventSheets.push({ id: newId('sheet'), ...input, enabled: true });
      break;
    case 'event_group_add':
      next.eventGroups ||= [];
      next.eventGroups.push({ id: newId('group'), ...input });
      break;
    case 'event_group_update': {
      const group = next.eventGroups?.find(group => group.id === input.id);
      if (!group) throw new Error('Event group not found');
      Object.assign(group, input);
      break;
    }
    case 'event_sheet_update': {
      const sheet = next.eventSheets?.find(sheet => sheet.id === input.id);
      if (!sheet) throw new Error('Event sheet not found');
      Object.assign(sheet, input);
      break;
    }
    case 'events_update_rule': {
      const event = next.events.find(event => event.id === input.id);
      if (!event) throw new Error('Event not found');
      Object.assign(event, input);
      break;
    }
    case 'map_add_room': addRoom(next, input); break;
    case 'map_add_entity':
      if (input.type === 'player') Object.assign(next.map.entities.find(entity => entity.type === 'player'), input);
      else next.map.entities.push({ id: newId('entity'), ...input });
      break;
    case 'map_update_wall': {
      const wall = next.map.walls.find(item => item.id === input.id);
      if (!wall) throw new Error('Wall not found');
      Object.assign(wall, input);
      break;
    }
    case 'sector_update': {
      const sector = next.map.sectors?.find(sector => sector.id === input.id);
      if (!sector) throw new Error('Sector not found');
      Object.assign(sector, input);
      break;
    }
    case 'entity_set_visual': {
      const entity = next.map.entities.find(entity => entity.id === input.id);
      if (!entity) throw new Error('Entity not found');
      if (input.light && entity.type !== 'light') throw new Error('Only light objects can emit a point light');
      Object.assign(entity, input);
      if (input.animation === null) delete entity.animation;
      break;
    }
    case 'entity_set_physics': {
      const entity = next.map.entities.find(entity => entity.id === input.id);
      if (!entity) throw new Error('Entity not found');
      const { id, ...physics } = input;
      entity.physics = physics;
      break;
    }
    case 'environment_set_visuals':
      Object.assign(next.environment, input);
      if (Object.hasOwn(input, 'skyAsset')) delete next.environment.skybox;
      break;
    case 'events_add_rule': {
      const event = { id: newId('event'), enabled: true, ...input };
      if (event.parentId) {
        if (!next.events.some(item => item.id === event.parentId)) throw new Error('Parent event not found');
        const ids = eventBranch(next.events, event.parentId);
        next.events.splice(next.events.findLastIndex(item => ids.has(item.id)) + 1, 0, event);
      } else next.events.push(event);
      break;
    }
    case 'project_replace': next = input.project; break;
  }
  validateProject(next);
  return { project: next, changed: true };
}

export function jsonSchemaForTool(tool) {
  // Zod v3 schemas are converted explicitly to keep the provider payload small.
  const properties = {};
  const required = [];
  for (const [key, original] of Object.entries(tool.shape)) {
    let schema = original;
    const optional = schema.isOptional();
    let nullable = false;
    while (['ZodOptional', 'ZodDefault', 'ZodNullable'].includes(schema._def.typeName)) {
      if (schema._def.typeName === 'ZodNullable') nullable = true;
      schema = schema._def.innerType;
    }
    const type = schema._def.typeName;
    let value;
    if (type === 'ZodString') value = { type: 'string' };
    else if (type === 'ZodNumber') value = { type: 'number' };
    else if (type === 'ZodBoolean') value = { type: 'boolean' };
    else if (type === 'ZodEnum') value = { type: 'string', enum: schema.options };
    else if (type === 'ZodArray') value = { type: 'array', items: { type: 'object', additionalProperties: true } };
    else value = { type: 'object', additionalProperties: true };
    if (nullable) value = { anyOf: [value, { type: 'null' }] };
    properties[key] = value;
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
