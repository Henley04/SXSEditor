/**
 * themeValidator 测试
 *
 * 覆盖 validate / normalize / parseThemeJson 的核心行为：
 *  - 合法主题
 *  - 缺 id / tokens
 *  - 非法 id 格式
 *  - 非法 token 键名 / 值
 *  - extends 深度 / 环 / 父不存在
 *  - normalize 自动补 -- 前缀、version、isDark
 *  - parseThemeJson 集成
 */
const { expect } = require('chai');

let validator; // 通过 before() 异步填充

before(async () => {
    // 主题校验器是 ESM，通过 babel/register 转 CJS；用动态 import 拿到具名导出
    validator = await import('../src/themes/themeValidator.js');
});

describe('themeValidator', () => {
    // helper：构造一个最简合法主题
    function makeValidTheme(overrides = {}) {
        return {
            id: 'sample-theme',
            name: 'Sample',
            tokens: {
                '--bg-app': '#14141f',
                '--fg-primary': '#e0e0f0',
            },
            ...overrides,
        };
    }

    describe('validate - 合法主题', () => {
        it('应当通过最简合法主题', () => {
            const result = validator.validate(makeValidTheme());
            expect(result.ok).to.be.true;
            expect(result.errors).to.be.an('array').with.length(0);
        });

        it('应当允许 name / version / isDark 缺省', () => {
            const result = validator.validate({ id: 't1', tokens: { '--bg-app': '#fff' } });
            expect(result.ok).to.be.true;
        });

        it('应当允许 isDark=true', () => {
            const result = validator.validate({
                id: 'dark1',
                isDark: true,
                tokens: { '--bg-app': '#000' },
            });
            expect(result.ok).to.be.true;
        });

        it('应当接受合法 hex 颜色（3/4/6/8 位）', () => {
            const theme = makeValidTheme({
                tokens: {
                    '--bg-app': '#abc',
                    '--bg-panel': '#abcd',
                    '--bg-elevated': '#aabbcc',
                    '--bg-input': '#aabbccdd',
                },
            });
            const result = validator.validate(theme);
            expect(result.ok).to.be.true;
        });

        it('应当接受 rgba / rgb / hsl / hsla / transparent / currentColor', () => {
            const theme = makeValidTheme({
                tokens: {
                    '--bg-overlay': 'rgba(10, 10, 20, 0.7)',
                    '--bg-pure': 'rgb(255, 255, 255)',
                    '--bg-hue': 'hsl(180, 50%, 50%)',
                    '--bg-hsla': 'hsla(180, 50%, 50%, 0.5)',
                    '--bg-none': 'transparent',
                    '--bg-cur': 'currentColor',
                },
            });
            const result = validator.validate(theme);
            expect(result.ok).to.be.true;
        });
    });

    describe('validate - 缺字段', () => {
        it('主题非对象应当失败', () => {
            const r1 = validator.validate(null);
            expect(r1.ok).to.be.false;
            expect(r1.errors[0].field).to.equal('root');

            const r2 = validator.validate('not-an-object');
            expect(r2.ok).to.be.false;
        });

        it('缺 id 应当报错', () => {
            const r = validator.validate({ tokens: { '--bg-app': '#fff' } });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => e.field === 'id')).to.be.true;
        });

        it('id 为空字符串应当报错', () => {
            const r = validator.validate({ id: '', tokens: { '--bg-app': '#fff' } });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => e.field === 'id')).to.be.true;
        });

        it('缺 tokens 应当报错', () => {
            const r = validator.validate({ id: 'x' });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => e.field === 'tokens')).to.be.true;
        });

        it('tokens 为数组应当报错', () => {
            const r = validator.validate({ id: 'x', tokens: [] });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => e.field === 'tokens')).to.be.true;
        });
    });

    describe('validate - 非法 id', () => {
        const badIds = [
            'BadID',         // 大写
            'has space',     // 空格
            '-leading',      // 以 - 开头
            'trailing-',     // 以 - 结尾
            '1starts',       // 数字开头
            'under_score',   // 含下划线
            'dot.in.id',     // 含点
            'a--b',          // 连续 -
            '',              // 空
        ];

        badIds.forEach(bad => {
            it(`应当拒绝 id="${bad}"`, () => {
                const r = validator.validate({ id: bad, tokens: { '--bg-app': '#fff' } });
                expect(r.ok).to.be.false;
                expect(r.errors.some(e => e.field === 'id')).to.be.true;
            });
        });

        const goodIds = ['a', 'a-b', 'ab1', 'a-1-b', 'dark-aurora', 'midnight-amber-v2'];
        goodIds.forEach(good => {
            it(`应当接受 id="${good}"`, () => {
                const r = validator.validate({ id: good, tokens: { '--bg-app': '#fff' } });
                expect(r.ok).to.be.true;
            });
        });
    });

    describe('validate - 非法 token 键名 / 值', () => {
        it('应当拒绝大写 token 键', () => {
            const r = validator.validate({ id: 't', tokens: { '--Color-blue': '#fff' } });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => /令牌名/.test(e.message))).to.be.true;
        });

        it('应当拒绝不带 -- 前缀的键', () => {
            const r = validator.validate({ id: 't', tokens: { 'color-blue-500': '#fff' } });
            expect(r.ok).to.be.false;
        });

        it('应当拒绝包含特殊字符的 token 键', () => {
            // 正则 ^--[a-z0-9][a-z0-9-]*$ 不允许 ! @ # 等
            const r = validator.validate({ id: 't', tokens: { '--bad!name': '#fff' } });
            expect(r.ok).to.be.false;
        });

        it('应当拒绝空字符串 token 值', () => {
            const r = validator.validate({ id: 't', tokens: { '--unknown-token': '' } });
            expect(r.ok).to.be.false;
        });

        it('非字符串 token 值应当失败', () => {
            const r = validator.validate({ id: 't', tokens: { '--bg-app': 123 } });
            expect(r.ok).to.be.false;
        });
    });

    describe('validate - extends', () => {
        it('父主题存在应当通过', () => {
            const idMap = {
                'parent-a': { id: 'parent-a', tokens: { '--bg-app': '#aaa' } },
            };
            const r = validator.validate(
                { id: 'child', extends: 'parent-a', tokens: { '--bg-app': '#ccc' } },
                { getThemeById: (id) => idMap[id] }
            );
            expect(r.ok).to.be.true;
        });

        it('父主题不存在应当失败', () => {
            const r = validator.validate(
                { id: 'orphan', extends: 'does-not-exist', tokens: { '--bg-app': '#ccc' } },
                { getThemeById: () => null }
            );
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => /父主题.*不存在/.test(e.message))).to.be.true;
        });

        it('extends 链 3 层（含自身）应当通过', () => {
            const idMap = {
                'l0': { id: 'l0', extends: 'l1', tokens: { '--bg-app': '#000' } },
                'l1': { id: 'l1', extends: 'l2', tokens: { '--bg-app': '#000' } },
                'l2': { id: 'l2', extends: 'l3', tokens: { '--bg-app': '#000' } },
                'l3': { id: 'l3', tokens: { '--bg-app': '#000' } },
            };
            const r = validator.validate(
                { id: 'l0', tokens: { '--bg-app': '#000' } },
                { getThemeById: (id) => idMap[id] }
            );
            expect(r.ok).to.be.true;
        });

        it('extends 链 4 层应当失败', () => {
            const idMap = {
                'm0': { id: 'm0', extends: 'm1', tokens: { '--bg-app': '#000' } },
                'm1': { id: 'm1', extends: 'm2', tokens: { '--bg-app': '#000' } },
                'm2': { id: 'm2', extends: 'm3', tokens: { '--bg-app': '#000' } },
                'm3': { id: 'm3', extends: 'm4', tokens: { '--bg-app': '#000' } },
                'm4': { id: 'm4', tokens: { '--bg-app': '#000' } },
            };
            const r = validator.validate(
                { id: 'm0', extends: 'm1', tokens: { '--bg-app': '#000' } },
                { getThemeById: (id) => idMap[id] }
            );
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => /深度/.test(e.message))).to.be.true;
        });

        it('环状继承应当失败', () => {
            const a = { id: 'cyc-a', extends: 'cyc-b', tokens: { '--bg-app': '#000' } };
            const b = { id: 'cyc-b', extends: 'cyc-a', tokens: { '--bg-app': '#000' } };
            const getById = (id) => (id === 'cyc-a' ? a : (id === 'cyc-b' ? b : null));
            const r = validator.validate(a, { getThemeById: getById });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => /环/.test(e.message))).to.be.true;
        });

        it('extends 非字符串应当失败', () => {
            const r = validator.validate({ id: 't', extends: 123, tokens: { '--bg-app': '#000' } });
            expect(r.ok).to.be.false;
            expect(r.errors.some(e => e.field === 'extends')).to.be.true;
        });
    });

    describe('validate - 警告（loose import）', () => {
        it('token 键缺 -- 前缀应当产生警告', () => {
            const r = validator.validate({
                id: 'loose',
                tokens: {
                    '--bg-app': '#fff',
                    'color-missing-prefix': '#000',
                },
            });
            // 校验器对缺前缀键同时报错并警告
            expect(r.warnings.some(w => /前缀/.test(w.message))).to.be.true;
        });
    });

    describe('normalize', () => {
        it('应当补全 -- 前缀', () => {
            const n = validator.normalize({
                id: 't',
                tokens: {
                    '--bg-app': '#fff',
                    'bg-extra': '#000',
                },
            });
            expect(n.tokens).to.have.property('--bg-app');
            expect(n.tokens).to.have.property('--bg-extra');
        });

        it('应当补全默认 version 1.0.0', () => {
            const n = validator.normalize({ id: 't', tokens: { '--bg-app': '#fff' } });
            expect(n.version).to.equal('1.0.0');
        });

        it('应当保留显式 version', () => {
            const n = validator.normalize({ id: 't', version: '2.3.4', tokens: { '--bg-app': '#fff' } });
            expect(n.version).to.equal('2.3.4');
        });

        it('缺省 isDark 时应从 --bg-app 计算', () => {
            const nDark = validator.normalize({ id: 't', tokens: { '--bg-app': '#000000' } });
            expect(nDark.isDark).to.be.true;

            const nLight = validator.normalize({ id: 't', tokens: { '--bg-app': '#ffffff' } });
            expect(nLight.isDark).to.be.false;
        });

        it('应当保留显式 isDark', () => {
            const n = validator.normalize({ id: 't', isDark: true, tokens: { '--bg-app': '#fff' } });
            expect(n.isDark).to.be.true;
        });
    });

    describe('parseThemeJson', () => {
        it('应当解析合法 JSON 并返回 normalized 主题', () => {
            const json = JSON.stringify({
                id: 'json-1',
                tokens: { '--bg-app': '#112233' },
            });
            const t = validator.parseThemeJson(json);
            expect(t.id).to.equal('json-1');
            expect(t.tokens).to.have.property('--bg-app', '#112233');
            expect(t.version).to.equal('1.0.0');
        });

        it('JSON 解析失败应当抛 ThemeValidationError', () => {
            expect(() => validator.parseThemeJson('{not-json'))
                .to.throw(validator.ThemeValidationError);
        });

        it('校验失败应当抛 ThemeValidationError 含 errors', () => {
            try {
                validator.parseThemeJson(JSON.stringify({ id: 'BadID', tokens: {} }));
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(validator.ThemeValidationError);
                expect(e.errors).to.be.an('array').with.length.greaterThan(0);
            }
        });
    });
});
