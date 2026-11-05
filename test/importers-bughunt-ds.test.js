import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecorate, resolveActorInheritance, compileActorStates } from '../shared/decorate.js';
import { parseModelDefs, modelForFrame } from '../shared/modeldef.js';
import { parseLanguage } from '../shared/language.js';
import { parseDehacked } from '../shared/dehacked.js';

function decorateActor(text) {
  const resolved = resolveActorInheritance(parseDecorate(text).actors);
  const actor = resolved.actors.get('Foo');
  assert.ok(actor, 'test actor should resolve');
  return actor;
}

test('importer 01: DECORATE goto Label+offset keeps the frame offset', () => {
  const actor = decorateActor(`actor Foo {
    States {
    Spawn:
      TROO A 3
      TROO B 3
      TROO C 3
      TROO D 3
      goto Spawn+2
      stop
    }
  }`);
  const compiled = compileActorStates(actor, {});
  const jump = compiled.frames.find(frame => frame.kind === 'goto');
  assert.ok(jump, 'the goto frame is compiled');
  // `goto Spawn+2` lands two frames after the start of Spawn, i.e. on frame C (index 2).
  assert.equal(jump.targetIndex, 2);
});

test('importer 01b: DECORATE goto preserves a scoped label and its offset', () => {
  const resolved = resolveActorInheritance(parseDecorate(`actor Base {
    States {
    Spawn:
      TROO A 3
      TROO B 3
      TROO C 3
      stop
    }
  }
  actor Foo : Base {
    States {
    Spawn:
      goto Super::Spawn+1
      stop
    }
  }`).actors);
  const actor = resolved.actors.get('Foo');
  const compiled = compileActorStates(actor, { parentLookup: name => resolved.actors.get(name) });
  const jump = compiled.frames.find(frame => frame.kind === 'goto');
  assert.equal(jump.target, 'Super::Spawn+1');
  // Super::Spawn+1 lands on the second frame of the parent's Spawn sequence (TROO B).
  const superStart = compiled.labels.get('Super::Spawn');
  assert.equal(jump.targetIndex, superStart + 1);
  assert.equal(compiled.frames[jump.targetIndex].letter, 'B');
});

test('importer 02: MODELDEF FrameIndex reads model index then frame number', () => {
  const [definition] = parseModelDefs([`Model Icon {
    Model 0 "icon.obj"
    FrameIndex ICNC A 0 0
    FrameIndex ICNC B 0 1
    FrameIndex ICNC C 0 2
  }`]);
  // FrameIndex <sprite> <letter> <model index> <frame number>: B uses model 0, frame 1.
  const b = definition.frames.find(frame => `${frame.sprite}${frame.letter}` === 'ICNCB');
  assert.deepEqual({ model: b.model, frame: b.frame }, { model: 0, frame: 1 });
  // modelForFrame must resolve the mesh for every declared frame, not just the first.
  assert.equal(modelForFrame(definition, 'ICNC', 'B')?.file, 'icon.obj');
  assert.equal(modelForFrame(definition, 'ICNC', 'C')?.file, 'icon.obj');
});

test('importer 03: LANGUAGE decodes \\xNN hex escapes like GZDoom', () => {
  const strings = parseLanguage('[enu]\nA = "line\\x0Abreak";\nB = "\\x41";');
  assert.equal(strings.A, 'line\nbreak');
  assert.equal(strings.B, 'A');
});

test('importer 03b: LANGUAGE keeps unknown escapes and existing escapes intact', () => {
  const strings = parseLanguage('[enu]\nA = "tab\\tquote\\"slash\\\\";');
  assert.equal(strings.A, 'tab\tquote"slash\\');
});

test('importer 04: DEHACKED keeps an inline # inside a string value', () => {
  const patch = parseDehacked('Patch File for DeHackEd v3.0\n[STRINGS]\nHUSTR_1 = Entry #1\n# a full-line comment\nHUSTR_2 = Two\n');
  assert.equal(patch.strings.HUSTR_1, 'Entry #1');
  assert.equal(patch.strings.HUSTR_2, 'Two');
  assert.equal('HUSTR_comment' in patch.strings, false);
});
