import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The editor's context menu is shared by every panel and view, and the create-object submenu is
// how an object is placed from a right click in either view. Both are DOM code driven by clicks,
// so what can be checked without a browser is the contract between them: the menu can carry a
// submenu at all, and the view menus offer the full list of things that can be created.
const memo = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

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
  assert.match(app, /function createObjectMenuItems\(position\)/);
  // One list built from ENTITY_TYPES, so a new object type appears in the menu automatically.
  assert.match(app, /ENTITY_TYPES\.map\(type => \(\{\s*label: type\[0\]\.toUpperCase\(\) \+ type\.slice\(1\)/);
  assert.match(app, /label: 'Path \(waypoints\)'/);
  // The 2D canvas menu, the 3D sector menu and the 3D empty-view menu all carry it.
  const uses = app.match(/\{ label: 'Create object', submenu: createObjectMenuItems\(/g) || [];
  assert.equal(uses.length, 3, 'the 2D menu, the 3D sector menu and the 3D empty area');
  // A path is started at the clicked point, so the following clicks extend the same route.
  assert.match(app, /function startPathAt\(position\)/);
  assert.match(app, /activePathId = null;\s*\n\s*addPathPoint\(position\);/);
});

test('a submenu is not closed by the pointer crossing the parent menu', () => {
  const menu = memo('context-menu.js');
  // Closing on hover looks tidy and loses the panel from under the pointer when it is clamped
  // to the bottom of the window; the entries then cannot be pressed at all.
  assert.equal(/pointerenter', \(\) => owner\.closeSubmenus/.test(menu), false,
    'hovering a parent item does not close the open submenu');
  assert.match(menu, /closeSubmenus\(1\)/, 'Escape and ArrowLeft still step out of it');
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
  // A right press leaves the mode in both views: the map's own pointerdown, and the 3D view
  // through its callback.
  assert.match(app, /if \(event\.button === 2\) finishPath\(\);/);
  assert.match(memo('scene-editor.js'), /callbacks\.clearTool\?\.\(\)/);
});
