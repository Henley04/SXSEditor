/**
 * 日语假名 → 音素映射表（单一真源）。
 *
 * 审查项 2.2：这张表此前在两处各存一份且靠人工同步 ——
 *   · src/inference/pipeline/textProcessing.js（主进程，CJS）
 *   · src/fragmentEditor/kanjiGroupUtils.js（渲染进程，ESM，注释里写着
 *     "mirrors textProcessing.js"）
 * 38 行 ×2，改一处漏一处就会让"编辑器里显示的假名分组"和"实际合成用的音素"
 * 悄悄不一致 —— 这类 bug 在 UI 上看不出来，只会表现为唱出来的词不对。
 *
 * 主进程用 require、渲染进程用 import 都可以拿到（webpack interop / node ESM
 * 的 default import 都支持 CJS），因此这里统一用 CommonJS 导出。
 */

// Japanese hiragana → phoneme mapping
const JP_HIRAGANA_MAP = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'k a', 'き': 'k i', 'く': 'k u', 'け': 'k e', 'こ': 'k o',
    'さ': 's a', 'し': 'sh i', 'す': 's u', 'せ': 's e', 'そ': 's o',
    'た': 't a', 'ち': 'ch i', 'つ': 'ts u', 'て': 't e', 'と': 't o',
    'な': 'n a', 'に': 'ny i', 'ぬ': 'n u', 'ね': 'n e', 'の': 'n o',
    'は': 'h a', 'ひ': 'hy i', 'ふ': 'f u', 'へ': 'h e', 'ほ': 'h o',
    'ま': 'm a', 'み': 'my i', 'む': 'm u', 'め': 'm e', 'も': 'm o',
    'や': 'y a', 'ゆ': 'y u', 'よ': 'y o',
    'ら': 'r a', 'り': 'ry i', 'る': 'r u', 'れ': 'r e', 'ろ': 'r o',
    'わ': 'w a', 'を': 'o', 'ん': 'n',
    'が': 'g a', 'ぎ': 'gy i', 'ぐ': 'g u', 'げ': 'g e', 'ご': 'g o',
    'ざ': 'z a', 'じ': 'j i', 'ず': 'z u', 'ぜ': 'z e', 'ぞ': 'z o',
    'だ': 'd a', 'ぢ': 'j i', 'づ': 'z u', 'で': 'd e', 'ど': 'd o',
    'ば': 'b a', 'び': 'by i', 'ぶ': 'b u', 'べ': 'b e', 'ぼ': 'b o',
    'ぱ': 'p a', 'ぴ': 'py i', 'ぷ': 'p u', 'ぺ': 'p e', 'ぽ': 'p o',
    'きゃ': 'ky a', 'きゅ': 'ky u', 'きょ': 'ky o',
    'しゃ': 'sh a', 'しゅ': 'sh u', 'しょ': 'sh o',
    'ちゃ': 'ch a', 'ちゅ': 'ch u', 'ちょ': 'ch o',
    'にゃ': 'ny a', 'にゅ': 'ny u', 'にょ': 'ny o',
    'ひゃ': 'hy a', 'ひゅ': 'hy u', 'ひょ': 'hy o',
    'みゃ': 'my a', 'みゅ': 'my u', 'みょ': 'my o',
    'りゃ': 'ry a', 'りゅ': 'ry u', 'りょ': 'ry o',
    'ぎゃ': 'gy a', 'ぎゅ': 'gy u', 'ぎょ': 'gy o',
    'じゃ': 'j a', 'じゅ': 'j u', 'じょ': 'j o',
    'びゃ': 'by a', 'びゅ': 'by u', 'びょ': 'by o',
    'ぴゃ': 'py a', 'ぴゅ': 'py u', 'ぴょ': 'py o',
    'てゃ': 't a', 'てゅ': 't u', 'てょ': 't o',
    'でゃ': 'd a', 'でゅ': 'd u', 'でょ': 'd o',
    // 外来语假名（片假名常用，平假名形式一并收录以便派生）。
    // 全部复用现有 JP 音素库存，不引入新音素，保证 jp-lora 路径一致。
    // ゔ 系列用 b（日语 /v/ 常读作 [b]，且音素库存无 v）。
    'ふぁ': 'f a', 'ふぃ': 'f i', 'ふぇ': 'f e', 'ふぉ': 'f o',
    'ゔ': 'b u', 'ゔぁ': 'b a', 'ゔぃ': 'b i', 'ゔぇ': 'b e', 'ゔぉ': 'b o',
    'てぃ': 't i', 'とぅ': 't u', 'でぃ': 'd i', 'どぅ': 'd u',
    'しぇ': 'sh e', 'じぇ': 'j e', 'ちぇ': 'ch e',
    'うぃ': 'w i', 'うぇ': 'w e', 'うぉ': 'w o',
    'つぁ': 'ts a', 'つぃ': 'ts i', 'つぇ': 'ts e', 'つぉ': 'ts o',
    'っ': 'cl',
};

// 片假名由平假名码位整体偏移 0x60 得到，两处原本各自派生，这里只派生一次。
// 必须逐码位转换整个字符串：拗音条目（きゃ/しゃ…）是两个码位，若只转首码位
// 会丢掉 ゃ/ゅ/ょ，派生出 キ→'ky o' 这类单字键，反过来覆盖正常单字 キ→'k i'，
// 导致 13 个片假名单字误读、片假名拗音整体缺失。
const JP_KATAKANA_MAP = {};
for (const [hira, ph] of Object.entries(JP_HIRAGANA_MAP)) {
    const kata = [...hira].map(c => String.fromCharCode(c.charCodeAt(0) + 0x60)).join('');
    JP_KATAKANA_MAP[kata] = ph;
}

module.exports = { JP_HIRAGANA_MAP, JP_KATAKANA_MAP };
