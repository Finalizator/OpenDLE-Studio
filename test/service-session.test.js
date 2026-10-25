import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWithSession } from '../public/service-session.js';

test('a server restart refreshes the token and retries a rejected save exactly once with its original body', async () => {
  const calls = [], body = '{"project":{"events":["pistol"]},"revision":2}';
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/session') return Response.json({ token: 'new' });
    return options.headers.Authorization === 'Bearer new' ? Response.json({ revision: 3 }) : new Response('', { status: 401 });
  };
  const result = await requestWithSession('/api/project', { method: 'PUT', body }, 'old', fetchImpl);
  assert.equal(result.token, 'new'); assert.equal(result.response.status, 200);
  assert.deepEqual(calls.map(c => c.path), ['/api/project', '/api/session', '/api/project']);
  assert.equal(calls[2].options.body, body); assert.equal(calls[2].options.method, 'PUT');
});
test('valid sessions and revision conflicts are not retried; repeated unauthorized errors remain explicit', async () => {
  for (const status of [200, 409, 500]) {
    let calls = 0;
    const result = await requestWithSession('/api/project', {}, 'valid', async () => { calls++; return new Response('', { status }); });
    assert.equal(calls, 1); assert.equal(result.response.status, status);
  }
  let calls = 0;
  const result = await requestWithSession('/api/project', {}, 'old', async path => {
    calls++; return path === '/api/session' ? Response.json({ token: 'new' }) : new Response('', { status: 401 });
  });
  assert.equal(calls, 3); assert.equal(result.response.status, 401);
});
test('invalid refresh responses fail explicitly without retrying the write', async () => {
  let writes = 0;
  await assert.rejects(requestWithSession('/api/project', {}, 'old', async path => {
    if (path === '/api/session') return Response.json({});
    writes++; return new Response('', { status: 401 });
  }), /invalid session token/);
  assert.equal(writes, 1);
});
