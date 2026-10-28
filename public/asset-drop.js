// Routing for files dropped on the asset browser. Model sources win over images
// and sounds because a glTF drop also carries its .bin buffer and textures, which
// the model bundler resolves by relative path.
const MODEL_SOURCE = /\.(glb|gltf|bbmodel)$/i;
// A saved node is a scene object of its own, not artwork.
const NODE_FILE = /\.node$/i;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const SOUND = /\.(wav|ogg|mp3)$/i;

export const IMAGE_KINDS = new Set(['texture', 'flat', 'sky', 'sprite', 'weapon']);

export function groupDroppedFiles(files) {
  const list = [...(files || [])].filter(file => file && typeof file.name === 'string');
  const models = list.filter(file => MODEL_SOURCE.test(file.name));
  const images = list.filter(file => IMAGE.test(file.name));
  const sounds = list.filter(file => SOUND.test(file.name));
  const nodes = list.filter(file => NODE_FILE.test(file.name));
  return {
    // Everything travels with a model drop so .bin buffers and textures resolve.
    models: models.length ? list : [],
    images: models.length ? [] : images,
    sounds: models.length ? [] : sounds,
    nodes: models.length ? [] : nodes,
    ignored: list.filter(file => !MODEL_SOURCE.test(file.name) && !IMAGE.test(file.name) && !SOUND.test(file.name)
      && !NODE_FILE.test(file.name)),
  };
}

// Folder drops arrive as directory entries; File.webkitRelativePath is read only,
// so each dropped file is labelled with the path the model bundler resolves
// dependencies against. The File itself is kept whenever possible: image import
// passes it to createImageBitmap, which needs a real Blob.
function withPath(file, path) {
  try {
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
    return file;
  } catch {
    return {
      name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, webkitRelativePath: path,
      arrayBuffer: () => file.arrayBuffer(), text: () => file.text(),
    };
  }
}

async function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readEntry(entry, prefix, files, depth = 0) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    files.push(withPath(file, `${prefix}${file.name}`));
    return;
  }
  if (!entry.isDirectory || depth > 8) return;
  const reader = entry.createReader();
  // Chrome returns at most 100 entries per readEntries call.
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, files, depth + 1);
  }
}

export async function readDroppedFiles(dataTransfer, { maxFiles = 300 } = {}) {
  const items = dataTransfer?.items ? [...dataTransfer.items] : [];
  const entries = items.map(item => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null)).filter(Boolean);
  if (!entries.length) return [...(dataTransfer?.files || [])].slice(0, maxFiles);
  const files = [];
  for (const entry of entries) {
    await readEntry(entry, '', files);
    if (files.length >= maxFiles) break;
  }
  return files.slice(0, maxFiles);
}
