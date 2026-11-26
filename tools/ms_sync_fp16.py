# -*- coding: utf-8 -*-
"""把本地 onnx_models/fp16 同步到 ModelScope 的 fp16 仓库，并按需打 tag。

只上传与远端 master 不同的文件（size + sha256 双重比对），避免每次都推 1.4 GB。
本地的一些遗留文件（未使用的 .data、JP 子目录）默认不上传，用 --include 显式加。

用法:
    # 只看差异
    python tools/ms_sync_fp16.py --dry-run
    # 上传差异文件
    python tools/ms_sync_fp16.py --push
    # 上传后打 v4 tag
    python tools/ms_sync_fp16.py --push --tag v4
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

from modelscope.hub.api import HubApi

REPO = 'syxppp/SoulX-Singer-onnx-directml-fp16'
LOCAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'onnx_models', 'fp16')
# 本地存在但不是仓库内容：未使用的外部数据、JP 子模型（单独仓库）、本地版本戳
SKIP = {
    '.msc',
    'version.json',
    'diff_step_dml.onnx.data',          # diff_step 是自包含的，这份是历史遗留
    'sifigan_vocoder.onnx.data',        # sifigan 不在该仓库
    'sifigan_vocoder_dml_mlp.onnx.data',
    'preprocess/rmvpe_mel.onnx.data',   # rmvpe_mel 自包含，这份是遗留
    'preprocess/README.md',             # 远端有更详细的版本，别用本地短版覆盖
}


def sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(chunk), b''):
            h.update(block)
    return h.hexdigest()


def collect_local(include_extra: list[str]) -> list[str]:
    out = []
    for root, _, names in os.walk(LOCAL_DIR):
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, LOCAL_DIR).replace('\\', '/')
            if rel.startswith('JP/'):
                continue
            if rel in SKIP and rel not in include_extra:
                continue
            out.append(rel)
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--push', action='store_true')
    ap.add_argument('--tag', default='')
    ap.add_argument('--include', nargs='*', default=[])
    ap.add_argument('--message', default='Publish FP16 v4: mel_transform FP32, vocoder W16A32')
    args = ap.parse_args()

    token = os.environ.get('MODELSCOPE_API_TOKEN')
    if not token:
        print('MODELSCOPE_API_TOKEN missing', file=sys.stderr)
        return 2
    api = HubApi()
    api.login(token)

    remote = {f['Path']: f for f in api.get_model_files(args.repo, revision='master', recursive=True)
              if f.get('Type') == 'blob'}
    local = collect_local(args.include)

    upload = []
    print(f"{'path':48s} {'local':>12s} {'remote':>12s}  status")
    for rel in local:
        full = os.path.join(LOCAL_DIR, rel)
        size = os.path.getsize(full)
        r = remote.get(rel)
        if not r:
            print(f"{rel:48s} {size:12d} {'-':>12s}  NEW")
            upload.append(rel)
            continue
        if r['Size'] != size:
            print(f"{rel:48s} {size:12d} {r['Size']:12d}  SIZE-DIFF")
            upload.append(rel)
            continue
        if sha256(full) != r.get('Sha256'):
            print(f"{rel:48s} {size:12d} {r['Size']:12d}  HASH-DIFF")
            upload.append(rel)
        else:
            print(f"{rel:48s} {size:12d} {r['Size']:12d}  same")

    for rel, r in remote.items():
        if rel not in local:
            print(f"{rel:48s} {'-':>12s} {r['Size']:12d}  REMOTE-ONLY")

    total = sum(os.path.getsize(os.path.join(LOCAL_DIR, r)) for r in upload)
    print(f"\n{len(upload)} file(s) to upload, {total / 1024 / 1024:.1f} MB")
    if not upload or args.dry_run or not args.push:
        return 0

    for rel in upload:
        full = os.path.join(LOCAL_DIR, rel)
        size_mb = os.path.getsize(full) / 1024 / 1024
        print(f"[upload] {rel} ({size_mb:.1f} MB) ...", flush=True)
        api.upload_file(path_or_fileobj=full, path_in_repo=rel, repo_id=args.repo,
                        commit_message=args.message)
        print(f"[upload] {rel} done", flush=True)

    if args.tag:
        print(f"[tag] creating {args.tag} ...", flush=True)
        try:
            api.create_model_tag(args.repo, args.tag)
            print(f"[tag] {args.tag} created")
        except Exception as exc:  # SDK 该接口在部分仓库上不可用
            print(f"[tag] create_model_tag failed: {exc}", file=sys.stderr)
            print('[tag] fallback: git push lightweight tag (see tools/ms_delete_files.py)')
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
