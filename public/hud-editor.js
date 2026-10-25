import { hudElement, hudViewport, createHUDState, advanceHUD, playHUDAnimation, HUD_PROPERTIES, installDefaultHUD } from '/shared/hud.js';
import { parseHUDCSS } from '/shared/hud-style.js';
import { newId } from '/shared/project.js';
import { HUD_PLAYER_BINDINGS } from '/shared/player-state.js';
import { GAME_HUD_BINDINGS } from '/shared/game-settings.js';
import { createRuntime, stepRuntime } from '/shared/runtime.js';
import { attachMenuElement } from '/shared/game-menu.js';
import { createHUDView } from './hud-view.js';

const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  if (className) result.className = className;
  return result;
};
export function createHUDEditor(host, { project: getProject, edit, script, error }) {
  let selectedId, clipId, view, state, current, stage, properties, animationPanel, drag, animationFrame;
  let previewAspect = '16 / 9';
  let previewScreen = 'playing';
  const safe = fn => (...args) => {
    try {
      const result = fn(...args);
      if (result?.catch) result.catch(failure => error(failure.message));
    } catch (failure) { error(failure.message); }
  };
  const button = (label, fn) => {
    const result = node('button', label); result.type = 'button'; result.addEventListener('click', safe(fn)); return result;
  };
  const field = (host, label, value, change, options) => {
    const wrapper = node('label', label), input = node(options ? 'select' : 'input');
    input.setAttribute('aria-label', label);
    if (options) for (const option of options) {
      const [id, name] = Array.isArray(option) ? option : [option, option];
      const item = node('option', name); item.value = id; input.append(item);
    }
    else { input.type = typeof value === 'number' ? 'number' : 'text'; input.step = 'any'; }
    input.value = value ?? '';
    input.addEventListener('change', safe(() => change(typeof value === 'number' ? input.valueAsNumber : input.value)));
    wrapper.append(input); host.append(wrapper); return input;
  };
  const check = (host, label, value, change) => {
    const wrapper = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = value;
    input.addEventListener('change', safe(() => change(input.checked))); wrapper.append(input, document.createTextNode(label)); host.append(wrapper);
  };
  const update = (fn, message = 'HUD updated') => edit(next => fn(next.hud, next), message);
  const selected = () => getProject().hud.elements.find(element => element.id === selectedId);
  const updateElement = (key, value) => update(hud => { hud.elements.find(element => element.id === selectedId)[key] = value; });
  const imageOptions = () => (getProject().assets || []).filter(asset => !['model', 'font', 'sound'].includes(asset.kind)).map(asset => [asset.id, asset.name]);
  function render() {
    cancelAnimationFrame(animationFrame); view?.dispose(); drag = null;
    current = getProject(); host.replaceChildren();
    const toolbar = node('div', null, 'hud-toolbar');
    host.append(toolbar);
    if (!current.hud) {
      toolbar.append(button('Install editable game HUD', () => edit(installDefaultHUD, 'HUD and visual feedback scripts installed')));
      host.append(node('p', 'No HUD is installed. Existing projects are not changed automatically. Install the original FPS overlay, then customize every element.', 'info'));
      return;
    }
    state = createRuntime(current, { screen: previewScreen });
    Object.assign(state, { message: 'HUD message preview', messageTime: 5, hud: true });
    stepRuntime({ ...current, events: current.events.filter(event => current.eventSheets.find(sheet => sheet.id === event.sheetId)?.phase === 'interface') },
      state, 0, new Set());
    for (const type of ['text', 'panel', 'image', 'bar', 'button']) toolbar.append(button(`+ ${type}`, () => update((hud, next) => {
      const element = hudElement(newId('hud'), type); hud.elements.push(element); selectedId = element.id;
      if (previewScreen !== 'playing') attachMenuElement(next, element, previewScreen);
    })));
    toolbar.append(button('Import Canva / image', () => importImage()), button('Import web font', () => importWebFont()),
      button('+ Bitmap font', addBitmapFont), button('Import .css', importCSS), button('Edit CSS', editCSS), button('HUD scripts', () => script()));
    const layout = node('div', null, 'hud-layout'), list = node('div', null, 'hud-elements');
    const workspace = node('div', null, 'hud-workspace');
    properties = node('div', null, 'hud-properties');
    const settings = node('div', null, 'hud-settings');
    for (const key of ['width', 'height']) field(settings, `Design ${key}`, current.hud[key], value => update(hud => { hud[key] = value; }));
    field(settings, 'Scaling', current.hud.scaleMode, value => update(hud => { hud.scaleMode = value; }),
      [['fit', 'Fit / responsive anchors'], ['stretch', 'Stretch X/Y'], ['integer', 'Integer / pixel art']]);
    field(settings, 'Reserve view bottom', current.hud.reserveBottom || 0, value => update(hud => { hud.reserveBottom = value; }));
    check(settings, 'Pixelated images', Boolean(current.hud.pixelated), value => update(hud => { hud.pixelated = value; }));
    field(settings, 'Preview aspect', previewAspect, value => { previewAspect = value; sizeStage(); view.update(state, { selectedId }); },
      ['16 / 9', '4 / 3', '9 / 16', '21 / 9']);
    if (current.gameMenus) field(settings, 'Game / menu screen', previewScreen, value => {
      previewScreen = value; selectedId = null; render();
    }, ['playing', ...current.gameMenus.screens]);
    stage = node('div', null, 'hud-designer'); stage.setAttribute('aria-label', 'WYSIWYG HUD canvas');
    sizeStage();
    workspace.append(settings, stage, node('p', 'Drag to move; drag the cyan corner to resize. Coordinates use anchors and pivot. Tab switches game/cursor mode in Play.', 'muted'));
    list.append(node('h3', 'HUD elements'));
    for (const element of current.hud.elements.filter(element => previewScreen === 'playing'
      ? !current.gameMenus?.elementIds.includes(element.id) : state.hudState.elements.get(element.id).visible)) {
      const item = button(`${element.parentId ? '  ' : ''}${element.name}${element.visible ? '' : ' (hidden)'}`, () => { selectedId = element.id; render(); });
      item.classList.toggle('selected', selectedId === element.id); list.append(item);
    }
    function sizeStage() {
      const [width, height] = previewAspect.split('/').map(Number);
      stage.style.aspectRatio = previewAspect;
      stage.style.maxWidth = `calc(52vh * ${width / height})`;
    }
    list.append(node('p', 'Canva PNG/JPG exports become image elements, not editable Canva layers. Export with transparency for overlays.', 'muted'));
    layout.append(list, workspace, properties); host.append(layout);
    view = createHUDView(stage, current, { editor: true, select: safe(beginMove), error });
    view.update(state, { selectedId });
    for (const [id, { node: element }] of view.nodes) if (id === selectedId) {
      const handle = node('span', null, 'hud-resize'); handle.setAttribute('aria-label', 'Resize HUD element');
      handle.addEventListener('pointerdown', event => { event.stopPropagation(); startDrag(id, event, true); }); element.append(handle);
    }
    renderProperties();
    animationPanel = node('div', null, 'hud-animation-panel'); host.append(animationPanel); renderAnimations();
    const fontPanel = node('details', null, 'hud-font-panel'); fontPanel.append(node('summary', `Fonts (${current.hud.fonts.length})`));
    for (const font of current.hud.fonts) {
      fontPanel.append(button(`Edit ${font.name} (${font.type})`, () => editFont(font)),
        button(`Delete ${font.name}`, () => update(hud => { hud.fonts = hud.fonts.filter(item => item.id !== font.id); })));
    }
    host.append(fontPanel);
  }
  function beginMove(id, event) {
    if (selectedId !== id) { selectedId = id; renderProperties(); view.update(state, { selectedId }); }
    startDrag(id, event, false);
  }
  function startDrag(id, event, resize) {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = current.hud.elements.find(element => element.id === id);
    // Parent transforms alter pointer coordinates; property editing remains exact for transformed hierarchies.
    let ancestor = element;
    while (ancestor) {
      if (ancestor.rotation !== 0 || ancestor.scale !== 1) throw new Error('Reset element/parent rotation and scale before dragging; use Properties for transformed elements.');
      ancestor = current.hud.elements.find(item => item.id === ancestor.parentId);
    }
    const viewport = hudViewport(current.hud, stage.clientWidth, stage.clientHeight);
    drag = { id, x: event.clientX, y: event.clientY, element: structuredClone(element), resize, sx: viewport.sx, sy: viewport.sy, pointerId: event.pointerId };
    stage.setPointerCapture(event.pointerId);
  }
  host.addEventListener('pointermove', safe(event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const element = state.hudState.elements.get(drag.id), dx = (event.clientX - drag.x) / drag.sx, dy = (event.clientY - drag.y) / drag.sy;
    if (drag.resize) {
      element.width = Math.max(element.anchors.left === element.anchors.right ? 1 : -16384, drag.element.width + dx);
      element.height = Math.max(element.anchors.top === element.anchors.bottom ? 1 : -16384, drag.element.height + dy);
    }
    else { element.x = Math.round(drag.element.x + dx); element.y = Math.round(drag.element.y + dy); }
    view.update(state, { selectedId });
  }));
  host.addEventListener('pointerup', safe(event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = drag, element = structuredClone(state.hudState.elements.get(drag.id)); drag = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (JSON.stringify(element) === JSON.stringify(finished.element)) { render(); return; }
    try { update(hud => Object.assign(hud.elements.find(item => item.id === finished.id), element), finished.resize ? 'HUD element resized' : 'HUD element moved'); }
    catch (failure) { render(); throw failure; }
  }));
  host.addEventListener('pointercancel', () => { if (drag) { drag = null; render(); } });
  function renderProperties() {
    properties.replaceChildren();
    const element = selected();
    if (!element) { properties.append(node('p', 'Select a HUD element to edit its properties.', 'muted')); return; }
    properties.append(node('h3', element.name), node('small', element.id));
    for (const key of ['name', 'text', 'x', 'y', 'width', 'height', 'pivotX', 'pivotY', 'z', 'opacity', 'scale', 'rotation', 'fontSize', 'color', 'background']) {
      field(properties, key, element[key], value => updateElement(key, value));
    }
    field(properties, 'Parent', element.parentId || '', value => update(hud => {
      const item = hud.elements.find(item => item.id === element.id);
      if (value) item.parentId = value; else delete item.parentId;
    }), [['', 'Screen'], ...current.hud.elements.slice(0, current.hud.elements.indexOf(element)).map(item => [item.id, item.name])]);
    field(properties, 'Anchor preset', '', value => {
      const [left, top, right, bottom] = value.split(',').map(Number);
      updateElement('anchors', { left, top, right, bottom });
    }, [['', 'Custom'], ...[[0, 0], [.5, 0], [1, 0], [0, .5], [.5, .5], [1, .5], [0, 1], [.5, 1], [1, 1]]
      .map(([x, y]) => [`${x},${y},${x},${y}`, `${['Left', 'Center', 'Right'][x * 2]} / ${['Top', 'Middle', 'Bottom'][y * 2]}`]), ['0,0,1,1', 'Stretch all'], ['0,1,1,1', 'Stretch bottom']]);
    for (const key of ['left', 'top', 'right', 'bottom']) field(properties, `Anchor ${key}`, element.anchors[key],
      value => update(hud => { hud.elements.find(item => item.id === element.id).anchors[key] = value; }));
    field(properties, 'Display mode', element.display, value => updateElement('display', value), ['always', 'game', 'cursor']);
    check(properties, 'Visible', element.visible, value => updateElement('visible', value));
    check(properties, 'Clickable (cursor mode)', element.interactive, value => updateElement('interactive', value));
    field(properties, 'Text alignment', element.align, value => updateElement('align', value), ['left', 'center', 'right']);
    field(properties, 'Binding', element.binding, value => updateElement('binding', value),
      ['', ...HUD_PLAYER_BINDINGS, ...GAME_HUD_BINDINGS, 'message', ...Object.keys(current.variables).map(key => `var:${key}`)]);
    field(properties, 'Visibility binding', element.visibilityBinding || '', value => updateElement('visibilityBinding', value),
      ['', ...HUD_PLAYER_BINDINGS, ...GAME_HUD_BINDINGS, ...Object.keys(current.variables).map(key => `var:${key}`)]);
    check(properties, 'Invert visibility binding', Boolean(element.visibilityInverted), value => updateElement('visibilityInverted', value));
    field(properties, 'Maximum text characters (0 = unlimited)', element.maxLength || 0, value => update(hud => {
      const item = hud.elements.find(item => item.id === element.id);
      if (value) item.maxLength = value; else delete item.maxLength;
    }));
    for (const key of ['value', 'maximum']) field(properties, key, element[key], value => updateElement(key, value));
    field(properties, 'Font', element.fontId || '', value => updateElement('fontId', value), [['', 'Built-in monospace'], ...current.hud.fonts.map(font => [font.id, font.name])]);
    field(properties, 'CSS class', element.styleClass || '', value => updateElement('styleClass', value),
      [['', 'None'], ...(current.hud.styles || []).map(style => style.name)]);
    field(properties, 'Image / atlas', element.assetId || '', value => update(hud => {
      const item = hud.elements.find(item => item.id === element.id);
      if (value) item.assetId = value; else delete item.assetId;
      delete item.slice; delete item.sprite;
    }), [['', 'None'], ...imageOptions()]);
    if (element.assetId) {
      check(properties, 'Nine-patch', Boolean(element.slice), value => update(hud => {
        const item = hud.elements.find(item => item.id === element.id);
        if (value) { item.slice = { left: 0, top: 0, right: 0, bottom: 0 }; delete item.sprite; } else delete item.slice;
      }));
      if (element.slice) for (const key of ['left', 'top', 'right', 'bottom']) field(properties, `Slice ${key} (source px)`, element.slice[key],
        value => update(hud => { hud.elements.find(item => item.id === element.id).slice[key] = value; }));
      check(properties, 'Sprite frames', Boolean(element.sprite), value => update(hud => {
        const item = hud.elements.find(item => item.id === element.id);
        if (value) { item.sprite = { columns: 1, rows: 1 }; item.frame = 0; delete item.slice; } else delete item.sprite;
      }));
      if (element.sprite) {
        for (const key of ['columns', 'rows']) field(properties, `Sprite ${key}`, element.sprite[key],
          value => update(hud => { hud.elements.find(item => item.id === element.id).sprite[key] = value; }));
        field(properties, 'frame', element.frame, value => updateElement('frame', value));
      }
    }
    properties.append(button('Open / attach visual script', () => script(element.id)), button('Duplicate', () => update((hud, next) => {
      const copy = structuredClone(element); copy.id = newId('hud'); copy.name += ' copy'; copy.x += 12; copy.y += 12;
      hud.elements.push(copy); selectedId = copy.id;
      if (previewScreen !== 'playing') attachMenuElement(next, copy, previewScreen);
    })), button('Delete element and children', () => update((hud, next) => {
      const ids = new Set([element.id]);
      for (const item of hud.elements) if (ids.has(item.parentId)) ids.add(item.id);
      hud.elements = hud.elements.filter(item => !ids.has(item.id));
      if (next.gameMenus?.elementIds.some(id => ids.has(id))) {
        next.gameMenus.elementIds = next.gameMenus.elementIds.filter(id => !ids.has(id));
        next.events = next.events.filter(event => !ids.has(event.condition.elementId) && !event.actions.some(action => ids.has(action.elementId)));
      }
    })));
    properties.append(node('p', 'Text supports {health}, {armor}, {bullets}, {message}, {var:score}. Delete referenced animation tracks/events before deleting their target.', 'muted'));
  }
  function renderAnimations() {
    animationPanel.replaceChildren();
    const hud = current.hud;
    animationPanel.append(node('h3', 'Animation timeline'), button('+ Animation', () => update(hud => {
      const clip = { id: newId('hud_clip'), name: 'New animation', duration: 1, loop: false, autoPlay: false, tracks: [] };
      hud.animations.push(clip); clipId = clip.id;
    })));
    field(animationPanel, 'Animation', clipId || '', value => { clipId = value; renderAnimations(); },
      [['', 'Select animation'], ...hud.animations.map(clip => [clip.id, clip.name])]);
    const clip = hud.animations.find(clip => clip.id === clipId);
    if (!clip) return;
    const change = fn => update(hud => fn(hud.animations.find(item => item.id === clip.id)));
    field(animationPanel, 'Clip name', clip.name, value => change(clip => { clip.name = value; }));
    field(animationPanel, 'Duration (seconds)', clip.duration, value => change(clip => {
      for (const track of clip.tracks) for (const key of track.keys) key.time *= value / clip.duration;
      clip.duration = value;
    }));
    check(animationPanel, 'Loop', clip.loop, value => change(clip => { clip.loop = value; }));
    check(animationPanel, 'Autoplay', clip.autoPlay, value => change(clip => { clip.autoPlay = value; }));
    animationPanel.append(button('Preview animation', () => {
      cancelAnimationFrame(animationFrame); state.hudState = createHUDState(current); state.hudState.playing.clear();
      playHUDAnimation(current, state.hudState, clip.id);
      let previous = performance.now();
      const frame = now => {
        advanceHUD(current, state.hudState, Math.min(.1, (now - previous) / 1000)); previous = now;
        view.update(state, { selectedId });
        if (state.hudState.playing.size) animationFrame = requestAnimationFrame(frame);
      };
      animationFrame = requestAnimationFrame(frame);
    }), button('Reset preview', () => { cancelAnimationFrame(animationFrame); state.hudState = createHUDState(current); view.update(state, { selectedId }); }),
    button('+ Track for selected element', () => {
      const element = selected();
      if (!element) throw new Error('Select a HUD element first');
      change(clip => {
        const property = ['opacity', ...HUD_PROPERTIES.filter(property => property !== 'opacity')]
          .find(property => !clip.tracks.some(track => track.elementId === element.id && track.property === property));
        if (!property) throw new Error('All properties of this element already have tracks');
        clip.tracks.push({ elementId: element.id, property, easing: 'linear',
          keys: [{ time: 0, value: property === 'opacity' ? 0 : element[property] },
            { time: clip.duration, value: property === 'opacity' ? 1 : element[property] }] });
      });
    }), button('Delete animation', () => update(hud => { hud.animations = hud.animations.filter(item => item.id !== clip.id); })));
    clip.tracks.forEach((track, index) => {
      const row = node('div', null, 'hud-track'); animationPanel.append(row);
      const changeTrack = fn => change(clip => fn(clip.tracks[index]));
      field(row, 'Target', track.elementId, value => changeTrack(track => { track.elementId = value; }), hud.elements.map(item => [item.id, item.name]));
      field(row, 'Property', track.property, value => changeTrack(track => {
        track.property = value;
        const target = hud.elements.find(item => item.id === track.elementId);
        track.keys = [{ time: 0, value: target[value] }, { time: clip.duration, value: target[value] }];
      }), HUD_PROPERTIES);
      field(row, 'Easing', track.easing, value => changeTrack(track => { track.easing = value; }), ['linear', 'easeInOut', 'step']);
      track.keys.forEach((key, keyIndex) => {
        const cell = node('div', null, 'hud-key'); row.append(cell);
        for (const name of ['time', 'value']) field(cell, name, key[name], value => changeTrack(track => { track.keys[keyIndex][name] = value; }));
        if (track.keys.length > 2) cell.append(button('Remove key', () => changeTrack(track => track.keys.splice(keyIndex, 1))));
      });
      row.append(button('+ Key', () => changeTrack(track => {
        let gap = 0;
        for (let i = 1; i < track.keys.length; i++) if (track.keys[i].time - track.keys[i - 1].time > gap) gap = track.keys[i].time - track.keys[i - 1].time;
        const index = track.keys.findIndex((key, i) => i && key.time - track.keys[i - 1].time === gap);
        const a = track.keys[index - 1], b = track.keys[index];
        track.keys.splice(index, 0, { time: (a.time + b.time) / 2, value: (a.value + b.value) / 2 });
      })), button('Remove track', () => change(clip => clip.tracks.splice(index, 1))));
    });
  }
  function pickFile(accept, callback) {
    const input = node('input'); input.type = 'file'; input.accept = accept;
    input.addEventListener('change', safe(async () => { if (input.files[0]) await callback(input.files[0]); }), { once: true }); input.click();
  }
  function importImage() {
    pickFile('image/png,image/jpeg,image/webp', async file => {
      if (file.size > 12 * 1024 * 1024) throw new Error('Canva/image export exceeds 12 MiB');
      const image = await createImageBitmap(file);
      try {
        if (image.width > 2048 || image.height > 2048) throw new Error('Export Canva artwork at 2048 x 2048 or smaller');
        const canvas = node('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const asset = { id: newId('hud_image'), name: file.name.slice(0, 100), kind: 'sprite', width: image.width, height: image.height, src: canvas.toDataURL('image/png') };
        update((hud, next) => {
          (next.assets ||= []).push(asset);
          const width = Math.min(image.width, hud.width), element = hudElement(newId('hud'), 'image', asset.name);
          Object.assign(element, { assetId: asset.id, width, height: image.height * width / image.width });
          hud.elements.push(element); selectedId = element.id;
        }, 'Canva/image artwork imported as an editable image element');
      } finally { image.close(); }
    });
  }
  function importWebFont() {
    pickFile('.woff,.woff2,.ttf,.otf', async file => {
      if (file.size > 4 * 1024 * 1024) throw new Error('Web font exceeds 4 MiB');
      const buffer = await file.arrayBuffer(), bytes = new Uint8Array(buffer);
      const signature = String.fromCharCode(...bytes.slice(0, 4));
      const format = signature === 'wOFF' ? 'woff' : signature === 'wOF2' ? 'woff2' : signature === 'OTTO' ? 'otf'
        : bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0 ? 'ttf' : null;
      if (!format) throw new Error('Not a supported WOFF/WOFF2/TTF/OTF font');
      await new FontFace('OpenDLE_import_check', buffer).load();
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const asset = { id: newId('font_asset'), name: file.name.slice(0, 100), kind: 'font', src: `data:font/${format};base64,${btoa(binary)}` };
      update((hud, next) => {
        (next.assets ||= []).push(asset);
        hud.fonts.push({ id: newId('hud_font'), name: asset.name, type: 'web', assetId: asset.id });
      }, 'Portable web font imported');
    });
  }
  function formDialog(title, build, submit) {
    const dialog = node('dialog', null, 'hud-form-dialog'), body = node('div'), feedback = node('p', null, 'error');
    dialog.append(node('h2', title), body, feedback);
    build(body);
    dialog.append(button('Cancel', () => dialog.close()), button('Apply', () => {
      try { submit(); dialog.close(); } catch (failure) { feedback.textContent = failure.message; }
    }));
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  function addBitmapFont() {
    const options = imageOptions();
    if (!options.length) throw new Error('Import the bitmap atlas as an image first');
    const draft = { id: newId('hud_font'), name: 'Bitmap font', type: 'bitmap', assetId: options[0][0],
      cellWidth: 8, cellHeight: 8, columns: 16, chars: Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('') };
    editFont(draft, true);
  }
  function editFont(font, add = false) {
    const draft = structuredClone(font);
    formDialog(draft.type === 'bitmap' ? 'Grid bitmap font' : 'Embedded web font', body => {
      const options = draft.type === 'bitmap' ? imageOptions() : (current.assets || []).filter(asset => asset.kind === 'font').map(asset => [asset.id, asset.name]);
      field(body, 'Atlas image', draft.assetId, value => { draft.assetId = value; }, options);
      for (const key of draft.type === 'bitmap' ? ['name', 'cellWidth', 'cellHeight', 'columns', 'chars'] : ['name']) {
        field(body, key, draft[key], value => { draft[key] = value; });
      }
      if (draft.type === 'bitmap') body.append(node('p', 'Characters are read left-to-right, top-to-bottom. Missing glyphs render as spaces; raster colors come from the atlas.', 'muted'));
    }, () => update(hud => {
      if (add) hud.fonts.push(draft); else Object.assign(hud.fonts.find(item => item.id === draft.id), draft);
    }, 'HUD font saved'));
  }
  function applyCSS(source, replace = false) {
    const styles = replace && !source.trim() ? [] : parseHUDCSS(source);
    for (const style of styles) for (const [property, value] of Object.entries(style.properties)) {
      if (!CSS.supports(property, value)) throw new Error(`Browser does not support ${property}: ${value}`);
    }
    update(hud => {
      if (replace) { hud.styles = styles; return; }
      hud.styles ||= [];
      for (const style of styles) {
        const existing = hud.styles.find(item => item.name === style.name);
        if (existing) Object.assign(existing.properties, style.properties); else hud.styles.push(style);
      }
    }, 'Scoped HUD CSS classes imported');
  }
  function importCSS() {
    pickFile('.css,text/css', async file => {
      if (file.size > 128 * 1024) throw new Error('HUD CSS exceeds 128 KiB');
      applyCSS(await file.text());
    });
  }
  function editCSS() {
    let text;
    formDialog('Scoped HUD CSS', body => {
      body.append(node('p', 'Only .class selectors and visual properties (colors, borders, shadows, padding and text styling). Geometry, anchors and animations belong to the HUD editor. No URLs or page-wide CSS.', 'muted'));
      text = node('textarea'); text.rows = 14; text.setAttribute('aria-label', 'HUD CSS source');
      text.value = (current.hud.styles || []).map(style => `.${style.name} {\n${Object.entries(style.properties).map(([key, value]) => `  ${key}: ${value};`).join('\n')}\n}`).join('\n\n') || '.status {\n  border-radius: 4px;\n  border-color: #aabbbb;\n  border-width: 1px;\n  border-style: solid;\n}';
      body.append(text);
    }, () => applyCSS(text.value, true));
  }
  const observer = new ResizeObserver(() => { if (view && state) view.update(state, { selectedId }); }); observer.observe(host);
  return { render, stopPreview() { cancelAnimationFrame(animationFrame); },
    dispose() { observer.disconnect(); cancelAnimationFrame(animationFrame); view?.dispose(); } };
}
