/**
 * Camera textures.
 *
 * `ANIMDEFS` declares a texture that no image file backs: `cameratexture NAME 128
 * 128` reserves a surface a script can point at a camera thing with
 * `SetCameraToTexture(camera_tid, "NAME", fov)`. The importer reserves the name
 * and the renderer fills it with a live view.
 */

const CAMERA = /^\s*cameratexture\s+([A-Za-z0-9_]{1,8})\s+(\d{1,4})\s+(\d{1,4})(?:\s+(\w+))?(?:\s+(\w+))?/i;

/** Camera textures declared by ANIMDEFS text, in declaration order. */
export function parseCameraTextures(sources) {
  const found = new Map();
  for (const source of sources) {
    if (typeof source !== 'string' || !source) continue;
    for (const raw of source.split('\n')) {
      const line = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!line) continue;
      const match = CAMERA.exec(line);
      if (!match) continue;
      const name = match[1].toUpperCase();
      const width = Math.min(2048, Math.max(1, Number(match[2])));
      const height = Math.min(2048, Math.max(1, Number(match[3])));
      const options = [match[4], match[5]].filter(Boolean).map(option => option.toLowerCase());
      // Later definitions replace earlier ones, as GZDoom's ANIMDEFS does.
      found.set(name, { name, width, height, fit: options.includes('fit'), worldPanning: options.includes('worldpanning') });
    }
  }
  return [...found.values()];
}

/**
 * Points a camera texture at a camera thing, which is what
 * `SetCameraToTexture(camera_tid, "NAME", fov)` does. The renderer draws that
 * view into the reserved surface every frame.
 */
export function bindCameraTexture(project, state, cameraTid, name, fov = 90) {
  const definition = (project.cameraTextures || []).find(entry => entry.name === String(name || '').toUpperCase());
  const camera = cameraTid ? state.entities.find(entity => entity.tid === cameraTid) : null;
  if (!definition || !camera) return false;
  state.cameraTextures ||= new Map();
  state.cameraTextures.set(definition.name, { cameraId: camera.id, fov: Math.max(1, Math.min(179, Number(fov) || 90)) });
  return true;
}
