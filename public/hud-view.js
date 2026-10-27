import { hudViewport, hudRect, hudText, hudBinding, bitmapGlyph } from '/shared/hud.js';

let viewId = 0;
export function createHUDView(host, project, { editor = false, select, click, error = console.error } = {}) {
  const hud = project.hud;
  host.replaceChildren();
  if (!hud) return { update() {}, dispose() {} };
  const root = document.createElement('div'); root.className = 'hud-root'; host.append(root);
  const nodes = new Map(), assets = new Map((project.assets || []).map(asset => [asset.id, asset]));
  // Authored visual properties, rendered to one string per element object. Elements are
  // replaced wholesale by an edit, so this cache cannot go stale.
  const visualKeys = new WeakMap();
  function visualKeyOf(element, hud) {
    let key = visualKeys.get(element);
    if (key !== undefined) return key;
    // `fontSize` and `frame` are writable at runtime (HUD_PROPERTIES), so they are
    // appended from the live element below instead of being cached here.
    key = `${element.color}|${element.background}|${element.align}|${element.type}|${hud.pixelated}` +
      `|${element.fontId}|${element.styleClass}|${element.assetId}|${element.fillAssetId}|${element.imageRepeat}` +
      `|${element.slice ? JSON.stringify(element.slice) : ''}|${element.sprite ? JSON.stringify(element.sprite) : ''}` +
      `|${element.fillDirection}`;
    visualKeys.set(element, key);
    return key;
  }
  const fonts = new Map(), faces = [], prefix = `OpenDLE_HUD_${++viewId}_`;
  // Per-frame lookups must not scan arrays: these are constant for the view.
  const menuIds = new Set(project.gameMenus?.elementIds || []);
  const styleByName = new Map((hud.styles || []).map(style => [style.name, style]));
  const fontById = new Map(hud.fonts.map(font => [font.id, font]));
  // Which HUD elements can take focus. Asking the element list per node per frame made
  // menu navigation quadratic in the element count (an imported menu has dozens).
  const interactiveIds = new Set((hud.elements || []).filter(element => element.interactive).map(element => element.id));
  let entryNativeSelector = null;
  let anySelectorVisible = false;
  let disposed = false;
  let currentState;
  for (const style of hud.styles || []) for (const [property, value] of Object.entries(style.properties)) {
    if (!CSS.supports(property, value)) error(`HUD CSS class "${style.name}": unsupported ${property}: ${value}`);
  }
  for (const font of hud.fonts) {
    if (font.type !== 'web') continue;
    const family = prefix + font.id;
    const face = new FontFace(family, `url("${assets.get(font.assetId).src}")`);
    fonts.set(font.id, family); faces.push(face);
    face.load().then(loaded => { if (!disposed) document.fonts.add(loaded); })
      .catch(failure => { if (!disposed) error(`HUD font "${font.name}" could not load: ${failure.message}`); });
  }
  for (const element of hud.elements) {
    const node = document.createElement('div'), visual = document.createElement('div'), content = document.createElement('div');
    node.className = 'hud-element'; node.dataset.hudId = element.id;
    visual.className = 'hud-visual'; content.className = 'hud-content';
    node.append(visual); visual.append(content);
    (element.parentId ? nodes.get(element.parentId).node : root).append(node);
    nodes.set(element.id, { node, visual, content, lastText: null,
      layout: '', visualKey: '', contentKey: '', hidden: null, selected: null, pointer: null, tab: null, label: null });
    if (editor) node.addEventListener('pointerdown', event => {
      event.stopPropagation(); select?.(element.id, event);
    });
    else if (element.interactive) {
      node.setAttribute('role', 'button'); node.tabIndex = -1;
      node.dataset.menuSelectable = String(element.menuSelectable !== false);
      const focus = () => { if (currentState && element.menuSelectable !== false) currentState.hudState.focused = element.id; };
      node.addEventListener('focus', focus); node.addEventListener('pointerenter', focus);
      node.addEventListener('pointermove', focus);
      node.addEventListener('click', event => { event.stopPropagation(); focus(); click?.(element.id); });
      node.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); click?.(element.id); }
      });
    }
  }
  function update(state, { selectedId, cursor = state.hudState.cursor } = {}) {
    currentState = state;
    anySelectorVisible = false;
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    const viewport = hudViewport(hud, width, height);
    root.style.width = `${viewport.width}px`; root.style.height = `${viewport.height}px`;
    root.style.transform = `scale(${viewport.sx},${viewport.sy})`;
    host.hidden = !editor && !state.hud;
    const rectangles = new Map(), visibility = new Map();
    for (const source of hud.elements) {
      const element = state.hudState.elements.get(source.id), { node, visual, content } = nodes.get(source.id);
      const parent = rectangles.get(element.parentId) || viewport;
      const rect = hudRect(element, parent.width, parent.height); rectangles.set(element.id, rect);
      const entry = nodes.get(source.id);
      // Compare the layout values directly: an imported HUD has hundreds of elements
      // and building a template string for each of them on every frame was pure
      // garbage, while the values themselves usually have not changed.
      if (entry.x !== rect.x || entry.y !== rect.y || entry.width !== rect.width || entry.height !== rect.height ||
        entry.opacity !== element.opacity || entry.rotation !== element.rotation || entry.scale !== element.scale ||
        entry.pivotX !== element.pivotX || entry.pivotY !== element.pivotY || entry.z !== element.z) {
        entry.x = rect.x; entry.y = rect.y; entry.width = rect.width; entry.height = rect.height;
        entry.opacity = element.opacity; entry.rotation = element.rotation; entry.scale = element.scale;
        entry.pivotX = element.pivotX; entry.pivotY = element.pivotY; entry.z = element.z;
        node.style.left = `${rect.x}px`; node.style.top = `${rect.y}px`;
        node.style.width = `${rect.width}px`; node.style.height = `${rect.height}px`;
        node.style.opacity = String(element.opacity);
        node.style.transform = `rotate(${element.rotation}deg) scale(${element.scale})`;
        node.style.transformOrigin = `${element.pivotX * 100}% ${element.pivotY * 100}%`;
        node.style.zIndex = String(element.z);
      }
      const boundVisibility = !element.visibilityBinding || (Boolean(hudBinding(element.visibilityBinding, state)) !== Boolean(element.visibilityInverted));
      const onMenu = state.gameScreen && state.gameScreen !== 'playing';
      const menuElement = menuIds.has(source.id);
      const shown = (!element.parentId || visibility.get(element.parentId)) &&
        element.visible && boundVisibility && (editor || !element.statusbar || state.settings?.viewSize !== 11) && (!onMenu || menuElement) && (editor ||
        (element.display === 'always' || element.display === (cursor ? 'cursor' : 'game')));
      visibility.set(element.id, shown);
      if (entry.hidden !== shown) { entry.hidden = shown; node.hidden = !shown; }
      const selected = selectedId === element.id;
      if (entry.selected !== selected) { entry.selected = selected; node.classList.toggle('hud-selected', selected); }
      const pointer = editor || element.interactive && cursor && state.hud ? 'auto' : 'none';
      if (entry.pointer !== pointer) { entry.pointer = pointer; node.style.pointerEvents = pointer; }
      const tab = !editor && element.interactive ? shown && cursor && state.hud ? 0 : -1 : null;
      if (tab !== null && entry.tab !== tab) { entry.tab = tab; node.tabIndex = tab; }
      if (element.menuSelector && shown) anySelectorVisible = true;
      // Static visual styling only changes when the authored element changes.
      const style = styleByName.get(element.styleClass);
      // The visual key covers authored data plus the animated frame; the authored part
      // is computed once per element object (an edit clones them) instead of being
      // rebuilt, JSON included, several hundred times per frame.
      const visualKey = `${visualKeyOf(source, hud)}\u0000${element.fontSize}\u0000${element.frame === undefined ? '' : Math.floor(element.frame)}`;
      const asset = assets.get(element.assetId);
      if (visualKey !== entry.visualKey) {
        entry.visualKey = visualKey;
        visual.style.cssText = '';
        Object.assign(visual.style, { color: element.color, backgroundColor: element.background, fontSize: `${element.fontSize}px`,
          textAlign: element.align, alignItems: element.type === 'bar' ? 'stretch' : 'center',
          imageRendering: hud.pixelated ? 'pixelated' : 'auto',
          fontFamily: fonts.has(element.fontId) ? `"${fonts.get(element.fontId)}"` : 'monospace' });
        for (const [key, value] of Object.entries(style?.properties || {})) visual.style.setProperty(key, value);
      }
      if (asset) {
        if (element.slice) {
          const { top, right, bottom, left } = element.slice;
          Object.assign(visual.style, { borderStyle: 'solid', borderWidth: `${top}px ${right}px ${bottom}px ${left}px`,
            borderImageSource: `url("${asset.src}")`, borderImageSlice: `${top} ${right} ${bottom} ${left} fill`, borderImageRepeat: 'stretch' });
        } else {
          visual.style.backgroundImage = `url("${asset.src}")`;
          if (element.imageRepeat) {
            visual.style.backgroundRepeat = element.imageRepeat;
            visual.style.backgroundSize = `${asset.width}px ${asset.height}px`;
          }
          if (element.sprite) {
            const { columns, rows } = element.sprite, frame = Math.floor(element.frame);
            visual.style.backgroundSize = `${columns * 100}% ${rows * 100}%`;
            visual.style.backgroundPosition = `${columns > 1 ? frame % columns / (columns - 1) * 100 : 0}% ${rows > 1 ? Math.floor(frame / columns) / (rows - 1) * 100 : 0}%`;
          }
        }
      }
      if (element.type === 'bar') {
        const value = element.binding ? Number(hudBinding(element.binding, state)) : element.value;
        const fillAsset = assets.get(element.fillAssetId);
        const amount = Math.max(0, Math.min(1, value / element.maximum));
        const direction = element.fillDirection || 'right', vertical = ['up', 'down'].includes(direction);
        const contentKey = `${amount}|${direction}|${rect.width}|${rect.height}|${fillAsset ? fillAsset.id : element.color}`;
        if (contentKey !== entry.contentKey) {
        entry.contentKey = contentKey;
        Object.assign(content.style, {
          position: 'absolute', width: `${vertical ? 100 : amount * 100}%`, height: `${vertical ? amount * 100 : 100}%`,
          left: direction === 'left' ? 'auto' : '0', right: direction === 'left' ? '0' : 'auto',
          top: direction === 'up' ? 'auto' : '0', bottom: direction === 'up' ? '0' : 'auto',
          backgroundColor: fillAsset ? 'transparent' : element.color,
          backgroundImage: fillAsset ? `url("${fillAsset.src}")` : 'none',
          backgroundSize: `${rect.width}px ${rect.height}px`, backgroundRepeat: 'no-repeat',
          backgroundPosition: `${direction === 'left' ? 'right' : 'left'} ${direction === 'up' ? 'bottom' : 'top'}`,
        });
        }
      } else {
        const text = hudText(element, state), font = fontById.get(element.fontId);
        const cache = `${text}\0${element.fontId}\0${element.fontSize}`;
        entry.text = text;
        if (cache !== entry.lastText) {
          entry.lastText = cache;
          content.replaceChildren();
          if (font?.type === 'bitmap') {
            content.style.lineHeight = '0';
            const atlas = assets.get(font.assetId), scale = element.fontSize / font.cellHeight;
            for (const char of [...text]) {
              if (char === '\n') { content.append(document.createElement('br')); continue; }
              const { index, advance } = bitmapGlyph(font, char);
              const glyph = document.createElement('span'); glyph.className = 'hud-glyph';
              glyph.setAttribute('aria-hidden', 'true');
              Object.assign(glyph.style, { position: 'relative', width: `${advance * scale}px`, height: `${element.fontSize}px` });
              if (index >= 0) {
                const ink = document.createElement('span');
                Object.assign(ink.style, { position: 'absolute', left: '0', top: '0',
                  width: `${font.cellWidth * scale}px`, height: `${element.fontSize}px`,
                  backgroundImage: `url("${atlas.src}")`, backgroundRepeat: 'no-repeat',
                  backgroundSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
                  backgroundPosition: `${-(index % font.columns) * font.cellWidth * scale}px ${-Math.floor(index / font.columns) * font.cellHeight * scale}px` });
                glyph.append(ink);
              }
              content.append(glyph);
            }
            content.setAttribute('aria-label', text);
          } else { content.style.lineHeight = ''; content.textContent = text; content.removeAttribute('aria-label'); }
        }
      }
      // The visible text was computed above for text elements, so an interactive menu
      // row is not evaluated twice every frame.
      const label = element.interactive && !menuElement
        ? ((entry.text ?? (element.type === 'bar' ? hudText(element, state) : '')) || element.name) : element.name;
      if (entry.label !== label) { entry.label = label; node.setAttribute('aria-label', label); }
    }
    if (!editor && state.gameScreen !== 'playing') {
      // Keyboard focus order over the menu rows, without rebuilding a candidate array
      // for every element on every frame.
      let focused = false, first = null;
      for (const [id, entry] of nodes) {
        if (entry.node.tabIndex !== 0 || entry.node.dataset.menuSelectable === 'false' ||
          entry.node.hidden || !interactiveIds.has(id)) continue;
        first ??= id;
        if (id === state.hudState.focused) { focused = true; break; }
      }
      if (!focused) state.hudState.focused = first;
    }
    const nativeSelector = !editor && anySelectorVisible;
    if (entryNativeSelector !== nativeSelector) {
      entryNativeSelector = nativeSelector;
      root.classList.toggle('hud-native-selector', nativeSelector);
    }
    return { ...viewport, rectangles };
  }
  return { update, nodes, dispose() {
    disposed = true; for (const face of faces) document.fonts.delete(face); host.replaceChildren();
  } };
}
