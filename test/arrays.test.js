import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import {
  MAX_ARRAY_CELLS, MAX_ARRAYS, arrayGrid, arrayReferences, arrayShape, createArrayState, isArrayName,
  readArrayCell, removeArray, setArray, setArrayCell, validateArrays,
} from '../shared/arrays.js';
import { evaluateExpression, expressionContext } from '../shared/expressions.js';
import { commandFields } from '../shared/command-fields.js';

/** A project with one numeric grid and one text grid, holding a couple of authored values. */
function fixture() {
  const project = createProject();
  setArray(project, 'board', { rows: 3, columns: 4 });
  setArray(project, 'labels', { rows: 2, columns: 2, type: 'string' });
  project.arrays.board.cells[1][2] = 7;
  project.arrays.labels.cells[0][1] = 'Bob';
  project.events.push({ id: 'arrays_rule', enabled: true, once: false, condition: { type: 'onStart' },
    actions: [
      { type: 'setArrayCell', array: 'board', row: 0, column: 0, value: { expr: 'global("score") + 5' } },
      { type: 'addToArrayCell', array: 'board', row: 1, column: 2, value: 3 },
    ] });
  project.variables.score = 10;
  return project;
}

test('an array is a grid whose size, type and cells are one piece of data', () => {
  const project = createProject();
  const array = setArray(project, 'board', { rows: 3, columns: 4 });
  assert.equal(array.type, 'number', 'a grid is numbers unless it says otherwise');
  assert.deepEqual(array.cells, arrayGrid({ rows: 3, columns: 4 }), 'a new grid starts empty');
  assert.deepEqual(arrayShape(project.arrays, 'board'), { rows: 3, columns: 4, type: 'number' });

  // Resizing keeps what fits: adding a row and a column must not lose the values already typed.
  setArrayCell(project, 'board', 1, 2, 9);
  setArray(project, 'board', { rows: 4, columns: 5 });
  assert.equal(project.arrays.board.cells.length, 4, 'four rows after the resize');
  assert.equal(project.arrays.board.cells[0].length, 5, 'five columns');
  assert.equal(project.arrays.board.cells[1][2], 9, 'and the cell that was inside the old grid kept its value');

  // A text grid holds text and refuses a number cell value.
  setArray(project, 'labels', { rows: 1, columns: 2, type: 'string' });
  setArrayCell(project, 'labels', 0, 1, 'ok');
  assert.throws(() => setArrayCell(project, 'labels', 0, 0, 5), /holds strings, not number/);
  assert.throws(() => setArrayCell(project, 'board', 9, 0, 1), /has 4 rows; 9 is outside it/);
  assert.throws(() => setArrayCell(project, 'board', 0, 9, 1), /has 5 columns; 9 is outside it/);

  assert.ok(isArrayName('board_2'), 'a name of letters, digits and underscores');
  assert.ok(!isArrayName('__proto__'), 'but never a prototype key');
  assert.ok(!isArrayName('has space'), 'and never with a space');
  assert.ok(!isArrayName(''), 'and never empty');
});

test('a project validates its arrays, and a broken grid is refused with a reason', () => {
  const project = fixture();
  validateProject(project);

  const ragged = structuredClone(project);
  ragged.arrays.board.cells[0].pop();
  assert.throws(() => validateProject(ragged), /rows must all be 3 cells wide/, 'the first row sets the width');

  const wrongType = structuredClone(project);
  wrongType.arrays.board.cells[0][0] = 'text';
  assert.throws(() => validateProject(wrongType), /cells must be numbers/);

  const empty = structuredClone(project);
  empty.arrays.board.cells = [];
  assert.throws(() => validateProject(empty), /must have 1-256 rows/);

  const badName = structuredClone(project);
  badName.arrays['bad name'] = { type: 'number', cells: [[1]] };
  assert.throws(() => validateProject(badName), /Invalid array name/);

  const huge = structuredClone(project);
  huge.arrays.huge = { type: 'number', cells: Array.from({ length: 256 }, () => new Array(256).fill(0)) };
  assert.throws(() => validateProject(huge), new RegExp(`more than ${MAX_ARRAY_CELLS} cells`));

  const many = structuredClone(project);
  for (let index = 0; index < MAX_ARRAYS; index++) many.arrays[`extra${index}`] = { type: 'number', cells: [[0]] };
  assert.throws(() => validateProject(many), new RegExp(`at most ${MAX_ARRAYS} arrays`));

  // And the module's own validator refuses the same shapes when it is called directly.
  assert.throws(() => validateArrays({ grid: { type: 'colour', cells: [[1]] } }, assert.ok.bind(assert)), /unknown cell type/);
});

test('a rule writes a cell with a computed value, and an expression reads it back', () => {
  const project = fixture();
  validateProject(project);
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  // Play starts from the authored grids, not from whatever the last run left behind.
  assert.equal(readArrayCell(state.arrays, 'board', 0, 0), 0);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(readArrayCell(state.arrays, 'board', 0, 0), 15, 'the expression value landed in the cell');
  assert.equal(readArrayCell(state.arrays, 'board', 1, 2), 10, 'and the counter added to what was authored');
  // The project itself is untouched: Play is a copy, the same contract variables have.
  assert.equal(project.arrays.board.cells[0][0], 0);
  assert.equal(project.arrays.board.cells[1][2], 7);

  const context = expressionContext(project, project.events.at(-1), state);
  assert.equal(evaluateExpression({ expr: 'array("board", 0, 0)' }, context), 15);
  assert.equal(evaluateExpression({ expr: 'array("board", 1, 2)' }, context), 10);
  assert.equal(evaluateExpression({ expr: 'arrayrows("board")' }, context), 3);
  assert.equal(evaluateExpression({ expr: 'arraycolumns("board")' }, context), 4);
  assert.equal(evaluateExpression({ expr: 'array("labels", 0, 1)' }, context), 'Bob', 'a text grid reads text');
  assert.throws(() => evaluateExpression({ expr: 'array("board", 9, 0)' }, context), /no cell at row 9/);
  assert.throws(() => evaluateExpression({ expr: 'array("missing", 0, 0)' }, context), /Unknown array/);
});

test('array reads are validated with the project, so a typo is refused while it is being written', () => {
  const unknownArray = fixture();
  unknownArray.events.at(-1).actions[0].array = 'nope';
  assert.throws(() => validateProject(unknownArray), /unknown array/i);

  const rowOutside = fixture();
  rowOutside.events.at(-1).actions[0].row = 9;
  assert.throws(() => validateProject(rowOutside), /whole number inside the 3-row grid/);

  const columnOutside = fixture();
  columnOutside.events.at(-1).actions[0].column = 9;
  assert.throws(() => validateProject(columnOutside), /whole number inside the 4-column grid/);

  const textIntoNumbers = fixture();
  textIntoNumbers.events.at(-1).actions[0].value = 'text';
  assert.throws(() => validateProject(textIntoNumbers), /holds numbers/);

  const addToText = fixture();
  addToText.events.at(-1).actions[1].array = 'labels';
  addToText.events.at(-1).actions[1].row = 0;
  addToText.events.at(-1).actions[1].column = 0;
  assert.throws(() => validateProject(addToText), /Only numeric arrays can be added to/);

  const typoInExpression = fixture();
  typoInExpression.events.at(-1).actions[0].value = { expr: 'array("missing", 0, 0)' };
  assert.throws(() => validateProject(typoInExpression), /Unknown array/);

  const cellOutsideInExpression = fixture();
  cellOutsideInExpression.events.at(-1).actions[0].value = { expr: 'array("board", 0, 99)' };
  assert.throws(() => validateProject(cellOutsideInExpression), /no cell at row 0, column 99/);

  // A computed index is the point of an array, so the name is literal but the indexes need not be.
  const computed = fixture();
  computed.variables.row = 0;
  computed.events.at(-1).actions[0].row = { expr: 'global("row")' };
  validateProject(computed);
});

test('deleting an array a rule still reads is refused, and counting references says why', () => {
  const project = fixture();
  project.events.at(-1).actions[0].value = { expr: 'array("board", 0, 0)' };
  // Both actions name the grid and the rewritten one also reads it, so the count is three.
  assert.equal(arrayReferences(project, 'board'), 3, 'each mention of the grid counts once');
  assert.equal(arrayReferences(project, 'labels'), 0, 'and the grid nothing uses counts zero');

  assert.equal(removeArray(project, 'labels'), true, 'an unused array goes');
  assert.equal(removeArray(project, 'labels'), false, 'and removing it twice is not an error');
  validateProject(project);
  assert.equal(project.arrays.labels, undefined);
});

test('the running copy of an array is a deep copy of the authored grid', () => {
  const project = fixture();
  const state = createArrayState(project);
  state.board[0][0] = 99;
  assert.equal(project.arrays.board.cells[0][0], 0, 'writing the copy cannot reach the project');
  assert.deepEqual(Object.keys(state), ['board', 'labels'], 'every array is present');
});

test('the event dialog offers the project arrays, and an action defaults to the first one', () => {
  const project = fixture();
  const arrays = Object.keys(project.arrays).map(name => [name, name]);
  const fields = commandFields({ type: 'setArrayCell', array: 'board', row: 1, column: 2, value: 0 },
    { entities: [], arrays, variables: [], clips: () => [], images: [] });
  const picker = fields.find(field => field.name === 'array');
  assert.ok(picker, 'the dialog asks which array');
  assert.deepEqual(picker.options, [['board', 'board'], ['labels', 'labels']]);
  assert.deepEqual(fields.filter(field => ['row', 'column', 'value'].includes(field.name)).map(field => field.name),
    ['row', 'column', 'value'], 'and the row, column and value the action needs');
});
