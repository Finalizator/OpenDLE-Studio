import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProjectStore } from './store.js';
import { applyTool, toolDefinitions } from './tools.js';
import { proposeChanges } from './deepseek.js';
import { importWad } from './import.js';
import { readWad } from '../shared/wad.js';
import { openLocalBrowser } from './browser.js';
import { readEngineVersion } from './version.js';
import { packageLibrary, localWadBytes, readLocalPackage, readPackageArchive, inspectPackage, importPackage } from './packages.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp({
  store = new ProjectStore(resolve(root, 'data/project.json')),
  token = randomBytes(32).toString('hex'),
  apiKey = process.env.DEEPSEEK_API_KEY,
  model = process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  fetchImpl = fetch,
  projectsDir = resolve(root, 'Projects'),
  openBrowser = openLocalBrowser,
  versionFile = resolve(root, 'version.ini'),
} = {}) {
  readEngineVersion(versionFile);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return res.status(403).json({ error: 'Only localhost access is supported' });
    if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-xgBhQgo+f9xOkcechLiI6lDe3GhH9jz1gwdm8I7MAQY='; style-src 'self'; img-src 'self' blob: data:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    });
    next();
  });
  app.get('/api/session', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ token, deepseekConfigured: Boolean(apiKey), model });
  });
  app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ service: 'OpenDLE', version: readEngineVersion(versionFile) });
  });
  app.get('/api/license', (req, res) => {
    const text = readFileSync(resolve(root, 'LICENSE'), 'utf8');
    res.set('Cache-Control', 'no-store').json({
      id: 'opendle-studio-commercial-1.0', text,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  });
  app.use(['/api', '/mcp'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!equal(req.headers.authorization || '', `Bearer ${token}`)) return res.status(401).json({ error: 'A valid local bearer token is required' });
    next();
  });
  app.use(express.json({ limit: '128mb' }));
  let browserBusy = false;
  app.post('/api/open-browser', async (req, res) => {
    if (browserBusy) return res.status(429).json({ error: 'A browser launch is already in progress' });
    browserBusy = true;
    try {
      const port = req.socket.localPort;
      const url = `http://127.0.0.1:${port}/`;
      await openBrowser(url);
      res.json({ url });
    } finally { browserBusy = false; }
  });
  app.get('/api/wads', (req, res) => {
    const files = readdirSync(projectsDir, { withFileTypes: true }).filter(file => file.isFile() && /\.wad$/i.test(file.name));
    res.json({ files: files.map(file => file.name) });
  });
  function localWad(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_. -]+\.wad$/i.test(name)) throw new Error('Invalid WAD filename');
    const file = resolve(projectsDir, name);
    const info = statSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > 128 * 1024 * 1024) throw new Error('WAD is missing or exceeds 128 MiB');
    return readFileSync(file);
  }
  app.get('/api/wads/:name/maps', (req, res) => {
    const buffer = localWad(req.params.name);
    res.json({ maps: readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)).maps });
  });
  app.post('/api/import/local-wad', (req, res) => res.json(importWad(localWad(req.body.name), req.body.map)));
  app.post('/api/import/wad', express.raw({ type: 'application/octet-stream', limit: '128mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new Error('Expected a binary WAD body');
    res.json(importWad(req.body, req.query.map));
  });
  app.get('/api/packages', (req, res) => res.json(packageLibrary(projectsDir)));
  app.post('/api/packages/inspect', async (req, res) => res.json(inspectPackage(await readLocalPackage(projectsDir, req.body.name))));
  app.post('/api/packages/upload/inspect', express.raw({ type: 'application/octet-stream', limit: '128mb' }), async (req, res) =>
    res.json(inspectPackage(await readPackageArchive(req.body))));
  app.post('/api/import/local-package', async (req, res) => {
    const files = await readLocalPackage(projectsDir, req.body.name);
    res.json(importPackage(files, { map: req.body.map, paths: req.body.paths,
      baseBytes: req.body.base ? localWadBytes(projectsDir, req.body.base) : undefined }));
  });
  app.post('/api/import/package', express.raw({ type: 'application/octet-stream', limit: '128mb' }), async (req, res) => {
    const files = await readPackageArchive(req.body);
    const inspection = inspectPackage(files);
    const indices = typeof req.query.images === 'string' ? req.query.images.split(',') : [];
    if (indices.some(index => !/^\d+$/.test(index) || !inspection.images[Number(index)])) throw new Error('Invalid package image selection');
    res.json(importPackage(files, { map: req.query.map, paths: indices.map(index => inspection.images[Number(index)]),
      baseBytes: req.query.base ? localWadBytes(projectsDir, req.query.base) : undefined }));
  });
  app.get('/api/project', (req, res) => res.json(store.snapshot()));
  app.put('/api/project', (req, res) => res.json(store.update(req.body.project, req.body.revision)));
  let aiBusy = false;
  app.post('/api/ai', async (req, res) => {
    if (aiBusy) return res.status(429).json({ error: 'An AI request is already running' });
    if (typeof req.body.prompt !== 'string' || !req.body.prompt.trim() || req.body.prompt.length > 8000) {
      return res.status(400).json({ error: 'Prompt must be 1-8000 characters' });
    }
    const snapshot = store.snapshot();
    if (req.body.revision !== snapshot.revision) return res.status(409).json({ error: 'Save your project before requesting AI changes' });
    aiBusy = true;
    try {
      const result = await proposeChanges({ project: snapshot.project, prompt: req.body.prompt, apiKey, model, fetchImpl });
      res.json({ ...result, revision: snapshot.revision });
    } finally {
      aiBusy = false;
    }
  });
  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'OpenDLE', version: readEngineVersion(versionFile) });
    for (const tool of toolDefinitions) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async args => {
        try {
          const snapshot = store.snapshot();
          const result = applyTool(snapshot.project, tool.name, args);
          const saved = result.changed ? store.update(result.project, snapshot.revision) : snapshot;
          return { content: [{ type: 'text', text: JSON.stringify(saved) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error.message }] };
        }
      });
    }
    server.registerResource('project', 'opendle://project', { description: 'Active OpenDLE project', mimeType: 'application/json' },
      async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(store.snapshot()) }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use stateless Streamable HTTP POST' }));
  app.use('/api', (req, res) => res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.originalUrl}. Check that the editor and running OpenDLE backend are up to date.` }));
  app.use('/shared', express.static(resolve(root, 'shared')));
  app.use('/vendor/three', express.static(resolve(root, 'node_modules/three/build')));
  app.get('/vendor/rapier/rapier.mjs', (req, res) => res.sendFile(resolve(root, 'node_modules/@dimforge/rapier3d-compat/rapier.mjs')));
  for (const module of ['loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js', 'environments/RoomEnvironment.js']) {
    app.get(`/vendor/three-addons/${module}`, (req, res) => res.type('application/javascript').send(
      readFileSync(resolve(root, 'node_modules/three/examples/jsm', module), 'utf8').replaceAll("from 'three'", "from '/vendor/three/three.module.js'")));
  }
  app.use('/vendor/three-addons', express.static(resolve(root, 'node_modules/three/examples/jsm')));
  app.use(express.static(resolve(root, 'public')));
  app.use((error, req, res, next) => {
    console.error(`${req.method} ${req.path}: ${error.message}`);
    if (res.headersSent) return next(error);
    const status = error.status || 400;
    res.status(status).json({ error: status === 413 ? 'Request is too large' : error.message });
  });
  return { app, token, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const { app, token } = createApp({ token: process.env.OPENDLE_TOKEN || undefined });
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`OpenDLE: http://127.0.0.1:${port}`);
    console.log(`MCP endpoint: http://127.0.0.1:${port}/mcp`);
    console.log(`Local MCP bearer token: ${token}`);
  });
  server.on('error', error => { console.error(`OpenDLE could not start: ${error.message}`); process.exitCode = 1; });
}
