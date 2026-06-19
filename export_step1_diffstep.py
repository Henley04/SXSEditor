# -*- coding: utf-8 -*-
"""Step 1: Export diff_step sub-model to FP32 ONNX via torch.export (dynamo)."""
import argparse, time, torch
from export_shared import load_config, load_model, DiffStepWrapper, DEFAULT_OUTPUT_DIR, clear_memory

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', default=None)
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    import os; os.makedirs(args.output_dir, exist_ok=True)

    config = load_config()
    model_path = args.model_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')

    print("Step 1: Export diff_step FP32 ONNX (torch.export via dynamo)")
    t0 = time.time()

    model = load_model(config, model_path)
    wrapper = DiffStepWrapper(model.cfm_decoder).eval()
    print(f"  diff_step: {sum(p.numel() for p in wrapper.parameters()) / 1e6:.1f}M params")

    output_path = os.path.join(args.output_dir, 'diff_step_fp32.onnx')
    seq_len = 2048
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (torch.randn(1, seq_len, 128), torch.tensor([0.5]),
             torch.randn(1, seq_len, 512), torch.ones(1, seq_len)),
            output_path,
            input_names=['xt_input', 't', 'cond', 'xt_mask'],
            output_names=['flow_pred'],
            opset_version=18,
            dynamo=True,
        )
    del wrapper, model
    clear_memory()

    print(f"  Done in {time.time() - t0:.1f}s -> {output_path}")

if __name__ == '__main__':
    main()
