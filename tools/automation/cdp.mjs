// A minimal Chrome DevTools Protocol client.
//
// Node 22 ships a global WebSocket, so a test harness can drive Chromium with no dependency at
// all. Every call returns a small value; nothing here harvests DOM snapshots, which is what makes
// long automation runs affordable for the editor's memory budget.

import { setTimeout as delay } from 'node:timers/promises';

export async function listTargets(port, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
      lastError = new Error(`DevTools endpoint answered HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`No DevTools endpoint on ${port}: ${lastError?.message || 'timed out'}`);
}

/** The first page target whose URL matches, newest first. */
export async function pageTarget(port, match = () => true, options) {
  const targets = await listTargets(port, options);
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
  const found = pages.find(target => match(target.url)) || pages[0];
  if (!found) throw new Error('The desktop window has no page target');
  return found;
}

export async function connect(port, { match, timeout } = {}) {
  const target = await pageTarget(port, match, { timeout });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const events = [];
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot attach to ${target.url}`)), { once: true });
  });
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method) events.push(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('The DevTools connection closed'));
    pending.clear();
  });

  /** Evaluate an expression in the page and return its value; throws on a page exception. */
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Page exception: ${String(detail).split('\n')[0]}`);
    }
    return result.result?.value;
  };

  /** Wait until `expression` is truthy, returning its value. */
  const waitFor = async (expression, { timeout: budget = 30000, interval = 60, label = expression } = {}) => {
    const deadline = Date.now() + budget;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (error) { last = error.message; }
      await delay(interval);
    }
    throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
  };

  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1,
    buttons: type === 'mousePressed' || type === 'mouseMoved' ? 1 : 0, ...extra,
  });
  const move = (x, y) => mouse('mouseMoved', x, y, { buttons: 0 });
  const press = (x, y) => mouse('mousePressed', x, y);
  const release = (x, y) => mouse('mouseReleased', x, y);
  /** A press-move-release drag with intermediate moves, so the page sees a real drag. */
  const drag = async (from, to, { steps = 8, pause = 6 } = {}) => {
    await move(from.x, from.y);
    await press(from.x, from.y);
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      await delay(pause);
    }
    await release(to.x, to.y);
  };
  /** A right click that does not move, which is how the editor's context menus open. */
  const rightClick = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y),
      button: 'right', buttons: 2, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
      button: 'right', buttons: 0, clickCount: 1 });
  };
  const key = async (code, { text, label } = {}) => {
    const common = { code, key: label || code, windowsVirtualKeyCode: virtualKey(code), nativeVirtualKeyCode: virtualKey(code) };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  };

  return { target, send, evaluate, waitFor, move, press, release, drag, rightClick, key, events,
    close: () => socket.close() };
}

function virtualKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit\d$/.test(code)) return code.charCodeAt(5);
  return { Enter: 13, Escape: 27, Delete: 46, Backspace: 8, Space: 32, ShiftLeft: 16 }[code] || 0;
}
