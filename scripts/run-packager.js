// Direct @electron/packager API call for CI fallback when electron-forge fails silently.
// Usage: node scripts/run-packager.js
'use strict';

// --- Diagnostic handlers: catch silent exits ---
// @electron/packager has been observed to exit with code 0 without resolving
// its Promise on Node 24. These handlers log the exit reason so the CI log
// shows exactly where the process terminated.
let packagerReturned = false;
process.on('exit', (code) => {
  console.log(`[run-packager] process exit event: code=${code} packagerReturned=${packagerReturned}`);
  if (!packagerReturned) {
    console.log('[run-packager] WARNING: packager() Promise never resolved - this is the silent-exit bug');
  }
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[run-packager] UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[run-packager] UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});

const fs = require('node:fs');
const path = require('node:path');
const packager = require('@electron/packager');

const ELECTRON_VERSION = '42.4.1';
const ELECTRON_CACHE = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'electron', 'Cache')
  : '';
const ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;

async function findElectronZip() {
  console.log('[run-packager] Looking for Electron zip in cache:', ELECTRON_CACHE);
  if (!ELECTRON_CACHE || !fs.existsSync(ELECTRON_CACHE)) {
    console.log('[run-packager] Cache dir does not exist, will let @electron/get download');
    return null;
  }
  // @electron/get stores under Cache/<hash>/<zipName>
  const entries = fs.readdirSync(ELECTRON_CACHE, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(ELECTRON_CACHE, entry.name, ZIP_NAME);
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        console.log(`[run-packager] Found cached zip: ${candidate} (${stat.size} bytes)`);
        if (stat.size < 10 * 1024 * 1024) {
          console.error('[run-packager] ERROR: zip is suspiciously small (<10MB), likely corrupted');
          return null;
        }
        return candidate;
      }
    }
  }
  console.log('[run-packager] zip not found in cache, will let @electron/get download');
  return null;
}

(async () => {
  try {
    console.log('[run-packager] Node version:', process.version);
    console.log('[run-packager] Starting @electron/packager...');

    const cachedZip = await findElectronZip();
    const opts = {
      dir: '.',
      name: 'SXSEditor',
      platform: 'win32',
      arch: 'x64',
      out: 'out',
      overwrite: true,
      prune: true,
      icon: 'assets/SXS.ico',
      asar: { unpack: '**/*.{node,dll}' },
      electronVersion: ELECTRON_VERSION,
      quiet: false,
    };
    if (cachedZip) {
      // Point packager at the pre-downloaded zip so it skips re-downloading.
      opts.electronZipDir = path.dirname(cachedZip);
      console.log('[run-packager] Using electronZipDir:', opts.electronZipDir);
    }

    console.log('[run-packager] Calling packager() with opts:', JSON.stringify({ ...opts, electronZipDir: opts.electronZipDir || '(none)' }));
    const appPaths = await packager(opts);
    packagerReturned = true;
    console.log('[run-packager] Packager returned appPaths:', JSON.stringify(appPaths));

    if (!appPaths || appPaths.length === 0) {
      console.error('[run-packager] ERROR: packager returned no app paths!');
      process.exit(1);
    }
    const expected = path.resolve('out', 'SXSEditor-win32-x64', 'SXSEditor.exe');
    if (!fs.existsSync(expected)) {
      console.error(`[run-packager] ERROR: expected exe not found at ${expected}`);
      process.exit(1);
    }
    console.log('[run-packager] SUCCESS:', expected);
  } catch (err) {
    packagerReturned = true;
    console.error('[run-packager] ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
