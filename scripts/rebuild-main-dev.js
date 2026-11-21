// Rebuild the main-process bundle into .webpack/main exactly the way
// `electron-forge start` does (dev mode), without launching the app.
// Usage: node scripts/rebuild-main-dev.js
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const webpack = require('webpack');
const forgeConfig = require('../forge.config.js');

/**
 * Forge 8 把 @electron-forge/plugin-webpack 变成纯 ESM，exports 是单个字符串
 * （只开放包根），旧写法 require('.../dist/WebpackConfig').default 在 Node 24
 * 下会报 ERR_PACKAGE_PATH_NOT_EXPORTED。用包根入口定位 dist 目录，再按 file
 * URL 动态 import 同目录的 ESM 文件（file URL 不走 exports 检查）。
 */
async function loadWebpackConfigGenerator() {
  const pluginEntry = require.resolve('@electron-forge/plugin-webpack');
  const generatorPath = path.join(path.dirname(pluginEntry), 'WebpackConfig.js');
  const mod = await import(pathToFileURL(generatorPath).href);
  return mod.default;
}

async function main() {
  const WebpackConfigGenerator = await loadWebpackConfigGenerator();
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
