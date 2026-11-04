/**
 * Client side of the PixiEditor bridge.
 *
 * A project keeps its artwork as PNG data URLs, so editing a texture in a desktop paint
 * program means handing the file over and taking it back: the server writes the PNG into
 * a scratch folder, starts PixiEditor on it, and reads the file again once it has been
 * exported over. This module is the editor-side half of that, shared by the asset browser
 * and every inspector that shows a picture, so all of them behave the same way.
 *
 * `request` is the studio's authorised fetch (the same `/api` helper every panel uses);
 * nothing here talks to the network by itself.
 */

/** Kinds whose artwork is a bitmap PixiEditor can open. */
export const PIXIEDITOR_KINDS = Object.freeze(['texture', 'flat', 'sprite', 'image', 'sky', 'weapon', 'hud']);

/** Whether an asset is a picture the studio can hand to PixiEditor. */
export function isEditableImage(asset) {
  return Boolean(asset && PIXIEDITOR_KINDS.includes(asset.kind)
    && typeof asset.src === 'string' && asset.src.startsWith('data:image/png;base64,'));
}

/**
 * `request(path, options)` performs an authorised call; `notify(message, error)` reports a
 * one-line result in the status bar. Both belong to the studio, not to this module.
 */
export function createPixiEditor({ request, notify = () => {} } = {}) {
  let known = null;

  /** Where PixiEditor is on this machine, cached for the session; `true` forces a re-probe. */
  async function status(force = false) {
    if (known && !force) return known;
    known = await request('/api/pixieditor');
    return known;
  }

  // Only what the server needs: sending the whole asset would copy previews and models.
  const payloadOf = asset => ({ id: asset.id, name: asset.name, kind: asset.kind, src: asset.src });

  async function open(asset) {
    if (!isEditableImage(asset)) throw new Error(`${asset?.name || 'That asset'} is not a picture PixiEditor can open`);
    const result = await request('/api/pixieditor/open', { method: 'POST', body: JSON.stringify({ asset: payloadOf(asset) }) });
    notify(`${asset.name}: editing in PixiEditor. Export the PNG over ${result.path} to bring the change back.`);
    return result;
  }

  /** Reads the exported file back: the caller applies `src`, `width` and `height`. */
  async function reload(asset) {
    const result = await request('/api/pixieditor/reload', { method: 'POST', body: JSON.stringify({ asset: payloadOf(asset) }) });
    notify(`${asset.name} reloaded from PixiEditor (${result.width}\u00d7${result.height}).`);
    return result;
  }

  /**
   * The little button every picture field carries. It reads the field's value when pressed,
   * so it always edits what the inspector is showing rather than what it showed at render time.
   */
  function button(getAsset) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'pixieditor-button';
    element.title = 'Edit this image in PixiEditor and bring the result back';
    element.setAttribute('aria-label', 'Edit this image in PixiEditor');
    element.textContent = '\u270e';
    element.addEventListener('click', event => {
      // A field is a <label>; without this the click also refocuses the select behind it.
      event.preventDefault();
      event.stopPropagation();
      const asset = getAsset();
      if (!asset) { notify('Choose an image first, then edit it in PixiEditor', true); return; }
      open(asset).catch(error => notify(error.message, true));
    });
    return element;
  }

  return { status, open, reload, button };
}
