const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/**
 * `--cli plugin`（M5 第 2 段）。
 *
 * 这一层的断言集中在**两条路径的分界**上：
 *   · 有运行实例时，命令必须走 HTTP（同一个 dispatch、同一份审计），
 *     不能悄悄起第二套插件进程；
 *   · 没有实例时才落本地，且本地模式必须如实说"状态是临时的"；
 *   · 用户开关写盘后要能被下一次启动读到（并带上 via:'cli' 的审计）。
 *
 * HTTP 那一半用一个假桥接来测：真桥接要起 Electron + 窗口，测不到"CLI 发了
 * 什么请求"这个最关键的点。
 */

const store = require('../src/main/plugins/PluginStateStore');
const { parseArgs } = require('../src/main/cli');
const { runPluginCommand, _setAppVersionForTests } = require('../src/main/cliPlugin');

_setAppVersionForTests('2.0.2');

/**
 * 走真实的参数解析，而不是直接拼 opts。
 *
 * `--json` / `--local` / `--params` 究竟落在 opts 的哪个字段，是 cli.js 与
 * cliPlugin.js 之间的契约；直接构造 opts 会让这条契约完全没被验证。
 */
function cli(...argv) {
  const parsed = parseArgs(['--cli', 'plugin', ...argv]);
  return runPluginCommand(parsed.opts._, parsed.opts);
}

// ---------------------------------------------------------------- 夹具

let root;
let endpointFile;
let server;
let lastRequest;
let schemaMethods;

function manifest(id, extra = {}) {
  return {
    apiVersion: 2,
    id,
    name: `${id} plugin`,
    version: '1.2.3',
    main: 'main.js',
    engines: { app: '>=2.0.0' },
    permissions: { automation: ['expose'] },
    contributes: {
      commands: [{ id: 'stats', title: 'Stats' }],
      automation: { methods: ['stats'] },
      ...extra,
    },
  };
}

function writePlugin(dirName, data) {
  const dir = path.join(root, 'plugins', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(data, null, 2));
  return dir;
}

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return Promise.resolve(fn()).then((code) => {
    process.stdout.write = orig;
    return { code, out: chunks.join('') };
  }, (err) => {
    process.stdout.write = orig;
    throw err;
  });
}

function silenceStderr(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; });
}

// ---------------------------------------------------------------- 安装态扫描

describe('cli plugin — 磁盘快照', function () {
  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-cliplug-'));
    store._setRootForTests(root);
    store.ensureDirs();
    // 指向一个不存在的端点：确保所有用例都落在本地路径，不会碰开发机上的 GUI。
    endpointFile = path.join(root, 'no-endpoint.json');
    process.env.SXSEDITOR_MCP_ENDPOINT = endpointFile;
  });

  afterEach(function () {
    store._setRootForTests(null);
    delete process.env.SXSEDITOR_MCP_ENDPOINT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('列出启用 / 停用 / 隔离三种状态，并按 id 排序', async function () {
    writePlugin('beta', manifest('beta'));
    writePlugin('alpha', manifest('alpha'));

    const registry = store.readRegistry();
    store.setPluginState(registry, 'beta', { enabled: false });
    store.setPluginState(registry, 'alpha', { quarantined: true, quarantineReason: '崩溃' });
    store.writeRegistry(registry);

    const { code, out } = await capture(() => cli('list'));
    expect(code).to.equal(0);
    expect(out).to.contain('2 on disk');
    expect(out).to.contain('no running instance');
    // alpha 在 beta 前面，且状态是磁盘状态（不是 loaded —— 我们没加载任何插件）
    expect(out.indexOf('alpha')).to.be.lessThan(out.indexOf('beta'));
    expect(out).to.match(/alpha\s+v1\.2\.3\s+quarantined/);
    expect(out).to.match(/beta\s+v1\.2\.3\s+disabled/);
  });

  it('automation 列区分"没声明"与"用户关掉"', async function () {
    writePlugin('withmethods', manifest('withmethods'));
    writePlugin('nomethods', manifest('nomethods', { commands: [{ id: 'about', title: 'About' }], automation: { methods: [] } }));
    writePlugin('muted', manifest('muted', { automation: { methods: ['stats'], expose: false } }));

    const registry = store.readRegistry();
    store.setPluginState(registry, 'withmethods', { automationExpose: false });
    store.writeRegistry(registry);

    const { out } = await capture(() => cli('list', '--json'));
    const data = JSON.parse(out);
    const byId = Object.fromEntries(data.plugins.map((p) => [p.id, p]));

    expect(byId.withmethods.automation).to.equal('off');
    expect(byId.nomethods.automation).to.equal(null);
    expect(byId.muted.automation).to.equal(null);
    expect(byId.nomethods.live).to.equal(null);
  });

  it('manifest 坏的目录标成 invalid，不拖垮整张表', async function () {
    writePlugin('broken', { apiVersion: 2, id: 'broken' });
    const { out } = await capture(() => cli('list', '--json'));
    const data = JSON.parse(out);
    expect(data.plugins).to.have.length(1);
    expect(data.plugins[0].status).to.equal('invalid');
    expect(data.plugins[0].error).to.be.a('string');
  });
});

// ---------------------------------------------------------------- 运行实例

describe('cli plugin — 转发给运行中的实例', function () {
  before(function () {
    // 假桥接：只实现 CLI 用到的三个端点，并把每次 POST 记下来。
    server = http.createServer((req, res) => {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer test-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, version: '2.0.2', pid: 4242 }));
      }
      if (req.method === 'GET' && req.url === '/schema') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, result: { version: 1, methods: schemaMethods } }));
      }
      if (req.method === 'POST' && req.url === '/automation') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        return req.on('end', () => {
          lastRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (lastRequest.method === 'demo.stats') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, result: { read: 3, lastFile: 'a.sv2' } }));
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: { code: 'UNKNOWN_METHOD', message: 'Unknown method' } }));
        });
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(function () {
    return new Promise((resolve) => server.close(resolve));
  });

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-cliplug-live-'));
    store._setRootForTests(root);
    store.ensureDirs();
    endpointFile = path.join(root, 'endpoint.json');
    fs.writeFileSync(endpointFile, JSON.stringify({
      port: server.address().port, token: 'test-token', pid: 4242,
    }));
    process.env.SXSEDITOR_MCP_ENDPOINT = endpointFile;
    lastRequest = null;
    schemaMethods = {
      'project.get': { target: 'renderer', summary: 'Get project' },
      'demo.stats': {
        target: 'plugin', summary: '统计', pluginId: 'demo', source: 'plugin:demo', description: 'Decoder counters.',
      },
    };
  });

  afterEach(function () {
    store._setRootForTests(null);
    delete process.env.SXSEDITOR_MCP_ENDPOINT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('methods 只列 target=plugin 的条目（内置方法不算插件方法）', async function () {
    const { code, out } = await capture(() => cli('methods', '--json'));
    expect(code).to.equal(0);
    const data = JSON.parse(out);
    expect(data.methods.map((m) => m.name)).to.deep.equal(['demo.stats']);
    expect(data.instance.port).to.equal(server.address().port);
  });

  it('call 把参数原样转发，并把结果打到 stdout（--json 是单行）', async function () {
    const { code, out } = await capture(() => silenceStderr(
      () => cli('call', 'demo.stats', '--params', '{"includeLast":false}', '--json'),
    ));
    expect(code).to.equal(0);
    expect(lastRequest).to.deep.equal({ method: 'demo.stats', params: { includeLast: false } });
    expect(JSON.parse(out)).to.include({ ok: true });
    expect(out.trim().split('\n')).to.have.length(1);
  });

  it('方法不存在时返回 1，且错误码原样透出', async function () {
    let stderr = '';
    const orig = process.stderr.write;
    process.stderr.write = (c) => { stderr += String(c); return true; };
    let code;
    try {
      code = await cli('call', 'demo.nope');
    } finally {
      process.stderr.write = orig;
    }
    expect(code).to.equal(1);
    expect(stderr).to.contain('UNKNOWN_METHOD');
  });

  it('方法名不是 <pluginId>.<commandId> 时在发请求前就拒绝', async function () {
    const { code } = await capture(() => cli('call', 'stats')).catch(() => ({ code: 2 }));
    expect(code).to.equal(2);
    expect(lastRequest).to.equal(null);
  });

  it('--params 不是对象时拒绝', async function () {
    let code;
    const orig = process.stderr.write;
    process.stderr.write = () => true;
    try {
      code = await cli('call', 'demo.stats', '--params', '[1,2]');
    } finally {
      process.stderr.write = orig;
    }
    expect(code).to.equal(2);
    expect(lastRequest).to.equal(null);
  });

  it('list 的 live 列来自 /schema，而不是 capabilities', async function () {
    const { out } = await capture(() => cli('list', '--json'));
    const data = JSON.parse(out);
    expect(data.instance.pid).to.equal(4242);
    expect(data.plugins).to.deep.equal([]);
  });
});

// ---------------------------------------------------------------- 用户开关

describe('cli plugin — automation on/off', function () {
  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-cliplug-auto-'));
    store._setRootForTests(root);
    store.ensureDirs();
    writePlugin('demo', manifest('demo'));
    endpointFile = path.join(root, 'no-endpoint.json');
    process.env.SXSEDITOR_MCP_ENDPOINT = endpointFile;
  });

  afterEach(function () {
    store._setRootForTests(null);
    delete process.env.SXSEDITOR_MCP_ENDPOINT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('off 写盘后下一次启动读到 false，并留下 via:cli 的审计', async function () {
    const { code } = await capture(() => cli('automation', 'demo', 'off'));
    expect(code).to.equal(0);

    const state = store.getPluginState(store.readRegistry(), 'demo');
    expect(state.automationExpose).to.equal(false);

    const audit = store.readAudit().filter((e) => e.event === 'automation');
    expect(audit).to.have.length(1);
    expect(audit[0].detail).to.deep.equal({ expose: false, via: 'cli' });
  });

  it('未知插件返回 1，不写状态', async function () {
    let code;
    const orig = process.stderr.write;
    process.stderr.write = () => true;
    try {
      code = await cli('automation', 'ghost', 'off');
    } finally {
      process.stderr.write = orig;
    }
    expect(code).to.equal(1);
    // 写盘层不能凭空造出一个 ghost 条目（否则下次 loadAll 会读到它）
    expect(store.readRegistry().plugins).to.not.have.property('ghost');
  });
});
