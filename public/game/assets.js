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
 * `report(index, total, asset)` is called as files arrive, so a big campaign can say what it is
 * doing; `fetchImpl` is the page's own `fetch` unless a caller (a test) supplies another.
 */
export async function hydrateAssets(project, report = () => {}, fetchImpl = (...args) => fetch(...args)) {
  const network = (project.assets || []).filter(asset =>
    typeof asset?.src === 'string' && asset.src && !/^(data|blob|https?):/i.test(asset.src));
  for (const [index, asset] of network.entries()) {
    report(index, network.length, asset);
    const response = await fetchImpl(asset.src);
    if (!response.ok) throw new Error(`${asset.name || asset.id}: ${asset.src} could not be loaded (${response.status})`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    const mime = asset.srcMime || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    asset.src = `data:${mime};base64,${toBase64(buffer)}`;
    delete asset.srcMime;
  }
  report(network.length, network.length);
}

/** Base64 without spreading a large buffer into an argument list. */
export function toBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

