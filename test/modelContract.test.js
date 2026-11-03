const { expect } = require('chai');

const {
  TASKS, ADAPTER_TASKS, LIMITS, ERR,
  endpointId, parseEndpointId, localityOf, isLoopbackHost, isPrivateHost,
  validateInvokeRequest, inputBytes, isLocalityFree,
} = require('../src/shared/modelContract');
const { ModelAcl, fingerprintOf } = require('../src/main/models/ModelAcl');

// ===========================================================================
// 契约：locality / id / 请求校验
// ===========================================================================
describe('modelContract', function () {
  it('endpoint id 必须能拆回 owner 与 localId', function () {
    const id = endpointId('plugin', 'com.example.midi', 'gen');
    expect(id).to.equal('plugin:com.example.midi.gen');
    expect(parseEndpointId(id)).to.deep.equal({ owner: 'plugin', ownerId: 'com.example.midi', localId: 'gen' });
  });

  it('拒绝缺 owner 段或含空格的 id', function () {
    expect(parseEndpointId('openai.gpt')).to.equal(null);
    expect(parseEndpointId('plugin:a b.c')).to.equal(null);
    expect(() => endpointId('nobody', 'a', 'b')).to.throw();
  });

  it('只把回环地址当本机，内网不算', function () {
    expect(isLoopbackHost('127.0.0.1')).to.equal(true);
    expect(isLoopbackHost('localhost')).to.equal(true);
    expect(isLoopbackHost('::1')).to.equal(true);
    expect(isLoopbackHost('192.168.1.5')).to.equal(false);
    expect(isPrivateHost('192.168.1.5')).to.equal(true);
    expect(isPrivateHost('172.20.0.3')).to.equal(true);
    expect(isPrivateHost('8.8.8.8')).to.equal(false);
  });

  it('locality 判定：local-process 与回环是 device，内网是 lan，公网是 cloud', function () {
    expect(localityOf({ adapter: 'local-process' })).to.equal('device');
    expect(localityOf({ adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434' })).to.equal('device');
    // 内网默认不信任：那台机器可能计费、可能是别人管的
    expect(localityOf({ adapter: 'openai-compatible', baseUrl: 'http://192.168.1.9:8080' })).to.equal('lan');
    expect(localityOf({ adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })).to.equal('cloud');
    expect(isLocalityFree('device')).to.equal(true);
    expect(isLocalityFree('lan')).to.equal(false);
  });

  it('用户显式标记覆盖推导结果', function () {
    const ep = {
      adapter: 'openai-compatible',
      baseUrl: 'http://192.168.1.9:8080',
      localityOverride: 'device',
    };
    expect(localityOf(ep)).to.equal('device');
  });

  it('输入字节数按 UTF-8 算，中文不能被当成 1 字节', function () {
    expect(inputBytes('你好')).to.equal(6);
    expect(inputBytes(Buffer.from('你好'))).to.equal(6);
    expect(inputBytes({ a: 1 })).to.be.greaterThan(0);
  });

  it('请求校验拒绝未知 task 与超大输入', function () {
    expect(validateInvokeRequest({ task: 'chat', input: 'hi' })).to.equal(null);
    expect(validateInvokeRequest({ task: 'nope', input: 'hi' })).to.match(/未知 task/);
    const huge = 'x'.repeat((1 << 20) + 1);
    expect(validateInvokeRequest({ task: 'chat', input: huge })).to.match(/输入过大/);
    expect(validateInvokeRequest({ task: 'chat', input: 'hi', endpointId: 'bad' })).to.match(/非法 endpointId/);
  });

  it('adapter 与 task 的对应关系覆盖所有 task', function () {
    for (const task of TASKS) {
      const owners = Object.keys(ADAPTER_TASKS).filter((a) => ADAPTER_TASKS[a].includes(task));
      expect(owners.length, `${task} 没有任何 adapter 能处理`).to.be.greaterThan(0);
    }
  });
});

// ===========================================================================
// ACL
// ===========================================================================
describe('ModelAcl', function () {
  const ep = {
    id: 'user:local.7f3a',
    baseUrl: 'https://api.example.com/v1',
    provider: 'example',
    adapter: 'openai-compatible',
    locality: 'cloud',
  };

  it('没有记录时是 ask，不是 allow 也不是 deny', function () {
    const acl = new ModelAcl();
    expect(acl.decide('plugin:a', ep).decision).to.equal('ask');
  });

  it('本地端点免确认只对 device 生效', function () {
    const acl = new ModelAcl();
    const local = { ...ep, locality: 'device' };
    expect(acl.decide('plugin:a', local, { localFree: true })).to.include({ decision: 'allow', reason: 'local-bypass' });
    // lan 即使开了总开关也要问：内网服务器可能计费
    expect(acl.decide('plugin:a', { ...ep, locality: 'lan' }, { localFree: true }).decision).to.equal('ask');
  });

  it('授权后放行，撤销后回到 ask', function () {
    const acl = new ModelAcl();
    acl.grant('plugin:a', ep, 'allow', 'always');
    expect(acl.decide('plugin:a', ep).decision).to.equal('allow');
    acl.revoke('plugin:a', ep.id);
    expect(acl.decide('plugin:a', ep).decision).to.equal('ask');
  });

  it('端点指纹变化后旧授权自动作废', function () {
    const acl = new ModelAcl();
    acl.grant('plugin:a', ep, 'allow', 'always');
    const changed = { ...ep, baseUrl: 'https://api.evil.com/v1' };
    expect(fingerprintOf(changed)).to.not.equal(fingerprintOf(ep));
    const verdict = acl.decide('plugin:a', changed);
    expect(verdict.decision).to.equal('ask');
    expect(verdict.reason).to.equal('fingerprint-changed');
  });

  it('subject 级 deny 连问都不问', function () {
    const acl = new ModelAcl();
    acl.setSubjectPolicy('plugin:bad', 'deny');
    expect(acl.decide('plugin:bad', ep).decision).to.equal('deny');
    expect(acl.decide('plugin:bad', { ...ep, locality: 'device' }, { localFree: true }).decision).to.equal('deny');
  });

  it('once 用完即删，session 留在内存，always 才落盘', function () {
    const saved = [];
    const acl = new ModelAcl({ store: { load: () => [], save: (rows) => saved.push(rows) } });
    acl.grant('plugin:a', ep, 'allow', 'once');
    acl.grant('plugin:b', ep, 'allow', 'session');
    acl.grant('plugin:c', ep, 'allow', 'always');
    expect(saved.length).to.equal(1);
    expect(saved[0].map((r) => r.subject)).to.deep.equal(['plugin:c']);

    expect(acl.consumeOnce('plugin:a', ep.id)).to.equal(true);
    expect(acl.decide('plugin:a', ep).decision).to.equal('ask');
    expect(acl.decide('plugin:b', ep).decision).to.equal('allow');
  });

  it('端点删除时级联清掉所有授权', function () {
    const acl = new ModelAcl();
    acl.grant('plugin:a', ep, 'allow', 'always');
    acl.grant('plugin:b', ep, 'allow', 'always');
    expect(acl.revokeAllForEndpoint(ep.id)).to.equal(2);
    expect(acl.decide('plugin:a', ep).decision).to.equal('ask');
  });

  it('bypass-all 只作用于显式传入的调用', function () {
    const acl = new ModelAcl();
    const cloud = { ...ep, locality: 'cloud' };
    expect(acl.decide('mcp:t1', cloud, { bypassAll: true })).to.include({ decision: 'allow', reason: 'bypass-all' });
    expect(acl.decide('mcp:t1', cloud).decision).to.equal('ask');
  });

  it('磁盘上只接受 always，坏的 session 记录不会复活', function () {
    const acl = new ModelAcl({
      store: {
        load: () => [{ subject: 'plugin:a', endpointId: ep.id, decision: 'allow', scope: 'session', fingerprint: '' }],
        save: () => {},
      },
    });
    expect(acl.decide('plugin:a', ep).decision).to.equal('ask');
  });

  it('拒绝非法的 decision / scope', function () {
    const acl = new ModelAcl();
    expect(() => acl.grant('plugin:a', ep, 'maybe', 'always')).to.throw();
    expect(() => acl.grant('plugin:a', ep, 'allow', 'forever')).to.throw();
  });

  it('错误码常量与文档一致', function () {
    expect(ERR.NEED_ENDPOINT).to.equal('NEED_ENDPOINT');
    expect(ERR.BACKPRESSURE_OVERFLOW).to.equal('BACKPRESSURE_OVERFLOW');
    expect(LIMITS.maxDurationMs).to.equal(600000);
  });
});
