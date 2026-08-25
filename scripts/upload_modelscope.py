import argparse,os
from modelscope.hub.api import HubApi
p=argparse.ArgumentParser();p.add_argument('--model-dir',required=True);p.add_argument('--model-id',required=True);a=p.parse_args();tok=os.environ.get('MODELSCOPE_API_TOKEN');
if not tok: raise SystemExit('MODELSCOPE_API_TOKEN missing')
api=HubApi();api.login(tok);api.upload_folder(repo_id=a.model_id,folder_path=a.model_dir,repo_type='model',commit_message='Add true INT8 Q-DiT W8A8 and AWQ W8A32 PT/ONNX DML models')
