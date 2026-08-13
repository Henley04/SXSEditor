import { t } from '../i18n/index.js';

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms).padStart(3, '0')}`;
}

/**
 * Unified dialog factory function
 */
export function createDialog(options) {
  const {
    title,
    content,
    contentElement,
    buttons = [],
    styles = {},
    minWidth = 280,
    closeOnClickOutside = true,
  } = options;

  // Create overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--overlay-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: overlay-fade-in 0.2s ease;
  `;

  // Create dialog container
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: ${styles.dialogBackground || 'var(--bg-elevated)'};
    border: 1px solid ${styles.dialogBorder || 'var(--border-strong)'};
    border-radius: 10px;
    padding: 20px;
    min-width: ${minWidth}px;
    max-width: ${styles.maxWidth || '500px'};
    max-height: ${styles.maxHeight || '80vh'};
    overflow-y: ${styles.overflowY || 'auto'};
    color: var(--fg-primary);
    box-shadow: 0 12px 40px var(--shadow-color-strong);
    animation: dialog-enter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  // Create title
  const titleEl = document.createElement('div');
  titleEl.style.cssText = `
    margin-bottom: 16px;
    font-weight: 600;
    font-size: ${styles.titleFontSize || '14px'};
    color: ${styles.titleColor || 'var(--fg-primary)'};
  `;
  titleEl.textContent = title;
  dialog.appendChild(titleEl);

  // Create content area
  if (content) {
    const contentEl = document.createElement('div');
    contentEl.style.cssText = `
      margin-bottom: 16px;
      font-size: ${styles.contentFontSize || '13px'};
      color: ${styles.contentColor || 'var(--fg-muted)'};
      line-height: 1.5;
    `;
    contentEl.textContent = content;
    dialog.appendChild(contentEl);
  }

  if (contentElement) {
    dialog.appendChild(contentElement);
  }

  // Create button container
  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = `
    display: flex;
    gap: 8px;
    justify-content: ${styles.buttonAlign || 'flex-end'};
    flex-direction: ${styles.buttonDirection || 'row'};
    margin-top: ${styles.buttonMarginTop || '12px'};
  `;

  // Button style mapping
  const buttonStyles = {
    primary: `
      padding: 6px 16px;
      background: var(--bg-button-primary);
      border: none;
      border-radius: var(--radius-md);
      color: var(--fg-on-accent);
      cursor: pointer;
      transition: background var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    `,
    default: `
      padding: 6px 16px;
      background: var(--bg-button);
      border: 1px solid var(--button-secondary-border);
      border-radius: var(--radius-md);
      color: var(--fg-primary);
      cursor: pointer;
      transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
    `,
    danger: `
      padding: 6px 16px;
      background: var(--bg-button-danger);
      border: none;
      border-radius: var(--radius-md);
      color: var(--fg-on-accent);
      cursor: pointer;
      transition: background var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    `,
    success: `
      padding: 6px 16px;
      background: var(--bg-button-success);
      border: none;
      border-radius: var(--radius-md);
      color: var(--fg-on-success);
      cursor: pointer;
      transition: background var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    `,
  };

  // Button hover/active style mapping
  const buttonHoverStyles = {
    primary: `
      background: var(--bg-button-primary-hover);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px var(--accent-glow);
    `,
    default: `
      background: var(--bg-button-hover);
      border-color: var(--accent-glow);
      color: var(--fg-primary);
      transform: translateY(-1px);
    `,
    danger: `
      background: var(--bg-button-danger-hover);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px var(--danger-glow);
    `,
    success: `
      background: var(--bg-button-success-hover);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px var(--success-glow);
    `,
  };

  // Create buttons
  buttons.forEach((btnConfig) => {
    const btn = document.createElement('button');
    btn.textContent = btnConfig.text;
    btn.style.cssText = buttonStyles[btnConfig.type] || buttonStyles.default;

    btn.addEventListener('mouseenter', () => {
      btn.style.cssText = (buttonStyles[btnConfig.type] || buttonStyles.default) + (buttonHoverStyles[btnConfig.type] || buttonHoverStyles.default);
    });

    btn.addEventListener('mouseleave', () => {
      btn.style.cssText = buttonStyles[btnConfig.type] || buttonStyles.default;
    });

    btn.addEventListener('mousedown', () => {
      btn.style.transform = 'translateY(0) scale(0.97)';
    });

    btn.addEventListener('click', () => {
      if (btnConfig.onClick) {
        btnConfig.onClick();
      }
      close();
    });

    btnContainer.appendChild(btn);
  });

  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Close method
  const close = () => {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  // Click overlay to close
  if (closeOnClickOutside) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        close();
      }
    });
  }

  return { close, overlay, dialog };
}

export function showPromptDialog(title, defaultValue, onConfirm) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.style.cssText = `
    width: 100%;
    padding: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--fg-primary);
    margin-bottom: 12px;
    box-sizing: border-box;
    font-size: var(--font-md);
    transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
  `;

  input.addEventListener('focus', () => {
    input.style.borderColor = 'var(--accent)';
    input.style.boxShadow = '0 0 0 3px var(--accent-soft)';
  });

  input.addEventListener('blur', () => {
    input.style.borderColor = 'var(--border-strong)';
    input.style.boxShadow = 'none';
  });

  const contentWrapper = document.createElement('div');
  contentWrapper.appendChild(input);

  const dialog = createDialog({
    title,
    contentElement: contentWrapper,
    buttons: [
      {
        text: t('common.cancel'),
        type: 'default',
        onClick: () => {
          if (onConfirm) onConfirm(null);
        },
      },
      {
        text: t('common.confirm'),
        type: 'primary',
        onClick: () => {
          if (onConfirm) onConfirm(input.value);
        },
      },
    ],
  });

  // Add keyboard events
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (onConfirm) onConfirm(input.value);
      dialog.close();
    }
    if (e.key === 'Escape') {
      if (onConfirm) onConfirm(null);
      dialog.close();
    }
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export function showSingerValidationReport(validation) {
  const contentWrapper = document.createElement('div');

  if (validation.errors.length > 0) {
    const errSection = document.createElement('div');
    errSection.style.cssText = 'margin-bottom: 10px;';
    const errTitle = document.createElement('div');
    errTitle.style.cssText = 'color: var(--danger); font-weight: 600; margin-bottom: 4px; font-size: 12px;';
    errTitle.textContent = t('common.errors');
    errSection.appendChild(errTitle);
    validation.errors.forEach((msg) => {
      const item = document.createElement('div');
      item.style.cssText = 'color: var(--danger); font-size: 11px; padding-left: 8px; margin-bottom: 2px;';
      item.textContent = `• ${msg}`;
      errSection.appendChild(item);
    });
    contentWrapper.appendChild(errSection);
  }

  if (validation.warnings.length > 0) {
    const warnSection = document.createElement('div');
    warnSection.style.cssText = 'margin-bottom: 10px;';
    const warnTitle = document.createElement('div');
    warnTitle.style.cssText = 'color: var(--warning); font-weight: 600; margin-bottom: 4px; font-size: 12px;';
    warnTitle.textContent = t('common.warnings');
    warnSection.appendChild(warnTitle);
    validation.warnings.forEach((msg) => {
      const item = document.createElement('div');
      item.style.cssText = 'color: var(--warning); font-size: 11px; padding-left: 8px; margin-bottom: 2px;';
      item.textContent = `• ${msg}`;
      warnSection.appendChild(item);
    });
    contentWrapper.appendChild(warnSection);
  }

  return new Promise((resolve) => {
    createDialog({
      title: validation.valid ? t('main.singerLoadWarnings') : t('main.singerFileFormatError'),
      contentElement: contentWrapper,
      buttons: [
        {
          text: t('common.confirm'),
          type: validation.valid ? 'primary' : 'danger',
          onClick: () => resolve(),
        },
      ],
      styles: {
        titleColor: validation.valid ? 'var(--warning)' : 'var(--danger)',
        dialogBorder: validation.valid ? 'var(--warning)' : 'var(--danger)',
      },
    });
  });
}

export function showAudioToMidiDialog() {
  return new Promise((resolve) => {
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

    const extractPitchBtn = document.createElement('button');
    extractPitchBtn.style.cssText = `
      padding: 12px 16px;
      background: var(--bg-button-primary);
      border: none;
      border-radius: var(--radius-md);
      color: var(--fg-on-accent);
      cursor: pointer;
      font-size: 14px;
      text-align: left;
      transition: background var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    `;
    const extractPitchLabel = document.createElement('div');
    extractPitchLabel.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    extractPitchLabel.textContent = t('main.audioToMidiExtractPitch');
    const extractPitchDesc = document.createElement('div');
    extractPitchDesc.style.cssText = 'font-size: 12px; opacity: 0.8;';
    extractPitchDesc.textContent = t('main.audioToMidiExtractPitchDesc');
    extractPitchBtn.appendChild(extractPitchLabel);
    extractPitchBtn.appendChild(extractPitchDesc);

    const onlyMidiBtn = document.createElement('button');
    onlyMidiBtn.style.cssText = `
      padding: 12px 16px;
      background: var(--bg-button-success);
      border: none;
      border-radius: var(--radius-md);
      color: var(--fg-on-success);
      cursor: pointer;
      font-size: 14px;
      text-align: left;
      transition: background var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    `;
    const onlyMidiLabel = document.createElement('div');
    onlyMidiLabel.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    onlyMidiLabel.textContent = t('main.audioToMidiOnly');
    const onlyMidiDesc = document.createElement('div');
    onlyMidiDesc.style.cssText = 'font-size: 12px; opacity: 0.8;';
    onlyMidiDesc.textContent = t('main.audioToMidiOnlyDesc');
    onlyMidiBtn.appendChild(onlyMidiLabel);
    onlyMidiBtn.appendChild(onlyMidiDesc);

    btnContainer.appendChild(extractPitchBtn);
    btnContainer.appendChild(onlyMidiBtn);

    extractPitchBtn.addEventListener('mouseenter', () => {
      extractPitchBtn.style.background = 'var(--bg-button-primary-hover)';
      extractPitchBtn.style.transform = 'translateY(-1px)';
      extractPitchBtn.style.boxShadow = '0 2px 12px var(--accent-glow)';
    });
    extractPitchBtn.addEventListener('mouseleave', () => {
      extractPitchBtn.style.background = 'var(--bg-button-primary)';
      extractPitchBtn.style.transform = '';
      extractPitchBtn.style.boxShadow = '';
    });
    extractPitchBtn.addEventListener('mousedown', () => {
      extractPitchBtn.style.transform = 'translateY(0) scale(0.97)';
    });

    onlyMidiBtn.addEventListener('mouseenter', () => {
      onlyMidiBtn.style.background = 'var(--bg-button-success-hover)';
      onlyMidiBtn.style.transform = 'translateY(-1px)';
      onlyMidiBtn.style.boxShadow = '0 2px 12px var(--success-glow)';
    });
    onlyMidiBtn.addEventListener('mouseleave', () => {
      onlyMidiBtn.style.background = 'var(--bg-button-success)';
      onlyMidiBtn.style.transform = '';
      onlyMidiBtn.style.boxShadow = '';
    });
    onlyMidiBtn.addEventListener('mousedown', () => {
      onlyMidiBtn.style.transform = 'translateY(0) scale(0.97)';
    });

    const dialog = createDialog({
      title: t('main.audioToMidiTitle'),
      contentElement: btnContainer,
      buttons: [
        {
          text: t('common.cancel'),
          type: 'default',
          onClick: () => resolve(null),
        },
      ],
      styles: {
        titleFontSize: '16px',
        buttonMarginTop: '0',
      },
    });

    extractPitchBtn.addEventListener('click', () => {
      dialog.close();
      resolve('withPitch');
    });
    onlyMidiBtn.addEventListener('click', () => {
      dialog.close();
      resolve('midiOnly');
    });
  });
}

export function showLoadingOverlay(message) {
  const overlay = document.createElement('div');
  overlay.id = 'audio-to-midi-loading';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--overlay-scrim);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 10001;
    color: var(--fg-primary);
  `;

  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 40px;
    height: 40px;
    border: 3px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 16px;
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;

  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'font-size: 14px; color: var(--fg-secondary);';
  msgEl.textContent = message;

  overlay.appendChild(style);
  overlay.appendChild(spinner);
  overlay.appendChild(msgEl);
  document.body.appendChild(overlay);

  return overlay;
}

export function updateLoadingMessage(overlay, message) {
  const msgEl = overlay.querySelector('div:last-child');
  if (msgEl) msgEl.textContent = message;
}

export function hideLoadingOverlay(overlay) {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}
