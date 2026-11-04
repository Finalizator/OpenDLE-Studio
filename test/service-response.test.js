import test from 'node:test';
import assert from 'node:assert/strict';
import { readServiceResponse } from '../public/service-response.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { createProject } from '../shared/project.js';

test('old-backend HTML 404 reports missing endpoint and safe restart instructions instead of JSON syntax errors', async () => {
  const response = new Response('<!DOCTYPE html><pre>Cannot GET /api/packages</pre>',
    { status: 404, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(readServiceResponse(response, '/api/packages'), error =>
    error.message.includes('/api/packages') && error.message.includes('older OpenDLE backend') &&
    error.message.includes('Save/export') && error.message.includes('./launch.sh'));
});
test('service responses preserve JSON errors and successful bodies, and explicitly reject non-JSON/malformed replies', async () => {
  const json = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.deepEqual(await readServiceResponse(json('{"packages":[]}'), '/api/packages'), { packages: [] });
  await assert.rejects(readServiceResponse(json('{"error":"A valid local bearer token is required"}', 401), '/api/project'), /bearer token/);
  // A conflict carries its status and body: the editor tells a stale save apart from a real failure.
  await assert.rejects(readServiceResponse(json('{"error":"Project changed in another client","code":"stale-revision"}', 409), '/api/project'),
    error => error.status === 409 && error.body.code === 'stale-revision');
  await assert.rejects(readServiceResponse(json('broken'), '/api/project'), /Invalid JSON response/);
  await assert.rejects(readServiceResponse(new Response('<html>', { status: 502 }), '/api/packages'), /Expected JSON.*502/);
});
test('unknown authenticated API routes return JSON rather than an Express HTML error page', async t => {
  const { app } = createApp({ store: new ProjectStore(), token: 'response-test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/no-such-route`,
    { headers: { Authorization: 'Bearer response-test' } });
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match((await response.json()).error, /Unknown API endpoint/);
});

test('a stale save is a 409 the editor can act on, and only a stated replacement writes over it', async t => {
  const store = new ProjectStore();
  const { app } = createApp({ store, token: 'conflict-test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/project`;
  const save = body => fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer conflict-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
  const imported = store.adopt({ ...createProject(), title: 'Contended' });
  const edited = structuredClone(imported.project);
  edited.variables.score = 5;

  const stale = await save({ project: edited, revision: imported.revision - 1, projectId: imported.projectId });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale-revision', 'the editor has to be able to tell this conflict from a real failure');
  assert.equal(stale.body.revision, imported.revision);
  assert.equal(store.snapshot().project.variables.score, imported.project.variables.score);

  const replaced = await save({ project: edited, revision: imported.revision - 1, projectId: imported.projectId, replaceStale: true });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.project.variables.score, 5);
});
