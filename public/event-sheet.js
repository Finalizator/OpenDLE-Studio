import { engineCommand } from '/shared/engine-script.js';
import { commandFields } from '/shared/command-fields.js';

export { commandFields };
import { isExpression, EXPRESSION_HELP } from '/shared/expressions.js';

const triggers = new Set(['onStart', 'keyPressed', 'mouseMoved', 'collisionStarted', 'collisionEnded', 'animationFinished', 'hudClicked', 'hudAnimationFinished', 'hudStatChanged', 'entityDamaged', 'wallActivated']);
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
      // A route action reads as the waypoints it visits, not as the indices the data stores.
      if (waypointName && (key === 'fromPoint' || key === 'toPoint') && !isExpression(value))
        return `${key === 'fromPoint' ? 'from' : 'to'} ${waypointName(command.pathId, value)}`;
      return `${key}: ${isExpression(value) ? '=' + value.expr : typeof value === 'number' ? Number(value.toFixed(4)) : value}`;
    });
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

export function openCommandDialog({ kind, labels, command, defaults, entities, zones = [], playerId, variables, groups, clips, walls = [], sectors = [], spriteClips = [], images = [], hudElements = [], hudAnimations = [],
  // Project data the newer commands point at: timelines, routes and imported sounds.
  timesheets = [], paths = [], sounds = [], pathPoints = () => null, entityVariableNames = () => [], submit, remove, move }) {
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
      for (const field of commandFields(draft, { entities, zones, playerId, variables, groups, clips, walls, sectors, spriteClips, images, hudElements, hudAnimations, timesheets, paths, sounds, pathPoints, entityVariableNames })) {
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
            : field.name === 'loop' ? input.value === 'true' : input.value;
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
          // The waypoint pickers below the route are built from that route, so choosing another
          // route has to rebuild them — and the old waypoint numbers mean nothing on the new one.
          if (field.name === 'pathId') { draft.fromPoint = 0; draft.toPoint = -1; render(); }
          // Which local variables exist depends on the object, so the list below follows it.
          if (field.name === 'entityId' && field.suggestions) render();
        });
        label.append(input);
        if (list) label.append(list);
        if (field.hint) label.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: field.hint }));
        content.append(label);
      }
      if (kind === 'condition' && !triggers.has(draft.type)) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = Boolean(draft.inverted);
        input.addEventListener('change', () => { draft.inverted = input.checked; });
        label.append(input, ' Invert condition (NOT)'); content.append(label);
      }
      footer.append(button('Done', () => { submit(draft); close(); }));
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

