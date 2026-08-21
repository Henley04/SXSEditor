import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { theme, FONT } from "../theme";

const STEPS = [
  { num: "01", title: "歌手创建", en: "Singer Creation" },
  { num: "02", title: "片段编辑", en: "Fragment Editor" },
  { num: "03", title: "合成推理", en: "Synthesis" },
  { num: "04", title: "导出音频", en: "Export" },
];

// A blank app-window placeholder (image area intentionally left empty)
const AppPlaceholder: React.FC<{ opacity: number; y: number }> = ({
  opacity,
  y,
}) => (
  <div
    style={{
      flex: 1,
      backgroundColor: theme.bgCard,
      border: `1px solid ${theme.border}`,
      borderRadius: 14,
      overflow: "hidden",
      opacity,
      transform: `translateY(${y}px)`,
      boxShadow: "0 6px 20px rgba(42,38,24,0.06)",
    }}
  >
    {/* Window title bar */}
    <div
      style={{
        height: 30,
        backgroundColor: theme.bgSoft,
        borderBottom: `1px solid ${theme.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 8,
      }}
    >
      <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#D8A65A" }} />
      <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#C4B894" }} />
      <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#C4B894" }} />
    </div>
    {/* Blank content area - intentionally empty per requirement */}
    <div
      style={{
        height: 150,
        backgroundColor: theme.bgCard,
      }}
    />
  </div>
);

export const WorkflowScene: React.FC = () => {
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
          marginBottom: 50,
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
          WORKFLOW
        </div>
        <h2
          style={{
            color: theme.ink,
            fontSize: 56,
            fontWeight: 700,
            margin: "8px 0 0 0",
          }}
        >
          工作流
        </h2>
      </div>

      {/* Steps row */}
      <div
        style={{
          display: "flex",
          gap: 24,
          flex: 1,
          alignItems: "stretch",
        }}
      >
        {STEPS.map((s, i) => {
          const delay = 20 + i * 28;
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
              key={s.num}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                opacity,
                transform: `translateY(${y}px)`,
              }}
            >
              {/* Step label */}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  marginBottom: 18,
                }}
              >
                <span
                  style={{
                    color: theme.accent,
                    fontSize: 30,
                    fontWeight: 800,
                  }}
                >
                  {s.num}
                </span>
                <div>
                  <div
                    style={{
                      color: theme.ink,
                      fontSize: 26,
                      fontWeight: 700,
                    }}
                  >
                    {s.title}
                  </div>
                  <div
                    style={{
                      color: theme.textSoft,
                      fontSize: 18,
                      fontWeight: 400,
                    }}
                  >
                    {s.en}
                  </div>
                </div>
              </div>
              {/* Connector arrow except last */}
              <AppPlaceholder opacity={1} y={0} />
              {i < STEPS.length - 1 && (
                <div
                  style={{
                    textAlign: "center",
                    color: theme.accentSoft,
                    fontSize: 28,
                    marginTop: 10,
                  }}
                >
                  →
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
