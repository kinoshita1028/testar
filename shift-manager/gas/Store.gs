/**
 * Store.gs — Googleスプレッドシートへの保存・読み込み、初期設定、メニュー
 *
 * シートは1行目が見出し（日本語）です。列の順番を入れ替えたり、右側に独自の列を
 * 足したりしても動くように、見出し名で列を探して読み書きします。
 */

var SCHEMA = {
  facilities: { sheet: '園', key: 'id', cols: [
    ['id', '園ID', 't'], ['name', '園名', 't'], ['kind', '種別', 't'], ['open', '開所', 'time'], ['close', '閉所', 'time'],
    ['satOpen', '土曜 開所', 'time'], ['satClose', '土曜 閉所', 'time'], ['classStart', 'クラス別保育 開始', 'time'], ['classEnd', 'クラス別保育 終了', 'time'],
    ['satClassCheck', '土曜もクラス別に判定', 'b'], ['breakExcluded', '休憩中は配置に数えない', 'b'], ['closedDates', '臨時休園日（yyyy-mm-dd をカンマ区切り）', 't'], ['order', '表示順', 'n']] },
  classes: { sheet: 'クラス', key: 'id', cols: [
    ['id', 'クラスID', 't'], ['facilityId', '園ID', 't'], ['name', 'クラス名', 't'], ['ages', '年齢', 't'],
    ['n0', '0歳児数', 'n'], ['n1', '1歳児数', 'n'], ['n2', '2歳児数', 'n'], ['n3', '3歳児数', 'n'], ['n4', '4歳児数', 'n'], ['n5', '5歳児数', 'n'],
    ['order', '表示順', 'n'], ['color', '色', 't']] },
  staff: { sheet: '職員', key: 'id', cols: [
    ['id', '職員ID', 't'], ['facilityId', '園ID', 't'], ['name', '氏名', 't'], ['job', '職種', 't'], ['license', '資格', 't'],
    ['qualified', '有資格として数える', 'b'], ['counted', '保育に従事（配置に数える）', 'b'], ['employment', '雇用形態', 't'],
    ['classId', '主担当クラスID', 't'], ['weeklyHours', '週所定時間', 'n'], ['order', '表示順', 'n'], ['active', '在籍', 'b']] },
  patterns: { sheet: '勤務区分', key: 'id', cols: [
    ['id', '区分ID', 't'], ['facilityId', '園ID（空欄=全園共通）', 't'], ['name', '勤務区分', 't'], ['short', '略称', 't'],
    ['start', '出勤', 'time'], ['end', '退勤', 'time'], ['breakMin', '休憩(分)', 'n'], ['kind', '種類（勤務/休み/有休/研修）', 't'],
    ['bg', '背景色', 't'], ['bar', '線の色', 't'], ['order', '表示順', 'n']] },
  rules: { sheet: '配置基準', key: 'age', cols: [
    ['age', '年齢', 'n'], ['label', '区分', 't'], ['perStaff', '職員1人あたりの子ども数', 'n'], ['basis', '根拠', 't'], ['note', '備考', 't']] },
  attendance: { sheet: '時間帯別在園率', key: null, cols: [
    ['facilityId', '園ID', 't'], ['dayType', '曜日区分（平日/土曜）', 't'], ['time', '時刻', 'time'], ['rate', '在園率(%)', 'n']] },
  settings: { sheet: '設定', key: 'key', cols: [['key', '項目', 't'], ['value', '値', 'any'], ['note', '説明', 't']] },
  accounts: { sheet: 'アカウント', key: 'id', cols: [
    ['id', 'アカウントID', 't'], ['name', '表示名', 't'], ['role', '権限（本部/園長/主任）', 't'], ['facilityId', '園ID（本部は空欄）', 't'],
    ['email', 'Googleアカウントのメール（任意）', 't'], ['pin', '暗証番号', 't']] },
  shifts: { sheet: '勤務データ', key: 'id', cols: [
    ['id', '勤務ID', 't'], ['facilityId', '園ID', 't'], ['facilityName', '園名', 't'], ['date', '日付', 'date'], ['dow', '曜日', 't'],
    ['staffId', '職員ID', 't'], ['staffName', '氏名', 't'], ['type', '勤務区分', 't'], ['kind', '種類', 't'],
    ['start', '出勤', 'time'], ['end', '退勤', 'time'], ['breakStart', '休憩開始', 'time'], ['breakMin', '休憩(分)', 'n'],
    ['spanH', '拘束時間(h)', 'h'], ['workH', '実働時間(h)', 'h'], ['classId', '配置クラスID', 't'], ['className', '配置クラス', 't'],
    ['segments', '時間帯別の配置（クラスID@開始-終了）', 't'], ['status', '状態', 't'], ['editor', '入力者', 't'], ['editedAt', '入力日時', 'dt'],
    ['approver', '承認者', 't'], ['approvedAt', '承認日時', 'dt'], ['prevFixed', '変更前（確定時の内容）', 't'], ['note', '備考', 't']] },
  history: { sheet: '変更履歴', key: null, cols: [
    ['at', '日時', 'dt'], ['action', '操作', 't'], ['facilityId', '園ID', 't'], ['shiftId', '勤務ID', 't'], ['date', '日付', 'date'],
    ['staffName', '氏名', 't'], ['before', '変更前', 't'], ['after', '変更後', 't'], ['by', '実行者', 't'], ['note', '備考', 't']] }
};
var MONTHLY_COLS = [
  ['ym', '年月', 't'], ['facilityId', '園ID', 't'], ['facilityName', '園名', 't'], ['staffId', '職員ID', 't'], ['name', '氏名', 't'],
  ['job', '職種', 't'], ['employment', '雇用形態', 't'], ['days', '出勤日数', 'n'], ['satDays', 'うち土曜', 'n'], ['off', '公休・振休', 'n'],
  ['paid', '有休', 'n'], ['train', '研修', 'n'], ['spanH', '拘束時間計(h)', 'h'], ['workH', '実働時間計(h)', 'h'], ['fixedWorkH', 'うち確定分(h)', 'h'],
  ['unfixed', '未確定の件数', 'n'], ['warnings', '休憩不足の件数', 'n']];
var SHEET_ORDER = ['勤務データ', '職員', 'クラス', '園', '勤務区分', '配置基準', '時間帯別在園率', 'アカウント', '設定', '変更履歴', '月次集計'];
var TZ = 'Asia/Tokyo';
var SHEET_TZ_ = '';

function getSpreadsheet_(createIfMissing) {
  var props = PropertiesService.getScriptProperties();
  var id = SPREADSHEET_ID || props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active) { props.setProperty('SPREADSHEET_ID', active.getId()); return active; }
  if (createIfMissing) {
    var ss = SpreadsheetApp.create('シフト管理データ');
    props.setProperty('SPREADSHEET_ID', ss.getId());
    return ss;
  }
  throw new Error('保存先のスプレッドシートが設定されていません。Apps Script エディタで setup を実行してください。');
}

var STORE_ = null;
function getStore_() {
  if (!STORE_) STORE_ = new SheetStore_(getSpreadsheet_(false));
  return STORE_;
}

function SheetStore_(ss) {
  this.ss = ss; this.cache = {};
  try { SHEET_TZ_ = ss.getSpreadsheetTimeZone() || TZ; } catch (e) { SHEET_TZ_ = TZ; }
}

SheetStore_.prototype.url = function () { return this.ss.getUrl(); };

SheetStore_.prototype.sheet_ = function (table) {
  var sc = SCHEMA[table];
  var sh = this.ss.getSheetByName(sc.sheet);
  if (!sh) throw new Error('シート「' + sc.sheet + '」がありません。Apps Script エディタで setup を実行してください。');
  return sh;
};

function fmtCell_(v, type) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    // シートで直接入力され、日付・時刻に自動変換されたセルも文字列に戻す
    var tz = SHEET_TZ_ || TZ;
    if (type === 'time') return Utilities.formatDate(v, tz, 'HH:mm');
    if (type === 'date') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (type === 'dt') return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
  }
  if (type === 'time' && typeof v === 'number') {
    var mins = Math.round(v * 1440) % 1440;
    return Shared.fromMin(mins);
  }
  if (type === 'n' || type === 'h') return v === '' ? '' : Number(v);
  if (type === 'b') return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '○' || v === 'はい';
  if (type === 'time') return v === '' ? '' : Shared.fromMin(Shared.toMin(String(v))) || String(v);
  if (type === 'any') return v;
  return String(v).trim();
}
function numberFormat_(type) {
  if (type === 'n') return '0';
  if (type === 'h') return '0.00';
  if (type === 'b' || type === 'any') return 'General';
  return '@';
}

SheetStore_.prototype.read_ = function (table) {
  if (this.cache[table]) return this.cache[table];
  var sh = this.sheet_(table), sc = SCHEMA[table] || { cols: [] };
  var lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
  var values = lastRow ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
  var header = values[0].map(function (h) { return String(h).trim(); });
  var idx = {};
  sc.cols.forEach(function (c) { idx[c[0]] = header.indexOf(c[1]); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    var empty = true;
    for (var i = 0; i < v.length; i++) if (v[i] !== '' && v[i] !== null) { empty = false; break; }
    if (empty) continue;
    var o = { _row: r + 1, _raw: v };
    sc.cols.forEach(function (c) { var j = idx[c[0]]; o[c[0]] = j < 0 ? '' : fmtCell_(v[j], c[2]); });
    rows.push(o);
  }
  var data = { sh: sh, header: header, idx: idx, rows: rows, lastRow: lastRow, lastCol: lastCol, cols: sc.cols };
  this.cache[table] = data;
  return data;
};

SheetStore_.prototype.list = function (table) {
  return this.read_(table).rows.map(function (r) {
    var o = {};
    for (var k in r) if (k !== '_row' && k !== '_raw') o[k] = r[k];
    return o;
  });
};
SheetStore_.prototype.count = function (table) { return this.read_(table).rows.length; };

SheetStore_.prototype.toRow_ = function (d, obj, base) {
  var row = base ? base.slice() : [];
  while (row.length < d.header.length) row.push('');
  d.cols.forEach(function (c) {
    var j = d.idx[c[0]];
    if (j < 0) return;
    var v = obj[c[0]];
    if (v === undefined || v === null) v = '';
    if (c[2] === 'b') v = v === true || v === 'TRUE' || v === 'true';
    row[j] = v;
  });
  return row;
};
SheetStore_.prototype.formats_ = function (d, n) {
  var f = d.header.map(function () { return 'General'; });
  d.cols.forEach(function (c) { var j = d.idx[c[0]]; if (j >= 0) f[j] = numberFormat_(c[2]); });
  var out = [];
  for (var i = 0; i < n; i++) out.push(f);
  return out;
};

/** キーが同じ行は上書き、無ければ末尾に追加 */
SheetStore_.prototype.upsert = function (table, objs) {
  if (!objs.length) return;
  delete this.cache[table];
  var d = this.read_(table), key = SCHEMA[table].key, self = this;
  var map = {};
  d.rows.forEach(function (r) { map[r[key]] = r; });
  var updates = [], appends = [];
  objs.forEach(function (o) {
    var ex = map[o[key]];
    if (ex) { var row = self.toRow_(d, o, ex._raw); ex._raw = row; updates.push({ r: ex._row, row: row }); }
    else appends.push(self.toRow_(d, o, null));
  });
  var width = d.header.length;
  if (updates.length > 25) {
    // まとめて書き換え（変更のあった範囲だけ）
    var minR = Infinity, maxR = 0;
    updates.forEach(function (u) { minR = Math.min(minR, u.r); maxR = Math.max(maxR, u.r); });
    var block = d.sh.getRange(minR, 1, maxR - minR + 1, width).getValues();
    updates.forEach(function (u) { block[u.r - minR] = u.row.slice(0, width); });
    d.sh.getRange(minR, 1, block.length, width).setValues(block);
  } else {
    updates.forEach(function (u) { d.sh.getRange(u.r, 1, 1, width).setValues([u.row.slice(0, width)]); });
  }
  if (appends.length) {
    var rng = d.sh.getRange(d.lastRow + 1, 1, appends.length, width);
    rng.setNumberFormats(this.formats_(d, appends.length));
    rng.setValues(appends.map(function (r) { return r.slice(0, width); }));
  }
  delete this.cache[table];
};

SheetStore_.prototype.append = function (table, objs) {
  if (!objs.length) return;
  delete this.cache[table];
  var d = this.read_(table), self = this, width = d.header.length;
  var rows = objs.map(function (o) { return self.toRow_(d, o, null).slice(0, width); });
  var rng = d.sh.getRange(d.lastRow + 1, 1, rows.length, width);
  rng.setNumberFormats(this.formats_(d, rows.length));
  rng.setValues(rows);
  delete this.cache[table];
};

SheetStore_.prototype.remove = function (table, keys) {
  if (!keys.length) return;
  delete this.cache[table];
  var d = this.read_(table), key = SCHEMA[table].key;
  var set = {};
  keys.forEach(function (k) { set[k] = true; });
  d.rows.filter(function (r) { return set[r[key]]; })
    .map(function (r) { return r._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (r) { d.sh.deleteRow(r); });
  delete this.cache[table];
};

/** データ行をすべて置き換える（初期設定・デモデータ作成用） */
SheetStore_.prototype.replaceAll = function (table, objs) {
  delete this.cache[table];
  var d = this.read_(table), self = this, width = d.header.length;
  if (d.lastRow > 1) d.sh.getRange(2, 1, d.lastRow - 1, Math.max(d.lastCol, width)).clearContent();
  if (objs.length) {
    var rows = objs.map(function (o) { return self.toRow_(d, o, null).slice(0, width); });
    var rng = d.sh.getRange(2, 1, rows.length, width);
    rng.setNumberFormats(this.formats_(d, rows.length));
    rng.setValues(rows);
  }
  delete this.cache[table];
};

/** 月次集計シート（毎回作り直し） */
SheetStore_.prototype.writeMonthly = function (ym, rows) {
  var name = '月次集計';
  var sh = this.ss.getSheetByName(name) || this.ss.insertSheet(name);
  sh.clear();
  var header = MONTHLY_COLS.map(function (c) { return c[1]; });
  var values = [header].concat(rows.map(function (r) { return MONTHLY_COLS.map(function (c) { return r[c[0]] === undefined ? '' : r[c[0]]; }); }));
  var rng = sh.getRange(1, 1, values.length, header.length);
  var fmts = values.map(function (_, i) { return MONTHLY_COLS.map(function (c) { return i === 0 ? '@' : numberFormat_(c[2]); }); });
  rng.setNumberFormats(fmts);
  rng.setValues(values);
  styleHeader_(sh, header.length);
  sh.getRange(1, header.length + 2).setValue(ym + ' の集計（' + Shared.nowJST() + ' 作成）');
  if (sh.getFilter()) sh.getFilter().remove();
  if (values.length > 1) sh.getRange(1, 1, values.length, header.length).createFilter();
  return { sheetName: name, url: this.ss.getUrl() + '#gid=' + sh.getSheetId() };
};

function styleHeader_(sh, width) {
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#E7F1EC').setFontColor('#24493F').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);
}

function ensureSheet_(ss, table) {
  var sc = SCHEMA[table];
  var sh = ss.getSheetByName(sc.sheet);
  var header = sc.cols.map(function (c) { return c[1]; });
  if (!sh) {
    sh = ss.insertSheet(sc.sheet);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  } else {
    // 足りない見出しだけ右端に追加（既存の列・データは触らない）
    var last = Math.max(sh.getLastColumn(), 1);
    var cur = sh.getRange(1, 1, 1, last).getValues()[0].map(function (h) { return String(h).trim(); });
    var missing = header.filter(function (h) { return cur.indexOf(h) < 0; });
    if (cur.length === 1 && cur[0] === '') { sh.getRange(1, 1, 1, header.length).setValues([header]); }
    else if (missing.length) sh.getRange(1, last + 1, 1, missing.length).setValues([missing]);
  }
  styleHeader_(sh, Math.max(sh.getLastColumn(), header.length));
  // 列の書式（日付・時刻は文字列として保存し、自動変換を防ぐ）
  var cur2 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  sc.cols.forEach(function (c) {
    var j = cur2.indexOf(c[1]);
    if (j >= 0) sh.getRange(2, j + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat(numberFormat_(c[2]));
  });
  return sh;
}

// ------------------------------------------------------------------
// 初期設定・デモデータ
// ------------------------------------------------------------------

/**
 * 初めに1回実行してください（Apps Script エディタで関数「setup」を選んで ▶実行）。
 * - 足りないシートを作成します（既存のデータは消しません）
 * - マスタや勤務データが空のときだけ、デモ用のデータを入れます
 */
function setup() {
  var ss = getSpreadsheet_(true);
  STORE_ = new SheetStore_(ss);
  Object.keys(SCHEMA).forEach(function (t) { ensureSheet_(ss, t); });
  var demo = null;
  var getDemo = function () { return demo || (demo = Shared.Demo.build(Shared.todayJST())); };
  ['facilities', 'classes', 'staff', 'patterns', 'rules', 'attendance', 'settings', 'accounts'].forEach(function (t) {
    if (STORE_.count(t) === 0) STORE_.replaceAll(t, getDemo()[t]);
  });
  if (STORE_.count('shifts') === 0) {
    var m = loadMasters_(STORE_);
    STORE_.replaceAll('shifts', getDemo().shifts.map(function (s) { return decorateShift_(s, m); }));
  }
  arrangeSheets_(ss);
  Logger.log('準備ができました: ' + ss.getUrl());
  Logger.log('次に「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」で公開してください。');
}

/** デモデータを作り直す（勤務データ・マスタをすべてデモ内容で上書きします） */
function resetDemoData() {
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  if (ui) {
    var r = ui.alert('デモデータを作り直します', '勤務データと各マスタを、デモ用の内容で上書きします。よろしいですか？', ui.ButtonSet.OK_CANCEL);
    if (r !== ui.Button.OK) return;
  }
  var ss = getSpreadsheet_(true);
  STORE_ = new SheetStore_(ss);
  Object.keys(SCHEMA).forEach(function (t) { ensureSheet_(ss, t); });
  var demo = Shared.Demo.build(Shared.todayJST());
  ['facilities', 'classes', 'staff', 'patterns', 'rules', 'attendance', 'settings', 'accounts'].forEach(function (t) { STORE_.replaceAll(t, demo[t]); });
  var m = loadMasters_(STORE_);
  STORE_.replaceAll('shifts', demo.shifts.map(function (s) { return decorateShift_(s, m); }));
  STORE_.append('history', [{ at: Shared.nowJST(), action: 'デモデータ作成', facilityId: '', shiftId: '', date: '', staffName: '', before: '', after: demo.shifts.length + '件', by: 'システム', note: '' }]);
  arrangeSheets_(ss);
}

function arrangeSheets_(ss) {
  SHEET_ORDER.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  var def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  var first = ss.getSheetByName('勤務データ');
  if (first) ss.setActiveSheet(first);
}

/** スプレッドシートを開いたときのメニュー */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('シフト管理')
    .addItem('今月の月次集計を作成', 'menuExportThisMonth')
    .addItem('先月の月次集計を作成', 'menuExportLastMonth')
    .addSeparator()
    .addItem('初期設定（足りないシートを作成）', 'setup')
    .addItem('デモデータを作り直す', 'resetDemoData')
    .addToUi();
}
function menuExportThisMonth() { api_exportMonthly({ ym: Shared.todayJST().slice(0, 7) }); }
function menuExportLastMonth() { api_exportMonthly({ ym: Shared.addMonths(Shared.todayJST(), -1).slice(0, 7) }); }
