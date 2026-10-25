import test from 'node:test';
import assert from 'node:assert/strict';
import { requireLicenseAgreement } from '../public/license-agreement.js';

function fixture(saved = null) {
  const dialog = new EventTarget(), accept = new EventTarget(), decline = new EventTarget();
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const text = {}, message = {};
  let record = saved;
  const storage = { getItem: () => record, setItem: (_key, value) => { record = value; } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'v1', text: 'Full terms', sha256: 'abc' }) });
  const options = { dialog, accept, decline, text, message, storage, fetchImpl };
  return { ...options, options, record: () => record };
}
const ready = () => new Promise(resolve => setImmediate(resolve));

test('first launch requires explicit acceptance and remembers the exact license', async () => {
  const f = fixture(), result = requireLicenseAgreement(f.options);
  await ready();
  assert.equal(f.dialog.open, true); assert.equal(f.text.textContent, 'Full terms');
  assert.equal(f.record(), null);
  f.accept.dispatchEvent(new Event('click'));
  assert.equal(await result, true); assert.equal(f.dialog.open, false);
  const record = JSON.parse(f.record());
  assert.equal(record.licenseId, 'v1'); assert.equal(record.sha256, 'abc');
  assert.ok(Number.isFinite(Date.parse(record.acceptedAt)));
  assert.equal(await requireLicenseAgreement(f.options), true);
  assert.equal(f.dialog.open, false);
});

test('decline and Escape do not record acceptance or open the editor', async () => {
  for (const escape of [false, true]) {
    const f = fixture(), result = requireLicenseAgreement(f.options);
    await ready();
    if (escape) {
      const event = new Event('cancel', { cancelable: true });
      f.dialog.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    } else f.decline.dispatchEvent(new Event('click'));
    assert.equal(await result, false); assert.equal(f.record(), null);
    assert.equal(f.dialog.open, true);
  }
});

test('changed or invalid records prompt again and failed storage does not grant entry', async () => {
  for (const saved of ['broken', JSON.stringify({ licenseId: 'v1', sha256: 'old', acceptedAt: '2026-10-25' })]) {
    const f = fixture(saved), result = requireLicenseAgreement(f.options);
    await ready(); assert.equal(f.dialog.open, true);
    f.storage.setItem = () => { throw new Error('Storage blocked'); };
    f.accept.dispatchEvent(new Event('click'));
    assert.equal(f.dialog.open, true);
    assert.match(f.message.textContent, /Acceptance could not be saved: Storage blocked/);
    f.decline.dispatchEvent(new Event('click'));
    assert.equal(await result, false);
  }
});

test('license fetch failures and malformed responses fail closed', async () => {
  const f = fixture();
  f.options.fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(requireLicenseAgreement(f.options), /HTTP 500/);
  assert.equal(f.accept.disabled, true);
  const cancel = new Event('cancel', { cancelable: true });
  f.dialog.dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true);
  const malformed = fixture();
  malformed.options.fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(requireLicenseAgreement(malformed.options), /invalid license/);
});
