// Rebuild the main-process bundle into .webpack/main exactly the way
// `electron-forge start` does (dev mode), without launching the app.
// Usage: node scripts/rebuild-main-dev.js
const path = require('node:path');
const webpack = require('webpack');
const WebpackConfigGenerator = require('@electron-forge/plugin-webpack/dist/WebpackConfig').default;
const forgeConfig = require('../forge.config.js');

async function main() {
  const projectDir = path.resolve(__dirname, '..');
  const pluginConfig = forgeConfig.plugins.find((p) => p.name === '@electron-forge/plugin-webpack').config;
  const gen = new WebpackConfigGenerator(pluginConfig, projectDir, false /* isProd */, 0 /* port, unused for main */);
  const config = await gen.getMainConfig();
  config.watch = false;
  webpack(config, (err, stats) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    const s = stats.toJson({ warnings: true, errors: true });
    for (const w of s.warnings) console.warn('WARN:', w.message || w);
    for (const e of s.errors) console.error('ERROR:', e.message || e);
    console.log(`webpack ${stats.hasErrors() ? 'FAILED' : 'compiled OK'}`);
    process.exit(stats.hasErrors() ? 1 : 0);
  });
}

main();
