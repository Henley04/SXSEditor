#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SXSEditor 应用图标生成器。

设计：八分音符。符头是斜椭圆，符干笔直；符尾从符干顶端扬起、向右划一道
长弧再垂落——它既是乐谱里的"旗"，也是被风吹起的一缕长发。这一层双关用来
表达"虚拟歌姬"，靠动势而不是五官，所以不会显得幼稚。

配色取自应用内置的三套主题：
  aurora  默认 Aurora Dark（蓝紫）——主推
  ink     纯扁平，深底 + 单色符号
  brand   品牌亮蓝底，任务栏里最容易找到

用法：
    python3 assets/icons/generate.py
依赖 cairosvg（仅用于导出位图，SVG 本身自包含）。
"""
import math
import os

import cairosvg

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ----------------------------------------------------------------- 基础几何
def squircle(cx, cy, rx, ry, n=4.2, steps=180):
    """超椭圆：iOS / Windows 11 那种圆润方形底板。"""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = cx + rx * math.copysign(abs(ct) ** (2 / n), ct)
        y = cy + ry * math.copysign(abs(st) ** (2 / n), st)
        pts.append((x, y))
    return "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"


def _bez(p0, p1, p2, p3, t):
    mt = 1 - t
    return (mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0],
            mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1])


def _tangent(p0, p1, p2, p3, t, eps=1e-4):
    a = _bez(p0, p1, p2, p3, max(0.0, t - eps))
    b = _bez(p0, p1, p2, p3, min(1.0, t + eps))
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1.0
    return dx / L, dy / L


def _width_at(profile, t):
    for i in range(len(profile) - 1):
        t0, w0 = profile[i]
        t1, w1 = profile[i + 1]
        if t <= t1:
            k = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return w0 + (w1 - w0) * k
    return profile[-1][1]


def _cap(t, t_start=0.9):
    """末端椭圆收尾：避免平切，同时保留"收尖"的观感。"""
    if t <= t_start:
        return 1.0
    k = (t - t_start) / (1.0 - t_start)
    return math.sqrt(max(0.0, 1.0 - k * k))


def ribbon(p0, p1, p2, p3, profile, steps=80):
    """沿三次贝塞尔扫出宽度按 profile 变化的飘带。"""
    left, right = [], []
    for i in range(steps + 1):
        t = i / steps
        cx, cy = _bez(p0, p1, p2, p3, t)
        tx, ty = _tangent(p0, p1, p2, p3, t)
        w = _width_at(profile, t) * _cap(t) / 2.0
        left.append((cx - ty * w, cy + tx * w))
        right.append((cx + ty * w, cy - tx * w))
    pts = left + right[::-1]
    return "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"


PLATE = squircle(512, 512, 476, 476, 4.2)

# 音符几何（1024 画布，最后整体 fit 到视觉中心）
INK = "#FBFDFF"
HEAD = dict(cx=400, cy=702, rx=112, ry=80, rot=-20)
STEM_X, STEM_W = 464, 44          # 右缘 508 ≈ 符头旋转后的右缘 508.7
STEM_TOP, STEM_BOT = 322, 700

# 符尾中心线：起点切线严格竖直，使根部截面与符干顶边严丝合缝；
# 随后向右扬、再垂落。
T0 = (STEM_X + STEM_W / 2, STEM_TOP + 10)
T1 = (STEM_X + STEM_W / 2, STEM_TOP - 40)
T2 = (828, 372)
T3 = (802, 726)

# 宽度剖面：开头保持与符干等宽，且扩宽必须晚于中心线右移，
# 否则左缘会反向鼓出一个"帽檐"。
TAIL_PROFILE = [(0.0, 44), (0.18, 44), (0.40, 70), (0.62, 58), (0.88, 30), (1.0, 9)]

PALETTES = {
    "aurora": dict(
        label="Aurora（主推）",
        plate=('#2E3A6B', '#1B2444', '#121831'),
        tail='<stop offset="0" stop-color="#FBFDFF"/><stop offset="0.2" stop-color="#FBFDFF"/>'
             '<stop offset="0.42" stop-color="#CBDCFF"/><stop offset="0.7" stop-color="#7DA2F7"/>'
             '<stop offset="1" stop-color="#4FD0E6"/>',
        glow=True,
    ),
    "ink": dict(
        label="Ink（纯扁平）",
        plate=('#1E2646', '#1E2646', '#1E2646'),
        tail='<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF"/>',
        glow=False,
    ),
    "brand": dict(
        label="Brand（亮色）",
        plate=('#5A8BF2', '#4C79E4', '#3A5FD0'),
        tail='<stop offset="0" stop-color="#FFFFFF"/><stop offset="0.2" stop-color="#FFFFFF"/>'
             '<stop offset="0.45" stop-color="#CFE0FF"/><stop offset="0.75" stop-color="#9FD8F0"/>'
             '<stop offset="1" stop-color="#7FE3EE"/>',
        glow=False,
    ),
}


def build_svg(key):
    pal = PALETTES[key]
    c0, c1, c2 = pal["plate"]
    if len({c0, c1, c2}) > 1:
        grad = (f'<linearGradient id="plate" x1="0" y1="0" x2="0.75" y2="1">'
                f'<stop offset="0" stop-color="{c0}"/>'
                f'<stop offset="0.55" stop-color="{c1}"/>'
                f'<stop offset="1" stop-color="{c2}"/></linearGradient>')
    else:
        grad = f'<linearGradient id="plate"><stop offset="0" stop-color="{c0}"/></linearGradient>'

    glow_def = ('<radialGradient id="glow" cx="0.5" cy="0.42" r="0.62">'
                '<stop offset="0" stop-color="#6E8FE0" stop-opacity="0.20"/>'
                '<stop offset="0.7" stop-color="#4E6BC0" stop-opacity="0.03"/>'
                '<stop offset="1" stop-color="#4E6BC0" stop-opacity="0"/></radialGradient>'
                if pal["glow"] else '')

    defs = (f'{grad}<linearGradient id="tail" x1="0.02" y1="0.1" x2="0.9" y2="1">'
            f'{pal["tail"]}</linearGradient>{glow_def}')

    tail = ribbon(T0, T1, T2, T3, TAIL_PROFILE)
    stem = (f'M {STEM_X} {STEM_TOP} L {STEM_X + STEM_W} {STEM_TOP} '
            f'L {STEM_X + STEM_W} {STEM_BOT} L {STEM_X} {STEM_BOT} Z')

    parts = [
        f'<path d="{PLATE}" fill="url(#plate)" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="6"/>',
    ]
    if pal["glow"]:
        parts.append('<g clip-path="url(#clip)"><rect width="1024" height="1024" fill="url(#glow)"/></g>')
    parts.append(
        '<g transform="translate(508,498) scale(1.12) translate(-520,-520)">'
        f'<path d="{tail}" fill="url(#tail)"/>'
        f'<path d="{stem}" fill="{INK}"/>'
        f'<ellipse cx="{HEAD["cx"]}" cy="{HEAD["cy"]}" rx="{HEAD["rx"]}" ry="{HEAD["ry"]}" '
        f'transform="rotate({HEAD["rot"]} {HEAD["cx"]} {HEAD["cy"]})" fill="{INK}"/></g>')

    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
            f'width="1024" height="1024" role="img" aria-label="SXSEditor">'
            f'<title>SXSEditor</title><defs>{defs}'
            f'<clipPath id="clip"><path d="{PLATE}"/></clipPath></defs>'
            + "".join(parts) + '</svg>')


# macOS .icns 里各元素对应的像素尺寸
ICNS_TYPES = {
    b"icp4": 16, b"icp5": 32, b"icp6": 64,
    b"ic07": 128, b"ic08": 256, b"ic09": 512, b"ic10": 1024,
    b"ic11": 32, b"ic12": 64, b"ic13": 256, b"ic14": 512,
}


def write_icns(path):
    """按 icns 容器格式打包（4 字节类型 + 4 字节长度 + PNG 数据）。"""
    import struct
    body = b""
    for code, size in ICNS_TYPES.items():
        png = os.path.join(HERE, f"sxseditor-aurora-{size}.png")
        if not os.path.exists(png):
            continue
        data = open(png, "rb").read()
        body += code + struct.pack(">I", len(data) + 8) + data
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    return path


def main():
    from PIL import Image

    written = []
    for key in PALETTES:
        svg = build_svg(key)
        sp = os.path.join(HERE, f"sxseditor-{key}.svg")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(svg + "\n")
        written.append(os.path.basename(sp))

        pngs = []
        for s in SIZES:
            pp = os.path.join(HERE, f"sxseditor-{key}-{s}.png")
            cairosvg.svg2png(bytestring=svg.encode(), write_to=pp,
                             output_width=s, output_height=s)
            pngs.append(pp)
        # macOS 图标容器
        if key == "aurora":
            write_icns(os.path.join(HERE, "sxseditor-aurora.icns"))
            written.append("sxseditor-aurora.icns")
        # Windows 图标：多尺寸打包
        if key == "aurora":
            ico = os.path.join(HERE, "sxseditor-aurora.ico")
            Image.open(os.path.join(HERE, f"sxseditor-{key}-256.png")).save(
                ico, format="ICO",
                sizes=[(s, s) for s in ICO_SIZES])
            written.append(os.path.basename(ico))
        written.append(f"sxseditor-{key}-*.png ({len(pngs)} sizes)")
    print("\n".join(written))


if __name__ == "__main__":
    main()
