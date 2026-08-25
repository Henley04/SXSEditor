import argparse,shutil,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--model-dir',required=True);a=p.parse_args();r=Path(a.repo);dst=r/'onnx_models'/'int8';dst.mkdir(parents=True,exist_ok=True)
for f in Path(a.model_dir).rglob('*.onnx'): shutil.copy2(f,dst/f.name)
# Do not alter download logic. Manifest only replaces INT8 artifact mapping.
manifest=dst/'manifest.json'; manifest.write_text(json.dumps({'precision':'INT8','diff_step':'W8A8','vocoder':'W8A32','provider':'dml','files':[x.name for x in dst.glob('*.onnx')]},indent=2))
