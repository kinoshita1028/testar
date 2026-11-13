/*
 * プレビュー用：Google Apps Script のサービスをブラウザ内で再現します。
 * Code.gs（本物のAPI）をそのまま動かし、保存先だけをメモリ＋localStorage に置き換えます。
 */
(function () {
  var LS_KEY = 'shift-preview-data-v1';
  var KEYS = { facilities: 'id', classes: 'id', staff: 'id', patterns: 'id', rules: 'age', attendance: null, settings: 'key', accounts: 'id', shifts: 'id', history: null };
  var data = null;
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* 保存できなくても動作は続ける */ } }
  function seed() {
    var demo = Shared.Demo.build(Shared.todayJST());
    data = {};
    Object.keys(KEYS).forEach(function (t) { data[t] = demo[t] ? clone(demo[t]) : []; });
    var m = { facilities: data.facilities, classes: data.classes, staff: data.staff };
    data.shifts = data.shifts.map(function (s) { return decorateShift_(s, m); });
    data.seededOn = Shared.todayJST();
    save();
  }
  function load() {
    if (data) return;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.seededOn && d.seededOn.slice(0, 7) === Shared.todayJST().slice(0, 7)) data = d;
      }
    } catch (e) { data = null; }
    if (!data) seed();
  }
  var MemoryStore = {
    url: function () { return 'https://docs.google.com/spreadsheets/（プレビューではスプレッドシートの代わりにブラウザ内に保存します）'; },
    list: function (t) { load(); return clone(data[t] || []); },
    count: function (t) { load(); return (data[t] || []).length; },
    upsert: function (t, objs) {
      load();
      var key = KEYS[t], idx = {};
      data[t].forEach(function (r, i) { idx[r[key]] = i; });
      objs.forEach(function (o) {
        var c = clone(o);
        if (idx[c[key]] !== undefined) data[t][idx[c[key]]] = c; else { idx[c[key]] = data[t].length; data[t].push(c); }
      });
      save();
    },
    append: function (t, objs) { load(); objs.forEach(function (o) { data[t].push(clone(o)); }); save(); },
    remove: function (t, keys) {
      load();
      var key = KEYS[t], set = {};
      keys.forEach(function (k) { set[k] = true; });
      data[t] = data[t].filter(function (r) { return !set[r[key]]; });
      save();
    },
    replaceAll: function (t, objs) { load(); data[t] = clone(objs); save(); },
    writeMonthly: function (ym, rows) { load(); data.monthly = rows; save(); return { sheetName: '月次集計', url: '' }; }
  };
  window.getStore_ = function () { return MemoryStore; };
  window.__resetPreviewData = function () { try { localStorage.removeItem(LS_KEY); } catch (e) { /* noop */ } data = null; seed(); };

  var cache = {};
  window.CacheService = { getScriptCache: function () { return {
    get: function (k) { return cache[k] === undefined ? null : cache[k]; },
    put: function (k, v) { cache[k] = String(v); },
    remove: function (k) { delete cache[k]; }
  }; } };
  window.Session = { getActiveUser: function () { return { getEmail: function () { return ''; } }; } };
  window.LockService = { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } };
  window.Utilities = {
    getUuid: function () { return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36); },
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: function () { throw new Error('プレビューでは暗号化した暗証番号は使えません'); }
  };

  // google.script.run の代わり（JSONで往復させて本物と同じ制約にする）
  function runner(ok, ng) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return runner(fn, ng); };
        if (name === 'withFailureHandler') return function (fn) { return runner(ok, fn); };
        return function () {
          var args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
          setTimeout(function () {
            var res;
            try { res = window[name].apply(null, args); }
            catch (e) { if (ng) ng(e); else console.error(e); return; }
            if (ok) ok(res === undefined ? undefined : JSON.parse(JSON.stringify(res)));
          }, 150 + Math.random() * 150);
        };
      }
    });
  }
  window.google = { script: { run: runner(null, null) } };
  window.__PREVIEW__ = true;
})();
