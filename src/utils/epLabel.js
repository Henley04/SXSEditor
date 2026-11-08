/**
 * 推理执行提供器（EP）在资源管理器里的显示标签与徽标样式。
 *
 * 为什么单独成模块：resourceManager.js 顶层就抓 DOM，还引 CSS 与 i18n，
 * 在单元测试里 require 它会连带初始化整个页面。EP 命名是纯字符串映射，
 * 拆出来才能直接断言，也让「Windows ML 供应商 EP 不要显示成一串大写」这条
 * 规则有回归保护 —— 这正是后端在 DML 与 Windows ML 之间切换后，界面需要
 * 如实反映当前 EP 的那一环。
 */

/** @returns {string} 模型卡片上显示的 EP 名称 */
export function getEPLabel(ep) {
    if (!ep) return '';
    const raw = String(ep);
    // WinML 会话的 EP 形如 `winml:NvTensorRtRtx`。直接 toUpperCase 会显示成
    // 一串难读的大写，且看不出它属于 Windows ML；这里显式拆出供应商 EP 名。
    if (raw.toLowerCase().startsWith('winml:')) {
        const vendor = raw.slice(6).trim();
        return vendor ? `WinML / ${vendor}` : 'WinML';
    }
    const map = {
        dml: 'DML',
        cpu: 'CPU',
        tfjs: 'TFJS',
    };
    return map[raw.toLowerCase()] || raw.toUpperCase();
}

/** @returns {string} 徽标 class 后缀（对应 resourceManager.css 的 .ep-badge.*） */
export function getEPBadgeClass(ep) {
    if (!ep) return 'none';
    const raw = String(ep);
    if (raw.toLowerCase().startsWith('winml:')) return 'winml';
    const map = {
        dml: 'dml',
        cpu: 'cpu',
        tfjs: 'tfjs',
    };
    return map[raw.toLowerCase()] || 'none';
}
