import { engineCommand, imageFieldOptions, INPUT_KEYS } from '/shared/engine-script.js';
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

export function describeCommand(command, labels, objectName) {
  const label = labels.find(([type]) => type === command.type)?.[1] || command.type;
  const parts = Object.entries(command).filter(([key]) => !['type', 'inverted', 'entityId', 'otherId'].includes(key))
    .map(([key, value]) => `${key}: ${isExpression(value) ? '=' + value.expr : typeof value === 'number' ? Number(value.toFixed(4)) : value}`);
  if (command.otherId) parts.push(`other: ${objectName(command.otherId)}`);
  return { object: command.entityId ? objectName(command.entityId) : categoryOf(command.type, label),
    text: `${command.inverted ? 'NOT ' : ''}${titles[command.type] || labelOf(label)}${parts.length ? '  ' + parts.join(' · ') : ''}` };
}

export function commandRow(command, labels, objectName, open, { inverted = false, or = false } = {}) {
  const description = describeCommand(command, labels, objectName);
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

export function openCommandDialog({ kind, labels, command, defaults, entities, playerId, variables, groups, clips, walls = [], sectors = [], spriteClips = [], images = [], hudElements = [], hudAnimations = [], submit, remove, move }) {
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
      for (const field of commandFields(draft, { entities, playerId, variables, groups, clips, walls, sectors, spriteClips, images, hudElements, hudAnimations })) {
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
        const input = document.createElement(field.options ? 'select' : 'input');
        input.setAttribute('aria-label', field.label || field.name);
        if (field.options) for (const value of field.options) {
          const [id, name] = Array.isArray(value) ? value : [value, value];
          const option = document.createElement('option'); option.value = id; option.textContent = name; input.append(option);
        }
        else input.type = 'text';
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
        input.addEventListener('input', update);
        input.addEventListener('change', () => { update(); if (field.name === 'entityId' && draft.type === 'playAnimation') {
          draft.clip = clips(draft.entityId)[0]; render();
        } });
        label.append(input); content.append(label);
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

export function commandFields(command, { entities, playerId, variables, groups, clips, walls, sectors, spriteClips, images = [], hudElements, hudAnimations }) {
  const definition = engineCommand(command.type);
  if (definition) {
    return [
      ...definition.fields.map(field => ({ ...field, value: field.kind === 'value', numeric: field.kind === 'number',
        ...(['clipId', 'impactClipId'].includes(field.name) ? { options: [['', 'None / primitive visual'], ...spriteClips] } : {}),
        // Image fields list the asset library, so a spray's artwork is chosen by name.
        ...(field.kind === 'image' ? { options: imageFieldOptions(images) } : {}) })),
      ...(definition.spriteClip ? [{ name: 'clipId', label: 'Sprite clip', options: spriteClips }] : []),
      ...(definition.wall ? [{ name: 'wallId', label: 'Linedef', options: walls }] : []),
      ...(definition.sector ? [{ name: 'sectorId', label: 'Sector', options: sectors }] : []),
      ...(definition.target ? [{ name: 'entityId', label: 'Object', options: ['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(command.type) ? entities : entities.filter(([id]) => id !== playerId) }] : []),
      ...(definition.variable ? [{ name: 'variable', options: variables }] : []),
      ...(definition.group ? [{ name: 'groupId', label: 'Group', options: groups }] : []),
      ...(definition.hudElement ? [{ name: 'elementId', label: 'HUD element', options: hudElements }] : []),
      ...(definition.hudAnimation ? [{ name: 'animationId', label: 'HUD animation', options: hudAnimations }] : []),
    ];
  }
  const fields = [];
  const field = (name, numeric = false, options, optional = false) => fields.push({ name, numeric, options, optional });
  if (command.type === 'keyPressed') field('key', false, INPUT_KEYS);
  if (['nearEntity', 'collisionStarted', 'collisionEnded', 'isTouching', 'animationFinished', 'removeEntity', 'setEntityPosition', 'rotateEntity', 'applyImpulse', 'applyForce', 'setVelocity', 'playAnimation', 'stopAnimation'].includes(command.type)) field('entityId', false,
    command.type === 'removeEntity' ? entities.filter(([id]) => id !== playerId) : entities);
  if (['collisionStarted', 'collisionEnded', 'isTouching'].includes(command.type)) field('otherId', false, [['$world', 'Sector geometry'], ...entities]);
  if (command.type === 'nearEntity') field('distance', true);
  if (command.type === 'showMessage') field('message');
  if (['setVariable', 'addVariable'].includes(command.type)) { field('variable', false, variables); fields.push({ name: 'value', value: true }); }
  if (['teleport', 'setEntityPosition', 'applyImpulse', 'applyForce', 'setVelocity'].includes(command.type)) {
    field('x', true); field('y', true); field('z', true, undefined, ['teleport', 'setEntityPosition'].includes(command.type));
  }
  if (command.type === 'rotateEntity') field('angle', true);
  if (command.type === 'playAnimation') {
    field('clip', false, clips(command.entityId)); field('speed', true); field('loop', false, [['true', 'Yes'], ['false', 'No']]);
  }
  return fields;
}
