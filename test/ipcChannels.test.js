const { expect } = require('chai');
const { IPC_CHANNELS } = require('../src/shared/ipcChannels');

describe('IPC Channels Constants', function () {
  it('should export an object', function () {
    expect(IPC_CHANNELS).to.be.an('object');
  });

  it('should have all dialog channels', function () {
    expect(IPC_CHANNELS.DIALOG_SAVE).to.equal('dialog:showSaveDialog');
    expect(IPC_CHANNELS.DIALOG_OPEN).to.equal('dialog:showOpenDialog');
  });

  it('should have all file operation channels', function () {
    expect(IPC_CHANNELS.FILE_SAVE).to.equal('file:saveFile');
    expect(IPC_CHANNELS.FILE_READ).to.equal('file:readFile');
    expect(IPC_CHANNELS.FILE_READ_BUFFER).to.equal('file:readFileBuffer');
    expect(IPC_CHANNELS.FILE_EXISTS).to.equal('file:exists');
    expect(IPC_CHANNELS.FILE_AUTHORIZE).to.equal('file:authorizePath');
  });

  it('should have all SVS pipeline channels', function () {
    expect(IPC_CHANNELS.SVS_INIT).to.equal('svs:init');
    expect(IPC_CHANNELS.SVS_SYNTHESIZE).to.equal('svs:synthesize');
    expect(IPC_CHANNELS.SVS_DISPOSE).to.equal('svs:dispose');
    expect(IPC_CHANNELS.FRAGMENT_SVS_SYNTHESIZE).to.equal('fragment-svs:synthesize');
    expect(IPC_CHANNELS.FRAGMENT_SVS_PROGRESS).to.equal('fragment-svs:progress');
  });

  it('should have all settings channels', function () {
    expect(IPC_CHANNELS.SETTINGS_GET).to.equal('settings:getSettings');
    expect(IPC_CHANNELS.SETTINGS_SAVE).to.equal('settings:saveSettings');
    expect(IPC_CHANNELS.SETTINGS_GET_DML_DEVICES).to.equal('settings:getDMLDevices');
    expect(IPC_CHANNELS.APP_GET_VERSION).to.equal('app:getVersion');
  });

  it('should have all audio channels', function () {
    expect(IPC_CHANNELS.AUDIO_PLAY).to.equal('audio:play');
    expect(IPC_CHANNELS.AUDIO_STOP).to.equal('audio:stop');
    expect(IPC_CHANNELS.AUDIO_GET_DEVICES).to.equal('audio:getDevices');
    expect(IPC_CHANNELS.AUDIO_ENDED).to.equal('audio:ended');
  });

  it('should have all theme channels', function () {
    expect(IPC_CHANNELS.THEME_BOOTSTRAP).to.equal('theme:bootstrap');
    expect(IPC_CHANNELS.THEME_LIST).to.equal('theme:list');
    expect(IPC_CHANNELS.THEME_GET).to.equal('theme:get');
    expect(IPC_CHANNELS.THEME_APPLY).to.equal('theme:apply');
    expect(IPC_CHANNELS.THEME_CHANGED).to.equal('theme:changed');
  });

  it('should have all WebNN channels', function () {
    expect(IPC_CHANNELS.WEBNN_DETECT_NPU).to.equal('webnn:detectNPU');
    expect(IPC_CHANNELS.WEBNN_LOAD_MODEL).to.equal('webnn:loadModel');
    expect(IPC_CHANNELS.WEBNN_RUN_INFERENCE).to.equal('webnn:runInference');
  });

  it('should have all resource manager channels', function () {
    expect(IPC_CHANNELS.RESMGR_OPEN).to.equal('resmgr:open');
    expect(IPC_CHANNELS.RESMGR_GET_GPU_INFO).to.equal('resmgr:getGPUInfo');
    expect(IPC_CHANNELS.RESMGR_LOAD_MODEL).to.equal('resmgr:loadModel');
  });

  it('should have all model download channels', function () {
    expect(IPC_CHANNELS.MODEL_DOWNLOAD_START).to.equal('model-download:start');
    expect(IPC_CHANNELS.MODEL_DOWNLOAD_CANCEL).to.equal('model-download:cancel');
    expect(IPC_CHANNELS.MODEL_DOWNLOAD_CHECK).to.equal('model-download:check');
    expect(IPC_CHANNELS.MODEL_DOWNLOAD_PROGRESS).to.equal('model-download:progress');
  });

  it('should have all locale channels', function () {
    expect(IPC_CHANNELS.SAVE_LOCALE).to.equal('save-locale');
    expect(IPC_CHANNELS.GET_LOCALE).to.equal('get-locale');
    expect(IPC_CHANNELS.LOCALE_CHANGED).to.equal('locale-changed');
  });

  it('should have unique channel values', function () {
    const values = Object.values(IPC_CHANNELS);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).to.equal(values.length);
  });

  it('should not have any empty channel names', function () {
    for (const [key, value] of Object.entries(IPC_CHANNELS)) {
      expect(value).to.be.a('string').with.length.greaterThan(0);
    }
  });
});
