import { removeScriptletSheet, scriptletRuleCount } from '../shared/scriptlets.js';

export const SPRAY_SHEET = 'Spray (CS-style)';

export function installSprayScriptlet(project, { key = 'KeyT', assetId } = {}) {
  const used = new Set([...(project.eventSheets || []).map(item => item.id), ...project.events.map(item => item.id)]);
  const id = name => {
    let result = name, suffix = 1;
    while (used.has(result)) result = `${name}_${suffix++}`;
    used.add(result); return result;
  };
  const existing = (project.eventSheets || []).find(sheet => sheet.name === SPRAY_SHEET);
  const sheet = existing || { id: id('engine_spray'), name: SPRAY_SHEET, section: 'engine', enabled: true, phase: 'afterPhysics' };
  if (!existing) project.eventSheets = [...(project.eventSheets || []), sheet];
  project.events = project.events.filter(event => event.sheetId !== sheet.id);
  const images = (project.assets || []).filter(asset => !['sound', 'music', 'model', 'font'].includes(asset.kind));
  const artwork = images.find(asset => (asset.width || 0) <= 256 && (asset.height || 0) <= 256)?.id || images[0]?.id || '';
  const rule = { id: id('engine_spray_paint'), sheetId: sheet.id, enabled: true, once: false, name: 'spray_paint',
    condition: { type: 'keyPressed', key }, conditions: [],
    actions: [{ type: 'sprayImage', assetId: assetId ?? artwork, distance: 96, size: 40, duration: 30 }] };
  project.events = [...project.events, rule];
  return sheet.id;
}

export function removeSpray(project) {
  return removeScriptletSheet(project, SPRAY_SHEET);
}

export default {
  id: 'spray',
  name: 'Spray (Counter-Strike style)',
  summary: 'Press a key to paint an imported image onto the wall you are looking at.',
  detail: 'Adds the "Spray (CS-style)" engine sheet with one editable rule: "Key pressed" sprays the chosen '
    + 'image onto the wall under the crosshair, where it stays flat against the surface for a while. Pick the '
    + 'image from the action (any PNG, WebP or JPEG imported into the asset library) and rebind the key in the '
    + 'event\'s "Key pressed" condition. The spray fades after the action\'s duration and survives saving.',
  rules: 1,
  install(project) {
    if (!(project.assets || []).some(asset => !['sound', 'music', 'model', 'font'].includes(asset.kind))) {
      throw new Error('Import an image (PNG, WebP or JPEG) into the asset library first: the spray needs artwork to paint.');
    }
    return installSprayScriptlet(project);
  },
  remove: removeSpray,
  installed(project) { return scriptletRuleCount(project, SPRAY_SHEET); },
};
