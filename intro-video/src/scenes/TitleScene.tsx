import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme, FONT } from "../theme";

export const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 100, mass: 0.8 },
  });
  const titleY = interpolate(frame, [10, 40], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleOpacity = interpolate(frame, [10, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subOpacity = interpolate(frame, [30, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lineScaleX = interpolate(frame, [35, 70], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        fontFamily: FONT,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Logo mark - rounded square with text */}
      <div
        style={{
          width: 150,
          height: 150,
          borderRadius: 36,
          backgroundColor: theme.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${logoScale})`,
          boxShadow: "0 12px 40px rgba(42,38,24,0.18)",
        }}
      >
        <span
          style={{
            color: theme.bg,
            fontSize: 64,
            fontWeight: 800,
            letterSpacing: -2,
          }}
        >
          S
        </span>
      </div>

      {/* App name */}
      <div
        style={{
          marginTop: 36,
          transform: `translateY(${titleY}px)`,
          opacity: titleOpacity,
        }}
      >
        <h1
          style={{
            color: theme.ink,
            fontSize: 86,
            fontWeight: 800,
            margin: 0,
            letterSpacing: -2,
          }}
        >
          SXSEditor
        </h1>
      </div>

      {/* Divider line */}
      <div
        style={{
          width: 220,
          height: 2,
          backgroundColor: theme.accent,
          marginTop: 28,
          transform: `scaleX(${lineScaleX})`,
          transformOrigin: "center",
        }}
      />

      {/* Tagline */}
      <div
        style={{
          marginTop: 28,
          opacity: subOpacity,
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: theme.text,
            fontSize: 36,
            fontWeight: 500,
          }}
        >
          AI Singing Voice Synthesis Workstation
        </div>
        <div
          style={{
            color: theme.textSoft,
            fontSize: 28,
            fontWeight: 400,
            marginTop: 10,
          }}
        >
          AI 歌声合成工作台
        </div>
      </div>
    </AbsoluteFill>
  );
};
