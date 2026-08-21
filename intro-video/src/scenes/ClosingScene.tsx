import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { theme, FONT } from "../theme";

export const ClosingScene: React.FC = () => {
  const frame = useCurrentFrame();

  const contentOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const contentY = interpolate(frame, [0, 20], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [75, 90], [1, 0], {
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
        opacity: fadeOut,
      }}
    >
      <div
        style={{
          opacity: contentOpacity,
          transform: `translateY(${contentY}px)`,
          textAlign: "center",
        }}
      >
        {/* Logo mark */}
        <div
          style={{
            width: 110,
            height: 110,
            borderRadius: 28,
            backgroundColor: theme.ink,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 28px",
          }}
        >
          <span
            style={{
              color: theme.bg,
              fontSize: 48,
              fontWeight: 800,
            }}
          >
            S
          </span>
        </div>

        <h2
          style={{
            color: theme.ink,
            fontSize: 64,
            fontWeight: 800,
            margin: 0,
            letterSpacing: -1,
          }}
        >
          SXSEditor
        </h2>

        <div
          style={{
            width: 160,
            height: 2,
            backgroundColor: theme.accent,
            margin: "24px auto",
          }}
        />

        <div
          style={{
            color: theme.text,
            fontSize: 30,
            fontWeight: 500,
            marginBottom: 12,
          }}
        >
          Open Source · MIT License
        </div>
        <div
          style={{
            color: theme.textSoft,
            fontSize: 24,
            fontWeight: 400,
          }}
        >
          github.com/Henley04/SXSEditor
        </div>
      </div>
    </AbsoluteFill>
  );
};
