# -*- coding: utf-8 -*-
"""
Phase A: run FP32 SoulX-Singer on SoulX-Singer-Eval items, save reference
outputs (preflow, cond_emb, diff_step flow, vocoder wav) to disk as .npz.
"""
import os
import sys
import gc
import json
import glob

os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')

import torch
import numpy as np
import soundfile as sf
import time
import yaml

from soulxsinger.models.soulxsinger import SoulXSinger
from soulxsinger.utils.data_processor import DataProcessor


class _Cfg(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)

    def __getitem__(self, k):
        v = dict.__getitem__(self, k)
        if isinstance(v, dict):
            return _Cfg(v)
        return v

    def get(self, k, d=None):
        v = dict.get(self, k, d)
        return _Cfg(v) if isinstance(v, dict) else v


def load_config():
    with open('/workspace/SoulX-Singer/soulxsinger/config/soulxsinger.yaml') as f:
        return _Cfg(yaml.safe_load(f))

MODEL_PATH = '/workspace/models_raw/model.pt'
EVAL_DIR = '/workspace/eval_data/gmo-svs'
REF_DIR = '/workspace/onnx_models/int8/pt/fp32_refs'
PHONESET = '/workspace/SoulX-Singer/soulxsinger/utils/phoneme/phone_set.json'
N_ITEMS = 6


def log(msg):
    print(msg, flush=True)


def load_model_mmap(config, model_path):
    model = SoulXSinger(config).cpu()
    ckpt = torch.load(model_path, weights_only=False, map_location='cpu', mmap=True)
    model.load_state_dict(ckpt['state_dict'])
    del ckpt
    gc.collect()
    model.eval()
    return model


def read_wav(path, sr=24000):
    audio, rs = sf.read(path, dtype='float32', always_2d=True)
    audio = audio[:, 0]
    if rs != sr:
        import torchaudio.functional as AF
        audio = AF.resample(torch.from_numpy(audio), rs, sr).numpy()
    return torch.from_numpy(audio).unsqueeze(0)


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


def main():
    config = load_config()
    processor = DataProcessor(hop_size=480, sample_rate=24000, phoneset_path=PHONESET, device='cpu')
    os.makedirs(REF_DIR, exist_ok=True)

    log('Loading FP32 model (mmap)...')
    fp32 = load_model_mmap(config, MODEL_PATH)

    anns = []
    with open(os.path.join(EVAL_DIR, 'annotation', 'opensource_eval.phone.target.jsonl'), 'r', encoding='utf-8') as f:
        for line in f:
            anns.append(json.loads(line))
    log(f'  {len(anns)} items, using {N_ITEMS}')

    timings = {'preflow': [], 'cond_emb': [], 'diff_step': [], 'vocoder': []}

    with torch.no_grad():
        for idx, ann in enumerate(anns[:N_ITEMS]):
            wav_fn = os.path.join(EVAL_DIR, 'audio', 'source', os.path.basename(ann['wav_fn']))
            log(f'--- item {idx}: {ann["item_name"]} ---')
            wav = read_wav(wav_fn)
            mel = fp32.mel(wav)[:, :4000, :]
            T_mel = mel.shape[1]
            log(f'  mel: {tuple(mel.shape)}')

            item = build_note_inputs(ann, processor)
            note_text = item['phoneme']
            note_pitch = item['note_pitch'].long()
            note_type = item['note_type'].long()
            mel2note = item['mel2note'].long()

            feats = fp32.note_pitch_encoder(note_pitch) + fp32.note_type_encoder(note_type) + fp32.note_text_encoder(note_text)
            t0 = time.time()
            pf = fp32.preflow(feats)
            timings['preflow'].append(time.time() - t0)
            dec = decoder_inp(fp32, pf, mel2note, T_mel)
            t0 = time.time()
            cond = fp32.cfm_decoder.model.cond_emb(dec)
            timings['cond_emb'].append(time.time() - t0)
            xt = mel + 0.1 * torch.randn_like(mel)
            tstep = torch.full((1,), 0.5)
            mask = torch.ones(1, T_mel)
            t0 = time.time()
            flow = fp32.cfm_decoder.model.diff_estimator(xt, tstep, cond, mask)
            timings['diff_step'].append(time.time() - t0)
            voc_in = mel.transpose(1, 2)
            t0 = time.time()
            wav_out = fp32.vocoder(voc_in)
            timings['vocoder'].append(time.time() - t0)

            np.savez_compressed(
                os.path.join(REF_DIR, f'item{idx}.npz'),
                mel=mel.float().numpy(),
                pf=pf.float().numpy(),
                cond=cond.float().numpy(),
                flow=flow.float().numpy(),
                wav=wav_out.float().numpy(),
            )
            log(f'  saved ref item{idx}.npz')
            del wav, mel, pf, dec, cond, xt, flow, wav_out
            gc.collect()

    with open(os.path.join(REF_DIR, 'fp32_timings.json'), 'w', encoding='utf-8') as f:
        json.dump({k: {'mean_s': round(float(np.mean(v)), 4)} for k, v in timings.items()}, f, indent=2)
    log('  saved fp32_timings.json')
    log('DONE')


if __name__ == '__main__':
    main()
