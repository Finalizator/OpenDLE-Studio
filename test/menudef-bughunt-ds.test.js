import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { installGameMenu } from '../shared/game-menu.js';

/**
 * MENUDEF / KEYCONF importer audit (DeepSeek batch).
 *
 * Every case below is grounded in GZDoom behaviour (src/common/menu/menudef.cpp
 * and wadsrc/static/menudef.txt): user-visible menu text uses `$KEYWORD` language
 * references that are resolved against the project LANGUAGE table, and `Font`
 * accepts "Untranslated" as a valid "leave the artwork alone" colour.
 */

test('MENUDEF $ keyword labels resolve against the project language table', () => {
  const p = installEngineScripts(createProject());
  p.strings = {
    OPTMNU_TITLE: 'Options', MNU_NEWGAME: 'New Game', TXT_DISPLAY: 'Display options',
    MNU_ALWAYSRUN: 'Always run', MNU_SFXVOL: 'Sound volume', MNU_FORWARD: 'Move forward',
  };
  const source = [
    'OptionMenu "OptionsMenu"',
    '{',
    '  Title "$OPTMNU_TITLE"',
    '  Submenu "$MNU_NEWGAME", "NewGameMenu"',
    '  StaticText "$TXT_DISPLAY"',
    '  Option "$MNU_ALWAYSRUN", "cl_run", "On", "Off"',
    '  Slider "$MNU_SFXVOL", "snd_sfxvolume", 0, 1, 0.1',
    '  Control "$MNU_FORWARD", "+forward"',
    '}',
    'ListMenu "MainMenu"',
    '{',
    '  TextItem "$MNU_NEWGAME", "n", "SkillMenu"',
    '}',
  ].join('\n');
  installGameMenu(p, null, [{ name: 'MENUDEF', source }]);
  const heading = p.hud.elements.find(item => item.name === 'OptionsMenu heading');
  assert.equal(heading.text, 'Options');
  for (const text of ['New Game', 'Display options', 'Always run', 'Sound volume']) {
    assert.ok(p.hud.elements.some(item => item.text === text), `menu shows resolved "${text}"`);
  }
  // The control row appends its live binding readout after the label.
  assert.ok(p.hud.elements.some(item => typeof item.text === 'string' && item.text.startsWith('Move forward')), 'control row shows resolved label');
  // The raw keywords must never leak into the HUD.
  assert.equal(p.hud.elements.some(item => typeof item.text === 'string' && item.text.includes('$')), false);
  validateProject(p);
});

test('"Untranslated" is a valid MENUDEF font colour and is not reported as unknown', () => {
  const p = installEngineScripts(createProject());
  const warnings = [];
  const source = 'ListMenu "MainMenu"\n{\n\tFont "BigFont", "Untranslated"\n\tTextItem "A", "a", "SkillMenu"\n}';
  installGameMenu(p, { has: () => false, get: () => null, atlas: null, font: () => null },
    [{ name: 'MENUDEF', source }], warnings);
  assert.equal(warnings.some(w => /not a known translation/.test(w)), false, 'Untranslated must not warn');
  // A genuinely unknown colour is still diagnosed.
  const p2 = installEngineScripts(createProject());
  const warnings2 = [];
  installGameMenu(p2, { has: () => false, get: () => null, atlas: null, font: () => null },
    [{ name: 'MENUDEF', source: 'ListMenu "MainMenu"\n{\n\tFont "BigFont", "Pink"\n\tTextItem "A", "a", "SkillMenu"\n}' }],
    warnings2);
  assert.ok(warnings2.some(w => /font colour Pink is not a known translation/.test(w)), 'unknown colour still diagnosed');
});
