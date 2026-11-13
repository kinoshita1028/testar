// GAS のサーバー側（Code.gs / Store.gs）を、擬似的なスプレッドシートで動かして確認する
// 使い方: TZ=Asia/Tokyo node tools/gas-sim.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pad = (n) => String(n).padStart(2, '0');

// ---- 擬似スプレッドシート（文字列の日付・時刻を、書式が「@」でなければ Date に変換する点も再現） ----
class Range {
  constructor(sh, r, c, nr = 1, nc = 1) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.get(this.r + i, this.c + j)); out.push(row); } return out; }
  setValues(v) {
    assert.equal(v.length, this.nr, 'setValues rows'); v.forEach((row) => assert.equal(row.length, this.nc, 'setValues cols'));
    v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x))); return this;
  }
  setValue(x) { this.sh.set(this.r, this.c, x); return this; }
  setNumberFormats(f) { assert.equal(f.length, this.nr); f.forEach((row, i) => row.forEach((x, j) => this.sh.fmt.set(`${this.r + i}:${this.c + j}`, x))); return this; }
  setNumberFormat(x) { for (let i = 0; i < Math.min(this.nr, 3000); i++) for (let j = 0; j < this.nc; j++) this.sh.fmt.set(`${this.r + i}:${this.c + j}`, x); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, ''); return this; }
  createFilter() { this.sh.filter = { remove: () => { this.sh.filter = null; } }; return this.sh.filter; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; } setWrap() { return this; } setVerticalAlignment() { return this; }
}
let sheetSeq = 1;
class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.fmt = new Map(); this.id = sheetSeq++; this.filter = null; }
  get(r, c) { const row = this.rows[r - 1]; const v = row ? row[c - 1] : undefined; return v === undefined ? '' : v; }
  set(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const f = this.fmt.get(`${r}:${c}`);
    if (typeof v === 'string' && f !== '@') {
      let m;
      if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) v = new Date(+m[1], +m[2] - 1, +m[3]);
      else if ((m = /^(\d{1,2}):(\d{2})$/.exec(v))) v = new Date(1899, 11, 30, +m[1], +m[2]);
    }
    this.rows[r - 1][c - 1] = v;
  }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getLastRow() { for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some((x) => x !== '' && x !== undefined)) return i; return 0; }
  getLastColumn() { let m = 0; this.rows.forEach((r) => r.forEach((x, j) => { if (x !== '' && x !== undefined) m = Math.max(m, j + 1); })); return m; }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  clear() { this.rows = []; this.fmt = new Map(); }
  setFrozenRows() {} setRowHeight() {}
  getFilter() { return this.filter; }
  getSheetId() { return this.id; }
}
class Spreadsheet {
  constructor() { this.sheets = [new Sheet('シート1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/FAKE/edit'; }
  getId() { return 'FAKE'; }
  getSpreadsheetTimeZone() { return 'Asia/Tokyo'; }
  setActiveSheet(s) { this.active = s; return s; }
  moveActiveSheet(i) { this.sheets = this.sheets.filter((s) => s !== this.active); this.sheets.splice(i - 1, 0, this.active); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

const ss = new Spreadsheet();
const props = new Map(), cache = new Map();
let activeEmail = '';
const ctx = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, create: () => ss, getUi: () => { throw new Error('no ui'); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
  CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, String(v)), remove: (k) => cache.delete(k) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Session: { getActiveUser: () => ({ getEmail: () => activeEmail }) },
  Logger: { log: (...a) => console.log('  [Logger]', ...a) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, tz, f) => f.replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
      .replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes())).replace('ss', pad(d.getSeconds()))
  },
  HtmlService: {}
};
vm.createContext(ctx);
for (const f of ['Shared.gs', 'Code.gs', 'Store.gs']) vm.runInContext(fs.readFileSync(path.join(root, 'gas', f), 'utf8'), ctx, { filename: f });
const run = (code) => vm.runInContext(code, ctx);
const call = (fn, req) => JSON.parse(JSON.stringify(ctx[fn](req)));

let t = Date.now();
run('setup()');
console.log('setup ms', Date.now() - t, 'sheets:', ss.sheets.map((s) => s.name).join(','));
const shiftSheet = ss.getSheetByName('勤務データ');
console.log('勤務データ rows', shiftSheet.getLastRow() - 1);
assert.ok(shiftSheet.getLastRow() > 3000);
// 日付・時刻が文字列のまま保存されていること
assert.equal(typeof shiftSheet.get(2, 4), 'string', '日付は文字列で保存');
assert.match(shiftSheet.get(2, 4), /^\d{4}-\d{2}-\d{2}$/);

// 2回目の setup はデータを消さない
const before = shiftSheet.getLastRow();
run('STORE_ = null; setup()');
assert.equal(shiftSheet.getLastRow(), before, 'setup は既存データを保持');

run('STORE_ = null');
const boot = call('api_bootstrap', {});
assert.equal(boot.facilities.length, 3);
assert.ok(boot.accounts.find((a) => a.id === 'e01-head').demoPin === '1111');
console.log('bootstrap ok: staff', boot.staff.length, 'today', boot.today);

const today = boot.today;
const from = today.slice(0, 8) + '01';
const to = run(`Shared.monthEnd('${today}')`);
const shifts = call('api_getShifts', { facilityId: 'E01', from, to }).shifts;
console.log('E01 shifts this month', shifts.length);
assert.ok(shifts.length > 400);
assert.match(shifts[0].start || '07:00', /^\d{2}:\d{2}$/);
// 手入力で時刻セルが Date になっていても読めること（シートで直接編集された場合）
{
  const d = shiftSheet; const hdr = d.rows[0]; const ci = hdr.indexOf('出勤') + 1;
  d.fmt.set(`5:${ci}`, 'General'); d.set(5, ci, '08:45');
  assert.ok(d.get(5, ci) instanceof Date);
  run('STORE_ = null');
  const id = d.get(5, 1);
  const all = call('api_getShifts', { facilityId: d.get(5, 2), from: '2000-01-01', to: '2100-01-01' }).shifts;
  assert.equal(all.find((s) => s.id === id).start, '08:45', 'Date の時刻を HH:mm で読む');
}

// 保存（新規・変更・競合）
const target = shifts.find((s) => s.status === '確定' && s.kind === '勤務' && s.date > today);
const res1 = call('api_saveShifts', { editor: '田中 結衣', facilityId: 'E01', items: [{ staffId: target.staffId, date: target.date, type: '遅番', kind: '勤務', start: '10:15', end: '19:00', breakMin: 45, breakStart: '13:30', classId: target.classId, segments: '', note: 'テスト', base: target.editedAt }] });
assert.equal(res1.saved.length, 1); assert.equal(res1.saved[0].status, '変更中');
assert.ok(res1.saved[0].prevFixed.includes(target.start), '変更前（確定）を記録');
assert.equal(res1.saved[0].workH, 8);
const conflict = call('api_saveShifts', { editor: '他の人', facilityId: 'E01', items: [{ staffId: target.staffId, date: target.date, type: '早番', start: '07:00', end: '15:45', breakMin: 45, base: target.editedAt }] });
assert.equal(conflict.conflicts.length, 1, '古い base は競合');
// 不正な時刻はエラー
assert.throws(() => ctx.api_saveShifts({ editor: 'x', facilityId: 'E01', items: [{ staffId: target.staffId, date: target.date, type: '日勤', kind: '勤務', start: '17:00', end: '09:00' }] }), /退勤/);

// 承認依頼 → 承認（権限チェック）
const rq = call('api_requestApproval', { editor: '田中 結衣', facilityId: 'E01', ids: [res1.saved[0].id] });
assert.equal(rq.updated[0].status, '承認待ち');
assert.throws(() => ctx.api_approve({ facilityId: 'E01', ids: [res1.saved[0].id] }), /LOGIN_REQUIRED/);
assert.throws(() => ctx.api_login({ accountId: 'e01-head', pin: '9999' }), /違います/);
const lg = call('api_login', { accountId: 'e01-head', pin: '1111' });
assert.throws(() => ctx.api_approve({ token: lg.token, facilityId: 'E02', ids: [] }), /権限/);
const ap = call('api_approve', { token: lg.token, facilityId: 'E01', ids: [res1.saved[0].id] });
assert.equal(ap.updated[0].status, '確定'); assert.equal(ap.updated[0].prevFixed, '');
console.log('approve ok by', ap.approver);

// 確定済みの削除は「削除予定」→ 承認で行が消える
const del = call('api_saveShifts', { editor: 'x', facilityId: 'E01', items: [{ staffId: target.staffId, date: target.date, clear: true }] });
assert.equal(del.saved[0].type, ''); assert.equal(del.saved[0].status, '変更中');
const rowsBefore = shiftSheet.getLastRow();
const ap2 = call('api_approve', { token: lg.token, facilityId: 'E01', ids: [del.saved[0].id] });
assert.deepEqual(ap2.deleted, [del.saved[0].id]);
assert.equal(shiftSheet.getLastRow(), rowsBefore - 1);
// 新規入力
const add = call('api_saveShifts', { editor: 'x', facilityId: 'E01', items: [{ staffId: target.staffId, date: target.date, type: '有休', kind: '有休', base: '' }] });
assert.equal(add.saved[0].kind, '有休'); assert.equal(add.saved[0].start, '');
// 差戻し
call('api_requestApproval', { editor: 'x', facilityId: 'E01', ids: [add.saved[0].id] });
const sb = call('api_sendBack', { token: lg.token, facilityId: 'E01', ids: [add.saved[0].id], reason: '人数を確認' });
assert.equal(sb.updated[0].status, '変更中'); assert.match(sb.updated[0].note, /差戻し/);

// メールでの自動ログイン
run(`STORE_ = null`);
const accSheet = ss.getSheetByName('アカウント');
const mailCol = accSheet.rows[0].indexOf('Googleアカウントのメール（任意）') + 1;
accSheet.set(2, mailCol, 'hq@example.com');
activeEmail = 'hq@example.com';
const boot2 = call('api_bootstrap', {});
assert.equal(boot2.user.role, '本部'); assert.ok(boot2.token);
activeEmail = '';

// 本部
t = Date.now();
const hq = call('api_hqSummary', { from, to });
console.log('hqSummary ms', Date.now() - t);
hq.facilities.forEach((f) => console.log(`  ${f.name}: 充足率 ${(f.rate * 100).toFixed(1)}% 不足 ${f.issueCount.short} 要確認 ${f.issueCount.warn} 実働 ${(f.hours.workMin / 60).toFixed(1)}h 承認 ${JSON.stringify(f.approval)}`));
const hqDay = call('api_hqSummary', { from: today, to: today });
assert.ok(hqDay.facilities[0].days[0].matrix || hqDay.facilities[0].days[0].closed);

// 月次集計
run(`STORE_ = null`);
const ex = call('api_exportMonthly', { ym: today.slice(0, 7) });
console.log('export', ex.sheetName, ex.rows, 'rows');
const mon = ss.getSheetByName('月次集計');
assert.equal(mon.get(1, 1), '年月'); assert.ok(mon.getLastRow() > 50);

// 履歴
const hist = call('api_history', { facilityId: 'E01' });
assert.ok(hist.length >= 5);
console.log('history', hist.slice(0, 3).map((h) => h.action).join(' / '));

// デモデータの作り直し
run(`STORE_ = null; resetDemoData()`);
assert.ok(ss.getSheetByName('勤務データ').getLastRow() > 3000);
console.log('\nALL SERVER CHECKS PASSED');
