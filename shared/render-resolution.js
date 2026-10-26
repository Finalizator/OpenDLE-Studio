// Internal render resolution policy shared by every preview. The game used to render
// a fixed 800x450 buffer stretched over the window, which is why the world and its
// models looked soft; the resolution is now selectable in Engine tweaks and applied
// to the drawing buffer while CSS keeps the canvas in the panel.

export const RENDER_RESOLUTIONS = [
  { value: 'display', label: 'Display size (native, sharpest)' },
  { value: '1280x720', label: '720p — 1280 × 720' },
  { value: '1600x900', label: '900p — 1600 × 900' },
  { value: '1920x1080', label: '1080p — 1920 × 1080' },
  { value: '2560x1440', label: '1440p — 2560 × 1440' },
  { value: '3840x2160', label: '4K — 3840 × 2160' },
];
export const RENDER_RESOLUTION_VALUES = RENDER_RESOLUTIONS.map(entry => entry.value);

export function parseRenderResolution(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Size of the drawing buffer for a canvas of `cssWidth` x `cssHeight`.
 *
 * `resolution` is the Engine tweak: 'display' renders at the panel's real pixel
 * size (device pixel ratio capped at 2), a preset such as '1920x1080' picks the
 * vertical resolution and keeps the panel's aspect ratio so nothing is stretched.
 * The legacy `resolution` scale and the classic low-detail mode still apply on top
 * of that choice.
 */
export function renderBufferSize({
  resolution = 'display', scale = 1, lowDetail = false,
  cssWidth = 800, cssHeight = 450, devicePixelRatio = 1, maxSize = 4096,
} = {}) {
  const preset = parseRenderResolution(resolution);
  const ratio = Math.min(Math.max(Number(devicePixelRatio) || 1, 1), 2);
  const width = Math.max(1, Number(cssWidth) || 800), height = Math.max(1, Number(cssHeight) || 450);
  let targetWidth, targetHeight;
  if (preset) {
    targetHeight = preset.height;
    targetWidth = Math.round(preset.height * width / height);
  } else {
    targetWidth = Math.round(width * ratio);
    targetHeight = Math.round(height * ratio);
  }
  const multiplier = Math.min(Math.max(Number(scale) || 1, .25), 2);
  targetWidth = Math.round(targetWidth * multiplier);
  targetHeight = Math.round(targetHeight * multiplier);
  if (lowDetail) targetWidth = Math.max(1, Math.round(targetWidth / 2));
  const limit = Math.min(Math.max(Number(maxSize) || 4096, 256), 8192);
  if (targetWidth > limit || targetHeight > limit) {
    const shrink = Math.min(limit / targetWidth, limit / targetHeight);
    targetWidth = Math.round(targetWidth * shrink);
    targetHeight = Math.round(targetHeight * shrink);
  }
  targetWidth = Math.max(64, targetWidth);
  targetHeight = Math.max(36, targetHeight);
  // A buffer smaller than the panel is scaled up, so keep the pixel art crisp.
  return { width: targetWidth, height: targetHeight, pixelated: Boolean(lowDetail) || targetHeight < Math.round(height * ratio) };
}
