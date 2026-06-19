# -*- coding: utf-8 -*-
"""
Shared utilities for INT8 ONNX export pipeline.
Contains: compatibility patches, model wrappers, ONNX post-processing, quantization.
"""

import os
import sys
import gc
import types
import time
import numpy as np

# ============================================================
# Compatibility patches
# ============================================================

class DictConfig(dict):
    def __getattr__(self, n):
        try: return DictConfig(self[n]) if isinstance(self[n], dict) else self[n]
        except KeyError: raise AttributeError(n)
    def __setattr__(self, n, v): self[n] = v
    def __contains__(self, k): return k in self

omegaconf = types.ModuleType('omegaconf')
omegaconf.DictConfig = DictConfig
sys.modules['omegaconf'] = omegaconf

class Config:
    def __init__(self, d):
        for k, v in d.items():
            setattr(self, k, Config(v) if isinstance(v, dict) else v)
    def __getattr__(self, n):
        if n.startswith('_'): raise AttributeError(n)
        try: return self.__dict__[n]
        except KeyError: raise AttributeError(f'no {n!r}')
    def __getitem__(self, k): return self.__dict__[k]
    def get(self, k, d=None): return self.__dict__.get(k, d)
    def __contains__(self, k): return k in self.__dict__
    def keys(self): return [k for k in self.__dict__ if not k.startswith('_')]
    def __iter__(self): return iter(self.keys())
    def items(self): return [(k, self.__dict__[k]) for k in self.keys()]

# Patch LlamaConfig for positional args
import transformers
from transformers import LlamaConfig as LC
from transformers.models.llama.modeling_llama import LlamaRotaryEmbedding
_orig_lc = LC.__init__
def _pi(self, *a, **kw):
    if a and not kw:
        for i, n in enumerate(['vocab_size','hidden_size','num_hidden_layers','num_attention_heads','intermediate_size']):
            if i < len(a): kw[n] = a[i]
    _orig_lc(self, **kw)
LC.__init__ = _pi

import torch
import torch.nn as nn
import yaml
import onnx
from onnx import helper, numpy_helper, TensorProto, shape_inference

try:
    import onnxsim
    HAS_ONNXSIM = True
except ImportError:
    HAS_ONNXSIM = False

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOULX_DIR = os.path.join(SCRIPT_DIR, 'SoulX-Singer')
sys.path.insert(0, SOULX_DIR)

from soulxsinger.models.soulxsinger import SoulXSinger
from soulxsinger.models.modules.llama import DiffLlama, LlamaNARDecoderLayer

# Patch LlamaNARDecoderLayer.forward
def _pnar(self, hidden_states, cond_embedding, attention_mask=None, position_ids=None,
          past_key_value=None, output_attentions=False, use_cache=False,
          position_embeddings=None, **kwargs):
    residual = hidden_states
    hidden_states = self.input_layernorm(hidden_states, cond_embedding=cond_embedding)
    attn_out = self.self_attn(hidden_states=hidden_states, position_embeddings=position_embeddings,
                              attention_mask=attention_mask, past_key_values=past_key_value)
    if isinstance(attn_out, tuple):
        hidden_states = attn_out[0]
    else:
        hidden_states = attn_out
    hidden_states = residual + hidden_states
    residual = hidden_states
    hidden_states = self.post_attention_layernorm(hidden_states, cond_embedding=cond_embedding)
    hidden_states = self.mlp(hidden_states)
    hidden_states = residual + hidden_states
    return (hidden_states,)
LlamaNARDecoderLayer.forward = _pnar

_orig_dli = DiffLlama.__init__
def _pdli(self, *a, **kw):
    _orig_dli(self, *a, **kw)
    layer_cfg = self.layers[0].self_attn.config
    self.rotary_emb = LlamaRotaryEmbedding(config=layer_cfg)
DiffLlama.__init__ = _pdli

def _pdl(self, x, diffusion_step, cond, x_mask, **kw):
    B, T, _ = x.shape
    cond_embedding = self.cond_mlp(cond)
    x = self.mel_mlp(x)
    diffusion_step = self.diff_step_embedding(diffusion_step).to(x.device)
    diffusion_step = self.diff_step_mlp(diffusion_step)
    x = x + cond_embedding
    attention_mask = self._prepare_decoder_attention_mask(x_mask, (B, T), x, 0)
    hidden_states = x
    position_ids = torch.arange(T, dtype=torch.long, device=x.device).unsqueeze(0).expand(B, -1)
    position_embeddings = self.rotary_emb(hidden_states, position_ids=position_ids)
    for decoder_layer in self.layers:
        layer_outputs = decoder_layer(hidden_states, attention_mask=attention_mask,
                                      position_embeddings=position_embeddings,
                                      cond_embedding=diffusion_step)
        hidden_states = layer_outputs[0]
    hidden_states = self.norm(hidden_states, cond_embedding=diffusion_step)
    hidden_states = self.mel_out_mlp(hidden_states)
    return hidden_states
DiffLlama.forward = _pdl

print("[PATCHES] Applied transformers 5.x compatibility patches")

# ============================================================
# Sub-model wrappers
# ============================================================

class DiffStepWrapper(nn.Module):
    def __init__(self, cfm_decoder):
        super().__init__()
        self.cond_emb = cfm_decoder.model.cond_emb
        self.diff_estimator = cfm_decoder.model.diff_estimator
    def forward(self, xt_input, t, cond, xt_mask):
        cond_emb = self.cond_emb(cond)
        return self.diff_estimator(xt_input, t, cond_emb, xt_mask)

class VocoderBackboneWrapper(nn.Module):
    def __init__(self, vocoder):
        super().__init__()
        self.backbone = vocoder.model.backbone
        self.head_out = vocoder.model.head.out
    def forward(self, mel):
        return self.head_out(self.backbone(mel.transpose(1, 2)))

# ============================================================
# Constants
# ============================================================

DEFAULT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8', 'from_pytorch')

# ============================================================
# Model loading
# ============================================================

def load_config():
    config_path = os.path.join(SOULX_DIR, 'soulxsinger', 'config', 'soulxsinger.yaml')
    with open(config_path) as f:
        return Config(yaml.safe_load(f))

def load_model(config, model_path):
    """Load SoulX-Singer model. Caller must del when done."""
    model = SoulXSinger(config).cpu()
    ckpt = torch.load(model_path, weights_only=False, map_location='cpu')
    model.load_state_dict(ckpt['state_dict'])
    del ckpt
    model.eval()
    return model

def clear_memory():
    """Force garbage collection and clear torch caches."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()

# ============================================================
# ONNX post-processing (STFT replacement, etc.)
# ============================================================

UNSUPPORTED_OPS = {'DynamicQuantizeLinear', 'MatMulInteger', 'ConvInteger', 'STFT'}

def find_initializer(graph, name):
    for init in graph.initializer:
        if init.name == name:
            return init
    return None

def replace_stft(model):
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced = 0

    for stft_node in list(graph.node):
        if stft_node.op_type != 'STFT':
            continue

        def get_constant_value(graph, name):
            init = find_initializer(graph, name)
            if init is not None:
                return numpy_helper.to_array(init)
            for node in graph.node:
                if node.op_type == 'Constant' and name in node.output:
                    for attr in node.attribute:
                        if attr.name == 'value':
                            return numpy_helper.to_array(attr.t)
            return None

        frame_step_val = get_constant_value(graph, stft_node.input[1])
        window_val = get_constant_value(graph, stft_node.input[2])
        if frame_step_val is None or window_val is None:
            continue

        hop_size = int(frame_step_val.item())
        window = window_val.astype(np.float32)
        n_fft = len(window)
        onesided = any(a.name == 'onesided' and a.i == 1 for a in stft_node.attribute)
        num_freq = n_fft // 2 + 1 if onesided else n_fft

        n = np.arange(n_fft, dtype=np.float32)
        k = np.arange(num_freq, dtype=np.float32).reshape(-1, 1)
        angles = 2 * np.pi * k * n / n_fft
        cos_kernel = (window * np.cos(angles)).reshape(num_freq, 1, n_fft).astype(np.float32)
        sin_kernel = (window * (-np.sin(angles))).reshape(num_freq, 1, n_fft).astype(np.float32)

        cos_name = f"{stft_node.name}_cos_kernel"
        sin_name = f"{stft_node.name}_sin_kernel"
        new_initializers.append(numpy_helper.from_array(cos_kernel, name=cos_name))
        new_initializers.append(numpy_helper.from_array(sin_kernel, name=sin_name))

        conv_input = stft_node.input[0]
        signal_is_3d = any(
            vi.name == conv_input and len([d.dim_value for d in vi.type.tensor_type.shape.dim]) == 3
            for vi in graph.value_info
        )
        if not signal_is_3d:
            unsq_name = f"{stft_node.name}_3d"
            new_nodes.append(helper.make_node('Unsqueeze', [conv_input, f"{stft_node.name}_ax"],
                                               [unsq_name], name=f"{stft_node.name}_unsq"))
            new_initializers.append(numpy_helper.from_array(np.array([1], dtype=np.int64),
                                                             name=f"{stft_node.name}_ax"))
            conv_input = unsq_name

        stft_output = stft_node.output[0]
        trans_node = next((n2 for n2 in graph.node if n2.op_type == 'Transpose' and stft_output in n2.input), None)
        if not trans_node:
            continue
        pow_node = next((n2 for n2 in graph.node if n2.op_type == 'Pow' and trans_node.output[0] in n2.input), None)
        if not pow_node:
            continue
        reduce_node = next((n2 for n2 in graph.node if n2.op_type == 'ReduceSum' and pow_node.output[0] in n2.input), None)
        if not reduce_node:
            continue

        current = reduce_node.output[0]
        add_node = None
        for n2 in graph.node:
            if n2.op_type == 'Add' and current in n2.input:
                add_node = n2
                current = n2.output[0]
                break
        sqrt_node = next((n2 for n2 in graph.node if n2.op_type == 'Sqrt' and current in n2.input), None)
        if not sqrt_node:
            continue

        final_output = sqrt_node.output[0]
        real_name = f"{stft_node.name}_real"
        imag_name = f"{stft_node.name}_imag"
        real_sq = f"{stft_node.name}_real_sq"
        imag_sq = f"{stft_node.name}_imag_sq"
        mag_sq = f"{stft_node.name}_mag_sq"

        new_nodes.extend([
            helper.make_node('Conv', [conv_input, cos_name], [real_name],
                             name=f"{stft_node.name}_cos", strides=[hop_size]),
            helper.make_node('Conv', [conv_input, sin_name], [imag_name],
                             name=f"{stft_node.name}_sin", strides=[hop_size]),
            helper.make_node('Mul', [real_name, real_name], [real_sq], name=f"{stft_node.name}_m1"),
            helper.make_node('Mul', [imag_name, imag_name], [imag_sq], name=f"{stft_node.name}_m2"),
            helper.make_node('Add', [real_sq, imag_sq], [mag_sq], name=f"{stft_node.name}_a1"),
            helper.make_node('Sqrt', [mag_sq], [final_output], name=f"{stft_node.name}_sq"),
        ])

        for n in [stft_node, trans_node, pow_node, reduce_node, sqrt_node] + ([add_node] if add_node else []):
            nodes_to_remove.add(n.name)
        replaced += 1

    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)
        graph.node.extend(new_nodes)
    graph.initializer.extend(new_initializers)
    print(f"  Replaced {replaced} STFT nodes")
    return model


def topological_sort(graph):
    from collections import deque
    available = {inp.name for inp in graph.input} | {init.name for init in graph.initializer}
    output_to_node = {out: node for node in graph.node for out in node.output}
    nodes = list(graph.node)
    node_by_name = {n.name: n for n in nodes}
    in_degree = {}
    dependents = {}
    for node in nodes:
        deps = sum(1 for inp in node.input if inp and inp not in available and inp in output_to_node
                   and output_to_node[inp].name != node.name)
        in_degree[node.name] = deps
        for inp in node.input:
            if inp and inp not in available and inp in output_to_node:
                dep_node = output_to_node[inp]
                if dep_node.name != node.name:
                    dependents.setdefault(dep_node.name, []).append(node.name)
    queue = deque(n for n, d in in_degree.items() if d == 0)
    sorted_names = []
    while queue:
        name = queue.popleft()
        sorted_names.append(name)
        for dep in dependents.get(name, []):
            in_degree[dep] -= 1
            if in_degree[dep] == 0:
                queue.append(dep)
    if len(sorted_names) == len(nodes):
        del graph.node[:]
        graph.node.extend(node_by_name[n] for n in sorted_names)


def strip_metadata(model):
    removed = len(model.metadata_props)
    del model.metadata_props[:]
    for attr in ['doc_string']:
        if getattr(model, attr):
            setattr(model, attr, '')
            removed += 1
    if model.graph.doc_string:
        model.graph.doc_string = ''
        removed += 1
    for node in model.graph.node:
        if node.doc_string:
            node.doc_string = ''
            removed += 1
    if removed:
        print(f"  Stripped {removed} metadata items")
    return model


def postprocess_onnx(input_path, output_path):
    print(f"\n  Post-processing: {os.path.basename(input_path)}")
    model = onnx.load(input_path)
    replace_stft(model)
    topological_sort(model.graph)
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass
    if HAS_ONNXSIM:
        try:
            simplified, ok = onnxsim.simplify(model, check_n=0, skip_fuse_bn=True, dynamic_input_shape=False)
            if ok:
                print(f"    onnxsim: {len(model.graph.node)} -> {len(simplified.graph.node)} nodes")
                model = simplified
        except Exception as e:
            print(f"    onnxsim error: {e}")
    model = strip_metadata(model)
    topological_sort(model.graph)

    graph = model.graph
    used = {inp for node in graph.node for inp in node.input if inp} | {o.name for o in graph.output}
    for init in [i for i in graph.initializer if i.name not in used]:
        graph.initializer.remove(init)

    old_data = output_path + '.data'
    if os.path.exists(old_data):
        os.remove(old_data)
    onnx.save_model(model, output_path, save_as_external_data=True,
                    all_tensors_to_one_file=True,
                    location=os.path.basename(output_path) + '.data',
                    size_threshold=1024)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f"    Saved: {os.path.basename(output_path)} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    unsupported = {n.op_type: sum(1 for nn in graph.node if nn.op_type == n.op_type)
                   for n in graph.node if n.op_type in UNSUPPORTED_OPS}
    if unsupported:
        print(f"    [WARN] NPU unsupported: {unsupported}")
    else:
        print(f"    [OK] All NPU compatible")

    ops = {}
    for n in graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f"    Nodes: {sum(ops.values())}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:8]:
        print(f"      {op}: {cnt}")

    return model


def quantize_onnx_model(input_path, output_path, calibration_inputs=None, per_channel=True):
    from onnxruntime.quantization import quantize, QuantFormat, QuantType, CalibrationDataReader, StaticQuantConfig

    print(f"\n  Quantizing: {os.path.basename(input_path)}")

    class RandomCalibrationReader(CalibrationDataReader):
        def __init__(self, inputs, num_samples=20):
            self.inputs_list = [inputs for _ in range(num_samples)]
            self.idx = 0
        def get_next(self):
            if self.idx >= len(self.inputs_list):
                return None
            result = self.inputs_list[self.idx]
            self.idx += 1
            return result

    reader = RandomCalibrationReader(calibration_inputs, num_samples=20) if calibration_inputs else None

    config = StaticQuantConfig(
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        per_channel=per_channel,
        reduce_range=False,
        op_types_to_quantize=['MatMul', 'Conv', 'Gemm'],
        extra_options={
            'ActivationSymmetric': False,
            'WeightSymmetric': True,
        },
    )

    quantize(
        model_input=input_path,
        model_output=output_path,
        quant_config=config,
    )

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f"    Quantized: {os.path.basename(output_path)} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    model = onnx.load(output_path, load_external_data=False)
    dq_count = sum(1 for n in model.graph.node if n.op_type == 'DequantizeLinear')
    q_count = sum(1 for n in model.graph.node if n.op_type == 'QuantizeLinear')
    print(f"    QDQ nodes: {q_count} QuantizeLinear + {dq_count} DequantizeLinear")

    return model
