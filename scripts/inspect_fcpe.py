"""Inspect the FCPE model architecture to understand inputs/outputs for ONNX export."""

import torch
import torchfcpe
import inspect

MODEL_PATH = r"D:\Document\electron\SXSEditor\onnx_models\preprocess\DDSP_200k.pt"

# Load model
print("=== Loading model ===")
model = torchfcpe.spawn_infer_model_from_pt(MODEL_PATH, device="cpu")
model.eval()
print(f"Model type: {type(model)}")
print(f"Model class: {type(model).__name__}")
print(f"Model module: {type(model).__module__}")

# Print model structure
print("\n=== Model repr (first 2000 chars) ===")
model_repr = repr(model)
print(model_repr[:2000])

# Check for the core model (the infer wrapper may have a sub-module)
print("\n=== Model attributes ===")
for name, attr in model.named_children():
    print(f"  child: {name} -> {type(attr).__name__}")

for name, attr in model.__dict__.items():
    if not name.startswith("_"):
        val_type = type(attr).__name__
        if isinstance(attr, torch.nn.Module):
            print(f"  attr: {name} -> {val_type}")
        elif isinstance(attr, (int, float, str, bool)):
            print(f"  attr: {name} = {attr} ({val_type})")
        elif isinstance(attr, (list, tuple)) and len(attr) < 10:
            print(f"  attr: {name} = {attr} ({val_type})")

# Check the forward method signature
print("\n=== Forward method ===")
if hasattr(model, "forward"):
    sig = inspect.signature(model.forward)
    print(f"forward signature: {sig}")

if hasattr(model, "infer"):
    sig = inspect.signature(model.infer)
    print(f"infer signature: {sig}")

# Try a test forward pass to understand I/O shapes
print("\n=== Test forward ===")
sr = 16000
hop_size = 160
audio_len = sr * 2  # 2 seconds
dummy_audio = torch.randn(1, audio_len, 1)

# Try calling the model's internal forward (not infer, which does post-processing)
with torch.no_grad():
    # First check what methods are available
    methods = [
        m for m in dir(model) if not m.startswith("__") and callable(getattr(model, m))
    ]
    print(f"Available methods: {methods[:30]}")

    # Try to understand the mel extractor
    if hasattr(model, "mel_extractor"):
        print(f"\nMel extractor: {type(model.mel_extractor)}")
        try:
            mel = model.mel_extractor(dummy_audio.transpose(1, 2), sr=sr)
            print(
                f"Mel output shape: {mel.shape if hasattr(mel, 'shape') else type(mel)}"
            )
        except Exception as e:
            print(f"Mel extraction error: {e}")

    # Try calling model.forward or model.model.forward
    print("\n--- Testing raw forward ---")
    # The infer model likely wraps a core model
    if hasattr(model, "model"):
        print(f"model.model type: {type(model.model)}")
        try:
            # Try with mel input
            if hasattr(model, "mel_extractor"):
                mel = model.mel_extractor(dummy_audio.transpose(1, 2), sr=sr)
                print(f"Mel shape for core model: {mel.shape}")
                out = model.model(mel)
                if isinstance(out, torch.Tensor):
                    print(f"Core model output shape: {out.shape}")
                    print(f"Core model output dtype: {out.dtype}")
                    print(f"Output sample values: {out.flatten()[:10]}")
                elif isinstance(out, (tuple, list)):
                    for i, o in enumerate(out):
                        print(
                            f"  output[{i}] shape: {o.shape if hasattr(o, 'shape') else type(o)}"
                        )
        except Exception as e:
            print(f"Core model forward error: {e}")
            import traceback

            traceback.print_exc()

    # Also try the full infer method
    print("\n--- Testing infer() ---")
    try:
        f0 = model.infer(
            dummy_audio,
            sr=sr,
            decoder_mode="local_argmax",
            threshold=0.006,
            f0_min=80,
            f0_max=880,
            interp_uv=False,
            output_interp_target_length=(audio_len // hop_size) + 1,
        )
        print(f"F0 shape: {f0.shape}")
        print(f"F0 dtype: {f0.dtype}")
        print(f"F0 sample values: {f0.flatten()[:10]}")
    except Exception as e:
        print(f"Infer error: {e}")
        import traceback

        traceback.print_exc()

print("\n=== Done ===")
