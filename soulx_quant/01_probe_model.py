# -*- coding: utf-8 -*-
"""Probe: load model.pt via mmap, build full SoulXSinger, count params, extract sub-model sizes."""
import os, sys, gc, resource
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'

import torch

def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0

from export_shared import load_config, clear_memory
from soulxsinger.models.soulxsinger import SoulXSinger

def main():
    config = load_config()
    print('config ok')
    model = SoulXSinger(config)
    total = sum(p.numel() for p in model.parameters())
    print(f'full model params: {total/1e6:.1f}M  fp32 bytes: {total*4/1e9:.2f}GB')
    # per sub-model
    sub = {
        'note_text_encoder': model.note_text_encoder,
        'note_pitch_encoder': model.note_pitch_encoder,
        'note_type_encoder': model.note_type_encoder,
        'f0_encoder': model.f0_encoder,
        'preflow': model.preflow,
        'cond_emb': model.cfm_decoder.model.cond_emb,
        'diff_step': model.cfm_decoder.model.diff_estimator,
        'vocoder': model.vocoder,
    }
    for k, m in sub.items():
        n = sum(p.numel() for p in m.parameters())
        print(f'  {k}: {n/1e6:.1f}M  fp32 {n*4/1e9:.2f}GB')
    del model
    gc.collect()
    ckpt = torch.load('/workspace/models_raw/model.pt', map_location='cpu', weights_only=False, mmap=True)
    print('ckpt keys:', list(ckpt.keys())[:5])
    sd = ckpt['state_dict']
    print('state_dict tensors:', len(sd))
    for k in list(sd.keys())[:8]:
        print('  ', k, tuple(sd[k].shape), sd[k].dtype)
    del sd, ckpt
    gc.collect()
    print(f'peak rss: {rss_mb():.0f} MB')

if __name__ == '__main__':
    main()
