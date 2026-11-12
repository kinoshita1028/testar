// 操作用ウィンドウ(拡張機能)と inject.js(Meetのページ本体)の橋渡し + Meetのボタン操作
(() => {
  if (window.__meetStageContent) return;
  window.__meetStageContent = true;

  const TAG = 'meet-stage';
  const STOP = [/共有を停止/, /表示を停止/, /固定表示を停止/, /stop sharing/i, /stop presenting/i];
  const PRESENT = [/画面を共有/, /画面共有/, /今すぐ表示/, /share screen/i, /present now/i];

  const labelOf = (el) =>
    [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.textContent].filter(Boolean).join(' ');
  const find = (patterns, exclude = []) =>
    [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
      .filter((el) => el.getClientRects().length > 0 && !el.disabled)
      .find((el) => {
        const label = labelOf(el);
        return patterns.some((p) => p.test(label)) && !exclude.some((p) => p.test(label));
      });

  // ---- ページ本体とのやりとり ----
  const pending = new Map();
  const ports = new Set();
  let reqSeq = 0;

  const ask = (msg) => new Promise((resolve) => {
    const reqId = ++reqSeq;
    pending.set(reqId, resolve);
    window.postMessage({ ...msg, [TAG]: 'to-page', reqId }, location.origin);
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.[TAG] !== 'from-page') return;
    const { [TAG]: _tag, ...msg } = ev.data;
    if (msg.type === 'reply') {
      pending.get(msg.reqId)?.(msg);
      pending.delete(msg.reqId);
    } else {
      for (const port of ports) port.postMessage(msg); // state / thumb
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TAG) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    ask({ type: 'state' });
  });

  // ---- 操作用ウィンドウからの指示 ----
  async function handle(msg) {
    switch (msg.type) {
      case 'add':
      case 'remove':
      case 'rename':
        return ask(msg);
      case 'show': {
        // 共有中ならソースを差し替えるだけ。まだなら、Meetの共有ボタンを押して始める
        const res = await ask({ type: 'switch', id: msg.id });
        if (res.presenting) return res.ok ? { ok: true } : { ok: false, error: 'そのソースはもうありません' };
        const armed = await ask({ type: 'arm', id: msg.id });
        if (!armed.ok) return { ok: false, error: 'そのソースはもうありません' };
        const btn = find(PRESENT, STOP);
        if (!btn) return { ok: false, error: 'Meetの共有ボタンが見つかりません(会議に参加していますか?)' };
        btn.click();
        return { ok: true };
      }
      case 'stop': {
        const btn = find(STOP);
        if (!btn) return { ok: false, error: 'Meetの共有停止ボタンが見つかりません' };
        btn.click();
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown' };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.[TAG] !== true) return;
    handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });
})();
