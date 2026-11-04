export async function readServiceResponse(response, path) {
  const restart = 'Save/export your edits, run ./launch.sh or npm start to restart OpenDLE, then refresh the editor. For server-only mode, stop the old server manually before running npm run serve.';
  if (!response.headers.get('content-type')?.includes('application/json')) {
    if (response.status === 404) throw new Error(`The local server does not provide ${path} (HTTP 404). It may be an older OpenDLE backend. ${restart}`);
    throw new Error(`Expected JSON from ${path}, but the local service returned ${response.headers.get('content-type') || 'no content type'} (HTTP ${response.status}). Check the local server and its URL. ${restart}`);
  }
  let body;
  try { body = await response.json(); }
  catch (error) { throw new Error(`Invalid JSON response from ${path} (HTTP ${response.status}). Check the local server logs.`, { cause: error }); }
  if (!response.ok) {
    // The status and the body travel with the error: a save turned away because another
    // client saved first (409) is recoverable, and the caller cannot tell without them.
    const error = new Error(body?.error || `Local service returned HTTP ${response.status} for ${path}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}
