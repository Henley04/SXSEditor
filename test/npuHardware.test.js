/**
 * NPU 硬件（PnP）检测回归测试
 *
 * 覆盖两类历史故障：
 *  1. 探测不到 NPU —— 只匹配 Class -eq "ComputeAccelerator" 且用脆弱的
 *     纯数字正则解析输出，导致有 NPU 的机器被判为无 NPU。
 *  2. 误报 NPU   —— 裸关键字 `NPU` 命中 "I-npu-t"，把
 *     "Microsoft Input Configuration Device" 当成 NPU。
 */
const { expect } = require('chai');
const sinon = require('sinon');
const childProcess = require('node:child_process');

const {
  detectNPUByPnp,
  invalidatePnpNpuCache,
  __test: { PNP_SENTINEL, NPU_NAME_REGEX, buildPnpCommand, parsePnpOutput },
} = require('../src/main/npuHardware');

// PowerShell 的 -match 是 .NET 正则且不区分大小写，用 JS 的等价正则来验证关键字表
const regex = () => new RegExp(NPU_NAME_REGEX, 'i');

describe('NPU hardware (PnP) detection', () => {
  describe('friendly-name keyword regex', () => {
    it('matches real NPU devices', () => {
      for (const name of [
        'Intel(R) AI Boost',
        'Intel(R) NPU Device',
        'AMD XDNA AI Engine',
        'AMD Ryzen AI NPU',
        'Qualcomm Hexagon NPU',
        'Neural Processing Unit',
      ]) {
        expect(regex().test(name), name).to.equal(true);
      }
    });

    it('does NOT match devices whose name merely contains "npu" as a substring', () => {
      // 回归：裸 `NPU` 会命中 "I-npu-t"，把常见 HID 设备误判为 NPU
      for (const name of [
        'Microsoft Input Configuration Device',
        'USB Input Device',
        'HID-compliant consumer control device',
      ]) {
        expect(regex().test(name), name).to.equal(false);
      }
    });
  });

  describe('PowerShell command construction', () => {
    it('broadens the device-class filter beyond ComputeAccelerator', () => {
      const cmd = buildPnpCommand();
      expect(cmd).to.include("Class -eq 'ComputeAccelerator'");
      expect(cmd).to.include("Class -eq 'NeuralProcessor'");
      expect(cmd).to.include('FriendlyName -match');
      // 只要求处于工作状态的设备
      expect(cmd).to.include("Status -eq 'OK'");
    });

    it('emits a sentinel so stray output cannot break parsing', () => {
      const cmd = buildPnpCommand();
      expect(cmd).to.include(`Write-Output "${PNP_SENTINEL}`);
    });
  });

  describe('parsePnpOutput', () => {
    it('parses a clean result', () => {
      expect(parsePnpOutput(`${PNP_SENTINEL}1\r\n`)).to.equal(1);
    });

    it('parses despite progress bars / warnings / BOM around the sentinel', () => {
      const noisy = `\uFEFF\u001b[?25lWorking... 42%\r${PNP_SENTINEL}2\r\nWARNING: something\r\n`;
      expect(parsePnpOutput(noisy)).to.equal(2);
    });

    it('returns 0 for empty or sentinel-less output', () => {
      expect(parsePnpOutput('')).to.equal(0);
      expect(parsePnpOutput(undefined)).to.equal(0);
      expect(parsePnpOutput('0')).to.equal(0);
      expect(parsePnpOutput(`${PNP_SENTINEL}0`)).to.equal(0);
    });
  });

  describe('detectNPUByPnp', () => {
    let stub;
    beforeEach(() => { invalidatePnpNpuCache(); });
    afterEach(() => { if (stub) { stub.restore(); stub = null; } });

    const stubExec = (stdout, err = null) => {
      stub = sinon.stub(childProcess, 'execFile').callsFake((_file, _args, _opts, cb) => {
        cb(err, stdout, '');
        return {};
      });
    };

    it('reports NPU present when the probe finds devices', async () => {
      stubExec(`${PNP_SENTINEL}1\r\n`);
      expect(await detectNPUByPnp()).to.equal(true);
    });

    it('reports no NPU when the probe finds none', async () => {
      stubExec(`${PNP_SENTINEL}0\r\n`);
      expect(await detectNPUByPnp()).to.equal(false);
    });

    it('still succeeds when exec reports an error but the sentinel was written', async () => {
      // 超时/超 buffer 时 Node 会设置 err，同时 stdout 里保留已收到的部分内容
      stubExec(`\uFEFF${PNP_SENTINEL}1\r\n`, new Error('ETIMEDOUT'));
      expect(await detectNPUByPnp()).to.equal(true);
    });

    it('caches the result so repeated calls do not re-spawn PowerShell', async () => {
      stubExec(`${PNP_SENTINEL}1\r\n`);
      expect(await detectNPUByPnp()).to.equal(true);
      expect(await detectNPUByPnp()).to.equal(true);
      expect(stub.callCount).to.equal(1);
    });
  });
});
