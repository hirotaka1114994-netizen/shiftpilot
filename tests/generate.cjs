// 自動作成の検証テスト
// 使い方: node tests/generate.cjs
// 内容: ブラウザで index.html を開き、自動作成（autoGenerate）を色々な月・希望休で実行し、
//       結果を (1) 独立した検査プログラム tests/rules-check.cjs と (2) アプリの validate() の両方で検証する。
//       成立しない条件（希望休の集中など）では、理由が具体的に示されることも確認する。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { checkSchedule } = require('./rules-check.cjs');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

// 再現できる乱数（希望休をランダムに作るため）
const rng = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function randomWishes(n, D, seed) {
  const r = rng(seed), set = new Map();
  while (set.size < n) { const s = Math.floor(r() * 14), d = 1 + Math.floor(r() * D); set.set(`${s}-${d}`, { s, d }); }
  return [...set.values()];
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));

  // 0. 検査プログラム自体の確認：既知の正しい勤務表（2026年11月の固定データ）が合格し、壊した勤務表が不合格になる
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-2026-11.json'), 'utf8'));
  const staff = await page.evaluate(() => staff);
  const sv = checkSchedule({ staff, D: 30, cells: sample.cells });
  check('検査プログラム：既知の勤務表を合格と判定', sv.length === 0, sv.slice(0, 3).join(' / '));
  const broken = { ...sample.cells, '0-1': '日', '13-5': '△' };
  const bv = checkSchedule({ staff, D: 30, cells: broken });
  check('検査プログラム：壊した勤務表を不合格と判定', bv.length >= 2, `${bv.length}件検出`);

  // 1. いろいろな月・希望休で自動作成し、独立に検証する
  const cases = [];
  for (const [y, m] of [[2026, 10], [2026, 11], [2027, 1], [2028, 1]]) // 11月(30日)・12月(31日)・2027年2月(28日)・2028年2月(29日)
    for (const n of [0, 10, 25])
      for (const seed of [1, 2, 3]) cases.push({ y, m, n, seed });
  let okCount = 0, fail = [], times = [], appIssues = 0, fairness = [];
  for (const c of cases) {
    const D = new Date(c.y, c.m + 1, 0).getDate();
    const wishes = randomWishes(c.n, D, c.seed * 100 + c.n);
    const t = Date.now();
    const r = await page.evaluate(({ D, wishes, seed }) => autoGenerate({ staff, D, wishes, allowLastDayNight: true, seed }), { D, wishes, seed: c.seed });
    times.push(Date.now() - t);
    const label = `${c.y}年${c.m + 1}月・希望休${c.n}件・seed${c.seed}`;
    if (!r.ok) { fail.push(`${label}：作成できず ${JSON.stringify(r.conflicts.length ? r.conflicts.slice(0, 2) : r.stuckDay)}`); continue; }
    const v = checkSchedule({ staff, D, cells: r.cells, wishes });
    // アプリの validate() でも確認（アプリの年月を合わせて評価）
    const iss = await page.evaluate(({ y, m, cells, wishes }) => { year = y; month = m; state = { cells, wishes }; return validate(); }, { y: c.y, m: c.m, cells: r.cells, wishes });
    appIssues += iss.length;
    if (v.length || iss.length) fail.push(`${label}：違反 ${[...v, ...iss].slice(0, 3).join(' / ')}`);
    else okCount++;
    // 公平さ（参考）：夜勤回数の最大−最小（夜勤に入れる人のみ）
    const nightsPer = staff.map((s, i) => s.dayOnly ? null : Array.from({ length: D }, (_, d) => r.cells[`${i}-${d + 1}`]).filter(x => x === '△').length).filter(x => x !== null);
    fairness.push(Math.max(...nightsPer) - Math.min(...nightsPer));
  }
  check(`自動作成：${cases.length}通りすべて作成でき、独立検査とアプリの検証で違反0件`, okCount === cases.length, fail.slice(0, 3).join(' | '));
  check('自動作成：1回あたりの時間が5秒以内', Math.max(...times) <= 5000, `最長 ${Math.max(...times)}ms・平均 ${Math.round(times.reduce((a, b) => a + b) / times.length)}ms`);
  console.log(`  参考：夜勤回数の個人差（最多−最少）平均 ${(fairness.reduce((a, b) => a + b, 0) / fairness.length).toFixed(1)}回、最大 ${Math.max(...fairness)}回`);

  // 2. 成立しない条件では、具体的な理由を示し、勤務表を作らない
  const D = 30;
  const crowd = Array.from({ length: 9 }, (_, s) => ({ s, d: 10 })); // 10日に9名が希望休
  const r1 = await page.evaluate(({ D, wishes }) => autoGenerate({ staff, D, wishes, allowLastDayNight: true, seed: 1 }), { D, wishes: crowd });
  check('成立しない条件：希望休の集中を理由つきで報告', !r1.ok && r1.conflicts.some(c => c.d === 10), r1.conflicts.map(c => `${c.d}日：${c.reason}`).join(' / '));
  const leadersOff = Array.from({ length: 7 }, (_, s) => ({ s, d: 5 })); // 5日にリーダー全員が希望休
  const r2 = await page.evaluate(({ D, wishes }) => autoGenerate({ staff, D, wishes, allowLastDayNight: true, seed: 1 }), { D, wishes: leadersOff });
  check('成立しない条件：リーダー不足を理由つきで報告', !r2.ok && r2.conflicts.some(c => /リーダー/.test(c.reason)), r2.conflicts.map(c => `${c.d}日：${c.reason}`).join(' / '));

  // 3. 画面操作：作成できないときは理由を表示し、勤務表を変更しない
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => { state.wishes = Array.from({ length: 9 }, (_, s) => ({ s, d: 10 })); save(); render(); });
  const before = await page.evaluate(() => JSON.stringify(state.cells));
  const msgs = [];
  page.on('dialog', d => { msgs.push(d.message()); d.type() === 'confirm' ? d.accept() : d.dismiss(); });
  await page.click('#generate');
  const after = await page.evaluate(() => JSON.stringify(state.cells));
  check('画面：作成できないときは理由を表示し、勤務表を変えない', before === after && /作成できませんでした/.test(msgs[1] || '') && /10日/.test(msgs[1] || ''), (msgs[1] || '').split('\n').slice(0, 3).join(' '));

  check('画面上のエラーがない', errors.length === 0, errors.join(' / '));
  await browser.close();
  const ng = results.filter(x => !x).length;
  console.log(`\n結果: ${results.length - ng}/${results.length} 項目OK${ng ? `、${ng} 項目NG` : ''}`);
  process.exit(ng ? 1 : 0);
})();
