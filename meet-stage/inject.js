// Meetのページ本体(MAIN world)で動くスクリプト。
// ・登録した共有ソース(タブ/ウィンドウ/画面)の映像を保持する
// ・Meetが画面共有を始めるとき、選択ダイアログの代わりに「番組」映像を渡す
// ・番組に流すソースを差し替えることで、共有を止めずに見せる画面を切り替える
(() => {
  if (window.__meetStageInject) return;
  window.__meetStageInject = true;

  const TAG = 'meet-stage';
  const md = navigator.mediaDevices;
  const realGetDisplayMedia = MediaDevices.prototype.getDisplayMedia.bind(md);
  const KIND = { monitor: '画面', window: 'ウィンドウ', browser: 'タブ' };

  const sources = new Map(); // id -> { id, name, kind, track, video }
  let seq = 0;
  let program = null;        // { gen, writer, liveId, token }
  let armedId = null;        // 次のgetDisplayMediaで流し始めるソース
  let armedTimer;

  const post = (msg) => window.postMessage({ ...msg, [TAG]: 'from-page' }, location.origin);
  const state = () => ({
    type: 'state',
    presenting: Boolean(program),
    liveId: program?.liveId ?? null,
    frames: program?.frames ?? 0,
    sources: [...sources.values()].map(({ id, name, kind }) => ({ id, name, kind })),
  });
  const pushState = () => post(state());

  // ---- 番組(Meetに渡す1本の映像) ----

  function startProgram(id) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    gen.contentHint = 'detail';
    program = { gen, writer: gen.writable.getWriter(), liveId: null, token: 0, frames: 0 };
    disguise(gen);
    switchTo(id);
    return new MediaStream([gen]);
  }

  // Meetは受け取った映像を「本物の画面共有」として扱おうとするので、
  // 設定の問い合わせには今流しているソースの値を返し、設定変更の要求は受け流す
  function disguise(gen) {
    const live = () => sources.get(program?.liveId)?.track;
    const own = gen.getSettings.bind(gen);
    try {
      gen.getSettings = () => ({ ...(live()?.getSettings() ?? { displaySurface: 'window' }), ...own() });
      gen.getCapabilities = () => live()?.getCapabilities() ?? {};
      gen.getConstraints = () => ({});
      gen.applyConstraints = () => Promise.resolve();
      Object.defineProperty(gen, 'label', { get: () => live()?.label ?? 'Meet Stage' });
    } catch { /* 上書きできなくても共有自体は続ける */ }
  }

  function endProgram() {
    if (!program) return;
    program.token++;
    try { program.gen.stop(); } catch { /* すでに停止 */ }
    program = null;
    pushState();
  }

  const restamp = (frame) => {
    // ソースごとに時刻の基準が違うので、現在時刻に付け替える
    const out = new VideoFrame(frame, { timestamp: Math.round(performance.now() * 1000) });
    frame.close();
    return out;
  };

  async function write(p, frame) {
    try { await p.writer.write(frame); p.frames++; } catch { /* 共有が終了した */ }
    try { frame.close(); } catch { /* 書き込み側で解放済み */ }
  }

  function switchTo(id) {
    const src = sources.get(id);
    const p = program;
    if (!src || !p) return false;
    const token = ++p.token;
    p.liveId = id;

    // 動きのない画面は新しいフレームが来ないので、今の絵をすぐ1枚送る
    if (src.video.readyState >= 2 && src.video.videoWidth) {
      try { write(p, new VideoFrame(src.video, { timestamp: Math.round(performance.now() * 1000) })); } catch { /* まだ絵がない */ }
    }

    const clone = src.track.clone();
    const reader = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 2 }).readable.getReader();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (program !== p || p.token !== token) { value.close(); break; }
          await write(p, restamp(value));
        }
      } finally {
        reader.cancel().catch(() => {});
        clone.stop();
      }
    })();
    pushState();
    return true;
  }

  // Meet側で共有が止められたことはイベントで分からないので定期的に確認する
  setInterval(() => {
    if (program && program.gen.readyState === 'ended') endProgram();
  }, 500);

  // ---- getDisplayMedia の差し替え ----

  // Meetがどの呼び方をしても差し替わるよう、prototype側を置き換える
  delete md.getDisplayMedia;
  MediaDevices.prototype.getDisplayMedia = function (constraints) {
    if (armedId != null && sources.has(armedId)) {
      const id = armedId;
      armedId = null;
      clearTimeout(armedTimer);
      if (program) endProgram();
      return Promise.resolve(startProgram(id));
    }
    return realGetDisplayMedia(constraints); // 通常どおりのMeetの共有
  };

  // ---- ソースの登録 ----

  async function addSource() {
    const stream = await realGetDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    const kind = KIND[track.getSettings().displaySurface] ?? 'キャプチャ';
    const id = ++seq;
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    sources.set(id, { id, name: `${kind} ${id}`, kind, track, video });
    // 元のウィンドウが閉じられた / Chromeの「共有を停止」が押された
    track.addEventListener('ended', () => removeSource(id));
    pushState();
    setTimeout(pushThumbs, 500);
  }

  function removeSource(id) {
    const src = sources.get(id);
    if (!src) return;
    sources.delete(id);
    src.track.stop();
    src.video.srcObject = null;
    if (program?.liveId === id) { program.token++; program.liveId = null; }
    pushState();
  }

  // ---- サムネイル ----

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  function pushThumbs() {
    for (const { id, video } of sources.values()) {
      if (video.readyState < 2 || !video.videoWidth) continue;
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const w = video.videoWidth * scale, h = video.videoHeight * scale;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      post({ type: 'thumb', id, url: canvas.toDataURL('image/jpeg', 0.6) });
    }
  }
  setInterval(() => { pushThumbs(); if (program) pushState(); }, 2000);

  // ---- 操作用ウィンドウからの指示(content.js経由) ----

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.data?.[TAG] !== 'to-page') return;
    const { type, id, name, reqId } = ev.data;
    const reply = (res) => post({ type: 'reply', reqId, ...res });
    try {
      if (type === 'add') {
        await addSource();
        reply({ ok: true });
      } else if (type === 'remove') {
        removeSource(id);
        reply({ ok: true });
      } else if (type === 'rename') {
        if (sources.has(id) && name) sources.get(id).name = name;
        pushState();
        reply({ ok: true });
      } else if (type === 'switch') {
        reply({ ok: switchTo(id), presenting: Boolean(program) });
      } else if (type === 'arm') {
        armedId = id;
        clearTimeout(armedTimer);
        armedTimer = setTimeout(() => { armedId = null; }, 30000);
        reply({ ok: sources.has(id) });
      } else if (type === 'state') {
        pushState();
        pushThumbs();
        reply({ ok: true, presenting: Boolean(program) });
      }
    } catch (e) {
      reply({ ok: false, error: e.name === 'NotAllowedError' ? 'cancelled' : `${e.name}: ${e.message}` });
    }
  });
})();
