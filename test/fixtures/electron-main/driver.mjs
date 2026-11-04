/**
 * Runs a bundled game's generated `main.js` with the `electron` stub above.
 *
 * The entry point under test is the real one from the exported build, unmodified.
 */
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stub = new URL('./electron-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return nextResolve(stub, context);
    return nextResolve(specifier, context);
  },
});
await import(pathToFileURL(resolve(process.argv[2])).href);
