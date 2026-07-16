function formatBytes(bytes) {
  if (bytes < 0) return '-' + formatBytes(-bytes);
  if (bytes === 0 || bytes == null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / Math.log2(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  if (i >= 2) {
    return val.toFixed(i >= 3 ? 2 : 0) + ' ' + units[i];
  }
  return Math.round(val) + ' ' + units[i];
}

module.exports = { formatBytes };
