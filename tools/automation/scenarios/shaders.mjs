// The shader library, driven the way a mapper meets it.
//
// The engine's shaders are folders under `shaders/` now — one shader per folder, full-screen ones
// under `shaders/on_screen/`. What has to stay true is that the studio *lists them from there*, that
// applying one copies it into the project rather than pointing at the file, and that a full-screen
// shader is offered in the Shaders tab and never in a brush's list.
const wait = ms => new Promise(done => setTimeout(done, ms));

export async function run({ page }) {
  const steps = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };
  const evaluate = expression => page.evaluate(expression);

  await evaluate('window.__opendle.newDocument()');
  await wait(400);

  // ---------- The library itself, as the studio received it.
  const library = await evaluate(`(async () => {
    const session = await fetch('/api/session').then(response => response.json());
    const response = await fetch('/api/shaders', { headers: { authorization: 'Bearer ' + session.token } });
    return response.json();
  })()`);
  check('the library lists shaders read from folders', Array.isArray(library.shaders) && library.shaders.length >= 2,
    library.shaders?.map(entry => entry.folder));
  check('every folder reads cleanly', (library.problems || []).length === 0, library.problems);
  const surface = (library.shaders || []).filter(entry => entry.kind === 'surface');
  const screen = (library.shaders || []).filter(entry => entry.kind === 'screen');
  check('a surface shader and a full-screen shader ship', surface.length > 0 && screen.length > 0,
    { surface: surface.map(entry => entry.folder), screen: screen.map(entry => entry.folder) });
  check('the full-screen one lives in on_screen/', screen.every(entry => entry.folder.startsWith('on_screen/')),
    screen.map(entry => entry.folder));
  check('each entry carries its source and its dials',
    library.shaders.every(entry => typeof entry.source === 'string' && entry.source.length > 20 && entry.uniforms && typeof entry.uniforms === 'object'));

  // ---------- A surface shader is offered on a brush, and applying it copies it in.
  await evaluate('window.__opendle.projection("xy")');
  await evaluate('window.__opendle.tool("room")');
  const rect = await evaluate('(() => { const r = document.querySelector("#map").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()');
  await page.drag({ x: rect.x + rect.w * 0.3, y: rect.y + rect.h * 0.3 }, { x: rect.x + rect.w * 0.6, y: rect.y + rect.h * 0.55 }, { steps: 8 });
  await wait(400);
  await evaluate('window.__opendle.tool("select")');
  const options = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#inspector label')].find(label => label.textContent.startsWith('Brush shader'));
    return row ? [...row.querySelector('select').options].map(option => ({ value: option.value, text: option.textContent })) : [];
  })()`);
  const fromLibrary = options.filter(option => option.value.startsWith('library:'));
  check('the brush lists the library\'s surface shaders', fromLibrary.length === surface.length,
    { offered: fromLibrary.map(option => option.text), library: surface.map(entry => entry.name) });
  check('and not the full-screen ones', !fromLibrary.some(option => screen.some(entry => option.text === entry.name)),
    fromLibrary.map(option => option.text));
  const starters = (library.shaders || []).filter(entry => entry.starter);
  check('nor the starters, which are templates rather than looks',
    starters.length > 0 && !fromLibrary.some(option => starters.some(entry => option.text === entry.name)),
    { starters: starters.map(entry => entry.name), offered: fromLibrary.map(option => option.text) });

  const chosen = fromLibrary[0];
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#inspector label')].find(label => label.textContent.startsWith('Brush shader'));
    const select = row.querySelector('select');
    select.value = ${JSON.stringify(chosen.value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await wait(400);
  const applied = await evaluate(`(() => {
    const brushes = window.__opendle.brushes();
    return brushes.map(brush => brush.shaderId);
  })()`);
  check('applying it points the brush at a shader', applied.some(id => id && !id.startsWith('library:')), applied);

  // ---------- A full-screen shader is offered in the Shaders tab.
  await evaluate(`(() => { const tab = [...document.querySelectorAll('button')].find(button => button.textContent === 'Shaders'); tab?.click(); })()`);
  await wait(600);
  const tabText = await evaluate('document.querySelector("#shader-engine")?.innerText || ""');
  check('the Shaders tab lists the library\'s full-screen shaders',
    screen.every(entry => tabText.includes(entry.name)), screen.map(entry => entry.name));
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('#shader-engine button')].find(item => item.textContent === ${JSON.stringify(screen[0].name)});
    button?.click();
  })()`);
  await wait(500);
  // The proof that it landed: the Environment tab's world-effect picker now names a project copy.
  await evaluate(`(() => { const tab = [...document.querySelectorAll('button')].find(button => button.textContent === 'Environment'); tab?.click(); })()`);
  await wait(600);
  const worldShader = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#environment-form label')].find(label => label.textContent.startsWith('World shader'));
    return row ? row.querySelector('select').value : '';
  })()`);
  check('and applying one gives the frame an effect', Boolean(worldShader), worldShader);
  check('the studio stayed alive', (await evaluate('window.__opendle.errors()')).length === 0,
    await evaluate('window.__opendle.errors()'));

  return { steps };
}
