# -*- coding: utf-8 -*-
"""Debug vocoder: FP32 vs INT8 layer-by-layer divergence (manual forward)."""
import os, sys, gc, glob
os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
import torch
import yaml
import numpy as np
import soundfile as sf
import torchaudio.functional as AF
from soulxsinger.models.soulxsinger import SoulXSinger
from soulx_quant.w8a8_modules import replace_linear_awq, collect_activation_stats, W8A8Linear, W8A8Conv1d


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


def rel(a, b):
    return float((a.float() - b.float()).abs().mean() / (a.float().abs().mean() + 1e-8))


def run_backbone(v, x, save):
    x = v.backbone.embed(x)
    save['embed'] = x.clone()
    x = v.backbone.norm(x.transpose(1, 2)).transpose(1, 2)
    save['norm0'] = x.clone()
    for i, blk in enumerate(v.backbone.convnext):
        x = blk(x)
        save[f'block{i}'] = x.clone()
    x = v.backbone.final_layer_norm(x.transpose(1, 2))
    save['final_norm'] = x.clone()
    return x


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
        mel = model.mel(torch.from_numpy(audio).unsqueeze(0))  # [1,T,128]
    T = min(400, mel.shape[1])
    melc = mel[:, :T, :].transpose(1, 2).contiguous()  # [1,128,T]
    print('input mel:', tuple(melc.shape))

    voc = model.vocoder
    v = voc.model  # Vocos

    fp32_out = {}
    with torch.no_grad():
        x = run_backbone(v, melc.clone(), fp32_out)
        head_pre = v.head.out(x)
        fp32_out['head_out_pre'] = head_pre.clone()
        fp32_out['head_full'] = v.head(x).clone()
        fp32_out['wav'] = voc(melc.clone())
    print('FP32 wav range: [%.4f, %.4f]' % (fp32_out['wav'].min().item(), fp32_out['wav'].max().item()))

    # ---- AWQ quantize vocoder ----
    module_names = set()
    for n, m in voc.named_modules():
        if isinstance(m, (torch.nn.Linear, torch.nn.Conv1d)):
            module_names.add(n)
    act_stats = collect_activation_stats(voc, [melc], module_names)
    print('collected act stats:', len(act_stats))
    replace_linear_awq(voc, act_stats)
    print('W8A8Conv1d:', sum(1 for m in voc.modules() if isinstance(m, W8A8Conv1d)),
          'W8A8Linear:', sum(1 for m in voc.modules() if isinstance(m, W8A8Linear)))

    int8_out = {}
    with torch.no_grad():
        x = run_backbone(v, melc.clone(), int8_out)
        int8_out['head_out_pre'] = v.head.out(x).clone()
        int8_out['head_full'] = v.head(x).clone()
        int8_out['wav'] = voc(melc.clone())
    print('INT8 wav range: [%.4f, %.4f]' % (int8_out['wav'].min().item(), int8_out['wav'].max().item()))
    print('wav cos=%.5f snr=%.2f' % (cos(fp32_out['wav'], int8_out['wav']),
          10*np.log10(fp32_out['wav'].pow(2).mean()/((fp32_out['wav']-int8_out['wav']).pow(2).mean()+1e-12))))

    for k in ['embed', 'norm0', 'final_norm', 'head_out_pre', 'head_full']:
        if k in fp32_out:
            c = cos(fp32_out[k], int8_out[k])
            r = rel(fp32_out[k], int8_out[k])
            print(f'  {k}: cos={c:.5f} relerr={r:.5f} fp32_range=[{fp32_out[k].min():.3f},{fp32_out[k].max():.3f}]')

    for i in range(len(v.backbone.convnext)):
        k = f'block{i}'
        c = cos(fp32_out[k], int8_out[k])
        r = rel(fp32_out[k], int8_out[k])
        flag = ' <<<' if c < 0.99 else ''
        if i < 3 or c < 0.999:
            print(f'  {k}: cos={c:.5f} relerr={r:.5f} fp32_range=[{fp32_out[k].min():.3f},{fp32_out[k].max():.3f}]{flag}')


if __name__ == '__main__':
    main()
