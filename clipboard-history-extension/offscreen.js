// PCのクリップボードを定期的に読み取り、内容が変わったらバックグラウンドへ通知する
const sink = document.getElementById('sink');
let last = null;

function readClipboard() {
  sink.value = '';
  sink.focus();
  const ok = document.execCommand('paste');
  const text = sink.value;
  sink.value = '';
  return ok ? text : null;
}

function poll() {
  let text;
  try {
    text = readClipboard();
  } catch (e) {
    return;
  }
  if (text === null || text === '' || text === last) return;
  last = text;
  chrome.runtime.sendMessage({ type: 'clip', text }).catch(() => {});
}

poll();
setInterval(poll, 1000);
