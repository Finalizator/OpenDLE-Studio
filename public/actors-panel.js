/**
 * Actors panel.
 *
 * Imported DECORATE/ZScript actors are data, so they get an editor like every
 * other part of the project: pick an actor, change its stats/flags/sounds, and
 * rewrite its state frames in DECORATE syntax.
 */

/** Serializes one action's argument list the way DECORATE writes it. */
function formatArgValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(value);
}
function formatAction(action) {
  const parts = (action.args || []).map(formatArgValue);
  for (const [key, value] of Object.entries(action.named || {})) parts.push(`${key}: ${formatArgValue(value)}`);
  return parts.length ? `${action.name}(${parts.join(', ')})` : action.name;
}

/** Renders the compiled frame list back into editable DECORATE-style lines. */
export function framesToText(actor) {
  const frames = actor.states?.frames || [];
  const lines = [];
  let label = null;
  for (const frame of frames) {
    // A state can begin with a control-flow frame (`Spawn: Goto See`), so the
    // label belongs to every frame kind, not only the ones that draw a sprite.
    if (frame.label && frame.label !== label) { label = frame.label; lines.push(`${label}:`); }
    if (frame.kind === 'frame') {
      const action = frame.actions?.length ? ` ${formatAction(frame.actions[0])}` : '';
      lines.push(`  ${frame.sprite} ${frame.letter} ${frame.duration}${action}${frame.bright ? ' Bright' : ''}`);
      continue;
    }
    if (frame.kind === 'goto') lines.push(`  Goto ${frame.target}`);
    else if (frame.kind === 'loop') lines.push('  Loop');
    else if (frame.kind === 'stop') lines.push('  Stop');
    else if (frame.kind === 'wait') lines.push('  Wait');
  }
  return lines.join('\n');
}

function splitArguments(text) {
  const parts = [];
  let part = '', depth = 0, quote = null;
  for (const char of text) {
    if (quote) { part += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; part += char; continue; }
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) { parts.push(part.trim()); part = ''; continue; }
    part += char;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}
function parseArgValue(raw) {
  const text = raw.trim();
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (text === 'null') return null;
  if (/^-?[0-9.]+$/.test(text) && text !== '') return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
}
function parseActionTail(tail) {
  const name = /^([A-Za-z_]\w*)/.exec(tail);
  if (!name) return null;
  const rest = tail.slice(name[1].length).trim();
  if (!rest) return { name: name[1], args: [], named: {} };
  if (!rest.startsWith('(') || !rest.endsWith(')')) return null;
  const args = [], named = {};
  for (const item of splitArguments(rest.slice(1, -1))) {
    const labelled = /^([a-z_]\w*)\s*:\s*([\s\S]+)$/i.exec(item);
    if (labelled) { named[labelled[1]] = parseArgValue(labelled[2]); continue; }
    const value = parseArgValue(item);
    if (value !== undefined) args.push(value);
  }
  return { name: name[1], args, named };
}

/** Parses the edited text back into a compiled frame list. */
export function textToFrames(text) {
  const frames = [], labels = {};
  let label = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const labelMatch = /^([A-Za-z_]\w*)\s*:$/.exec(line);
    if (labelMatch) { label = labelMatch[1]; labels[label] = frames.length; continue; }
    if (/^goto\b/i.test(line)) { frames.push({ kind: 'goto', target: line.split(/\s+/)[1], label }); continue; }
    if (/^loop$/i.test(line)) { frames.push({ kind: 'loop', target: label, label }); continue; }
    if (/^stop$/i.test(line)) { frames.push({ kind: 'stop', target: null, label }); continue; }
    if (/^wait$/i.test(line)) { frames.push({ kind: 'wait', target: null, label }); continue; }
    // `Bright` is a frame flag, not an action: strip it before reading the action
    // so a bright frame neither gains a bogus action nor becomes unreadable.
    let rest = line, bright = false;
    const brightFlag = /\s+[Bb]right$/.exec(rest);
    if (brightFlag) { bright = true; rest = rest.slice(0, brightFlag.index); }
    const head = /^([A-Za-z0-9_]{1,5})\s+([A-Za-z#-]+)\s+(-?\d+)/.exec(rest);
    if (!head) throw new Error(`Unreadable state line: ${line}`);
    const tail = rest.slice(head[0].length).trim();
    let actions = [];
    if (tail) {
      const action = parseActionTail(tail);
      if (!action) throw new Error(`Unreadable state line: ${line}`);
      actions = [action];
    }
    frames.push({ kind: 'frame', sprite: head[1].toUpperCase(), letter: head[2][0], duration: Number(head[3]),
      bright, label, actions });
  }
  return { frames, labels };
}

/** Filters actors for the panel list. */
export function visibleActors(actors, { search = '', filter = 'all' } = {}) {
  const query = search.trim().toLowerCase();
  return (actors || []).filter(actor => {
    if (filter === 'monster' && !actor.flags?.MONSTER) return false;
    if (filter === 'weapon' && !actor.flags?.WEAPON) return false;
    if (filter === 'item' && (actor.flags?.MONSTER || actor.flags?.WEAPON)) return false;
    if (!query) return true;
    return actor.name.toLowerCase().includes(query) || String(actor.doomedNum ?? '').includes(query);
  });
}

const STAT_FIELDS = ['health', 'speed', 'damage', 'painChance', 'radius', 'height', 'mass', 'reactionTime'];
const SOUND_FIELDS = ['see', 'pain', 'death', 'active', 'attack'];

export function createActorsPanel({ list, summary, gaps: gapNote, search, filter, form, title, fields, states }, { actors, edit, unsupported }) {
  let selected = null;

  function render() {
    const items = visibleActors(actors(), { search: search.value, filter: filter.value });
    const total = actors().length;
    const monsters = actors().filter(actor => actor.flags?.MONSTER).length;
    const weapons = actors().filter(actor => actor.flags?.WEAPON).length;
    summary.textContent = total
      ? `${total} actors: ${monsters} monsters, ${weapons} weapons, ${total - monsters - weapons} props and pickups.`
      : 'This project has no actor table yet; importing a WAD or PK3 fills it.';
    renderGaps();
    list.replaceChildren(...items.slice(0, 400).map(actor => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'actor-row';
      button.dataset.actor = actor.name;
      button.classList.toggle('selected', selected === actor.name);
      const kind = actor.flags?.MONSTER ? 'monster' : actor.flags?.WEAPON ? 'weapon' : 'prop';
      button.textContent = `${actor.name} · ${kind} · ${actor.doomedNum ?? 'no number'} · ${actor.health ?? 0} hp`;
      button.addEventListener('click', () => { selected = actor.name; render(); });
      return button;
    }));
    if (items.length > 400) list.append(Object.assign(document.createElement('p'),
      { className: 'muted', textContent: `Showing the first 400 of ${items.length} matches.` }));
    renderForm();
  }

  /**
   * Names the imported actors call that this runtime cannot execute. They are
   * skipped at the frame that calls them, so the gap belongs where the actors are
   * edited rather than only in a playtest log.
   */
  function renderGaps() {
    if (!gapNote) return;
    const missing = unsupported ? unsupported() : [];
    gapNote.hidden = !missing.length;
    if (!missing.length) { gapNote.textContent = ''; return; }
    const listed = missing.slice(0, 6).map(gap => `${gap.name}${gap.actors.length ? ` (${gap.actors.slice(0, 2).join(', ')}${gap.actors.length > 2 ? ', …' : ''})` : ''}`);
    gapNote.textContent = `${missing.length} action function${missing.length === 1 ? '' : 's'} used by this level's actors have no engine `
      + `equivalent and ${missing.length === 1 ? 'is' : 'are'} skipped: ${listed.join('; ')}`
      + `${missing.length > 6 ? `; and ${missing.length - 6} more` : ''}.` +
      ' Edit the state frames below to use a supported action, or extend the runtime.';
  }

  function renderForm() {
    const actor = actors().find(candidate => candidate.name === selected);
    form.hidden = !actor;
    if (!actor) return;
    title.textContent = `${actor.name}${actor.doomedNum !== null ? ` (editor number ${actor.doomedNum})` : ''}`;
    fields.replaceChildren();
    for (const stat of STAT_FIELDS) {
      const label = document.createElement('label');
      label.textContent = stat;
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(actor[stat] ?? 0);
      input.dataset.stat = stat;
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        edit(next => {
          const target = next.actors.find(candidate => candidate.name === actor.name);
          target[stat] = value; target.edited = true;
        }, `${actor.name} ${stat} set to ${value}`);
      });
      label.append(input);
      fields.append(label);
    }
    for (const flag of ['MONSTER', 'COUNTKILL', 'NOBLOOD', 'FLOAT', 'NOGRAVITY', 'BOSS', 'SHOOTABLE', 'SOLID', 'DROPOFF', 'NOTARGET']) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(actor.flags?.[flag]);
      input.addEventListener('change', () => edit(next => {
        const target = next.actors.find(candidate => candidate.name === actor.name);
        if (input.checked) target.flags[flag] = true; else delete target.flags[flag];
        target.edited = true;
      }, `${actor.name} ${flag} ${input.checked ? 'enabled' : 'disabled'}`));
      label.append(input, document.createTextNode(` ${flag}`));
      fields.append(label);
    }
    for (const sound of SOUND_FIELDS) {
      const label = document.createElement('label');
      label.textContent = `${sound} sound`;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = actor.sounds?.[sound] || '';
      input.addEventListener('change', () => edit(next => {
        const target = next.actors.find(candidate => candidate.name === actor.name);
        target.sounds ||= {};
        if (input.value) target.sounds[sound] = input.value; else delete target.sounds[sound];
        target.edited = true;
      }, `${actor.name} ${sound} sound`));
      label.append(input);
      fields.append(label);
    }
    // Translation specs repaint the actor's sprites, so they belong with the actor
    // that owns them. Imported sprites are re-baked on the next import.
    const translationLabel = document.createElement('label');
    translationLabel.textContent = 'Translation';
    const translationInput = document.createElement('input');
    translationInput.type = 'text';
    translationInput.placeholder = '128:151=80:111, 208:223=1';
    translationInput.value = [].concat(actor.translation ?? []).filter(entry => typeof entry === 'string').join(', ');
    translationInput.addEventListener('change', () => edit(next => {
      const target = next.actors.find(candidate => candidate.name === actor.name);
      const specs = translationInput.value.split(',').map(entry => entry.trim()).filter(Boolean);
      if (specs.length) target.translation = specs; else delete target.translation;
      target.edited = true;
    }, `${actor.name} translation`));
    translationLabel.append(translationInput);
    fields.append(translationLabel);
    states.replaceChildren();
    const label = document.createElement('label');
    label.textContent = 'State machine';
    const textarea = document.createElement('textarea');
    textarea.rows = 14;
    textarea.value = framesToText(actor);
    textarea.setAttribute('aria-label', `${actor.name} state frames`);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'Apply state frames';
    apply.addEventListener('click', () => {
      let parsed;
      try { parsed = textToFrames(textarea.value); }
      catch (error) { apply.textContent = error.message; return; }
      apply.textContent = 'Apply state frames';
      edit(next => {
        const target = next.actors.find(candidate => candidate.name === actor.name);
        target.states = parsed; target.edited = true;
      }, `${actor.name} state machine updated`);
    });
    label.append(textarea, apply);
    states.append(label);
  }

  search.addEventListener('input', render);
  filter.addEventListener('change', render);
  return { render, select(name) { selected = name; render(); } };
}
