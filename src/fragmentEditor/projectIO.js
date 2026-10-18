import {
  getCurrentFragment,
  getNotes,
  getEnvelopes,
  getPitchCurve,
  getKanjiGroups,
  getPostprocess,
  getAutoSaveTimer, setAutoSaveTimer,
} from './state.js';

export function scheduleAutoSave() {
  const autoSaveTimer = getAutoSaveTimer();
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  setAutoSaveTimer(setTimeout(() => {
    saveFragmentData();
  }, 500));
}

export function saveFragmentData() {
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
      window.electronAPI.saveFragmentData(currentFragment.id, {
        notes,
        envelopes,
        pitchCurve,
        kanjiGroups,
        postprocess,
        startTime: currentFragment.startTime,
        duration: currentFragment.duration,
      });
    }
  }
}
