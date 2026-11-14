// Offscreen document: the only place an extension can write to the clipboard
// while none of its pages has focus.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'copy') return undefined;

  const area = document.getElementById('clip');
  try {
    area.value = message.text;
    area.select();
    const ok = document.execCommand('copy');
    sendResponse({ ok });
  } catch (err) {
    sendResponse({ ok: false, error: String(err?.message || err) });
  } finally {
    area.value = '';
  }
  return undefined;
});
