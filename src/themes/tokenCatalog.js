/**
 * Token catalog metadata for the SXSEditor theme architecture.
 *
 * Every token has:
 *   - name:    full token name (with --)
 *   - layer:   'global' | 'alias' | 'component'
 *   - group:   display group label
 *   - type:    'color' | 'size' | 'motion' | 'shadow' | 'string'
 *   - default: fallback value when no theme is loaded
 *   - label:   human-readable Chinese label
 *
 * The catalog is used by the theme editor to enumerate tokens in groups
 * and by validators to detect missing tokens in a built-in theme.
 */

export const TOKEN_CATALOG = {
    // ==================== Global: blue scale ====================
    '--color-blue-50':  { layer: 'global', group: 'color-blue', type: 'color', default: '#eef4ff', label: '蓝 50' },
    '--color-blue-100': { layer: 'global', group: 'color-blue', type: 'color', default: '#dbe7ff', label: '蓝 100' },
    '--color-blue-200': { layer: 'global', group: 'color-blue', type: 'color', default: '#b7ceff', label: '蓝 200' },
    '--color-blue-300': { layer: 'global', group: 'color-blue', type: 'color', default: '#8fb1ff', label: '蓝 300' },
    '--color-blue-400': { layer: 'global', group: 'color-blue', type: 'color', default: '#6b9df5', label: '蓝 400' },
    '--color-blue-500': { layer: 'global', group: 'color-blue', type: 'color', default: '#5b8def', label: '蓝 500' },
    '--color-blue-600': { layer: 'global', group: 'color-blue', type: 'color', default: '#4a7de0', label: '蓝 600' },
    '--color-blue-700': { layer: 'global', group: 'color-blue', type: 'color', default: '#3a6ad0', label: '蓝 700' },
    '--color-blue-800': { layer: 'global', group: 'color-blue', type: 'color', default: '#2a55b5', label: '蓝 800' },
    '--color-blue-900': { layer: 'global', group: 'color-blue', type: 'color', default: '#1a3a85', label: '蓝 900' },

    // ==================== Global: gray scale ====================
    '--color-gray-50':  { layer: 'global', group: 'color-gray', type: 'color', default: '#f5f5fa', label: '灰 50' },
    '--color-gray-100': { layer: 'global', group: 'color-gray', type: 'color', default: '#e8e8f0', label: '灰 100' },
    '--color-gray-200': { layer: 'global', group: 'color-gray', type: 'color', default: '#d8d8ec', label: '灰 200' },
    '--color-gray-300': { layer: 'global', group: 'color-gray', type: 'color', default: '#c8c8dc', label: '灰 300' },
    '--color-gray-400': { layer: 'global', group: 'color-gray', type: 'color', default: '#a8a8c0', label: '灰 400' },
    '--color-gray-500': { layer: 'global', group: 'color-gray', type: 'color', default: '#8888a8', label: '灰 500' },
    '--color-gray-600': { layer: 'global', group: 'color-gray', type: 'color', default: '#6a6a86', label: '灰 600' },
    '--color-gray-700': { layer: 'global', group: 'color-gray', type: 'color', default: '#5a5a72', label: '灰 700' },
    '--color-gray-800': { layer: 'global', group: 'color-gray', type: 'color', default: '#4a4a66', label: '灰 800' },
    '--color-gray-900': { layer: 'global', group: 'color-gray', type: 'color', default: '#3a3a52', label: '灰 900' },

    // ==================== Global: ink / panel / base ====================
    '--color-ink-50':   { layer: 'global', group: 'color-ink', type: 'color', default: '#3a3a4e', label: '墨 50' },
    '--color-ink-100':  { layer: 'global', group: 'color-ink', type: 'color', default: '#323246', label: '墨 100' },
    '--color-ink-200':  { layer: 'global', group: 'color-ink', type: 'color', default: '#2f2f3d', label: '墨 200' },
    '--color-ink-300':  { layer: 'global', group: 'color-ink', type: 'color', default: '#2a2a3d', label: '墨 300' },
    '--color-ink-400':  { layer: 'global', group: 'color-ink', type: 'color', default: '#282838', label: '墨 400' },
    '--color-ink-500':  { layer: 'global', group: 'color-ink', type: 'color', default: '#252538', label: '墨 500' },
    '--color-ink-600':  { layer: 'global', group: 'color-ink', type: 'color', default: '#1e1e2e', label: '墨 600' },
    '--color-ink-700':  { layer: 'global', group: 'color-ink', type: 'color', default: '#1a1a2a', label: '墨 700' },
    '--color-ink-800':  { layer: 'global', group: 'color-ink', type: 'color', default: '#1a1a28', label: '墨 800' },
    '--color-ink-900':  { layer: 'global', group: 'color-ink', type: 'color', default: '#14141f', label: '墨 900' },

    // ==================== Global: red ====================
    '--color-red-300':  { layer: 'global', group: 'color-red', type: 'color', default: '#ff8888', label: '红 300' },
    '--color-red-400':  { layer: 'global', group: 'color-red', type: 'color', default: '#f87171', label: '红 400' },
    '--color-red-500':  { layer: 'global', group: 'color-red', type: 'color', default: '#ef4444', label: '红 500' },
    '--color-red-600':  { layer: 'global', group: 'color-red', type: 'color', default: '#e85555', label: '红 600' },

    // ==================== Global: green ====================
    '--color-green-300': { layer: 'global', group: 'color-green', type: 'color', default: '#5aee90', label: '绿 300' },
    '--color-green-400': { layer: 'global', group: 'color-green', type: 'color', default: '#4ade80', label: '绿 400' },
    '--color-green-500': { layer: 'global', group: 'color-green', type: 'color', default: '#3ac870', label: '绿 500' },
    '--color-green-600': { layer: 'global', group: 'color-green', type: 'color', default: '#22c55e', label: '绿 600' },

    // ==================== Global: amber / yellow ====================
    '--color-amber-300': { layer: 'global', group: 'color-amber', type: 'color', default: '#fbbf24', label: '琥珀 300' },
    '--color-amber-400': { layer: 'global', group: 'color-amber', type: 'color', default: '#f59e0b', label: '琥珀 400' },
    '--color-amber-500': { layer: 'global', group: 'color-amber', type: 'color', default: '#f0a810', label: '琥珀 500' },

    // ==================== Global: purple ====================
    '--color-purple-400': { layer: 'global', group: 'color-purple', type: 'color', default: '#a855f7', label: '紫 400' },

    // ==================== Global: white / black ====================
    '--color-white': { layer: 'global', group: 'color-base', type: 'color', default: '#ffffff', label: '白' },
    '--color-black': { layer: 'global', group: 'color-base', type: 'color', default: '#000000', label: '黑' },

    // ==================== Spacing scale ====================
    '--space-0':  { layer: 'global', group: 'space', type: 'size', default: '0', label: '空间 0' },
    '--space-1':  { layer: 'global', group: 'space', type: 'size', default: '2px', label: '空间 1' },
    '--space-2':  { layer: 'global', group: 'space', type: 'size', default: '4px', label: '空间 2' },
    '--space-3':  { layer: 'global', group: 'space', type: 'size', default: '6px', label: '空间 3' },
    '--space-4':  { layer: 'global', group: 'space', type: 'size', default: '8px', label: '空间 4' },
    '--space-5':  { layer: 'global', group: 'space', type: 'size', default: '12px', label: '空间 5' },
    '--space-6':  { layer: 'global', group: 'space', type: 'size', default: '16px', label: '空间 6' },
    '--space-7':  { layer: 'global', group: 'space', type: 'size', default: '20px', label: '空间 7' },
    '--space-8':  { layer: 'global', group: 'space', type: 'size', default: '24px', label: '空间 8' },

    // ==================== Radius scale ====================
    '--radius-sm':   { layer: 'global', group: 'radius', type: 'size', default: '2px', label: '圆角 小' },
    '--radius-md':   { layer: 'global', group: 'radius', type: 'size', default: '4px', label: '圆角 中' },
    '--radius-lg':   { layer: 'global', group: 'radius', type: 'size', default: '8px', label: '圆角 大' },
    '--radius-xl':   { layer: 'global', group: 'radius', type: 'size', default: '10px', label: '圆角 特大' },
    '--radius-2xl':  { layer: 'global', group: 'radius', type: 'size', default: '12px', label: '圆角 超大' },
    '--radius-full': { layer: 'global', group: 'radius', type: 'size', default: '9999px', label: '圆角 全圆' },

    // ==================== Font scale ====================
    '--font-xs':   { layer: 'global', group: 'font', type: 'size', default: '10px', label: '字号 极小' },
    '--font-sm':   { layer: 'global', group: 'font', type: 'size', default: '11px', label: '字号 小' },
    '--font-base': { layer: 'global', group: 'font', type: 'size', default: '12px', label: '字号 基础' },
    '--font-md':   { layer: 'global', group: 'font', type: 'size', default: '13px', label: '字号 中' },
    '--font-lg':   { layer: 'global', group: 'font', type: 'size', default: '14px', label: '字号 大' },
    '--font-xl':   { layer: 'global', group: 'font', type: 'size', default: '18px', label: '字号 特大' },
    '--font-2xl':  { layer: 'global', group: 'font', type: 'size', default: '20px', label: '字号 超大' },

    // ==================== Motion scale ====================
    '--motion-fast':  { layer: 'global', group: 'motion', type: 'motion', default: '0.15s', label: '动效 快' },
    '--motion-base':  { layer: 'global', group: 'motion', type: 'motion', default: '0.2s',  label: '动效 中' },
    '--motion-slow':  { layer: 'global', group: 'motion', type: 'motion', default: '0.3s',  label: '动效 慢' },

    // ==================== Shadows (string tokens) ====================
    '--shadow-sm': { layer: 'global', group: 'shadow', type: 'shadow', default: '0 1px 3px rgba(0, 0, 0, 0.2)', label: '阴影 小' },
    '--shadow-md': { layer: 'global', group: 'shadow', type: 'shadow', default: '0 2px 8px rgba(0, 0, 0, 0.25)', label: '阴影 中' },
    '--shadow-lg': { layer: 'global', group: 'shadow', type: 'shadow', default: '0 4px 16px rgba(0, 0, 0, 0.3)', label: '阴影 大' },
    '--shadow-xl': { layer: 'global', group: 'shadow', type: 'shadow', default: '0 8px 32px rgba(0, 0, 0, 0.5)', label: '阴影 特大' },

    // ==================== Alias: backgrounds ====================
    '--bg-app':         { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-900)', label: '应用背景' },
    '--bg-panel':       { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-700)', label: '面板背景' },
    '--bg-elevated':    { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-600)', label: '浮起背景' },
    '--bg-input':       { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-800)', label: '输入框背景' },
    '--bg-overlay':     { layer: 'alias', group: 'bg', type: 'color', default: 'rgba(10, 10, 20, 0.7)', label: '遮罩背景' },
    '--bg-toolbar-start': { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-200)', label: '工具栏渐变起' },
    '--bg-toolbar-end':   { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-400)', label: '工具栏渐变末' },
    '--bg-header-start':  { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-300)', label: '头部渐变起' },
    '--bg-header-end':    { layer: 'alias', group: 'bg', type: 'color', default: 'var(--color-ink-500)', label: '头部渐变末' },
    '--bg-button':        { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-ink-50) 0%, var(--color-ink-100) 100%)', label: '按钮背景' },
    '--bg-button-hover':  { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-gray-50) 0%, var(--color-gray-100) 100%)', label: '按钮悬停背景' },
    '--bg-button-active': { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-ink-300) 0%, var(--color-ink-400) 100%)', label: '按钮按下背景' },
    '--bg-button-primary':     { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-blue-500) 0%, var(--color-blue-600) 100%)', label: '主按钮背景' },
    '--bg-button-primary-hover': { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-blue-400) 0%, var(--color-blue-500) 100%)', label: '主按钮悬停背景' },
    '--bg-button-success':     { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-green-400) 0%, var(--color-green-500) 100%)', label: '成功按钮背景' },
    '--bg-button-success-hover': { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-green-300) 0%, var(--color-green-400) 100%)', label: '成功按钮悬停' },
    '--bg-button-danger':     { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-red-400) 0%, var(--color-red-600) 100%)', label: '危险按钮背景' },
    '--bg-button-danger-hover': { layer: 'alias', group: 'bg', type: 'color', default: 'linear-gradient(180deg, var(--color-red-300) 0%, var(--color-red-400) 100%)', label: '危险按钮悬停' },

    // ==================== Alias: foregrounds ====================
    '--fg-primary':   { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-ink-100)', label: '主前景' },
    '--fg-secondary': { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-gray-200)', label: '次前景' },
    '--fg-muted':     { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-gray-300)', label: '弱前景' },
    '--fg-disabled':  { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-gray-600)', label: '禁用前景' },
    '--fg-on-accent': { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-white)', label: '强调色文字' },
    '--fg-on-success': { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-ink-900)', label: '成功色文字' },
    '--fg-on-warning': { layer: 'alias', group: 'fg', type: 'color', default: 'var(--color-ink-900)', label: '警告色文字' },
    '--fg-toolbar-hover': { layer: 'alias', group: 'fg', type: 'color', default: '#f0f0ff', label: '工具栏悬停文字' },
    '--fg-bpm':            { layer: 'alias', group: 'fg', type: 'color', default: '#a8c8ff', label: 'BPM 显示文字' },
    '--fg-time':           { layer: 'alias', group: 'fg', type: 'color', default: '#e8e8f8', label: '时间显示文字' },
    '--bg-singer-active':  { layer: 'alias', group: 'bg', type: 'color', default: '#2a2a42', label: '歌手激活背景' },

    // ==================== Alias: accent ====================
    '--accent':         { layer: 'alias', group: 'accent', type: 'color', default: 'var(--color-blue-500)', label: '强调色' },
    '--accent-hover':   { layer: 'alias', group: 'accent', type: 'color', default: 'var(--color-blue-400)', label: '强调色悬停' },
    '--accent-pressed': { layer: 'alias', group: 'accent', type: 'color', default: 'var(--color-blue-600)', label: '强调色按下' },
    '--accent-soft':    { layer: 'alias', group: 'accent', type: 'color', default: 'rgba(91, 141, 239, 0.12)', label: '强调色弱化背景' },
    '--accent-softer':  { layer: 'alias', group: 'accent', type: 'color', default: 'rgba(91, 141, 239, 0.06)', label: '强调色极弱背景' },
    '--accent-glow':    { layer: 'alias', group: 'accent', type: 'color', default: 'rgba(91, 141, 239, 0.25)', label: '强调色发光' },
    '--accent-glow-strong': { layer: 'alias', group: 'accent', type: 'color', default: 'rgba(91, 141, 239, 0.35)', label: '强调色强发光' },
    '--accent-line':    { layer: 'alias', group: 'accent', type: 'color', default: 'rgba(91, 141, 239, 0.2)', label: '强调色描边' },
    '--accent-line-strong': { layer: 'alias', group: 'accent', type: 'color', default: 'rgba(91, 141, 239, 0.3)', label: '强调色强描边' },
    '--accent-fg':      { layer: 'alias', group: 'accent', type: 'color', default: 'var(--color-blue-400)', label: '强调色文字' },

    // ==================== Alias: status soft variants ====================
    '--success-soft':   { layer: 'alias', group: 'status', type: 'color', default: 'rgba(74, 222, 128, 0.12)', label: '成功弱化' },
    '--success-glow':   { layer: 'alias', group: 'status', type: 'color', default: 'rgba(74, 222, 128, 0.3)', label: '成功发光' },
    '--warning-soft':   { layer: 'alias', group: 'status', type: 'color', default: 'rgba(251, 191, 36, 0.12)', label: '警告弱化' },
    '--warning-line':   { layer: 'alias', group: 'status', type: 'color', default: 'rgba(251, 191, 36, 0.2)', label: '警告描边' },
    '--warning-glow':   { layer: 'alias', group: 'status', type: 'color', default: 'rgba(251, 191, 36, 0.06)', label: '警告发光弱' },
    '--danger-soft':    { layer: 'alias', group: 'status', type: 'color', default: 'rgba(239, 68, 68, 0.12)', label: '危险弱化' },
    '--danger-glow':    { layer: 'alias', group: 'status', type: 'color', default: 'rgba(248, 113, 113, 0.3)', label: '危险发光' },
    '--purple-soft':    { layer: 'alias', group: 'status', type: 'color', default: 'rgba(168, 85, 247, 0.12)', label: '紫色弱化' },

    // ==================== Alias: shadow / overlay ====================
    '--shadow-color':        { layer: 'alias', group: 'shadow', type: 'color', default: 'rgba(0, 0, 0, 0.2)', label: '阴影颜色弱' },
    '--shadow-color-mid':    { layer: 'alias', group: 'shadow', type: 'color', default: 'rgba(0, 0, 0, 0.3)', label: '阴影颜色中' },
    '--shadow-color-strong': { layer: 'alias', group: 'shadow', type: 'color', default: 'rgba(0, 0, 0, 0.5)', label: '阴影颜色强' },
    '--overlay-scrim':       { layer: 'alias', group: 'overlay', type: 'color', default: 'rgba(10, 10, 20, 0.7)', label: '遮罩背景' },
    '--panel-line':          { layer: 'alias', group: 'border', type: 'color', default: 'rgba(42, 42, 61, 0.5)', label: '面板描边' },
    '--ink-soft':            { layer: 'alias', group: 'fg', type: 'color', default: 'rgba(90, 90, 114, 0.3)', label: '弱墨色描边' },

    // ==================== Alias: borders ====================
    '--border-subtle': { layer: 'alias', group: 'border', type: 'color', default: 'var(--color-ink-800)', label: '浅边框' },
    '--border-default': { layer: 'alias', group: 'border', type: 'color', default: 'var(--color-ink-300)', label: '默认边框' },
    '--border-strong': { layer: 'alias', group: 'border', type: 'color', default: 'var(--color-gray-900)', label: '强边框' },
    '--border-accent': { layer: 'alias', group: 'border', type: 'color', default: 'var(--color-blue-500)', label: '强调边框' },

    // ==================== Alias: status ====================
    '--success': { layer: 'alias', group: 'status', type: 'color', default: 'var(--color-green-400)', label: '成功' },
    '--warning': { layer: 'alias', group: 'status', type: 'color', default: 'var(--color-amber-300)', label: '警告' },
    '--danger':  { layer: 'alias', group: 'status', type: 'color', default: 'var(--color-red-400)', label: '危险' },
    '--info':    { layer: 'alias', group: 'status', type: 'color', default: 'var(--color-blue-500)', label: '信息' },

    // ==================== Alias: scrollbar ====================
    '--scrollbar-thumb':       { layer: 'alias', group: 'scrollbar', type: 'color', default: 'var(--color-gray-900)', label: '滚动条滑块' },
    '--scrollbar-thumb-hover': { layer: 'alias', group: 'scrollbar', type: 'color', default: 'var(--color-gray-700)', label: '滚动条滑块悬停' },
    '--scrollbar-track':       { layer: 'alias', group: 'scrollbar', type: 'color', default: 'transparent', label: '滚动条轨道' },

    // ==================== Alias: selection / focus ====================
    '--selection-bg': { layer: 'alias', group: 'selection', type: 'color', default: 'rgba(91, 141, 239, 0.4)', label: '选区背景' },
    '--focus-ring':   { layer: 'alias', group: 'selection', type: 'color', default: '0 0 0 2px rgba(91, 141, 239, 0.3)', label: '焦点环' },

    // ==================== Component tokens ====================
    '--button-primary-bg':    { layer: 'component', group: 'button', type: 'color', default: 'var(--bg-button-primary)', label: '主按钮背景' },
    '--button-primary-fg':    { layer: 'component', group: 'button', type: 'color', default: 'var(--fg-on-accent)', label: '主按钮文字' },
    '--button-primary-hover': { layer: 'component', group: 'button', type: 'color', default: 'var(--bg-button-primary-hover)', label: '主按钮悬停' },
    '--button-secondary-bg':  { layer: 'component', group: 'button', type: 'color', default: 'var(--bg-button)', label: '次按钮背景' },
    '--button-secondary-fg':  { layer: 'component', group: 'button', type: 'color', default: 'var(--fg-secondary)', label: '次按钮文字' },
    '--button-secondary-border': { layer: 'component', group: 'button', type: 'color', default: 'var(--color-gray-900)', label: '次按钮边框' },
    '--button-disabled-bg':   { layer: 'component', group: 'button', type: 'color', default: 'var(--color-ink-300)', label: '禁用按钮背景' },
    '--button-danger-bg':     { layer: 'component', group: 'button', type: 'color', default: 'var(--bg-button-danger)', label: '危险按钮背景' },

    '--input-bg':         { layer: 'component', group: 'input', type: 'color', default: 'var(--bg-input)', label: '输入框背景' },
    '--input-border':     { layer: 'component', group: 'input', type: 'color', default: 'var(--color-gray-900)', label: '输入框边框' },
    '--input-fg':         { layer: 'component', group: 'input', type: 'color', default: 'var(--fg-primary)', label: '输入框文字' },
    '--input-focus-ring': { layer: 'component', group: 'input', type: 'color', default: 'var(--focus-ring)', label: '输入框焦点环' },
    '--input-placeholder':{ layer: 'component', group: 'input', type: 'color', default: 'var(--color-gray-800)', label: '输入框占位文字' },

    '--panel-bg':     { layer: 'component', group: 'panel', type: 'color', default: 'var(--bg-panel)', label: '面板背景' },
    '--panel-border': { layer: 'component', group: 'panel', type: 'color', default: 'var(--color-ink-300)', label: '面板边框' },
    '--panel-fg':     { layer: 'component', group: 'panel', type: 'color', default: 'var(--fg-secondary)', label: '面板文字' },

    '--tooltip-bg': { layer: 'component', group: 'tooltip', type: 'color', default: 'var(--color-ink-300)', label: '提示框背景' },
    '--tooltip-fg': { layer: 'component', group: 'tooltip', type: 'color', default: 'var(--fg-primary)', label: '提示框文字' },

    '--selection-bg-token': { layer: 'component', group: 'selection', type: 'color', default: 'var(--selection-bg)', label: '选区背景' },
    '--selection-fg':       { layer: 'component', group: 'selection', type: 'color', default: 'var(--fg-primary)', label: '选区文字' },

    // ==================== Structural: clip-paths ====================
    '--clip-button':  { layer: 'component', group: 'clip', type: 'string', default: 'none', label: '按钮切角' },
    '--clip-panel':   { layer: 'component', group: 'clip', type: 'string', default: 'none', label: '面板切角' },
    '--clip-badge':   { layer: 'component', group: 'clip', type: 'string', default: 'none', label: '标签切角' },

    // ==================== Structural: decorative ====================
    '--deco-accent-bar':     { layer: 'component', group: 'deco', type: 'string', default: '0', label: '装饰强调线宽' },
    '--deco-stripe':         { layer: 'component', group: 'deco', type: 'string', default: 'none', label: '装饰条纹背景' },
    '--toolbar-accent-line': { layer: 'component', group: 'deco', type: 'string', default: '0', label: '工具栏强调线' },
};

export const TOKEN_NAMES = Object.keys(TOKEN_CATALOG);

export const REQUIRED_TOKENS_FOR_BUILTIN = [
    // Global color scales
    ...Object.keys(TOKEN_CATALOG).filter(k => k.startsWith('--color-')),
    // Spacing / radius / font / motion
    ...Object.keys(TOKEN_CATALOG).filter(k => k.startsWith('--space-')),
    ...Object.keys(TOKEN_CATALOG).filter(k => k.startsWith('--radius-')),
    ...Object.keys(TOKEN_CATALOG).filter(k => k.startsWith('--font-')),
    ...Object.keys(TOKEN_CATALOG).filter(k => k.startsWith('--motion-')),
    // Aliases
    '--bg-app', '--bg-panel', '--bg-elevated', '--bg-input',
    '--fg-primary', '--fg-secondary', '--fg-muted',
    '--accent', '--accent-hover', '--accent-pressed', '--accent-soft', '--accent-softer',
    '--accent-glow', '--accent-glow-strong', '--accent-line', '--accent-line-strong', '--accent-fg',
    '--success-soft', '--success-glow',
    '--warning-soft', '--warning-line', '--warning-glow',
    '--danger-soft', '--danger-glow', '--purple-soft',
    '--shadow-color', '--shadow-color-mid', '--shadow-color-strong',
    '--overlay-scrim', '--panel-line', '--ink-soft',
    '--border-subtle', '--border-default', '--border-strong', '--border-accent',
    '--success', '--warning', '--danger', '--info',
    '--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-track',
    '--selection-bg', '--focus-ring',
    // Component
    '--button-primary-bg', '--button-primary-fg', '--button-primary-hover',
    '--button-secondary-bg', '--button-secondary-fg', '--button-secondary-border',
    '--button-disabled-bg', '--button-danger-bg',
    '--input-bg', '--input-border', '--input-fg', '--input-focus-ring', '--input-placeholder',
    '--panel-bg', '--panel-border', '--panel-fg',
    '--tooltip-bg', '--tooltip-fg',
    '--selection-bg-token', '--selection-fg',
    // Structural
    '--clip-button', '--clip-panel', '--clip-badge',
    '--deco-accent-bar', '--deco-stripe', '--toolbar-accent-line',
];

/**
 * Build a flat token map using catalog defaults. Used as the bootstrap theme
 * (FOUC fallback) and as the merge base for user overrides.
 */
export function buildDefaultTokens() {
    const out = {};
    for (const [name, meta] of Object.entries(TOKEN_CATALOG)) {
        out[name] = meta.default;
    }
    return out;
}

export function getGroupedTokens(tokens) {
    const groups = {};
    for (const [name, value] of Object.entries(tokens || {})) {
        const meta = TOKEN_CATALOG[name];
        const group = meta ? meta.group : 'custom';
        const layer = meta ? meta.layer : 'custom';
        if (!groups[group]) groups[group] = { layer, tokens: {} };
        groups[group].tokens[name] = value;
    }
    return groups;
}
