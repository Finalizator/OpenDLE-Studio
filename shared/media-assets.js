export const VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export function isImageAsset(asset) {
  return Boolean(asset) && ['texture', 'flat', 'sky', 'sprite', 'weapon'].includes(asset.kind);
}

const VIDEO_FORMATS = new Map([
  ['video/mp4', { format: 'mp4', extension: 'mp4' }],
  ['video/webm', { format: 'webm', extension: 'webm' }],
]);
const VIDEO_EXTENSIONS = new Map([['mp4', 'video/mp4'], ['webm', 'video/webm']]);

export function videoMimeForFile(file) {
  const declared = VIDEO_FORMATS.has(String(file?.type || '').toLowerCase()) ? String(file.type).toLowerCase() : null;
  const extension = String(file?.name || '').split('.').pop().toLowerCase();
  const inferred = VIDEO_EXTENSIONS.get(extension);
  if (!declared && !inferred) throw new Error('Choose a local MP4 or WebM video');
  if (declared && inferred && declared !== inferred) throw new Error('The video file extension does not match its MIME type');
  const mime = declared || inferred;
  if (file.size > VIDEO_MAX_BYTES) throw new Error('Videos must be no larger than 64 MiB');
  return mime;
}

function base64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

export async function embedVideoFile(file, id) {
  const mime = videoMimeForFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > VIDEO_MAX_BYTES) throw new Error('Videos must be no larger than 64 MiB');
  const name = String(file.name || '').replace(/\.(mp4|webm)$/i, '').trim();
  if (!name || name.length > 100) throw new Error('Video names must be 1-100 characters');
  const format = VIDEO_FORMATS.get(mime).format;
  return { id, name, kind: 'video', format, src: `data:${mime};base64,${base64(bytes)}` };
}
