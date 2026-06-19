/**
 * 包络曲线编辑器
 * 支持关键帧编辑，音量和声像控制
 */

import { debounce } from '../utils/debounce.js';
import { smoothstep } from '../utils/smoothstep.js';
import { getCanvasColors, invalidateCanvasThemeCache } from '../themes/canvasTheme.js';

class EnvelopeEditor {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      minValue: options.minValue ?? 0,
      maxValue: options.maxValue ?? 1,
      defaultValue: options.defaultValue ?? 0.5,
      showPan: options.showPan ?? false,
      showPromptDialog: options.showPromptDialog ?? null,
      ...options
    };

    this.envelope = { keyframes: [{ time: 0, value: this.options.defaultValue, smoothness: 0 }] };
    this.selectedKeyframeIndex = -1;
    this.draggingKeyframeIndex = -1;
    this.hoverKeyframeIndex = -1;

    this.width = 0;
    this.height = 0;
    this.dpr = window.devicePixelRatio || 1;

    this.padding = { top: 8, bottom: 20, left: 4, right: 4 };
    this.keyframeRadius = 5;

    this.onChange = null;

    this._initEvents();
    this._resize();
  }

  _initEvents() {
    this._boundResize = () => this._resize();
    window.addEventListener('resize', this._boundResize);

    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this._onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this._onMouseLeave());
    this.canvas.addEventListener('contextmenu', (e) => this._onContextMenu(e));
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.render();
  }

  _getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  _timeToX(time) {
    const maxTime = this._getMaxTime();
    const plotWidth = this.width - this.padding.left - this.padding.right;
    return this.padding.left + (time / maxTime) * plotWidth;
  }

  _xToTime(x) {
    const maxTime = this._getMaxTime();
    const plotWidth = this.width - this.padding.left - this.padding.right;
    return Math.max(0, (x - this.padding.left) / plotWidth * maxTime);
  }

  _valueToY(value) {
    const plotHeight = this.height - this.padding.top - this.padding.bottom;
    const normalized = (value - this.options.minValue) / (this.options.maxValue - this.options.minValue);
    return this.padding.top + (1 - normalized) * plotHeight;
  }

  _yToValue(y) {
    const plotHeight = this.height - this.padding.top - this.padding.bottom;
    const normalized = 1 - (y - this.padding.top) / plotHeight;
    return this.options.minValue + normalized * (this.options.maxValue - this.options.minValue);
  }

  _getMaxTime() {
    if (this.envelope.keyframes.length === 0) return 8;
    return Math.max(8, ...this.envelope.keyframes.map(k => k.time)) * 1.2;
  }

  _findKeyframeAt(x, y) {
    for (let i = 0; i < this.envelope.keyframes.length; i++) {
      const kf = this.envelope.keyframes[i];
      const kx = this._timeToX(kf.time);
      const ky = this._valueToY(kf.value);
      const dist = Math.sqrt((x - kx) ** 2 + (y - ky) ** 2);
      if (dist <= this.keyframeRadius + 3) {
        return { index: i, keyframe: kf, x: kx, y: ky };
      }
    }
    return null;
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    const pos = this._getMousePos(e);
    const hit = this._findKeyframeAt(pos.x, pos.y);

    if (hit) {
      this.selectedKeyframeIndex = hit.index;
      this.draggingKeyframeIndex = hit.index;
    } else {
      const time = this._xToTime(pos.x);
      const value = this._yToValue(pos.y);
      this._addKeyframe(time, value);
    }
    this.render();
  }

  _onMouseMove(e) {
    const pos = this._getMousePos(e);
    const hit = this._findKeyframeAt(pos.x, pos.y);

    if (hit) {
      this.hoverKeyframeIndex = hit.index;
      this.canvas.style.cursor = 'pointer';
    } else {
      this.hoverKeyframeIndex = -1;
      this.canvas.style.cursor = 'crosshair';
    }

    if (this.draggingKeyframeIndex !== -1) {
      const time = this._xToTime(pos.x);
      const value = this._yToValue(pos.y);
      const kf = this.envelope.keyframes[this.draggingKeyframeIndex];
      kf.time = Math.max(0, time);
      kf.value = Math.max(this.options.minValue, Math.min(this.options.maxValue, value));
      this._sortKeyframes();
      this.draggingKeyframeIndex = this.envelope.keyframes.indexOf(kf);
      if (this.onChange) this.onChange(this.envelope);
    }

    this.render();
  }

  _onMouseUp() {
    if (this.draggingKeyframeIndex !== -1 && this.onChange) {
      this.onChange(this.envelope);
    }
    this.draggingKeyframeIndex = -1;
  }

  _onMouseLeave() {
    this.hoverKeyframeIndex = -1;
    this.canvas.style.cursor = 'default';
    this.render();
  }

  _onContextMenu(e) {
    e.preventDefault();
    const pos = this._getMousePos(e);
    const hit = this._findKeyframeAt(pos.x, pos.y);

    if (hit) {
      this.selectedKeyframeIndex = hit.index;
      this._showKeyframeMenu(e.clientX, e.clientY, hit.index);
    }
  }

  _showKeyframeMenu(x, y, index) {
    const kf = this.envelope.keyframes[index];

    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      padding: 4px 0;
      z-index: 1000;
      min-width: 120px;
    `;

    const createItem = (text, action) => {
      const item = document.createElement('div');
      item.textContent = text;
      item.style.cssText = `
        padding: 6px 12px;
        cursor: pointer;
        color: var(--fg-primary);
        font-size: 12px;
      `;
      item.addEventListener('mouseenter', () => item.style.background = 'var(--accent-softer)');
      item.addEventListener('mouseleave', () => item.style.background = 'transparent');
      item.addEventListener('click', () => {
        action();
        document.body.removeChild(menu);
      });
      return item;
    };

    menu.appendChild(createItem('编辑', () => {
      const showPrompt = this.options.showPromptDialog;
      if (showPrompt) {
        showPrompt('值 (' + this.options.minValue + '-' + this.options.maxValue + '):', kf.value.toFixed(2), (newValue) => {
          if (newValue !== null) {
            const val = parseFloat(newValue);
            if (!isNaN(val)) {
              kf.value = Math.max(this.options.minValue, Math.min(this.options.maxValue, val));
              if (this.onChange) this.onChange(this.envelope);
              this.render();
            }
          }
        });
        showPrompt('平滑 (0-100):', kf.smoothness.toString(), (newSmoothness) => {
          if (newSmoothness !== null) {
            const sm = parseInt(newSmoothness, 10);
            if (!isNaN(sm)) {
              kf.smoothness = Math.max(0, Math.min(100, sm));
              if (this.onChange) this.onChange(this.envelope);
              this.render();
            }
          }
        });
      }
    }));

    menu.appendChild(createItem('删除', () => {
      if (this.envelope.keyframes.length > 1) {
        this.envelope.keyframes.splice(index, 1);
        this.selectedKeyframeIndex = -1;
        if (this.onChange) this.onChange(this.envelope);
        this.render();
      }
    }));

    document.body.appendChild(menu);

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        document.body.removeChild(menu);
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  _addKeyframe(time, value) {
    const kf = { time, value, smoothness: 0 };
    this.envelope.keyframes.push(kf);
    this._sortKeyframes();
    this.selectedKeyframeIndex = this.envelope.keyframes.indexOf(kf);
    if (this.onChange) this.onChange(this.envelope);
  }

  destroy() {
    window.removeEventListener('resize', this._boundResize);
  }

  _sortKeyframes() {
    this.envelope.keyframes.sort((a, b) => a.time - b.time);
  }

  _interpolateValue(time) {
    const kfs = this.envelope.keyframes;
    if (kfs.length === 0) return this.options.defaultValue;
    if (kfs.length === 1) return kfs[0].value;

    if (time <= kfs[0].time) return kfs[0].value;
    if (time >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;

    for (let i = 0; i < kfs.length - 1; i++) {
      if (time >= kfs[i].time && time <= kfs[i + 1].time) {
        const t = (time - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
        const smoothness = kfs[i].smoothness / 100;
        const smoothT = smoothness > 0 ? this._smoothstep(t, smoothness) : t;
        return kfs[i].value + (kfs[i + 1].value - kfs[i].value) * smoothT;
      }
    }
    return this.options.defaultValue;
  }

  _smoothstep(t, smoothness) {
    const s = Math.max(0, Math.min(1, smoothness));
    const smooth = t * t * (3 - 2 * t);
    return t + s * (smooth - t);
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    const c = getCanvasColors();
    this._drawGrid(c);
    this._drawEnvelopeLine(c);
    this._drawKeyframes(c);
    this._drawLabels(c);
  }

  _drawGrid(c) {
    const ctx = this.ctx;
    const plotHeight = this.height - this.padding.top - this.padding.bottom;

    ctx.strokeStyle = c.gridLineMajor;
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
      const y = this.padding.top + (i / 4) * plotHeight;
      ctx.beginPath();
      ctx.moveTo(this.padding.left, y);
      ctx.lineTo(this.width - this.padding.right, y);
      ctx.stroke();
    }
  }

  _drawEnvelopeLine(c) {
    const ctx = this.ctx;
    const maxTime = this._getMaxTime();
    const steps = Math.max(50, Math.floor(maxTime * 20));

    ctx.strokeStyle = this.options.showPan ? c.paramPan : c.paramVol;
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxTime;
      const value = this._interpolateValue(t);
      const x = this._timeToX(t);
      const y = this._valueToY(value);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  _drawKeyframes(c) {
    const ctx = this.ctx;

    for (let i = 0; i < this.envelope.keyframes.length; i++) {
      const kf = this.envelope.keyframes[i];
      const x = this._timeToX(kf.time);
      const y = this._valueToY(kf.value);
      const isSelected = i === this.selectedKeyframeIndex;
      const isHover = i === this.hoverKeyframeIndex;

      ctx.fillStyle = isSelected ? c.fgPrimary : (isHover ? c.fgSecondary : c.paramVol);
      ctx.beginPath();
      ctx.arc(x, y, this.keyframeRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? c.fgPrimary : c.noteBorder;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();
    }
  }

  _drawLabels(c) {
    const ctx = this.ctx;
    ctx.fillStyle = c.timeText;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';

    if (this.options.showPan) {
      ctx.fillText('L', this.padding.left, this.height - 4);
      ctx.textAlign = 'right';
      ctx.fillText('R', this.width - this.padding.right, this.height - 4);
      ctx.textAlign = 'center';
      ctx.fillText('C', this.width / 2, this.height - 4);
    }
  }

  setEnvelope(envelope) {
    this.envelope = envelope || { keyframes: [{ time: 0, value: this.options.defaultValue, smoothness: 0 }] };
    this.selectedKeyframeIndex = -1;
    this.render();
  }

  getEnvelope() {
    return this.envelope;
  }
}

export { EnvelopeEditor };

// Re-render all envelope editors when theme changes
if (typeof window !== 'undefined') {
  window.addEventListener('theme:changed', () => {
    invalidateCanvasThemeCache();
  });
}