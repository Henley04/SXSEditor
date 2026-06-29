// Direct @electron/packager API call for CI fallback when electron-forge fails silently.
// Usage: node scripts/run-packager.js
'use strict';

const packager = require('@electron/packager');

(async () => {
  try {
    console.log('[run-packager] Starting @electron/packager...');
    const appPaths = await packager({
      dir: '.',
      name: 'SXSEditor',
      platform: 'win32',
      arch: 'x64',
      out: 'out',
      overwrite: true,
      prune: true,
      icon: 'assets/SXS.ico',
      asar: { unpack: '**/*.{node,dll}' },
      electronVersion: '42.4.1',
      quiet: false,
    });
    console.log('[run-packager] Packager returned appPaths:', JSON.stringify(appPaths));
  } catch (err) {
    console.error('[run-packager] ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
