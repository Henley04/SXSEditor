/**
 * 模型注册表 - 可扩展的模型组定义
 * 每个模型组包含一组相关模型，支持折叠显示和单独加载/卸载
 */

const MODEL_GROUPS = [
  {
    id: 'svs',
    name: 'SVS 合成管线',
    nameEn: 'SVS Synthesis Pipeline',
    description: '歌声合成核心模型，将 MIDI 音符与歌词合成为歌声音频',
    descriptionEn: 'Core models for synthesizing singing voice from MIDI notes and lyrics',
    required: true,
    pipelineRef: 'svsPipeline',
    models: [
      {
        id: 'noteTextEncoder',
        name: '音素文本编码器',
        nameEn: 'Phoneme Text Encoder',
        description: '将歌词音素序列编码为高维嵌入向量',
        descriptionEn: 'Encode lyric phoneme sequences into high-dimensional embeddings',
        files: ['note_text_encoder.onnx', 'note_text_encoder.onnx.data'],
        sessionKey: 'noteTextEncoder',
      },
      {
        id: 'notePitchEncoder',
        name: '音高编码器',
        nameEn: 'Pitch Encoder',
        description: '将 MIDI 音高编码为嵌入向量',
        descriptionEn: 'Encode MIDI pitch into embedding vectors',
        files: ['note_pitch_encoder.onnx', 'note_pitch_encoder.onnx.data'],
        sessionKey: 'notePitchEncoder',
      },
      {
        id: 'noteTypeEncoder',
        name: '音符类型编码器',
        nameEn: 'Note Type Encoder',
        description: '编码音符类型（休止/演唱/延续音）',
        descriptionEn: 'Encode note types (rest/vocal/slur)',
        files: ['note_type_encoder.onnx', 'note_type_encoder.onnx.data'],
        sessionKey: 'noteTypeEncoder',
      },
      {
        id: 'f0Encoder',
        name: 'F0 基频编码器',
        nameEn: 'F0 Encoder',
        description: '将量化后的 F0 基频序列编码为嵌入向量',
        descriptionEn: 'Encode quantized F0 sequences into embedding vectors',
        files: ['f0_encoder.onnx', 'f0_encoder.onnx.data'],
        sessionKey: 'f0Encoder',
      },
      {
        id: 'preflow',
        name: '预流变换',
        nameEn: 'Pre-flow Transform',
        description: '对编码器输出进行非线性变换，为扩散模型准备条件',
        descriptionEn: 'Non-linear transform on encoder outputs to prepare conditions for diffusion',
        files: ['preflow.onnx', 'preflow.onnx.data'],
        sessionKey: 'preflow',
      },
      {
        id: 'condEmb',
        name: '条件嵌入',
        nameEn: 'Condition Embedding',
        description: '将组合条件映射为扩散模型的引导条件',
        descriptionEn: 'Map combined conditions to diffusion model guidance',
        files: ['cond_emb.onnx', 'cond_emb.onnx.data'],
        sessionKey: 'condEmb',
      },
      {
        id: 'diffStep',
        name: '扩散步',
        nameEn: 'Diffusion Step',
        description: '扩散模型核心单步推理，执行反向去噪',
        descriptionEn: 'Core diffusion step for reverse denoising',
        files: ['diff_step_dml.onnx'],
        sessionKey: 'diffStep',
      },
      {
        id: 'vocoder',
        name: '声码器',
        nameEn: 'Vocoder',
        description: '将梅尔频谱重建为音频波形',
        descriptionEn: 'Reconstruct audio waveform from mel spectrogram',
        files: ['vocoder_dml.onnx'],
        sessionKey: 'vocoder',
      },
      {
        id: 'melTransform',
        name: '梅尔变换',
        nameEn: 'Mel Transform',
        description: '将参考音频波形转换为梅尔频谱',
        descriptionEn: 'Convert reference audio waveform to mel spectrogram',
        files: ['mel_transform.onnx', 'mel_transform.onnx.data'],
        sessionKey: 'melTransform',
      },
    ],
  },
  {
    id: 'sifigan-vocoder',
    name: 'SiFiGAN Vocoder',
    nameEn: 'SiFiGAN Vocoder',
    description: '可选替代声码器，基于 Source-Filter HiFi-GAN，支持音高可控',
    descriptionEn: 'Optional alternative vocoder based on Source-Filter HiFi-GAN with pitch controllability',
    required: false,
    optional: true,
    pipelineRef: 'svsPipeline',
    models: [
      {
        id: 'sifiganVocoder',
        name: 'SiFiGAN 声码器',
        nameEn: 'SiFiGAN Vocoder',
        description: '可选替代声码器，基于 Source-Filter HiFi-GAN，支持音高可控',
        descriptionEn: 'Optional alternative vocoder based on Source-Filter HiFi-GAN with pitch controllability',
        files: ['sifigan_vocoder_dml.onnx', 'sifigan_stats.joblib'],
        sessionKey: 'sifigan',
      },
    ],
  },
  {
    id: 'rmvpe',
    name: 'RMVPE 音高检测',
    nameEn: 'RMVPE Pitch Detection',
    description: '基于 RMVPE 的 F0 基频提取，用于音频预处理',
    descriptionEn: 'RMVPE-based F0 extraction for audio preprocessing',
    required: false,
    pipelineRef: 'rmvpeDetector',
    models: [
      {
        id: 'rmvpeModel',
        name: 'RMVPE 模型',
        nameEn: 'RMVPE Model',
        description: '从音频中提取 F0 基频曲线',
        descriptionEn: 'Extract F0 fundamental frequency curve from audio',
        files: ['preprocess/rmvpe_model.onnx'],
        sessionKey: 'rmvpe',
      },
    ],
  },
  {
    id: 'basicPitch',
    name: 'Basic Pitch MIDI 提取',
    nameEn: 'Basic Pitch MIDI Extraction',
    description: '基于 Basic Pitch 的 MIDI 音符提取，用于音频转 MIDI',
    descriptionEn: 'Basic Pitch-based MIDI note extraction for audio-to-MIDI',
    required: false,
    pipelineRef: 'basicPitchDetector',
    models: [
      {
        id: 'basicPitchModel',
        name: 'Basic Pitch 模型',
        nameEn: 'Basic Pitch Model',
        description: '从音频中提取 MIDI 音符信息',
        descriptionEn: 'Extract MIDI note information from audio',
        files: ['basic_pitch_model/model.json', 'basic_pitch_model/group1-shard1of1.bin'],
        sessionKey: 'basicPitch',
      },
    ],
  },
  {
    id: 'rosvot',
    name: 'RosVot MIDI 识别',
    nameEn: 'RosVot MIDI Recognition',
    description: '基于 RosVot 的 MIDI 音符识别，配合 RMVPE 使用，用于精确音频转 MIDI',
    descriptionEn: 'RosVot-based MIDI note recognition, used with RMVPE for accurate audio-to-MIDI',
    required: false,
    disabled: true,
    disabledReason: 'ONNX 导出存在问题，当前只能提取 F0，MIDI 音符提取结果为空，待修复后启用',
    pipelineRef: 'rosvotDetector',
    models: [
      {
        id: 'rosvotModel',
        name: 'RosVot 模型',
        nameEn: 'RosVot Model',
        description: '从音频和 F0 基频中识别 MIDI 音符边界和音高',
        descriptionEn: 'Recognize MIDI note boundaries and pitches from audio and F0',
        files: ['preprocess/rosvot_model.onnx'],
        sessionKey: 'rosvot',
      },
    ],
  },
  {
    id: 'svs-jp',
    name: 'SVS 日语模型',
    nameEn: 'SVS Japanese Models',
    description: '日语歌声合成专用模型（音素文本编码器 + 预流变换），需配合基础 SVS 管线使用',
    descriptionEn: 'Japanese singing synthesis models (text encoder + preflow), used with base SVS pipeline',
    required: false,
    language: 'ja',
    pipelineRef: 'svsPipeline',
    models: [
      {
        id: 'noteTextEncoderJp',
        name: '日语音素文本编码器',
        nameEn: 'JP Phoneme Text Encoder',
        description: '扩展的日语音素嵌入编码器（3033 音素）',
        descriptionEn: 'Extended Japanese phoneme embedding encoder (3033 phonemes)',
        files: ['note_text_encoder.onnx', 'note_text_encoder.onnx.data'],
        sessionKey: 'noteTextEncoder',
      },
      {
        id: 'preflowJp',
        name: '日语预流变换',
        nameEn: 'JP Pre-flow Transform',
        description: '日语微调的预流变换模型',
        descriptionEn: 'Japanese fine-tuned pre-flow transform model',
        files: ['preflow.onnx', 'preflow.onnx.data'],
        sessionKey: 'preflow',
      },
    ],
  },
];

/**
 * 获取所有模型组
 * 新模型组可以通过在数组末尾追加来扩展
 */
function getModelGroups() {
  return MODEL_GROUPS;
}

/**
 * 根据 groupId 获取模型组
 */
function getModelGroup(groupId) {
  return MODEL_GROUPS.find(g => g.id === groupId);
}

/**
 * 根据 groupId 和 modelId 获取模型定义
 */
function getModelDef(groupId, modelId) {
  const group = getModelGroup(groupId);
  if (!group) return null;
  return group.models.find(m => m.id === modelId);
}

/**
 * 获取所有模型的文件列表（去重）
 */
function getAllModelFiles() {
  const files = new Set();
  for (const group of MODEL_GROUPS) {
    for (const model of group.models) {
      for (const file of model.files) {
        files.add(file);
      }
    }
  }
  return [...files];
}

module.exports = {
  MODEL_GROUPS,
  getModelGroups,
  getModelGroup,
  getModelDef,
  getAllModelFiles,
};
