export async function requireLicenseAgreement({ dialog, text, accept, decline, message, storage = localStorage, fetchImpl = fetch }) {
  dialog.showModal();
  const preventDismiss = event => event.preventDefault();
  dialog.addEventListener('cancel', preventDismiss);
  accept.disabled = true; decline.disabled = true;
  const response = await fetchImpl('/api/license', { cache: 'no-store' });
  if (!response.ok) throw new Error(`License could not be loaded (HTTP ${response.status})`);
  const license = await response.json();
  if (typeof license.id !== 'string' || typeof license.text !== 'string' || !license.text ||
    typeof license.sha256 !== 'string') throw new Error('The server returned an invalid license document');
  text.textContent = license.text;
  const key = 'opendle-license-acceptance';
  const stored = storage.getItem(key);
  let record;
  if (stored !== null) {
    try { record = JSON.parse(stored); }
    catch { message.textContent = 'The saved acceptance record is invalid. Please review and accept again.'; }
  }
  if (record?.licenseId === license.id && typeof record.acceptedAt === 'string' && record.sha256 === license.sha256) {
    dialog.removeEventListener('cancel', preventDismiss);
    dialog.close();
    return true;
  }
  accept.disabled = false; decline.disabled = false;
  return new Promise(resolve => {
    function cleanup() {
      accept.removeEventListener('click', agree);
      decline.removeEventListener('click', reject);
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('cancel', preventDismiss);
    }
    function agree() {
      try {
        storage.setItem(key, JSON.stringify({ licenseId: license.id, sha256: license.sha256, acceptedAt: new Date().toISOString() }));
      } catch (error) {
        message.textContent = `Acceptance could not be saved: ${error.message}. Allow browser storage and try again.`;
        return;
      }
      cleanup(); dialog.close(); resolve(true);
    }
    function reject() { cleanup(); resolve(false); }
    function cancel(event) { event.preventDefault(); reject(); }
    accept.addEventListener('click', agree);
    decline.addEventListener('click', reject);
    dialog.addEventListener('cancel', cancel);
  });
}
