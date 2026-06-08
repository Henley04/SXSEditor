/**
 * themeManager 测试
 *
 * 覆盖注册 / 激活 / 继承展开 / 撤销栈 / 事件等核心 API。
 *
 * 注意：themeManager 是模块级单例（registry 缓存在模块内），每个测试必须
 * 使用独立 id 以避免污染；不需要反复重置。
 */
const { expect } = require('chai');

let managerMod;        // 默认导出（对象）
let ThemeNotFoundError; // 具名导出

before(async () => {
    // JSDOM 的 document.dispatchEvent 要求事件对象是 JSDOM 的 Event 实例，
    // 不能用 Node 全局 CustomEvent；因此强制把 JSDOM 的 CustomEvent 挂到 global。
    if (typeof global.CustomEvent === 'undefined' || global.CustomEvent.toString().indexOf('[native code]') === -1) {
        // 仅在没有或不是 JSDOM CustomEvent 时设置
        if (global.document && global.document.defaultView && global.document.defaultView.CustomEvent) {
            global.CustomEvent = global.document.defaultView.CustomEvent;
        }
    }
    managerMod = await import('../src/themes/themeManager.js');
    ThemeNotFoundError = managerMod.ThemeNotFoundError;
});

// id 自增，避免单例污染
let _idCounter = 0;
function nextId(prefix = 'tmgr') {
    _idCounter += 1;
    return `${prefix}-${Date.now()}-${_idCounter}`;
}

function makeTheme(overrides = {}) {
    const id = overrides.id || nextId();
    return {
        id,
        name: `Test ${id}`,
        tokens: {
            '--bg-app': '#101010',
            '--fg-primary': '#eeeeee',
            '--accent': '#5b8def',
        },
        ...overrides,
    };
}

describe('themeManager', () => {
    const tm = () => managerMod.default;

    describe('register / unregister / list', () => {
        it('register 应返回 normalized 主题', () => {
            const t = makeTheme();
            const r = tm().register(t);
            expect(r.id).to.equal(t.id);
            expect(r.tokens).to.have.property('--bg-app');
        });

        it('list 应包含已注册主题', () => {
            const t = makeTheme();
            tm().register(t);
            const all = tm().list();
            expect(all.map(x => x.id)).to.include(t.id);
        });

        it('list 条目应包含 source 字段', () => {
            const t = makeTheme();
            tm().register(t);
            const entry = tm().list().find(x => x.id === t.id);
            expect(entry).to.have.property('source');
        });

        it('unregister 应从 list 中移除', () => {
            const t = makeTheme();
            tm().register(t);
            const ok = tm().unregister(t.id);
            expect(ok).to.be.true;
            expect(tm().list().map(x => x.id)).to.not.include(t.id);
        });

        it('unregister 不存在的 id 应返回 false', () => {
            expect(tm().unregister('not-registered-xxx')).to.be.false;
        });

        it('registerBuiltins 应批量注册主题到 list', () => {
            const id1 = nextId('builtin');
            const id2 = nextId('builtin');
            const arr = [
                { id: id1, tokens: { '--bg-app': '#000000' } },
                { id: id2, tokens: { '--bg-app': '#ffffff' } },
            ];
            tm().registerBuiltins(arr);
            const ids = tm().list().map(x => x.id);
            expect(ids).to.include(id1);
            expect(ids).to.include(id2);
        });

        it('registerBuiltins 单个非法主题应跳过不影响其它', () => {
            const idGood = nextId('bulkgood');
            const arr = [
                { id: idGood, tokens: { '--bg-app': '#000000' } },
                { id: 'BadID', tokens: { '--bg-app': '#ffffff' } },
            ];
            // 不应抛错
            tm().registerBuiltins(arr);
            expect(tm().list().map(x => x.id)).to.include(idGood);
            expect(tm().list().map(x => x.id)).to.not.include('BadID');
        });

        it('register 拒绝非法主题应抛 ThemeValidationError', () => {
            try {
                tm().register({ id: 'BadID', tokens: { '--bg-app': '#ffffff' } });
                expect.fail('应当抛错');
            } catch (e) {
                expect(e.name).to.equal('ThemeValidationError');
            }
        });
    });

    describe('事件', () => {
        it('重新注册同一 id 应触发 theme-overwritten', () => {
            const id = nextId('evt-overwrite');
            let fired = null;
            const unsub = tm().on('theme-overwritten', (d) => { fired = d; });
            tm().register({ id, tokens: { '--bg-app': '#111111' } });
            tm().register({ id, tokens: { '--bg-app': '#222222' } });
            unsub();
            expect(fired).to.exist;
            expect(fired.id).to.equal(id);
        });

        it('注册新主题应触发 theme-list-changed', () => {
            const id = nextId('evt-list');
            let fired = null;
            const unsub = tm().on('theme-list-changed', (d) => { fired = d; });
            tm().register({ id, tokens: { '--bg-app': '#333333' } });
            unsub();
            expect(fired).to.exist;
            expect(fired.id).to.equal(id);
        });

        it('activate 应触发 theme-changed 事件', () => {
            const id = nextId('evt-activated');
            tm().register({ id, tokens: { '--bg-app': '#abcabc' } });
            let fired = null;
            const unsub = tm().on('theme-changed', (d) => { fired = d; });
            tm().activate(id);
            unsub();
            expect(fired).to.exist;
            expect(fired.themeId).to.equal(id);
            expect(fired.tokens).to.have.property('--bg-app', '#abcabc');
        });

        it('import 应触发 theme-imported 事件', () => {
            const id = nextId('evt-imported');
            const json = JSON.stringify({ id, tokens: { '--bg-app': '#defdef' } });
            let fired = null;
            const unsub = tm().on('theme-imported', (d) => { fired = d; });
            tm().import(json);
            unsub();
            expect(fired).to.exist;
            expect(fired.id).to.equal(id);
        });

        it('Document 上也派发了 theme-changed CustomEvent', () => {
            const id = nextId('evt-doc');
            tm().register({ id, tokens: { '--bg-app': '#ccddee' } });
            let fired = null;
            const handler = (e) => { fired = e.detail; };
            document.addEventListener('theme-changed', handler);
            tm().activate(id);
            document.removeEventListener('theme-changed', handler);
            expect(fired).to.exist;
            expect(fired.themeId).to.equal(id);
        });
    });

    describe('activate / 注入到 :root', () => {
        it('activate 应将 token 写入 document.documentElement.style', () => {
            const id = nextId('activate');
            tm().register({ id, tokens: { '--bg-app': '#abcdef' } });
            tm().activate(id);
            const root = document.documentElement;
            expect(root.style.getPropertyValue('--bg-app')).to.equal('#abcdef');
        });

        it('activate 未知 id 应抛 ThemeNotFoundError', () => {
            try {
                tm().activate('does-not-exist-zzz');
                expect.fail('应当抛错');
            } catch (e) {
                expect(e).to.be.instanceOf(ThemeNotFoundError);
                expect(e.id).to.equal('does-not-exist-zzz');
            }
        });

        it('activate 应清空 overrides', () => {
            const id1 = nextId('clear-ovr-1');
            const id2 = nextId('clear-ovr-2');
            tm().register({ id: id1, tokens: { '--bg-app': '#111111' } });
            tm().register({ id: id2, tokens: { '--bg-app': '#222222' } });
            tm().activate(id1);
            tm().mergeOverrides({ '--bg-app': '#999999' });
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#999999');
            tm().activate(id2);
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#222222');
        });

        it('activate 应解析 extends 链：父 token 被继承', () => {
            const parentId = nextId('ext-parent');
            const childId = nextId('ext-child');
            tm().register({
                id: parentId,
                tokens: { '--bg-app': '#111111', '--fg-primary': '#f0f0f0' },
            });
            tm().register({
                id: childId,
                extends: parentId,
                tokens: { '--accent': '#aabbcc' },
            });
            tm().activate(childId);
            const root = document.documentElement;
            // 子主题的 --accent 应被注入
            expect(root.style.getPropertyValue('--accent')).to.equal('#aabbcc');
            // 父主题的 --fg-primary 应通过继承被注入
            expect(root.style.getPropertyValue('--fg-primary')).to.equal('#f0f0f0');
            // 子主题未定义 --bg-app，父的应被继承
            expect(root.style.getPropertyValue('--bg-app')).to.equal('#111111');
        });
    });

    describe('export / import', () => {
        it('export 应返回包含 id 与 tokens 的 JSON 字符串', () => {
            const id = nextId('exp');
            tm().register({ id, tokens: { '--bg-app': '#aabbcc' } });
            const json = tm().export(id);
            const obj = JSON.parse(json);
            expect(obj.id).to.equal(id);
            expect(obj.tokens).to.have.property('--bg-app', '#aabbcc');
        });

        it('export 未知 id 应抛 ThemeNotFoundError', () => {
            expect(() => tm().export('no-such-id-123')).to.throw(ThemeNotFoundError);
        });

        it('import 应注册并返回主题', () => {
            const id = nextId('imp');
            const json = JSON.stringify({ id, tokens: { '--bg-app': '#010101' } });
            const t = tm().import(json);
            expect(t.id).to.equal(id);
            expect(tm().list().map(x => x.id)).to.include(id);
        });

        it('import 非法 JSON 应抛 ThemeValidationError', () => {
            try {
                tm().import(JSON.stringify({ id: 'BadID', tokens: {} }));
                expect.fail('应当抛错');
            } catch (e) {
                expect(e.name).to.equal('ThemeValidationError');
            }
        });

        it('import 损坏字符串应抛错', () => {
            expect(() => tm().import('{not-valid-json')).to.throw();
        });
    });

    describe('mergeOverrides / clearOverrides', () => {
        it('mergeOverrides 应覆盖指定 token', () => {
            const id = nextId('ovr');
            tm().register({ id, tokens: { '--bg-app': '#111111', '--fg-primary': '#ffffff' } });
            tm().activate(id);
            tm().mergeOverrides({ '--bg-app': '#0000ff' });
            const root = document.documentElement;
            expect(root.style.getPropertyValue('--bg-app')).to.equal('#0000ff');
            // 未覆盖的 token 保持不变
            expect(root.style.getPropertyValue('--fg-primary')).to.equal('#ffffff');
        });

        it('clearOverrides 应恢复至基线 token', () => {
            const id = nextId('clear');
            tm().register({ id, tokens: { '--bg-app': '#444444' } });
            tm().activate(id);
            tm().mergeOverrides({ '--bg-app': '#ff00ff' });
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#ff00ff');
            tm().clearOverrides();
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#444444');
        });

        it('mergeOverrides 在未 activate 时也可工作（使用默认 token）', () => {
            // 不 activate，直接 mergeOverrides 不应抛错
            expect(() => tm().mergeOverrides({ '--bg-app': '#ffffff' })).to.not.throw();
        });
    });

    describe('undo / redo', () => {
        it('undo / redo 应在历史内正确回放', () => {
            const id = nextId('undo');
            tm().register({ id, tokens: { '--bg-app': '#101010' } });
            tm().activate(id);

            tm().mergeOverrides({ '--bg-app': '#aabbcc' });
            tm().mergeOverrides({ '--bg-app': '#ddeeff' });
            tm().mergeOverrides({ '--bg-app': '#112233' });
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#112233');

            const ok1 = tm().undo();
            expect(ok1).to.be.true;
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#ddeeff');

            const ok2 = tm().undo();
            expect(ok2).to.be.true;
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#aabbcc');

            const ok3 = tm().redo();
            expect(ok3).to.be.true;
            expect(document.documentElement.style.getPropertyValue('--bg-app')).to.equal('#ddeeff');
        });

        it('undo 不应造成无限定循环（到达起点后返回 false）', () => {
            // 由于 manager 是模块级单例，历史状态可能被前序测试污染；
            // 这里只验证 undo 总会到达终点（不会无限循环）。
            const id = nextId('undo-loop');
            tm().register({ id, tokens: { '--bg-app': '#000000' } });
            tm().activate(id);
            let count = 0;
            while (tm().undo() && count < 200) count += 1;
            expect(count).to.be.lessThan(200);
        });

        it('历史终点 redo 应返回 false', () => {
            const id = nextId('redo-end');
            tm().register({ id, tokens: { '--bg-app': '#000000' } });
            tm().activate(id);
            tm().mergeOverrides({ '--bg-app': '#ffffff' });
            // 已在终点，redo 返回 false
            const ok = tm().redo();
            expect(ok).to.be.false;
        });

        it('历史容量应被限制为 20 步', () => {
            const id = nextId('cap');
            tm().register({ id, tokens: { '--bg-app': '#000000' } });
            tm().activate(id);
            for (let i = 0; i < 30; i += 1) {
                tm().mergeOverrides({ '--bg-app': `#${(i * 0x010101).toString(16).padStart(6, '0')}` });
            }
            // 一直 undo 直到返回 false，最多能撤 20 步
            let undos = 0;
            while (tm().undo()) undos += 1;
            expect(undos).to.be.at.most(20);
        });
    });

    describe('computeIsDark', () => {
        it('根据 --bg-app 亮度判定明暗', () => {
            const dark = tm().computeIsDark({ '--bg-app': '#000000' });
            expect(dark).to.be.true;
            const light = tm().computeIsDark({ '--bg-app': '#ffffff' });
            expect(light).to.be.false;
        });

        it('缺 --bg-app 应返回 false', () => {
            expect(tm().computeIsDark({})).to.be.false;
            expect(tm().computeIsDark(null)).to.be.false;
        });
    });

    describe('current / currentTokens', () => {
        it('current 应返回当前 id / scope', () => {
            const id = nextId('cur');
            tm().register({ id, tokens: { '--bg-app': '#abcabc' } });
            tm().activate(id, { scope: 'window', scopeId: 'win-1' });
            const cur = tm().current();
            expect(cur.themeId).to.equal(id);
            expect(cur.scope).to.equal('window');
            expect(cur.scopeId).to.equal('win-1');
        });

        it('currentTokens 应返回含 id、tokens、overrides 的对象', () => {
            const id = nextId('curtok');
            tm().register({ id, tokens: { '--bg-app': '#101010' } });
            tm().activate(id);
            tm().mergeOverrides({ '--bg-app': '#abcdef' });
            const ct = tm().currentTokens();
            expect(ct.id).to.equal(id);
            expect(ct.tokens['--bg-app']).to.equal('#abcdef');
            expect(ct.overrides).to.have.property('--bg-app', '#abcdef');
            expect(ct.baseTokens).to.have.property('--bg-app', '#101010');
        });

        it('未 activate 时 currentTokens 应返回 null', () => {
            tm().activate(null);
            expect(tm().currentTokens()).to.be.null;
        });
    });

    describe('get / list', () => {
        it('get 应返回已注册主题', () => {
            const id = nextId('get');
            tm().register({ id, tokens: { '--bg-app': '#000000' } });
            const got = tm().get(id);
            expect(got).to.exist;
            expect(got.id).to.equal(id);
        });

        it('get 未知 id 应返回 null', () => {
            expect(tm().get('not-there')).to.be.null;
        });
    });
});
