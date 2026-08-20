# -*- coding: utf-8 -*-
"""Low-memory vocoder AWQ test: quantize ONE layer at a time.

Instead of holding activation stats for all 92 modules at once (OOM at 4GB),
hook only one module, run one forward, compute its AWQ scale, replace it,
free memory, repeat. Measures wav cos/snr for fixed AWQ W8A8.
"""
import os, sys, gc, glob, resource
os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
import torch
import yaml
import numpy as np
import soundfile as sf
import torchaudio.functional as AF
from torch import nn
from soulxsinger.models.modules.vocoder import Vocoder
from soulxsinger.models.modules.mel_transform import MelSpectrogramEncoder
from soulx_quant.w8a8_modules import (
    compute_awq_scale, compute_awq_scale_conv, W8A8Linear, W8A8Conv1d,
)

CKPT = '/workspace/models_raw/model.pt'


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024


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


def build_standalone():
    config = load_config()
    audio_cfg = config.audio
    mel_enc = MelSpectrogramEncoder(audio_cfg)
    vocoder = Vocoder()
    ck = torch.load(CKPT, map_location='cpu', weights_only=False, mmap=True)
    sd = ck['state_dict']
    voc_sd = {k[len('vocoder.'):]: v for k, v in sd.items() if k.startswith('vocoder.')}
    missing, unexpected = vocoder.load_state_dict(voc_sd, strict=False)
    print(f'  [standalone] vocoder loaded: {len(voc_sd)} keys, missing={len(missing)}', flush=True)
    del ck, sd, voc_sd
    gc.collect()
    vocoder.eval()
    for p in vocoder.parameters():
        p.requires_grad = False
    return vocoder, mel_enc


def main():
    max_rows = int(os.environ.get('MAX_ROWS', '256'))
    use_awq = os.environ.get('AWQ', '1') == '1'
    print(f'[start] max_rows={max_rows} awq={use_awq} RSS={rss_mb()}MB', flush=True)
    vocoder, mel_enc = build_standalone()
    print(f'  after build RSS={rss_mb()}MB', flush=True)

    wavs = sorted(glob.glob('/workspace/eval_data/gmo-svs/audio/source/*.wav'))
    audio, sr = sf.read(wavs[0], dtype='float32', always_2d=True)
    audio = audio[:, 0]
    if sr != 24000:
        audio = AF.resample(torch.from_numpy(audio), sr, 24000).numpy()
    with torch.no_grad():
        mel = mel_enc(torch.from_numpy(audio).unsqueeze(0))
    T = min(400, mel.shape[1])
    melc = mel[:, :T, :].transpose(1, 2).contiguous()

    with torch.no_grad():
        wav_fp32 = vocoder(melc.clone())
    print(f'  fp32 done RSS={rss_mb()}MB', flush=True)

    # ---- quantize layer-by-layer ----
    targets = []
    for name, m in vocoder.named_modules():
        if isinstance(m, (nn.Linear, nn.Conv1d)):
            targets.append((name, m))

    def replace_one(path, m, act):
        """Replace a single module using its collected activation."""
        if isinstance(m, nn.Linear):
            s = compute_awq_scale(m.weight.data, act) if use_awq else None
            parent = vocoder
            parts = path.split('.')
            for p in parts[:-1]:
                parent = getattr(parent, p)
            setattr(parent, parts[-1], W8A8Linear(
                m.weight.data, m.bias.data if m.bias is not None else None,
                group_size=0, awq_scale=s))
        elif isinstance(m, nn.Conv1d):
            s = None
            if use_awq and m.groups == 1:
                s = compute_awq_scale_conv(
                    m.weight.data, act,
                    m.stride[0], m.padding[0], m.dilation[0], m.groups)
            parent = vocoder
            parts = path.split('.')
            for p in parts[:-1]:
                parent = getattr(parent, p)
            setattr(parent, parts[-1], W8A8Conv1d(
                m.weight.data, m.bias.data if m.bias is not None else None,
                m.stride[0], m.padding[0], m.dilation[0], m.groups,
                awq_scale=s))

    for i, (name, m) in enumerate(targets):
        captured = {}

        def make_hook(mod, is_conv):
            def hook(mod, inp, out):
                x = inp[0].detach().float()
                if is_conv:
                    captured['act'] = x[0, :, :max_rows]
                else:
                    if x.dim() == 3:
                        captured['act'] = x.reshape(-1, x.shape[-1])[:max_rows]
                    else:
                        captured['act'] = x.reshape(-1, x.shape[-1])[:max_rows]
            return hook

        is_conv = isinstance(m, nn.Conv1d)
        h = m.register_forward_hook(make_hook(name, is_conv))
        with torch.no_grad():
            vocoder(melc.clone())
        h.remove()
        act = captured.get('act')
        if act is None:
            continue
        replace_one(name, m, act)
        del act, captured
        gc.collect()
        if i % 10 == 0:
            print(f'  [{i}/{len(targets)}] {name} RSS={rss_mb()}MB', flush=True)

    print(f'  quantized all {len(targets)} layers RSS={rss_mb()}MB', flush=True)
    with torch.no_grad():
        w = vocoder(melc.clone())
    L = min(w.shape[-1], wav_fp32.shape[-1])
    n_lin = sum(1 for m in vocoder.modules() if isinstance(m, W8A8Linear))
    n_conv = sum(1 for m in vocoder.modules() if isinstance(m, W8A8Conv1d))
    print(f'[RESULT] wav cos={cos(wav_fp32[..., :L], w[..., :L]):.5f} '
          f'snr={snr(wav_fp32[..., :L], w[..., :L]):.2f}dB '
          f'| W8A8Linear={n_lin} W8A8Conv1d={n_conv} | RSS={rss_mb()}MB')


if __name__ == '__main__':
    main()
