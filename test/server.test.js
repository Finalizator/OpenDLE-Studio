import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { readEngineVersion } from '../server/version.js';
import { proposeChanges } from '../server/deepseek.js';
import { createProject } from '../shared/project.js';
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
    body: JSON.stringify({ project: imported, revision: adopted.revision }) })).json();
  assert.equal(saved.projectId, 'imported-wad-game');
  assert.equal(saved.revision, 2);
  assert.equal((await fetch(`${url}/api/projects/open`, { method: 'POST', headers,
    body: JSON.stringify({ id: 'missing' }) })).status, 404);
  const reopened = await (await fetch(`${url}/api/projects/open`, { method: 'POST', headers,
    body: JSON.stringify({ id: 'imported-wad-game' }) })).json();
  assert.equal(reopened.project.title, 'Imported WAD game');
  assert.equal(store.snapshot().projectId, 'imported-wad-game');
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
  const saved = await fetch(`${url}/api/project`, { method: 'PUT', headers, body: JSON.stringify({ project: draft.project, revision: 0 }) });
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
