// 勤務表の条件チェック（自動作成の処理とは独立に書いた検査プログラム）
// 基準：docs/requirements.md（A 確定・B-3 検証ルール）。自動作成の計算処理のコードは使わない。
// 使い方：const { checkSchedule } = require('./rules-check.cjs');
//   checkSchedule({ staff, D, cells, wishes, conditions }) → 違反の一覧（空なら条件をすべて満たす）
//   conditions = { dayMin, nightMin, nightMax, offDays, nightTargets: { スタッフ番号: 回数 } }
//   （conditions を省略すると、日勤4・夜勤2〜3名、公休日数と夜勤回数の指定なし）

const CODES = ['日', '△', '×', '休', '有'];

function checkSchedule({ staff, D, cells, wishes = [], conditions = {} }) {
  const cond = { dayMin: 4, nightMin: 2, nightMax: 3, offDays: null, nightTargets: {}, ...conditions };
  const v = [];
  const at = (s, d) => cells[`${s}-${d}`];
  const name = s => staff[s].name || `スタッフ${s}`;

  // 1. すべてのマスが正しい勤務区分で埋まっている
  for (let s = 0; s < staff.length; s++)
    for (let d = 1; d <= D; d++)
      if (!CODES.includes(at(s, d))) v.push(`${d}日 ${name(s)}：勤務区分が不正（${at(s, d)}）`);

  for (let s = 0; s < staff.length; s++) {
    let consecutive = 0;
    for (let d = 1; d <= D; d++) {
      const c = at(s, d), prev = d > 1 ? at(s, d - 1) : null, next = d < D ? at(s, d + 1) : null;
      // 2. 夜勤の翌日は必ず明け、明けの前日は必ず夜勤
      if (c === '△' && d < D && next !== '×') v.push(`${d}日 ${name(s)}：夜勤の翌日が明けでない`);
      if (c === '×' && prev !== '△') v.push(`${d}日 ${name(s)}：前日が夜勤でないのに明け`);
      // 3. 明けの翌日は日勤にしない
      if (c === '×' && next === '日') v.push(`${d + 1}日 ${name(s)}：明けの翌日に日勤`);
      // 4. 連続夜勤（夜勤→明け→夜勤）は1人月1回まで（2026-11-09 確定）。1日おきの3回連続は不可
      if (c === '△' && d >= 3 && at(s, d - 2) === '△') consecutive++;
      if (c === '△' && d >= 5 && at(s, d - 2) === '△' && at(s, d - 4) === '△') v.push(`${d}日 ${name(s)}：3回連続夜勤`);
      // 5. 4日連続日勤の直後に夜勤をしない
      if (c === '△' && d >= 5 && [1, 2, 3, 4].every(n => at(s, d - n) === '日')) v.push(`${d}日 ${name(s)}：4連続日勤の後の夜勤`);
      // 6. 日勤専従は夜勤なし
      if (c === '△' && staff[s].dayOnly) v.push(`${d}日 ${name(s)}：日勤専従なのに夜勤`);
    }
    if (consecutive > 1) v.push(`${name(s)}：連続夜勤が月${consecutive}回（1回まで）`);
    // 7. 公休日数（全員ちょうど、希望休を含む）と、個人ごとの夜勤回数（指定した人はちょうど）
    const row = Array.from({ length: D }, (_, i) => at(s, i + 1));
    if (cond.offDays != null) {
      const off = row.filter(c => c === '休').length;
      if (off !== cond.offDays) v.push(`${name(s)}：公休${off}日（指定${cond.offDays}日）`);
    }
    const t = cond.nightTargets[s];
    if (t != null && t !== '') {
      const n = row.filter(c => c === '△').length;
      if (n !== Number(t)) v.push(`${name(s)}：夜勤${n}回（指定${t}回）`);
    }
  }

  // 8. 毎日の配置人数と資格（月末日も夜勤が必要：2026-11-09 確定）
  for (let d = 1; d <= D; d++) {
    const day = [], night = [];
    for (let s = 0; s < staff.length; s++) { if (at(s, d) === '日') day.push(staff[s]); if (at(s, d) === '△') night.push(staff[s]); }
    if (day.length < cond.dayMin) v.push(`${d}日：日勤${day.length}名（最低${cond.dayMin}名）`);
    if (day.filter(x => x.driver).length < 2) v.push(`${d}日：日勤の運転可が2名未満`);
    if (!day.some(x => x.leader)) v.push(`${d}日：日勤リーダー不在`);
    if (night.length < cond.nightMin || night.length > cond.nightMax) v.push(`${d}日：夜勤${night.length}名（${cond.nightMin}〜${cond.nightMax}名）`);
    if (!night.some(x => x.leader)) v.push(`${d}日：夜勤リーダー不在`);
    if (!night.some(x => x.driver)) v.push(`${d}日：夜勤の運転可が不在`);
    const j = night.filter(x => x.junior).length;
    if (j > 1) v.push(`${d}日：指導対象の新人が夜勤に${j}名`);
    if (j >= 1 && night.length < 3) v.push(`${d}日：新人が夜勤に入るのに夜勤${night.length}名（3名必要）`);
  }

  // 9. 希望休は休のまま
  for (const w of wishes) if (at(w.s, w.d) !== '休') v.push(`${w.d}日 ${name(w.s)}：希望休なのに「${at(w.s, w.d)}」`);

  return v;
}

// 目安（必須ではない）の達成状況：連続夜勤の後に2日休めたか
function softStats({ staff, D, cells }) {
  const at = (s, d) => cells[`${s}-${d}`];
  let consec = 0, restedTwo = 0;
  for (let s = 0; s < staff.length; s++)
    for (let d = 3; d <= D; d++)
      if (at(s, d) === '△' && at(s, d - 2) === '△' && d + 3 <= D) { consec++; if (at(s, d + 2) === '休' && at(s, d + 3) === '休') restedTwo++; }
  return { consec, restedTwo };
}

module.exports = { checkSchedule, softStats };
