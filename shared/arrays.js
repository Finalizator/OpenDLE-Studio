/**
 * Arrays: named two-dimensional tables of values that a project owns and its rules read and write.
 *
 * A project's `variables` are single values; an array is a grid of them, indexed by row and column.
 * That is the smallest thing that answers "a board", "a map key", "a dialogue tree" or "a table of
 * per-weapon numbers" without asking a creator to encode two indexes into one integer, which is what
 * they have had to do until now.
 *
 * The grid is stored as rows of cells so that what the designer draws and what the engine reads are
 * the same shape — `cells[row][column]`, first index row — and a save is a plain copy of it. Every
 * cell holds one scalar of the array's own type, so a rule that assigns text into a number grid is
 * refused while the rule is being written rather than at the moment it runs.
 */

/** How many arrays one project may hold, and how big one may get. */
export const MAX_ARRAYS = 32;
export const MAX_ARRAY_ROWS = 256;
export const MAX_ARRAY_COLUMNS = 256;
export const MAX_ARRAY_CELLS = 16384;
export const ARRAY_CELL_TYPES = ['number', 'string'];

/** Array names are variable names: letters, digits, `-` and `_`, and never a prototype key. */
const NAME = /^[a-zA-Z0-9_-]{1,80}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export const isArrayName = name => typeof name === 'string' && NAME.test(name) && !forbidden.has(name);

/** The zero value of an array's cell type, which is what a new cell starts as. */
export const arrayEmptyCell = type => (type === 'string' ? '' : 0);

/** A fresh grid of `rows` x `columns`, every cell empty. */
export function arrayGrid({ rows = 4, columns = 4, type = 'number', fill } = {}) {
  const empty = fill === undefined ? arrayEmptyCell(type) : fill;
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => empty));
}

/**
 * Adds an array to a project, or replaces the grid of one that already exists.
 *
 * Everything is derived from the name, size and type, so there is no second place to keep in step:
 * a resized grid is a new grid, and cells that survive keep their values.
 */
export function setArray(project, name, change = {}) {
  if (!isArrayName(name)) throw new Error(`Invalid array name: ${name}`);
  project.arrays ||= {};
  const current = project.arrays[name] || { type: 'number', cells: arrayGrid({}) };
  const type = change.type ?? current.type;
  if (!ARRAY_CELL_TYPES.includes(type)) throw new Error(`Unknown array cell type: ${type}`);
  const rows = clampInt(change.rows ?? current.cells.length, 1, MAX_ARRAY_ROWS, 'rows');
  const columns = clampInt(change.columns ?? (current.cells[0]?.length || 1), 1, MAX_ARRAY_COLUMNS, 'columns');
  if (rows * columns > MAX_ARRAY_CELLS) throw new Error(`An array holds at most ${MAX_ARRAY_CELLS} cells`);
  const cells = arrayGrid({ rows, columns, type });
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const value = change.cells?.[row]?.[column] ?? current.cells[row]?.[column];
    if (typeof value === typeof arrayEmptyCell(type)) cells[row][column] = value;
  }
  project.arrays[name] = { type, cells };
  return project.arrays[name];
}

/** Sets one cell, refusing a value of the wrong type for the grid it lands in. */
export function setArrayCell(project, name, row, column, value) {
  const array = project.arrays?.[name];
  if (!array) throw new Error(`Unknown array: ${name}`);
  checkIndex(array, row, column, name);
  if (typeof value !== array.type) throw new Error(`Array "${name}" holds ${array.type}s, not ${typeof value}`);
  array.cells[row][column] = value;
}

export function removeArray(project, name) {
  if (!project.arrays || !Object.hasOwn(project.arrays, name)) return false;
  delete project.arrays[name];
  return true;
}

function clampInt(value, min, max, label) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) throw new Error(`Array ${label} must be a number`);
  return Math.min(max, Math.max(min, number));
}

function checkIndex(array, row, column, name) {
  const rows = array.cells.length, columns = array.cells[0]?.length || 0;
  if (!Number.isInteger(row) || row < 0 || row >= rows)
    throw new Error(`Array "${name}" has ${rows} rows; ${row} is outside it`);
  if (!Number.isInteger(column) || column < 0 || column >= columns)
    throw new Error(`Array "${name}" has ${columns} columns; ${column} is outside it`);
}

/** The running copy of every array, which rules read and write. */
export function createArrayState(project) {
  const state = {};
  for (const [name, array] of Object.entries(project.arrays || {})) state[name] = array.cells.map(row => [...row]);
  return state;
}

/**
 * Reads a cell from the live arrays, falling back to the authored grid when there is no game
 * running (the designer's preview reads values before Play).
 */
export function readArrayCell(arrays, name, row, column) {
  const array = arrays?.[name];
  if (!array) throw new Error(`Unknown array: ${name}`);
  const table = Array.isArray(array) ? array : array.cells;
  const r = Math.trunc(Number(row)) || 0, c = Math.trunc(Number(column)) || 0;
  if (!table[r] || c < 0 || c >= table[r].length || r < 0)
    throw new Error(`Array "${name}" has no cell at row ${r}, column ${c}`);
  return table[r][c];
}

export function arrayShape(arrays, name) {
  const array = arrays?.[name];
  if (!array) throw new Error(`Unknown array: ${name}`);
  const table = Array.isArray(array) ? array : array.cells;
  return { rows: table.length, columns: table[0]?.length || 0, type: Array.isArray(array) ? null : array.type };
}

/** How many rules name an array, so deleting one that something still reads can be refused. */
export function arrayReferences(project, name) {
  let count = 0;
  const mentions = value => typeof value === 'string' && new RegExp(`array\\s*\\(\\s*"${escapeRegExp(name)}"`).test(value);
  const scan = holder => {
    for (const event of holder.events || []) {
      const commands = [event.condition, ...(event.conditions || []), ...(event.actions || [])].filter(Boolean);
      for (const command of commands) {
        if (command.array === name) count++;
        for (const value of Object.values(command)) {
          if (mentions(value?.expr)) count++;
        }
      }
    }
  };
  scan(project);
  for (const scene of project.scenes || []) scan(scene);
  return count;
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Validates `project.arrays`. Called from `validateProject` with its own `assert`. */
export function validateArrays(arrays, assert) {
  if (arrays === undefined) return;
  assert(arrays && typeof arrays === 'object' && !Array.isArray(arrays), 'Arrays must be a record of named arrays');
  const names = Object.keys(arrays);
  assert(names.length <= MAX_ARRAYS, `A project holds at most ${MAX_ARRAYS} arrays`);
  for (const [name, array] of Object.entries(arrays)) {
    assert(isArrayName(name), `Invalid array name: ${name}`);
    assert(array && typeof array === 'object' && !Array.isArray(array), `Array ${name} must be an object`);
    assert(ARRAY_CELL_TYPES.includes(array.type), `Array ${name} has an unknown cell type`);
    assert(Array.isArray(array.cells) && array.cells.length >= 1 && array.cells.length <= MAX_ARRAY_ROWS,
      `Array ${name} must have 1-${MAX_ARRAY_ROWS} rows`);
    const columns = array.cells[0]?.length;
    assert(Number.isInteger(columns) && columns >= 1 && columns <= MAX_ARRAY_COLUMNS,
      `Array ${name} must have 1-${MAX_ARRAY_COLUMNS} columns`);
    assert(array.cells.length * columns <= MAX_ARRAY_CELLS, `Array ${name} holds more than ${MAX_ARRAY_CELLS} cells`);
    for (const row of array.cells) {
      assert(Array.isArray(row) && row.length === columns, `Array ${name} rows must all be ${columns} cells wide`);
      for (const cell of row) {
        assert(typeof cell === array.type, `Array ${name} cells must be ${array.type}s`);
        if (array.type === 'number') assert(Number.isFinite(cell) && Math.abs(cell) <= 1e12,
          `Array ${name} numbers must be finite and within +/-1e12`);
        else assert(cell.length <= 4096, `Array ${name} text cells hold at most 4096 characters`);
      }
    }
  }
}
