/**
 * 「帮助 → MCP 连接」的运行期路径探测（主进程）。
 *
 * MCP 客户端是独立进程，配置里必须写磁盘绝对路径，而源码树与安装包的文件布局
 * 完全不同：
 *   · 源码树：<repo>/mcp/sxseditor-mcp.js（由 npm start 的 prestart 生成）
 *   · 安装包：<resources>/mcp/sxseditor-mcp.js（forge extraResource 复制）
 *
 * 这里只做探测，把「实际存在的绝对路径」交给渲染层的 prompt 生成器；绝不把
 * 用户目录或版本信息硬编码进字典。探测方式与 src/main/docs.js 的 getDocsRoot
 * 一致（resourcesPath 优先，再回落 app.getAppPath()）。
 */
const fs = require('node:fs');
const path = require('node:path');

const SERVER_FILE = 'sxseditor-mcp.js';
const SKILL_REL = path.join('skills', 'mcp-driver', 'SKILL.md');

/**
 * 纯函数：按候选顺序找第一个真实存在 MCP 服务器文件的目录。
 * 抽出来是为了能脱离 Electron 单测。
 * @param {Array<{dir: string, layout: 'bundled'|'source'}>} candidates
 */
function resolveMcpLayout(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    if (!candidate || !candidate.dir) continue;
    const serverPath = path.join(candidate.dir, SERVER_FILE);
    if (!fs.existsSync(serverPath)) continue;
    const skillPath = path.join(candidate.dir, SKILL_REL);
    return {
      available: true,
      layout: candidate.layout,
      root: candidate.dir,
      serverPath,
      skillDir: path.join(candidate.dir, 'skills'),
      skillPath,
      skillExists: fs.existsSync(skillPath),
    };
  }
  // 一个候选都没命中也要给出可用的默认路径：对话框据此提示用户重建随包目录，
  // 而不是弹一个空白面板。
  const fallback = list.find((c) => c && c.dir) || { dir: path.join(process.cwd(), 'mcp'), layout: 'bundled' };
  const skillPath = path.join(fallback.dir, SKILL_REL);
  return {
    available: false,
    layout: fallback.layout,
    root: fallback.dir,
    serverPath: path.join(fallback.dir, SERVER_FILE),
    skillDir: path.join(fallback.dir, 'skills'),
    skillPath,
    skillExists: false,
  };
}

/** 供「MCP 连接」对话框调用：返回探测结果与发现文件路径。 */
function getMcpSetupInfo() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push({ dir: path.join(process.resourcesPath, 'mcp'), layout: 'bundled' });
  }
  try {
    const appPath = require('electron').app.getAppPath();
    if (appPath) {
      candidates.push({ dir: path.join(appPath, 'mcp'), layout: 'source' });
      candidates.push({ dir: path.join(path.dirname(appPath), 'mcp'), layout: 'source' });
    }
  } catch (_) { /* app 尚未就绪，忽略 */ }

  const layout = resolveMcpLayout(candidates);
  let endpointPath = '';
  try {
    endpointPath = path.join(require('electron').app.getPath('userData'), 'mcp-endpoint.json');
  } catch (_) { /* 拿不到 userData 时留空，prompt 里仍会说明发现文件的作用 */ }

  return { ...layout, endpointPath, nodeCommand: 'node' };
}

module.exports = { resolveMcpLayout, getMcpSetupInfo, SERVER_FILE, SKILL_REL };
