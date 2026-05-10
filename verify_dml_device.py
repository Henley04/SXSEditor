import onnxruntime as ort
import subprocess
import time

def get_nvidia_vram():
    try:
        out = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], encoding='utf-8').strip()
        return int(out)
    except:
        return -1

model_path = 'onnx_models/diff_step_dml.onnx'

for device_id in [0, 1]:
    before = get_nvidia_vram()
    print(f'device_id={device_id}: before={before} MB')
    
    sess = ort.InferenceSession(model_path, providers=[('DmlExecutionProvider', {'device_id': device_id}), 'CPUExecutionProvider'])
    
    time.sleep(2)
    after = get_nvidia_vram()
    delta = after - before
    nvidia_marker = " <-- NVIDIA GPU!" if delta > 10 else ""
    print(f'device_id={device_id}: after={after} MB, delta={delta} MB{nvidia_marker}')
    
    sess = None
    time.sleep(1)
