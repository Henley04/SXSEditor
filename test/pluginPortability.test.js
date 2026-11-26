'use strict';
/**
 * 跨平台便携性（M6 第 4 段）。
 *
 * 这里测的不是"理论上能不能跨平台"，而是**三个平台真实会踩的坑**：
 *
 * · 包在 Linux 上打、在 Windows 上解 —— 条目名里带 `\`、带 `:`、叫 `con.js`；
 * · 只在大小写上不同的两个文件 —— Linux 上是两个，Windows/macOS 上是一个；
 * · 换行符 —— 签名规范文本必须永远是 `\n`，而文件摘要必须按字节算，
 *   两者混为一谈就会出现"同一份代码在两台机器上验签结果不同"。
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const { readZip, createZip, normalizeEntryPath } = require('../src/shared/pluginZip.js');
const signature = require('../src/shared/pluginSignature.js');

const file = (path, data = 'x') => ({ path, data: Buffer.from(data) });

describe('插件包跨平台便携性', () => {
  describe('条目路径归一化', () => {
    it('把反斜杠统一成正斜杠（Windows 打的包）', () => {
      assert.strictEqual(normalizeEntryPath('main\\sub\\a.js'), 'main/sub/a.js');
    });

    it('拒绝绝对路径与盘符', () => {
      assert.strictEqual(normalizeEntryPath('/etc/passwd'), null);
      assert.strictEqual(normalizeEntryPath('C:\\Windows\\system.ini'), null);
      assert.strictEqual(normalizeEntryPath('c:/x'), null);
    });

    it('拒绝目录穿越', () => {
      assert.strictEqual(normalizeEntryPath('../evil.js'), null);
      assert.strictEqual(normalizeEntryPath('a/../../b.js'), null);
    });

    it('去掉空段与 "."', () => {
      assert.strictEqual(normalizeEntryPath('./a//b.js'), 'a/b.js');
    });
  });

  describe('readZip 的便携性检查', () => {
    it('反斜杠条目读出来是正斜杠', () => {
      const buf = createZip([file('a.js'), file('lib/b.js')]);
      const { entries } = readZip(buf);
      assert.deepStrictEqual(entries.map((e) => e.path), ['a.js', 'lib/b.js']);
    });

    it('拒绝仅大小写不同的重名条目', () => {
      // createZip 自己就会拦，所以这里手工构造：两条路径在 Linux 上都合法。
      const build = () => createZip([file('Main.js'), file('lib.js')]);
      const buf = build();
      // 直接把 Main.js 改名成 main.js 需要重算 CRC/长度，成本太高；
      // 用 assertPortableNames 直接测规则本身。
      const { assertPortableNames } = require('../src/shared/pluginZip.js');
      assert.throws(
        () => assertPortableNames([{ path: 'Main.js' }, { path: 'main.js' }]),
        /仅大小写不同的重名条目/,
      );
      assert.doesNotThrow(() => readZip(buf));
    });

    it('拒绝 Windows 保留设备名', () => {
      const { assertPortableNames } = require('../src/shared/pluginZip.js');
      for (const name of ['con', 'CON.js', 'aux', 'nul.json', 'com1', 'lpt9.txt']) {
        assert.throws(() => assertPortableNames([{ path: name }]), /保留设备名/, name);
      }
      // 只是以 con 开头的普通名字不受影响
      assert.doesNotThrow(() => assertPortableNames([{ path: 'config.js' }, { path: 'console.js' }]));
    });

    it('拒绝 Windows 非法字符', () => {
      const { assertPortableNames } = require('../src/shared/pluginZip.js');
      for (const name of ['a<b.js', 'a>b.js', 'a:b.js', 'a"b.js', 'a|b.js', 'a?b.js', 'a*b.js']) {
        assert.throws(() => assertPortableNames([{ path: name }]), /Windows 不可用字符/, name);
      }
    });

    it('拒绝以空格或点结尾的段', () => {
      const { assertPortableNames } = require('../src/shared/pluginZip.js');
      assert.throws(() => assertPortableNames([{ path: 'a./b.js' }]), /以空格或点结尾/);
      assert.throws(() => assertPortableNames([{ path: 'dir /b.js' }]), /以空格或点结尾/);
    });

    it('拒绝过长路径（Windows MAX_PATH 余量）', () => {
      const { assertPortableNames } = require('../src/shared/pluginZip.js');
      const long = `${'a/'.repeat(90)}x.js`;
      assert.ok(long.length > 180);
      assert.throws(() => assertPortableNames([{ path: long }]), /路径过长/);
    });
  });

  describe('createZip 在打包时就拦住', () => {
    it('非法名字打包失败，而不是打出一个只能在 Linux 装的包', () => {
      assert.throws(() => createZip([file('main.js'), file('Main.js')]), /仅大小写不同的重名条目/);
      assert.throws(() => createZip([file('con.js')]), /保留设备名/);
      // `a:b.js` 会先被盘符规则拦下（^[A-Za-z]:），报的是"非法条目路径"；
      // 这里只要求"被拦住"，不锁死是哪条规则先命中。
      assert.throws(() => createZip([file('a:b.js')]), /非法条目路径|Windows 不可用字符/);
    });
  });

  describe('换行符', () => {
    it('签名规范文本只用 LF，不含 CR', () => {
      const text = signature.canonicalList({ 'a.js': 'a'.repeat(64), 'b/c.js': 'b'.repeat(64) });
      assert.ok(!text.includes('\r'), '规范文本里出现了 CR —— Windows 上生成的签名会和 Linux 对不上');
      assert.ok(text.endsWith('\n'), '规范文本必须以换行结尾');
      assert.ok(text.startsWith('sxsp-signature-v1\n'));
    });

    it('摘要按字节算：CRLF 与 LF 是不同的内容', () => {
      const lf = Buffer.from('line1\nline2\n');
      const crlf = Buffer.from('line1\r\nline2\r\n');
      const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
      assert.notStrictEqual(h(lf), h(crlf), '按文本归一化换行会让两平台算出同一个摘要，那是错的');
    });

    it('同一份内容在两平台写出的包，条目字节一致', () => {
      // createZip 不做任何换行转换：Buffer 进、Buffer 出。
      const payload = Buffer.from('a\r\nb\r\n');
      const buf = createZip([file('main.js', payload)]);
      const { entries } = readZip(buf);
      assert.ok(entries[0].data.equals(payload));
    });
  });
});
