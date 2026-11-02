import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, CONDITIONS, createProject, validateProject } from '../shared/project.js';
import {
  ADDON_FORMAT, ADDON_LIMITS, addonCommands, addonCommand, addonFile, addonReady, addonUsage,
  declaredAddonTypes, enabledAddons, findAddon, installAddon, normalizeAddon, projectAddons,
  removeAddon, setAddonEnabled, stripAddonCommands, validateAddonManifest,
} from '../shared/addons.js';
import { ENGINE_ACTIONS, ENGINE_CONDITIONS, engineCommand, engineCommands } from '../shared/engine-script.js';
import { createRuntime, setAddonHooks, stepRuntime } from '../shared/runtime.js';
import { createPath, createPathPoint } from '../shared/paths.js';
import { createTimesheet, createCue, createTrack } from '../shared/timesheet.js';
import { applyTool } from '../server/tools.js';

// Every type the engine itself understands: the catalogue plus the hand-written commands.
const ENGINE_TYPES = new Set([...ENGINE_ACTIONS, ...ENGINE_CONDITIONS, ...CONDITIONS, ...ACTIONS].map(command => command.type ?? command));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const manifest = (overrides = {}) => ({
  format: ADDON_FORMAT, version: 1, id: 'sparkle', name: 'Sparkle', entry: 'main.js',
  description: 'Sparkles on demand', author: 'someone',
  provides: {
    conditions: [{ type: 'sparkle:armed', label: 'Addon: sparkle armed', fields: [] }],
    actions: [{ type: 'sparkle:burst', label: 'Addon: sparkle burst', target: true,
      fields: [{ name: 'count', kind: 'number', value: 3, min: 1, max: 10, label: 'Count' },
        { name: 'mode', kind: 'choice', value: 'wide', options: ['wide', 'narrow'], label: 'Mode' }] }],
  },
  ...overrides,
});
const files = { 'main.js': 'export function activate() {}', 'README.md': '# Sparkle' };
/** A shader the project validator accepts; anything else is refused as an addon's content too. */
const SHADER = 'vec4 effect(vec4 color, vec2 uv, float time) { return vec4(color.rgb, color.a); }';
/** The same manifest without a script, for the cases that only care about its commands. */
const headless = (overrides = {}) => manifest({ ...overrides, entry: undefined });
const install = (project, overrides = {}) => installAddon(project, { manifest: manifest(overrides), files }, { engineTypes: ENGINE_TYPES });

test('an addon manifest is checked the way the engine catalogue is', () => {
  assert.doesNotThrow(() => validateAddonManifest(manifest()));
  assert.throws(() => validateAddonManifest({ ...manifest(), format: 'something' }), /opendle-addon/);
  assert.throws(() => validateAddonManifest({ ...manifest(), version: 9 }), /version 9/);
  assert.throws(() => validateAddonManifest({ ...manifest(), id: 'Not An Id' }), /lowercase/);
  assert.throws(() => validateAddonManifest({ ...manifest(), id: 'sparkle', requires: ['sparkle'] }), /cannot require itself/);
  assert.throws(() => validateAddonManifest(manifest({ provides: { actions: [{ type: 'x', label: 'x',
    fields: [{ name: 'n', kind: 'colour', label: 'N' }] }] } })), /must be one of/);
  assert.throws(() => validateAddonManifest(manifest({ provides: { actions: [{ type: 'x', label: 'x',
    fields: [{ name: 'n', kind: 'choice', options: ['a'], value: 'b', label: 'N' }] }] } })), /default must be one of/);
  assert.throws(() => validateAddonManifest(manifest({ provides: { widgets: [] } })), /cannot provide/);
  assert.throws(() => validateAddonManifest(manifest({ entry: '../escape.js' })), /stay inside/);
  // Ordering: a format version this build does not read is refused before anything else is trusted.
  assert.throws(() => validateAddonManifest(null), /must be an object/);
});

test('installing an addon puts its commands in the catalogue and its content in the project', () => {
  const project = createProject();
  project.shaders = [];
  const before = engineCommands(project).actions.length;
  install(project, { provides: {
    actions: manifest().provides.actions,
    conditions: manifest().provides.conditions,
    shaders: [{ id: 'sparkleTint', name: 'Sparkle tint', language: 'glsl', source: SHADER }],
    assets: [{ id: 'sparkle_sprite', name: 'Sparkle', kind: 'sprite', width: 32, height: 32, src: PNG }],
  } });
  assert.equal(engineCommands(project).actions.length, before + 1, 'the action joins the catalogue');
  assert.equal(engineCommand('sparkle:burst', project)?.addonId, 'sparkle');
  assert.equal(engineCommand('sparkle:burst')?.label, undefined, 'the engine alone does not know it');
  assert.deepEqual(addonCommands(project, 'actions').map(command => command.type), ['sparkle:burst']);
  assert.equal(project.shaders.find(shader => shader.id === 'sparkleTint').addonId, 'sparkle');
  assert.equal(project.assets.find(asset => asset.id === 'sparkle_sprite').addonId, 'sparkle');
  assert.equal(addonFile(project, 'sparkle', 'main.js'), files['main.js']);
  assert.equal(addonFile(project, 'sparkle', 'nope.js'), null);
  assert.doesNotThrow(() => validateProject(project), 'the project with the addon is valid');
});

test('the same addon cannot be installed twice, nor shadow an engine command', () => {
  const project = createProject();
  install(project);
  assert.throws(() => install(project), /already installed/);
  const shadow = createProject();
  assert.throws(() => installAddon(shadow, { manifest: headless({ id: 'shadow', provides: {
    actions: [{ type: 'teleport', label: 'Mine now', fields: [] }],
  } }), files: {} }, { engineTypes: ENGINE_TYPES }), /the engine already has/);
  const clash = createProject();
  install(clash);
  assert.throws(() => installAddon(clash, { manifest: headless({ id: 'other', provides: {
    actions: [{ type: 'sparkle:burst', label: 'Also mine', fields: [] }],
  } }), files: {} }, { engineTypes: ENGINE_TYPES }), /another addon already adds/);
});

test('a rule that uses an addon command validates, and its fields are checked like an engine command', () => {
  const project = createProject();
  project.events = [{ id: 'rule', enabled: true, once: false, ownerId: 'pickup',
    condition: { type: 'sparkle:armed' },
    actions: [{ type: 'sparkle:burst', entityId: 'pickup', count: 4, mode: 'wide' }] }];
  install(project);
  assert.doesNotThrow(() => validateProject(project));
  project.events[0].actions[0].count = 99;
  assert.throws(() => validateProject(project), /count must be between 1 and 10/);
  project.events[0].actions[0].count = 4;
  project.events[0].actions[0].mode = 'sideways';
  assert.throws(() => validateProject(project), /Unsupported mode/);
  project.events[0].actions[0].mode = 'wide';
  // Switching the addon off keeps the rule valid: the record still declares the type.
  setAddonEnabled(project, 'sparkle', false);
  assert.doesNotThrow(() => validateProject(project), 'a switched-off addon leaves readable rules');
  assert.deepEqual(addonCommands(project, 'actions'), [], 'but its commands are out of the catalogue');
  assert.equal(declaredAddonTypes(project).has('sparkle:burst'), true);
  assert.equal(enabledAddons(project).length, 0);
});

test('removing an addon takes its content and its commands with it, and nothing else', () => {
  const project = createProject();
  project.events = [
    { id: 'uses', enabled: true, once: false, condition: { type: 'always' }, conditions: [],
      actions: [{ type: 'sparkle:burst', entityId: 'pickup', count: 1, mode: 'wide' },
        { type: 'addVariable', variable: 'score', value: 1 }] },
    { id: 'only-addon', enabled: true, once: false, condition: { type: 'sparkle:armed' }, actions: [] },
    { id: 'unrelated', enabled: true, once: false, condition: { type: 'always' }, actions: [{ type: 'addVariable', variable: 'score', value: 2 }] },
  ];
  install(project, { provides: { actions: manifest().provides.actions, conditions: manifest().provides.conditions,
    shaders: [{ id: 'tint', name: 'Tint', language: 'glsl', source: SHADER }] } });
  project.shaders = project.shaders || [];
  validateProject(project);
  assert.equal(addonUsage(project, 'sparkle').length, 2, 'two rules use its commands');
  const result = removeAddon(project, 'sparkle');
  assert.equal(result.commands, 2);
  assert.equal(result.rules, 1, 'the rule that only named an addon condition is dropped');
  assert.deepEqual(project.events.map(event => event.id), ['uses', 'unrelated']);
  assert.deepEqual(project.events[0].actions.map(action => action.type), ['addVariable'], 'the rest of the rule stays');
  assert.equal(project.shaders.some(shader => shader.id === 'tint'), false, 'the shader it brought is gone');
  assert.doesNotThrow(() => validateProject(project), 'the project is valid again');
  assert.equal(findAddon(project, 'sparkle'), null);
  assert.equal(removeAddon(project, 'sparkle'), null, 'removing twice is not an error');
});

test('removing an addon also clears a timesheet cue and a scene rule that used it', () => {
  const project = createProject();
  project.events = [];
  project.paths = [createPath({ id: 'road', name: 'Road', points: [
    createPathPoint({ id: 'a', x: 0, y: 0 }), createPathPoint({ id: 'b', x: 100, y: 0 })] })];
  const sheet = createTimesheet({ id: 'sheet', name: 'Sheet' });
  sheet.tracks = [createTrack(0)];
  sheet.cues = [{ ...createCue({ id: 'cue', name: 'Cue', trackId: sheet.tracks[0].id, time: 0, ownerId: null }),
    actions: [{ type: 'sparkle:burst', entityId: 'pickup', count: 1, mode: 'wide' }] }];
  project.timesheets = [sheet];
  install(project);
  validateProject(project);
  const result = removeAddon(project, 'sparkle');
  assert.equal(result.commands, 1);
  assert.deepEqual(project.timesheets[0].cues, [], 'the cue that only sparkled is gone');
});

test('two addons can require each other\'s presence without a cycle', () => {
  const project = createProject();
  install(project);
  installAddon(project, { manifest: headless({ id: 'glitter', requires: ['sparkle'], provides: {
    actions: [{ type: 'glitter:shine', label: 'Addon: shine', fields: [] }],
  } }), files: {} }, { engineTypes: ENGINE_TYPES });
  assert.equal(addonReady(project, 'glitter'), true);
  setAddonEnabled(project, 'glitter', true);
  setAddonEnabled(project, 'sparkle', false);
  assert.equal(addonReady(project, 'glitter'), false, 'a switched-off requirement is not ready');
  // Switching the dependent back on switches its requirement on with it.
  setAddonEnabled(project, 'glitter', true);
  assert.equal(findAddon(project, 'sparkle').enabled, true);
  // Removing the requirement switches the dependent off rather than breaking the project.
  removeAddon(project, 'sparkle', { strip: false });
  assert.equal(findAddon(project, 'glitter').enabled, false);
  assert.doesNotThrow(() => validateProject(project));
});

test('an addon that requires a missing addon cannot be installed', () => {
  const project = createProject();
  assert.throws(() => installAddon(project, { manifest: headless({ id: 'glitter', requires: ['ghost'] }), files: {} },
    { engineTypes: ENGINE_TYPES }), /requires "ghost"/);
});

test('the runtime runs an addon action and asks an addon condition', () => {
  const project = createProject();
  project.events = [{ id: 'rule', enabled: true, once: false, ownerId: 'pickup',
    condition: { type: 'sparkle:armed' },
    actions: [{ type: 'sparkle:burst', entityId: 'pickup', count: 4, mode: 'wide' }] }];
  install(project);
  validateProject(project);
  let bursts = 0, armed = true;
  const seen = [];
  const runtime = createRuntime(project, { addons: {
    actions: new Map([['sparkle:burst', (context, action) => {
      bursts += action.count;
      seen.push([context.entity?.id, context.project === project, context.state === runtime]);
      context.say('sparkle');
    }]]),
    conditions: new Map([['sparkle:armed', () => armed]]),
  } });
  stepRuntime(project, runtime, 1 / 35, new Set());
  assert.equal(bursts, 4);
  assert.equal(runtime.message, 'sparkle');
  assert.deepEqual(seen[0], ['pickup', true, true], 'the implementation gets the game, the rule\'s object and the project');
  armed = false;
  stepRuntime(project, runtime, 1 / 35, new Set());
  assert.equal(bursts, 4, 'a false condition means no action');
  // A runtime without the implementation ignores the rule rather than throwing.
  const bare = createRuntime(project);
  assert.doesNotThrow(() => stepRuntime(project, bare, 1 / 35, new Set()));
  // And hooks can be attached to a restored or otherwise created runtime afterwards.
  setAddonHooks(bare, { actions: new Map([['sparkle:burst', () => { bursts += 1; }]]), conditions: new Map() });
  bare.entities.find(entity => entity.id === 'pickup');
  stepRuntime(project, bare, 1 / 35, new Set());
  assert.equal(bursts, 4, 'the armed condition has no implementation in this runtime');
});

test('an addon file is the files the manifest names, bounded and text only', () => {
  const project = createProject();
  assert.throws(() => normalizeAddon({ manifest: manifest(), files: { 'other.js': 'x' } }), /entry main\.js is not one of its files/);
  assert.throws(() => normalizeAddon({ manifest: manifest(), files: { 'main.js': 'x', '../escape.js': 'x' } }), /stay inside/);
  assert.throws(() => normalizeAddon({ manifest: manifest(), files: { 'main.js': 'x'.repeat(ADDON_LIMITS.fileChars + 1) } }), /larger than/);
  const record = normalizeAddon({ manifest: manifest(), files, source: { type: 'url', url: 'https://example.test/a.zip' } });
  assert.equal(record.enabled, true);
  assert.equal(record.description, 'Sparkles on demand');
  assert.equal(record.source.type, 'url');
  assert.deepEqual(projectAddons(project), []);
});

test('an addon record in a project is validated like any other project data', () => {
  const project = createProject();
  install(project);
  const broken = structuredClone(project);
  broken.addons[0].manifest.id = 'someone-else';
  assert.throws(() => validateProject(broken), /does not match its manifest id/);
  const duplicate = structuredClone(project);
  duplicate.addons.push(structuredClone(duplicate.addons[0]));
  assert.throws(() => validateProject(duplicate), /Duplicate addon sparkle/);
  const unknown = structuredClone(project);
  unknown.addons[0].manifest.provides.actions.push({ type: 'teleport', label: 'Mine', fields: [] });
  assert.throws(() => validateProject(unknown), /redeclares the engine command teleport/);
  const missing = structuredClone(project);
  missing.addons[0].manifest = { ...missing.addons[0].manifest, requires: ['ghost'] };
  assert.throws(() => validateProject(missing), /requires ghost, which is not installed/);
  assert.doesNotThrow(() => validateProject(project));
});

test('the MCP catalogue tells the assistant what an addon adds', () => {
  const project = createProject();
  install(project);
  const result = applyTool(project, 'addons_list', {});
  assert.equal(result.changed, false);
  assert.deepEqual(result.addons.map(addon => addon.id), ['sparkle']);
  assert.equal(result.addons[0].enabled, true);
  assert.deepEqual(result.addons[0].actions.map(action => action.type), ['sparkle:burst']);
  assert.deepEqual(result.addons[0].actions[0].fields.map(field => field.name), ['count', 'mode']);
  assert.equal(result.addons[0].actions[0].target, true);
  assert.deepEqual(result.addons[0].conditions.map(condition => condition.type), ['sparkle:armed']);
  // And a rule can be written against it through the same tool surface.
  const added = applyTool(project, 'events_add_rule', { name: 'Sparkle rule', condition: { type: 'sparkle:armed' },
    actions: [{ type: 'sparkle:burst', entityId: 'pickup', count: 2, mode: 'wide' }] });
  assert.equal(added.project.events.some(event => event.actions.some(action => action.type === 'sparkle:burst')), true);
});
