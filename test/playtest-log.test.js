import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogId, isLogId, isLogFileName, logEntryKey, logFileName, logLine, normalizeLogEntry, parseLogText,
  sanitizeDetails, sessionRecord, summarizeLog, LOG_LIMITS,
} from '../shared/playtest-log.js';
import { createPlaytestLogStore } from '../server/playtest-logs.js';
import { createPlaytestLogger } from '../public/playtest-log.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';
import { createProject } from '../shared/project.js';

const tempDirectory = t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-logs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

test('log entries are bounded, JSON safe and carry the playtest context', () => {
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const record = normalizeLogEntry({
    severity: 'error', category: 'acs', message: '  script stopped\u0000 here  ',
    details: { error: new Error('boom'), cyclic, big: 'x'.repeat(20000), fn: () => {} },
  }, { session: '2026-10-26t13-00-00z-abcdef', level: 'MAP05', project: 'Hexabun' }, Date.parse('2026-10-26T13:00:01Z'));
  assert.equal(record.v, 1);
  assert.equal(record.time, '2026-10-26T13:00:01.000Z');
  assert.equal(record.severity, 'error');
  assert.equal(record.category, 'acs');
  assert.equal(record.level, 'MAP05');
  assert.equal(record.session, '2026-10-26t13-00-00z-abcdef');
  assert.equal(record.message, 'script stopped here', 'control characters are stripped');
  assert.equal(record.details.error.message, 'boom');
  assert.equal(record.details.fn, '[function]');
  assert.ok(record.details.big.length <= LOG_LIMITS.text + 1, 'long strings are truncated');
  // A cycle must not explode or recurse forever.
  assert.ok(JSON.stringify(record).length < LOG_LIMITS.detailsBytes + 4000);
});

test('severity defaults to error and unknown sessions are dropped rather than written into a path', () => {
  const record = normalizeLogEntry({ message: 'x' }, { session: '../../etc/passwd' });
  assert.equal(record.severity, 'error');
  assert.equal(record.session, undefined, 'an invalid session never reaches the file name');
  assert.equal(record.category, 'runtime');
  assert.equal(normalizeLogEntry({}).message, 'Unknown playtest failure');
});

test('details sanitising stops at the depth and entry budget', () => {
  let deep = { value: 1 };
  for (let index = 0; index < 20; index++) deep = { nested: deep };
  assert.match(JSON.stringify(sanitizeDetails(deep)), /depth limit/);
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`key${index}`, index]));
  assert.ok(Object.keys(sanitizeDetails(wide)).length <= 45, 'wide objects are capped');
});

test('log ids become safe file names and round-trip through the reader', () => {
  const id = createLogId(Date.parse('2026-10-26T13:41:02.500Z'), () => 0.5);
  assert.equal(id, '2026-10-26t13-41-02-500z-800000');
  assert.ok(isLogId(id));
  assert.ok(isLogFileName(logFileName(id)));
  assert.ok(!isLogId('../escape'));
  assert.ok(!isLogId('short'));
  assert.ok(!isLogFileName('../../etc/passwd.log'));
});

test('parsing skips a truncated or hand-edited line instead of losing the file', () => {
  const text = [
    logLine({ v: 1, category: 'session', message: 'start' }),
    '{"broken": ',
    logLine({ v: 1, severity: 'error', category: 'acs', message: 'boom', level: 'MAP01' }),
    '[1,2,3]',
    '',
  ].join('\n');
  const { records, skipped } = parseLogText(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 2);
  const summary = summarizeLog(records);
  assert.deepEqual({ entries: summary.entries, errors: summary.errors, level: summary.level },
    { entries: 2, errors: 1, level: 'MAP01' });
});

test('repeating failures share an identity key', () => {
  const base = { category: 'acs', severity: 'error', message: 'script stopped', details: { where: 'MAP05:12' } };
  assert.equal(logEntryKey(base), logEntryKey({ ...base, time: 'later', repeats: 9 }));
  assert.notEqual(logEntryKey(base), logEntryKey({ ...base, details: { where: 'MAP06:12' } }));
});

test('the store writes one file per session with a header and keeps its index honest', t => {
  const directory = join(tempDirectory(t), 'playtest');
  const store = createPlaytestLogStore({ directory });
  const session = createLogId(Date.parse('2026-10-26T13:00:00Z'), () => 0.1);
  const header = sessionRecord({ session, project: 'Hexabun', level: 'MAP05' }, Date.parse('2026-10-26T13:00:00Z'));
  store.append(session, [normalizeLogEntry({ severity: 'error', category: 'acs', message: 'first' }, { session })], { header });
  store.append(session, [
    normalizeLogEntry({ severity: 'warning', category: 'actor', message: 'second' }, { session }),
    normalizeLogEntry({ severity: 'error', category: 'acs', message: 'third' }, { session }),
  ]);

  const file = join(directory, logFileName(session));
  assert.ok(existsSync(file));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4, 'one header plus three records');
  assert.equal(JSON.parse(lines[0]).category, 'session');

  const listed = store.list();
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].level, 'MAP05');
  assert.equal(listed.sessions[0].project, 'Hexabun');
  assert.equal(listed.sessions[0].entries, 4);
  assert.equal(listed.sessions[0].errors, 2);
  assert.equal(listed.totals.warnings, 1);

  const read = store.read(session);
  assert.equal(read.entries.length, 4);
  assert.equal(read.summary.errors, 2);
  assert.equal(read.file, logFileName(session));
});

test('the store rebuilds its index from files and prunes the oldest sessions', t => {
  const directory = join(tempDirectory(t), 'playtest');
  const options = { directory, maxSessions: 3 };
  const store = createPlaytestLogStore(options);
  const ids = [0, 1, 2, 3].map(index => createLogId(Date.parse('2026-10-26T13:00:0' + index + 'Z'), () => index / 10));
  for (const id of ids) store.append(id, [normalizeLogEntry({ message: `failure ${id}` }, { session: id })]);
  assert.equal(store.list().sessions.length, 3, 'only the newest sessions survive');
  assert.ok(!existsSync(join(directory, logFileName(ids[0]))), 'the oldest file is deleted, not just forgotten');

  // Losing the index must cost a rescan, never data.
  rmSync(join(directory, 'index.json'));
  const rebuilt = createPlaytestLogStore(options).list();
  assert.equal(rebuilt.sessions.length, 3);
  assert.equal(rebuilt.sessions[0].entries, 2, 'header plus one record');
});

test('a session file is capped, then reported as truncated instead of growing', t => {
  const directory = join(tempDirectory(t), 'playtest');
  const store = createPlaytestLogStore({ directory, maxFileBytes: 900, maxEntries: 6 });
  const session = createLogId(Date.now(), () => 0.2);
  let written = 0;
  for (let index = 0; index < 20; index++) {
    written += store.append(session, [normalizeLogEntry({ message: `failure number ${index} with padding` }, { session })]).written;
  }
  assert.ok(written < 20, 'writing stops at the cap');
  const result = store.append(session, [normalizeLogEntry({ message: 'after the cap' }, { session })]);
  assert.equal(result.truncated, true);
  assert.equal(result.written, 0);
  const text = readFileSync(join(directory, logFileName(session)), 'utf8');
  assert.match(text, /log limit reached/);
  assert.ok(text.length <= 1400, `file stayed bounded: ${text.length} bytes`);
  assert.doesNotMatch(text, /after the cap/);
});

test('the store rejects unusable session ids and reads unknown sessions explicitly', t => {
  const directory = join(tempDirectory(t), 'playtest');
  const store = createPlaytestLogStore({ directory });
  assert.throws(() => store.append('../evil', []), /session id is invalid/);
  assert.throws(() => store.read('../evil'), /session id is invalid/);
  assert.throws(() => store.read(createLogId()), /Unknown playtest session/);
});

test('clearing deletes files, the index and reports how many went', t => {
  const directory = join(tempDirectory(t), 'playtest');
  const store = createPlaytestLogStore({ directory });
  const session = createLogId();
  store.append(session, [normalizeLogEntry({ message: 'x' }, { session })]);
  writeFileSync(join(directory, 'notes.txt'), 'not a log');
  assert.deepEqual(store.clear(), { removed: 1 });
  assert.deepEqual(readdirSync(directory), ['notes.txt'], 'unrelated files are left alone');
  assert.equal(store.list().sessions.length, 0);
});

test('the browser logger batches, collapses repeats and keeps one session per tab', async () => {
  const sent = [];
  const tabs = memoryStorage(), durable = memoryStorage();
  let clock = Date.parse('2026-10-26T13:00:00Z');
  const logger = createPlaytestLogger({
    send: async payload => { sent.push(payload); return { written: payload.entries.length }; },
    tabStorage: tabs, durableStorage: durable, now: () => clock, random: () => 0.5, flushDelay: 5,
  });
  const first = logger.session;
  assert.ok(isLogId(first));
  logger.setContext({ level: 'MAP05', project: 'Hexabun' });
  logger.error('acs', 'script stopped', { where: 'MAP05:12' });
  logger.error('acs', 'script stopped', { where: 'MAP05:12' });
  logger.error('acs', 'script stopped', { where: 'MAP05:12' });
  clock += 100;
  await logger.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].entries.length, 1, 'one record for a repeating failure');
  assert.equal(sent[0].entries[0].repeats, 3);
  assert.equal(sent[0].entries[0].level, 'MAP05');
  assert.equal(sent[0].header.category, 'session');
  assert.equal(sent[0].session, first);

  // A reload in the same tab continues the same file.
  const reloaded = createPlaytestLogger({ send: async payload => ({ written: payload.entries.length }),
    tabStorage: tabs, durableStorage: durable, now: () => clock });
  assert.equal(reloaded.session, first);
});

test('the browser logger survives an unreachable service by keeping records in browser storage', async () => {
  const tabs = memoryStorage(), durable = memoryStorage();
  const logger = createPlaytestLogger({
    send: async () => { throw new Error('local service unavailable'); },
    tabStorage: tabs, durableStorage: durable, flushDelay: 5,
  });
  logger.error('render', 'WebGPU adapter lost');
  await logger.flush();
  assert.equal(logger.pending, 1, 'the record is still queued');
  assert.match(logger.status().lastError, /unavailable/);
  const stored = JSON.parse(durable.getItem('opendle-playtest-log-pending'));
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0].message, 'WebGPU adapter lost');

  // The next page load retries what the previous one could not send.
  const revived = createPlaytestLogger({ send: async payload => ({ written: payload.entries.length }),
    tabStorage: tabs, durableStorage: durable, flushDelay: 5 });
  assert.equal(revived.pending, 1);
  await revived.flush();
  assert.equal(revived.pending, 0);
  assert.equal(JSON.parse(durable.getItem('opendle-playtest-log-pending')).entries.length, 0);
});

test('logger notices fire once and a full session stops queueing forever', async () => {
  const tabs = memoryStorage();
  const logger = createPlaytestLogger({ send: async payload => ({ written: 0, truncated: true }),
    tabStorage: tabs, durableStorage: memoryStorage(), flushDelay: 5 });
  logger.once('actor:A_Morph', { severity: 'warning', category: 'actor', message: 'A_Morph unsupported' });
  logger.once('actor:A_Morph', { severity: 'warning', category: 'actor', message: 'A_Morph unsupported' });
  assert.equal(logger.pending, 1);
  await logger.flush();
  assert.equal(logger.pending, 0, 'a truncated response clears the queue instead of retrying');
  logger.error('acs', 'later failure');
  logger.close();
  assert.equal(logger.log({ message: 'after close' }), null);
});

test('playtest log routes accept batches, list sessions, read them and delete them', async t => {
  const directory = join(tempDirectory(t), 'playtest');
  const playtestLogs = createPlaytestLogStore({ directory });
  const { app } = createApp({ store: new ProjectStore(), token: 'log-test', playtestLogs });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: ['Bearer', 'log-test'].join(' '), 'Content-Type': 'application/json' };
  const session = createLogId(Date.parse('2026-10-26T13:10:00Z'), () => 0.3);

  const posted = await fetch(`${url}/api/playtest/logs`, { method: 'POST', headers, body: JSON.stringify({
    session,
    header: sessionRecord({ session, project: 'Hexabun', level: 'MAP05' }),
    entries: [{ severity: 'error', category: 'acs', message: 'script "lowerComp3" stopped', details: { script: 'lowerComp3' } }],
  }) });
  assert.equal(posted.status, 200);
  assert.equal((await posted.json()).written, 1);

  const listed = await (await fetch(`${url}/api/playtest/logs`, { headers })).json();
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].level, 'MAP05');
  assert.equal(listed.totals.errors, 1);

  const read = await (await fetch(`${url}/api/playtest/logs/${session}`, { headers })).json();
  assert.equal(read.entries.length, 2, 'the header is a record too');
  assert.equal(read.entries[1].details.script, 'lowerComp3');
  assert.match(read.directory, /playtest$/);

  const rejected = await fetch(`${url}/api/playtest/logs`, { method: 'POST', headers,
    body: JSON.stringify({ session: '../escape', entries: [] }) });
  assert.equal(rejected.status, 400);
  const oversized = await fetch(`${url}/api/playtest/logs`, { method: 'POST', headers,
    body: JSON.stringify({ session, entries: Array.from({ length: LOG_LIMITS.entriesPerRequest + 1 }, () => ({ message: 'x' })) }) });
  assert.equal(oversized.status, 413);

  const cleared = await (await fetch(`${url}/api/playtest/logs`, { method: 'DELETE', headers })).json();
  assert.equal(cleared.removed, 1);
  assert.equal((await (await fetch(`${url}/api/playtest/logs`, { headers })).json()).sessions.length, 0);
});

test('the MCP tools expose saved playtest logs to the assistant', async () => {
  const { applyTool } = await import('../server/tools.js');
  const directory = join(mkdtempSync(join(tmpdir(), 'opendle-logs-')), 'playtest');
  const playtestLogs = createPlaytestLogStore({ directory });
  const session = createLogId(Date.parse('2026-10-26T13:20:00Z'), () => 0.4);
  playtestLogs.append(session, [normalizeLogEntry({ severity: 'error', category: 'acs', message: 'boom' }, { session })],
    { header: sessionRecord({ session, level: 'MAP08' }) });
  const project = createProject();
  try {
    const listed = applyTool(project, 'playtest_log_list', {}, { playtestLogs });
    assert.equal(listed.changed, false);
    assert.equal(listed.report.sessions[0].id, session);
    assert.equal(listed.project, undefined, 'read-only tools do not hand back the project');
    const read = applyTool(project, 'playtest_log_read', { session, limit: 10 }, { playtestLogs });
    assert.equal(read.report.entries.at(-1).message, 'boom');
    assert.throws(() => applyTool(project, 'playtest_log_read', { session }, {}), /not available/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

/** Minimal DOM for exercising the panel without a browser. */
function fakeDocument() {
  const make = tag => {
    const node = {
      tagName: tag.toUpperCase(), children: [], className: '', textContent: '', dataset: {}, hidden: false,
      value: '', type: '', listeners: new Map(),
      append(...items) { node.children.push(...items); },
      replaceChildren(...items) { node.children = [...items]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      classList: { toggle(name, on) { const set = new Set(node.className.split(/\s+/).filter(Boolean));
        if (on) set.add(name); else set.delete(name); node.className = [...set].join(' '); } },
    };
    return node;
  };
  return { createElement: make };
}

test('the logs panel lists sessions, shows records and filters them', async () => {
  globalThis.document = fakeDocument();
  try {
    const { createPlaytestLogPanel } = await import('../public/playtest-log-panel.js');
    const session = createLogId(Date.parse('2026-10-26T13:30:00Z'), () => 0.5);
    const entries = [
      normalizeLogEntry({ severity: 'info', category: 'session', message: 'started' }, { session, level: 'MAP05' }),
      normalizeLogEntry({ severity: 'error', category: 'acs', message: 'script stopped' }, { session, level: 'MAP05' }),
      normalizeLogEntry({ severity: 'warning', category: 'actor', message: 'A_Morph unsupported' }, { session, level: 'MAP05' }),
    ];
    const nodes = { directory: fakeDocument().createElement('p'), totals: fakeDocument().createElement('p'),
      list: fakeDocument().createElement('div'), detail: fakeDocument().createElement('div'),
      refresh: fakeDocument().createElement('button'), clear: fakeDocument().createElement('button') };
    const panel = createPlaytestLogPanel(nodes, {
      list: async () => ({ directory: '/tmp/logs/playtest', sessions: [{ id: session, level: 'MAP05',
        startedAt: '2026-10-26T13:30:00.000Z', entries: 3, errors: 1, warnings: 1, bytes: 800 }],
        totals: { entries: 3, errors: 1, warnings: 1, bytes: 800 } }),
      read: async () => ({ session, file: `${session}.log`, directory: '/tmp/logs/playtest', skipped: 0,
        total: 3, summary: summarizeLog(entries), entries }),
      clear: async () => ({ removed: 1 }),
    });
    await panel.render();
    assert.match(nodes.directory.textContent, /\/tmp\/logs\/playtest$/);
    assert.match(nodes.totals.textContent, /1 error\(s\)/);
    assert.equal(nodes.list.children.length, 1);
    nodes.list.children[0].listeners.get('click')();
    await new Promise(resolve => setTimeout(resolve, 0));
    const records = nodes.detail.children.find(node => node.className === 'log-entries');
    assert.ok(records, 'records rendered');
    assert.equal(records.children.length, 3);
    const messages = records.children.map(item => item.children[1]?.textContent);
    assert.deepEqual(messages, ['script stopped', 'A_Morph unsupported', 'started'], 'failures sort before notices');
    const filters = nodes.detail.children.find(node => node.className === 'log-filters');
    filters.children[1].listeners.get('click')();
    const filtered = nodes.detail.children.find(node => node.className === 'log-entries');
    assert.equal(filtered.children.length, 1, 'the Errors filter narrows the list');
  } finally { delete globalThis.document; }
});

test('frame stats keep session-wide stall totals past the rolling window', async () => {
  const { createFrameStats } = await import('../shared/perf.js');
  const stats = createFrameStats({ window: 4, stallMs: 50 });
  [10, 400, 10, 10, 10, 10, 10, 10, 300].forEach(ms => stats.push(ms));
  const summary = stats.summary();
  assert.equal(summary.sessionStalls, 2, 'both stalls are remembered');
  assert.equal(summary.stalls, 1, 'the rolling window only still holds the last one');
  assert.equal(summary.worst, 400);
  assert.equal(summary.sessionFrames, 9);
  stats.reset();
  assert.equal(stats.summary().sessionStalls, 0);
});
