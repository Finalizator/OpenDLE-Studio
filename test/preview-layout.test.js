import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
  + readFileSync(new URL('../public/hud.css', import.meta.url), 'utf8');

test('the preview stage is the containing block for the HUD and the game message', () => {
  // The HUD overlay is absolutely positioned; without a positioned stage it was laid
  // out against the whole play dialog, which drew the status bar far below the game
  // view and made the HUD look missing.
  assert.match(css, /#preview-stage\s*\{[^}]*position:\s*relative/);
  const line = html.split('\n').find(text => text.includes('id="preview-stage"'));
  assert.ok(line, 'the stage exists');
  assert.match(line, /<canvas id="preview"/);
  assert.match(line, /id="hud-overlay"/);
  assert.match(line, /id="game-message"/);
  assert.match(css, /\.hud-overlay\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /#game-message\s*\{[^}]*position:\s*absolute/);
});

test('the preview toolbar keeps a one-click way back from a hidden status bar', () => {
  assert.match(html, /<button id="show-statusbar"[^>]*hidden/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function syncStatusBarButton\(\)/);
  assert.match(app, /\$\(&#39;show-statusbar&#39;\)|'show-statusbar'\).addEventListener/);
  assert.match(app, /changeSetting\(runtime, 'viewSize', 10\)/);
});
