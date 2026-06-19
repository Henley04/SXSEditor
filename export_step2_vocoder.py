# -*- coding: utf-8 -*-
"""Step 2: Export vocoder sub-model to FP32 ONNX via torch.export (dynamo)."""
import argparse, time, torch
from export_shared import load_config, load_model, VocoderBackboneWrapper, DEFAULT_OUTPUT_DIR, clear_memory

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', default=None)
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    import os; os.makedirs(args.output_dir, exist_ok=True)

    config = load_config()
    model_path = args.model_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')

    print("Step 2: Export vocoder FP32 ONNX (torch.export via dynamo)")
    t0 = time.time()

    model = load_model(config, model_path)
    wrapper = VocoderBackboneWrapper(model.vocoder).eval()
    print(f"  vocoder: {sum(p.numel() for p in wrapper.parameters()) / 1e6:.1f}M params")

    output_path = os.path.join(args.output_dir, 'vocoder_fp32.onnx')
    voc_seq_len = 500
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (torch.randn(1, voc_seq_len, 128),),
            output_path,
            input_names=['mel'],
            output_names=['spec'],
            opset_version=18,
            dynamo=True,
        )
    del wrapper, model
    clear_memory()

    print(f"  Done in {time.time() - t0:.1f}s -> {output_path}")

if __name__ == '__main__':
    main()
