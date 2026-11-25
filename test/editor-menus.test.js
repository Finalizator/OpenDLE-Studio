import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { contextMenu } from '../public/context-menu.js';

// The editor's context menu is shared by every panel and view, and the create-object submenu is
// how an object is placed from a right click in either view. Both are DOM code driven by clicks,
// so what can be checked without a browser is the contract between them: the menu can carry a
// submenu at all, and the view menus offer the full list of things that can be created.
const memo = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

test('unhandled editor right-clicks suppress native menus without blocking field or custom menus', () => {
  const app = memo('app.js');
  const start = app.indexOf('function dismissUnhandledContextMenu(');
  const end = app.indexOf('\ninstallContextMenus();', start);
  let closed = 0;
  const context = vm.createContext({ closeContextMenu() { closed++; } });
  vm.runInContext(app.slice(start, end), context);
  const event = options => ({
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...options,
  });
  const background = event({});
  context.dismissUnhandledContextMenu(background);
  assert.equal(background.defaultPrevented, true);
  assert.equal(closed, 1);
  const custom = event({ defaultPrevented: true });
  context.dismissUnhandledContextMenu(custom);
  assert.equal(closed, 1, 'an existing editor menu is left open');
  const input = event({ target: { closest: () => ({}) } });
  context.dismissUnhandledContextMenu(input);
  assert.equal(input.defaultPrevented, false, 'native text editing remains available');
  assert.equal(closed, 1);
  assert.match(app, /window\.addEventListener\('contextmenu', dismissUnhandledContextMenu\)/,
    'the fallback runs after document-level addon and editor menus');
});

test('empty and separator-only menus do not create panels or leave pointer listeners behind', () => {
  // No DOM should be needed when there is nothing to show.
  assert.equal(contextMenu({}, []), null);
  assert.equal(contextMenu({}, [null, { separator: true }]), null);
});

test('the context menu can open a submenu from an item', () => {
  const menu = memo('context-menu.js');
  assert.match(menu, /submenu/, 'an item can carry a submenu');
  assert.match(menu, /aria-haspopup/, 'and says so to assistive technology');
  assert.match(menu, /context-menu-chevron/, 'and shows a chevron');
  // Hovering opens it, which is how the rest of the editor behaves; a click is kept for
  // keyboards and touchscreens.
  assert.match(menu, /addEventListener\('pointerenter'/, 'hover opens the submenu');
  assert.match(menu, /ArrowLeft/, 'and Escape / left arrow step back out of it');
  // The child panel counts as part of the menu, or pressing one of its items would close the
  // menu before the item could run.
  assert.match(menu, /function panelsOf/, 'child panels are part of the open menu');
  assert.match(menu, /insideMenu\(state, event\.target\)/);
  // `blur` must not be captured: a capturing window listener hears an item lose focus and would
  // close the menu on the press that was meant to activate it.
  assert.match(menu, /\[window, 'blur', onBlur, false\]/);
});

test('both view menus offer every object type plus a path from a right click', () => {
  const app = memo('app.js');
  // The elevation is the surface the object lands on: a sector floor, or — on a brush level — the
  // brush top or the surface the ray hit.
  assert.match(app, /function createObjectMenuItems\(position, elevation = 0\)/);
  // One list built from ENTITY_TYPES, so a new object type appears in the menu automatically.
  assert.match(app, /ENTITY_TYPES\.map\(type => \(\{\s*label: type\[0\]\.toUpperCase\(\) \+ type\.slice\(1\)/);
  assert.match(app, /label: 'Path \(waypoints\)'/);
  // Two builders, not three menus: the 2D canvas and the tail every 3D right click gets. The 3D
  // view used to have a menu per thing hit, and a brush level's answer was the brush actions
  // alone — no Create object, no Group, no Duplicate.
  const uses = app.match(/\{ label: 'Create object', submenu: createObjectMenuItems\(/g) || [];
  assert.equal(uses.length, 2, 'the 2D canvas menu and the 3D view actions');
  assert.match(app, /function viewActionItems\(under\)/, 'one tail of actions for the 3D view');
  assert.match(app, /items\.push\(\.\.\.viewActionItems\(under\)\)/,
    'the 3D menu appends it whatever the pointer hit');
  // A path is started at the clicked point, so the following clicks extend the same route.
  assert.match(app, /function startPathAt\(position\)/);
  assert.match(app, /activePathId = null;\s*\n\s*addPathPoint\(position\);/);
});

test('hovering an item leaves one submenu open, not a stack of them', () => {
  const menu = memo('context-menu.js');
  // Every item takes the same hover path, submenu or not, so pointing at an ordinary item takes
  // down the panel another item left open instead of leaving it standing beside it.
  assert.match(menu, /button\.addEventListener\('pointerenter', \(\) => owner\.showItem\(item, button, 'pointer'\)\)/);
  assert.match(menu, /const showItem = \(item, element, source = 'pointer'\) => \{/);
  assert.match(menu, /for \(const child of \[\.\.\.state\.children\]\) if \(!keep\.has\(child\)\) dropPanel\(child\)/);
  // A panel belongs to the item that opened it, not to its label: two items may share a label, and
  // a label cannot be matched against an element.
  assert.match(menu, /const submenuFor = element => state\.children\.find\(child => openerOf\.get\(child\) === element\)/);
  // Focus is not intent. The menu focuses its first item as it opens, and a press focuses the item
  // it is about to click; unfolding on either would open a panel nobody asked for.
  assert.match(menu, /button\.addEventListener\('focus', \(\) => owner\.showItem\(item, button, 'focus'\)\)/);
  assert.match(menu, /let keyboardNav = false;/);
  assert.match(menu, /else if \(!keyboardNav\) return;/);
  assert.match(menu, /keyboardNav = true; moveFocus\(panel, 1\)/, 'arrows are the keyboard driving it');
  // Escape and ArrowLeft step out of one panel and put the caret back on the item that opened it.
  assert.match(menu, /closeSubmenus\(state\.children\.indexOf\(panel\)\)/);
  assert.doesNotMatch(menu, /closeSubmenus\(1\)/);
});

test('Draw path is a mode that Escape and a right click can leave', () => {
  const app = memo('app.js');
  // Leaving the tool returns to Select, so a later left click selects instead of adding a
  // waypoint — the trap the tool had: click anywhere and the route grew.
  assert.match(app, /function finishPath\(\{ select = true \} = \{\}\)/);
  assert.match(app, /if \(select && toolMode\(\) === 'path'\) \$\('tool'\)\.value = 'select';/);
  // The Tool box carries the selected object's own transforms, and choosing one is the same
  // choice as the Transform list, so a drag and a gizmo can never disagree.
  assert.match(app, /function toolMode\(\)/);
  assert.match(app, /\['transform:form', 'Form \(resize sides\)'\]/);
  assert.match(app, /\['transform:scale', volume \? 'Scale volume' : 'Scale object'\]/);
  // The toolbar's own change handler must not drag the tool back to Select after the mapper
  // picked something else.
  assert.match(app, /if \(toolMode\(\) !== 'path'\) finishPath\(\{ select: false \}\)/);
  // Escape works even before the first waypoint: the mode itself has to end.
  assert.match(app, /if \(activePathId \|\| toolMode\(\) === 'path'\) finishPath\(\);/);
  // A right *click* leaves the mode in both views — the map when the pan turns out to be a click,
  // the 3D view through its callback — and looking around with the right button does not, because
  // a mapper places a waypoint, turns the view and expects to keep drawing.
  assert.match(app, /if \(finished\.kind === 'pan' && finished\.button === 2 && !finished\.moved\) \{\s*if \(geometryCutActive\(\)\) \{ cutTool\.cancel\(\); return; \}\s*finishPath\(\); mapCanvasMenu\(event\); return;\s*\}/);
  assert.doesNotMatch(app, /if \(event\.button === 2\) finishPath\(\);/);
  assert.match(memo('scene-editor.js'), /callbacks\.clearTool\?\.\(\)/);
  assert.match(memo('scene-editor.js'), /if \(!completed\.moved\) \{\s*callbacks\.clearTool\?\.\(\);/);
  // The route line is pickable in 3D, not only its waypoint cubes.
  assert.match(memo('scene-editor.js'), /ray\.params\.Line\.threshold = Math\.max\(8, camera\.position\.distanceTo\(pathCentre\) \* \.012\)/);
  assert.match(memo('scene-editor.js'), /line\.userData\.selection = \{ kind: 'path', id: path\.id \};/);
});
