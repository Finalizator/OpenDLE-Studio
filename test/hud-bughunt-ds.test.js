import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { hudElement, hudBinding } from '../shared/hud.js';
import { captureGameSave } from '../shared/save-game.js';

// Minimal editable HUD with one target element and one authored animation.
function fixture() {
  const project = installEngineScripts(createProject(), { includeHUD: false });
  const element = hudElement('hud_target', 'text', 'Target');
  project.hud = { width: 800, height: 450, scaleMode: 'fit', fonts: [], elements: [element], animations: [] };
  project.eventSheets.push({ id: 'hud_iface', name: 'Interface', section: 'game', phase: 'interface', enabled: true });
  const afterPhysics = project.eventSheets.find(sheet => sheet.phase === 'afterPhysics').id;
  const rule = (name, sheetId, condition, actions) => project.events.push({
    id: name, name, sheetId, enabled: true, once: false, condition, actions,
  });
  return { project, element, rule, afterPhysics };
}

test('hud bughunt: a finished game-phase animation is observed by interface rules once, even while paused', () => {
  const { project, element, rule, afterPhysics } = fixture();
  const clip = { id: 'clip', name: 'Clip', duration: .01, loop: false, autoPlay: false,
    tracks: [{ elementId: element.id, property: 'opacity', easing: 'linear',
      keys: [{ time: 0, value: 0 }, { time: .01, value: 1 }] }] };
  project.hud.animations.push(clip);
  rule('start', 'hud_iface', { type: 'onStart' }, [{ type: 'playHUDAnimation', animationId: clip.id }]);
  // The moment the clip completes, gameplay pauses (the completion pauses the game).
  rule('pause', afterPhysics, { type: 'hudAnimationFinished', animationId: clip.id },
    [{ type: 'setGameScreen', screen: 'pause' }]);
  // An interface observer counts how many times the completion is seen.
  rule('watch', 'hud_iface', { type: 'hudAnimationFinished', animationId: clip.id },
    [{ type: 'addVariable', variable: 'score', value: 1 }]);
  validateProject(project);
  const state = createRuntime(project);
  for (let i = 0; i < 10; i++) stepRuntime(project, state, .05, new Set());
  assert.equal(state.gameScreen, 'pause');
  assert.equal(state.variables.score, 1, 'one completion must be observed once, not replayed every paused frame');
});

test('hud bughunt: the controller readout reads its HUD state and a connected pad does not break game saves', () => {
  const project = installEngineScripts(createProject());
  const state = createRuntime(project);
  stepRuntime(project, state, .05, new Set());
  // setControllerStatus writes both: the HUD-owned mirror, and a host transient on the state.
  state.hudState.controller = 'Pad A';
  state.controllerStatus = 'Pad B';
  assert.equal(hudBinding('game:controller', state), 'Pad A', 'the binding reads its own HUD field, not the transient');
  assert.doesNotThrow(() => captureGameSave(project, state, 'identity-x'),
    'a connected controller must not make the save unloadable');
});
