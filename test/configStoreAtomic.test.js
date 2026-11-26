/**
 * ConfigStore：并发写同一个配置文件不再互相踩临时文件
 *
 * 现场（启动日志）：
 *
 *   [ConfigStore] 写入 locale 配置失败: ENOENT: no such file or directory,
 *     rename '…\sxseditor-locale.json.42728.tmp' -> '…\sxseditor-locale.json'
 *
 * 根因：临时文件名是 `${pid}.tmp`，**同一进程内**并发写同一文件时名字撞车 ——
 * 前一个 writer 已经把临时文件 rename 走了，后一个再 rename 就是 ENOENT。
 * 启动时每个窗口的 renderer 都会 i18n.setLocale → invoke save-locale，
 * 所以这条几乎必现。
 *
 * 这里锁住的契约：
 *   1. 并发写全部成功，且最终文件内容一定是某个 writer 写的内容（不会残留半截）；
 *   2. 每个 writer 用不同的临时文件名，目录里不留 .tmp；
 *   3. 内容没变就不写盘（启动时每个窗口回写 locale 不该产生磁盘动作）；
 *   4. rename 被 Windows 短暂占用（EPERM/EBUSY/EACCES）时会重试。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const configStore = require('../src/main/configStore.js');

const configPath = configStore.getConfigPath('locale');
const configDir = path.dirname(configPath);

/** 目录里除目标文件外的残留（只看本次相关的临时文件） */
function strayTmpFiles() {
  if (!fs.existsSync(configDir)) return [];
  return fs.readdirSync(configDir).filter((f) => f.startsWith('sxseditor-locale.json.') && f.endsWith('.tmp'));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

describe('ConfigStore 原子写（并发不踩临时文件）', () => {
  beforeEach(() => {
    fs.mkdirSync(configDir, { recursive: true });
    for (const f of strayTmpFiles()) {
      fs.rmSync(path.join(configDir, f), { force: true });
    }
  });

  afterEach(() => {
    for (const f of strayTmpFiles()) {
      fs.rmSync(path.join(configDir, f), { force: true });
    }
  });

  after(() => {
    // 只清理本测试造出来的配置文件，不碰其它真实配置
    try { fs.rmSync(configPath, { force: true }); } catch (_) { /* ignore */ }
  });

  it('20 个并发写全部成功，最终内容是其中一个 writer 的完整 JSON', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => ({ locale: 'en', seq: i }));
    const results = await Promise.all(inputs.map((data) => configStore.writeJsonConfig('locale', data)));

    expect(results.filter(Boolean), '所有并发写都应成功').to.have.length(20);
    const final = readConfig();
    expect(inputs).to.deep.include(final);
    expect(strayTmpFiles(), '不应残留临时文件').to.deep.equal([]);
  });

  it('每个 writer 使用互不相同的临时文件名', async () => {
    const seen = [];
    const origWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async (file, ...rest) => {
      seen.push(String(file));
      return origWriteFile.call(fs.promises, file, ...rest);
    };
    try {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => configStore.writeJsonConfig('locale', { locale: 'en', seq: 100 + i })),
      );
    } finally {
      fs.promises.writeFile = origWriteFile;
    }

    const tmpNames = seen.filter((f) => f.endsWith('.tmp'));
    expect(tmpNames.length).to.be.greaterThan(0);
    expect(new Set(tmpNames).size, '临时文件名撞车就是 ENOENT 的来源').to.equal(tmpNames.length);
    // 历史回归点：固定 `${pid}.tmp` 的写法不能再出现
    expect(readFileSyncSafe('src/main/configStore.js')).to.not.match(/configPath\.\}\.\$\{process\.pid\}\.tmp/);
  });

  it('内容未变化时不落盘', async () => {
    const data = { locale: 'zh-CN', fixed: true };
    expect(await configStore.writeJsonConfig('locale', data)).to.equal(true);

    let writes = 0;
    const origWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async (file, ...rest) => {
      writes += 1;
      return origWriteFile.call(fs.promises, file, ...rest);
    };
    try {
      // 同一个对象形状（键序也一致）—— 启动时各窗口回写 locale 就是这个情况
      expect(await configStore.writeJsonConfig('locale', { locale: 'zh-CN', fixed: true })).to.equal(true);
    } finally {
      fs.promises.writeFile = origWriteFile;
    }
    expect(writes, '同样的内容不该再写一次').to.equal(0);
  });

  it('rename 遇到 EPERM 会重试（Windows 杀软/索引器占用）', async () => {
    const target = configStore.getConfigPath('settings');
    fs.writeFileSync(target, JSON.stringify({ old: true }), 'utf8');

    const origRename = fs.promises.rename;
    let attempts = 0;
    fs.promises.rename = async (from, to) => {
      attempts += 1;
      if (attempts <= 2) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return origRename.call(fs.promises, from, to);
    };
    let ok;
    try {
      ok = await configStore.writeJsonConfig('settings', { fresh: true });
    } finally {
      fs.promises.rename = origRename;
    }

    expect(attempts, '重试次数应覆盖前两次失败').to.be.greaterThan(2);
    expect(ok).to.equal(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).to.deep.equal({ fresh: true });
    fs.rmSync(target, { force: true });
  });

  it('同步写同样用独立临时名且内容未变时不写盘', () => {
    const data = { locale: 'en', sync: true };
    expect(configStore.writeJsonConfigSync('locale', data)).to.equal(true);
    expect(readConfig()).to.deep.equal(data);

    const statBefore = fs.statSync(configPath);
    expect(configStore.writeJsonConfigSync('locale', data)).to.equal(true);
    const statAfter = fs.statSync(configPath);
    expect(statAfter.mtimeMs).to.equal(statBefore.mtimeMs);
    expect(strayTmpFiles()).to.deep.equal([]);
  });
});

function readFileSyncSafe(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}
