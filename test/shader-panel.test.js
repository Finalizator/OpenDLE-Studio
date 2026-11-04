/**
 * The Shader Engine panel's controls.
 *
 * There is no DOM in the test runner, so this file carries the smallest one the panel
 * needs — elements with children, attributes and listeners. It exists because a control
 * that renders perfectly and does nothing when clicked is invisible to every other test:
 * the arrows, the On toggles and every slider were dead for exactly that reason, and the
 * only thing that caught it was clicking them in a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// The public modules import their shared code by the path the browser serves it from
// (`/shared/post-fx.js`), which is not a path Node can resolve. This hook points those
// specifiers at the files on disk so the panel itself can be loaded and clicked.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/shared/')) {
      const target = new URL(`../shared/${specifier.slice('/shared/'.length)}`, import.meta.url).href;
      return nextResolve(target, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createShaderEnginePanel } = await import('../public/shader-engine-panel.js');
const { createPostFxPass, POST_FX_PRESETS } = await import('../shared/post-fx.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.textContent = '';
    this.className = '';
    this.parent = null;
    this.disabled = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') { this.textContent += node; continue; }
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(node) { this.append(node); return node; }

  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type, target: this });
  }

  click() { this.dispatch('click'); }

  * walk() {
    yield this;
    for (const child of this.children) if (child instanceof FakeElement) yield* child.walk();
  }

  find(predicate) { return [...this.walk()].find(predicate) || null; }

  findAll(predicate) { return [...this.walk()].filter(predicate); }
}

const installDom = () => {
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
  globalThis.Option = class {
    constructor(text, value) { this.textContent = String(text); this.value = String(value); }
  };
};

const setup = () => {
  installDom();
  let project = { postFx: { enabled: true, passes: [createPostFxPass('fog'), createPostFxPass('pixelization')] } };
  const edits = [];
  const errors = [];
  const host = new FakeElement('div');
  const state = {};
  const panel = createShaderEnginePanel(host, {
    project: () => project,
    // The panel reports a failed edit instead of throwing, so it has to be collected here:
    // an unreported failure is exactly how a dead control hides.
    edit: (mutate, message) => {
      const next = structuredClone(project);
      mutate(next);
      project = next;
      edits.push(message);
      // The editor re-renders every panel after a commit; without this the fake would show
      // the stack from before the click.
      state.draw();
    },
  });
  state.draw = () => panel.render(message => errors.push(message));
  state.draw();
  return { host, draw: state.draw, edits, errors, project: () => project };
};

const kindOrder = project => project.postFx.passes.map(pass => pass.kind);

const cards = host => host.findAll(element => element.tagName === 'ARTICLE');
const arrow = (host, index, text) => cards(host)[index].find(element => element.textContent === text);

test('the order arrows move a pass and re-render the stack', () => {
  const { host, project, edits, errors } = setup();
  assert.equal(cards(host).length, 2);
  assert.equal(arrow(host, 0, '↑').disabled, true, 'the first pass has nowhere to go up to');
  assert.equal(arrow(host, 1, '↑').disabled, false);
  arrow(host, 1, '↑').click();
  assert.deepEqual(kindOrder(project()), ['pixelization', 'fog']);
  assert.deepEqual(edits, ['Shader stack reordered']);
  assert.deepEqual(errors, []);
});

test('the On toggle and every slider reach the project', () => {
  const { host, project, errors } = setup();
  const fogCard = cards(host)[0];
  const checkbox = fogCard.find(element => element.tagName === 'INPUT' && element.type === 'checkbox');
  checkbox.checked = false;
  checkbox.dispatch('change');
  assert.equal(project().postFx.passes.find(pass => pass.kind === 'fog').enabled, false);

  const slider = fogCard.find(element => element.tagName === 'INPUT' && element.type === 'range');
  slider.value = '640';
  slider.dispatch('change');
  assert.equal(project().postFx.passes.find(pass => pass.kind === 'fog').params.near, 640);
  assert.deepEqual(errors, []);
});

test('a preset button replaces the stack, and adding keeps the stack switched on', () => {
  const { host, project, errors } = setup();
  const silentHill = host.find(element => element.textContent === 'Silent Hill');
  silentHill.click();
  assert.equal(kindOrder(project())[0], 'depthOfField');
  assert.equal(project().postFx.passes.length, POST_FX_PRESETS.find(preset => preset.id === 'silenthill').passes.length);

  const select = host.find(element => element.tagName === 'SELECT');
  select.value = 'gamma';
  select.dispatch('change');
  assert.ok(kindOrder(project()).includes('gamma'));
  assert.equal(project().postFx.enabled, true);
  assert.deepEqual(errors, []);
});

test('a stack with a colour pass above a sampling pass shows the order warning', () => {
  const { host, project, errors } = setup();
  const text = host.findAll(element => element.tagName === 'P').map(element => element.textContent).join('\n');
  assert.match(text, /Order warning: Pixelization sits below Fog/);

  // Moving the sampling pass up clears it on the next render.
  arrow(host, 1, '↑').click();
  const after = host.findAll(element => element.tagName === 'P').map(element => element.textContent).join('\n');
  assert.deepEqual(kindOrder(project()), ['pixelization', 'fog']);
  assert.doesNotMatch(after, /Order warning/);
  assert.deepEqual(errors, []);
});
