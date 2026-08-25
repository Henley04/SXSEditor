const path = require('node:path');
const ort = require('onnxruntime-node');
const mods = ['diff_step_dml', 'note_text_encoder', 'f0_encoder', 'cond_emb', 'preflow', 'vocoder_dml'];
async function inspect(file) {
    const s = await ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
    const ins = s.inputMetadata || [];
    const out = s.outputMetadata || [];
    console.log('=== ' + path.basename(file) + ' ===');
    for (const m of ins) {
        console.log('  IN ', m.name, 'type=', (m.type||'').split('(')[0], 'dims=', JSON.stringify(m.shape || m.dims));
    }
    for (const m of out) {
        console.log('  OUT', m.name, 'type=', (m.type||'').split('(')[0], 'dims=', JSON.stringify(m.shape || m.dims));
    }
    s.release?.();
}
(async () => {
    const base = process.argv[2] || 'onnx_models/int8';
    for (const b of ['note_text_encoder', 'f0_encoder', 'preflow', 'cond_emb', 'diff_step_dml', 'vocoder_dml']) {
        try { await inspect(path.join(base, b + '.onnx')); }
        catch (e) { console.log('ERR', b, e.message); }
    }
})().catch(e => { console.error(e); process.exit(1); });