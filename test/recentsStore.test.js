'use strict';
/**
 * 欢迎页「最近的工程」在主进程侧的存储。
 *
 * 锁住四条契约：
 *   1. 去重靠归一化后的路径，同一文件重复打开只顶到最前、不堆重复条目；
 *   2. 读出来按 openedAt 新→旧排序，且不超过 MAX_RECENTS；
 *   3. 配置文件是外部可写的文本 —— 结构不合格的条目直接丢掉，绝不抛错
 *      （欢迎页因为一条脏数据打不开，比少显示一条历史严重得多）；
 *   4. IPC 边界只接受绝对路径的字符串，挡住"把配置文件写成垃圾"这条路。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const configStore = require('../src/main/configStore.js');
const recentsStore = require('../src/main/recentsStore.js');
const { validPath } = require('../src/main/recentsIpc.js');

const CONFIG_PATH = configStore.getConfigPath('recentProjects');

function writeRaw(items) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ version: 1, items }), 'utf8');
}

function readRaw() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function cleanup() {
  try { fs.rmSync(CONFIG_PATH, { force: true }); } catch (_) { /* 本来就不存在 */ }
}

describe('recentsStore — 最近工程列表', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('空配置文件 / 不存在的配置文件都返回空数组', () => {
    expect(recentsStore.listRecents()).to.deep.equal([]);
    writeRaw([]);
    expect(recentsStore.listRecents()).to.deep.equal([]);
  });

  it('记录一条：文件名按路径现算，时间戳是最近', async () => {
    await recentsStore.recordRecent('/tmp/music/song a.sxsproj');
    const items = recentsStore.listRecents();
    expect(items).to.have.length(1);
    expect(items[0].name).to.equal('song a.sxsproj');
    expect(items[0].path).to.equal('/tmp/music/song a.sxsproj');
    expect(items[0].openedAt).to.be.closeTo(Date.now(), 5000);
  });

  it('同一文件重复打开不产生第二条，只更新时间并顶到最前', async () => {
    writeRaw([
      { path: '/tmp/first.sxsproj', name: 'first.sxsproj', openedAt: 2000 },
      { path: '/tmp/second.sxsproj', name: 'second.sxsproj', openedAt: 1000 },
    ]);
    await recentsStore.recordRecent('/tmp/second.sxsproj');
    const items = recentsStore.listRecents();
    expect(items.map((i) => i.path)).to.deep.equal(['/tmp/second.sxsproj', '/tmp/first.sxsproj']);
    expect(items[0].openedAt).to.be.greaterThan(2000);
  });

  it('相对路径与空串不会污染列表', async () => {
    writeRaw([{ path: '/tmp/a.sxsproj', name: 'a.sxsproj', openedAt: 1000 }]);
    expect((await recentsStore.recordRecent('')).success).to.equal(false);
    expect((await recentsStore.recordRecent('   ')).success).to.equal(false);
    expect((await recentsStore.recordRecent(undefined)).success).to.equal(false);
    expect(recentsStore.listRecents().map((i) => i.path)).to.deep.equal(['/tmp/a.sxsproj']);
  });

  it('超出上限时挤掉最旧的，保留最新的 MAX_RECENTS 条', async () => {
    const cap = recentsStore.MAX_RECENTS;
    const seeded = cap + 3; // 13 条：开了新的那条以后，最旧的 4 条该被挤掉
    writeRaw(Array.from({ length: seeded }, (_x, i) => ({
      path: `/tmp/p${i}.sxsproj`, openedAt: i + 1,
    })));
    await recentsStore.recordRecent('/tmp/fresh.sxsproj');
    const items = recentsStore.listRecents();
    expect(items).to.have.length(cap);
    expect(items[0].path).to.equal('/tmp/fresh.sxsproj');
    // 剩下的按时间倒序：13、12……一直到 5（最旧的 1~4 被挤掉）
    expect(items.slice(1).map((i) => i.openedAt)).to.deep.equal(
      Array.from({ length: cap - 1 }, (_x, i) => seeded - i),
    );
    expect(items.some((i) => i.path === '/tmp/p0.sxsproj')).to.equal(false);
  });

  it('读出来总是按 openedAt 新→旧，即使文件里是乱序', () => {
    writeRaw([
      { path: '/tmp/c.sxsproj', openedAt: 100 },
      { path: '/tmp/a.sxsproj', openedAt: 300 },
      { path: '/tmp/b.sxsproj', openedAt: 200 },
    ]);
    expect(recentsStore.listRecents().map((i) => i.path)).to.deep.equal([
      '/tmp/a.sxsproj', '/tmp/b.sxsproj', '/tmp/c.sxsproj',
    ]);
  });

  it('结构不合格的条目被丢掉而不是抛错（配置文件是外部可写的）', () => {
    writeRaw([
      null,
      'a string',
      { path: '' },
      { path: 42 },
      { path: '/tmp/no-time.sxsproj', openedAt: 500 },
      { path: '/tmp/bad-time.sxsproj', openedAt: 'not-a-number' },
      { path: '/tmp/nan-time.sxsproj', openedAt: NaN },
    ]);
    const items = recentsStore.listRecents();
    // 时间戳不合格的一律归 0，排在最后（而不是 1970-01-01 那种假日期）
    expect(items.map((i) => i.path)).to.deep.equal([
      '/tmp/no-time.sxsproj', '/tmp/bad-time.sxsproj', '/tmp/nan-time.sxsproj',
    ]);
    expect(items[0].openedAt).to.equal(500);
    expect(items[1].openedAt).to.equal(0);
    expect(items[2].openedAt).to.equal(0);
    // name 不信文件里存的旧值，按路径现算
    expect(items.map((i) => i.name)).to.deep.equal([
      'no-time.sxsproj', 'bad-time.sxsproj', 'nan-time.sxsproj',
    ]);
  });

  it('配置文件不是 JSON / 不是对象时回空数组', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{ this is not json', 'utf8');
    expect(recentsStore.listRecents()).to.deep.equal([]);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ version: 1, items: 'nope' }), 'utf8');
    expect(recentsStore.listRecents()).to.deep.equal([]);
  });

  it('removeRecent 只去掉指定那条；clearRecents 清空', async () => {
    writeRaw([
      { path: '/tmp/a.sxsproj', openedAt: 300 },
      { path: '/tmp/b.sxsproj', openedAt: 200 },
      { path: '/tmp/c.sxsproj', openedAt: 100 },
    ]);
    await recentsStore.removeRecent('/tmp/b.sxsproj');
    expect(recentsStore.listRecents().map((i) => i.path)).to.deep.equal([
      '/tmp/a.sxsproj', '/tmp/c.sxsproj',
    ]);
    await recentsStore.clearRecents();
    expect(recentsStore.listRecents()).to.deep.equal([]);
    expect(readRaw().items).to.deep.equal([]);
  });

  it('写出去的文件带 version 字段（以后好迁移）', async () => {
    await recentsStore.recordRecent('/tmp/a.sxsproj');
    expect(readRaw().version).to.equal(recentsStore.RECENTS_FORMAT_VERSION);
  });
});

describe('recentsStore — 路径归一化', () => {
  it('同一路径的不同写法归一到同一个键（Windows 大小写不敏感）', () => {
    const k1 = recentsStore.recentKey('/tmp/a b/../a b.sxsproj');
    const k2 = recentsStore.recentKey('/tmp/a b.sxsproj');
    expect(k1).to.equal(k2);
  });

  it('反斜杠与正斜杠归一到同一个键', () => {
    expect(recentsStore.recentKey('C:\\tmp\\a.sxsproj'))
      .to.equal(recentsStore.recentKey('C:/tmp/a.sxsproj'));
  });

  it('文件名取最后一段，两种分隔符都认', () => {
    expect(recentsStore.displayName('/tmp/music/a.sxsproj')).to.equal('a.sxsproj');
    expect(recentsStore.displayName('C:\\music\\a.sxsproj')).to.equal('a.sxsproj');
    expect(recentsStore.displayName('/')).to.equal('');
  });
});

describe('recentsIpc — 入口参数校验', () => {
  it('只接受绝对路径字符串', () => {
    expect(validPath('/tmp/a.sxsproj')).to.equal('/tmp/a.sxsproj');
    expect(validPath('  /tmp/a.sxsproj  ')).to.equal('/tmp/a.sxsproj');
    expect(validPath('relative/a.sxsproj')).to.equal(null);
    expect(validPath('')).to.equal(null);
    expect(validPath(null)).to.equal(null);
    expect(validPath(123)).to.equal(null);
    expect(validPath({})).to.equal(null);
  });

  it('挡掉控制字符与超长字符串（它们会污染配置文件与列表文本）', () => {
    expect(validPath('/tmp/a\nb.sxsproj')).to.equal(null);
    expect(validPath('/tmp/a\u0000.sxsproj')).to.equal(null);
    expect(validPath(`/${'x'.repeat(5000)}`)).to.equal(null);
  });
});
