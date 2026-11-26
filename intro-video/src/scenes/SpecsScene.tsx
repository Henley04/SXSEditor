import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { theme, FONT } from "../theme";
import realInference from "../data/realInference.json";

const M = realInference;

// 推理管线常量（src/inference/shared/constants.js）与本次真实 run 的实测值
const SPECS: Array<{ k: string; v: string }> = [
  { k: "模型", v: "SoulX-Singer (ONNX)" },
  { k: "模型仓库", v: "syxppp/SoulX-Singer-onnx-directml" },
  { k: "加载模型数", v: `${M.pipeline.modelsLoaded} 个` },
  { k: "采样率", v: `${M.audio.sampleRate / 1000} kHz` },
  { k: "梅尔通道", v: "128 bins · hop 480" },
  { k: "采样器", v: `${M.pipeline.sampler} · ${M.pipeline.diffusionSteps} 步` },
  { k: "唱词语言", v: "中 · 英 · 日" },
  { k: "执行提供者", v: M.executionProvider },
  { k: "许可证", v: "MIT" },
];

const PLATFORMS: Array<{ name: string; sub: string; tag: string; strong: boolean }> = [
  { name: "Windows", sub: "安装包 · DirectML / WebNN / WinML", tag: "主平台", strong: true },
  { name: "Linux", sub: "源码构建 · CPU 推理 · 已验证可编译", tag: "deb 已产出", strong: true },
  { name: "macOS", sub: "源码构建 · CPU 推理", tag: "源码构建", strong: false },
];

export const SpecsScene: React.FC = () => {
  const frame = useCurrentFrame();

  const headerOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        fontFamily: FONT,
        padding: "56px 72px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ opacity: headerOpacity, marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <span style={{ color: theme.accent, fontSize: 22, fontWeight: 700, letterSpacing: 5 }}>
            SPECIFICATIONS
          </span>
          <h2 style={{ color: theme.ink, fontSize: 46, fontWeight: 800, margin: 0, letterSpacing: -1 }}>
            技术规格
          </h2>
        </div>
      </div>

      <div style={{ display: "flex", gap: 26, flex: 1, minHeight: 0 }}>
        {/* 推理规格 */}
        <div
          style={{
            flex: 1.15,
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 18,
            padding: "26px 30px",
            opacity: interpolate(frame, [10, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            boxShadow: "0 4px 16px rgba(42,38,24,0.05)",
          }}
        >
          <div style={{ color: theme.ink, fontSize: 22, fontWeight: 700, marginBottom: 6 }}>
            推理管线
          </div>
          <div style={{ color: theme.textSoft, fontSize: 14, marginBottom: 18 }}>
            参数取自本次真实推理 run（{M.modelRepo}）
          </div>
          {SPECS.map((s, i) => {
            const delay = 18 + i * 8;
            const o = interpolate(frame, [delay, delay + 16], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <div
                key={s.k}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "13px 0",
                  borderBottom: i === SPECS.length - 1 ? "none" : `1px solid ${theme.border}`,
                  opacity: o,
                }}
              >
                <span style={{ color: theme.textSoft, fontSize: 18 }}>{s.k}</span>
                <span
                  style={{
                    color: theme.ink,
                    fontSize: 18,
                    fontWeight: 600,
                    maxWidth: "62%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.v}
                </span>
              </div>
            );
          })}
        </div>

        {/* 平台支持 */}
        <div
          style={{
            flex: 1,
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 18,
            padding: "26px 30px",
            opacity: interpolate(frame, [16, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            boxShadow: "0 4px 16px rgba(42,38,24,0.05)",
          }}
        >
          <div style={{ color: theme.ink, fontSize: 22, fontWeight: 700, marginBottom: 6 }}>
            平台支持
          </div>
          <div style={{ color: theme.textSoft, fontSize: 14, marginBottom: 18 }}>
            Electron Forge 构建目标
          </div>
          {PLATFORMS.map((p, i) => {
            const delay = 24 + i * 10;
            const o = interpolate(frame, [delay, delay + 16], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <div
                key={p.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "13px 16px",
                  marginBottom: 10,
                  borderRadius: 12,
                  backgroundColor: p.strong ? theme.bgSoft : theme.bgCard,
                  border: `1px solid ${theme.border}`,
                  opacity: o,
                }}
              >
                <div>
                  <div style={{ color: theme.ink, fontSize: 19, fontWeight: 700 }}>{p.name}</div>
                  <div style={{ color: theme.textSoft, fontSize: 14, marginTop: 2 }}>{p.sub}</div>
                </div>
                <span
                  style={{
                    color: p.strong ? theme.accent : theme.textSoft,
                    fontSize: 13,
                    fontWeight: 600,
                    border: `1px solid ${p.strong ? theme.accent : theme.border}`,
                    borderRadius: 999,
                    padding: "4px 12px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.tag}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部说明 */}
      <div
        style={{
          marginTop: 22,
          display: "flex",
          gap: 16,
          opacity: interpolate(frame, [70, 95], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        <div
          style={{
            flex: 1,
            borderLeft: `3px solid ${theme.accent}`,
            paddingLeft: 16,
          }}
        >
          <div style={{ color: theme.text, fontSize: 17, lineHeight: 1.6 }}>
            Linux 构建已在 x64 上实测通过：webpack 打包 → electron-packager →{" "}
            <b>sxseditor_2.0.2_amd64.deb</b>（模型由应用首次启动时按需下载）。
          </div>
        </div>
        <div
          style={{
            flex: 1,
            borderLeft: `3px solid ${theme.border}`,
            paddingLeft: 16,
          }}
        >
          <div style={{ color: theme.textSoft, fontSize: 17, lineHeight: 1.6 }}>
            上场景的 CPU 实时率 {M.realtimeFactor.toFixed(1)}× 是无 GPU 加速下的实测值；
            Windows 上 DirectML / Windows ML 可显著加速。
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
