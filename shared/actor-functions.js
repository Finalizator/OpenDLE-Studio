/**
 * Runs the little functions a mod attaches to its own state frames.
 *
 * A decoration that turns writes it in its own class rather than calling an engine action:
 *
 * ```zscript
 * States { Spawn: PLAY A 1 Rotate; Loop; }
 * void Rotate() { angle += 1; }
 * ```
 *
 * GZDoom calls `Rotate` every tic the frame lasts. This module executes the subset of that
 * code an imported actor can need — assignments and compound assignments of numbers to the
 * actor's own fields — and reports anything else as unsupported instead of guessing, so the
 * import report still tells the truth about what the engine can run.
 */

/** Fields a mod may write from a state function, and how they are stored on an entity. */
const FIELDS = {
  angle: entity => entity.angle,
  pitch: entity => entity.pitch,
  roll: entity => entity.roll,
  alpha: entity => entity.alpha,
  scale: entity => entity.scale,
  // `z` is where the actor's bottom is; the entity keeps it as `z` once physics has run, and
  // as `elevation` above the floor before that.
  z: entity => entity.elevation,
};

const OPERATORS = { '=': 'set', '+=': 'add', '-=': 'subtract', '*=': 'multiply', '/=': 'divide' };

/** `angle += 1`, `self.angle = 90`, `angle = angle + 1` — one statement at a time. */
function statement(source) {
  const text = String(source).trim().replace(/^self\./, '');
  const match = /^([A-Za-z_]\w*)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/.exec(text);
  if (!match) return null;
  const [, field, token, rawValue] = match;
  if (!FIELDS[field]) return null;
  const operator = OPERATORS[token];
  const value = rawValue.trim();
  // The right-hand side is a literal number, or the field itself (`angle = angle + 1`).
  if (Number.isFinite(Number(value))) return { field, operator, value: Number(value) };
  const selfReference = new RegExp('^' + field + '\\s*(?:([-+])\\s*([\\d.]+))?$').exec(value);
  if (!selfReference) return null;
  const amount = Number(selfReference[2] || 0) * (selfReference[1] === '-' ? -1 : 1);
  return { field, operator: operator === 'set' ? 'add' : operator, value: amount };
}

/**
 * Executes a function body against an entity.
 * Returns `{ ran, unsupported }`: `ran` is false when any statement could not be executed,
 * and `unsupported` names the first statement that stopped it.
 */
export function runActorFunction(entity, source) {
  const statements = String(source || '').split(';').map(part => part.trim()).filter(Boolean);
  if (!statements.length) return { ran: false, unsupported: null };
  const applied = [];
  for (const text of statements) {
    const parsed = statement(text);
    if (!parsed) return { ran: false, unsupported: text.slice(0, 120) };
    applied.push(parsed);
  }
  for (const { field, operator, value } of applied) {
    const current = Number(FIELDS[field](entity)) || 0;
    const next = operator === 'set' ? value
      : operator === 'add' ? current + value
        : operator === 'subtract' ? current - value
          : operator === 'multiply' ? current * value
            : value === 0 ? current : current / value;
    if (field === 'angle') entity.angle = ((next % 360) + 360) % 360;
    else if (field === 'z') entity.elevation = next;
    else entity[field] = next;
  }
  return { ran: true, unsupported: null };
}

/** The source of one of the actor's own functions, or null when it has none by that name. */
export function actorFunctionSource(actor, name) {
  const list = actor?.functions;
  if (!list) return null;
  if (Array.isArray(list)) {
    const found = list.find(entry => String(entry.name).toLowerCase() === String(name).toLowerCase());
    return found?.source ?? null;
  }
  const key = Object.keys(list).find(candidate => candidate.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? null : list[key]?.source ?? list[key] ?? null;
}
