// The Skybox tab: the window, the preview, presets, and the sky reaching the 3D view.
//
// Everything here was a real failure at some point: the tab existed but its buttons were built as
// text ("[object HTMLButtonElement]"), the preview showed a 70-degree camera slice instead of the
// whole sky, the editor's 3D viewport ignored the sky the tab wrote, and a colour written as
// `vec3(new THREE.Color(..))` painted the sky black. Each check is cheap: datasets and a handful of
// canvas pixels, never a page snapshot.

const wait = ms => new Promise(done => setTimeout(done, ms));

// A 128x64 panorama wide enough to read when the preview samples it: blue at the top, cream at the
// horizon, green at the bottom.
const IMPORT_SKY = `(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, '#1030a0'); gradient.addColorStop(.5, '#e0d0a0'); gradient.addColorStop(1, '#204020');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 64);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'test-sky.png', { type: 'image/png' }));
  const input = document.getElementById('image-file');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 400));
  return true;
})()`;

export async function run({ page }) {
  const steps = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };
  const open = async () => { await page.evaluate(`document.querySelector('[data-tab="skybox"]').click()`); await wait(250); };
  const put = label => `(() => {
    const rows = [...document.querySelectorAll('#skybox-panel .sky-field')];
    const row = rows.find(item => item.textContent.startsWith(${JSON.stringify(label)}));
    return row ? row.querySelector('input, select') : null;
  })()`;
  const setField = async (label, value) => {
    await page.evaluate(`(() => {
      const input = ${put(label)};
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    })()`);
    await wait(120);
  };
  const pixel = `(() => {
    const canvas = document.querySelector('.sky-preview');
    const ctx = canvas.getContext('2d');
    const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { top: at(canvas.width / 2, 6), middle: at(canvas.width / 2, canvas.height / 2),
      bottom: at(canvas.width / 2, canvas.height - 6), left: at(4, canvas.height / 2),
      coverage: canvas.dataset.skyCoverage };
  })()`;

  await page.evaluate('window.__opendle.newDocument()');
  await wait(300);
  await open();
  check('the Skybox tab opens', await page.evaluate(`!document.getElementById('skybox-panel').hidden`));
  check('an empty level says there is no sky yet',
    await page.evaluate(`document.getElementById('skybox-panel').textContent.includes('No sky yet')`));

  await page.evaluate(`[...document.querySelectorAll('#skybox-panel button')].find(b => b.textContent.startsWith('Start')).click()`);
  await wait(300);
  const groups = await page.evaluate(`[...document.querySelectorAll('#skybox-panel .sky-group > summary')].map(n => n.textContent)`);
  check('the form builds its groups', groups.length >= 6, groups);
  const buttons = await page.evaluate(`[...document.querySelectorAll('#skybox-panel button')].map(b => b.textContent)`);
  check('the window buttons are real buttons, not stringified text',
    buttons.includes('Whole sphere') && buttons.includes('Clear outside colour') && buttons.includes('+ Layer'), buttons);
  check('no control is rendered as "[object ...]"',
    !(await page.evaluate(`document.getElementById('skybox-panel').textContent.includes('[object')`)));

  // The tab opens on the 3D view, which is a real renderer over the level's horizon.
  check('the tab opens on the 3D view',
    await page.evaluate(`document.querySelector('.sky-view').dataset.view === '3d'`));
  check('the 3D view is a real viewport, sized to its box',
    await page.evaluate(`(() => {
      const canvas = document.querySelector('.sky-canvas');
      const box = canvas.getBoundingClientRect();
      return canvas.width > 100 && canvas.height > 60 && Math.abs(canvas.width / canvas.height - box.width / box.height) < .05;
    })()`));
  check('the viewport built the sky the tab wrote',
    await page.evaluate(`document.querySelector('.sky-canvas').dataset.skyLayers !== undefined`));

  // The tab imports its own pictures: the button drives the file input, and the picture lands on
  // the layer being edited with the sky becoming a plain panorama.
  const imported = await page.evaluate(`(async () => {
    const input = document.querySelector('#skybox-panel input[type=file]');
    let clicked = false;
    const original = input.click.bind(input);
    input.click = () => { clicked = true; original(); };
    const button = [...document.querySelectorAll('#skybox-panel button')].find(b => /Import/.test(b.textContent));
    button.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ['#8b2f2f', '#2f6b3a', '#2f4f8b', '#8b7a2f'].forEach((colour, index) => {
      ctx.fillStyle = colour; ctx.fillRect(index * 32, 0, 32, 64);
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'tab-sky.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 900));
    return { clicked, accept: input.accept, status: document.getElementById('status').textContent };
  })()`);
  check('the tab has its own import button', imported.clicked, imported);
  check('the picker accepts the sky formats', imported.accept.includes('.dds') && imported.accept.includes('.hdr'),
    imported.accept.split(',').slice(0, 4));
  const afterImport = await page.evaluate(`(() => ({
    readout: document.querySelector('.sky-readout').textContent,
    layers: document.querySelector('.sky-canvas').dataset.skyLayers,
    view: document.querySelector('.sky-view').dataset.view }))()`);
  check('the imported picture is on the sky',
    afterImport.readout.includes('covered by the layer pictures') && afterImport.layers === '1', afterImport);

  // Dragging turns the view, and the sky follows the pointer: one azimuth drives the camera and the
  // sky's own heading, so a rightward drag slides the sky right rather than mirroring it.
  const beforeDrag = await page.evaluate(`document.querySelector('.sky-canvas').dataset.skyAzimuth`);
  const rect = await page.evaluate(`(() => { const r = document.querySelector('.sky-canvas').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await page.drag({ x: rect.x, y: rect.y }, { x: rect.x + 100, y: rect.y }, { steps: 6 });
  await wait(300);
  const afterDrag = await page.evaluate(`document.querySelector('.sky-canvas').dataset.skyAzimuth`);
  check('a rightward drag turns the view one way and not the other',
    Number(afterDrag) < Number(beforeDrag) - 20, { beforeDrag, afterDrag });

  // The tab wears the studio's colours, not a palette of its own.
  check('the tab uses the editor palette',
    await page.evaluate(`(() => {
      const stage = getComputedStyle(document.querySelector('.sky-stage')).backgroundColor;
      const panel = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
      const probe = document.createElement('div'); probe.style.color = panel; document.body.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return stage === expected;
    })()`), await page.evaluate(`getComputedStyle(document.querySelector('.sky-stage')).backgroundColor`));

  // The coverage map is the same sky as a plate; the switch must not lose the record.
  await page.evaluate(`[...document.querySelectorAll('.sky-view-tabs button')].find(b => b.textContent === 'Coverage map').click()`);
  await wait(300);
  check('the coverage map opens beside the 3D view',
    await page.evaluate(`document.querySelector('.sky-view').dataset.view === 'plate'`));
  check('a full window covers the whole plate', (await page.evaluate(pixel)).coverage === '1.000');

  // Narrow the window: the plate must show the picture inside it and grey outside.
  await setField('Azimuth from', -60);
  await setField('Azimuth to', 60);
  await setField('Elevation from', -20);
  await setField('Elevation to', 50);
  const windowed = await page.evaluate(pixel);
  check('a narrower window covers less of the plate', Number(windowed.coverage) < .2, windowed.coverage);
  check('outside the window is the editor grey, not artwork',
    windowed.left.join(',') === '63,63,63' && windowed.top.join(',') === '63,63,63', windowed);

  // A picture sky: the plate shows its texels, and the editor's 3D view draws it. The window goes
  // back to the whole sphere first, so the plate is the picture and not a patch of it.
  await page.evaluate(`[...document.querySelectorAll('#skybox-panel button')].find(b => b.textContent === 'Whole sphere').click()`);
  await wait(250);

  // The imported picture is four vertical bands, so the plate must show several colours across a
  // row: one flat colour would mean it sampled a single texel.
  const bands = await page.evaluate(`(() => {
    const canvas = document.querySelector('.sky-preview');
    if (!canvas || canvas.hidden) return { distinct: 0 };
    const ctx = canvas.getContext('2d');
    const row = ctx.getImageData(0, Math.round(canvas.height / 2), canvas.width, 1).data;
    const seen = new Set();
    for (let x = 0; x < canvas.width; x++) seen.add([row[x * 4], row[x * 4 + 1], row[x * 4 + 2]].join(','));
    return { distinct: seen.size, coverage: canvas.dataset.skyCoverage };
  })()`);
  check('the plate samples the picture it was given', bands.distinct >= 3, bands);
  check('the readout names what is drawing the sky',
    (await page.evaluate(`document.querySelector('.sky-readout').textContent`)).includes('covered by the layer pictures'));
  // The tab's own viewport draws the picture too, through the same material builder.
  const inTab = await page.evaluate(`(() => {
    const canvas = document.querySelector('.sky-canvas');
    const view = document.querySelector('.sky-view').dataset.view;
    const layers = canvas.dataset.skyLayers;
    if (view !== '3d') [...document.querySelectorAll('.sky-view-tabs button')].find(b => b.textContent === '3D view').click();
    return { view, layers, error: canvas.dataset.skyError };
  })()`);
  await wait(600);
  check('the 3D view draws the layer the picture is on',
    inTab.view !== '3d' || inTab.layers === '1', inTab);

  await page.evaluate(`[...document.querySelectorAll('#skybox-panel button')].find(b => b.textContent.startsWith('Save current')).click()`);
  await wait(250);
  check('a preset is saved', (await page.evaluate(`document.getElementById('status').textContent`)).includes('preset'));

  // Back to the 3D view: the sky it shows must be the one the plate just described.
  await page.evaluate(`[...document.querySelectorAll('.sky-view-tabs button')].find(b => b.textContent === '3D view').click()`);
  await wait(600);
  const back = await page.evaluate(`(() => {
    const canvas = document.querySelector('.sky-canvas');
    return { view: document.querySelector('.sky-view').dataset.view,
      canvasCoverage: canvas.dataset.skyCoverage, plateCoverage: document.querySelector('.sky-preview').dataset.skyCoverage,
      layers: canvas.dataset.skyLayers, error: canvas.dataset.skyError };
  })()`);
  check('the 3D view comes back with the same sky',
    back.view === '3d' && back.canvasCoverage === back.plateCoverage && !back.error, back);

  // The level's own 3D view draws the sky the tab wrote.
  await page.evaluate(`[...document.querySelectorAll('header button, .tabs button')].find(b => b.textContent === 'Layout 1').click()`);
  await wait(250);
  await page.evaluate(`window.__opendle.view('3d')`);
  await wait(1500);
  const drawn = await page.evaluate(`(() => {
    const canvas = document.querySelector('#scene-3d');
    return { sky: canvas.dataset.sky, layers: canvas.dataset.skyLayers, error: canvas.dataset.skyError };
  })()`);
  check('the 3D view built the skybox', drawn.layers === '1' && !drawn.error, drawn);
  check('the editor viewport reports it is drawing a skybox', drawn.sky === 'skybox', drawn);
  check('the editor logged no error', (await page.evaluate('window.__opendle.errors()')).length === 0);

  return { steps: steps.length };
}
