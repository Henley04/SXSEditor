# -*- coding: utf-8 -*-
"""
Phase C: run the INT8 ONNX models (QOperator) via ONNX Runtime on the same
SoulX-Singer-Eval items, compare against the FP32 refs saved by 07_save_fp32_refs.py.

Memory-light: instead of loading the full FP32 SoulXSinger (2.8GB), we only load
the 4 tiny embedding layers (note_text/pitch/type + f0) from the state_dict via mmap.
expand_states is a static torch.gather helper. This keeps RAM usage low so the
4 ORT sessions (esp. the 424MB diffstep.onnx) fit in the 4GB cgroup.

Sub-models evaluated end-to-end:
  preflow.onnx  (W8A8)   feats [1,T,512] -> pf
  cond_emb.onnx (W8A8)   dec   [1,T,512] -> cond [1,T,1024]
  diffstep.onnx (W8A8 QDIT) x[1,T,128], t[1], cond[1,T,1024], x_mask[1,T] bool -> flow
  vocoder.onnx  (W8A32)  mel[1,128,T] -> wav
"""
import os
import sys
import gc
import json
import time

os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')

import torch
import numpy as np
import yaml
import onnxruntime as ort

from soulxsinger.models.soulxsinger import SoulXSinger  # only for expand_states static helper
from soulxsinger.utils.data_processor import DataProcessor


ONNX_DIR = '/workspace/onnx_models/int8'
EVAL_DIR = '/workspace/eval_data/gmo-svs'
REF_DIR = '/workspace/onnx_models/int8/pt/fp32_refs'
REPORT = '/workspace/onnx_models/int8/onnx_eval_report.json'
PHONESET = '/workspace/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json'
MODEL_PATH = '/workspace/models_raw/model.pt'
N_ITEMS = 6


def log(msg):
    print(msg, flush=True)


def cosine(a, b):
    a = a.reshape(-1).astype(np.float32)
    b = b.reshape(-1).astype(np.float32)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def rel_err(a, b):
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    return float(np.abs(a - b).mean() / (np.abs(b).mean() + 1e-8))


def snr_db_np(ref, q):
    noise = ref - q
    return float(10 * np.log10((ref ** 2).mean() / (noise ** 2).mean() + 1e-12))


def build_note_inputs(ann, processor):
    ph = ann['ph']
    durs = ann['ep_notedurs']
    pitches = ann['ep_pitches']
    types = ann['ep_types']
    phonemes = ['<SP>' if p in ('<SP>', '<AP>') else 'en_' + p for p in ph]
    meta = {
        'phoneme': ' '.join(phonemes),
        'duration': ' '.join(f'{d:.4f}' for d in durs),
        'note_pitch': ' '.join(str(int(p)) for p in pitches),
        'note_type': ' '.join(str(int(t)) for t in types),
    }
    return processor.process(meta, None)


def decoder_inp(f0_emb, pf, mel2note_, T_mel):
    # f0_emb: nn.Embedding; expand_states is a static torch.gather
    fe = SoulXSinger.expand_states(pf, mel2note_)
    Ln = fe.shape[1]
    if Ln > T_mel:
        fe = fe[:, :T_mel, :]
        m2n = mel2note_[:, :T_mel]
    else:
        pad = T_mel - Ln
        last = fe[:, -1:, :]
        fe = torch.cat([fe, last.repeat(1, pad, 1)], dim=1)
        m2n = mel2note_
    f0c = torch.zeros_like(m2n).clamp(min=1)
    return fe + f0_emb(f0c)


def load_lite_encoders():
    """Load only the 4 embedding layers from the FP32 state_dict (mmap, ~few MB)."""
    ckpt = torch.load(MODEL_PATH, weights_only=False, map_location='cpu', mmap=True)
    sd = ckpt['state_dict']
    from torch import nn
    note_text_encoder = nn.Embedding(sd['note_text_encoder.weight'].shape[0], sd['note_text_encoder.weight'].shape[1])
    note_pitch_encoder = nn.Embedding(sd['note_pitch_encoder.weight'].shape[0], sd['note_pitch_encoder.weight'].shape[1])
    note_type_encoder = nn.Embedding(sd['note_type_encoder.weight'].shape[0], sd['note_type_encoder.weight'].shape[1])
    f0_encoder = nn.Embedding(sd['f0_encoder.weight'].shape[0], sd['f0_encoder.weight'].shape[1])
    note_text_encoder.weight.data.copy_(sd['note_text_encoder.weight'].float())
    note_pitch_encoder.weight.data.copy_(sd['note_pitch_encoder.weight'].float())
    note_type_encoder.weight.data.copy_(sd['note_type_encoder.weight'].float())
    f0_encoder.weight.data.copy_(sd['f0_encoder.weight'].float())
    note_text_encoder.eval()
    note_pitch_encoder.eval()
    note_type_encoder.eval()
    f0_encoder.eval()
    del ckpt, sd
    gc.collect()
    return note_text_encoder, note_pitch_encoder, note_type_encoder, f0_encoder


def main():
    processor = DataProcessor(hop_size=480, sample_rate=24000, phoneset_path=PHONESET, device='cpu')

    log('Loading lite embeddings (mmap)...')
    nte, npe, nte2, f0e = load_lite_encoders()
    log('  embeddings loaded')

    # ORT sessions
    sess_pre = ort.InferenceSession(os.path.join(ONNX_DIR, 'preflow.onnx'), providers=['CPUExecutionProvider'])
    sess_ce = ort.InferenceSession(os.path.join(ONNX_DIR, 'cond_emb.onnx'), providers=['CPUExecutionProvider'])
    sess_ds = ort.InferenceSession(os.path.join(ONNX_DIR, 'diffstep.onnx'), providers=['CPUExecutionProvider'])
    sess_voc = ort.InferenceSession(os.path.join(ONNX_DIR, 'vocoder.onnx'), providers=['CPUExecutionProvider'])

    def run_ort(sess, feeds):
        outs = sess.run(None, feeds)
        return outs[0] if len(outs) == 1 else outs

    anns = []
    with open(os.path.join(EVAL_DIR, 'annotation', 'opensource_eval.phone.target.jsonl'), 'r', encoding='utf-8') as f:
        for line in f:
            anns.append(json.loads(line))

    results = {}
    speed = {}

    with torch.no_grad():
        for idx, ann in enumerate(anns[:N_ITEMS]):
            log(f'--- item {idx}: {ann["item_name"]} ---')
            ref = np.load(os.path.join(REF_DIR, f'item{idx}.npz'))
            mel = torch.from_numpy(ref['mel'])
            T_mel = mel.shape[1]
            it = {}

            item = build_note_inputs(ann, processor)
            note_text = item['phoneme']
            note_pitch = item['note_pitch'].long()
            note_type = item['note_type'].long()
            mel2note = item['mel2note'].long()
            feats = npe(note_pitch) + nte2(note_type) + nte(note_text)

            # preflow.onnx
            t0 = time.time()
            pf = run_ort(sess_pre, {'x': feats.numpy()})
            t_pre = time.time() - t0
            it['preflow_cos'] = cosine(pf, ref['pf'])
            it['preflow_relerr'] = rel_err(pf, ref['pf'])

            # decoder input
            dec = decoder_inp(f0e, torch.from_numpy(pf), mel2note, T_mel)

            # cond_emb.onnx
            t0 = time.time()
            cond = run_ort(sess_ce, {'cond_code': dec.numpy()})
            t_cond = time.time() - t0
            it['cond_emb_cos'] = cosine(cond, ref['cond'])
            it['cond_emb_relerr'] = rel_err(cond, ref['cond'])

            # diffstep.onnx (QDIT bool mask)
            xt = (mel + 0.1 * torch.randn_like(mel)).numpy()
            tstep = np.array([0.5], dtype=np.float32)
            mask = np.ones((1, T_mel), dtype=np.bool_)
            t0 = time.time()
            flow = run_ort(sess_ds, {'x': xt, 'diffusion_step': tstep, 'cond': cond, 'x_mask': mask})
            t_diff = time.time() - t0
            flow_ref = ref['flow']
            it['diff_step_cos'] = cosine(flow, flow_ref)
            it['diff_step_relerr'] = rel_err(flow, flow_ref)
            it['diff_step_maxerr'] = float(np.abs(flow.astype(np.float32) - flow_ref.astype(np.float32)).max())

            # vocoder.onnx
            voc_in = mel.transpose(1, 2).numpy()
            t0 = time.time()
            wav_out = run_ort(sess_voc, {'mel': voc_in})
            t_voc = time.time() - t0
            wav_ref = ref['wav']
            L = min(wav_out.shape[-1], wav_ref.shape[-1])
            it['vocoder_cos'] = cosine(wav_out[..., :L], wav_ref[..., :L])
            it['vocoder_snr_db'] = snr_db_np(wav_ref[..., :L], wav_out[..., :L])

            speed.setdefault('preflow', []).append(t_pre)
            speed.setdefault('cond_emb', []).append(t_cond)
            speed.setdefault('diff_step', []).append(t_diff)
            speed.setdefault('vocoder', []).append(t_voc)

            log(f'  preflow cos={it["preflow_cos"]:.5f} | cond_emb cos={it["cond_emb_cos"]:.5f} | '
                f'diff_step cos={it["diff_step_cos"]:.5f} relerr={it["diff_step_relerr"]:.5f} | '
                f'vocoder cos={it["vocoder_cos"]:.5f} snr={it["vocoder_snr_db"]:.2f}dB')
            results[ann['item_name']] = it
            del ref, mel, pf, dec, cond, flow, wav_out
            gc.collect()

    def avg(k):
        vals = [v[k] for v in results.values() if k in v]
        return round(float(np.mean(vals)), 5) if vals else None

    summary = {
        'n_items': len(results),
        'diff_step_cos_mean': avg('diff_step_cos'),
        'diff_step_relerr_mean': avg('diff_step_relerr'),
        'cond_emb_cos_mean': avg('cond_emb_cos'),
        'preflow_cos_mean': avg('preflow_cos'),
        'vocoder_cos_mean': avg('vocoder_cos'),
        'vocoder_snr_db_mean': avg('vocoder_snr_db'),
    }
    speed_sum = {}
    fp32_t = json.load(open(os.path.join(REF_DIR, 'fp32_timings.json')))
    for k, v in speed.items():
        fp32_s = fp32_t.get(k, {}).get('mean_s')
        int8_s = round(float(np.mean(v)), 4)
        speed_sum[k] = {
            'fp32_mean_s': fp32_s,
            'int8_onnx_mean_s': int8_s,
            'speedup_x': round(fp32_s / int8_s, 2) if fp32_s and int8_s > 0 else None,
        }
    summary['speed'] = speed_sum
    log('===== ONNX SUMMARY =====')
    log(json.dumps(summary, ensure_ascii=False, indent=2))
    with open(REPORT, 'w', encoding='utf-8') as f:
        json.dump({'summary': summary, 'per_item': results}, f, ensure_ascii=False, indent=2)
    log(f'Report: {REPORT}')
    log('DONE')


if __name__ == '__main__':
    main()
