# -*- coding: utf-8 -*-
"""Upload new FP16 models to ModelScope release branch, tag v1.

Strategy:
1. Use push_model (deprecated but supports auto-branch-creation) to create
   'release' branch from master with a configuration.json
2. Use upload_file to upload the 3 new model files to release branch
3. Create tag 'v1'
"""
import os
import sys
import time
import json
import shutil
import logging
import subprocess

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FP16_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'fp16_dynamo')

MODEL_ID = 'syxppp/SoulX-Singer-onnx-directml-fp16'
ACCESS_TOKEN = os.environ.get('MODELSCOPE_ACCESS_TOKEN')
if not ACCESS_TOKEN:
    logger.error("MODELSCOPE_ACCESS_TOKEN environment variable not set")
    sys.exit(1)
NEW_BRANCH = 'release'
TAG_NAME = 'v1'

FILES_TO_UPLOAD = [
    (os.path.join(FP16_DIR, 'diff_step_dml.onnx'), 'diff_step_dml.onnx'),
    (os.path.join(FP16_DIR, 'diff_step_dml.onnx.data'), 'diff_step_dml.onnx.data'),
    (os.path.join(FP16_DIR, 'vocoder_dml.onnx'), 'vocoder_dml.onnx'),
]


def main():
    from modelscope.hub.api import HubApi

    api = HubApi()
    logger.info("Logging in to ModelScope...")
    git_token, _ = api.login(ACCESS_TOKEN)
    if not git_token:
        logger.error("Login failed: no git_token returned")
        sys.exit(1)
    logger.info("Login successful")

    # Verify files exist
    for local_path, remote_path in FILES_TO_UPLOAD:
        if not os.path.exists(local_path):
            logger.error(f"File not found: {local_path}")
            sys.exit(1)
        size_mb = os.path.getsize(local_path) / 1024 / 1024
        logger.info(f"  {remote_path}: {size_mb:.1f} MB")

    # Check current branches and tags
    branches, tags = api.get_model_branches_and_tags(MODEL_ID)
    logger.info(f"Current branches: {branches}")
    logger.info(f"Current tags: {tags}")

    if TAG_NAME in tags:
        logger.error(f"Tag '{TAG_NAME}' already exists! Aborting to avoid overwrite.")
        sys.exit(1)

    # Step 1: Create release branch using push_model
    # push_model auto-creates branches that don't exist
    if NEW_BRANCH not in branches:
        logger.info(f"\nStep 1: Creating branch '{NEW_BRANCH}' via push_model...")

        # Create a minimal temp directory with just configuration.json
        temp_dir = os.path.join(SCRIPT_DIR, '_ms_temp_push')
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
        os.makedirs(temp_dir)

        # Create minimal configuration.json (required by push_model)
        config = {
            "model": {
                "type": "onnx",
                "model_type": "onnx"
            }
        }
        with open(os.path.join(temp_dir, 'configuration.json'), 'w') as f:
            json.dump(config, f)

        try:
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                api.push_model(
                    model_id=MODEL_ID,
                    model_dir=temp_dir,
                    revision=NEW_BRANCH,
                    commit_message=f'Create release branch for FP16 dynamo+olive models',
                    token=ACCESS_TOKEN,
                )
            logger.info(f"Branch '{NEW_BRANCH}' created successfully")
        except Exception as e:
            logger.error(f"push_model failed: {e}")
            import traceback
            traceback.print_exc()
            # Check if branch was created anyway
            branches_check, _ = api.get_model_branches_and_tags(MODEL_ID)
            if NEW_BRANCH in branches_check:
                logger.info(f"Branch '{NEW_BRANCH}' exists despite error, continuing")
            else:
                sys.exit(1)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        # Verify branch
        branches_after, _ = api.get_model_branches_and_tags(MODEL_ID)
        logger.info(f"Branches after: {branches_after}")
        if NEW_BRANCH not in branches_after:
            logger.error(f"Branch '{NEW_BRANCH}' was not created!")
            sys.exit(1)
    else:
        logger.info(f"Branch '{NEW_BRANCH}' already exists, skipping creation")

    # Step 2: Upload files via upload_file to release branch
    logger.info(f"\nStep 2: Uploading {len(FILES_TO_UPLOAD)} files to branch '{NEW_BRANCH}'...")

    last_commit_info = None
    for i, (local_path, remote_path) in enumerate(FILES_TO_UPLOAD, 1):
        size_mb = os.path.getsize(local_path) / 1024 / 1024
        logger.info(f"\n[{i}/{len(FILES_TO_UPLOAD)}] Uploading {remote_path} ({size_mb:.1f} MB)...")
        t0 = time.time()
        try:
            commit_info = api.upload_file(
                path_or_fileobj=local_path,
                path_in_repo=remote_path,
                repo_id=MODEL_ID,
                revision=NEW_BRANCH,
                commit_message=f'Upload FP16 dynamo+olive optimized {remote_path}',
                token=ACCESS_TOKEN,
            )
            elapsed = time.time() - t0
            logger.info(f"  Uploaded in {elapsed:.1f}s ({size_mb/elapsed:.1f} MB/s)")
            logger.info(f"  Commit info: {commit_info}")
            last_commit_info = commit_info
        except Exception as e:
            logger.error(f"  Upload failed: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)

    # Get the commit id
    release_commit = None
    if last_commit_info is not None:
        for attr in ['commit_id', 'commit_oid', 'oid', 'id', 'Revision']:
            val = getattr(last_commit_info, attr, None)
            if val:
                release_commit = val
                break
        if not release_commit and isinstance(last_commit_info, dict):
            for key in ['commit_id', 'commit_oid', 'oid', 'id', 'Revision']:
                if key in last_commit_info:
                    release_commit = last_commit_info[key]
                    break
        if not release_commit:
            release_commit = str(last_commit_info)

    # Fallback: list_repo_commits
    if not release_commit or len(str(release_commit)) < 10:
        logger.info(f"\nGetting latest commit on branch '{NEW_BRANCH}' via list_repo_commits...")
        commits = api.list_repo_commits(MODEL_ID, revision=NEW_BRANCH, token=ACCESS_TOKEN)
        if commits:
            logger.info(f"  commits type: {type(commits)}")
            if isinstance(commits, list) and len(commits) > 0:
                first = commits[0]
                logger.info(f"  first commit: {first}")
                if isinstance(first, dict):
                    release_commit = first.get('id') or first.get('Revision') or first.get('commit_id')
                elif hasattr(first, 'commit_id'):
                    release_commit = first.commit_id
                else:
                    release_commit = str(first)

    logger.info(f"\nRelease branch HEAD commit: {release_commit}")

    if not release_commit:
        logger.error("Failed to get release commit id")
        sys.exit(1)

    # Step 3: Create tag 'v1'
    logger.info(f"\nStep 3: Creating tag '{TAG_NAME}'...")
    try:
        result = api.create_model_tag(
            model_id=MODEL_ID,
            tag_name=TAG_NAME,
            token=ACCESS_TOKEN,
        )
        logger.info(f"Tag created: {result}")
    except Exception as e:
        logger.error(f"Failed to create tag: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Verify
    branches_final, tags_final = api.get_model_branches_and_tags(MODEL_ID)
    logger.info(f"\nFinal branches: {branches_final}")
    logger.info(f"Final tags: {tags_final}")

    logger.info(f"\n{'='*60}")
    logger.info("UPLOAD COMPLETE")
    logger.info(f"{'='*60}")
    logger.info(f"Model: https://modelscope.cn/models/{MODEL_ID}")
    logger.info(f"Branch: {NEW_BRANCH}")
    logger.info(f"Tag: {TAG_NAME}")
    logger.info(f"Commit: {release_commit}")
    logger.info(f"Download URL template:")
    logger.info(f"  https://modelscope.cn/api/v1/models/{MODEL_ID}/repo?Revision={TAG_NAME}&FilePath=<filename>")


if __name__ == '__main__':
    main()
