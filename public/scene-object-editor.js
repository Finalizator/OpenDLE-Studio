import { entityColors } from './render.js';
import {
  sceneChildren, sceneDepths, sceneSubtree, sceneDescendants, sceneBounds, sceneOrigin,
  addSceneObject, removeSceneObjects, duplicateSceneObject, reparentSceneObject, moveSceneObject,
  renameSceneObject, MAX_SCENE_ENTITIES,
  sceneArtwork, sceneAssetUse, setSceneObjectAsset, addSceneObjectFromAsset, addSceneObjectFromEntity, nestScene,
} from '/shared/scenes.js';
import { ENTITY_TYPES } from '/shared/project.js';
import { assetField, openAssetPicker, MODEL_KINDS, PICTURE_KINDS } from './asset-picker.js';
import { contextMenu } from './context-menu.js';

// A scene object editor laid out like Godot's scene dock and inspector: the node tree
// on the left with the node toolbar under it, the view in the middle, and the
// inspector on the right with folded property categories. The scene is the node tree
// root, so the tree always starts on the scene itself, exactly as a Godot scene does.

/** Icons are text glyphs, one per object type, so the tree needs no image assets. */
const TYPE_GLYPHS = { scene: 'S', enemy: 'E', pickup: 'P', light: 'L', decoration: 'D', player: 'O' };
const TYPE_LABELS = { scene: 'Scene', enemy: 'Enemy', pickup: 'Pickup', light: 'Light', decoration: 'Decoration' };
const GRID = 32;
/** Godot's inspector groups; a row is only shown when the object has that data. */
const CATEGORIES = ['Transform', 'Node', 'Visual', 'Model', 'Physics', 'Light', 'Interaction area', 'Script'];

export function createSceneObjectEditor({ callbacks }) {
  const state = {
    sceneId: null,
    selection: null,
    filter: '',
    propertyFilter: '',
    collapsed: new Set(),
    zoom: 1,
    panX: 0,
    panY: 0,
    grid: true,
    snap: true,
    // The 3D tab orbits a camera around the scene origin, the way Godot's 3D view does.
    view3d: false,
    orbitYaw: -0.7,
    orbitPitch: 0.55,
    orbitDistance: 420,
    drag: null,
    treeDrag: null,
    // Dragging an asset, a scene or a layout object onto the view or the tree.
    drop: null,
  };
  const dom = {};
  const scene = () => callbacks.scenes().find(item => item.id === state.sceneId) || null;
  const selectedObject = () => {
    const current = scene();
    return current && state.selection && state.selection !== current.id
      ? current.entities.find(entity => entity.id === state.selection) || null : null;
  };

  /* ---------------------------------------------------------------- helpers */

  function glyph(type) {
    const span = document.createElement('span');
    // Colour comes from the stylesheet per type: inline styles are refused by the CSP.
    span.className = `node-glyph node-glyph-${type}`;
    span.textContent = TYPE_GLYPHS[type] || 'N';
    return span;
  }

  function el(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function iconButton(label, title, onClick) {
    const element = el('button', label);
    element.title = title;
    element.setAttribute('aria-label', title);
    element.addEventListener('click', event => { event.preventDefault(); onClick(); });
    return element;
  }

  /** Every edit goes through the app so it is undoable and validated. */
  function editScene(fn, message) {
    const id = state.sceneId;
    if (!id) return;
    callbacks.editScene(id, fn, message);
  }

  function select(id) {
    state.selection = id;
    if (id && id !== state.sceneId) revealInTree(id);
    renderTree();
    renderInspector();
    draw();
  }

  function revealInTree(id) {
    const current = scene();
    if (!current) return;
    let parent = current.entities.find(entity => entity.id === id)?.parentId;
    for (let depth = 0; parent && depth < 24; depth++) {
      state.collapsed.delete(parent);
      parent = current.entities.find(entity => entity.id === parent)?.parentId;
    }
  }

  /* ------------------------------------------------------------------- tabs */

  function renderTabs() {
    if (!dom.tabs) return;
    dom.tabs.replaceChildren();
    const open = callbacks.openScenes();
    for (const id of open) {
      const item = callbacks.scenes().find(candidate => candidate.id === id);
      if (!item) continue;
      const tab = el('button', null, 'scene-tab');
      tab.classList.toggle('active', id === state.sceneId);
      tab.append(el('span', null, 'scene-tab-icon'), el('span', item.name, 'scene-tab-name'));
      const close = el('span', null, 'scene-tab-close');
      close.textContent = '\u00d7';
      close.title = 'Close this scene';
      close.addEventListener('click', event => { event.stopPropagation(); callbacks.closeScene(id); });
      tab.append(close);
      tab.addEventListener('click', () => callbacks.openScene(id));
      tab.addEventListener('contextmenu', menuEvent => {
        menuEvent.preventDefault();
        contextMenu(menuEvent, [
          { label: 'Open', run: () => callbacks.openScene(id) },
          { label: 'Close', run: () => callbacks.closeScene(id) },
          { label: 'Close other scene objects', disabled: open.length < 2, run: () => {
            for (const other of open) if (other !== id) callbacks.closeScene(other);
          } },
          { separator: true },
          { label: 'Place in layout', run: () => callbacks.placeScene(id) },
          { label: 'Delete scene', danger: true, run: () => callbacks.deleteScene(id) },
        ], { label: `${item.name} tab` });
      });
      dom.tabs.append(tab);
    }
    const add = el('button', '+', 'scene-tab-add');
    add.title = 'Open another scene object';
    add.addEventListener('click', () => callbacks.chooseScene());
    dom.tabs.append(add);
  }

  /* ------------------------------------------------------------------- tree */

  function matchesFilter(entity) {
    if (!state.filter) return true;
    const needle = state.filter.toLowerCase();
    return entity.name.toLowerCase().includes(needle) || TYPE_LABELS[entity.type]?.toLowerCase().includes(needle)
      || entity.id.toLowerCase().includes(needle);
  }

  /** Keeps a node visible when any of its children matches the filter (Godot does too). */
  function branchMatches(entity, children) {
    if (matchesFilter(entity)) return true;
    return (children.get(entity.id) || []).some(child => branchMatches(child, children));
  }

  function renderTree() {
    if (!dom.tree) return;
    dom.tree.replaceChildren();
    const current = scene();
    if (!current) {
      dom.tree.append(el('p', 'No scene object is open.', 'muted scene-empty'));
      return;
    }
    const children = sceneChildren(current), depths = sceneDepths(current);
    const root = el('div', null, 'node-row node-row-root');
    root.dataset.nodeId = current.id;
    root.setAttribute('role', 'treeitem');
    root.setAttribute('aria-level', '1');
    root.setAttribute('aria-selected', String(state.selection === current.id));
    root.classList.toggle('selected', state.selection === current.id);
    root.tabIndex = 0;
    root.append(el('span', null, 'node-twisty node-twisty-empty'), glyph('scene'));
    root.append(el('span', current.name, 'node-name'));
    root.append(el('span', 'Scene', 'node-type'));
    const count = current.entities.length;
    root.append(el('span', `${count} node${count === 1 ? '' : 's'}`, 'node-badge'));
    root.addEventListener('mousedown', event => { event.stopPropagation(); select(current.id); });
    root.addEventListener('dblclick', () => beginRename(current.id, root));
    root.addEventListener('contextmenu', menuEvent => {
      menuEvent.preventDefault();
      select(current.id);
      contextMenu(menuEvent, [
        { label: 'Add node', run: () => addNode(null) },
        { label: 'Expand all', run: () => runTool('expand') },
        { label: 'Collapse all', run: () => runTool('collapse') },
        { separator: true },
        { label: 'Place in layout', run: () => callbacks.placeScene(current.id) },
        { label: 'Capture selected layout objects', run: () => callbacks.captureInto(current.id) },
        { separator: true },
        { label: 'Delete scene', danger: true, run: () => callbacks.deleteScene(current.id) },
      ], { label: `${current.name} actions` });
    });
    makeTreeDropTarget(root, null);
    dom.tree.append(root);

    const rows = [];
    const walk = (parent, depth) => {
      for (const entity of children.get(parent) || []) {
        const childRows = children.get(entity.id) || [];
        const visible = !state.filter || branchMatches(entity, children) || matchesFilter(entity);
        if (!visible) continue;
        const collapsed = state.collapsed.has(entity.id);
        const row = el('div', null, 'node-row');
        row.dataset.nodeId = entity.id;
        row.dataset.depth = String(depth);
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 2));
        row.setAttribute('aria-selected', String(state.selection === entity.id));
        row.setAttribute('aria-expanded', String(!collapsed));
        row.classList.toggle('selected', state.selection === entity.id);
        row.classList.toggle('dimmed', Boolean(state.filter) && !matchesFilter(entity));
        row.classList.add(`node-depth-${Math.min(depth, 8)}`);
        row.tabIndex = -1;

        const twisty = el('span', null, `node-twisty${childRows.length ? '' : ' node-twisty-empty'}`);
        twisty.textContent = childRows.length ? (collapsed ? '\u25b8' : '\u25be') : '';
        if (childRows.length) {
          twisty.addEventListener('mousedown', event => {
            event.stopPropagation();
            if (collapsed) state.collapsed.delete(entity.id); else state.collapsed.add(entity.id);
            renderTree();
          });
        }
        row.append(twisty, glyph(entity.type), el('span', entity.name, 'node-name'));
        row.append(el('span', TYPE_LABELS[entity.type] || entity.type, 'node-type'));
        const events = (current.events || []).filter(event => event.ownerId === entity.id).length;
        if (events) row.append(el('span', String(events), 'node-badge'), el('span', null, 'node-badge-score'));
        row.draggable = true;
        row.addEventListener('mousedown', event => {
          if (event.button !== 0) return;
          event.stopPropagation();
          select(entity.id);
        });
        row.addEventListener('dragstart', dragEvent => {
          state.treeDrag = entity.id;
          dragEvent.dataTransfer?.setData('text/plain', entity.id);
          if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
          state.treeDrag = null;
          row.classList.remove('dragging');
          dom.tree.querySelectorAll('.drop-into').forEach(element => element.classList.remove('drop-into'));
        });
        row.addEventListener('dblclick', () => beginRename(entity.id, row));
        // Right-click acts on the row under the pointer, like Godot's node context menu.
        row.addEventListener('contextmenu', menuEvent => {
          menuEvent.preventDefault();
          select(entity.id);
          contextMenu(menuEvent, [
            ...nodeMenuItems(entity),
            { separator: true },
            { label: 'Move up', run: () => { select(entity.id); runTool('up'); } },
            { label: 'Move down', run: () => { select(entity.id); runTool('down'); } },
          ], { label: `${entity.name} actions` });
        });
        makeTreeDropTarget(row, entity.id);
        dom.tree.append(row);
        rows.push(row);
        if (!collapsed) walk(entity.id, depth + 1);
      }
    };
    walk('', 0);
    if (!rows.length && !state.filter) {
      dom.tree.append(el('p', 'Use + to add a node, or capture objects from the layout.', 'muted scene-empty'));
    } else if (!rows.length) {
      dom.tree.append(el('p', `No node matches "${state.filter}".`, 'muted scene-empty'));
    }
  }

  function makeTreeDropTarget(row, parentId) {
    row.addEventListener('dragover', event => {
      if (!state.treeDrag) return;
      event.preventDefault();
      if (state.treeDrag === parentId) return;
      row.classList.add('drop-into');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
    row.addEventListener('drop', event => {
      if (!state.treeDrag) return;
      event.preventDefault(); event.stopPropagation();
      row.classList.remove('drop-into');
      const moving = state.treeDrag;
      state.treeDrag = null;
      if (!moving || moving === parentId) return;
      try {
        editScene(next => reparentSceneObject(next, moving, parentId),
          parentId ? 'Node grouped under its new parent' : 'Node moved to the scene root');
      } catch (error) { callbacks.status(error.message, true); }
    });
  }

  function beginRename(id, row) {
    const current = scene();
    const entity = id === current?.id ? current : current?.entities.find(item => item.id === id);
    if (!entity) return;
    const name = el('input', null, 'node-rename');
    name.value = entity.name;
    name.setAttribute('aria-label', 'Node name');
    const label = row.querySelector('.node-name');
    label.replaceWith(name);
    name.focus(); name.select();
    const finish = commit => {
      const value = name.value.trim();
      if (commit && value && value !== entity.name) {
        try {
          editScene(next => {
            if (id === next.id) next.name = value.slice(0, 100);
            else renameSceneObject(next, id, value);
          }, `Renamed to ${value}`);
        } catch (error) { callbacks.status(error.message, true); }
      }
      renderAll();
    };
    name.addEventListener('keydown', keyEvent => {
      if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); finish(true); }
      else if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); finish(false); }
    });
    name.addEventListener('blur', () => finish(true));
  }

  /* ---------------------------------------------------------------- toolbar */

  function addNode(parentId = null, point = null) {
    const current = scene();
    if (!current) return;
    if (current.entities.length >= MAX_SCENE_ENTITIES) {
      callbacks.status(`A scene holds at most ${MAX_SCENE_ENTITIES} nodes`, true);
      return;
    }
    // New nodes land in front of the view centre, or at the point the caller dropped on.
    const centre = point || (state.view3d ? { x: 0, y: 0 }
      : worldToScene({ x: dom.canvas.clientWidth / 2, y: dom.canvas.clientHeight / 2 }));
    const snap = value => state.snap ? Math.round(value / GRID) * GRID : Math.round(value);
    let created = null;
    try {
      editScene(next => {
        created = addSceneObject(next, { type: 'decoration', name: 'New node', x: snap(centre.x), y: snap(centre.y), parentId });
      }, 'Node added');
    } catch (error) { callbacks.status(error.message, true); return; }
    if (created) select(created.id);
  }

  function runTool(tool) {
    const current = scene();
    if (!current) return;
    const id = state.selection;
    const isRoot = !id || id === current.id;
    const title = name => (name || '').trim() || 'Node';
    try {
      switch (tool) {
        case 'add': addNode(isRoot ? null : id); return;
        case 'duplicate': {
          if (isRoot) { callbacks.status('Select a node to duplicate', true); return; }
          let result = null;
          editScene(next => { result = duplicateSceneObject(next, id); }, 'Node duplicated');
          if (result) select(result.root);
          return;
        }
        case 'up': case 'down': {
          if (isRoot) { callbacks.status('Select a node to reorder', true); return; }
          editScene(next => moveSceneObject(next, id, tool === 'up' ? -1 : 1), 'Node reordered');
          return;
        }
        case 'expand': {
          state.collapsed.clear(); renderTree(); return;
        }
        case 'collapse': {
          for (const entity of current.entities) if ((sceneChildren(current).get(entity.id) || []).length) state.collapsed.add(entity.id);
          renderTree(); return;
        }
        case 'rename': {
          if (isRoot) { beginRename(current.id, dom.tree.querySelector('.node-row-root')); return; }
          const row = dom.tree.querySelector(`.node-row[data-node-id="${id}"]`);
          if (row) beginRename(id, row);
          return;
        }
        case 'delete': {
          if (isRoot) { callbacks.status('The scene root cannot be deleted; remove the scene instead', true); return; }
          const entity = selectedObject();
          if (!entity) return;
          const subtree = sceneSubtree(current, id).length;
          const message = subtree > 1
            ? `Delete ${title(entity.name)} and ${subtree - 1} grouped node(s)?`
            : `Delete ${title(entity.name)}?`;
          if (!confirm(message)) return;
          editScene(next => removeSceneObjects(next, id), 'Node deleted');
          select(current.id);
          return;
        }
        default: return;
      }
    } catch (error) { callbacks.status(error.message, true); }
  }

  /* -------------------------------------------------------------- inspector */

  let propertyHost = null;

  function propertyRow(container, { label, value, editor, reset }) {
    container = propertyHost || container;
    const row = el('div', null, 'property-row');
    const name = el('label', label, 'property-name');
    name.title = label;
    const valueCell = el('div', null, 'property-value');
    valueCell.append(editor);
    row.append(name, valueCell);
    if (reset) {
      const revert = el('button', '\u21ba', 'property-revert');
      revert.title = `Reset ${label}`;
      revert.setAttribute('aria-label', `Reset ${label}`);
      revert.addEventListener('click', event => { event.preventDefault(); reset(); });
      row.append(revert);
    } else row.append(el('span', null, 'property-revert-empty'));
    container.append(row);
    return row;
  }

  function numberEditor(value, { min, max, step = 1, onChange }) {
    const wrap = el('div', null, 'number-editor');
    const input = el('input');
    input.type = 'number'; input.value = String(value); input.step = String(step);
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) { input.value = String(value); return; }
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
      if (clamped !== parsed) input.value = String(clamped);
      onChange(clamped);
    });
    wrap.append(input);
    return wrap;
  }

  function textEditor(value, onChange, { maxLength = 100 } = {}) {
    const input = el('input');
    input.type = 'text'; input.value = value ?? ''; input.maxLength = maxLength;
    input.addEventListener('change', () => onChange(input.value.slice(0, maxLength)));
    return input;
  }

  function selectEditor(options, value, onChange) {
    const select = el('select');
    for (const [optionValue, label] of options) {
      const option = el('option', label);
      option.value = optionValue;
      select.append(option);
    }
    select.value = value ?? '';
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function checkEditor(value, onChange, label) {
    const input = el('input');
    input.type = 'checkbox'; input.checked = Boolean(value);
    input.setAttribute('aria-label', label || 'Enabled');
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  /**
   * A sprite or model slot. An imported game has thousands of sprites, so the row shows
   * the current asset and opens the searchable picker instead of a list of every asset.
   */
  function assetEditor(kind, value, onChange, onClear) {
    const assets = callbacks.assets() || [];
    const asset = value ? assets.find(candidate => candidate.id === value) || null : null;
    const kinds = kind === 'model' ? MODEL_KINDS : PICTURE_KINDS;
    const missing = value && !asset;
    return assetField(missing ? { name: `${value} (missing)`, kind } : asset, {
      placeholder: kind === 'model' ? 'Choose a 3D model' : 'Choose a sprite',
      title: missing ? `${value} is not part of this project any more` : undefined,
      onOpen: button => openAssetPicker({
        anchor: button,
        title: kind === 'model' ? 'Choose a 3D model' : 'Choose a sprite or image',
        assets, kinds, value,
        noneLabel: kind === 'model' ? '(no model)' : '(no sprite)',
        emptyText: kind === 'model'
          ? 'No 3D models yet. Import a glTF, glb, obj or bbmodel from the Assets tab.'
          : 'No pictures yet. Import a WAD or images to get sprites.',
        onPick: chosen => onChange(chosen.id),
        ...(onClear ? { onClear } : {}),
      }),
      ...(onClear ? { onClear, clearLabel: kind === 'model' ? 'Remove the model' : 'Remove the sprite' } : {}),
    });
  }

  function categoryHeader(container, title) {
    const row = el('div', null, 'property-category');
    const twisty = el('span', null, 'property-twisty');
    twisty.textContent = state.collapsed.has(`cat:${title}`) ? '\u25b8' : '\u25be';
    row.append(twisty, el('span', title, 'property-category-name'));
    row.addEventListener('click', () => {
      const key = `cat:${title}`;
      if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
      renderInspector();
    });
    container.append(row);
    return !state.collapsed.has(`cat:${title}`);
  }

  function renderInspector() {
    if (!dom.properties) return;
    dom.properties.replaceChildren();
    const current = scene();
    if (!current) {
      dom.head?.replaceChildren(el('p', 'No scene object is open.', 'muted'));
      return;
    }
    const entity = selectedObject();
    const isRoot = !entity;
    const target = entity || current;
    const propertiesOf = (id, patch, message) => {
      try {
        editScene(next => {
          if (id === next.id) Object.assign(next, patch);
          else Object.assign(next.entities.find(item => item.id === id), patch);
        }, message);
      } catch (error) { callbacks.status(error.message, true); }
    };
    const set = (key, value, message) => propertiesOf(target.id, { [key]: value }, message || 'Node updated');
    // Assigning artwork goes through the shared helper so a sprite replaces a model and
    // the other way round, exactly like dropping an asset on the layout.
    const assignAsset = assetId => {
      if (isRoot) { callbacks.status('Pick a node, not the scene, to assign artwork', true); return; }
      assignNodeAsset(target.id, assetId);
    };
    const setPath = (path, value, message) => {
      try {
        editScene(next => {
          const record = id => (id === next.id ? next : next.entities.find(item => item.id === id));
          const item = record(target.id);
          const keys = path.split('.');
          let cursor = item;
          for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {};
          cursor[keys.at(-1)] = value;
        }, message || 'Node updated');
      } catch (error) { callbacks.status(error.message, true); }
    };
    const clear = (path, message) => {
      try {
        editScene(next => {
          const item = target.id === next.id ? next : next.entities.find(candidate => candidate.id === target.id);
          const keys = path.split('.');
          let cursor = item;
          for (const key of keys.slice(0, -1)) { cursor = cursor?.[key]; if (!cursor) return; }
          delete cursor[keys.at(-1)];
        }, message || 'Property cleared');
      } catch (error) { callbacks.status(error.message, true); }
    };

    // Header: icon, editable name, type — Godot's inspector node header.
    if (dom.head) {
      dom.head.replaceChildren();
      dom.head.append(glyph(isRoot ? 'scene' : target.type));
      const name = textEditor(target.name, value => {
        const clean = value.trim();
        if (!clean) { callbacks.status('An object name cannot be empty', true); renderInspector(); return; }
        propertiesOf(target.id, { name: clean.slice(0, 100) }, 'Node renamed');
      });
      name.className = 'scene-inspector-name';
      name.setAttribute('aria-label', 'Node name');
      dom.head.append(name);
      dom.head.append(el('span', isRoot ? 'Scene' : TYPE_LABELS[target.type] || target.type, 'scene-inspector-type'));
      const events = isRoot ? (current.events || []).length
        : (current.events || []).filter(event => event.ownerId === target.id).length;
      const link = el('button', `${events} event${events === 1 ? '' : 's'}`, 'scene-inspector-events');
      link.title = isRoot ? 'Open the scene event sheet' : 'Open this node\'s event sheet';
      link.addEventListener('click', () => callbacks.openEvents(isRoot ? '$all' : target.id));
      dom.head.append(link);
    }

    const filter = state.propertyFilter.toLowerCase();
    const visible = rowLabel => !filter || rowLabel.toLowerCase().includes(filter);
    let shown = 0;
    // A category is only drawn when it has something to show, which is what keeps the
    // inspector short for a light or a decoration, exactly like Godot's folded groups.
    const rows = (title, build) => {
      const body = el('div', null, 'property-group');
      propertyHost = body;
      try { build(); } finally { propertyHost = null; }
      if (!body.childElementCount) return;
      if (state.collapsed.has(`cat:${title}`)) {
        categoryHeader(dom.properties, title);
        return;
      }
      categoryHeader(dom.properties, title);
      dom.properties.append(body);
    };

    // The scene root has an origin instead of a position, so its transform edits that.
    const positionX = isRoot ? current.origin?.x ?? 0 : target.x;
    const positionY = isRoot ? current.origin?.y ?? 0 : target.y;
    const setPosition = (axis, value) => isRoot
      ? setPath(`origin.${axis}`, value, 'Scene origin moved')
      : set(axis, value, 'Node moved');
    rows('Transform', () => {
      if (visible('Position X')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Position X', value: positionX,
          editor: numberEditor(positionX, { step: GRID, onChange: value => setPosition('x', value) }),
          reset: positionX ? () => setPosition('x', 0) : null,
        });
      }
      if (visible('Position Y')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Position Y', value: positionY,
          editor: numberEditor(positionY, { step: GRID, onChange: value => setPosition('y', value) }),
          reset: positionY ? () => setPosition('y', 0) : null,
        });
      }
      if (!isRoot && visible('Elevation')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Elevation', value: target.elevation ?? 0,
          editor: numberEditor(target.elevation ?? 0, { min: -32768, max: 32767, onChange: value => set('elevation', value, 'Elevation updated') }),
          reset: target.elevation ? () => set('elevation', 0, 'Elevation reset') : null,
        });
      }
      if (!isRoot && visible('Rotation')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Rotation', value: target.angle ?? 0,
          editor: numberEditor(target.angle ?? 0, { min: -3600, max: 3600, step: 45, onChange: value => set('angle', value, 'Rotation updated') }),
          reset: target.angle ? () => set('angle', 0, 'Rotation reset') : null,
        });
      }
      if (!isRoot && visible('Parent')) {
        shown++;
        const options = [['', '(scene root)']];
        for (const candidate of current.entities) {
          if (candidate.id === target.id) continue;
          if (sceneDescendants(current, target.id).includes(candidate.id)) continue;
          options.push([candidate.id, candidate.name]);
        }
        propertyRow(dom.properties, {
          label: 'Parent', value: target.parentId ?? '',
          editor: selectEditor(options, target.parentId ?? '', value => {
            try {
              editScene(next => reparentSceneObject(next, target.id, value || null), value ? 'Node grouped' : 'Node ungrouped');
            } catch (error) { callbacks.status(error.message, true); }
          }),
          reset: target.parentId ? () => {
            try { editScene(next => reparentSceneObject(next, target.id, null), 'Node ungrouped'); }
            catch (error) { callbacks.status(error.message, true); }
          } : null,
        });
      }
    });

    rows('Node', () => {
      if (visible('Name')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Name', value: target.name,
          editor: textEditor(target.name, value => {
            const clean = value.trim();
            if (!clean) { callbacks.status('An object name cannot be empty', true); return; }
            set('name', clean.slice(0, 100), 'Node renamed');
          }),
        });
      }
      if (visible('Type') && !isRoot) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Type', value: target.type,
          editor: selectEditor(ENTITY_TYPES.filter(type => type !== 'player').map(type => [type, TYPE_LABELS[type] || type]),
            target.type, value => set('type', value, 'Node type changed')),
        });
      }
      if (visible('ID')) {
        shown++;
        const id = el('input');
        id.type = 'text'; id.value = target.id; id.readOnly = true; id.className = 'property-readonly';
        id.setAttribute('aria-label', 'Node ID');
        propertyRow(dom.properties, { label: 'ID', value: target.id, editor: id });
      }
      if (!isRoot && visible('Skill mask')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Skill mask', value: target.skillMask ?? '',
          editor: numberEditor(target.skillMask ?? 0, { min: 0, max: 7, onChange: value => set('skillMask', value, 'Skill mask updated') }),
          reset: target.skillMask ? () => clear('skillMask', 'Skill mask cleared') : null,
        });
      }
      if (!isRoot && visible('Health')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Health', value: target.health ?? 0,
          editor: numberEditor(target.health ?? 0, { min: 0, max: 1000000, onChange: value => set('health', value, 'Health updated') }),
          reset: target.health !== undefined ? () => clear('health', 'Health cleared') : null,
        });
      }
    });

    rows('Visual', () => {
      if (!isRoot && visible('Sprite')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Sprite', value: target.spriteAsset ?? '',
          editor: assetEditor('sprite', target.spriteAsset,
            value => assignAsset(value),
            target.spriteAsset ? () => clear('spriteAsset', 'Sprite cleared') : null),
        });
      }
      if (!isRoot && visible('Sprite scale')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Sprite scale', value: target.spriteScale ?? 1,
          editor: numberEditor(target.spriteScale ?? 1, { min: .05, max: 16, step: .05, onChange: value => set('spriteScale', value, 'Sprite scale updated') }),
          reset: target.spriteScale !== undefined ? () => clear('spriteScale', 'Sprite scale reset') : null,
        });
      }
    });

    rows('Model', () => {
      if (!isRoot && visible('Model')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Model', value: target.modelAsset ?? '',
          editor: assetEditor('model', target.modelAsset,
            value => assignAsset(value),
            target.modelAsset ? () => clear('modelAsset', 'Model cleared') : null),
        });
      }
      if (!isRoot && target.modelAsset && visible('Model scale')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Model scale', value: target.modelScale ?? 32,
          editor: numberEditor(target.modelScale ?? 32, { min: .001, max: 4096, step: 1, onChange: value => set('modelScale', value, 'Model scale updated') }),
        });
      }
      if (!isRoot && target.modelAsset && visible('Model pitch')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Model pitch', value: target.modelTilt?.pitch ?? 0,
          editor: numberEditor(target.modelTilt?.pitch ?? 0, { min: -3600, max: 3600, step: 90, onChange: value => setPath('modelTilt.pitch', value, 'Model pitch updated') }),
          reset: target.modelTilt?.pitch ? () => clear('modelTilt.pitch', 'Model pitch reset') : null,
        });
      }
      if (!isRoot && target.modelAsset && visible('Model roll')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Model roll', value: target.modelTilt?.roll ?? 0,
          editor: numberEditor(target.modelTilt?.roll ?? 0, { min: -3600, max: 3600, step: 90, onChange: value => setPath('modelTilt.roll', value, 'Model roll updated') }),
          reset: target.modelTilt?.roll ? () => clear('modelTilt.roll', 'Model roll reset') : null,
        });
      }
    });

    if (!isRoot) rows('Physics', () => {
      const config = target.physics;
      if (visible('Body')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Body', value: config?.body ?? 'none',
          editor: selectEditor([['none', 'None (static visual)'], ['fixed', 'Fixed'], ['dynamic', 'Dynamic'], ['kinematic', 'Kinematic']],
            config?.body ?? 'none', value => {
              if (value === 'none') clear('physics', 'Physics removed');
              else set('physics', {
                body: value, shape: config?.shape ?? 'box', width: config?.width ?? 32, height: config?.height ?? 32,
                depth: config?.depth ?? 32, radius: config?.radius ?? 16, mass: config?.mass ?? 1,
                friction: config?.friction ?? .7, restitution: config?.restitution ?? 0,
                sensor: config?.sensor ?? false, lockRotation: config?.lockRotation ?? false,
              }, 'Rigid body added');
            }),
          reset: config ? () => clear('physics', 'Physics removed') : null,
        });
      }
      if (config && config.body !== 'none' && visible('Shape')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Shape', value: config.shape,
          editor: selectEditor([['box', 'Box'], ['ball', 'Ball'], ['capsule', 'Capsule']], config.shape,
            value => setPath('physics.shape', value, 'Collider shape updated')),
        });
      }
      if (config && config.body !== 'none') {
        for (const [key, label, min] of [['width', 'Width', .1], ['height', 'Height', .1], ['depth', 'Depth', .1], ['radius', 'Radius', .1],
          ['mass', 'Mass', .01], ['friction', 'Friction', 0], ['restitution', 'Restitution', 0]]) {
          if (!visible(label)) continue;
          shown++;
          propertyRow(dom.properties, {
            label, value: config[key] ?? 0,
            editor: numberEditor(config[key] ?? 0, { min, max: 100000, step: key === 'friction' || key === 'restitution' ? .05 : 1,
              onChange: value => setPath(`physics.${key}`, value, `Collider ${label.toLowerCase()} updated`) }),
          });
        }
        for (const [key, label] of [['sensor', 'Sensor'], ['lockRotation', 'Lock rotation']]) {
          if (!visible(label)) continue;
          shown++;
          propertyRow(dom.properties, {
            label, value: config[key],
            editor: checkEditor(config[key], value => setPath(`physics.${key}`, value, `${label} updated`), label),
          });
        }
      }
    });

    if (!isRoot) rows('Light', () => {
      const light = target.light;
      if (visible('Light')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Light', value: Boolean(light),
          editor: checkEditor(light, value => value
            ? set('light', light || { color: '#ffbd72', intensity: 1, radius: 192 }, 'Light added')
            : clear('light', 'Light removed'), 'Light'),
        });
      }
      if (light) {
        if (visible('Color')) {
          shown++;
          const color = el('input');
          color.type = 'color'; color.value = light.color;
          color.setAttribute('aria-label', 'Light color');
          color.addEventListener('change', () => setPath('light.color', color.value, 'Light colour updated'));
          propertyRow(dom.properties, { label: 'Color', value: light.color, editor: color });
        }
        for (const [key, label, max, step] of [['intensity', 'Intensity', 10, .05], ['radius', 'Radius', 8192, 8]]) {
          if (!visible(label)) continue;
          shown++;
          propertyRow(dom.properties, {
            label, value: light[key],
            editor: numberEditor(light[key], { min: key === 'intensity' ? 0 : 1, max, step,
              onChange: value => setPath(`light.${key}`, value, `Light ${label.toLowerCase()} updated`) }),
          });
        }
      }
    });

    if (!isRoot) rows('Interaction area', () => {
      const area = target.area;
      if (visible('Interaction area')) {
        shown++;
        propertyRow(dom.properties, {
          label: 'Interaction area', value: Boolean(area),
          editor: checkEditor(area, value => value
            ? set('area', area || { shape: 'box', width: 64, height: 64, depth: 64, radius: 32 }, 'Interaction area added')
            : clear('area', 'Interaction area removed'), 'Interaction area'),
        });
      }
      if (area) {
        if (visible('Area shape')) {
          shown++;
          propertyRow(dom.properties, {
            label: 'Area shape', value: area.shape,
            editor: selectEditor([['box', 'Box'], ['ball', 'Ball'], ['capsule', 'Capsule']], area.shape,
              value => setPath('area.shape', value, 'Area shape updated')),
          });
        }
        for (const [key, label] of [['width', 'Area width'], ['height', 'Area height'], ['depth', 'Area depth'], ['radius', 'Area radius']]) {
          if (!visible(label)) continue;
          shown++;
          propertyRow(dom.properties, {
            label, value: area[key] ?? 0,
            editor: numberEditor(area[key] ?? 0, { min: 1, max: 65536, step: 8,
              onChange: value => setPath(`area.${key}`, value, `Area ${label.split(' ')[1]} updated`) }),
          });
        }
      }
    });

    rows('Script', () => {
      if (!visible('Events')) return;
      shown++;
      const events = isRoot ? (current.events || []).length
        : (current.events || []).filter(event => event.ownerId === target.id).length;
      const holder = el('div', null, 'property-events');
      holder.append(el('span', `${events} attached`, 'property-events-count'));
      const open = el('button', 'Open event sheet', 'property-events-open');
      open.addEventListener('click', () => callbacks.openEvents(isRoot ? '$all' : target.id));
      holder.append(open);
      propertyRow(dom.properties, { label: 'Events', value: events, editor: holder });
    });

    if (!shown && filter) dom.properties.append(el('p', `No property matches "${state.propertyFilter}".`, 'muted scene-empty'));
  }

  /* -------------------------------------------------------------------- view */

  const view = () => ({
    zoom: state.zoom, panX: state.panX, panY: state.panY,
  });

  function sceneToScreen(point) {
    const canvas = dom.canvas;
    const { zoom, panX, panY } = view();
    return { x: canvas.clientWidth / 2 + (point.x - panX) * zoom, y: canvas.clientHeight / 2 + (point.y - panY) * zoom };
  }

  function worldToScene(point) {
    const canvas = dom.canvas;
    const { zoom, panX, panY } = view();
    return { x: (point.x - canvas.clientWidth / 2) / zoom + panX, y: (point.y - canvas.clientHeight / 2) / zoom + panY };
  }

  /* --------------------------------------------------------- 3D projection */

  // A small perspective camera: orbit angles around the scene origin, no matrices, so
  // the projection stays readable and the editor keeps no renderer alive.
  const FOV = 1.05;

  function orbitEye() {
    const distance = state.orbitDistance;
    const pitch = state.orbitPitch;
    return {
      x: Math.cos(state.orbitYaw) * Math.cos(pitch) * distance,
      y: Math.sin(state.orbitYaw) * Math.cos(pitch) * distance,
      z: Math.sin(pitch) * distance,
    };
  }

  /** Projects a scene point (x, y on the floor, z up) to the canvas. */
  function project(point) {
    const { eye, forward, right, up, scale } = cameraBasis();
    const dx = point.x - eye.x, dy = point.y - eye.y, dz = (point.z || 0) - eye.z;
    const depth = dx * forward.x + dy * forward.y + dz * forward.z;
    if (depth <= 1) return null;
    const screenX = dx * right.x + dy * right.y + dz * right.z;
    const screenY = dx * up.x + dy * up.y + dz * up.z;
    return {
      x: dom.canvas.clientWidth / 2 + (screenX / depth) * scale,
      y: dom.canvas.clientHeight / 2 - (screenY / depth) * scale,
      depth,
    };
  }

  /** The orbit camera basis, shared by the projection and by inverse picking. */
  function cameraBasis() {
    const eye = orbitEye();
    // Camera basis: forward towards the pivot at the scene origin.
    const forward = { x: -eye.x, y: -eye.y, z: -eye.z };
    const length = Math.hypot(forward.x, forward.y, forward.z) || 1;
    forward.x /= length; forward.y /= length; forward.z /= length;
    const right = { x: -forward.y, y: forward.x, z: 0 };
    const rightLength = Math.hypot(right.x, right.y) || 1;
    right.x /= rightLength; right.y /= rightLength;
    // up = forward x right, so a point above the floor projects above the floor.
    const up = {
      x: forward.y * right.z - forward.z * right.y,
      y: forward.z * right.x - forward.x * right.z,
      z: forward.x * right.y - forward.y * right.x,
    };
    return { eye, forward, right, up, scale: (dom.canvas.clientHeight / 2) / Math.tan(FOV / 2) };
  }

  /** Where a canvas pixel meets the ground plane, so 3D drops and drags have a point. */
  function groundPointAt(local) {
    const { eye, forward, right, up, scale } = cameraBasis();
    const sx = (local.x - dom.canvas.clientWidth / 2) / scale;
    const sy = -(local.y - dom.canvas.clientHeight / 2) / scale;
    const dir = {
      x: forward.x + right.x * sx + up.x * sy,
      y: forward.y + right.y * sx + up.y * sy,
      z: forward.z + right.z * sx + up.z * sy,
    };
    if (Math.abs(dir.z) < 1e-6) return null;
    const t = -eye.z / dir.z;
    if (!Number.isFinite(t) || t <= 0) return null;
    return { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: 0 };
  }

  /* --------------------------------------------------------------- artwork */

  // Sprite pictures and model previews are decoded once per asset; both views draw them,
  // which is what makes assigning an asset visibly change the node.
  const artworkImages = new Map();

  function artworkImage(src) {
    if (!src) return null;
    let record = artworkImages.get(src);
    if (!record) {
      record = { image: new Image(), ready: false };
      record.image.addEventListener('load', () => {
        record.ready = true;
        if (!dom.panel?.hidden) draw();
      });
      record.image.src = src;
      artworkImages.set(src, record);
    }
    return record.ready ? record.image : null;
  }

  function artworkOf(entity) {
    return sceneArtwork(entity, callbacks.assets?.() || []);
  }

  /** Height of a node as a 3D box, so elevation and colliders are visible. */
  function nodeHeight(entity) {
    if (entity.physics?.body && entity.physics.body !== 'none') return entity.physics.height || 32;
    if (entity.type === 'enemy') return 56;
    if (entity.type === 'light') return 0;
    return entity.height || 32;
  }

  function draw3d(ctx, width, height, current) {
    // Sky gradient and a projected floor grid, Godot's dark viewport with a grid.
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#26282e'); sky.addColorStop(1, '#1b1c20');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
    if (state.grid) {
      const span = Math.max(256, Math.ceil(Math.max(...current.entities.map(entity => Math.max(Math.abs(entity.x), Math.abs(entity.y))), 128) / GRID) * GRID);
      ctx.strokeStyle = '#33373f'; ctx.lineWidth = 1;
      for (let value = -span; value <= span; value += GRID * 2) {
        for (const [from, to] of [[{ x: value, y: -span }, { x: value, y: span }], [{ x: -span, y: value }, { x: span, y: value }]]) {
          const a = project({ ...from, z: 0 }), b = project({ ...to, z: 0 });
          if (!a || !b) continue;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    // Axis marker so the orbit direction is readable.
    for (const [axis, colour] of [[{ x: 96, y: 0, z: 0 }, '#d06a5f'], [{ x: 0, y: 96, z: 0 }, '#6aa85f'], [{ x: 0, y: 0, z: 96 }, '#5f7fd0']]) {
      const origin = project({ x: 0, y: 0, z: 0 }), end = project(axis);
      if (!origin || !end) continue;
      ctx.strokeStyle = colour; ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    }
    const selected = selectedObject();
    const boxes = [];
    for (const entity of current.entities) {
      const base = { x: entity.x, y: entity.y, z: entity.elevation || 0 };
      const top = { ...base, z: base.z + nodeHeight(entity) };
      const centre = project({ x: base.x, y: base.y, z: base.z + nodeHeight(entity) / 2 });
      const footPoint = project(base), headPoint = project(top);
      if (!centre || !footPoint || !headPoint) continue;
      boxes.push({ entity, centre, footPoint, headPoint, depth: centre.depth });
    }
    boxes.sort((a, b) => b.depth - a.depth);
    for (const box of boxes) {
      const { entity, footPoint, headPoint } = box;
      const colour = entityColors[entity.type] || '#a6a4bc';
      const selectedNow = selected?.id === entity.id;
      const focal = (dom.canvas.clientHeight / 2) / Math.tan(FOV / 2);
      const half = Math.max(3, GRID / 2 * focal / Math.max(1, box.centre.depth));
      const top = Math.min(box.headPoint.y, footPoint.y), tall = Math.max(3, Math.abs(footPoint.y - box.headPoint.y));
      // The sprite or model preview fills the box's front face, so the assigned artwork is
      // what the view shows instead of an anonymous block.
      const picture = artworkImage(artworkOf(entity)?.src);
      if (picture) ctx.drawImage(picture, box.centre.x - half, top, half * 2, tall);
      else { ctx.fillStyle = selectedNow ? '#ffffff' : colour; ctx.fillRect(box.centre.x - half, top, half * 2, tall); }
      ctx.globalAlpha = .55;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(box.centre.x - half, top, half * 2, Math.max(2, tall * .18));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selectedNow ? '#d4c28e' : '#15161a';
      ctx.lineWidth = selectedNow ? 2 : 1;
      ctx.strokeRect(box.centre.x - half, top, half * 2, tall);
      // A line down to the floor makes the elevation of a floating node obvious.
      if ((entity.elevation || 0) > 0) {
        const floorPoint = project({ x: entity.x, y: entity.y, z: 0 });
        if (floorPoint) {
          ctx.strokeStyle = 'rgba(212,194,142,.45)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(footPoint.x, footPoint.y); ctx.lineTo(floorPoint.x, floorPoint.y); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (entity.type === 'light' && entity.light) {
        ctx.fillStyle = 'rgba(255,189,114,.28)';
        ctx.beginPath(); ctx.arc(box.centre.x, box.centre.y, Math.max(6, half), 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = selectedNow ? '#ffffff' : '#b9bdc6';
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(entity.name, box.centre.x, box.headPoint.y - 4, 140);
    }
  }

  function centerView() {
    const current = scene();
    if (!current) return;
    // Frame the whole scene from outside: the orbit camera sits back from the largest
    // extent, so opening a scene never starts inside a node.
    const spread = Math.max(...current.entities.map(entity => Math.max(Math.abs(entity.x), Math.abs(entity.y))), 128);
    state.orbitDistance = Math.max(240, Math.min(4000, spread * 2.6));
    updateZoomLabel();
    const origin = sceneOrigin(current);
    state.panX = origin.x; state.panY = origin.y;
    const bounds = sceneBounds(current);
    const width = Math.max(GRID * 8, bounds.maxX - bounds.minX + GRID * 4);
    const height = Math.max(GRID * 8, bounds.maxY - bounds.minY + GRID * 4);
    const canvas = dom.canvas;
    if (canvas?.clientWidth) state.zoom = Math.min(2, Math.max(.15, Math.min(canvas.clientWidth / width, canvas.clientHeight / height)));
    updateZoomLabel();
  }

  function updateZoomLabel() {
    if (!dom.zoom) return;
    dom.zoom.textContent = state.view3d
      ? `3D ${Math.round(state.orbitDistance)}u`
      : `${Math.round(state.zoom * 100)}%`;
  }

  function draw() {
    const canvas = dom.canvas;
    if (!canvas) return;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const sceneNow = scene();
    if (state.view3d) {
      if (sceneNow) draw3d(ctx, width, height, sceneNow);
      else { ctx.fillStyle = '#1f2024'; ctx.fillRect(0, 0, width, height); }
      empty(!sceneNow?.entities.length);
      return;
    }
    // Godot's 2D view: a dot grid on a dark background, grid lines strengthening.
    ctx.fillStyle = '#1f2024';
    ctx.fillRect(0, 0, width, height);
    const { zoom } = view();
    if (state.grid) {
      const step = GRID * zoom;
      if (step > 3) {
        const offset = sceneToScreen({ x: 0, y: 0 });
        ctx.strokeStyle = '#2b2d33';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = offset.x % step; x < width; x += step) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, height); }
        for (let y = offset.y % step; y < height; y += step) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(width, Math.round(y) + .5); }
        ctx.stroke();
        ctx.strokeStyle = '#3b3f48';
        ctx.beginPath();
        const big = step * 4;
        for (let x = offset.x % big; x < width; x += big) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, height); }
        for (let y = offset.y % big; y < height; y += big) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(width, Math.round(y) + .5); }
        ctx.stroke();
      }
    }
    const current = scene();
    if (!current) {
      empty(true);
      return;
    }
    empty(!current.entities.length);
    // Scene origin marker, so absolute coordinates stay readable.
    const origin = sceneToScreen({ x: 0, y: 0 });
    ctx.strokeStyle = '#4a4f5a'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(origin.x - 8, origin.y); ctx.lineTo(origin.x + 8, origin.y);
    ctx.moveTo(origin.x, origin.y - 8); ctx.lineTo(origin.x, origin.y + 8);
    ctx.stroke();

    const bounds = sceneBounds(current);
    const min = sceneToScreen({ x: bounds.minX - GRID, y: bounds.minY - GRID });
    const max = sceneToScreen({ x: bounds.maxX + GRID, y: bounds.maxY + GRID });
    if (current.entities.length) {
      ctx.strokeStyle = '#3d4250'; ctx.setLineDash([4, 4]);
      ctx.strokeRect(min.x, min.y, max.x - min.x, max.y - min.y);
      ctx.setLineDash([]);
    }

    const size = Math.max(12, GRID * zoom * .8);
    for (const entity of current.entities) {
      const point = sceneToScreen(entity);
      const parent = entity.parentId ? current.entities.find(item => item.id === entity.parentId) : null;
      if (parent) {
        const from = sceneToScreen(parent);
        ctx.strokeStyle = 'rgba(212,194,142,.35)';
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(point.x, point.y); ctx.stroke();
      }
    }
    const selected = selectedObject();
    for (const entity of current.entities) {
      const point = sceneToScreen(entity);
      if (point.x < -size || point.y < -size || point.x > width + size || point.y > height + size) continue;
      const picture = artworkImage(artworkOf(entity)?.src);
      if (picture) {
        // A sprite or model preview drawn at its real world size in the top-down view.
        const art = artworkOf(entity);
        const drawnWidth = Math.max(6, art.width * zoom), drawnHeight = Math.max(6, art.height * zoom);
        ctx.globalAlpha = .95;
        ctx.drawImage(picture, point.x - drawnWidth / 2, point.y - drawnHeight / 2, drawnWidth, drawnHeight);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = selected?.id === entity.id ? '#ffffff' : 'rgba(20,20,20,.65)';
        ctx.lineWidth = selected?.id === entity.id ? 2 : 1;
        ctx.strokeRect(point.x - drawnWidth / 2, point.y - drawnHeight / 2, drawnWidth, drawnHeight);
      } else {
        ctx.fillStyle = `${entityColors[entity.type] || '#a6a4bc'}cc`;
        ctx.strokeStyle = selected?.id === entity.id ? '#ffffff' : '#1b1c20';
        ctx.lineWidth = selected?.id === entity.id ? 2 : 1;
        ctx.beginPath();
        if (entity.type === 'light') {
          ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
        } else {
          ctx.rect(point.x - size / 2, point.y - size / 2, size, size);
        }
        ctx.fill(); ctx.stroke();
      }
      // Facing tick, so rotation is visible without opening the inspector.
      const angle = (Number(entity.angle) || 0) * Math.PI / 180;
      ctx.strokeStyle = 'rgba(20,20,20,.9)';
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + Math.cos(angle) * size, point.y - Math.sin(angle) * size);
      ctx.stroke();
      if (zoom > .55 || selected?.id === entity.id) {
        ctx.fillStyle = selected?.id === entity.id ? '#ffffff' : '#c9ccd4';
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(entity.name, point.x, point.y - size / 2 - 4, Math.max(60, 140 * zoom));
      }
      if (entity.area) {
        const radius = Math.max(entity.area.width || 0, entity.area.radius * 2 || 0) / 2 * zoom;
        ctx.strokeStyle = 'rgba(255,193,116,.6)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(4, radius), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function empty(show) {
    if (dom.empty) dom.empty.hidden = !show;
  }

  function pickAt(event) {
    const current = scene();
    if (!current) return null;
    const rect = dom.canvas.getBoundingClientRect();
    const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (state.view3d) {
      // Nearest projected node within reach, so the closest box wins in a crowd.
      let best = null, bestDistance = 18, bestDepth = Infinity;
      for (const entity of current.entities) {
        const centre = project({ x: entity.x, y: entity.y, z: (entity.elevation || 0) + nodeHeight(entity) / 2 });
        if (!centre) continue;
        const distance = Math.hypot(centre.x - local.x, centre.y - local.y);
        const half = Math.max(8, 24);
        if (distance > half + 6) continue;
        if (distance < bestDistance || (Math.abs(distance - bestDistance) < 4 && centre.depth < bestDepth)) {
          best = entity; bestDistance = distance; bestDepth = centre.depth;
        }
      }
      return best;
    }
    const point = worldToScene(local);
    const reach = Math.max(GRID * .6, 10 / state.zoom);
    let best = null, bestDistance = reach;
    for (const entity of current.entities) {
      const distance = Math.hypot(entity.x - point.x, entity.y - point.y);
      if (distance <= bestDistance) { best = entity; bestDistance = distance; }
    }
    return best;
  }

  function localPoint(event) {
    const rect = dom.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The scene point a drop lands on: the floor plane in 3D, the grid in 2D. */
  function dropPointAt(event) {
    const local = localPoint(event);
    const point = state.view3d ? groundPointAt(local) : worldToScene(local);
    if (!point) return null;
    const snap = value => state.snap ? Math.round(value / GRID) * GRID : Math.round(value);
    return { x: snap(point.x), y: snap(point.y) };
  }

  function bindCanvas() {
    const canvas = dom.canvas;
    if (!canvas) return;
    canvas.addEventListener('pointerdown', event => {
      const current = scene();
      if (!current) return;
      canvas.focus();
      if (state.view3d) {
        // Hit a node and drag it along the ground; miss and orbit. The right button
        // dollies, and a right click that does not move opens the node menu.
        const hit = event.button === 2 ? null : pickAt(event);
        state.drag = hit
          ? { kind: 'move3d', id: hit.id, moved: false, startX: event.clientX, startY: event.clientY,
            originX: hit.x, originY: hit.y }
          : { kind: event.button === 2 ? 'dolly' : 'orbit', startX: event.clientX, startY: event.clientY,
            yaw: state.orbitYaw, pitch: state.orbitPitch, distance: state.orbitDistance, moved: false };
        canvas.setPointerCapture(event.pointerId);
        if (hit) select(hit.id);
        return;
      }
      if (event.button === 2) {
        state.drag = { kind: 'menu', startX: event.clientX, startY: event.clientY, moved: false };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button === 1 || (event.button === 0 && event.altKey)) {
        state.drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, panX: state.panX, panY: state.panY };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      const hit = pickAt(event);
      if (event.shiftKey && event.detail === 0) return;
      if (!hit) { select(current.id); return; }
      select(hit.id);
      const rect = canvas.getBoundingClientRect();
      state.drag = { kind: 'move', id: hit.id, startX: event.clientX - rect.left, startY: event.clientY - rect.top,
        originX: hit.x, originY: hit.y, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      const drag = state.drag;
      if (!drag) return;
      if (drag.kind === 'menu') {
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) drag.moved = true;
        return;
      }
      if (drag.kind === 'orbit' || drag.kind === 'dolly') {
        const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        if (drag.kind === 'orbit') {
          state.orbitYaw = drag.yaw - dx * .01;
          state.orbitPitch = Math.max(-1.45, Math.min(1.45, drag.pitch + dy * .008));
        } else state.orbitDistance = Math.max(60, Math.min(4000, drag.distance * Math.exp(dy * .006)));
        draw();
        return;
      }
      if (drag.kind === 'move3d') {
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
        drag.moved = true;
        const point = dropPointAt(event);
        if (!point) return;
        drag.nextX = point.x; drag.nextY = point.y;
        draw();
        if (!state.view3d) drawDragGhost(drag.nextX, drag.nextY);
        return;
      }
      if (drag.kind === 'pan') {
        state.panX = drag.panX - (event.clientX - drag.startX) / state.zoom;
        state.panY = drag.panY - (event.clientY - drag.startY) / state.zoom;
        draw();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const dx = (event.clientX - rect.left - drag.startX) / state.zoom;
      const dy = (event.clientY - rect.top - drag.startY) / state.zoom;
      if (!drag.moved && Math.hypot(dx, dy) * state.zoom < 3) return;
      drag.moved = true;
      const snap = value => state.snap ? Math.round(value / GRID) * GRID : Math.round(value);
      drag.nextX = snap(drag.originX + dx);
      drag.nextY = snap(drag.originY + dy);
      draw();
      drawDragGhost(drag.nextX, drag.nextY);
    });
    const finish = event => {
      const drag = state.drag;
      state.drag = null;
      if (!drag) return;
      if ((drag.kind === 'menu' || drag.kind === 'dolly') && !drag.moved) { canvasMenu(event); return; }
      if (drag.kind !== 'move' && drag.kind !== 'move3d') return;
      if (!drag.moved) return;
      const current = scene();
      const entity = current?.entities.find(item => item.id === drag.id);
      if (!entity || (entity.x === drag.nextX && entity.y === drag.nextY)) { draw(); return; }
      try {
        editScene(next => {
          const item = next.entities.find(candidate => candidate.id === drag.id);
          const dx = drag.nextX - item.x, dy = drag.nextY - item.y;
          // Moving a parent carries its group, like moving a Godot node.
          const group = [item, ...sceneSubtree(next, drag.id).slice(1)];
          for (const node of group) { node.x = Math.round(node.x + dx); node.y = Math.round(node.y + dy); }
        }, 'Node moved');
      } catch (error) { callbacks.status(error.message, true); }
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      if (state.view3d) {
        state.orbitDistance = Math.max(60, Math.min(4000, state.orbitDistance * Math.exp(event.deltaY * .0015)));
        updateZoomLabel();
        draw();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const before = worldToScene({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      state.zoom = Math.min(4, Math.max(.1, state.zoom * Math.exp(-event.deltaY * .0015)));
      const after = worldToScene({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      state.panX += before.x - after.x;
      state.panY += before.y - after.y;
      updateZoomLabel();
      draw();
    }, { passive: false });
  }

  function drawDragGhost(x, y) {
    draw();
    const canvas = dom.canvas, ctx = canvas.getContext('2d');
    const point = sceneToScreen({ x, y });
    const size = Math.max(12, GRID * state.zoom * .8);
    ctx.strokeStyle = '#d4c28e';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.setLineDash([]);
  }

  /* --------------------------------------------------------------- artwork */

  /** Visually points a node at an asset; the shared helper drops the other artwork kind. */
  function assignNodeAsset(nodeId, assetId) {
    const asset = (callbacks.assets() || []).find(candidate => candidate.id === assetId);
    if (!asset) { callbacks.status('That asset is no longer part of this project', true); return; }
    try {
      let message = 'Asset assigned';
      editScene(next => { message = setSceneObjectAsset(next, nodeId, asset); }, `Asset ${asset.name} assigned`);
      callbacks.status(message);
    } catch (error) { callbacks.status(error.message, true); }
  }

  /** Opens the asset picker for a node, anchored at the pointer or the inspector row. */
  function pickArtworkFor(nodeId, kind, anchor) {
    const assets = callbacks.assets() || [];
    openAssetPicker({
      anchor: anchor || { left: dom.canvas.getBoundingClientRect().left + 40, top: dom.canvas.getBoundingClientRect().top + 40 },
      title: kind === 'model' ? 'Choose a 3D model' : 'Choose a sprite or image',
      assets, kinds: kind === 'model' ? MODEL_KINDS : PICTURE_KINDS,
      emptyText: kind === 'model'
        ? 'No 3D models yet. Import a glTF, glb, obj or bbmodel from the Assets tab.'
        : 'No pictures yet. Import a WAD or images to get sprites.',
      onPick: asset => assignNodeAsset(nodeId, asset.id),
    });
  }

  /* -------------------------------------------------------------- dropping */

  // Assets, scene objects and layout objects are dragged into a scene with pointer
  // events, the same way the layout view takes them: a tile that contains an <img>
  // would otherwise start the browser's own image drag and lose the drop target.
  function sourceFrom(target) {
    if (!target?.closest || dom.panel?.hidden) return null;
    const tile = target.closest('#asset-list .asset-tile');
    if (tile) {
      // Buttons inside a tile are actions, not drag handles.
      if (target.closest('button, audio, input')) return null;
      if (tile.dataset.sceneId) {
        const source = (callbacks.scenes() || []).find(item => item.id === tile.dataset.sceneId);
        return source ? { kind: 'scene', id: source.id, label: `${source.name} (scene)` } : null;
      }
      const asset = (callbacks.assets() || []).find(item => item.id === tile.dataset.assetId);
      return asset ? { kind: 'asset', id: asset.id, label: `${asset.name} (${asset.kind})` } : null;
    }
    const sceneRow = target.closest('#scene-objects .scene-object-row');
    if (sceneRow?.dataset.sceneId) {
      const source = (callbacks.scenes() || []).find(item => item.id === sceneRow.dataset.sceneId);
      return source ? { kind: 'scene', id: source.id, label: `${source.name} (scene)` } : null;
    }
    const objectTile = target.closest('[data-object-id]');
    if (objectTile?.dataset.objectId) {
      const entity = (callbacks.entities?.() || []).find(item => item.id === objectTile.dataset.objectId);
      return entity ? { kind: 'object', id: entity.id, label: `${entity.name} (layout object)` } : null;
    }
    return null;
  }

  function dropTargets(event) {
    const current = scene();
    if (!current) return null;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node-row[data-node-id]');
    if (row) {
      const entity = current.entities.find(item => item.id === row.dataset.nodeId);
      if (entity) return { node: entity };
    }
    const rect = dom.canvas.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) return null;
    return { point: dropPointAt(event), hit: pickAt(event) };
  }

  function planDrop(target, source) {
    const current = scene();
    if (!current || !target) return { error: 'Drop it inside the scene view or on a node' };
    const node = target.node || target.hit || null;
    const point = target.point || { x: node?.x ?? 0, y: node?.y ?? 0 };
    if (source.kind === 'asset') {
      const asset = (callbacks.assets() || []).find(item => item.id === source.id);
      if (!asset) return { error: 'That asset is no longer part of this project' };
      const use = sceneAssetUse(asset);
      if (!use) return { error: `${asset.name} is a ${asset.kind} asset; drop a picture or a model on a node` };
      if (node) return { label: `Set ${use === 'model' ? 'model' : 'sprite'} ${asset.name} on ${node.name}`, asset, nodeId: node.id };
      return { label: `Place ${asset.name} at ${point.x}, ${point.y}`, asset, point };
    }
    if (source.kind === 'scene') {
      const other = (callbacks.scenes() || []).find(item => item.id === source.id);
      if (!other) return { error: 'That scene object no longer exists' };
      if (other.id === current.id) return { error: 'A scene cannot be placed inside itself' };
      if (!other.entities.length) return { error: `${other.name} has no objects to place` };
      return { label: node ? `Nest ${other.name} under ${node.name}` : `Nest ${other.name} at ${point.x}, ${point.y}`,
        scene: other, parentId: node?.id ?? null, point };
    }
    const entity = (callbacks.entities?.() || []).find(item => item.id === source.id);
    if (!entity) return { error: 'That layout object no longer exists' };
    if (entity.type === 'player') return { error: 'A scene cannot contain the player object' };
    return { label: node ? `Add ${entity.name} under ${node.name}` : `Add ${entity.name} at ${point.x}, ${point.y}`,
      entity, parentId: node?.id ?? null, point };
  }

  function applyDrop(plan) {
    if (plan.nodeId) { assignNodeAsset(plan.nodeId, plan.asset.id); return; }
    let created = null;
    try {
      editScene(next => {
        if (plan.asset) created = addSceneObjectFromAsset(next, plan.asset, { x: plan.point.x, y: plan.point.y });
        else if (plan.scene) created = nestScene(next, plan.scene, { x: plan.point.x, y: plan.point.y, parentId: plan.parentId }).group;
        else if (plan.entity) created = addSceneObjectFromEntity(next, plan.entity, { x: plan.point.x, y: plan.point.y, parentId: plan.parentId });
      }, plan.label);
    } catch (error) { callbacks.status(error.message, true); return; }
    if (created) select(created.id);
    callbacks.status(plan.label);
  }

  let ghost = null;
  function ghostElement() {
    if (!ghost) {
      ghost = el('div', '', 'scene-drag-ghost');
      ghost.hidden = true;
      document.body.append(ghost);
    }
    return ghost;
  }

  function showDropHint(text, isError) {
    if (!dom.hint) return;
    dom.hint.textContent = text || '';
    dom.hint.hidden = !text;
    dom.hint.classList.toggle('error', Boolean(isError));
  }

  function endDropVisuals() {
    const element = ghostElement();
    element.hidden = true;
    element.textContent = '';
    document.body.classList.remove('scene-dragging');
    showDropHint('');
    dom.canvas?.classList.remove('scene-drop-target');
  }

  /** The click that follows a drop is the drag's, not the user's. */
  function suppressNextClick() {
    const stop = event => { event.stopPropagation(); event.preventDefault(); };
    document.addEventListener('click', stop, true);
    setTimeout(() => document.removeEventListener('click', stop, true), 0);
  }

  function bindDropping() {
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0 || dom.panel?.hidden) return;
      const source = sourceFrom(event.target);
      if (!source) return;
      state.drop = { pointerId: event.pointerId, source, startX: event.clientX, startY: event.clientY, active: false };
    });
    document.addEventListener('pointermove', event => {
      const drop = state.drop;
      if (!drop || drop.pointerId !== event.pointerId) return;
      if (!drop.active) {
        if (Math.hypot(event.clientX - drop.startX, event.clientY - drop.startY) < 5) return;
        drop.active = true;
        ghostElement().hidden = false;
        document.body.classList.add('scene-dragging');
      }
      event.preventDefault();
      const element = ghostElement();
      element.textContent = drop.source.label;
      element.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`;
      const plan = planDrop(dropTargets(event), drop.source);
      showDropHint(plan.error || plan.label, Boolean(plan.error));
      dom.canvas?.classList.toggle('scene-drop-target', !plan.error);
    });
    document.addEventListener('pointerup', event => {
      const drop = state.drop;
      if (!drop || drop.pointerId !== event.pointerId) return;
      state.drop = null;
      endDropVisuals();
      if (!drop.active) return;
      suppressNextClick();
      const plan = planDrop(dropTargets(event), drop.source);
      if (plan.error) { callbacks.status(plan.error, true); return; }
      applyDrop(plan);
    });
    document.addEventListener('pointercancel', () => {
      if (!state.drop) return;
      state.drop = null;
      endDropVisuals();
    });
  }

  /* ------------------------------------------------------------------ menus */

  function closeMenu() {
    for (const button of document.querySelectorAll('.dock-menu')) button.setAttribute('aria-expanded', 'false');
    if (dom.menu) dom.menu.hidden = true;
  }

  function openMenu(anchor, items) {
    const menu = dom.menu;
    if (!menu) return;
    menu.replaceChildren();
    for (const item of items) {
      if (item.separator) { menu.append(el('div', null, 'dock-popup-separator')); continue; }
      const entry = el('button', item.label, item.disabled ? 'disabled' : undefined);
      entry.setAttribute('role', 'menuitem');
      entry.addEventListener('click', () => { closeMenu(); item.run(); });
      menu.append(entry);
    }
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    dom.menu.dataset.anchor = anchor.id;
  }

  /** The actions for one node, shared by the tree, the node menu and the view menu. */
  function nodeMenuItems(entity) {
    return [
      { label: 'Add child node', run: () => addNode(entity.id) },
      { label: 'Duplicate', run: () => { select(entity.id); runTool('duplicate'); } },
      { label: 'Rename', run: () => beginRename(entity.id, dom.tree.querySelector(`.node-row[data-node-id="${entity.id}"]`) || dom.tree) },
      { separator: true },
      { label: 'Assign sprite\u2026', run: () => pickArtworkFor(entity.id, 'sprite') },
      { label: 'Assign 3D model\u2026', run: () => pickArtworkFor(entity.id, 'model') },
      { label: 'Remove artwork', disabled: !entity.spriteAsset && !entity.modelAsset, run: () => {
        try {
          editScene(next => {
            const node = next.entities.find(item => item.id === entity.id);
            if (!node) throw new Error('That object no longer exists');
            delete node.spriteAsset; delete node.modelAsset; delete node.animation;
          }, `Artwork removed from ${entity.name}`);
        } catch (error) { callbacks.status(error.message, true); }
      } },
      { separator: true },
      { label: 'Open event sheet', run: () => callbacks.openEvents(entity.id) },
      { label: 'Move to scene root', disabled: !entity.parentId, run: () => {
        try { editScene(next => reparentSceneObject(next, entity.id, null), 'Node moved to the scene root'); }
        catch (error) { callbacks.status(error.message, true); }
      } },
      { separator: true },
      { label: 'Delete node', danger: true, run: () => { select(entity.id); runTool('delete'); } },
    ];
  }

  /** Right-clicking the view: node actions when a node is under the pointer. */
  function canvasMenu(event) {
    const current = scene();
    if (!current) return;
    const hit = pickAt(event);
    if (hit) select(hit.id);
    const point = dropPointAt(event);
    const viewItems = [
      { label: 'Add node here', disabled: !point, run: () => addNode(null, point) },
      { label: 'Add node at the view centre', run: () => addNode(null) },
      { separator: true },
      { label: state.view3d ? 'Switch to the 2D view' : 'Switch to the 3D view', run: () => {
        state.view3d = !state.view3d;
        for (const button of document.querySelectorAll('[data-scene-view]')) {
          button.classList.toggle('active', (button.dataset.sceneView === '3d') === state.view3d);
        }
        updateZoomLabel();
        draw();
      } },
      { label: 'Center the view', run: () => { centerView(); draw(); } },
      { label: 'Show the grid', checked: state.grid, run: () => {
        state.grid = !state.grid;
        document.getElementById('scene-view-grid')?.setAttribute('aria-pressed', String(state.grid));
        draw();
      } },
      { label: 'Snap to the grid', checked: state.snap, run: () => {
        state.snap = !state.snap;
        document.getElementById('scene-view-snap')?.setAttribute('aria-pressed', String(state.snap));
      } },
    ];
    if (!hit) { contextMenu(event, viewItems, { label: 'Scene view' }); return; }
    contextMenu(event, [
      ...nodeMenuItems(hit),
      { separator: true },
      ...viewItems,
    ], { label: `${hit.name} actions` });
  }

  /* ------------------------------------------------------------------- bind */

  function cacheDom() {
    dom.tabs = document.getElementById('scene-tabs');
    dom.tree = document.getElementById('scene-tree');
    dom.filter = document.getElementById('scene-filter');
    dom.filterClear = document.getElementById('scene-filter-clear');
    dom.canvas = document.getElementById('scene-canvas');
    dom.empty = document.getElementById('scene-view-empty');
    dom.properties = document.getElementById('scene-properties');
    dom.head = document.getElementById('scene-inspector-head');
    dom.inspectorFilter = document.getElementById('scene-inspector-filter');
    dom.zoom = document.getElementById('scene-view-zoom');
    dom.menu = document.getElementById('scene-menu');
    dom.dockMenu = document.getElementById('scene-dock-menu');
    dom.inspectorMenu = document.getElementById('scene-inspector-menu');
    dom.panel = document.getElementById('scene-panel');
  }

  function bind() {
    cacheDom();
    bindCanvas();
    bindDropping();
    if (dom.panel && !dom.hint) {
      // The drop hint sits over the viewport and says what the drop would do.
      dom.hint = el('div', '', 'scene-drop-hint');
      dom.hint.hidden = true;
      dom.canvas?.parentElement?.append(dom.hint);
    }
    dom.filter?.addEventListener('input', () => { state.filter = dom.filter.value.trim(); renderTree(); });
    dom.filterClear?.addEventListener('click', () => {
      state.filter = ''; if (dom.filter) dom.filter.value = ''; renderTree(); dom.filter?.focus();
    });
    dom.inspectorFilter?.addEventListener('input', () => {
      state.propertyFilter = dom.inspectorFilter.value.trim(); renderInspector();
    });
    dom.tree?.addEventListener('keydown', keyEvent => {
      const current = scene();
      if (!current) return;
      if (keyEvent.key === 'Delete' && state.selection) { keyEvent.preventDefault(); runTool('delete'); }
      else if (keyEvent.key === 'F2' && state.selection) { keyEvent.preventDefault(); runTool('rename'); }
      else if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
        // Godot walks the visible tree with the arrow keys, so this does too.
        const ids = [current.id, ...[...dom.tree.querySelectorAll('.node-row[data-node-id]')]
          .map(row => row.dataset.nodeId).filter(id => id !== current.id)];
        const index = Math.max(0, ids.indexOf(state.selection));
        const next = ids[Math.min(ids.length - 1, Math.max(0, index + (keyEvent.key === 'ArrowDown' ? 1 : -1)))];
        keyEvent.preventDefault();
        select(next);
        dom.tree.querySelector(`.node-row[data-node-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (keyEvent.key === 'ArrowRight' || keyEvent.key === 'ArrowLeft') {
        const entity = selectedObject();
        if (!entity) return;
        const hasChildren = (sceneChildren(current).get(entity.id) || []).length > 0;
        if (keyEvent.key === 'ArrowRight') {
          if (hasChildren && state.collapsed.has(entity.id)) { state.collapsed.delete(entity.id); renderTree(); }
          else { const first = sceneChildren(current).get(entity.id)?.[0]; if (first) select(first.id); }
        } else if (hasChildren && !state.collapsed.has(entity.id)) {
          state.collapsed.add(entity.id); renderTree();
        } else if (entity.parentId) select(entity.parentId);
        keyEvent.preventDefault();
      }
    });
    for (const button of document.querySelectorAll('[data-scene-tool]')) {
      button.addEventListener('click', () => runTool(button.dataset.sceneTool));
    }
    document.getElementById('scene-view-grid')?.addEventListener('click', event => {
      state.grid = !state.grid;
      event.currentTarget.setAttribute('aria-pressed', String(state.grid));
      draw();
    });
    document.getElementById('scene-view-snap')?.addEventListener('click', event => {
      state.snap = !state.snap;
      event.currentTarget.setAttribute('aria-pressed', String(state.snap));
    });
    document.getElementById('scene-view-center')?.addEventListener('click', () => { centerView(); draw(); });
    document.getElementById('scene-place')?.addEventListener('click', () => {
      if (state.sceneId) callbacks.placeScene(state.sceneId);
    });
    document.getElementById('scene-view-add')?.addEventListener('click', () => addNode(null));
    for (const button of document.querySelectorAll('[data-scene-view]')) {
      button.addEventListener('click', () => {
        for (const peer of document.querySelectorAll('[data-scene-view]')) peer.classList.toggle('active', peer === button);
        state.view3d = button.dataset.sceneView === '3d';
        state.drag = null;
        updateZoomLabel();
        draw();
      });
    }
    dom.dockMenu?.addEventListener('click', () => {
      const current = scene();
      if (!current) return;
      openMenu(dom.dockMenu, [
        { label: 'Add child node', run: () => runTool('add') },
        { label: 'Duplicate', run: () => runTool('duplicate') },
        { label: 'Rename', run: () => runTool('rename') },
        { separator: true },
        { label: 'Move up', run: () => runTool('up') },
        { label: 'Move down', run: () => runTool('down') },
        { separator: true },
        { label: 'Move to scene root', run: () => {
          if (!state.selection || state.selection === current.id) return;
          try { editScene(next => reparentSceneObject(next, state.selection, null), 'Node moved to the scene root'); }
          catch (error) { callbacks.status(error.message, true); }
        } },
        { label: 'Expand all', run: () => runTool('expand') },
        { label: 'Collapse all', run: () => runTool('collapse') },
        { separator: true },
        { label: 'Place in layout', run: () => callbacks.placeScene(current.id) },
        { label: 'Capture selected layout objects', run: () => callbacks.captureInto(current.id) },
        { label: 'Delete scene', run: () => callbacks.deleteScene(current.id) },
      ]);
    });
    dom.inspectorMenu?.addEventListener('click', () => {
      openMenu(dom.inspectorMenu, [
        { label: 'Expand all categories', run: () => { state.collapsed.clear(); renderInspector(); } },
        { label: 'Collapse all categories', run: () => {
          for (const title of CATEGORIES) state.collapsed.add(`cat:${title}`);
          renderInspector();
        } },
        { separator: true },
        { label: 'Clear property filter', run: () => {
          state.propertyFilter = ''; if (dom.inspectorFilter) dom.inspectorFilter.value = ''; renderInspector();
        } },
      ]);
    });
    document.addEventListener('pointerdown', event => {
      if (dom.menu && !dom.menu.hidden && !dom.menu.contains(event.target) && !event.target.closest('.dock-menu')) closeMenu();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  }

  bind();

  return {
    /** Show the scene with this id; null closes the editor's view. */
    open(id) {
      state.sceneId = id;
      state.selection = id;
      state.filter = '';
      if (dom.filter) dom.filter.value = '';
      renderAll();
      centerView();
      draw();
    },
    /** Closes the editor; `null` clears it whatever scene was open. */
    close(id) {
      if (id !== null && state.sceneId !== id) return;
      state.sceneId = null;
      state.selection = null;
      renderAll();
    },
    selection: () => state.selection,
    select,
    /** Re-render after any project change (undo, imported scene, rename elsewhere). */
    render() {
      renderAll();
      draw();
    },
    /** Called from the app frame loop while the panel is visible. */
    frame() {
      if (dom.panel?.hidden) return;
      draw();
    },
    center: () => { centerView(); draw(); },
  };

  function renderAll() {
    renderTabs();
    renderTree();
    renderInspector();
  }
}
