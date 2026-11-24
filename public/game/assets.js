// Putting an exported game's asset files back into its document.
//
// The build writes every texture, sound and model as its own file and names it by URL, so the game
// folder is a folder a person can read. The engine, though, wants an asset's bytes in hand — it
// decodes a model while it builds the scene — so the files are fetched once and turned back into
// the data URLs the rest of the engine already understands. Split on disk, joined at load: the same
// deal the studio makes with its own project folder.

/**
 * Puts the payloads back into the document, in memory, right before a level starts.
 *
 * A campaign is thousands of files, so they are fetched a few at a time rather than one after
 * another (2218 of them in sequence is a wait nobody would sit through), each with its own
 * deadline: one stalled request must not become a game that never finishes loading.
 *
 * `report(index, total, asset)` says how far along it is; `fetchImpl` is the page's own `fetch`
 * unless a caller (a test) supplies another. Files that cannot be read are reported rather than
 * thrown: a missing texture should leave a hole, not cost the player the level.
 */
export async function hydrateAssets(project, report = () => {}, fetchImpl = (...args) => fetch(...args),
  { concurrency = 8, timeout = 20000, onFailure = () => {} } = {}) {
  const network = (project.assets || []).filter(asset =>
    typeof asset?.src === 'string' && asset.src && !/^(data|blob|https?):/i.test(asset.src));
  const queue = [...network];
  const failures = [];
  let done = 0;
  report(0, network.length, null);
  const worker = async () => {
    while (queue.length) {
      const asset = queue.shift();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeout) : 0;
      try {
        const response = await fetchImpl(asset.src, controller ? { signal: controller.signal } : undefined);
        if (!response.ok) throw new Error(`${asset.src} could not be loaded (${response.status})`);
        const buffer = new Uint8Array(await response.arrayBuffer());
        const mime = asset.srcMime || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
        asset.src = `data:${mime};base64,${toBase64(buffer)}`;
        delete asset.srcMime;
      } catch (error) {
        const reason = error?.name === 'AbortError' ? `${timeout} ms without an answer` : error.message;
        failures.push({ asset, reason });
        onFailure(asset, reason);
      } finally {
        if (timer) clearTimeout(timer);
        report(++done, network.length, asset);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { loaded: network.length - failures.length, failed: failures };
}

/** Base64 without spreading a large buffer into an argument list. */
export function toBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
