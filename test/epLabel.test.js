'use strict';
/**
 * EP 显示标签的回归测试。
 *
 * 用户报的现象：后端切到 DML 再切回 Windows ML，界面上的 EP 一直显示 DML。
 * 除状态清理外，还要求界面能如实显示 WinML 会话的供应商 EP —— 旧逻辑会把
 * `winml:NvTensorRtRtx` 直接转成大写串，既难读也看不出属于 Windows ML。
 */

const { expect } = require('chai');
const { getEPLabel, getEPBadgeClass } = require('../src/utils/epLabel.js');

describe('EP 显示标签与徽标', () => {
  it('Windows ML 供应商 EP 显示成 WinML / <vendor>', () => {
    expect(getEPLabel('winml:NvTensorRtRtx')).to.equal('WinML / NvTensorRtRtx');
    expect(getEPLabel('WINML:OpenVINO')).to.equal('WinML / OpenVINO');
    expect(getEPLabel('winml:')).to.equal('WinML');
    expect(getEPLabel('winml:   ')).to.equal('WinML');
    expect(getEPBadgeClass('winml:NvTensorRtRtx')).to.equal('winml');
    expect(getEPBadgeClass('WINML:OpenVINO')).to.equal('winml');
  });

  it('既有 EP 映射保持不变', () => {
    expect(getEPLabel('dml')).to.equal('DML');
    expect(getEPLabel('DML')).to.equal('DML');
    expect(getEPLabel('cpu')).to.equal('CPU');
    expect(getEPLabel('tfjs')).to.equal('TFJS');
    expect(getEPBadgeClass('dml')).to.equal('dml');
    expect(getEPBadgeClass('cpu')).to.equal('cpu');
    expect(getEPBadgeClass('tfjs')).to.equal('tfjs');
  });

  it('空值、非字符串与未知 EP 安全降级', () => {
    expect(getEPLabel('')).to.equal('');
    expect(getEPLabel(null)).to.equal('');
    expect(getEPLabel(undefined)).to.equal('');
    expect(getEPBadgeClass('')).to.equal('none');
    expect(getEPBadgeClass(null)).to.equal('none');
    expect(getEPLabel('cuda')).to.equal('CUDA');
    expect(getEPBadgeClass('cuda')).to.equal('none');
  });
});
