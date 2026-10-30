const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractOpenPath,
  classify,
  setPendingTarget,
  takePendingTarget,
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
