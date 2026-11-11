const $ = (s) => document.getElementById(s);

async function render() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  const ls = s.lastSync;
  $('state').textContent = !ls ? '未同期' : ls.ok ? `正常（配信中の通知 ${ls.count} 件）` : `エラー: ${ls.error}`;
  $('state').className = ls?.ok ? 'ok' : 'ng';
  $('email').textContent = s.email || '（Chromeに未ログイン）';
  const u = ls?.user;
  $('school').textContent = u ? [u.schools.join('、'), u.name].filter(Boolean).join(' / ') || '（宛先マスタに未登録）' : '-';
  $('last').textContent = ls ? new Date(ls.at).toLocaleString('ja-JP') : '-';
  $('source').textContent = s.isManaged ? '管理者による配布' : s.configured ? '手動設定' : '未設定';
  $('version').textContent = s.version;
  $('manual').hidden = s.isManaged;
}

async function syncNow() {
  $('state').textContent = '同期中…';
  $('state').className = '';
  await chrome.runtime.sendMessage({ type: 'syncNow' });
  await render();
}

$('sync').addEventListener('click', syncNow);
$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    localConfig: {
      apiUrl: $('apiUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      testEmail: $('testEmail').value.trim(),
    },
  });
  await syncNow();
});

(async () => {
  const { localConfig = {} } = await chrome.storage.local.get('localConfig');
  $('apiUrl').value = localConfig.apiUrl || '';
  $('apiKey').value = localConfig.apiKey || '';
  $('testEmail').value = localConfig.testEmail || '';
  await render();
})();
