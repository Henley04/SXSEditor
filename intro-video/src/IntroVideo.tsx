import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { theme } from "./theme";
import { TitleScene } from "./scenes/TitleScene";
import { FeaturesScene } from "./scenes/FeaturesScene";
import { WorkflowScene } from "./scenes/WorkflowScene";
import { RealInferenceScene } from "./scenes/RealInferenceScene";
import { SpecsScene } from "./scenes/SpecsScene";
import { ClosingScene } from "./scenes/ClosingScene";

// 场景时长（帧）@ 30fps：
//   Title 3s · Features 4s · Workflow 5s · 真实推理 10s · Specs 5s · Closing 3s
// 真实推理场景展示的是 scripts/intro-video-assets.js 实际跑出来的推理结果。
export const IntroVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Series>
        <Series.Sequence durationInFrames={90}>
          <TitleScene />
        </Series.Sequence>
        <Series.Sequence durationInFrames={120}>
          <FeaturesScene />
        </Series.Sequence>
        <Series.Sequence durationInFrames={150}>
          <WorkflowScene />
        </Series.Sequence>
        <Series.Sequence durationInFrames={300}>
          <RealInferenceScene />
        </Series.Sequence>
        <Series.Sequence durationInFrames={150}>
          <SpecsScene />
        </Series.Sequence>
        <Series.Sequence durationInFrames={90}>
          <ClosingScene />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
