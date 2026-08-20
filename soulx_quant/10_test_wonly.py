# -*- coding: utf-8 -*-
"""Isolate activation-quant error: MODE=convonly|linonly|w8a8conv_plain
- convonly: convs W8A8 (per-tensor act), linears weights-only (exact act)
- linonly : linears W8A8 (per-token act), convs weights-only (exact act)
- awq     : full AWQ W8A8 (baseline comparison)
"""
import os, sys, gc, glob
os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
import torch
import yaml
import numpy as np
import soundfile as sf
import torchaudio.functional as AF
from torch import nn
from soulxsinger.models.soulxsinger import SoulXSinger
from soulx_quant.w8a8_modules import (
    replace_linear_awq, collect_activation_stats, W8A8Linear, W8A8Conv1d,
)

MODE = os.environ.get('MODE', 'convonly')


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


def cos(a, b):
    return float(torch.nn.functional.cosine_similarity(a.reshape(-1).float(), b.reshape(-1).float(), dim=0))


def dequant_linear(m):
    w = m.weight.data.float()
    s = w.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8) / 127.0
    m.weight.data.copy_(torch.clamp(torch.round(w / s), -128, 127) * s)


def dequant_conv(m):
    w = m.weight.data.float()
    s = w.abs().amax(dim=(1, 2), keepdim=True).clamp(min=1e-8) / 127.0
    m.weight.data.copy_(torch.clamp(torch.round(w / s), -128, 127) * s)


def replace_conv_only(module, name=''):
    for child_name, child in list(module.named_children()):
        path = f'{name}.{child_name}' if name else child_name
        if isinstance(child, nn.Conv1d):
            setattr(module, child_name, W8A8Conv1d(
                child.weight.data,
                child.bias.data if child.bias is not None else None,
                child.stride[0], child.padding[0], child.dilation[0], child.groups))
        elif isinstance(child, nn.Linear):
            dequant_linear(child)
        else:
            replace_conv_only(child, path)
    return module


def replace_lin_only(module, name=''):
    for child_name, child in list(module.named_children()):
        path = f'{name}.{child_name}' if name else child_name
        if isinstance(child, nn.Linear):
            setattr(module, child_name, W8A8Linear(
                child.weight.data, child.bias.data if child.bias is not None else None,
                group_size=0))
        elif isinstance(child, nn.Conv1d):
            dequant_conv(child)
        else:
            replace_lin_only(child, path)
    return module


def main():
    model = SoulXSinger(load_config()).cpu()
    ckpt = torch.load('/workspace/models_raw/model.pt', weights_only=False, map_location='cpu', mmap=True)
    model.load_state_dict(ckpt['state_dict'])
    del ckpt
    gc.collect()
    model.eval()

    wavs = sorted(glob.glob('/workspace/eval_data/gmo-svs/audio/source/*.wav'))
    audio, sr = sf.read(wavs[0], dtype='float32', always_2d=True)
    audio = audio[:, 0]
    if sr != 24000:
        audio = AF.resample(torch.from_numpy(audio), sr, 24000).numpy()
    with torch.no_grad():
        mel = model.mel(torch.from_numpy(audio).unsqueeze(0))
    T = min(400, mel.shape[1])
    melc = mel[:, :T, :].transpose(1, 2).contiguous()

    voc = model.vocoder
    with torch.no_grad():
        wav_fp32 = voc(melc.clone())

    if MODE == 'convonly':
        replace_conv_only(voc)
    elif MODE == 'linonly':
        replace_lin_only(voc)
    elif MODE == 'awq':
        module_names = set()
        for n, m in voc.named_modules():
            if isinstance(m, (torch.nn.Linear, torch.nn.Conv1d)):
                module_names.add(n)
        act_stats = collect_activation_stats(voc, [melc], module_names)
        replace_linear_awq(voc, act_stats)
    gc.collect()

    with torch.no_grad():
        w = voc(melc.clone())
    L = min(w.shape[-1], wav_fp32.shape[-1])
    n_lin = sum(1 for m in voc.modules() if isinstance(m, W8A8Linear))
    n_conv = sum(1 for m in voc.modules() if isinstance(m, W8A8Conv1d))
    print(f'[{MODE}] wav cos={cos(wav_fp32[..., :L], w[..., :L]):.5f} | W8A8Linear={n_lin} W8A8Conv1d={n_conv}')


if __name__ == '__main__':
    main()
