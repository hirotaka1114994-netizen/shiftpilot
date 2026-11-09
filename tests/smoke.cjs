// ShiftPilot 動作確認テスト（スモークテスト）
// 使い方: node tests/smoke.cjs
// 内容: index.html をローカルで配信し、ブラウザ（Chromium）で主要操作を自動で試す。
// アプリ本体は変更しない。スクリーンショットは tests/screenshots/ に保存（Git管理外）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    // ---- パソコン幅 ----
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', d => (d.type() === 'confirm' ? d.accept() : d.dismiss()));

    await page.goto(url);
    check('ページが開く', (await page.title()).includes('ShiftPilot'), await page.title());
    check('対象月が2026年11月', (await page.textContent('#monthTitle')) === '2026年11月');
    const rows = await page.locator('#schedule tbody tr').count();
    const cells = await page.locator('#schedule tbody tr:first-child button').count();
    check('勤務表が14名×30日で表示される', rows === 14 && cells === 30, `${rows}行×${cells}列`);

    // マスを編集（スタッフA 3日 → 日勤）
    await page.click('#schedule button[data-s="0"][data-d="3"]');
    check('マスをタップすると編集画面が開く', await page.isVisible('#editor'));
    await page.click('#editor [data-code="日"]');
    check('勤務区分を変更できる', (await page.textContent('#schedule button[data-s="0"][data-d="3"]')).trim() === '日');

    // 夜勤を入れると翌日が自動で「×」
    await page.click('#schedule button[data-s="1"][data-d="10"]');
    await page.click('#editor [data-code="△"]');
    const next = (await page.textContent('#schedule button[data-s="1"][data-d="11"]')).trim();
    check('夜勤の翌日が自動で夜勤明け「×」になる', next === '×', `翌日=${next}`);

    // 希望休の登録と解除
    await page.selectOption('#wishStaff', '2');
    await page.selectOption('#wishDay', '15');
    await page.click('#addWish');
    const wishCell = page.locator('#schedule button[data-s="2"][data-d="15"]');
    check('希望休を登録できる', (await wishCell.textContent()).trim() === '休' && (await wishCell.getAttribute('class')).includes('wish'));
    check('希望休の件数表示が増える', (await page.textContent('#wishStat')).trim() === '1 件');
    await page.click('[data-remove="0"]');
    check('希望休を解除できる', (await page.textContent('#wishStat')).trim() === '0 件');

    // 最適化済みサンプルの読み込み
    await page.click('#generate');
    const issues = (await page.textContent('#issueStat')).trim();
    check('最適化済みサンプルを読み込める', /件$/.test(issues), `注意点 ${issues}`);
    await page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });

    // CSV書き出し
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    check('CSVを書き出せる', dl.suggestedFilename() === 'shiftpilot_2026_11.csv' && csv.split('\r\n').length === 15, dl.suggestedFilename());

    // 再読み込み後も端末内保存が残る
    await page.reload();
    check('再読み込み後も内容が保持される', (await page.textContent('#issueStat')).trim() === issues);

    // 月の移動
    await page.click('#next');
    check('翌月へ移動できる', (await page.textContent('#monthTitle')) === '2026年12月');
    await page.click('#prev');

    check('画面上のエラーがない', errors.length === 0, errors.join(' / '));
    await ctx.close();

    // ---- スマホ幅（iPhone 13 相当）----
    const { devices } = require('playwright');
    const mctx = await browser.newContext({ ...devices['iPhone 13'] });
    const m = await mctx.newPage();
    await m.goto(url);
    // 端末の画面幅（390px）とページ全体の幅を比べる。window.innerWidth はページに合わせて広がるため使わない。
    const screenW = m.viewportSize().width;
    const pageW = await m.evaluate(() => document.documentElement.scrollWidth);
    check('スマホ幅でページ全体が横にはみ出さない', pageW <= screenW, `画面幅 ${screenW}px／ページ幅 ${pageW}px`);
    const tap = await m.locator('#schedule tbody button').first().boundingBox();
    // 参考値（失敗扱いにしない）：押しやすさの目安は44px以上
    console.log(`  参考：勤務表マスの大きさ ${Math.round(tap.width)}×${Math.round(tap.height)}px（目安 44×44px 以上）`);
    await m.screenshot({ path: path.join(SHOTS, 'phone.png'), fullPage: false });
    await mctx.close();
  } catch (e) {
    check('テストが最後まで実行できる', false, e.message);
  } finally {
    await browser.close();
    server.close();
  }
  const ng = results.filter(r => !r.ok).length;
  console.log(`\n結果: ${results.length - ng}/${results.length} 項目OK${ng ? `、${ng} 項目NG` : ''}`);
  process.exit(ng ? 1 : 0);
})();
