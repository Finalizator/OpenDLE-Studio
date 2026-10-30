/**
 * Records every object a view had to draw as a grey placeholder.
 *
 * The renderer knows which objects it could not give artwork (no sprite, a sprite that is
 * not in the project, only a collider), but that fact disappears with the tab. These lines
 * go to their own log folder, so "why does the map look wrong" is answered by a file that
 * names each such object, its type, its position and what it was missing.
 *
 * Writes are best-effort: a logging failure must never disturb the game.
 */
import { createLogId } from '../shared/playtest-log.js';

const SESSION_KEY = 'opendle-placeholder-session';

export function createPlaceholderLog({ send, storage = globalThis.sessionStorage, now = () => Date.now(), random = Math.random } = {}) {
  let session;
  try { session = storage?.getItem(SESSION_KEY) || undefined; } catch { /* storage may be blocked */ }
  if (!session) {
    session = createLogId(now(), random);
    try { storage?.setItem(SESSION_KEY, session); } catch { /* ignore */ }
  }
  const sent = new Set();
  let headerSent = false;

  return {
    session,
    /** Sends the records that have not been written yet. Returns how many were queued. */
    async flush(report, { mode = 'view', level = '', project: title = '', keepalive = false } = {}) {
      if (!Array.isArray(report) || !report.length) return 0;
      const entries = [];
      for (const item of report) {
        const key = `${mode}:${item.id}:${item.drawn}:${item.reason}`;
        if (sent.has(key)) continue;
        sent.add(key);
        entries.push({
          severity: 'info', category: 'placeholder',
          level: level || undefined,
          message: `${mode === 'editor' ? 'Editor' : 'Game'} drew ${item.name} (${item.type}${item.doomType ? ` #${item.doomType}` : ''}) `
            + `as a ${item.drawn === 'box' ? 'grey box' : 'grey billboard'}: ${item.reason}`,
          details: { ...item, mode },
        });
        if (entries.length >= 400) break;
      }
      if (!entries.length && headerSent) return 0;
      const header = headerSent ? undefined : {
        severity: 'info', category: 'placeholder',
        message: `${title || 'Project'} — placeholder report (${mode})`,
        details: { mode, project: title || null, level: level || null, count: report.length },
      };
      try {
        await send({ session, header: header || undefined, entries }, { keepalive });
        headerSent ||= Boolean(header);
        return entries.length;
      } catch (error) {
        for (const entry of entries) sent.delete(`${mode}:${entry.details.id}:${entry.details.drawn}:${entry.details.reason}`);
        throw error;
      }
    },
    get sentCount() { return sent.size; },
  };
}
