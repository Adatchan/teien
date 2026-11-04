/**
 * サーバー（src/index.js）のテスト：本物の Worker を Miniflare で動かし、一時的な D1 を使う。
 *   - 公演：作成・複製・切り替え・削除
 *   - 当日券：サーバー側の料金計算、二重記録の防止、会計番号、販売終了、リセット
 *   - 取り置き：CSV の取り込み（確認・追加・更新・置き換え・エラー）、受け渡し、集計、CSV の書き出し
 *   npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, tempDir, cleanup } from './helpers.js';

const nowIso = () => new Date().toISOString();
let seq = 0;
const cid = () => `test-${Date.now().toString(36)}-${(seq++).toString(36)}-xxxx`;
const csvRows = (text) => text.replace(/^﻿/, '').trim().split('\r\n');

/** 公演 1 に券種（一般 1枚1,000円・2枚1,800円／学生 500円／招待 0円・販売停止）を登録する */
async function setupProducts(w, project = 1) {
  const h = { 'X-Project': String(project) };
  for (const body of [
    { name: '一般', unit: '枚', sets: [{ qty: 1, price: 1000 }, { qty: 2, price: 1800 }] },
    { name: '学生', unit: '枚', sets: [{ qty: 1, price: 500 }] },
    { name: '招待', unit: '枚', sets: [{ qty: 1, price: 0 }], active: false },
  ]) {
    const r = await w.api('/api/master/products', { body, role: 'master', headers: h });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return (await w.api('/api/master/data', { role: 'master', headers: h })).body.allProducts;
}

describe('新しく作った環境', () => {
  let w, dir;
  before(async () => { dir = tempDir(); w = await startWorker(dir); await w.loginMaster(); });
  after(async () => { await w.dispose(); cleanup(dir); });

  test('空の「最初の公演」が 1 つでき、当日に使う公演になる。支払方法の初期値は現金だけ', async () => {
    const r = await w.api('/api/master/projects', { role: 'master' });
    assert.equal(r.body.projects.length, 1);
    assert.equal(r.body.projects[0].name, '最初の公演');
    assert.equal(r.body.active, r.body.projects[0].id);
    assert.deepEqual(r.body.projects[0].payments, ['現金']);
    assert.equal(r.body.projects[0].products, 0);
  });
  test('ダッシュボードの API はない', async () => {
    assert.equal((await w.api('/api/summary')).status, 404);
  });
  test('ログインしないとレジ・受付の API は使えない', async () => {
    assert.equal((await w.api('/api/admin/reservations')).status, 401);
    assert.equal((await w.api('/api/admin/data')).status, 401);
  });
});

describe('当日券（レジ）', () => {
  let w, dir, prods;
  before(async () => {
    dir = tempDir(); w = await startWorker(dir);
    await w.loginMaster(); await w.loginRegister('受付太郎');
    prods = await setupProducts(w);
  });
  after(async () => { await w.dispose(); cleanup(dir); });
  const id = (name) => prods.find((p) => p.name === name).id;

  test('レジには販売中の券種だけが出る', async () => {
    const d = (await w.api('/api/admin/data', { role: 'register' })).body;
    assert.deepEqual(d.products.map((p) => p.name), ['一般', '学生']);
  });
  test('サーバーでセットを組み直して記録（一般3枚 = 2,800円）。会計番号は #1 から', async () => {
    const r = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('一般')]: 3 }, payment: '現金', clientId: cid(), createdAt: nowIso() } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 2800);
    assert.equal(r.body.units, 3);
    assert.equal(r.body.recent[0].order_no, 1);
    assert.equal(r.body.recent[0].desc, '一般3枚（2枚セット×1＋1枚×1）');
    assert.equal(r.body.recent[0].staff, '受付太郎');
  });
  test('同じ会計 ID は 2 回送っても 1 件', async () => {
    const c = cid();
    const body = { items: { [id('学生')]: 1 }, payment: '現金', clientId: c, createdAt: nowIso(), lite: true };
    await w.api('/api/admin/sales', { role: 'register', body });
    await w.api('/api/admin/sales', { role: 'register', body });
    const rows = await w.query('SELECT COUNT(*) AS n FROM sales WHERE client_id = ?', c);
    assert.equal(rows[0].n, 1);
  });
  test('販売停止の券種・選んでいない支払方法は受け付けない', async () => {
    let r = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('招待')]: 1 }, payment: '現金', clientId: cid(), createdAt: nowIso() } });
    assert.equal(r.status, 409);
    r = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('一般')]: 1 }, payment: 'PayPay', clientId: cid(), createdAt: nowIso() } });
    assert.equal(r.status, 409);
  });
  test('取消すると売上から外れ、戻すと元に戻る', async () => {
    const before = (await w.api('/api/admin/data', { role: 'register' })).body;
    const sale = before.recent[0];
    await w.api('/api/admin/sales/set-cancel', { role: 'register', body: { id: sale.id, cancelled: true } });
    let d = (await w.api('/api/admin/data', { role: 'register' })).body;
    assert.equal(d.total, before.total - sale.amount);
    await w.api('/api/admin/sales/set-cancel', { role: 'register', body: { id: sale.id, cancelled: false } });
    d = (await w.api('/api/admin/data', { role: 'register' })).body;
    assert.equal(d.total, before.total);
  });
  test('価格が変わる前に端末で打った会計は、端末の金額で記録して操作の記録に残す', async () => {
    const lines = [{ productId: id('学生'), name: '学生', unit: '枚', packs: [{ qty: 1, price: 400, count: 1 }] }];
    const r = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('学生')]: 1 }, lines, payment: '現金', clientId: cid(), createdAt: nowIso() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.recent[0].amount, 400);
    assert.ok(r.body.audit.some((a) => a.action === '今の価格と違う会計を記録'));
  });
  test('手集計用 CSV：券種ごとの枚数の列と合計。取消は含めない', async () => {
    const csv = (await w.api('/api/master/sales_ja.csv', { role: 'master' })).body;
    const rows = csvRows(csv);
    assert.equal(rows[0], '会計番号,日付,時刻,支払方法,担当者,一般(枚),学生(枚),枚数計(枚),合計(円),内容（参考）');
    assert.match(rows[1], /^1,\d{4}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2},現金,受付太郎,3,0,3,2800,/);
    const sales = csvRows((await w.api('/api/master/sales.csv', { role: 'master' })).body);
    assert.equal(sales[0], 'sale_id,project_id,order_no,sold_at,business_date,payment_method,ticket_quantity,total_amount_yen,staff_name');
  });
  test('販売終了後に打った会計は受け付けない（受付はそのまま使える）', async () => {
    await w.api('/api/master/closed', { role: 'master', body: { closed: true } });
    const r = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('一般')]: 1 }, payment: '現金', clientId: cid(), createdAt: nowIso() } });
    assert.equal(r.status, 423);
    assert.equal((await w.api('/api/admin/reservations', { role: 'register' })).status, 200);
    await w.api('/api/master/closed', { role: 'master', body: { closed: false } });
  });
  test('リセットは当日券の会計だけ。古い世代の未送信の会計は捨てる', async () => {
    const d0 = (await w.api('/api/admin/data', { role: 'register' })).body;
    const r = await w.api('/api/master/reset-sales', { role: 'master', body: { confirm: 'リセット', password: 'master-pass-1234' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 0);
    const stale = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('一般')]: 1 }, payment: '現金', clientId: cid(), createdAt: nowIso(), epoch: d0.epoch } });
    assert.equal(stale.body.total, 0);
    const ok = await w.api('/api/admin/sales', { role: 'register', body: { items: { [id('一般')]: 1 }, payment: '現金', clientId: cid(), createdAt: nowIso(), epoch: d0.epoch + 1 } });
    assert.equal(ok.body.total, 1000);
    assert.equal(ok.body.recent[0].order_no, 1);
  });
});

describe('取り置き（CSV の取り込みと受け渡し）', () => {
  let w, dir, prods;
  before(async () => {
    dir = tempDir(); w = await startWorker(dir);
    await w.loginMaster(); await w.loginRegister('受付花子');
    prods = await setupProducts(w);
  });
  after(async () => { await w.dispose(); cleanup(dir); });
  const imp = (csv, opts = {}) => w.api('/api/master/reservations/import', { role: 'master', body: { csv, mode: 'append', ...opts } });

  const CSV1 = '﻿番号,氏名,フリガナ,券種,枚数,支払,金額,備考\r\n'
    + '1,岡大 太郎,オカダイ タロウ,一般,3,当日,,\r\n'
    + '2,グリー 花子,グリー ハナコ,一般,1,済,,振込済み\r\n'
    + '2,グリー 花子,グリー ハナコ,学生,1,済,,\r\n'
    + '3,"合唱, 次郎",,招待,2,,,"関係者\n2階席"\r\n'
    + '\r\n';

  test('確認（dryRun）では何も書き込まず、件数・金額・枚数を返す。同じ番号の行は 1 件にまとめる', async () => {
    const r = await imp(CSV1, { dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.preview;
    assert.deepEqual(p.errors, []);
    assert.equal(p.counts.created, 3);
    assert.equal(p.items.length, 3);
    const [a, b, c] = p.items;
    assert.deepEqual([a.no, a.name, a.qty, a.amount, a.due, a.paid], ['1', '岡大 太郎', 3, 2800, 2800, false]);
    assert.deepEqual([b.ticketsText, b.amount, b.due, b.note], ['一般1枚・学生1枚', 1500, 0, '振込済み']);
    assert.deepEqual([c.name, c.ticketsText, c.amount, c.note], ['合唱, 次郎', '招待2枚', 0, '関係者\n2階席']);
    assert.equal((await w.query('SELECT COUNT(*) AS n FROM reservations'))[0].n, 0);
  });
  test('取り込むと受付の画面に出る。集計（件数・枚数・当日精算の額）', async () => {
    const r = await imp(CSV1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reservations.count, 3);
    assert.equal(r.body.reservations.qty, 7);
    assert.equal(r.body.reservations.dueTotal, 2800);
    const rec = (await w.api('/api/admin/reservations', { role: 'register' })).body;
    assert.equal(rec.reservations.length, 3);
    assert.equal(rec.reservations[0].name, '岡大 太郎');
    assert.deepEqual(rec.reservations[1].tickets.map((t) => [t.name, t.qty]), [['一般', 1], ['学生', 1]]);
    // 変化がなければ一覧は返さない
    const same = (await w.api(`/api/admin/reservations?project=${rec.project.id}&rev=${rec.rev}`, { role: 'register' })).body;
    assert.equal(same.same, true);
  });
  test('受け渡し済みにすると、当日精算の額が「受け取った額」に入り、レジの売上合計にも足される', async () => {
    const rec = (await w.api('/api/admin/reservations', { role: 'register' })).body;
    const taro = rec.reservations.find((x) => x.no === '1');
    const r = await w.api('/api/admin/reservations/handed', { role: 'register', body: { id: taro.id, handed: true, at: nowIso() } });
    assert.equal(r.status, 200);
    // 何度送っても同じ
    await w.api('/api/admin/reservations/handed', { role: 'register', body: { id: taro.id, handed: true, at: nowIso() } });
    const d = (await w.api('/api/admin/data', { role: 'register' })).body;
    assert.equal(d.reservations.handed, 1);
    assert.equal(d.reservations.collected, 2800);
    assert.equal(d.reservations.uncollected, 0);
    assert.equal(d.grandTotal, d.total + 2800);
    const after = (await w.api(`/api/admin/reservations?project=${rec.project.id}&rev=${rec.rev}`, { role: 'register' })).body;
    assert.notEqual(after.rev, rec.rev);
    const t = after.reservations.find((x) => x.no === '1');
    assert.ok(t.handedAt);
    assert.equal(t.handedBy, '受付花子');
  });
  test('同じ番号を取り込み直すと内容だけ更新し、受け渡しの記録は残す（追加・更新）', async () => {
    const csv = '番号,氏名,券種,枚数,支払\n1,岡大 太郎,一般,4,当日\n4,新しい 人,学生,2,当日\n';
    const pre = (await imp(csv, { dryRun: true })).body.preview;
    assert.deepEqual([pre.counts.created, pre.counts.updated, pre.counts.removed], [1, 1, 0]);
    const r = await imp(csv);
    assert.equal(r.status, 200);
    const list = r.body.reservationList;
    assert.equal(list.length, 4);
    const taro = list.find((x) => x.no === '1');
    assert.equal(taro.qty, 4);
    assert.equal(taro.amount, 3600);
    assert.ok(taro.handedAt, '受け渡しの記録が残る');
    assert.equal(taro.kana, 'オカダイ タロウ', 'CSV に列がない項目（フリガナ）は今の値を残す');
  });
  test('置き換えると CSV にない取り置きは消え、受け渡し済みが消えるときは警告を出す', async () => {
    const csv = '番号,氏名,券種,枚数,支払\n2,グリー 花子,一般,1,済\n2,グリー 花子,学生,1,済\n';
    let pre = (await imp(csv, { dryRun: true, mode: 'replace' })).body.preview;
    assert.equal(pre.counts.removed, 3);
    assert.equal(pre.counts.removedHanded, 1);
    assert.ok(pre.warnings.some((x) => x.includes('受け渡し済み')));
    pre = (await imp(csv, { dryRun: true, mode: 'append' })).body.preview;
    assert.equal(pre.counts.removed, 0);
    assert.equal(pre.counts.unchanged, 1);
  });
  test('券種ごとの列（横持ち）の CSV と、番号のない行への自動の番号付け', async () => {
    const csv = '氏名,一般(枚),学生,支払\n横持ち 一郎,2,1,当日\n横持ち 二郎,,3,済\n';
    const p = (await imp(csv, { dryRun: true })).body.preview;
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.items.map((x) => [x.no, x.ticketsText, x.amount]), [['5', '一般2枚・学生1枚', 2300], ['6', '学生3枚', 1500]]);
    assert.ok(p.warnings.some((x) => x.includes('番号を自動で付けます')));
  });
  test('間違いのある CSV は行番号つきでエラーを返し、取り込まない', async () => {
    const csv = '番号,氏名,券種,枚数,支払,金額\n10,,一般,1,当日,\n11,誤字 さん,一船,1,当日,\n12,枚数 さん,一般,ニ,当日,\n13,支払 さん,一般,1,たぶん,\n14,金額 さん,一般,1,当日,abc\n';
    const p = (await imp(csv, { dryRun: true })).body.preview;
    assert.deepEqual(p.errors.map((e) => e.line), [2, 3, 4, 5, 6]);
    assert.match(p.errors[1].message, /券種「一船」は登録されていません/);
    const r = await imp(csv);
    assert.equal(r.status, 400);
    assert.equal((await w.query("SELECT COUNT(*) AS n FROM reservations WHERE res_no IN ('10', '11', '12', '13', '14')"))[0].n, 0);
  });
  test('必要な列がない CSV', async () => {
    let p = (await imp('名前だけ\nあ\n', { dryRun: true })).body.preview;
    assert.match(p.errors[0].message, /「氏名」の列がありません/);
    p = (await imp('氏名,枚数\nあ,1\n', { dryRun: true })).body.preview;
    assert.match(p.errors[0].message, /「券種」の列がありません/);
  });
  test('金額の列があればその金額を使う（割引など）', async () => {
    const p = (await imp('番号,氏名,券種,枚数,支払,金額\n20,割引 さん,一般,2,当日,"1,500円"\n', { dryRun: true })).body.preview;
    assert.equal(p.items[0].amount, 1500);
  });
  test('取り置きの一覧の CSV は、そのまま取り込み直せる（変更なし）', async () => {
    const csv = (await w.api('/api/master/reservations.csv', { role: 'master' })).body;
    const rows = csvRows(csv);
    assert.equal(rows[0], '番号,氏名,フリガナ,一般(枚),学生(枚),招待(枚),枚数計,支払,金額(円),受付で受け取る額(円),受け取った額(円),受け渡し,受け渡し日時,受け渡した人,備考,連絡先,受付方法,申込日時,団員,団員のメール,団員から回収');
    assert.match(rows[1], /^1,岡大 太郎,オカダイ タロウ,4,0,0,4,当日,3600,3600,3600,済,\d{4}-\d{2}-\d{2}T[\d:]+\+09:00,受付花子,,,CSV,\d{4}-\d{2}-\d{2}T[\d:]+\+09:00,,,$/);
    const p = (await imp(csv, { dryRun: true })).body.preview;
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.warnings, []);
    assert.equal(p.counts.unchanged, p.counts.rows);
  });
  test('様式の CSV（見出しと記入例）は登録済みの券種名で、そのまま取り込める', async () => {
    const csv = (await w.api('/api/master/reservations_template.csv', { role: 'master' })).body;
    assert.equal(csvRows(csv)[0], '番号,氏名,フリガナ,券種,枚数,支払,金額,団員,備考');
    const p = (await imp(csv, { dryRun: true, mode: 'replace' })).body.preview;
    assert.deepEqual(p.errors, []);
    assert.equal(p.items.length, 2);
  });
  test('受け渡しを戻すと操作の記録に残る。取り置きのある券種は削除できない', async () => {
    const list = (await w.api('/api/admin/reservations', { role: 'register' })).body.reservations;
    const taro = list.find((x) => x.no === '1');
    await w.api('/api/admin/reservations/handed', { role: 'register', body: { id: taro.id, handed: false } });
    const d = (await w.api('/api/master/data', { role: 'master' })).body;
    assert.ok(d.audit.some((a) => a.action === '受け渡しを取り消し'));
    assert.equal(d.reservations.handed, 0);
    const gen = prods.find((p) => p.name === '学生');
    const r = await w.api(`/api/master/products/${gen.id}/delete`, { role: 'master', body: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /取り置き/);
  });
  test('受け渡しの記録だけを未に戻す・すべて削除（確認の文字が必要）', async () => {
    const list = (await w.api('/api/admin/reservations', { role: 'register' })).body.reservations;
    await w.api('/api/admin/reservations/handed', { role: 'register', body: { id: list[0].id, handed: true } });
    assert.equal((await w.api('/api/master/reservations/reset', { role: 'master', body: { what: 'handed', confirm: 'はい' } })).status, 400);
    let r = await w.api('/api/master/reservations/reset', { role: 'master', body: { what: 'handed', confirm: '未に戻す' } });
    assert.equal(r.body.reservations.handed, 0);
    assert.equal(r.body.reservations.count, list.length);
    r = await w.api('/api/master/reservations/reset', { role: 'master', body: { what: 'all', confirm: '削除' } });
    assert.equal(r.body.reservations.count, 0);
  });
});

describe('ウェブの取り置き予約（/order・団員が知り合いの分を予約）', () => {
  let w, dir, prods;
  const future = () => new Date(Date.now() + 3600000).toISOString();
  before(async () => {
    dir = tempDir(); w = await startWorker(dir);
    await w.loginMaster(); await w.loginRegister('受付花子');
    prods = await setupProducts(w);
    // 招待はウェブ予約に出さない
    const inv = prods.find((p) => p.name === '招待');
    await w.api('/api/master/products', { role: 'master', body: { ...inv, web: false } });
  });
  after(async () => { await w.dispose(); cleanup(dir); });
  const id = (name) => prods.find((p) => p.name === name).id;
  const auth = { email: 'yamada@example.com', password: 'ensoukai' };
  const order = (body) => w.api('/api/order', { body: { ...auth, clientId: cid(), member: '山田 花子', sei: 'ヨヤク', mei: 'イチロウ', items: { [id('一般')]: 2 }, ...body } });

  test('設定するまでは受け付けない。受け付けるにはパスワードと開場日時が必要', async () => {
    const st = (await w.api('/api/order/status')).body;
    assert.equal(st.open, false);
    assert.equal(st.state, 'off');
    assert.equal((await order({})).status, 403);
    let r = await w.api('/api/master/web-order', { role: 'master', body: { enabled: true, openAt: future() } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /パスワード/);
    r = await w.api('/api/master/web-order', { role: 'master', body: { enabled: true, password: 'abc' } });
    assert.equal(r.status, 400, '短すぎるパスワード');
    r = await w.api('/api/master/web-order', { role: 'master', body: { enabled: true, openAt: future(), password: 'ensoukai', max: 6 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.projectSettings.webOrder.state, 'open');
    assert.equal(r.body.projectSettings.webOrder.password, true);
  });
  test('メールアドレスとパスワードで認証。違うと券種も見えない。合っていればウェブ予約に出す券種だけが見える', async () => {
    let r = await w.api('/api/order/unlock', { body: { email: 'yamada@example.com', password: 'wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.products, undefined);
    r = await w.api('/api/order/unlock', { body: { email: 'not-an-email', password: 'ensoukai' } });
    assert.equal(r.status, 400);
    assert.equal((await order({ password: 'wrong' })).status, 401);
    r = await w.api('/api/order/unlock', { body: { email: ' Yamada@Example.com ', password: 'ensoukai' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.email, 'yamada@example.com');
    assert.deepEqual(r.body.products.map((p) => p.name), ['一般', '学生']);
    assert.equal(r.body.max, 6);
  });
  test('予約すると W1, W2… で取り置きに入り、受付の画面に出る。代金はいつも団員から回収（受付では受け取らない）', async () => {
    let r = await order({ note: '2階席希望' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reservations[0].no, 'W1');
    assert.equal(r.body.reservations[0].name, 'ヨヤク イチロウ');
    assert.equal(r.body.reservations[0].amount, 1800);
    assert.equal(r.body.reservations[0].settle, 'member');
    // ひらがな・半角カナはカタカナに直す。「受付で払う」を送っても団員から回収になる
    r = await order({ sei: 'よやく', mei: 'ｼﾞﾛｳ', settle: 'reception', items: { [id('学生')]: 1, [id('一般')]: 1 } });
    assert.equal(r.body.reservations[0].no, 'W2');
    assert.equal(r.body.reservations[0].name, 'ヨヤク ジロウ');
    const rec = (await w.api('/api/admin/reservations', { role: 'register' })).body.reservations;
    const w1 = rec.find((x) => x.no === 'W1');
    assert.deepEqual([w1.source, w1.settle, w1.due, w1.memberDue, w1.member, w1.email, w1.kana, w1.note],
      ['web', 'member', 0, 1800, '山田 花子', 'yamada@example.com', 'ヨヤク イチロウ', '2階席希望']);
    const w2 = rec.find((x) => x.no === 'W2');
    assert.deepEqual([w2.settle, w2.due, w2.memberDue], ['member', 0, 1500]);
    const d = (await w.api('/api/master/data', { role: 'master' })).body;
    assert.equal(d.reservations.web, 2);
    assert.equal(d.reservations.memberTotal, 3300);
    assert.equal(d.reservations.dueTotal, 0);
  });
  test('複数のお客さんをまとめて予約できる（お客さんごとに番号）。同じ氏名が 2 回はだめ。1 人でも間違いがあれば 1 人も入らない', async () => {
    const guests = [
      { sei: 'マトメ', mei: 'イチ', items: { [id('一般')]: 1 }, note: '前の方の席' },
      { sei: 'まとめ', mei: 'に', items: { [id('学生')]: 2 } },
    ];
    let r = await w.api('/api/order', { body: { ...auth, clientId: cid(), member: '山田 花子', guests } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.reservations.map((x) => [x.no, x.name, x.amount, x.note]), [['W3', 'マトメ イチ', 1000, '前の方の席'], ['W4', 'マトメ ニ', 1000, '']]);
    assert.equal(r.body.mailed, false, 'メールの送信サービスを設定していなければ送らない');
    const before = (await w.query('SELECT COUNT(*) AS n FROM reservations'))[0].n;
    r = await w.api('/api/order', { body: { ...auth, clientId: cid(), member: '山田 花子', guests: [{ sei: 'イイ', mei: 'ヒト', items: { [id('一般')]: 1 } }, { sei: '悪い', mei: 'ヒト', items: { [id('一般')]: 1 } }] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /2人目/);
    r = await w.api('/api/order', { body: { ...auth, clientId: cid(), member: '山田 花子', guests: [guests[0], guests[0]] } });
    assert.equal(r.status, 400);
    assert.equal((await w.query('SELECT COUNT(*) AS n FROM reservations'))[0].n, before);
    // 同じ送信をもう一度：まとめて 1 回分
    const c = cid();
    const a = await w.api('/api/order', { body: { ...auth, clientId: c, member: '山田 花子', guests: [{ sei: 'サイ', mei: 'ソウ', items: { [id('一般')]: 1 } }, { sei: 'サイ', mei: 'ソウニ', items: { [id('一般')]: 1 } }] } });
    const b = await w.api('/api/order', { body: { ...auth, clientId: c, member: '山田 花子', guests: [{ sei: 'サイ', mei: 'ソウ', items: { [id('一般')]: 1 } }, { sei: 'サイ', mei: 'ソウニ', items: { [id('一般')]: 1 } }] } });
    assert.equal(b.body.duplicate, true);
    assert.deepEqual(b.body.reservations.map((x) => x.no), a.body.reservations.map((x) => x.no));
    // あとで消す（ほかのテストの金額に影響しないように）
    await w.query("DELETE FROM reservations WHERE name IN ('マトメ イチ', 'マトメ ニ', 'サイ ソウ', 'サイ ソウニ')");
  });
  test('お客さんの氏名はカタカナだけ（セイ・メイとも必須）。団員氏名も必須', async () => {
    for (const bad of [{ sei: '' }, { mei: '' }, { sei: '山田' }, { mei: 'Taro' }, { mei: 'タロウ1' }, { member: '' }]) {
      const r = await order(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });
  test('同じ予約を 2 回送っても 1 件', async () => {
    const c = cid();
    const a = await order({ clientId: c, sei: 'ニジュウ', mei: 'ソウシン' });
    const b = await order({ clientId: c, sei: 'ニジュウ', mei: 'ソウシン' });
    assert.equal(a.body.reservations[0].no, b.body.reservations[0].no);
    assert.equal(b.body.duplicate, true);
    assert.equal((await w.query("SELECT COUNT(*) AS n FROM reservations WHERE name = 'ニジュウ ソウシン'"))[0].n, 1);
  });
  test('入力のチェック：上限の枚数、ウェブ予約に出さない券種、枚数なし', async () => {
    assert.equal((await order({ items: { [id('一般')]: 7 } })).status, 400);
    assert.equal((await order({ items: { [id('招待')]: 1 } })).status, 409);
    assert.equal((await order({ items: {} })).status, 400);
  });
  test('団員ごとの精算：団員の名前（全角・半角・空白の違いは同じ人）ごとにまとめ、回収済みを記録できる', async () => {
    await order({ member: '山田　花子', sei: 'ベツノ', mei: 'キャク', items: { [id('学生')]: 2 } });
    await order({ member: '佐藤 一郎', email: 'sato@example.com', sei: 'サトウ', mei: 'ノ', items: { [id('一般')]: 1 } });
    let d = (await w.api('/api/master/data', { role: 'master' })).body;
    const yamada = d.members.find((m) => m.member.startsWith('山田'));
    // W1（1,800）＋ W2（1,500）＋ 二重送信（1,800）＋ ベツノ（1,000）
    assert.deepEqual([yamada.count, yamada.amount, yamada.uncollected, yamada.others], [4, 6100, 6100, 0]);
    assert.deepEqual(yamada.emails, ['yamada@example.com']);
    const r = await w.api('/api/master/members/collect', { role: 'master', body: { member: '山田花子', collected: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    d = r.body;
    assert.equal(d.members.find((m) => m.member.startsWith('山田')).collected, 6100);
    assert.equal(d.reservations.memberCollected, 6100);
    assert.equal(d.reservations.memberUncollected, 1000);
    const csv = csvRows((await w.api('/api/master/members.csv', { role: 'master' })).body);
    assert.equal(csv[0], '団員,メールアドレス,取り置き(件),枚数,うち受け渡し済み(枚),団員から回収する額(円),回収済み(円),未回収(円),回収,団員の精算でない取り置き(件)');
    assert.ok(csv.some((l) => l.startsWith('佐藤 一郎,sato@example.com,1,1,0,1000,0,1000,未,0')));
  });
  test('CSV の「団員」の列：支払が空欄なら団員から回収、「当日」なら受付で', async () => {
    const p = (await w.api('/api/master/reservations/import', { role: 'master', body: { mode: 'append', dryRun: true,
      csv: '番号,氏名,券種,枚数,支払,団員\n1,カ タロウ,一般,1,,山田 花子\n2,カ ジロウ,一般,1,当日,山田 花子\n3,カ サブロウ,一般,1,,\n4,カ シロウ,一般,1,団員,\n' } })).body.preview;
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.items.map((x) => x.settle), ['member', 'reception', 'reception', 'member']);
  });
  test('CSV の「置き換え」でも、ウェブで受け付けた取り置きは消さない', async () => {
    const r = await w.api('/api/master/reservations/import', { role: 'master', body: { csv: '番号,氏名,券種,枚数\n1,CSV 太郎,一般,1\n', mode: 'replace', dryRun: true } });
    assert.equal(r.body.preview.counts.removed, 0);
    assert.ok(r.body.preview.warnings.some((x) => x.includes('ウェブで受け付けた取り置き')));
  });
  test('取り置きを 1 件削除できる（受付の画面からも消える）', async () => {
    const list = (await w.api('/api/admin/reservations', { role: 'register' })).body.reservations;
    const x = list.find((r) => r.no === 'W2');
    const r = await w.api(`/api/master/reservations/${x.id}/delete`, { role: 'master', body: {} });
    assert.equal(r.status, 200);
    const after = (await w.api('/api/admin/reservations', { role: 'register' })).body.reservations;
    assert.equal(after.some((r) => r.no === 'W2'), false);
    assert.ok(r.body.audit.some((a) => a.action === '取り置きを削除'));
  });
  test('開場時刻を過ぎたら締め切り', async () => {
    await w.api('/api/master/web-order', { role: 'master', body: { openAt: new Date(Date.now() - 60000).toISOString() } });
    const st = (await w.api('/api/order/status')).body;
    assert.equal(st.open, false);
    assert.equal(st.state, 'closed');
    const r = await order({});
    assert.equal(r.status, 403);
    assert.match(r.body.error, /締め切りました/);
  });
});

describe('公演', () => {
  let w, dir;
  before(async () => {
    dir = tempDir(); w = await startWorker(dir);
    await w.loginMaster(); await w.loginRegister();
    await setupProducts(w);
    await w.api('/api/master/payments', { role: 'master', body: { payments: ['現金', 'PayPay'] } });
  });
  after(async () => { await w.dispose(); cleanup(dir); });

  test('公演の設定で開場時刻を決めると、ウェブ予約の締め切りになる（公演日のその時刻・日本時間）', async () => {
    let r = await w.api('/api/master/projects/1', { role: 'master', body: { name: '最初の公演', startDate: '2027-06-01', endDate: '2027-06-01', openTime: '13:30' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.projectSettings.openAt, '2027-06-01T04:30:00.000Z');
    assert.equal(r.body.projectSettings.openTime, '13:30');
    // 公演日を変えると、開場時刻はそのままで日付が変わる
    r = await w.api('/api/master/projects/1', { role: 'master', body: { startDate: '2027-06-02', endDate: '2027-06-02' } });
    assert.equal(r.body.projectSettings.openAt, '2027-06-02T04:30:00.000Z');
    assert.equal((await w.api('/api/master/projects/1', { role: 'master', body: { openTime: '25:00' } })).status, 400);
    r = await w.api('/api/master/projects', { role: 'master', body: { name: '開場あり', startDate: '2027-12-01', openTime: '18:00' } });
    assert.equal(r.body.projects.find((x) => x.name === '開場あり').openAt, '2027-12-01T09:00:00.000Z');
  });
  test('入力のチェック', async () => {
    assert.equal((await w.api('/api/master/projects', { role: 'master', body: { name: '', startDate: '2027-06-01' } })).status, 400);
    assert.equal((await w.api('/api/master/projects', { role: 'master', body: { name: 'x', startDate: '2027-06-02', endDate: '2027-06-01' } })).status, 400);
  });
  test('前の公演から複製（券種・セットに含める相手・支払方法）。取り置きと会計は複製しない', async () => {
    const r = await w.api('/api/master/projects', { role: 'master', body: { name: '第61回定期演奏会', startDate: '2027-06-01', copyFrom: 1, copy: { products: true, payments: true } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.projects.find((x) => x.id === r.body.created);
    assert.equal(p.products, 3);
    assert.equal(p.reservations, 0);
    assert.deepEqual(p.payments, ['現金', 'PayPay']);
    assert.equal(p.endDate, '2027-06-01', '最終日を省くと公演日と同じ');
  });
  test('「当日に使う」を切り替えると、レジ・受付はその公演になる', async () => {
    const list = (await w.api('/api/master/projects', { role: 'master' })).body.projects;
    const next = list.find((x) => x.name === '第61回定期演奏会');
    await w.api(`/api/master/projects/${next.id}/activate`, { role: 'master', body: {} });
    const d = (await w.api('/api/admin/data', { role: 'register' })).body;
    assert.equal(d.project.id, next.id);
    const rec = (await w.api('/api/admin/reservations', { role: 'register' })).body;
    assert.equal(rec.project.id, next.id);
  });
  test('削除：当日に使っている公演は不可、取り置きがあれば公演名とパスワードが必要', async () => {
    const list = (await w.api('/api/master/projects', { role: 'master' })).body.projects;
    const active = list.find((x) => x.active);
    assert.equal((await w.api(`/api/master/projects/${active.id}/delete`, { role: 'master', body: {} })).status, 400);
    await w.api('/api/master/reservations/import', { role: 'master', headers: { 'X-Project': '1' }, body: { csv: '氏名,券種,枚数\nあ,一般,1\n' } });
    assert.equal((await w.api('/api/master/projects/1/delete', { role: 'master', body: {} })).status, 400);
    const r = await w.api('/api/master/projects/1/delete', { role: 'master', body: { confirm: '最初の公演', password: 'master-pass-1234' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await w.query('SELECT COUNT(*) AS n FROM reservations WHERE project_id = 1'))[0].n, 0);
  });
});
