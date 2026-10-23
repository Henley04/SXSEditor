/**
 * 回归：svsIpc 通过 getPipelineModule() 惰性拿 pipeline 的导出。
 *
 * 这种惰性写法把「属性名写错」从构建期错误降级成运行时错误：一旦写成
 * `getPipelineModule().getSampleRate()`（pipeline 只导出 SAMPLE_RATE 常量），
 * ESLint / mocha / webpack 都不会报，只有渲染进程真正点到
 * `fragment-svs:getSampleRate` 时才抛 "getSampleRate is not a function"，
 * 而那是打开分片编辑器的第一条 IPC。这里静态扫描源码里的
 * `getPipelineModule().X`，逐一对照 pipeline/index.js 的真实导出。
 */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SRC_PATH = path.join(__dirname, '..', 'src', 'main', 'svsIpc.js');

describe('svsIpc ↔ inference/pipeline 导出契约', function () {
  const rawSrc = fs.readFileSync(SRC_PATH, 'utf8');
  // 去掉注释再扫描：说明性注释里会引用历史错误写法（如
  // `getPipelineModule().getSampleRate()`），不去掉会造成自指假阳性。
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const pipeline = require('../src/inference/pipeline');

  it('源码中至少有一处 getPipelineModule().X 用法', function () {
    const props = [...src.matchAll(/getPipelineModule\(\)\.(\w+)/g)].map((m) => m[1]);
    expect(props.length).to.be.at.least(1);
  });

  it('每个 getPipelineModule().X 都是 pipeline 的真实导出', function () {
    const props = new Set([...src.matchAll(/getPipelineModule\(\)\.(\w+)/g)].map((m) => m[1]));
    for (const prop of props) {
      expect(pipeline, `pipeline/index.js 未导出 "${prop}"`).to.have.property(prop);
    }
  });

  it('采样率取自共享常量，且与 pipeline 的 SAMPLE_RATE 同源同值', function () {
    const shared = require('../src/inference/shared/constants.js');
    expect(shared.SAMPLE_RATE).to.equal(pipeline.SAMPLE_RATE);
    expect(src).to.match(/getSampleRate\(\)\s*\{\s*return\s+SAMPLE_RATE;/);
  });
});
