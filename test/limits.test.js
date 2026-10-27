import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../shared/limits.js';
import { createProject, validateProject } from '../shared/project.js';

test('import limits are budgets well past the original engine, not Doom limits', () => {
  // The engine is not bound by Doom's own limits: a megawad's geometry and a mod's
  // archive are both far larger than the 1993 originals.
  assert.ok(LIMITS.vertices >= 100000, 'vertex budget');
  assert.ok(LIMITS.walls >= 100000, 'linedef budget');
  assert.ok(LIMITS.sectors >= 65536, 'sector budget');
  assert.ok(LIMITS.entities >= 65536, 'thing budget');
  assert.ok(LIMITS.levels >= 256, 'level budget');
  assert.ok(LIMITS.archiveBytes >= 192 * 1024 * 1024, 'archive budget');
  assert.ok(LIMITS.archiveExpandedBytes > LIMITS.archiveBytes, 'an archive may expand past its own size');
  assert.ok(LIMITS.imageSize >= 4096, 'modern replacement textures are square powers of two, up to 4096');
  assert.ok(LIMITS.imageBytes < LIMITS.imageTotalBytes);
});

test('a map well past the old record limits validates and saves', () => {
  const project = createProject();
  const decoration = { id: 'deco', type: 'decoration', name: 'Barrel', x: 0, y: 0, angle: 0 };
  // 6000 things: the old imports stopped at 5000.
  for (let index = 0; index < 6000; index++) {
    project.map.entities.push({ ...decoration, id: `thing_${index}` });
  }
  assert.doesNotThrow(() => validateProject(project), 'the raised thing budget accepts the map');
});

test('every module takes its limits from shared/limits.js', () => {
  // One place to change a budget, and one number in the message the user sees.
  const files = {
    '../shared/udmf.js': /LIMITS\.udmfTextBytes/,
    '../shared/wad.js': /LIMITS\.archiveBytes/,
    '../shared/doom-assets.js': /LIMITS\.assetPixels/,
    '../server/packages.js': /MAX_BYTES = LIMITS\.archiveBytes/,
    '../public/app.js': /ARCHIVE_LIMIT = LIMITS\.archiveBytes/,
  };
  for (const [file, pattern] of Object.entries(files)) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), pattern, `${file} uses the shared limits`);
  }
});
