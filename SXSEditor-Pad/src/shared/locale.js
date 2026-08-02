/**
 * locale.js
 * Multi-language support for SXSEditor-Pad.
 *
 * Provides Chinese (zh-CN), English (en-US), and Japanese (ja-JP) translations
 * for all UI strings used in the main interface.
 *
 * @module shared/locale
 */

// ==================== Locale Definitions ====================

/**
 * @type {Object<string, Object<string, string>>}
 */
const messages = {
  // ==================== Chinese (Simplified) ====================
  'zh-CN': {
    // --- App ---
    'app.name': 'SXSEditor-Pad',
    'app.version': '版本',
    'app.loading': '加载中...',
    'app.initializing': '正在初始化...',
    'app.ready': '就绪',
    'app.error': '错误',
    'app.warning': '警告',
    'app.success': '成功',
    'app.info': '提示',
    'app.confirm': '确认',
    'app.cancel': '取消',
    'app.save': '保存',
    'app.close': '关闭',
    'app.delete': '删除',
    'app.edit': '编辑',
    'app.create': '新建',
    'app.rename': '重命名',
    'app.duplicate': '复制',
    'app.import': '导入',
    'app.export': '导出',
    'app.search': '搜索',
    'app.filter': '筛选',
    'app.sort': '排序',
    'app.yes': '是',
    'app.no': '否',
    'app.ok': '确定',
    'app.back': '返回',
    'app.next': '下一步',
    'app.finish': '完成',
    'app.retry': '重试',
    'app.done': '完成',
    'app.pending': '待处理',
    'app.processing': '处理中',
    'app.failed': '失败',
    'app.skipped': '已跳过',
    'app.all': '全部',
    'app.none': '无',
    'app.unknown': '未知',
    'app.unsaved': '未保存',
    'app.unsavedChanges': '有未保存的更改，是否保存？',

    // --- Navigation ---
    'nav.home': '首页',
    'nav.editor': '编辑器',
    'nav.projects': '项目',
    'nav.singers': '歌手',
    'nav.settings': '设置',
    'nav.market': '市场',
    'nav.resources': '资源管理',
    'nav.models': '模型管理',
    'nav.help': '帮助',
    'nav.about': '关于',
    'nav.update': '检查更新',
    'nav.splash': '启动画面',

    // --- Project ---
    'project.new': '新建项目',
    'project.open': '打开项目',
    'project.save': '保存项目',
    'project.saveAs': '另存为',
    'project.recent': '最近项目',
    'project.name': '项目名称',
    'project.path': '项目路径',
    'project.created': '创建时间',
    'project.modified': '修改时间',
    'project.duration': '时长',
    'project.tempo': '速度 (BPM)',
    'project.key': '调号',
    'project.timeSignature': '拍号',
    'project.sampleRate': '采样率',
    'project.unnamed': '未命名项目',
    'project.deleteConfirm': '确定要删除此项目吗？此操作不可撤销。',
    'project.importSuccess': '项目导入成功',
    'project.exportSuccess': '项目导出成功',
    'project.saveSuccess': '项目保存成功',
    'project.loadError': '加载项目失败',
    'project.saveError': '保存项目失败',
    'project.noProjects': '暂无项目',

    // --- Editor ---
    'editor.title': '片段编辑器',
    'editor.newTrack': '新建音轨',
    'editor.addTrack': '添加音轨',
    'editor.deleteTrack': '删除音轨',
    'editor.trackName': '音轨名称',
    'editor.trackVolume': '音量',
    'editor.trackPan': '声像',
    'editor.trackMute': '静音',
    'editor.trackSolo': '独奏',
    'editor.addNote': '添加音符',
    'editor.deleteNote': '删除音符',
    'editor.notePitch': '音高',
    'editor.noteStart': '开始时间',
    'editor.noteDuration': '时长',
    'editor.noteLyric': '歌词',
    'editor.notePhoneme': '音素',
    'editor.undo': '撤销',
    'editor.redo': '重做',
    'editor.zoomIn': '放大',
    'editor.zoomOut': '缩小',
    'editor.zoomReset': '重置缩放',
    'editor.snapToGrid': '吸附网格',
    'editor.play': '播放',
    'editor.pause': '暂停',
    'editor.stop': '停止',
    'editor.record': '录音',
    'editor.metronome': '节拍器',
    'editor.loop': '循环播放',
    'editor.exportAudio': '导出音频',
    'editor.exportMIDI': '导出MIDI',
    'editor.importMIDI': '导入MIDI',
    'editor.synthesize': '合成',
    'editor.synthesizeAll': '合成全部',
    'editor.synthesizeSelection': '合成选中',
    'editor.preview': '预览',
    'editor.noSelection': '未选中任何片段',
    'editor.unsavedConfirm': '编辑器中有未保存的更改，是否保存？',

    // --- Singer ---
    'singer.title': '歌手管理',
    'singer.add': '添加歌手',
    'singer.import': '导入歌手',
    'singer.export': '导出歌手',
    'singer.name': '歌手名称',
    'singer.trackName': '音轨名称',
    'singer.avatar': '头像',
    'singer.model': '模型文件',
    'singer.config': '配置文件',
    'singer.type': '类型',
    'singer.language': '语言',
    'singer.gender': '性别',
    'singer.male': '男',
    'singer.female': '女',
    'singer.other': '其他',
    'singer.download': '下载歌手',
    'singer.deleteConfirm': '确定要删除此歌手吗？',
    'singer.importSuccess': '歌手导入成功',
    'singer.exportSuccess': '歌手导出成功',
    'singer.noSingers': '暂无歌手',
    'singer.selectPrompt': '请选择一个歌手',
    'singer.default': '默认歌手',

    // --- Synthesis ---
    'synth.title': '歌声合成',
    'synth.start': '开始合成',
    'synth.stop': '停止合成',
    'synth.progress': '合成进度',
    'synth.processing': '正在合成...',
    'synth.complete': '合成完成',
    'synth.error': '合成出错',
    'synth.pipelineInit': '正在初始化合成管线...',
    'synth.pipelineReady': '合成管线就绪',
    'synth.pipelineError': '合成管线初始化失败',
    'synth.modelLoading': '正在加载模型...',
    'synth.featureExtract': '正在提取特征...',
    'synth.acoustic': '声学模型推理中...',
    'synth.vocoder': '声码器推理中...',
    'synth.postProcess': '后处理中...',
    'synth.timeElapsed': '耗时',
    'synth.device': '推理设备',
    'synth.deviceAuto': '自动选择',
    'synth.deviceCPU': 'CPU',
    'synth.deviceCUDA': 'CUDA',
    'synth.deviceDirectML': 'DirectML',
    'synth.deviceCoreML': 'CoreML',
    'synth.deviceWebNN': 'WebNN',
    'synth.duration': '合成时长',

    // --- Settings ---
    'settings.title': '设置',
    'settings.general': '通用设置',
    'settings.audio': '音频设置',
    'settings.synthesis': '合成设置',
    'settings.theme': '主题设置',
    'settings.language': '语言设置',
    'settings.update': '更新设置',
    'settings.about': '关于',
    'settings.locale': '界面语言',
    'settings.localeZh': '中文',
    'settings.localeEn': 'English',
    'settings.localeJa': '日本語',
    'settings.themeMode': '主题模式',
    'settings.themeDark': '深色模式',
    'settings.themeLight': '浅色模式',
    'settings.themeSystem': '跟随系统',
    'settings.modelDir': '模型目录',
    'settings.modelDirSelect': '选择模型目录',
    'settings.modelDirChange': '更改模型目录',
    'settings.audioDevice': '音频输出设备',
    'settings.audioDeviceDefault': '默认设备',
    'settings.audioSampleRate': '采样率',
    'settings.audioBufferSize': '缓冲区大小',
    'settings.synthDevice': '合成设备',
    'settings.synthThreads': '合成线程数',
    'settings.synthUseGPU': '使用GPU加速',
    'settings.synthGPUId': 'GPU设备ID',
    'settings.updateAuto': '自动检查更新',
    'settings.updateChannel': '更新通道',
    'settings.updateChannelStable': '稳定版',
    'settings.updateChannelBeta': '测试版',
    'settings.updateChannelDev': '开发版',
    'settings.reset': '恢复默认设置',
    'settings.resetConfirm': '确定要恢复默认设置吗？',
    'settings.saveSuccess': '设置保存成功',
    'settings.loadError': '加载设置失败',

    // --- Model Download ---
    'download.title': '模型下载',
    'download.start': '开始下载',
    'download.pause': '暂停',
    'download.resume': '继续',
    'download.cancel': '取消下载',
    'download.retry': '重试下载',
    'download.progress': '下载进度',
    'download.speed': '下载速度',
    'download.size': '文件大小',
    'download.remaining': '剩余时间',
    'download.complete': '下载完成',
    'download.error': '下载出错',
    'download.statusPending': '等待中',
    'download.statusDownloading': '下载中',
    'download.statusPaused': '已暂停',
    'download.statusCompleted': '已完成',
    'download.statusFailed': '下载失败',
    'download.statusCancelled': '已取消',
    'download.selectModel': '选择要下载的模型',
    'download.availableModels': '可用模型',
    'download.installedModels': '已安装模型',
    'download.checking': '正在检查模型...',
    'download.noModels': '暂无可用模型',
    'download.confirmCancel': '确定要取消下载吗？',

    // --- Market ---
    'market.title': '歌手市场',
    'market.login': '登录',
    'market.register': '注册',
    'market.logout': '退出登录',
    'market.username': '用户名',
    'market.password': '密码',
    'market.email': '邮箱',
    'market.loginTitle': '登录账号',
    'market.registerTitle': '注册账号',
    'market.loginSuccess': '登录成功',
    'market.registerSuccess': '注册成功',
    'market.logoutSuccess': '已退出登录',
    'market.loginError': '登录失败',
    'market.purchase': '购买',
    'market.purchased': '已购买',
    'market.free': '免费',
    'market.price': '价格',
    'market.author': '作者',
    'market.rating': '评分',
    'market.downloads': '下载量',
    'market.search': '搜索歌手...',
    'market.noResults': '未找到匹配的歌手',
    'market.purchaseConfirm': '确定要购买此歌手吗？',
    'market.purchaseSuccess': '购买成功',
    'market.downloadStart': '开始下载歌手',
    'market.downloadComplete': '歌手下载完成',

    // --- Update ---
    'update.title': '检查更新',
    'update.checking': '正在检查更新...',
    'update.available': '发现新版本',
    'update.notAvailable': '已是最新版本',
    'update.currentVersion': '当前版本',
    'update.newVersion': '最新版本',
    'update.releaseDate': '发布日期',
    'update.releaseNotes': '更新说明',
    'update.download': '下载更新',
    'update.downloading': '正在下载更新...',
    'update.downloadComplete': '下载完成',
    'update.install': '立即安装',
    'update.installLater': '稍后安装',
    'update.installConfirm': '安装更新后将重启应用，是否继续？',
    'update.error': '检查更新失败',
    'update.downloadError': '下载更新失败',
    'update.progress': '更新下载进度',

    // --- Audio ---
    'audio.play': '播放',
    'audio.pause': '暂停',
    'audio.stop': '停止',
    'audio.volume': '音量',
    'audio.position': '当前位置',
    'audio.duration': '总时长',
    'audio.device': '音频设备',
    'audio.noDevice': '未检测到音频设备',
    'audio.playbackError': '播放出错',
    'audio.exportTitle': '导出音频',
    'audio.exportFormat': '导出格式',
    'audio.exportWAV': 'WAV',
    'audio.exportMP3': 'MP3',
    'audio.exportFLAC': 'FLAC',
    'audio.exportOGG': 'OGG',
    'audio.exportSuccess': '音频导出成功',
    'audio.exportError': '音频导出失败',

    // --- File ---
    'file.open': '打开文件',
    'file.save': '保存文件',
    'file.saveAs': '另存为',
    'file.new': '新建文件',
    'file.import': '导入文件',
    'file.export': '导出文件',
    'file.supportedFormats': '支持的格式',
    'file.allFiles': '所有文件',
    'file.audioFiles': '音频文件',
    'file.midiFiles': 'MIDI文件',
    'file.projectFiles': '项目文件',
    'file.modelFiles': '模型文件',
    'file.configFiles': '配置文件',
    'file.overwriteConfirm': '文件已存在，是否覆盖？',
    'file.notFound': '文件未找到',
    'file.readError': '读取文件失败',
    'file.writeError': '写入文件失败',
    'file.permissionDenied': '权限不足',

    // --- Resource ---
    'resource.title': '资源管理',
    'resource.memory': '内存使用',
    'resource.gpuMemory': 'GPU显存',
    'resource.cpuUsage': 'CPU使用率',
    'resource.diskUsage': '磁盘使用',
    'resource.modelCache': '模型缓存',
    'resource.clearCache': '清除缓存',
    'resource.clearCacheConfirm': '确定要清除缓存吗？',
    'resource.cacheCleared': '缓存已清除',

    // --- Error ---
    'error.unknown': '发生未知错误',
    'error.network': '网络连接失败',
    'error.timeout': '操作超时',
    'error.notSupported': '不支持此操作',
    'error.notImplemented': '此功能尚未实现',
    'error.invalidInput': '输入无效',
    'error.fileNotFound': '文件未找到',
    'error.permissionDenied': '权限被拒绝',
    'error.diskFull': '磁盘空间不足',
    'error.outOfMemory': '内存不足',
    'error.gpuNotAvailable': 'GPU不可用',
    'error.modelNotFound': '模型未找到',
    'error.modelLoadFailed': '模型加载失败',
    'error.synthesisFailed': '合成失败',
    'error.audioPlaybackFailed': '音频播放失败',

    // --- Shortcuts ---
    'shortcut.playPause': '播放/暂停',
    'shortcut.stop': '停止',
    'shortcut.save': '保存',
    'shortcut.undo': '撤销',
    'shortcut.redo': '重做',
    'shortcut.zoomIn': '放大',
    'shortcut.zoomOut': '缩小',
    'shortcut.delete': '删除选中',
    'shortcut.selectAll': '全选',
    'shortcut.copy': '复制',
    'shortcut.cut': '剪切',
    'shortcut.paste': '粘贴',
    'shortcut.synthesize': '合成选中',
    'shortcut.export': '导出音频',
    'shortcut.toggleMetronome': '切换节拍器',
    'shortcut.toggleLoop': '切换循环',
  },

  // ==================== English ====================
  'en-US': {
    // --- App ---
    'app.name': 'SXSEditor-Pad',
    'app.version': 'Version',
    'app.loading': 'Loading...',
    'app.initializing': 'Initializing...',
    'app.ready': 'Ready',
    'app.error': 'Error',
    'app.warning': 'Warning',
    'app.success': 'Success',
    'app.info': 'Info',
    'app.confirm': 'Confirm',
    'app.cancel': 'Cancel',
    'app.save': 'Save',
    'app.close': 'Close',
    'app.delete': 'Delete',
    'app.edit': 'Edit',
    'app.create': 'Create',
    'app.rename': 'Rename',
    'app.duplicate': 'Duplicate',
    'app.import': 'Import',
    'app.export': 'Export',
    'app.search': 'Search',
    'app.filter': 'Filter',
    'app.sort': 'Sort',
    'app.yes': 'Yes',
    'app.no': 'No',
    'app.ok': 'OK',
    'app.back': 'Back',
    'app.next': 'Next',
    'app.finish': 'Finish',
    'app.retry': 'Retry',
    'app.done': 'Done',
    'app.pending': 'Pending',
    'app.processing': 'Processing',
    'app.failed': 'Failed',
    'app.skipped': 'Skipped',
    'app.all': 'All',
    'app.none': 'None',
    'app.unknown': 'Unknown',
    'app.unsaved': 'Unsaved',
    'app.unsavedChanges': 'You have unsaved changes. Save them?',

    // --- Navigation ---
    'nav.home': 'Home',
    'nav.editor': 'Editor',
    'nav.projects': 'Projects',
    'nav.singers': 'Singers',
    'nav.settings': 'Settings',
    'nav.market': 'Market',
    'nav.resources': 'Resources',
    'nav.models': 'Models',
    'nav.help': 'Help',
    'nav.about': 'About',
    'nav.update': 'Check Updates',
    'nav.splash': 'Splash',

    // --- Project ---
    'project.new': 'New Project',
    'project.open': 'Open Project',
    'project.save': 'Save Project',
    'project.saveAs': 'Save As',
    'project.recent': 'Recent Projects',
    'project.name': 'Project Name',
    'project.path': 'Project Path',
    'project.created': 'Created',
    'project.modified': 'Modified',
    'project.duration': 'Duration',
    'project.tempo': 'Tempo (BPM)',
    'project.key': 'Key',
    'project.timeSignature': 'Time Signature',
    'project.sampleRate': 'Sample Rate',
    'project.unnamed': 'Untitled Project',
    'project.deleteConfirm': 'Are you sure you want to delete this project? This action cannot be undone.',
    'project.importSuccess': 'Project imported successfully',
    'project.exportSuccess': 'Project exported successfully',
    'project.saveSuccess': 'Project saved successfully',
    'project.loadError': 'Failed to load project',
    'project.saveError': 'Failed to save project',
    'project.noProjects': 'No projects yet',

    // --- Editor ---
    'editor.title': 'Fragment Editor',
    'editor.newTrack': 'New Track',
    'editor.addTrack': 'Add Track',
    'editor.deleteTrack': 'Delete Track',
    'editor.trackName': 'Track Name',
    'editor.trackVolume': 'Volume',
    'editor.trackPan': 'Pan',
    'editor.trackMute': 'Mute',
    'editor.trackSolo': 'Solo',
    'editor.addNote': 'Add Note',
    'editor.deleteNote': 'Delete Note',
    'editor.notePitch': 'Pitch',
    'editor.noteStart': 'Start Time',
    'editor.noteDuration': 'Duration',
    'editor.noteLyric': 'Lyric',
    'editor.notePhoneme': 'Phoneme',
    'editor.undo': 'Undo',
    'editor.redo': 'Redo',
    'editor.zoomIn': 'Zoom In',
    'editor.zoomOut': 'Zoom Out',
    'editor.zoomReset': 'Reset Zoom',
    'editor.snapToGrid': 'Snap to Grid',
    'editor.play': 'Play',
    'editor.pause': 'Pause',
    'editor.stop': 'Stop',
    'editor.record': 'Record',
    'editor.metronome': 'Metronome',
    'editor.loop': 'Loop',
    'editor.exportAudio': 'Export Audio',
    'editor.exportMIDI': 'Export MIDI',
    'editor.importMIDI': 'Import MIDI',
    'editor.synthesize': 'Synthesize',
    'editor.synthesizeAll': 'Synthesize All',
    'editor.synthesizeSelection': 'Synthesize Selection',
    'editor.preview': 'Preview',
    'editor.noSelection': 'No fragment selected',
    'editor.unsavedConfirm': 'You have unsaved changes in the editor. Save them?',

    // --- Singer ---
    'singer.title': 'Singer Management',
    'singer.add': 'Add Singer',
    'singer.import': 'Import Singer',
    'singer.export': 'Export Singer',
    'singer.name': 'Singer Name',
    'singer.trackName': 'Track Name',
    'singer.avatar': 'Avatar',
    'singer.model': 'Model File',
    'singer.config': 'Config File',
    'singer.type': 'Type',
    'singer.language': 'Language',
    'singer.gender': 'Gender',
    'singer.male': 'Male',
    'singer.female': 'Female',
    'singer.other': 'Other',
    'singer.download': 'Download Singer',
    'singer.deleteConfirm': 'Are you sure you want to delete this singer?',
    'singer.importSuccess': 'Singer imported successfully',
    'singer.exportSuccess': 'Singer exported successfully',
    'singer.noSingers': 'No singers yet',
    'singer.selectPrompt': 'Please select a singer',
    'singer.default': 'Default Singer',

    // --- Synthesis ---
    'synth.title': 'Singing Voice Synthesis',
    'synth.start': 'Start Synthesis',
    'synth.stop': 'Stop Synthesis',
    'synth.progress': 'Synthesis Progress',
    'synth.processing': 'Synthesizing...',
    'synth.complete': 'Synthesis Complete',
    'synth.error': 'Synthesis Error',
    'synth.pipelineInit': 'Initializing synthesis pipeline...',
    'synth.pipelineReady': 'Synthesis pipeline ready',
    'synth.pipelineError': 'Failed to initialize synthesis pipeline',
    'synth.modelLoading': 'Loading model...',
    'synth.featureExtract': 'Extracting features...',
    'synth.acoustic': 'Acoustic model inference...',
    'synth.vocoder': 'Vocoder inference...',
    'synth.postProcess': 'Post-processing...',
    'synth.timeElapsed': 'Time elapsed',
    'synth.device': 'Inference Device',
    'synth.deviceAuto': 'Auto',
    'synth.deviceCPU': 'CPU',
    'synth.deviceCUDA': 'CUDA',
    'synth.deviceDirectML': 'DirectML',
    'synth.deviceCoreML': 'CoreML',
    'synth.deviceWebNN': 'WebNN',
    'synth.duration': 'Synthesis Duration',

    // --- Settings ---
    'settings.title': 'Settings',
    'settings.general': 'General',
    'settings.audio': 'Audio',
    'settings.synthesis': 'Synthesis',
    'settings.theme': 'Theme',
    'settings.language': 'Language',
    'settings.update': 'Update',
    'settings.about': 'About',
    'settings.locale': 'Language',
    'settings.localeZh': '中文',
    'settings.localeEn': 'English',
    'settings.localeJa': '日本語',
    'settings.themeMode': 'Theme Mode',
    'settings.themeDark': 'Dark',
    'settings.themeLight': 'Light',
    'settings.themeSystem': 'System',
    'settings.modelDir': 'Model Directory',
    'settings.modelDirSelect': 'Select Model Directory',
    'settings.modelDirChange': 'Change Model Directory',
    'settings.audioDevice': 'Audio Output Device',
    'settings.audioDeviceDefault': 'Default Device',
    'settings.audioSampleRate': 'Sample Rate',
    'settings.audioBufferSize': 'Buffer Size',
    'settings.synthDevice': 'Synthesis Device',
    'settings.synthThreads': 'Synthesis Threads',
    'settings.synthUseGPU': 'Use GPU Acceleration',
    'settings.synthGPUId': 'GPU Device ID',
    'settings.updateAuto': 'Auto-check Updates',
    'settings.updateChannel': 'Update Channel',
    'settings.updateChannelStable': 'Stable',
    'settings.updateChannelBeta': 'Beta',
    'settings.updateChannelDev': 'Dev',
    'settings.reset': 'Reset to Default',
    'settings.resetConfirm': 'Are you sure you want to reset settings?',
    'settings.saveSuccess': 'Settings saved successfully',
    'settings.loadError': 'Failed to load settings',

    // --- Model Download ---
    'download.title': 'Model Download',
    'download.start': 'Start Download',
    'download.pause': 'Pause',
    'download.resume': 'Resume',
    'download.cancel': 'Cancel Download',
    'download.retry': 'Retry Download',
    'download.progress': 'Download Progress',
    'download.speed': 'Download Speed',
    'download.size': 'File Size',
    'download.remaining': 'Time Remaining',
    'download.complete': 'Download Complete',
    'download.error': 'Download Error',
    'download.statusPending': 'Pending',
    'download.statusDownloading': 'Downloading',
    'download.statusPaused': 'Paused',
    'download.statusCompleted': 'Completed',
    'download.statusFailed': 'Failed',
    'download.statusCancelled': 'Cancelled',
    'download.selectModel': 'Select Model to Download',
    'download.availableModels': 'Available Models',
    'download.installedModels': 'Installed Models',
    'download.checking': 'Checking models...',
    'download.noModels': 'No models available',
    'download.confirmCancel': 'Are you sure you want to cancel the download?',

    // --- Market ---
    'market.title': 'Singer Market',
    'market.login': 'Login',
    'market.register': 'Register',
    'market.logout': 'Logout',
    'market.username': 'Username',
    'market.password': 'Password',
    'market.email': 'Email',
    'market.loginTitle': 'Login',
    'market.registerTitle': 'Register',
    'market.loginSuccess': 'Login successful',
    'market.registerSuccess': 'Registration successful',
    'market.logoutSuccess': 'Logged out',
    'market.loginError': 'Login failed',
    'market.purchase': 'Purchase',
    'market.purchased': 'Purchased',
    'market.free': 'Free',
    'market.price': 'Price',
    'market.author': 'Author',
    'market.rating': 'Rating',
    'market.downloads': 'Downloads',
    'market.search': 'Search singers...',
    'market.noResults': 'No matching singers found',
    'market.purchaseConfirm': 'Are you sure you want to purchase this singer?',
    'market.purchaseSuccess': 'Purchase successful',
    'market.downloadStart': 'Downloading singer',
    'market.downloadComplete': 'Singer download complete',

    // --- Update ---
    'update.title': 'Check for Updates',
    'update.checking': 'Checking for updates...',
    'update.available': 'New version available',
    'update.notAvailable': 'You are up to date',
    'update.currentVersion': 'Current Version',
    'update.newVersion': 'New Version',
    'update.releaseDate': 'Release Date',
    'update.releaseNotes': 'Release Notes',
    'update.download': 'Download Update',
    'update.downloading': 'Downloading update...',
    'update.downloadComplete': 'Download complete',
    'update.install': 'Install Now',
    'update.installLater': 'Install Later',
    'update.installConfirm': 'The app will restart after installation. Continue?',
    'update.error': 'Failed to check for updates',
    'update.downloadError': 'Failed to download update',
    'update.progress': 'Update download progress',

    // --- Audio ---
    'audio.play': 'Play',
    'audio.pause': 'Pause',
    'audio.stop': 'Stop',
    'audio.volume': 'Volume',
    'audio.position': 'Position',
    'audio.duration': 'Duration',
    'audio.device': 'Audio Device',
    'audio.noDevice': 'No audio device detected',
    'audio.playbackError': 'Playback error',
    'audio.exportTitle': 'Export Audio',
    'audio.exportFormat': 'Export Format',
    'audio.exportWAV': 'WAV',
    'audio.exportMP3': 'MP3',
    'audio.exportFLAC': 'FLAC',
    'audio.exportOGG': 'OGG',
    'audio.exportSuccess': 'Audio exported successfully',
    'audio.exportError': 'Audio export failed',

    // --- File ---
    'file.open': 'Open File',
    'file.save': 'Save File',
    'file.saveAs': 'Save As',
    'file.new': 'New File',
    'file.import': 'Import File',
    'file.export': 'Export File',
    'file.supportedFormats': 'Supported Formats',
    'file.allFiles': 'All Files',
    'file.audioFiles': 'Audio Files',
    'file.midiFiles': 'MIDI Files',
    'file.projectFiles': 'Project Files',
    'file.modelFiles': 'Model Files',
    'file.configFiles': 'Config Files',
    'file.overwriteConfirm': 'File already exists. Overwrite?',
    'file.notFound': 'File not found',
    'file.readError': 'Failed to read file',
    'file.writeError': 'Failed to write file',
    'file.permissionDenied': 'Permission denied',

    // --- Resource ---
    'resource.title': 'Resource Manager',
    'resource.memory': 'Memory Usage',
    'resource.gpuMemory': 'GPU Memory',
    'resource.cpuUsage': 'CPU Usage',
    'resource.diskUsage': 'Disk Usage',
    'resource.modelCache': 'Model Cache',
    'resource.clearCache': 'Clear Cache',
    'resource.clearCacheConfirm': 'Are you sure you want to clear the cache?',
    'resource.cacheCleared': 'Cache cleared',

    // --- Error ---
    'error.unknown': 'An unknown error occurred',
    'error.network': 'Network connection failed',
    'error.timeout': 'Operation timed out',
    'error.notSupported': 'Operation not supported',
    'error.notImplemented': 'This feature is not yet implemented',
    'error.invalidInput': 'Invalid input',
    'error.fileNotFound': 'File not found',
    'error.permissionDenied': 'Permission denied',
    'error.diskFull': 'Disk is full',
    'error.outOfMemory': 'Out of memory',
    'error.gpuNotAvailable': 'GPU is not available',
    'error.modelNotFound': 'Model not found',
    'error.modelLoadFailed': 'Failed to load model',
    'error.synthesisFailed': 'Synthesis failed',
    'error.audioPlaybackFailed': 'Audio playback failed',

    // --- Shortcuts ---
    'shortcut.playPause': 'Play/Pause',
    'shortcut.stop': 'Stop',
    'shortcut.save': 'Save',
    'shortcut.undo': 'Undo',
    'shortcut.redo': 'Redo',
    'shortcut.zoomIn': 'Zoom In',
    'shortcut.zoomOut': 'Zoom Out',
    'shortcut.delete': 'Delete Selected',
    'shortcut.selectAll': 'Select All',
    'shortcut.copy': 'Copy',
    'shortcut.cut': 'Cut',
    'shortcut.paste': 'Paste',
    'shortcut.synthesize': 'Synthesize Selected',
    'shortcut.export': 'Export Audio',
    'shortcut.toggleMetronome': 'Toggle Metronome',
    'shortcut.toggleLoop': 'Toggle Loop',
  },

  // ==================== Japanese ====================
  'ja-JP': {
    // --- App ---
    'app.name': 'SXSEditor-Pad',
    'app.version': 'バージョン',
    'app.loading': '読み込み中...',
    'app.initializing': '初期化中...',
    'app.ready': '準備完了',
    'app.error': 'エラー',
    'app.warning': '警告',
    'app.success': '成功',
    'app.info': '情報',
    'app.confirm': '確認',
    'app.cancel': 'キャンセル',
    'app.save': '保存',
    'app.close': '閉じる',
    'app.delete': '削除',
    'app.edit': '編集',
    'app.create': '新規作成',
    'app.rename': '名前変更',
    'app.duplicate': '複製',
    'app.import': 'インポート',
    'app.export': 'エクスポート',
    'app.search': '検索',
    'app.filter': 'フィルター',
    'app.sort': '並び替え',
    'app.yes': 'はい',
    'app.no': 'いいえ',
    'app.ok': 'OK',
    'app.back': '戻る',
    'app.next': '次へ',
    'app.finish': '完了',
    'app.retry': '再試行',
    'app.done': '完了',
    'app.pending': '保留中',
    'app.processing': '処理中',
    'app.failed': '失敗',
    'app.skipped': 'スキップ',
    'app.all': 'すべて',
    'app.none': 'なし',
    'app.unknown': '不明',
    'app.unsaved': '未保存',
    'app.unsavedChanges': '未保存の変更があります。保存しますか？',

    // --- Navigation ---
    'nav.home': 'ホーム',
    'nav.editor': 'エディター',
    'nav.projects': 'プロジェクト',
    'nav.singers': '歌手',
    'nav.settings': '設定',
    'nav.market': 'マーケット',
    'nav.resources': 'リソース',
    'nav.models': 'モデル管理',
    'nav.help': 'ヘルプ',
    'nav.about': 'について',
    'nav.update': 'アップデート確認',
    'nav.splash': 'スプラッシュ',

    // --- Project ---
    'project.new': '新規プロジェクト',
    'project.open': 'プロジェクトを開く',
    'project.save': 'プロジェクトを保存',
    'project.saveAs': '名前を付けて保存',
    'project.recent': '最近のプロジェクト',
    'project.name': 'プロジェクト名',
    'project.path': 'プロジェクトパス',
    'project.created': '作成日時',
    'project.modified': '更新日時',
    'project.duration': '長さ',
    'project.tempo': 'テンポ (BPM)',
    'project.key': 'キー',
    'project.timeSignature': '拍子記号',
    'project.sampleRate': 'サンプルレート',
    'project.unnamed': '無題のプロジェクト',
    'project.deleteConfirm': 'このプロジェクトを削除してもよろしいですか？この操作は元に戻せません。',
    'project.importSuccess': 'プロジェクトをインポートしました',
    'project.exportSuccess': 'プロジェクトをエクスポートしました',
    'project.saveSuccess': 'プロジェクトを保存しました',
    'project.loadError': 'プロジェクトの読み込みに失敗しました',
    'project.saveError': 'プロジェクトの保存に失敗しました',
    'project.noProjects': 'プロジェクトがありません',

    // --- Editor ---
    'editor.title': 'フラグメントエディター',
    'editor.newTrack': '新規トラック',
    'editor.addTrack': 'トラック追加',
    'editor.deleteTrack': 'トラック削除',
    'editor.trackName': 'トラック名',
    'editor.trackVolume': '音量',
    'editor.trackPan': 'パン',
    'editor.trackMute': 'ミュート',
    'editor.trackSolo': 'ソロ',
    'editor.addNote': 'ノート追加',
    'editor.deleteNote': 'ノート削除',
    'editor.notePitch': 'ピッチ',
    'editor.noteStart': '開始時間',
    'editor.noteDuration': '長さ',
    'editor.noteLyric': '歌詞',
    'editor.notePhoneme': '音素',
    'editor.undo': '元に戻す',
    'editor.redo': 'やり直し',
    'editor.zoomIn': '拡大',
    'editor.zoomOut': '縮小',
    'editor.zoomReset': 'ズームリセット',
    'editor.snapToGrid': 'グリッドにスナップ',
    'editor.play': '再生',
    'editor.pause': '一時停止',
    'editor.stop': '停止',
    'editor.record': '録音',
    'editor.metronome': 'メトロノーム',
    'editor.loop': 'ループ',
    'editor.exportAudio': 'オーディオ書き出し',
    'editor.exportMIDI': 'MIDI書き出し',
    'editor.importMIDI': 'MIDI読み込み',
    'editor.synthesize': '合成',
    'editor.synthesizeAll': 'すべて合成',
    'editor.synthesizeSelection': '選択を合成',
    'editor.preview': 'プレビュー',
    'editor.noSelection': 'フラグメントが選択されていません',
    'editor.unsavedConfirm': 'エディターに未保存の変更があります。保存しますか？',

    // --- Singer ---
    'singer.title': '歌手管理',
    'singer.add': '歌手追加',
    'singer.import': '歌手インポート',
    'singer.export': '歌手エクスポート',
    'singer.name': '歌手名',
    'singer.trackName': 'トラック名',
    'singer.avatar': 'アバター',
    'singer.model': 'モデルファイル',
    'singer.config': '設定ファイル',
    'singer.type': 'タイプ',
    'singer.language': '言語',
    'singer.gender': '性別',
    'singer.male': '男性',
    'singer.female': '女性',
    'singer.other': 'その他',
    'singer.download': '歌手ダウンロード',
    'singer.deleteConfirm': 'この歌手を削除してもよろしいですか？',
    'singer.importSuccess': '歌手をインポートしました',
    'singer.exportSuccess': '歌手をエクスポートしました',
    'singer.noSingers': '歌手が登録されていません',
    'singer.selectPrompt': '歌手を選択してください',
    'singer.default': 'デフォルト歌手',

    // --- Synthesis ---
    'synth.title': '歌声合成',
    'synth.start': '合成開始',
    'synth.stop': '合成停止',
    'synth.progress': '合成進捗',
    'synth.processing': '合成中...',
    'synth.complete': '合成完了',
    'synth.error': '合成エラー',
    'synth.pipelineInit': '合成パイプラインを初期化中...',
    'synth.pipelineReady': '合成パイプライン準備完了',
    'synth.pipelineError': '合成パイプラインの初期化に失敗しました',
    'synth.modelLoading': 'モデルを読み込み中...',
    'synth.featureExtract': '特徴抽出中...',
    'synth.acoustic': '音響モデル推論中...',
    'synth.vocoder': 'ボコーダー推論中...',
    'synth.postProcess': '後処理中...',
    'synth.timeElapsed': '経過時間',
    'synth.device': '推論デバイス',
    'synth.deviceAuto': '自動選択',
    'synth.deviceCPU': 'CPU',
    'synth.deviceCUDA': 'CUDA',
    'synth.deviceDirectML': 'DirectML',
    'synth.deviceCoreML': 'CoreML',
    'synth.deviceWebNN': 'WebNN',
    'synth.duration': '合成時間',

    // --- Settings ---
    'settings.title': '設定',
    'settings.general': '一般',
    'settings.audio': 'オーディオ',
    'settings.synthesis': '合成',
    'settings.theme': 'テーマ',
    'settings.language': '言語',
    'settings.update': 'アップデート',
    'settings.about': '情報',
    'settings.locale': '言語',
    'settings.localeZh': '中文',
    'settings.localeEn': 'English',
    'settings.localeJa': '日本語',
    'settings.themeMode': 'テーマモード',
    'settings.themeDark': 'ダーク',
    'settings.themeLight': 'ライト',
    'settings.themeSystem': 'システム設定に従う',
    'settings.modelDir': 'モデルディレクトリ',
    'settings.modelDirSelect': 'モデルディレクトリを選択',
    'settings.modelDirChange': 'モデルディレクトリ変更',
    'settings.audioDevice': 'オーディオ出力デバイス',
    'settings.audioDeviceDefault': 'デフォルトデバイス',
    'settings.audioSampleRate': 'サンプルレート',
    'settings.audioBufferSize': 'バッファサイズ',
    'settings.synthDevice': '合成デバイス',
    'settings.synthThreads': '合成スレッド数',
    'settings.synthUseGPU': 'GPUアクセラレーションを使用',
    'settings.synthGPUId': 'GPUデバイスID',
    'settings.updateAuto': '自動アップデート確認',
    'settings.updateChannel': 'アップデートチャンネル',
    'settings.updateChannelStable': '安定版',
    'settings.updateChannelBeta': 'ベータ版',
    'settings.updateChannelDev': '開発版',
    'settings.reset': 'デフォルトにリセット',
    'settings.resetConfirm': '設定をリセットしてもよろしいですか？',
    'settings.saveSuccess': '設定を保存しました',
    'settings.loadError': '設定の読み込みに失敗しました',

    // --- Model Download ---
    'download.title': 'モデルダウンロード',
    'download.start': 'ダウンロード開始',
    'download.pause': '一時停止',
    'download.resume': '再開',
    'download.cancel': 'ダウンロードキャンセル',
    'download.retry': '再試行',
    'download.progress': 'ダウンロード進捗',
    'download.speed': 'ダウンロード速度',
    'download.size': 'ファイルサイズ',
    'download.remaining': '残り時間',
    'download.complete': 'ダウンロード完了',
    'download.error': 'ダウンロードエラー',
    'download.statusPending': '待機中',
    'download.statusDownloading': 'ダウンロード中',
    'download.statusPaused': '一時停止中',
    'download.statusCompleted': '完了',
    'download.statusFailed': '失敗',
    'download.statusCancelled': 'キャンセル済み',
    'download.selectModel': 'ダウンロードするモデルを選択',
    'download.availableModels': '利用可能なモデル',
    'download.installedModels': 'インストール済みモデル',
    'download.checking': 'モデルを確認中...',
    'download.noModels': '利用可能なモデルはありません',
    'download.confirmCancel': 'ダウンロードをキャンセルしてもよろしいですか？',

    // --- Market ---
    'market.title': '歌手マーケット',
    'market.login': 'ログイン',
    'market.register': '登録',
    'market.logout': 'ログアウト',
    'market.username': 'ユーザー名',
    'market.password': 'パスワード',
    'market.email': 'メールアドレス',
    'market.loginTitle': 'ログイン',
    'market.registerTitle': '新規登録',
    'market.loginSuccess': 'ログインしました',
    'market.registerSuccess': '登録しました',
    'market.logoutSuccess': 'ログアウトしました',
    'market.loginError': 'ログインに失敗しました',
    'market.purchase': '購入',
    'market.purchased': '購入済み',
    'market.free': '無料',
    'market.price': '価格',
    'market.author': '作者',
    'market.rating': '評価',
    'market.downloads': 'ダウンロード数',
    'market.search': '歌手を検索...',
    'market.noResults': '該当する歌手が見つかりません',
    'market.purchaseConfirm': 'この歌手を購入してもよろしいですか？',
    'market.purchaseSuccess': '購入しました',
    'market.downloadStart': '歌手をダウンロード中',
    'market.downloadComplete': '歌手のダウンロードが完了しました',

    // --- Update ---
    'update.title': 'アップデート確認',
    'update.checking': 'アップデートを確認中...',
    'update.available': '新しいバージョンがあります',
    'update.notAvailable': '最新バージョンです',
    'update.currentVersion': '現在のバージョン',
    'update.newVersion': '新しいバージョン',
    'update.releaseDate': 'リリース日',
    'update.releaseNotes': 'リリースノート',
    'update.download': 'アップデートをダウンロード',
    'update.downloading': 'アップデートをダウンロード中...',
    'update.downloadComplete': 'ダウンロード完了',
    'update.install': '今すぐインストール',
    'update.installLater': '後でインストール',
    'update.installConfirm': 'インストール後にアプリが再起動します。続行しますか？',
    'update.error': 'アップデートの確認に失敗しました',
    'update.downloadError': 'アップデートのダウンロードに失敗しました',
    'update.progress': 'アップデートダウンロード進捗',

    // --- Audio ---
    'audio.play': '再生',
    'audio.pause': '一時停止',
    'audio.stop': '停止',
    'audio.volume': '音量',
    'audio.position': '再生位置',
    'audio.duration': '長さ',
    'audio.device': 'オーディオデバイス',
    'audio.noDevice': 'オーディオデバイスが検出されません',
    'audio.playbackError': '再生エラー',
    'audio.exportTitle': 'オーディオ書き出し',
    'audio.exportFormat': '書き出し形式',
    'audio.exportWAV': 'WAV',
    'audio.exportMP3': 'MP3',
    'audio.exportFLAC': 'FLAC',
    'audio.exportOGG': 'OGG',
    'audio.exportSuccess': 'オーディオを書き出しました',
    'audio.exportError': 'オーディオの書き出しに失敗しました',

    // --- File ---
    'file.open': 'ファイルを開く',
    'file.save': 'ファイルを保存',
    'file.saveAs': '名前を付けて保存',
    'file.new': '新規ファイル',
    'file.import': 'ファイルインポート',
    'file.export': 'ファイルエクスポート',
    'file.supportedFormats': '対応形式',
    'file.allFiles': 'すべてのファイル',
    'file.audioFiles': 'オーディオファイル',
    'file.midiFiles': 'MIDIファイル',
    'file.projectFiles': 'プロジェクトファイル',
    'file.modelFiles': 'モデルファイル',
    'file.configFiles': '設定ファイル',
    'file.overwriteConfirm': 'ファイルは既に存在します。上書きしますか？',
    'file.notFound': 'ファイルが見つかりません',
    'file.readError': 'ファイルの読み込みに失敗しました',
    'file.writeError': 'ファイルの書き込みに失敗しました',
    'file.permissionDenied': '権限がありません',

    // --- Resource ---
    'resource.title': 'リソース管理',
    'resource.memory': 'メモリ使用量',
    'resource.gpuMemory': 'GPUメモリ',
    'resource.cpuUsage': 'CPU使用率',
    'resource.diskUsage': 'ディスク使用量',
    'resource.modelCache': 'モデルキャッシュ',
    'resource.clearCache': 'キャッシュをクリア',
    'resource.clearCacheConfirm': 'キャッシュをクリアしてもよろしいですか？',
    'resource.cacheCleared': 'キャッシュをクリアしました',

    // --- Error ---
    'error.unknown': '不明なエラーが発生しました',
    'error.network': 'ネットワーク接続に失敗しました',
    'error.timeout': '操作がタイムアウトしました',
    'error.notSupported': 'この操作はサポートされていません',
    'error.notImplemented': 'この機能はまだ実装されていません',
    'error.invalidInput': '入力が無効です',
    'error.fileNotFound': 'ファイルが見つかりません',
    'error.permissionDenied': '権限が拒否されました',
    'error.diskFull': 'ディスク容量が不足しています',
    'error.outOfMemory': 'メモリが不足しています',
    'error.gpuNotAvailable': 'GPUが利用できません',
    'error.modelNotFound': 'モデルが見つかりません',
    'error.modelLoadFailed': 'モデルの読み込みに失敗しました',
    'error.synthesisFailed': '合成に失敗しました',
    'error.audioPlaybackFailed': 'オーディオ再生に失敗しました',

    // --- Shortcuts ---
    'shortcut.playPause': '再生/一時停止',
    'shortcut.stop': '停止',
    'shortcut.save': '保存',
    'shortcut.undo': '元に戻す',
    'shortcut.redo': 'やり直し',
    'shortcut.zoomIn': '拡大',
    'shortcut.zoomOut': '縮小',
    'shortcut.delete': '選択を削除',
    'shortcut.selectAll': 'すべて選択',
    'shortcut.copy': 'コピー',
    'shortcut.cut': '切り取り',
    'shortcut.paste': '貼り付け',
    'shortcut.synthesize': '選択を合成',
    'shortcut.export': 'オーディオ書き出し',
    'shortcut.toggleMetronome': 'メトロノーム切替',
    'shortcut.toggleLoop': 'ループ切替',
  },
};

// ==================== Supported Locales ====================

/**
 * List of supported locale identifiers.
 * @type {Array<{code: string, label: string, nativeLabel: string}>}
 */
export const SUPPORTED_LOCALES = [
  { code: 'zh-CN', label: 'Chinese (Simplified)', nativeLabel: '中文' },
  { code: 'en-US', label: 'English', nativeLabel: 'English' },
  { code: 'ja-JP', label: 'Japanese', nativeLabel: '日本語' },
];

/**
 * Default locale used as fallback when a key is missing in the current locale.
 * @type {string}
 */
export const DEFAULT_LOCALE = 'zh-CN';

// ==================== Locale Manager ====================

/**
 * Current active locale code (e.g. 'zh-CN', 'en-US', 'ja-JP').
 * @type {string}
 */
let _currentLocale = DEFAULT_LOCALE;

/**
 * Callbacks to invoke when the locale changes.
 * @type {Array<{callback: Function, once: boolean}>}
 */
const _changeListeners = [];

/**
 * Subscribe to locale change events.
 *
 * @param {Function} callback - Function called with the new locale code
 * @returns {() => void} Unsubscribe function
 */
export function onLocaleChange(callback) {
  _changeListeners.push({ callback, once: false });
  return () => {
    const idx = _changeListeners.findIndex((l) => l.callback === callback);
    if (idx >= 0) _changeListeners.splice(idx, 1);
  };
}

/**
 * Subscribe to the next locale change event only.
 *
 * @param {Function} callback - Function called with the new locale code
 * @returns {() => void} Unsubscribe function
 */
export function onceLocaleChange(callback) {
  _changeListeners.push({ callback, once: true });
  return () => {
    const idx = _changeListeners.findIndex((l) => l.callback === callback);
    if (idx >= 0) _changeListeners.splice(idx, 1);
  };
}

/**
 * Notify all registered listeners that the locale has changed.
 *
 * @param {string} locale - The new locale code
 */
function _notifyListeners(locale) {
  for (let i = _changeListeners.length - 1; i >= 0; i--) {
    const entry = _changeListeners[i];
    try {
      entry.callback(locale);
    } catch (err) {
      console.error('[locale] change listener error:', err);
    }
    if (entry.once) {
      _changeListeners.splice(i, 1);
    }
  }
}

// ==================== Core API ====================

/**
 * Set the active locale.
 *
 * @param {string} locale - Locale code (e.g. 'zh-CN', 'en-US', 'ja-JP')
 * @returns {boolean} Whether the locale was successfully set
 */
export function setLocale(locale) {
  if (!messages[locale]) {
    console.warn(`[locale] Unsupported locale: "${locale}". Falling back to "${DEFAULT_LOCALE}".`);
    locale = DEFAULT_LOCALE;
  }
  if (_currentLocale === locale) return true;

  _currentLocale = locale;
  _notifyListeners(locale);

  // Persist to DOM for CSS selectors
  document.documentElement.setAttribute('lang', locale);

  return true;
}

/**
 * Get the current active locale code.
 *
 * @returns {string} Current locale code
 */
export function getLocale() {
  return _currentLocale;
}

/**
 * Translate a message key into the current locale.
 *
 * Uses key dot-notation (e.g. 'app.name', 'editor.title').
 * Falls back to the default locale (zh-CN) if the key is missing
 * in the current locale, and then to the key itself if all else fails.
 *
 * @param {string} key - The message key
 * @param {object} [params] - Optional interpolation parameters (e.g. {name: 'xxx'})
 * @returns {string} The translated string
 */
export function t(key, params) {
  // Try current locale first
  let msg = messages[_currentLocale]?.[key];

  // Fallback to default locale
  if (msg === undefined || msg === null) {
    msg = messages[DEFAULT_LOCALE]?.[key];
  }

  // Final fallback: return the key itself
  if (msg === undefined || msg === null) {
    console.warn(`[locale] Missing translation key: "${key}"`);
    return key;
  }

  // Simple interpolation: replace {paramName} with values
  if (params && typeof params === 'object') {
    return msg.replace(/\{(\w+)\}/g, (match, paramName) => {
      const val = params[paramName];
      return val !== undefined && val !== null ? String(val) : match;
    });
  }

  return msg;
}

/**
 * Check if a given locale is supported.
 *
 * @param {string} locale - Locale code to check
 * @returns {boolean}
 */
export function isLocaleSupported(locale) {
  return !!messages[locale];
}

/**
 * Get all available locales with metadata.
 *
 * @returns {Array<{code: string, label: string, nativeLabel: string}>}
 */
export function getAvailableLocales() {
  return [...SUPPORTED_LOCALES];
}

/**
 * Get the number of translated strings for a given locale.
 *
 * @param {string} locale - Locale code
 * @returns {number} Count of translated keys
 */
export function getTranslationCount(locale) {
  const dict = messages[locale];
  return dict ? Object.keys(dict).length : 0;
}

/**
 * Auto-detect the user's preferred locale from the browser/OS settings.
 * Falls back to the default locale if detection fails or the detected
 * locale is not supported.
 *
 * @returns {string} Detected locale code
 */
export function detectLocale() {
  try {
    // Check navigator.language (primary browser language)
    const lang = navigator.language?.replace(/_/g, '-');

    if (lang) {
      // Try exact match first
      if (messages[lang]) return lang;

      // Try matching on language code only (e.g. 'zh' for 'zh-CN')
      const langPrefix = lang.split('-')[0];
      for (const supported of Object.keys(messages)) {
        if (supported.startsWith(langPrefix)) {
          return supported;
        }
      }
    }

    // Check navigator.languages (preferred languages list)
    const languages = navigator.languages || [];
    for (const lang of languages) {
      const normalized = lang.replace(/_/g, '-');
      if (messages[normalized]) return normalized;
    }
  } catch (err) {
    console.warn('[locale] Detection error:', err);
  }

  return DEFAULT_LOCALE;
}

/**
 * Initialize the locale system.
 *
 * - Detects the user's preferred locale
 * - Sets the initial locale
 * - Applies to the DOM
 *
 * @param {string} [preferredLocale] - Optional locale to use instead of auto-detection
 * @returns {string} The active locale code
 */
export function initLocale(preferredLocale) {
  const locale = preferredLocale || detectLocale();
  setLocale(locale);
  console.log(`[locale] Initialized with locale: "${_currentLocale}"`);
  return _currentLocale;
}

// ==================== Convenience Proxy ====================

/**
 * Proxy-based convenience object that allows direct property access
 * for translation keys:  locale.t('app.name')  or  locale.app.name
 *
 * @type {object}
 */
const locale = new Proxy(
  {
    t,
    setLocale,
    getLocale,
    initLocale,
    detectLocale,
    isLocaleSupported,
    getAvailableLocales,
    getTranslationCount,
    onLocaleChange,
    onceLocaleChange,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  },
  {
    get(target, prop) {
      // If the property exists on the target, return it
      if (prop in target) {
        return target[prop];
      }
      // Otherwise, treat it as a translation key with dot-notation
      if (typeof prop === 'string') {
        return t(prop);
      }
      return undefined;
    },
  }
);

export default locale;