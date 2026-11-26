# -*- coding: utf-8 -*-
"""Upload INT8 v3 to the int8 ModelScope repo and tag v3.

v3 content
  1. diff_step_dml.onnx — W8A32 + **RoPE cos/sin tables baked** ([1,8192,64] fp32
     x2, runtime only Slice). Fixes the TRT-RTX bug where the runtime
     Range->Cast->MatMul->Sin/Cos position chain is fused into a Myelin kernel
     that collapses every frame >= 2048 (TRT vs DML frame cos 0.833 -> 1.000000).
     I/O contract unchanged: xt_input / t / cond / xt_mask -> flow_pred, cond=1024,
     dynamic seq_len.
  2. mel_transform.onnx + .data — FP32 dynamic graph (input 'audio',
     output 'mel'), replacing the old static fp16 graph
     (waveform:float32[1,240000] -> output). DML fp16 STFT returns a constant
     tensor, so the FP32 graph is mandatory; it also removes the CPU fallback.

Strategy
  1. pre-flight: files exist, sizes sane, diff_step self-contained (no .data
     sidecar), mel_transform has its .data sidecar
  2. upload changed files to the branch (release if present else master)
  3. verify remote blob sizes
  4. tag v3 at branch HEAD via git push (SDK create_model_tag is unusable)
  5. verify refs/tags/v3 == refs/heads/<branch>

Usage
  export MODELSCOPE_ACCESS_TOKEN=ms-...
  python tools/upload_int8_v3_to_modelscope.py --dry-run
  python tools/upload_int8_v3_to_modelscope.py --push
"""
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('ms_int8_v3')

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8')
MODEL_ID = 'syxppp/SoulX-Singer-onnx-directml-int8'
GIT_URL = f'https://www.modelscope.cn/{MODEL_ID}.git'
TAG_NAME = 'v3'
BRANCH_CANDIDATES = ('release', 'master')

FILES_TO_UPLOAD = [
    ('diff_step_dml.onnx',
     'INT8 v3: diff_step W8A32 + baked RoPE tables (fix TRT-RTX >=2048 frame collapse)'),
    ('mel_transform.onnx',
     'INT8 v3: mel_transform FP32 dynamic graph (audio -> mel)'),
    ('mel_transform.onnx.data',
     'INT8 v3: mel_transform FP32 weights'),
]

# 自包含模型不应有 .data；带外部数据的模型必须成对（下载器只认 <file>.onnx.data）
SELF_CONTAINED = ('diff_step_dml.onnx',)
NEEDS_SIDECAR = ('mel_transform.onnx',)

SECRETS = []


def _scrub(text):
    for s in SECRETS:
        if s:
            text = text.replace(s, '<redacted>')
    return text


def resolve_token():
    token = os.environ.get('MODELSCOPE_ACCESS_TOKEN') or os.environ.get('MODELSCOPE_API_TOKEN')
    if token:
        return token.strip()
    logger.error('No token: export MODELSCOPE_ACCESS_TOKEN=ms-...')
    sys.exit(2)


def run_git(args, cwd=None):
    env = dict(os.environ)
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GCM_INTERACTIVE'] = 'never'
    return subprocess.run(['git', '-c', 'credential.helper='] + args,
                          capture_output=True, text=True, env=env, timeout=300, cwd=cwd)


def remote_files(branch):
    url = (f'https://modelscope.cn/api/v1/models/{MODEL_ID}/repo/files'
           f'?Revision={branch}&Recursive=true')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    import json
    d = json.load(urllib.request.urlopen(req, timeout=60))
    return {f['Path']: int(f['Size']) for f in d['Data']['Files'] if f.get('Type') == 'blob'}


def preflight():
    ok = True
    for rel, _msg in FILES_TO_UPLOAD:
        full = os.path.join(LOCAL_DIR, rel)
        if not os.path.exists(full):
            logger.error('missing: %s', full)
            ok = False
            continue
        logger.info('  %-28s %12d B', rel, os.path.getsize(full))
    for rel in SELF_CONTAINED:
        sidecar = os.path.join(LOCAL_DIR, rel + '.data')
        if os.path.exists(sidecar):
            logger.error('%s is self-contained but a stale %s.data exists (move it away)', rel, rel)
            ok = False
    for rel in NEEDS_SIDECAR:
        sidecar = os.path.join(LOCAL_DIR, rel + '.data')
        if not os.path.exists(sidecar):
            logger.error('%s requires its %s.data sidecar (downloader fetches by exact name)', rel, rel)
            ok = False
    return ok


def main():
    dry = '--dry-run' in sys.argv
    push = '--push' in sys.argv
    token = resolve_token()
    SECRETS.append(token)

    if not preflight():
        logger.error('pre-flight FAILED')
        return 1

    from modelscope.hub.api import HubApi
    api = HubApi()
    logger.info('logging in ...')
    login_res = api.login(token)
    git_token = None
    if isinstance(login_res, (tuple, list)) and login_res:
        git_token = login_res[0]
    elif isinstance(login_res, dict):
        git_token = login_res.get('git_token') or login_res.get('Credential')
    else:
        git_token = login_res
    if not git_token:
        logger.error('login returned no git_token')
        return 1
    SECRETS.append(git_token)

    branches, tags = api.get_model_branches_and_tags(MODEL_ID)
    logger.info('branches=%s tags=%s', branches, tags)
    if TAG_NAME in tags:
        logger.error("tag '%s' already exists — aborting", TAG_NAME)
        return 1
    branch = next((b for b in BRANCH_CANDIDATES if b in branches), None)
    if not branch:
        logger.error('none of %s exist', BRANCH_CANDIDATES)
        return 1
    logger.info('target branch: %s', branch)

    remote = remote_files(branch)
    todo = []
    for rel, msg in FILES_TO_UPLOAD:
        local_size = os.path.getsize(os.path.join(LOCAL_DIR, rel))
        remote_size = remote.get(rel)
        status = 'NEW' if remote_size is None else ('same' if remote_size == local_size else f'DIFF({remote_size} -> {local_size})')
        logger.info('  %-28s %s', rel, status)
        if remote_size != local_size:
            todo.append((rel, msg))

    total = sum(os.path.getsize(os.path.join(LOCAL_DIR, r)) for r, _ in todo)
    logger.info('%d file(s) to upload, %.1f MB', len(todo), total / 1e6)
    if dry:
        logger.info('--dry-run: nothing uploaded')
        return 0
    if not push:
        logger.info('pass --push to upload')
        return 0
    if not todo:
        logger.info('nothing to upload; will still tag %s at %s HEAD', TAG_NAME, branch)

    for i, (rel, msg) in enumerate(todo, 1):
        full = os.path.join(LOCAL_DIR, rel)
        size_mb = os.path.getsize(full) / 1e6
        logger.info('[%d/%d] uploading %s (%.1f MB) ...', i, len(todo), rel, size_mb)
        t0 = time.time()
        api.upload_file(path_or_fileobj=full, path_in_repo=rel, repo_id=MODEL_ID,
                        revision=branch, commit_message=msg, token=token)
        dt = time.time() - t0
        logger.info('  done in %.1fs (%.2f MB/s)', dt, size_mb / max(dt, 1e-6))

    logger.info('verifying remote sizes on %s ...', branch)
    after = remote_files(branch)
    ok = True
    for rel, _msg in FILES_TO_UPLOAD:
        want = os.path.getsize(os.path.join(LOCAL_DIR, rel))
        got = after.get(rel)
        if got != want:
            ok = False
            logger.error('  %s: local=%s remote=%s MISMATCH', rel, f'{want:,}', f'{got:,}' if got else 'missing')
        else:
            logger.info('  %s: %s OK', rel, f'{want:,}')
    if not ok:
        logger.error('size verification FAILED — aborting before tagging')
        return 1

    logger.info('tagging %s at %s HEAD ...', TAG_NAME, branch)
    tagrepo = os.path.join(SCRIPT_DIR, '.workbuddy', 'tmp_ms_int8_v3_tagrepo')
    shutil.rmtree(tagrepo, ignore_errors=True)
    os.makedirs(tagrepo)
    subprocess.run(['git', 'init', '-q'], cwd=tagrepo, check=True)
    pushed = False
    for label, cred in (('git_token', git_token), ('sdk_token', token)):
        auth_url = f'https://syxppp:{cred}@www.modelscope.cn/{MODEL_ID}.git'
        subprocess.run(['git', 'remote', 'remove', 'origin'], cwd=tagrepo, capture_output=True)
        subprocess.run(['git', 'remote', 'add', 'origin', auth_url], cwd=tagrepo, check=True)
        f = run_git(['fetch', '--depth=1', 'origin', f'refs/heads/{branch}'], cwd=tagrepo)
        if f.returncode != 0:
            logger.error('fetch failed (%s): %s', label, _scrub(f.stderr)[-300:])
            continue
        subprocess.run(['git', 'tag', '-d', TAG_NAME], cwd=tagrepo, capture_output=True)
        t = subprocess.run(['git', 'tag', TAG_NAME, 'FETCH_HEAD'], cwd=tagrepo, capture_output=True, text=True)
        if t.returncode != 0:
            logger.error('tag failed (%s): %s', label, _scrub(t.stderr)[-300:])
            continue
        p = run_git(['push', 'origin', f'refs/tags/{TAG_NAME}:refs/tags/{TAG_NAME}'], cwd=tagrepo)
        if p.returncode == 0:
            pushed = True
            logger.info('  pushed with %s', label)
            break
        logger.error('push failed (%s): %s', label, _scrub(p.stderr)[-300:])
    if not pushed:
        logger.error('tag push failed with both credentials')
        return 1

    time.sleep(3)
    refs = {}
    ls = run_git(['ls-remote', GIT_URL])
    for line in ls.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2:
            refs[parts[1]] = parts[0]
    tag_sha = refs.get(f'refs/tags/{TAG_NAME}')
    head_sha = refs.get(f'refs/heads/{branch}')
    logger.info('refs/tags/%s : %s', TAG_NAME, tag_sha)
    logger.info('refs/heads/%s: %s', branch, head_sha)
    if not tag_sha or tag_sha != head_sha:
        logger.error('TAG MISMATCH (%s vs %s)', tag_sha, head_sha)
        return 1
    logger.info('OK: %s points at %s HEAD', TAG_NAME, branch)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
