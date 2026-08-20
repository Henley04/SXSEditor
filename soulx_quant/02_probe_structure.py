# -*- coding: utf-8 -*-
"""Probe detailed module structure of diff_step + vocoder."""
import os, sys, gc
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')
os.environ['PYTHONIOENCODING'] = 'utf-8'
import torch
from export_shared import load_config
from soulxsinger.models.soulxsinger import SoulXSinger

def log(msg):
    print(msg, flush=True)
    with open('/tmp/struct.txt', 'a') as f:
        f.write(msg + '\n')

def load_model_mmap(config, model_path):
    model = SoulXSinger(config).cpu()
    ckpt = torch.load(model_path, weights_only=False, map_location='cpu', mmap=True)
    model.load_state_dict(ckpt['state_dict'])
    del ckpt
    gc.collect()
    model.eval()
    return model

def main():
    open('/tmp/struct.txt', 'w').close()
    config = load_config()
    model = load_model_mmap(config, '/workspace/models_raw/model.pt')
    de = model.cfm_decoder.model.diff_estimator
    l0 = de.layers[0]
    log('n_layers: %d' % len(de.layers))
    log('self_attn: %s' % str(list(l0.self_attn.named_children())))
    log('mlp: %s' % str(list(l0.mlp.named_children())))
    log('input_layernorm: %s' % type(l0.input_layernorm).__name__)
    log('diff_step_mlp: %s' % str([type(m).__name__ for m in de.diff_step_mlp]))
    log('cond_mlp: %s' % str([type(m).__name__ for m in de.cond_mlp]))
    log('mel_mlp: %s' % str([type(m).__name__ for m in de.mel_mlp]))
    log('mel_out_mlp: %s' % str([type(m).__name__ for m in de.mel_out_mlp]))
    log('cond_emb: %s %s' % (type(model.cfm_decoder.model.cond_emb).__name__,
                             str(tuple(model.cfm_decoder.model.cond_emb.weight.shape))))
    vb = model.vocoder.model.backbone
    log('vocos embed: %s %s' % (type(vb.embed).__name__, str(tuple(vb.embed.weight.shape))))
    cb0 = vb.convnext[0]
    log('dwconv: %s pwconv1: %s pwconv2: %s' % (
        str(tuple(cb0.dwconv.weight.shape)),
        str(tuple(cb0.pwconv1.weight.shape)),
        str(tuple(cb0.pwconv2.weight.shape))))
    log('head.out: %s' % str(tuple(model.vocoder.model.head.out.weight.shape)))
    log('vocos n_convnext: %d' % len(vb.convnext))
    # count per-layer params
    total_qkv = 0
    for layer in de.layers:
        sa = layer.self_attn
        total_qkv += sum(p.numel() for p in sa.q_proj.parameters())
    log('q_proj per layer params: %d' % total_qkv)
    del model
    gc.collect()
    log('DONE')

if __name__ == '__main__':
    main()
