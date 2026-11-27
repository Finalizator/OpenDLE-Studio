// One-shot driver for the editor window.
//
//   node tools/automation/drive.mjs eval:__opendle.state()
//   node tools/automation/drive.mjs click:#undo eval:__opendle.state()
//   node tools/automation/drive.mjs --attach 9333 eval:__opendle.ui.layout()
//
// Each step is `<command>:<argument>`; the results are printed as one JSON object, so a caller
// reads a few hundred bytes instead of a page dump. Steps run in order and the first failure stops
// the run, which makes a single line self-explanatory.
//
// Commands:
//   eval:<js>                 evaluate in the page and return the value
//   wait-js:<expression>      wait until truthy
//   wait:<ms>                 sleep
//   click:<selector|ref>      DOM click
//   click-text:<text>         click the first element whose text matches
//   set:<selector>=<value>    set an input / select value and fire input+change
//   check:<selector>=<bool>   set a checkbox
//   key:<Code>                synthetic key press on the focused element
//   drag:<x1>,<y1>,<x2>,<y2>  real mouse drag (CSS pixels)
//   right-click:<x>,<y>       real right click, which is how the context menus open
//   move:<x>,<y>              real mouse move
//   ui:<selector>             describe matching elements
//   menu                      describe the open context menu
//   layout                    describe the chrome
//   tool:<name>               pick an editor tool
//   brush-mode:<object|face|vertex>
//   projection:<xy|xz|yz>
//   view:<2d|3d>
//   new                       blank document
//   shot:<path>               PNG screenshot written to disk
//
// Flags:
//   --port <n>        studio server port (default 3000)
//   --attach <port>   attach to an already running --automation-port window
//   --timeout <ms>    readiness timeout (default 60000)
//   --keep            leave the window running and print its CDP port (needs a terminal)
//   --allow-errors    do not fail the run when the page logged exceptions

import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';
import { withStudio, launchStudio } from './studio.mjs';

const argv = process.argv.slice(2);
const flags = { port: 3000, attach: null, timeout: 60000, keep: false, allowErrors: false };
const steps = [];
for (let index = 0; index < argv.length; index++) {
  const token = argv[index];
  if (token === '--port') flags.port = Number(argv[++index]);
  else if (token === '--attach') flags.attach = Number(argv[++index]);
  else if (token === '--timeout') flags.timeout = Number(argv[++index]);
  else if (token === '--keep') flags.keep = true;
  else if (token === '--allow-errors') flags.allowErrors = true;
  else if (token.startsWith('--')) { console.error(`Unknown flag ${token}`); process.exit(2); }
  else steps.push(token);
}

const wait = ms => new Promise(done => setTimeout(done, ms));

function parsePoint(argument, label) {
  const numbers = String(argument || '').split(',').map(Number);
  if (numbers.length < 2 || numbers.some(value => !Number.isFinite(value))) {
    throw new Error(`${label} needs x,y in CSS pixels`);
  }
  return numbers;
}

/** A point in CSS pixels, from `x,y` or from world coordinates written `w:x,y[,z]`. */
async function pointOf(page, text) {
  const source = String(text).trim();
  if (source.startsWith('w:')) {
    const [x, y, z = 0] = source.slice(2).split(',').map(Number);
    if (![x, y, z].every(Number.isFinite)) throw new Error(`bad world point "${source}"`);
    const point = await page.evaluate(`window.__opendle.worldToScreen(${x}, ${y}, ${z})`);
    if (!point) throw new Error(`world point ${source} is not in the current view`);
    return { x: point.x, y: point.y };
  }
  const [x, y] = source.split(',').map(Number);
  if (![x, y].every(Number.isFinite)) throw new Error(`bad point "${source}"`);
  return { x, y };
}

async function runStep(page, step) {
  const split = step.indexOf(':');
  const command = split < 0 ? step : step.slice(0, split);
  const argument = split < 0 ? '' : step.slice(split + 1);
  switch (command) {
    case 'eval': return page.evaluate(argument);
    case 'wait-js': return page.waitFor(argument, { timeout: flags.timeout, label: argument });
    case 'wait': await wait(Number(argument) || 0); return null;
    case 'click': return page.evaluate(`window.__opendle.ui.click(${JSON.stringify(argument)})`);
    case 'click-text': return page.evaluate(`window.__opendle.ui.click(window.__opendle.ui.find(${JSON.stringify(argument)}))`);
    case 'set': {
      const equals = argument.indexOf('=');
      if (equals < 0) throw new Error('set needs <selector>=<value>');
      const selector = argument.slice(0, equals), value = argument.slice(equals + 1);
      return page.evaluate(`window.__opendle.ui.set(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
    }
    case 'check': {
      const equals = argument.indexOf('=');
      const selector = equals < 0 ? argument : argument.slice(0, equals);
      const value = equals < 0 ? true : argument.slice(equals + 1) !== 'false';
      return page.evaluate(`window.__opendle.ui.check(${JSON.stringify(selector)}, ${Boolean(value)})`);
    }
    case 'key': return page.evaluate(`window.__opendle.ui.press(${JSON.stringify(argument)})`);
    case 'drag': {
      // Pixels: `drag:10,20,60,20`. World: `drag:w:-160,-96|w:96,96` — the page converts, so a
      // caller never has to reproduce the camera maths.
      // `null` here would be destructured, which throws: a pixel drag has no `|` at all.
      const [from, to] = argument.includes('|') ? argument.split('|') : [];
      const numbers = from ? null : parsePoint(argument, 'drag');
      const start = from ? await pointOf(page, from) : { x: numbers[0], y: numbers[1] };
      const end = to ? await pointOf(page, to) : { x: numbers[2], y: numbers[3] };
      await page.drag(start, end);
      return { dragged: [start, end] };
    }
    case 'right-click': {
      const at = await pointOf(page, argument);
      await page.rightClick(at.x, at.y);
      return { rightClicked: [at.x, at.y] };
    }
    case 'move': {
      const [x, y] = parsePoint(argument, 'move');
      await page.move(x, y);
      return null;
    }
    case 'ui': return page.evaluate(`window.__opendle.ui.describe(${JSON.stringify(argument)})`);
    case 'menu': return page.evaluate('window.__opendle.ui.menu()');
    case 'layout': return page.evaluate('window.__opendle.ui.layout()');
    case 'tool': return page.evaluate(`window.__opendle.tool(${JSON.stringify(argument)})`);
    case 'brush-mode': return page.evaluate(`window.__opendle.brushMode(${JSON.stringify(argument)})`);
    case 'projection': return page.evaluate(`window.__opendle.projection(${JSON.stringify(argument)})`);
    case 'view': return page.evaluate(`window.__opendle.view(${JSON.stringify(argument)})`);
    case 'new': return page.evaluate('window.__opendle.newDocument()');
    case 'shot': {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(argument, Buffer.from(data, 'base64'));
      return { screenshot: argument, bytes: Buffer.byteLength(data, 'base64') };
    }
    default: throw new Error(`Unknown step "${step}"`);
  }
}

async function drive(page) {
  const results = [];
  for (const step of steps) {
    try {
      results.push({ step, result: await runStep(page, step) });
    } catch (error) {
      throw Object.assign(new Error(`${step}: ${error.message}`), { results });
    }
  }
  const errors = await page.evaluate('window.__opendle.errors()');
  return { results, errors };
}

const started = Date.now();
try {
  if (flags.attach) {
    const page = await connect(flags.attach, { timeout: flags.timeout });
    await page.waitFor('typeof window.__opendle === "object"', { timeout: flags.timeout, label: 'automation hooks' });
    await page.waitFor('window.__opendle.ready()', { timeout: flags.timeout, label: 'the editor' });
    const { results, errors } = await drive(page);
    page.close();
    console.log(JSON.stringify({ ok: true, seconds: (Date.now() - started) / 1000, cdpPort: flags.attach,
      steps: results, ...(errors.length ? { pageErrors: errors } : {}) }));
    if (errors.length && !flags.allowErrors) process.exitCode = 1;
  } else if (flags.keep) {
    const studio = await launchStudio({ port: flags.port, timeout: flags.timeout });
    console.log(JSON.stringify({ ok: true, cdpPort: studio.cdpPort, profile: studio.profile,
      hint: `re-run with --attach ${studio.cdpPort}` }));
    await new Promise(() => {});
  } else {
    const { results, errors } = await withStudio({ port: flags.port, timeout: flags.timeout },
      ({ page }) => drive(page));
    console.log(JSON.stringify({ ok: true, seconds: (Date.now() - started) / 1000, steps: results,
      ...(errors.length ? { pageErrors: errors } : {}) }));
    if (errors.length && !flags.allowErrors) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, seconds: (Date.now() - started) / 1000,
    error: String(error.message || error).split('\n')[0],
    steps: error.results || [], detail: String(error.message || error).split('\n').slice(1, 6) }));
  process.exitCode = 1;
}
