// 小さな DOM ヘルパー群

/** h('div', {class:'x', onclick: fn}, 'text', child) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'muted' || k === 'autoplay' || k === 'loop' || k === 'controls' || k === 'multiple') el[k] = Boolean(v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** null/false を無視して子要素を追加（Element.append は null を "null" と表示してしまうため） */
export function add(el, ...children) {
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function option(value, label, selected) {
  return h('option', { value, selected: selected ? true : undefined }, label);
}

export function select(options, value, onchange, attrs = {}) {
  const el = h('select', { ...attrs, onchange: (e) => onchange?.(e.target.value) });
  for (const o of options) {
    if (o.group) {
      const g = h('optgroup', { label: o.group });
      for (const x of o.options) g.append(option(x.value, x.label, x.value === value));
      el.append(g);
    } else el.append(option(o.value, o.label, o.value === value));
  }
  el.value = value;
  return el;
}

export function segmented(options, value, onchange) {
  const wrap = h('div', { class: 'seg' });
  for (const o of options) {
    wrap.append(
      h('button', {
        type: 'button',
        class: String(o.value) === String(value) ? 'on' : '',
        title: o.title,
        onclick: () => {
          for (const b of wrap.children) b.classList.remove('on');
          wrap.children[options.indexOf(o)].classList.add('on');
          onchange(o.value);
        },
      }, o.label),
    );
  }
  return wrap;
}

export function toast(message, type = 'info', ms = 4200) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${type}` }, message);
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, type === 'err' ? Math.max(ms, 8000) : ms);
}

/** モーダルを開く */
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modalRoot');
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const foot = actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => (a instanceof Node ? a : h('button', { class: `btn ${a.class || ''}`, onclick: () => a.onClick?.(close), disabled: a.disabled }, a.label)))) : null;
  const dlg = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' },
    h('div', { class: 'modal-head' }, title, h('div', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: close, title: '閉じる' }, '✕')),
    h('div', { class: 'modal-body' }, body),
    foot,
  );
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, dlg);
  root.append(back);
  document.addEventListener('keydown', onKey, true);
  return { close, el: dlg, body: dlg.querySelector('.modal-body'), foot };
}

export function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: '確認',
      body: h('div', { style: { whiteSpace: 'pre-wrap' } }, message),
      actions: [
        { label: 'キャンセル', onClick: (close) => close() },
        { label: okLabel, class: danger ? 'danger' : 'primary', onClick: (close) => { done = true; resolve(true); close(); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
    m.foot?.lastChild?.focus();
  });
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtSec(s) {
  if (!Number.isFinite(s)) return '';
  return s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${s.toFixed(1)}秒`;
}

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10);

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
