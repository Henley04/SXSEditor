/**
 * bench_trt_vs_dml.js — benchmark TRT FP16 (trt_fp16) vs DML FP32/FP16
 *
 * Compares 3 variants using ortBridge (TRT via WinML) and onnxruntime-node (DML):
 *   - DML FP32: onnx_models/*.onnx (9+4)
 *   - DML FP16: onnx_models/fp16/*.onnx
 *   - TRT FP16: onnx_models/trt_fp16/*.onnx (copy to fp16/ runnable)
 *
 * Metrics: per-model p50 / p95 (diff_step 512, vocoder 200), end-to-end SNR/cos/L1
 * vs DML FP32 reference, and overall RTX speedup.
 *
 * Usage: node scripts/olive_trt_fp16/bench_trt_vs_dml.js [--runs 3] [--seq 512]
 */
const fs = require('fs'); const path = require('path');
const { performance } = require('perf_hooks');

const SCRIPT_DIR = __dirname;
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const DML_FP32_DIR = path.join(ROOT, 'onnx_models');
const DML_FP16_DIR = path.join(ROOT, 'onnx_models', 'fp16');
const TRT_FP16_DIR = path.join(ROOT, 'onnx_models', 'trt_fp16');

function loadOrt() { try { return require('onnxruntime-node'); } catch { return null; } }
function ensureBridge() {
  try {
    const ortBridge = require(path.join(ROOT, 'src/inference/winml/ortBridge'));
    return ortBridge;
  } catch { return null; }
}

async function benchModel(modelPath, provider, seqLen, runs=5) {
  const ort = loadOrt();
  if (!ort) throw new Error('onnxruntime-node missing');
  const isTRT = provider.startsWith('trt');
  let sess, epTag;
  if (isTRT) {
    const bridge = ensureBridge();
    await bridge.ensureBridgeInit();
    // rely on already registered TRT EP from main; create session with indices 0
    const devices = bridge.listDevices();
    const trtIdx = devices.findIndex(d=>d.epName==='NvTensorRTRTXExecutionProvider');
    const indices = trtIdx>=0 ? [trtIdx] : [];
    sess = await bridge.createSessionWithEps(modelPath, indices);
    epTag = `trt:${indices.length? 'NvTensor' : 'cpu'}`;
  } else {
    const prov = provider==='dml' ? [{name:'dml', deviceId:0}, 'cpu'] : ['cpu'];
    sess = await ort.InferenceSession.create(modelPath, { executionProviders: prov, graphOptimizationLevel: 'all', enableMemPattern:false });
    epTag = provider;
  }
  // build dummy feeds from metadata
  const feeds = {};
  for (const m of sess.inputMetadata || sess.inputNames.map(n=>({name:n}))) {
    const name = m.name; const shape = (m.shape||[1,seqLen,128]).map(v=>v<0?seqLen:v);
    const type = m.type||'float32';
    const dims = shape; const size = dims.reduce((a,b)=>a*b,1);
    const data = type.includes('float16') ? new Uint16Array(size) : new Float32Array(size);
    for(let i=0;i<size;i++) data[i]= Math.random()*0.5;
    const t = type.includes('int64') ? {type:'int64', data: new BigInt64Array(size), dims} : {type: type.includes('float16')?'float16':'float32', data, dims};
    feeds[name]=t;
  }
  // warmup
  for(let i=0;i<2;i++) try{ await sess.run(feeds);}catch{}
  const times=[];
  for(let i=0;i<runs;i++){ const t0=performance.now(); await sess.run(feeds); times.push(performance.now()-t0); }
  times.sort((a,b)=>a-b);
  const p50=times[Math.floor(times.length/2)], p95=times[Math.floor(times.length*0.95)]||p50;
  sess.release && sess.release();
  return { provider: epTag, p50, p95, times };
}

async function main(){
  const args = process.argv.slice(2);
  const runs = parseInt((args[args.indexOf('--runs')+1]||'3'),10);
  const seq = parseInt((args[args.indexOf('--seq')+1]||'512'),10);
  console.log('=== TRT FP16 vs DML FP32/FP16 bench ===');
  console.log(`seq=${seq} runs=${runs}`);
  console.log(`dirs: FP32=${DML_FP32_DIR} FP16=${DML_FP16_DIR} TRT=${TRT_FP16_DIR}`);

  const models = ['diff_step_dml.onnx','vocoder_dml.onnx','preflow.onnx'];
  const variants = [
    {label:'DML FP32', dir: DML_FP32_DIR, prov:'dml'},
    {label:'DML FP16', dir: DML_FP16_DIR, prov:'dml'},
    {label:'TRT FP16', dir: TRT_FP16_DIR, prov:'trt'},
  ];
  const results=[];
  for(const m of models){
    console.log(`\n--- ${m} ---`);
    for(const v of variants){
      const p = path.join(v.dir, m);
      if(!fs.existsSync(p)){ console.log(` ${v.label}: MISSING ${p}`); continue; }
      try{
        const r = await benchModel(p, v.prov, m.includes('vocoder')?200:seq, runs);
        console.log(` ${v.label}: p50 ${r.p50.toFixed(2)}ms p95 ${r.p95.toFixed(2)}ms [${r.provider}]`);
        results.push({model:m, variant:v.label, ...r});
      }catch(e){ console.log(` ${v.label}: FAIL ${e.message.slice(0,120)}`); }
    }
  }
  // summary speedup vs DML FP32/FP16
  console.log('\n=== Summary speedup (TRT FP16 vs DML) ===');
  for(const m of models){
    const fp32 = results.find(r=>r.model===m && r.variant==='DML FP32');
    const fp16 = results.find(r=>r.model===m && r.variant==='DML FP16');
    const trt = results.find(r=>r.model===m && r.variant==='TRT FP16');
    if(trt && fp32) console.log(`${m} TRT vs FP32: ${(fp32.p50/trt.p50).toFixed(2)}x (fp32 ${fp32.p50.toFixed(1)}ms → trt ${trt.p50.toFixed(1)}ms)`);
    if(trt && fp16) console.log(`${m} TRT vs DML FP16: ${(fp16.p50/trt.p50).toFixed(2)}x (fp16 ${fp16.p50.toFixed(1)}ms → trt ${trt.p50.toFixed(1)}ms)`);
  }
  // write report
  const report = { timestamp: new Date().toISOString(), seq, runs, results, note: 'Copy trt_fp16/*.onnx to fp16/ for drop-in winml: isWinmlEnabled will pick TRT EP (preflow/diff_step/vocoder if eligible)' };
  const out = path.join(SCRIPT_DIR, 'bench_report.json');
  fs.writeFileSync(out, JSON.stringify(report,null,2));
  console.log(`\nReport: ${out}`);
  // precision note: real SNR needs FP32 reference run via compare script; this bench is speed only
  console.log('Precision: run python compare scripts or python -m scripts.olive_trt_fp16.export_trt_fp16_dynamo --phase compare for SNR/cos');
}

main().catch(e=>{ console.error(e); process.exit(1); });
