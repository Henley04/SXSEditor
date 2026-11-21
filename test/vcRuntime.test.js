'use strict';
/**
 * VC++ 运行库探测与原生加载错误归类。
 *
 * 锁死三条行为：
 *   1. 非 Windows 一律 supported:false / ok:true 且不碰文件系统（CI 跑 Linux）；
 *   2. 缺任意一枚 CRT DLL 都要在 missing 里点名，尤其 vcruntime140_1.dll；
 *   3. Windows 加载错误 126/1114 归到 vc-runtime、193 归到 arch、
 *      NODE_MODULE_VERSION 归到 abi —— 不再笼统报 "binding not found"。
 */
const { expect } = require('chai');
const vc = require('../src/shared/vcRuntime.js');

function fakeFs(presentNames) {
  const set = new Set(presentNames);
  return {
    existsSync(p) {
      return set.has(require('node:path').basename(p));
    },
  };
}

describe('vcRuntime — VC++ 运行库探测与错误归类', () => {
  describe('probeVcRuntime', () => {
    it('非 Windows 返回 supported:false / ok:true，且不访问文件系统', () => {
      const boom = { existsSync() { throw new Error('should not be called'); } };
      const r = vc.probeVcRuntime({ platform: 'linux', fsModule: boom });
      expect(r.supported).to.equal(false);
      expect(r.ok).to.equal(true);
      expect(r.status).to.equal(vc.STATUS.UNSUPPORTED);
      expect(r.missing).to.deep.equal([]);
      expect(r.system32).to.equal(null);
    });

    it('三枚 DLL 齐全时 ok:true', () => {
      const r = vc.probeVcRuntime({
        platform: 'win32',
        windir: 'C:\\Windows',
        fsModule: fakeFs(vc.REQUIRED_CRT_DLLS),
      });
      expect(r.ok).to.equal(true);
      expect(r.status).to.equal(vc.STATUS.OK);
      expect(r.missing).to.deep.equal([]);
      expect(r.supported).to.equal(true);
    });

    it('缺 vcruntime140_1.dll 时点名报出（旧机器最常见情形）', () => {
      const r = vc.probeVcRuntime({
        platform: 'win32',
        windir: 'C:\\Windows',
        fsModule: fakeFs(['vcruntime140.dll', 'msvcp140.dll']),
      });
      expect(r.ok).to.equal(false);
      expect(r.status).to.equal(vc.STATUS.MISSING);
      expect(r.missing).to.deep.equal(['vcruntime140_1.dll']);
    });

    it('全部缺失时列出所有 DLL，并给出 redist 下载地址', () => {
      const r = vc.probeVcRuntime({
        platform: 'win32',
        windir: 'D:\\Win',
        fsModule: fakeFs([]),
      });
      expect(r.missing).to.deep.equal(vc.REQUIRED_CRT_DLLS.slice());
      expect(r.redistUrl).to.match(/aka\.ms/);
    });
  });

  describe('classifyNativeLoadError', () => {
    const cases = [
      ['error 126', 'The specified module could not be found', vc.LOAD_ERROR_KIND.VC_RUNTIME],
      ['中文"找不到指定的模块"', '找不到指定的模块', vc.LOAD_ERROR_KIND.VC_RUNTIME],
      ['error 1114 DLL init', 'A dynamic link library (DLL) initialization routine failed', vc.LOAD_ERROR_KIND.VC_RUNTIME],
      ['error 193 位数不符', '%1 is not a valid Win32 application', vc.LOAD_ERROR_KIND.ARCH],
      ['NODE_MODULE_VERSION 不匹配', 'was compiled against a different Node.js version using NODE_MODULE_VERSION 127', vc.LOAD_ERROR_KIND.ABI],
      ['文件本身不存在', "Cannot find module 'C:\\app\\ort_bridge.node'", vc.LOAD_ERROR_KIND.NOT_FOUND],
      // 回归：NODE_MODULE_VERSION 126 里的 126 不是 ERROR_MOD_NOT_FOUND；
      // 路径里的 126 也不能触发缺运行库误判。
      ['NODE_MODULE_VERSION 126 不误判为缺运行库', 'compiled against NODE_MODULE_VERSION 126', vc.LOAD_ERROR_KIND.ABI],
      ['路径含 126 视为文件不存在', "Cannot find module 'C:\\app126\\ort_bridge.node'", vc.LOAD_ERROR_KIND.NOT_FOUND],
      ['无关错误', 'some unrelated failure', vc.LOAD_ERROR_KIND.UNKNOWN],
    ];
    for (const [label, message, expected] of cases) {
      it(`归类：${label}`, () => {
        const c = vc.classifyNativeLoadError(new Error(message));
        expect(c.kind, label).to.equal(expected);
      });
    }

    it('VC++ 运行库类给出可操作提示（含安装地址）', () => {
      const c = vc.classifyNativeLoadError(new Error('The specified module could not be found'));
      const hint = vc.describeLoadError(c);
      expect(hint).to.be.a('string');
      expect(hint).to.include('Visual C++');
      expect(hint).to.include('aka.ms');
    });

    it('未知类型不产生提示', () => {
      const c = vc.classifyNativeLoadError(new Error('some unrelated failure'));
      expect(vc.describeLoadError(c)).to.equal(null);
    });

    it('保留多行完整消息（不丢第二行的根因）', () => {
      const c = vc.classifyNativeLoadError(
        new Error('The module was loaded\nThe specified module could not be found')
      );
      expect(c.message).to.include('The specified module could not be found');
      expect(c.kind).to.equal(vc.LOAD_ERROR_KIND.VC_RUNTIME);
    });
  });
});
