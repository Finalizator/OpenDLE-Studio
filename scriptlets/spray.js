import { findScriptletSheet, installScriptletRules, removeScriptletSheet, scriptletRuleCount } from '../shared/scriptlets.js';
import { isImageAsset } from '../shared/media-assets.js';

export const SPRAY_SHEET = 'Spray (CS-style)';
const ID = 'spray';

export function installSprayScriptlet(project, { key = 'KeyT', assetId } = {}) {
  const images = (project.assets || []).filter(isImageAsset);
  const artwork = images.find(asset => (asset.width || 0) <= 256 && (asset.height || 0) <= 256)?.id || images[0]?.id || '';
  const rule = { id: 'engine_spray_paint', name: 'spray_paint',
    condition: { type: 'keyPressed', key }, conditions: [],
    actions: [{ type: 'sprayImage', assetId: assetId ?? artwork, distance: 96, size: 40, duration: 30 }] };
  return installScriptletRules(project, { id: ID, name: SPRAY_SHEET, sheetId: 'engine_spray' }, [rule]);
}

export function removeSpray(project) {
  return removeScriptletSheet(project, SPRAY_SHEET, ID);
}

export default {
  id: ID,
  name: 'Spray (Counter-Strike style)',
  summary: 'Press a key to paint an imported image onto the wall you are looking at.',
  detail: 'Adds the "Spray (CS-style)" engine sheet with one editable rule: "Key pressed" sprays the chosen '
    + 'image onto the wall under the crosshair, where it stays flat against the surface for a while. Pick the '
    + 'image from the action (any PNG, WebP or JPEG imported into the asset library) and rebind the key in the '
    + 'event\'s "Key pressed" condition. The spray fades after the action\'s duration and survives saving.',
  rules: 1,
  install(project) {
    if (!(project.assets || []).some(isImageAsset)) {
      throw new Error('Import an image (PNG, WebP or JPEG) into the asset library first: the spray needs artwork to paint.');
    }
    return installSprayScriptlet(project);
  },
  remove: removeSpray,
  installed(project) { return scriptletRuleCount(project, SPRAY_SHEET, ID); },
  present(project) { return Boolean(findScriptletSheet(project, SPRAY_SHEET, ID)); },
};
