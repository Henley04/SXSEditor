/**
 * 歌手编辑链路端到端测试（Electron）。
 *
 * 加载**打包产物**里的 audio_preprocess_window 页面，注入一份「编辑模式」
 * 数据（已有音符 + F0 + 目标文件路径），等钢琴卷轴恢复后点击保存，然后断言
 * 主进程收到的保存参数：filePath 是原文件、midiNotes 已恢复、走的是
 * notifyMainWindowUpdate（就地更新）而不是 notifyMainWindow（新建）。
 *
 * 用法（需要先 npm run package）：
 *   xvfb-run -a npx electron test/e2e/singerEditE2E.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const ASAR = path.join(ROOT, 'out', 'SXSEditor-linux-x64', 'resources', 'app.asar');
const PAGE = path.join(ASAR, '.webpack', 'renderer', 'audio_preprocess_window', 'index.html');
const PRELOAD = path.join(ASAR, '.webpack', 'renderer', 'audio_preprocess_window', 'preload.js');

const OUT_FILE = path.join(os.tmpdir(), 'sxse-singer-edit-e2e.sxssinger');

function makeWav({ seconds = 1, sampleRate = 16000, hz = 261.63, amp = 0.2 } = {}) {
  const n = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / sampleRate) * 32767);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  // ArrayBuffer（渲染进程 decodeAudioData 需要）
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const NOTES = [
  { id: 1, pitch: 60, start: 0, duration: 0.25, lyric: 'la', noteType: 'note' },
  { id: 2, pitch: 62, start: 0.25, duration: 0.25, lyric: 'la', noteType: 'note' },
  { id: 3, pitch: 64, start: 0.5, duration: 0.25, lyric: 'la', noteType: 'note' },
];
const F0 = Array.from({ length: 40 }, (_, i) => ({ time: i * 0.02, f0: i < 12 ? 0 : 261.6 }));

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

async function main() {
  if (!fs.existsSync(PAGE)) {
    console.error('[e2e] packaged page not found, run `npm run package` first:', PAGE);
    return 1;
  }
  if (fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);

  const received = [];
  ipcMain.handle('saveSingerFile', async (_e, data) => {
    received.push(data);
    fs.writeFileSync(OUT_FILE, JSON.stringify({ ok: true, singerName: data.singerName }));
    return { success: true, filePath: data.filePath, canceled: false };
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await win.loadURL('file://' + PAGE);
  await loaded;

  win.webContents.send('loadPreprocessData', {
    data: {
      wavFileName: 'e2e-vocal.wav',
      singerName: 'E2E Singer',
      singerColor: '#3498db',
      avatarImageData: null,
      avatarImageName: '',
      edit: {
        filePath: OUT_FILE,
        singerName: 'E2E Singer',
        color: '#3498db',
        midiNotes: NOTES,
        f0Data: F0,
        singerData: { note_pitch: '60 62 64', f0: '' },
      },
    },
    wavBuffer: makeWav(),
  });

  // 等 decodeAudioData + initPianoRoll + restoreEditContent
  await new Promise((r) => setTimeout(r, 4000));

  const snapshot = await win.webContents.executeJavaScript(`(() => ({
    title: document.getElementById('page-title')?.textContent || '',
    wavName: document.getElementById('wav-file-name')?.textContent || '',
    midiInfo: document.getElementById('midi-info')?.textContent || '',
    hasSave: !!document.getElementById('btn-save'),
  }))()`);
  console.log('[e2e] page:', JSON.stringify(snapshot));

  assert(snapshot.title.includes('E2E Singer'), 'title should show the singer being edited');
  assert(snapshot.wavName.includes('e2e-vocal.wav'), 'wav file name should be loaded');
  assert(/3/.test(snapshot.midiInfo), 'midi info should report the 3 restored notes: ' + snapshot.midiInfo);

  await win.webContents.executeJavaScript("document.getElementById('btn-save').click()");
  await new Promise((r) => setTimeout(r, 2500));

  assert(received.length === 1, 'saveSingerFile should be invoked exactly once, got ' + received.length);
  const payload = received[0];
  console.log('[e2e] save payload:',
    JSON.stringify({
      filePath: payload.filePath,
      singerName: payload.singerName,
      notes: (payload.preprocessResult?.midiNotes || []).length,
      f0: (payload.preprocessResult?.f0Data || []).length,
      notifyMainWindow: payload.notifyMainWindow,
      notifyMainWindowUpdate: payload.notifyMainWindowUpdate,
      wavBytes: payload.wavBuffer ? payload.wavBuffer.byteLength : 0,
    }));

  assert(payload.filePath === OUT_FILE, 'must write back to the original path');
  assert(payload.notifyMainWindowUpdate === true, 'must notify the main window to refresh in place');
  assert(payload.notifyMainWindow !== true, 'must not create a duplicate singer entry');
  assert((payload.preprocessResult?.midiNotes || []).length === 3, 'all 3 notes must survive round-trip');
  assert((payload.preprocessResult?.midiNotes || [])[2].pitch === 64, 'note order/pitch preserved');
  assert(payload.preprocessResult?.singerData?.note_pitch === '60 62 64', 'singerData note_pitch rebuilt from notes');
  assert(fs.existsSync(OUT_FILE), 'file written');

  console.log('[e2e] singer edit round-trip OK');
  return 0;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error('[e2e]', e && e.message ? e.message : e);
  }
  app.exit(code);
});
