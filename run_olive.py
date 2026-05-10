import subprocess
import sys
import os

PYTHON = r"C:\Users\15240\AppData\Local\Python\bin\python3.exe"
PIP = r"C:\Users\15240\AppData\Local\Python\bin\pip3.exe"
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'onnx_models')

def run_cmd(cmd, timeout=300):
    print(f"\n> {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if result.stdout:
        print(result.stdout[-2000:])
    if result.stderr:
        print("STDERR:", result.stderr[-1000:])
    return result.returncode

def main():
    # Step 1: Install olive with DirectML support
    print("Step 1: 安装 Olive DirectML 支持...")
    run_cmd(f'"{PIP}" install olive-ai[directml] -i https://pypi.tuna.tsinghua.edu.cn/simple', timeout=120)
    
    # Step 2: Try Olive auto-opt on diff_step
    print("\n\nStep 2: 使用 Olive 优化 diff_step...")
    diff_step_path = os.path.join(MODEL_DIR, 'diff_step.onnx')
    output_dir = os.path.join(MODEL_DIR, 'diff_step_olive')
    
    # Use Olive Python API
    olive_script = f'''
import sys
sys.path.insert(0, r"C:\\Users\\15240\\AppData\\Local\\Python\\pythoncore-3.14-64\\Lib\\site-packages")

try:
    from olive.engine import Engine
    from olive.model import ONNXModelHandler
    from olive.passes import OnnxConversion
    from olive.passes.onnx.quantization import OnnxQuantization
    from olive.passes.onnx.transformer_optimization import TransformerOptimization
    from olive.passes.onnx.peephole_optimizer import OnnxPeepholeOptimizer
    from olive.passes.onnx.shape_inference import ShapeInference
    from olive.passes.onnx.conversion import OnnxConversion
    from olive.systems.local import LocalSystem
    print("Olive imports successful!")
    
    # Check available passes
    import olive.passes as passes
    print("Available pass modules:")
    for name in sorted(dir(passes)):
        if not name.startswith('_'):
            print(f"  {name}")
            
except ImportError as e:
    print(f"Olive import failed: {e}")
    import traceback
    traceback.print_exc()
'''
    with open('_olive_test.py', 'w') as f:
        f.write(olive_script)
    run_cmd(f'"{PYTHON}" _olive_test.py', timeout=30)
    
    # Step 3: Try running olive optimize with config
    print("\n\nStep 3: 使用 Olive 配置优化...")
    
    olive_config = f'''
{{
    "input_model": {{
        "type": "ONNXModel",
        "config": {{
            "model_path": "{diff_step_path.replace(os.sep, '/')}"
        }}
    }},
    "systems": {{
        "local_system": {{
            "type": "LocalSystem"
        }}
    }},
    "passes": {{
        "shape_inference": {{
            "type": "ShapeInference"
        }},
        "peephole_optimizer": {{
            "type": "OnnxPeepholeOptimizer"
        }}
    }},
    "output_dir": "{output_dir.replace(os.sep, '/')}",
    "target": {{
        "provider": "DmlExecutionProvider"
    }}
}}
'''
    config_path = os.path.join(MODEL_DIR, 'olive_config_diff_step.json')
    with open(config_path, 'w') as f:
        f.write(olive_config)
    
    run_cmd(f'"{PYTHON}" -m olive run --config "{config_path}"', timeout=300)

if __name__ == '__main__':
    main()
