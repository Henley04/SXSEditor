const { TrackManager, createSinger, createFragment } = require('../src/editor/trackManager');
const { expect } = require('chai');

describe('TrackManager', () => {
  let manager;

  beforeEach(() => {
    manager = new TrackManager();
  });

  describe('createSinger', () => {
    it('should create a singer with default values', () => {
      const singer = manager.addSinger();

      expect(singer).to.have.property('id');
      expect(singer).to.have.property('trackName');
      expect(singer).to.have.property('singerName');
      expect(singer).to.have.property('avatarPath', null);
      expect(singer).to.have.property('wavPath', null);
      expect(singer).to.have.property('midiPath', null);
      expect(singer).to.have.property('color');
    });

    it('should create a singer with custom values', () => {
      const singer = manager.addSinger({
        trackName: 'Test Track',
        singerName: 'Test Singer',
        color: '#ff0000',
        wavPath: './test.wav',
      });

      expect(singer.trackName).to.equal('Test Track');
      expect(singer.singerName).to.equal('Test Singer');
      expect(singer.color).to.equal('#ff0000');
      expect(singer.wavPath).to.equal('./test.wav');
    });

    it('should assign unique IDs to singers', () => {
      const s1 = manager.addSinger({ singerName: 'Singer 1' });
      const s2 = manager.addSinger({ singerName: 'Singer 2' });

      expect(s1.id).to.not.equal(s2.id);
    });
  });

  describe('createFragment', () => {
    it('should create a fragment with default values', () => {
      manager.addSinger({ id: 1 });
      const fragment = manager.addFragment({ singerId: 1 });

      expect(fragment).to.have.property('id');
      expect(fragment).to.have.property('singerId', 1);
      expect(fragment).to.have.property('startTime', 0);
      expect(fragment).to.have.property('duration', 4);
      expect(fragment).to.have.property('name');
      expect(fragment).to.have.property('color');
      expect(fragment).to.have.property('notes').that.is.an('array');
      expect(fragment).to.have.property('envelopes');
      expect(fragment.envelopes).to.have.property('volume');
      expect(fragment.envelopes).to.have.property('pan');
      expect(fragment).to.have.property('pitchCurve');
    });

    it('should create a fragment with custom values', () => {
      manager.addSinger({ id: 2 });
      const fragment = manager.addFragment({
        singerId: 2,
        startTime: 10,
        duration: 8,
        name: 'Test Fragment',
      });

      expect(fragment.singerId).to.equal(2);
      expect(fragment.startTime).to.equal(10);
      expect(fragment.duration).to.equal(8);
      expect(fragment.name).to.equal('Test Fragment');
    });

    it('should create default envelope keyframes', () => {
      manager.addSinger({ id: 1 });
      const fragment = manager.addFragment({ singerId: 1 });

      expect(fragment.envelopes.volume.keyframes[0].value).to.equal(1);
      expect(fragment.envelopes.pan.keyframes[0].value).to.equal(0);
      expect(fragment.pitchCurve).to.exist;
    });
  });

  describe('addSinger', () => {
    it('should add a singer and return it', () => {
      const singer = manager.addSinger({ singerName: 'Test Singer' });

      expect(singer.singerName).to.equal('Test Singer');
      expect(manager.getSingers()).to.have.length(1);
    });

    it('should assign unique IDs to singers', () => {
      const s1 = manager.addSinger({ singerName: 'Singer 1' });
      const s2 = manager.addSinger({ singerName: 'Singer 2' });

      expect(s1.id).to.not.equal(s2.id);
    });

    it('should assign different colors to singers', () => {
      const s1 = manager.addSinger({ singerName: 'Singer 1' });
      const s2 = manager.addSinger({ singerName: 'Singer 2' });

      expect(s1.color).to.not.equal(s2.color);
    });
  });

  describe('removeSinger', () => {
    beforeEach(() => {
      manager.addSinger({ singerName: 'Singer 1' });
      manager.addSinger({ singerName: 'Singer 2' });
    });

    it('should remove a singer by ID', () => {
      const singer = manager.getSingers()[0];
      const result = manager.removeSinger(singer.id);

      expect(result).to.be.true;
      expect(manager.getSingers()).to.have.length(1);
    });

    it('should return false for non-existent singer', () => {
      const result = manager.removeSinger(999);

      expect(result).to.be.false;
    });

    it('should not remove the last singer', () => {
      manager.removeSinger(manager.getSingers()[0].id);
      const result = manager.removeSinger(manager.getSingers()[0].id);

      expect(result).to.be.false;
      expect(manager.getSingers()).to.have.length(1);
    });
  });

  describe('getSinger', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1, singerName: 'Singer 1' });
    });

    it('should return singer by ID', () => {
      const singer = manager.getSinger(1);

      expect(singer).to.not.be.null;
      expect(singer.singerName).to.equal('Singer 1');
    });

    it('should return null for non-existent singer', () => {
      expect(manager.getSinger(999)).to.be.null;
    });
  });

  describe('updateSinger', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1, singerName: 'Old Name' });
    });

    it('should update singer properties', () => {
      const result = manager.updateSinger(1, { singerName: 'New Name', color: '#ff0000' });

      expect(result).to.be.true;
      const singer = manager.getSinger(1);
      expect(singer.singerName).to.equal('New Name');
      expect(singer.color).to.equal('#ff0000');
    });

    it('should return false for non-existent singer', () => {
      expect(manager.updateSinger(999, { singerName: 'Test' })).to.be.false;
    });
  });

  describe('addFragment', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1, singerName: 'Singer 1', color: '#3498db' });
    });

    it('should add a fragment and return it', () => {
      const fragment = manager.addFragment({ singerId: 1, name: 'Test Fragment' });

      expect(fragment.name).to.equal('Test Fragment');
      expect(manager.getFragments()).to.have.length(1);
    });

    it('should inherit singer color', () => {
      const fragment = manager.addFragment({ singerId: 1 });

      expect(fragment.color).to.equal('#3498db');
    });

    it('should default to a TRACK_COLORS color for unknown singer', () => {
      const fragment = manager.addFragment({ singerId: 999 });

      expect(manager.getColors()).to.include(fragment.color);
    });
  });

  describe('removeFragment', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1 });
      manager.addFragment({ id: 1, singerId: 1 });
      manager.addFragment({ id: 2, singerId: 1 });
    });

    it('should remove a fragment by ID', () => {
      const result = manager.removeFragment(1);

      expect(result).to.be.true;
      expect(manager.getFragments()).to.have.length(1);
    });

    it('should return false for non-existent fragment', () => {
      expect(manager.removeFragment(999)).to.be.false;
    });

    it('should update activeFragmentId if active fragment is removed', () => {
      manager.setActiveFragment(1);
      manager.removeFragment(1);

      expect(manager.activeFragmentId).to.equal(2);
    });

    it('should set activeFragmentId to null if last fragment is removed', () => {
      manager.removeFragment(2);
      manager.setActiveFragment(1);
      manager.removeFragment(1);

      expect(manager.activeFragmentId).to.be.null;
    });
  });

  describe('getFragment', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1 });
      manager.addFragment({ id: 1, singerId: 1, name: 'Fragment 1' });
    });

    it('should return fragment by ID', () => {
      const fragment = manager.getFragment(1);

      expect(fragment).to.not.be.null;
      expect(fragment.name).to.equal('Fragment 1');
    });

    it('should return null for non-existent fragment', () => {
      expect(manager.getFragment(999)).to.be.null;
    });
  });

  describe('setActiveFragment', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1 });
      manager.addFragment({ id: 1, singerId: 1 });
    });

    it('should set active fragment', () => {
      manager.setActiveFragment(1);

      expect(manager.activeFragmentId).to.equal(1);
    });

    it('should not set non-existent fragment as active', () => {
      manager.setActiveFragment(1);
      manager.setActiveFragment(999);

      expect(manager.activeFragmentId).to.equal(1);
    });
  });

  describe('getActiveFragment', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1 });
      manager.addFragment({ id: 1, singerId: 1 });
    });

    it('should return active fragment', () => {
      manager.setActiveFragment(1);
      const fragment = manager.getActiveFragment();

      expect(fragment).to.not.be.null;
      expect(fragment.id).to.equal(1);
    });

    it('should return null if no active fragment set', () => {
      expect(manager.getActiveFragment()).to.be.null;
    });
  });

  describe('updateFragment', () => {
    beforeEach(() => {
      manager.addSinger({ id: 1 });
      manager.addFragment({ id: 1, singerId: 1, name: 'Old Name' });
    });

    it('should update fragment properties', () => {
      const result = manager.updateFragment(1, { name: 'New Name', duration: 10 });

      expect(result).to.be.true;
      const fragment = manager.getFragment(1);
      expect(fragment.name).to.equal('New Name');
      expect(fragment.duration).to.equal(10);
    });

    it('should return false for non-existent fragment', () => {
      expect(manager.updateFragment(999, { name: 'Test' })).to.be.false;
    });
  });

  describe('getColors', () => {
    it('should return TRACK_COLORS array', () => {
      const colors = manager.getColors();

      expect(colors).to.be.an('array');
      expect(colors.length).to.equal(12);
    });
  });

  describe('color management', () => {
    it('should reuse colors after singer removal', () => {
      const s1 = manager.addSinger({ singerName: 'Singer 1' });
      const s2 = manager.addSinger({ singerName: 'Singer 2' });
      const s3 = manager.addSinger({ singerName: 'Singer 3' });

      manager.removeSinger(s2.id);
      const s4 = manager.addSinger({ singerName: 'Singer 4' });

      expect(s4.color).to.equal(s2.color);
    });
  });
});
