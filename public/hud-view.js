import { hudViewport, hudRect, hudText, hudBinding, bitmapGlyph } from '/shared/hud.js';

let viewId = 0;
export function createHUDView(host, project, { editor = false, select, click, error = console.error } = {}) {
  const hud = project.hud;
  host.replaceChildren();
  if (!hud) return { update() {}, dispose() {} };
  const root = document.createElement('div'); root.className = 'hud-root'; host.append(root);
  const nodes = new Map(), assets = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const fonts = new Map(), faces = [], prefix = `OpenDLE_HUD_${++viewId}_`;
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
    nodes.set(element.id, { node, visual, content, lastText: null });
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
      node.style.left = `${rect.x}px`; node.style.top = `${rect.y}px`;
      node.style.width = `${rect.width}px`; node.style.height = `${rect.height}px`;
      node.style.opacity = String(element.opacity);
      node.style.transform = `rotate(${element.rotation}deg) scale(${element.scale})`;
      node.style.transformOrigin = `${element.pivotX * 100}% ${element.pivotY * 100}%`;
      node.style.zIndex = String(element.z);
      const boundVisibility = !element.visibilityBinding || (Boolean(hudBinding(element.visibilityBinding, state)) !== Boolean(element.visibilityInverted));
      const onMenu = state.gameScreen && state.gameScreen !== 'playing';
      const menuElement = project.gameMenus?.elementIds.includes(source.id);
      const shown = (!element.parentId || visibility.get(element.parentId)) &&
        element.visible && boundVisibility && (editor || !element.statusbar || state.settings?.viewSize !== 11) && (!onMenu || menuElement) && (editor ||
        (element.display === 'always' || element.display === (cursor ? 'cursor' : 'game')));
      visibility.set(element.id, shown);
      node.hidden = !shown;
      node.classList.toggle('hud-selected', selectedId === element.id);
      node.style.pointerEvents = editor || element.interactive && cursor && state.hud ? 'auto' : 'none';
      if (!editor && element.interactive) node.tabIndex = shown && cursor && state.hud ? 0 : -1;
      visual.style.cssText = '';
      Object.assign(visual.style, { color: element.color, backgroundColor: element.background, fontSize: `${element.fontSize}px`,
        textAlign: element.align, alignItems: element.type === 'bar' ? 'stretch' : 'center',
        imageRendering: hud.pixelated ? 'pixelated' : 'auto',
        fontFamily: fonts.has(element.fontId) ? `"${fonts.get(element.fontId)}"` : 'monospace' });
      const style = hud.styles?.find(style => style.name === element.styleClass);
      for (const [key, value] of Object.entries(style?.properties || {})) visual.style.setProperty(key, value);
      const asset = assets.get(element.assetId);
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
        Object.assign(content.style, {
          position: 'absolute', width: `${vertical ? 100 : amount * 100}%`, height: `${vertical ? amount * 100 : 100}%`,
          left: direction === 'left' ? 'auto' : '0', right: direction === 'left' ? '0' : 'auto',
          top: direction === 'up' ? 'auto' : '0', bottom: direction === 'up' ? '0' : 'auto',
          backgroundColor: fillAsset ? 'transparent' : element.color,
          backgroundImage: fillAsset ? `url("${fillAsset.src}")` : 'none',
          backgroundSize: `${rect.width}px ${rect.height}px`, backgroundRepeat: 'no-repeat',
          backgroundPosition: `${direction === 'left' ? 'right' : 'left'} ${direction === 'up' ? 'bottom' : 'top'}`,
        });
      } else {
        const text = hudText(element, state), font = hud.fonts.find(font => font.id === element.fontId);
        const cache = `${text}\0${element.fontId}\0${element.fontSize}`;
        if (cache !== nodes.get(source.id).lastText) {
          nodes.get(source.id).lastText = cache;
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
      node.setAttribute('aria-label', element.interactive && !menuElement ? hudText(element, state) || element.name : element.name);
    }
    if (!editor && state.gameScreen !== 'playing') {
      const candidates = [...nodes].filter(([id, entry]) => entry.node.tabIndex === 0 &&
        entry.node.dataset.menuSelectable !== 'false' && !entry.node.hidden &&
        project.hud.elements.find(element => element.id === id)?.interactive);
      if (!candidates.some(([id]) => id === state.hudState.focused)) state.hudState.focused = candidates[0]?.[0] || null;
    }
    root.classList.toggle('hud-native-selector', !editor && hud.elements.some(element =>
      element.menuSelector && !nodes.get(element.id).node.hidden));
    return { ...viewport, rectangles };
  }
  return { update, nodes, dispose() {
    disposed = true; for (const face of faces) document.fonts.delete(face); host.replaceChildren();
  } };
}
