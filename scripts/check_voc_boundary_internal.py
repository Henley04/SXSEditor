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
    n = len(raw) // 4
    x = struct.unpack('<%df' % n, raw)
    if ch > 1: x = x[::ch]
    return sr, x

def rms_db(seg):
    s = 0.0
    for v in seg: s += v * v
    return 10 * math.log10(s / len(seg) + 1e-12)

for name in ['ab_voc_boundary_a.wav', 'ab_voc_boundary_b.wav']:
    sr, x = read_wav_f32(name)
    dur = len(x) / sr
    print(f"\n===== {name}: {dur:.2f}s =====")
    # 写回边界：(k*1024-32)*480 样本 = 20.48k-0.64s；k=1,2 -> 19.84s, 40.32s
    # （chunk2 [1984,2133) 写回起点 1984*480/24000=39.68s）
    B = 20.48
    print("== 边界 ±0.5s 窗 vs 前后基线（内部对照，排除拼接点±1s）==")
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
    # 100ms 粒度的边界附近细节
    for tb in [19.84, 39.68]:
        print(f"-- 边界 {tb}s 附近 100ms RMS --")
        i0 = int(tb * sr)
        win = int(0.1 * sr)
        vals = []
        for k in range(-8, 10):
            seg = x[i0 + k*win: i0 + (k+1)*win]
            if len(seg) < win: break
            vals.append(rms_db(seg))
        lo = min(vals)
        for k, v in enumerate(vals):
            t = tb + (k - 8) * 0.1
            bar = '#' * max(0, int((v - lo) / 0.5))
            mark = ' <-overlap' if 0 <= k < 7 else ''
            print(f"  {t:7.2f}s {v:7.2f} {bar}{mark}")
