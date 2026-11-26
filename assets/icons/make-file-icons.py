#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工程文件 / 歌手文件的图标生成器。

源图在 assets/icons/src/：
    project.png  已扣好，透明底
    singer.png   纯白底，需要抠

两张图都是竖版"文件卡片"，但比例与留白不同（project 内容 714x773，singer
1039x1203）。这里做统一：裁到内容边界 → 缩放到同一高度 → 居中放进 1024 方图，
这样在资源管理器里两个图标的大小和重心一致。

singer 的白底处理
------------------
不能简单地"白色变透明"，因为卡片右上角的折角本身就是近白色，会被一起抠穿。
所以先用 flood fill 从四角把**与画布边缘连通的**近白区域标出来，只把这块设为
透明；卡片内部的白（折角、标签）不与边缘连通，自然保留。

抠完的边缘会残留 1px 白边（原图的抗锯齿像素是白色与橙色的混合）。两步修：
    · 对 alpha 做 1.2px 高斯模糊，让边界变软；
    · 再用最近邻把半透明像素的颜色替换成最近的实心像素颜色（去边 / decontaminate），
      否则那块白色在深色背景上会勾出一条亮线。

用法：
    python3 assets/icons/make-file-icons.py
输出 assets/fileicons/。
"""
import os
import struct
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(ROOT, "assets", "fileicons")

CANVAS = 1024
CONTENT_H = 932          # 内容高度占画布 91%，上下各留 46 —— 资源管理器里不会顶格
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
# 预览页要按真实像素贴图；ico 里的帧不便于 <img>，所以另存一份 png
PREVIEW_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128]
ICNS_TYPES = {
    b"icp4": 16, b"icp5": 32, b"icp6": 64,
    b"ic07": 128, b"ic08": 256, b"ic09": 512, b"ic10": 1024,
    b"ic11": 32, b"ic12": 64, b"ic13": 256, b"ic14": 512,
}


def cut_white(rgb: np.ndarray) -> np.ndarray:
    """白底 → alpha。只抠与画面边缘连通的近白区域。"""
    # 边界容差 18：原图左/上边缘有一条 1px 的浅灰导出边，只用 d<=4 会把它
    # 判成"内容"，整块背景就抠不掉，裁切也跟着错。
    d = 255 - rgb.min(axis=2)
    whiteish = d <= 18
    whiteish = ndimage.binary_opening(whiteish, structure=np.ones((3, 3)))
    lab, n = ndimage.label(whiteish)
    # 取四角所在的连通块（角上必然是背景）
    corners = {lab[0, 0], lab[0, -1], lab[-1, 0], lab[-1, -1]}
    corners.discard(0)
    outside = np.isin(lab, [c for c in corners if c > 0])

    alpha = np.where(outside, 0.0, 1.0)
    # 羽化：先模糊，再压到 [0,1]
    alpha = ndimage.gaussian_filter(alpha, 0.9)
    alpha = np.clip(alpha, 0.0, 1.0)

    # 去边：半透明像素取最近实心像素的颜色
    solid = alpha > 0.98
    if solid.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
        rgb = rgb[iy, ix]
    return np.dstack([rgb, (alpha * 255).round().astype(np.uint8)])


def load(name: str) -> Image.Image:
    im = Image.open(os.path.join(SRC, f"{name}.png"))
    if name == "singer":
        arr = cut_white(np.array(im.convert("RGB")))
        im = Image.fromarray(arr, "RGBA")
    else:
        im = im.convert("RGBA")

    a = np.array(im)[:, :, 3]
    ys, xs = np.nonzero(a > 8)
    im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

    w, h = im.size
    scale = CONTENT_H / h
    im = im.resize((max(1, round(w * scale)), CONTENT_H), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(im, ((CANVAS - im.width) // 2, (CANVAS - im.height) // 2), im)
    return canvas


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


def main():
    os.makedirs(OUT, exist_ok=True)
    for name in ("project", "singer"):
        big = load(name)
        big.save(os.path.join(OUT, f"{name}.png"))
        for s in PREVIEW_SIZES:
            big.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, f"{name}-{s}.png"))

        # ICO：Windows 会按尺寸挑最合适的一张，所以每档单独重采样而不是让系统缩
        frames = []
        for s in ICO_SIZES:
            frames.append(big.resize((s, s), Image.LANCZOS))
        frames[-1].save(os.path.join(OUT, f"{name}.ico"), format="ICO",
                        sizes=[(s, s) for s in ICO_SIZES],
                        append_images=frames[:-1])

        # icns 需要独立的 png 文件
        tmp = {}
        for s in (16, 32, 64, 128, 256, 512, 1024):
            p = os.path.join(OUT, f"_tmp_{name}_{s}.png")
            big.resize((s, s), Image.LANCZOS).save(p)
            tmp[s] = p
        write_icns(os.path.join(OUT, f"{name}.icns"), lambda s: tmp[s])
        for p in tmp.values():
            os.remove(p)
        print(f"{name}: {big.size}")


if __name__ == "__main__":
    main()
