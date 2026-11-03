import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { startStudioDesktop } from '../server/studio-window.js';

async function main() {
  const entryIndex = process.argv.indexOf(fileURLToPath(import.meta.url));
  if (entryIndex < 1) throw new Error('Studio desktop entry point is missing from its launch arguments.');
  await startStudioDesktop({ app, BrowserWindow, Menu, dialog, shell }, process.argv.slice(entryIndex + 1));
}

// Electron emits ready only after this entry module finishes evaluating.
main().catch(error => {
  console.error(`OpenDLE Studio could not start: ${error.message}`);
  dialog.showErrorBox('OpenDLE: Studio could not start', error.message);
  app.exit(1);
});
