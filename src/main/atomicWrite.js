'use strict';
/**
 * 原子写盘。
 *
 * 为什么单独一个模块：写工程文件有两条路径（宿主自己的 .sxsproj、插件的
 * codec.write），但"不能留下半截文件"这件事对两者是同一个要求。复制一份实现
 * 迟早会漂移 —— 比如一边补了 fsync、另一边没有。
 *
 * 做法：写同目录临时文件 → 原文件改名为 .bak → 临时文件 rename 覆盖。
 * 崩溃发生在任何一步，磁盘上要么是旧文件、要么是 .bak，不会是半个 JSON。
 */
const fs = require('node:fs');

/**
 * @param {string} filePath 目标路径
 * @param {string|Buffer|Uint8Array} data
 */
async function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const bakPath = `${filePath}.bak`;
  try {
    await fs.promises.writeFile(tmpPath, data);
    // 首次保存时原文件不存在，ENOENT 是正常情况，不是失败
    let hadOriginal = false;
    try {
      await fs.promises.rename(filePath, bakPath);
      hadOriginal = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      if (hadOriginal) {
        try { await fs.promises.rename(bakPath, filePath); } catch (_) { /* 回滚尽力而为 */ }
      }
      throw err;
    }
  } finally {
    // rename 成功时临时文件已被消费；这里只清理失败路径上的残留
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { writeFileAtomic };
