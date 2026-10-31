/**
 * ACS HudMessages, drawn over the game view.
 *
 * A title screen is built out of these: `SetFont("LULLABY")` names a picture, which GZDoom
 * turns into a one-picture font, and `HudMessage` then paints that picture at a position in
 * a virtual screen set by `SetHudSize`. Without them the title map is a dark room with no
 * logo on it.
 *
 * The coordinates follow GZDoom's: with a hud size they are pixels in that virtual screen and
 * the message is centred on them; without one they are 0..1 fractions of the view.
 */
import { bitmapGlyph } from '/shared/hud.js';

export function createAcsHud(host, project) {
  const layers = new Map();
  const assets = new Map((project.assets || []).map(asset => [asset.id, asset]));
  const picturesByName = new Map();
  for (const asset of assets.values()) if (asset.name && asset.src && asset.width) picturesByName.set(asset.name.toUpperCase(), asset);
  const fontsByName = new Map();
  for (const font of project.hud?.fonts || []) {
    fontsByName.set((font.name || '').toLowerCase(), font);
    fontsByName.set((font.id || '').toLowerCase(), font);
  }
  // GZDoom's own font names, mapped onto whatever this import actually has.
  const defaultFont = project.hud?.fonts?.find(font => font.type === 'bitmap') || null;
  for (const alias of ['smallfont', 'bigfont', 'dbigfont', 'confont', 'indexfont', 'menu']) {
    if (!fontsByName.has(alias) && defaultFont) fontsByName.set(alias, defaultFont);
  }

  function glyphs(node, text, font, pixelScale) {
    node.replaceChildren();
    const size = Math.max(4, Math.round(font.cellHeight * pixelScale));
    for (const lineText of text.split('\n')) {
      const line = document.createElement('div');
      line.style.cssText = 'display:flex;align-items:flex-start;justify-content:center;';
      for (const char of lineText) {
        const { index, advance } = bitmapGlyph(font, char);
        const glyph = document.createElement('span');
        glyph.style.cssText = `position:relative;display:inline-block;width:${advance * pixelScale}px;height:${size}px;`;
        if (index >= 0) {
          const atlas = assets.get(font.assetId);
          const ink = document.createElement('span');
          ink.style.cssText = `position:absolute;left:0;top:0;width:${font.cellWidth * pixelScale}px;height:${size}px;`
            + `background-image:url("${atlas?.src || ''}");background-repeat:no-repeat;`
            + `background-size:${(atlas?.width || 0) * pixelScale}px ${(atlas?.height || 0) * pixelScale}px;`
            + `background-position:${-(index % font.columns) * font.cellWidth * pixelScale}px `
            + `${-Math.floor(index / font.columns) * font.cellHeight * pixelScale}px;`;
          glyph.append(ink);
        }
        line.append(glyph);
      }
      node.append(line);
    }
  }

  function plainText(node, text, colour, pixelScale) {
    node.replaceChildren();
    const line = document.createElement('div');
    line.textContent = text;
    line.style.cssText = `color:${colour};font:${Math.round(10 * pixelScale)}px monospace;white-space:pre;text-align:center;`;
    node.append(line);
  }

  return {
    /** Draws the current messages; `view` is the game viewport in CSS pixels. */
    update(state, view) {
      const messages = state.acsMessages || [];
      // One framebuffer pixel in CSS pixels, so a picture keeps its own resolution.
      const deviceScale = view.deviceScale || 1;
      const live = new Set();
      for (const record of messages) {
        live.add(record);
        let layer = layers.get(record);
        if (!layer) {
          const node = document.createElement('div');
          node.className = 'acs-message';
          node.style.cssText = 'position:absolute;pointer-events:none;transform:translate(-50%,-50%);';
          host.append(node);
          layer = { node, built: '' };
          layers.set(record, layer);
        }
        const key = `${record.text}\0${record.font}\0${record.color}\0${record.bold}`;
        const virtualWidth = record.hudWidth || 320, virtualHeight = record.hudHeight || 200;
        // A virtual-pixel hud scales with the view; a fractional one is already relative.
        const scaleX = view.width / virtualWidth, scaleY = view.height / virtualHeight;
        const pixelScale = record.hudHeight ? scaleY : view.height / 200;
        if (layer.built !== key || layer.scale !== pixelScale) {
          layer.built = key; layer.scale = pixelScale;
          const picture = record.font ? picturesByName.get(record.font.toUpperCase()) : null;
          if (picture) {
            layer.node.replaceChildren();
            // A one-picture font is drawn at the picture's own pixel size, positioned by the
            // hud coordinates — GZDoom's font drawing takes its scale from the font, not from
            // the virtual screen. The size is therefore expressed in framebuffer pixels, which
            // is what the artwork's pixels correspond to.
            const width = picture.width * deviceScale;
            Object.assign(layer.node.style, { width: `${width}px`, height: `${picture.height * deviceScale}px`,
              backgroundImage: `url("${picture.src}")`, backgroundSize: '100% 100%', imageRendering: 'pixelated' });
          } else {
            Object.assign(layer.node.style, { width: 'auto', height: 'auto', backgroundImage: 'none' });
            const font = record.font ? fontsByName.get(record.font.toLowerCase()) : null;
            if (font?.type === 'bitmap') glyphs(layer.node, record.text, font, pixelScale);
            else plainText(layer.node, record.text, colourOf(record.color), pixelScale);
          }
        }
        // A hud-sized message is positioned in virtual pixels; otherwise x and y are
        // fractions of the view. Recomputed every frame, because the preview is resized
        // (and starts at zero size) after the message first appears.
        layer.node.style.left = `${Math.round(view.x + (record.hudWidth ? record.x * scaleX : record.x * view.width))}px`;
        layer.node.style.top = `${Math.round(view.y + (record.hudHeight ? record.y * scaleY : record.y * view.height))}px`;
        layer.node.style.opacity = String(opacityOf(record, state));
      }
      for (const [record, layer] of layers) {
        if (live.has(record)) continue;
        layer.node.remove();
        layers.delete(record);
      }
    },
    dispose() {
      for (const layer of layers.values()) layer.node.remove();
      layers.clear();
      host.replaceChildren();
    },
  };
}

/** Doom's CR_ colours, in the order the constants number them. */
const COLORS = ['#ffffff', '#a03020', '#d8c090', '#a0a0a0', '#00a000', '#a06030',
  '#f0d000', '#f00000', '#0000f0', '#f07000', '#ffffff', '#ffff00'];

function colourOf(index) {
  return COLORS[index] || COLORS[0];
}

/** HUDMSG_FADEOUT eases out; every other type simply expires. */
function opacityOf(record, state) {
  if (record.type !== 3 || !record.hold) return 1;
  return Math.max(0, Math.min(1, (record.hold - (state.time - record.start)) / Math.min(1, record.hold)));
}
