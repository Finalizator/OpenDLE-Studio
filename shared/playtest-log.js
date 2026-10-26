/**
 * Playtest logs: a durable record of everything that failed while a map was played.
 *
 * A playtest happens in the browser, so its errors are invisible the moment the tab
 * closes: an ACS script that stopped, a texture that would not decode, an event rule
 * that threw. This module is the shared half of the log pipeline — the browser
 * normalises records with it, the local service writes and reads them with it — so
 * both sides agree on the format, the limits and the file names.
 *
 * Records are newline-delimited JSON: one object per line, append-only, so a crashed
 * or truncated write loses at most the last record and never the file.
 */

export const PLAYTEST_LOG_VERSION = 1;
export const LOG_SEVERITIES = ['error', 'warning', 'info'];
export const LOG_KINDS = ['session', 'note'];

/**
 * Every bound here exists because the input crosses a trust boundary (a browser
 * page can post anything) or because an unchecked log can fill a disk: a per-frame
 * error that repeats would otherwise write a line 60 times a second.
 */
export const LOG_LIMITS = {
  message: 4000,
  text: 500,
  detailsDepth: 6,
  detailsEntries: 200,
  detailsBytes: 16000,
  entriesPerRequest: 400,
  requestsPerMinute: 240,
  entriesPerSession: 20000,
  fileBytes: 4 * 1024 * 1024,
  sessions: 60,
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Session ids become file names, so they are restricted to a safe alphabet. */
export function isLogId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** `2026-10-26t13-41-02z-1a2b3c` — sortable, readable and filesystem-safe. */
export function createLogId(now = Date.now(), random = Math.random) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace('T', 't').toLowerCase();
  const suffix = Math.floor(random() * 0x1000000).toString(16).padStart(6, '0');
  return `${stamp}-${suffix}`;
}

export function logFileName(session) {
  return `${session}.log`;
}

export function isLogFileName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{7,63}\.log$/.test(name);
}

function clampText(value, limit) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(CONTROL, '').trim();
  return clean ? clean.slice(0, limit) : undefined;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
}

/**
 * Keeps `details` JSON-safe and small. A thrown Error, DOM node or cyclic object
 * would otherwise break both the write and the later read, so anything that is not
 * a bounded scalar or a short array/object is summarised instead of copied.
 */
export function sanitizeDetails(value, budget = { entries: LOG_LIMITS.detailsEntries, bytes: LOG_LIMITS.detailsBytes }, depth = 0) {
  if (budget.bytes <= 0 || budget.entries <= 0) return '[truncated]';
  const spend = amount => { budget.bytes -= amount; };
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.length > LOG_LIMITS.text ? `${value.slice(0, LOG_LIMITS.text)}…` : value;
    spend(text.length);
    return text;
  }
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (value instanceof Error) {
    spend(80);
    return { name: value.name, message: clampText(value.message, LOG_LIMITS.text), stack: clampText(value.stack, LOG_LIMITS.text) };
  }
  if (depth >= LOG_LIMITS.detailsDepth) return '[depth limit]';
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value.slice(0, 40)) {
      if (budget.entries-- <= 0) { items.push('[truncated]'); break; }
      items.push(sanitizeDetails(item, budget, depth + 1));
    }
    spend(items.length);
    return items;
  }
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    if (budget.entries-- <= 0) { result.truncated = true; break; }
    if (!/^[\w.$-]{1,80}$/.test(key)) continue;
    spend(key.length);
    result[key] = sanitizeDetails(child, budget, depth + 1);
  }
  return result;
}

/**
 * Turns whatever a caller reports into one bounded record. `context` carries the
 * playtest circumstances (session, level, renderer, project) so a single line is
 * still meaningful when read out of order.
 */
export function normalizeLogEntry(entry, context = {}, now = Date.now()) {
  const source = entry && typeof entry === 'object' ? entry : { message: String(entry ?? '') };
  const severity = LOG_SEVERITIES.includes(source.severity) ? source.severity : 'error';
  const message = clampText(source.message, LOG_LIMITS.message)
    || clampText(source.reason, LOG_LIMITS.message)
    || 'Unknown playtest failure';
  const details = source.details === undefined ? undefined : sanitizeDetails(source.details);
  const record = {
    v: PLAYTEST_LOG_VERSION,
    time: new Date(Number.isFinite(source.time) ? source.time : now).toISOString(),
    severity,
    category: clampText(source.category, 60) || 'runtime',
    message,
  };
  if (isLogId(context.session)) record.session = context.session;
  const level = clampText(context.level ?? source.level, 80);
  if (level) record.level = level;
  const project = clampText(context.project ?? source.project, LOG_LIMITS.text);
  if (project) record.project = project;
  const uptime = finiteNumber(source.uptime ?? context.uptime);
  if (uptime !== undefined) record.uptime = uptime;
  const repeats = Number.isFinite(source.repeats) && source.repeats > 1 ? Math.min(100000, Math.floor(source.repeats)) : undefined;
  if (repeats) record.repeats = repeats;
  if (details !== undefined && details !== null) record.details = details;
  return record;
}

/** One line of the file: JSON with no embedded newlines, whatever the message said. */
export function logLine(record) {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Reads a log file. A partially written or hand-edited line is skipped rather than
 * aborting the read, because losing a whole session to one bad byte is worse than
 * losing one record.
 */
export function parseLogText(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { skipped++; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { skipped++; continue; }
    records.push(parsed);
  }
  return { records, skipped };
}

/** The session header: what was being played when this log started. */
export function sessionRecord(context = {}, now = Date.now()) {
  const details = {
    ...(clampText(context.app, 120) ? { app: clampText(context.app, 120) } : {}),
    ...(clampText(context.renderer, 120) ? { renderer: clampText(context.renderer, 120) } : {}),
    ...(clampText(context.difficulty, 60) ? { difficulty: clampText(context.difficulty, 60) } : {}),
    ...(clampText(context.mode, 60) ? { mode: clampText(context.mode, 60) } : {}),
    ...(Number.isFinite(context.levels) ? { levels: context.levels } : {}),
    ...(clampText(context.url, 200) ? { url: clampText(context.url, 200) } : {}),
  };
  return normalizeLogEntry({ severity: 'info', category: 'session', message: clampText(context.note, LOG_LIMITS.message)
    || 'Playtest session started', details }, context, now);
}

/** Counts for the session list, so the UI never has to parse a whole file. */
export function summarizeLog(records) {
  const summary = { entries: 0, errors: 0, warnings: 0, infos: 0, categories: {}, first: null, last: null, level: null };
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.severity === 'error') summary.errors++;
    else if (record.severity === 'warning') summary.warnings++;
    else summary.infos++;
    if (record.category) summary.categories[record.category] = (summary.categories[record.category] || 0) + 1;
    if (typeof record.time === 'string') {
      if (!summary.first || record.time < summary.first) summary.first = record.time;
      if (!summary.last || record.time > summary.last) summary.last = record.time;
    }
    if (!summary.level && record.level) summary.level = record.level;
    summary.entries++;
  }
  return summary;
}

/**
 * Identity used to collapse a repeating failure into one record with a count: an
 * error thrown every frame should read "×1400" instead of filling the file.
 */
export function logEntryKey(record) {
  const details = record?.details;
  const where = details?.where || details?.file || details?.line || '';
  return `${record?.category ?? ''}|${record?.severity ?? ''}|${record?.message ?? ''}|${where}`;
}
