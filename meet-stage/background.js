// ツールバーのアイコンをクリックすると、操作用の小さなウィンドウを開く(すでにあれば前面に出す)
chrome.action.onClicked.addListener(async () => {
  const { controllerWindowId } = await chrome.storage.session.get('controllerWindowId');
  if (controllerWindowId != null) {
    try {
      await chrome.windows.update(controllerWindowId, { focused: true });
      return;
    } catch { /* 閉じられていた */ }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('controller.html'), type: 'popup', width: 380, height: 760,
  });
  await chrome.storage.session.set({ controllerWindowId: win.id });
});
