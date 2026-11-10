// Installs the hooks in loader.mjs, so `node --test` can run the TypeScript modules under web/src
// without a bundler. module.registerHooks is used where Node has it; older Node 22 releases fall
// back to module.register.
import module from 'node:module';
import { syncHooks } from './loader.mjs';

if (typeof module.registerHooks === 'function') module.registerHooks(syncHooks);
else module.register('./loader.mjs', import.meta.url);
