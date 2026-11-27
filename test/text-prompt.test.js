import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const editorFiles = readdirSync(new URL('../public/', import.meta.url))
  .filter(name => name.endsWith('.js'));

test('no editor module reaches for prompt(), which the desktop build does not have', () => {
  // Electron's renderer throws `prompt() is not supported.` instead of answering, so every
  // editor command that called it died silently; the playtest log caught Edit game version
  // throwing from app.js. `public/text-prompt.js` is the one place allowed to mention it.
  const offenders = [];
  for (const name of editorFiles) {
    if (name === 'text-prompt.js') continue;
    const source = readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (/(^|[^.\w$])prompt\s*\(/.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `use askText() instead of prompt():\n${offenders.join('\n')}`);
});

test('askText answers the native prompt where one exists', async () => {
  const { askText } = await import('../public/text-prompt.js');
  const calls = [];
  globalThis.window = { prompt: (message, initial) => { calls.push([message, initial]); return 'typed'; } };
  try {
    assert.equal(await askText('Asset name', 'old'), 'typed');
    assert.deepEqual(calls, [['Asset name', 'old']], 'the question and the starting text are passed on');
  } finally {
    delete globalThis.window;
  }
});

// A DOM just big enough for the overlay: elements remember their children and their listeners.
function fakeDom() {
  const created = [];
  const makeEl = tag => {
    const element = {
      tag, children: [], listeners: new Map(), className: '', textContent: '', type: '', title: '',
      value: '', style: {}, focused: false, selected: false,
      setAttribute(name, value) { this[name] = value; },
      append(...items) { this.children.push(...items); },
      remove() { this.removed = true; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); },
      fire(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn({ preventDefault() {}, stopPropagation() {}, ...event }); },
    };
    created.push(element);
    return element;
  };
  const documentListeners = new Map();
  const document = {
    body: makeEl('body'),
    createElement: makeEl,
    addEventListener(name, fn) { documentListeners.set(name, [...(documentListeners.get(name) || []), fn]); },
    removeEventListener(name) { documentListeners.delete(name); },
    listeners: documentListeners,
  };
  return { document, created, find: tag => created.find(element => element.tag === tag) };
}

test('with a throwing prompt the overlay asks the same question and answers it', async () => {
  const { askText } = await import('../public/text-prompt.js');
  const dom = fakeDom();
  globalThis.document = dom.document;
  globalThis.window = { prompt: () => { throw new Error('prompt() is not supported.'); } };
  let pending;
  try {
    pending = askText('Asset name', 'old name');
  } finally {
    delete globalThis.window;
  }
  const input = dom.find('input');
  assert.equal(input.value, 'old name', 'the starting text is filled in');
  assert.equal(dom.find('label').textContent, 'Asset name', 'the question is shown');
  assert.equal(input.focused, true, 'the field takes focus');
  input.value = 'renamed';
  dom.find('form').fire('submit');
  assert.equal(await pending, 'renamed', 'OK answers with what was typed');
  assert.equal(dom.created.some(element => element.removed), true, 'the overlay goes away');
  assert.equal(dom.document.listeners.size, 0, 'and leaves no key listener behind');
  delete globalThis.document;
});

test('Escape cancels the overlay instead of answering it', async () => {
  const { askText } = await import('../public/text-prompt.js');
  const dom = fakeDom();
  globalThis.document = dom.document;
  globalThis.window = { prompt: undefined };
  const pending = askText('Asset name', 'old');
  const keyHandlers = dom.document.listeners.get('keydown') || [];
  assert.equal(keyHandlers.length, 1, 'the overlay is listening for keys');
  keyHandlers[0]({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(await pending, null, 'cancel is null, the same answer a native prompt gives');
  delete globalThis.document;
  delete globalThis.window;
});
