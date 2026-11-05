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

test('the save actions write through the host at once and report the outcome', () => {
  const value = project();
  value.events = rule([
    { type: 'saveVariables', file: 'slot-1', variables: 'score' },
    { type: 'saveGameState', file: 'checkpoint' },
  ]);
  validateProject(value);
  const files = new Map();
  const state = createRuntime(value, { saveFiles: {
    read: name => files.get(name) ?? null,
    write: (name, text) => { files.set(name, text); },
    list: () => [...files.keys()],
    identity: 'identity',
  } });
  tick(value, state);
  // The variable file exists the moment the action ran; a whole-game file is a request, because
  // restoring one restarts the preview.
  assert.deepEqual([...files.keys()], ['slot-1']);
  assert.deepEqual(parseSaveFile(files.get('slot-1')).variables, { score: 10 });
  assert.match(state.saveStatus, /Saved 1 variable/);
  assert.deepEqual(state.menuRequests, [{ type: 'save-file', kind: 'game', file: 'checkpoint' }]);
  assert.equal(state.saveFileError, '');
});

test('a load applies inside the same rule, so later actions see the loaded values', () => {
  const value = project();
  value.events = rule([
    { type: 'setVariable', variable: 'score', value: 7 },
    { type: 'loadVariables', file: 'slot-1' },
    { type: 'addVariable', variable: 'score', value: 1 },
  ]);
  validateProject(value);
  const files = new Map([['slot-1', serializeSaveFile(saveFileDocument({ kind: 'variables', name: 'slot-1',
    identity: 'identity', variables: { score: 500 } }))]]);
  const state = createRuntime(value, { saveFiles: { read: name => files.get(name) ?? null,
    write: (name, text) => files.set(name, text), identity: 'identity' } });
  tick(value, state);
  assert.equal(state.variables.score, 501, 'the load replaced 7 with 500 before the +1 ran');
  assert.match(state.saveStatus, /Loaded 1 variable/);
});

test('a save after a load in the same rule stores the loaded values, not the replaced ones', () => {
  const value = project();
  value.events = rule([
    { type: 'setVariable', variable: 'score', value: 7 },
    { type: 'loadVariables', file: 'slot-1' },
    { type: 'saveVariables', file: 'copy' },
  ]);
  validateProject(value);
  const files = new Map([['slot-1', serializeSaveFile(saveFileDocument({ kind: 'variables', name: 'slot-1',
    identity: 'identity', variables: { score: 500 } }))]]);
  const state = createRuntime(value, { saveFiles: { read: name => files.get(name) ?? null,
    write: (name, text) => files.set(name, text), identity: 'identity' } });
  tick(value, state);
  assert.equal(parseSaveFile(files.get('copy')).variables.score, 500);
});

test('a save file from a different game is refused instead of replacing this game variables', () => {
  const value = project();
  value.events = rule([{ type: 'loadVariables', file: 'foreign' }]);
  validateProject(value);
  const files = new Map([['foreign', serializeSaveFile(saveFileDocument({ kind: 'variables', name: 'foreign',
    identity: 'another-game', variables: { score: 999 } }))]]);
  const state = createRuntime(value, { saveFiles: { read: name => files.get(name) ?? null,
    write: () => {}, identity: 'this-game' } });
  tick(value, state);
  assert.equal(state.variables.score, 10, 'the live value is untouched');
  assert.match(state.saveStatus, /different game/);
  assert.match(state.saveFileError, /different game/);
});

test('a missing file or a whole-game file is reported, not thrown', () => {
  const value = project();
  value.events = rule([{ type: 'loadVariables', file: 'gone' }, { type: 'loadVariables', file: 'game' }]);
  validateProject(value);
  const files = new Map([['game', serializeSaveFile(saveFileDocument({ kind: 'game', name: 'game', record: { version: 1 } }))]]);
  const state = createRuntime(value, { saveFiles: { read: name => files.get(name) ?? null, write: () => {}, identity: 'id' } });
  assert.doesNotThrow(() => tick(value, state));
  assert.match(state.saveFileError, /holds a whole game/);
  assert.equal(state.variables.score, 10);
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

test('a value JSON cannot hold is refused at save time, not turned into null', () => {
  // `JSON.stringify` writes NaN and Infinity as `null` and drops undefined, so the file used to
  // hold a value the load then refuses to apply — while the rule that saved it said "Saved 1
  // variable". A number the game cannot write down is an error the saving rule has to hear.
  for (const [label, value, message] of [
    ['NaN', NaN, /Cannot save score: a number has to be finite/],
    ['Infinity', Infinity, /Cannot save score: a number has to be finite/],
    ['undefined', undefined, /Cannot save score: it is undefined/],
    ['a function', () => 1, /Cannot save score: it is not data/],
    ['a Map', new Map(), /Cannot save score: it is not plain data/],
  ]) {
    assert.throws(() => saveFileDocument({ kind: 'variables', name: 'slot-1', variables: { score: value } }),
      message, `${label} must be refused`);
  }
  // A nested one is named by its path, so a rule's author can find it.
  assert.throws(() => saveFileDocument({ kind: 'variables', name: 'slot-1',
    variables: { bag: { list: [1, NaN] } } }), /Cannot save bag\.list\[1\]: a number has to be finite/);
  // Everything JSON does hold still passes untouched.
  const kept = { score: 1, label: 'a\u0000b😀', nested: { list: [1, 'x', { on: true }] }, nothing: null };
  assert.deepEqual(saveFileDocument({ kind: 'variables', name: 'slot-1', variables: kept }).variables, kept);
});

test('a rule that saves a number JSON cannot hold reports the failure and writes no file', () => {
  const value = project();
  value.events = rule([{ type: 'saveVariables', file: 'slot-1', variables: '' }]);
  validateProject(value);
  const files = new Map();
  const state = createRuntime(value, { saveFiles: {
    read: name => files.get(name) ?? null,
    write: (name, text) => { files.set(name, text); },
    list: () => [...files.keys()],
    identity: 'identity',
  } });
  state.variables.score = NaN;
  tick(value, state);
  assert.equal(files.size, 0, 'no file is written for a save that cannot be read back');
  assert.match(state.saveStatus, /Save failed: Cannot save score: a number has to be finite/);
  assert.match(state.saveFileError, /Cannot save score/);
});

test('importing a save file asks before it replaces one of the same name', async () => {
  // The import handler runs in the page, so this checks the source it is written from: without
  // the question, a player importing a file from another machine silently loses their own save.
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const handler = /save-files-input'\)\.addEventListener\('change', async \(\) => \{([\s\S]*?)\n\}\);/.exec(app);
  assert.ok(handler, 'the import handler is there');
  const body = handler[1];
  assert.match(body, /saveFileKeys\(\)\.includes\(parsed\.name\)/, 'it looks for a file already stored under that name');
  assert.match(body, /confirm\(`Replace the save file \$\{parsed\.name\}/, 'and asks before writing over it');
  assert.ok(body.indexOf('saveFileKeys().includes(parsed.name)') < body.indexOf('writeSaveFile(parsed.name'),
    'the question comes before the write');
});
