// The README is the shop window, and a picture that moved or was renamed is a broken shop window.
// These keep the screenshots, the tool that takes them, and the pages that show them in step.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shotNames } from '../tools/automation/screenshots.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(join(root, name), 'utf8');
/** Every image a page or guide points at, as paths relative to the repository root. */
const referenced = text => [...text.matchAll(/\]\((\.\/)?([^)\s]+\.png)\)/gi)].map(match => match[2]);

test('every picture the README shows exists and is a real screenshot', () => {
  const images = referenced(read('README.md'));
  assert.ok(images.length >= 8, `the README shows ${images.length} pictures`);
  for (const image of images) {
    const path = join(root, image);
    assert.ok(existsSync(path), `${image} is missing`);
    assert.ok(statSync(path).size > 20000, `${image} is too small to be a screenshot`);
  }
});

test('the screenshot tool takes the pictures the README shows', () => {
  const images = new Set(referenced(read('README.md')).map(image => image.replace(/^.*\//, '')));
  for (const name of shotNames()) {
    assert.ok(images.has(`${name}.png`), `tools/automation/screenshots.mjs takes ${name}.png but the README does not show it`);
  }
});

test('no screenshot in Docs/ is orphaned', () => {
  const pages = ['README.md', ...readdirSync(join(root, 'Docs')).filter(name => name.endsWith('.md'))
    .map(name => join('Docs', name))];
  const shown = new Set(pages.flatMap(page => referenced(read(page)))
    .filter(image => image.includes('Docs/') || !image.includes('/'))
    .map(image => image.replace(/^.*\//, '')));
  for (const file of readdirSync(join(root, 'Docs')).filter(name => name.endsWith('.png'))) {
    assert.ok(shown.has(file), `Docs/${file} is not shown anywhere; add it to a guide or delete it`);
  }
});

test('the screenshot tool cannot replace a picture on its own', () => {
  const source = readFileSync(join(root, 'tools', 'automation', 'screenshots.mjs'), 'utf8');
  // The README's pictures are hand-picked. A capture run wrote into Docs/ and replaced the
  // author's own screenshots twice; the tool must not be able to do that again.
  assert.match(source, /outDir = join\(root, 'data', 'screenshots'\)/, 'captures land outside Docs/');
  assert.match(source, /existsSync\(file\) && !force/, 'an existing picture is left alone');
  assert.doesNotMatch(source, /outDir = join\(root, 'Docs'\)/);
});
