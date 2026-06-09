import { state, trackManager } from './state.js';

export function getSelectedSinger() {
  if (!state.selectedSingerId) return null;
  return trackManager.getSingers().find(s => s.id === state.selectedSingerId) || null;
}
