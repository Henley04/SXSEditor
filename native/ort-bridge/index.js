'use strict';

// sxs-ort-bridge loader.
//
// Binary resolution order:
//   1. SXS_ORT_BRIDGE_PATH env override
//   2. Local build output   (repo dev:  native/ort-bridge/build/Release)
//   3. Committed prebuilt   (packaged:  <pkg>/prebuilt/win32-x64)
//
// When installed as a file: dependency, this directory lands under
// node_modules/sxs-ort-bridge/, which forge keeps outside asar except that
// '*.node' files are unpacked automatically (forge.config.js).

const path = require('node:path');

function candidatePaths() {
    const archDir = `win32-${process.arch}`;
    const list = [];
    if (process.env.SXS_ORT_BRIDGE_PATH) list.push(process.env.SXS_ORT_BRIDGE_PATH);
    list.push(path.join(__dirname, 'build', 'Release', 'ort_bridge.node'));
    list.push(path.join(__dirname, 'prebuilt', archDir, 'ort_bridge.node'));
    // file:-dep layout: node_modules/sxs-ort-bridge/../.. == project root
    list.push(path.join(__dirname, '..', '..', 'native', 'ort-bridge', 'build', 'Release', 'ort_bridge.node'));
    list.push(path.join(__dirname, '..', '..', 'native', 'ort-bridge', 'prebuilt', archDir, 'ort_bridge.node'));
    return list;
}

function loadAddon() {
    const errors = [];
    for (const p of candidatePaths()) {
        try {
            return { addon: require(p), path: p };
        } catch (e) {
            errors.push(`${path.basename(p)}: ${e.message.split('\n')[0]}`);
        }
    }
    throw new Error(
        '[sxs-ort-bridge] native module not found. Tried:\n  ' +
        errors.join('\n  ') +
        '\nBuild it with: npm run build:native'
    );
}

const loaded = loadAddon();
module.exports = loaded.addon;
module.exports.__binaryPath = loaded.path;
