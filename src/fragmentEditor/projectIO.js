import {
  getCurrentFragment,
  getNotes,
  getEnvelopes,
  getPitchCurve,
  getKanjiGroups,
  getPostprocess,
  getAutoSaveTimer, setAutoSaveTimer,
} from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';

// 自动保存失败只提示一次，避免拖拽/连续编辑时每次防抖都弹窗；错误始终进日志。
let _saveErrorNotified = false;

export function scheduleAutoSave() {
  const autoSaveTimer = getAutoSaveTimer();
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  setAutoSaveTimer(setTimeout(() => {
    void saveFragmentData();
  }, 500));
}

export async function saveFragmentData() {
  const currentFragment = getCurrentFragment();
  if (currentFragment) {
    const notes = getNotes();
    const envelopes = getEnvelopes();
    const pitchCurve = getPitchCurve();
    const kanjiGroups = getKanjiGroups();
    const postprocess = getPostprocess();
    currentFragment.notes = notes;
    currentFragment.envelopes = envelopes;
    currentFragment.pitchCurve = pitchCurve;
    currentFragment.kanjiGroups = kanjiGroups;
    currentFragment.postprocess = postprocess;
    if (window.electronAPI?.saveFragmentData) {
      try {
        // 之前既没有 await 也没有 catch：IPC 失败会被完全吞掉，用户看到的是
        // "编辑已同步"却其实没保存。
        await window.electronAPI.saveFragmentData(currentFragment.id, {
          notes,
          envelopes,
          pitchCurve,
          kanjiGroups,
          postprocess,
          startTime: currentFragment.startTime,
          duration: currentFragment.duration,
        });
        _saveErrorNotified = false;
      } catch (err) {
        console.error('[FragmentEditor] saveFragmentData failed:', err);
        if (!_saveErrorNotified) {
          _saveErrorNotified = true;
          showAlertDialog(t('fragment.autoSaveFailedDetail', {
            detail: (err && err.message) || String(err),
          }));
        }
      }
    }
  }
}
