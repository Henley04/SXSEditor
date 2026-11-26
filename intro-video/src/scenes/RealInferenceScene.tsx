import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { theme, FONT } from "../theme";
import realInference from "../data/realInference.json";
import envelope from "../data/envelope.json";

// ---------------------------------------------------------------------------
// 本场景展示的全部内容都来自一次**真实推理**：
//   node scripts/intro-video-assets.js --steps 32
// 音频 (sample.wav)、频谱图 (sample-mel.png)、波形图 (sample-wave.png) 与
// 下面所有指标都由该脚本在 Linux / CPU (ONNX Runtime) 上实际运行产生，
// 见 intro-video/public/metrics.json。
// ---------------------------------------------------------------------------

const M = realInference;

// 音频从第 AUDIO_START 帧开始播放；时长按真实采样点数换算。
const AUDIO_START = 66;
const AUDIO_FRAMES = Math.round((M.audio.samples / M.audio.sampleRate) * 30);

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitchToName = (p: number) =>
  `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

// 音符真实的起始拍与时长（与 scripts/intro-video-assets.js 中 SAMPLE_SONG 一致）
const NOTE_BEATS: Array<[number, number]> = [
  [0.0, 1.0],
  [1.0, 0.5],
  [1.5, 0.5],
  [2.0, 1.0],
  [3.0, 1.0],
  [4.0, 0.5],
  [4.5, 1.5],
];
const TOTAL_BEATS = 6;

const Card: React.FC<{
  label: string;
  labelEn: string;
  children: React.ReactNode;
  opacity: number;
  y: number;
  flex?: number;
}> = ({ label, labelEn, children, opacity, y, flex = 1 }) => (
  <div
    style={{
      flex,
      backgroundColor: theme.bgCard,
      border: `1px solid ${theme.border}`,
      borderRadius: 18,
      padding: "22px 26px",
      opacity,
      transform: `translateY(${y}px)`,
      display: "flex",
      flexDirection: "column",
      boxShadow: "0 4px 16px rgba(42,38,24,0.05)",
      minWidth: 0,
    }}
  >
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 }}>
      <span style={{ color: theme.ink, fontSize: 22, fontWeight: 700 }}>{label}</span>
      <span style={{ color: theme.textSoft, fontSize: 15, letterSpacing: 1 }}>{labelEn}</span>
    </div>
    {children}
  </div>
);

const Metric: React.FC<{
  value: string;
  unit?: string;
  label: string;
  delay: number;
  frame: number;
}> = ({ value, unit, label, delay, frame }) => {
  const opacity = interpolate(frame, [delay, delay + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [delay, delay + 18], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        flex: 1,
        opacity,
        transform: `translateY(${y}px)`,
        backgroundColor: theme.bgCard,
        border: `1px solid ${theme.border}`,
        borderRadius: 14,
        padding: "14px 18px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ color: theme.ink, fontSize: 34, fontWeight: 800, letterSpacing: -1 }}>
          {value}
        </span>
        {unit ? (
          <span style={{ color: theme.accent, fontSize: 17, fontWeight: 600 }}>{unit}</span>
        ) : null}
      </div>
      <div style={{ color: theme.textSoft, fontSize: 14, marginTop: 2 }}>{label}</div>
    </div>
  );
};

export const RealInferenceScene: React.FC = () => {
  const frame = useCurrentFrame();

  const headerOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 音频播放进度 0 → 1（真实音频播放期间推进）
  const progress = interpolate(frame, [AUDIO_START, AUDIO_START + AUDIO_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 频谱扫描线：真实播放位置
  const scanLeft = `${progress * 100}%`;

  // 实时电平条：取真实音频 RMS 包络在当前播放位置的值
  const envIndex = Math.min(
    envelope.length - 1,
    Math.floor(progress * envelope.length)
  );
  const level = frame >= AUDIO_START ? envelope[envIndex] : 0;

  const cardOpacity = interpolate(frame, [12, 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cardY = interpolate(frame, [12, 34], [24, 0], {
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
      {/* Header */}
      <div style={{ opacity: headerOpacity, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <span style={{ color: theme.accent, fontSize: 22, fontWeight: 700, letterSpacing: 5 }}>
            REAL INFERENCE
          </span>
          <h2 style={{ color: theme.ink, fontSize: 46, fontWeight: 800, margin: 0, letterSpacing: -1 }}>
            真实推理样例
          </h2>
        </div>
        <div style={{ color: theme.textSoft, fontSize: 19, marginTop: 10 }}>
          SoulX-Singer · {M.pipeline.modelsLoaded} 个 ONNX 模型 · {M.pipeline.sampler} 采样器 ·{" "}
          {M.pipeline.diffusionSteps} 步扩散 · {M.executionProvider}
        </div>
      </div>

      {/* Input / Output */}
      <div style={{ display: "flex", gap: 26, flex: 1, minHeight: 0 }}>
        {/* ---- 输入：真实音符与歌词 ---- */}
        <Card label="输入" labelEn="INPUT" opacity={cardOpacity} y={cardY} flex={0.72}>
          <div
            style={{
              color: theme.text,
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: 6,
              marginBottom: 4,
            }}
          >
            {M.song.lyrics}
          </div>
          <div style={{ color: theme.textSoft, fontSize: 15, marginBottom: 18 }}>
            {M.song.noteCount} 个音符 · {M.song.bpm} BPM · 乐句「{M.song.title}」
          </div>

          {/* 钢琴卷帘 */}
          <div
            style={{
              position: "relative",
              height: 210,
              backgroundColor: theme.bgSoft,
              borderRadius: 10,
              border: `1px solid ${theme.border}`,
              overflow: "hidden",
            }}
          >
            {/* 节拍网格 */}
            {Array.from({ length: TOTAL_BEATS + 1 }).map((_, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: `${(i / TOTAL_BEATS) * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  backgroundColor: theme.border,
                }}
              />
            ))}
            {/* 音符块 */}
            {M.song.pitches.map((pitch, i) => {
              const [startBeat, durBeat] = NOTE_BEATS[i];
              // 音高 → 纵向位置（低音在下）
              const minP = 57;
              const maxP = 69;
              const top = ((maxP - pitch) / (maxP - minP)) * 100;
              const delay = 26 + i * 7;
              const o = interpolate(frame, [delay, delay + 14], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              const isPlaying =
                frame >= AUDIO_START &&
                progress >= startBeat / TOTAL_BEATS &&
                progress <= (startBeat + durBeat) / TOTAL_BEATS;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: `${(startBeat / TOTAL_BEATS) * 100}%`,
                    width: `${(durBeat / TOTAL_BEATS) * 100}%`,
                    top: `${top}%`,
                    height: 8,
                    backgroundColor: isPlaying ? theme.accent : theme.accentSoft,
                    borderRadius: 4,
                    opacity: o,
                    boxShadow: isPlaying ? "0 0 12px rgba(184,137,59,0.5)" : "none",
                    transition: "background-color 0.08s linear",
                  }}
                />
              );
            })}
            {/* 播放指针 */}
            {frame >= AUDIO_START && (
              <div
                style={{
                  position: "absolute",
                  left: scanLeft,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  backgroundColor: theme.ink,
                }}
              />
            )}
          </div>

          <div style={{ color: theme.textSoft, fontSize: 14, marginTop: 14, lineHeight: 1.7 }}>
            MIDI 音高：{M.song.pitches.map((p) => `${pitchToName(p)}(${p})`).join(" · ")}
          </div>
        </Card>

        {/* ---- 输出：真实梅尔频谱 ---- */}
        <Card label="模型输出" labelEn="MEL SPECTROGRAM" opacity={cardOpacity} y={cardY} flex={1.5}>
          <div
            style={{
              position: "relative",
              flex: 1,
              backgroundColor: theme.bgSoft,
              borderRadius: 10,
              border: `1px solid ${theme.border}`,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img
              src={staticFile("sample-mel.png")}
              style={{ width: "100%", display: "block" }}
              alt="真实推理输出的梅尔频谱图"
            />
            {/* 真实播放扫描线：已播放区域保持原样，未播放区域压暗 */}
            {frame >= AUDIO_START && (
              <>
                <div
                  style={{
                    position: "absolute",
                    left: scanLeft,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    backgroundColor: "rgba(251,247,236,0.72)",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: scanLeft,
                    top: 0,
                    bottom: 0,
                    width: 3,
                    backgroundColor: theme.accent,
                    boxShadow: "0 0 14px rgba(184,137,59,0.7)",
                  }}
                />
              </>
            )}
            {/* 已播放/未播放遮罩：未播放区域压暗 */}
            {frame < AUDIO_START && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  backgroundColor: "rgba(251,247,236,0.72)",
                }}
              />
            )}
          </div>
          <div style={{ color: theme.textSoft, fontSize: 14, marginTop: 12 }}>
            128 mel bins · hop 480 @ 24 kHz · 由真实输出波形计算
          </div>
        </Card>
      </div>

      {/* 波形 + 电平 */}
      <div
        style={{
          marginTop: 22,
          backgroundColor: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 14,
          padding: "14px 20px",
          opacity: cardOpacity,
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <img
            src={staticFile("sample-wave.png")}
            style={{ width: "100%", display: "block" }}
            alt="真实推理输出的波形图"
          />
          {frame >= AUDIO_START && (
            <div
              style={{
                position: "absolute",
                left: scanLeft,
                top: 0,
                bottom: 0,
                width: 3,
                backgroundColor: theme.accent,
              }}
            />
          )}
        </div>
        {/* 真实 RMS 电平条 */}
        <div style={{ width: 150, display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              flex: 1,
              height: 10,
              backgroundColor: theme.bgSoft,
              borderRadius: 5,
              overflow: "hidden",
              border: `1px solid ${theme.border}`,
            }}
          >
            <div
              style={{
                width: `${level * 100}%`,
                height: "100%",
                backgroundColor: theme.accent,
              }}
            />
          </div>
          <span style={{ color: theme.textSoft, fontSize: 13, width: 44, textAlign: "right" }}>
            {frame >= AUDIO_START ? `${Math.round(level * 100)}%` : "—"}
          </span>
        </div>
      </div>

      {/* 真实指标 */}
      <div style={{ display: "flex", gap: 14, marginTop: 20 }}>
        <Metric value={String(M.pipeline.diffusionSteps)} unit="steps" label="扩散步数" delay={90} frame={frame} />
        <Metric value={(M.pipeline.synthMs / 1000).toFixed(1)} unit="s" label="端到端推理耗时" delay={100} frame={frame} />
        <Metric value={M.audio.durationSec.toFixed(2)} unit="s" label="生成音频时长" delay={110} frame={frame} />
        <Metric value={(M.audio.sampleRate / 1000).toFixed(0)} unit="kHz" label="采样率" delay={120} frame={frame} />
        <Metric value={M.audio.peak.toFixed(2)} label="峰值幅度" delay={130} frame={frame} />
        <Metric value={M.realtimeFactor.toFixed(1)} unit="× RTF" label="CPU 实时率" delay={140} frame={frame} />
      </div>

      {/* 真实音频：从第 AUDIO_START 帧起播放，与扫描线进度保持一致 */}
      <Sequence from={AUDIO_START} layout="none">
        <Audio src={staticFile("sample.wav")} />
      </Sequence>
    </AbsoluteFill>
  );
};
