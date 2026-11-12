// 他アプリのウィンドウ/画面のキャプチャ映像を投影ウィンドウ内に表示するページ。
// 映像(MediaStream)はサイドパネルが取得し、attachStream() で渡してくる。
const video = document.getElementById('video');
const msg = document.getElementById('msg');
let watch;

function ended() {
  clearInterval(watch);
  video.srcObject = null;
  msg.textContent = 'キャプチャが終了しました。サイドバーから追加し直してください。';
  msg.hidden = false;
  if (!document.title.startsWith('(終了)')) document.title = '(終了) ' + document.title;
}

window.attachStream = (stream, name) => {
  document.title = name;
  video.srcObject = stream;
  video.play().catch(() => {});
  msg.hidden = true;
  // サイドパネルが閉じられた場合などはイベントが届かないことがあるので定期的にも確認する
  clearInterval(watch);
  watch = setInterval(() => {
    let alive = false;
    try { alive = stream.active; } catch { /* 取得元のページが消えた */ }
    if (!alive) ended();
  }, 1000);
};
