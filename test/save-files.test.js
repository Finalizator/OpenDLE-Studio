import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { saveFileDocument, serializeSaveFile, parseSaveFile, variableSnapshot, applyVariableSave,
  saveFileName, saveVariableNames, MAX_SAVE_FILE_BYTES, SAVE_FILE_FORMAT, SAVE_FILE_VERSION } from '../shared/save-files.js';

function project() {
  const value = installEngineScripts(createProject(), { includeHUD: false });
  value.events = [];
  value.variables.score = 10;
  value.variables.label = 'start';
  value.variables.flag = false;
  return value;
}
const rule = actions => [{ id: 'save_rule', name: 'Save rule', enabled: true, once: false,
  condition: { type: 'always' }, conditions: [], actions }];
const tick = (value, state, count = 1) => { for (let i = 0; i < count; i++) stepRuntime(value, state, 1 / 35, new Set()); };

test('a variables save file round-trips through its own JSON text', () => {
  const value = project(), state = createRuntime(value);
  state.variables.score = 42;
  const document = saveFileDocument({ kind: 'variables', name: 'slot-1', identity: 'save-v1:abc',
    levelId: 'MAP01', variables: variableSnapshot(value, state) });
  const text = serializeSaveFile(document);
  const parsed = parseSaveFile(text);
  assert.equal(parsed.format, SAVE_FILE_FORMAT);
  assert.equal(parsed.version, SAVE_FILE_VERSION);
  assert.equal(parsed.kind, 'variables');
  assert.equal(parsed.name, 'slot-1');
  assert.equal(parsed.identity, 'save-v1:abc');
  assert.deepEqual(parsed.variables, { score: 42, label: 'start', flag: false });
  assert.ok(text.endsWith('\n') && text.includes('\n  "kind"'), 'the file is indented JSON a person can read');
});

test('a save file that is not one of ours, or comes from another version, is refused by name', () => {
  const good = saveFileDocument({ kind: 'variables', name: 'slot-1', variables: { score: 1 } });
  for (const [label, text, message] of [
    ['empty', '   ', /empty/],
    ['not JSON', 'this is not json', /not JSON/],
    ['not a save file', JSON.stringify({ hello: 'world' }), /not written by this engine/],
    ['another version', JSON.stringify({ ...good, version: 99 }), /another version/],
    ['unknown kind', JSON.stringify({ ...good, kind: 'level' }), /unknown kind/],
    ['no variables', JSON.stringify({ ...good, variables: undefined }), /no variables/],
    ['bad name', JSON.stringify({ ...good, name: '../etc/passwd' }), /save file needs a name/],
    ['bad date', JSON.stringify({ ...good, createdAt: 'yesterday' }), /creation time/],
  ]) assert.throws(() => parseSaveFile(text), message, label);
  const huge = 'x'.repeat(MAX_SAVE_FILE_BYTES + 1);
  assert.throws(() => parseSaveFile(huge), /larger than the save-file limit/);
});

test('loading a variables save replaces the live values and skips what no longer fits', () => {
  const value = project(), state = createRuntime(value);
  state.variables.score = 5;
  state.variables.label = 'live';
  const document = saveFileDocument({ kind: 'variables', name: 'slot-1',
    variables: { score: 99, label: 'saved', gone: 1, flag: 'not a boolean' } });
  const result = applyVariableSave(value, state, document);
  assert.deepEqual(result.applied, ['score', 'label']);
  assert.equal(state.variables.score, 99);
  assert.equal(state.variables.label, 'saved');
  assert.equal(state.variables.flag, false, 'a value of the wrong type leaves the live one alone');
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped.join(' '), /gone \(no longer in the project\)/);
  assert.match(result.skipped.join(' '), /flag \(was boolean, saved as string\)/);
});

test('a save file can carry only the variables a rule names', () => {
  const value = project(), state = createRuntime(value);
  state.variables.label = 'picked';
  assert.deepEqual(variableSnapshot(value, state, 'label'), { label: 'picked' });
  assert.deepEqual(Object.keys(variableSnapshot(value, state)).sort(), ['flag', 'label', 'score']);
  assert.throws(() => saveVariableNames(value, 'score,nope'), /unknown variable: nope/);
  assert.deepEqual(saveVariableNames(value, 'score, score'), ['score']);
  for (const name of ['', ' ', '-leading', 'a'.repeat(61), 'has/slash']) assert.throws(() => saveFileName(name), /save file needs a name/);
  assert.equal(saveFileName('  checkpoint_1 '), 'checkpoint_1');
});

test('the save actions ask the host and the load conditions read what it published', () => {
  const value = project();
  value.events = rule([
    { type: 'saveVariables', file: 'slot-1', variables: 'score' },
    { type: 'saveGameState', file: 'checkpoint' },
  ]);
  validateProject(value);
  const state = createRuntime(value);
  tick(value, state);
  assert.deepEqual(state.menuRequests, [
    // The values travel with the request, taken when the action ran.
    { type: 'save-file', kind: 'variables', file: 'slot-1', values: { score: 10 } },
    { type: 'save-file', kind: 'game', file: 'checkpoint' },
  ]);
  assert.equal(state.saveFileError, '');
});

test('a full-state load refuses a name the host has not published', () => {
  const value = project();
  value.events = rule([{ type: 'loadGameState', file: 'checkpoint' }]);
  const state = createRuntime(value);
  tick(value, state);
  assert.deepEqual(state.menuRequests, []);
  assert.match(state.saveStatus, /no save file named checkpoint/);
  assert.equal(state.saveFileError, 'missing');
  // Published by the host (or restored from a save), the same rule asks for the load.
  state.saveFiles.add('checkpoint');
  state.saveFileError = '';
  tick(value, state);
  assert.deepEqual(state.menuRequests, [{ type: 'load-file', kind: 'game', file: 'checkpoint' }]);
});

test('the save-file conditions follow the published list and the last error', () => {
  const value = project();
  value.events = [
    { id: 'has', name: 'has', enabled: true, once: false, condition: { type: 'saveFileExists', file: 'slot-1' },
      conditions: [], actions: [{ type: 'addVariable', variable: 'score', value: 1 }] },
    { id: 'failed', name: 'failed', enabled: true, once: false, condition: { type: 'saveFileFailed' },
      conditions: [], actions: [{ type: 'addVariable', variable: 'score', value: 100 }] },
  ];
  validateProject(value);
  const state = createRuntime(value);
  state.variables.score = 0;
  tick(value, state);
  assert.equal(state.variables.score, 0, 'no file, no failure yet');
  state.saveFiles.add('slot-1');
  tick(value, state);
  assert.equal(state.variables.score, 1, 'the file exists now');
  state.saveFileError = 'disk full';
  state.variables.score = 0;
  tick(value, state);
  // Both rules hold now — the file exists and the last attempt failed — so both add their value.
  assert.equal(state.variables.score, 101, 'a failed save is visible to a rule');
});

test('the new state fields survive a whole-game save and come back with it', () => {
  const value = project();
  validateProject(value);
  const state = createRuntime(value);
  state.saveFiles.add('checkpoint');
  state.saveFiles.add('slot-1');
  const record = captureGameSave(value, state, 'identity');
  const { runtime } = restoreGameSave(value, record, 'identity');
  assert.deepEqual([...runtime.saveFiles].sort(), ['checkpoint', 'slot-1']);
  assert.equal(runtime.saveFileError, '');
});

test('a whole-game save file wraps a record the game can resume', () => {
  const value = project();
  validateProject(value);
  const state = createRuntime(value);
  state.variables.score = 7;
  state.player.x += 64;
  const record = captureGameSave(value, state, 'identity');
  const document = saveFileDocument({ kind: 'game', name: 'checkpoint', identity: 'identity', record });
  const parsed = parseSaveFile(serializeSaveFile(document));
  const { runtime } = restoreGameSave(value, parsed.record, 'identity');
  assert.equal(runtime.variables.score, 7);
  assert.equal(runtime.player.x, state.player.x);
  // A file whose record belongs to another game is refused, exactly like a slot would be.
  assert.throws(() => restoreGameSave(value, parsed.record, 'other'), /belongs to a different game/);
});

test('the four save actions and two conditions are in the event sheet catalogue', async () => {
  const { engineCommands } = await import('../shared/engine-script.js');
  const catalogue = engineCommands(project());
  const types = Object.values(catalogue).flat().map(command => command.type);
  for (const type of ['saveVariables', 'loadVariables', 'saveGameState', 'loadGameState', 'saveFileExists', 'saveFileFailed']) {
    assert.ok(types.includes(type), `${type} is offered by the sheet`);
  }
  const save = Object.values(catalogue).flat().find(command => command.type === 'saveVariables');
  assert.match(save.label, /^Save: /, 'the labels group under Save in the picker');
});

test('a bad file name or an unknown variable is refused while the rule is written', () => {
  const value = project();
  const cases = [
    [{ type: 'saveVariables', file: '../save', variables: '' }, /invalid characters|save file needs a name/],
    [{ type: 'loadVariables', file: 'has space' }, /invalid characters|save file needs a name/],
    [{ type: 'saveVariables', file: 'ok', variables: 'missing' }, /unknown variable: missing/],
    [{ type: 'saveGameState', file: '' }, /save file needs a name|must be 1-80 characters/],
    [{ type: 'saveFileExists', file: '' }, /save file needs a name|must be 1-80 characters/],
  ];
  for (const [action, message] of cases) {
    value.events = action.type === 'saveFileExists'
      ? [{ id: 'e', name: 'e', enabled: true, once: false, condition: action, conditions: [], actions: [] }]
      : rule([action]);
    assert.throws(() => validateProject(value), message, JSON.stringify(action));
  }
});
