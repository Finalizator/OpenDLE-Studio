// PBR materials: the record that groups a map set, and the bake that settles its resolution.
//
// The editor draws the preview copies and the project plays with the baked ones, so the two are
// stored side by side and `materialDisplay` is the one place that decides which is which.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { createProject, validateProject } from '../shared/project.js';
import { createBoxBrush } from '../shared/brushes.js';
import { createMaterial, materialDisplay, materialScale, assignMaterial, removeMaterial,
  materialsUsing, wallSideMaterial, WALL_MATERIAL_PARTS, MAX_MATERIALS, MATERIAL_CHANNELS } from '../shared/materials.js';
import { bakeChannels, previewChannels, resample, readPng, writePng, imageSize } from '../server/material-bake.js';

/** A solid-colour PNG data URL, which is all a resize test needs. */
function png(width, height, [r, g, b, a = 255]) {
  const image = new PNG({ width, height });
  for (let at = 0; at < image.data.length; at += 4) {
    image.data[at] = r; image.data[at + 1] = g; image.data[at + 2] = b; image.data[at + 3] = a;
  }
  return `data:image/png;base64,${PNG.sync.write(image).toString('base64')}`;
}

function projectWithImage(kind = 'texture', name = 'Brick') {
  const project = createProject();
  project.events = [];
  project.assets = [];
  const id = `asset_${name.toLowerCase()}`;
  project.assets.push({ id, name, kind, width: 2, height: 2, src: png(2, 2, [200, 60, 40]) });
  return { project, id };
}

test('a material groups its maps and validates as part of the project', () => {
  const { project, id } = projectWithImage();
  const material = createMaterial(project, { name: 'Brick', channels: { baseColor: id, normal: null, roughness: '' } });
  assert.deepEqual(Object.keys(material.channels), ['baseColor'], 'empty channels are not stored');
  assert.deepEqual(materialScale(material), { u: 1, v: 1 });
  validateProject(project);

  // A channel the renderer does not know is refused, and so is a map the project does not hold.
  project.materials[0].channels.height = 'missing_asset';
  assert.throws(() => validateProject(project), /unknown image|asset/i);
  project.materials[0].channels.height = id;
  project.materials[0].channels.specular = id;
  assert.throws(() => validateProject(project), /Unknown material channel/);
  delete project.materials[0].channels.specular;
  validateProject(project);
  assert.ok(MATERIAL_CHANNELS.includes('ao'));
  assert.equal(MAX_MATERIALS, 256);
});

test('a material with no maps at all is refused', () => {
  const { project } = projectWithImage();
  createMaterial(project, { name: 'Empty', channels: {} });
  assert.throws(() => validateProject(project), /at least one map/);
});

test('the editor draws the preview and the game draws the baked set', () => {
  const { project, id } = projectWithImage();
  const material = createMaterial(project, { channels: { baseColor: id } });
  material.preview = { size: 64, channels: { baseColor: id } };
  material.baked = { size: 512, at: '2026-11-25T00:00:00.000Z' };
  assert.equal(materialDisplay(material, { editor: true }).size, 64, 'the editor is cheap');
  assert.equal(materialDisplay(material).size, 512, 'the game is what was baked');
  // With no preview yet (a fresh material) the editor falls back to the full set.
  delete material.preview;
  assert.equal(materialDisplay(material, { editor: true }).size, 512);
  assert.equal(materialDisplay(material, { editor: true }).baseColor, id);
});

test('each material keeps its own preview and bake resolution', () => {
  const { project, id } = projectWithImage('texture', 'Shared');
  const small = createMaterial(project, { name: 'Floor tile', channels: { baseColor: id } });
  const hero = createMaterial(project, { name: 'Hero wall', channels: { baseColor: id } });
  small.preview = { size: 64, channels: { baseColor: id } };
  small.baked = { size: 512, at: '2026-11-25T00:00:00.000Z' };
  hero.preview = { size: 512, channels: { baseColor: id } };
  hero.baked = { size: 2048, at: '2026-11-25T00:00:00.000Z' };
  validateProject(project);
  // One material's choice is not another's: the two are looked at and played at different sizes.
  assert.equal(materialDisplay(small, { editor: true }).size, 64);
  assert.equal(materialDisplay(hero, { editor: true }).size, 512);
  assert.equal(materialDisplay(small).size, 512);
  assert.equal(materialDisplay(hero).size, 2048);
  // A material with no preview of its own still draws its full set.
  const plain = createMaterial(project, { name: 'Plain', channels: { baseColor: id } });
  assert.equal(materialDisplay(plain, { editor: true }).size, null);
  assert.equal(materialDisplay(plain, { editor: true }).baseColor, id);
});

test('a surface draws one material, and removing the material clears the assignment', () => {
  const { project, id } = projectWithImage();
  const material = createMaterial(project, { channels: { baseColor: id } });
  project.map.brushes = [];
  const brush = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 32, depth: 32, height: 32 });
  brush.faces[0].texture = id;
  assignMaterial(project, material.id, { kind: 'brushFace', brushId: brush.id, faceIndex: 0 });
  assert.equal(brush.faces[0].material, material.id);
  assert.equal(brush.faces[0].texture, null, 'the texture gives way to the material');
  validateProject(project);

  assert.deepEqual(materialsUsing(project, [id]).map(item => item.id), [material.id]);
  removeMaterial(project, material.id);
  assert.equal(brush.faces[0].material, undefined);
  assert.equal(project.materials.length, 0);
  validateProject(project);
});

test('a wall side carries a material per part, and the renderer reads the same field', () => {
  const { project, id } = projectWithImage();
  const material = createMaterial(project, { channels: { baseColor: id } });
  const wall = project.map.walls[0];
  // Every part the sidedef has: assignment and lookup must agree on the field name, which is what
  // broke when the renderer asked for `material_mid` and the editor wrote `material_middle`.
  for (const part of Object.keys(WALL_MATERIAL_PARTS)) {
    assignMaterial(project, material.id, { kind: 'wallSide', wallId: wall.id, side: 'right', part });
    assert.equal(wall.right[WALL_MATERIAL_PARTS[part]], material.id, `assigning wrote ${part}`);
    assert.equal(wallSideMaterial(project, wall.right, part)?.id, material.id, `the lookup found ${part}`);
  }
  assert.equal(wallSideMaterial(project, wall.right, 'middle')?.channels.baseColor, id,
    'and the part resolves to a material whose base colour is the picture the wall draws');
  assert.throws(() => wallSideMaterial(project, wall.right, 'nonsense'), /no "nonsense" part/,
    'a misspelt part is an error, not a silently missing material');
  validateProject(project);
  wall.right.material_middle = 'material_nowhere';
  assert.throws(() => validateProject(project), /unknown material/);
});

test('a brush face that names a material draws that material in play, not the white filler', () => {
  // Assigning a material takes the texture away ("a surface draws one thing"), and the play
  // renderer grouped brush faces by `face.texture` alone — so every material face played as the
  // white checker filler while the editor drew it correctly.
  const project = createProject();
  const brush = createBoxBrush(project, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 });
  const material = createMaterial(project, { channels: { baseColor: 'asset_base', normal: 'asset_normal' } });
  assignMaterial(project, material.id, { kind: 'brushFace', brushId: brush.id, faceIndex: 0 });
  const face = project.map.brushes[0].faces[0];
  assert.equal(face.texture, null, 'the texture is gone, so the picture cannot be the key');
  assert.equal(face.material, material.id);

  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(source, /const key = \[shaderId, face\.material \|\| face\.texture \|\| ''/,
    'the brush path groups by the material when there is one');
  assert.match(source, /brushMaterialForMaterial\(face\.material\)/, 'and builds a lit material for it');
  assert.match(source, /full\.userData\.pbrVariants = \{ full, normalOnly: build/, 'with the same levels of detail the walls get');
  assert.match(source, /\.\.\.batchMeshes\.values\(\), \.\.\.brushPbrMeshes/, 'which the LOD switch walks');
});

test('a wall draws the material it names, even when another material shares its picture', () => {
  // The wall path looked a material up by base-colour asset id, so two materials over one albedo
  // (polished stone and rough stone) drew each other's normal and roughness maps.
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(source, /materialId: record\?\.id \|\| null/, "the side's own material is passed in");
  assert.match(source, /const assigned = materialId \? materialById\(project, materialId\) : null/);
  assert.match(source, /const key = `\$\{assetId\}\/\$\{color\}\/.*\/\$\{materialId \|\| ''\}`/,
    'and the material is part of the cache key');
});

test('the renderer resolves wall materials through the shared part names', () => {
  // The draw path used `material_mid`/`material_top`/`material_bottom`, none of which any assignment
  // writes: a material on a Doom wall was stored, validated and never drawn.
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(source, /wallSideMaterial\(project, side, part\)/);
  for (const part of ["'middle'", "'upper'", "'lower'"]) {
    assert.ok(source.includes(`sideAsset(side, ${part},`), `the renderer asks for ${part}`);
  }
  assert.doesNotMatch(source, /material_mid[^d]/, 'no field name of its own');
  assert.doesNotMatch(source, /material_top|material_bottom/);
});

test('resampling averages, and a normal map stays a direction', () => {
  // Four texels to one: the colour is their mean, not the first of them.
  const image = new PNG({ width: 2, height: 2 });
  const values = [[0, 0, 0, 255], [100, 100, 100, 255], [200, 200, 200, 255], [255, 255, 255, 255]];
  values.forEach((value, index) => image.data.set(value, index * 4));
  const reduced = resample({ width: 2, height: 2, data: image.data }, 1);
  assert.deepEqual([...reduced.data], [139, 139, 139, 255], 'the mean of the four');

  // (128,128,255) is "straight up": averaging it with its opposite would give a zero vector, so
  // the result has to be renormalised rather than averaged as bytes.
  const normals = new PNG({ width: 2, height: 1 });
  normals.data.set([128, 128, 255, 255, 128, 128, 255, 255]);
  const baked = resample({ width: 2, height: 1, data: normals.data }, 1, { normal: true });
  assert.ok(Math.abs(baked.data[0] - 128) <= 1 && Math.abs(baked.data[1] - 128) <= 1);
  assert.ok(baked.data[2] >= 254, 'still pointing up');
});

test('baking writes the size that was chosen, and a preview is only ever smaller', () => {
  const source = png(4, 4, [10, 20, 30]);
  const baked = bakeChannels({ baseColor: source }, 256);
  assert.deepEqual(imageSize(baked.baseColor), { width: 256, height: 256 });
  const preview = previewChannels({ baseColor: baked.baseColor }, 64);
  assert.deepEqual(imageSize(preview.baseColor), { width: 64, height: 64 });
  // A map already smaller than the preview is passed through rather than upscaled.
  const small = png(8, 8, [1, 2, 3]);
  assert.equal(previewChannels({ baseColor: small }, 64).baseColor, small);
  assert.throws(() => bakeChannels({ baseColor: source }, 300), /baked at/);
  assert.throws(() => resample(readPng(source), 0), /whole number/);
  assert.equal(writePng(readPng(source)).startsWith('data:image/png;base64,'), true);
});
