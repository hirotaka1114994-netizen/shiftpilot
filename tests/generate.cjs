// 自動作成の検証テスト
// 使い方: node tests/generate.cjs
// 内容: ブラウザで index.html を開き、自動作成（autoGenerate）を色々な月・作成条件・希望休で実行し、
//       結果を (1) 独立した検査プログラム tests/rules-check.cjs と (2) アプリの validate() の両方で検証する。
//       成立しない条件では、理由が具体的に示されることも確認する。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { checkSchedule, softStats } = require('./rules-check.cjs');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const rng = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
// 希望休をランダムに作る（1人あたり上限つき）
function randomWishes(n, D, seed, perStaffMax = 3) {
  const r = rng(seed), set = new Map(), per = {};
  while (set.size < n) {
    const s = Math.floor(r() * 14), d = 1 + Math.floor(r() * D);
    if ((per[s] || 0) >= perStaffMax || set.has(`${s}-${d}`)) continue;
    per[s] = (per[s] || 0) + 1; set.set(`${s}-${d}`, { s, d });
  }
  return [...set.values()];
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  const staff = await page.evaluate(() => staff);
  const gen = (args) => page.evaluate(a => autoGenerate({ staff, ...a }), args);
  // アプリの validate() で検証（アプリの年月・条件を合わせて評価）
  const appValidate = (y, m, cells, wishes, cond) => page.evaluate(({ y, m, cells, wishes, cond }) => {
    year = y; month = m; Object.assign(settings, { dayMin: cond.dayMin, nightMin: cond.nightMin, nightMax: cond.nightMax });
    state = { cells, wishes, offDays: cond.offDays, nightTargets: cond.nightTargets }; return validate();
  }, { y, m, cells, wishes, cond });

  // 0. 検査プログラム自体の確認
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-2026-11.json'), 'utf8'));
  const sv = checkSchedule({ staff, D: 30, cells: sample.cells });
  check('検査プログラム：以前の固定データの「連続夜勤が月2回以上」を検出', sv.some(x => /連続夜勤が月/.test(x)), `${sv.length}件：${sv.slice(0, 2).join(' / ')}`);

  // 1. いろいろな月・作成条件・希望休で自動作成し、独立に検証する
  // 今月（2026年11月）を中心に確認する。他の月・厳しい条件は下の「参考」で成功率だけ記録する（既知の問題）
  const cases = [];
  for (const [y, m] of [[2026, 10]])
    for (const offDays of [8, 9, 10])
      for (const nW of [0, 15])
        for (const nightTargets of [{}, { 11: 4, 12: 4 }, { 0: 6, 11: 2, 12: 3 }])
          cases.push({ y, m, offDays, nW, nightTargets, dayMin: 4, nightMin: 2, nightMax: 3 });
  cases.push({ y: 2026, m: 10, offDays: 8, nW: 10, nightTargets: { 11: 4, 12: 4 }, dayMin: 4, nightMin: 3, nightMax: 3 }); // 夜勤3名体制（公休9日では人数不足のため8日）
  cases.push({ y: 2026, m: 10, offDays: 8, nW: 10, nightTargets: {}, dayMin: 5, nightMin: 2, nightMax: 3 });               // 日勤5名
  // 勤務の希望（日勤希望・夜勤希望）も混ぜたケース
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) cases.push({ y: 2026, m: 10, offDays: 9, nW: 12, nightTargets: { 11: 4, 12: 4 }, dayMin: 4, nightMin: 2, nightMax: 3, workReq: seed });
  let okCount = 0; const fail = [], times = [], spread = []; let consecAll = 0, restedAll = 0, generated = null;
  for (const [i, c] of cases.entries()) {
    const D = new Date(c.y, c.m + 1, 0).getDate();
    const wishes = randomWishes(c.nW, D, 1000 + i);
    if (c.workReq) { // 休み希望の一部を、日勤希望・夜勤希望に変える（夜勤希望は日勤専従以外、前後の希望と重ならないもの）
      const r = rng(c.workReq * 31);
      for (const w of wishes) {
        const x = r();
        const near = wishes.some(o => o !== w && o.s === w.s && Math.abs(o.d - w.d) <= 2);
        if (x < 0.25) w.t = '日'; else if (x < 0.45 && !staff[w.s].dayOnly && !near && w.d < D) w.t = '△';
      }
    }
    const cond = { dayMin: c.dayMin, nightMin: c.nightMin, nightMax: c.nightMax, offDays: c.offDays, nightTargets: c.nightTargets };
    const t = Date.now();
    const r = await gen({ D, wishes, conditions: cond, seed: i + 1 });
    times.push(Date.now() - t);
    const label = `${c.workReq ? '勤務希望あり・' : ''}${c.y}年${c.m + 1}月・公休${c.offDays}・日勤${c.dayMin}・夜勤${c.nightMin}〜${c.nightMax}・夜勤指定${JSON.stringify(c.nightTargets)}・希望休${c.nW}`;
    if (!r.ok) { fail.push(`${label}：作成できず ${JSON.stringify(r.conflicts.length ? r.conflicts.slice(0, 2) : r.stuckDay)}`); continue; }
    const v = checkSchedule({ staff, D, cells: r.cells, wishes, conditions: cond });
    const iss = await appValidate(c.y, c.m, r.cells, wishes, cond);
    if (v.length || iss.length) { fail.push(`${label}：違反 ${[...v, ...iss].slice(0, 3).join(' / ')}`); continue; }
    okCount++;
    if (!generated) generated = { D, cells: r.cells, wishes, cond, y: c.y, m: c.m };
    // 参考：指定なしの人の夜勤回数の差、連続夜勤の後に2日休めた割合
    const free = staff.map((s, k) => k).filter(k => !staff[k].dayOnly && c.nightTargets[k] == null);
    const counts = free.map(k => Array.from({ length: D }, (_, d) => r.cells[`${k}-${d + 1}`]).filter(x => x === '△').length);
    spread.push(Math.max(...counts) - Math.min(...counts));
    const ss = softStats({ staff, D, cells: r.cells }); consecAll += ss.consec; restedAll += ss.restedTwo;
  }
  check(`自動作成（今月 2026年11月）：${cases.length}通りすべて作成でき、独立検査とアプリの検証で違反0件`, okCount === cases.length, `${okCount}/${cases.length}件OK ${fail.slice(0, 2).join(' | ')}`);
  check('自動作成：1回あたりの時間が5秒以内', Math.max(...times) <= 5000, `最長 ${Math.max(...times)}ms・平均 ${Math.round(times.reduce((a, b) => a + b) / times.length)}ms`);
  console.log(`  参考：夜勤回数の個人差（指定なしの人、最多−最少）平均 ${(spread.reduce((a, b) => a + b, 0) / Math.max(1, spread.length)).toFixed(1)}回、最大 ${Math.max(...spread)}回`);
  console.log(`  参考（目安）：連続夜勤の後に2日休めた割合 ${restedAll}/${consecAll}回`);

  // 参考：他の月（12月・2月）と公休7・11日での成功率（失敗してもテストはNGにしない。既知の問題）
  {
    let ok = 0, n = 0, wrong = 0;
    for (const [y, m] of [[2026, 11], [2027, 1]]) for (const offDays of [7, 8, 9, 10, 11]) for (const nW of [0, 15]) {
      const D = new Date(y, m + 1, 0).getDate(); const wishes = randomWishes(nW, D, 5000 + n);
      const cond = { dayMin: 4, nightMin: 2, nightMax: 3, offDays, nightTargets: { 11: 4, 12: 4 } };
      const r = await gen({ D, wishes, conditions: cond, seed: n + 1, timeLimitMs: 2000 }); n++;
      if (r.ok) { if (checkSchedule({ staff, D, cells: r.cells, wishes, conditions: cond }).length) wrong++; else ok++; }
    }
    console.log(`  参考：他の月・厳しい条件での作成成功 ${ok}/${n}（作成できたものの違反 ${wrong}件）`);
    if (wrong) check('参考ケースで作成できた勤務表に違反がない', false, `${wrong}件`);
  }

  // 2. 2つの検査（テスト側の検査プログラムとアプリの validate）が、崩した勤務表で同じ判定をするか
  if (generated) {
    const r = rng(42); let agree = 0, total = 0, disagree = [];
    for (let k = 0; k < 150; k++) {
      const cells = { ...generated.cells };
      const s = Math.floor(r() * 14), d = 1 + Math.floor(r() * generated.D);
      cells[`${s}-${d}`] = ['日', '△', '×', '休'][Math.floor(r() * 4)];
      const a = checkSchedule({ staff, D: generated.D, cells, wishes: generated.wishes, conditions: generated.cond }).length > 0;
      const b = (await appValidate(generated.y, generated.m, cells, generated.wishes, generated.cond)).length > 0;
      total++; if (a === b) agree++; else disagree.push(`${s}-${d}→${cells[`${s}-${d}`]}（検査:${a} アプリ:${b}）`);
    }
    check('2つの検査の判定が一致（1マスずつ崩した勤務表150通り）', agree === total, `${agree}/${total} ${disagree.slice(0, 3).join(' / ')}`);
  }

  // 3. 成立しない条件では、具体的な理由を示し、勤務表を作らない
  const base = { dayMin: 4, nightMin: 2, nightMax: 3, offDays: 9, nightTargets: {} };
  const tryFail = async (title, args, re) => {
    const r = await gen({ D: 30, wishes: [], seed: 1, ...args, conditions: { ...base, ...args.conditions } });
    const msg = r.conflicts.map(c => (c.d ? `${c.d}日：` : '') + c.reason).join(' / ');
    check(`成立しない条件：${title}`, !r.ok && re.test(msg), msg.slice(0, 160));
  };
  await tryFail('人数が足りない（夜勤3名体制・公休9日：延べ3日不足）', { conditions: { nightMin: 3 } }, /3日足りません/);
  await tryFail('人数が足りない（日勤5・夜勤3・公休9日）', { conditions: { dayMin: 5, nightMin: 3 } }, /延べ.*足りません/);
  await tryFail('希望休が公休日数を超える', { wishes: Array.from({ length: 10 }, (_, i) => ({ s: 0, d: i + 1 })) }, /休み希望10日が、公休日数9日を超え/);
  await tryFail('希望休の集中（10日に9名）', { wishes: Array.from({ length: 9 }, (_, s) => ({ s, d: 10 })) }, /10日：/);
  await tryFail('夜勤希望の翌日に別の希望', { wishes: [{ s: 0, d: 5, t: '△' }, { s: 0, d: 6, t: '日' }] }, /明けになるため、翌日の希望と両立しません/);
  await tryFail('夜勤希望が上限人数を超える', { wishes: [0, 1, 2, 3].map(s => ({ s, d: 7, t: '△' })) }, /夜勤希望が4名/);
  await tryFail('夜勤の最低人数が上限を超える', { conditions: { nightMin: 4, nightMax: 3 } }, /最低人数4名が、夜勤の上限3名を超え/);
  await tryFail('夜勤回数の指定が多すぎる', { conditions: { nightTargets: { 0: 12 } } }, /夜勤12回/);

  // 4. 画面操作：公休日数が未入力なら入力を求める／作成できないときは理由を表示し、勤務表を変えない
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const msgs = [];
  page.on('dialog', d => { msgs.push(d.message()); d.type() === 'confirm' ? d.accept() : d.dismiss(); });
  await page.click('#generate');
  check('画面：公休日数が未入力なら入力を求める', /公休日数を入力/.test(msgs[0] || ''), msgs[0]);
  await page.fill('#offDays', '9'); await page.dispatchEvent('#offDays', 'change');
  await page.evaluate(() => { state.wishes = Array.from({ length: 9 }, (_, s) => ({ s, d: 10 })); save(); render(); });
  const before = await page.evaluate(() => JSON.stringify(state.cells));
  msgs.length = 0;
  await page.click('#generate');
  const after = await page.evaluate(() => JSON.stringify(state.cells));
  check('画面：作成できないときは理由を表示し、勤務表を変えない', before === after && /作成できませんでした/.test(msgs[1] || '') && /10日/.test(msgs[1] || ''), (msgs[1] || '').split('\n').slice(0, 3).join(' '));

  check('画面上のエラーがない', errors.length === 0, errors.join(' / '));
  await browser.close();
  const ng = results.filter(x => !x).length;
  console.log(`\n結果: ${results.length - ng}/${results.length} 項目OK${ng ? `、${ng} 項目NG` : ''}`);
  process.exit(ng ? 1 : 0);
})();
