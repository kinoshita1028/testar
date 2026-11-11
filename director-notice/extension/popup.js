const id = new URLSearchParams(location.search).get('id');
const $ = (s) => document.getElementById(s);

(async () => {
  const { notices = [], state = {} } = await chrome.storage.local.get(['notices', 'state']);
  const n = notices.find((x) => x.id === id);
  if (!n) { window.close(); return; }
  document.title = `【重要】${n.title}`;
  $('title').textContent = n.title;
  $('body').textContent = n.body || '';
  const occ = state[id]?.occ;
  if (occ) $('when').textContent = `配信日時: ${new Date(occ).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (/^https?:\/\//i.test(n.url || '')) {
    $('link').href = n.url;
    $('link').hidden = false;
  }
})();

$('ack').addEventListener('click', async () => {
  $('ack').disabled = true;
  try { await chrome.runtime.sendMessage({ type: 'ack', id }); } catch { /* 次回同期で再送 */ }
  window.close();
});
