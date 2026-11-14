const stateEl = document.getElementById('state');
const grantBtn = document.getElementById('grant');
const closeBtn = document.getElementById('closeTab');
const settingsBtn = document.getElementById('openSettings');
const deniedHelp = document.getElementById('deniedHelp');

function show(kind, text) {
  stateEl.className = `state ${kind}`;
  stateEl.textContent = text;
}

async function requestMic() {
  show('wait', 'ブラウザの許可ダイアログで「許可」を選んでください…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    show('ok', '✓ マイクが許可されました。このタブを閉じて、サイドパネルの「録音開始」を押してください。');
    grantBtn.hidden = true;
    deniedHelp.hidden = true;
    settingsBtn.hidden = true;
    closeBtn.hidden = false;
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      show('error', 'マイクが見つかりません。マイクを接続してから、もう一度お試しください。');
    } else {
      show('error', 'マイクがブロックされています。下の手順で許可してください。');
      deniedHelp.hidden = false;
      settingsBtn.hidden = false;
    }
  }
}

grantBtn.addEventListener('click', requestMic);
closeBtn.addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) chrome.tabs.remove(tab.id);
  else window.close();
});
settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({
    url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`,
  });
});

requestMic();
