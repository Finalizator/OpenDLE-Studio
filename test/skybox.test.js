import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDds, parseDdsHeader } from '../shared/dds.js';
import { skyTexel, normalizeSkybox, defaultSkybox, animationFrameAt, layerAssetAt, edgeSampleMode,
  coverageWindow, skyboxFromEnvironment, SKY_FACES } from '../shared/skybox.js';
import { skyDomeV } from '../shared/sky-dome.js';

// ------------------------------------------------------------------------------- DDS

/** A DDS file: the 128-byte header, then whatever the caller puts after it. */
function dds({ width, height, fourCc = 'DXT1', faces = 1, rgbBits = 0, rgb = false, payload }) {
  const bytes = new Uint8Array(128 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x44, 0x44, 0x53, 0x20], 0); // "DDS "
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x81007, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(20, payload.length, true);
  view.setUint32(28, 1, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, rgb ? 0x40 : fourCc ? 0x4 : 0, true);
  if (fourCc) for (let index = 0; index < 4; index++) bytes[84 + index] = fourCc.charCodeAt(index);
  view.setUint32(88, rgbBits, true);
  view.setUint32(108, 0x1000, true);
  view.setUint32(112, faces === 6 ? 0xfc00 | 0x200 : 0, true);
  bytes.set(payload, 128);
  return bytes;
}

/** One BC1 block whose sixteen pixels are all `colour` (an RGB565 value). */
function bc1Block(colour, other = 0x001f) {
  const block = new Uint8Array(8);
  new DataView(block.buffer).setUint16(0, colour, true);
  new DataView(block.buffer).setUint16(2, other, true);
  new DataView(block.buffer).setUint32(4, 0, true); // every pixel uses entry 0
  return block;
}

test('a DXT1 DDS decodes to the colour its block names', () => {
  const payload = bc1Block(0xf800); // pure red in RGB565
  const image = decodeDds(dds({ width: 4, height: 4, payload }));
  assert.equal(image.width, 4);
  assert.equal(image.cubemap, false);
  assert.equal(image.faces.length, 1);
  const rgba = image.faces[0];
  assert.equal(rgba.length, 4 * 4 * 4);
  assert.deepEqual([rgba[0], rgba[1], rgba[2], rgba[3]], [255, 0, 0, 255], 'red, opaque');
  const last = rgba.length - 4;
  assert.deepEqual([rgba[last], rgba[last + 1], rgba[last + 2], rgba[last + 3]], [255, 0, 0, 255],
    'and so is the last pixel of the block');
});

test('a six-face DDS answers six faces, in cubemap order', () => {
  // Each face a different colour so the order can be checked: red, green, blue, black, white, grey.
  const colours = [0xf800, 0x07e0, 0x001f, 0x0000, 0xffff, 0x8410];
  const payload = new Uint8Array(colours.flatMap(colour => [...bc1Block(colour)]));
  const image = decodeDds(dds({ width: 4, height: 4, faces: 6, payload }));
  assert.equal(image.cubemap, true);
  assert.equal(image.faces.length, 6);
  // RGB565 expands by rounding each channel over its own bit count: 0x8410 is r=16/31, g=32/63,
  // b=16/31, which is a muddy grey rather than exactly 128.
  assert.deepEqual(image.faces.map(face => [...face.slice(0, 3)]), [[255, 0, 0], [0, 255, 0], [0, 0, 255],
    [0, 0, 0], [255, 255, 255], [132, 130, 132]]);
});

test('an uncompressed DDS is read pixel for pixel, and its alpha kept', () => {
  const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
  const image = decodeDds(dds({ width: 2, height: 2, fourCc: '', rgb: true, rgbBits: 32, payload }));
  assert.deepEqual([...image.faces[0]], [...payload]);
});

test('a DDS that is not a DDS, or uses a format this engine cannot read, is refused', () => {
  assert.throws(() => parseDdsHeader(new Uint8Array(200)), /Not a DDS file/);
  assert.throws(() => parseDdsHeader(new Uint8Array(64)), /shorter than its header/);
  const payload = bc1Block(0xf800);
  assert.throws(() => decodeDds(dds({ width: 4, height: 4, fourCc: 'DX10', payload })),
    /Unsupported DDS pixel format/);
});

// --------------------------------------------------------------------------- coverage

/** A unit view direction from an azimuth and an elevation, in degrees. */
function direction(azimuth, elevation) {
  const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
  return { x: Math.cos(el) * Math.cos(az), y: Math.sin(el), z: Math.cos(el) * Math.sin(az) };
}

test('a full-sphere window covers every direction, so nothing is left to stretch', () => {
  const coverage = defaultSkybox().coverage;
  for (const [azimuth, elevation] of [[0, 0], [90, 45], [180, -60], [270, 89], [-135, -89]]) {
    const texel = skyTexel({ direction: direction(azimuth, elevation), coverage });
    assert.equal(texel.inside, true, `${azimuth}/${elevation} is inside`);
    assert.ok(texel.u >= 0 && texel.u <= 1 && texel.v >= 0 && texel.v <= 1, 'and samples the picture');
  }
});

test('a picture drawn between two elevations does not reach above them', () => {
  // The report: a sky whose picture covers the horizon and below, with the area above it turned
  // into vertical streaks. Inside the window the picture is sampled; above it there is nothing.
  const coverage = { azimuth: { from: -180, to: 180 }, elevation: { from: -20, to: 30 },
    edge: 'fade', feather: 0, background: null };
  const inside = skyTexel({ direction: direction(0, 10), coverage });
  assert.equal(inside.inside, true);
  assert.ok(inside.v > 0 && inside.v < 1, 'v runs from the bottom of the window to its top');
  const above = skyTexel({ direction: direction(0, 60), coverage });
  assert.equal(above.inside, false, 'above the window');
  assert.ok(above.outside > 0, `and it is outside by ${above.outside.toFixed(3)}`);
  const below = skyTexel({ direction: direction(0, -50), coverage });
  assert.equal(below.inside, false, 'and below it too');
});

test('an azimuth window that crosses north is the short way round', () => {
  const coverage = { azimuth: { from: 300, to: 60 }, elevation: { from: -90, to: 90 }, edge: 'fade', feather: 0 };
  const window = coverageWindow(coverage);
  assert.equal(window.span, 120, '300 to 60 is 120 degrees through north, not 240 round the south');
  assert.equal(skyTexel({ direction: direction(0, 0), coverage }).inside, true, 'due north is inside');
  assert.equal(skyTexel({ direction: direction(20, 0), coverage }).inside, true);
  assert.equal(skyTexel({ direction: direction(180, 0), coverage }).inside, false, 'due south is not');
});

test('a rotation turns the picture inside a window that stays where it was put', () => {
  const coverage = { azimuth: { from: 350, to: 20 }, elevation: { from: -90, to: 90 }, edge: 'fade', feather: 0 };
  const plain = skyTexel({ direction: direction(10, 0), coverage });
  assert.equal(plain.inside, true);
  // The window says which part of the view the sky covers, so it does not move when the picture
  // inside it turns — only which texel is sampled does.
  const rotated = skyTexel({ direction: direction(10, 0), coverage, rotation: 5 });
  assert.equal(rotated.inside, true, 'the window did not move');
  assert.notEqual(rotated.u, plain.u, 'but another part of the picture is drawn there');
  assert.equal(rotated.window.from, plain.window.from);
  // A rotation of the whole window is a wrap, not an escape: the picture slides round its arc.
  assert.equal(skyTexel({ direction: direction(10, 0), coverage, rotation: 30 }).inside, true);
  // Rotating the *view* into the window's covered area is what changes `inside`.
  assert.equal(skyTexel({ direction: direction(200, 0), coverage }).inside, false);
});

test('zooming the picture inside the window leaves the edges uncovered', () => {
  const coverage = defaultSkybox().coverage;
  // The picture spans the whole turn and zooming happens about its middle, so at 2x the ends of
  // the picture no longer reach the parts of the sphere they used to cover.
  const end = skyTexel({ direction: direction(180, 0), coverage });
  assert.equal(end.inside, true);
  assert.equal(skyTexel({ direction: direction(180, 0), coverage, scale: 2 }).inside, false,
    'a 2x zoom no longer reaches the end of the picture');
  assert.ok(skyTexel({ direction: direction(180, 0), coverage, scale: 2 }).outside > 0);
  assert.equal(skyTexel({ direction: direction(0, 0), coverage, scale: 2 }).inside, true,
    'the middle of the picture is still covered');
});

test('a Doom dome is a 60-degree window, and the edge mode decides what is above it', () => {
  // The dome's limit is its own window, not a hidden number: the whole picture is laid over 0..60
  // degrees, so above it the author's edge mode applies. GZDoom clamps (the top row continues up);
  // `fade` is how a picture stops instead of being stretched into streaks.
  const clamped = { azimuth: { from: -180, to: 180 }, elevation: { from: 0, to: 60 }, edge: 'clamp' };
  assert.equal(skyTexel({ direction: direction(0, 30), coverage: clamped }).inside, true);
  assert.ok(Math.abs(skyTexel({ direction: direction(0, 30), coverage: clamped }).v - .5) < 1e-9,
    'halfway up the dome is halfway up the picture');
  const above = skyTexel({ direction: direction(0, 75), coverage: clamped });
  assert.equal(above.inside, false);
  assert.ok(above.outside > 0, 'a clamped dome still reports the area above its top');
  const faded = { ...clamped, edge: 'fade' };
  assert.equal(skyTexel({ direction: direction(0, 30), coverage: faded }).inside, true);
  assert.equal(edgeSampleMode('clamp'), 'clamp', 'the shader repeats the top row above the dome');
});

test("a level's own Doom sky is adopted over its whole dome, tiled the way GZDoom tiles it", () => {
  const sky = skyboxFromEnvironment({ skyAsset: 'sky1', skyMode: 'doom' },
    [{ id: 'sky1', name: 'SKY1', width: 256, height: 128 }]);
  assert.equal(sky.shape, 'dome');
  assert.equal(sky.projection, 'doom');
  // The dome mapping places the picture, not a guessed window: its rows sit where `skyDomeV` puts
  // them, which for a 128-row sky starts below the horizon and compresses towards the zenith.
  assert.deepEqual({ ...sky.coverage.elevation }, { from: -90, to: 90 }, 'the whole sky is the window');
  assert.equal(sky.coverage.edge, 'clamp');
  const at = elevation => skyTexel({ direction: { x: Math.cos(elevation * Math.PI / 180),
    y: Math.sin(elevation * Math.PI / 180), z: 0 }, projection: sky.projection, coverage: sky.coverage,
    rows: 128, uv: sky.layers[0].uv });
  // The horizon samples the picture 78% down (GZDoom pushes the dome down 1250 units), and the
  // zenith is the top row — the numbers `skyDomeV` gives, not a straight stretch.
  assert.ok(Math.abs(at(0).v - skyDomeV(128, 0)) < 1e-9, `horizon v ${at(0).v}`);
  assert.ok(Math.abs(at(30).v - skyDomeV(128, 30)) < 1e-9, `30 degrees v ${at(30).v}`);
  assert.ok(at(0).v > .7 && at(40).v < .2, 'the rows are compressed towards the top');
  // 1024 / 256 = four turns of a 256-wide picture, which is GZDoom's `xscale`.
  assert.equal(sky.layers[0].uv.repeatU, 4);
  const wide = skyboxFromEnvironment({ skyAsset: 'big', skyMode: 'doom' }, [{ id: 'big', width: 1024, height: 512 }]);
  assert.equal(wide.layers[0].uv.repeatU, 1, 'a 1024-wide sky covers the turn once');
});

test('the edge mode decides what a texel outside the window does', () => {
  assert.equal(edgeSampleMode('fade', 0), 'none', 'no feather means nothing is drawn outside');
  assert.equal(edgeSampleMode('fade', 4), 'fade');
  assert.equal(edgeSampleMode('clamp'), 'clamp');
  assert.equal(edgeSampleMode('wrap'), 'wrap');
  assert.equal(edgeSampleMode('none'), 'none');
});

// ------------------------------------------------------------------------ animation

test('an animated sky steps through its frames at the speed it was given', () => {
  const layer = { assetId: 'still', animation: { frames: [
    { assetId: 'a', seconds: .5 }, { assetId: 'b', seconds: .25 }, { assetId: 'c', seconds: .25 }],
    speed: 1, playing: true, loop: true } };
  assert.equal(animationFrameAt(layer.animation, 0), 0);
  assert.equal(animationFrameAt(layer.animation, .49), 0);
  assert.equal(animationFrameAt(layer.animation, .5), 1);
  assert.equal(animationFrameAt(layer.animation, .74), 1);
  assert.equal(animationFrameAt(layer.animation, .75), 2);
  assert.equal(animationFrameAt(layer.animation, 1), 0, 'it loops');
  assert.equal(layerAssetAt(layer, .6), 'b');
  assert.equal(layerAssetAt({ ...layer, animation: { ...layer.animation, speed: 0 } }, 3), 'a',
    'a stopped clock holds its frame');
  assert.equal(animationFrameAt({ frames: [], speed: 1 }), -1, 'no frames is no animation');
  assert.equal(layerAssetAt({ assetId: 'still', animation: { frames: [] } }, 9), 'still',
    'and the layer keeps its picture');
});

test('a one-shot animation stops on its last frame instead of looping', () => {
  const animation = { frames: [{ assetId: 'a', seconds: .2 }, { assetId: 'b', seconds: .2 }],
    speed: 1, playing: true, loop: false };
  assert.equal(animationFrameAt(animation, 5), 1);
});

// ---------------------------------------------------------------------- normalisation

test('the old six-face skybox is read as a cubemap', () => {
  const legacy = Object.fromEntries(SKY_FACES.map(face => [face, `asset_${face}`]));
  const sky = normalizeSkybox(legacy);
  assert.equal(sky.projection, 'cube');
  assert.equal(sky.shape, 'box');
  assert.deepEqual(sky.layers[0].faces, legacy);
});

test('a stored skybox is completed with every field the renderer reads', () => {
  const sky = normalizeSkybox({ shape: 'cylinder', layers: [{ id: 'clouds', assetId: 'a', opacity: 4 }] });
  assert.equal(sky.shape, 'cylinder');
  assert.equal(sky.projection, 'equirect', 'a default projection rather than undefined');
  assert.equal(sky.layers[0].opacity, 1, 'clamped');
  assert.equal(sky.layers[0].coverage.enabled, false);
  assert.deepEqual(sky.coverage.azimuth, { from: -180, to: 180 });
  assert.equal(normalizeSkybox(null), null);
  assert.equal(normalizeSkybox('nonsense'), null);
});
