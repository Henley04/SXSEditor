'use strict';
/**
 * dummy 校验结果持久化缓存。
 *
 * 需求：同一 EP + 同一模型（含版本）先前 dummy 推理成功过，重启后再次加载
 * 直接复用结果，不再跑 dummy；EP 变化、模型版本变化必须重新校验；切换模型
 * 精度（不同目录）再切回来仍应命中各自的记录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');

const cache = require('../src/inference/pipeline/sessionValidationCache');

describe('sessionValidationCache — dummy 校验结果持久化', function () {
  let root;
  let fp16Dir;
  let fp32Dir;
  const SESSION_KEY = 'preflow';

  function writeModel(dir, name, bytes) {
    const modelPath = path.join(dir, name);
    fs.writeFileSync(modelPath, Buffer.alloc(bytes, 1));
    return modelPath;
  }

  function writeVersion(dir, version, revision) {
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, revision }), 'utf8');
  }

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-validation-'));
    fp16Dir = path.join(root, 'fp16');
    fp32Dir = path.join(root, 'fp32');
    fs.mkdirSync(fp16Dir, { recursive: true });
    fs.mkdirSync(fp32Dir, { recursive: true });
    writeVersion(fp16Dir, '1.0.0', 'v1');
    writeVersion(fp32Dir, '1.0.0', 'v1');
    cache._resetForTest(root);
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('未校验过时返回 null，校验成功后可在"重启"后命中', async function () {
    const modelPath = writeModel(fp16Dir, 'preflow.onnx', 64);
    const q = { epKey: 'dml:0:dynamic', modelPath, sessionKey: SESSION_KEY };

    expect(await cache.getValidationRecord(q)).to.equal(null);

    expect(await cache.recordValidation({ ...q, detail: 'dml' })).to.equal(true);
    await cache.flush();
    expect(fs.existsSync(path.join(root, 'session-validation-cache.json'))).to.equal(true);

    // 模拟进程重启：清掉内存状态后应从磁盘恢复
    cache._resetForTest(root);
    const rec = await cache.getValidationRecord(q);
    expect(rec).to.be.an('object');
    expect(rec.modelVersion).to.equal('1.0.0');
    expect(rec.detail).to.equal('dml');
  });

  it('EP 变化后必须重新校验', async function () {
    const modelPath = writeModel(fp16Dir, 'preflow.onnx', 64);
    await cache.recordValidation({ epKey: 'dml:0:dynamic', modelPath, sessionKey: SESSION_KEY });
    await cache.flush();
    cache._resetForTest(root);

    expect(await cache.getValidationRecord({
      epKey: 'winml:NvTensorRTRTXExecutionProvider@auto', modelPath, sessionKey: SESSION_KEY,
    })).to.equal(null);
    expect(await cache.getValidationRecord({
      epKey: 'dml:0:static', modelPath, sessionKey: SESSION_KEY,
    })).to.equal(null);
  });

  it('模型版本号变化后必须重新校验', async function () {
    const modelPath = writeModel(fp16Dir, 'preflow.onnx', 64);
    await cache.recordValidation({ epKey: 'dml:0:dynamic', modelPath, sessionKey: SESSION_KEY });
    await cache.flush();
    cache._resetForTest(root);

    writeVersion(fp16Dir, '2.0.0', 'v2');
    expect(await cache.getValidationRecord({
      epKey: 'dml:0:dynamic', modelPath, sessionKey: SESSION_KEY,
    })).to.equal(null);
  });

  it('模型文件被替换（size / mtime 变化）后必须重新校验', async function () {
    const modelPath = writeModel(fp16Dir, 'preflow.onnx', 64);
    await cache.recordValidation({ epKey: 'dml:0:dynamic', modelPath, sessionKey: SESSION_KEY });
    await cache.flush();
    cache._resetForTest(root);

    fs.writeFileSync(modelPath, Buffer.alloc(128, 2));
    expect(await cache.getValidationRecord({
      epKey: 'dml:0:dynamic', modelPath, sessionKey: SESSION_KEY,
    })).to.equal(null);
  });

  it('切换精度后再切回，原精度的记录仍然命中', async function () {
    const fp16Model = writeModel(fp16Dir, 'preflow.onnx', 64);
    const fp32Model = writeModel(fp32Dir, 'preflow.onnx', 64);
    await cache.recordValidation({ epKey: 'dml:0:dynamic', modelPath: fp16Model, sessionKey: SESSION_KEY });
    await cache.recordValidation({ epKey: 'dml:0:dynamic', modelPath: fp32Model, sessionKey: SESSION_KEY });
    await cache.flush();
    cache._resetForTest(root);

    // 从 fp32 切回 fp16：命中 fp16 的旧记录，不因"切过精度"整体失效
    expect(await cache.getValidationRecord({
      epKey: 'dml:0:dynamic', modelPath: fp16Model, sessionKey: SESSION_KEY,
    })).to.be.an('object');
    expect(await cache.getValidationRecord({
      epKey: 'dml:0:dynamic', modelPath: fp32Model, sessionKey: SESSION_KEY,
    })).to.be.an('object');
  });

  it('无 userData 目录时不缓存、也不抛错', async function () {
    const savedGlobal = globalThis.__SXS_USER_DATA_DIR__;
    delete globalThis.__SXS_USER_DATA_DIR__;
    cache._resetForTest(null);
    // 清掉 override：直接用默认解析（测试环境没有 electron.app 时应为 null）
    const modelPath = writeModel(fp16Dir, 'preflow.onnx', 32);
    const q = { epKey: 'cpu', modelPath, sessionKey: SESSION_KEY };
    const before = await cache.getValidationRecord(q);
    expect(before).to.equal(null);
    globalThis.__SXS_USER_DATA_DIR__ = savedGlobal;
  });
});
