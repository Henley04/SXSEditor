function formatBytes(bytes) {
  if (bytes < 0) return '-' + formatBytes(-bytes);
  if (bytes === 0 || bytes == null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // Use Math.log2 for exact precision at power-of-2 boundaries —
  // Math.log(bytes)/Math.log(1024) suffers from floating-point error
  // (e.g. log(1048576)/log(1024) = 1.9999... which floors to 1, making
  // 1 MB display as "1024 KB").
  const i = Math.min(Math.floor(Math.log2(bytes) / Math.log2(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  if (i >= 2) {
    return val.toFixed(i >= 3 ? 2 : 1) + ' ' + units[i];
  }
  return Math.round(val) + ' ' + units[i];
}

module.exports = { formatBytes };
