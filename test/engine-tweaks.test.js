import test from 'node:test';
import assert from 'node:assert/strict';
import { engineTweaks, ENGINE_TWEAK_KEYS } from '../shared/engine-tweaks.js';

test('editor rendering tweaks migrate jump-only preferences and remain typed', () => {
  const defaults = engineTweaks(), migrated = engineTweaks({ jumping: false });
  assert.equal(defaults.jumping, true);
  assert.deepEqual(migrated, { ...defaults, jumping: false });
  assert.deepEqual(Object.keys(defaults), ENGINE_TWEAK_KEYS);
  assert.equal(engineTweaks({ resolution: 1.5 }).resolution, 1.5);
  for (const value of [null, [], { resolution: 3 }, { muted: 1 }, { fov: '70' }, { unknown: 1 }])
    assert.throws(() => engineTweaks(value));
});

test('the PBR detail distances are tweaks like any other, and are ordered', () => {
  const defaults = engineTweaks();
  assert.equal(defaults.materialNormalDistance, 1536);
  assert.equal(defaults.materialDetailDistance, 768);
  // Full detail is the nearer of the two: a material cannot lose its normal map before it loses
  // its roughness without the rule meaning the opposite of what it says.
  assert.ok(defaults.materialDetailDistance <= defaults.materialNormalDistance);
  const tuned = engineTweaks({ materialNormalDistance: 4096, materialDetailDistance: 0 });
  assert.equal(tuned.materialNormalDistance, 4096);
  assert.equal(tuned.materialDetailDistance, 0, 'zero is a valid distance: never draw the detail maps');
  assert.throws(() => engineTweaks({ materialNormalDistance: -1 }), /Invalid game setting/);
  assert.throws(() => engineTweaks({ materialDetailDistance: 99999 }), /Invalid game setting/);
});
