import numpy as np
import onnxruntime as ort

# 检查 rosvot_mel.onnx
mel_sess = ort.InferenceSession(r'd:\Document\electron\SXSEditor\onnx_models\preprocess\rosvot_mel.onnx', providers=['CPUExecutionProvider'])
print('=== rosvot_mel.onnx ===')
for i in mel_sess.get_inputs():
    print(f'  Input: {i.name}, shape={i.shape}, type={i.type}')
for o in mel_sess.get_outputs():
    print(f'  Output: {o.name}, shape={o.shape}, type={o.type}')

# 测试 mel 提取
sr = 24000
duration = 3
audio = np.random.randn(1, sr * duration).astype(np.float32) * 0.1
mel_result = mel_sess.run(None, {mel_sess.get_inputs()[0].name: audio})
print(f'  Mel output shape: {mel_result[0].shape}')
print(f'  Mel output range: [{mel_result[0].min():.4f}, {mel_result[0].max():.4f}]')

# 检查 rosvot_model.onnx
model_sess = ort.InferenceSession(r'd:\Document\electron\SXSEditor\onnx_models\preprocess\rosvot_model.onnx', providers=['CPUExecutionProvider'])
print('\n=== rosvot_model.onnx ===')
for i in model_sess.get_inputs():
    print(f'  Input: {i.name}, shape={i.shape}, type={i.type}')
for o in model_sess.get_outputs():
    print(f'  Output: {o.name}, shape={o.shape}, type={o.type}')

# 用 mel 输出作为 rosvot_model 的输入测试
# rosvot_model 接受 wav, pitch, uv, word_bd
# 但原始 ROSVOT 代码接受 mel, pitch_coarse, uv, word_bd, non_padding
# 看看 rosvot_model 是否也接受 mel 输入
input_names = [i.name for i in model_sess.get_inputs()]
print(f'\n  Input names: {input_names}')

# 测试：用 mel 替代 wav
max_frames = 4000
max_samples = max_frames * 128
hop_size = 128

# 先用原始 wav 方式
wav_padded = np.zeros((1, max_samples), dtype=np.float32)
wav_padded[0, :audio.shape[1]] = audio[0]

pitch = np.zeros((1, max_frames), dtype=np.int64)
uv = np.ones((1, max_frames), dtype=np.int64)
word_bd = np.zeros((1, max_frames), dtype=np.int64)

# 设置一些有声音帧
for i in range(100, 500):
    pitch[0, i] = 60
    uv[0, i] = 0

print('\n--- Test with wav input ---')
try:
    results = model_sess.run(None, {'wav': wav_padded, 'pitch': pitch, 'uv': uv, 'word_bd': word_bd})
    note_bd = results[0]
    note_pred = results[1]
    note_lengths = results[2]
    print(f'  note_bd_pred: nonzero={np.count_nonzero(note_bd)}')
    print(f'  note_pred: {note_pred[0][:10]}')
    print(f'  note_lengths: {note_lengths}')
except Exception as e:
    print(f'  Error: {e}')

# 测试：用 mel 替代 wav
print('\n--- Test with mel input (if supported) ---')
mel_output = mel_result[0]
mel_frames = mel_output.shape[1]
mel_bins = mel_output.shape[2]
print(f'  Mel shape: {mel_output.shape} (batch, frames, bins)')

# 尝试把 mel 传给 rosvot_model
# pitch_coarse 需要匹配 mel 的帧数
# ROSVOT 原始代码的 hop_size 是 480（对于 mel），不是 128
# 但 rosvot_mel.onnx 的输出帧数取决于其内部参数

# 检查 mel 帧数与音频长度的关系
print(f'  Audio samples: {audio.shape[1]}')
print(f'  Mel frames: {mel_frames}')
print(f'  Ratio: {audio.shape[1] / mel_frames:.1f}')

# 尝试用 mel 输入
if 'mel' in input_names:
    mel_padded = np.zeros((1, max_frames, mel_bins), dtype=np.float32)
    mel_padded[0, :mel_frames] = mel_output[0]
    
    # pitch_coarse 需要和 mel 帧数匹配
    pitch_coarse = np.zeros((1, max_frames), dtype=np.int64)
    for i in range(100, min(500, mel_frames)):
        pitch_coarse[0, i] = 60
    
    try:
        results = model_sess.run(None, {
            'mel': mel_padded,
            'pitch': pitch_coarse,
            'uv': uv[:, :max_frames],
            'word_bd': word_bd[:, :max_frames],
            'non_padding': np.ones((1, max_frames), dtype=np.float32)
        })
        print(f'  Success with mel input!')
        print(f'  note_bd_pred: nonzero={np.count_nonzero(results[0])}')
        print(f'  note_pred: {results[1][0][:10]}')
        print(f'  note_lengths: {results[2]}')
    except Exception as e:
        print(f'  Error with mel input: {e}')
else:
    print('  mel input not supported by rosvot_model.onnx')
