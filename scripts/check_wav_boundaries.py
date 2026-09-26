import struct, sys, math

def read_wav_f32(path):
    with open(path, 'rb') as f:
        data = f.read()
    pos = 12
    fmt = None; raw = None
    while pos + 8 <= len(data):
        cid = data[pos:pos+4]; sz = struct.unpack('<I', data[pos+4:pos+8])[0]
        body = data[pos+8:pos+8+sz]
        if cid == b'fmt ': fmt = struct.unpack('<HHIIHH', body[:16])
        elif cid == b'data': raw = body
        pos += 8 + sz + (sz & 1)
    tag, ch, sr, _, _, bits = fmt
    assert tag == 3 and bits == 32
    n = len(raw) // 4
    x = struct.unpack('<%df' % n, raw)
    if ch > 1: x = x[::ch]
    return sr, x

path = sys.argv[1]
sr, x = read_wav_f32(path)
dur = len(x) / sr
print(f"{path}: {dur:.1f}s")

def rms_db(seg):
    s = 0.0
    for v in seg: s += v * v
    return 10 * math.log10(s / len(seg) + 1e-12)

# vocoder 块边界网格（1024 帧 x 480 hop / 24k = 20.48s）
B = 20.48
# 拼接检查：边界 t±0.5s 窗 RMS vs 前后基线 [t-2.5,t-0.7]+[t+0.9,t+2.7]
print("\n== vocoder 1024f 边界检测 (20.48s 网格) ==")
print("   t      win_dB  base_dB  delta")
t = B
while t < dur - 2.7:
    i0 = int(t * sr)
    w = x[i0 - int(0.5*sr): i0 + int(0.5*sr)]
    b1 = x[i0 - int(2.5*sr): i0 - int(0.7*sr)]
    b2 = x[i0 + int(0.9*sr): i0 + int(2.7*sr)]
    wd = rms_db(w); bd = (rms_db(b1) + rms_db(b2)) / 2
    flag = '  <<<' if wd - bd < -1.5 else ''
    print(f"{int(t//60):02d}:{t%60:05.2f}  {wd:7.2f}  {bd:7.2f}  {wd-bd:+6.2f}{flag}")
    t += B

# 也检查 2:43-2:57 内的 1s 粒度曲线细节
print("\n== 2:40-2:58 的 1s RMS 细节 ==")
for t1 in range(160, min(178, int(dur))):
    seg = x[t1*sr:(t1+1)*sr]
    if len(seg) < sr: break
    print(f"{t1//60:02d}:{t1%60:02d}  {rms_db(seg):7.2f}")
