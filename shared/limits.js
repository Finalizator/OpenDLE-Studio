/**
 * Import and project limits, in one place.
 *
 * These are budget guards, not Doom's own limits: the studio accepts maps and games
 * well past what the original engine could load (community megawads pass 20 000
 * linedefs routinely, mod archives are often several hundred megabytes), and a limit
 * here only exists so a malformed or hostile file cannot exhaust memory.
 */
const MiB = 1024 * 1024;

export const LIMITS = Object.freeze({
  // Geometry, in records. The editor and the renderer stream these, so the ceiling is
  // about memory per record rather than a format restriction.
  vertices: 200000,
  walls: 200000,
  sidedefs: 400000,
  sectors: 100000,
  entities: 100000,
  udmfBlocks: 800000,
  // Text and script lumps.
  udmfTextBytes: 64 * MiB,
  udmfProvenanceBytes: 128 * MiB,
  textBytes: 8 * MiB,
  scriptBytes: 32 * MiB,
  // A game: level count and total serialized level data.
  levels: 512,
  gameBytes: 512 * MiB,
  // Archives and single files.
  archiveBytes: 256 * MiB,
  archiveExpandedBytes: 512 * MiB,
  archiveEntries: 50000,
  // Assets: how many, how large a single image may be, and how much decoded pixel
  // data one import may hold.
  assets: 12000,
  assetPixels: 96 * 1024 * 1024,
  imageSize: 4096,
  imageBytes: 16 * MiB,
  imageTotalBytes: 192 * MiB,
  // Events and the tables that grow with the game.
  events: 16384,
  soundAliases: 50000,
  languageKeys: 50000,
});

export const MiB_BYTES = MiB;
