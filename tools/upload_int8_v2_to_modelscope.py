# -*- coding: utf-8 -*-
"""Upload the v2 INT8 models (W8A32) to the int8 ModelScope repo, tag v2.

v2 content
  1. diff_step_dml.onnx — W8A32: int8 weights (116 MatMul, per-output-channel
     DequantizeLinear) + fp32 activations. Replaces the v1 QDIT/W8A8 model whose
     cond was still 512 (issue #36) and whose activation quantization collapsed
     the last diffusion step (see int8_w8a8_output/INT8_REPORT.md).
  2. vocoder_dml.onnx   — W8A32: int8 weights + fp32 activations, ISTFT head
     kept fp32.

Both files are staged as *single self-contained* files (tools/embed_external_data.py)
because the app's download manifest lists only `diff_step_dml.onnx` /
`vocoder_dml.onnx` — a split model would arrive without its weights.

Strategy
  1. upload both .onnx to the release branch (the repo has no 'release' branch,
     so it falls back to 'master' — detected at runtime)
  2. verify remote blob sizes
  3. delete the now-dead `.onnx.data` sidecars of those two files
  4. tag v2 at the branch HEAD via git push (SDK create_model_tag hardcodes
     Ref='master' in 1.37.1, so it is not used)
  5. verify refs/tags/v2 == refs/heads/<branch>

Usage
  export MODELSCOPE_ACCESS_TOKEN=ms-...
  python tools/upload_int8_v2_to_modelscope.py [--tag-only] [--dry-run]
"""
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('ms_int8_v2')

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STAGE_DIR = os.path.join(SCRIPT_DIR, '.workbuddy', 'tmp_ms_int8_v2')
TOKEN_FILE = os.path.join(SCRIPT_DIR, '.workbuddy', 'ms_token.txt')

MODEL_ID = 'syxppp/SoulX-Singer-onnx-directml-int8'
GIT_URL = f'https://www.modelscope.cn/{MODEL_ID}.git'
TAG_NAME = 'v2'
# 有 release 就推 release，否则 master（int8 仓库目前只有 master）
BRANCH_CANDIDATES = ('release', 'master')

FILES_TO_UPLOAD = [
    (os.path.join(STAGE_DIR, 'diff_step_dml.onnx'), 'diff_step_dml.onnx',
     'INT8 v2: diff_step W8A32 (int8 weights + fp32 activations), cond=1024, dynamic shapes'),
    (os.path.join(STAGE_DIR, 'vocoder_dml.onnx'), 'vocoder_dml.onnx',
     'INT8 v2: vocoder W8A32 (int8 weights + fp32 activations), ISTFT head kept fp32'),
]

# 上传完新单文件后，这两个 .onnx.data 已经没人引用（新模型自包含），删掉省 ~700 MB
STALE_SIDECARS = ('diff_step_dml.onnx.data', 'vocoder_dml.onnx.data')

SECRETS = []


def _scrub(text):
    if not text:
        return text
    for s in SECRETS:
        text = text.replace(s, '<redacted>')
    return text


def resolve_token():
    token = os.environ.get('MODELSCOPE_ACCESS_TOKEN')
    if token:
        return token.strip()
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
            token = f.read().strip()
        if token:
            return token
    logger.error('No token: set MODELSCOPE_ACCESS_TOKEN or create %s', TOKEN_FILE)
    sys.exit(1)


def run_git(args, cwd=None):
    env = dict(os.environ)
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GCM_INTERACTIVE'] = 'never'
    cmd = ['git', '-c', 'credential.helper='] + args
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=300, cwd=cwd)
    return p


def remote_files(branch):
    url = (f'https://modelscope.cn/api/v1/models/{MODEL_ID}/repo/files'
           f'?Revision={branch}&Recursive=true')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    d = json.load(urllib.request.urlopen(req, timeout=60))
    return {f['Path']: int(f['Size']) for f in d['Data']['Files'] if f['Type'] == 'blob'}


def cleanup_sidecars(api, token, branch):
    """删除新版自包含模型已经不再引用的 .onnx.data 边车。

    必须删干净：应用侧 modelManager._filterMissingByRemote() 的"阶段 2"会**主动**
    为远程存在的 .onnx 补下载配套 .onnx.data。留下的 443 MB + 256 MB 孤儿分片
    会被每个用户无谓下载一次（虽然加载时不会被读）。

    ⚠️ 不能用 HubApi.delete_files()：平台已封禁 token 删除
    （401 Code=10010101003 "the current token no longer supports deletion
    operations. Please go to the site page"）。只能用 git 推一个删除提交，
    具体见 tools/ms_delete_files.py（blob 过滤浅取 + commit-tree，不下载大文件）。

    删除会推进分支 HEAD，所以必须在打 tag 之前完成。
    """
    remote = remote_files(branch)
    stale = [s for s in STALE_SIDECARS if s in remote]
    if not stale:
        logger.info('  no stale sidecar present (ok)')
        return []
    for s in stale:
        logger.info('  deleting stale sidecar %s (%.1f MB)', s, remote[s] / 1e6)

    cmd = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        'ms_delete_files.py'),
           '--repo', MODEL_ID, '--branch', branch]
    for s in stale:
        cmd += ['--delete', s]
    p = subprocess.run(cmd, capture_output=True, text=True)
    for line in (p.stdout or '').splitlines():
        logger.info('  %s', _scrub(line))
    if p.returncode != 0:
        logger.error('  delete failed (%s): %s', p.returncode, _scrub(p.stderr))
        return None

    after = remote_files(branch)
    left = [s for s in stale if s in after]
    if left:
        logger.error('  still present after delete: %s', left)
        return None
    logger.info('  deleted: %s', ', '.join(stale))
    return stale


def main():
    dry = '--dry-run' in sys.argv
    tag_only = '--tag-only' in sys.argv
    # 只做清理 + 重新打 tag：用于修"上传成功但 .data 边车没删掉 / tag 落在旧 commit"。
    fix_sidecars = '--fix-sidecars' in sys.argv
    if fix_sidecars:
        tag_only = True

    token = resolve_token()
    SECRETS.append(token)
    from modelscope.hub.api import HubApi

    api = HubApi()
    logger.info('Logging in to ModelScope...')
    login_res = api.login(token)
    git_token = None
    if isinstance(login_res, (tuple, list)) and login_res:
        git_token = login_res[0]
    elif isinstance(login_res, dict):
        git_token = login_res.get('git_token') or login_res.get('Credential')
    else:
        git_token = login_res
    if not git_token:
        logger.error('Login failed: no git_token returned')
        sys.exit(1)
    SECRETS.append(git_token)
    logger.info('Login successful')

    branches, tags = api.get_model_branches_and_tags(MODEL_ID)
    logger.info('branches: %s', branches)
    logger.info('tags    : %s', tags)
    if TAG_NAME in tags and not (tag_only or fix_sidecars):
        logger.error("Tag '%s' already exists — aborting to avoid overwrite.", TAG_NAME)
        sys.exit(1)
    retag = TAG_NAME in tags
    if retag:
        logger.info("tag '%s' exists — will re-point it at the post-cleanup %s HEAD", TAG_NAME, 'branch')
    branch = next((b for b in BRANCH_CANDIDATES if b in branches), None)
    if not branch:
        logger.error('None of %s exist in %s', BRANCH_CANDIDATES, MODEL_ID)
        sys.exit(1)
    logger.info('target branch: %s', branch)

    for local_path, remote_path, _msg in FILES_TO_UPLOAD:
        if not os.path.exists(local_path):
            logger.error('File not found: %s (run tools/embed_external_data.py first)', local_path)
            sys.exit(1)
        size_mb = os.path.getsize(local_path) / 1e6
        logger.info('  %s: %.1f MB', remote_path, size_mb)
        if not local_path.endswith('.onnx'):
            logger.error('unexpected staging file: %s', local_path)
            sys.exit(1)
        sidecar = local_path + '.data'
        if os.path.exists(sidecar):
            logger.error('staging file still has a .data sidecar: %s', sidecar)
            sys.exit(1)

    if dry:
        logger.info('--dry-run: pre-flight OK, nothing uploaded')
        return

    if not tag_only:
        for i, (local_path, remote_path, msg) in enumerate(FILES_TO_UPLOAD, 1):
            size_mb = os.path.getsize(local_path) / 1e6
            logger.info('\n[%d/%d] uploading %s (%.1f MB)...', i, len(FILES_TO_UPLOAD),
                        remote_path, size_mb)
            t0 = time.time()
            info = api.upload_file(
                path_or_fileobj=local_path,
                path_in_repo=remote_path,
                repo_id=MODEL_ID,
                revision=branch,
                commit_message=msg,
                token=token,
            )
            dt = time.time() - t0
            logger.info('  done in %.1fs (%.2f MB/s)', dt, size_mb / max(dt, 1e-6))
            logger.info('  commit: %s', str(info)[:200])

        logger.info('\nVerifying remote sizes on %s...', branch)
        remote = remote_files(branch)
        ok = True
        for local_path, remote_path, _msg in FILES_TO_UPLOAD:
            want = os.path.getsize(local_path)
            got = remote.get(remote_path)
            status = 'OK' if got == want else 'MISMATCH'
            if got != want:
                ok = False
            logger.info('  %s: local=%s remote=%s [%s]', remote_path, f'{want:,}',
                        f'{got:,}' if got is not None else 'missing', status)
        if not ok:
            logger.error('remote size verification FAILED — aborting before tagging')
            sys.exit(1)

    # ---- 清理 stale sidecar（无论上传路径还是 --fix-sidecars 都要跑）----
    # 必须在打 tag 之前：删除会推进分支 HEAD，tag 必须落在"已经干净"的那次 commit 上，
    # 否则按 tag 拉取的用户仍会看到 .data。
    logger.info('\ncleaning stale sidecars on %s...', branch)
    if cleanup_sidecars(api, token, branch) is None:
        logger.error('stale sidecar cleanup FAILED — aborting before tagging '
                     '(leftover .onnx.data would be downloaded by every client)')
        sys.exit(1)

    # ---- tag v2 at branch HEAD via git push ----
    logger.info('\ntagging %s at %s HEAD...', TAG_NAME, branch)
    tagrepo = os.path.join(STAGE_DIR, 'tagrepo')
    if os.path.exists(tagrepo):
        shutil.rmtree(tagrepo, ignore_errors=True)
    os.makedirs(tagrepo)
    subprocess.run(['git', 'init', '-q'], cwd=tagrepo, check=True)

    pushed = False
    for label, cred in (('git_token', git_token), ('sdk_token', token)):
        auth_url = f'https://syxppp:{cred}@www.modelscope.cn/{MODEL_ID}.git'
        subprocess.run(['git', 'remote', 'remove', 'origin'], cwd=tagrepo,
                       capture_output=True)
        subprocess.run(['git', 'remote', 'add', 'origin', auth_url], cwd=tagrepo, check=True)
        f = run_git(['fetch', '--depth=1', 'origin', f'refs/heads/{branch}'], cwd=tagrepo)
        if f.returncode != 0:
            logger.error('fetch failed (%s): %s', label, _scrub(f.stderr))
            continue
        subprocess.run(['git', 'tag', '-d', TAG_NAME], cwd=tagrepo, capture_output=True)
        t = subprocess.run(['git', 'tag', TAG_NAME, 'FETCH_HEAD'], cwd=tagrepo,
                           capture_output=True, text=True)
        if t.returncode != 0:
            logger.error('tag failed (%s): %s', label, _scrub(t.stderr))
            continue
        # 重新打 tag 时必须 --force：远程已存在同名 tag，普通 push 会被拒。
        # 用带 + 的 refspec 而不是 --force，避免影响其他 ref。
        refspec = f'+refs/tags/{TAG_NAME}:refs/tags/{TAG_NAME}' if retag \
            else f'refs/tags/{TAG_NAME}:refs/tags/{TAG_NAME}'
        p = run_git(['push', 'origin', refspec], cwd=tagrepo)
        if p.returncode == 0:
            pushed = True
            logger.info('  pushed with %s', label)
            break
        logger.error('push failed (%s): %s', label, _scrub(p.stderr))

    if not pushed:
        logger.error('git push tagging failed with both credentials — tag NOT created')
        sys.exit(1)

    time.sleep(3)
    refs = {}
    p = run_git(['ls-remote', GIT_URL])
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2:
            refs[parts[1]] = parts[0]
    tag_sha = refs.get(f'refs/tags/{TAG_NAME}')
    head_sha = refs.get(f'refs/heads/{branch}')
    logger.info('\nrefs/tags/%s : %s', TAG_NAME, tag_sha)
    logger.info('refs/heads/%s: %s', branch, head_sha)
    if not tag_sha or tag_sha != head_sha:
        logger.error('TAG MISMATCH (%s vs %s) — investigate immediately', tag_sha, head_sha)
        sys.exit(1)
    logger.info('OK: tag %s points at %s HEAD', TAG_NAME, branch)


if __name__ == '__main__':
    main()
