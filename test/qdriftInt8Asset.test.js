const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const QDRIFT_DIR = path.resolve(__dirname, '..', 'src', 'inference', 'pipeline', 'qdrift');
const { CONTRACT, getCorrection, resolveQDrift, isEpMeasured } = require('../src/inference/pipeline/qdrift');

/**
 * INT8 Q-Drift 校正表接线回归测试。
 *
 * 背景（两个都踩过）：
 *  1. 早期用 `require(CORRECTION_MODULES[precision])` 动态取模块，主进程经 webpack
 *     打包后被判成 critical dependency，运行期抛 "Cannot find module" 又被 try/catch
 *     吞掉 → INT8 校正表永久静默失效，日志里只有一行 warn。所以这里锁死
 *     "每个 require 都必须是字面量"。
 *  2. INT8 校准比 FP16 慢得多（138 条配对轨迹），仓库里必须先有一份占位表才能构建。
 *     占位表是全零的，若被当成可用资产，"启用"会连带锁定步数/CFG 却完全不产生校正，
 *     比直接禁用更难排查 → 必须有 meta.placeholder 门禁。
 */

const EXPECTED_BYTES = 32 * 128 * 4;

describe('Q-Drift INT8 资产接线', () => {
    it('两个精度的 require 都是字面量（禁止动态 require）', () => {
        const src = fs.readFileSync(path.join(QDRIFT_DIR, 'index.js'), 'utf-8');
        // 加载器表里每一项都必须是 require('./字面量')
        const block = src.match(/const CORRECTION_LOADERS = \{[\s\S]*?\};/);
        expect(block, 'CORRECTION_LOADERS 应存在').to.not.equal(null);
        const requires = block[0].match(/require\('\.\/[A-Za-z0-9]+'\)/g) || [];
        expect(requires).to.have.length.above(1);
        expect(block[0]).to.include("require('./qdriftCorrection')");
        expect(block[0]).to.include("require('./qdriftCorrectionInt8')");
        // 不允许出现 require(变量) 形式
        expect(block[0]).to.not.match(/require\(\s*[A-Za-z_$]/);
    });

    it('INT8 资产文件存在且形状合规（webpack 需要静态可解析）', () => {
        const p = path.join(QDRIFT_DIR, 'qdriftCorrectionInt8.js');
        expect(fs.existsSync(p), 'qdriftCorrectionInt8.js 缺失会导致主进程打包失败').to.equal(true);
        const asset = require(p);
        expect(asset.meta.precision).to.equal('int8');
        expect(asset.meta.n_steps).to.equal(CONTRACT.nSteps);
        expect(String(asset.meta.solver)).to.equal(CONTRACT.solver);
        const buf = Buffer.from(asset.base64, 'base64');
        expect(buf.length).to.equal(EXPECTED_BYTES);
    });

    it('占位表必须被拒绝启用，真实表必须可用', () => {
        const asset = require(path.join(QDRIFT_DIR, 'qdriftCorrectionInt8.js'));
        const c = getCorrection('int8');
        if (asset.meta.placeholder === true) {
            // 占位阶段：显式返回 null，绝不冒充已校正
            expect(c).to.equal(null);
            const r = resolveQDrift({
                enabled: true,
                diffStepPrecision: 'int8',
                diffStepEp: 'DmlExecutionProvider',
                samplerName: 'euler',
                totalSteps: 32,
                cfgStrength: 3.0,
                cfgRescale: 0.7,
            });
            expect(r.active).to.equal(false);
            expect(r.reason).to.equal('correction-unavailable');
        } else {
            // 真实校准产物：必须是 4096 个有限 float32
            expect(c).to.be.instanceOf(Float32Array);
            expect(c.length).to.equal(EXPECTED_BYTES / 4);
            for (let i = 0; i < c.length; i += 1) {
                if (!Number.isFinite(c[i])) throw new Error(`c[${i}] 非有限值: ${c[i]}`);
            }
        }
    });

    it('INT8 精度下会锁定合约并要求已实测 EP', () => {
        const r = resolveQDrift({
            enabled: true,
            diffStepPrecision: 'int8',
            diffStepEp: 'DmlExecutionProvider',
            samplerName: 'dpmpp',
            totalSteps: 16,
            cfgStrength: 5.0,
            cfgRescale: 0.5,
            cfgScheduleOpts: { mode: 'linear' },
        });
        // 表可用则 active，不可用则 correction-unavailable —— 共同点是
        // 绝不能再把 int8 误判成 precision-unsupported
        expect(['correction-unavailable', null]).to.include(r.reason);
        if (r.active) {
            expect(r.precision).to.equal('int8');
            expect(r.params.samplerName).to.equal(CONTRACT.solver);
            expect(r.params.totalSteps).to.equal(CONTRACT.nSteps);
            expect(r.params.cfgStrength).to.equal(CONTRACT.cfgStrength);
            expect(r.params.cfgRescale).to.equal(CONTRACT.cfgRescale);
            expect(r.params.cfgScheduleOpts).to.equal(null);
        }
    });

    it('int8-npu 仍被判定为不支持（WebNN 另一套运行时）', () => {
        const r = resolveQDrift({
            enabled: true,
            diffStepPrecision: 'int8-npu',
            diffStepEp: 'DmlExecutionProvider',
            samplerName: 'euler',
            totalSteps: 32,
            cfgStrength: 3.0,
            cfgRescale: 0.7,
        });
        expect(r.active).to.equal(false);
        expect(r.reason).to.equal('precision-unsupported');
    });

    it('CPU EP 不算已实测（Δv 只有 GPU 的 1/4~1/8）', () => {
        expect(isEpMeasured('CpuExecutionProvider')).to.equal(false);
        expect(isEpMeasured('OpenVINOExecutionProvider')).to.equal(false);
        expect(isEpMeasured('DmlExecutionProvider')).to.equal(true);
        expect(isEpMeasured('NvTensorRtRtxExecutionProvider')).to.equal(true);
    });
});
