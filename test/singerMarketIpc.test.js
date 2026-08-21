/**
 * Tests for the Singer Market IPC helper functions.
 *
 * The full IPC handlers (login/list/upload/download/...) make outbound HTTPS
 * requests to the Cloudflare Workers backend and are not exercised here.
 * This file covers the pure helpers that can be unit-tested in isolation:
 *   - buildMultipart (multipart/form-data body construction)
 *   - module exports / shape
 */

const { expect } = require('chai');
const Module = require('module');

// singerMarketIpc.js requires `electron` at load time, which is not available
// in the test environment. We inject a minimal stub before requiring the
// module so the require() succeeds. The stub provides ipcMain.handle (no-op)
// and app.getPath (returns a temp dir).
const electronStub = {
  ipcMain: { handle: () => {} },
  app: { getPath: () => '/tmp/sxseditor-test' },
  dialog: { showOpenDialog: () => {}, showSaveDialog: () => {} },
};

// Patch Module._load so `require('electron')` returns our stub. The original
// loader is restored after the test file loads the module.
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

describe('singerMarketIpc', () => {
  describe('module exports', () => {
    it('should export registerSingerMarketIpc as a function', () => {
      expect(singerMarketIpc).to.have.property('registerSingerMarketIpc');
      expect(singerMarketIpc.registerSingerMarketIpc).to.be.a('function');
    });

    it('should export _internal helpers for testing', () => {
      expect(singerMarketIpc).to.have.property('_internal');
      expect(singerMarketIpc._internal).to.have.property('buildMultipart');
      expect(singerMarketIpc._internal).to.have.property('withAuth');
      expect(singerMarketIpc._internal).to.have.property('request');
    });
  });

  describe('buildMultipart', () => {
    const { buildMultipart } = singerMarketIpc._internal;

    it('should produce a Buffer body with the multipart content type', () => {
      const result = buildMultipart({ description: 'hello' }, null);
      expect(result.body).to.be.an.instanceOf(Buffer);
      expect(result.contentType).to.match(/^multipart\/form-data; boundary=/);
    });

    it('should encode text fields into the body', () => {
      const result = buildMultipart({ description: '测试描述', tags: 'pop,rock' }, null);
      const bodyStr = result.body.toString('utf-8');
      expect(bodyStr).to.include('name="description"');
      expect(bodyStr).to.include('测试描述');
      expect(bodyStr).to.include('name="tags"');
      expect(bodyStr).to.include('pop,rock');
    });

    it('should include the file part when a file is provided', () => {
      const fileData = Buffer.from('fake-singer-bytes');
      const result = buildMultipart(
        { description: 'with file' },
        { filename: 'singer.sxssinger', data: fileData, contentType: 'application/octet-stream' }
      );
      const bodyStr = result.body.toString('utf-8');
      expect(bodyStr).to.include('name="file"');
      expect(bodyStr).to.include('filename="singer.sxssinger"');
      expect(bodyStr).to.include('fake-singer-bytes');
      // Body must end with the closing boundary.
      const boundary = result.contentType.split('boundary=')[1];
      expect(bodyStr.endsWith(`--${boundary}--\r\n`)).to.equal(true);
    });

    it('should skip null/undefined fields', () => {
      const result = buildMultipart({ description: 'keep', tags: null, visibility: undefined }, null);
      const bodyStr = result.body.toString('utf-8');
      expect(bodyStr).to.include('keep');
      expect(bodyStr).to.not.include('name="tags"');
      expect(bodyStr).to.not.include('name="visibility"');
    });
  });

  describe('withAuth', () => {
    const { withAuth } = singerMarketIpc._internal;

    it('should return headers unchanged when no session token is loaded', () => {
      // The test stub uses /tmp/sxseditor-test as userData; no token file
      // exists there, so getToken() returns null.
      const input = { 'X-Custom': 'value' };
      const result = withAuth(input);
      expect(result).to.deep.equal(input);
      expect(result).to.not.have.property('Authorization');
    });

    it('should not mutate the input headers object', () => {
      const input = { 'X-Custom': 'value' };
      withAuth(input);
      expect(input).to.deep.equal({ 'X-Custom': 'value' });
    });
  });
});
