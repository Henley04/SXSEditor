import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { theme } from "./theme";
import { TitleScene } from "./scenes/TitleScene";
import { FeaturesScene } from "./scenes/FeaturesScene";
import { WorkflowScene } from "./scenes/WorkflowScene";
import { ClosingScene } from "./scenes/ClosingScene";

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
        <Series.Sequence durationInFrames={90}>
          <ClosingScene />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
