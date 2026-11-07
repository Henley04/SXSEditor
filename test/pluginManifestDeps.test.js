const { expect } = require('chai');

const { validateManifest } = require('../src/shared/pluginManifest');
const {
  validateDependencies,
  resolvePluginDependencies,
  buildPluginEdges,
  hasInstallPermission,
} = require('../src/shared/pluginDependencies');
const { findCycles } = require('../src/shared/pluginServices');
const { PERMISSION_GROUPS, HOST_CALL_METHODS, DEPENDENCY_LIMITS } = require('../src/shared/pluginApi');

function goodManifest(overrides = {}) {
  return {
    apiVersion: 2,
    id: 'com.example.demo',
    name: 'Demo Plugin',
    version: '1.0.0',
    main: 'main.js',
    engines: { app: '>=1.0.0' },
    permissions: { ui: ['menu'] },
    ...overrides,
  };
}

const CTX = { dirName: 'com.example.demo', appVersion: '1.5.0' };

describe('pluginManifest.dependencies', function () {
  it('未声明时输出空数组，且不影响权限指纹', function () {
    const r = validateManifest(goodManifest(), CTX);
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.dependencies).to.deep.equal([]);
    expect(r.value.permissionsHash).to.be.a('string').and.not.empty;
  });

  it('接受合法依赖并归一 range / optional', function () {
    const r = validateManifest(goodManifest({
      dependencies: [
        { id: 'audio.cpp', range: '>=1.2.0 <3.0.0' },
        { id: 'llama.cpp', optional: true },
      ],
    }), CTX);
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.dependencies).to.deep.equal([
      { id: 'audio.cpp', range: '>=1.2.0 <3.0.0', optional: false },
      { id: 'llama.cpp', range: '*', optional: true },
    ]);
  });

  it('拒绝依赖自己', function () {
    const r = validateManifest(goodManifest({
      dependencies: [{ id: 'com.example.demo' }],
    }), CTX);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/不能依赖自己/);
  });

  it('拒绝重复 id、非法 id、非法 range 与坏 optional', function () {
    const cases = [
      [{ id: 'a' }, { id: 'a' }],
      [{ id: 'Not Valid' }],
      [{ id: 'a', range: 'not a range at all @@' }],
      [{ id: 'a', optional: 'yes' }],
    ];
    for (const dependencies of cases) {
      const r = validateManifest(goodManifest({ dependencies }), CTX);
      expect(r.ok, JSON.stringify(dependencies)).to.equal(false);
    }
  });

  it('拒绝非数组与超上限', function () {
    expect(validateManifest(goodManifest({ dependencies: {} }), CTX).ok).to.equal(false);
    const many = Array.from({ length: DEPENDENCY_LIMITS.max + 1 }, (_, i) => ({ id: `dep${i}` }));
    const r = validateManifest(goodManifest({ dependencies: many }), CTX);
    expect(r.ok).to.equal(false);
    expect(r.error).to.match(/超过上限/);
  });

  it('依赖声明不需要任何 plugins 权限，也不改变 permissions', function () {
    const r = validateManifest(goodManifest({
      dependencies: [{ id: 'audio.cpp', range: '^1.0.0' }],
    }), CTX);
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.permissions.plugins).to.equal(undefined);
  });
});

describe('validateDependencies（独立入口）', function () {
  it('缺省、空数组返回空值', function () {
    expect(validateDependencies(undefined, 'a')).to.deep.equal({ ok: true, value: [] });
    expect(validateDependencies([], 'a')).to.deep.equal({ ok: true, value: [] });
  });

  it('超长 range、非数组、非对象条目被拒', function () {
    expect(validateDependencies([{ id: 'b', range: 'x'.repeat(200) }], 'a').ok).to.equal(false);
    expect(validateDependencies('nope', 'a').ok).to.equal(false);
    expect(validateDependencies([null], 'a').ok).to.equal(false);
  });
});

describe('validatePermissions 接受 plugins 权限组', function () {
  it('五个取值都可单独声明', function () {
    const r = validateManifest(goodManifest({
      permissions: { plugins: ['inspect', 'installMarket', 'installUrl', 'installPath', 'selfUpdate'] },
    }), CTX);
    expect(r.ok, r.error).to.equal(true);
    expect(r.value.permissions.plugins).to.have.length(5);
  });

  it('未知取值被拒', function () {
    const r = validateManifest(goodManifest({ permissions: { plugins: ['installEverything'] } }), CTX);
    expect(r.ok).to.equal(false);
  });

  it('HOST_CALL_METHODS 覆盖所有 plugins.* 且无重复', function () {
    const pluginMethods = HOST_CALL_METHODS.filter((m) => m.startsWith('plugins.'));
    expect(pluginMethods).to.have.length(4);
    expect(new Set(HOST_CALL_METHODS).size).to.equal(HOST_CALL_METHODS.length);
    expect(PERMISSION_GROUPS.plugins).to.include('selfUpdate');
  });
});

describe('resolvePluginDependencies', function () {
  const manifest = {
    id: 'com.example.accompaniment',
    dependencies: [
      { id: 'audio.cpp', range: '^1.0.0', optional: false },
      { id: 'llama.cpp', range: '>=2.0.0', optional: true },
    ],
  };

  it('全部缺失时逐项标 missing，且返回值没有任何安装动作', function () {
    // 纯函数：没有 IPC、没有落盘、没有回调参数。若哪天有人把 install 塞进来，
    // 这条断言会先炸，而不是让「声明依赖」悄悄变成「自动安装」。
    const r = resolvePluginDependencies(manifest, []);
    expect(r.deps.map((d) => d.missing)).to.deep.equal([true, true]);
    expect(r.deps.map((d) => d.satisfied)).to.deep.equal([false, false]);
    expect(r.deps.map((d) => d.installedVersion)).to.deep.equal([null, null]);
    expect(Object.keys(r).sort()).to.deep.equal(['cycles', 'deps']);
    expect(r.deps[0]).to.not.have.property('install');
  });

  it('版本满足标 satisfied，版本不满足不算 missing', function () {
    const installed = [
      { id: 'audio.cpp', version: '1.4.0' },
      { id: 'llama.cpp', version: '1.0.0' },
    ];
    const r = resolvePluginDependencies(manifest, installed);
    expect(r.deps[0]).to.include({ satisfied: true, missing: false, installedVersion: '1.4.0' });
    expect(r.deps[1]).to.include({ satisfied: false, missing: false, installedVersion: '1.0.0' });
    expect(r.deps[1].optional).to.equal(true);
  });

  it('环只报告，不拒绝加载（findCycles 语义）', function () {
    const installed = [
      { id: 'a', dependencies: [{ id: 'b' }] },
      { id: 'b', dependencies: [{ id: 'a' }] },
    ];
    const cycles = findCycles(buildPluginEdges(installed));
    expect(cycles.length).to.be.greaterThan(0);
    expect(cycles[0][0]).to.equal(cycles[0][cycles[0].length - 1]);
  });

  it('未安装 id 不成节点，不产生假环', function () {
    const edges = buildPluginEdges([
      { id: 'a', dependencies: [{ id: 'not-installed' }] },
    ]);
    expect(findCycles(edges)).to.deep.equal([]);
  });

  it('hasInstallPermission 按来源分别判定', function () {
    const perms = { plugins: ['inspect', 'installMarket'] };
    expect(hasInstallPermission(perms, 'installMarket')).to.equal(true);
    expect(hasInstallPermission(perms, 'installUrl')).to.equal(false);
    expect(hasInstallPermission(perms, 'selfUpdate')).to.equal(false);
    expect(hasInstallPermission({}, 'installMarket')).to.equal(false);
    expect(hasInstallPermission(perms, 'bogus')).to.equal(false);
  });
});
