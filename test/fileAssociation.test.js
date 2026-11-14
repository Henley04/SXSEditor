const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractOpenPath,
  classify,
  setPendingTarget,
  takePendingTarget,
  pluginProgId,
  extFromPluginProgId,
} = require('../src/main/fileAssociation');

describe('fileAssociation — 系统投递的文件', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-open-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const touch = (name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '{}');
    return p;
  };

  describe('extractOpenPath', () => {
    it('从 argv 里取出工程文件', () => {
      const p = touch('a.sxsproj');
      expect(extractOpenPath(['SXSEditor.exe', p])).to.equal(p);
    });

    it('从 argv 里取出歌手文件', () => {
      const p = touch('b.sxssinger');
      expect(extractOpenPath(['SXSEditor.exe', p])).to.equal(p);
    });

    it('跳过以 - 开头的开关', () => {
      const p = touch('c.sxsproj');
      expect(extractOpenPath(['SXSEditor.exe', '--enable-logging', p])).to.equal(p);
    });

    it('忽略不存在的路径（注册表里可能有历史残留）', () => {
      const missing = path.join(dir, 'ghost.sxsproj');
      expect(extractOpenPath(['SXSEditor.exe', missing])).to.be.null;
    });

    it('忽略不认识的文件类型', () => {
      const p = touch('notes.txt');
      expect(extractOpenPath(['SXSEditor.exe', p])).to.be.null;
    });

    it('argv 为空或非数组时返回 null', () => {
      expect(extractOpenPath(['SXSEditor.exe'])).to.be.null;
      expect(extractOpenPath(undefined)).to.be.null;
    });

    it('多个文件时只取第一个 —— 系统一次只会投递一个', () => {
      const a = touch('first.sxsproj');
      const b = touch('second.sxssinger');
      expect(extractOpenPath(['SXSEditor.exe', a, b])).to.equal(a);
    });
  });

  describe('classify', () => {
    it('识别工程与歌手两类', () => {
      expect(classify('x.sxsproj')).to.deep.equal({ kind: 'project', path: 'x.sxsproj' });
      expect(classify('x.sxssinger')).to.deep.equal({ kind: 'singer', path: 'x.sxssinger' });
    });

    it('大小写不敏感（Windows 上资源管理器给的就是大写）', () => {
      expect(classify('X.SXSPROJ').kind).to.equal('project');
      expect(classify('X.SXSSINGER').kind).to.equal('singer');
    });

    it('其它扩展名返回 null', () => {
      expect(classify('x.sxsproject')).to.be.null;
      expect(classify('x.txt')).to.be.null;
      expect(classify(null)).to.be.null;
    });
  });

  describe('pending 槽', () => {
    it('取走即清空 —— 同一个文件不会被处理两次', () => {
      setPendingTarget({ kind: 'project', path: '/tmp/a.sxsproj' });
      expect(takePendingTarget()).to.deep.equal({ kind: 'project', path: '/tmp/a.sxsproj' });
      expect(takePendingTarget()).to.be.null;
    });

    it('后到的覆盖先到的（连点两个文件，以最后一个为准）', () => {
      setPendingTarget({ kind: 'project', path: '/tmp/a.sxsproj' });
      setPendingTarget({ kind: 'singer', path: '/tmp/b.sxssinger' });
      expect(takePendingTarget().path).to.match(/b\.sxssinger$/);
    });

    it('空值不覆盖已有目标', () => {
      setPendingTarget({ kind: 'project', path: '/tmp/a.sxsproj' });
      setPendingTarget(null);
      expect(takePendingTarget()).to.not.be.null;
    });
  });
});

describe('fileAssociation — 插件扩展名的注册表 ProgId', () => {
  /**
   * ProgId 要满足两个互相拉扯的要求：
   *   · 能唯一标识"哪个插件的哪个扩展名"（清理时靠它精确删键）；
   *   · 能从 ProgId 反解出扩展名（清理 OpenWithProgids 时需要知道挂在哪个键下）。
   *
   * 后一条容易被忽略：插件 id 允许点分（com.example.demo），一旦扩展名不是
   * 最后一段，反解就会把 `demo` 当成 id 的一部分。
   */
  it('由 pluginId 与扩展名确定性生成', () => {
    expect(pluginProgId('example-demo', '.demo')).to.equal('SXSEditor.Plugin.example-demo.demo');
    expect(pluginProgId('example-demo', '.demo')).to.equal(pluginProgId('example-demo', '.demo'));
  });

  it('扩展名大小写/点号归一：.DEMO 与 .demo 是同一个', () => {
    expect(pluginProgId('p', '.DEMO')).to.equal(pluginProgId('p', '.demo'));
  });

  it('点分插件 id 也能反解出扩展名', () => {
    const progId = pluginProgId('com.example.demo', '.vsqx');
    expect(progId).to.equal('SXSEditor.Plugin.com.example.demo.vsqx');
    expect(extFromPluginProgId(progId)).to.equal('.vsqx');
  });

  it('非法字符被替换，不会把注册表路径写歪', () => {
    const progId = pluginProgId('bad id/with\\slashes', '.x');
    expect(progId).to.match(/^SXSEditor\.Plugin\.[A-Za-z0-9._-]+\.x$/);
    expect(extFromPluginProgId(progId)).to.equal('.x');
  });

  it('不是我们的 ProgId 一律返回 null', () => {
    expect(extFromPluginProgId('SXSEditor.Project')).to.equal(null);
    expect(extFromPluginProgId('SomethingElse.demo')).to.equal(null);
    expect(extFromPluginProgId('')).to.equal(null);
    expect(extFromPluginProgId(null)).to.equal(null);
  });

  it('缺扩展名段的畸形 ProgId 返回 null（不猜）', () => {
    expect(extFromPluginProgId('SXSEditor.Plugin.onlyid')).to.equal(null);
    expect(extFromPluginProgId('SXSEditor.Plugin.')).to.equal(null);
  });
});
