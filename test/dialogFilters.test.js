const { expect } = require('chai');

const { _mergeFiltersWithPlugins } = require('../src/main/dialogIpc.js');

/**
 * 文件对话框里的插件格式。
 *
 * 合并规则只有三条，但每一条都对应一个用户能感知的失效：
 *   · 不并入第一项 → 默认的"所有支持的格式"里看不到插件文件；
 *   · 不单列一项 → 用户没法"只看 .demo"；
 *   · 重名不去重 → 装了同名格式的插件会出现两条一模一样的选项。
 */
describe('dialogIpc — 插件格式合并进过滤器', () => {
  const base = [
    { name: 'All supported formats', extensions: ['sxsproj', 'sxs'] },
    { name: 'SXSEditor Project', extensions: ['sxsproj', 'sxs'] },
  ];
  const plugin = [{ name: 'Demo Project', extensions: ['demo'] }];

  it('没有插件格式时原样返回（不引入空 filter）', () => {
    expect(_mergeFiltersWithPlugins(base, [])).to.deep.equal(base);
  });

  it('插件扩展名并入第一项，同时单列一项', () => {
    const out = _mergeFiltersWithPlugins(base, plugin);
    expect(out[0].extensions).to.deep.equal(['sxsproj', 'sxs', 'demo']);
    expect(out.map((f) => f.name)).to.deep.equal([
      'All supported formats', 'SXSEditor Project', 'Demo Project',
    ]);
    expect(out[2].extensions).to.deep.equal(['demo']);
  });

  it('extendFirst=false 时不改动第一项', () => {
    const out = _mergeFiltersWithPlugins(base, plugin, false);
    expect(out[0].extensions).to.deep.equal(['sxsproj', 'sxs']);
    expect(out).to.have.lengthOf(3);
  });

  it('同名过滤器不重复追加（大小写不敏感）', () => {
    const out = _mergeFiltersWithPlugins(base, [{ name: 'sxseditor project', extensions: ['x'] }]);
    expect(out.map((f) => f.name)).to.deep.equal(['All supported formats', 'SXSEditor Project']);
  });

  it('多个插件格式：扩展名去重后并入第一项', () => {
    const extra = [
      { name: 'A', extensions: ['a', 'demo'] },
      { name: 'B', extensions: ['demo', 'b'] },
    ];
    const out = _mergeFiltersWithPlugins(base, extra);
    expect(out[0].extensions).to.deep.equal(['sxsproj', 'sxs', 'a', 'demo', 'b']);
    expect(out.map((f) => f.name)).to.deep.equal([
      'All supported formats', 'SXSEditor Project', 'A', 'B',
    ]);
  });

  it('不修改入参（调用方可能复用同一份 filter 数组）', () => {
    const snapshot = JSON.stringify(base);
    _mergeFiltersWithPlugins(base, plugin);
    expect(JSON.stringify(base)).to.equal(snapshot);
  });

  it('base 为空时只返回插件项', () => {
    expect(_mergeFiltersWithPlugins([], plugin)).to.deep.equal(plugin);
  });
});
