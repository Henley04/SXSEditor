const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { getMainWindow } = require('./windowManager');
const pending = new Map();
const AUTOMATION_TIMEOUT_MS = 600000; // 长任务（合成/导出/提取）可能远超 120s
const MIDI_MAX_BYTES = 64 * 1024 * 1024; // MIDI 是文本二进制协议，64 MiB 上限绰绰有余
let server, endpointFile, sequence = 0;
function registerMcpReplyIpc(ipcMain) { ipcMain.on('mcp:automation-response', (_e, m) => { const p = pending.get(m?.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'Automation failed')); }); }
function callRenderer(method, params = {}) { const win = getMainWindow(); if (!win || win.isDestroyed()) return Promise.reject(new Error('SXSEditor main window is unavailable')); const id = ++sequence; return new Promise((resolve,reject) => { const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Automation timeout: ${method}`));},AUTOMATION_TIMEOUT_MS); pending.set(id,{resolve,reject,timer}); win.webContents.send('mcp:automation-request',{id,method,params}); }); }
async function dispatch(method, params) {
  if (method === 'midi.importFile') {
    // 与渲染端 authorize() 语义对齐：拒绝系统目录（C:\Windows 等），
    // 允许用户目录，防止 token 泄漏场景下经由 MCP 读取任意系统文件。
    if (!params.path) throw new Error('path is required');
    const { isSystemPath } = require('./security');
    if (isSystemPath(params.path)) throw new Error('System path not allowed');
    const st = await fs.promises.stat(params.path).catch(() => null);
    if (!st || !st.isFile()) throw new Error('File not found');
    if (st.size > MIDI_MAX_BYTES) throw new Error(`MIDI file exceeds ${MIDI_MAX_BYTES / 1024 / 1024} MiB`);
    const b = await fs.promises.readFile(params.path);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const { parseMidiFile, parseMidiFileMultiTrack, parseMidiProjectInfo } = require('../inference/midiParser');
    const tracks = params.multiTrack === false
      ? [{ name: params.name || 'MIDI', notes: parseMidiFile(ab) }]
      : parseMidiFileMultiTrack(ab);
    let projectInfo = null;
    try { projectInfo = parseMidiProjectInfo(ab); } catch (_) {}
    return callRenderer('midi.importParsed', { ...params, tracks, projectInfo });
  }
  return callRenderer(method, params);
}
function send(res,status,value){const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'content-type':'application/json','content-length':body.length});res.end(body);}
function read(req){return new Promise((resolve,reject)=>{let n=0,a=[];req.on('data',c=>{n+=c.length;if(n>33554432){reject(new Error('Request exceeds 32 MiB'));req.destroy();}else a.push(c);});req.on('end',()=>{try{resolve(a.length?JSON.parse(Buffer.concat(a)):{});}catch(e){reject(new Error(`Invalid JSON: ${e.message}`));}});req.on('error',reject);});}
async function startMcpBridge(){if(server)return;const token=crypto.randomBytes(32).toString('hex');server=http.createServer(async(req,res)=>{if(!['127.0.0.1','::1'].includes(req.socket.remoteAddress))return send(res,403,{error:'Loopback only'});if(req.headers.authorization!==`Bearer ${token}`)return send(res,401,{error:'Unauthorized'});if(req.method==='GET'&&req.url==='/health')return send(res,200,{ok:true,version:app.getVersion()});if(req.method!=='POST'||req.url!=='/automation')return send(res,404,{error:'Not found'});try{const b=await read(req);send(res,200,{ok:true,result:await dispatch(b.method,b.params||{})});}catch(e){send(res,400,{ok:false,error:e.message});}});await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});endpointFile=path.join(app.getPath('userData'),'mcp-endpoint.json');const tmp=`${endpointFile}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify({port:server.address().port,token,pid:process.pid,version:app.getVersion()}),{mode:0o600});fs.renameSync(tmp,endpointFile);console.log(`[MCP] bridge listening on 127.0.0.1:${server.address().port}`);}
function stopMcpBridge(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP stopped'));}pending.clear();server?.close();server=null;try{if(endpointFile)fs.unlinkSync(endpointFile);}catch(_){}}
module.exports={registerMcpReplyIpc,startMcpBridge,stopMcpBridge};
