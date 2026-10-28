import { contextMenu } from './context-menu.js';
/**
 * Playtest logs panel.
 *
 * The logs are the record of what broke during a playtest, so the panel's job is to
 * make them findable: where the folder is, which sessions exist, and what each one
 * contains. Everything shown here was written by the service, not by this page, so
 * reloading the panel always reflects the files on disk.
 */

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bytesText(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function whenText(iso) {
  if (!iso) return 'unknown time';
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso;
}

export function createPlaytestLogPanel(nodes, { list, read, clear, status = () => {} } = {}) {
  if (!nodes?.list || !nodes?.detail) throw new Error('Playtest log panel needs a list and a detail node');
  let sessions = [], selected = null, detail = null, busy = false, show = 'all';

  /** Copies text out of the log; the clipboard can be refused outside a user gesture. */
  function copy(text, label) {
    navigator.clipboard?.writeText(text).then(() => status(`Copied ${label}`),
      () => status('Clipboard access was refused by the browser', true));
  }

  async function render() {
    if (busy) return;
    busy = true;
    try {
      const result = await list();
      sessions = result.sessions || [];
      nodes.directory.textContent = result.directory ? `Log folder: ${result.directory}` : '';
      nodes.totals.textContent = sessions.length
        ? `${sessions.length} playtest session(s), ${result.totals.errors} error(s), ${result.totals.warnings} warning(s), ${bytesText(result.totals.bytes)} on disk.`
        : 'No playtest logs yet. Play a level and any failure is written to the log folder.';
      renderSessions();
      if (selected && !sessions.some(session => session.id === selected)) { selected = null; detail = null; }
      if (selected) await showSession(selected);
      else nodes.detail.replaceChildren(element('p', 'muted', 'Select a session to read its records.'));
    } catch (error) {
      nodes.totals.textContent = `Playtest logs unavailable: ${error.message}`;
      status(error.message);
    } finally {
      busy = false;
    }
  }

  function renderSessions() {
    nodes.list.replaceChildren();
    if (!sessions.length) return;
    for (const session of sessions) {
      const row = element('button', 'log-session');
      row.type = 'button';
      row.classList.toggle('selected', selected === session.id);
      const counts = element('span', 'log-counts');
      if (session.errors) counts.append(element('span', 'log-badge error', `${session.errors} error${session.errors === 1 ? '' : 's'}`));
      if (session.warnings) counts.append(element('span', 'log-badge warning', `${session.warnings} warning${session.warnings === 1 ? '' : 's'}`));
      if (!session.errors && !session.warnings) counts.append(element('span', 'log-badge', 'no failures'));
      row.append(element('strong', '', session.level || session.project || 'Playtest'),
        element('small', '', `${whenText(session.startedAt)} · ${session.entries} record(s) · ${bytesText(session.bytes)}${session.truncated ? ' · truncated' : ''}`),
        counts);
      row.addEventListener('click', () => { selected = session.id; renderSessions(); showSession(session.id).catch(error => status(error.message)); });
      row.addEventListener('contextmenu', event => {
        event.preventDefault();
        contextMenu(event, [
          { label: 'Open this session', run: () => { selected = session.id; renderSessions(); showSession(session.id).catch(error => status(error.message)); } },
          { label: 'Copy the session id', run: () => copy(`${session.id}\n`, 'the session id') },
        ], { label: 'Playtest session actions' });
      });
      nodes.list.append(row);
    }
  }

  async function showSession(id) {
    const result = await read(id);
    detail = result;
    renderDetail();
  }

  function renderDetail() {
    nodes.detail.replaceChildren();
    if (!detail) return;
    const { summary, entries } = detail;
    const heading = element('div', 'log-detail-head');
    heading.append(element('h2', '', summary.level || detail.session),
      element('small', 'muted', `${whenText(summary.first)} → ${whenText(summary.last)} · ${summary.entries} record(s) · file ${detail.file}`));
    nodes.detail.append(heading);
    const filters = element('div', 'log-filters');
    for (const [value, label] of [['all', 'All'], ['error', 'Errors'], ['warning', 'Warnings']]) {
      const button = element('button', value === show ? 'primary' : '', label);
      button.type = 'button';
      button.addEventListener('click', () => { show = value; renderDetail(); });
      filters.append(button);
    }
    if (detail.skipped) filters.append(element('span', 'muted', `${detail.skipped} unreadable line(s) skipped`));
    nodes.detail.append(filters);

    const visible = entries
      .filter(entry => show === 'all' || entry.severity === show)
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
    if (!visible.length) { nodes.detail.append(element('p', 'muted', 'No records of this kind.')); return; }
    const list = element('ol', 'log-entries');
    for (const entry of visible) {
      const item = element('li', `log-entry ${entry.severity || 'info'}`);
      item.append(element('span', `log-severity ${entry.severity || 'info'}`, entry.severity || 'info'),
        element('strong', '', entry.message),
        element('small', '', `${entry.category || 'runtime'}${entry.level ? ` · ${entry.level}` : ''}${entry.uptime !== undefined ? ` · t+${entry.uptime.toFixed(1)}s` : ''}${entry.repeats ? ` · repeated ×${entry.repeats}` : ''}`));
      if (entry.details) {
        const details = element('details', 'log-details');
        details.append(element('summary', '', 'Details'), element('pre', '', JSON.stringify(entry.details, null, 1)));
        item.append(details);
      }
      item.addEventListener('contextmenu', event => {
        event.preventDefault();
        contextMenu(event, [
          { label: 'Copy the message', run: () => copy(`${entry.message}\n`, 'the message') },
          { label: 'Copy the whole record', run: () => copy(`${JSON.stringify(entry, null, 1)}\n`, 'the record') },
        ], { label: 'Log entry actions' });
      });
      list.append(item);
    }
    nodes.detail.append(list);
  }

  nodes.refresh?.addEventListener('click', () => {
    nodes.detail?.replaceChildren();
    render();
  });
  nodes.clear?.addEventListener('click', async () => {
    if (!sessions.length) return;
    if (!confirm(`Delete all ${sessions.length} playtest log file(s)? This cannot be undone.`)) return;
    try {
      const result = await clear();
      selected = null; detail = null;
      status(`Deleted ${result.removed} playtest log file(s).`);
      await render();
    } catch (error) { status(error.message); }
  });

  return { render, reload: render };
}
