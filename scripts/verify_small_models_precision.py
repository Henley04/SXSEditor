# -*- coding: utf-8 -*-
"""
验证所有小模型（encoder 系列、preflow、cond_emb、mel_transform）的 FP16 vs FP32 精度。

使用 DML EP（生产环境后端），因为 CPU EP 会自动 promote FP16 到 FP32，掩盖真实误差。

模型清单与输入输出（参考 src/inference/pipeline/preprocessing.js）：
  - note_text_encoder:  input_ids(int64,[1,T])      -> embeddings(float,[1,T,512])
  - note_pitch_encoder: input_ids(int64,[1,T])      -> embeddings(float,[1,T,512])
  - note_type_encoder:  input_ids(int64,[1,T])      -> embeddings(float,[1,T,512])
  - f0_encoder:         input_ids(int64,[1,T])      -> embeddings(float,[1,T,512])
  - preflow:            features(float,[1,T,512])   -> processed_features(float,[1,T,512])
  - cond_emb:           cond_code(float,[1,T,512])  -> cond_embedding(float,[1,T,1024])
  - mel_transform:      waveform(float,[1,N])       -> mel(float,[1,T,128]) / 其他

用法:
  python scripts/verify_small_models_precision.py
  python scripts/verify_small_models_precision.py --seq-len 100
  python scripts/verify_small_models_precision.py --models preflow cond_emb
"""
import argparse
import os
import sys
import numpy as np
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
FP32_DIR = os.path.join(PROJECT_DIR, 'onnx_models')
FP16_DIR = os.path.join(PROJECT_DIR, 'onnx_models', 'fp16')

# EMBED_DIM = 512  # encoder/preflow 输出维度
# COND_DIM = 1024  # cond_emb 输出维度

# 模型配置: (filename, input_name, output_name, input_dtype, input_shape_spec)
# input_shape_spec: 'int_seq' = [1, seq_len] int64
#                   'float_seq_512' = [1, seq_len, 512] float32
#                   'waveform' = [1, seq_len*480] float32
MODEL_CONFIGS = {
    'note_text_encoder': {
        'file': 'note_text_encoder.onnx',
        'input': 'input_ids',
        'output': 'embeddings',
        'dtype': 'int64',
        'shape': lambda seq_len: [1, seq_len],
        'gen': lambda seq_len, rng: rng.integers(0, 100, size=(1, seq_len), dtype=np.int64),
    },
    'note_pitch_encoder': {
        'file': 'note_pitch_encoder.onnx',
        'input': 'input_ids',
        'output': 'embeddings',
        'dtype': 'int64',
        'shape': lambda seq_len: [1, seq_len],
        'gen': lambda seq_len, rng: rng.integers(0, 256, size=(1, seq_len), dtype=np.int64),
    },
    'note_type_encoder': {
        'file': 'note_type_encoder.onnx',
        'input': 'input_ids',
        'output': 'embeddings',
        'dtype': 'int64',
        'shape': lambda seq_len: [1, seq_len],
        'gen': lambda seq_len, rng: rng.integers(0, 256, size=(1, seq_len), dtype=np.int64),
    },
    'f0_encoder': {
        'file': 'f0_encoder.onnx',
        'input': 'input_ids',
        'output': 'embeddings',
        'dtype': 'int64',
        'shape': lambda seq_len: [1, seq_len],
        'gen': lambda seq_len, rng: rng.integers(0, 361, size=(1, seq_len), dtype=np.int64),
    },
    'preflow': {
        'file': 'preflow.onnx',
        'input': 'features',
        'output': 'processed_features',
        'dtype': 'float32',
        'shape': lambda seq_len: [1, seq_len, 512],
        'gen': lambda seq_len, rng: rng.standard_normal((1, seq_len, 512)).astype(np.float32) * 0.5,
    },
    'cond_emb': {
        'file': 'cond_emb.onnx',
        'input': 'cond_code',
        'output': 'cond_embedding',
        'dtype': 'float32',
        'shape': lambda seq_len: [1, seq_len, 512],
        'gen': lambda seq_len, rng: rng.standard_normal((1, seq_len, 512)).astype(np.float32) * 0.5,
    },
    'mel_transform': {
        'file': 'mel_transform.onnx',
        'input': 'waveform',
        'output': None,  # 自动检测
        'dtype': 'float32',
        'shape': lambda seq_len: [1, seq_len * 480],
        'gen': lambda seq_len, rng: rng.standard_normal((1, seq_len * 480)).astype(np.float32) * 0.1,
    },
}

# 修正 note_pitch_encoder 的文件名
MODEL_CONFIGS['note_pitch_encoder']['file'] = 'note_pitch_encoder.onnx'


def create_dml_session(model_path):
    """创建 DML EP session（生产环境后端）。"""
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        model_path,
        sess_options=sess_options,
        providers=['DmlExecutionProvider', 'CPUExecutionProvider'],
    )
    return session


def get_io_info(session):
    """获取 session 的输入输出信息。"""
    inputs = {i.name: (i.type, i.shape) for i in session.get_inputs()}
    outputs = {o.name: (o.type, o.shape) for o in session.get_outputs()}
    return inputs, outputs


def compare(name, ref, cand):
    """对比两组输出的统计差异。"""
    ref = np.asarray(ref, dtype=np.float32).reshape(-1)
    cand = np.asarray(cand, dtype=np.float32).reshape(-1)
    min_len = min(len(ref), len(cand))
    ref = ref[:min_len]
    cand = cand[:min_len]
    diff = ref - cand
    l1_mean = float(np.mean(np.abs(diff)))
    l1_max = float(np.max(np.abs(diff)))
    l1_p99 = float(np.percentile(np.abs(diff), 99))
    mse = float(np.mean(diff ** 2))
    ref_energy = float(np.sum(ref ** 2)) + 1e-12
    err_energy = float(np.sum(diff ** 2)) + 1e-12
    snr_db = 10 * np.log10(ref_energy / err_energy)
    cos = float(np.sum(ref * cand) / (np.linalg.norm(ref) * np.linalg.norm(cand) + 1e-8))
    corr = float(np.corrcoef(ref, cand)[0, 1]) if min_len > 1 else 0.0
    return {
        'name': name,
        'l1_mean': l1_mean,
        'l1_max': l1_max,
        'l1_p99': l1_p99,
        'mse': mse,
        'snr_db': snr_db,
        'cosine': cos,
        'corr': corr,
        'len': min_len,
    }


def print_result(r):
    """打印对比结果。"""
    print(f"  [{r['name']}] (len={r['len']})")
    print(f"    L1 mean={r['l1_mean']:.6f}, L1 max={r['l1_max']:.6f}, L1 p99={r['l1_p99']:.6f}")
    print(f"    MSE={r['mse']:.8f}")
    print(f"    SNR={r['snr_db']:.2f} dB, Cosine={r['cosine']:.6f}, Corr={r['corr']:.6f}")


def verdict(r):
    """根据 cosine 和 SNR 给出判定。"""
    if r['cosine'] > 0.9999 and r['snr_db'] > 40:
        return 'EXCELLENT'
    elif r['cosine'] > 0.999 and r['snr_db'] > 30:
        return 'GOOD'
    elif r['cosine'] > 0.99 and r['snr_db'] > 20:
        return 'ACCEPTABLE'
    elif r['cosine'] > 0.95 and r['snr_db'] > 13:
        return 'MARGINAL'
    else:
        return 'POOR'


def verify_model(model_name, seq_len, rng, verbose=True):
    """验证单个模型的 FP16 vs FP32 精度。"""
    cfg = MODEL_CONFIGS[model_name]
    fname = cfg['file']
    fp32_path = os.path.join(FP32_DIR, fname)
    fp16_path = os.path.join(FP16_DIR, fname)

    if not os.path.exists(fp32_path):
        return None, f'FP32 model not found: {fp32_path}'
    if not os.path.exists(fp16_path):
        return None, f'FP16 model not found: {fp16_path}'

    if verbose:
        print(f"\n{'='*60}")
        print(f"Model: {model_name} ({fname})")
        print(f"{'='*60}")

    # 生成输入
    input_data = cfg['gen'](seq_len, rng)
    input_shape = cfg['shape'](seq_len)
    feeds_fp32 = {cfg['input']: input_data}

    # 创建 session
    try:
        sess_fp32 = create_dml_session(fp32_path)
    except Exception as e:
        return None, f'Failed to create FP32 session: {e}'
    try:
        sess_fp16 = create_dml_session(fp16_path)
    except Exception as e:
        return None, f'Failed to create FP16 session: {e}'

    # 获取 IO 信息
    in32, out32 = get_io_info(sess_fp32)
    in16, out16 = get_io_info(sess_fp16)
    if verbose:
        print(f"  FP32 inputs:  {in32}")
        print(f"  FP32 outputs: {list(out32.keys())}")
        print(f"  FP16 inputs:  {in16}")
        print(f"  FP16 outputs: {list(out16.keys())}")

    # FP16 输入需要转换为 float16（如果模型是 FP16）
    feeds_fp16 = {}
    is_fp16_model = any('float16' in (str(t) if t else '') for t in in16.values())
    if verbose:
        print(f"  FP16 model detected: {is_fp16_model}")

    for input_name, (input_type, _) in in16.items():
        if 'float16' in str(input_type):
            feeds_fp16[input_name] = input_data.astype(np.float16)
        elif 'int64' in str(input_type) or 'int' in str(input_type).lower():
            feeds_fp16[input_name] = input_data
        else:
            feeds_fp16[input_name] = input_data.astype(np.float32)

    # 运行推理
    try:
        out_fp32 = sess_fp32.run(None, feeds_fp32)
    except Exception as e:
        return None, f'FP32 inference failed: {e}'
    try:
        out_fp16 = sess_fp16.run(None, feeds_fp16)
    except Exception as e:
        return None, f'FP16 inference failed: {e}'

    # 取第一个输出对比
    out32_arr = np.asarray(out_fp32[0]).astype(np.float32)
    out16_arr = np.asarray(out_fp16[0]).astype(np.float32)

    # 对比
    output_name = cfg['output'] or list(out32.keys())[0]
    r = compare(f'{output_name}: FP32 vs FP16', out32_arr, out16_arr)
    if verbose:
        print()
        print_result(r)
        v = verdict(r)
        print(f"    Verdict: {v}")

    # 清理
    del sess_fp32, sess_fp16
    import gc
    gc.collect()

    return r, None


def main():
    parser = argparse.ArgumentParser(description='验证小模型 FP16 vs FP32 精度 (DML EP)')
    parser.add_argument('--seq-len', type=int, default=100,
                        help='序列长度（默认 100）')
    parser.add_argument('--models', nargs='+', default=None,
                        help='只验证指定模型（默认全部）')
    args = parser.parse_args()

    print(f"FP32 dir: {FP32_DIR}")
    print(f"FP16 dir: {FP16_DIR}")
    print(f"Seq length: {args.seq_len}")
    print(f"EP: DmlExecutionProvider (生产环境后端)")

    models_to_test = args.models if args.models else list(MODEL_CONFIGS.keys())
    rng = np.random.default_rng(42)

    results = {}
    errors = {}
    for model_name in models_to_test:
        if model_name not in MODEL_CONFIGS:
            print(f"\n[SKIP] Unknown model: {model_name}")
            continue
        r, err = verify_model(model_name, args.seq_len, rng, verbose=True)
        if err:
            errors[model_name] = err
            print(f"  [ERROR] {err}")
        else:
            results[model_name] = r

    # 总结
    print(f"\n{'='*60}")
    print("Summary")
    print(f"{'='*60}")
    print(f"{'Model':<25} {'Cosine':>10} {'SNR(dB)':>10} {'L1 mean':>12} {'Verdict':>12}")
    print('-' * 75)
    for model_name, r in results.items():
        v = verdict(r)
        flag = '  <<<' if v in ('POOR', 'MARGINAL') else ''
        print(f"{model_name:<25} {r['cosine']:>10.6f} {r['snr_db']:>10.2f} {r['l1_mean']:>12.6f} {v:>12}{flag}")

    for model_name, err in errors.items():
        print(f"{model_name:<25} {'ERROR':>10} {'-':>10} {'-':>12} {'-':>12}  {err}")

    # 整体判定
    if results:
        worst_cos = min(r['cosine'] for r in results.values())
        worst_snr = min(r['snr_db'] for r in results.values())
        worst_model = min(results, key=lambda k: results[k]['cosine'])
        print(f"\n  Worst cosine: {worst_cos:.6f} ({worst_model})")
        print(f"  Worst SNR:    {worst_snr:.2f} dB ({min(results, key=lambda k: results[k]['snr_db'])})")

        if worst_cos < 0.99 or worst_snr < 20:
            print(f"\n  [FAIL] 存在严重精度损失的小模型，可能是咬字不清的根因")
        elif worst_cos < 0.999 or worst_snr < 30:
            print(f"\n  [WARN] 部分小模型存在可测量的精度损失")
        else:
            print(f"\n  [PASS] 所有小模型 FP16 精度可接受")


if __name__ == '__main__':
    main()
