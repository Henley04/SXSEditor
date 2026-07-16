const { expect } = require('chai');
const sinon = require('sinon');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const { Readable } = require('node:stream');

const {
  compareVersions,
  getLatestTag,
  checkModelVersion,
  saveModelVersion,
  getLocalModelVersion,
  getLocalModelRevision,
  getModelVersionPath,
  checkJpModelVersion,
  saveJpModelVersion,
  getLocalJpModelVersion,
  getLocalJpModelRevision,
  getJpModelVersionPath,
  invalidateJpModelsCache,
  checkSifiganVersion,
  saveSifiganVersion,
  getLocalSifiganVersion,
  getLocalSifiganRevision,
  getSifiganVersionPath,
} = require('../src/modelManager');

// ===== Helpers =====

/**
 * Create a mock HTTP response (Readable stream) with given status code and body.
 * The stream supports `for await ... of` consumption used by _fetchModelScopeJson.
 */
function createMockResponse(statusCode, body, headers = {}) {
  const response = new Readable();
  response.statusCode = statusCode;
  response.headers = headers;
  if (body) {
    response.push(Buffer.from(body));
  }
  response.push(null);
  return response;
}

/**
 * Build a ModelScope /revisions API response body containing the given tags.
 */
function buildTagsBody(tags) {
  return JSON.stringify({
    Success: true,
    Data: {
      RevisionMap: {
        Tags: tags.map(t => ({ Revision: t })),
      },
    },
  });
}

/**
 * Stub https.request to return a ModelScope revisions API response.
 * Returns the stub so it can be restored.
 */
function stubModelScopeTags(tags) {
  const body = buildTagsBody(tags);
  return sinon.stub(https, 'request').callsFake((reqOptions, callback) => {
    const response = createMockResponse(200, body);
    // Invoke callback asynchronously (after request.end() is called)
    process.nextTick(() => callback(response));
    return {
      on: sinon.stub(),
      setTimeout: sinon.stub(),
      end: sinon.stub(),
      destroy: sinon.stub(),
    };
  });
}

/**
 * Stub https.request to simulate a network failure.
 */
function stubModelScopeNetworkError(errorMessage) {
  return sinon.stub(https, 'request').callsFake(() => {
    const req = {
      on: sinon.stub(),
      setTimeout: sinon.stub(),
      end: sinon.stub(),
      destroy: sinon.stub(),
    };
    // Simulate error event on next tick
    process.nextTick(() => {
      const errorCallback = req.on.getCalls().find(c => c.args[0] === 'error');
      if (errorCallback) errorCallback.args[1](new Error(errorMessage || 'Network error'));
    });
    return req;
  });
}

/**
 * Create a temp directory with a dummy model file so hasModelFiles is true.
 * Returns the path to the temp model directory.
 */
function createTempModelDir(precision) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-model-test-'));
  const subdir = precision === 'fp16' ? 'fp16' : precision;
  const precisionDir = path.join(tmpDir, subdir);
  fs.mkdirSync(precisionDir, { recursive: true });
  // Create a dummy required SVS model file with non-zero size
  fs.writeFileSync(path.join(precisionDir, 'note_text_encoder.onnx'), 'dummy');
  return tmpDir;
}

/**
 * Create a temp directory with dummy JP model files.
 */
function createTempJpModelDir(precision) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-jp-test-'));
  const subdir = precision === 'fp16' ? 'fp16' : precision;
  const jpDir = path.join(tmpDir, subdir, 'JP');
  fs.mkdirSync(jpDir, { recursive: true });
  // Create all required JP model files
  for (const fileName of ['note_text_encoder.onnx', 'preflow.onnx', 'cond_emb.onnx', 'diff_step_dml.onnx']) {
    fs.writeFileSync(path.join(jpDir, fileName), 'dummy');
  }
  return tmpDir;
}

/**
 * Create a temp directory with dummy SiFiGAN model files.
 */
function createTempSifiganModelDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-sifigan-test-'));
  fs.writeFileSync(path.join(tmpDir, 'sifigan_stats.joblib'), 'dummy');
  fs.writeFileSync(path.join(tmpDir, 'sifigan_vocoder_dml.onnx'), 'dummy');
  fs.writeFileSync(path.join(tmpDir, 'sifigan_vocoder_dml.onnx.data'), 'dummy');
  return tmpDir;
}

// ===== Tests =====

describe('Model Version Management', () => {
  describe('compareVersions', () => {
    it('should normalize v-prefix (v1 vs v2)', () => {
      expect(compareVersions('v1', 'v2')).to.equal(-1);
      expect(compareVersions('v2', 'v1')).to.equal(1);
    });

    it('should treat v-prefixed and non-prefixed as equal', () => {
      expect(compareVersions('v1', '1')).to.equal(0);
      expect(compareVersions('v2.0', '2.0')).to.equal(0);
    });

    it('should compare multi-segment versions', () => {
      expect(compareVersions('1.0.0', '1.0.1')).to.equal(-1);
      expect(compareVersions('1.2.0', '1.1.9')).to.equal(1);
      expect(compareVersions('v2.1', 'v2.0')).to.equal(1);
    });

    it('should handle null/empty values', () => {
      expect(compareVersions(null, null)).to.equal(0);
      expect(compareVersions(null, 'v1')).to.equal(-1);
      expect(compareVersions('v1', null)).to.equal(1);
    });

    it('should treat legacy (master) as older than any tag', () => {
      expect(compareVersions('master', 'v1')).to.equal(-1);
      expect(compareVersions('master', 'v2')).to.equal(-1);
    });
  });

  describe('getLatestTag', () => {
    it('should pick the highest tag from a list', () => {
      expect(getLatestTag(['v0', 'v1', 'v2'])).to.equal('v2');
      expect(getLatestTag(['v1', 'v0'])).to.equal('v1');
    });

    it('should handle unsorted tags', () => {
      expect(getLatestTag(['v3', 'v1', 'v2', 'v0'])).to.equal('v3');
    });

    it('should handle single tag', () => {
      expect(getLatestTag(['v1'])).to.equal('v1');
    });

    it('should return null for empty array', () => {
      expect(getLatestTag([])).to.be.null;
      expect(getLatestTag(null)).to.be.null;
      expect(getLatestTag(undefined)).to.be.null;
    });

    it('should ignore non-version tags', () => {
      expect(getLatestTag(['master', 'v1', 'some-branch'])).to.equal('v1');
      expect(getLatestTag(['master', 'nightly'])).to.be.null;
    });
  });

  describe('Version file path helpers', () => {
    it('getModelVersionPath: fp16 uses fp16 subdirectory', () => {
      const p = getModelVersionPath('/models', 'fp16');
      expect(p).to.equal(path.join('/models', 'fp16', 'version.json'));
    });

    it('getModelVersionPath: fp32 uses root directory', () => {
      const p = getModelVersionPath('/models', 'fp32');
      expect(p).to.equal(path.join('/models', 'version.json'));
    });

    it('getJpModelVersionPath: fp16 uses fp16/JP subdirectory', () => {
      const p = getJpModelVersionPath('/models', 'fp16');
      expect(p).to.equal(path.join('/models', 'fp16', 'JP', 'version.json'));
    });

    it('getSifiganVersionPath: uses sifigan_version.json at root', () => {
      const p = getSifiganVersionPath('/models');
      expect(p).to.equal(path.join('/models', 'sifigan_version.json'));
    });
  });

  describe('saveModelVersion / getLocalModelVersion', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-ver-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write the remote revision tag to version.json', () => {
      saveModelVersion(tmpDir, 'fp16', 'v2');
      const version = getLocalModelVersion(tmpDir, 'fp16');
      const revision = getLocalModelRevision(tmpDir, 'fp16');
      expect(version).to.equal('v2');
      expect(revision).to.equal('v2');
    });

    it('should write version.json to the precision subdirectory', () => {
      saveModelVersion(tmpDir, 'fp16', 'v1');
      const versionPath = getModelVersionPath(tmpDir, 'fp16');
      expect(fs.existsSync(versionPath)).to.be.true;
      const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
      expect(data.version).to.equal('v1');
      expect(data.revision).to.equal('v1');
      expect(data.precision).to.equal('fp16');
    });

    it('should overwrite existing version on re-save', () => {
      saveModelVersion(tmpDir, 'fp16', 'v1');
      saveModelVersion(tmpDir, 'fp16', 'v2');
      expect(getLocalModelRevision(tmpDir, 'fp16')).to.equal('v2');
    });

    it('should not write when revision is empty', () => {
      saveModelVersion(tmpDir, 'fp16', '');
      const versionPath = getModelVersionPath(tmpDir, 'fp16');
      expect(fs.existsSync(versionPath)).to.be.false;
    });

    it('getLocalModelVersion should return null when version.json missing (legacy)', () => {
      expect(getLocalModelVersion(tmpDir, 'fp16')).to.be.null;
      expect(getLocalModelRevision(tmpDir, 'fp16')).to.be.null;
    });
  });

  describe('saveJpModelVersion / getLocalJpModelVersion', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-jp-ver-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write JP revision tag to JP version.json', () => {
      saveJpModelVersion(tmpDir, 'fp16', 'v2');
      expect(getLocalJpModelVersion(tmpDir, 'fp16')).to.equal('v2');
      expect(getLocalJpModelRevision(tmpDir, 'fp16')).to.equal('v2');
    });

    it('should write to fp16/JP/version.json', () => {
      saveJpModelVersion(tmpDir, 'fp16', 'v1');
      const jpPath = getJpModelVersionPath(tmpDir, 'fp16');
      expect(fs.existsSync(jpPath)).to.be.true;
      const data = JSON.parse(fs.readFileSync(jpPath, 'utf-8'));
      expect(data.revision).to.equal('v1');
      expect(data.language).to.equal('jp');
    });
  });

  describe('saveSifiganVersion / getLocalSifiganVersion', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-sifi-ver-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write SiFiGAN revision tag to sifigan_version.json', () => {
      saveSifiganVersion(tmpDir, 'v2');
      expect(getLocalSifiganVersion(tmpDir)).to.equal('v2');
      expect(getLocalSifiganRevision(tmpDir)).to.equal('v2');
    });

    it('should write to sifigan_version.json at model root', () => {
      saveSifiganVersion(tmpDir, 'v1');
      const sifiganPath = getSifiganVersionPath(tmpDir);
      expect(fs.existsSync(sifiganPath)).to.be.true;
      const data = JSON.parse(fs.readFileSync(sifiganPath, 'utf-8'));
      expect(data.revision).to.equal('v1');
      expect(data.model).to.equal('sifigan');
    });
  });

  // ===== Network-dependent tests (https.request stubbed) =====

  describe('checkModelVersion - legacy model (no version.json)', () => {
    let tmpDir;
    let httpsStub;

    beforeEach(() => {
      tmpDir = createTempModelDir('fp16');
    });

    afterEach(() => {
      if (httpsStub) httpsStub.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should flag updateAvailable and populate latestVersion from remote tags', async () => {
      httpsStub = stubModelScopeTags(['v0', 'v1', 'v2']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.hasModelFiles).to.be.true;
      expect(result.localRevision).to.be.null;
      expect(result.updateAvailable).to.be.true;
      expect(result.latestVersion).to.equal('v2');
    });

    it('should NOT flag update if network fails and latestVersion is null (v0/null = no real update)', async () => {
      httpsStub = stubModelScopeNetworkError('ECONNREFUSED');
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.be.null;
      expect(result.isLatestV0OrNull).to.be.true;
    });

    it('should flag updateAvailable when only one remote tag exists', async () => {
      httpsStub = stubModelScopeTags(['v1']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.true;
      expect(result.latestVersion).to.equal('v1');
    });

    it('should NOT flag update when remote latest is v0 (v0 = legacy content)', async () => {
      httpsStub = stubModelScopeTags(['v0']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.equal('v0');
      expect(result.isLatestV0OrNull).to.be.true;
    });

    it('should NOT flag update when remote returns no tags', async () => {
      httpsStub = stubModelScopeTags([]);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.be.null;
      expect(result.isLatestV0OrNull).to.be.true;
    });
  });

  describe('checkModelVersion - master revision (legacy)', () => {
    let tmpDir;
    let httpsStub;

    beforeEach(() => {
      tmpDir = createTempModelDir('fp16');
      // Write version.json with revision='master' (legacy branch install)
      saveModelVersion(tmpDir, 'fp16', 'master');
    });

    afterEach(() => {
      if (httpsStub) httpsStub.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should treat master revision as legacy and show latestVersion', async () => {
      httpsStub = stubModelScopeTags(['v1', 'v2']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.localRevision).to.equal('master');
      expect(result.updateAvailable).to.be.true;
      expect(result.latestVersion).to.equal('v2');
    });
  });

  describe('checkModelVersion - tag-based model', () => {
    let tmpDir;
    let httpsStub;

    beforeEach(() => {
      tmpDir = createTempModelDir('fp16');
    });

    afterEach(() => {
      if (httpsStub) httpsStub.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should flag update when local tag is older than remote latest', async () => {
      saveModelVersion(tmpDir, 'fp16', 'v1');
      httpsStub = stubModelScopeTags(['v1', 'v2']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.localRevision).to.equal('v1');
      expect(result.updateAvailable).to.be.true;
      expect(result.latestVersion).to.equal('v2');
    });

    it('should NOT flag update when local tag equals remote latest', async () => {
      saveModelVersion(tmpDir, 'fp16', 'v2');
      httpsStub = stubModelScopeTags(['v0', 'v1', 'v2']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.localRevision).to.equal('v2');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.equal('v2');
    });

    it('should NOT flag update when local tag is newer than remote latest', async () => {
      saveModelVersion(tmpDir, 'fp16', 'v3');
      httpsStub = stubModelScopeTags(['v0', 'v1', 'v2']);
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.equal('v2');
    });

    it('should not flag update on network failure (avoid false positives)', async () => {
      saveModelVersion(tmpDir, 'fp16', 'v1');
      httpsStub = stubModelScopeNetworkError('timeout');
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.be.null;
    });
  });

  describe('checkModelVersion - no model files', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-empty-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return hasModelFiles=false and no update', async () => {
      const result = await checkModelVersion(tmpDir, 'fp16');
      expect(result.hasModelFiles).to.be.false;
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.be.null;
    });
  });

  describe('checkJpModelVersion - legacy model', () => {
    let tmpDir;
    let httpsStub;

    beforeEach(() => {
      tmpDir = createTempJpModelDir('fp16');
      invalidateJpModelsCache();
    });

    afterEach(() => {
      if (httpsStub) httpsStub.restore();
      invalidateJpModelsCache();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should flag updateAvailable and populate latestVersion for legacy JP model', async () => {
      httpsStub = stubModelScopeTags(['v1', 'v2']);
      const result = await checkJpModelVersion(tmpDir, 'fp16');
      expect(result.hasModelFiles).to.be.true;
      expect(result.localRevision).to.be.null;
      expect(result.updateAvailable).to.be.true;
      expect(result.latestVersion).to.equal('v2');
    });

    it('should NOT flag update on network failure (v0/null = no real update)', async () => {
      httpsStub = stubModelScopeNetworkError('fail');
      const result = await checkJpModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.be.null;
      expect(result.isLatestV0OrNull).to.be.true;
    });

    it('should not flag update when JP tag is current', async () => {
      saveJpModelVersion(tmpDir, 'fp16', 'v2');
      invalidateJpModelsCache(tmpDir, 'fp16');
      httpsStub = stubModelScopeTags(['v1', 'v2']);
      const result = await checkJpModelVersion(tmpDir, 'fp16');
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.equal('v2');
    });
  });

  describe('checkSifiganVersion - legacy model', () => {
    let tmpDir;
    let httpsStub;

    beforeEach(() => {
      tmpDir = createTempSifiganModelDir();
    });

    afterEach(() => {
      if (httpsStub) httpsStub.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should flag updateAvailable and populate latestVersion for legacy SiFiGAN', async () => {
      httpsStub = stubModelScopeTags(['v1', 'v2']);
      const result = await checkSifiganVersion(tmpDir);
      expect(result.hasModelFiles).to.be.true;
      expect(result.localRevision).to.be.null;
      expect(result.updateAvailable).to.be.true;
      expect(result.latestVersion).to.equal('v2');
    });

    it('should NOT flag update on network failure (v0/null = no real update)', async () => {
      httpsStub = stubModelScopeNetworkError('fail');
      const result = await checkSifiganVersion(tmpDir);
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.be.null;
      expect(result.isLatestV0OrNull).to.be.true;
    });

    it('should not flag update when SiFiGAN tag is current', async () => {
      saveSifiganVersion(tmpDir, 'v2');
      httpsStub = stubModelScopeTags(['v1', 'v2']);
      const result = await checkSifiganVersion(tmpDir);
      expect(result.updateAvailable).to.be.false;
      expect(result.latestVersion).to.equal('v2');
    });
  });

  // ===== Download → version write integration =====

  describe('Download flow writes remote tag to local version file', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempModelDir('fp16');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should persist remote tag (v2) as both version and revision after download', () => {
      // Simulate what downloadMissingFiles does on success: saveModelVersion
      const downloadedRevision = 'v2';
      saveModelVersion(tmpDir, 'fp16', downloadedRevision);

      // Verify the local version file now records the remote tag
      const localVersion = getLocalModelVersion(tmpDir, 'fp16');
      const localRevision = getLocalModelRevision(tmpDir, 'fp16');
      expect(localVersion).to.equal('v2');
      expect(localRevision).to.equal('v2');

      // Verify the file on disk contains the tag
      const versionPath = getModelVersionPath(tmpDir, 'fp16');
      const data = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
      expect(data.version).to.equal('v2');
      expect(data.revision).to.equal('v2');
    });

    it('should upgrade from legacy to tagged version after download', () => {
      // Before download: legacy (no version.json)
      expect(getLocalModelRevision(tmpDir, 'fp16')).to.be.null;

      // After download with revision 'v2'
      saveModelVersion(tmpDir, 'fp16', 'v2');
      expect(getLocalModelRevision(tmpDir, 'fp16')).to.equal('v2');
      expect(getLocalModelVersion(tmpDir, 'fp16')).to.equal('v2');
    });

    it('should upgrade from v1 to v2 after update download', () => {
      // Before: v1 installed
      saveModelVersion(tmpDir, 'fp16', 'v1');
      expect(getLocalModelRevision(tmpDir, 'fp16')).to.equal('v1');

      // After update download with revision 'v2'
      saveModelVersion(tmpDir, 'fp16', 'v2');
      expect(getLocalModelRevision(tmpDir, 'fp16')).to.equal('v2');
    });
  });
});
