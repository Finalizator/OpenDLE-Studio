// One context menu for the whole editor. Every list, tile, tree and view opens this same
// element, so a right click looks and behaves the same way everywhere and only one menu
// is ever open. Items are plain data, which keeps the call sites readable:
//
//   contextMenu(event, [
//     { label: 'Duplicate', run: duplicate },
//     { separator: true },
//     { label: 'Delete', run: remove, danger: true },
//   ]);
//
// The menu is placed at the pointer with `style.left/top`, which the Content Security
// Policy allows (style attributes are blocked, CSSOM property writes are not).

/** Item shapes: { label, run, disabled, checked, danger, hint } or { separator: true }. */
let open = null;

function itemClass(item) {
  return `context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`;
}

function makeMenuItem(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = itemClass(item);
  button.setAttribute('role', 'menuitem');
  if (item.checked !== undefined) button.setAttribute('role', 'menuitemcheckbox');
  if (item.disabled) button.disabled = true;
  if (item.danger) button.dataset.danger = 'true';
  const tick = document.createElement('span');
  tick.className = 'context-menu-tick';
  tick.textContent = item.checked ? '\u2713' : '';
  const label = document.createElement('span');
  label.className = 'context-menu-label';
  label.textContent = item.label;
  button.append(tick, label);
  if (item.hint) {
    const hint = document.createElement('span');
    hint.className = 'context-menu-hint';
    hint.textContent = item.hint;
    button.append(hint);
  }
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (item.disabled) return;
    closeContextMenu();
    item.run?.();
  });
  return button;
}

function moveFocus(menu, step) {
  const items = [...menu.querySelectorAll('.context-menu-item:not([disabled])')];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
  items[next].focus();
}

/**
 * Opens the editor context menu at the pointer (or at an explicit `{ x, y }` anchor).
 * Returns the menu element so a caller can measure or focus it.
 */
export function contextMenu(anchor, items, { label = 'Actions' } = {}) {
  closeContextMenu();
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.tabIndex = -1;
  for (const item of list) {
    if (item.separator) {
      const line = document.createElement('div');
      line.className = 'context-menu-separator';
      line.setAttribute('role', 'separator');
      menu.append(line);
      continue;
    }
    menu.append(makeMenuItem(item));
  }
  if (!menu.querySelector('.context-menu-item')) return null;
  document.body.append(menu);
  // Measure once, then keep the menu inside the viewport: a menu opened near the edge
  // would otherwise hang off the window and look clipped.
  const x = Number.isFinite(anchor?.clientX) ? anchor.clientX : anchor?.x ?? 0;
  const y = Number.isFinite(anchor?.clientY) ? anchor.clientY : anchor?.y ?? 0;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const left = Math.max(2, Math.min(x, window.innerWidth - width - 2));
  const top = Math.max(2, Math.min(y, window.innerHeight - height - 2));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  open = { menu, anchor };
  const first = menu.querySelector('.context-menu-item:not([disabled])');
  first?.focus({ preventScroll: true });
  const onPointerDown = event => {
    if (menu.contains(event.target)) return;
    closeContextMenu();
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeContextMenu(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(menu, 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(menu, -1); return; }
    if (event.key === 'Home') { event.preventDefault(); menu.querySelector('.context-menu-item:not([disabled])')?.focus(); return; }
    if (event.key === 'End') {
      event.preventDefault();
      const all = [...menu.querySelectorAll('.context-menu-item:not([disabled])')];
      all.at(-1)?.focus();
      return;
    }
    if (event.key === 'Tab') { closeContextMenu(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      const focused = document.activeElement;
      if (focused && menu.contains(focused)) { event.preventDefault(); focused.click(); }
    }
  };
  // A second right click anywhere is the usual way to dismiss a menu.
  const onContextMenu = event => { if (!menu.contains(event.target)) closeContextMenu(); };
  const onBlur = () => closeContextMenu();
  const listeners = [
    [document, 'pointerdown', onPointerDown], [document, 'keydown', onKeyDown],
    [document, 'contextmenu', onContextMenu], [window, 'blur', onBlur], [window, 'resize', onBlur],
  ];
  for (const [target, type, handler] of listeners) target.addEventListener(type, handler, true);
  open.cleanup = () => {
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
  };
  return menu;
}

export function closeContextMenu() {
  if (!open) return;
  open.cleanup?.();
  open.menu.remove();
  open.anchor?.classList?.remove('context-menu-open');
  open = null;
}

/** True while a menu is open, so views can let the menu swallow their own keys. */
export function contextMenuOpen() {
  return Boolean(open);
}
