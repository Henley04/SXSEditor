'use strict';

async function main() {
  let payload;
  try {
    payload = JSON.parse(process.env.SXS_TRT_DIAGNOSTIC_PAYLOAD || '{}');
  } catch (error) {
    throw new Error(`Invalid diagnostic payload: ${error.message}`);
  }

  // Inject snapshots before requiring trtDiagnostic. That module imports
  // winmlProvider and pipeline utilities at module-load time. Without this,
  // the child tries electron.app.getPath(), falls back to defaults, and closes
  // the WinML opt-in gate before any inference can start.
  globalThis.__SXS_SETTINGS_SNAPSHOT__ = {
    ...(payload.settingsSnapshot || {}),
    winmlEnabled: true,
    diagnosticMode: true,
  };
  if (Array.isArray(payload.winmlEps)) {
    globalThis.__SXS_WINML_EPS__ = payload.winmlEps;
  }

  // Mirror svsWorker startup order. The patch must be installed before the
  // diagnostic module imports onnxruntime-node.
  require('../pipeline/float16Patch');
  const { runTrtDiagnostic } = require('./trtDiagnostic');
  const report = await runTrtDiagnostic(payload);
  if (process.send) process.send({ type: 'result', report });
}

main().then(() => process.exit(0)).catch(error => {
  const message = error?.stack || error?.message || String(error);
  try {
    if (process.send) process.send({ type: 'error', error: message });
  } catch (_) {}
  console.error(message);
  process.exit(1);
});
