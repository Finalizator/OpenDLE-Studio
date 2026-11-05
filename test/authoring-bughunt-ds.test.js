import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { commandFields } from '../shared/command-fields.js';

/** A minimal DOM element good enough to drive the parameter dialog's data, not its drawing. */
class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.style = {};
    this._value = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get value() { return this._value; }
  set value(value) { this._value = String(value ?? ''); }
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

async function loadEventSheet() {
  let source = await readFile(new URL('../public/event-sheet.js', import.meta.url), 'utf8');
  source = source.replace(/from '\/shared\/([^']+)'/g, (_match, path) =>
    `from '${new URL(`../shared/${path}`, import.meta.url).href}'`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(moduleUrl);
}

async function withDialog(setup, drive) {
  const previousDocument = globalThis.document;
  const document = { body: new MockElement('body'), createElement: tag => new MockElement(tag) };
  globalThis.document = document;
  try {
    const { openCommandDialog } = await loadEventSheet();
    let submitted = null;
    openCommandDialog({ ...setup, submit: value => { submitted = value; } });
    drive(descendants(document.body));
    return submitted;
  } finally {
    globalThis.document = previousDocument;
  }
}

test('authoring 01: the command dialog forwards the level camera list to camera commands', async () => {
  await withDialog({
    kind: 'action',
    labels: [['switchCamera', 'Camera: switch the view to a camera']],
    command: { type: 'switchCamera', camera: '$player' },
    defaults: type => ({ type }),
    entities: [],
    cameras: [['cam1', 'Cam 1'], ['cam2', 'Cam 2']],
  }, nodes => {
    // The camera field is a picker; the level's cameras have to be among its options.
    const picker = nodes.find(node => node.getAttribute('aria-label') === 'camera');
    assert.ok(picker, 'the camera field exists');
    assert.deepEqual(picker.options.map(option => option.value),
      ['$player', '$active', 'cam1', 'cam2']);
  });
});

test('authoring 02: editing a startTimesheet action keeps its three-valued loop', async () => {
  const submitted = await withDialog({
    kind: 'action',
    labels: [['startTimesheet', 'Timesheet: start']],
    command: { type: 'startTimesheet', restart: 'yes', loop: 'same' },
    defaults: type => ({ type }),
    entities: [],
    timesheets: [],
  }, nodes => {
    const picker = nodes.find(node => node.getAttribute('aria-label') === 'loop');
    assert.ok(picker, 'the loop picker exists');
    assert.deepEqual(picker.options.map(option => option.value), ['same', 'yes', 'no']);
    picker.value = 'no';
    picker.listeners.change();
    const done = nodes.find(node => node.tagName === 'button' && node.textContent === 'Done');
    done.listeners.click();
  });
  assert.equal(submitted.loop, 'no');
});

test('authoring 03: a camera field still lists the picker rows when the dialog has no cameras', async () => {
  const fields = commandFields({ type: 'setCameraPosition', camera: '$active' }, {
    entities: [], cameras: [],
  }).find(field => field.name === 'camera');
  assert.deepEqual(fields.options, [['$player', "The player's view"], ['$active', 'The camera in use']]);
});

test('authoring 04: the playAnimation loop picker still submits a boolean', async () => {
  const submitted = await withDialog({
    kind: 'action',
    labels: [['playAnimation', 'Model: play animation']],
    command: { type: 'playAnimation', entityId: 'e1', clip: 'run', speed: 1, loop: true },
    defaults: type => ({ type }),
    entities: [['e1', 'Enemy']],
    clips: () => ['run', 'walk'],
  }, nodes => {
    const picker = nodes.find(node => node.getAttribute('aria-label') === 'loop');
    assert.ok(picker, 'the loop picker exists');
    picker.value = 'false';
    picker.listeners.change();
    const done = nodes.find(node => node.tagName === 'button' && node.textContent === 'Done');
    done.listeners.click();
  });
  assert.equal(submitted.loop, false);
});

test('authoring 05: command descriptions never leak "undefined" for unset optional fields', async () => {
  const { describeCommand } = await loadEventSheet();
  const { defaultEngineCommand } = await import('../shared/engine-script.js');
  const labels = [['setCameraPosition', 'Camera: set position'], ['moveCamera', 'Camera: move over time'],
    ['moveSector', 'World: move sector surface']];
  for (const type of ['setCameraPosition', 'moveCamera', 'moveSector']) {
    const text = describeCommand(defaultEngineCommand(type), labels, id => id).text;
    assert.ok(!text.includes('undefined'), `${type} shows "undefined": ${text}`);
  }
  // A set field still reads its number, so the filter only drops what was never authored.
  const positioned = describeCommand({ type: 'setCameraPosition', camera: '$active', x: 4, y: 8, z: 16 },
    labels, id => id).text;
  assert.ok(positioned.includes('z: 16'), positioned);
});
