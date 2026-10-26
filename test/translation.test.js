import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { applyActorTranslations } from '../shared/wad.js';
import { translationLookup, applyTranslation, parseTranslationTable, translationSpecs, packColour } from '../shared/translation.js';

/** A palette where each index has a recognisable colour. */
function palette() {
  const bytes = new Uint8Array(768);
  for (let index = 0; index < 256; index++) {
    bytes[index * 3] = index;
    bytes[index * 3 + 1] = (index * 3) % 256;
    bytes[index * 3 + 2] = (index * 7) % 256;
  }
  return bytes;
}
const colourOf = (bytes, index) => packColour(bytes[index * 3], bytes[index * 3 + 1], bytes[index * 3 + 2]);

test('palette ranges, single targets and one-to-one pairs remap as Doom defines them', () => {
  const colors = palette();
  const { lookup, unsupported } = translationLookup(['128:151=80:111', '208:223=1', '5=9'], colors);
  assert.deepEqual(unsupported, []);
  assert.equal(lookup.size, 24 + 16 + 1);
  assert.equal(lookup.get(colourOf(colors, 128)), colourOf(colors, 80));
  assert.equal(lookup.get(colourOf(colors, 151)), colourOf(colors, 103), 'the range keeps its stride');
  assert.equal(lookup.get(colourOf(colors, 210)), colourOf(colors, 1), 'a single target collapses the range');
  assert.equal(lookup.get(colourOf(colors, 5)), colourOf(colors, 9));
  assert.equal(lookup.get(colourOf(colors, 200)), undefined, 'colours outside the spec are untouched');
});

test('several Translation properties concatenate and unknown syntax is reported', () => {
  assert.deepEqual(translationSpecs(['128:151=80:111', '208:223=1']), ['128:151=80:111', '208:223=1']);
  assert.deepEqual(translationSpecs('168:191=80:111'), ['168:191=80:111']);
  assert.deepEqual(translationSpecs(null), []);
  const { lookup, unsupported } = translationLookup(['128:151=80:111', 'Desaturate'], palette());
  assert.equal(lookup.size, 24);
  assert.deepEqual(unsupported, ['Desaturate'], 'named engine translations are reported rather than guessed');
});

test('applying a translation keeps transparency and unmapped pixels', () => {
  const colors = palette();
  const { lookup } = translationLookup(['128:151=80:111'], colors);
  const pixels = new Uint8ClampedArray([
    ...uint32(colourOf(colors, 130), 255),
    ...uint32(colourOf(colors, 200), 255),
    ...uint32(colourOf(colors, 130), 0),
  ]);
  const result = applyTranslation(pixels, lookup);
  assert.deepEqual([...result.subarray(0, 3)], [...uint32(colourOf(colors, 82), 255).subarray(0, 3)]);
  assert.deepEqual([...result.subarray(4, 7)], [...uint32(colourOf(colors, 200), 255).subarray(0, 3)]);
  assert.equal(result[11], 0, 'transparent pixels stay transparent');
  assert.deepEqual([...pixels.subarray(0, 3)], [...uint32(colourOf(colors, 130), 255).subarray(0, 3)],
    'the source buffer is not modified');
});

test('a TRANSLATION table provides named and numeric translations in order', () => {
  const table = parseTranslationTable([
    '// comment\nAcolyteRust = "111:122=224:235"\nAcolyteGray = "111:122=1:1"\n',
    'Ice = "0:255=[16,16,200]:[16,16,200]";\n',
  ]);
  assert.deepEqual(table.named.get('acolyterust'), ['111:122=224:235']);
  assert.deepEqual(table.ordered.map(entry => entry.name), ['AcolyteRust', 'AcolyteGray', 'Ice'],
    'a numeric translation indexes this order');
});

test('placed actors with a translation get their own sprite assets and clips', () => {
  const project = createProject();
  project.actors = [
    { id: 'actor_imp', name: 'TestImp', flags: { MONSTER: true }, doomedNum: 3001, translation: ['128:151=80:111'], states: { labels: {}, frames: [] } },
    { id: 'actor_dog', name: 'TestDog', flags: { MONSTER: true }, doomedNum: 3002, translation: 1, states: { labels: {}, frames: [] } },
    { id: 'actor_ghost', name: 'TestGhost', flags: { MONSTER: true }, doomedNum: 3003, translation: 4, states: { labels: {}, frames: [] } },
  ];
  project.spriteClips = [{ id: 'clip_TROO_stand', name: 'TROO / stand', frames: ['asset_sprite_TROOA0', 'asset_sprite_TROOB0'],
    seconds: 10 / 35, loop: true }];
  const entity = (id, doomType) => ({ id, type: 'enemy', doomType, x: 0, y: 0, angle: 0, elevation: 0, health: 60,
    spriteAsset: 'asset_sprite_TROOA0', spriteStates: { stand: 'clip_TROO_stand' } });
  project.map.entities.push(entity('imp1', 3001), entity('imp2', 3001), entity('dog1', 3002), entity('ghost1', 3003));
  const calls = [];
  const assets = { translate: (assetId, suffix, specs) => { calls.push({ assetId, suffix, specs }); return `${assetId}_${suffix}`; } };
  const warnings = [];
  applyActorTranslations(project, assets, parseTranslationTable(['AcolyteRust = "111:122=224:235"']), warnings);

  const [imp1, imp2, dog1, ghost1] = project.map.entities.slice(-4);
  assert.match(imp1.spriteStates.stand, /^clip_TROO_stand_tr/);
  assert.equal(imp1.spriteStates.stand, imp2.spriteStates.stand, 'equal specs share one translated clip');
  const suffix = imp1.spriteStates.stand.slice('clip_TROO_stand_'.length);
  const clip = project.spriteClips.find(candidate => candidate.id === imp1.spriteStates.stand);
  assert.deepEqual(clip.frames, [`asset_sprite_TROOA0_${suffix}`, `asset_sprite_TROOB0_${suffix}`]);
  assert.equal(clip.seconds, 10 / 35, 'the translated clip keeps the original timing');
  assert.equal(imp1.spriteAsset, `asset_sprite_TROOA0_${suffix}`, 'the editor sprite follows the translation');
  assert.deepEqual(calls[0].specs, ['128:151=80:111']);
  assert.match(dog1.spriteStates.stand, /^clip_TROO_stand_tr/, 'a numeric translation resolves through the table');
  assert.equal(ghost1.spriteStates.stand, 'clip_TROO_stand', 'an out-of-range index leaves the sprite alone');
  assert.ok(warnings.some(warning => /TestGhost uses translation 4/.test(warning)), warnings.join(' | '));
  assert.ok(warnings.some(warning => /3 placed actor/.test(warning)), 'the import report says what was repainted');
});

function uint32(colour, alpha) {
  return new Uint8ClampedArray([(colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff, alpha]);
}
