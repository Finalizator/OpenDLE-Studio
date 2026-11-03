import { scalar } from './expressions.js';

export const SIGNAL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/;
export const SIGNAL_LIMIT = 256;
const buses = new WeakMap();

export function nodeSignals(entity) {
  return [...new Set([...(entity.signals || []), ...(entity.terminal?.submitSignal ? [entity.terminal.submitSignal] : [])])];
}

export function emitSignal(state, entityId, signal, value = '') {
  const entity = state.entities.find(item => item.id === entityId);
  if (!entity) throw new Error(`Signal emitter no longer exists: ${entityId}`);
  if (!SIGNAL_NAME.test(signal) || !nodeSignals(entity).includes(signal)) {
    throw new Error(`Object "${entity.name || entityId}" has no declared signal "${signal}"`);
  }
  scalar(value);
  let queue = buses.get(state);
  if (!queue) buses.set(state, queue = []);
  if (queue.length >= SIGNAL_LIMIT) throw new Error(`Signal queue exceeded ${SIGNAL_LIMIT} pending emissions`);
  queue.push({ entityId, signal, value, phases: new Set(['interface', 'beforePhysics', 'afterPhysics']) });
}

export function nextSignal(state) {
  const message = buses.get(state)?.shift();
  return message ? { entityId: message.entityId, signal: message.signal, value: message.value } : null;
}

export function signalBatch(state, phase) {
  const queue = buses.get(state);
  if (!queue) return [];
  const batch = queue.filter(message => message.phases.has(phase));
  for (const message of batch) message.phases.delete(phase);
  buses.set(state, queue.filter(message => message.phases.size));
  return batch;
}

export function hasSignalCondition(event) {
  return [event.condition, ...(event.conditions || [])].some(condition => condition?.type === 'onSignal');
}

export function validateSignalEvent(event, entities) {
  if (hasSignalCondition(event) && (event.condition?.type !== 'onSignal' || event.parentId !== undefined ||
    event.condition.inverted || event.conditionMode === 'or')) {
    throw new Error('On signal must be the non-inverted first condition of a top-level AND rule');
  }
  for (const command of [event.condition, ...(event.conditions || []), ...(event.actions || [])]) {
    if (!['onSignal', 'emitSignal'].includes(command?.type)) continue;
    const targets = command.entityId === '$self'
      ? entities.filter(entity => event.forEachType ? entity.type === event.forEachType : entity.id === event.ownerId)
      : entities.filter(entity => entity.id === command.entityId);
    if (typeof command.signal !== 'string' || !SIGNAL_NAME.test(command.signal) || !targets.length ||
      targets.some(entity => !nodeSignals(entity).includes(command.signal))) {
      throw new Error(`Signal "${command.signal}" is not declared by its source object`);
    }
  }
}
