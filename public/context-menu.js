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

/** Item shapes: { label, run, disabled, checked, danger, hint, submenu } or { separator: true }. */
let open = null;

function itemClass(item) {
  return `context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`;
}

/** Every panel the open menu consists of, so "the pointer is inside the menu" covers children. */
function panelsOf(state) {
  return state ? [state.menu, ...state.children] : [];
}

function insideMenu(state, target) {
  return panelsOf(state).some(panel => panel.contains(target));
}

function makeMenuItem(item, owner) {
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
  if (item.submenu?.length) {
    // A submenu opens on hover or focus, which is how every other menu behaves; the click is
    // kept for keyboards and touch, where there is no hover to rely on.
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const chevron = document.createElement('span');
    chevron.className = 'context-menu-chevron';
    chevron.textContent = '\u25b8';
    button.append(chevron);
    button.addEventListener('pointerenter', () => owner.openSubmenu(item, button));
    button.addEventListener('focus', () => owner.openSubmenu(item, button));
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) return;
      if (owner.submenuFor(button)) owner.closeSubmenus();
      else owner.openSubmenu(item, button);
    });
    return button;
  }
  // A submenu stays open until one of its items is pressed, another item with its own submenu
  // replaces it, Escape steps out, or the menu closes. Closing it as the pointer passes over an
  // ordinary item looks tidy and is a trap: the panel can sit lower than the item that opened
  // it, so travelling to an entry crosses the parent menu and the panel vanishes from under the
  // pointer that was about to press it.
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
  const state = { menu: null, children: [], anchor };
  const build = (entries, label2, parentItem) => {
    const panel = document.createElement('div');
    panel.className = 'context-menu';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', label2);
    if (parentItem) panel.dataset.submenu = 'true';
    panel.tabIndex = -1;
    for (const item of entries) {
      if (item.separator) {
        const line = document.createElement('div');
        line.className = 'context-menu-separator';
        line.setAttribute('role', 'separator');
        panel.append(line);
        continue;
      }
      const element = makeMenuItem(item, owner);
      if (item.submenu?.length) element.dataset.submenuFor = item.label;
      panel.append(element);
    }
    return panel;
  };
  /** The child panel an item opened, so hovering it again does not rebuild it. */
  const submenuFor = element => state.children.find(child => child.dataset.parentLabel === element.dataset.submenuFor);
  const closeSubmenus = (from = 0) => {
    for (const child of state.children.slice(from)) child.remove();
    state.children.length = from;
    for (const element of state.menu.querySelectorAll('[aria-expanded="true"]')) element.setAttribute('aria-expanded', 'false');
  };
  const openSubmenu = (item, element) => {
    if (!item?.submenu?.length || !element) return;
    const existing = submenuFor(element);
    if (existing) return;
    const panel = build(item.submenu, item.label, element);
    panel.dataset.parentLabel = item.label;
    document.body.append(panel);
    state.children.push(panel);
    // Beside the item, on whichever side fits: a menu opened near the right edge has to
    // unfold to the left or it would hang off the window.
    const box = element.getBoundingClientRect();
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const left = box.right + width + 4 > window.innerWidth ? Math.max(2, box.left - width + 2) : box.right - 2;
    const top = Math.max(2, Math.min(box.top - 4, window.innerHeight - height - 2));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    element.setAttribute('aria-expanded', 'true');
    const first = panel.querySelector('.context-menu-item:not([disabled])');
    first?.focus({ preventScroll: true });
  };
  const owner = { openSubmenu, submenuFor, closeSubmenus };
  const menu = build(list, label);
  if (!menu.querySelector('.context-menu-item')) return null;
  state.menu = menu;
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
  open = state;
  const first = menu.querySelector('.context-menu-item:not([disabled])');
  first?.focus({ preventScroll: true });
  const onPointerDown = event => {
    if (insideMenu(state, event.target)) return;
    closeContextMenu();
  };
  const onKeyDown = event => {
    // Keys act on whichever panel has focus, so a submenu navigates on its own and Escape
    // steps back out of it rather than closing the whole menu.
    const panel = panelsOf(state).find(node => node.contains(document.activeElement)) || menu;
    const nested = panel !== menu;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (nested) { closeSubmenus(1); panel.remove(); menu.querySelector('[aria-expanded="true"]')?.focus(); return; }
      if (state.children.length) { closeSubmenus(); menu.focus(); return; }
      closeContextMenu(); return;
    }
    if (event.key === 'ArrowLeft' && nested) {
      event.preventDefault();
      const parentLabel = panel.dataset.parentLabel;
      closeSubmenus(1);
      panel.remove();
      [...menu.querySelectorAll('.context-menu-item')].find(item => item.dataset.submenuFor === parentLabel)?.focus();
      return;
    }
    if (event.key === 'ArrowRight') {
      const focused = document.activeElement;
      if (focused?.dataset?.submenuFor) {
        event.preventDefault();
        focused.click();
        return;
      }
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(panel, 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(panel, -1); return; }
    if (event.key === 'Home') { event.preventDefault(); panel.querySelector('.context-menu-item:not([disabled])')?.focus(); return; }
    if (event.key === 'End') {
      event.preventDefault();
      panel.querySelectorAll('.context-menu-item:not([disabled])').length &&
        [...panel.querySelectorAll('.context-menu-item:not([disabled])')].at(-1)?.focus();
      return;
    }
    if (event.key === 'Tab') { closeContextMenu(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      const focused = document.activeElement;
      if (focused && insideMenu(state, focused)) { event.preventDefault(); focused.click(); }
    }
  };
  // A second right click anywhere is the usual way to dismiss a menu.
  const onContextMenu = event => { if (!insideMenu(state, event.target)) closeContextMenu(); };
  const onBlur = () => closeContextMenu();
  const onResize = () => closeContextMenu();
  // `blur` must not be captured: a blur fires on the element that loses focus and does not
  // bubble, yet a *capturing* listener on window still sees it — so pressing an item moved focus,
  // the menu heard its own item blur, and closed before the click could run it.
  const listeners = [
    [document, 'pointerdown', onPointerDown, true], [document, 'keydown', onKeyDown, true],
    [document, 'contextmenu', onContextMenu, true], [window, 'blur', onBlur, false],
    [window, 'resize', onResize, true],
  ];
  for (const [target, type, handler, capture] of listeners) target.addEventListener(type, handler, capture);
  open.cleanup = () => {
    for (const [target, type, handler, capture] of listeners) target.removeEventListener(type, handler, capture);
  };
  return menu;
}

export function closeContextMenu() {
  if (!open) return;
  open.cleanup?.();
  for (const panel of panelsOf(open)) panel.remove();
  open.anchor?.classList?.remove('context-menu-open');
  open = null;
}

/** True while a menu is open, so views can let the menu swallow their own keys. */
export function contextMenuOpen() {
  return Boolean(open);
}
