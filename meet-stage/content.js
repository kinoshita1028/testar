// Google Meet の画面上のボタンを、サイドパネルからの指示で押す
(() => {
  if (window.__meetStageLoaded) return;
  window.__meetStageLoaded = true;

  const STOP = [/共有を停止/, /表示を停止/, /固定表示を停止/, /stop sharing/i, /stop presenting/i];
  const PRESENT = [/画面を共有/, /画面共有/, /今すぐ表示/, /share screen/i, /present now/i];

  const labelOf = (el) =>
    [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.textContent]
      .filter(Boolean).join(' ');
  const visible = (el) => el.getClientRects().length > 0 && !el.disabled;
  const buttons = () => [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].filter(visible);
  const find = (patterns, exclude = []) =>
    buttons().find((el) => {
      const label = labelOf(el);
      return patterns.some((p) => p.test(label)) && !exclude.some((p) => p.test(label));
    });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'meet-stage:status') {
      sendResponse({ ok: true, presenting: Boolean(find(STOP)), inCall: Boolean(find(PRESENT) || find(STOP)) });
    } else if (msg?.type === 'meet-stage:present') {
      const btn = find(PRESENT, STOP);
      if (btn) { btn.click(); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, error: find(STOP) ? 'すでに共有中です' : '共有ボタンが見つかりません(会議に参加していますか?)' });
    } else if (msg?.type === 'meet-stage:stop') {
      const btn = find(STOP);
      if (btn) { btn.click(); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, error: '共有停止ボタンが見つかりません(共有中ではないようです)' });
    }
  });
})();
