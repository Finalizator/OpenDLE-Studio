/**
 * The Skybox tab's preview, as numbers.
 *
 * The tab draws a grid of cells in front of a camera and fills each one with the texel the shader
 * would sample there — so a gap in the coverage is a visible gap rather than a colour nobody can
 * explain, and a picture that is stretched shows its stretched texels. Everything that decides a
 * cell is here, pure, so it can be checked without a canvas.
 */
import { skyTexel } from './skybox.js';

/**
 * One cell per screen position: which part of the sky it looks at and which texel that is.
 *
 * `heading` and `fov` are in radians; `fov` is the vertical field of view, and `aspect` widens it
 * horizontally, exactly as the camera does in the renderer.
 */
export function skyPreviewCells({ skybox, columns = 32, rows = 16, heading = 0, pitch = 0,
  fov = Math.PI * 70 / 180, aspect = 16 / 9, pictureRows = 240 } = {}) {
  const cells = [];
  const halfTan = Math.tan(fov / 2);
  for (let row = 0; row < rows; row++) {
    // Screen rows run top to bottom; a view direction is built from the middle outwards.
    const ny = 1 - (row + .5) / rows * 2;
    for (let column = 0; column < columns; column++) {
      const nx = (column + .5) / columns * 2 - 1;
      // The ray through this cell, in the renderer's axes (x east, y up, z north).
      const flat = 1;
      const dx = Math.cos(heading) * flat - Math.sin(heading) * nx * halfTan * aspect;
      const dz = Math.sin(heading) * flat + Math.cos(heading) * nx * halfTan * aspect;
      const dy = ny * halfTan + Math.sin(pitch) * flat;
      const length = Math.hypot(dx, dy, dz) || 1;
      const texel = skyTexel({ direction: { x: dx / length, y: dy / length, z: dz / length },
        projection: skybox?.projection || 'equirect', coverage: skybox?.coverage,
        rotation: skybox?.rotation || 0, pitch: skybox?.pitch || 0, scale: skybox?.scale || 1,
        rows: pictureRows });
      // The ray is kept with the cell: a preview of a procedural sky lights it, and re-deriving the
      // direction in the panel would be a second copy of this arithmetic to keep in step.
      cells.push({ column, row, direction: { x: dx / length, y: dy / length, z: dz / length }, ...texel });
    }
  }
  return cells;
}

/**
 * The whole sky as one plate: azimuth across, elevation up.
 *
 * A camera view can only show one 70-degree slice, so it cannot answer the question the tab
 * exists for — "where does the picture stop covering the sky?". The plate can: the entire
 * window, and grey wherever nothing is drawn. Column 0 is -180 degrees and the rightmost column
 * is just short of +180, so the plate's two edges are the same direction, as a panorama's are.
 */
export function skyPlateCells({ skybox, columns = 72, rows = 36, pictureRows = 240, layerUv = null } = {}) {
  const cells = [];
  for (let row = 0; row < rows; row++) {
    const elevation = 90 - (row + .5) / rows * 180;
    const el = elevation * Math.PI / 180, ring = Math.cos(el), up = Math.sin(el);
    for (let column = 0; column < columns; column++) {
      const azimuth = -180 + (column + .5) / columns * 360;
      const az = azimuth * Math.PI / 180;
      const direction = { x: ring * Math.cos(az), y: up, z: ring * Math.sin(az) };
      const texel = skyTexel({ direction, projection: skybox?.projection || 'equirect', coverage: skybox?.coverage,
        rotation: skybox?.rotation || 0, pitch: skybox?.pitch || 0, scale: skybox?.scale || 1,
        rows: pictureRows, uv: layerUv });
      // The plate's own coordinates win over the texel's, which are the same direction in the
      // sky's rotated frame: a caller asking "which cell is this" means the plate's row and column.
      cells.push({ ...texel, column, row, direction, azimuth, elevation });
    }
  }
  return cells;
}

/** How much of the preview is covered, which is the number the tab shows beside it. */
export function previewCoverage(cells) {
  if (!cells?.length) return { inside: 0, total: 0, fraction: 0 };
  const inside = cells.filter(cell => cell.inside).length;
  return { inside, total: cells.length, fraction: inside / cells.length };
}
