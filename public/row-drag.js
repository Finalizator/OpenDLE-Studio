// Drag-to-reorder for the event sheet. Rows carry a grip; a pointer drag picks the
// row under the cursor, shows where it would land, and hands the ids to the caller.
// Events, conditions and actions all use this one installer so they behave the same.

const INDENT_SLOP = 28;

/**
 * @param {HTMLElement} container  element containing the rows
 * @param {(source: {id: string, kind: string, index: number}, target: {id: string, kind: string, index: number},
 *   position: 'before'|'after'|'inside') => void} onDrop
 */
export function installRowDrag(container, { onDrop, onError = () => {} } = {}) {
  let drag = null, indicator = null, suppressClick = false;
  function clearIndicator() {
    indicator?.remove(); indicator = null;
    container.querySelectorAll('.drag-over-before, .drag-over-after, .drag-over-inside')
      .forEach(row => row.classList.remove('drag-over-before', 'drag-over-after', 'drag-over-inside'));
  }
  function rowInfo(element) {
    const row = element?.closest?.('[data-drag-row]');
    if (!row) return null;
    return { row, id: row.dataset.dragId, kind: row.dataset.dragKind, index: Number(row.dataset.dragIndex) };
  }
  container.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const grip = event.target.closest?.('[data-drag-grip]');
    const row = event.target.closest?.('[data-drag-row]');
    if (!row) return;
    // A rule is dragged by its grip or its header, so typing in its fields still works;
    // a condition or an action is a single line, so the whole row is the handle.
    if (!grip) {
      if (row.dataset.dragKind === 'event') {
        if (!event.target.closest('summary')) return;
      } else if (event.target.closest('input, select, textarea, audio')) return;
    }
    const info = rowInfo(row);
    if (!info) return;
    event.preventDefault();
    drag = { ...info, startY: event.clientY, moved: false, pointerId: event.pointerId };
    container.setPointerCapture?.(event.pointerId);
    document.body.classList.add('row-dragging');
  });
  function targetUnder(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const info = rowInfo(element);
    if (!info || !drag || info.row === drag.row) return null;
    if (info.kind !== drag.kind) return null;
    // Only rows inside the same event card can take conditions or actions.
    if (drag.kind !== 'event' && info.row.closest('[data-drag-row]').closest('.event-card') !==
      drag.row.closest('.event-card')) return null;
    return info;
  }
  container.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    container.classList.add('row-dragging');
    clearIndicator();
    const target = targetUnder(event);
    if (!target) return;
    const box = target.row.getBoundingClientRect();
    const ratio = (event.clientY - box.top) / Math.max(1, box.height);
    const position = ratio < .33 ? 'before' : ratio > .67 ? 'after' : 'inside';
    target.row.classList.add(`drag-over-${position}`);
    drag.target = target; drag.position = position;
  });
  container.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const finished = drag;
    drag = null;
    container.classList.remove('row-dragging');
    document.body.classList.remove('row-dragging');
    clearIndicator();
    if (!finished.moved) return;
    // A drag ends with a click; swallow it so dragging a row does not also select or
    // expand it.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (!finished.target) return;
    try {
      onDrop({ id: finished.id, kind: finished.kind, index: finished.index },
        { id: finished.target.id, kind: finished.target.kind, index: finished.target.index }, finished.position);
    } catch (error) { onError(error); }
  });
  container.addEventListener('pointercancel', () => {
    drag = null;
    container.classList.remove('row-dragging');
    document.body.classList.remove('row-dragging');
    clearIndicator();
  });
  container.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation(); event.preventDefault();
  }, true);
  // Deny the browser's native drag/selection while dragging a row.
  container.addEventListener('dragstart', event => { if (drag) event.preventDefault(); });
  return { get dragging() { return Boolean(drag?.moved); } };
}

/**
 * Turn an element into an inline text editor. Used for rule comments: pressing a
 * comment in the event sheet edits it in place, Enter or blur keeps it, Escape drops
 * it.
 */
export function editInline(element, { value = '', onCommit = () => {}, onCancel = () => {}, multiline = false } = {}) {
  const field = document.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) field.type = 'text';
  field.className = 'inline-edit';
  field.value = value;
  field.setAttribute('aria-label', 'Edit text');
  let finished = false;
  const finish = commit => {
    if (finished) return;
    finished = true;
    const text = field.value.trim();
    if (commit) onCommit(text); else onCancel();
  };
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  });
  field.addEventListener('blur', () => finish(true));
  field.addEventListener('pointerdown', event => event.stopPropagation());
  element.replaceWith(field);
  field.focus();
  field.select();
  return field;
}
