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
  if (item.checked !== undefined) {
    // A tick alone tells a screen reader nothing, and a scenario driving the menu cannot read it.
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-checked', String(Boolean(item.checked)));
  }
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
  // Which submenu is on screen is decided here, for every item, not only for the ones that carry
  // one: hovering an ordinary item closes the panel another item opened, so walking down a menu
  // leaves one panel open instead of a stack of them.
  button.addEventListener('pointerenter', () => owner.showItem(item, button, 'pointer'));
  if (item.submenu?.length) {
    // A submenu opens on hover or on keyboard focus, which is how every other menu behaves; the
    // click is kept for touch, where there is neither.
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const chevron = document.createElement('span');
    chevron.className = 'context-menu-chevron';
    chevron.textContent = '\u25b8';
    button.append(chevron);
    // Focus arrives by itself when the menu opens, or on the press that also produces a click;
    // unfolding a submenu then would open a panel nobody asked for.
    button.addEventListener('focus', () => owner.showItem(item, button, 'focus'));
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) return;
      if (owner.submenuFor(button)) owner.closeSubmenus();
      else owner.openSubmenu(item, button);
    });
    return button;
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
  if (!list.some(item => !item.separator)) return null;
  const state = { menu: null, children: [], anchor };
  // Whether the pointer or the keyboard is driving the menu. Focus alone means nothing: a menu
  // focuses its first item as it opens, and a press focuses the item it is about to click.
  let keyboardNav = false;
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
  /** Which item opened each child panel, so a panel can be matched to its item, not to a label. */
  const openerOf = new Map();
  const panelOf = element => element?.closest?.('.context-menu') || null;
  /** The child panel an item opened, so hovering it again does not rebuild it. */
  const submenuFor = element => state.children.find(child => openerOf.get(child) === element);
  const closeSubmenus = (from = 0) => {
    for (const child of state.children.slice(from)) {
      child.remove();
      openerOf.get(child)?.setAttribute('aria-expanded', 'false');
      openerOf.delete(child);
    }
    state.children.length = from;
  };
  /** The panels that lead to `element`: the one it sits in, and the ones its parents opened. */
  const branchOf = element => {
    const branch = new Set();
    for (let panel = panelOf(element); panel && panel !== state.menu; panel = panelOf(openerOf.get(panel))) branch.add(panel);
    return branch;
  };
  const dropPanel = panel => {
    panel.remove();
    const index = state.children.indexOf(panel);
    if (index >= 0) state.children.splice(index, 1);
    openerOf.get(panel)?.setAttribute('aria-expanded', 'false');
    openerOf.delete(panel);
  };
  /**
   * Shows what `element` opens and takes down everything else, which is what keeps the panels
   * from piling up beside each other as the pointer walks down the menu. Travel to a panel is
   * safe: it is anchored to the row that opened it (its top sits at or above that row, its bottom
   * at the window bottom when it has to be pushed up), so the way in is a sideways move.
   */
  const showItem = (item, element, source = 'pointer') => {
    if (!element) return;
    // A hover is where the pointer is, a focus is only where the caret is.
    if (source === 'pointer') keyboardNav = false;
    else if (!keyboardNav) return;
    const keep = branchOf(element);
    const own = submenuFor(element);
    if (own) keep.add(own);
    for (const child of [...state.children]) if (!keep.has(child)) dropPanel(child);
    if (item?.submenu?.length) openSubmenu(item, element);
  };
  const openSubmenu = (item, element) => {
    if (!item?.submenu?.length || !element) return;
    const existing = submenuFor(element);
    if (existing) return;
    const panel = build(item.submenu, item.label, element);
    document.body.append(panel);
    state.children.push(panel);
    openerOf.set(panel, element);
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
    // The panel takes the caret, which is not a reason for its first item to unfold as well.
    keyboardNav = false;
    first?.focus({ preventScroll: true });
  };
  const owner = { openSubmenu, submenuFor, closeSubmenus, showItem };
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
    if ((event.key === 'Escape' || event.key === 'ArrowLeft') && nested) {
      // Step out one panel and land the caret back on the item that opened it. The panels only
      // ever form one branch, so this drops the panel and the ones unfolded from it.
      event.preventDefault();
      const opener = openerOf.get(panel);
      closeSubmenus(state.children.indexOf(panel));
      opener?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (state.children.length) { closeSubmenus(); menu.focus(); return; }
      closeContextMenu(); return;
    }
    if (event.key === 'ArrowRight') {
      const focused = document.activeElement;
      if (focused?.dataset?.submenuFor) {
        event.preventDefault();
        focused.click();
        return;
      }
    }
    // Moving with the keys is the other way a submenu opens: the arrow lands on the item, and the
    // item's own focus handler asks this flag before unfolding anything.
    if (event.key === 'ArrowDown') { event.preventDefault(); keyboardNav = true; moveFocus(panel, 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); keyboardNav = true; moveFocus(panel, -1); return; }
    if (event.key === 'Home') { event.preventDefault(); keyboardNav = true; panel.querySelector('.context-menu-item:not([disabled])')?.focus(); return; }
    if (event.key === 'End') {
      event.preventDefault();
      keyboardNav = true;
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
