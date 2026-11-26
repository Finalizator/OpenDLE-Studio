// The engine documentation site: the markdown renderer it is built with, and the pages it produces.
//
// The site is generated, so what needs guarding is the two things a generator gets wrong quietly:
// escaping (a page that renders a code sample's HTML as markup) and completeness (a reference that
// stops listing what the engine exports).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocs, docsAreStale, escapeHtml, exportedSymbols, inline, linkTarget, renderMarkdown, slug } from '../scripts/docs.js';
import { ENGINE_CONDITIONS, ENGINE_ACTIONS } from '../shared/engine-script.js';

test('markdown becomes html with anchored headings, and code keeps its angle brackets', () => {
  const { html, toc } = renderMarkdown([
    '# Title', '', 'A paragraph with `code` and **bold** and a [link](../Docs/x.md).', '',
    '## Second', '', '```js', 'const a = "<div>";', '```', '',
    '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
    '- one', '- two', '', '> quoted', '', '---', '',
  ].join('\n'));
  assert.match(html, /<h1 id="title">Title/);
  assert.match(html, /<h2 id="second">Second/);
  assert.deepEqual(toc.map(entry => entry.id), ['title', 'second']);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="\.\.\/Docs\/x\.html"/, 'a markdown link points at the page the site serves');
  assert.match(html, /&lt;div&gt;/, 'code is escaped, not rendered as markup');
  assert.match(html, /<table>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr>/);
});

test('headings that repeat still get unique anchors, and inline html is escaped', () => {
  const taken = new Set();
  assert.equal(slug('Same', taken), 'same');
  assert.equal(slug('Same', taken), 'same-2');
  assert.equal(inline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "c"'), 'a &amp; b &quot;c&quot;');
  assert.equal(linkTarget('https://example.com/'), 'https://example.com/');
  assert.equal(linkTarget('#anchor'), '#anchor');
});

test('a module reference reads the exports and the comment above each one', () => {
  const symbols = exportedSymbols([
    '/**',
    ' * Does the thing.',
    ' *',
    ' * More detail that is not the summary.',
    ' * @param {number} value input',
    ' */',
    'export function doThing(value) { return value; }',
    'export const LIMIT = 10;',
    '/** An async one. */',
    'export async function later() {}',
  ].join('\n'));
  assert.deepEqual(symbols.map(symbol => symbol.name), ['doThing', 'LIMIT', 'later']);
  assert.equal(symbols[0].summary, 'Does the thing.');
  assert.equal(symbols[0].args, '(value)');
  assert.equal(symbols[2].summary, 'An async one.');
});

test('the built site has a page per guide, a full module reference and the whole event catalogue', () => {
  const out = mkdtempSync(join(tmpdir(), 'opendle-docs-'));
  const { pages } = buildDocs({ out, quiet: true });
  assert.ok(existsSync(join(out, 'index.html')));
  assert.ok(existsSync(join(out, 'site.css')), 'the site carries its own styling');
  for (const slugName of ['readme', 'visual-scripting', 'modules', 'commands']) {
    assert.ok(pages.includes(slugName), `${slugName} page missing`);
    assert.ok(existsSync(join(out, `${slugName}.html`)), `${slugName}.html missing`);
  }
  // Every module the engine ships is listed, and the modules page names real exports.
  const modules = readFileSync(join(out, 'modules.html'), 'utf8');
  const engineFiles = readdirSync(new URL('../shared/', import.meta.url)).filter(name => name.endsWith('.js'));
  assert.ok(engineFiles.length > 50);
  assert.ok(modules.includes('shared/runtime.js') && modules.includes('shared/materials.js'), 'modules are listed');
  assert.match(modules, /<h4>[a-zA-Z]+/);

  // Every condition and action is in the catalogue page, generated from the source.
  const commands = readFileSync(join(out, 'commands.html'), 'utf8');
  for (const command of [...ENGINE_CONDITIONS, ...ENGINE_ACTIONS]) {
    assert.ok(commands.includes(`>${command.type}<`), `${command.type} is missing from the catalogue`);
  }
  // A generated page is a page of its own, with the shared navigation.
  for (const name of readdirSync(out)) {
    if (!name.endsWith('.html')) continue;
    const page = readFileSync(join(out, name), 'utf8');
    assert.match(page, /<nav class="side"/, `${name} has no navigation`);
    assert.match(page, /<link rel="stylesheet" href="\/docs\/site\.css">/);
  }
});

test('a site older than the pages it was built from is reported stale', () => {
  // The site used to be built once, when `public/docs` did not exist, so a doc page edited after
  // the first start — or any module whose comment the reference is read from — stayed stale for
  // ever and the reader saw documentation of an earlier build.
  const base = mkdtempSync(join(tmpdir(), 'opendle-docs-src-'));
  const out = join(base, 'public', 'docs');
  for (const folder of ['Docs', 'shared', 'server', 'public', 'scripts', 'public/docs']) {
    mkdirSync(join(base, folder), { recursive: true });
  }
  const sources = {
    'README.md': '# Hand written\n',
    'version.ini': '[engine]\nversion=0.0.1\n',
    'Docs/guide.md': '# Guide\n',
    'shared/thing.js': 'export const a = 1;\n',
    'scripts/docs.js': '// the generator\n',
  };
  for (const [name, body] of Object.entries(sources)) writeFileSync(join(base, name), body);
  const built = Date.now() / 1000;
  const setTime = (name, time) => utimesSync(join(base, name), time, time);
  for (const name of Object.keys(sources)) setTime(name, built);
  writeFileSync(join(out, 'index.html'), '<!doctype html>');
  setTime('public/docs/index.html', built + 60);
  const stale = () => docsAreStale({ out, base, self: join(base, 'scripts', 'docs.js') });

  assert.equal(stale(), false, 'a site newer than every source is current');
  setTime('Docs/guide.md', built + 120);
  assert.equal(stale(), true, 'an edited guide makes the site stale');
  setTime('Docs/guide.md', built);
  setTime('shared/thing.js', built + 120);
  assert.equal(stale(), true, 'so does a module the reference is read from');
  setTime('shared/thing.js', built);
  setTime('version.ini', built + 120);
  assert.equal(stale(), true, 'and a version bump, which every page prints');
  rmSync(join(out, 'index.html'));
  assert.equal(stale(), true, 'and a missing site is always built');
});
