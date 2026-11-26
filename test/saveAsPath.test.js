/**
 * 「另存为」路径归一化。
 *
 * 三条规则分别对应一次真实故障：保存框在 Linux/GTK 不补后缀、目录名里带点、
 * 用户主动选择插件格式导出。前两种曾经让写出端把整段路径当成扩展名，
 * 判定成插件格式并回 FILE_NOT_HANDLED；第三种不能被改写。
 */
const { expect } = require('chai');

let mod;
before(async () => {
  mod = await import('../src/renderer/saveAsPath.js');
});

describe('saveAsPath — extensionOf（只看 basename 的扩展名）', () => {
  it('普通路径取到最后一段的扩展名并转小写', () => {
    expect(mod.extensionOf('/home/u/song.SXSPROJ')).to.equal('sxsproj');
    expect(mod.extensionOf('C:\\Users\\u\\song.sxs')).to.equal('sxs');
    expect(mod.extensionOf('/home/u/song.vpr')).to.equal('vpr');
  });

  it('目录名里的点不能干扰扩展名判定（旧的 split(".").pop() 会取到 "b\\song"）', () => {
    expect(mod.extensionOf('C:\\a.b\\song.sxsproj')).to.equal('sxsproj');
    expect(mod.extensionOf('/home/a.b/song.sxsproj')).to.equal('sxsproj');
  });

  it('完全没有扩展名时返回空串', () => {
    expect(mod.extensionOf('/tmp/saveas-noext')).to.equal('');
    expect(mod.extensionOf('C:\\Users\\u\\我的工程')).to.equal('');
  });

  it('隐藏文件与以点结尾的名字视为无扩展名', () => {
    expect(mod.extensionOf('/tmp/.gitignore')).to.equal('');
    expect(mod.extensionOf('/tmp/song.')).to.equal('');
  });

  it('空值与非字符串安全返回空串', () => {
    expect(mod.extensionOf('')).to.equal('');
    expect(mod.extensionOf(null)).to.equal('');
    expect(mod.extensionOf(undefined)).to.equal('');
  });
});

describe('saveAsPath — normalizeSavePath（无后缀补宿主默认格式）', () => {
  it('GTK 保存框返回无后缀路径时补 .sxsproj', () => {
    expect(mod.normalizeSavePath('/tmp/saveas-noext')).to.equal('/tmp/saveas-noext.sxsproj');
  });

  it('Windows 路径无后缀同样补齐', () => {
    expect(mod.normalizeSavePath('C:\\Users\\u\\我的工程')).to.equal('C:\\Users\\u\\我的工程.sxsproj');
  });

  it('目录名带点但文件名无后缀，也要补（旧逻辑会误判）', () => {
    expect(mod.normalizeSavePath('C:\\a.b\\song')).to.equal('C:\\a.b\\song.sxsproj');
    expect(mod.normalizeSavePath('/home/a.b/song')).to.equal('/home/a.b/song.sxsproj');
  });

  it('以点结尾的路径先清掉尾点再补，避免出现双点后缀', () => {
    expect(mod.normalizeSavePath('/home/a.b/song.')).to.equal('/home/a.b/song.sxsproj');
    expect(mod.normalizeSavePath('/tmp/song...')).to.equal('/tmp/song.sxsproj');
  });

  it('已有内置扩展名原样保留，不重复补', () => {
    expect(mod.normalizeSavePath('/tmp/song.sxsproj')).to.equal('/tmp/song.sxsproj');
    expect(mod.normalizeSavePath('/tmp/song.sxs')).to.equal('/tmp/song.sxs');
  });

  it('用户主动选择的插件格式原样保留（另存为允许导出）', () => {
    expect(mod.normalizeSavePath('/tmp/song.vpr')).to.equal('/tmp/song.vpr');
    expect(mod.normalizeSavePath('/tmp/song.svp')).to.equal('/tmp/song.svp');
    expect(mod.normalizeSavePath('/tmp/song.vsqx')).to.equal('/tmp/song.vsqx');
    expect(mod.normalizeSavePath('/tmp/song.demo')).to.equal('/tmp/song.demo');
  });

  it('空值原样返回', () => {
    expect(mod.normalizeSavePath('')).to.equal('');
    expect(mod.normalizeSavePath(null)).to.equal('');
  });
});

describe('saveAsPath — isExternalFormat', () => {
  it('内置格式不是外部格式', () => {
    expect(mod.isExternalFormat('/tmp/song.sxsproj')).to.equal(false);
    expect(mod.isExternalFormat('/tmp/song.sxs')).to.equal(false);
  });

  it('插件格式是外部格式', () => {
    expect(mod.isExternalFormat('/tmp/song.vpr')).to.equal(true);
    expect(mod.isExternalFormat('/tmp/song.demo')).to.equal(true);
  });

  it('无扩展名（归一化前）不算外部格式', () => {
    expect(mod.isExternalFormat('/tmp/song')).to.equal(false);
  });
});

describe('saveAsPath — 伴奏音频写回能力', () => {
  it('VPR / SVP（SV1/SV2 双世代 .svp）能写回伴奏，不弹"伴奏将丢失"确认，且保存时必须嵌入音频字节', () => {
    for (const ext of ['vpr', 'svp']) {
      expect(mod.formatDropsAccompaniment(`/tmp/song.${ext}`), ext).to.equal(false);
      expect(mod.requiresAccompanimentAudio(`/tmp/song.${ext}`), ext).to.equal(true);
    }
    expect(mod.formatDropsAccompaniment('/tmp/song.VPR')).to.equal(false);
  });

  it('未登记的虚构示例格式 .demo 仍需写盘前确认（能力清单只含 vpr/svp）', () => {
    expect(mod.formatDropsAccompaniment('/tmp/song.demo')).to.equal(true);
    expect(mod.requiresAccompanimentAudio('/tmp/song.demo')).to.equal(false);
  });

  it('VSQX（XML，无音频容器）仍需写盘前确认', () => {
    expect(mod.formatDropsAccompaniment('/tmp/song.vsqx')).to.equal(true);
    expect(mod.requiresAccompanimentAudio('/tmp/song.vsqx')).to.equal(false);
  });

  it('宿主原生格式既不弹确认，也不因外部格式规则强制嵌入', () => {
    for (const ext of ['sxsproj', 'sxs']) {
      expect(mod.formatDropsAccompaniment(`/tmp/song.${ext}`), ext).to.equal(false);
      expect(mod.requiresAccompanimentAudio(`/tmp/song.${ext}`), ext).to.equal(false);
    }
    expect(mod.formatDropsAccompaniment('/tmp/song')).to.equal(false);
  });
});
