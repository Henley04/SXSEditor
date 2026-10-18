# -*- coding: utf-8 -*-
"""Upload FP16 v2 models to ModelScope release branch, tag v2 (via git push).

v2 content:
1. diff_step_dml.onnx — RoPE cos/sin tables baked into weights
   ([1,8192,64] fp16 x2 + Slice), removing the runtime fp32 position
   MatMul that TRT-RTX (NvTensorRtRtx / WinML) Myelin executes on an
   11-bit mantissa grid, which corrupted phases for frames >= 2049
   (tail energy dip). Repo: scripts/make_diff_step_rope_table.py.
2. vocoder_dml.onnx — W16A32 (FP16 weights + FP32 activations) re-export
   with hardware-agnostic Olive optimization, re-embedded into a single
   self-contained file (staged at .workbuddy/tmp_ms_v2/) so the app's
   download manifest (vocoder_dml.onnx only) stays compatible.

Strategy (differs from v1 upload):
1. upload_file both files to the 'release' branch
2. verify remote blob sizes at Revision=release
3. tag v2 by GIT PUSH of a lightweight tag at the release HEAD sha
   (SDK create_model_tag hardcodes Ref='master' in 1.37.1 — do not use;
   empirically v1 ended up on release HEAD, but that behavior is not
   something to rely on)
4. verify with git ls-remote that refs/tags/v2 == refs/heads/release
"""
import os
import sys
import time
import json
import shutil
import logging
import subprocess
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FP16_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16')
STAGE_DIR = os.path.join(SCRIPT_DIR, '.workbuddy', 'tmp_ms_v2')
TOKEN_FILE = os.path.join(SCRIPT_DIR, '.workbuddy', 'ms_token.txt')

MODEL_ID = 'syxppp/SoulX-Singer-onnx-directml-fp16'
GIT_URL = f'https://www.modelscope.cn/{MODEL_ID}.git'
BRANCH = 'release'
TAG_NAME = 'v2'

FILES_TO_UPLOAD = [
    (os.path.join(FP16_DIR, 'diff_step_dml.onnx'), 'diff_step_dml.onnx',
     'FP16 v2: bake RoPE cos/sin tables into diff_step weights (fixes TRT-RTX tail energy dip for frames >= 2049)'),
    (os.path.join(STAGE_DIR, 'vocoder_dml.onnx'), 'vocoder_dml.onnx',
     'FP16 v2: vocoder re-exported as W16A32 (FP16 weights + FP32 activations) with Olive optimization, single-file'),
]


def resolve_token():
    token = os.environ.get('MODELSCOPE_ACCESS_TOKEN')
    if token:
        return token
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
            token = f.read().strip()
        if token:
            return token
    logger.error("No token: set MODELSCOPE_ACCESS_TOKEN or create %s", TOKEN_FILE)
    sys.exit(1)


def git_env(token):
    env = dict(os.environ)
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GCM_INTERACTIVE'] = 'never'
    return env


SECRETS = []  # credentials to scrub from any logged git output


def _scrub(text):
    if not text:
        return text
    for s in SECRETS:
        text = text.replace(s, '<redacted>')
    return text


def run_git(args, token, check=True, cwd=None):
    cmd = ['git', '-c', 'credential.helper='] + args
    p = subprocess.run(cmd, capture_output=True, text=True, env=git_env(token),
                       timeout=300, cwd=cwd)
    if check and p.returncode != 0:
        logger.error("git %s failed:\nstdout: %s\nstderr: %s", ' '.join(args),
                     _scrub(p.stdout), _scrub(p.stderr))
    return p


def ls_remote(token):
    """Return dict of ref -> sha (anonymous read works for public repos)."""
    p = run_git(['ls-remote', GIT_URL], token)
    if p.returncode != 0:
        raise RuntimeError(f"ls-remote failed: {p.stderr}")
    refs = {}
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2:
            refs[parts[1]] = parts[0]
    return refs


def main():
    token = resolve_token()
    SECRETS.extend([token])
    from modelscope.hub.api import HubApi

    api = HubApi()
    logger.info("Logging in to ModelScope...")
    login_res = api.login(token)
    git_token = None
    if isinstance(login_res, (tuple, list)) and len(login_res) >= 1:
        git_token = login_res[0]
    elif isinstance(login_res, dict):
        git_token = login_res.get('git_token') or login_res.get('Credential')
    else:
        git_token = login_res
    if not git_token:
        logger.error("Login failed: no git_token returned")
        sys.exit(1)
    SECRETS.append(git_token)
    logger.info("Login successful")

    # Pre-flight: files exist, tag absent, branch present
    for local_path, remote_path, _msg in FILES_TO_UPLOAD:
        if not os.path.exists(local_path):
            logger.error(f"File not found: {local_path}")
            sys.exit(1)
        logger.info(f"  {remote_path}: {os.path.getsize(local_path)/1024/1024:.1f} MB")

    branches, tags = api.get_model_branches_and_tags(MODEL_ID)
    logger.info(f"Current branches: {branches}")
    logger.info(f"Current tags: {tags}")
    if TAG_NAME in tags:
        logger.error(f"Tag '{TAG_NAME}' already exists! Aborting to avoid overwrite.")
        sys.exit(1)
    if BRANCH not in branches:
        logger.error(f"Branch '{BRANCH}' missing! Aborting.")
        sys.exit(1)

    tag_only = '--tag-only' in sys.argv
    if tag_only:
        logger.info("--tag-only: skipping upload (files already on release branch)")

    # Step 1: upload files to release branch
    if not tag_only:
        for i, (local_path, remote_path, msg) in enumerate(FILES_TO_UPLOAD, 1):
            size_mb = os.path.getsize(local_path) / 1024 / 1024
            logger.info(f"\n[{i}/{len(FILES_TO_UPLOAD)}] Uploading {remote_path} ({size_mb:.1f} MB)...")
            t0 = time.time()
            commit_info = api.upload_file(
                path_or_fileobj=local_path,
                path_in_repo=remote_path,
                repo_id=MODEL_ID,
                revision=BRANCH,
                commit_message=msg,
                token=token,
            )
            elapsed = time.time() - t0
            logger.info(f"  Uploaded in {elapsed:.1f}s ({size_mb/elapsed if elapsed else 0:.1f} MB/s)")
            logger.info(f"  Commit info: {commit_info}")

    # Step 2: verify remote blob sizes at Revision=release
    if not tag_only:
        logger.info("\nVerifying remote file sizes on release branch...")
        url = f'https://modelscope.cn/api/v1/models/{MODEL_ID}/repo/files?Revision={BRANCH}&Recursive=true'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        d = json.load(urllib.request.urlopen(req, timeout=60))
        remote = {f['Path']: int(f['Size']) for f in d['Data']['Files'] if f['Type'] == 'blob'}
        ok = True
        for local_path, remote_path, _msg in FILES_TO_UPLOAD:
            want = os.path.getsize(local_path)
            got = remote.get(remote_path)
            status = 'OK' if got == want else 'MISMATCH'
            if got != want:
                ok = False
            logger.info(f"  {remote_path}: local={want:,} remote={got:,} [{status}]")
        if not ok:
            logger.error("Remote size verification FAILED — aborting before tagging.")
            sys.exit(1)

    # Step 3: tag v2 at release HEAD via git push (lightweight tag)
    refs = ls_remote(token)
    release_sha = refs.get(f'refs/heads/{BRANCH}')
    if not release_sha:
        logger.error(f"Cannot resolve release HEAD sha from ls-remote: {refs}")
        sys.exit(1)
    logger.info(f"\nRelease HEAD: {release_sha}")

    tagrepo = os.path.join(STAGE_DIR, 'tagrepo')
    if os.path.exists(tagrepo):
        shutil.rmtree(tagrepo, ignore_errors=True)
    os.makedirs(tagrepo)
    subprocess.run(['git', 'init', '-q'], cwd=tagrepo, check=True)
    pushed = False
    for label, cred in (('git_token', git_token), ('sdk_token', token)):
        auth_url = f'https://syxppp:{cred}@www.modelscope.cn/{MODEL_ID}.git'
        logger.info(f"\nStep 3: tagging via git push (credential: {label})...")
        subprocess.run(['git', 'remote', 'remove', 'origin'], cwd=tagrepo,
                       capture_output=True)  # ok if absent
        subprocess.run(['git', 'remote', 'add', 'origin', auth_url], cwd=tagrepo, check=True)
        f = run_git(['fetch', '--depth=1', 'origin', f'refs/heads/{BRANCH}'], token,
                    cwd=tagrepo)
        if f.returncode != 0:
            logger.error("fetch failed: %s", _scrub(f.stderr))
            continue
        t = subprocess.run(['git', 'tag', TAG_NAME, 'FETCH_HEAD'], cwd=tagrepo,
                           capture_output=True, text=True)
        if t.returncode != 0:
            logger.error("tag failed: %s", _scrub(t.stderr))
            continue
        p = run_git(['push', 'origin', f'refs/tags/{TAG_NAME}:refs/tags/{TAG_NAME}'], token,
                    check=False, cwd=tagrepo)
        if p.returncode == 0:
            pushed = True
            break
        logger.error("push failed with %s: %s", label, _scrub(p.stderr))
        # clean local tag before retry with next credential
        subprocess.run(['git', 'tag', '-d', TAG_NAME], cwd=tagrepo, capture_output=True)

    if not pushed:
        logger.error("git push tagging failed with both credentials. Aborting (tag NOT created).")
        sys.exit(1)

    # Step 4: verify tag points at release HEAD
    time.sleep(3)  # allow backend propagation
    refs = ls_remote(token)
    tag_sha = refs.get(f'refs/tags/{TAG_NAME}')
    head_sha = refs.get(f'refs/heads/{BRANCH}')
    logger.info(f"\nFinal refs/tags/{TAG_NAME}: {tag_sha}")
    logger.info(f"Final refs/heads/{BRANCH}: {head_sha}")
    if tag_sha != head_sha:
        logger.error(f"TAG MISMATCH: v2 ({tag_sha}) != release HEAD ({head_sha}) — INVESTIGATE IMMEDIATELY")
        sys.exit(1)

    logger.info(f"\n{'='*60}")
    logger.info("UPLOAD COMPLETE")
    logger.info(f"{'='*60}")
    logger.info(f"Model: https://modelscope.cn/models/{MODEL_ID}")
    logger.info(f"Tag: {TAG_NAME} -> {tag_sha}")
    logger.info(f"Download URL template:")
    logger.info(f"  https://modelscope.cn/api/v1/models/{MODEL_ID}/repo?Revision={TAG_NAME}&FilePath=<filename>")


if __name__ == '__main__':
    main()
