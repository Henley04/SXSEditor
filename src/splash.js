// Splash screen renderer.
// Reads build info via IPC and renders an SVG-based splash card.
// Loaded as a webpack renderer entry point (splash_window).
//
// Design notes:
//   - Colors are pulled directly from the Aurora Dark theme tokens
//     (src/themes/builtins/dark-aurora.theme.json) so the splash
//     visually belongs to the app, not to a generic AI template.
//   - No purple-to-cyan "AI" gradient. Just the app's accent (#5b8def)
//     on the existing dark navy background (#14141f / #1a1a2a).
//   - Minimal layout: icon → name → tagline → footer divider → meta.

const BUILD_INFO_DEFAULT = {
  productName: 'SXSEditor',
  version: '0.0.0-dev',
  buildDate: '',
  buildDateISO: '',
};

// Aurora Dark theme tokens (kept in sync with dark-aurora.theme.json).
const THEME = {
  bgApp:      '#14141f', // --bg-app / --color-ink-900
  bgPanel:    '#1a1a2a', // --bg-panel / --color-ink-700
  bgElevated: '#1e1e2e', // --bg-elevated
  border:     '#2a2a3d', // --color-ink-300
  fgPrimary:  '#e0e0f0', // --fg-primary
  fgMuted:    '#8888a8', // --fg-muted
  accent:     '#5b8def', // --accent
  accentSoft: '#6b9df5', // --accent-hover
};

function renderSplash(info, iconDataUrl) {
  const W = 440, H = 280;
  const versionText = info.version ? `v${info.version}` : '';

  const iconImage = iconDataUrl
    ? `<image x="20" y="20" width="64" height="64"
         preserveAspectRatio="xMidYMid meet" href="${iconDataUrl}" />`
    : '';

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="SXSEditor splash screen">

  <!-- Solid app background (matches --bg-app). No gradient — the app
       itself doesn't use one on its main surface, and gradients here
       are what gives generic AI splashes their "AI flavor". -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="${THEME.bgApp}" />

  <!-- 3px accent bar at the very top, matching the app's
       --toolbar-accent-line decoration. Subtle, on-brand. -->
  <rect x="0" y="0" width="${W}" height="3" fill="${THEME.accent}" />

  <!-- App icon (top-left, 64x64 — same proportions the app uses in
       its own headers, no decorative ring around it). -->
  ${iconImage}

  <!-- App name -->
  <text x="100" y="50"
        font-size="22" font-weight="600" letter-spacing="0.5"
        fill="${THEME.fgPrimary}"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">
    ${escapeXml(info.productName || 'SXSEditor')}
  </text>

  <!-- Tagline / brief introduction -->
  <text x="100" y="72"
        font-size="12" font-weight="400"
        fill="${THEME.fgMuted}"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">
    ${escapeXml(info.description || 'AI Singing Voice Synthesis Workstation')}
  </text>

  <!-- Footer divider -->
  <line x1="20" y1="${H - 40}" x2="${W - 20}" y2="${H - 40}"
        stroke="${THEME.border}" stroke-width="1" />

  <!-- Version (left) -->
  <text x="20" y="${H - 18}"
        font-size="11" font-weight="500"
        fill="${THEME.fgMuted}"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">
    ${escapeXml(versionText)}
  </text>

  <!-- Build date (right) -->
  <text x="${W - 20}" y="${H - 18}" text-anchor="end"
        font-size="11" font-weight="400"
        fill="${THEME.fgMuted}"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">
    ${escapeXml(info.buildDate ? `Build ${info.buildDate}` : 'Build dev')}
  </text>
</svg>`.trim();
}

function escapeXml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function init() {
  const root = document.getElementById('splash-root');
  let info = BUILD_INFO_DEFAULT;
  let iconDataUrl = '';

  try {
    if (window.splashAPI && typeof window.splashAPI.getBuildInfo === 'function') {
      info = await window.splashAPI.getBuildInfo();
      iconDataUrl = await window.splashAPI.getIconDataUrl();
    }
  } catch (err) {
    // fall back to defaults
  }

  root.innerHTML = renderSplash(info, iconDataUrl);
}

document.addEventListener('DOMContentLoaded', init);
