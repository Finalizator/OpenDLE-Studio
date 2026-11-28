import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { defaultSkybox, activeSkybox, currentSkyFrame } from '../shared/skybox.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';

// A project whose sky is the layered kind, with one saved preset to switch to.
function fixture() {
  const project = installEngineScripts(createProject());
  project.assets.push({ id: 'sky_blue', name: 'Blue sky', kind: 'sky', format: 'png', width: 1024, height: 512,
    offsetX: 0, offsetY: 0, src: 'data:image/png;base64,AAAA' });
  project.assets.push({ id: 'sky_clouds', name: 'Clouds', kind: 'sky', format: 'png', width: 512, height: 256,
    offsetX: 0, offsetY: 0, src: 'data:image/png;base64,BBBB' });
  const sky = defaultSkybox();
  sky.layers[0].assetId = 'sky_blue';
  sky.animation.playing = false;
  project.environment.skybox = sky;
  const night = defaultSkybox();
  night.layers[0].assetId = 'sky_clouds';
  project.skyPresets = [{ id: 'preset_night', name: 'Night', skybox: night }];
  project.variables.tick = 0;
  return project;
}
function rule(project, actions, condition = { type: 'always' }) {
  const event = { id: `rule_${project.events.length}`, enabled: true, once: false, condition, actions };
  project.events.push(event);
  return event;
}
// One step is all a rule needs: the sheet runs its condition and its actions, and the sky is part
// of the state the step updates (the animation clock advances against the same `dt`).
function run(project, seconds = 1 / 60) {
  const state = createRuntime(project);
  stepRuntime(project, state, seconds, new Set());
  return state;
}

test('a preset action replaces the sky the level is drawing', () => {
  const project = fixture();
  assert.equal(activeSkybox(createRuntime(project), project).layers[0].assetId, 'sky_blue');
  rule(project, [{ type: 'setSkyPreset', preset: 'preset_night' }]);
  const state = run(project);
  assert.equal(state.skybox.layers[0].assetId, 'sky_clouds');
  assert.equal(state.skybox.presetName, 'Night');
  // The preset's own record is copied, not referenced: editing the preset later must not reach
  // back into the level that already applied it.
  assert.notEqual(state.skybox, project.skyPresets[0].skybox);
});

test('an unknown preset is refused instead of leaving a blank sky', () => {
  const project = fixture();
  rule(project, [{ type: 'setSkyPreset', preset: 'sunset' }]);
  assert.throws(() => validateProject(project), /no sky preset named sunset/);
});

test('the animation clock runs while playing and holds when stopped', () => {
  const project = fixture();
  rule(project, [{ type: 'startSkyAnimation' }]);
  const state = createRuntime(project);
  // `dt` is clamped to a frame, so half a second is ten steps — the same as the game's own loop.
  // The rule that starts the clock runs inside the step, so the step that starts it does not also
  // advance it: ten steps leave nine frames of sky time.
  for (let frame = 0; frame < 10; frame++) stepRuntime(project, state, .05, new Set());
  assert.ok(Math.abs(state.skyClock - .45) < 1e-6, `clock advanced to ${state.skyClock}`);
  // A sky that is stopped holds its clock at zero however long it runs.
  const stillProject = fixture(), still = createRuntime(stillProject);
  for (let frame = 0; frame < 10; frame++) stepRuntime(stillProject, still, .05, new Set());
  assert.equal(still.skyClock, 0);
});

test('start, stop and speed steer the clock, and a frame jump moves it', () => {
  const project = fixture();
  rule(project, [{ type: 'startSkyAnimation' }, { type: 'setSkySpeed', value: 4 }]);
  const state = createRuntime(project);
  for (let frame = 0; frame < 5; frame++) stepRuntime(project, state, .05, new Set());
  assert.equal(state.skybox.animation.playing, true);
  assert.equal(state.skybox.animation.speed, 4);
  assert.ok(Math.abs(state.skyClock - .8) < 1e-6, `four times the clock after a quarter second: ${state.skyClock}`);

  // A frame is a position in the layer's own clip, so jumping to it moves the shared clock — which
  // is what makes "start the sky on frame 2" mean the same thing as it does in the tab's preview.
  const frames = [{ assetId: 'sky_blue', seconds: .5 }, { assetId: 'sky_clouds', seconds: .5 },
    { assetId: 'sky_blue', seconds: .5 }];
  project.environment.skybox.layers[0].animation.frames = frames;
  project.events.length = 0;
  rule(project, [{ type: 'setSkyFrame', frame: 2, layer: 1 }]);
  const framed = run(project);
  assert.equal(currentSkyFrame(framed, project, 1), 2);
});

test('coverage, rotation, tint and exposure are runtime commands too', () => {
  const project = fixture();
  rule(project, [{ type: 'setSkyCoverage', azimuthFrom: -40, azimuthTo: 40, elevationFrom: 0, elevationTo: 40, edge: 'wrap' },
    { type: 'setSkyRotation', degrees: 90 }, { type: 'setSkyTint', color: '#ffaa00' }, { type: 'setSkyExposure', value: 2 }]);
  const state = run(project);
  assert.deepEqual({ ...state.skybox.coverage.azimuth }, { from: -40, to: 40 });
  assert.deepEqual({ ...state.skybox.coverage.elevation }, { from: 0, to: 40 });
  assert.equal(state.skybox.coverage.edge, 'wrap');
  assert.equal(state.skybox.rotation, 90);
  assert.equal(state.skybox.tint, '#ffaa00');
  assert.equal(state.skybox.exposure, 2);
});

test('a layer can be given its own picture, moved, spun and faded', () => {
  const project = fixture();
  project.environment.skybox.layers.push(defaultSkybox().layers[0]);
  rule(project, [{ type: 'setSkyLayerTexture', layer: 2, assetId: 'sky_clouds' },
    { type: 'setSkyLayerOffset', layer: 2, offsetU: .25, offsetV: -.5 },
    { type: 'setSkyLayerSpin', layer: 2, degreesPerSecond: 6 },
    { type: 'setSkyLayerOpacity', layer: 2, opacity: .4 }]);
  const state = run(project);
  const layer = state.skybox.layers[1];
  assert.equal(layer.assetId, 'sky_clouds');
  assert.equal(layer.uv.offsetU, .25);
  assert.equal(layer.uv.offsetV, -.5);
  assert.equal(layer.spin.azimuth, 6);
  assert.equal(layer.opacity, .4);
});

test('sky conditions read the sky the level is actually showing', () => {
  const project = fixture();
  project.events.length = 0;
  // Each condition writes a different value, so one step proves which of them passed.
  const only = (condition) => {
    project.events.length = 0;
    return rule(project, [{ type: 'setVariable', variable: 'tick', value: 9 }], condition);
  };
  only({ type: 'skyboxPreset', preset: 'preset_night' });
  assert.equal(run(project).variables.tick, 0, 'no preset has been applied yet');
  only({ type: 'skyboxShape', shape: 'sphere' });
  assert.equal(run(project).variables.tick, 9);
  only({ type: 'skyboxShape', shape: 'box' });
  assert.equal(run(project).variables.tick, 0);
  only({ type: 'skyboxAnimating' });
  assert.equal(run(project).variables.tick, 0, 'the fixture sky is stopped');
  only({ type: 'skyboxSpeed', operator: '>=', value: 1 });
  assert.equal(run(project).variables.tick, 9);
  only({ type: 'skyboxSpeed', operator: '>', value: 1 });
  assert.equal(run(project).variables.tick, 0);

  // A preset applies on one step and the condition sees it on the next.
  project.events.length = 0;
  rule(project, [{ type: 'setSkyPreset', preset: 'Night' }]);
  rule(project, [{ type: 'setVariable', variable: 'tick', value: 3 }], { type: 'skyboxPreset', preset: 'Night' });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 60, new Set());
  assert.equal(state.variables.tick, 3);
});

test('the sky the level starts with survives a save and a load', () => {
  const project = fixture();
  rule(project, [{ type: 'setSkyPreset', preset: 'preset_night' }, { type: 'startSkyAnimation' }]);
  validateProject(project);
  const state = createRuntime(project);
  for (let frame = 0; frame < 6; frame++) stepRuntime(project, state, .05, new Set());
  assert.ok(state.skyClock > 0, 'the sky clock is running before the save');
  const { runtime } = restoreGameSave(project, captureGameSave(project, state, 'sky-test'), 'sky-test');
  assert.equal(runtime.skybox.layers[0].assetId, 'sky_clouds');
  assert.equal(runtime.skybox.presetName, 'Night');
  assert.equal(runtime.skyClock, state.skyClock);
});
