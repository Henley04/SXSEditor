# -*- coding: utf-8 -*-
"""
Phase B: run INT8 W8A8 model on same eval items, compare to saved FP32 refs.

Metrics per submodel: cosine sim, rel err (diff_step), SNR (vocoder),
plus speed comparison. Uses fp32_refs saved by 07_save_fp32_refs.py.
"""
import os
import sys
import gc
import json
import glob
import time

os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')

import torch
import numpy as np
import yaml

from soulxsinger.models.soulxsinger import SoulXSinger
from soulxsinger.utils.data_processor import DataProcessor
from soulx_quant.w8a8_modules import quantize_model_qdit, replace_linear_awq


class _Cfg(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)

    def __getitem__(self, k):
        v = dict.__getitem__(self, k)
        return _Cfg(v) if isinstance(v, dict) else v

    def get(self, k, d=None):
        v = dict.get(self, k, d)
        return _Cfg(v) if isinstance(v, dict) else v


def load_config():
    with open('/workspace/SoulX-Singer/soulxsinger/config/soulxsinger.yaml') as f:
        return _Cfg(yaml.safe_load(f))

INT8_PT = '/workspace/onnx_models/int8/pt/soulxsinger_w8a8_full.pt'
EVAL_DIR = '/workspace/eval_data/gmo-svs'
REF_DIR = '/workspace/onnx_models/int8/pt/fp32_refs'
REPORT = '/workspace/onnx_models/int8/pt/eval_report.json'
PHONESET = '/workspace/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json'
N_ITEMS = 6


def log(msg):
    print(msg, flush=True)


def load_int8_model(config, path):
    # The full quantized module object was saved with torch.save in 05; this
    # preserves the exact W8A8 + AWQ module structure and scales.
    model = torch.load(path, weights_only=False, map_location='cpu', mmap=True)
    model.eval()
    return model


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


def decoder_inp(m, feats, mel2note_, T_mel):
    fe = m.expand_states(feats, mel2note_)
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
    return fe + m.f0_encoder(f0c)


def cosine(a, b):
    return float(torch.nn.functional.cosine_similarity(a.reshape(-1).float(), b.reshape(-1).float(), dim=0))


def rel_err(a, b):
    return float((a.float() - b.float()).abs().mean() / (a.float().abs().mean() + 1e-8))


def snr_db(ref, q):
    noise = (ref.float() - q.float())
    return float(10 * np.log10(ref.float().pow(2).mean() / (noise.pow(2).mean() + 1e-12)))


def main():
    config = load_config()
    processor = DataProcessor(hop_size=480, sample_rate=24000, phoneset_path=PHONESET, device='cpu')

    log('Loading INT8 model (mmap)...')
    int8 = load_int8_model(config, INT8_PT)
    n_i8 = sum(1 for b in int8.buffers() if b.dtype == torch.int8)
    log(f'  int8 buffers: {n_i8}')

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

            feats = int8.note_pitch_encoder(note_pitch) + int8.note_type_encoder(note_type) + int8.note_text_encoder(note_text)
            t0 = time.time()
            pf = int8.preflow(feats)
            t_pre_i = time.time() - t0
            it['preflow_cos'] = cosine(pf, torch.from_numpy(ref['pf']))
            it['preflow_relerr'] = rel_err(pf, torch.from_numpy(ref['pf']))

            dec = decoder_inp(int8, pf, mel2note, T_mel)
            t0 = time.time()
            cond = int8.cfm_decoder.model.cond_emb(dec)
            t_cond_i = time.time() - t0
            it['cond_emb_cos'] = cosine(cond, torch.from_numpy(ref['cond']))
            it['cond_emb_relerr'] = rel_err(cond, torch.from_numpy(ref['cond']))

            xt = mel + 0.1 * torch.randn_like(mel)
            tstep = torch.full((1,), 0.5)
            mask = torch.ones(1, T_mel)
            t0 = time.time()
            flow = int8.cfm_decoder.model.diff_estimator(xt, tstep, cond, mask)
            t_diff_i = time.time() - t0
            flow_ref = torch.from_numpy(ref['flow'])
            it['diff_step_cos'] = cosine(flow, flow_ref)
            it['diff_step_relerr'] = rel_err(flow, flow_ref)
            it['diff_step_maxerr'] = float((flow.float() - flow_ref.float()).abs().max())

            voc_in = mel.transpose(1, 2)
            t0 = time.time()
            wav_out = int8.vocoder(voc_in)
            t_voc_i = time.time() - t0
            wav_ref = torch.from_numpy(ref['wav'])
            L = min(wav_out.shape[-1], wav_ref.shape[-1])
            it['vocoder_cos'] = cosine(wav_out[..., :L], wav_ref[..., :L])
            it['vocoder_snr_db'] = snr_db(wav_ref[..., :L], wav_out[..., :L])

            speed.setdefault('preflow', []).append(t_pre_i)
            speed.setdefault('cond_emb', []).append(t_cond_i)
            speed.setdefault('diff_step', []).append(t_diff_i)
            speed.setdefault('vocoder', []).append(t_voc_i)

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
        'int8_int8_buffers': n_i8,
    }
    speed_sum = {}
    fp32_t = json.load(open(os.path.join(REF_DIR, 'fp32_timings.json')))
    for k, v in speed.items():
        fp32_s = fp32_t.get(k, {}).get('mean_s')
        int8_s = round(float(np.mean(v)), 4)
        speed_sum[k] = {
            'fp32_mean_s': fp32_s,
            'int8_mean_s': int8_s,
            'speedup_x': round(fp32_s / int8_s, 2) if fp32_s and int8_s > 0 else None,
        }
    summary['speed'] = speed_sum
    log('===== SUMMARY =====')
    log(json.dumps(summary, ensure_ascii=False, indent=2))
    with open(REPORT, 'w', encoding='utf-8') as f:
        json.dump({'summary': summary, 'per_item': results}, f, ensure_ascii=False, indent=2)
    log(f'Report: {REPORT}')
    log('DONE')


if __name__ == '__main__':
    main()
