/**
 * Tests for the newer singerMarketIpc behaviors:
 *   - buildMultipartParts (streaming multipart construction)
 *   - request() against a real local HTTP server (API base override, body
 *     streaming with Content-Length, progress callback)
 *   - request() timeouts against a black-hole server
 *
 * The API base is overridden via SXS_SINGER_API_BASE so request() talks to a
 * local server instead of the real Cloudflare Workers backend.
 */

const { expect } = require('chai');
const http = require('node:http');
const Module = require('module');

const electronStub = {
  ipcMain: { handle: () => {} },
  app: { getPath: () => '/tmp/sxseditor-test' },
  dialog: { showOpenDialog: () => {}, showSaveDialog: () => {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};

let singerMarketIpc;
try {
  singerMarketIpc = require('../src/main/singerMarketIpc');
} finally {
  Module._load = originalLoad;
}

const { request, buildMultipart, buildMultipartParts, errorPayload, parseGeo, MSG_UNREACHABLE, MSG_TIMEOUT } = singerMarketIpc._internal;

describe('singerMarketIpc request/timeout', function () {
  // Point the client at a local server before the first getApiBase() call.
  let server;
  let baseUrl;

  before(function (done) {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ hello: 'world' }));
        return;
      }
      if (req.url === '/upload') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ received: Buffer.concat(chunks).toString('utf-8') }));
        });
        return;
      }
      if (req.url === '/stall' || req.url.startsWith('/api/files')) {
        // Never respond — exercises the socket-idle timeout (raw request and
        // the singer-market:list IPC handler respectively).
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      process.env.SXS_SINGER_API_BASE = baseUrl;
      done();
    });
  });

  after(function () {
    delete process.env.SXS_SINGER_API_BASE;
    server.close();
  });

  describe('buildMultipartParts', () => {
    it('streamed parts should assemble to the same body as buildMultipart', () => {
      const fields = { description: 'hello', tags: 'pop,rock' };
      const fileData = Buffer.from('FILEBYTES');
      const file = { filename: 'singer.sxssinger', data: fileData };

      const parts = buildMultipartParts(fields, { filename: file.filename });
      const whole = buildMultipart(fields, file);

      // Boundaries are random per call — normalize them before comparing.
      const normalize = (buf) =>
        buf.toString('utf-8').replace(/----SingerMarketBoundary[0-9a-f]+/g, 'BOUNDARY');
      expect(normalize(Buffer.concat([parts.prefix, fileData, parts.suffix])))
        .to.equal(normalize(whole.body));
      expect(parts.contentType.split('boundary=')[0])
        .to.equal(whole.contentType.split('boundary=')[0]);
    });
  });

  describe('request', () => {
    it('should resolve a JSON response from the overridden API base', async () => {
      const res = await request('GET', '/ok');
      expect(res.status).to.equal(200);
      expect(JSON.parse(res.body)).to.deep.equal({ hello: 'world' });
    });

    it('should stream a bodyStream body with the declared Content-Length', async () => {
      const fields = { description: '测试描述' };
      const fileData = Buffer.from('STREAMED_FILE_BYTES');
      const { prefix, suffix, contentType } = buildMultipartParts(fields, {
        filename: 'singer.sxssinger',
      });
      const contentLength = prefix.length + fileData.length + suffix.length;
      const { Readable } = require('node:stream');
      const stream = Readable.from([prefix, fileData, suffix]);

      const res = await request('POST', '/upload', {
        headers: { 'Content-Type': contentType },
        bodyStream: stream,
        bodyLength: contentLength,
      });
      expect(res.status).to.equal(200);
      const echoed = JSON.parse(res.body).received;
      // The echoed body must contain the full file bytes.
      expect(echoed.includes('STREAMED_FILE_BYTES')).to.equal(true);
    });

    it('should report progress when onProgress is provided', async () => {
      const seen = [];
      await request('GET', '/ok', { onProgress: (received, total) => seen.push([received, total]) });
      expect(seen.length).to.be.greaterThan(0);
      expect(seen[seen.length - 1][0]).to.be.greaterThan(0);
    });

    it('should reject with a friendly timeout message against a stalling server', async function () {
      this.timeout(15000); // socket idle timeout is 5s
      let err = null;
      try {
        await request('GET', '/stall');
      } catch (e) {
        err = e;
      }
      expect(err).to.not.equal(null);
      expect(err.message).to.match(/timed out/i);
    });
  });

  describe('parseGeo', () => {
    it('should parse ip-api.com responses', () => {
      const geo = parseGeo({ status: 'success', country: 'United States', countryCode: 'US', query: '8.8.8.8', timezone: 'America/New_York' });
      expect(geo.country).to.equal('US');
      expect(geo.ip).to.equal('8.8.8.8');
    });

    it('should treat mainland China (ipip) as CN', () => {
      const geo = parseGeo({ ret: 'ok', data: { ip: '1.2.3.4', location: ['中国', '江苏', '南京'] } });
      expect(geo.country).to.equal('CN');
    });

    it('should NOT treat Hong Kong/Macao/Taiwan as mainland CN', () => {
      for (const sub of ['香港', '澳门', '台湾']) {
        const geo = parseGeo({ ret: 'ok', data: { ip: '1.2.3.4', location: ['中国', sub] } });
        expect(geo.country, sub).to.not.equal('CN');
      }
    });

    it('should parse Baidu qifu responses', () => {
      expect(parseGeo({ code: 'CHINA', ip: '1.2.3.4' }).country).to.equal('CN');
      expect(parseGeo({ ip: '1.2.3.4', data: { country: '中国' } }).country).to.equal('CN');
      expect(parseGeo({ ip: '1.2.3.4', data: { country: 'United States' } }).country).to.not.equal('CN');
    });

    it('should return null for unrecognized shapes', () => {
      expect(parseGeo(null)).to.equal(null);
      expect(parseGeo({ foo: 'bar' })).to.equal(null);
    });
  });

  describe('errorPayload', () => {
    const fakeDiag = (isCN) => async () => ({
      at: Date.now(),
      apiHost: 'example.invalid',
      apiDns: { system: ['1.2.3.4'], ali: ['1.2.3.4'] },
      geo: isCN ? { country: 'CN', countryName: '中国', ip: '5.6.7.8' } : { country: 'US', countryName: 'United States', ip: '5.6.7.8' },
      geoSource: 'test',
      isMainlandChina: isCN,
      attempts: [{ name: 'DNS(system)', ok: true, detail: '1.2.3.4', ms: 3 }],
    });

    it('should pass non-network errors through unchanged', async () => {
      const payload = await errorPayload(new Error('Not logged in'), fakeDiag(true));
      expect(payload.region).to.equal(undefined);
      expect(payload.error).to.equal('Not logged in');
    });

    it('should produce a region-block message with diagnostics on a CN network', async () => {
      const payload = await errorPayload(new Error(MSG_TIMEOUT), fakeDiag(true));
      expect(payload.region).to.equal('CN');
      expect(payload.error).to.match(/not available in your region/i);
      expect(payload.error).to.contain('example.invalid');       // API address
      expect(payload.error).to.contain('5s / total 30s');        // timeout settings
      expect(payload.error).to.contain('5.6.7.8');               // egress IP
      expect(payload.error).to.contain('DNS(system)');           // attempt info
    });

    it('should show the normal connection failure outside mainland China', async () => {
      const payload = await errorPayload(new Error(MSG_UNREACHABLE + ' (ECONNREFUSED)'), fakeDiag(false));
      expect(payload.region).to.equal('US');
      expect(payload.error).to.not.match(/not available in your region/i);
      expect(payload.error).to.contain('ECONNREFUSED');
    });
  });

  describe('singer-market:list handler (end-to-end region-aware failure)', function () {
    // Re-require the module with a capturing ipcMain stub so we can invoke
    // the really registered handler — this exercises the full chain:
    // handler → request() (wrapped timeout) → errorPayload → CN message.
    let handlers;
    let mod2;

    before(function () {
      handlers = {};
      const originalLoad2 = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
          return {
            ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
            app: { getPath: () => '/tmp/sxseditor-test', getLocale: () => 'en' },
            dialog: { showOpenDialog: () => {}, showSaveDialog: () => {} },
          };
        }
        return originalLoad2.apply(this, arguments);
      };
      try {
        delete require.cache[require.resolve('../src/main/singerMarketIpc')];
        // locale.js may also be cached with a non-capturing stub — keep it.
        mod2 = require('../src/main/singerMarketIpc');
        mod2.registerSingerMarketIpc();
      } finally {
        Module._load = originalLoad2;
      }
      // Seed the new module instance's diagnostics cache with a CN result so
      // the test does not perform real network probes.
      mod2._internal._setDiagCache({
        at: Date.now(),
        apiHost: new URL(baseUrl).hostname,
        apiDns: { system: ['192.0.2.1'], ali: ['192.0.2.1'] },
        geo: { country: 'CN', countryName: '中国', ip: '203.0.113.9' },
        geoSource: 'test',
        isMainlandChina: true,
        attempts: [{ name: 'DNS(system)', ok: true, detail: '192.0.2.1', ms: 1 }],
      });
    });

    it('should return region=CN with diagnostics when the list request times out on a CN network', async function () {
      this.timeout(15000); // socket idle timeout is 5s
      expect(handlers['singer-market:list']).to.be.a('function');
      const payload = await handlers['singer-market:list'](null, { page: 1, limit: 24 });
      expect(payload.success).to.equal(false);
      expect(payload.region).to.equal('CN');
      expect(payload.error).to.match(/not available in your region/i);
      expect(payload.error).to.contain('socket 5s / total 30s');
      expect(payload.error).to.contain('203.0.113.9');   // egress IP info
      expect(payload.error).to.contain('DNS(system)');   // attempt info
      expect(payload.error).to.match(/timed out/i);      // underlying error
    });
  });
});
