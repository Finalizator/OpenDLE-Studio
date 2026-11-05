import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { commandFields } from '../shared/command-fields.js';
import { setEventObjectContext, validateEventStructure } from '../shared/events.js';

function rule(id, parentId, context = {}) {
  return { id, ...context, ...(parentId ? { parentId } : {}), condition: { type: 'always' }, actions: [] };
}

function checkStructure(project) {
  validateEventStructure(project, (valid, message) => assert.ok(valid, message));
}

test('changing a plain event context preserves nested for-each scopes', () => {
  const project = { events: [
    rule('root'),
    rule('loop', 'root', { forEachType: 'enemy' }),
    rule('loop-child', 'loop', { forEachType: 'enemy' }),
    rule('plain-child', 'root'),
  ] };

  setEventObjectContext(project, 'root', {});
  assert.equal(project.events[0].ownerId, undefined);
  assert.equal(project.events[1].ownerId, undefined);
  assert.equal(project.events[1].forEachType, 'enemy');
  assert.equal(project.events[2].forEachType, 'enemy');
  assert.equal(project.events[3].ownerId, undefined);
  checkStructure(project);
});

test('changing an ancestor to an incompatible object context is rejected atomically', () => {
  const project = { events: [
    rule('root'),
    rule('loop', 'root', { forEachType: 'enemy' }),
    rule('loop-child', 'loop', { forEachType: 'enemy' }),
  ] };
  const before = structuredClone(project);

  assert.throws(() => setEventObjectContext(project, 'root', { forEachType: 'pickup' }), /nested for-each/i);
  assert.deepEqual(project, before);
  assert.throws(() => setEventObjectContext(project, 'root', { ownerId: 'owner' }), /nested for-each/i);
  assert.deepEqual(project, before);
});

class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this._value = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get value() { return this._value; }
  set value(value) { this._value = String(value ?? ''); }
  get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
  querySelector(selector) {
    if (selector === 'input,select' && ['input', 'select'].includes(this.tagName)) return this;
    for (const child of this.children) {
      const match = child.querySelector?.(selector);
      if (match) return match;
    }
    return null;
  }
  focus() {}
  showModal() {}
  close() {}
  remove() {}
}

function descendants(element) {
  return [element, ...element.children.flatMap(child => descendants(child))];
}

async function loadCommandDialog() {
  let source = await readFile(new URL('../public/event-sheet.js', import.meta.url), 'utf8');
  source = source.replace(/from '\/shared\/([^']+)'/g, (_match, path) =>
    `from '${new URL(`../shared/${path}`, import.meta.url).href}'`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(moduleUrl);
}

test('the command dialog uses object types to suggest picked local variables', async () => {
  const previousDocument = globalThis.document;
  const document = { body: new MockElement('body'), createElement: tag => new MockElement(tag) };
  globalThis.document = document;
  try {
    const { openCommandDialog } = await loadCommandDialog();
    openCommandDialog({
      kind: 'action',
      labels: [['setPickedVariable', 'Object: set a local variable on picked instances']],
      command: { type: 'setPickedVariable', objectType: 'enemy', variable: 'health', value: 1 },
      defaults: type => ({ type }),
      entities: [],
      objectTypes: [['enemy', 'Enemy', ['health', 'speed']]],
      submit() {},
    });

    const datalist = descendants(document.body).find(element => element.tagName === 'datalist');
    assert.ok(datalist, 'the local-variable field has a suggestion list');
    assert.deepEqual(datalist.options.map(option => option.value), ['health', 'speed']);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('changing a picked object type refreshes its local-variable suggestions', async () => {
  const previousDocument = globalThis.document;
  const document = { body: new MockElement('body'), createElement: tag => new MockElement(tag) };
  globalThis.document = document;
  try {
    const { openCommandDialog } = await loadCommandDialog();
    openCommandDialog({
      kind: 'action',
      labels: [['setPickedVariable', 'Object: set a local variable on picked instances']],
      command: { type: 'setPickedVariable', objectType: 'enemy', variable: 'health', value: 1 },
      defaults: type => ({ type }),
      entities: [],
      objectTypes: [['enemy', 'Enemy', ['health']], ['pickup', 'Pickup', ['item']]],
      submit() {},
    });

    const dialog = document.body.children[0];
    const typePicker = descendants(dialog).find(element => element.getAttribute('aria-label') === 'objectType');
    typePicker.value = 'pickup';
    typePicker.listeners.change();

    const datalist = descendants(dialog).find(element => element.tagName === 'datalist');
    assert.deepEqual(datalist.options.map(option => option.value), ['item']);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('spawnEntity offers only eligible object templates', () => {
  const fields = commandFields({ type: 'spawnEntity', templateId: '' }, {
    entities: [['$self', 'This object'], ['player', 'Player'], ['enemy-id', 'Enemy'], ['pickup-id', 'Coin']],
    playerId: 'player',
  });
  const template = fields.find(field => field.name === 'templateId');
  assert.equal(template.label, 'Object template');
  assert.deepEqual(template.options, [['enemy-id', 'Enemy'], ['pickup-id', 'Coin']]);
});

test('the spawn dialog selects a valid template and refuses an empty template list', async () => {
  const previousDocument = globalThis.document;
  const { openCommandDialog } = await loadCommandDialog();
  try {
    let document = { body: new MockElement('body'), createElement: tag => new MockElement(tag) };
    globalThis.document = document;
    openCommandDialog({
      kind: 'action',
      labels: [['spawnEntity', 'Object: spawn a new object from a template']],
      command: { type: 'spawnEntity', templateId: '' },
      defaults: type => ({ type, templateId: '' }),
      entities: [['$self', 'This object'], ['player', 'Player'], ['enemy-id', 'Enemy']],
      playerId: 'player',
      submit() {},
    });
    const picker = descendants(document.body).find(element => element.getAttribute('aria-label') === 'Object template');
    assert.equal(picker.value, 'enemy-id');

    document = { body: new MockElement('body'), createElement: tag => new MockElement(tag) };
    globalThis.document = document;
    let submitted = false;
    openCommandDialog({
      kind: 'action',
      labels: [['spawnEntity', 'Object: spawn a new object from a template']],
      command: { type: 'spawnEntity', templateId: '' },
      defaults: type => ({ type, templateId: '' }),
      entities: [['player', 'Player']],
      playerId: 'player',
      submit() { submitted = true; },
    });
    const done = descendants(document.body).find(element => element.tagName === 'button' && element.textContent === 'Done');
    done.listeners.click();
    assert.equal(submitted, false);
    assert.match(descendants(document.body).find(element => element.getAttribute('role') === 'alert').textContent, /non-player object first/);
  } finally {
    globalThis.document = previousDocument;
  }
});
