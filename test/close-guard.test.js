import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloseGuard } from '../server/close-guard.js';

/** A close guard wired to fakes, plus the record of what it did. */
function harness({ attempt, ask = async () => true, timeout = 50 } = {}) {
  const calls = { close: 0, asked: [], logged: [] };
  const guard = createCloseGuard({
    attempt, ask: async reason => { calls.asked.push(reason); return ask(reason); },
    close: () => { calls.close++; },
    log: message => calls.logged.push(message),
    timeout,
  });
  return { guard, calls };
}
const settle = () => new Promise(done => setTimeout(done, 5));

test('a saved project closes without asking anything', async () => {
  const { guard, calls } = harness({ attempt: async () => true });
  assert.equal(guard(), true, 'the guard takes the close over');
  await settle();
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.asked, []);
});

test('unsaved changes are offered, and choosing to close closes', async () => {
  const { guard, calls } = harness({ attempt: async () => false, ask: async () => true });
  guard();
  await settle();
  assert.equal(calls.asked.length, 1);
  assert.match(calls.asked[0], /unsaved changes/);
  assert.equal(calls.close, 1);
});

test('choosing to keep editing leaves the window open, and the next close works', async () => {
  // This is the regression: the old implementation cleared its "closing" flag only after a
  // successful close, so cancelling once made every later attempt do nothing.
  let allow = false;
  const { guard, calls } = harness({ attempt: async () => false, ask: async () => allow });
  guard();
  await settle();
  assert.equal(calls.close, 0);
  assert.equal(calls.asked.length, 1);

  allow = true;
  guard();
  await settle();
  assert.equal(calls.close, 1, 'a later close is decided again');
  assert.equal(calls.asked.length, 2);
});

test('a save that fails asks with the reason, it does not fail silently', async () => {
  const { guard, calls } = harness({
    attempt: async () => { throw new Error('The service is not answering'); },
    ask: async () => true,
  });
  guard();
  await settle();
  assert.deepEqual(calls.asked, ['The service is not answering']);
  assert.equal(calls.close, 1, 'the person can still leave');
});

test('a save that never answers cannot trap the window', async () => {
  // A hundred-megabyte save against a server that stopped answering: the promise never settles.
  const { guard, calls } = harness({ attempt: () => new Promise(() => {}), timeout: 20, ask: async () => true });
  guard();
  await new Promise(done => setTimeout(done, 40));
  assert.equal(calls.asked.length, 1, 'after the deadline the offer is made anyway');
  assert.equal(calls.close, 1);
});

test('a decided close does not start a second decision, and finishes to a clean state', async () => {
  let finish;
  const attempt = () => new Promise(done => { finish = done; });
  const { guard, calls } = harness({ attempt, ask: async () => true });
  assert.equal(guard(), true);
  assert.equal(guard(), true, 'a second click while deciding is swallowed');
  assert.equal(guard(), true);
  finish(true);
  await settle();
  assert.equal(calls.close, 1, 'one save, one close');

  // And the guard is usable again afterwards, not wedged by the swallowed clicks.
  const second = harness({ attempt: async () => true });
  second.guard();
  await settle();
  assert.equal(second.calls.close, 1);
});

test('a cancel is logged so a bug report has something to read', async () => {
  const { guard, calls } = harness({ attempt: async () => false, ask: async () => false });
  guard();
  await settle();
  assert.equal(calls.close, 0);
  assert.equal(calls.logged.length, 1);
  assert.match(calls.logged[0], /cancelled/);
});
