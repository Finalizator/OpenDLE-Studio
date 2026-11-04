/**
 * The Shader Engine panel.
 *
 * One page for the whole post-processing stack: which techniques run, in what order, and
 * what each of their parameters is worth. Everything here is project data — `project.postFx`
 * — so a look travels with the game, an undo takes it back, and a visual script can change
 * any of it at play time (`setPostFxParam`, `setPostFxPass`, `setPostFxStack`).
 *
 * The techniques are the ones in *3D Game Shaders For Beginners*; each card names the
 * chapter it comes from so the source of the math is never a mystery.
 */
import {
  POST_FX_CATALOG, POST_FX_BY_KIND, POST_FX_PRESETS, createPostFxPass, defaultPostFx, postFxPreset,
} from '/shared/post-fx.js';

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

const BOOK_URL = 'https://github.com/lettier/3d-game-shaders-for-beginners/blob/master/sections/';

export function createShaderEnginePanel(host, { project: getProject, edit }) {
  const safe = fn => (...args) => {
    try {
      const result = fn(...args);
      if (result?.catch) result.catch(error => fail(error.message));
    } catch (error) { fail(error.message); }
  };
  let fail = () => {};
  const change = (mutate, message) => safe(() => edit(mutate, message));
  const stack = () => getProject().postFx || defaultPostFx();
  const passOf = kind => (stack().passes || []).find(pass => pass.kind === kind) || null;

  function toggle(text, checked, onchange) {
    const label = node('label', undefined, 'shader-toggle');
    const input = node('input');
    input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', () => onchange(input.checked));
    label.append(input, node('span', text));
    return label;
  }

  function slider(spec, value, onchange) {
    const row = node('div', undefined, 'shader-param');
    const label = node('label', spec.label);
    const readout = node('output', String(round(value)));
    const input = node('input');
    input.type = 'range'; input.min = String(spec.min); input.max = String(spec.max); input.step = String(spec.step);
    input.value = String(value);
    input.setAttribute('aria-label', spec.label);
    input.addEventListener('input', () => { readout.textContent = String(round(Number(input.value))); });
    // `change` fires when the handle is released, so one drag is one undoable edit.
    input.addEventListener('change', () => onchange(Number(input.value)));
    label.append(input, readout);
    row.append(label);
    if (spec.hint) row.append(node('small', spec.hint, 'muted'));
    return row;
  }

  const round = value => Math.round(Number(value) * 1000) / 1000;

  function addMenu() {
    const available = POST_FX_CATALOG.filter(entry => !passOf(entry.kind));
    const select = node('select');
    select.setAttribute('aria-label', 'Add a technique to the stack');
    select.append(new Option(available.length ? 'Add a technique…' : 'Every technique is in the stack', ''));
    for (const entry of available) select.append(new Option(entry.name, entry.kind));
    select.disabled = !available.length;
    select.addEventListener('change', change(next => {
      const kind = select.value;
      if (!kind) return;
      next.postFx = next.postFx || defaultPostFx();
      next.postFx.passes = [...(next.postFx.passes || []), createPostFxPass(kind)];
      // Adding a technique is a request to see it: an "Off" stack becomes active again.
      next.postFx.enabled = true;
    }, 'Technique added to the shader stack'));
    return select;
  }

  function movePass(kind, direction) {
    change(next => {
      const passes = [...(next.postFx?.passes || [])];
      const index = passes.findIndex(pass => pass.kind === kind);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= passes.length) throw new Error('That effect is already at the end of the stack');
      [passes[index], passes[target]] = [passes[target], passes[index]];
      next.postFx.passes = passes;
    }, 'Shader stack reordered');
  }

  function card(pass) {
    const entry = POST_FX_BY_KIND.get(pass.kind);
    if (!entry) return null;
    const element = node('article', undefined, 'shader-card');
    element.dataset.kind = pass.kind;
    const head = node('div', undefined, 'shader-card-head');
    const title = node('div', undefined, 'shader-card-title');
    const link = node('a', entry.name);
    link.href = `${BOOK_URL}${entry.section}.md`;
    link.target = '_blank'; link.rel = 'noreferrer noopener';
    title.append(link, node('small', `Chapter: ${entry.section.replace(/-/g, ' ')}`, 'muted'));
    const tools = node('div', undefined, 'shader-card-tools');
    tools.append(toggle('On', pass.enabled !== false, checked => change(next => {
      const target = (next.postFx?.passes || []).find(candidate => candidate.kind === pass.kind);
      if (target) target.enabled = checked;
    }, `${entry.name} ${checked ? 'enabled' : 'disabled'}`)));
    const up = node('button', '↑'); up.type = 'button'; up.title = 'Move earlier in the stack';
    up.addEventListener('click', () => movePass(pass.kind, -1));
    const down = node('button', '↓'); down.type = 'button'; down.title = 'Move later in the stack';
    down.addEventListener('click', () => movePass(pass.kind, 1));
    const remove = node('button', 'Remove'); remove.type = 'button';
    remove.addEventListener('click', change(next => {
      next.postFx.passes = (next.postFx.passes || []).filter(candidate => candidate.kind !== pass.kind);
    }, `${entry.name} removed from the stack`));
    const reset = node('button', 'Reset'); reset.type = 'button'; reset.title = 'Back to the book\'s starting values';
    reset.addEventListener('click', change(next => {
      const fresh = createPostFxPass(pass.kind);
      const target = (next.postFx.passes || []).find(candidate => candidate.kind === pass.kind);
      if (target) target.params = fresh.params;
    }, `${entry.name} reset`));
    tools.append(up, down, reset, remove);
    head.append(title, tools);
    element.append(head, node('p', entry.summary, 'shader-summary'));
    for (const spec of entry.params) {
      element.append(slider(spec, pass.params?.[spec.name] ?? spec.value, value => change(next => {
        const target = (next.postFx?.passes || []).find(candidate => candidate.kind === pass.kind);
        if (!target) return;
        target.params = { ...(target.params || {}), [spec.name]: Math.min(spec.max, Math.max(spec.min, value)) };
      }, `${entry.name}: ${spec.label}`)));
    }
    return element;
  }

  function render(errorReporter) {
    fail = message => errorReporter?.(message);
    const current = stack();
    const children = [];
    const heading = node('div', undefined, 'panel-heading');
    const text = node('div');
    text.append(node('h1', 'Shader engine'),
      node('p', 'Full-screen effect passes ported from 3D Game Shaders For Beginners. They run in order over the rendered frame; a pass reads what the pass before it produced.'));
    heading.append(text);
    const master = toggle('Shader stack enabled', current.enabled !== false, checked => change(next => {
      next.postFx = next.postFx || defaultPostFx();
      next.postFx.enabled = checked;
    }, checked ? 'Shader stack enabled' : 'Shader stack disabled'));
    heading.append(master);
    children.push(heading);

    const presets = node('div', undefined, 'shader-presets');
    presets.append(node('strong', 'Presets'));
    for (const preset of POST_FX_PRESETS) {
      const button = node('button', preset.name);
      button.type = 'button';
      button.title = preset.passes.length ? preset.passes.map(pass => pass.kind).join(' → ') : 'No passes: the frame is drawn untouched';
      button.addEventListener('click', change(next => { next.postFx = postFxPreset(preset.id); },
        `Shader preset ${preset.name}`));
      presets.append(button);
    }
    children.push(presets);

    const passes = current.passes || [];
    const list = node('div', undefined, 'shader-stack');
    if (!passes.length) list.append(node('p', 'No effects yet: the level is drawn straight to the screen. Add a technique below, or start from a preset.', 'muted'));
    for (const pass of passes) {
      const element = card(pass);
      if (element) list.append(element);
    }
    children.push(list);

    const footer = node('div', undefined, 'shader-add');
    footer.append(addMenu());
    footer.append(node('p', 'Visual scripts can carry the same controls at play time: Shaders: set an effect parameter, enable / disable one effect pass, and enable / disable the effect stack. Runtime changes reset when the level restarts.', 'muted'));
    children.push(footer);

    host.replaceChildren(...children);
  }

  return { render };
}
