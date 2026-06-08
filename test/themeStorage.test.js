/**
 * themeStorage 测试
 *
 * 主题文件的原子写入 / 损坏跳过 / id 校验等。
 * 使用 os.tmpdir() 下的临时目录，每次测试后清理。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
    loadUserThemes,
    saveTheme,
    deleteTheme,
    exportThemeToFile,
    importThemeFromFile,
    isValidId,
    BUILTIN_IDS,
    getUserThemesDir,
    ThemeStorageError,
} = require('../src/themes/themeStorage.js');

let tmpDir;

beforeEach(() => {
    // 每个测试用全新子目录，避免互相污染
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    tmpDir = path.join(os.tmpdir(), `sxseditor-theme-test-${stamp}`);
    fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
    }
});

function writeRaw(name, content) {
    const fp = path.join(tmpDir, name);
    fs.writeFileSync(fp, content, 'utf8');
    return fp;
}

function makeThemeObj(overrides = {}) {
    return {
        id: 'sample-theme',
        name: 'Sample',
        version: '1.0.0',
        tokens: { '--bg-app': '#101010' },
        ...overrides,
    };
}

describe('themeStorage', () => {
    describe('isValidId', () => {
        it('应当接受合法 kebab-case id', () => {
            expect(isValidId('dark-aurora')).to.be.true;
            expect(isValidId('a')).to.be.true;
            expect(isValidId('a-b-c-d')).to.be.true;
            expect(isValidId('abc-1-2-3')).to.be.true;
        });

        it('应当拒绝非法 id', () => {
            expect(isValidId('BadID')).to.be.false;
            expect(isValidId('-leading')).to.be.false;
            expect(isValidId('trailing-')).to.be.false;
            expect(isValidId('')).to.be.false;
            expect(isValidId(null)).to.be.false;
            expect(isValidId(undefined)).to.be.false;
            expect(isValidId(123)).to.be.false;
            expect(isValidId('1leading')).to.be.false;
        });

        it('应当拒绝包含路径分隔符 / 控制字符的 id', () => {
            expect(isValidId('foo/bar')).to.be.false;
            expect(isValidId('foo\\bar')).to.be.false;
            expect(isValidId('foo:bar')).to.be.false;
            expect(isValidId('foo*bar')).to.be.false;
            expect(isValidId('foo?bar')).to.be.false;
            expect(isValidId('foo"bar')).to.be.false;
            expect(isValidId('foo<bar')).to.be.false;
            expect(isValidId('foo>bar')).to.be.false;
            expect(isValidId('foo|bar')).to.be.false;
            expect(isValidId('foo\x00bar')).to.be.false;
            expect(isValidId('foo\nbar')).to.be.false;
        });
    });

    describe('getUserThemesDir', () => {
        it('应当返回 userDataDir/themes', () => {
            expect(getUserThemesDir('/abc')).to.equal(path.join('/abc', 'themes'));
        });
    });

    describe('saveTheme', () => {
        it('应写入合法主题到 userData/themes/<id>.theme.json', () => {
            const t = makeThemeObj({ id: 'my-theme' });
            const res = saveTheme(tmpDir, t);
            expect(res.id).to.equal('my-theme');
            expect(fs.existsSync(res.filePath)).to.be.true;
            const content = JSON.parse(fs.readFileSync(res.filePath, 'utf8'));
            expect(content.id).to.equal('my-theme');
            expect(content.tokens).to.have.property('--bg-app', '#101010');
        });

        it('应自动创建 themes 子目录', () => {
            // 写一个干净 tmp 目录，里面没 themes/
            const t = makeThemeObj({ id: 'sub' });
            expect(fs.existsSync(path.join(tmpDir, 'themes'))).to.be.false;
            saveTheme(tmpDir, t);
            expect(fs.existsSync(path.join(tmpDir, 'themes'))).to.be.true;
        });

        it('应当使用原子写入：先创建 tmp，再 rename', () => {
            const t = makeThemeObj({ id: 'atomic' });
            saveTheme(tmpDir, t);
            // 不应残留 .tmp
            const themesDir = getUserThemesDir(tmpDir);
            const files = fs.readdirSync(themesDir);
            const tmpFiles = files.filter(f => f.endsWith('.tmp'));
            expect(tmpFiles).to.have.length(0);
            const realFile = files.find(f => f === 'atomic.theme.json');
            expect(realFile).to.exist;
        });

        it('覆盖已存在的主题应成功', () => {
            const id = 'overwrite-me';
            saveTheme(tmpDir, makeThemeObj({ id, tokens: { '--bg-app': '#000000' } }));
            saveTheme(tmpDir, makeThemeObj({ id, tokens: { '--bg-app': '#ffffff' } }));
            const fp = path.join(getUserThemesDir(tmpDir), `${id}.theme.json`);
            const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
            expect(obj.tokens['--bg-app']).to.equal('#ffffff');
        });

        it('应当拒绝非法 id（含路径分隔符）', () => {
            try {
                saveTheme(tmpDir, makeThemeObj({ id: 'foo/bar' }));
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(ThemeStorageError);
                expect(e.code).to.equal('THEME_INVALID_ID');
            }
        });

        it('应当拒绝非法 id（含反斜杠）', () => {
            try {
                saveTheme(tmpDir, makeThemeObj({ id: 'foo\\bar' }));
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(ThemeStorageError);
                expect(e.code).to.equal('THEME_INVALID_ID');
            }
        });

        it('应当拒绝非对象输入', () => {
            try {
                saveTheme(tmpDir, null);
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(ThemeStorageError);
            }
        });
    });

    describe('loadUserThemes', () => {
        it('空目录应返回空 themes 数组', () => {
            const r = loadUserThemes(tmpDir);
            expect(r.themes).to.be.an('array').with.length(0);
            expect(r.errors).to.be.an('array').with.length(0);
        });

        it('应扫描 themes/*.theme.json 加载所有合法主题', () => {
            saveTheme(tmpDir, makeThemeObj({ id: 'a' }));
            saveTheme(tmpDir, makeThemeObj({ id: 'b' }));
            const r = loadUserThemes(tmpDir);
            expect(r.themes.map(t => t.id).sort()).to.deep.equal(['a', 'b']);
            expect(r.errors).to.have.length(0);
        });

        it('应跳过损坏的 JSON 文件并填入 errors', () => {
            saveTheme(tmpDir, makeThemeObj({ id: 'good' }));
            writeRaw('themes/bad.theme.json', '{not-valid-json');
            const r = loadUserThemes(tmpDir);
            const ids = r.themes.map(t => t.id);
            expect(ids).to.include('good');
            expect(r.errors).to.have.length.greaterThan(0);
            expect(r.errors[0].filePath).to.include('bad.theme.json');
        });

        it('应跳过 id 非法的文件', () => {
            saveTheme(tmpDir, makeThemeObj({ id: 'good' }));
            writeRaw('themes/InvalidID.theme.json', JSON.stringify({ id: 'InvalidID', tokens: {} }));
            const r = loadUserThemes(tmpDir);
            expect(r.themes.map(t => t.id)).to.deep.equal(['good']);
            expect(r.errors).to.have.length(1);
        });

        it('应跳过非 .theme.json 后缀的文件', () => {
            saveTheme(tmpDir, makeThemeObj({ id: 'a' }));
            writeRaw('themes/notes.txt', 'hello');
            const r = loadUserThemes(tmpDir);
            expect(r.themes).to.have.length(1);
            expect(r.themes[0].id).to.equal('a');
        });

        it('加载的主题应标记 source=user', () => {
            saveTheme(tmpDir, makeThemeObj({ id: 'src-test' }));
            const r = loadUserThemes(tmpDir);
            const t = r.themes.find(x => x.id === 'src-test');
            expect(t.source).to.equal('user');
            expect(t.filePath).to.exist;
        });
    });

    describe('deleteTheme', () => {
        it('应删除用户主题文件', () => {
            saveTheme(tmpDir, makeThemeObj({ id: 'rm-me' }));
            const fp = path.join(getUserThemesDir(tmpDir), 'rm-me.theme.json');
            expect(fs.existsSync(fp)).to.be.true;
            const r = deleteTheme(tmpDir, 'rm-me');
            expect(r.deleted).to.be.true;
            expect(fs.existsSync(fp)).to.be.false;
        });

        it('应拒绝删除 builtin 主题', () => {
            for (const id of BUILTIN_IDS) {
                try {
                    deleteTheme(tmpDir, id);
                    expect.fail(`应当拒绝删除 ${id}`);
                } catch (e) {
                    expect(e).to.be.instanceOf(ThemeStorageError);
                    expect(e.code).to.equal('THEME_BUILTIN_PROTECTED');
                }
            }
        });

        it('应拒绝非法 id', () => {
            try {
                deleteTheme(tmpDir, 'foo/bar');
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(ThemeStorageError);
                expect(e.code).to.equal('THEME_INVALID_ID');
            }
        });

        it('删除不存在的文件应返回 {deleted: false}', () => {
            const r = deleteTheme(tmpDir, 'nope-no-such');
            expect(r.deleted).to.be.false;
            expect(r.filePath).to.exist;
        });
    });

    describe('exportThemeToFile / importThemeFromFile', () => {
        it('export / import 应能 round-trip 主题', () => {
            const t = makeThemeObj({ id: 'rt', tokens: { '--bg-app': '#deadbe' } });
            const fp = path.join(tmpDir, 'rt.theme.json');
            exportThemeToFile(t, fp);
            const loaded = importThemeFromFile(fp);
            expect(loaded.id).to.equal('rt');
            expect(loaded.tokens['--bg-app']).to.equal('#deadbe');
        });

        it('import 非法 id 文件应抛错', () => {
            const fp = path.join(tmpDir, 'bad-id.theme.json');
            fs.writeFileSync(fp, JSON.stringify({ id: 'InvalidID', tokens: {} }), 'utf8');
            try {
                importThemeFromFile(fp);
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(ThemeStorageError);
            }
        });
    });
});
