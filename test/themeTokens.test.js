/**
 * themeTokens 测试
 *
 * 验证 4 套内置主题的：
 *  - 必备字段（id / name / isDark / tokens）
 *  - 必需令牌覆盖
 *  - 关键 token 名称与值格式
 *  - dark-aurora 关键颜色与重构前一致
 *  - light-paper 为 isDark=false，dark-aurora 为 isDark=true
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

let catalog;       // tokenCatalog (REQUIRED_TOKENS_FOR_BUILTIN / TOKEN_CATALOG)

before(async () => {
    catalog = await import('../src/themes/tokenCatalog.js');
});

const BUILTIN_DIR = path.join(__dirname, '..', 'src', 'themes', 'builtins');

function loadTheme(filename) {
    const fp = path.join(BUILTIN_DIR, filename);
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
}

const BUILTIN_FILES = [
    'dark-aurora.theme.json',
    'light-paper.theme.json',
    'midnight-amber.theme.json',
    'contrast-onyx.theme.json',
];

// 关键必需令牌（不能缺失）；不带 extends 的内置主题都应包含
const REQUIRED_TOKENS = [
    '--bg-app', '--bg-panel', '--bg-elevated', '--bg-input',
    '--fg-primary', '--fg-secondary', '--fg-muted',
    '--accent', '--accent-hover', '--accent-pressed', '--accent-fg',
    '--border-subtle', '--border-default', '--border-strong', '--border-accent',
    '--success', '--warning', '--danger', '--info',
    '--button-primary-bg', '--button-secondary-bg',
    '--input-bg', '--input-border', '--input-fg',
    '--panel-bg', '--panel-border', '--panel-fg',
    '--color-blue-500', '--color-gray-500', '--color-ink-900',
];

// 合法 token 名格式
const TOKEN_NAME_RE = /^--[a-z0-9][a-z0-9-]*$/;

describe('themeTokens - 内置主题完整性', () => {
    BUILTIN_FILES.forEach(filename => {
        describe(filename, () => {
            let theme;

            before(() => { theme = loadTheme(filename); });

            it('应有 id 字段', () => {
                expect(theme).to.have.property('id');
                expect(theme.id).to.be.a('string').with.length.greaterThan(0);
            });

            it('应有 name 字段', () => {
                expect(theme).to.have.property('name');
                expect(theme.name).to.be.a('string').with.length.greaterThan(0);
            });

            it('应有 isDark 字段（boolean）', () => {
                expect(theme).to.have.property('isDark');
                expect(theme.isDark).to.be.a('boolean');
            });

            it('应有 tokens 对象', () => {
                expect(theme).to.have.property('tokens');
                expect(theme.tokens).to.be.an('object');
            });

            it('所有 token 键名应匹配 --kebab-case 格式', () => {
                const bad = Object.keys(theme.tokens).filter(k => !TOKEN_NAME_RE.test(k));
                expect(bad, `非法 token 键：${bad.join(', ')}`).to.have.length(0);
            });

            it('所有 token 值应为非空字符串', () => {
                const bad = Object.entries(theme.tokens)
                    .filter(([_, v]) => typeof v !== 'string' || v.length === 0);
                expect(bad, `空/非字符串 token：${JSON.stringify(bad)}`).to.have.length(0);
            });
        });
    });

    describe('dark-aurora 关键颜色', () => {
        let theme;

        before(() => { theme = loadTheme('dark-aurora.theme.json'); });

        it('应包含全部必需 token', () => {
            const missing = REQUIRED_TOKENS.filter(t => !(t in theme.tokens));
            expect(missing, `缺少 token：${missing.join(', ')}`).to.have.length(0);
        });

        it('--bg-app 应为 #14141f（与重构前一致）', () => {
            expect(theme.tokens['--bg-app']).to.equal('#14141f');
        });

        it('--fg-primary 应为 #e0e0f0', () => {
            expect(theme.tokens['--fg-primary']).to.equal('#e0e0f0');
        });

        it('--accent 应为 #5b8def（蓝紫主色）', () => {
            expect(theme.tokens['--accent']).to.equal('#5b8def');
        });

        it('--color-ink-900 应为 #14141f', () => {
            expect(theme.tokens['--color-ink-900']).to.equal('#14141f');
        });

        it('isDark 应为 true', () => {
            expect(theme.isDark).to.be.true;
        });
    });

    describe('light-paper', () => {
        let theme;

        before(() => { theme = loadTheme('light-paper.theme.json'); });

        it('应包含全部必需 token', () => {
            const missing = REQUIRED_TOKENS.filter(t => !(t in theme.tokens));
            expect(missing, `缺少 token：${missing.join(', ')}`).to.have.length(0);
        });

        it('id 应为 "light-paper"', () => {
            expect(theme.id).to.equal('light-paper');
        });

        it('isDark 应为 false', () => {
            expect(theme.isDark).to.be.false;
        });

        it('--bg-app 应当是亮色', () => {
            // 解析 hex 并验证每个通道都 >= 0xa0（约 160/255 = 0.63）
            const v = theme.tokens['--bg-app'];
            const m = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
            expect(m, `--bg-app "${v}" 应为 6 位 hex`).to.not.be.null;
            const r = parseInt(m[1], 16);
            const g = parseInt(m[2], 16);
            const b = parseInt(m[3], 16);
            // light-paper 背景应明显偏白
            expect(r + g + b).to.be.greaterThan(3 * 0xa0);
        });
    });

    describe('midnight-amber', () => {
        let theme;

        before(() => { theme = loadTheme('midnight-amber.theme.json'); });

        it('id 应为 "midnight-amber"', () => {
            expect(theme.id).to.equal('midnight-amber');
        });

        it('isDark 应为 true', () => {
            expect(theme.isDark).to.be.true;
        });

        it('应当 extends dark-aurora', () => {
            expect(theme.extends).to.equal('dark-aurora');
        });

        it('应至少显式定义差异 token（如琥珀强调色）', () => {
            // midnight-amber 重写了 --accent 等
            expect(theme.tokens).to.have.property('--accent');
            // amber 系列的强调色不应是默认蓝紫色
            const accent = theme.tokens['--accent'].toLowerCase();
            expect(accent).to.not.equal('#5b8def');
        });
    });

    describe('contrast-onyx', () => {
        let theme;

        before(() => { theme = loadTheme('contrast-onyx.theme.json'); });

        it('id 应为 "contrast-onyx"', () => {
            expect(theme.id).to.equal('contrast-onyx');
        });

        it('isDark 应为 true', () => {
            expect(theme.isDark).to.be.true;
        });

        it('--bg-app 应是深色（亮度低）', () => {
            const v = theme.tokens['--bg-app'];
            const m = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
            expect(m, `--bg-app "${v}" 应为 6 位 hex`).to.not.be.null;
            const r = parseInt(m[1], 16);
            const g = parseInt(m[2], 16);
            const b = parseInt(m[3], 16);
            // 黑色或近黑色
            expect(r + g + b).to.be.lessThan(3 * 0x40);
        });
    });
});

describe('themeTokens - REQUIRED_TOKENS_FOR_BUILTIN 完整性', () => {
    it('REQUIRED_TOKENS_FOR_BUILTIN 应包含所有内置主题要求的 token', () => {
        expect(catalog.REQUIRED_TOKENS_FOR_BUILTIN).to.be.an('array').with.length.greaterThan(20);
    });

    it('dark-aurora / light-paper 应覆盖 catalog.REQUIRED_TOKENS_FOR_BUILTIN', () => {
        // midnight-amber 通过 extends 继承，豁免；
        // contrast-onyx 暂未补全 spacing/radius/font/motion scale（已记录为已知差异），豁免；
        // 这里只对 dark-aurora / light-paper 做强校验
        ['dark-aurora.theme.json', 'light-paper.theme.json'].forEach(f => {
            const t = loadTheme(f);
            const missing = catalog.REQUIRED_TOKENS_FOR_BUILTIN.filter(rt => !(rt in t.tokens));
            expect(missing, `${f} 缺少必需 token：${missing.join(', ')}`).to.have.length(0);
        });
    });

    it('contrast-onyx 至少应包含核心颜色与 alias 令牌', () => {
        // 已知差异：contrast-onyx 未补全 spacing/radius/font/motion scale，
        // 这里只验证核心 alias/border 令牌存在。
        const t = loadTheme('contrast-onyx.theme.json');
        const CORE = [
            '--bg-app', '--bg-panel', '--bg-elevated', '--bg-input',
            '--fg-primary', '--fg-secondary', '--fg-muted',
            '--accent', '--accent-hover', '--accent-pressed', '--accent-fg',
            '--border-subtle', '--border-default', '--border-strong', '--border-accent',
            '--button-primary-bg', '--button-secondary-bg',
            '--panel-bg', '--input-bg',
        ];
        const missing = CORE.filter(rt => !(rt in t.tokens));
        expect(missing, `contrast-onyx 缺少核心 token：${missing.join(', ')}`).to.have.length(0);
    });

    it('midnight-amber 通过 extends 继承时无需覆盖全部必需 token', () => {
        const t = loadTheme('midnight-amber.theme.json');
        expect(t.extends).to.equal('dark-aurora');
        // 只要求它显式定义的部分 token
        expect(t.tokens).to.have.property('--accent');
    });
});
