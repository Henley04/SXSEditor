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

// 精简版的加载错误归类：本目录是可独立分发的 file: 包，不能依赖 src/shared。
// 逻辑与 src/shared/vcRuntime.js 保持一致（126/1114 → 缺 VC++ 运行库，193 → 位数，
// 127/NODE_MODULE_VERSION → ABI）。保留完整错误文本，不再只取第一行。
function classifyLoadError(err) {
    const full = String((err && err.message) || err || '');
    const single = full.split('\n').map((s) => s.trim()).filter(Boolean)
        .filter((s) => !/^\s*at\s/.test(s)).join(' | ').slice(0, 500);
    const lower = full.toLowerCase();
    const errCode = (n) => new RegExp(
        `(?:win32[ _]?error|error|code|errno|gle)[^0-9]{0,12}\\b${n}\\b`, 'i'
    ).test(full);
    // ABI 优先于裸错误码（NODE_MODULE_VERSION 126 里的 126 不是 126 错误）。
    if (lower.includes('node_module_version') || lower.includes('compiled against a different node')
        || lower.includes('the specified procedure could not be found') || errCode(127)) {
        return { kind: 'abi', text: single };
    }
    if (lower.includes('cannot find module')
        || (lower.includes('module_not_found') && !lower.includes('specified module'))) {
        return { kind: 'not-found', text: single };
    }
    if (errCode(126) || lower.includes('0x7e')
        || lower.includes('the specified module could not be found')
        || full.includes('找不到指定的模块') || errCode(1114)
        || lower.includes('dll initialization routine failed')) {
        return { kind: 'vc-runtime', text: single };
    }
    if (errCode(193) || lower.includes('0xc1')
        || lower.includes('is not a valid win32 application')) {
        return { kind: 'arch', text: single };
    }
    return { kind: 'unknown', text: single };
}

const LOAD_HINT = {
    'vc-runtime': '[sxs-ort-bridge] 加载失败：缺少 Visual C++ 运行库或依赖 DLL。'
        + '请安装 Microsoft Visual C++ 2015-2022 Redistributable (x64) 后重启：'
        + 'aka.ms/vs/17/release/vc_redist.x64.exe',
    arch: '[sxs-ort-bridge] 加载失败：原生模块位数与应用不符（需 x64）。',
    abi: '[sxs-ort-bridge] 加载失败：原生模块与 Electron/Node ABI 不匹配，请重新 build:native。',
    'not-found': '[sxs-ort-bridge] 加载失败：找不到 ort_bridge.node，请确认安装完整或 build:native。',
};

function loadAddon() {
    const errors = [];
    let hint = '';
    for (const p of candidatePaths()) {
        try {
            return { addon: require(p), path: p };
        } catch (e) {
            const c = classifyLoadError(e);
            if (!hint && LOAD_HINT[c.kind]) hint = '\n' + LOAD_HINT[c.kind];
            errors.push(`${path.basename(p)} [${c.kind}]: ${c.text}`);
        }
    }
    throw new Error(
        hint +
        '\n[sxs-ort-bridge] native module not found. Tried:\n  ' +
        errors.join('\n  ') +
        '\nBuild it with: npm run build:native'
    );
}

const loaded = loadAddon();
module.exports = loaded.addon;
module.exports.__binaryPath = loaded.path;
