const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// The isolated diagnostic process does not pass through svsWorker.js, which is
// where the application normally patches onnxruntime-node's float16 mapping.
// Load the patch before onnxruntime-node and before creating any Tensor. Without
// this, Uint16Array FP16 buffers are exposed as empty buffers to ORT ("expected
// N bytes, got 0") and the native bridge receives zero-valued inputs.
require('../pipeline/float16Patch');
const ort = require('onnxruntime-node');
const { float32ToF16Buffer } = require('../pipeline/utils');
const provider = require('./winmlProvider');
const bridge = require('./ortBridge');

const MODEL_SPECS = [
  { model: 'preflow', file: 'preflow.onnx', output: 'processed_features', seqs: [32, 512, 1435] },
  { model: 'diffStep', file: 'diff_step_dml.onnx', output: 'flow_pred', seqs: [32, 512, 1950] },
];
function makeData(n, salt) { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=Math.sin((i+salt)*.017)*.7+Math.cos((i+salt)*.031)*.3; return a; }
function f16Tensor(a,dims){
  const data = float32ToF16Buffer(a);
  if (!(data instanceof Uint16Array) || data.length !== a.length || data.byteLength !== a.length * 2) {
    throw new Error(`FP16 conversion failed: values=${a.length} words=${data?.length ?? -1} bytes=${data?.byteLength ?? -1}`);
  }
  const tensor = new ort.Tensor('float16', data, dims);
  if (!tensor.data || tensor.data.length !== a.length || tensor.data.byteLength !== a.length * 2) {
    throw new Error(`FP16 tensor backing store invalid: values=${a.length} words=${tensor.data?.length ?? -1} bytes=${tensor.data?.byteLength ?? -1}`);
  }
  return tensor;
}
function feedsFor(model,seq){
  if(model==='preflow') return {features:f16Tensor(makeData(seq*512,11),[1,seq,512])};
  return {xt_input:f16Tensor(makeData(seq*128,17),[1,seq,128]),t:f16Tensor(new Float32Array([.5]),[1]),cond:f16Tensor(makeData(seq*1024,29),[1,seq,1024]),xt_mask:f16Tensor(new Float32Array(seq).fill(1),[1,seq])};
}
function decode(t){ if(!t?.data?.length)return null; const a=new Float32Array(t.data.length); for(let i=0;i<a.length;i++)a[i]=t.type==='float16'?bridge.__test._fp16ToNumber(t.data[i]):Number(t.data[i]); return a; }
function stats(t){ const a=decode(t); if(!a)return {n:0,error:'empty-output'}; let min=Infinity,max=-Infinity,sum=0,sum2=0,zero=0,nan=0,inf=0; for(const v of a){if(Number.isNaN(v)){nan++;continue}if(!Number.isFinite(v)){inf++;continue}if(v===0)zero++;min=Math.min(min,v);max=Math.max(max,v);sum+=v;sum2+=v*v} const finite=a.length-nan-inf; return {n:a.length,min,max,mean:finite?sum/finite:null,rms:finite?Math.sqrt(sum2/finite):null,zero,nan,inf}; }
function classify(s){if(!s||!s.n)return'FAIL_EMPTY';if(s.nan||s.inf)return'FAIL_NON_FINITE';if(s.zero===s.n||!s.rms||s.rms<1e-8)return'FAIL_ALL_ZERO';return'PASS'}
function compare(aTensor,bTensor){const a=decode(aTensor),b=decode(bTensor);if(!a||!b||a.length!==b.length)return null;let dot=0,aa=0,bb=0,maxAbs=0,mae=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];const d=Math.abs(a[i]-b[i]);mae+=d;maxAbs=Math.max(maxAbs,d)}return{cosine:aa&&bb?dot/Math.sqrt(aa*bb):null,maxAbs,mae:mae/a.length};}
function sha256(file){const h=crypto.createHash('sha256');h.update(fs.readFileSync(file));return h.digest('hex')}
async function runOrt(modelPath,executionProviders,feeds){const s=await ort.InferenceSession.create(modelPath,{executionProviders,graphOptimizationLevel:'all',executionMode:'sequential',enableMemPattern:false});try{return await s.run(feeds)}finally{try{await s.release()}catch(_){}}}
function artifacts(dir){return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&!/^report\./.test(e.name)).map(e=>{const p=path.join(dir,e.name),st=fs.statSync(p);return{name:e.name,bytes:st.size,sha256:sha256(p)}})}
function reportText(r) {
  // Checkpoints are intentionally written before Identity/model probes start.
  // Every field below must therefore tolerate a partially populated report.
  const system = r?.system || {};
  const models = Array.isArray(r?.models) ? r.models : [];
  const identity = r?.identity || null;
  const artifactsList = Array.isArray(r?.artifacts) ? r.artifacts : [];
  const out = [
    `TensorRT-RTX diagnostic ${r?.createdAt || new Date().toISOString()}`,
    `host=${system.host || 'unknown'} arch=${system.arch || process.arch}`,
    `gpu=${system.gpu || 'unknown'}`,
    `dumpDir=${r?.dumpDir || 'unknown'}`,
    '',
  ];
  for (const m of models) {
    out.push(`[${m?.model || 'unknown'}] sha256=${m?.sha256 || '-'}`);
    for (const x of (Array.isArray(m?.runs) ? m.runs : [])) {
      out.push(` seq=${x?.seq ?? '-'} classification=${x?.classification || 'RUNNING'} cpu=${x?.cpu?.result || '-'} dml=${x?.dml?.result || '-'} trt=${x?.trt?.result || '-'} trtVsDml=${JSON.stringify(x?.trtVsDml || null)} trtError=${x?.trt?.error || '-'}`);
    }
    out.push('');
  }
  if (identity) {
    out.push(`[identity] classification=${identity.classification || 'RUNNING'} input=${JSON.stringify(identity.inputStats || {})} stats=${JSON.stringify(identity.trt?.stats || {})} compare=${JSON.stringify(identity.trtVsInput || null)} error=${identity.trt?.error || '-'}`);
  } else {
    out.push('[identity] classification=NOT_STARTED');
  }
  out.push(`artifacts=${artifactsList.length}`);
  out.push(`summary=${r?.summary || 'RUNNING'}`);
  return out.join('\n');
}
function persistReport(report, partial = false) {
  const suffix = partial ? '.partial' : '';
  const jsonPath = path.join(report.dumpDir, `report${suffix}.json`);
  const textPath = path.join(report.dumpDir, `report${suffix}.txt`);
  const jsonTmp = `${jsonPath}.tmp`;
  const textTmp = `${textPath}.tmp`;
  // Atomic replacement prevents the parent process from reading half-written
  // JSON if the vendor EP terminates the child during a checkpoint.
  fs.writeFileSync(jsonTmp, JSON.stringify(report, null, 2));
  fs.renameSync(jsonTmp, jsonPath);
  fs.writeFileSync(textTmp, reportText(report));
  fs.renameSync(textTmp, textPath);
}

// Minimal FP16 Identity ONNX, generated without adding a protobuf dependency.
function identityModel(){
  const v=n=>{const a=[];while(n>127){a.push((n&127)|128);n>>>=7}a.push(n);return Buffer.from(a)};
  const field=(n,w,b)=>Buffer.concat([v((n<<3)|w),w===2?Buffer.concat([v(b.length),b]):b]);
  const str=(n,s)=>field(n,2,Buffer.from(s));
  const i64=(n,x)=>field(n,0,v(x));
  const msg=(n,...x)=>field(n,2,Buffer.concat(x));
  // TypeProto.tensor_type is field 1. TensorShapeProto is field 2 inside
  // TypeProto_Tensor. The previous double msg(1, ...) wrapped tensor_type in
  // another field 1, so ORT parsed input/output as scalar Half[] instead of
  // Half[4]. That made the probe return one element and falsely diagnosed the
  // host/EP input path.
  const dim=i64(1,4);
  // TensorShapeProto.dim is repeated field 1. The previous encoder used field
  // 2 here, which is not a valid dimension field. ORT therefore discarded the
  // shape and exposed the probe as scalar float16[] even though the feed was
  // float16[4].
  const tensorShape=msg(1,dim);
  const tensorType=Buffer.concat([i64(1,10),tensorShape]);
  const valueInfo=name=>Buffer.concat([str(1,name),msg(2,msg(1,tensorType))]);
  const node=Buffer.concat([str(1,'input'),str(2,'output'),str(3,'IdentityProbe'),str(4,'Identity')]);
  const graph=Buffer.concat([msg(1,node),str(2,'SXSIdentityProbe'),msg(11,valueInfo('input')),msg(12,valueInfo('output'))]);
  return Buffer.concat([i64(1,9),str(2,'SXSEditor'),str(3,'1'),msg(7,graph),msg(8,str(1,''),i64(2,13))]);
}
async function identityProbe(dir){const file=path.join(dir,'identity_fp16.onnx');fs.writeFileSync(file,identityModel());const input=f16Tensor(new Float32Array([.25,-.5,1,2]),[4]);const inputStats=stats(input);let session;try{const c=await provider.tryCreateWinMLSession(file,false);session=c?.session;if(!session||!String(c?.ep).includes('NvTensorRTRTX'))throw new Error(`TRT not selected: ${c?.ep||'none'}`);const meta=session.inputMetadata?.[0];const metaShape=meta?.shape||meta?.dimensions||meta?.dims;if(!meta||!Array.isArray(metaShape)||metaShape.length!==1||Number(metaShape[0])!==4)throw new Error(`Identity model shape invalid: ${JSON.stringify(metaShape||null)}; expected [4]`);const o=await session.run({input});const tensor=o.output||Object.values(o)[0],s=stats(tensor),cmp=compare(input,tensor);return{classification:classify(s)==='PASS'&&cmp?.maxAbs===0?'PASS':'FAIL_IDENTITY_MISMATCH',inputStats,trt:{result:classify(s),stats:s},trtVsInput:cmp}}catch(e){return{classification:'FAIL_EXECUTION',inputStats,trt:{result:'FAIL_EXECUTION',error:String(e.message||e).split('\n')[0]}}}finally{try{session?.release()}catch(_){}}}
async function runTrtDiagnostic({modelDir,precision='fp16',dmlDeviceId=0,gpu=null,dumpDir:requestedDumpDir=null}){const actual=precision==='fp32'?modelDir:path.join(modelDir,precision),dumpDir=requestedDumpDir||path.join(modelDir,'diagnostics',`trtrtx-${new Date().toISOString().replace(/[:.]/g,'-')}`);fs.mkdirSync(dumpDir,{recursive:true});const oldCwd=process.cwd(),oldTrace=process.env.SXS_WINML_TRACE,oldNo=process.env.SXS_TRTRTX_NO_PROFILE;process.env.SXS_WINML_TRACE='1';process.env.SXS_TRTRTX_NO_PROFILE='1';process.chdir(dumpDir);const report={createdAt:new Date().toISOString(),dumpDir,modelDir:actual,system:{host:os.hostname(),arch:process.arch,platform:process.platform,gpu},models:[],identity:null,artifacts:[],summary:'RUNNING'};persistReport(report,true);try{report.identity=await identityProbe(dumpDir);report.artifacts=artifacts(dumpDir);persistReport(report,true);if(!report.identity||report.identity.classification!=='PASS'){report.summary=`INPUT_PATH_FAILURE identity=${report.identity?.classification || 'NO_RESULT'}`;persistReport(report);return report}persistReport(report,true);for(const spec of MODEL_SPECS){const file=path.join(actual,spec.file),item={model:spec.model,path:file,sha256:fs.existsSync(file)?sha256(file):null,runs:[]};report.models.push(item);if(!fs.existsSync(file)){item.runs.push({classification:'FAIL_MODEL_MISSING'});continue}let trt;try{const c=await provider.tryCreateWinMLSession(file,false);trt=c?.session;if(!trt||!String(c?.ep).includes('NvTensorRTRTX'))throw new Error(`TRT not selected: ${c?.ep||'none'}`);for(const seq of spec.seqs){const row={seq};for(const [name,eps] of [['cpu',['cpu']],['dml',[{name:'dml',deviceId:dmlDeviceId},'cpu']]]){const start=performance.now();try{const o=await runOrt(file,eps,feedsFor(spec.model,seq)),tensor=o[spec.output]||Object.values(o)[0];row[name]={result:classify(stats(tensor)),ms:+(performance.now()-start).toFixed(1),stats:stats(tensor),_tensor:tensor}}catch(e){row[name]={result:'FAIL_EXECUTION',error:String(e.message||e).split('\n')[0]}}}const start=performance.now();try{const o=await trt.run(feedsFor(spec.model,seq)),tensor=o[spec.output]||Object.values(o)[0];row.trt={result:classify(stats(tensor)),ms:+(performance.now()-start).toFixed(1),stats:stats(tensor)};row.trtVsDml=compare(row.dml?._tensor,tensor)}catch(e){row.trt={result:'FAIL_EXECUTION',error:String(e.message||e).split('\n')[0]}}delete row.cpu?._tensor;delete row.dml?._tensor;row.classification=row.cpu?.result==='PASS'&&row.dml?.result==='PASS'&&row.trt?.result!=='PASS'?'TRTRTX_ONLY_FAILURE':(row.trt?.result==='PASS'?'PASS':'INCONCLUSIVE');item.runs.push(row);report.artifacts=artifacts(dumpDir);persistReport(report,true)}}catch(e){item.runs.push({classification:'FAIL_SESSION',trt:{result:'FAIL_SESSION',error:String(e.message||e).split('\n')[0]}});persistReport(report,true)}finally{try{trt?.release()}catch(_){}}}report.artifacts=artifacts(dumpDir);const rows=report.models.flatMap(m=>m.runs),trtOnly=rows.filter(x=>x.classification==='TRTRTX_ONLY_FAILURE').length;report.summary=report.identity.classification!=='PASS'?`INPUT_PATH_FAILURE identity=${report.identity.classification}`:trtOnly?`TRTRTX_MODEL_FAILURE checks=${trtOnly}`:rows.every(x=>x.classification==='PASS')?'PASS':'INCONCLUSIVE'}finally{process.chdir(oldCwd);if(oldTrace===undefined)delete process.env.SXS_WINML_TRACE;else process.env.SXS_WINML_TRACE=oldTrace;if(oldNo===undefined)delete process.env.SXS_TRTRTX_NO_PROFILE;else process.env.SXS_TRTRTX_NO_PROFILE=oldNo}persistReport(report);return report}
module.exports={runTrtDiagnostic,__test:{makeData,stats,classify,compare,identityModel}};
