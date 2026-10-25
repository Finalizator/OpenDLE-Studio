export function requestMouseLock(document, canvas, report) {
  if (document.pointerLockElement === canvas) return;
  if (typeof canvas.requestPointerLock !== 'function') {
    report('Mouse capture is not supported here. Use drag-look, or open this URL in a desktop browser.', true);
    return;
  }
  report('Requesting mouse capture. Your browser may ask for permission.');
  const failure = error => report(error.name === 'WrongDocumentError'
    ? `This embedded browser cannot capture the mouse (${error.name}: ${error.message}). Use Open in system browser for native capture, or drag-look here.`
    : `Mouse capture was denied (${error.name}: ${error.message}). Retry Capture mouse, use drag-look, or open this URL in Chrome/Firefox.`, true);
  try {
    const pending = canvas.requestPointerLock();
    pending?.catch(failure);
  } catch (error) {
    failure(error);
  }
}
