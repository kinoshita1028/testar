// Webページ上でのコピー/切り取りを即座に記録する(クリップボード監視の取りこぼし対策)
(() => {
  function onCopy() {
    let text = '';
    try {
      const el = document.activeElement;
      if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'password'))
          && typeof el.selectionStart === 'number') {
        text = el.value.substring(el.selectionStart, el.selectionEnd);
      } else if (!(el && el.tagName === 'INPUT')) {
        text = String(document.getSelection() || '');
      }
    } catch (e) { /* 取得できなければ無視 */ }
    if (!text) return;
    try {
      chrome.runtime.sendMessage({ type: 'clip', text }).catch(() => {});
    } catch (e) { /* 拡張機能の再読み込み直後など */ }
  }
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('cut', onCopy, true);
})();
