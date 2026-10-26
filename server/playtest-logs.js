/**
 * Playtest log storage.
 *
 * Logs live in one folder as newline-delimited JSON, one file per playtest session.
 * The folder is meant to be opened in an editor or handed to the AI: a session file
 * starts with a header record describing what was played, then one line per failure.
 *
 * Writes are append-only and bounded. A browser page can post anything, so every
 * limit here is enforced on the server even when the client already respects it.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isLogFileName, isLogId, logFileName, normalizeLogEntry, parseLogText, summarizeLog, LOG_LIMITS } from '../shared/playtest-log.js';

const INDEX = 'index.json';

export const DEFAULT_LOG_DIRECTORY = join('logs', 'playtest');

/**
 * @param {object} options
 * @param {string} options.directory absolute folder for session files
 * @param {number} [options.maxSessions] how many playtests to keep
 * @param {number} [options.maxFileBytes] per-session size ceiling
 */
export function createPlaytestLogStore({ directory, maxSessions = LOG_LIMITS.sessions,
  maxFileBytes = LOG_LIMITS.fileBytes, maxEntries = LOG_LIMITS.entriesPerSession } = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('Playtest logs need a directory');
  const index = loadIndex();
  let writes = 0;

  function ensureDirectory() {
    mkdirSync(directory, { recursive: true });
  }

  function indexPath() {
    return join(directory, INDEX);
  }

  function loadIndex() {
    try {
      const parsed = JSON.parse(readFileSync(indexPath(), 'utf8'));
      if (parsed && typeof parsed.sessions === 'object' && parsed.sessions) return parsed.sessions;
    } catch { /* A missing or corrupt index is rebuilt from the files. */ }
    return {};
  }

  function saveIndex() {
    ensureDirectory();
    // The index is a cache: losing it costs a rescan, never data.
    try {
      writeFileSync(`${indexPath()}.tmp`, `${JSON.stringify({ version: 1, sessions: index }, null, 2)}\n`);
      renameSync(`${indexPath()}.tmp`, indexPath());
    } catch { /* The log file itself is already written; the index can be rebuilt. */ }
  }

  function filePath(session) {
    return join(directory, logFileName(session));
  }

  function fileSize(session) {
    try { return statSync(filePath(session)).size; } catch { return 0; }
  }

  /** Rebuilds one index entry from the file when the index is missing or stale. */
  function scanSession(session) {
    let text;
    try { text = readFileSync(filePath(session), 'utf8'); } catch { return null; }
    const { records } = parseLogText(text);
    const header = records.find(record => record.category === 'session') || records[0] || {};
    const summary = summarizeLog(records);
    return {
      id: session,
      startedAt: header.time || summary.first || null,
      updatedAt: summary.last || header.time || null,
      level: header.level || summary.level || null,
      project: header.project || null,
      entries: summary.entries,
      errors: summary.errors,
      warnings: summary.warnings,
      categories: summary.categories,
      bytes: fileSize(session),
      truncated: false,
    };
  }

  function reconcile() {
    ensureDirectory();
    const files = readdirSync(directory).filter(isLogFileName);
    let changed = false;
    for (const name of files) {
      const session = name.slice(0, -4);
      if (!index[session]) {
        const scanned = scanSession(session);
        if (scanned) { index[session] = scanned; changed = true; }
      }
    }
    for (const session of Object.keys(index)) {
      if (!isLogId(session) || !existsSync(filePath(session))) { delete index[session]; changed = true; }
    }
    if (changed) saveIndex();
    return files;
  }

  function prune() {
    const sessions = Object.values(index).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    let removed = 0;
    while (sessions.length > maxSessions) {
      const oldest = sessions.shift();
      try { unlinkSync(filePath(oldest.id)); } catch { /* already gone */ }
      delete index[oldest.id];
      removed++;
    }
    return removed;
  }

  return {
    directory,
    get indexFile() { return indexPath(); },

    /**
     * Appends a batch. Returns what was actually written so the client can tell a
     * capped session from an accepted one instead of assuming success.
     */
    append(session, entries, { header } = {}) {
      if (!isLogId(session)) throw new Error('Playtest session id is invalid');
      ensureDirectory();
      writes++;
      reconcile();
      const file = filePath(session);
      const isNew = !existsSync(file);
      const existing = index[session];
      const size = fileSize(session);
      if (existing?.truncated && !isNew) {
        return { session, written: 0, truncated: true, reason: 'session log is already full' };
      }
      // A file that has no room for the next record is as full as one at the byte
      // cap: both stop writing and say so, instead of silently dropping records.
      if (size >= maxFileBytes - 64 || (existing?.entries ?? 0) >= maxEntries) {
        if (!existing?.truncated) {
          const notice = normalizeLogEntry({
            severity: 'warning', category: 'logging',
            message: `Playtest log limit reached (${Math.round(size / 1024)} KiB / ${maxEntries} entries); later failures for this session are not written.`,
          }, { session });
          try { appendFileSync(file, `${JSON.stringify(notice)}\n`); } catch { /* disk full */ }
          index[session] = { ...(existing || scanSession(session) || { id: session }), truncated: true, bytes: size };
          saveIndex();
        }
        return { session, written: 0, truncated: true, reason: 'session log limit reached' };
      }

      const records = [];
      let bytes = 0, overflowed = false;
      for (const entry of entries) {
        const record = normalizeLogEntry(entry, { session });
        const room = Math.max(0, maxFileBytes - size - bytes);
        const line = `${JSON.stringify(record)}\n`;
        if (line.length > room) { overflowed = true; break; }
        records.push(line);
        bytes += line.length;
      }
      const headerLine = isNew ? `${JSON.stringify(header || normalizeLogEntry({
        severity: 'info', category: 'session', message: 'Playtest session started' }, { session }))}\n` : '';
      if (records.length || headerLine) {
        const text = headerLine + records.join('');
        appendFileSync(file, text);
      }
      const scanned = isNew || !existing ? scanSession(session) : null;
      const summary = summarizeLog(records.map(line => { try { return JSON.parse(line); } catch { return null; } }));
      const merged = scanned || {
        ...existing,
        entries: existing.entries + summary.entries,
        errors: existing.errors + summary.errors,
        warnings: existing.warnings + summary.warnings,
        categories: mergeCategories(existing.categories, summary.categories),
        updatedAt: summary.last || existing.updatedAt,
        level: existing.level || summary.level || null,
        bytes: fileSize(session),
      };
      if (overflowed) {
        const notice = normalizeLogEntry({ severity: 'warning', category: 'logging',
          message: `Playtest log limit reached (${Math.round(fileSize(session) / 1024)} KiB); later failures for this session are not written.` }, { session });
        try { appendFileSync(file, `${JSON.stringify(notice)}\n`); } catch { /* disk full */ }
      }
      index[session] = { ...merged, id: session, bytes: fileSize(session), truncated: overflowed };
      const dropped = prune();
      saveIndex();
      return { session, written: records.length, truncated: false, bytes: index[session].bytes, dropped };
    },

    list() {
      reconcile();
      const sessions = Object.values(index)
        .map(entry => ({ ...entry, file: logFileName(entry.id) }))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      return {
        directory,
        sessions,
        totals: sessions.reduce((totals, session) => ({
          entries: totals.entries + (session.entries || 0),
          errors: totals.errors + (session.errors || 0),
          warnings: totals.warnings + (session.warnings || 0),
          bytes: totals.bytes + (session.bytes || 0),
        }), { entries: 0, errors: 0, warnings: 0, bytes: 0 }),
      };
    },

    read(session, { limit = 5000 } = {}) {
      if (!isLogId(session)) throw new Error('Playtest session id is invalid');
      if (!existsSync(filePath(session))) throw new Error(`Unknown playtest session: ${session}`);
      const text = readFileSync(filePath(session), 'utf8');
      const { records, skipped } = parseLogText(text);
      const visible = limit > 0 ? records.slice(0, limit) : records;
      return {
        session, file: logFileName(session), directory, skipped, total: records.length,
        summary: summarizeLog(records), entries: visible,
      };
    },

    clear() {
      ensureDirectory();
      let removed = 0;
      for (const name of readdirSync(directory)) {
        if (!isLogFileName(name)) continue;
        try { unlinkSync(join(directory, name)); removed++; } catch { /* ignore */ }
      }
      for (const session of Object.keys(index)) delete index[session];
      try { rmSync(indexPath(), { force: true }); } catch { /* ignore */ }
      return { removed };
    },

    stats() {
      return { directory, sessions: Object.keys(index).length, writes };
    },
  };
}

function mergeCategories(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) merged[key] = (merged[key] || 0) + value;
  return merged;
}
