import { engineCommand, defaultEngineCommand } from '/shared/engine-script.js';
import { commandFields } from '/shared/command-fields.js';
import { nodeSignals } from '/shared/signals.js';
import { eventBranch, TRIGGER_CONDITIONS } from '/shared/events.js';

export { commandFields };
import { isExpression, EXPRESSION_HELP } from '/shared/expressions.js';

const categoryOf = (type, label) => type.startsWith('key') ? 'Keyboard' : type === 'mouseMoved' ? 'Mouse'
  : label.includes(':') ? label.split(':')[0] : ['nearEntity', 'playerGrounded'].includes(type) ? 'Player' : 'System';
const labelOf = label => label.includes(':') ? label.split(':').slice(1).join(':').trim() : label;
const titles = {
  onStart: 'On start of layout', always: 'Every tick', keyHeld: 'Is down', keyPressed: 'On pressed',
  mouseMoved: 'On mouse movement', movePlayer: 'Move locally', turnPlayer: 'Turn', mouseLook: 'Apply mouse look',
  playerStat: 'Compare player stat', entityHealth: 'Compare health', variableCompare: 'Compare variable',
  hitscan: 'Fire hitscan', timerReady: 'Timer is ready', startTimer: 'Start timer', showPlayerHUD: 'Show player HUD',
};

export function describeCommand(command, labels, objectName, waypointName = null) {
  const label = labels.find(([type]) => type === command.type)?.[1] || command.type;
  const parts = Object.entries(command).filter(([key]) => !['type', 'inverted', 'entityId', 'otherId'].includes(key))
    .map(([key, value]) => {
      // An optional field the author left unset has no default to describe.
      if (value === undefined || value === null) return null;
      // A route action reads as the waypoints it visits, not as the indices the data stores.
      // A zero facing offset is the common case and says nothing worth reading.
      if (key === 'yawOffset' && !value) return null;
      if (waypointName && (key === 'fromPoint' || key === 'toPoint') && !isExpression(value))
        return `${key === 'fromPoint' ? 'from' : 'to'} ${waypointName(command.pathId, value)}`;
      return `${key}: ${isExpression(value) ? '=' + value.expr : typeof value === 'number' ? Number(value.toFixed(4)) : value}`;
    }).filter(Boolean);
  if (command.otherId) parts.push(`other: ${objectName(command.otherId)}`);
  return { object: command.entityId ? objectName(command.entityId) : categoryOf(command.type, label),
    text: `${command.inverted ? 'NOT ' : ''}${titles[command.type] || labelOf(label)}${parts.length ? '  ' + parts.join(' · ') : ''}` };
}

export function commandRow(command, labels, objectName, open, { inverted = false, or = false, waypointName = null } = {}) {
  const description = describeCommand(command, labels, objectName, waypointName);
  const row = document.createElement('button');
  row.type = 'button'; row.className = 'script-command';
  if (inverted) row.classList.add('inverted');
  row.title = 'Double-click or press Enter to edit';
  const object = document.createElement('span'); object.className = 'command-object'; object.textContent = description.object;
  const text = document.createElement('span'); text.className = 'command-description'; text.textContent = `${or ? 'OR  ' : ''}${description.text}`;
  row.append(object, text);
  row.addEventListener('click', () => {
    document.querySelectorAll('.script-command.selected').forEach(item => item.classList.remove('selected'));
    row.classList.add('selected');
  });
  row.addEventListener('dblclick', open);
  row.addEventListener('contextmenu', event => { event.preventDefault(); open(); });
  row.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); open(); } });
  return row;
}

export function openCommandDialog({ kind, labels, command, defaults, entities, zones = [], cameras = [], objectTypes = [], playerId, variables, groups, clips, walls = [], sectors = [], doorSectors = sectors, elevatorSectors = sectors, spriteClips = [], images = [], hudElements = [], hudAnimations = [],
  // Project data the newer commands point at: timelines, routes and imported sounds.
  timesheets = [], paths = [], sounds = [], pathPoints = () => null, entityVariableNames = () => [], entitySignalNames = () => [],
  // Engine commands plus the ones addons add; the parameter stage is built from this list.
  commands = null, submit, remove, move }) {
  const dialog = document.createElement('dialog'); dialog.className = 'command-dialog';
  dialog.setAttribute('aria-label', `${command ? 'Edit' : 'Add'} ${kind}`);
  const heading = document.createElement('h2'), search = document.createElement('input'), content = document.createElement('div');
  const help = document.createElement('p'), error = document.createElement('p'), footer = document.createElement('div');
  search.type = 'search'; search.placeholder = 'Search commands'; search.setAttribute('aria-label', 'Search commands');
  content.className = 'command-catalog'; footer.className = 'button-row'; error.className = 'error'; error.setAttribute('role', 'alert');
  help.className = 'muted';
  dialog.append(heading, search, help, content, error, footer); document.body.append(dialog);
  let stage = command ? 'parameters' : 'objects', category, draft = command && structuredClone(command);
  const button = (label, fn) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => { try { error.textContent = ''; fn(); } catch (failure) { error.textContent = failure.message; } });
    return button;
  };
  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  function render() {
    heading.textContent = `${command ? 'Edit' : 'Add'} ${kind}${category ? ` — ${category}` : ''}`;
    content.replaceChildren(); footer.replaceChildren(); search.hidden = stage === 'parameters';
    content.classList.toggle('parameters', stage === 'parameters');
    help.textContent = stage === 'objects' ? 'Choose an object or system category.'
      : stage === 'commands' ? `Choose a ${kind}, then edit its parameters.` : `Changes apply together when you click Done. ${EXPRESSION_HELP}`;
    footer.append(button('Cancel', close));
    if (stage !== 'objects') footer.append(button('Back', () => { search.value = ''; stage = stage === 'parameters' ? 'commands' : 'objects'; render(); }));
    const query = search.value.trim().toLowerCase();
    if (stage === 'objects') {
      for (const name of [...new Set(labels.map(([type, label]) => categoryOf(type, label)))]) {
        if (query && !name.toLowerCase().includes(query) && !labels.some(([type, label]) => categoryOf(type, label) === name && label.toLowerCase().includes(query))) continue;
        content.append(button(name, () => { category = name; search.value = ''; stage = 'commands'; render(); }));
      }
    } else if (stage === 'commands') {
      for (const [type, label] of labels) {
        if (category && categoryOf(type, label) !== category || query && !`${label} ${type}`.toLowerCase().includes(query)) continue;
        content.append(button(labelOf(label), () => { draft = defaults(type); stage = 'parameters'; render(); }));
      }
    } else {
      const label = document.createElement('h3'); label.textContent = labels.find(([type]) => type === draft.type)?.[1] || draft.type;
      content.append(label);
      for (const field of commandFields(draft, { entities, zones, cameras, objectTypes, playerId, variables, groups, clips, walls, sectors, doorSectors, elevatorSectors, spriteClips, images, hudElements, hudAnimations, timesheets, paths, sounds, pathPoints, entityVariableNames, entitySignalNames, commands })) {
        const label = document.createElement('label'); label.textContent = field.label || field.name;
        const valueType = field.value ? isExpression(draft[field.name]) ? 'expression' : typeof draft[field.name] : null;
        if (field.value) {
          const type = document.createElement('select'); type.setAttribute('aria-label', `${field.name} value type`);
          for (const name of ['number', 'string', 'boolean', 'expression']) {
            const option = document.createElement('option'); option.value = name; option.textContent = name; type.append(option);
          }
          type.value = valueType;
          type.addEventListener('change', () => { draft[field.name] = type.value === 'expression' ? { expr: '0' }
            : type.value === 'string' ? '' : type.value === 'boolean' ? false : 0; render(); });
          label.append(type);
        }
        // A suggestion list is for names the author may have to type before they exist (an object
        // variable on a fresh object), so it stays a text box with the known names on offer.
        let list = null;
        if (field.suggestions) {
          list = document.createElement('datalist');
          list.id = `command-suggestions-${draft.type}-${field.name}`;
          for (const value of field.suggestions) {
            const option = document.createElement('option'); option.value = value; list.append(option);
          }
        }
        const input = document.createElement(field.options ? 'select' : 'input');
        input.setAttribute('aria-label', field.label || field.name);
        if (list) { input.setAttribute('list', list.id); input.autocomplete = 'off'; }
        if (field.options) for (const value of field.options) {
          const [id, name] = Array.isArray(value) ? value : [value, value];
          const option = document.createElement('option'); option.value = id; option.textContent = name; input.append(option);
        }
        else input.type = 'text';
        // A picker whose stored value is not on offer — an expression, or a waypoint of a route
        // that no longer exists — has to say so instead of painting the first option as if chosen.
        if (field.options && draft[field.name] !== undefined && draft[field.name] !== ''
          && ![...input.options].some(option => option.value === String(draft[field.name]))) {
          const option = document.createElement('option');
          option.value = String(draft[field.name]);
          option.textContent = isExpression(draft[field.name]) ? `= ${draft[field.name].expr}` : `${draft[field.name]} (not on this route)`;
          input.append(option);
        }
        input.value = isExpression(draft[field.name]) ? '=' + draft[field.name].expr : draft[field.name] ?? '';
        const update = () => {
          if (input.value === '' && field.optional) delete draft[field.name];
          else draft[field.name] = field.value ? valueType === 'expression' ? { expr: input.value.replace(/^=/, '') }
            : valueType === 'number' ? input.value.trim() === '' ? NaN : Number(input.value)
            : valueType === 'boolean' ? input.value === 'true' ? true : input.value === 'false' ? false : NaN : input.value
            : !field.options && input.value.startsWith('=') && (field.numeric || field.name === 'message' || field.kind === 'string') ? { expr: input.value.slice(1) }
            : field.numeric ? (input.value.trim() === '' ? NaN : Number(input.value))
            : draft.type === 'playAnimation' && field.name === 'loop' ? input.value === 'true' : input.value;
        };
        // A picker that shows a choice has to submit it: an untouched select would otherwise
        // leave the field unset, and the rule would run against nothing.
        if (field.options && (draft[field.name] === undefined || draft[field.name] === '')) {
          // A select paints its first option even when the draft has no value that matches one,
          // so a fresh "Route" or "Sound" field looked filled in while holding nothing — Done then
          // built an action that pointed at no path at all. Choose the option that is on screen,
          // as the kind of value the field stores: a waypoint stays a number, not the text of it.
          if (input.selectedIndex < 0 && input.options[0]?.value) input.value = input.options[0].value;
          if (input.value !== '') draft[field.name] = field.numeric ? Number(input.value) : input.value;
        }
        input.addEventListener('input', update);
        input.addEventListener('change', () => {
          update();
          if (field.name === 'entityId' && draft.type === 'playAnimation') { draft.clip = clips(draft.entityId)[0]; render(); }
          if (field.kind === 'objectType') render();
          // The waypoint pickers below the route are built from that route, so choosing another
          // route has to rebuild them — and the old waypoint numbers mean nothing on the new one.
          if (field.name === 'pathId') { draft.fromPoint = 0; draft.toPoint = -1; render(); }
          // Which local variables exist depends on the object, so the list below follows it.
          if (field.name === 'entityId' && (field.suggestions || ['onSignal', 'emitSignal'].includes(draft.type))) render();
        });
        label.append(input);
        if (list) label.append(list);
        if (field.hint) label.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: field.hint }));
        content.append(label);
      }
      if (kind === 'condition' && !TRIGGER_CONDITIONS.has(draft.type)) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = Boolean(draft.inverted);
        input.addEventListener('change', () => { draft.inverted = input.checked; });
        label.append(input, ' Invert condition (NOT)'); content.append(label);
      }
      footer.append(button('Done', () => {
        if (draft.type === 'spawnEntity' && !draft.templateId) {
          const hasTemplate = commandFields(draft, { entities, playerId })
            .some(field => field.name === 'templateId' && field.options?.length);
          throw new Error(hasTemplate
            ? 'Choose an object template before adding this action'
            : 'Add a non-player object first so it can be used as a spawn template');
        }
        submit(draft); close();
      }));
      if (remove) footer.append(button('Delete', () => { remove(); close(); }));
      if (move) for (const [label, direction] of [['Move up', -1], ['Move down', 1]]) {
        footer.append(button(label, () => { move(direction); close(); }));
      }
    }
    if (stage !== 'parameters' && !content.children.length) content.append(Object.assign(document.createElement('p'), { textContent: 'No matching commands.' }));
  }
  search.addEventListener('input', render);
  if (command) category = categoryOf(command.type, labels.find(([type]) => type === command.type)?.[1] || '');
  render(); dialog.showModal(); (stage === 'parameters' ? content.querySelector('input,select') : search)?.focus();
}

/** Reusable nodes edit their own script, not a similarly named layout instance. */
export function openNodeEventSheet({ getScene, edit, ownerId, project, lists, conditionLabels, actionLabels, onError }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'command-dialog';
  dialog.setAttribute('aria-label', 'Scene node visual script');
  const heading = document.createElement('h2'), content = document.createElement('div'), footer = document.createElement('div');
  const button = (label, action) => {
    const element = document.createElement('button'); element.textContent = label;
    element.addEventListener('click', () => { try { action(); } catch (error) { onError(error.message, true); } });
    return element;
  };
  const modify = (id, fn) => { edit(scene => fn(scene.events.find(event => event.id === id)), 'Node visual script updated'); render(); };
  function parameters(event) {
    const scene = getScene(), owner = scene.entities.find(entity => entity.id === event.ownerId);
    return { ...lists, entities: [...(owner ? [['$self', 'This object']] : []), ...scene.entities.map(entity => [entity.id, entity.name])],
      zones: scene.entities.filter(entity => entity.type === 'zone').map(entity => [entity.id, entity.name]),
      entityVariableNames: id => Object.keys((id === '$self' ? owner : scene.entities.find(entity => entity.id === id))?.variables || {}),
      entitySignalNames: id => nodeSignals((id === '$self' ? owner : scene.entities.find(entity => entity.id === id)) || {}),
      clips: id => {
        const node = id === '$self' ? owner : scene.entities.find(entity => entity.id === id);
        return project.assets?.find(asset => asset.id === node?.modelAsset)?.animations || [];
      } };
  }
  function defaults(type, event) {
    const definition = engineCommand(type, project), context = parameters(event), scene = getScene();
    const result = definition ? defaultEngineCommand(type, project) : { type };
    for (const field of commandFields(result, context)) {
      if (result[field.name] !== undefined || field.optional) continue;
      const option = field.options?.[0];
      result[field.name] = option !== undefined ? Array.isArray(option) ? option[0] : option : field.numeric || field.value ? 0 : '';
    }
    if (type === 'showMessage') result.message = 'Message';
    if (['onSignal', 'emitSignal'].includes(type)) {
      const owner = scene.entities.find(entity => entity.id === event.ownerId);
      const emitter = owner && nodeSignals(owner).length ? owner : scene.entities.find(entity => nodeSignals(entity).length);
      if (!emitter) throw new Error('Declare a signal on a node first');
      result.entityId = emitter === owner ? '$self' : emitter.id;
      result.signal = nodeSignals(emitter)[0];
    }
    if (['objectVariableCompare', 'setObjectVariable', 'addObjectVariable'].includes(type)) {
      const node = scene.entities.find(entity => entity.id === event.ownerId) || scene.entities[0];
      const name = Object.keys(node?.variables || {}).find(name => type !== 'addObjectVariable' || typeof node.variables[name] === 'number');
      if (!name) throw new Error('Declare a suitable local variable on this node first');
      result.entityId = node.id === event.ownerId ? '$self' : node.id;
      result.variable = name; result.value = type === 'addObjectVariable' ? 1 : node.variables[name];
    }
    return result;
  }
  function commandDialog(kind, event, command, submit, remove) {
    const snapshot = getScene();
    openCommandDialog({ kind, command, ...parameters(event), labels: kind === 'condition' ? conditionLabels : actionLabels,
      defaults: type => defaults(type, event), remove,
      submit: value => {
        if (getScene() !== snapshot) throw new Error('Scene changed while editing the command. Cancel and reopen it.');
        submit(value);
      } });
  }
  function render() {
    const scene = getScene();
    if (!scene) { dialog.close(); return; }
    heading.textContent = `${scene.entities.find(entity => entity.id === ownerId)?.name || scene.name} - Visual script`;
    content.replaceChildren(); footer.replaceChildren();
    for (const event of scene.events || []) {
      if (!['$all', '$scene'].includes(ownerId) && event.ownerId !== ownerId) continue;
      const card = document.createElement('section'); card.className = 'event-card';
      const conditions = document.createElement('div'); conditions.className = 'event-conditions';
      const actions = document.createElement('div'); actions.className = 'event-actions';
      const objectName = id => id === '$self' ? 'This node' : scene.entities.find(node => node.id === id)?.name || id;
      [event.condition, ...(event.conditions || [])].forEach((condition, index) => {
        conditions.append(commandRow(condition, conditionLabels, objectName, () => commandDialog('condition', event, condition,
          value => modify(event.id, rule => { if (!index) rule.condition = value; else rule.conditions[index - 1] = value; }),
          index ? () => modify(event.id, rule => rule.conditions.splice(index - 1, 1)) : undefined)));
      });
      conditions.append(button('+ Add condition', () => commandDialog('condition', event, null,
        value => modify(event.id, rule => (rule.conditions ||= []).push(value)))));
      event.actions.forEach((action, index) => actions.append(commandRow(action, actionLabels, objectName,
        () => commandDialog('action', event, action, value => modify(event.id, rule => { rule.actions[index] = value; }),
          () => modify(event.id, rule => rule.actions.splice(index, 1))))));
      actions.append(button('+ Add action', () => commandDialog('action', event, null,
        value => modify(event.id, rule => rule.actions.push(value)))));
      const controls = document.createElement('div'); controls.className = 'event-controls';
      controls.append(button(event.enabled ? 'Disable' : 'Enable', () => modify(event.id, rule => { rule.enabled = !rule.enabled; })),
        button(event.once ? 'Once: yes' : 'Once: no', () => modify(event.id, rule => { rule.once = !rule.once; })),
        button('Delete rule', () => {
          edit(scene => { const ids = eventBranch(scene.events, event.id); scene.events = scene.events.filter(rule => !ids.has(rule.id)); }, 'Node rule deleted');
          render();
        }));
      card.append(conditions, actions, controls); content.append(card);
    }
    footer.append(button('+ Add event', () => {
      const event = { id: `event_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`, enabled: true, once: false, actions: [] };
      if (!['$all', '$scene'].includes(ownerId)) event.ownerId = ownerId;
      commandDialog('condition', event, null, condition => {
        edit(scene => (scene.events ||= []).push({ ...event, condition }), 'Node event added'); render();
      });
    }), button('Close', () => dialog.close()));
  }
  dialog.append(heading, content, footer);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); render(); dialog.showModal();
}
