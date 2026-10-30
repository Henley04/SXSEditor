#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SXSEditor 应用图标 —— 橙黄声波（圆角外框版）。

原稿是一张白底方图：橙色圆盘 + 七根奶油白声波柱，圆盘左右各溢出两枚小
胶囊。这一版只做两件事，设计本身不动：

1. 外框（画布的四边四角）改成圆角，导出就是一张圆角卡片，四角透明。
2. 内容重新配比。原稿圆盘直径占画布 56%，放进圆角卡片后上下会空出一大块；
   放大到 62%，横向由两枚溢出胶囊撑到 88%，四边留白收得比较紧——声波本来
   就是横向的，纵向留白多一点是正常的。

几何直接取自原稿（1254 画布）实测像素，不做重画：
    圆盘   直径 706，圆心 (626.5, 607.5)
    主条   7 根，中心距 80，宽 49~57，高 112/199/263/386/262/172/108
    内胶囊 48 x 118，距圆边 22
    外胶囊 71 x 56（横躺的椭圆），距内胶囊 20

整体按 0.90 缩放后居中到 1024 画布。

用法：
    python3 assets/icons/generate_wave_icon.py
输出 assets/icons/wave/ 与正式路径 assets/SXS.*。
"""
import math
import os
import struct
import sys

import cairosvg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "wave")
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024, 2000]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ----------------------------------------------------------------- 颜色
CREAM = "#FDF8E6"
AMBER = "#FBB92E"
ORANGE = "#FD662E"
EMBER_A = "#FB6A34"
EMBER_B = "#F85B22"
CAP_IN_COLOR = "#FCB029"      # 圆盘外的小段：原稿里它们是橙色，不是奶油白
CAP_OUT_COLOR = "#FCA824"
CARD = "#FFFFFF"

# ----------------------------------------------------------------- 原稿坐标
SRC = 1254.0
DISC = dict(cx=626.5, cy=607.5, r=353.0)
BARS = [  # (中心 x, 宽, 高)
    (389.0, 49, 112),
    (466.0, 55, 199),
    (547.0, 57, 263),
    (627.5, 56, 386),
    (707.5, 56, 262),
    (787.5, 54, 172),
    (864.0, 49, 108),
]
CAP_IN = dict(cx=237.5, w=48, h=118)     # 左内胶囊中心 x
CAP_OUT = dict(cx=159.0, w=71, h=56)     # 左外胶囊（横椭圆）

SCALE = 0.95
W = 1024
TX = W / 2 - DISC["cx"] * SCALE
TY = W / 2 - DISC["cy"] * SCALE


def squircle(cx, cy, rx, ry, n=4.2, steps=240):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        pts.append((cx + rx * math.copysign(abs(ct) ** (2 / n), ct),
                    cy + ry * math.copysign(abs(st) ** (2 / n), st)))
    return "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"


CARD_PATH = squircle(512, 512, 512, 512, 4.2)


def _capsule(cx, cy, w, h, fill):
    r = min(w, h) / 2
    return (f'<rect x="{cx - w / 2:.1f}" y="{cy - h / 2:.1f}" width="{w}" '
            f'height="{h}" rx="{r}" ry="{r}" fill="{fill}"/>')


def bars():
    d = DISC
    out = [_capsule(cx, d["cy"], w, h, CREAM) for cx, w, h in BARS]
    # 两侧溢出的小段：按原稿 x 关于圆盘中心镜像
    for cfg, fill in ((CAP_IN, CAP_IN_COLOR), (CAP_OUT, CAP_OUT_COLOR)):
        for sgn in (-1, 1):
            cx = d["cx"] + sgn * abs(cfg["cx"] - d["cx"])
            out.append(_capsule(cx, d["cy"], cfg["w"], cfg["h"], fill))
    return "".join(out)


def build_svg():
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" '
        'width="1024" height="1024" role="img" aria-label="SXSEditor">'
        '<title>SXSEditor</title><defs>'
        '<linearGradient id="disc" x1="0.1" y1="0" x2="0.9" y2="1">'
        f'<stop offset="0" stop-color="{AMBER}"/>'
        f'<stop offset="1" stop-color="{ORANGE}"/></linearGradient>'
        '<linearGradient id="ember" x1="0.2" y1="0" x2="0.8" y2="1">'
        f'<stop offset="0" stop-color="{EMBER_A}"/>'
        f'<stop offset="1" stop-color="{EMBER_B}"/></linearGradient>'
        f'<clipPath id="disc_clip"><circle cx="{DISC["cx"]}" cy="{DISC["cy"]}" r="{DISC["r"]}"/></clipPath>'
        '</defs>'
        # 圆角白卡
        f'<path d="{CARD_PATH}" fill="{CARD}"/>'
        f'<g transform="translate({TX:.2f},{TY:.2f}) scale({SCALE})">'
        # 橙色圆盘
        f'<circle cx="{DISC["cx"]}" cy="{DISC["cy"]}" r="{DISC["r"]}" fill="url(#disc)"/>'
        # 右下深色月牙：一个很大的圆压上去，边缘自然是一段平滑弧
        '<g clip-path="url(#disc_clip)">'
        '<circle cx="1180" cy="1225" r="800" fill="url(#ember)"/></g>'
        # 声波
        f'<g fill="{CREAM}">{bars()}</g>'
        '</g>'
        # 卡片边缘：极淡描边，避免在浅色桌面上与背景糊在一起
        f'<path d="{CARD_PATH}" fill="none" stroke="#000000" stroke-opacity="0.06" stroke-width="4"/>'
        '</svg>'
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

    os.makedirs(OUT, exist_ok=True)
    svg = build_svg()
    with open(os.path.join(OUT, "sxseditor.svg"), "w", encoding="utf-8") as f:
        f.write(svg + "\n")

    for s in SIZES:
        cairosvg.svg2png(bytestring=svg.encode(),
                         write_to=os.path.join(OUT, f"sxseditor-{s}.png"),
                         output_width=s, output_height=s)

    Image.open(os.path.join(OUT, "sxseditor-256.png")).save(
        os.path.join(OUT, "sxseditor.ico"), format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    write_icns(os.path.join(OUT, "sxseditor.icns"),
               lambda s: os.path.join(OUT, f"sxseditor-{s}.png"))
    print("ok")


if __name__ == "__main__":
    main(sys.argv[1:])
