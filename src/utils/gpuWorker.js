const { parentPort } = require('node:worker_threads');

async function queryGPU() {
  const si = require('systeminformation');
  const graphics = await si.graphics();
  const controllers = graphics.controllers || [];
  return controllers.map((c, idx) => ({
    adapterIndex: idx,
    model: c.model || '',
    vram: c.vram || 0,
    memoryTotal: c.memoryTotal || c.vram || 0,
    memoryUsed: c.memoryUsed || 0,
    vendor: c.vendor || '',
    isDiscrete: (c.memoryTotal || c.vram || 0) >= 512,
  }));
}

queryGPU().then(result => {
  parentPort.postMessage({ success: true, data: result });
}).catch(err => {
  parentPort.postMessage({ success: false, error: err.message });
});
