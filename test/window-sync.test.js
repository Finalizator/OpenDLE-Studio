// One document in several windows: who owns which part of it, and how the two sides merge.
//
// The merge is the whole feature. If it is wrong, a wall drag in the main window erases the HUD
// change made on the second monitor, or a peer's panel writes back a section it never owned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_SECTIONS, conflictingSections, dialogWindowURL, mergeFromHub, mergeFromPeer,
  panelForSection, panelWindowURL, parseWindowView, sectionsForPanel } from '../shared/window-sync.js';

test('a URL decides whether a window is the hub or a detached panel', () => {
  assert.deepEqual(parseWindowView(''), { kind: 'main' });
  assert.deepEqual(parseWindowView('?'), { kind: 'main' });
  assert.deepEqual(parseWindowView('?view=terrain'), { kind: 'panel', panel: 'terrain' });
  assert.deepEqual(parseWindowView('?view=dialog&dialog=script-editor&args=%7B%22key%22%3A%22map%3A1%22%7D'),
    { kind: 'dialog', dialog: 'script-editor', args: '{"key":"map:1"}' });
});

test('a detached panel opens at a URL that says which panel it is', () => {
  assert.equal(panelWindowURL('http://127.0.0.1:3000/?view=hud&x=1', 'terrain'),
    'http://127.0.0.1:3000/?view=terrain');
  const dialog = new URL(dialogWindowURL('http://127.0.0.1:3000/', 'script-editor', { key: 'map:1' }));
  assert.equal(dialog.searchParams.get('view'), 'dialog');
  assert.equal(dialog.searchParams.get('dialog'), 'script-editor');
  assert.deepEqual(JSON.parse(dialog.searchParams.get('args')), { key: 'map:1' });
});

test('every editing tab declares what it owns, and nothing else', () => {
  assert.deepEqual(sectionsForPanel('hud'), PANEL_SECTIONS.hud);
  assert.ok(sectionsForPanel('hud').includes('hud'));
  assert.deepEqual(sectionsForPanel('logs'), [], 'a read-only tab owns nothing');
  assert.deepEqual(sectionsForPanel('not-a-tab'), []);
  assert.equal(panelForSection('mapScripts'), 'scripts');
});

test('the hub keeps its own sections when a peer commits', () => {
  const hub = { title: 'Campaign', map: { walls: ['main'] }, hud: { elements: ['old'] }, assets: ['shared'] };
  const peer = { title: 'Campaign', map: { walls: ['stale copy'] }, hud: { elements: ['from the second monitor'] },
    assets: ['shared'] };
  const merged = mergeFromPeer(hub, peer, ['hud', 'assets']);
  assert.deepEqual(merged.hud, { elements: ['from the second monitor'] }, 'the peer owns hud');
  assert.deepEqual(merged.assets, ['shared'], 'and the asset table it also owns');
  assert.deepEqual(merged.map, hub.map, 'the map was not the peer\'s to change');
  assert.equal(merged.title, 'Campaign');
});

test('a section the peer changed without owning it comes back to the hub\'s version', () => {
  const hub = { map: { walls: ['main'] }, hud: { elements: [] } };
  const peer = { map: { walls: ['changed by the hud window'] }, hud: { elements: ['x'] } };
  const merged = mergeFromPeer(hub, peer, ['hud']);
  assert.deepEqual(merged.map, hub.map);
  assert.deepEqual(merged.hud, peer.hud);
});

test('a field only the peer has is kept only when the peer owns it', () => {
  const hub = { hud: { elements: [] } };
  const merged = mergeFromPeer(hub, { hud: { elements: ['x'] }, privateDraft: 1 }, ['hud']);
  assert.equal(merged.privateDraft, undefined);
  const kept = mergeFromPeer(hub, { hud: { elements: ['x'] }, terrain: { size: 8 } }, ['hud', 'terrain']);
  assert.deepEqual(kept.terrain, { size: 8 });
});

test('a peer keeps its own section when the hub broadcasts', () => {
  const peer = { map: { walls: ['stale'] }, hud: { elements: ['mine'] } };
  const hub = { map: { walls: ['moved in the main window'] }, hud: { elements: ['older'] } };
  const merged = mergeFromHub(peer, hub, ['hud']);
  assert.deepEqual(merged.map, hub.map, 'the hub is the only writer of the map');
  assert.deepEqual(merged.hud, peer.hud, 'the peer keeps what it is editing');
});

test('one round trip leaves both windows showing the same document', () => {
  const hub = { map: { walls: ['a'] }, hud: { elements: ['a'] }, terrain: null };
  const peer = { map: { walls: ['a'] }, hud: { elements: ['b'] }, terrain: null };
  const atHub = mergeFromPeer(hub, peer, ['hud']);
  const atPeer = mergeFromHub(peer, atHub, ['hud']);
  assert.deepEqual(atPeer.hud, atHub.hud);
  assert.deepEqual(atPeer.map, atHub.map);
  // And again, with the hub having moved the map meanwhile: still the same document.
  const movedHub = { ...atHub, map: { walls: ['c'] } };
  const backAtPeer = mergeFromHub(atPeer, movedHub, ['hud']);
  const backAtHub = mergeFromPeer(movedHub, backAtPeer, ['hud']);
  assert.deepEqual(backAtPeer.map, { walls: ['c'] });
  assert.deepEqual(backAtPeer.hud, { elements: ['b'] });
  assert.deepEqual(backAtHub, backAtPeer);
});

test('a second editor for the same section is a conflict that can be refused', () => {
  // Panels that can import artwork share the asset table, which is the one section two windows may
  // both touch; the hub settles it by taking the last commit.
  assert.deepEqual(conflictingSections(sectionsForPanel('hud'), sectionsForPanel('terrain')), ['assets']);
  assert.deepEqual(conflictingSections(sectionsForPanel('hud'), sectionsForPanel('assets')), ['assets']);
  assert.deepEqual(conflictingSections(sectionsForPanel('scripts'), sectionsForPanel('terrain')), []);
  assert.deepEqual(conflictingSections(sectionsForPanel('actors'), sectionsForPanel('scene')), ['actors', 'assets']);
});
