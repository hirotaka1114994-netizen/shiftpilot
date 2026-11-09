// 勤務表の条件チェック（自動作成の処理とは独立に書いた検査プログラム）
// 基準：docs/requirements.md（A 確定・B-3 検証ルール）。自動作成の計算処理のコードは使わない。
// 使い方：const { checkSchedule } = require('./rules-check.cjs');
//         checkSchedule({ staff, D, cells, wishes }) → 違反の一覧（空なら条件をすべて満たす）

const CODES = ['日', '△', '×', '休', '有'];

function checkSchedule({ staff, D, cells, wishes = [] }) {
  const v = [];
  const at = (s, d) => cells[`${s}-${d}`];
  const name = s => staff[s].name || `スタッフ${s}`;

  // 1. すべてのマスが正しい勤務区分で埋まっている
  for (let s = 0; s < staff.length; s++)
    for (let d = 1; d <= D; d++)
      if (!CODES.includes(at(s, d))) v.push(`${d}日 ${name(s)}：勤務区分が不正（${at(s, d)}）`);

  for (let s = 0; s < staff.length; s++) {
    for (let d = 1; d <= D; d++) {
      const c = at(s, d), prev = d > 1 ? at(s, d - 1) : null, next = d < D ? at(s, d + 1) : null;
      // 2. 夜勤の翌日は必ず明け、明けの前日は必ず夜勤
      if (c === '△' && d < D && next !== '×') v.push(`${d}日 ${name(s)}：夜勤の翌日が明けでない`);
      if (c === '×' && prev !== '△') v.push(`${d}日 ${name(s)}：前日が夜勤でないのに明け`);
      // 3. 明けの翌日は日勤にしない
      if (c === '×' && next === '日') v.push(`${d + 1}日 ${name(s)}：明けの翌日に日勤`);
      // 4. 1日おきの3回連続夜勤をしない
      if (c === '△' && d >= 5 && at(s, d - 2) === '△' && at(s, d - 4) === '△') v.push(`${d}日 ${name(s)}：3回連続夜勤`);
      // 5. 4日連続日勤の直後に夜勤をしない
      if (c === '△' && d >= 5 && [1, 2, 3, 4].every(n => at(s, d - n) === '日')) v.push(`${d}日 ${name(s)}：4連続日勤の後の夜勤`);
      // 6. 日勤専従は夜勤なし
      if (c === '△' && staff[s].dayOnly) v.push(`${d}日 ${name(s)}：日勤専従なのに夜勤`);
    }
  }

  // 7. 毎日の配置人数と資格（月末日も夜勤2名以上：2026-11-09 確定）
  for (let d = 1; d <= D; d++) {
    const day = [], night = [];
    for (let s = 0; s < staff.length; s++) { if (at(s, d) === '日') day.push(staff[s]); if (at(s, d) === '△') night.push(staff[s]); }
    if (day.length < 4) v.push(`${d}日：日勤${day.length}名（4名以上必要）`);
    if (day.filter(x => x.driver).length < 2) v.push(`${d}日：日勤の運転可が2名未満`);
    if (!day.some(x => x.leader)) v.push(`${d}日：日勤リーダー不在`);
    if (night.length < 2 || night.length > 3) v.push(`${d}日：夜勤${night.length}名（2〜3名必要）`);
    if (!night.some(x => x.leader)) v.push(`${d}日：夜勤リーダー不在`);
    if (!night.some(x => x.driver)) v.push(`${d}日：夜勤の運転可が不在`);
    const j = night.filter(x => x.junior).length;
    if (j > 1) v.push(`${d}日：指導対象の新人が夜勤に${j}名`);
    if (j >= 1 && night.length < 3) v.push(`${d}日：新人が夜勤に入るのに夜勤${night.length}名（3名必要）`);
  }

  // 8. 希望休は休のまま
  for (const w of wishes) if (at(w.s, w.d) !== '休') v.push(`${w.d}日 ${name(w.s)}：希望休なのに「${at(w.s, w.d)}」`);

  return v;
}

module.exports = { checkSchedule };
