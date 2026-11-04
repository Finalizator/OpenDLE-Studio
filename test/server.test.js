import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { readEngineVersion } from '../server/version.js';
import { proposeChanges } from '../server/deepseek.js';
import { createProject, validateProject } from '../shared/project.js';
import { createScriptletRegistry } from '../shared/scriptlets.js';
import { normalizeAddon } from '../shared/addons.js';
import { toolDefinitions } from '../server/tools.js';
import { openLocalBrowser } from '../server/browser.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function fixture(t, options = {}) {
  const result = createApp({ store: new ProjectStore(), token: 'test-token', ...options });
  const server = result.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { ...result, url: `http://127.0.0.1:${server.address().port}` };
}
const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
test('scriptlet folder discovery reloads custom modules without registration or a server restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-scriptlets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scriptletsDir = join(directory, 'scriptlets');
  mkdirSync(scriptletsDir);
  symlinkSync(fileURLToPath(new URL('../shared/', import.meta.url)), join(directory, 'shared'), 'dir');
  const { url } = await fixture(t, { scriptletsDir });
  assert.equal((await fetch(`${url}/api/scriptlets`)).status, 401);
  assert.equal((await fetch(`${url}/api/scriptlets`, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  const readManifest = async () => {
    const response = await fetch(`${url}/api/scriptlets`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  assert.deepEqual(await readManifest(), { directory: 'scriptlets', files: [] });
  const readme = readFileSync(new URL('../scriptlets/README.md', import.meta.url), 'utf8');
  const example = readme.match(/```js\n([\s\S]*?)\n```/)[1];
  writeFileSync(join(scriptletsDir, 'greeting.mjs'), example);
  writeFileSync(join(scriptletsDir, 'README.md'), 'Not a module');
  writeFileSync(join(scriptletsDir, '_helper.js'), 'Not an entry');
  writeFileSync(join(scriptletsDir, '.hidden.js'), 'Not an entry');
  mkdirSync(join(scriptletsDir, 'nested.js'));
  symlinkSync(join(scriptletsDir, 'greeting.mjs'), join(scriptletsDir, 'linked.mjs'));
  const manifest = await readManifest();
  assert.deepEqual(manifest.files.map(file => file.name), ['greeting.mjs']);
  const moduleResponse = await fetch(`${url}${manifest.files[0].url}`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type'), /javascript/);
  assert.equal(moduleResponse.headers.get('cache-control'), 'no-cache');
  assert.equal(await moduleResponse.text(), example);
  const registry = createScriptletRegistry();
  const importLocal = moduleUrl => {
    const parsed = new URL(moduleUrl, url);
    const target = pathToFileURL(join(directory, decodeURIComponent(parsed.pathname.slice(1))));
    target.search = parsed.search;
    return import(target.href);
  };
  await registry.load(manifest.files, importLocal);
  assert.deepEqual(registry.errors, []);
  assert.equal(registry.scriptlets[0].id, 'custom-greeting');
  const project = createProject();
  project.eventSheets = [];
  const before = structuredClone(project);
  const sheetId = registry.installScriptlet(project, 'custom-greeting');
  validateProject(project);
  assert.equal(registry.scriptletById('custom-greeting').installed(project), 1);
  assert.equal(project.events.find(event => event.sheetId === sheetId).actions[0].message, 'Welcome to my game!');
  registry.installScriptlet(project, 'custom-greeting');
  assert.equal(project.events.filter(event => event.sheetId === sheetId).length, 1);
  assert.equal(registry.removeScriptlet(project, 'custom-greeting'), true);
  validateProject(project);
  assert.deepEqual(project, before);

  writeFileSync(join(scriptletsDir, 'greeting.mjs'), example.replace('Welcome to my game!', 'Updated greeting!'));
  const updated = await readManifest();
  assert.notEqual(updated.files[0].url, manifest.files[0].url, 'changed content bypasses the module cache');
  await registry.load(updated.files, importLocal);
  registry.installScriptlet(project, 'custom-greeting');
  assert.equal(project.events.at(-1).actions[0].message, 'Updated greeting!');
  validateProject(project);

  writeFileSync(join(scriptletsDir, 'broken.mjs'), 'export default {');
  writeFileSync(join(scriptletsDir, 'missing-import.mjs'), "import './does-not-exist.mjs';");
  writeFileSync(join(scriptletsDir, 'invalid.mjs'), 'export default {};');
  await registry.load((await readManifest()).files, importLocal);
  assert.equal(registry.scriptlets.length, 1, 'a broken custom file must not disable good files');
  assert.deepEqual(registry.errors.map(error => error.name), ['broken.mjs', 'invalid.mjs', 'missing-import.mjs']);
  assert.ok(registry.errors.every(error => error.message.length > 0));
  writeFileSync(join(scriptletsDir, 'broken.mjs'), example.replace("const ID = 'custom-greeting'", "const ID = 'repaired'"));
  await registry.load((await readManifest()).files, importLocal);
  assert.deepEqual(registry.scriptlets.map(scriptlet => scriptlet.id), ['repaired', 'custom-greeting'], 'corrected syntax errors can be retried');
  writeFileSync(join(scriptletsDir, 'duplicate.mjs'), example);
  await registry.load((await readManifest()).files, importLocal);
  assert.deepEqual(registry.scriptlets.map(scriptlet => scriptlet.id), ['repaired']);
  assert.deepEqual(registry.errors.filter(error => /Duplicate/.test(error.message)).map(error => error.name), ['duplicate.mjs', 'greeting.mjs']);
  for (const name of ['broken.mjs', 'missing-import.mjs', 'invalid.mjs', 'duplicate.mjs', 'greeting.mjs']) unlinkSync(join(scriptletsDir, name));
  await registry.load((await readManifest()).files, importLocal);
  assert.deepEqual(registry.scriptlets, []);
  assert.deepEqual(registry.errors, []);
  assert.equal(project.events.at(-1).actions[0].message, 'Updated greeting!', 'removing a module leaves saved events intact');
  validateProject(project);
});
test('scriptlet folder read failures are explicit errors, not an empty success manifest', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-scriptlets-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { url } = await fixture(t, { scriptletsDir: join(directory, 'missing') });
  const response = await fetch(`${url}/api/scriptlets`, { headers });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /ENOENT/);
});
test('standalone Studio launch is authenticated, origin-protected and uses only the bound editor URL', async t => {
  const opened = [];
  const { url } = await fixture(t, { openWindow: async target => opened.push(target) });
  assert.equal((await fetch(`${url}/api/open-window`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/api/open-window`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  const response = await fetch(`${url}/api/open-window`, { method: 'POST', headers, body: '{"url":"https://other.example/"}' });
  assert.equal(response.status, 200);
  assert.deepEqual(opened, [`${url}/`]);
  assert.deepEqual(await response.json(), { url: `${url}/` });
  const failed = await fixture(t, { openWindow: async () => { throw new Error('Studio runtime unavailable'); } });
  const failure = await fetch(`${failed.url}/api/open-window`, { method: 'POST', headers });
  assert.equal(failure.status, 400);
  assert.match((await failure.json()).error, /Studio runtime unavailable/);
});
test('browser and standalone launches share a busy guard that resets after completion', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { url } = await fixture(t, {
    openWindow: () => { started(); return new Promise(resolve => { finish = resolve; }); },
    openBrowser: async () => {},
  });
  const pending = fetch(`${url}/api/open-window`, { method: 'POST', headers });
  await ready;
  const concurrent = await fetch(`${url}/api/open-browser`, { method: 'POST', headers });
  assert.equal(concurrent.status, 429);
  finish();
  assert.equal((await pending).status, 200);
  assert.equal((await fetch(`${url}/api/open-browser`, { method: 'POST', headers })).status, 200);
});
test('store saves atomically, reloads and rejects stale revisions without changing the project', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-test-'));
  try {
    const file = join(directory, 'project.json'), store = new ProjectStore(file);
    const project = createProject(); project.title = 'Persistent world';
    assert.equal(store.update(project, 0).revision, 1);
    assert.equal(new ProjectStore(file).snapshot().project.title, 'Persistent world');
    assert.equal(new ProjectStore(file).snapshot().revision, 1);
    assert.throws(() => store.update(createProject(), 0), /another client/);
    assert.equal(store.snapshot().project.title, 'Persistent world');
    const snapshot = store.snapshot(); snapshot.project.title = 'mutated';
    assert.equal(store.snapshot().project.title, 'Persistent world');
  } finally { rmSync(directory, { recursive: true }); }
});
test('stored projects can be adopted, listed and opened over HTTP', async t => {
  const { url, store } = await fixture(t);
  assert.equal((await fetch(`${url}/api/projects`)).status, 401);
  const empty = await (await fetch(`${url}/api/projects`, { headers })).json();
  assert.deepEqual(empty, { active: null, projects: [] });
  // A document that came from an import: it gets its own project and becomes the open one.
  const imported = createProject(); imported.title = 'Imported WAD game';
  const adopted = await (await fetch(`${url}/api/project/adopt`, { method: 'POST', headers,
    body: JSON.stringify({ project: imported, title: imported.title }) })).json();
  assert.equal(adopted.projectId, 'imported-wad-game');
  assert.equal(adopted.revision, 1);
  const listed = await (await fetch(`${url}/api/projects`, { headers })).json();
  assert.deepEqual(listed.projects.map(entry => entry.id), ['imported-wad-game']);
  // Saving the open project keeps it as the active one.
  const saved = await (await fetch(`${url}/api/project`, { method: 'PUT', headers,
    body: JSON.stringify({ project: imported, revision: adopted.revision, projectId: adopted.projectId }) })).json();
  assert.equal(saved.projectId, 'imported-wad-game');
  assert.equal(saved.revision, 2);
  assert.equal((await fetch(`${url}/api/projects/open`, { method: 'POST', headers,
    body: JSON.stringify({ id: 'missing' }) })).status, 404);
  const reopened = await (await fetch(`${url}/api/projects/open`, { method: 'POST', headers,
    body: JSON.stringify({ id: 'imported-wad-game' }) })).json();
  assert.equal(reopened.project.title, 'Imported WAD game');
  assert.equal(store.snapshot().projectId, 'imported-wad-game');
  // An import is stored in the temporary slot and saving promotes it out of that slot.
  const temporary = await (await fetch(`${url}/api/project/adopt`, { method: 'POST', headers,
    body: JSON.stringify({ project: imported, title: imported.title, temporary: true }) })).json();
  assert.equal(temporary.projectId, 'temporary');
  assert.equal(temporary.temporary, true);
  const promoted = await (await fetch(`${url}/api/project`, { method: 'PUT', headers,
    body: JSON.stringify({ project: imported, revision: temporary.revision, projectId: temporary.projectId }) })).json();
  assert.equal(promoted.projectId, 'imported-wad-game-2');
  assert.equal(promoted.temporary, false);
  const afterSave = await (await fetch(`${url}/api/projects`, { headers })).json();
  assert.equal(afterSave.projects.some(entry => entry.id === 'temporary'), false);
});

test('HTTP saves require identity and refuse stale tabs even at matching revisions', async t => {
  const { url, store } = await fixture(t);
  const first = createProject(); first.title = 'First';
  const second = createProject(); second.title = 'Second';
  const tab = store.adopt(first);
  const active = store.adopt(second);
  assert.equal(tab.revision, active.revision);
  const write = body => fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const missing = await write({ project: tab.project, revision: tab.revision });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /missing project identity/);
  assert.equal((await write({ project: tab.project, revision: tab.revision, projectId: tab.projectId })).status, 409);
  assert.deepEqual(store.snapshot().project, active.project);
});

test('HTTP editor, auth, host/origin checks, invalid input and revision conflict', async t => {
  const { url } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200); assert.match(await page.text(), /<title>OpenDLE: Studio<\/title>/);
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.deepEqual(health, { service: 'OpenDLE', version: readEngineVersion(new URL('../version.ini', import.meta.url)) });
  const licenseResponse = await fetch(`${url}/api/license`);
  assert.equal(licenseResponse.status, 200);
  assert.equal(licenseResponse.headers.get('cache-control'), 'no-store');
  const license = await licenseResponse.json();
  assert.equal(license.id, 'opendle-studio-commercial-1.0');
  assert.equal(license.text, readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'));
  assert.match(license.sha256, /^[a-f0-9]{64}$/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url}/Ancestors/gzdoom-master/README.md`)).status, 404);
  assert.equal((await fetch(`${url}/api/project`)).status, 401);
  assert.equal((await fetch(`${url}/api/session`, { headers: { Origin: 'https://other.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/session`, { headers: { Host: 'other.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    test('one-click shell launcher refuses an in-process fixture and validates arguments', async t => {
      const { url } = await fixture(t);
      const launch = fileURLToPath(new URL('../launch.sh', import.meta.url));
      const env = { ...process.env, PORT: new URL(url).port };
      await assert.rejects(promisify(execFile)(launch, ['--no-browser'], { cwd: tmpdir(), env, timeout: 10000 }), /unrelated process/);
      await assert.rejects(promisify(execFile)(launch, ['--unknown'], { env, timeout: 10000 }), /Usage:/);
      await assert.rejects(promisify(execFile)(launch, ['--no-browser'], { env: { ...env, PORT: 'invalid' }, timeout: 10000 }), /PORT must be/);
    });
    test('launcher refuses a foreign service without opening it or terminating it', async t => {
      const server = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json'); res.end('{"service":"Other"}');
      }).listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      t.after(() => new Promise(resolve => server.close(resolve)));
      const port = server.address().port;
      await assert.rejects(promisify(execFile)(fileURLToPath(new URL('../launch.sh', import.meta.url)), ['--no-browser'],
        { env: { ...process.env, PORT: String(port) }, timeout: 10000 }), /occupied by another service/);
      assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
    });
    test('system-browser launch is authenticated, uses the bound loopback URL and reports failures', async t => {
      const opened = [];
      const { url } = await fixture(t, { openBrowser: async target => { opened.push(target); } });
      assert.equal((await fetch(`${url}/api/open-browser`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${url}/api/open-browser`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: '{}' })).status, 403);
      const response = await fetch(`${url}/api/open-browser`, { method: 'POST', headers, body: '{"url":"https://other.example"}' });
      assert.equal(response.status, 200);
      assert.deepEqual(opened, [`${url}/`]); assert.equal((await response.json()).url, `${url}/`);
      const failed = await fixture(t, { openBrowser: async () => { throw new Error('Browser could not open'); } });
      const failure = await fetch(`${failed.url}/api/open-browser`, { method: 'POST', headers, body: '{}' });
      assert.equal(failure.status, 400); assert.match((await failure.json()).error, /Browser could not open/);
      for (const target of ['https://example.com/', 'http://127.0.0.1:3000/path', 'http://127.0.0.1:3000/?arg=1']) {
        await assert.rejects(openLocalBrowser(target), /Only the local/);
      }
    });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await (await fetch(`${url}/api/session`)).json()).token, 'test-token');
  const snapshot = await (await fetch(`${url}/api/project`, { headers })).json();
  snapshot.project.title = 'Saved via HTTP';
  assert.equal((await fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify(snapshot) })).status, 200);
  assert.equal((await fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify(snapshot) })).status, 409);
  assert.equal((await fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify({ revision: 1, project: {} }) })).status, 400);
  const ai = await fetch(`${url}/api/ai`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'Add a room', revision: 1 }) });
  assert.equal(ai.status, 503);
  assert.match((await ai.json()).error, /not configured/);
});
test('real MCP client initializes, discovers tools/resources, edits and reports tool errors', async t => {
  const { url, store } = await fixture(t);
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-token' } } });
  const client = new Client({ name: 'OpenDLE-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), toolDefinitions.map(tool => tool.name).sort());
  assert.ok(listed.tools.some(tool => tool.name === 'events_add_rule'));
  const resources = await client.listResources();
  assert.equal(resources.resources[0].uri, 'opendle://project');
  const resource = await client.readResource({ uri: 'opendle://project' });
  assert.equal(JSON.parse(resource.contents[0].text).revision, 0);
  const result = await client.callTool({ name: 'project_set_title', arguments: { title: 'MCP world' } });
  assert.ok(!result.isError); assert.equal(store.snapshot().project.title, 'MCP world');
  assert.equal(store.snapshot().revision, 1);
  const failed = await client.callTool({ name: 'map_update_wall', arguments: { id: 'missing', height: 100 } });
  assert.equal(failed.isError, true);
  assert.equal(store.snapshot().revision, 1);
  const attached = await client.callTool({ name: 'events_add_rule', arguments: {
    ownerId: 'pickup', condition: { type: 'nearEntity', entityId: '$self', distance: 40 },
    conditions: [{ type: 'keyPressed', key: 'KeyE' }],
    actions: [{ type: 'rotateEntity', entityId: '$self', angle: 90 }],
  } });
  assert.ok(!attached.isError);
  assert.equal(store.snapshot().revision, 2);
  assert.equal(store.snapshot().project.events.at(-1).ownerId, 'pickup');
  assert.equal(store.snapshot().project.events.at(-1).conditions[0].key, 'KeyE');
  const sector = await client.callTool({ name: 'sector_update', arguments: { id: 'room0', light: 70, sky: true } });
  assert.ok(!sector.isError);
  assert.equal(store.snapshot().project.map.sectors[0].light, 70);
  const visuals = await client.callTool({ name: 'environment_set_visuals', arguments: { weaponAsset: null } });
  assert.ok(!visuals.isError);
  const physics = await client.callTool({ name: 'entity_set_physics', arguments: { id: 'pickup', body: 'dynamic', mass: 2 } });
  assert.ok(!physics.isError);
  assert.equal(store.snapshot().project.map.entities[1].physics.mass, 2);
  const contact = await client.callTool({ name: 'events_add_rule', arguments: {
    ownerId: 'pickup', condition: { type: 'collisionStarted', entityId: '$self', otherId: '$world' },
    actions: [{ type: 'applyImpulse', entityId: '$self', x: 0, y: 0, z: 2 }],
  } });
  assert.ok(!contact.isError);
  const hud = await client.callTool({ name: 'hud_element_add', arguments: { type: 'button', name: 'MCP HUD button' } });
  assert.ok(!hud.isError);
  const elementId = store.snapshot().project.hud.elements.at(-1).id;
  const hudRule = await client.callTool({ name: 'events_add_rule', arguments: {
    condition: { type: 'hudClicked', elementId }, actions: [{ type: 'setPlayerStat', stat: 'health', value: 75 }],
  } });
  assert.ok(!hudRule.isError);
  const css = await client.callTool({ name: 'hud_import_css', arguments: { css: '.mcp { border-radius: 5px; }' } });
  assert.ok(!css.isError);
  const snapshot = store.snapshot();
  const invalidHUD = await client.callTool({ name: 'hud_element_update', arguments: { id: elementId, properties: { assetId: 'missing' } } });
  assert.equal(invalidHUD.isError, true); assert.deepEqual(store.snapshot(), snapshot);
});
test('browser physics/addon modules resolve local dependencies with WASM and embedded-resource CSP permissions', async t => {
  const { url } = await fixture(t);
  const page = await fetch(url), csp = page.headers.get('content-security-policy');
  assert.match(csp, /'wasm-unsafe-eval'/); assert.match(csp, /connect-src 'self' data: blob:/);
  assert.match(csp, /font-src 'self' data:/);
  for (const module of ['loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js', 'environments/RoomEnvironment.js']) {
    const response = await fetch(`${url}/vendor/three-addons/${module}`);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    assert.doesNotMatch(source, /from 'three'/); assert.match(source, /\/vendor\/three\/three.module.js/);
  }
  assert.equal((await fetch(`${url}/vendor/rapier/rapier.mjs`)).status, 200);
  assert.equal((await fetch(`${url}/vendor/rapier/package.json`)).status, 404);
});
test('WAD library/import APIs are authenticated, bounded to WAD files and return unsaved asset drafts', { skip: !existsSync(new URL('../Projects/freedoom2.wad', import.meta.url)) }, async t => {
  const { url, store } = await fixture(t);
  assert.equal((await fetch(`${url}/api/wads`)).status, 401);
  const files = await (await fetch(`${url}/api/wads`, { headers })).json();
  assert.ok(files.files.includes('freedoom2.wad'));
  const maps = await (await fetch(`${url}/api/wads/freedoom2.wad/maps`, { headers })).json();
  assert.equal(maps.maps.length, 32);
  const response = await fetch(`${url}/api/import/local-wad`, { method: 'POST', headers, body: JSON.stringify({ name: 'freedoom2.wad', map: 'MAP01' }) });
  const draft = await response.json();
  assert.equal(response.status, 200);
  assert.equal(draft.project.game.levels.length, 32);
  assert.equal(draft.project.game.entry, 'MAP01');
  assert.ok(draft.project.game.levels.some(level => level.id === 'MAP32'));
  assert.equal(draft.project.map.sectors.length, 130);
  assert.ok(draft.project.assets.some(asset => asset.kind === 'weapon'));
  assert.equal(draft.project.playerControl, 'events');
  assert.ok(draft.project.assets.some(asset => asset.name === 'STBAR'));
  assert.ok(draft.project.hud.elements.some(element => element.name === 'Player face'));
  assert.equal(draft.project.hud.reserveBottom, 32);
  assert.equal(store.snapshot().revision, 0);
  assert.notEqual(store.snapshot().project.title, draft.project.title);
  const saved = await fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify({ project: draft.project, revision: 0, projectId: null }) });
  assert.equal(saved.status, 200);
  assert.equal(store.snapshot().project.assets.length, draft.project.assets.length);
  const uploaded = await fetch(`${url}/api/import/wad?map=MAP01&scope=level`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: readFileSync(new URL('../Projects/freedoom2.wad', import.meta.url)) });
  assert.equal(uploaded.status, 200);
  assert.deepEqual((await uploaded.json()).project.hud, draft.project.hud);
  assert.equal((await fetch(`${url}/api/import/local-wad`, { method: 'POST', headers, body: JSON.stringify({ name: '../freedoom2.wad', map: 'MAP01' }) })).status, 400);
  assert.equal((await fetch(`${url}/api/import/wad?map=MAP01`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) })).status, 400);
  assert.equal((await fetch(`${url}/Projects/freedoom2.wad`)).status, 404);
});
test('DeepSeek function loop returns a draft, not a mutation, and uses server-side auth', async () => {
  const project = createProject(); let calls = 0;
  const result = await proposeChanges({ project, prompt: 'Rename it', apiKey: 'provider-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer provider-key');
    const request = JSON.parse(options.body);
    assert.equal(request.tools.length, toolDefinitions.length);
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'project_set_title', arguments: '{"title":"AI draft"}' } }] }
      : { role: 'assistant', content: 'Renamed the project in a draft.' } }] }) };
  } });
  assert.equal(calls, 2); assert.equal(result.project.title, 'AI draft');
  assert.notEqual(project.title, 'AI draft'); assert.deepEqual(result.changes, ['project_set_title']);
});
test('DeepSeek tool errors are explicit and invalid changes never enter the draft', async () => {
  let calls = 0;
  const project = createProject();
  const result = await proposeChanges({ project, prompt: 'Invalid edit', apiKey: 'key', fetchImpl: async (url, options) => {
    calls++;
    if (calls === 2) assert.match(JSON.parse(options.body).messages.at(-1).content, /Unknown tool/);
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', tool_calls: [{ id: 'invalid', type: 'function', function: { name: 'execute_code', arguments: '{}' } }] }
      : { role: 'assistant', content: 'The tool rejected that edit.' } }] }) };
  } });
  assert.deepEqual(result.project, project); assert.deepEqual(result.changes, []);
});
test('DeepSeek HUD tools produce approved-only drafts using the same portable validation', async () => {
  let calls = 0;
  const project = createProject();
  const result = await proposeChanges({ project, prompt: 'Add the game HUD', apiKey: 'key', fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.ok(payload.tools.some(tool => tool.function.name === 'hud_set_layout'));
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', tool_calls: [{ id: 'hud-install', type: 'function', function: { name: 'hud_install_default', arguments: '{}' } }] }
      : { role: 'assistant', content: 'Added an editable HUD in the draft.' } }] }) };
  } });
  assert.ok(result.project.hud); assert.equal(project.hud, undefined);
  assert.deepEqual(result.changes, ['hud_install_default']);
});
test('DeepSeek can propose attached object scripts through the shared function schema', async () => {
  let calls = 0;
  const project = createProject();
  const args = {
    ownerId: 'pickup', condition: { type: 'always' }, conditions: [{ type: 'keyPressed', key: 'KeyF' }],
    actions: [{ type: 'setEntityPosition', entityId: '$self', x: 100, y: 50 }],
  };
  const draft = await proposeChanges({ project, prompt: 'Move this object when F is pressed', apiKey: 'key', fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    const schema = payload.tools.find(tool => tool.function.name === 'events_add_rule').function.parameters;
    assert.equal(schema.properties.ownerId.type, 'string');
    assert.equal(schema.properties.conditions.type, 'array');
    assert.ok(!schema.required.includes('ownerId'));
    assert.ok(!schema.required.includes('conditions'));
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', tool_calls: [{ id: 'attached', type: 'function', function: { name: 'events_add_rule', arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: 'Attached an F-key movement event to the energy cell.' } }] }) };
  } });
  assert.equal(draft.project.events.at(-1).ownerId, 'pickup');
  assert.deepEqual(draft.project.events.at(-1).conditions, args.conditions);
  assert.equal(project.events.length, 2);
});
test('DeepSeek request errors, malformed responses, missing config and tool budget fail explicitly', async () => {
  const base = { project: createProject(), prompt: 'test', apiKey: 'key' };
  await assert.rejects(proposeChanges({ ...base, apiKey: '' }), /not configured/);
  await assert.rejects(proposeChanges({ ...base, fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(proposeChanges({ ...base, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /invalid assistant/);
  await assert.rejects(proposeChanges({ ...base, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: null } }] }) }) }), /empty response/);
  let calls = 0;
  await assert.rejects(proposeChanges({ ...base, fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [
      { id: `call${calls}`, type: 'function', function: { name: 'project_get', arguments: '{}' } },
    ] } }] }) };
  } }), /eight-round/);
  assert.equal(calls, 8);
});
test('addon files are served from the project, and a staged copy bridges the moment before a save', async t => {
  const { url } = await fixture(t);
  const manifest = { format: 'opendle-addon', version: 1, id: 'sparkle', name: 'Sparkle', entry: 'addon.js',
    provides: { actions: [{ type: 'sparkle:burst', label: 'Burst', fields: [] }] } };
  const files = { 'addon.js': 'export default () => {};', 'style.css': 'body{}' };
  // A script has to be same-origin to run under the studio's CSP and `import()` cannot send the bearer
  // token, so this one GET is open.
  assert.equal((await fetch(`${url}/api/addons/sparkle/addon.js`)).status, 404, 'nothing is served before it exists');
  const staged = await fetch(`${url}/api/addons/stage`, { method: 'POST', headers, body: JSON.stringify({ id: 'sparkle', files }) });
  assert.equal(staged.status, 200);
  const pending = await fetch(`${url}/api/addons/sparkle/addon.js`);
  assert.equal(pending.status, 200);
  assert.match(pending.headers.get('content-type'), /text\/javascript/);
  assert.match(await pending.text(), /export default/);
  assert.match((await fetch(`${url}/api/addons/sparkle/style.css`)).headers.get('content-type'), /text\/css/);
  assert.equal((await fetch(`${url}/api/addons/sparkle/notes.bin`)).status, 404);
  assert.equal((await fetch(`${url}/api/addons/stage`, { method: 'POST', headers,
    body: JSON.stringify({ id: 'no', files: { '../escape.js': 'x' } }) })).status, 400, 'a path out of the addon is refused');

  // Once the project holds it, the route reads the project instead of the staged copy.
  const snapshot = await (await fetch(`${url}/api/project`, { headers })).json();
  const project = { ...snapshot.project, addons: [normalizeAddon({ manifest,
    files: { 'addon.js': 'export const saved = true;', 'style.css': 'body{}' } })] };
  const saved = await fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify({ project, revision: snapshot.revision, projectId: snapshot.projectId }) });
  assert.equal(saved.status, 200);
  assert.match(await (await fetch(`${url}/api/addons/sparkle/addon.js`)).text(), /saved = true/);
});

test('AI HTTP returns approval-only changes and leaves server project untouched', async t => {
  let calls = 0;
  const { url, store } = await fixture(t, { apiKey: 'test', fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: calls === 1
      ? { role: 'assistant', tool_calls: [{ id: 'one', type: 'function', function: { name: 'project_set_title', arguments: '{"title":"Proposed"}' } }] }
      : { role: 'assistant', content: 'A proposed rename.' } }] }) };
  } });
  const response = await fetch(`${url}/api/ai`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'Rename', revision: 0 }) });
  const draft = await response.json();
  assert.equal(response.status, 200); assert.equal(draft.project.title, 'Proposed');
  assert.notEqual(store.snapshot().project.title, 'Proposed'); assert.equal(store.snapshot().revision, 0);
  assert.equal((await fetch(`${url}/api/ai`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'Rename', revision: 99 }) })).status, 409);
});
