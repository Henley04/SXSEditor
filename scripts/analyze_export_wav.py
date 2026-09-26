import struct, sys, math

def read_wav_f32(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE'
    pos = 12
    fmt = None
    raw = None
    while pos + 8 <= len(data):
        cid = data[pos:pos+4]
        sz = struct.unpack('<I', data[pos+4:pos+8])[0]
        body = data[pos+8:pos+8+sz]
        if cid == b'fmt ':
            fmt = struct.unpack('<HHIIHH', body[:16])
        elif cid == b'data':
            raw = body
        pos += 8 + sz + (sz & 1)
    tag, ch, sr, _, _, bits = fmt
    assert tag == 3 and bits == 32, (tag, bits)
    n = len(raw) // 4
    samples = struct.unpack('<%df' % n, raw)
    if ch > 1:
        samples = samples[::ch]
    return sr, samples

def rms_curve(samples, sr, win_s=0.1):
    win = int(sr * win_s)
    out = []
    for i in range(0, len(samples) - win, win):
        s = 0.0
        for j in range(i, i + win, 4):  # stride 4 采样加速
            v = samples[j]
            s += v * v
        n = win // 4
        out.append(10 * math.log10(s / n + 1e-12))
    return out

path = sys.argv[1]
sr, x = read_wav_f32(path)
dur = len(x) / sr
print(f"{path}: {sr}Hz mono, {dur:.1f}s = {int(dur//60)}:{dur%60:04.1f}")

peak = max(abs(v) for v in x)
print(f"peak={peak:.4f} ({20*math.log10(peak+1e-12):.2f} dBFS)")

cur = rms_curve(x, sr)
# 全曲概览：每 5s 的平均 RMS
print("\n== 5s 粒度 RMS(dB) 概览 ==")
per5 = int(round(5 / 0.1))
for i in range(0, len(cur), per5):
    seg = cur[i:i+per5]
    if not seg: break
    m = sum(seg) / len(seg)
    t = i * 0.1
    bar = '#' * max(0, int((m + 60) / 1.5))
    print(f"{int(t//60):02d}:{t%60:04.1f} {m:7.2f} {bar}")

# 找最安静的 10 个 1s 窗（排除首尾 2s 静音区）
print("\n== 最安静 1s 窗 top15 (排除首尾 2s) ==")
per10 = 10
lo = 20
hi = len(cur) - 20
cands = []
for i in range(lo, hi, per10):
    seg = cur[i:i+per10]
    if len(seg) < per10: break
    m = sum(seg) / len(seg)
    cands.append((m, i * 0.1))
cands.sort()
for m, t in cands[:15]:
    # 与 vocoder 块边界(20.48s)网格的关系
    phase = t % 20.48
    print(f"{int(t//60):02d}:{t%60:04.1f}  {m:7.2f} dB  phase20.48={phase:5.2f}s")
