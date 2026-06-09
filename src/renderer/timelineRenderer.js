import { state, dom, trackManager, history } from './state.js';
import {
  FRAGMENT_HEIGHT,
  SINGER_ROW_HEIGHT,
  HEADER_HEIGHT,
  FRAGMENT_BASE_BEAT_WIDTH,
  REF_BPM,
} from './constants.js';
import { t } from '../i18n/index.js';
import { showConfirmDialog } from '../alertDialog.js';
import { loadSingerFile, showSingerSelectDialog, markDirty } from './projectManager.js';

export function getBeatWidth() {
  const bpmFactor = REF_BPM / (state.project.bpm || 120);
  return FRAGMENT_BASE_BEAT_WIDTH * state.fragmentZoomX * bpmFactor;
}

export function syncFragmentScroll() {
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const beatWidth = getBeatWidth();
  const maxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 16) / 16) * 16);
  const canvasWidth = totalBeats * beatWidth;
  const canvasHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;
  const containerW = dom.fragmentContainer.clientWidth;
  const containerH = dom.fragmentContainer.clientHeight;

  state.fragmentScrollX = Math.max(0, Math.min(state.fragmentScrollX, canvasWidth - containerW));
  state.fragmentScrollY = Math.max(0, Math.min(state.fragmentScrollY, canvasHeight - containerH));

  dom.fragmentCanvas.style.transform = `translate(${-state.fragmentScrollX}px, ${-state.fragmentScrollY}px)`;
  dom.fragmentPlayheadCanvas.style.transform = `translate(${-state.fragmentScrollX}px, ${-state.fragmentScrollY}px)`;
  dom.singerListEl.scrollTop = state.fragmentScrollY;
}

export function renderFragmentTimeline() {
  const ctx = dom.fragmentCanvas.getContext('2d');
  const singers = trackManager.getSingers();
  const fragments = trackManager.getFragments();
  const dpr = window.devicePixelRatio || 1;

  const beatWidth = getBeatWidth();
  const maxBeat = fragments.reduce((max, f) => Math.max(max, f.startTime + f.duration), 0);
  const totalBeats = Math.max(64, Math.ceil((maxBeat + 16) / 16) * 16);
  const canvasWidth = totalBeats * beatWidth;
  const canvasHeight = singers.length * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

  dom.fragmentCanvas.style.width = canvasWidth + 'px';
  dom.fragmentCanvas.style.height = canvasHeight + 'px';
  dom.fragmentCanvas.width = Math.floor(canvasWidth * dpr);
  dom.fragmentCanvas.height = Math.floor(canvasHeight * dpr);

  dom.fragmentPlayheadCanvas.style.width = canvasWidth + 'px';
  dom.fragmentPlayheadCanvas.style.height = canvasHeight + 'px';
  dom.fragmentPlayheadCanvas.width = Math.floor(canvasWidth * dpr);
  dom.fragmentPlayheadCanvas.height = Math.floor(canvasHeight * dpr);

  syncFragmentScroll();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#14141f';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const beatsPerMeasure = state.project.timeSignature ? state.project.timeSignature[0] : 4;

  ctx.strokeStyle = '#2a2a3d';
  ctx.lineWidth = 1;
  for (let i = 0; i <= totalBeats; i++) {
    const x = i * beatWidth;
    const isMeasureLine = (i % beatsPerMeasure === 0);
    ctx.strokeStyle = isMeasureLine ? '#4a4a66' : '#2a2a3d';
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();

    if (isMeasureLine) {
      const measureNum = Math.floor(i / beatsPerMeasure) + 1;
      ctx.fillStyle = '#6a6a86';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(measureNum), x + 2, HEADER_HEIGHT - 4);
    }
  }

  singers.forEach((singer, index) => {
    const y = index * SINGER_ROW_HEIGHT + HEADER_HEIGHT;

    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, y, canvasWidth, SINGER_ROW_HEIGHT - 2);

    ctx.strokeStyle = '#1a1a28';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + SINGER_ROW_HEIGHT - 2);
    ctx.lineTo(canvasWidth, y + SINGER_ROW_HEIGHT - 2);
    ctx.stroke();

    const singerFragments = fragments.filter(f => f.singerId === singer.id);
    singerFragments.forEach(fragment => {
      const fragX = fragment.startTime * beatWidth;
      const fragWidth = fragment.duration * beatWidth;
      const fragY = y + 4;
      const radius = 6;

      // Rounded rect fill
      ctx.fillStyle = fragment.color + 'cc';
      ctx.beginPath();
      ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
      ctx.fill();

      // Rounded rect stroke
      ctx.strokeStyle = fragment.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
      ctx.stroke();

      // MIDI note visualization
      if (fragment.notes && fragment.notes.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(fragX, fragY, fragWidth, FRAGMENT_HEIGHT, radius);
        ctx.clip();

        const midiAreaTop = fragY + 22;
        const midiAreaHeight = FRAGMENT_HEIGHT - 26;
        const fragDuration = fragment.duration;

        // Calculate pitch range
        let minPitch = 127, maxPitch = 0;
        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          if (note.pitch < minPitch) minPitch = note.pitch;
          if (note.pitch > maxPitch) maxPitch = note.pitch;
        }
        if (minPitch > maxPitch) { minPitch = 60; maxPitch = 72; }
        const pitchRange = Math.max(maxPitch - minPitch + 1, 6);

        for (const note of fragment.notes) {
          if (note.start >= fragDuration) continue;
          const noteEnd = Math.min(note.start + note.duration, fragDuration);
          const noteX = fragX + (note.start / fragDuration) * fragWidth;
          const noteW = Math.max(1, ((noteEnd - note.start) / fragDuration) * fragWidth);
          const pitchOffset = (maxPitch - note.pitch) / pitchRange;
          const noteH = Math.max(2, midiAreaHeight / pitchRange);
          const noteY = midiAreaTop + pitchOffset * midiAreaHeight;

          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.fillRect(noteX, noteY, noteW, noteH);
        }
        ctx.restore();
      }

      ctx.fillStyle = '#e0e0f0';
      ctx.font = '11px sans-serif';
      ctx.fillText(fragment.name || t('main.newFragment'), fragX + 6, y + 16);

      ctx.fillStyle = '#a8a8c0';
      ctx.font = '10px sans-serif';
      ctx.fillText(t('main.beatRange', { start: fragment.startTime, end: fragment.startTime + fragment.duration }), fragX + 6, y + 36);

      ctx.save();
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(fragX - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.strokeRect(fragX + fragWidth - 2, y + 4, 4, FRAGMENT_HEIGHT);
      ctx.restore();
    });

    if (singerFragments.length === 0) {
      ctx.fillStyle = '#4a4a66';
      ctx.font = '11px sans-serif';
      ctx.fillText(t('main.clickToAddFragment'), 8, y + 30);
    }
  });
}

export function drawPlayheadLine(elapsedSeconds) {
  if (!dom.fragmentPlayheadCanvas) return;
  const ctx = dom.fragmentPlayheadCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = dom.fragmentPlayheadCanvas.width / dpr;
  const h = dom.fragmentPlayheadCanvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const beatWidth = getBeatWidth();
  const currentBeat = (elapsedSeconds / 60) * state.project.bpm;
  const x = currentBeat * beatWidth;

  if (x < 0 || x > w) return;

  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();

  ctx.fillStyle = '#ff4444';
  ctx.beginPath();
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 5, 0);
  ctx.lineTo(x, 8);
  ctx.closePath();
  ctx.fill();
}

export function clearPlayheadLine() {
  if (!dom.fragmentPlayheadCanvas) return;
  const ctx = dom.fragmentPlayheadCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = dom.fragmentPlayheadCanvas.width / dpr;
  const h = dom.fragmentPlayheadCanvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
}

function commitTrackNameEdit(singer, newName) {
  if (newName && newName !== singer.trackName) {
    const oldName = singer.trackName;
    const singerId = singer.id;
    trackManager.updateSinger(singer.id, { trackName: newName });
    history.push({
      undo() {
        trackManager.updateSinger(singerId, { trackName: oldName });
        refreshAll();
      },
      redo() {
        trackManager.updateSinger(singerId, { trackName: newName });
        refreshAll();
      }
    });
    markDirty();
  }
}

export function renderSingerList() {
  const singers = trackManager.getSingers();
  const currentIds = singers.map(s => s.id).join(',');
  const currentNames = singers.map(s => s.trackName).join(',');
  const currentMissing = singers.map(s => s.singerFileMissing ? '1' : '0').join(',');
  const cacheKey = `${currentIds}|${currentNames}|${currentMissing}|${state.editingTrackNameId}`;
  if (renderSingerList._cacheKey === cacheKey && dom.singerListEl.childElementCount > 0) return;
  renderSingerList._cacheKey = cacheKey;

  dom.singerListEl.innerHTML = '';

  const spacer = document.createElement('div');
  spacer.className = 'singer-row-spacer';
  dom.singerListEl.appendChild(spacer);

  if (singers.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'singer-item-empty';
    emptyItem.setAttribute('role', 'listitem');
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar-empty';
    const placeholder = document.createElement('span');
    placeholder.className = 'singer-avatar-placeholder';
    placeholder.textContent = '+';
    avatarDiv.appendChild(placeholder);
    const infoDiv = document.createElement('div');
    infoDiv.className = 'singer-info-empty';
    const textDiv = document.createElement('div');
    textDiv.className = 'singer-empty-text';
    textDiv.textContent = t('main.clickToAddSinger');
    infoDiv.appendChild(textDiv);
    emptyItem.appendChild(avatarDiv);
    emptyItem.appendChild(infoDiv);
    emptyItem.addEventListener('click', () => {
      showSingerSelectDialog(null);
    });
    dom.singerListEl.appendChild(emptyItem);
    return;
  }

  singers.forEach(singer => {
    const item = document.createElement('div');
    item.className = 'singer-item';
    item.setAttribute('role', 'listitem');
    item.dataset.singerId = singer.id;

    const isEditingTrackName = state.editingTrackNameId === singer.id;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'singer-avatar';
    if (singer.avatarPath && (singer.avatarPath.startsWith('data:image/') || /^[a-zA-Z]:\\|^\//.test(singer.avatarPath))) {
      const img = document.createElement('img');
      img.src = singer.avatarPath;
      img.alt = singer.singerName || '';
      avatarDiv.appendChild(img);
    } else {
      avatarDiv.textContent = '🎤';
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'singer-info';

    if (isEditingTrackName) {
      const input = document.createElement('input');
      input.className = 'singer-track-name-input';
      input.value = singer.trackName;
      input.style.cssText = `
        background: #14141f;
        color: #e0e0f0;
        border: 1px solid #5b8def;
        border-radius: 3px;
        padding: 2px 4px;
        font-size: 12px;
        font-weight: 600;
        width: 100%;
      `;
      infoDiv.appendChild(input);

      const singerNameDiv = document.createElement('div');
      singerNameDiv.className = 'singer-singer-name';
      singerNameDiv.textContent = singer.singerName;
      infoDiv.appendChild(singerNameDiv);

      if (singer.singerFileMissing) {
        const warningDiv = document.createElement('div');
        warningDiv.className = 'singer-file-missing-warning';
        warningDiv.textContent = t('main.singerFileNotFound');
        infoDiv.appendChild(warningDiv);
      } else {
        const configDiv = document.createElement('div');
        configDiv.className = 'singer-config';
        configDiv.textContent = 'SXS INFERENCE';
        infoDiv.appendChild(configDiv);
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commitTrackNameEdit(singer, input.value.trim());
          state.editingTrackNameId = null;
          renderSingerList();
        } else if (e.key === 'Escape') {
          state.editingTrackNameId = null;
          renderSingerList();
        }
      });
      input.addEventListener('blur', () => {
        if (state.editingTrackNameId === singer.id) {
          commitTrackNameEdit(singer, input.value.trim());
          state.editingTrackNameId = null;
          renderSingerList();
        }
      });

      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const trackNameDiv = document.createElement('div');
      trackNameDiv.className = 'singer-track-name';
      trackNameDiv.textContent = singer.trackName;
      infoDiv.appendChild(trackNameDiv);

      const singerNameDiv = document.createElement('div');
      singerNameDiv.className = 'singer-singer-name';
      singerNameDiv.textContent = singer.singerName;
      infoDiv.appendChild(singerNameDiv);

      if (singer.singerFileMissing) {
        const warningDiv = document.createElement('div');
        warningDiv.className = 'singer-file-missing-warning';
        warningDiv.textContent = t('main.singerFileNotFound');
        infoDiv.appendChild(warningDiv);

        const relocateBtn = document.createElement('button');
        relocateBtn.className = 'btn-relocate-singer';
        relocateBtn.textContent = t('main.relocate');
        relocateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const result = await window.electronAPI.showOpenDialog({
              title: t('main.relocateSingerFile'),
              filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const filePath = result.filePaths[0];
              const buffer = await window.electronAPI.readFileBuffer(filePath);
              await loadSingerFile(singer.id, buffer, filePath);
              refreshAll();
            }
          } catch (err) {
      // TODO: translate garbled log
          }
        });
        infoDiv.appendChild(relocateBtn);
      } else {
        const configDiv = document.createElement('div');
        configDiv.className = 'singer-config';
        configDiv.textContent = 'SXS INFERENCE';
        infoDiv.appendChild(configDiv);
      }

      trackNameDiv.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        state.editingTrackNameId = singer.id;
        renderSingerList();
      });
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'singer-item-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-fragment-add';
    addBtn.title = t('main.addFragment');
    addBtn.dataset.singerId = singer.id;
    addBtn.textContent = '+';
    actionsDiv.appendChild(addBtn);

    if (singers.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-singer-delete';
      delBtn.title = t('main.deleteSinger');
      delBtn.dataset.singerId = singer.id;
      delBtn.textContent = '×';
      actionsDiv.appendChild(delBtn);
    }

    item.appendChild(avatarDiv);
    item.appendChild(infoDiv);
    item.appendChild(actionsDiv);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-fragment-add') || e.target.closest('.btn-singer-delete') || e.target.closest('.singer-track-name-input') || e.target.closest('.btn-relocate-singer')) {
        return;
      }
      if (state.editingTrackNameId === singer.id) {
        const input = item.querySelector('.singer-track-name-input');
        if (input) {
          commitTrackNameEdit(singer, input.value.trim());
        }
        state.editingTrackNameId = null;
        renderSingerList();
        return;
      }
      document.querySelectorAll('.singer-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      state.selectedSingerId = singer.id;
    });

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const singerId = addBtn.dataset.singerId;
      const fragments = trackManager.getFragments();
      const lastFragment = fragments.filter(f => f.singerId === singerId).pop();
      const startTime = lastFragment ? lastFragment.startTime + lastFragment.duration : 0;
      const newFragment = trackManager.addFragment({ singerId, startTime, duration: 4 });
      const newFragmentId = newFragment.id;
      history.push({
        undo() {
          trackManager.removeFragment(newFragmentId);
          refreshAll();
        },
        redo() {
          const singer = trackManager.getSinger(singerId);
          const color = singer ? singer.color : '#5b8def';
          const frag = trackManager.addFragment({ singerId, startTime, duration: 4, color });
          renderFragmentTimeline();
        }
      });
      markDirty();
      renderFragmentTimeline();
    });

    if (singers.length > 1) {
      const delBtn = item.querySelector('.btn-singer-delete');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const singerId = delBtn.dataset.singerId;
          if (await showConfirmDialog(t('main.confirmDeleteSinger', { name: singer.trackName }))) {
            const singerClone = JSON.parse(JSON.stringify(singer));
            const singerFragments = trackManager.getFragments().filter(f => f.singerId === singerId);
            const fragmentsClone = singerFragments.map(f => JSON.parse(JSON.stringify(f)));
            trackManager.removeSinger(singerId);
            history.push({
              undo() {
                const restoredSinger = trackManager.addSinger(singerClone);
                for (const fc of fragmentsClone) {
                  trackManager.addFragment(fc);
                }
                refreshAll();
              },
              redo() {
                trackManager.removeSinger(singerId);
                refreshAll();
              }
            });
            markDirty();
            refreshAll();
          }
        });
      }
    }

    dom.singerListEl.appendChild(item);
  });
}

export function refreshAll() {
  renderSingerList();
  renderFragmentTimeline();
}
