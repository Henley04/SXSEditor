let _cache = null;
let _cacheTime = 0;
const TTL = 5000;

export async function getGraphicsCached() {
  const now = Date.now();
  if (_cache && now - _cacheTime < TTL) return _cache;
  const si = require('systeminformation');
  _cache = await si.graphics();
  _cacheTime = now;
  return _cache;
}
