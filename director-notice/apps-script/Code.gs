/**
 * 重要通知ポップアップ - 本部側（Googleスプレッドシート + Apps Script）
 *
 * このスクリプトは「通知管理スプレッドシート」に紐づけて使います。
 *   - シート「通知」       : 本部が通知内容・対象・スケジュールを入力する
 *   - シート「宛先マスタ」 : 先生のメールアドレスと所属園の対応表
 *   - シート「確認ログ」   : 先生が「確認しました」を押した記録（自動追記）
 * Chrome拡張機能は、このスクリプトのウェブアプリURLへ定期的に問い合わせます。
 */

const SHEET_NOTICE = '通知';
const SHEET_MEMBER = '宛先マスタ';
const SHEET_LOG = '確認ログ';
const CACHE_KEY = 'notice-data-v1';
const CACHE_SECONDS = 60;

const NOTICE_HEADERS = [
  'ID', '有効', 'タイトル', '本文', 'リンクURL', '対象種別', '対象',
  '開始日時', '終了日時', '繰り返し単位', '繰り返し間隔', '曜日指定',
  '未確認時の再表示(分)', 'メモ',
];
const NOTICE_NOTES = [
  '自動で採番されます。編集しないでください。',
  'チェックを入れた行だけ配信されます。',
  'ポップアップの見出し（必須）',
  'ポップアップの本文。セル内改行（Alt+Enter）可。',
  '任意。「詳細を開く」ボタンのリンク先（https://〜）',
  '全園 / 園別 / 個人別',
  '園別: 園名をカンマ区切り（宛先マスタの園名と一致させる）\n個人別: メールアドレスをカンマ区切り\n全園: 空欄でOK',
  '最初に表示する日時（必須）。例: 2026/04/01 09:00',
  '任意。この日時を過ぎると表示しません。\n空欄の場合: 繰り返しなし→開始から7日間有効 / 繰り返しあり→無期限',
  '繰り返しなし / 分 / 時間 / 日 / 週 / 月',
  '繰り返し単位と組み合わせます。例: 単位「日」・間隔「1」＝毎日、単位「分」・間隔「30」＝30分ごと',
  '任意。表示する曜日をカンマ区切り。例: 月,火,水,木,金（空欄＝毎日対象）',
  '任意。「確認しました」を押さずに閉じた場合、この分数後にもう一度表示します。',
  '本部用のメモ（先生には表示されません）',
];
const TARGET_TYPES = ['全園', '園別', '個人別'];
const UNIT_MAP = { '繰り返しなし': 'none', '分': 'minute', '時間': 'hour', '日': 'day', '週': 'week', '月': 'month' };
const WEEKDAY_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

// ---------------------------------------------------------------------------
// メニュー・初期セットアップ
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('通知管理')
    .addItem('初期セットアップ（シート作成）', 'setup')
    .addItem('配布用の設定（ポリシーJSON）を表示', 'showPolicyJson')
    .addSeparator()
    .addItem('APIキーを再発行', 'regenerateApiKey')
    .addToUi();
}

/** シート・見出し・入力規則を作成する。何度実行しても既存データは消えません。 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Tokyo');

  const notice = getOrCreateSheet_(ss, SHEET_NOTICE, NOTICE_HEADERS);
  notice.getRange(1, 1, 1, NOTICE_HEADERS.length).setNotes([NOTICE_NOTES]);
  const rows = Math.max(notice.getMaxRows() - 1, 1);
  notice.getRange(2, 2, rows, 1).insertCheckboxes();
  notice.getRange(2, 6, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(TARGET_TYPES, true).setAllowInvalid(false).build());
  notice.getRange(2, 8, rows, 2)
    .setNumberFormat('yyyy/MM/dd HH:mm')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  notice.getRange(2, 10, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(UNIT_MAP), true).setAllowInvalid(false).build());
  notice.getRange(2, 11, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false).build());
  notice.getRange(2, 13, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false).build());
  notice.getRange(2, 4, rows, 1).setWrap(true);
  notice.setColumnWidth(3, 220).setColumnWidth(4, 360).setColumnWidth(7, 240);
  notice.getRange(1, 1, notice.getMaxRows(), 1).setFontColor('#888888');

  const member = getOrCreateSheet_(ss, SHEET_MEMBER, ['メールアドレス', '氏名', '園名']);
  member.getRange(1, 3).setNote('複数の園を兼務する場合はカンマ区切り。例: ひまわり保育園,さくら保育園');
  member.setColumnWidth(1, 260).setColumnWidth(3, 260);

  const log = getOrCreateSheet_(ss, SHEET_LOG, ['確認日時', '通知ID', 'タイトル', 'メールアドレス', '氏名', '園名', '表示予定日時']);
  log.getRange('A:A').setNumberFormat('yyyy/MM/dd HH:mm:ss');
  log.getRange('G:G').setNumberFormat('yyyy/MM/dd HH:mm');

  getApiKey_();
  SpreadsheetApp.getUi().alert(
    'セットアップが完了しました。\n\n' +
    '次に、Apps Script エディタの「デプロイ」→「新しいデプロイ」でウェブアプリとして公開し、\n' +
    'メニュー「通知管理」→「配布用の設定（ポリシーJSON）を表示」を開いてください。');
}

function getOrCreateSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setFrozenRows(1);
  return sheet;
}

function getApiKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_KEY', key);
  }
  return key;
}

function regenerateApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('APIキーを再発行します',
    '再発行すると、管理コンソールのポリシーJSONを新しいキーに更新するまで通知が届かなくなります。続行しますか？',
    ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  getApiKey_();
  showPolicyJson();
}

/** Google管理コンソールの「拡張機能のポリシー」に貼り付けるJSONを表示する。 */
function showPolicyJson() {
  const url = ScriptApp.getService().getUrl();
  const policy = {
    apiUrl: { Value: url || '（ウェブアプリのURLをここに貼り付け）' },
    apiKey: { Value: getApiKey_() },
  };
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:13px">' +
    '<p>Google管理コンソール → Chrome → アプリと拡張機能 → 対象の拡張機能 →' +
    '「拡張機能のポリシー」に、下のJSONをそのまま貼り付けてください。</p>' +
    '<textarea style="width:100%;height:150px;font-family:monospace" readonly onclick="this.select()">' +
    escapeHtml_(JSON.stringify(policy, null, 2)) + '</textarea>' +
    (url ? '' : '<p style="color:#c00">ウェブアプリがまだデプロイされていません。デプロイ後にもう一度開いてください。</p>') +
    '<p style="color:#666">apiUrl が「/exec」で終わるURL（デプロイ画面に表示されるウェブアプリURL）であることを確認してください。</p>' +
    '</div>').setWidth(560).setHeight(330);
  SpreadsheetApp.getUi().showModalDialog(html, '配布用の設定（ポリシーJSON）');
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 通知シートが編集されたら、IDの自動採番とキャッシュの破棄を行う。 */
function onEdit(e) {
  const sheet = e && e.range && e.range.getSheet();
  if (!sheet) return;
  const name = sheet.getName();
  if (name !== SHEET_NOTICE && name !== SHEET_MEMBER) return;
  if (name === SHEET_NOTICE) assignIds_(sheet);
  CacheService.getScriptCache().remove(CACHE_KEY);
}

function assignIds_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const range = sheet.getRange(2, 1, last - 1, 3);
  const values = range.getValues();
  values.forEach(function (row, i) {
    if (!row[0] && String(row[2]).trim()) {
      sheet.getRange(i + 2, 1).setValue('N' + Utilities.getUuid().slice(0, 8));
    }
  });
}

// ---------------------------------------------------------------------------
// ウェブアプリ（Chrome拡張機能からの問い合わせ窓口）
// ---------------------------------------------------------------------------

function doGet(e) {
  return respond_(function () {
    const p = (e && e.parameter) || {};
    checkKey_(p.key);
    const email = resolveEmail_(p.email);
    const data = loadData_();
    const user = findUser_(data.members, email);
    const now = Date.now();
    const notices = data.notices.filter(function (n) {
      return !(n.endAt && n.endAt < now) && isTarget_(n, user);
    }).map(function (n) {
      return {
        id: n.id, title: n.title, body: n.body, url: n.url,
        startAt: n.startAt, endAt: n.endAt, unit: n.unit, interval: n.interval,
        weekdays: n.weekdays, remindMin: n.remindMin,
      };
    });
    return { ok: true, serverTime: now, user: user, notices: notices };
  });
}

function doPost(e) {
  return respond_(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    if (body.action !== 'ack') throw new Error('unknown action');
    const email = resolveEmail_(body.email);
    const data = loadData_();
    const user = findUser_(data.members, email);
    const notice = data.notices.filter(function (n) { return n.id === body.id; })[0];
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG).appendRow([
        new Date(), String(body.id || ''), notice ? notice.title : '',
        user.email, user.name, user.schools.join(','),
        body.occurrence ? new Date(Number(body.occurrence)) : '',
      ]);
    } finally {
      lock.releaseLock();
    }
    return { ok: true };
  });
}

function respond_(fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  if (!key || key !== getApiKey_()) throw new Error('APIキーが正しくありません');
}

/**
 * 利用者のメールアドレスを決める。
 * 「組織内のユーザーのみ」でデプロイした場合はGoogleログイン中のアドレス（詐称不可）を優先し、
 * 「全員」でデプロイした場合は拡張機能が申告したChromeプロファイルのアドレスを使う。
 */
function resolveEmail_(claimed) {
  let active = '';
  try { active = Session.getActiveUser().getEmail(); } catch (err) { /* 取得不可 */ }
  const email = String(active || claimed || '').trim().toLowerCase();
  if (!email) throw new Error('メールアドレスを特定できません（ChromeにGoogleアカウントでログインしてください）');
  return email;
}

function findUser_(members, email) {
  const m = members[email];
  return { email: email, name: m ? m.name : '', schools: m ? m.schools : [] };
}

function isTarget_(n, user) {
  if (n.targetType === '全園') return true;
  if (n.targetType === '園別') {
    return user.schools.some(function (s) { return n.targets.indexOf(s) >= 0; });
  }
  if (n.targetType === '個人別') return n.targets.indexOf(user.email) >= 0;
  return false;
}

// ---------------------------------------------------------------------------
// シート読み込み
// ---------------------------------------------------------------------------

function loadData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = {
    notices: readNotices_(ss.getSheetByName(SHEET_NOTICE)),
    members: readMembers_(ss.getSheetByName(SHEET_MEMBER)),
  };
  try { cache.put(CACHE_KEY, JSON.stringify(data), CACHE_SECONDS); } catch (err) { /* 100KB超はキャッシュしない */ }
  return data;
}

function splitList_(v) {
  return String(v == null ? '' : v).split(/[,、，\n]/)
    .map(function (s) { return s.trim(); }).filter(String);
}

function toMillis_(v) {
  if (v instanceof Date) return v.getTime();
  if (!v) return null;
  const t = new Date(String(v).replace(/-/g, '/')).getTime();
  return isNaN(t) ? null : t;
}

function readNotices_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, NOTICE_HEADERS.length).getValues();
  const out = [];
  rows.forEach(function (r) {
    const id = String(r[0]).trim();
    const title = String(r[2]).trim();
    const startAt = toMillis_(r[7]);
    const targetType = String(r[5]).trim();
    if (!id || r[1] !== true || !title || !startAt || TARGET_TYPES.indexOf(targetType) < 0) return;
    const url = String(r[4]).trim();
    const unit = UNIT_MAP[String(r[9]).trim()] || 'none';
    out.push({
      id: id,
      title: title,
      body: String(r[3]),
      url: /^https?:\/\//i.test(url) ? url : '',
      targetType: targetType,
      targets: splitList_(r[6]).map(function (s) {
        return targetType === '個人別' ? s.toLowerCase() : s;
      }),
      startAt: startAt,
      endAt: toMillis_(r[8]),
      unit: unit,
      interval: Math.max(1, Math.floor(Number(r[10]) || 1)),
      weekdays: splitList_(r[11]).map(function (s) { return WEEKDAY_MAP[s.charAt(0)]; })
        .filter(function (d) { return d !== undefined; }),
      remindMin: Math.max(0, Math.floor(Number(r[12]) || 0)),
    });
  });
  return out;
}

function readMembers_(sheet) {
  const members = {};
  if (!sheet || sheet.getLastRow() < 2) return members;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function (r) {
    const email = String(r[0]).trim().toLowerCase();
    if (!email) return;
    members[email] = { name: String(r[1]).trim(), schools: splitList_(r[2]) };
  });
  return members;
}
