import test from 'node:test';
import assert from 'node:assert/strict';
import { readServiceResponse } from '../public/service-response.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';

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
