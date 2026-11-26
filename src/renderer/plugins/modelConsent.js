/**
 * 首次调用某个模型端点时的确认窗（渲染层）。
 *
 * 设计约束（设计方案 §12.4）：
 *   · 必须显示"将发送什么、发多少"——这是用户唯一能用来判断的信息
 *   · 不允许"全部允许"按钮，也不在弹窗里做批量授权
 *   · 默认按钮是"本次运行"，不是"始终允许"
 *   · 30 秒无响应由主进程判拒；这里只显示倒计时，不做定时判定（避免两边各判一次）
 *
 * 不引入任何泛光/发光：分层只靠边框与背景色。
 */

import { TASK_SPECS } from '../../shared/modelContract.js';
import { t } from '../../i18n/index.js';

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** 'stream-text' → 'StreamText'，用来拼 models.consent.* 的键名。 */
function cap(value) {
  return String(value || '')
    .split(/[-_:]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

const OUTPUT_KEYS = ['stream-text', 'text', 'json', 'binary'];
const INPUT_KEYS = ['text', 'json', 'binary'];

function inputLabel(input) {
  return INPUT_KEYS.includes(input) ? t(`models.consent.input${cap(input)}`) : '';
}

function outputLabel(output) {
  return OUTPUT_KEYS.includes(output)
    ? t(`models.consent.output${cap(output)}`)
    : String(output || '');
}

function subjectLabel(subject) {
  const s = String(subject || '');
  if (s.startsWith('plugin:')) return t('models.consent.subjectPlugin', { id: s.slice(7) });
  if (s.startsWith('mcp:')) return t('models.consent.subjectMcp', { id: s.slice(4) });
  if (s === 'host') return t('models.consent.subjectHost');
  return s || '?';
}

/**
 * @param {{onConsentRequest:Function, consentReply:Function}} api
 * @returns {Function} dispose
 */
export function installModelConsent(api) {
  if (!api || typeof api.onConsentRequest !== 'function') return () => {};
  let active = null;

  function close() {
    if (!active) return;
    if (active.timer) clearInterval(active.timer);
    active.el.remove();
    active = null;
  }

  function reply(requestId, answer) {
    try {
      api.consentReply(requestId, answer);
    } catch (_) { /* 主进程已超时，忽略 */ }
    close();
  }

  function show(req) {
    if (!req || !req.requestId) return;
    // 同一时刻只留一个确认窗：多个请求排队会让用户对着两三个几乎一样的框点按钮
    close();

    const spec = TASK_SPECS[req.task] || {};

    const el = document.createElement('div');
    el.className = 'model-consent-backdrop';

    const card = document.createElement('div');
    card.className = 'model-consent-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const title = document.createElement('div');
    title.className = 'model-consent-title';
    title.textContent = t('models.consent.title', { subject: subjectLabel(req.subject) });

    const rows = document.createElement('dl');
    rows.className = 'model-consent-rows';
    const addRow = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      rows.append(dt, dd);
    };
    addRow(t('models.consent.endpoint'),
      `${(req.endpoint && req.endpoint.title) || req.endpoint.id} (${(req.endpoint && req.endpoint.provider) || 'custom'})`);
    addRow(t('models.consent.task'), String(req.task || ''));
    addRow(t('models.consent.sends'),
      `${humanBytes(req.bytesIn)} ${inputLabel(spec.input)}`.trim());
    addRow(t('models.consent.receives'), outputLabel(spec.output));

    const hint = document.createElement('div');
    hint.className = 'model-consent-hint';
    // 文案跟着网络位置走：本机端点说"数据不出本机"，云端才说"会离开本机"。
    // 一句通用文案放在本机端点上就是假话。
    const locality = (req.endpoint && req.endpoint.locality) || 'cloud';
    hint.textContent = t(`models.consent.hint${cap(locality)}`);

    const actions = document.createElement('div');
    actions.className = 'model-consent-actions';

    const countdown = document.createElement('span');
    countdown.className = 'model-consent-countdown';
    let left = 30;
    countdown.textContent = t('models.consent.countdown', { n: left });

    const mk = (label, answer, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = primary ? 'btn-primary' : 'btn-secondary';
      b.textContent = label;
      b.addEventListener('click', () => reply(req.requestId, answer));
      return b;
    };

    const deny = mk(t('models.consent.deny'), 'deny', false);
    const once = mk(t('models.consent.once'), 'once', false);
    const session = mk(t('models.consent.session'), 'session', true);
    const always = mk(t('models.consent.always'), 'always', false);

    actions.append(countdown, deny, once, session, always);
    card.append(title, rows, hint, actions);
    el.appendChild(card);
    document.body.appendChild(el);

    const timer = setInterval(() => {
      left -= 1;
      countdown.textContent = t('models.consent.countdown', { n: left });
      if (left <= 0) {
        // 到点只收摊，不发回执：判定权在主进程网关，这里再回一次会让
        // "超时"被记成两个来源。
        clearInterval(timer);
        close();
      }
    }, 1000);

    active = { el, timer };

    // 焦点落在"本次运行"上：回车默认是最保守的那个长期选项
    setTimeout(() => { try { session.focus(); } catch (_) { /* ignore */ } }, 0);
    deny.addEventListener('keydown', (e) => { if (e.key === 'Escape') reply(req.requestId, 'deny'); });
  }

  const off = api.onConsentRequest(show);
  return () => {
    try { off(); } catch (_) { /* ignore */ }
    close();
  };
}
