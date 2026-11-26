# -*- coding: utf-8 -*-
"""在 ModelScope 仓库的分支 HEAD 上打一个 lightweight tag（发布版本用）。

为什么不用 HubApi.create_model_tag
    该接口在部分仓库/账号上直接 403（平台侧限制），而 git push tag 可用。
    为了不下载几 GB 的模型，fetch 时用 `--filter=blob:none --depth=1`；
    tag 只需要 commit 对象，服务端已有全部 blob。

用法:
    python tools/ms_tag_release.py --repo syxppp/SoulX-Singer-onnx-directml-fp16 --tag v4
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

GIT_HOST = 'www.modelscope.cn'


def run_git(argv, cwd=None, check=False):
    return subprocess.run(['git', *argv], cwd=cwd, capture_output=True, text=True, check=check)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--branch', default='master')
    args = ap.parse_args()

    token = os.environ.get('MODELSCOPE_API_TOKEN') or os.environ.get('MODELSCOPE_ACCESS_TOKEN')
    if not token:
        print('MODELSCOPE_API_TOKEN missing', file=sys.stderr)
        return 2

    from modelscope.hub.api import HubApi
    api = HubApi()
    login = api.login(token)
    git_token = login[0] if isinstance(login, (tuple, list)) and login else login
    if not isinstance(git_token, str) or not git_token:
        print('login did not return a git token', file=sys.stderr)
        return 1

    work = tempfile.mkdtemp(prefix='mstag-')
    auth_url = f'https://{args.repo.split("/")[0]}:{git_token}@{GIT_HOST}/{args.repo}.git'
    try:
        run_git(['init', '-q'], cwd=work, check=True)
        run_git(['remote', 'add', 'origin', auth_url], cwd=work, check=True)
        print(f'[tag] fetching {args.branch} (blob-filtered) ...', flush=True)
        f = run_git(['fetch', '--depth=1', '--filter=blob:none', 'origin',
                     f'refs/heads/{args.branch}'], cwd=work)
        if f.returncode != 0:
            print(f'fetch failed: {f.stderr[-400:]}', file=sys.stderr)
            return 1
        sha = run_git(['rev-parse', 'FETCH_HEAD'], cwd=work, check=True).stdout.strip()
        print(f'[tag] {args.branch} HEAD = {sha[:9]}')

        run_git(['tag', '-f', args.tag, sha], cwd=work, check=True)
        p = run_git(['push', '--force', 'origin', f'refs/tags/{args.tag}:refs/tags/{args.tag}'], cwd=work)
        if p.returncode != 0:
            print(f'tag push failed: {p.stderr[-400:]}', file=sys.stderr)
            return 1

        ls = run_git(['ls-remote', f'https://{GIT_HOST}/{args.repo}.git'])
        refs = {}
        for line in ls.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2:
                refs[parts[1]] = parts[0]
        tag_sha = refs.get(f'refs/tags/{args.tag}')
        head_sha = refs.get(f'refs/heads/{args.branch}')
        if tag_sha != head_sha:
            print(f'TAG MISMATCH: tag={tag_sha} head={head_sha}', file=sys.stderr)
            return 1
        print(f'[tag] OK: {args.tag} -> {args.branch} HEAD ({head_sha[:9]})')
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
