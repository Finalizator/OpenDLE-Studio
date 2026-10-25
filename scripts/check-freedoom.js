import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readWad } from '../shared/wad.js';
import { importWad } from '../server/import.js';
const path = new URL('../Projects/freedoom2.wad', import.meta.url);
const buffer = readFileSync(path);
const maps = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)).maps;
let failures = 0;
for (const map of maps) {
  try {
    const { project, warnings } = importWad(buffer, map);
    assert.equal(project.hud.reserveBottom, 32, 'Classic status-bar viewport reservation');
    assert.equal(project.hud.fonts.length, 2, 'Imported raster digit fonts');
    assert.equal(project.hud.animations.length, 5, 'Editable pain-band face clips');
    assert.ok(project.hud.elements.some(element => element.name === 'WAD status-bar artwork'), 'Original WAD status-bar artwork');
    assert.ok(project.events.some(event => event.actions.some(action => action.type === 'selectWeapon')), 'Editable weapon selection');
    const omissions = warnings.filter(warning => warning.includes('omitted floor/ceiling'));
    console.log(`${map}: ${project.map.sectors.length} sectors, ${project.assets.length} assets, ${project.hud.elements.length} HUD elements, ${project.hud.fonts.length} digit fonts, ${project.hud.animations.length} face clips${omissions.length ? `; ${omissions.join(' ')}` : ''}`);
  } catch (error) { console.error(`${map}: ${error.message}`); failures++; }
}
console.log(`${maps.length - failures}/${maps.length} maps imported; ${failures} failed.`);
if (failures) process.exitCode = 1;
