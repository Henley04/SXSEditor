import { state, dom, trackManager, history } from './state.js';
import { t } from '../i18n/index.js';
import { showAlertDialog } from '../alertDialog.js';
import { showAudioToMidiDialog, showLoadingOverlay, updateLoadingMessage, hideLoadingOverlay } from './uiControls.js';
import { f0DataToPitchCurveAnchorPoints } from './f0Utils.js';
import { markDirty } from './projectManager.js';
import { refreshAll, renderFragmentTimeline } from './timelineRenderer.js';

export function openFragmentEditor(fragment) {
  if (window.electronAPI?.openFragmentEditor) {
    const singer = trackManager.getSingers().find(s => s.id === fragment.singerId);
    const wavBuffer = singer?.wavBuffer || null;

    window.electronAPI.openFragmentEditor({
      fragment,
      project: state.project,
      wavBuffer,
    });
  } else {
    showAlertDialog(t('main.fragmentEditorNotImplemented'));
  }
}

export function finishDrag() {
  if (state.dragState && state.fragmentDragSnapshot) {
    const fragment = state.dragState.fragment;
    const oldStart = state.fragmentDragSnapshot.startTime;
    const oldDuration = state.fragmentDragSnapshot.duration;
    const oldSingerId = state.fragmentDragSnapshot.singerId;
    const newStart = fragment.startTime;
    const newDuration = fragment.duration;
    const newSingerId = fragment.singerId;
    const fragmentId = fragment.id;

    if (oldStart !== newStart || oldDuration !== newDuration || oldSingerId !== newSingerId) {
      history.push({
        undo() {
          const f = trackManager.getFragment(fragmentId);
          if (f) {
            f.startTime = oldStart;
            f.duration = oldDuration;
            if (oldSingerId !== newSingerId) {
              const oldSinger = trackManager.getSinger(oldSingerId);
              f.singerId = oldSingerId;
              f.color = oldSinger ? oldSinger.color : f.color;
            }
          }
          renderFragmentTimeline();
          if (window.electronAPI?.updateFragmentBounds) {
            window.electronAPI.updateFragmentBounds(fragmentId, { startTime: oldStart, duration: oldDuration });
          }
        },
        redo() {
          const f = trackManager.getFragment(fragmentId);
          if (f) {
            f.startTime = newStart;
            f.duration = newDuration;
            if (oldSingerId !== newSingerId) {
              const newSinger = trackManager.getSinger(newSingerId);
              f.singerId = newSingerId;
              f.color = newSinger ? newSinger.color : f.color;
            }
          }
          renderFragmentTimeline();
          if (window.electronAPI?.updateFragmentBounds) {
            window.electronAPI.updateFragmentBounds(fragmentId, { startTime: newStart, duration: newDuration });
          }
        }
      });
      markDirty();
      if (window.electronAPI?.updateFragmentBounds) {
        window.electronAPI.updateFragmentBounds(fragmentId, { startTime: newStart, duration: newDuration });
      }
    }
  }
  state.dragState = null;
  state.fragmentDragSnapshot = null;
}

export async function handleAudioToMidi() {
  const choice = await showAudioToMidiDialog();
  if (!choice) return;

  const extractPitch = choice === 'withPitch';

  try {
    const result = await window.electronAPI.showOpenDialog({
      title: t('main.audioToMidiSelectFile'),
      filters: [
        { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
        { name: 'WAV Files', extensions: ['wav'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return;
    }

    const filePath = result.filePaths[0];
    const buffer = await window.electronAPI.readFileBuffer(filePath);

    let audioBuffer;
    const ac = new AudioContext();
    try {
      audioBuffer = await ac.decodeAudioData(buffer.slice(0));
    } catch (decodeErr) {
      console.error('Audio decode failed:', decodeErr);
      showAlertDialog(t('main.audioToMidiDecodeFailed') + ': ' + decodeErr.message);
      return;
    } finally {
      ac.close();
    }

    const channelData = audioBuffer.getChannelData(0);
    const audioData = Array.from(channelData);
    const sampleRate = audioBuffer.sampleRate;
    const bpm = state.project.bpm || 120;

    const loading = showLoadingOverlay(t('main.audioToMidiExtracting'));

    let midiNotes = [];
    let f0Data = null;

    try {
      const settings = await window.electronAPI.getSettings();
      const midiTool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'basicpitch';

      if (midiTool === 'rmvpe') {
        // RMVPE: extract F0 + f0ToNotes for MIDI
        const rmvpeResult = await window.electronAPI.extractMidiRosvot({
          audioData,
          sampleRate,
          bpm,
        });

        if (!rmvpeResult.success) {
          throw new Error(rmvpeResult.error || 'RMVPE failed');
        }

        midiNotes = (rmvpeResult.notes || []).map((n, i) => ({
          id: n.id ?? (Date.now() + i),
          pitch: n.pitch ?? 60,
          start: n.start ?? 0,
          duration: n.duration ?? 0.25,
          lyric: n.lyric || 'la',
        }));

        if (extractPitch) {
          f0Data = rmvpeResult.f0Array;
        }
      } else {
        // Basic Pitch: extract MIDI + F0
        const bpResult = await window.electronAPI.extractF0BasicPitch({
          audioData,
          sampleRate,
          bpm,
        });

        if (!bpResult.success) {
          throw new Error(bpResult.error || 'Basic Pitch failed');
        }

        midiNotes = (bpResult.notes || []).map((n, i) => ({
          id: n.id ?? (Date.now() + i),
          pitch: n.pitch ?? 60,
          start: n.start ?? 0,
          duration: n.duration ?? 0.25,
          lyric: n.lyric || 'la',
        }));

        if (extractPitch) {
          updateLoadingMessage(loading, t('main.audioToMidiExtractingF0'));

          const rmvpeResult = await window.electronAPI.extractF0({
            audioData,
            sampleRate,
          });

          if (!rmvpeResult.success) {
            throw new Error(rmvpeResult.error || 'RMVPE failed');
          }

          f0Data = rmvpeResult.f0Array;
        }
      }
    } catch (err) {
      hideLoadingOverlay(loading);
      console.error('Audio to MIDI failed:', err);
      showAlertDialog(t('main.audioToMidiFailed') + ': ' + err.message);
      return;
    }

    hideLoadingOverlay(loading);

    if (midiNotes.length === 0) {
      showAlertDialog(t('main.audioToMidiFailed') + ': no notes extracted');
      return;
    }

    const lastNote = midiNotes[midiNotes.length - 1];
    const totalBeats = lastNote.start + lastNote.duration;
    const duration = Math.max(4, Math.ceil(totalBeats));

    const singer = trackManager.addSinger({
      trackName: t('main.audioToMidiTitle'),
      singerName: t('main.audioToMidiTitle'),
      singerFileMissing: true,
    });

    const fragment = trackManager.addFragment({
      singerId: singer.id,
      startTime: 0,
      duration,
      notes: midiNotes,
    });

    if (f0Data && f0Data.length > 0) {
      const anchorPoints = f0DataToPitchCurveAnchorPoints(f0Data, bpm);
      if (anchorPoints.length > 0) {
        fragment.pitchCurve = {
          enabled: true,
          anchorPoints,
          brushSegments: [],
        };
      }
    }

    state.selectedSingerId = singer.id;
    refreshAll();

    showAlertDialog(t('main.audioToMidiComplete'));
  } catch (err) {
    console.error('Audio to MIDI process error:', err);
    showAlertDialog(t('main.audioToMidiFailed') + ': ' + err.message);
  }
}
