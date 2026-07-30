import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { theme, FONT } from "../theme";

const FEATURES = [
  {
    title: "ONNX Runtime",
    desc: "高性能神经网络推理\nONNX Runtime Inference",
    icon: "⚙",
  },
  {
    title: "EN · ZH · JP",
    desc: "多语言歌声合成\nMultilingual Singing Synthesis",
    icon: "语",
  },
  {
    title: "GPU · NPU · CPU",
    desc: "DirectML / WebNN 硬件加速\nHardware Acceleration",
    icon: "▣",
  },
  {
    title: "Open Source",
    desc: "MIT 许可证 · 完全开源\nMIT Licensed",
    icon: "✦",
  },
];

export const FeaturesScene: React.FC = () => {
  const frame = useCurrentFrame();

  const headerOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const headerY = interpolate(frame, [0, 20], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        fontFamily: FONT,
        padding: 80,
      }}
    >
      {/* Header */}
      <div
        style={{
          opacity: headerOpacity,
          transform: `translateY(${headerY}px)`,
          marginBottom: 60,
        }}
      >
        <div
          style={{
            color: theme.accent,
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: 4,
          }}
        >
          FEATURES
        </div>
        <h2
          style={{
            color: theme.ink,
            fontSize: 56,
            fontWeight: 700,
            margin: "8px 0 0 0",
          }}
        >
          核心特性
        </h2>
      </div>

      {/* Feature cards */}
      <div
        style={{
          display: "flex",
          gap: 32,
          flex: 1,
          alignItems: "stretch",
        }}
      >
        {FEATURES.map((f, i) => {
          const delay = 20 + i * 18;
          const opacity = interpolate(frame, [delay, delay + 25], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const y = interpolate(frame, [delay, delay + 25], [30, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={f.title}
              style={{
                flex: 1,
                backgroundColor: theme.bgCard,
                border: `1px solid ${theme.border}`,
                borderRadius: 20,
                padding: "40px 32px",
                opacity,
                transform: `translateY(${y}px)`,
                display: "flex",
                flexDirection: "column",
                boxShadow: "0 4px 16px rgba(42,38,24,0.05)",
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  backgroundColor: theme.bgSoft,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: theme.accent,
                  fontSize: 32,
                  fontWeight: 700,
                  marginBottom: 28,
                }}
              >
                {f.icon}
              </div>
              <div
                style={{
                  color: theme.ink,
                  fontSize: 30,
                  fontWeight: 700,
                  marginBottom: 14,
                }}
              >
                {f.title}
              </div>
              <div
                style={{
                  color: theme.textSoft,
                  fontSize: 20,
                  fontWeight: 400,
                  lineHeight: 1.6,
                  whiteSpace: "pre-line",
                }}
              >
                {f.desc}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
