const { expect } = require('chai');
const sinon = require('sinon');

describe('ortOptions', () => {
  let buildSessionOptions, LOG_SEVERITY_MAP, GRAPH_OPT_LEVELS;

  before(() => {
    const opts = require('../src/inference/shared/ortOptions.js');
    buildSessionOptions = opts.buildSessionOptions;
    LOG_SEVERITY_MAP = opts.LOG_SEVERITY_MAP;
    GRAPH_OPT_LEVELS = opts.GRAPH_OPT_LEVELS;
  });

  describe('LOG_SEVERITY_MAP', () => {
    it('should map verbose to 0', () => { expect(LOG_SEVERITY_MAP.verbose).to.equal(0); });
    it('should map info to 1', () => { expect(LOG_SEVERITY_MAP.info).to.equal(1); });
    it('should map warning to 2', () => { expect(LOG_SEVERITY_MAP.warning).to.equal(2); });
    it('should map error to 3', () => { expect(LOG_SEVERITY_MAP.error).to.equal(3); });
    it('should map fatal to 4', () => { expect(LOG_SEVERITY_MAP.fatal).to.equal(4); });
  });

  describe('GRAPH_OPT_LEVELS', () => {
    it('should contain all levels in order', () => {
      expect(GRAPH_OPT_LEVELS).to.deep.equal(['disabled', 'basic', 'extended', 'all']);
    });
  });

  describe('buildSessionOptions', () => {
    it('should return baseOptions with defaults applied', () => {
      const opts = buildSessionOptions({ executionProviders: ['cpu'] });
      expect(opts.executionProviders).to.deep.equal(['cpu']);
      expect(opts.enableMemPattern).to.be.true; // non-DML default
      expect(opts.enableCpuMemArena).to.be.true;
      expect(opts.graphOptimizationLevel).to.equal('all');
      expect(opts.executionMode).to.equal('sequential');
    });

    it('should set enableMemPattern to false for DML paths', () => {
      const opts = buildSessionOptions({ executionProviders: [{ name: 'dml' }, 'cpu'] });
      expect(opts.enableMemPattern).to.be.false;
    });

    it('should preserve explicitly provided fields', () => {
      const opts = buildSessionOptions({
        executionProviders: ['cpu'],
        enableMemPattern: false,
      });
      expect(opts.enableMemPattern).to.be.false;
    });

    it('should apply overrides at highest priority', () => {
      const opts = buildSessionOptions(
        { executionProviders: ['cpu'], graphOptimizationLevel: 'basic' },
        { graphOptimizationLevel: 'extended' }
      );
      expect(opts.graphOptimizationLevel).to.equal('extended');
    });

    it('should set executionMode to parallel when configured', () => {
      // No settings module loaded, so defaults should apply
      const opts = buildSessionOptions({ executionProviders: ['cpu'] });
      expect(opts.executionMode).to.equal('sequential');
    });

    it('should return empty defaults when only baseOptions is empty', () => {
      const opts = buildSessionOptions({});
      expect(opts.executionProviders).to.be.undefined;
      expect(opts.enableMemPattern).to.be.true;
      expect(opts.enableCpuMemArena).to.be.true;
    });
  });
});