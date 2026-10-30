#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SXSEditor 应用图标生成器 —— P 形音符。

设计说明
--------
符号是一个四分音符：斜椭圆符头在符干左下，符干竖直向上。符干顶端右侧不是乐谱
里那道飘起来的"旗"，而是一个 D 形环——它占据的正是旗的位置，同时是字母 P 的
肚子。于是一个标记同时读作：

    音符   这是一个做歌声合成的工具
    P      Producer / P 主；也是产品名的首字母

两者共用同一条几何：竖干既是符干也是 P 的竖笔，D 环既是旗也是 P 的碗。不画人脸、
不画头发，靠结构而不是靠比喻去暗示主题，所以不会幼稚，也不依赖"看懂梗"才成立。

三种做法（差别只在环的厚度与实现方式）：
    solid   实心 D 环，环宽 70，小尺寸下仍是一块干净的形
    ring    细环，环宽 44，最轻、最线性
    line    单线笔画：竖干与环一笔连成，stroke 圆头

用法：
    python3 assets/icons/generate_p_icon.py            # 全尺寸 + ico/icns + 预览页
    python3 assets/icons/generate_p_icon.py --quick    # 只出 16/32/256 看稿
输出到 assets/icons/candidates/，不碰 assets/SXS.*。
"""
import math
import os
import struct
import sys

import cairosvg

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "candidates")
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024]
QUICK_SIZES = [16, 32, 256]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ----------------------------------------------------------------- 几何
# 全部在 1024 画布上定义，最后整体 fit 到视觉中心（见 compute_fit）。
HEAD = dict(cx=330, cy=760, rx=122, ry=88, rot=-22)
STEM_X0, STEM_X1 = 386, 446          # 右缘 446 = 符头旋转后的右缘
STEM_TOP, STEM_BOT = 250, 762

BOWL_CY, BOWL_R = 410, 160           # D 环：圆心在竖干右缘 (446, 410)
BOWL_CX = STEM_X1

INK_COLOR = "#FBFDFF"                # 单色。符号内部一旦用渐变，各元素按自身 bbox
                                     # 归一化就会出色差接缝；扁平单色反而干净。

PALETTES = {
    "aurora": dict(plate=("#31407A", "#1B2444", "#111730"), glow=("#6E8FE0", 0.16)),
    "ink": dict(plate=("#1E2646", "#1E2646", "#1E2646"), glow=None),
    "brand": dict(plate=("#5A8BF2", "#4C79E4", "#3A5FD0"), glow=None),
}


def squircle(cx, cy, rx, ry, n=4.2, steps=240):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        pts.append((cx + rx * math.copysign(abs(ct) ** (2 / n), ct),
                    cy + ry * math.copysign(abs(st) ** (2 / n), st)))
    return "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"


PLATE = squircle(512, 512, 476, 476, 4.2)


def _stem(top=STEM_TOP, bot=STEM_BOT):
    return f'<rect x="{STEM_X0}" y="{top}" width="{STEM_X1 - STEM_X0}" height="{bot - top}"/>'


def _half_disc_solid(ring):
    """D 形环：右半圆减内半圆，左侧由竖干补齐。evenodd 一次成环。"""
    r_out, r_in = BOWL_R, BOWL_R - ring
    top, bot = BOWL_CY - r_out, BOWL_CY + r_out
    top_in, bot_in = BOWL_CY - r_in, BOWL_CY + r_in
    d = (f'M {BOWL_CX} {top} A {r_out} {r_out} 0 0 1 {BOWL_CX} {bot} Z '
         f'M {BOWL_CX} {top_in} A {r_in} {r_in} 0 0 1 {BOWL_CX} {bot_in} Z')
    return f'<path d="{d}" fill-rule="evenodd"/>'


def _head():
    h = HEAD
    return (f'<ellipse cx="{h["cx"]}" cy="{h["cy"]}" rx="{h["rx"]}" ry="{h["ry"]}" '
            f'transform="rotate({h["rot"]} {h["cx"]} {h["cy"]})"/>')


def bowl_solid():
    return _stem() + _half_disc_solid(70) + _head()


def bowl_ring():
    return _stem() + _half_disc_solid(44) + _head()


def bowl_line():
    """一笔：符干直上，到顶绕成右半圆，再落回符干中线。"""
    r = BOWL_R + 5
    cx = (STEM_X0 + STEM_X1) / 2
    d = (f"M {cx} {STEM_BOT} V {BOWL_CY - r} "
         f"A {r} {r} 0 0 1 {cx} {BOWL_CY + r}")
    return (f'<path d="{d}" fill="none" stroke="{INK_COLOR}" stroke-width="{STEM_X1 - STEM_X0}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>') + _head()


BOWLS = {
    "solid": (bowl_solid, "实心 D 环 · 环宽 70"),
    "ring": (bowl_ring, "细环 · 环宽 44，最轻"),
    "line": (bowl_line, "单线 · 一笔连成"),
}

TARGET = 660          # 符号最长边占画布的比例目标（px @1024）


def _bbox(variant):
    """把符号单独渲染一次，量出真实包围盒（比手算可靠）。"""
    body = BOWLS[variant][0]().replace("{INK_COLOR}", "#000")
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
           'width="512" height="512"><g fill="#000" stroke="#000">'
           + body + '</g></svg>')
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=512, output_height=512)
    from io import BytesIO
    from PIL import Image
    bb = Image.open(BytesIO(png)).convert("RGBA").split()[-1].getbbox()
    k = 1024 / 512
    return [v * k for v in bb]


_FITS = {}


def compute_fit(variant):
    if variant not in _FITS:
        x0, y0, x1, y1 = _bbox(variant)
        s = TARGET / max(x1 - x0, y1 - y0)
        # 缩放后把 bbox 中心对到画布中心；符头偏重，整体上移 8px
        _FITS[variant] = (f"translate({512 - s * (x0 + x1) / 2:.2f},"
                          f"{512 - 8 - s * (y0 + y1) / 2:.2f}) scale({s:.4f})")
    return _FITS[variant]


# ----------------------------------------------------------------- 组装
def build_svg(variant, palette="aurora"):
    pal = PALETTES[palette]
    c0, c1, c2 = pal["plate"]
    if len({c0, c1, c2}) > 1:
        plate_grad = (f'<linearGradient id="plate" x1="0" y1="0" x2="0.75" y2="1">'
                      f'<stop offset="0" stop-color="{c0}"/>'
                      f'<stop offset="0.55" stop-color="{c1}"/>'
                      f'<stop offset="1" stop-color="{c2}"/></linearGradient>')
    else:
        plate_grad = f'<linearGradient id="plate"><stop offset="0" stop-color="{c0}"/></linearGradient>'

    if pal["glow"]:
        gc, go = pal["glow"]
        glow = (f'<radialGradient id="glow" cx="0.5" cy="0.4" r="0.62">'
                f'<stop offset="0" stop-color="{gc}" stop-opacity="{go}"/>'
                f'<stop offset="0.7" stop-color="{gc}" stop-opacity="0.03"/>'
                f'<stop offset="1" stop-color="{gc}" stop-opacity="0"/></radialGradient>')
        glow_rect = '<g clip-path="url(#clip)"><rect width="1024" height="1024" fill="url(#glow)"/></g>'
    else:
        glow, glow_rect = "", ""

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" '
        'role="img" aria-label="SXSEditor">'
        '<title>SXSEditor</title>'
        f'<defs>{plate_grad}{glow}'
        f'<clipPath id="clip"><path d="{PLATE}"/></clipPath></defs>'
        f'<path d="{PLATE}" fill="url(#plate)" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="6"/>'
        + glow_rect
        + f'<g transform="{compute_fit(variant)}" fill="{INK_COLOR}" stroke="none">'
        + BOWLS[variant][0]() + '</g>'
        + '</svg>'
    )


ICNS_TYPES = {
    b"icp4": 16, b"icp5": 32, b"icp6": 64,
    b"ic07": 128, b"ic08": 256, b"ic09": 512, b"ic10": 1024,
    b"ic11": 32, b"ic12": 64, b"ic13": 256, b"ic14": 512,
}


def write_icns(path, png_for):
    body = b""
    for code, size in ICNS_TYPES.items():
        p = png_for(size)
        if not os.path.exists(p):
            continue
        data = open(p, "rb").read()
        body += code + struct.pack(">I", len(data) + 8) + data
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main(argv):
    from PIL import Image

    quick = "--quick" in argv
    sizes = QUICK_SIZES if quick else SIZES
    os.makedirs(OUT, exist_ok=True)

    for variant in BOWLS:
        for palette in PALETTES:
            svg = build_svg(variant, palette)
            name = f"p-{variant}" if palette == "aurora" else f"p-{variant}-{palette}"
            with open(os.path.join(OUT, f"{name}.svg"), "w", encoding="utf-8") as f:
                f.write(svg + "\n")
            for s in sizes:
                cairosvg.svg2png(bytestring=svg.encode(),
                                 write_to=os.path.join(OUT, f"{name}-{s}.png"),
                                 output_width=s, output_height=s)

        base = f"p-{variant}"
        Image.open(os.path.join(OUT, f"{base}-256.png")).save(
            os.path.join(OUT, f"{base}.ico"), format="ICO", sizes=[(s, s) for s in ICO_SIZES])
        if not quick:
            write_icns(os.path.join(OUT, f"{base}.icns"),
                       lambda s, b=base: os.path.join(OUT, f"{b}-{s}.png"))
        print(f"{base}: fit={compute_fit(variant)}")


if __name__ == "__main__":
    main(sys.argv[1:])
