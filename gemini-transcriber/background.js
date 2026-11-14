// Service worker: opens the side panel on toolbar click and copies text to the
// clipboard through an offscreen document when the panel itself has no focus
// (e.g. auto-copy while you are typing in another tab).

const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null;

function enablePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('setPanelBehavior failed', err));
}

chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['CLIPBOARD'],
        justification: '文字起こし結果をクリップボードへコピーするため',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'copy-text') return undefined;

  (async () => {
    try {
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'copy',
        text: String(message.text ?? ''),
      });
      sendResponse(result ?? { ok: false, error: 'no response' });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // keep the message channel open for the async response
});
