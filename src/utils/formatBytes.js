function formatBytes(bytes) {
  if (bytes < 0) return '-' + formatBytes(-bytes);
  if (bytes === 0 || bytes == null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  if (i >= 2) {
    return val.toFixed(i >= 3 ? 2 : 0) + ' ' + units[i];
  }
  return Math.round(val) + ' ' + units[i];
}

module.exports = { formatBytes };
