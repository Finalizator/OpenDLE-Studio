/**
 * Sky pictures in the formats a sky actually ships in.
 *
 * A panorama is often a tone-mapped `.hdr` or `.exr` (a 32-bit image whose bright pixels are
 * brighter than white, which is what makes a sun look like a sun), a cubemap is often a compressed
 * `.dds`, and a mod's own sky is whatever its author had — `.tga` or `.tif` as often as `.png`.
 * The browser decodes none of those, so each one is read through three.js's own loader, which is
 * already vendored. Everything here is pure "bytes in, texture out", so it can be driven from a
 * test with a hand-built file.
 */

import { isFloatSampleArray, repairFloatSamples, samplerReadyTexture } from '/shared/sky-hdr.js';

/** The formats a sky may be stored as, in the order the file picker offers them. */
export const SKY_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'tga', 'dds', 'hdr', 'exr', 'tif', 'tiff'];

/** An `<input accept>` list for a sky image. */
export const SKY_IMAGE_ACCEPT = '.png,.jpg,.jpeg,.tga,.dds,.hdr,.exr,.tif,.tiff,image/png,image/jpeg,image/x-tga,'
  + 'image/vnd-ms.dds,image/vnd.radiance,image/x-exr,image/tiff';

const BY_EXTENSION = new Map([
  ['png', 'png'], ['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['tga', 'tga'], ['dds', 'dds'], ['hdr', 'hdr'],
  ['exr', 'exr'], ['tif', 'tiff'], ['tiff', 'tiff'],
]);
const BY_MIME = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/jpg', 'jpeg'], ['image/x-tga', 'tga'],
  ['image/tga', 'tga'], ['image/vnd-ms.dds', 'dds'], ['image/x-dds', 'dds'], ['image/dds', 'dds'],
  ['image/vnd.radiance', 'hdr'], ['image/hdr', 'hdr'], ['image/x-exr', 'exr'], ['image/exr', 'exr'],
  ['image/tiff', 'tiff'], ['image/tif', 'tiff'],
]);

/**
 * The format of a dropped or stored picture, from whichever of its name, its mime type or its
 * bytes is available. `null` when it is not an image a sky can use.
 */
export function skyImageFormat({ name = '', type = '', src = null } = {}) {
  const extension = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension && BY_EXTENSION.has(extension)) return BY_EXTENSION.get(extension);
  const mime = String(type).toLowerCase().split(';')[0].trim();
  if (BY_MIME.has(mime)) return BY_MIME.get(mime);
  if (src) {
    const declared = /^data:([^;,]+)/.exec(String(src))?.[1]?.toLowerCase();
    if (declared && BY_MIME.has(declared)) return BY_MIME.get(declared);
  }
  return null;
}

/** True when the picture is high dynamic range, so the renderer must not sRGB-decode it. */
export const isHdrFormat = format => format === 'hdr' || format === 'exr';

/** The mime type a stored sky picture should carry. */
export const skyMimeFor = format => ({
  png: 'image/png', jpeg: 'image/jpeg', tga: 'image/x-tga', dds: 'image/vnd-ms.dds',
  hdr: 'image/vnd.radiance', exr: 'image/x-exr', tiff: 'image/tiff',
}[format] || 'application/octet-stream');

/** The bytes a data URI carries, without going through `fetch`. */
export function skyImageBytes(src) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(src || ''));
  if (!match) throw new Error('A sky picture must be an embedded data URI');
  if (!match[2]) {
    const text = decodeURIComponent(match[3]);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return { bytes, mime: match[1] || 'application/octet-stream' };
  }
  const binary = atob(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { bytes, mime: match[1] || 'application/octet-stream' };
}

/**
 * Decodes one sky picture into a three texture (or a cubemap).
 *
 * Three of these formats are already textures by the time their loader answers — HDR and EXR are
 * `DataTexture`s of half or full floats, and TGA and TIFF are data textures too — so they are
 * *configured*, not rebuilt. DDS is decoded here (`shared/dds.js`) because a compressed cubemap has
 * to become six ordinary pictures before it can be drawn, and doing it in JavaScript keeps one code
 * path for the editor and the game.
 *
 * Answers `{ texture, format, hdr, cube, width, height }`. `options.THREE` and `options.loaders`
 * exist so a test can drive the decode without a browser.
 */
export async function decodeSkyImage({ src, format = null, name = '' }, options = {}) {
  const THREE = options.THREE;
  if (!THREE) throw new Error('decodeSkyImage needs the three module');
  const kind = format || skyImageFormat({ name, src });
  if (!kind) throw new Error(`${name || 'That picture'} is not an image a sky can use`);
  const { bytes } = skyImageBytes(src);
  if (kind === 'dds') {
    const { decodeDds } = await import('/shared/dds.js');
    const decoded = decodeDds(bytes);
    const faces = decoded.faces.map(rgba => new THREE.DataTexture(rgba, decoded.width, decoded.height));
    if (decoded.cubemap) {
      for (const face of faces) finish(face, THREE, { hdr: false });
      const cube = new THREE.CubeTexture(faces);
      cube.needsUpdate = true;
      return { texture: cube, format: kind, hdr: false, cube: true, width: decoded.width, height: decoded.height };
    }
    finish(faces[0], THREE, { hdr: false });
    return { texture: faces[0], format: kind, hdr: false, cube: false, width: decoded.width, height: decoded.height };
  }
  // Everything else is decoded by three's own loader, which wants a URL.
  const blob = new Blob([bytes], { type: skyMimeFor(kind) });
  const url = URL.createObjectURL(blob);
  try {
    const loaders = options.loaders || {};
    if (kind === 'hdr') {
      const { RGBELoader } = await (loaders.hdr?.() ?? import('/vendor/three-addons/loaders/RGBELoader.js'));
      const data = await new RGBELoader().loadAsync(url);
      finish(data, THREE, { hdr: true });
      return { texture: data, format: kind, hdr: true, cube: false, width: data.image.width, height: data.image.height };
    }
    if (kind === 'exr') {
      const { EXRLoader } = await (loaders.exr?.() ?? import('/vendor/three-addons/loaders/EXRLoader.js'));
      const data = await new EXRLoader().loadAsync(url);
      finish(data, THREE, { hdr: true });
      return { texture: data, format: kind, hdr: true, cube: false, width: data.image.width, height: data.image.height };
    }
    if (kind === 'tga' || kind === 'tiff') {
      const { TGALoader } = await (loaders.tga?.() ?? import('/vendor/three-addons/loaders/TGALoader.js'));
      const { TIFFLoader } = await (loaders.tiff?.() ?? import('/vendor/three-addons/loaders/TIFFLoader.js'));
      const data = await new (kind === 'tga' ? TGALoader : TIFFLoader)().loadAsync(url);
      finish(data, THREE, { hdr: false });
      return { texture: data, format: kind, hdr: false, cube: false, width: data.image.width, height: data.image.height };
    }
    const loader = loaders.image ? await loaders.image() : new THREE.TextureLoader();
    const data = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    finish(data, THREE, { hdr: false });
    return { texture: data, format: kind || 'png', hdr: false, cube: false,
      width: data.image?.width, height: data.image?.height };
  } finally {
    // The loader has read the bytes by the time it resolves; the object URL is only its doorway.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The sampler settings a sky needs.
 *
 * A panorama is looked at from the inside of a sphere, so it repeats round the horizon and clamps
 * top to bottom; a high-dynamic-range picture keeps its own values (sRGB-decoding a float image
 * would crush the sun) and mipmaps, because the horizon occupies very few texels on screen.
 */
function finish(texture, THREE, { hdr = false } = {}) {
  if (!texture) return texture;
  // A float panorama is repaired before it reaches the GPU: one NaN sample is undefined behaviour
  // and shows up as a colour that has nothing to do with the picture, and a negative sample has no
  // meaning in a sky. `texture.userData.repair` says whether anything was changed.
  if (hdr) {
    const ready = samplerReadyTexture(texture, THREE);
    if (!ready.ok) throw new Error(`${ready.reason}`);
    const image = texture.image;
    if (isFloatSampleArray(image?.data)) {
      const channels = image.data.length / Math.max(1, image.width * image.height);
      texture.userData.repair = repairFloatSamples(image.data, { channels: Math.round(channels) || 4 });
    }
  }
  texture.colorSpace = hdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The pictures a skybox names, flattened for the renderer.
 *
 * A layer draws one picture, or six if it is a cube face set, and an animated layer names a picture
 * per frame. This answers every one of them once, in the order the renderer asks for, so the
 * decoder runs once per picture rather than once per frame.
 */
export function skyboxImages(skybox) {
  const images = [];
  const push = (assetId, cube = false) => { if (assetId) images.push({ assetId, cube }); };
  for (const layer of skybox?.layers || []) {
    push(layer.assetId);
    if (layer.faces) for (const face of Object.values(layer.faces)) push(face);
    for (const frame of layer.animation?.frames || []) push(frame.assetId);
  }
  return images;
}
