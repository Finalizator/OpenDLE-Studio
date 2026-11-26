#!/usr/bin/env node
/**
 * Builds the engine documentation site.
 *
 * The documentation is one site with two kinds of page. The hand-written pages are the project's
 * own markdown (`README.md`, `Docs/*.md`); the generated ones are read from the source every time
 * this runs — every shared and server module with its exported functions, and every event
 * condition and action with its fields. A generated page cannot fall behind the code, which is what
 * makes "as full as possible" something that stays true instead of something that was true once.
 *
 * Output goes to `public/docs/`, which the studio already serves, so the site is at `/docs/` with no
 * route to add. No dependencies: the markdown renderer below covers what the project's docs use.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONDITIONS, ENGINE_ACTIONS } from '../shared/engine-script.js';

const root = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------

export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

/** A heading anchor that survives punctuation and repeats. */
export function slug(text, taken = new Set()) {
  const base = String(text).toLowerCase().replace(/`/g, '').replace(/[^\w\s-]/g, '').trim()
    .replace(/\s+/g, '-').slice(0, 60) || 'section';
  let candidate = base, index = 2;
  while (taken.has(candidate)) candidate = `${base}-${index++}`;
  taken.add(candidate);
  return candidate;
}

const escapeAttribute = value => escapeHtml(value).replace(/`/g, '&#96;');

/** Inline markdown: code spans first, so nothing inside them is touched again. */
export function inline(text) {
  const codes = [];
  let html = String(text).replace(/`([^`]+)`/g, (match, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = escapeHtml(html);
  // A link may point at another markdown page, which the site serves as `.html`.
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (match, alt, href, title) => `<img src="${linkTarget(href)}" alt="${alt}"${title ? ` title="${title}"` : ''}>`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (match, label, href, title) => `<a href="${linkTarget(href)}"${title ? ` title="${title}"` : ''}>${label}</a>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (match, index) => codes[Number(index)]);
}

/** A relative `.md` link becomes the page the site actually serves. */
export function linkTarget(href) {
  if (!href) return '#';
  if (/^(https?:|mailto:|#|data:)/.test(href)) return escapeAttribute(href);
  if (href.endsWith('.md')) return escapeAttribute(href.slice(0, -3) + '.html');
  return escapeAttribute(href);
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;

/**
 * Markdown to HTML, with the table of contents it produced.
 *
 * Deliberately small: the project's docs use headings, fenced code, tables, lists, quotes, rules,
 * links, images and inline emphasis, and this covers exactly those. Anything else is escaped text,
 * which is a readable page rather than a broken one.
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const html = [], toc = [], taken = new Set();
  let index = 0;

  const flushParagraph = buffer => {
    if (!buffer.length) return;
    html.push(`<p>${inline(buffer.join(' '))}</p>`);
    buffer.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1], language = fence[2];
      const body = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) body.push(lines[index++]);
      index++;
      html.push(`<pre${language ? ` class="language-${escapeAttribute(language)}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length, text = heading[2].trim();
      const id = slug(text, taken);
      toc.push({ level, text: text.replace(/`/g, ''), id });
      html.push(`<h${level} id="${id}">${inline(text)}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
      index++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html.push('<hr>'); index++; continue; }

    // A table: a header row, then a delimiter row of dashes and colons.
    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1])) {
      const split = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
      const head = split(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) rows.push(split(lines[index++]));
      html.push('<div class="table-wrap"><table><thead><tr>'
        + head.map(cell => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(row => `<tr>${head.map((unused, column) => `<td>${inline(row[column] || '')}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) body.push(lines[index++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(body.join('\n')).html}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
        let text = lines[index++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        // A wrapped item continues on the indented lines under it.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[index]))
          text += ` ${lines[index++].trim()}`;
        items.push(`<li>${inline(text)}</li>`);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (!line.trim()) { index++; continue; }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !FENCE.test(lines[index]) && !/^#{1,6}\s/.test(lines[index])
      && !/^\s*>/.test(lines[index]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[index])) paragraph.push(lines[index++].trim());
    flushParagraph(paragraph);
  }
  return { html: html.join('\n'), toc };
}

// ---------------------------------------------------------------------------------------------------
// Generated pages
// ---------------------------------------------------------------------------------------------------

const summaryOf = jsdoc => {
  if (!jsdoc) return '';
  const body = jsdoc
    .replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
    .split('\n').map(line => line.replace(/^\s*\*\s?/, '').trimEnd()).join('\n');
  const prose = body.split(/\n\s*@/)[0].trim();
  return prose.split(/\n\s*\n/)[0].replace(/\n/g, ' ').trim();
};

/**
 * Every exported symbol of a module, with the doc comment above it.
 *
 * Read with a line scan rather than a parser: the project's modules are plain ES modules, and what
 * a reference needs is the export list and what each one is for, not an AST.
 */
export function exportedSymbols(source) {
  const lines = String(source).split('\n');
  const symbols = [];
  let doc = null, pending = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('/**')) {
      // A one-line comment (`/** An async one. */`) closes on the line it opens.
      if (trimmed.endsWith('*/') && trimmed.length > 4) { doc = trimmed; pending = []; } else pending = [trimmed];
    } else if (pending.length) {
      pending.push(trimmed);
      if (trimmed.endsWith('*/')) { doc = pending.join('\n'); pending = []; }
    }
    const match = trimmed.match(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/);
    if (!match) continue;
    symbols.push({ name: match[1], args: (match[2] || '').replace(/\s+/g, ' '), summary: summaryOf(doc) });
    doc = null;
  }
  return symbols;
}

export function moduleReference(files) {
  const pages = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const moduleDoc = summaryOf((source.match(/^\/\*\*[\s\S]*?\*\//) || [])[0]);
    const symbols = exportedSymbols(source);
    // A module without exports is still a module: `public/app.js` is the editor itself, and a
    // reference that silently skips the biggest file in the project is not a reference.
    if (!symbols.length && !moduleDoc && !source.trim()) continue;
    pages.push({ name: relative(root, file), moduleDoc, symbols });
  }
  return pages.sort((a, b) => a.name.localeCompare(b.name));
}

const fieldList = fields => (fields || []).map(field =>
  `${field.name}${field.kind === 'number' ? ` (${field.min}–${field.max})` : field.options ? ` (${field.options.map(option => Array.isArray(option) ? option[0] : option).slice(0, 6).join(', ')}${field.options.length > 6 ? ', …' : ''})` : ''}`).join(', ');

// ---------------------------------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------------------------------

const CSS = `:root {
  color-scheme: dark;
  --bg: #14161a; --panel: #1b1e24; --line: #2b303a; --text: #e6e9ef; --muted: #9aa3b2;
  --accent: #6fd3e0; --accent-dim: #2b6d76; --code: #10131a; --warn: #f0c274;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.65 "Segoe UI", system-ui, -apple-system, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top { position: sticky; top: 0; z-index: 5; display: flex; gap: 16px; align-items: center;
  padding: 12px 20px; background: rgba(20, 22, 26, .92); border-bottom: 1px solid var(--line);
  backdrop-filter: blur(8px); }
header.top strong { font-size: 15px; letter-spacing: .02em; }
header.top .version { color: var(--muted); font-size: 12px; }
header.top input { margin-left: auto; width: min(280px, 40vw); padding: 7px 12px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--code); color: var(--text); font: inherit; }
.layout { display: grid; grid-template-columns: 268px minmax(0, 1fr); min-height: calc(100vh - 54px); }
nav.side { border-right: 1px solid var(--line); padding: 18px 14px 40px; position: sticky; top: 54px;
  height: calc(100vh - 54px); overflow-y: auto; background: var(--panel); }
nav.side h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted);
  margin: 18px 10px 8px; }
nav.side a { display: block; padding: 6px 10px; border-radius: 7px; color: var(--text); font-size: 13.5px; }
nav.side a:hover { background: #232830; text-decoration: none; }
nav.side a.current { background: var(--accent-dim); color: #eafcff; }
nav.side .sub { padding-left: 20px; font-size: 12.5px; color: var(--muted); }
main { padding: 30px clamp(20px, 5vw, 64px) 90px; max-width: 1100px; }
main h1 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
main h2 { font-size: 21px; margin: 34px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
main h3 { font-size: 17px; margin: 26px 0 8px; }
main h4 { font-size: 15px; margin: 20px 0 6px; color: #cfd6e2; }
main p, main li { color: #d7dde7; }
main code { background: var(--code); border: 1px solid var(--line); border-radius: 5px;
  padding: 1px 5px; font: 13px/1.5 "Cascadia Code", ui-monospace, monospace; color: #cfe9ef; }
main pre { background: var(--code); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
  overflow-x: auto; }
main pre code { background: none; border: 0; padding: 0; color: #dfe7f2; }
main table { border-collapse: collapse; width: 100%; font-size: 14px; }
main th, main td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
main th { color: var(--muted); font-weight: 600; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; }
main tr:hover td { background: #1a1e25; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
.table-wrap table { min-width: 100%; }
main blockquote { margin: 14px 0; padding: 10px 16px; border-left: 3px solid var(--accent-dim);
  background: #1a1e24; border-radius: 0 8px 8px 0; color: #c9d2df; }
main hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
main img { max-width: 100%; border-radius: 10px; }
a.anchor { margin-left: 8px; color: var(--line); font-weight: 400; }
h1:hover a.anchor, h2:hover a.anchor, h3:hover a.anchor { color: var(--accent); }
.toc { margin: 10px 0 26px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.toc ol { margin: 6px 0 0; padding-left: 18px; }
.toc a { color: #cfe3ea; }
.lede { color: var(--muted); margin: 0 0 22px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line);
  font-size: 11.5px; color: var(--muted); margin-left: 6px; }
.symbol { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin: 10px 0; background: var(--panel); }
.symbol h4 { margin: 0 0 4px; font: 600 14px "Cascadia Code", ui-monospace, monospace; color: #dff0f5; }
.symbol p { margin: 0; color: #c4ccd8; font-size: 13.5px; }
footer { padding: 24px 0 0; color: var(--muted); font-size: 12.5px; border-top: 1px solid var(--line); margin-top: 40px; }
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  nav.side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
}`;

const JS = `// Filter the navigation as the reader types: the site is one directory, so the browser does the
// search and there is nothing to index on a server.
const search = document.getElementById('docs-search');
const links = [...document.querySelectorAll('nav.side a')];
search?.addEventListener('input', () => {
  const needle = search.value.trim().toLowerCase();
  let shown = 0;
  for (const link of links) {
    const match = !needle || link.textContent.toLowerCase().includes(needle) || (link.dataset.terms || '').includes(needle);
    link.hidden = !match;
    if (match) shown++;
  }
  document.getElementById('docs-empty').hidden = shown > 0;
});`;

function page({ title, body, toc, nav, current, version }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · OpenDLE engine docs</title>
<link rel="stylesheet" href="/docs/site.css">
</head>
<body>
<header class="top">
  <strong>OpenDLE engine docs</strong><span class="version">${escapeHtml(version)}</span>
  <input id="docs-search" type="search" placeholder="Filter pages…" aria-label="Filter pages">
</header>
<div class="layout">
<nav class="side" aria-label="Documentation">
${nav}
<p id="docs-empty" class="sub" hidden>No page matches that.</p>
</nav>
<main>
${toc && toc.length > 2 ? `<div class="toc"><strong>On this page</strong><ol>${toc.filter(entry => entry.level > 1 && entry.level < 4)
  .map(entry => `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a></li>`).join('')}</ol></div>` : ''}
${body}
<footer>Built by <code>npm run docs</code> from the markdown in <code>Docs/</code>, the module
comments in <code>shared/</code> and <code>server/</code>, and the event catalogue in
<code>shared/engine-script.js</code>.</footer>
</main>
</div>
<script src="/docs/site.js" defer></script>
</body>
</html>`;
}

function navHtml(pages, current) {
  const groups = new Map();
  for (const entry of pages) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  return [...groups.entries()].map(([group, entries]) => `<h2>${escapeHtml(group)}</h2>`
    + entries.map(entry => `<a href="/docs/${entry.slug}.html"${entry.slug === current ? ' class="current"' : ''}
      data-terms="${escapeAttribute(entry.terms || '')}">${escapeHtml(entry.title)}</a>`).join('')).join('\n');
}

function readEngineVersion() {
  try {
    const ini = readFileSync(join(root, 'version.ini'), 'utf8');
    return (ini.match(/^version\s*=\s*(\S+)/m) || [])[1] || '';
  } catch { return ''; }
}

/** Every source file the generated reference covers. */
export function referenceFiles(base = root) {
  const files = [];
  for (const folder of ['shared', 'server', 'public']) {
    const directory = join(base, folder);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) if (name.endsWith('.js')) files.push(join(directory, name));
  }
  return files.sort();
}

/**
 * Whether the generated site is older than something it was built from.
 *
 * The site used to be built once, when `public/docs` did not exist yet, so a doc page edited after
 * the first start — or any module whose comment the reference is read from — stayed stale on disk
 * for ever: the reader saw the documentation of some earlier build and had no way to tell.
 */
export function docsAreStale({ out = join(root, 'public', 'docs'), base = root, self = fileURLToPath(import.meta.url) } = {}) {
  const index = join(out, 'index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  const sources = [join(base, 'README.md'), join(base, 'version.ini'), self,
    ...readdirSync(join(base, 'Docs')).filter(name => name.endsWith('.md') && name !== 'handoff.md')
      .map(name => join(base, 'Docs', name)),
    ...referenceFiles(base)];
  for (const file of sources) {
    if (!existsSync(file)) continue;
    if (statSync(file).mtimeMs > built) return true;
  }
  return false;
}

export function buildDocs({ out = join(root, 'public', 'docs'), base = root, quiet = false } = {}) {
  const version = readEngineVersion();
  const pages = [];

  // Hand-written pages: the README first, then Docs, skipping this session's own handoff.
  const markdown = [join(base, 'README.md'),
    ...readdirSync(join(base, 'Docs')).filter(name => name.endsWith('.md') && name !== 'handoff.md')
      .sort().map(name => join(base, 'Docs', name))];
  for (const file of markdown) {
    if (!existsSync(file)) continue;
    const rendered = renderMarkdown(readFileSync(file, 'utf8'));
    const title = (readFileSync(file, 'utf8').match(/^#\s+(.+)$/m) || [])[1] || basename(file, '.md');
    pages.push({
      slug: basename(file, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      title: title.replace(/`/g, ''), group: 'Guides', body: rendered.html, toc: rendered.toc,
      // The README is a front page; its file name is not a title.
      ...(title === basename(file, '.md') ? { title: basename(file, '.md') === 'README' ? 'Overview' : title } : {}),
      source: relative(base, file),
    });
  }

  // Generated: every module and its exports.
  const modules = moduleReference(referenceFiles(base));
  const moduleHtml = [`<h1>Module reference</h1>`,
    `<p class="lede">Every module in <code>shared/</code> and <code>server/</code>, with the exports it
     offers and the comment above each one. Generated from the source by <code>npm run docs</code> —
     ${modules.length} modules, ${modules.reduce((sum, module) => sum + module.symbols.length, 0)} exports.</p>`,
    ...modules.map(module => `<h2 id="${slug(module.name)}"><code>${escapeHtml(module.name)}</code></h2>`
      + (module.moduleDoc ? `<p>${inline(module.moduleDoc)}</p>` : '')
      + (module.symbols.length ? '' : '<p class="muted">No exports: this module runs for its side effects.</p>')
      + module.symbols.map(symbol => `<div class="symbol"><h4>${escapeHtml(symbol.name)}${escapeHtml(symbol.args)}</h4>`
        + `<p>${symbol.summary ? inline(symbol.summary) : 'No comment yet.'}</p></div>`).join(''))];
  pages.push({ slug: 'modules', title: 'Module reference', group: 'Reference', body: moduleHtml.join('\n'), toc: [] });

  // Generated: the event catalogue, straight from the sheet's own definitions.
  const conditions = ENGINE_CONDITIONS, actions = ENGINE_ACTIONS;
  const catalogRow = command => `<tr><td><code>${escapeHtml(command.type)}</code></td>
    <td>${escapeHtml(command.label || '')}</td><td>${command.target ? 'object' : '—'}</td>
    <td>${escapeHtml(fieldList(command.fields)) || '—'}</td></tr>`;
  pages.push({
    slug: 'commands', title: 'Event catalogue', group: 'Reference', toc: [],
    body: [`<h1>Event catalogue</h1>`,
      `<p class="lede">Every condition and action the event sheet offers, with the fields each takes.
       Generated from <code>shared/engine-script.js</code>, so a command added to the engine appears
       here before anyone remembers to write about it.</p>`,
      `<h2 id="conditions">Conditions (${conditions.length})</h2>`,
      `<div class="table-wrap"><table><thead><tr><th>Type</th><th>What it asks</th><th>Target</th><th>Fields</th></tr></thead><tbody>`,
      ...conditions.map(catalogRow), '</tbody></table></div>',
      `<h2 id="actions">Actions (${actions.length})</h2>`,
      `<div class="table-wrap"><table><thead><tr><th>Type</th><th>What it does</th><th>Target</th><th>Fields</th></tr></thead><tbody>`,
      ...actions.map(catalogRow), '</tbody></table></div>'].join('\n'),
  });

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'site.css'), CSS);
  // The guides embed screenshots beside them, and the site serves pages from one directory:
  // copy the pictures across so a relative `src` still finds them.
  const docsDir = join(base, 'Docs');
  if (existsSync(docsDir)) for (const name of readdirSync(docsDir)) {
    if (/\.(png|jpe?g|webp|svg|gif)$/i.test(name)) copyFileSync(join(docsDir, name), join(out, name));
  }
  writeFileSync(join(out, 'site.js'), JS);
  const order = ['Guides', 'Reference'];
  pages.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.title.localeCompare(b.title));
  for (const entry of pages) {
    const nav = navHtml(pages, entry.slug);
    writeFileSync(join(out, `${entry.slug}.html`),
      page({ title: entry.title, body: entry.body, toc: entry.toc, nav, current: entry.slug, version }));
  }
  const nav = navHtml(pages, 'index');
  writeFileSync(join(out, 'index.html'), page({
    title: 'Engine documentation', nav, current: 'index', version, toc: [],
    body: [`<h1>OpenDLE engine documentation</h1>`,
      `<p class="lede">The engine as it is: how the pieces fit, what every module offers, and every
       event command it understands. The guides are written by hand; the reference pages are read
       from the source each time the site is built.</p>`,
      `<h2>Guides</h2><ul>${pages.filter(entry => entry.group === 'Guides')
        .map(entry => `<li><a href="/docs/${entry.slug}.html">${escapeHtml(entry.title)}</a></li>`).join('')}</ul>`,
      `<h2>Reference</h2><ul>${pages.filter(entry => entry.group === 'Reference')
        .map(entry => `<li><a href="/docs/${entry.slug}.html">${escapeHtml(entry.title)}</a></li>`).join('')}</ul>`,
      `<h2>How the engine is put together</h2>`,
      `<p><code>shared/</code> is the engine and is shared by the editor, the play view and an exported
       build: sectors and geometry, collision and the runtime, the event machine, actors and DECORATE,
       rendering helpers, saves, saves files and the material pipeline. <code>server/</code> is the
       studio's host: imports, project storage, exports, the map and texture readers, and the
       Electron window. <code>public/</code> is the browser: the editor, the play renderer, the game
       shell and the panels. Nothing in <code>shared/</code> reaches for the DOM, which is what lets
       a test drive the engine without a browser.</p>`].join('\n'),
  }));
  if (!quiet) {
    console.log(`Engine docs: ${pages.length + 1} pages in ${relative(root, out)}`);
  }
  return { pages: pages.map(entry => entry.slug), out };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) buildDocs();
