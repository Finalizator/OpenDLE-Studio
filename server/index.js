import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProjectStore } from './store.js';
import { LIMITS } from '../shared/limits.js';
import { applyTool, toolDefinitions } from './tools.js';
import { proposeChanges } from './deepseek.js';
import { importWad } from './import.js';
import { readWad } from '../shared/wad.js';
import { openLocalBrowser } from './browser.js';
import { readEngineVersion } from './version.js';
import { packageLibrary, localWadBytes, readLocalPackage, readPackageArchive, inspectPackage, importPackage } from './packages.js';
import { createImportCache, importCacheFingerprint, importCacheKey, directorySignature } from './import-cache.js';
import { createPortableBuild } from './export-build.js';
import { loadGzdoomActors } from './actor-sources.js';
import { createPlaytestLogStore, DEFAULT_LOG_DIRECTORY } from './playtest-logs.js';
import { isLogId, normalizeLogEntry, LOG_LIMITS } from '../shared/playtest-log.js';

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
  importCache,
  playtestLogs = createPlaytestLogStore({ directory: resolve(root, DEFAULT_LOG_DIRECTORY) }),
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
  // Imports are whole archives (see shared/limits.js); the body limit follows them.
  const archiveLimit = `${LIMITS.archiveBytes / (1024 * 1024)}mb`;
  app.use(express.json({ limit: archiveLimit }));
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
    if (!info?.isFile() || info.size > LIMITS.archiveBytes) {
      throw new Error(`WAD is missing or exceeds ${LIMITS.archiveBytes / (1024 * 1024)} MiB`);
    }
    return readFileSync(file);
  }
  app.get('/api/wads/:name/maps', (req, res) => {
    const buffer = localWad(req.params.name);
    res.json({ maps: readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)).maps });
  });
  const fullGameImport = scope => {
    if (scope !== undefined && !['game', 'level'].includes(scope)) throw new Error('Import scope must be game or level');
    return scope !== 'level';
  };
  const cache = importCache === null ? null : importCache || createImportCache({
    directory: resolve(root, 'data/import-cache'), fingerprint: importCacheFingerprint(root),
  });
  const fresh = query => query.fresh === '1' || query.fresh === 'true';
  const fileStamp = name => {
    const info = statSync(resolve(projectsDir, name), { throwIfNoEntry: false });
    return info?.isFile() ? `${name}:${info.size}:${info.mtimeMs}` : `${name}:missing`;
  };
  // GZDoom's own actor definitions (from a local gzdoom.pk3) make imported
  // monsters and weapons run their real state machines.
  function actorContext() {
    const gzdoom = loadGzdoomActors(projectsDir);
    return gzdoom.available
      ? { actorSources: gzdoom.sources, dehacked: gzdoom.dehacked, sndInfoSources: gzdoom.sndinfo }
      : {};
  }
  app.post('/api/import/local-wad', (req, res) => {
    const bytes = localWad(req.body.name), options = { fullGame: fullGameImport(req.body.scope), title: req.body.name.replace(/\.wad$/i, '') };
    const key = importCacheKey(['wad', createHash('sha256').update(bytes).digest('hex'), req.body.map ?? '', options.fullGame, options.title]);
    const cached = fresh(req.body) ? null : cache?.get(key);
    const result = cached || importWad(bytes, req.body.map, { ...options, ...actorContext() });
    if (!cached) cache?.set(key, result);
    res.json({ ...result, cached: cached?.cached || null });
  });
  app.post('/api/import/wad', express.raw({ type: 'application/octet-stream', limit: archiveLimit }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new Error('Expected a binary WAD body');
    const options = { fullGame: fullGameImport(req.query.scope) };
    const key = importCacheKey(['wad', createHash('sha256').update(req.body).digest('hex'), req.query.map ?? '', options.fullGame, null]);
    const cached = fresh(req.query) ? null : cache?.get(key);
    const result = cached || importWad(req.body, req.query.map, { ...options, ...actorContext() });
    if (!cached) cache?.set(key, result);
    res.json({ ...result, cached: cached?.cached || null });
  });
  app.get('/api/packages', (req, res) => res.json(packageLibrary(projectsDir)));
  app.post('/api/packages/inspect', async (req, res) => res.json(inspectPackage(await readLocalPackage(projectsDir, req.body.name))));
  app.post('/api/packages/upload/inspect', express.raw({ type: 'application/octet-stream', limit: archiveLimit }), async (req, res) =>
    res.json(inspectPackage(await readPackageArchive(req.body))));
  app.post('/api/import/local-package', async (req, res) => {
    const source = resolve(projectsDir, String(req.body.name || ''));
    const signature = statSync(source, { throwIfNoEntry: false })?.isDirectory() ? directorySignature(source) : fileStamp(req.body.name);
    const options = { map: req.body.map, paths: req.body.paths, fullGame: fullGameImport(req.body.scope),
      base: req.body.base ? fileStamp(req.body.base) : null };
    const key = importCacheKey(['package', req.body.name, signature, options]);
    const cached = fresh(req.body) ? null : cache?.get(key);
    if (cached) return res.json({ ...cached, cached: cached.cached || null });
    const files = await readLocalPackage(projectsDir, req.body.name);
    const result = importPackage(files, { map: req.body.map, paths: req.body.paths,
      fullGame: options.fullGame, projectsDir,
      baseBytes: req.body.base ? localWadBytes(projectsDir, req.body.base) : undefined });
    cache?.set(key, result);
    res.json({ ...result, cached: null });
  });
  app.post('/api/import/package', express.raw({ type: 'application/octet-stream', limit: archiveLimit }), async (req, res) => {
    const files = await readPackageArchive(req.body);
    const inspection = inspectPackage(files);
    const indices = typeof req.query.images === 'string' && req.query.images ? req.query.images.split(',') : [];
    if (indices.some(index => !/^\d+$/.test(index) || !inspection.images[Number(index)])) throw new Error('Invalid package image selection');
    const options = { map: req.query.map, paths: indices.map(index => inspection.images[Number(index)]),
      fullGame: fullGameImport(req.query.scope), base: req.query.base ? req.query.base : null };
    const key = importCacheKey(['package-upload', createHash('sha256').update(req.body).digest('hex'), options]);
    const cached = fresh(req.query) ? null : cache?.get(key);
    const result = cached || importPackage(files, { map: req.query.map, paths: options.paths,
      fullGame: options.fullGame, projectsDir,
      baseBytes: req.query.base ? localWadBytes(projectsDir, req.query.base) : undefined });
    if (!cached) cache?.set(key, result);
    res.json({ ...result, cached: cached?.cached || null });
  });
  app.get('/api/import-cache', (req, res) => {
    const files = cache?.files() || [];
    res.set('Cache-Control', 'no-store').json({ enabled: Boolean(cache), ...(cache?.stats() || {}),
      entries: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) });
  });
  app.delete('/api/import-cache', (req, res) => {
    cache?.clear();
    res.json({ cleared: Boolean(cache) });
  });
  app.get('/api/export/build', async (req, res) => {
    const project = store.snapshot().project;
    const built = await createPortableBuild({ project, projectJson: JSON.stringify(project),
      version: readEngineVersion(versionFile), platform: req.query.platform || process.platform });
    res.set({ 'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${built.filename}"`,
      'Content-Length': String(built.bytes.length) }).send(built.bytes);
  });
  // Playtest logs: the browser posts batches of failures during play and the
  // service appends them to a file, so nothing is lost when the tab closes.
  let logBudget = { minute: Math.floor(Date.now() / 60000), used: 0 };
  const withinLogBudget = count => {
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== logBudget.minute) logBudget = { minute, used: 0 };
    logBudget.used += count;
    return logBudget.used <= LOG_LIMITS.requestsPerMinute;
  };
  app.post('/api/playtest/logs', (req, res) => {
    const session = req.body?.session;
    if (!isLogId(session)) return res.status(400).json({ error: 'Playtest session id is invalid' });
    if (!Array.isArray(req.body?.entries)) return res.status(400).json({ error: 'Playtest log entries must be an array' });
    if (req.body.entries.length > LOG_LIMITS.entriesPerRequest) {
      return res.status(413).json({ error: `At most ${LOG_LIMITS.entriesPerRequest} playtest log entries per request` });
    }
    if (!withinLogBudget(req.body.entries.length)) {
      return res.status(429).json({ error: 'Too many playtest log entries in one minute' });
    }
    const entries = req.body.entries.map(entry => normalizeLogEntry(entry, { session }));
    const header = req.body.header && typeof req.body.header === 'object' ? normalizeLogEntry(req.body.header, { session }) : undefined;
    res.json(playtestLogs.append(session, entries, { header }));
  });
  app.get('/api/playtest/logs', (req, res) => res.json(playtestLogs.list()));
  app.get('/api/playtest/logs/:session', (req, res) => {
    if (!isLogId(req.params.session)) return res.status(400).json({ error: 'Playtest session id is invalid' });
    res.json(playtestLogs.read(req.params.session));
  });
  app.delete('/api/playtest/logs', (req, res) => res.json(playtestLogs.clear()));
  app.get('/api/project', (req, res) => res.json(store.snapshot()));
  app.put('/api/project', (req, res) => res.json(store.update(req.body.project, req.body.revision)));
  // Stored projects: the studio reopens the active one on the next start, so switching
  // and adopting both have to be reachable from the client.
  app.get('/api/projects', (req, res) => res.json(store.list()));
  app.post('/api/projects/open', (req, res) => res.json(store.open(String(req.body?.id ?? ''))));
  app.post('/api/project/adopt', (req, res) => res.json(store.adopt(req.body?.project, req.body?.title,
    { temporary: req.body?.temporary === true })));
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
          const result = applyTool(snapshot.project, tool.name, args, { playtestLogs });
          const saved = result.changed ? store.update(result.project, snapshot.revision) : snapshot;
          // Read-only tools answer with their own payload instead of the whole
          // project, which would drown the answer in megabytes of map data.
          return { content: [{ type: 'text', text: JSON.stringify(result.report ?? saved) }] };
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
