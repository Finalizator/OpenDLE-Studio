/**
 * Reading an exported project folder back from its zip.
 *
 * Exports are zips of the folder format (`server/project-folder.js`) — the document plus the
 * asset files it names — so a project can leave the studio as something a person can unzip,
 * browse and put back. This is data from outside the studio, so it is bounded by entry count and
 * expanded size, paths are normalised, and only `project.json` and the files it names are read.
 *
 * It lives apart from `project-folder.js` because it needs `yauzl`, and the portable build ships
 * the packing side inside a game that has no node_modules.
 */

import { posix } from 'node:path';
import yauzl from 'yauzl';
import { PROJECT_FILE, isFolderDocument, unpackProject } from './project-folder.js';

const MiB = 1024 * 1024;
const MAX_ARCHIVE = 1024 * MiB;
const MAX_UNPACKED = 2048 * MiB;
const MAX_ENTRIES = 20000;

/**
 * Reads an exported project folder back from its zip.
 *
 * The archive is data from outside the studio, so entries are bounded by count and size, paths
 * are normalised, and only `project.json` and files it names are read.
 */
export async function readProjectArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The project archive is empty');
  if (buffer.length > MAX_ARCHIVE) throw new Error(`The project archive exceeds ${MAX_ARCHIVE / MiB} MiB`);
  const zip = await new Promise((resolveZip, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true },
    (error, opened) => error ? reject(error) : resolveZip(opened)));
  const files = new Map();
  await new Promise((resolveZip, reject) => {
    let entries = 0, total = 0, done = false;
    const fail = error => { if (!done) { done = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('end', () => { if (!done) { done = true; resolveZip(); } });
    zip.on('entry', entry => {
      try {
        if (++entries > MAX_ENTRIES) throw new Error(`The project archive has more than ${MAX_ENTRIES} entries`);
        const name = posix.normalize(entry.fileName.replace(/\\/g, '/')).replace(/^\.\//, '');
        if (name.endsWith('/')) { zip.readEntry(); return; }
        if (name.includes('..') || name.startsWith('/')) throw new Error(`Project archive path is not safe: ${entry.fileName}`);
        total += entry.uncompressedSize;
        if (total > MAX_UNPACKED) throw new Error(`The project archive expands past ${MAX_UNPACKED / MiB} MiB`);
        if (entry.generalPurposeBitFlag & 1) throw new Error(`Project archive entry is encrypted: ${name}`);
        if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Project archive entry uses unsupported compression: ${name}`);
        zip.openReadStream(entry, (error, stream) => {
          if (error) { fail(error); return; }
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => { if (!done) { files.set(name, Buffer.concat(chunks)); zip.readEntry(); } });
        });
      } catch (error) { fail(error); }
    });
    // Lazy entries start nothing on their own: the first one is asked for once the handlers are in
    // place, and each entry asks for the next as it finishes.
    zip.readEntry();
  });
  const document = files.get(PROJECT_FILE);
  if (!document) throw new Error(`The archive has no ${PROJECT_FILE}`);
  let saved;
  try { saved = JSON.parse(document.toString('utf8')); }
  catch (error) { throw new Error(`The project document is not valid JSON (${error.message})`); }
  // The document alone is the format; a bare project in a zip is still a project.
  const folder = isFolderDocument(saved) ? saved : { project: saved, revision: 0 };
  return unpackProject(folder, path => files.get(path) || null);
}
