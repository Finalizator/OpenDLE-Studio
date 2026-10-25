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
