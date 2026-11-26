/**
 * 插件快捷键的渲染层派发。
 *
 * 这里**不做冲突判定**：投影里的 `keybindings[].status` 已经是主进程仲裁过的结果，
 * 渲染层只认 `status === 'active'`。两边各判一次必然会出现"界面说没绑、实际按下去
 * 却触发了"的偏差，而这类偏差只能靠手测发现。
 */

import { chordFromEvent } from '../../shared/pluginKeys.js';
import { isMacPlatform } from '../platformInfo.js';
import { evalWhen, reportCommandFailure } from './pluginText.js';

function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function installPluginKeybindings(options) {
  const { getPlugins, getContext, runCommand } = options;
  const isMac = isMacPlatform();

  const onKeyDown = (event) => {
    // 输入框里不拦截：插件把 `Mod+Enter` 绑成"执行"时，用户在文本框里按
    // 应该是插件的命令生效还是换行？让宿主让路更可预期 —— 先打字，离开输入框再说。
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    const chord = chordFromEvent(event, isMac);
    if (!chord) return;

    const ctx = typeof getContext === 'function' ? getContext() : {};
    let hit = null;
    for (const plugin of getPlugins() || []) {
      for (const binding of plugin.keybindings || []) {
        if (binding.status !== 'active') continue;
        if (binding.chord !== chord) continue;
        if (!evalWhen(binding.when, ctx)) continue;
        hit = binding;
        break;
      }
      if (hit) break;
    }
    if (!hit) return;

    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(runCommand(hit.command)).then((result) => {
      if (result && result.ok === false) reportCommandFailure(result);
    }).catch((err) => {
      reportCommandFailure({ error: { message: (err && err.message) || String(err) } });
    });
  };

  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}
