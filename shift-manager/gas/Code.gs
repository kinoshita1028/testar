/**
 * Code.gs — Webアプリの入口と、画面から呼ばれる API
 *
 * 画面（Index.html）から google.script.run.api_xxx(req) で呼び出されます。
 * データの保存先は Store.gs（Googleスプレッドシート）です。
 */

// 保存先スプレッドシートのID（空欄なら、このスクリプトを作成したスプレッドシート、またはスクリプトプロパティ SPREADSHEET_ID を使います）
var SPREADSHEET_ID = '';

var APP_TITLE = 'シフト管理';
var TOKEN_HOURS = 6;

function doGet(e) {
  var p = (e && e.parameter) || {};
  var t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify({
    page: p.page === 'hq' ? 'hq' : 'facility',
    facilityId: String(p.en || '').replace(/[^\w-]/g, '')
  }).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ------------------------------------------------------------------
// 共通
// ------------------------------------------------------------------
function loadMasters_(store) {
  return {
    facilities: store.list('facilities').sort(function (a, b) { return Shared.num(a.order, 99) - Shared.num(b.order, 99); }),
    classes: store.list('classes'),
    staff: store.list('staff'),
    patterns: store.list('patterns'),
    rules: store.list('rules'),
    attendance: store.list('attendance'),
    settings: store.list('settings'),
    accounts: store.list('accounts')
  };
}

function settingsOf_(m) { return Shared.settingsMap(m.settings); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function hashPin_(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
}
function pinMatches_(stored, pin) {
  stored = String(stored === null || stored === undefined ? '' : stored).trim();
  if (!stored) return false;
  if (stored.indexOf('sha256:') === 0) return stored.slice(7).toLowerCase() === hashPin_(pin);
  return stored === String(pin).trim();
}

function publicUser_(acc) {
  if (!acc) return null;
  return { id: acc.id, name: acc.name, role: acc.role, facilityId: acc.facilityId || '' };
}

/** トークン（ログイン）またはGoogleアカウントのメールから利用者を特定 */
function currentUser_(token, m) {
  var cache = CacheService.getScriptCache();
  var accId = token ? cache.get('tok:' + token) : null;
  var acc = null;
  if (accId) acc = m.accounts.filter(function (a) { return a.id === accId; })[0] || null;
  if (acc) return { acc: acc, token: token };
  var email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { email = ''; }
  if (email) {
    acc = m.accounts.filter(function (a) { return String(a.email || '').toLowerCase() === email; })[0] || null;
    if (acc) {
      var t = Utilities.getUuid();
      cache.put('tok:' + t, acc.id, TOKEN_HOURS * 3600);
      return { acc: acc, token: t };
    }
  }
  return null;
}

function canApprove_(acc, facilityId) {
  if (!acc) return false;
  if (acc.role === '本部') return true;
  return (acc.role === '園長' || acc.role === '主任') && acc.facilityId === facilityId;
}

function requireApprover_(req, m, facilityId) {
  var u = currentUser_(req.token, m);
  if (!u) throw new Error('LOGIN_REQUIRED: 承認印を押すには、園長・主任・本部のアカウントでログインしてください。');
  if (!canApprove_(u.acc, facilityId)) throw new Error('この園の承認権限がありません（' + u.acc.name + '）。');
  return u.acc;
}

function decorateShift_(s, m) {
  var fac = m.facilities.filter(function (f) { return f.id === s.facilityId; })[0] || {};
  var st = m.staff.filter(function (x) { return x.id === s.staffId; })[0] || {};
  var cls = m.classes.filter(function (c) { return c.id === s.classId; })[0] || {};
  var h = Shared.calcHours(s);
  s.facilityName = fac.name || s.facilityName || '';
  s.dow = Shared.DOW[Shared.dow(s.date)];
  s.staffName = st.name || s.staffName || '';
  s.className = cls.name || '';
  s.spanH = h.span;
  s.workH = h.work;
  return s;
}

function validDate_(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }
function cleanTime_(t) {
  var v = Shared.toMin(t);
  return v === null ? '' : Shared.fromMin(v);
}

// ------------------------------------------------------------------
// API
// ------------------------------------------------------------------

/** 画面の初期表示に必要なマスタ類と、ログイン状態 */
function api_bootstrap(req) {
  req = req || {};
  var store = getStore_();
  var m = loadMasters_(store);
  var st = settingsOf_(m);
  var u = currentUser_(req.token, m);
  var demo = Shared.bool(st.demoMode, false);
  return {
    today: Shared.todayJST(),
    now: Shared.nowJST(),
    user: u ? publicUser_(u.acc) : null,
    token: u ? u.token : '',
    settings: m.settings,
    facilities: m.facilities,
    classes: m.classes,
    staff: m.staff,
    patterns: m.patterns,
    rules: m.rules,
    attendance: m.attendance,
    accounts: m.accounts.map(function (a) {
      var p = String(a.pin || '');
      return { id: a.id, name: a.name, role: a.role, facilityId: a.facilityId || '',
        demoPin: demo && p && p.indexOf('sha256:') !== 0 ? p : '' };
    }),
    sheetUrl: store.url()
  };
}

function api_login(req) {
  req = req || {};
  var store = getStore_();
  var m = loadMasters_(store);
  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + req.accountId;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('暗証番号を続けて間違えたため、5分間ログインできません。');
  var acc = m.accounts.filter(function (a) { return a.id === req.accountId; })[0];
  if (!acc || !pinMatches_(acc.pin, req.pin)) {
    cache.put(failKey, String(fails + 1), 300);
    throw new Error('アカウントまたは暗証番号が違います。');
  }
  cache.remove(failKey);
  var token = Utilities.getUuid();
  cache.put('tok:' + token, acc.id, TOKEN_HOURS * 3600);
  return { token: token, user: publicUser_(acc) };
}

function api_logout(req) {
  if (req && req.token) CacheService.getScriptCache().remove('tok:' + req.token);
  return { ok: true };
}

/** 期間内の勤務 */
function api_getShifts(req) {
  req = req || {};
  if (!validDate_(req.from) || !validDate_(req.to)) throw new Error('期間の指定が正しくありません。');
  var store = getStore_();
  var list = store.list('shifts').filter(function (s) {
    return s.facilityId === req.facilityId && s.date >= req.from && s.date <= req.to;
  });
  return { shifts: list, now: Shared.nowJST() };
}

/**
 * 勤務の保存（1件でも複数でも）。保存した勤務は「変更中」になります。
 * item: { staffId, date, type, kind, start, end, breakStart, breakMin, classId, segments, note, clear, base }
 *   base … 画面が読み込んだ時点の入力日時。他の人が先に変更していたら conflicts に入ります。
 */
function api_saveShifts(req) {
  req = req || {};
  var items = req.items || [];
  if (!items.length) return { saved: [], deleted: [], conflicts: [] };
  return withLock_(function () {
    var store = getStore_();
    var m = loadMasters_(store);
    var u = currentUser_(req.token, m);
    var editor = u ? u.acc.name : String(req.editor || '').slice(0, 40) || '（未入力）';
    var now = Shared.nowJST();
    var all = store.list('shifts');
    var byId = {};
    all.forEach(function (s) { byId[s.id] = s; });
    var staffById = {};
    m.staff.forEach(function (s) { staffById[s.id] = s; });
    var patByName = {};
    Shared.patternsFor(m, req.facilityId).forEach(function (p) { patByName[p.name] = p; });
    var saved = [], deleted = [], conflicts = [], logs = [];

    items.forEach(function (it) {
      if (!validDate_(it.date)) return;
      var staff = staffById[it.staffId];
      if (!staff || staff.facilityId !== req.facilityId) return;
      var id = it.date + '_' + it.staffId;
      var cur = byId[id] || null;
      if (it.base !== undefined && it.base !== null) {
        var curStamp = cur ? String(cur.editedAt || '') : '';
        if (curStamp !== String(it.base || '')) { conflicts.push({ id: id, current: cur }); return; }
      }
      var before = cur ? Shared.shiftText(cur) : '';
      if (it.clear) {
        if (!cur) return;
        if (cur.status === Shared.STATUS.FIXED || cur.prevFixed) {
          var del = {};
          for (var k in cur) del[k] = cur[k];
          del.type = ''; del.kind = ''; del.start = ''; del.end = ''; del.breakStart = ''; del.breakMin = 0;
          del.segments = ''; del.prevFixed = cur.prevFixed || (cur.status === Shared.STATUS.FIXED ? Shared.shiftText(cur) : '');
          del.status = Shared.STATUS.DRAFT; del.editor = editor; del.editedAt = now; del.approver = ''; del.approvedAt = '';
          decorateShift_(del, m);
          saved.push(del); byId[id] = del;
          logs.push({ at: now, action: '削除（承認待ちへ）', facilityId: req.facilityId, shiftId: id, date: it.date, staffName: staff.name, before: before, after: '（削除）', by: editor, note: '' });
        } else {
          deleted.push(id); delete byId[id];
          logs.push({ at: now, action: '削除', facilityId: req.facilityId, shiftId: id, date: it.date, staffName: staff.name, before: before, after: '', by: editor, note: '' });
        }
        return;
      }
      var pat = patByName[it.type] || null;
      var kind = it.kind || (pat ? pat.kind : Shared.KIND.WORK);
      var isWork = kind === Shared.KIND.WORK || kind === Shared.KIND.TRAIN;
      var rec = {
        id: id, facilityId: req.facilityId, date: it.date, staffId: it.staffId,
        type: String(it.type || '').slice(0, 20), kind: kind,
        start: isWork ? cleanTime_(it.start) : '', end: isWork ? cleanTime_(it.end) : '',
        breakStart: isWork ? cleanTime_(it.breakStart) : '', breakMin: isWork ? Math.max(0, Math.min(240, Number(it.breakMin) || 0)) : 0,
        classId: String(it.classId || ''), segments: isWork ? Shared.formatSegments(Shared.parseSegments(it.segments)) : '',
        note: String(it.note || '').slice(0, 200),
        status: Shared.STATUS.DRAFT, editor: editor, editedAt: now, approver: '', approvedAt: '',
        prevFixed: cur ? (cur.prevFixed || (cur.status === Shared.STATUS.FIXED ? Shared.shiftText(cur) : '')) : ''
      };
      if (isWork && (!rec.start || !rec.end)) throw new Error(staff.name + ' ' + it.date + '：出勤・退勤の時刻を入れてください。');
      if (isWork && Shared.toMin(rec.end) <= Shared.toMin(rec.start)) throw new Error(staff.name + ' ' + it.date + '：退勤は出勤より後の時刻にしてください。');
      // 内容が同じなら何もしない
      if (cur && ['type', 'kind', 'start', 'end', 'breakStart', 'breakMin', 'classId', 'segments', 'note'].every(function (k) { return String(cur[k] === undefined ? '' : cur[k]) === String(rec[k]); })) {
        saved.push(cur);
        return;
      }
      decorateShift_(rec, m);
      saved.push(rec); byId[id] = rec;
      logs.push({ at: now, action: cur ? '変更' : '入力', facilityId: req.facilityId, shiftId: id, date: it.date, staffName: staff.name, before: before, after: Shared.shiftText(rec), by: editor, note: rec.note });
    });

    if (saved.length) store.upsert('shifts', saved);
    if (deleted.length) store.remove('shifts', deleted);
    if (logs.length) store.append('history', logs);
    return { saved: saved, deleted: deleted, conflicts: conflicts, now: now };
  });
}

/** 変更中 → 承認待ち（だれでも可） */
function api_requestApproval(req) {
  req = req || {};
  return withLock_(function () {
    var store = getStore_();
    var m = loadMasters_(store);
    var u = currentUser_(req.token, m);
    var editor = u ? u.acc.name : String(req.editor || '').slice(0, 40) || '（未入力）';
    var now = Shared.nowJST();
    var ids = {};
    (req.ids || []).forEach(function (id) { ids[id] = true; });
    var targets = store.list('shifts').filter(function (s) {
      return s.facilityId === req.facilityId && s.status === Shared.STATUS.DRAFT && ids[s.id];
    });
    targets.forEach(function (s) { s.status = Shared.STATUS.PENDING; s.editedAt = now; });
    if (targets.length) {
      store.upsert('shifts', targets);
      store.append('history', [{ at: now, action: '承認依頼', facilityId: req.facilityId, shiftId: '', date: '', staffName: '', before: '', after: targets.length + '件', by: editor, note: String(req.message || '').slice(0, 200) }]);
    }
    return { updated: targets, now: now };
  });
}

/** 承認印：承認待ち（・変更中）→ 確定。園長・主任・本部のみ */
function api_approve(req) {
  req = req || {};
  return withLock_(function () {
    var store = getStore_();
    var m = loadMasters_(store);
    var acc = requireApprover_(req, m, req.facilityId);
    var now = Shared.nowJST();
    var ids = {};
    (req.ids || []).forEach(function (id) { ids[id] = true; });
    var updated = [], deleted = [];
    store.list('shifts').forEach(function (s) {
      if (s.facilityId !== req.facilityId || !ids[s.id] || s.status === Shared.STATUS.FIXED) return;
      if (!s.type && !Shared.hasTimes(s)) { deleted.push(s.id); return; }
      s.status = Shared.STATUS.FIXED; s.approver = acc.name; s.approvedAt = now; s.prevFixed = '';
      updated.push(s);
    });
    if (updated.length) store.upsert('shifts', updated);
    if (deleted.length) store.remove('shifts', deleted);
    if (updated.length || deleted.length) {
      store.append('history', [{ at: now, action: '承認（確定）', facilityId: req.facilityId, shiftId: '', date: '', staffName: '', before: '', after: (updated.length + deleted.length) + '件', by: acc.name, note: '' }]);
    }
    return { updated: updated, deleted: deleted, approver: acc.name, now: now };
  });
}

/** 差戻し：承認待ち → 変更中（理由を備考に追記）。園長・主任・本部のみ */
function api_sendBack(req) {
  req = req || {};
  return withLock_(function () {
    var store = getStore_();
    var m = loadMasters_(store);
    var acc = requireApprover_(req, m, req.facilityId);
    var now = Shared.nowJST();
    var ids = {};
    (req.ids || []).forEach(function (id) { ids[id] = true; });
    var reason = String(req.reason || '').slice(0, 100);
    var updated = store.list('shifts').filter(function (s) {
      return s.facilityId === req.facilityId && ids[s.id] && s.status === Shared.STATUS.PENDING;
    });
    updated.forEach(function (s) {
      s.status = Shared.STATUS.DRAFT; s.editedAt = now;
      s.note = ('【差戻し】' + (reason || '内容を確認してください') + (s.note ? ' / ' + s.note : '')).slice(0, 200);
    });
    if (updated.length) {
      store.upsert('shifts', updated);
      store.append('history', [{ at: now, action: '差戻し', facilityId: req.facilityId, shiftId: '', date: '', staffName: '', before: '', after: updated.length + '件', by: acc.name, note: reason }]);
    }
    return { updated: updated, now: now };
  });
}

/** 変更履歴（新しい順） */
function api_history(req) {
  req = req || {};
  var list = getStore_().list('history').filter(function (h) { return !req.facilityId || h.facilityId === req.facilityId; });
  return list.slice(-Math.min(Number(req.limit) || 100, 300)).reverse();
}

/** 本部画面：園ごとの充足状況・不足箇所・承認状況・勤務時間 */
function api_hqSummary(req) {
  req = req || {};
  if (!validDate_(req.from) || !validDate_(req.to)) throw new Error('期間の指定が正しくありません。');
  var store = getStore_();
  var m = loadMasters_(store);
  var st = settingsOf_(m);
  var u = currentUser_(req.token, m);
  if (Shared.bool(st.hqLoginRequired, false) && !(u && u.acc.role === '本部')) {
    throw new Error('LOGIN_REQUIRED: 本部画面を見るには本部アカウントでログインしてください。');
  }
  var shifts = store.list('shifts').filter(function (s) { return s.date >= req.from && s.date <= req.to; });
  return buildHqSummary_(m, shifts, req.from, req.to);
}

function buildHqSummary_(m, shifts, from, to) {
  var detail = from === to;
  var facilities = m.facilities.map(function (f) {
    var ctx = Shared.buildContext(m, f.id);
    var mine = shifts.filter(function (s) { return s.facilityId === f.id; });
    var days = Shared.evaluateRange(ctx, from, to, mine);
    var counts = { ok: 0, warn: 0, short: 0 };
    var issues = [];
    var dayList = days.map(function (d) {
      counts.ok += d.counts.ok; counts.warn += d.counts.warn; counts.short += d.counts.short;
      d.issues.forEach(function (x) { issues.push(x); });
      var out = { date: d.date, closed: d.closed, worst: d.worst, shortMin: d.shortMin, warnMin: d.warnMin,
        shortCount: d.issues.filter(function (x) { return x.status === 'short'; }).length,
        warnCount: d.issues.filter(function (x) { return x.status === 'warn'; }).length,
        rows: d.rows.map(function (r) { return { key: r.key, label: r.label, worst: r.worst, shortMin: r.shortMin, warnMin: r.warnMin }; }) };
      if (detail) {
        out.times = d.times;
        out.matrix = d.rows.map(function (r) {
          return { key: r.key, label: r.label, color: r.color || '', cells: r.cells.map(function (c) { return [c.st, c.req, c.n, c.q, c.kids]; }) };
        });
      }
      return out;
    });
    var sum = Shared.staffSummary(ctx, mine);
    var workMin = 0, workDays = 0, satDays = 0, paid = 0, warnings = 0;
    sum.forEach(function (r) { workMin += r.workMin; workDays += r.days; satDays += r.satDays; paid += r.paid; warnings += r.warnings; });
    var total = counts.ok + counts.warn + counts.short;
    return {
      id: f.id, name: f.name, kind: f.kind,
      classes: ctx.classes.map(function (c) { return { id: c.id, name: c.name, color: c.color }; }),
      staffCount: ctx.staff.length,
      rate: total ? counts.ok / total : null,
      counts: counts,
      issueCount: { short: issues.filter(function (x) { return x.status === 'short'; }).length, warn: issues.filter(function (x) { return x.status === 'warn'; }).length },
      issues: issues.slice(0, 400),
      days: dayList,
      approval: Shared.statusCounts(mine),
      hours: { workMin: workMin, workDays: workDays, satDays: satDays, paid: paid, laborWarnings: warnings }
    };
  });
  return { from: from, to: to, facilities: facilities, now: Shared.nowJST() };
}

/** 月次集計シートを作成（労務・給与用） */
function api_exportMonthly(req) {
  req = req || {};
  var ym = String(req.ym || Shared.todayJST().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('年月の指定が正しくありません。');
  var from = ym + '-01', to = Shared.monthEnd(from);
  var store = getStore_();
  var m = loadMasters_(store);
  var shifts = store.list('shifts').filter(function (s) { return s.date >= from && s.date <= to; });
  var rows = [];
  m.facilities.forEach(function (f) {
    if (req.facilityId && f.id !== req.facilityId) return;
    var ctx = Shared.buildContext(m, f.id);
    Shared.staffSummary(ctx, shifts.filter(function (s) { return s.facilityId === f.id; })).forEach(function (r) {
      rows.push({ ym: ym, facilityId: f.id, facilityName: f.name, staffId: r.staffId, name: r.name, job: r.job, employment: r.employment,
        days: r.days, satDays: r.satDays, off: r.off, paid: r.paid, train: r.train,
        spanH: Shared.round2(r.spanMin / 60), workH: Shared.round2(r.workMin / 60), fixedWorkH: Shared.round2(r.fixedWorkMin / 60),
        unfixed: r.unfixed, warnings: r.warnings });
    });
  });
  var res = store.writeMonthly(ym, rows);
  return { sheetName: res.sheetName, url: res.url, rows: rows.length };
}
