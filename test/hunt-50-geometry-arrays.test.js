// Regressions from the 50-bug hunt: geometry and array boundaries.
//
// Each test states the contract it holds the code to; the comment says what the code did before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createBoxBrush, hollowBrush } from '../shared/brushes.js';
import { setArray, setArrayCell, readArrayCell, createArrayState, validateArrays } from '../shared/arrays.js';

const box = () => {
  const project = createProject();
  return { project, brush: createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, height: 64, depth: 64 }) };
};

test('hunt 50: hollowing a 64 unit box 200 units deep is refused, not turned into six solids', () => {
  const { project, brush } = box();
  // Before: the inner plane of each wall landed past the opposite face, so every "wall" was the
  // whole brush again — six solid copies stacked in the same place, with no error.
  assert.throws(() => hollowBrush(project, brush.id, 200), /too thin to hollow/);
  assert.equal(project.map.brushes.length, 1, 'the brush is left untouched');
  assert.equal(project.map.brushes[0].id, brush.id);
  // Exactly as wide as the brush leaves no cavity either.
  assert.throws(() => hollowBrush(project, brush.id, 64), /too thin to hollow/);
});

test('hunt 50: hollowing just under the brush size keeps a cavity', () => {
  const { project, brush } = box();
  const walls = hollowBrush(project, brush.id, 63);
  assert.equal(walls.length, 6);
  for (const wall of walls) assert.ok(wall.faces.length >= 6, 'each wall is a closed volume');
  assert.equal(project.map.brushes.length, 6);
});

test('hunt 50: an array cell read with a non-numeric index is refused', () => {
  const project = createProject();
  setArray(project, 'grid', { rows: 3, columns: 3 });
  setArrayCell(project, 'grid', 0, 0, 5);
  setArrayCell(project, 'grid', 2, 2, 7);
  const arrays = createArrayState(project);
  // Before: `Math.trunc(Number(row)) || 0` made "abc", null, NaN and true all read row 0, so a rule
  // with a misspelled variable quietly used the first cell instead of reporting the mistake.
  for (const index of ['abc', '', null, NaN, undefined, true, {}]) {
    assert.throws(() => readArrayCell(arrays, 'grid', index, 0), /needs a numeric row/, `row ${String(index)}`);
    assert.throws(() => readArrayCell(arrays, 'grid', 0, index), /needs a numeric column/, `column ${String(index)}`);
  }
  // Numbers and numeric strings still work, and fractions still truncate toward zero.
  assert.equal(readArrayCell(arrays, 'grid', 2.9, 2.9), 7);
  assert.equal(readArrayCell(arrays, 'grid', '2', '2'), 7);
  assert.throws(() => readArrayCell(arrays, 'grid', 3, 0), /no cell/);
});

test('hunt 50: a number grid refuses values no save could hold', () => {
  const project = createProject();
  setArray(project, 'grid', { rows: 2, columns: 2 });
  // Before: `typeof NaN === 'number'` let it through, and the value then failed validation on the
  // next save of the project, which is a level that cannot be saved after one bad division.
  for (const value of [NaN, Infinity, -Infinity, 1e13]) {
    assert.throws(() => setArrayCell(project, 'grid', 0, 0, value), /finite numbers/, String(value));
  }
  assert.equal(project.arrays.grid.cells[0][0], 0, 'the cell keeps its value');
  setArrayCell(project, 'grid', 0, 0, -1e12);
  assert.equal(project.arrays.grid.cells[0][0], -1e12);
  assert.doesNotThrow(() => validateArrays(project.arrays, (ok, message) => { if (!ok) throw new Error(message); }));
});

test('hunt 50: a string grid refuses text longer than a save may hold', () => {
  const project = createProject();
  setArray(project, 'names', { rows: 1, columns: 1, type: 'string' });
  assert.throws(() => setArrayCell(project, 'names', 0, 0, 'x'.repeat(4097)), /at most 4096/);
  assert.equal(project.arrays.names.cells[0][0], '');
});
