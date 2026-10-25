import { createProject, validateProject } from './project.js';
import { doomName, createDoomAssets, doomThings } from './doom-assets.js';
import { installWorldScripts } from './world-motion.js';
import { installSpriteAnimations } from './sprite-animation.js';
import { installEngineScripts } from './engine-script.js';
import { importDoomHUD, installDoomInventoryScripts } from './doom-hud.js';
import { installDefaultHUD } from './hud.js';
import { parseUDMF, udmfRecords } from './udmf.js';
import { installGameMenu } from './game-menu.js';

const mapPattern = /^(MAP\d\d|E\dM\d)$/;

export function readWad(buffer, { allowNoMaps = false } = {}) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw new Error('WAD header is truncated');
  if (buffer.byteLength > 128 * 1024 * 1024) throw new Error('WAD exceeds the 128 MiB import limit');
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (!['IWAD', 'PWAD'].includes(doomName(bytes.subarray(0, 4)))) throw new Error('Not an IWAD or PWAD file');
  const count = view.getUint32(4, true), directory = view.getUint32(8, true);
  if (count > 100000 || directory < 12 || directory + count * 16 > buffer.byteLength) throw new Error('Invalid WAD directory');
  const lumps = [];
  for (let index = 0; index < count; index++) {
    const offset = directory + index * 16;
    const start = view.getUint32(offset, true), size = view.getUint32(offset + 4, true);
    if (start > buffer.byteLength || size > buffer.byteLength - start) throw new Error(`Lump ${index} is out of bounds`);
    lumps.push({ name: doomName(bytes.subarray(offset + 8, offset + 16)), start, size });
  }
  const maps = lumps.filter((lump, index) => mapPattern.test(lump.name) ||
    ['THINGS', 'TEXTMAP'].includes(lumps[index + 1]?.name) && lump.size === 0).map(lump => lump.name);
  if (!maps.length && !allowNoMaps) throw new Error('No classic Doom map markers found');
  return { buffer, lumps, maps: [...new Set(maps)] };
}

export function importWadMap(wad, mapName, { encodeImage, images, sounds = new Map(), menuDefinitions = [] } = {}) {
  const start = wad.lumps.findLastIndex(lump => lump.name === mapName);
  if (start < 0) throw new Error('Map not found');
  const mapLumps = [];
  for (let index = start + 1; index < wad.lumps.length && !wad.maps.includes(wad.lumps[index].name); index++) mapLumps.push(wad.lumps[index]);
  const textMap = mapLumps.find(lump => lump.name === 'TEXTMAP');
  let source, data;
  if (textMap) {
    if (textMap.size > 16 * 1024 * 1024) throw new Error('UDMF TEXTMAP exceeds 16 MiB');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(wad.buffer, textMap.start, textMap.size));
    source = parseUDMF(text);
    data = udmfRecords(source);
  } else if (mapLumps.some(lump => lump.name === 'BEHAVIOR')) throw new Error('Hexen-format binary maps are not supported');
  function records(lumpName, recordSize) {
    const lump = mapLumps.find(item => item.name === lumpName);
    if (!lump || lump.size % recordSize !== 0) throw new Error(`Missing or malformed ${lumpName}`);
    const limits = { VERTEXES: 20000, LINEDEFS: 20000, SIDEDEFS: 40000, SECTORS: 20000, THINGS: 5000 };
    if (lump.size / recordSize > limits[lumpName]) throw new Error(`${lumpName} exceeds editor geometry limits`);
    return Array.from({ length: lump.size / recordSize }, (_, index) => new DataView(wad.buffer, lump.start + index * recordSize, recordSize));
  }
  const lumpText = (view, offset) => doomName(new Uint8Array(view.buffer, view.byteOffset + offset, 8));
  if (!data) data = {
    vertices: records('VERTEXES', 4).map(view => ({ x: view.getInt16(0, true), y: view.getInt16(2, true) })),
    sectors: records('SECTORS', 26).map(view => ({ floorHeight: view.getInt16(0, true), ceilingHeight: view.getInt16(2, true),
      floor: lumpText(view, 4), ceiling: lumpText(view, 12), light: view.getInt16(20, true),
      special: view.getUint16(22, true), tag: view.getUint16(24, true) })),
    sides: records('SIDEDEFS', 30).map(view => ({ sector: view.getUint16(28, true), offsetX: view.getInt16(0, true),
      offsetY: view.getInt16(2, true), upper: lumpText(view, 4), lower: lumpText(view, 12), middle: lumpText(view, 20) })),
    lines: records('LINEDEFS', 14).map(view => ({ a: view.getUint16(0, true), b: view.getUint16(2, true),
      right: view.getUint16(10, true) === 65535 ? -1 : view.getUint16(10, true),
      left: view.getUint16(12, true) === 65535 ? -1 : view.getUint16(12, true), flags: view.getUint16(4, true),
      special: view.getUint16(6, true), tag: view.getUint16(8, true) })),
    things: records('THINGS', 10).map(view => ({ type: view.getUint16(6, true), flags: view.getUint16(8, true),
      x: view.getInt16(0, true), y: view.getInt16(2, true), angle: view.getInt16(4, true), elevation: 0 })),
  };
  const { vertices, lines, sides, sectors, things } = data;
  const assets = encodeImage ? createDoomAssets(wad, encodeImage, images) : null;
  const material = (name, kind) => assets?.get(name, kind) || null;
  const project = createProject();
  project.title = `${mapName} - imported WAD`;
  if (source) project.importSource = { format: 'udmf', mapName, ...source };
  project.map.vertices = vertices.map((vertex, index) => ({ id: `v${index}`, x: vertex.x, y: -vertex.y }));
  project.map.sectors = sectors.map((record, index) => {
    const { floor, ceiling } = record;
    return {
      id: `sector${index}`, floorHeight: record.floorHeight, ceilingHeight: record.ceilingHeight,
      floorAsset: material(floor, 'flat'), ceilingAsset: ceiling === 'F_SKY1' ? null : material(ceiling, 'flat'),
      sky: ceiling === 'F_SKY1', light: Math.max(0, Math.min(255, record.light)),
      special: record.special, tag: record.tag,
    };
  });
  function side(index) {
    if (index === -1) return null;
    if (index < 0 || index >= sides.length) throw new Error('Linedef references an invalid sidedef');
    const record = sides[index], sector = record.sector;
    if (sector < 0 || sector >= sectors.length) throw new Error('Sidedef references an invalid sector');
    return {
      sectorId: `sector${sector}`, offsetX: record.offsetX, offsetY: record.offsetY,
      upper: material(record.upper, 'texture'), lower: material(record.lower, 'texture'),
      middle: material(record.middle, 'texture'),
    };
  }
  project.map.walls = lines.map((record, index) => {
    const { a, b } = record;
    if (a < 0 || b < 0 || a >= vertices.length || b >= vertices.length) throw new Error('Linedef references an invalid vertex');
    const right = side(record.right), left = side(record.left);
    const sector = project.map.sectors.find(sector => sector.id === (right || left)?.sectorId);
    return {
      id: `w${index}`, a: `v${a}`, b: `v${b}`, right, left, flags: record.flags,
      special: record.special || 0, tag: record.tag || 0, ...(source ? { specialFormat: 'zdoom', args: record.args } : {}),
      color: '#9aa3ab', height: sector ? Math.max(8, Math.min(4096, sector.ceilingHeight - sector.floorHeight)) : 128,
      solid: !left || !right || Boolean(record.flags & 1),
    };
  }).filter(wall => {
    const a = project.map.vertices[Number(wall.a.slice(1))], b = project.map.vertices[Number(wall.b.slice(1))];
    return a.x !== b.x || a.y !== b.y;
  });
  let playerFound = false, unknownThings = 0, lightCount = 0;
  project.map.entities = things.flatMap((record, index) => {
    const { type, flags } = record;
    if (type !== 1 && (!(flags & 7) || (flags & 16) || [2, 3, 4, 11].includes(type))) return [];
    const isPlayer = type === 1 && !playerFound;
    if (type === 1 && playerFound) return [];
    if (isPlayer) playerFound = true;
    const mapping = doomThings[type];
    const spriteAsset = !isPlayer && mapping ? assets?.sprite(mapping[0]) || null : null;
    if (!isPlayer && !mapping) unknownThings++;
    const entity = {
      id: `thing${index}`, name: isPlayer ? 'Player start' : `${mapping?.[0] || 'Doom thing'} ${type}`,
      type: isPlayer ? 'player' : mapping?.[1] || 'decoration', doomType: type,
      x: record.x, y: -record.y, angle: -record.angle, spriteAsset, ...(source ? { elevation: record.elevation } : {}),
      ...(mapping?.[1] === 'enemy' ? { ambush: Boolean(flags & 8) } : {}),
      ...(!isPlayer ? { skillMask: flags & 7 } : {}),
    };
    if (entity.type === 'light' && lightCount++ < 16) entity.light = { color: '#ffbd72', intensity: 1, radius: 192 };
    return [entity];
  });
  if (!playerFound) throw new Error('Map has no player-one start');
  const warnings = [
    'Playable native weapons, enemy combat, sound, HUD, classic door/lift/floor specials and sprite animations use editable Engine rules, not a Doom-compatible simulation yet. Unsupported linedef specials are listed separately.',
    'Eight-way sprite views, mirrored patches, gunfire wake-up and directional chase are imported. Combat remains an editable approximation, not exact Doom actor/weapon state machines; BFG spray and specialized monster abilities remain to be translated.',
    'Single-player skill flags are retained; New Game difficulty selects placement at runtime. Unknown thing types appear as colored placeholders.',
  ];
  if (source) {
    warnings.push(`UDMF ${source.namespace} geometry imported natively. Original global/block properties are retained in importSource as an import snapshot, not live gameplay state. Later visual edits change native map data, not that snapshot.`);
    if (sectors.some(sector => sector.light < 0 || sector.light > 255)) warnings.push('UDMF lightlevel values outside 0-255 are clamped for the current renderer; original values are preserved in importSource.');
    const unsupported = new Set();
    const supported = {
      vertex: ['x', 'y'], linedef: ['v1', 'v2', 'sidefront', 'sideback', 'blocking', 'blockplayers', 'blockeverything', 'dontpegtop', 'dontpegbottom', 'twosided'],
      sidedef: ['sector', 'offsetx', 'offsety', 'texturetop', 'texturebottom', 'texturemiddle'],
      sector: ['heightfloor', 'heightceiling', 'texturefloor', 'textureceiling', 'lightlevel'],
      thing: ['x', 'y', 'angle', 'height', 'type', 'skill1', 'skill2', 'skill3', 'skill4', 'skill5', 'single', 'coop', 'dm'],
    };
    for (const block of source.blocks) for (const key of Object.keys(block.properties)) {
      if (!supported[block.type]?.includes(key)) unsupported.add(`${block.type}.${key}`);
    }
    if (unsupported.size) warnings.push(`UDMF properties preserved but not simulated/rendered: ${[...unsupported].sort().join(', ')}. Specials, slopes, 3D floors, per-surface transforms and custom actor behavior require further native compatibility work.`);
    if (mapLumps.some(lump => ['BEHAVIOR', 'SCRIPTS', 'DIALOGUE'].includes(lump.name))) warnings.push('This UDMF map contains ACS/dialogue lumps; they are not executed by the current native runtime.');
  }
  for (const sector of project.map.sectors) {
    const boundaries = project.map.walls.filter(wall => wall.right?.sectorId !== wall.left?.sectorId &&
      (wall.right?.sectorId === sector.id || wall.left?.sectorId === sector.id));
    const directed = new Set(), balance = new Map();
    for (const wall of boundaries) {
      const forward = wall.right?.sectorId === sector.id;
      const a = project.map.vertices[Number((forward ? wall.a : wall.b).slice(1))];
      const b = project.map.vertices[Number((forward ? wall.b : wall.a).slice(1))];
      const from = `${a.x},${a.y}`, to = `${b.x},${b.y}`, key = `${from}/${to}`;
      if (directed.has(key)) continue;
      directed.add(key);
      balance.set(from, (balance.get(from) || 0) + 1);
      balance.set(to, (balance.get(to) || 0) - 1);
    }
    if (boundaries.length > 0 && (directed.size < 3 || [...balance.values()].some(value => value !== 0))) {
      sector.wallsOnly = true;
      warnings.push(`${sector.id} has an open or non-polygon boundary (${boundaries.length} lines); retained its walls and metadata but omitted floor/ceiling surfaces.`);
    }
  }
  if (assets) {
    const mapNumber = Number(mapName.match(/\d+$/)?.[0] || 1);
    const skyName = mapName.startsWith('MAP') ? `SKY${mapNumber <= 11 ? 1 : mapNumber <= 20 ? 2 : 3}` : `SKY${mapName[1]}`;
    if (assets.has(skyName)) { project.environment.skyAsset = assets.get(skyName, 'sky'); project.environment.skyMode = 'doom'; }
    for (const prefix of ['PUNG', 'PISG', 'SHTG', 'SHT2', 'CHGG', 'MISG', 'PLSG', 'BFGG', 'SAWG']) assets.sprite(prefix, 'weapon');
    project.environment.weaponAsset = assets.assets.find(asset => asset.name.startsWith('PISG'))?.id || null;
    project.assets = assets.assets;
  } else warnings.push('No image encoder supplied: imported geometry and sector lighting only, without textures or sprites.');
  if (unknownThings) warnings.push(`${unknownThings} unmapped things use placeholders.`);
  if (lightCount > 16) warnings.push(`${lightCount} lamp sprites imported; only the first 16 emit added point light. Sector lighting is preserved throughout.`);
  project.events = [];
  for (const [name, src] of sounds) {
    const existing = project.assets?.find(asset => asset.kind === 'sound' && asset.name === name);
    if (existing) existing.src = src;
    else {
      project.assets ||= [];
      project.assets.push({ id: `package_sound_${project.assets.length}`, name, kind: 'sound', src });
    }
  }
  installEngineScripts(project, { includeHUD: false });
  installWorldScripts(project, warnings);
  const generatedSounds = project.assets.filter(asset => asset.kind === 'sound' && asset.generated).length;
  if (generatedSounds) warnings.push(`${generatedSounds} missing standard combat sounds use generated OpenDLE fallback effects, editable as sound assets.`);
  if (assets) importDoomHUD(project, assets);
  else installDefaultHUD(project);
  installDoomInventoryScripts(project);
  if (assets) installSpriteAnimations(project, assets);
  const definitions = wad.lumps.filter(lump => lump.name === 'MENUDEF').map(lump => ({
    name: 'WAD MENUDEF', source: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(wad.buffer, lump.start, lump.size)),
  }));
  installGameMenu(project, assets, [...definitions, ...menuDefinitions], warnings);
  if (wad.lumps.some(lump => lump.name.startsWith('D_'))) warnings.push('Doom MUS/MIDI music is not synthesized yet; music controls apply to browser-decodable tracks only.');
  warnings.push('Menus are editable HUD/events. MENUDEF support is partial: custom menu classes, arbitrary CVARs/commands, savegames, episode/map progression and exact Nightmare respawn/fast states are not translated yet.');
  if (assets) warnings.push(...assets.warnings);
  const unsupported = [...new Set(project.map.entities.filter(entity => entity.type === 'pickup' &&
    [2022, 2023, 2024, 2025, 2026, 2045].includes(entity.doomType)).map(entity => entity.doomType))];
  if (unsupported.length) warnings.push(`Power-up effects are not imported for Doom thing types ${unsupported.join(', ')}; these objects remain visible until scripted.`);
  validateProject(project);
  return { project, warnings };
}
