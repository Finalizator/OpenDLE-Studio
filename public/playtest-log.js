/**
 * Browser-side playtest logger.
 *
 * Errors during a playtest only exist in the page, so they are captured here and
 * batched to the local service, which appends them to a log file. Three properties
 * matter more than throughput:
 *
 * - Logging never throws. A logger that breaks the game while reporting a break is
 *   worse than no logger at all.
 * - A failure that happens every frame is one record with a repeat count, not 60
 *   lines a second.
 * - If the service is unreachable (or the game runs as an exported build with no
 *   service) records survive in browser storage and are reported as unsaved instead
 *   of being silently dropped.
 */

import { createLogId, logEntryKey, normalizeLogEntry, sessionRecord } from '../shared/playtest-log.js';

const STORAGE_KEY = 'opendle-playtest-log-pending';
const SESSION_KEY = 'opendle-playtest-session';
const DEDUPE_WINDOW = 30000;
const MAX_PENDING = 400;
const SESSION_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

function memoryStorage() {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } };
}

/** Storage access can throw (private mode, opaque origin), so it is probed once. */
export function readStorage(kind) {
  try {
    const storage = globalThis[kind];
    if (!storage) return null;
    const probe = '__opendle_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch { return null; }
}

const readJson = (store, key) => {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const writeJson = (store, key, value) => {
  try { store?.setItem(key, JSON.stringify(value)); return Boolean(store); } catch { return false; }
};

export function createPlaytestLogger({
  send = async () => ({ written: 0 }),
  tabStorage,
  durableStorage,
  now = () => Date.now(),
  random = Math.random,
  flushDelay = 2000,
  maxPending = MAX_PENDING,
  session: providedSession,
} = {}) {
  const tabs = tabStorage === undefined ? readStorage('sessionStorage') : tabStorage;
  const durable = durableStorage === undefined ? readStorage('localStorage') : durableStorage;
  // One playtest per tab: a reload continues the same log file, a new tab starts a
  // new one. sessionStorage has exactly that lifetime.
  const remembered = readJson(tabs, SESSION_KEY)?.session;
  const session = [providedSession, remembered].find(value => typeof value === 'string' && SESSION_PATTERN.test(value))
    || createLogId(now(), random);
  writeJson(tabs, SESSION_KEY, { session });

  let context = { session };
  // An exported build has no local service at all, so after a few failed batches the
  // logger stops calling out and only keeps records in browser storage.
  let disabled = false;
  let pending = [];
  let timer = null;
  let closed = false;
  const recent = new Map();
  const stats = { queued: 0, collapsed: 0, written: 0, failedBatches: 0, dropped: 0, lastError: null, persisted: false };

  // Records left unsent by an earlier page are sent first, so a reload does not lose
  // the errors that caused it.
  for (const entry of (readJson(durable, STORAGE_KEY)?.entries || []).slice(-maxPending)) {
    if (entry && typeof entry === 'object') pending.push(entry);
  }

  function persistPending() {
    if (!durable) { stats.persisted = false; return; }
    const keep = pending.slice(-maxPending);
    stats.dropped += pending.length - keep.length;
    stats.persisted = writeJson(durable, STORAGE_KEY, { session, entries: keep, savedAt: now() });
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushDelay);
    // A pending flush must not keep the page alive on its own.
    timer?.unref?.();
  }

  /** Records one failure. Returns the stored record, or null when it was dropped. */
  function log(entry) {
    if (closed) return null;
    let record;
    try { record = normalizeLogEntry(entry, context, now()); } catch { return null; }
    const key = logEntryKey(record);
    const seen = recent.get(key);
    if (seen && now() - seen.at < DEDUPE_WINDOW && pending.includes(seen.record)) {
      seen.record.repeats = (seen.record.repeats || 1) + 1;
      seen.record.time = record.time;
      seen.at = now();
      stats.collapsed++;
      return seen.record;
    }
    if (pending.length >= maxPending) {
      // The earliest failures usually explain the rest, so the newest are dropped.
      stats.dropped++;
      return null;
    }
    pending.push(record);
    recent.set(key, { record, at: now() });
    if (recent.size > 400) recent.delete(recent.keys().next().value);
    stats.queued++;
    if (record.severity === 'error') flush().catch(() => {});
    else schedule();
    return record;
  }

  const error = (category, message, details) => log({ severity: 'error', category, message, details });
  const warn = (category, message, details) => log({ severity: 'warning', category, message, details });
  const info = (category, message, details) => log({ severity: 'info', category, message, details });

  // Notices about limitations (an unsupported action function, a missing feature)
  // are worth one line per session, not one per occurrence.
  const onceKeys = new Set();
  function once(key, entry) {
    if (onceKeys.has(key)) return null;
    onceKeys.add(key);
    return log(entry);
  }

  /** Merges playtest circumstances (level, renderer, difficulty) into later records. */
  function setContext(patch) {
    context = { ...(context || {}), ...patch, session };
    return context;
  }

  /** Sends one batch and records the outcome. Never throws. */
  async function sendBatch(keepalive) {
    const batch = pending.slice();
    try {
      const result = await send({ session, header: sessionRecord(context, now()), entries: batch }, { keepalive });
      const accepted = Number.isFinite(result?.written) ? result.written : batch.length;
      pending = pending.slice(accepted);
      stats.written += accepted;
      stats.lastError = null;
      // A full session file cannot accept later records; retrying forever would only
      // fill the browser buffer with records that can never be written.
      if (result?.truncated && !accepted) pending = [];
      persistPending();
    } catch (failure) {
      stats.failedBatches++;
      stats.lastError = String(failure?.message || failure).slice(0, 200);
      if (stats.failedBatches >= 3) disabled = true;
      persistPending();
    }
  }

  async function drain({ keepalive = false } = {}) {
    for (let round = 0; round < 8; round++) {
      if (!pending.length) { persistPending(); return stats; }
      if (disabled) return stats;
      const failures = stats.failedBatches;
      await sendBatch(keepalive);
      // One failed batch means the service is unreachable; do not hammer it.
      if (stats.failedBatches > failures) return stats;
    }
    return stats;
  }

  // Flushes are serialised: two callers awaiting a flush must not each send the same
  // queued record. The chain guarantees one drain at a time, in call order.
  let chain = Promise.resolve();
  function flush(options = {}) {
    const next = chain.then(() => drain(options));
    chain = next.catch(() => stats);
    return next;
  }

  /** Attaches the handlers that catch failures no `try/catch` in the app would see. */
  function attach(target = globalThis) {
    const onError = event => error('uncaught', event.message || 'Uncaught error', {
      where: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      stack: event.error?.stack,
    });
    const onRejection = event => {
      const reason = event.reason;
      error('unhandled-rejection', reason?.message ? String(reason.message) : String(reason),
        { name: reason?.name, stack: reason?.stack });
    };
    const flushNow = () => { flush({ keepalive: true }).catch(() => {}); };
    const onHide = () => { if (target.document?.visibilityState === 'hidden') flushNow(); };
    target.addEventListener?.('error', onError);
    target.addEventListener?.('unhandledrejection', onRejection);
    target.addEventListener?.('pagehide', flushNow);
    target.document?.addEventListener?.('visibilitychange', onHide);
    return () => {
      target.removeEventListener?.('error', onError);
      target.removeEventListener?.('unhandledrejection', onRejection);
      target.removeEventListener?.('pagehide', flushNow);
      target.document?.removeEventListener?.('visibilitychange', onHide);
    };
  }

  function close() {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return {
    session, log, error, warn, info, once, setContext, flush, attach, close,
    get pending() { return pending.length; },
    get context() { return { ...context }; },
    status: () => ({ session, pending: pending.length, offline: disabled, ...stats }),
  };
}
