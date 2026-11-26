// A Hexen/UDMF line that is not marked repeatable must fire once.
//
// Hexen and UDMF lines carry their own repeatability: `ML_REPEAT_SPECIAL` (0x200) in the binary
// format and `repeatable = true` in UDMF, both false by default. The importer never read either,
// so every translated line here was repeatable — a one-shot line re-lowered its floor, re-ran its
// script and re-fired its teleport for as long as the player stood against it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installWorldScripts } from '../shared/world-motion.js';

function lineWith(fields) {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-128, -64], [0, -64], [0, 64], [-128, 64], [128, -64], [128, 64]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w1', a: 'v1', b: 'v2', right: side('a'), left: side('b'), height: 128, color: '#888888',
      specialFormat: 'zdoom', special: 12, args: [1, 8, 0, 0, 0], activationModes: ['cross'], solid: false, ...fields },
    { id: 'w2', a: 'v2', b: 'v3', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w3', a: 'v3', b: 'v0', right: side('a'), height: 128, color: '#888888', solid: true },
    { id: 'w4', a: 'v1', b: 'v4', right: side('b'), height: 128, color: '#888888', solid: true },
    { id: 'w5', a: 'v4', b: 'v5', right: side('b'), height: 128, color: '#888888', solid: true },
    { id: 'w6', a: 'v5', b: 'v2', right: side('b'), height: 128, color: '#888888', solid: true },
  ];
  project.map.sectors = [
    { id: 'a', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 },
    { id: 'b', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 1 },
  ];
  project.map.entities = [{ ...project.map.entities[0], x: -80, y: 0, angle: 0 }];
  installWorldScripts(project, []);
  validateProject(project);
  return { project, rule: () => project.events.find(event => event.id.startsWith('world_special')) };
}

test('a Hexen line that does not set ML_REPEAT_SPECIAL fires once', () => {
  const { rule } = lineWith({});
  assert.ok(rule(), 'the line has a rule');
  assert.equal(rule().once, true);
});

test('a Hexen line that sets ML_REPEAT_SPECIAL keeps firing', () => {
  const { rule } = lineWith({ repeatable: true });
  assert.equal(rule().once, false);
});

test('a UDMF line reads its own repeatable key', async () => {
  const { parseUDMF, udmfRecords } = await import('../shared/udmf.js');
  const text = `namespace = "ZDoom";
vertex { x = -128; y = -64; }
vertex { x = 0; y = -64; }
vertex { x = 0; y = 64; }
vertex { x = -128; y = 64; }
sector { floorheight = 0; ceilingheight = 128; }
sector { floorheight = 0; ceilingheight = 128; }
sidedef { sector = 0; }
sidedef { sector = 1; }
linedef { v1 = 0; v2 = 1; sidefront = 0; blocking = true; }
linedef { v1 = 1; v2 = 2; sidefront = 0; sideback = 1; special = 12; arg0 = 1; arg1 = 8; playercross = true; }
linedef { v1 = 1; v2 = 2; sidefront = 0; sideback = 1; special = 13; arg0 = 1; repeatable = true; playercross = true; }
`;
  const map = udmfRecords(parseUDMF(text));
  assert.equal(map.lines[1].repeatable, false, 'repeatable is off unless the map says otherwise');
  assert.equal(map.lines[2].repeatable, true);
});
