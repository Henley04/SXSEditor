// Splash screen renderer — enrichment pass.
//
// The inline SVG in splash.html paints immediately on HTML parse
// (before this script loads), with safe default values. This script
// runs AFTER first paint and only updates the version text, build date
// text, and icon image href if the IPC provides richer data.
//
// Design notes:
//   - Colors are pulled directly from the Aurora Dark theme tokens
//     (src/themes/builtins/dark-aurora.theme.json) so the splash
//     visually belongs to the app, not to a generic AI template.
//   - No purple-to-cyan "AI" gradient. Just the app's accent (#5b8def)
//     on the existing dark navy background (#14141f / #1a1a2a).
//   - If this script fails to load or IPC rejects, the defaults in
//     splash.html remain visible — the splash is never blank.

const BUILD_INFO_DEFAULT = {
  productName: 'SXSEditor',
  version: '0.0.0-dev',
  buildDate: '',
  buildDateISO: '',
};

async function enrichSplash() {
  let info = BUILD_INFO_DEFAULT;

  try {
    if (window.splashAPI && typeof window.splashAPI.getBuildInfo === 'function') {
      info = { ...BUILD_INFO_DEFAULT, ...(await window.splashAPI.getBuildInfo()) };
    }
  } catch (_err) {
    // Keep defaults — the inline SVG is already visible.
    return;
  }

  // Update version text (left of footer).
  const versionEl = document.getElementById('splash-version');
  if (versionEl) {
    versionEl.textContent = info.version ? `v${info.version}` : '';
  }

  // Update build date text (right of footer).
  const buildEl = document.getElementById('splash-build-date');
  if (buildEl) {
    buildEl.textContent = info.buildDate ? `Build ${info.buildDate}` : 'Build dev';
  }

  // Icon: the inline SVG already references ./SXS.png via a relative
  // URL, which loads in parallel with this script. We don't override
  // it here unless the IPC provided an explicit data URL fallback
  // (which it no longer does — see splashManager.js). The relative
  // path is the primary mechanism and avoids an IPC round-trip on
  // the critical path.
  //
  // If a future enhancement wants to fall back to a base64 data URL
  // when the relative path fails (e.g. in dev mode where webpack
  // dev server doesn't serve the PNG), this is where it would go.
  // For now, the relative path is sufficient for both dev and
  // packaged mode (webpack CopyPlugin copies SXS.png to the
  // splash_window renderer folder in both cases).
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', enrichSplash);
} else {
  // DOM already parsed (script injected at end of body) — run now.
  enrichSplash();
}
