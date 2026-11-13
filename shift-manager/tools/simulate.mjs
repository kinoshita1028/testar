// デモデータの不足・要確認の出方を確認するためのスクリプト
import { loadShared } from './load-shared.mjs';
const S = loadShared();
const today = process.argv[2] || S.todayJST();
const t0 = Date.now();
const m = S.Demo.build(today);
console.log('build ms', Date.now() - t0, 'shifts', m.shifts.length, 'today', today);
for (const f of m.facilities) {
  const ctx = S.buildContext(m, f.id);
  const from = S.monthStart(today), to = S.monthEnd(today);
  const sh = m.shifts.filter(s => s.facilityId === f.id && s.date >= from && s.date <= to);
  const res = S.evaluateRange(ctx, from, to, sh);
  const open = res.filter(r => !r.closed);
  const c = { short: 0, warn: 0, ok: 0 };
  open.forEach(r => { c[r.worst === 'short' ? 'short' : r.worst === 'warn' ? 'warn' : 'ok']++; });
  const tot = open.reduce((a, r) => ({ ok: a.ok + r.counts.ok, warn: a.warn + r.counts.warn, short: a.short + r.counts.short }), { ok: 0, warn: 0, short: 0 });
  const rate = tot.ok / (tot.ok + tot.warn + tot.short);
  console.log(`\n${f.name}: openDays=${open.length} worst short=${c.short} warn=${c.warn} ok=${c.ok}  slotOK=${(rate * 100).toFixed(1)}%`);
  const st = S.statusCounts(sh); console.log('  status', JSON.stringify(st));
  open.forEach(r => {
    const iss = r.issues.map(i => (i.status === 'short' ? '×' : '!') + i.message).join(' / ');
    console.log('  ', r.date, r.worst.padEnd(5), iss.slice(0, 260));
  });
}
