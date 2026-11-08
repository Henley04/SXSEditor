"""通过 git 提交删除 ModelScope 仓库里的文件（平台已封禁 API 删除）。

为什么不用 HubApi.delete_files()
    实测远端直接拒绝（同一个 token 上传 600MB 文件是成功的）：
      401 {"Code":10010101003,
           "Message":"the current token no longer supports deletion operations.
                      Please go to the site page : https://www.modelscope.cn to delete"}
    换成 cookies 认证、raw token、/repo 端点、POST /file/delete 全部不通。
    所以删除只能走 git：推一个"去掉这些条目"的 commit。

怎么做到不下载几 GB 的模型
    仓库里全是大文件（int8 仓库 ~1.6 GB），普通浅克隆会把 blob 全拉下来。
    这里用 `--filter=blob:none --depth=1` 只取 commit + tree（实测 78 KB），
    然后用 read-tree / update-index --force-remove 改索引；
    这两个操作都只动 index 条目、不读 blob 内容，最后 commit-tree 生成新提交、
    push 上去。服务端本来就有那些 blob，所以只传新 tree 对象。

用法:
    python tools/ms_delete_files.py --repo syxppp/SoulX-Singer-onnx-directml-int8 \\
        --delete diff_step_dml.onnx.data --delete vocoder_dml.onnx.data \\
        --retag v2 [--dry-run]

    # 只列将要删除的条目，不推送
    python tools/ms_delete_files.py --repo ... --delete '*.onnx.data' --dry-run

注意:
  - `--retag` 必须是分支 HEAD 移动之后的目标 tag。删除会推进 HEAD，原来指向旧
    commit 的 tag 会让按 tag 拉取的用户仍看到被删文件，所以必须重指（force push）。
  - 需要 MODELSCOPE_ACCESS_TOKEN（用于换取 git token）。
"""
from __future__ import annotations

import argparse
import fnmatch
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import json

logger = logging.getLogger('ms-delete')

GIT_HOST = 'www.modelscope.cn'
# 日志里必须打码的东西（token 会出现在 remote URL 里）
_SECRETS: list[str] = []


def _scrub(text: str) -> str:
    out = text or ''
    for s in _SECRETS:
        if s:
            out = out.replace(s, '***')
    return out


def run_git(args, cwd=None, check=False):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    p = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f'git {" ".join(args)} failed: {_scrub(p.stderr)}')
    return p


def resolve_token() -> str:
    tok = (os.environ.get('MODELSCOPE_ACCESS_TOKEN') or '').strip()
    if tok:
        return tok
    for rel in (os.path.expanduser('~/.modelscope/token'),):
        try:
            with open(rel, 'r', encoding='utf-8') as f:
                v = f.read().strip()
                if v:
                    return v
        except OSError:
            pass
    raise SystemExit('MODELSCOPE_ACCESS_TOKEN is not set')


def remote_listing(repo: str, revision: str) -> dict[str, int]:
    url = (f'https://{GIT_HOST}/api/v1/models/{repo}/repo/files'
           f'?Revision={revision}&Recursive=true')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    return {f['Path']: int(f['Size']) for f in d['Data']['Files'] if f['Type'] == 'blob'}


def matches(path: str, patterns: list[str]) -> bool:
    # gitignore 风格：'*.onnx.data' 要能匹配子目录里的同名文件
    return any(fnmatch.fnmatch(path, p) or fnmatch.fnmatch(os.path.basename(path), p)
               for p in patterns)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='owner/name')
    ap.add_argument('--delete', action='append', required=True, metavar='PATTERN',
                    help='glob 模式，可重复')
    ap.add_argument('--branch', default='master')
    ap.add_argument('--retag', default=None, help='删除后把这个 tag 重指到新 HEAD')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

    token = resolve_token()
    _SECRETS.append(token)

    from modelscope.hub.api import HubApi
    api = HubApi()
    login_res = api.login(token)
    if isinstance(login_res, (tuple, list)) and login_res:
        git_token = login_res[0]
    elif isinstance(login_res, dict):
        git_token = login_res.get('git_token') or login_res.get('Credential')
    else:
        git_token = login_res
    if not git_token:
        logger.error('login failed: no git_token')
        return 1
    _SECRETS.append(str(git_token))

    files = remote_listing(args.repo, args.branch)
    targets = sorted(p for p in files if matches(p, args.delete))
    if not targets:
        logger.info('nothing to delete on %s (patterns: %s)', args.branch, args.delete)
        if args.retag:
            logger.warning('--retag skipped (no commit created)')
        return 0
    total_mb = sum(files[p] for p in targets) / 1e6
    logger.info('will delete %d file(s), %.1f MB:', len(targets), total_mb)
    for p in targets:
        logger.info('  %s (%.1f MB)', p, files[p] / 1e6)
    if args.dry_run:
        logger.info('--dry-run: nothing pushed')
        return 0

    work = tempfile.mkdtemp(prefix='msdel-')
    try:
        # auth URL 只在 remote 里出现一次，日志全部走 _scrub
        auth_url = f'https://{args.repo.split("/")[0]}:{git_token}@{GIT_HOST}/{args.repo}.git'
        run_git(['init', '-q'], cwd=work, check=True)
        run_git(['remote', 'add', 'origin', auth_url], cwd=work, check=True)
        logger.info('fetching tree of %s (blob-filtered) ...', args.branch)
        f = run_git(['fetch', '--depth=1', '--filter=blob:none', 'origin',
                     f'refs/heads/{args.branch}'], cwd=work)
        if f.returncode != 0:
            logger.error('fetch failed: %s', _scrub(f.stderr))
            return 1
        parent = run_git(['rev-parse', 'FETCH_HEAD'], cwd=work, check=True).stdout.strip()

        run_git(['read-tree', parent], cwd=work, check=True)
        for p in targets:
            # --force-remove 只删 index 条目，不读 blob（否则就要下载它）
            r = run_git(['update-index', '--force-remove', p], cwd=work)
            if r.returncode != 0:
                logger.error('update-index failed for %s: %s', p, _scrub(r.stderr))
                return 1
        tree = run_git(['write-tree'], cwd=work, check=True).stdout.strip()

        # 安全闸：新树里必须还有所有 `.onnx` 主体文件，防止误删整棵子树
        kept = run_git(['ls-tree', '-r', '--name-only', tree], cwd=work, check=True).stdout.split()
        before_onnx = {p for p in files if p.endswith('.onnx')}
        after_onnx = {p for p in kept if p.endswith('.onnx')}
        if before_onnx - after_onnx:
            logger.error('sanity check FAILED: .onnx files would disappear: %s',
                         sorted(before_onnx - after_onnx))
            return 1
        logger.info('new tree %s (files: %d -> %d)', tree, len(files), len(kept))

        msg = f'remove stale files: {", ".join(targets)}'
        env_ident = {
            'GIT_AUTHOR_NAME': args.repo.split('/')[0],
            'GIT_AUTHOR_EMAIL': f'{args.repo.split("/")[0]}@users.noreply.{GIT_HOST}',
            'GIT_COMMITTER_NAME': args.repo.split('/')[0],
            'GIT_COMMITTER_EMAIL': f'{args.repo.split("/")[0]}@users.noreply.{GIT_HOST}',
        }
        c = subprocess.run(['git', 'commit-tree', tree, '-p', parent, '-m', msg],
                           cwd=work, capture_output=True, text=True,
                           env=dict(os.environ, **env_ident))
        if c.returncode != 0:
            logger.error('commit-tree failed: %s', _scrub(c.stderr))
            return 1
        commit = c.stdout.strip()

        p = run_git(['push', 'origin', f'{commit}:refs/heads/{args.branch}'], cwd=work)
        if p.returncode != 0:
            logger.error('push failed: %s', _scrub(p.stderr))
            return 1
        logger.info('pushed %s -> %s', commit[:9], args.branch)

        # ---- 校验：远端已无目标文件 ----
        time.sleep(3)
        after = remote_listing(args.repo, args.branch)
        left = [p for p in targets if p in after]
        if left:
            logger.error('still present after push: %s', left)
            return 1
        logger.info('verified: %d file(s) gone from %s', len(targets), args.branch)

        if args.retag:
            logger.info('re-pointing tag %s at %s ...', args.retag, commit[:9])
            run_git(['tag', '-f', args.retag, commit], cwd=work, check=True)
            r = run_git(['push', '--force', 'origin',
                         f'refs/tags/{args.retag}:refs/tags/{args.retag}'], cwd=work)
            if r.returncode != 0:
                logger.error('tag push failed: %s', _scrub(r.stderr))
                return 1
            time.sleep(2)
            refs = {}
            ls = run_git(['ls-remote', f'https://{GIT_HOST}/{args.repo}.git'])
            for line in ls.stdout.splitlines():
                parts = line.split()
                if len(parts) == 2:
                    refs[parts[1]] = parts[0]
            tag_sha = refs.get(f'refs/tags/{args.retag}')
            head_sha = refs.get(f'refs/heads/{args.branch}')
            if not tag_sha or tag_sha != head_sha:
                logger.error('TAG MISMATCH: %s vs %s', tag_sha, head_sha)
                return 1
            logger.info('OK: tag %s == %s HEAD (%s)', args.retag, args.branch, head_sha[:9])
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
