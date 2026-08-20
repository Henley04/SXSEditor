# -*- coding: utf-8 -*-
"""Vocoder quantization strategy experiment - one config per process.
MODE=plain|awq|awq_nohead|plain_nohead"""
import os, sys, gc, glob, resource
os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
import torch
import yaml
import numpy as np
import soundfile as sf
import torchaudio.functional as AF
from soulxsinger.models.soulxsinger import SoulXSinger
from soulx_quant.w8a8_modules import (
    replace_linear_awq, collect_activation_stats, quantize_model_qdit,
    W8A8Linear, W8A8Conv1d,
)


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024

MODE = os.environ.get('MODE', 'awq')


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


def snr(a, b):
    n = (a.float() - b.float())
    return float(10 * np.log10(a.float().pow(2).mean() / (n.pow(2).mean() + 1e-12)))


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
    v = voc.model
    head_w = v.head.out.weight.detach().clone()
    head_b = v.head.out.bias.detach().clone()

    with torch.no_grad():
        wav_fp32 = voc(melc.clone())

    act_stats = None
    if MODE.startswith('awq'):
        module_names = set()
        for n, m in voc.named_modules():
            if isinstance(m, (torch.nn.Linear, torch.nn.Conv1d)):
                module_names.add(n)
        act_stats = collect_activation_stats(voc, [melc], module_names)
        print(f'  [mem] after collect stats RSS={rss_mb()}MB n={len(act_stats)}', flush=True)

    if MODE == 'plain':
        quantize_model_qdit(voc, group_size=0, quant_conv=True)
    elif MODE == 'awq':
        replace_linear_awq(voc, act_stats)
    elif MODE == 'awq_nohead':
        replace_linear_awq(voc, act_stats)
        lin = torch.nn.Linear(head_w.shape[1], head_w.shape[0])
        with torch.no_grad():
            lin.weight.copy_(head_w)
            lin.bias.copy_(head_b)
        v.head.out = lin
    elif MODE == 'plain_nohead':
        quantize_model_qdit(voc, group_size=0, quant_conv=True)
        lin = torch.nn.Linear(head_w.shape[1], head_w.shape[0])
        with torch.no_grad():
            lin.weight.copy_(head_w)
            lin.bias.copy_(head_b)
        v.head.out = lin
    del act_stats
    gc.collect()

    with torch.no_grad():
        w = voc(melc.clone())
    L = min(w.shape[-1], wav_fp32.shape[-1])
    c = cos(wav_fp32[..., :L], w[..., :L])
    s = snr(wav_fp32[..., :L], w[..., :L])
    n_lin = sum(1 for m in voc.modules() if isinstance(m, W8A8Linear))
    n_conv = sum(1 for m in voc.modules() if isinstance(m, W8A8Conv1d))
    print(f'[{MODE}] wav cos={c:.5f} snr={s:.2f}dB | W8A8Linear={n_lin} W8A8Conv1d={n_conv} | wav_range=[{w.min():.4f},{w.max():.4f}]')


if __name__ == '__main__':
    main()
