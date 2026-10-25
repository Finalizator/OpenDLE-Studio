import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEngineVersion } from '../server/version.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('version.ini accepts SemVer and comments but rejects missing, duplicate and malformed versions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-version-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, 'version.ini');
  assert.throws(() => readEngineVersion(file), /ENOENT/);
  for (const version of ['0.1.0', '2.3.4-beta.1+build.7']) {
    writeFileSync(file, `; Engine version\r\n[engine]\r\n# Release\r\nversion = ${version}\r\n`);
    assert.equal(readEngineVersion(file), version);
  }
  for (const source of ['', '[engine]', 'version=1.2.3', '[engine]\nversion=1.2',
    '[engine]\nversion=01.2.3', '[engine]\nversion=1.2.3-01',
    '[engine]\nversion=1.2.3\nversion=2.0.0', '[other]\nversion=1.2.3']) {
    writeFileSync(file, source);
    assert.throws(() => readEngineVersion(file), /version.ini/);
  }
});

test('health API reads the configured version file instead of a hard-coded version', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-version-api-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, 'version.ini');
  writeFileSync(file, '[engine]\nversion=2.7.1-preview.3\n');
  const { app, token } = createApp({ store: new ProjectStore(), versionFile: file });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.deepEqual(await response.json(), { service: 'OpenDLE', version: '2.7.1-preview.3' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  writeFileSync(file, '[engine]\nversion=2.7.2\n');
  const updated = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.deepEqual(await updated.json(), { service: 'OpenDLE', version: '2.7.2' });
  const client = new Client({ name: 'version-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal(client.getServerVersion().version, '2.7.2');
  writeFileSync(file, '[engine]\nversion=broken\n');
  const invalid = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /SemVer/);
  assert.throws(() => createApp({ store: new ProjectStore(), versionFile: file }), /SemVer/);
});
