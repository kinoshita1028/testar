import test from 'node:test';
import assert from 'node:assert/strict';
import { latestOccurrence, occurrenceAt } from '../extension/schedule.js';

const at = (s) => new Date(s).getTime();
const base = { interval: 1, weekdays: [] };

test('開始前は表示しない', () => {
  assert.equal(latestOccurrence({ ...base, unit: 'none', startAt: at('2026-04-01T09:00') }, at('2026-04-01T08:59')), null);
});

test('単発: 開始後は開始時刻を返し、7日で失効', () => {
  const n = { ...base, unit: 'none', startAt: at('2026-04-01T09:00') };
  assert.equal(latestOccurrence(n, at('2026-04-03T12:00')), n.startAt);
  assert.equal(latestOccurrence(n, at('2026-04-08T09:01')), null);
});

test('単発: 終了日時があればそこまで有効', () => {
  const n = { ...base, unit: 'none', startAt: at('2026-04-01T09:00'), endAt: at('2026-05-01T00:00') };
  assert.equal(latestOccurrence(n, at('2026-04-20T00:00')), n.startAt);
  assert.equal(latestOccurrence(n, at('2026-05-01T00:01')), null);
});

test('30分ごと', () => {
  const n = { ...base, unit: 'minute', interval: 30, startAt: at('2026-04-01T09:00') };
  assert.equal(latestOccurrence(n, at('2026-04-01T10:29')), at('2026-04-01T10:00'));
  assert.equal(latestOccurrence(n, at('2026-04-01T10:30')), at('2026-04-01T10:30'));
});

test('毎日・2日おき', () => {
  const n = { ...base, unit: 'day', startAt: at('2026-04-01T09:00') };
  assert.equal(latestOccurrence(n, at('2026-04-10T08:59')), at('2026-04-09T09:00'));
  assert.equal(latestOccurrence({ ...n, interval: 2 }, at('2026-04-10T10:00')), at('2026-04-09T09:00'));
});

test('平日のみ: 土曜は金曜分が残る', () => {
  const n = { ...base, unit: 'day', weekdays: [1, 2, 3, 4, 5], startAt: at('2026-04-01T09:00') };
  assert.equal(latestOccurrence(n, at('2026-04-04T12:00')), at('2026-04-03T09:00')); // 4/4は土曜
  assert.equal(latestOccurrence(n, at('2026-04-06T09:00')), at('2026-04-06T09:00')); // 月曜
});

test('分単位＋曜日指定: 対象外の曜日は表示しない', () => {
  const n = { ...base, unit: 'minute', interval: 60, weekdays: [1], startAt: at('2026-04-01T09:00') };
  assert.equal(latestOccurrence(n, at('2026-04-04T12:30')), null);
  assert.equal(latestOccurrence(n, at('2026-04-06T12:30')), at('2026-04-06T12:00'));
});

test('毎週', () => {
  const n = { ...base, unit: 'week', startAt: at('2026-04-06T08:30') };
  assert.equal(latestOccurrence(n, at('2026-04-19T23:00')), at('2026-04-13T08:30'));
});

test('毎月: 31日開始は月末に寄せる・長期間でも正しい', () => {
  const n = { ...base, unit: 'month', startAt: at('2026-01-31T09:00') };
  assert.equal(occurrenceAt(n, 1), at('2026-02-28T09:00'));
  assert.equal(latestOccurrence(n, at('2026-03-01T00:00')), at('2026-02-28T09:00'));
  assert.equal(latestOccurrence(n, at('2036-04-30T09:00')), at('2036-04-30T09:00'));
});

test('繰り返しは終了日時で止まる', () => {
  const n = { ...base, unit: 'day', startAt: at('2026-04-01T09:00'), endAt: at('2026-04-05T00:00') };
  assert.equal(latestOccurrence(n, at('2026-04-05T00:01')), null);
});
