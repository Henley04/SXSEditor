# -*- coding: utf-8 -*-
"""复用已提取的数据快速重训 MLP（跳过 60 分钟数据提取阶段）。

用法:
  python scripts/retrain_mlp_from_data.py
"""
import os
import sys
import numpy as np
import torch
import torch.nn as nn

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from train_mel_proj_mlp import (
    MelProjMLP, SVS_NUM_MELS, TOTAL_DIM, HIDDEN_DIM, DROPOUT,
    BATCH_FRAMES, EPOCHS, LR, WEIGHT_DECAY, PATIENCE, MIN_DELTA,
    OUTPUT_DIR, MLP_WEIGHT_PATH, MLP_LOG_PATH,
)


def main():
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")

    # 加载已提取的数据
    mel_path = os.path.join(OUTPUT_DIR, "mlp_mel_data.npy")
    target_path = os.path.join(OUTPUT_DIR, "mlp_target_data.npy")
    print(f"\n[1] Loading existing data...")
    mel_data = np.load(mel_path)
    target_data = np.load(target_path)
    print(f"    mel: {mel_data.shape}, target: {target_data.shape}")

    # 过滤 NaN/Inf
    valid_mask = np.isfinite(mel_data).all(axis=1) & np.isfinite(target_data).all(axis=1)
    if not valid_mask.all():
        n_invalid = (~valid_mask).sum()
        print(f"    [WARN] 过滤 {n_invalid} 个含 NaN/Inf 的帧")
        mel_data = mel_data[valid_mask]
        target_data = target_data[valid_mask]
    print(f"    After filter: mel={mel_data.shape}, target={target_data.shape}")

    # 数据统计
    print(f"\n[2] Data stats:")
    print(f"    SVS mel: mean={mel_data.mean():.4f}, std={mel_data.std():.4f}")
    print(f"    target mcep(0:40): mean={target_data[:, :40].mean():.4f}, "
          f"std={target_data[:, :40].std():.4f}")

    # 训练
    print(f"\n[3] Training MelProjMLP (residual)...")
    mel_t = torch.from_numpy(mel_data).float().to(device)
    target_t = torch.from_numpy(target_data).float().to(device)

    model = MelProjMLP().to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"    Parameters: {n_params} ({n_params/1e3:.1f}K)")

    # 最小二乘初始化线性主干
    print(f"    Initializing linear backbone with least-squares...")
    with torch.no_grad():
        X = mel_t
        Y = target_t
        XtX = X.t() @ X + 1e-4 * torch.eye(SVS_NUM_MELS, device=device)
        XtY = X.t() @ Y
        W_init = torch.linalg.solve(XtX, XtY)
        model.linear.weight.copy_(W_init.t())

    model.eval()
    with torch.no_grad():
        pred_init = model(mel_t)
        loss_init = nn.functional.l1_loss(pred_init, target_t).item()
    print(f"    Init L1 loss: {loss_init:.6f}")
    model.train()

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="min", factor=0.5, patience=10, min_lr=1e-6
    )

    N = mel_t.shape[0]
    best_loss = float("inf")
    best_state = None
    no_improve = 0
    log_lines = []

    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(N, device=device)
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, N, BATCH_FRAMES):
            end = min(start + BATCH_FRAMES, N)
            idx = perm[start:end]
            x_batch = mel_t[idx]
            y_batch = target_t[idx]
            pred = model(x_batch)
            loss = nn.functional.l1_loss(pred, y_batch)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
            n_batches += 1

        avg_loss = epoch_loss / n_batches
        scheduler.step(avg_loss)

        with torch.no_grad():
            pred_all = model(mel_t)
            full_loss = nn.functional.l1_loss(pred_all, target_t).item()
            mcep_l1 = nn.functional.l1_loss(pred_all[:, :40], target_t[:, :40]).item()
            in_range = torch.mean((torch.abs(pred_all[:, :40]) <= 5).float()).item()

        log_line = f"Epoch {epoch+1:3d}/{EPOCHS}: loss={avg_loss:.6f}, full={full_loss:.6f}, mcep_l1={mcep_l1:.4f}, in_range={in_range*100:.1f}%, lr={optimizer.param_groups[0]['lr']:.2e}"
        log_lines.append(log_line)
        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"    {log_line}")

        if full_loss < best_loss - MIN_DELTA:
            best_loss = full_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= PATIENCE:
                print(f"    Early stop at epoch {epoch+1}, best_loss={best_loss:.6f}")
                break

    if best_state is not None:
        model.load_state_dict(best_state)

    torch.save({
        "state_dict": model.state_dict(),
        "config": {
            "in_dim": SVS_NUM_MELS, "hidden_dim": HIDDEN_DIM,
            "out_dim": TOTAL_DIM, "dropout": DROPOUT,
        },
        "best_loss": best_loss,
    }, MLP_WEIGHT_PATH)
    print(f"\n[4] Saved MLP weight: {MLP_WEIGHT_PATH}")

    model.eval()
    with torch.no_grad():
        pred = model(mel_t)
        loss = nn.functional.l1_loss(pred, target_t).item()
        mcep_l1 = nn.functional.l1_loss(pred[:, :40], target_t[:, :40]).item()
    print(f"\n[5] Final validation:")
    print(f"    L1 loss: {loss:.6f}")
    print(f"    mcep L1 (normalized): {mcep_l1:.4f}")

    with open(MLP_LOG_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
    print(f"    Train log: {MLP_LOG_PATH}")
    print(f"\n[6] Done. Next: python scripts/export_sifigan_with_mlp.py")


if __name__ == "__main__":
    main()
