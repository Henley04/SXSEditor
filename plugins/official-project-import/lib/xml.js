'use strict';
/**
 * 极简 XML 解析器（只服务于工程文件导入，不追求通用性）。
 *
 * 之所以不引第三方库：插件包不装 node_modules，运行时也不能联网。
 * 这里覆盖工程文件实际会用到的全部语法：声明、注释、CDATA、自闭合标签、
 * 属性、字符实体（含数字实体）。命名空间前缀原样保留，查找时按 localName 比较。
 */

const MAX_DEPTH = 512;
const MAX_NODES = 2000000;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const named = ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

function localName(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

/** 解析起始标签：返回 { name, attrs, selfClosing }。 */
function parseStartTag(input, start, end) {
  const body = input.slice(start + 1, end);
  const selfClosing = body.endsWith('/');
  const text = selfClosing ? body.slice(0, -1) : body;
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  let j = i;
  while (j < text.length && !/[\s=]/.test(text[j])) j++;
  const name = text.slice(i, j);
  if (!name) throw new Error('XML 起始标签缺少名字');
  const attrs = {};
  while (j < text.length) {
    while (j < text.length && /\s/.test(text[j])) j++;
    if (j >= text.length) break;
    let k = j;
    while (k < text.length && !/[\s=]/.test(text[k])) k++;
    const attrName = text.slice(j, k);
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] !== '=') {
      // 允许没有值的属性（XML 不允许，但真实文件里偶尔出现）
      attrs[attrName] = '';
      j = k;
      continue;
    }
    k++;
    while (k < text.length && /\s/.test(text[k])) k++;
    const quote = text[k];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, k + 1);
      if (close === -1) throw new Error(`XML 属性 ${attrName} 的引号没有闭合`);
      attrs[attrName] = decodeEntities(text.slice(k + 1, close));
      j = close + 1;
    } else {
      let m = k;
      while (m < text.length && !/\s/.test(text[m])) m++;
      attrs[attrName] = decodeEntities(text.slice(k, m));
      j = m;
    }
  }
  return { name, attrs, selfClosing };
}

/**
 * @param {string} input
 * @returns {{name:string, attrs:object, children:Array, text:string}}
 */
function parseXml(input) {
  if (typeof input !== 'string' || !input) throw new Error('XML 内容为空');
  let pos = 0;
  const len = input.length;
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let nodes = 0;

  const appendText = (raw) => {
    if (!raw) return;
    stack[stack.length - 1].text += decodeEntities(raw);
  };

  while (pos < len) {
    const lt = input.indexOf('<', pos);
    if (lt === -1) {
      appendText(input.slice(pos));
      break;
    }
    if (lt > pos) appendText(input.slice(pos, lt));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('XML 注释没有闭合');
      pos = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('XML CDATA 没有闭合');
      stack[stack.length - 1].text += input.slice(lt + 9, end);
      pos = end + 3;
      continue;
    }
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('XML 声明没有闭合');
      pos = end + 2;
      continue;
    }
    if (input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt + 2);
      if (end === -1) throw new Error('XML 声明没有闭合');
      pos = end + 1;
      continue;
    }

    // 起始/结束标签：找 '>' 时要跳过引号内的内容
    let gt = lt + 1;
    let quote = null;
    while (gt < len) {
      const ch = input[gt];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt++;
    }
    if (gt >= len) throw new Error('XML 标签没有闭合');

    if (input[lt + 1] === '/') {
      const name = input.slice(lt + 2, gt).trim();
      const open = stack.pop();
      if (!open || open === root) throw new Error(`XML 出现多余的结束标签 </${name}>`);
      if (open.name !== name) {
        // 允许前缀不一致（极少见），但结构必须对得上
        if (localName(open.name) !== localName(name)) {
          throw new Error(`XML 标签不匹配：<${open.name}> 被 </${name}> 关闭`);
        }
      }
      pos = gt + 1;
      continue;
    }

    const tag = parseStartTag(input, lt, gt);
    const node = { name: tag.name, attrs: tag.attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    nodes++;
    if (nodes > MAX_NODES) throw new Error('XML 节点数量超出上限');
    if (!tag.selfClosing) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new Error('XML 嵌套过深');
    }
    pos = gt + 1;
  }

  if (stack.length !== 1) throw new Error(`XML 有未闭合的标签 <${stack[stack.length - 1].name}>`);
  if (!root.children.length) throw new Error('XML 没有根元素');
  return root.children[0];
}

/** 直接子元素里 localName 命中任一名字的第一个。 */
function child(node, ...names) {
  if (!node) return null;
  for (const item of node.children) {
    if (names.includes(localName(item.name))) return item;
  }
  return null;
}

function children(node, ...names) {
  if (!node) return [];
  return node.children.filter((item) => names.includes(localName(item.name)));
}

/** 深度优先查找第一个 localName 命中的后代（不含自身）。 */
function find(node, ...names) {
  if (!node) return null;
  const stack = [...node.children].reverse();
  while (stack.length) {
    const item = stack.pop();
    if (names.includes(localName(item.name))) return item;
    for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]);
  }
  return null;
}

function findAll(node, ...names) {
  const out = [];
  if (!node) return out;
  const stack = [...node.children].reverse();
  while (stack.length) {
    const item = stack.pop();
    if (names.includes(localName(item.name))) out.push(item);
    for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]);
  }
  return out;
}

function textOf(node, ...names) {
  const target = names.length ? child(node, ...names) : node;
  if (!target) return '';
  // 混排时（如 <pos><t>0</t></pos>）取第一个数字型文本仍由调用方决定，
  // 这里只返回自身的直接文本。
  return target.text.trim();
}

function numberOf(node, ...names) {
  const text = textOf(node, ...names);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** 解析 <pos><t>123</t></pos> 这类包装：返回内部第一个数字。 */
function numberIn(node) {
  if (!node) return null;
  const direct = Number(node.text.trim());
  if (node.text.trim() && Number.isFinite(direct)) return direct;
  const stack = [...node.children];
  while (stack.length) {
    const item = stack.shift();
    const n = Number(item.text.trim());
    if (item.text.trim() && Number.isFinite(n)) return n;
    stack.unshift(...item.children);
  }
  return null;
}

/** 先按子元素名找数字，找不到时在该子元素内部递归找第一个数字。 */
function deepNumber(node, ...names) {
  for (const name of names) {
    const target = child(node, name);
    if (!target) continue;
    const n = numberIn(target);
    if (n !== null) return n;
  }
  return null;
}

module.exports = {
  parseXml,
  child,
  children,
  find,
  findAll,
  textOf,
  numberOf,
  numberIn,
  deepNumber,
  localName,
  decodeEntities,
};
