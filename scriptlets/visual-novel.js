import { findScriptletSheet, installScriptletRules, removeScriptletSheet, scriptletRuleCount } from '../shared/scriptlets.js';
import { hudElement, installDefaultHUD, removeHUDElements, MAIN_HUD_SCREEN } from '../shared/hud.js';
import { ZONE_AREA } from '../shared/areas.js';
import { LIMITS } from '../shared/limits.js';

export const VISUAL_NOVEL_SHEET = 'Visual novel (dialogue)';
const ID = 'visual-novel';

/**
 * Two HUD screens, so the demo is a real dialogue rather than one box that never changes: walking
 * into the zone swaps the game HUD for the first line, "Continue" swaps one screen for the other —
 * which is the feature this scriptlet exists to demonstrate — and "Leave" puts the game HUD back.
 */
export const VN_SCREENS = [
  { id: 'hud_screen_vn_intro', name: 'Visual novel: intro' },
  { id: 'hud_screen_vn_reply', name: 'Visual novel: reply' },
];

/** Unique id helper: elements and screens share the project's id space with everything else. */
function allocator(project) {
  const used = new Set([
    ...['vertices', 'walls', 'sectors', 'entities'].flatMap(key => (project.map?.[key] || []).map(item => item.id)),
    ...['assets', 'spriteClips', 'shaders', 'eventSheets', 'eventGroups', 'timesheets', 'paths'].flatMap(key => (project[key] || []).map(item => item.id)),
    ...['elements', 'fonts', 'animations'].flatMap(key => (project.hud?.[key] || []).map(item => item.id)),
    ...(project.hud?.screens || []).map(screen => screen.id),
    ...(project.events || []).map(event => event.id),
  ]);
  return base => {
    let value = base, suffix = 1;
    while (used.has(value)) value = `${base}_${suffix++}`;
    used.add(value);
    return value;
  };
}

/** The elements of one dialogue screen: a dim, a box, a speaker, a line and one button. */
function screenElements(allocate, { screenId, speaker, line, button, buttonAction }) {
  const make = (name, type, props) => {
    const element = { ...hudElement(allocate(`hud_vn_${screenId.replace('hud_screen_vn_', '')}_${type}`), type, name), screenId, ...props };
    return element;
  };
  // The dim covers the world so the dialogue reads; the box is where the words are; the button is
  // the only interactive element, which is what `hudClicked` is allowed to point at.
  return [
    make('Dim', 'panel', { anchors: { left: 0, top: 0, right: 1, bottom: 1 }, x: 0, y: 0, width: 0, height: 0,
      background: '#05070ad9', z: 60 }),
    make('Dialogue box', 'panel', { anchors: { left: 0, top: 1, right: 1, bottom: 1 }, x: 48, y: -196, width: -96, height: 168,
      background: '#11161ef2', z: 61 }),
    make('Speaker', 'text', { anchors: { left: 0, top: 1, right: 1, bottom: 1 }, x: 76, y: -184, width: -152, height: 28,
      text: speaker, fontSize: 20, align: 'left', color: '#f0c987', z: 62 }),
    make('Line', 'text', { anchors: { left: 0, top: 1, right: 1, bottom: 1 }, x: 76, y: -146, width: -152, height: 84,
      text: line, fontSize: 18, align: 'left', color: '#e9eef5', z: 62 }),
    make(button, 'button', { anchors: { left: 1, top: 1, right: 1, bottom: 1 }, x: -196, y: -52, width: 150, height: 36,
      text: button, fontSize: 16, z: 63, ...buttonAction }),
  ];
}

/**
 * Installs a small visual-novel interface into a project that already has a HUD.
 *
 * It is ordinary content: two HUD screens (so the elements can be restyled like any others), a zone
 * object you can move wherever you like, and three editable rules on one engine sheet. Nothing is
 * hidden in code, and removing the scriptlet removes all of it.
 */
export function installVisualNovelScriptlet(project, { zoneOffset = 160 } = {}) {
  // Asking for the sheet first is what keeps a project with two candidate sheets untouched: this
  // throws before a single edit, which is the contract every scriptlet follows.
  findScriptletSheet(project, VISUAL_NOVEL_SHEET, ID);
  // A dialogue screen is part of the HUD, so a project without one gets the editable game HUD
  // installed rather than being told to go and find it: there would be nothing for the dialogue to
  // stand in front of, or to give the screen back to afterwards.
  if (!project.hud) installDefaultHUD(project);
  if ((project.hud.elements || []).length + 10 > 512)
    throw new Error('The HUD is full: the visual novel needs ten more elements.');
  if (!Number.isSafeInteger(zoneOffset) || zoneOffset < 0) throw new Error('Visual novel zone offset must be a nonnegative integer');

  // Reinstalling replaces what this scriptlet made rather than adding a second copy of it — the
  // zone included, or a reinstall would leave the old trigger standing next to the new one.
  removeVisualNovelScreens(project);
  if (project.visualNovelZone) {
    project.map.entities = project.map.entities.filter(entity => entity.id !== project.visualNovelZone);
    delete project.visualNovelZone;
  }
  const allocate = allocator(project);
  project.hud.screens ||= [];
  const screens = VN_SCREENS.map(screen => ({ ...screen, id: allocate(screen.id) }));
  project.hud.screens.push(...screens);
  const [introScreen, replyScreen] = screens;

  const intro = screenElements(allocate, {
    screenId: introScreen.id,
    speaker: 'Guide',
    line: 'You found the quiet room. Nothing here wants to kill you — which, in this place, is worth remarking on.',
    button: 'Continue',
  });
  const reply = screenElements(allocate, {
    screenId: replyScreen.id,
    speaker: 'Guide',
    line: 'That is what a HUD screen is for: a whole interface switched on by one event. Swap this text, add buttons, make it a shop.',
    button: 'Leave',
  });
  project.hud.elements.push(...intro, ...reply);
  project.visualNovelElements = [...intro, ...reply].map(element => element.id);
  project.visualNovelScreens = screens.map(screen => screen.id);

  // A place to walk into. It is offset from the player start so entering it is something the player
  // does, not something that happens on the first frame.
  const start = (project.map.entities || []).find(entity => entity.type === 'player') || { x: 0, y: 0, angle: 0 };
  const radians = (Number(start.angle) || 0) * Math.PI / 180;
  const zone = { id: allocate('vn_zone'), type: 'zone', name: 'Visual novel trigger', angle: 0,
    x: Math.round(start.x + Math.cos(radians) * zoneOffset),
    y: Math.round(start.y + Math.sin(radians) * zoneOffset),
    area: { ...ZONE_AREA, width: 128, height: 160, depth: 128 } };
  if (project.map.entities.length >= LIMITS.entities) throw new Error(`The map already holds ${LIMITS.entities} objects`);
  project.map.entities.push(zone);
  project.visualNovelZone = zone.id;

  const introButton = intro.find(element => element.type === 'button');
  const replyButton = reply.find(element => element.type === 'button');
  return installScriptletRules(project, { id: ID, name: VISUAL_NOVEL_SHEET, sheetId: 'engine_visual_novel' }, [
    { id: 'engine_vn_enter', name: 'visual_novel_enter',
      condition: { type: 'playerEnteredZone', zoneId: zone.id }, conditions: [],
      actions: [
        // The game HUD steps aside, the dialogue screen arrives: one event, one whole interface.
        { type: 'showHudScreen', screen: MAIN_HUD_SCREEN, mode: 'hide' },
        { type: 'showHudScreen', screen: introScreen.id, mode: 'show' },
        { type: 'setHUDCursor', mode: 'cursor' },
      ] },
    { id: 'engine_vn_continue', name: 'visual_novel_continue',
      condition: { type: 'hudClicked', elementId: introButton.id }, conditions: [],
      actions: [
        { type: 'showHudScreen', screen: introScreen.id, mode: 'hide' },
        { type: 'showHudScreen', screen: replyScreen.id, mode: 'show' },
      ] },
    { id: 'engine_vn_leave', name: 'visual_novel_leave',
      condition: { type: 'hudClicked', elementId: replyButton.id }, conditions: [],
      actions: [
        { type: 'showHudScreen', screen: replyScreen.id, mode: 'hide' },
        { type: 'showHudScreen', screen: MAIN_HUD_SCREEN, mode: 'show' },
        { type: 'setHUDCursor', mode: 'game' },
      ] },
  ]);
}

/** Drops the screens this scriptlet added, and the elements on them. */
function removeVisualNovelScreens(project) {
  const screens = new Set(project.visualNovelScreens || []);
  if (!screens.size) return;
  const elements = (project.hud?.elements || []).filter(element => screens.has(element.screenId));
  if (elements.length) removeHUDElements(project, elements.map(element => element.id));
  project.hud.screens = (project.hud?.screens || []).filter(screen => !screens.has(screen.id));
  delete project.visualNovelScreens;
  delete project.visualNovelElements;
}

export function removeVisualNovel(project) {
  const removed = removeScriptletSheet(project, VISUAL_NOVEL_SHEET, ID);
  removeVisualNovelScreens(project);
  if (project.visualNovelZone) {
    project.map.entities = project.map.entities.filter(entity => entity.id !== project.visualNovelZone);
    delete project.visualNovelZone;
  }
  return removed;
}

export default {
  id: ID,
  name: 'Visual novel (dialogue screens)',
  summary: 'Walk into a zone and a dialogue interface takes over, with a second line behind a button.',
  detail: 'Adds two HUD screens (a dim, a dialogue box, a speaker, a line and a button each), a zone object '
    + 'in front of the player start, and one engine sheet with three editable rules: entering the zone hides '
    + 'the game HUD and shows the first screen, clicking Continue swaps it for the second, and clicking Leave '
    + 'restores the game HUD and the cursor. Move the zone, restyle the elements in the HUD designer, and edit '
    + 'the lines in the rules — the "HUD: show / hide a HUD screen" action is the whole mechanism, so the '
    + 'same sheet can drive a shop, a cutscene or a menu. Needs a project that already has a HUD.',
  rules: 3,
  install(project) {
    return installVisualNovelScriptlet(project);
  },
  remove: removeVisualNovel,
  installed(project) { return scriptletRuleCount(project, VISUAL_NOVEL_SHEET, ID); },
  present(project) { return Boolean(findScriptletSheet(project, VISUAL_NOVEL_SHEET, ID)) || Boolean((project.visualNovelScreens || []).length); },
};
