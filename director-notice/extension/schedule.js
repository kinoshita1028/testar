// 通知スケジュールの計算（純粋関数のみ。Chrome API には依存しない）

const APPROX_MS = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 31 * 86400e3 };
export const ONE_SHOT_VALID_MS = 7 * 86400e3; // 終了日時なしの単発通知の有効期間

/** k 回目（0始まり）の表示予定時刻をミリ秒で返す */
export function occurrenceAt(n, k) {
  const step = k * (n.interval || 1);
  const d = new Date(n.startAt);
  switch (n.unit) {
    case 'minute': return n.startAt + step * 60e3;
    case 'hour': return n.startAt + step * 3600e3;
    case 'day': d.setDate(d.getDate() + step); return d.getTime();
    case 'week': d.setDate(d.getDate() + step * 7); return d.getTime();
    case 'month': {
      // 31日開始 → 30日までの月は月末に寄せる
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + step);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      return d.getTime();
    }
    default: return n.startAt;
  }
}

/**
 * now 時点で「直近に到来済みの表示予定時刻」を返す。表示対象がなければ null。
 * PCの電源が切れていて予定時刻を過ぎた場合も、次の予定時刻が来るまでは対象として残る。
 */
export function latestOccurrence(n, now) {
  if (!n || !n.startAt || now < n.startAt) return null;
  if (n.endAt && now > n.endAt) return null;

  if (!APPROX_MS[n.unit]) {
    if (!n.endAt && now > n.startAt + ONE_SHOT_VALID_MS) return null;
    return n.startAt;
  }

  let k = Math.floor((now - n.startAt) / (APPROX_MS[n.unit] * (n.interval || 1)));
  while (occurrenceAt(n, k + 1) <= now) k++;
  while (k > 0 && occurrenceAt(n, k) > now) k--;

  const days = n.weekdays || [];
  if (!days.length) return occurrenceAt(n, k);

  // 曜日指定あり: 分・時間単位は「今が対象曜日か」だけを見る。日以上の単位は直近の対象曜日まで遡る。
  const maxBack = n.unit === 'minute' || n.unit === 'hour' ? 0 : 60;
  for (let i = 0; i <= maxBack && k - i >= 0; i++) {
    const t = occurrenceAt(n, k - i);
    if (days.includes(new Date(t).getDay())) return t;
  }
  return null;
}
