import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createProject, validateProject } from '../shared/project.js';
import { createTrack, removeTimesheet, TIMESHEET_LIMITS, TIMESHEET_TRACK_COLORS } from '../shared/timesheet.js';

const source = readFileSync(new URL('../public/timesheet-panel.js', import.meta.url), 'utf8');

function fixture() {
  const document = { activeElement: null };
  const make = tag => {
    const node = {
      tagName: tag.toUpperCase(), children: [], className: '', dataset: {}, attributes: {}, listeners: new Map(),
      style: { setProperty() {} }, disabled: false,
      offsetWidth: 100,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = [...items]; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      focus() { document.activeElement = this; },
      scrollIntoView() { this.scrolled = true; },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        return descendants(this).filter(item => selector.split('.').filter(Boolean)
          .every(name => (item.className || '').split(' ').includes(name)));
      },
      classList: {
        toggle(name, on) {
          const names = new Set(node.className.split(' ').filter(Boolean));
          if (on) names.add(name); else names.delete(name);
          node.className = [...names].join(' ');
        },
      },
    };
    return node;
  };
  document.createElement = make;
  document.createTextNode = text => ({ textContent: text, children: [] });
  const context = vm.createContext({
    document, structuredClone, createTrack, removeTimesheet, TIMESHEET_LIMITS, TIMESHEET_TRACK_COLORS,
    commandRow: () => make('div'),
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('export function ', 'function '), context);
  let project = createProject();
  project.timesheets = [{
    id: 'timeline', name: 'Intro', duration: 4, loop: false, tracks: [createTrack(0), createTrack(1)],
    cues: [
      { id: 'source', name: 'Drive', time: 2, trackId: 'track_2', ownerId: 'pickup',
        actions: [{ type: 'setVariable', variable: 'score', value: 5 }] },
      { id: 'later', name: 'Later', time: 3, trackId: 'track_1', ownerId: null, actions: [] },
    ],
  }];
  const root = make('div'), history = [], notices = [];
  let menu = [];
  const panel = context.createTimesheetPanel({ root }, {
    project: () => project,
    edit(mutate) {
      const next = structuredClone(project);
      mutate(next);
      validateProject(next);
      history.push(project); project = next;
    },
    status: (message, error = false) => notices.push({ message, error }),
    contextMenu: (event, items) => { menu = items; },
  });
  panel.render();
  const event = () => ({ stopPropagation() {}, preventDefault() {} });
  const click = text => {
    const button = descendants(root).find(item => item.tagName === 'BUTTON' && item.textContent === text);
    assert.ok(button, text);
    assert.equal(button.disabled, false, `${text} is enabled`);
    button.listeners.get('click')(event());
  };
  const select = id => descendants(root).find(item => item.dataset?.cueId === id).listeners.get('click')(event());
  const key = (code, options = {}) => {
    const input = {
      code, ctrlKey: true, target: root, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      ...options,
    };
    root.listeners.get('keydown')(input);
    return input;
  };
  return {
    root, document, panel, history, notices, click, select, key,
    get project() { return project; },
    get sheet() { return project.timesheets[0]; },
    menu(id) {
      descendants(root).find(item => item.dataset?.cueId === id).listeners.get('contextmenu')(event());
      return menu;
    },
    undo() { project = history.pop(); panel.refresh(); },
  };
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

test('copy and paste preserve cue settings and frozen actions, insert after source, and undo atomically', () => {
  const f = fixture();
  f.select('source');
  f.click('Copy cue');
  assert.equal(f.history.length, 0, 'copy does not edit the project');
  assert.equal(f.notices.at(-1).error, false);
  f.sheet.cues[0].actions[0].value = 99;
  f.click('Paste cue');
  const [original, copy, later] = f.sheet.cues;
  assert.equal(original.id, 'source');
  assert.equal(later.id, 'later');
  assert.equal(later.time, 3, 'existing cues are not shifted');
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.time, 2.1);
  assert.equal(copy.trackId, original.trackId);
  assert.equal(copy.ownerId, original.ownerId);
  assert.deepEqual(copy.actions, [{ type: 'setVariable', variable: 'score', value: 5 }]);
  copy.actions[0].value = 7;
  assert.equal(original.actions[0].value, 99, 'pasted actions are independent');
  assert.equal(f.history.length, 1);
  assert.equal(f.root.querySelector('.timesheet-cue.selected').dataset.cueId, copy.id);
  assert.equal(f.root.querySelector('.timesheet-cue.selected').scrolled, true);
  assert.equal(f.document.activeElement, f.root);
  const [sourceBlock, copyBlock] = f.root.querySelectorAll('.timesheet-cue')
    .filter(block => [original.id, copy.id].includes(block.dataset.cueId));
  assert.notEqual(sourceBlock.style.top, copyBlock.style.top, 'close copies remain separately clickable');
  f.undo();
  assert.deepEqual(f.sheet.cues.map(cue => cue.id), ['source', 'later']);
});

test('keyboard paste repeats after the last copy, including Cmd shortcuts, with unique project-wide ids', () => {
  const f = fixture();
  f.project.timesheets.push({ ...structuredClone(f.sheet), id: 'other', cues: [{ ...structuredClone(f.sheet.cues[0]), id: 'cue_1' }] });
  f.select('source');
  assert.equal(f.key('KeyC', { ctrlKey: false, metaKey: true }).defaultPrevented, true);
  f.key('KeyV');
  f.key('KeyV', { ctrlKey: false, metaKey: true });
  const copies = f.sheet.cues.slice(1, 3);
  assert.deepEqual(copies.map(cue => cue.time), [2.1, 2.2]);
  assert.deepEqual(copies.map(cue => cue.id), ['cue_2', 'cue_3']);
  copies[0].actions[0].value = 100;
  assert.equal(copies[1].actions[0].value, 5);
  f.undo();
  f.key('KeyV');
  assert.equal(f.sheet.cues[2].time, 2.2, 'after undo, paste follows the last surviving copy');
  f.undo(); f.undo();
  f.key('KeyV');
  assert.equal(f.sheet.cues[1].time, 2.1, 'undoing all copies falls back to the original source');
});

test('pasting extends duration in the same undo step and duplicate uses the same placement', () => {
  const f = fixture();
  f.sheet.cues[0].time = 4;
  f.sheet.cues[0].name = 'D'.repeat(60);
  f.menu('source').find(item => item.label === 'Duplicate').run();
  assert.equal(f.sheet.duration, 4.1);
  assert.equal(f.sheet.cues[1].time, 4.1);
  assert.equal(f.sheet.cues[1].name.length, 60);
  assert.match(f.sheet.cues[1].name, / copy$/);
  validateProject(f.project);
  f.undo();
  assert.equal(f.sheet.duration, 4);
  assert.equal(f.sheet.cues.length, 2);
});

test('cue and duration limits report errors without partial changes', () => {
  const f = fixture();
  f.select('source'); f.key('KeyC');
  const original = structuredClone(f.sheet.cues[0]);
  f.sheet.cues = Array.from({ length: TIMESHEET_LIMITS.cues }, (_, index) => ({ ...original, id: `full_${index}` }));
  f.panel.render();
  f.key('KeyV');
  assert.match(f.notices.at(-1).message, /at most 512 cues/);
  assert.equal(f.notices.at(-1).error, true);
  assert.equal(f.history.length, 0);
  f.sheet.cues = [original];
  f.sheet.duration = 3600;
  f.sheet.cues[0].time = 3600;
  f.key('KeyV');
  assert.match(f.notices.at(-1).message, /No time remains/);
  assert.equal(f.sheet.cues.length, 1);
  assert.equal(f.history.length, 0);
  f.sheet.cues[0].time = 3599.9;
  f.key('KeyV');
  assert.equal(f.sheet.cues[1].time, 3600, 'the final legal instant remains usable');
});

test('other timelines and deleted sources use snapshot time and a valid destination track', () => {
  const f = fixture();
  f.menu('source').find(item => item.label === 'Copy cue').run();
  f.project.timesheets.push({
    id: 'destination', name: 'Destination', duration: 1, loop: false,
    tracks: [{ id: 'destination_track', name: 'Track' }], cues: [],
  });
  f.panel.select('destination');
  f.click('Paste cue');
  const destination = f.project.timesheets[1];
  assert.equal(destination.cues[0].time, 2.1);
  assert.equal(destination.duration, 2.1);
  assert.equal(destination.cues[0].trackId, 'destination_track');
  f.panel.select('timeline');
  f.sheet.cues.shift();
  f.click('Paste cue');
  assert.equal(f.sheet.cues.at(-1).time, 2.1);
  validateProject(f.project);
});

test('deleted object references are surfaced by project validation rather than restored or silently cleared', () => {
  const f = fixture();
  f.select('source'); f.key('KeyC');
  f.sheet.cues.shift();
  f.project.map.entities = f.project.map.entities.filter(entity => entity.id !== 'pickup');
  f.key('KeyV');
  assert.match(f.notices.at(-1).message, /targets an object that does not exist/);
  assert.equal(f.notices.at(-1).error, true);
  assert.equal(f.sheet.cues.length, 1);
  assert.equal(f.history.length, 0);
});

test('typing fields, unrelated shortcuts and already-handled keys retain their behavior', () => {
  const f = fixture();
  f.select('source');
  for (const options of [
    { target: { closest: () => ({}) } }, { shiftKey: true }, { altKey: true },
    { ctrlKey: false }, { defaultPrevented: true },
  ]) {
    const event = f.key('KeyC', options);
    assert.equal(event.stopped, undefined);
  }
  assert.equal(f.key('KeyZ').defaultPrevented, false);
  f.key('KeyV');
  assert.match(f.notices.at(-1).message, /Copy a timesheet cue first/);
  assert.equal(f.history.length, 0);
});

test('app clipboard routing reserves the visible timesheet instead of copying map objects, without stealing undo', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf("document.addEventListener('keydown', event => {", app.indexOf('function pasteEntities()'));
  const end = app.indexOf('function hitTest(', start);
  let keydown, cueKeys = 0, entityCopies = 0, entityPastes = 0, undo = 0;
  const panel = { hidden: false };
  const context = vm.createContext({
    document: { addEventListener: (type, callback) => { keydown = callback; } },
    $: id => id === 'timesheet-panel' ? panel : { disabled: false, click() { undo++; } },
    runtime: null,
    timesheetPanel: { handleClipboardKey(event) { cueKeys++; event.preventDefault(); } },
    copySelectedEntities() { entityCopies++; return true; }, pasteEntities() { entityPastes++; return true; },
  });
  vm.runInContext(app.slice(start, end), context);
  const event = code => ({ code, ctrlKey: true, preventDefault() { this.defaultPrevented = true; } });
  keydown(event('KeyC')); keydown(event('KeyV'));
  assert.equal(cueKeys, 2);
  assert.equal(entityCopies + entityPastes, 0);
  keydown(event('KeyZ'));
  assert.equal(undo, 1);
  keydown({ ...event('KeyC'), defaultPrevented: true });
  assert.equal(cueKeys, 2);
  panel.hidden = true;
  keydown(event('KeyC')); keydown(event('KeyV'));
  assert.equal(entityCopies, 1);
  assert.equal(entityPastes, 1);
});
