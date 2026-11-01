import { createTrack, removeTimesheet, TIMESHEET_LIMITS, TIMESHEET_TRACK_COLORS } from '/shared/timesheet.js';
import { commandRow, openCommandDialog } from './event-sheet.js';

/**
 * The Timesheet editor: tracks over one clock, cues that carry visual-script actions.
 *
 * A cue is not a special kind of rule — it compiles into one (`shared/timesheet.js`) — so this
 * panel's job is only to place them on a timeline and let the same action dialog the event sheet
 * uses fill them in. Nothing here starts a timeline: a cue runs when a rule started it.
 *
 * The panel deliberately does not write that rule. A button that silently added an event somewhere
 * else in the project was easy to press twice and impossible to find again; starting a timeline is
 * the event sheet's job, and the editor's "drive this route on a timesheet" recipe writes the rule
 * where the author can see it.
 */

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const seconds = value => `${Math.round(value * 10) / 10}s`;
const clock = value => {
  const whole = Math.floor(value), tenths = Math.round((value - whole) * 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${tenths}`;
};

export function createTimesheetPanel(nodes, {
  project, edit, status = () => {}, commandContext = () => ({}), defaults = null, labels = [], contextMenu = null,
} = {}) {
  if (!nodes?.root) throw new Error('The timesheet panel needs a root node');
  let selectedId = null, selectedCue = null, pixelsPerSecond = 60, playhead = 0;

  const timesheets = () => project()?.timesheets || [];
  const current = () => timesheets().find(sheet => sheet.id === selectedId) || timesheets()[0] || null;

  const newId = prefix => {
    const used = new Set([...timesheets().map(sheet => sheet.id),
      ...timesheets().flatMap(sheet => [...(sheet.tracks || []).map(track => track.id), ...(sheet.cues || []).map(cue => cue.id)])]);
    let index = 1;
    while (used.has(`${prefix}_${index}`)) index++;
    return `${prefix}_${index}`;
  };

  /** Every mutation goes through the app's `edit`, so a timeline edit is one undo step. */
  function change(mutate, message) {
    edit(next => { mutate(next); }, message);
    render();
  }

  function addTimesheet() {
    const sheet = { id: newId('timesheet'), name: `Timesheet ${timesheets().length + 1}`,
      duration: 30, loop: false, tracks: [createTrack(0)], cues: [] };
    selectedId = sheet.id; selectedCue = null;
    change(next => { (next.timesheets ||= []).push(sheet); }, `Timesheet "${sheet.name}" added`);
  }

  function deleteTimesheet(sheet) {
    if (!confirm(`Delete the timeline "${sheet.name}" and its ${sheet.cues.length} cue(s)? You can undo this change.`)) return;
    selectedId = null; selectedCue = null;
    let released = 0, rules = 0;
    change(next => {
      const result = removeTimesheet(next, sheet.id);
      released = result?.actions || 0;
      rules = result?.rules || 0;
    }, 'Timesheet deleted');
    // `change` renders and sets its own message first; the counts only exist once the edit ran.
    if (released) status(`Timeline "${sheet.name}" deleted · ${released} action(s) that named it removed${rules ? `, and ${rules} rule(s) that only started it` : ''}`);
  }

  function addCue(sheet, time = playhead, trackId = sheet.tracks[0]?.id) {
    const cue = { id: newId('cue'), name: `Cue ${sheet.cues.length + 1}`, trackId,
      time: Math.max(0, Math.min(sheet.duration, Math.round(time * 10) / 10)), ownerId: null, actions: [] };
    selectedCue = cue.id;
    change(next => {
      const target = next.timesheets.find(item => item.id === sheet.id);
      target.cues = [...target.cues, cue];
    }, `Cue added at ${seconds(cue.time)}`);
  }

  function removeCue(sheet, cue) {
    if (selectedCue === cue.id) selectedCue = null;
    change(next => {
      const target = next.timesheets.find(item => item.id === sheet.id);
      target.cues = target.cues.filter(item => item.id !== cue.id);
    }, 'Cue deleted');
  }

  function duplicateCue(sheet, cue) {
    const copy = { ...structuredClone(cue), id: newId('cue'), name: `${cue.name} copy` };
    selectedCue = copy.id;
    change(next => {
      const target = next.timesheets.find(item => item.id === sheet.id);
      target.cues = [...target.cues, copy];
    }, 'Cue duplicated');
  }

  function patchCue(sheet, cueId, patch, message) {
    change(next => {
      const target = next.timesheets.find(item => item.id === sheet.id);
      Object.assign(target.cues.find(item => item.id === cueId), patch);
    }, message);
  }

  function patchSheet(sheet, patch, message) {
    change(next => Object.assign(next.timesheets.find(item => item.id === sheet.id), patch), message);
  }

  /** Opens the shared action dialog for one cue action. */
  function editAction(sheet, cue, action, index) {
    const version = project();
    const context = commandContext(cue.ownerId);
    openCommandDialog({
      kind: 'action', labels, command: action || undefined,
      // The dialog asks `defaults(type)` when a command is picked from the catalogue; the panel
      // passes the editor's own default builder so a cue action starts out the same way an event
      // action does (targets filled in, groups and shader uniforms pre-selected).
      defaults: defaults ? type => defaults(type, cue.ownerId) : type => ({ type }),
      ...context,
      submit: value => {
        if (version !== project()) throw new Error('Project changed while the dialog was open. Reopen it.');
        change(next => {
          const target = next.timesheets.find(item => item.id === sheet.id);
          const line = target.cues.find(item => item.id === cue.id);
          if (index === null) line.actions = [...line.actions, value];
          else line.actions = line.actions.map((item, at) => at === index ? value : item);
        }, action ? 'Cue action updated' : 'Cue action added');
      },
      remove: index === null ? undefined : () => change(next => {
        const target = next.timesheets.find(item => item.id === sheet.id);
        const line = target.cues.find(item => item.id === cue.id);
        line.actions = line.actions.filter((item, at) => at !== index);
      }, 'Cue action removed'),
      move: index === null ? undefined : direction => change(next => {
        const target = next.timesheets.find(item => item.id === sheet.id);
        const line = target.cues.find(item => item.id === cue.id);
        const at = index + direction;
        if (at < 0 || at >= line.actions.length) return;
        const copy = [...line.actions];
        [copy[index], copy[at]] = [copy[at], copy[index]];
        line.actions = copy;
      }, 'Cue action moved'),
    });
  }

  function render() {
    const root = nodes.root;
    root.replaceChildren();
    const sheet = current();
    if (!sheet && !timesheets().length) {
      const empty = element('div', 'timesheet-empty');
      empty.append(
        element('p', 'muted', 'A timesheet is a timeline: tracks over one clock, with cues that run ordinary '
          + 'visual-script actions at the moment the clock reaches them. Nothing plays until an event starts it, and '
          + 'that rule belongs to the Events tab (On start of layout → Timesheet: start) where you can see and delete it.'),
        element('p', 'muted', 'Quickest way to make one: select an object that has a route in the 3D view and press '
          + '"Drive this route on a timesheet (start to end)" in its Properties — that writes the timeline, the cue '
          + 'and the start event for you.'),
        (() => { const button = element('button', 'primary', 'New timesheet'); button.type = 'button';
          button.addEventListener('click', addTimesheet); return button; })(),
      );
      root.append(empty);
      return;
    }
    root.append(toolbar(sheet), timeline(sheet), inspector(sheet));
  }

  function toolbar(sheet) {
    const bar = element('div', 'timesheet-toolbar');
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', 'Timesheet');
    for (const item of timesheets()) {
      const option = document.createElement('option');
      option.value = item.id; option.textContent = `${item.name} (${item.cues.length} cues)`; option.selected = item.id === sheet.id;
      picker.append(option);
    }
    picker.addEventListener('change', () => { selectedId = picker.value; selectedCue = null; render(); });
    const add = element('button', '', 'New');
    add.type = 'button'; add.addEventListener('click', addTimesheet);
    const remove = element('button', '', 'Delete');
    remove.type = 'button'; remove.addEventListener('click', () => deleteTimesheet(sheet));
    const name = document.createElement('input');
    name.type = 'text'; name.value = sheet.name; name.setAttribute('aria-label', 'Timesheet name');
    name.addEventListener('change', () => patchSheet(sheet, { name: name.value.trim() || sheet.name }, 'Timesheet renamed'));
    const duration = document.createElement('input');
    duration.type = 'number'; duration.min = TIMESHEET_LIMITS.duration[0]; duration.max = TIMESHEET_LIMITS.duration[1];
    duration.step = '.5'; duration.value = sheet.duration; duration.setAttribute('aria-label', 'Duration in seconds');
    duration.addEventListener('change', () => {
      const value = Math.min(TIMESHEET_LIMITS.duration[1], Math.max(TIMESHEET_LIMITS.duration[0], Number(duration.value) || 30));
      patchSheet(sheet, { duration: value }, `Timeline set to ${value} seconds`);
    });
    const loopLabel = element('label', 'timesheet-loop');
    const loop = document.createElement('input');
    loop.type = 'checkbox'; loop.checked = Boolean(sheet.loop);
    loop.addEventListener('change', () => patchSheet(sheet, { loop: loop.checked }, loop.checked ? 'Timeline loops' : 'Timeline plays once'));
    loopLabel.append(loop, document.createTextNode(' Loop'));
    const cue = element('button', 'primary', 'Cue at playhead');
    cue.type = 'button'; cue.addEventListener('click', () => addCue(sheet, playhead));
    const zoomOut = element('button', '', '\u2212');
    zoomOut.type = 'button'; zoomOut.title = 'Zoom out';
    zoomOut.addEventListener('click', () => { pixelsPerSecond = Math.max(12, Math.round(pixelsPerSecond * .75)); render(); });
    const zoomIn = element('button', '', '+');
    zoomIn.type = 'button'; zoomIn.title = 'Zoom in';
    zoomIn.addEventListener('click', () => { pixelsPerSecond = Math.min(400, Math.round(pixelsPerSecond * 1.33)); render(); });
    bar.append(element('label', 'timesheet-field', 'Timesheet'), picker, add, remove,
      (() => { const label = element('label', 'timesheet-field', 'Name'); label.append(name); return label; })(),
      (() => { const label = element('label', 'timesheet-field', 'Duration (s)'); label.append(duration); return label; })(),
      loopLabel, cue,
      (() => { const group = element('span', 'timesheet-zoom'); group.append(element('span', 'muted', 'Zoom'), zoomOut, zoomIn); return group; })());
    return bar;
  }

  function timeline(sheet) {
    const wrap = element('div', 'timesheet');
    const width = Math.max(240, sheet.duration * pixelsPerSecond);
    const ruler = element('div', 'timesheet-ruler');
    ruler.style.width = `${width}px`;
    // One tick per second, a label every five, so a long timeline stays readable when zoomed out.
    const step = pixelsPerSecond >= 40 ? 1 : pixelsPerSecond >= 20 ? 2 : 5;
    for (let time = 0; time <= sheet.duration + 1e-9; time += step) {
      const tick = element('span', 'timesheet-tick', time % 5 === 0 ? `${time}s` : '');
      tick.style.left = `${time * pixelsPerSecond}px`;
      tick.dataset.time = String(time);
      ruler.append(tick);
    }
    ruler.addEventListener('pointerdown', event => {
      const box = ruler.getBoundingClientRect();
      playhead = Math.max(0, Math.min(sheet.duration, (event.clientX - box.left) / pixelsPerSecond));
      render();
    });
    ruler.addEventListener('dblclick', event => {
      const box = ruler.getBoundingClientRect();
      addCue(sheet, (event.clientX - box.left) / pixelsPerSecond);
    });

    const rulerHighlight = element('span', 'timesheet-playhead');
    rulerHighlight.style.left = `${playhead * pixelsPerSecond}px`;
    ruler.append(rulerHighlight);

    const body = element('div', 'timesheet-body');
    const rows = element('div', 'timesheet-rows');
    sheet.tracks.forEach((track, index) => {
      const row = element('div', 'timesheet-track');
      row.dataset.trackId = track.id;
      const head = element('div', 'timesheet-track-head');
      const name = document.createElement('input');
      name.type = 'text'; name.value = track.name; name.setAttribute('aria-label', `Track ${index + 1} name`);
      name.addEventListener('change', () => change(next => {
        const target = next.timesheets.find(item => item.id === sheet.id);
        target.tracks.find(item => item.id === track.id).name = name.value.trim() || track.name;
      }, 'Track renamed'));
      head.style.borderLeftColor = TIMESHEET_TRACK_COLORS[index % TIMESHEET_TRACK_COLORS.length];
      head.append(element('span', 'timesheet-track-number', String(index + 1)), name);
      if (sheet.tracks.length > 1) {
        const drop = element('button', 'timesheet-track-remove', '\u00d7');
        drop.type = 'button'; drop.title = 'Remove this track';
        drop.addEventListener('click', () => {
          if (sheet.cues.some(cue => cue.trackId === track.id)) {
            status('Move or delete this track\'s cues first', true);
            return;
          }
          change(next => {
            const target = next.timesheets.find(item => item.id === sheet.id);
            target.tracks = target.tracks.filter(item => item.id !== track.id);
          }, 'Track removed');
        });
        head.append(drop);
      }
      const lane = element('div', 'timesheet-lane');
      lane.style.width = `${width}px`;
      lane.dataset.trackId = track.id;
      for (const cue of sheet.cues.filter(item => item.trackId === track.id)) lane.append(cueBlock(sheet, cue, lane));
      row.append(head, lane);
      rows.append(row);
    });
    const addTrack = element('button', 'timesheet-add-track', '+ Track');
    addTrack.type = 'button';
    addTrack.disabled = sheet.tracks.length >= TIMESHEET_LIMITS.tracks;
    addTrack.addEventListener('click', () => change(next => {
      const target = next.timesheets.find(item => item.id === sheet.id);
      const index = target.tracks.length;
      target.tracks.push({ id: `track_${index + 1}_${target.cues.length}`, name: `Track ${index + 1}` });
    }, 'Track added'));
    body.append(rows, addTrack);
    wrap.append(ruler, body);
    wrap.style.setProperty('--timesheet-width', `${width}px`);
    // The lanes draw their five-second gridlines from the same scale the cues use.
    wrap.style.setProperty('--timesheet-zoom', String(pixelsPerSecond));
    return wrap;
  }

  function cueBlock(sheet, cue, lane) {
    const block = element('button', 'timesheet-cue');
    block.type = 'button';
    block.style.left = `${cue.time * pixelsPerSecond}px`;
    block.style.borderColor = TIMESHEET_TRACK_COLORS[Math.max(0, sheet.tracks.findIndex(track => track.id === cue.trackId)) % TIMESHEET_TRACK_COLORS.length];
    block.classList.toggle('selected', cue.id === selectedCue);
    block.append(element('span', 'timesheet-cue-name', cue.name),
      element('span', 'timesheet-cue-time', clock(cue.time)),
      element('span', 'timesheet-cue-actions', `${cue.actions.length} action${cue.actions.length === 1 ? '' : 's'}`));
    block.title = `${cue.name} at ${seconds(cue.time)} — double-click to edit its actions, drag to move`;
    block.addEventListener('click', event => {
      event.stopPropagation();
      selectedCue = cue.id; playhead = cue.time; render();
    });
    block.addEventListener('dblclick', event => { event.stopPropagation(); editAction(sheet, cue, null, null); });
    block.addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopPropagation();
      selectedCue = cue.id; render();
      const items = [
        { label: 'Edit actions', run: () => editAction(sheet, cue, null, null) },
        { label: 'Move to playhead', run: () => patchCue(sheet, cue.id, { time: Math.round(playhead * 10) / 10 }, 'Cue moved') },
        { label: 'Duplicate', run: () => duplicateCue(sheet, cue) },
        { separator: true },
        { label: 'Delete cue', danger: true, run: () => removeCue(sheet, cue) },
      ];
      if (contextMenu) contextMenu(event, items);
      else items.forEach(() => {});
    });
    // Dragging moves the cue in time and between tracks; the lane's own geometry is the scale.
    block.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX, startY = event.clientY, startTime = cue.time;
      let targetTrack = cue.trackId, moved = false;
      block.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        const delta = (moveEvent.clientX - startX) / pixelsPerSecond;
        const time = Math.max(0, Math.min(sheet.duration, Math.round((startTime + delta) * 20) / 20));
        block.style.left = `${time * pixelsPerSecond}px`;
        block.querySelector('.timesheet-cue-time').textContent = clock(time);
        const dy = moveEvent.clientY - startY;
        if (Math.abs(dy) > 12) {
          const row = document.elementsFromPoint(moveEvent.clientX, moveEvent.clientY)
            .find(node => node.classList?.contains('timesheet-lane'));
          if (row?.dataset.trackId) targetTrack = row.dataset.trackId;
        }
        if (Math.abs(moveEvent.clientX - startX) > 1 || Math.abs(dy) > 1) moved = true;
        block.dataset.pendingTime = String(time);
      };
      const up = () => {
        block.removeEventListener('pointermove', move);
        block.removeEventListener('pointerup', up);
        block.removeEventListener('pointercancel', up);
        if (!moved) return;
        const time = Number(block.dataset.pendingTime || cue.time);
        delete block.dataset.pendingTime;
        patchCue(sheet, cue.id, { time, trackId: targetTrack }, `Cue moved to ${seconds(time)}`);
      };
      block.addEventListener('pointermove', move);
      block.addEventListener('pointerup', up);
      block.addEventListener('pointercancel', up);
    });
    return block;
  }

  function inspector(sheet) {
    const cue = sheet.cues.find(item => item.id === selectedCue);
    const panel = element('div', 'timesheet-inspector');
    if (!cue) {
      panel.append(element('p', 'muted', 'Select a cue to edit it, or double-click the ruler to add one there. '
        + 'Cue actions are ordinary visual-script actions: set a variable, move an object, play a sound, start another timeline.'));
      return panel;
    }
    const heading = element('h3', '', `Cue: ${cue.name}`);
    const fields = element('div', 'timesheet-cue-fields');
    const name = document.createElement('input');
    name.type = 'text'; name.value = cue.name; name.setAttribute('aria-label', 'Cue name');
    name.addEventListener('change', () => patchCue(sheet, cue.id, { name: name.value.trim() || cue.name }, 'Cue renamed'));
    const time = document.createElement('input');
    time.type = 'number'; time.min = 0; time.max = sheet.duration; time.step = '.1'; time.value = cue.time;
    time.setAttribute('aria-label', 'Cue time in seconds');
    time.addEventListener('change', () => patchCue(sheet, cue.id,
      { time: Math.max(0, Math.min(sheet.duration, Number(time.value) || 0)) }, 'Cue time changed'));
    const track = document.createElement('select');
    track.setAttribute('aria-label', 'Cue track');
    for (const item of sheet.tracks) {
      const option = document.createElement('option');
      option.value = item.id; option.textContent = item.name; option.selected = item.id === cue.trackId;
      track.append(option);
    }
    track.addEventListener('change', () => patchCue(sheet, cue.id, { trackId: track.value }, 'Cue moved to another track'));
    const owner = document.createElement('select');
    owner.setAttribute('aria-label', 'Cue target object');
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'No object (This object is unavailable)'; none.selected = !cue.ownerId;
    owner.append(none);
    const objects = commandContext(cue.ownerId).entities || [];
    for (const [id, label] of objects) {
      const option = document.createElement('option');
      option.value = id; option.textContent = label; option.selected = id === cue.ownerId;
      owner.append(option);
    }
    // A cue can name an object the map no longer has; without an option for it the select would
    // fall back to its first entry and quietly claim the cue targets nothing.
    if (cue.ownerId && !objects.some(([id]) => id === cue.ownerId)) {
      const missing = document.createElement('option');
      missing.value = cue.ownerId; missing.textContent = `${cue.ownerId} (not in this layout)`; missing.selected = true;
      owner.append(missing);
    }
    owner.addEventListener('change', () => patchCue(sheet, cue.id, { ownerId: owner.value || null },
      owner.value ? 'Cue target set' : 'Cue target cleared'));
    const field = (label, node) => { const wrapper = element('label', 'timesheet-field', label); wrapper.append(node); return wrapper; };
    fields.append(field('Name', name), field('At (s)', time), field('Track', track), field('Object', owner));

    const list = element('div', 'timesheet-actions');
    if (!cue.actions.length) list.append(element('p', 'muted', 'No actions yet. Add one to say what happens at this moment.'));
    cue.actions.forEach((action, index) => {
      const row = commandRow(action, labels, id => (commandContext(cue.ownerId).entities || []).find(([value]) => value === id)?.[1] || id,
        () => editAction(sheet, cue, action, index),
        { waypointName: commandContext(cue.ownerId).waypointName });
      const removeButton = element('button', 'timesheet-action-remove', '\u00d7');
      removeButton.type = 'button'; removeButton.title = 'Remove this action';
      removeButton.addEventListener('click', () => change(next => {
        const target = next.timesheets.find(item => item.id === sheet.id);
        const line = target.cues.find(item => item.id === cue.id);
        line.actions = line.actions.filter((item, at) => at !== index);
      }, 'Cue action removed'));
      const wrapper = element('div', 'timesheet-action-row');
      wrapper.append(row, removeButton);
      list.append(wrapper);
    });
    const add = element('button', 'primary', '+ Action at this cue');
    add.type = 'button'; add.addEventListener('click', () => editAction(sheet, cue, null, null));
    const remove = element('button', 'danger', 'Delete cue');
    remove.type = 'button'; remove.addEventListener('click', () => removeCue(sheet, cue));
    panel.append(heading, fields, list, (() => {
      const row = element('div', 'button-row'); row.append(add, remove); return row;
    })());
    return panel;
  }

  return {
    render,
    /** The panel is rebuilt from the project, so `refresh` is the same thing said plainly. */
    refresh: render,
    select(id) { selectedId = id; selectedCue = null; render(); },
    /** Which timeline the panel is showing, so an outside list can mark it. */
    selectedId: () => current()?.id ?? null,
    /** Creates a timeline and opens it. The Project tree makes its own rows with this. */
    add(name) {
      const sheet = { id: newId('timesheet'), name: name || `Timesheet ${timesheets().length + 1}`,
        duration: 30, loop: false, tracks: [createTrack(0)], cues: [] };
      selectedId = sheet.id; selectedCue = null;
      change(next => { (next.timesheets ||= []).push(sheet); }, `Timesheet "${sheet.name}" added`);
      return sheet.id;
    },
    /** Deletes a timeline, asking first: the panel's own Delete button goes through here too. */
    remove(id) {
      const sheet = timesheets().find(item => item.id === id);
      if (sheet) deleteTimesheet(sheet);
    },
    rename(id, name) {
      const sheet = timesheets().find(item => item.id === id);
      const clean = String(name ?? '').trim();
      if (!sheet || !clean || clean === sheet.name) return false;
      patchSheet(sheet, { name: clean.slice(0, TIMESHEET_LIMITS.name) }, `Timeline renamed to "${clean}"`);
      return true;
    },
  };
}
