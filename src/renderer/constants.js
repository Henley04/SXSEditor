export const SAMPLE_RATE = 24000;
export const SVS_HOP_SIZE = 480;
export const SXSSINGER_CURRENT_VERSION = '1.0.0';

export const FRAGMENT_HEIGHT = 60;
export const SINGER_ROW_HEIGHT = 80;
export const HEADER_HEIGHT = 24;
export const FRAGMENT_BASE_BEAT_WIDTH = 40;
export const REF_BPM = 120;

/**
 * 渲染层内部事件：一份工程文档刚刚被装载/新建到编辑器里。
 * detail = { filePath }（绝对路径；未落盘的工程没有值）。
 *
 * 谁发：projectManager（applyProjectDocument / createNewProjectFile）。
 * 谁听：欢迎页（收起 + 刷新列表）、最近工程记录（记一笔）。
 * 走事件而不是互相 import，是为了不把 projectManager 和这两个模块缠成环。
 */
export const PROJECT_APPLIED_EVENT = 'sxse:project-applied';
