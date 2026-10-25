import { hudElement, installDefaultHUD, MAX_HUD_ELEMENTS } from './hud.js';
import { sectorAt } from './sectors.js';
import { nextGameLevel } from './game-levels.js';
import { setGameScreen } from './game-settings.js';
import { playerReachesEntity } from './combat.js';

const itemTypes = new Set([2013, 2014, 2015, 2022, 2023, 2024, 2025, 2026, 2045, 83]);
const countsKill = entity => entity.type === 'enemy' && entity.doomType !== 3006;
const countsItem = entity => entity.type === 'pickup' && (entity.doomType === undefined || itemTypes.has(entity.doomType));
const secretSector = sector => sector.special === 9 || sector.special >= 32 && Boolean(sector.special & 128);
const fields = ['level', 'kills', 'items', 'secrets', 'time', 'next'];
const variable = field => `intermission_${field}`;

export function createLevelStatistics(entities, sectors) {
  return {
    enemies: new Set(entities.filter(entity => countsKill(entity) && (entity.health ?? 20) > 0).map(entity => entity.id)),
    pickups: new Set(entities.filter(countsItem).map(entity => entity.id)),
    secretSectors: new Set(sectors.filter(secretSector).map(sector => sector.id)),
    kills: new Set(), items: new Set(), secrets: new Set(),
  };
}

export function updateLevelStatistics(state) {
  const stats = state.levelStatistics;
  for (const entity of state.entities) {
    if (stats.enemies.has(entity.id) && entity.health <= 0) stats.kills.add(entity.id);
  }
  const sector = sectorAt(state.sectors, state.player.x, state.player.y);
  if (sector && stats.secretSectors.has(sector.id)) stats.secrets.add(sector.id);
}

export function recordRemovedEntity(state, entity) {
  if (!entity) return;
  const stats = state.levelStatistics;
  if (stats.enemies.has(entity.id) && entity.health <= 0) stats.kills.add(entity.id);
  if (stats.pickups.has(entity.id) && state.playerStats.health > 0 && playerReachesEntity(state, entity, 40, 56, 8)) stats.items.add(entity.id);
}

export function beginIntermission(project, state, secret = false) {
  if (state.intermission) return;
  updateLevelStatistics(state);
  const stats = state.levelStatistics;
  const level = project.game?.levels.find(level => level.id === project.game.active);
  const levelId = nextGameLevel(project.game, secret);
  const next = project.game?.levels.find(level => level.id === levelId);
  const seconds = Math.floor(state.time);
  const values = {
    level: `${level?.name || level?.id || project.title} finished`,
    kills: `${stats.kills.size} / ${stats.enemies.size}`,
    items: `${stats.items.size} / ${stats.pickups.size}`,
    secrets: `${stats.secrets.size} / ${stats.secretSectors.size}`,
    time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    next: next ? `Entering ${next.name || next.id}` : project.game ? 'Campaign complete' : 'Level complete',
  };
  state.intermission = { levelId, values, confirmed: false };
  for (const field of fields) if (Object.hasOwn(state.variables, variable(field))) state.variables[variable(field)] = values[field];
  state.message = `${values.level} — Kills ${values.kills}, Items ${values.items}, Secrets ${values.secrets}, Time ${values.time}`;
  state.messageTime = 10;
  setGameScreen(state, 'intermission');
}

export function continueIntermission(state) {
  const intermission = state.intermission;
  if (state.gameScreen !== 'intermission' || !intermission || intermission.confirmed) return;
  intermission.confirmed = true;
  if (intermission.levelId) state.menuRequests.push({ type: 'level', levelId: intermission.levelId, carryProgress: true });
  else {
    state.menuRequests.push('complete');
    setGameScreen(state, 'title');
  }
}

export function installIntermission(project, assets, { compact = project.hud?.elements.length > MAX_HUD_ELEMENTS - 32 } = {}) {
  if (project.eventSheets.some(sheet => sheet.id === 'intermission_sheet')) return project;
  if (project.gameMenus) project.gameMenus.elementIds ||= [];
  if (project.gameMenus && !project.gameMenus.screens.includes('intermission')) project.gameMenus.screens.push('intermission');
  if (!project.hud) installDefaultHUD(project);
  for (const field of fields) project.variables[variable(field)] = '';
  const hud = project.hud, sx = hud.width / 320, sy = hud.height / 200;
  const used = new Set([...project.events, ...project.eventGroups, ...project.eventSheets, ...hud.elements,
    ...hud.fonts, ...hud.animations, ...project.assets, ...Object.values(project.map).filter(Array.isArray).flat()].map(item => item.id));
  let sequence = 0;
  const id = () => { let value; do { value = `intermission_${sequence++}`; } while (used.has(value)); used.add(value); return value; };
  const sheet = { id: 'intermission_sheet', name: 'Level intermission', section: 'game', phase: 'interface', enabled: true };
  project.eventSheets.push(sheet);
  const screen = { type: 'gameScreen', screen: 'intermission' };
  const rule = (name, condition, actions, conditions = []) => project.events.push({
    id: id(), name, sheetId: sheet.id, enabled: true, once: false, condition, conditions, actions,
  });
  function element(type, name, x, y, width, height, extra = {}) {
    const item = { ...hudElement(id(), type, name), x: x * sx, y: y * sy, width: width * sx, height: height * sy,
      fontSize: 10 * sy, z: 9500, visible: false, background: '#00000000', ...extra };
    hud.elements.push(item);
    if (project.gameMenus && !project.gameMenus.elementIds.includes(item.id)) project.gameMenus.elementIds.push(item.id);
    rule(`Hide ${name}`, { type: 'always' }, [{ type: 'setHUDVisible', elementId: item.id, visible: 'no' }]);
    rule(`Show ${name}`, screen, [{ type: 'setHUDVisible', elementId: item.id, visible: 'yes' }]);
    return item;
  }
  function art(name) {
    if (!assets?.has(name)) return null;
    const assetId = assets.get(name, 'sprite');
    const asset = project.assets.find(asset => asset.id === assetId) || assets.assets?.find(asset => asset.id === assetId);
    if (asset && !project.assets.some(item => item.id === assetId)) project.assets.push(asset);
    return asset;
  }
  element('panel', 'Intermission letterbox', 0, 0, 0, 0,
    { anchors: { left: 0, right: 1, top: 0, bottom: 1 }, background: '#000000ff' });
  const frame = element('panel', 'Intermission canvas', -160, -100, 320, 200,
    { anchors: { left: .5, right: .5, top: .5, bottom: .5 } });
  const mapName = project.game?.active || project.importSource?.mapName || project.title;
  const episode = /^E(\d)M(\d)/i.exec(mapName), map = /^MAP(\d\d)/i.exec(mapName);
  const background = (episode && art(`WIMAP${Number(episode[1]) - 1}`)) || art('INTERPIC');
  element(background ? 'image' : 'panel', 'Intermission background', 0, 0, 320, 200,
    { parentId: frame.id, ...(background ? { assetId: background.id } : { background: '#241c18ff' }) });
  const font = hud.fonts.find(font => font.name === 'Imported menu small font');
  const text = (name, x, y, width, content, extra = {}) => element('text', name, x, y, width, 14,
    { parentId: frame.id, text: content, ...(font ? { fontId: font.id, fontSize: font.cellHeight * sy } : {}), ...extra });
  const levelArt = episode ? art(`WILV${Number(episode[1]) - 1}${Number(episode[2]) - 1}`)
    : map ? art(`CWILV${String(Number(map[1]) - 1).padStart(2, '0')}`) : null;
  if (levelArt) element('image', 'Finished level artwork', (320 - levelArt.width) / 2, 8, levelArt.width, levelArt.height,
    { parentId: frame.id, assetId: levelArt.id });
  else text('Finished level', 12, 12, 296, `{var:${variable('level')}}`, { align: 'center' });
  const finishedArt = !compact && art('WIF');
  if (finishedArt) element('image', 'Finished artwork', (320 - finishedArt.width) / 2, 30, finishedArt.width, finishedArt.height,
    { parentId: frame.id, assetId: finishedArt.id });
  if (compact) {
    text('Intermission statistics', 32, 54, 256,
      `Kills: {var:intermission_kills}\n\nItems: {var:intermission_items}\n\nSecrets: {var:intermission_secrets}\n\nTime: {var:intermission_time}\n\n{var:intermission_next}`,
      { height: 118 * sy });
  } else {
    for (const [field, label, patch, y] of [
    ['kills', 'Kills', 'WIOSTK', 58], ['items', 'Items', 'WIOSTI', 82],
    ['secrets', 'Secrets', 'WISCRT2', 106], ['time', 'Time', 'WITIME', 138],
    ]) {
      const image = art(patch);
      if (image) element('image', `Intermission ${label} artwork`, 32, y, image.width, image.height,
        { parentId: frame.id, assetId: image.id });
      else text(`Intermission ${label} label`, 32, y, 120, label);
      text(`Intermission ${label} value`, 190, y, 98, `{var:${variable(field)}}`, { align: 'right' });
    }
    text('Next level', 12, 160, 296, `{var:${variable('next')}}`, { align: 'center' });
  }
  const button = element('button', 'Continue intermission', 30, 180, 260, 16, { parentId: frame.id,
    text: 'Continue — Enter / Space', fontSize: 8 * sy, ...(font ? { fontId: font.id } : {}) });
  for (const key of ['Enter', 'Space']) rule(`Continue intermission with ${key}`, { type: 'keyPressed', key },
    [{ type: 'continueIntermission' }], [screen]);
  rule('Continue intermission with click', { type: 'hudClicked', elementId: button.id },
    [{ type: 'continueIntermission' }], [screen]);
  return project;
}
