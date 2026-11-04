/**
 * 岡大グリー 定演チケットシステム — 取り置きの受け渡し・当日券のレジ・管理画面（Cloudflare Workers + D1）
 *
 * 公演（定期演奏会など）ごとに、券種・価格と、取り置き・当日券の会計を分けて管理する。
 * レジと受付は、管理画面で「当日に使う」にした公演を使う。
 *
 *   /            入口（public/index.html・各画面へのリンクだけ）
 *   /admin       レジ（当日券の販売。public/admin.html・レジ用パスワード＋担当者名）
 *   /reception   受付（取り置きの受け渡し。public/reception.html・レジ用パスワード＋名前）
 *   /master      管理画面（public/master.html・マスターパスワード）
 *   /order       ウェブの取り置き予約（public/order.html・公演ごとの取り置き専用パスワード。開場時刻まで）
 *   /api/...     この Worker が処理する API
 *
 * 取り置き：管理画面で所定の様式の CSV を取り込むと、受付の画面に 1 件ずつカードで並ぶ。
 *   渡したらカードをスワイプ（またはタップ）して「受け渡し済み」にする。
 *   支払が「当日」の取り置きは、受け渡しのときに受け取る金額をカードに出し、受け取った額として集計する。
 * 取り置きは、出演者（団員）が知り合いにチケットを事前に渡せないときに使う。団員はウェブ（/order）で、
 *   メールアドレスと事前に渡した取り置き専用パスワードで認証し、団員氏名とお客さんの氏名（カタカナ）・券種・枚数を入れて予約する。
 *   開場時刻を過ぎると締め切る。届いた予約は番号 W1, W2, … で取り置きの一覧に入り、受付の画面にすぐ出る。
 *   代金は終演後に団員からまとめて回収するのが基本（settle = 'member'。受付では受け取らない）。管理画面で団員ごとに回収済みを記録する。
 * 当日券：レジで券種と枚数を入れて会計を記録する（受付には出ない）。
 *
 * 認証のしくみ
 *   - ログインに成功するとランダムなセッショントークンを発行し、HttpOnly Cookie に入れる
 *     （パスワード自体は端末に保存しない）。DB にはトークンの SHA-256 だけを保存する。
 *   - パスワードは PBKDF2 でハッシュ化して D1 に保存する。まだ一度も変更していないときは
 *     secret（ADMIN_PASSWORD / MASTER_PASSWORD）と照合する。
 *   - 同じ接続元から 10 分間に 5 回ログインに失敗すると、しばらくログインできなくする。
 *   - 取消・取り込み・パスワード変更・締め出しなどの操作は audit テーブルに記録する。
 *
 * 会計ごとの明細は sale_items に「その時点の券種名・価格」で保存するので、
 * あとで価格を変えても過去の記録は変わらない。
 */

import { DEFAULT_PAYMENTS, MAX_PAYMENTS, MAX_QTY, priceCart, describeItems, itemsFromLines, describeTickets } from '../public/pricing.js';

// ログインの種類ごとの設定（受付はレジと同じログイン）
const ROLES = {
  register: { label: 'レジ・受付', cookie: 'teien_reg', path: '/api/admin', ttl: 3 * 24 * 3600, secret: 'ADMIN_PASSWORD' },
  master: { label: 'マスター', cookie: 'teien_master', path: '/api/master', ttl: 12 * 3600, secret: 'MASTER_PASSWORD' },
  order: { label: 'ウェブ予約' },   // ログインはしない（予約のたびに取り置き専用パスワードを確かめる）
};
const ORDER_LIMIT = 20;          // 同じ接続元からのウェブ予約は 1 時間にこの件数まで（いたずら対策）
const ORDER_MAX_DEFAULT = 10;    // 1 回のウェブ予約の枚数の上限（管理画面で変えられる）
const MIN_ORDER_PASSWORD = 4;    // 取り置き専用パスワードの最低文字数（お客さんに伝えるので短めでもよい）
const MAX_FAILS = 5;          // この回数失敗したら
const LOCK_MINUTES = 10;      // この時間ログインできない
const MIN_PASSWORD = 8;       // 新しいパスワードの最低文字数
const PBKDF2_ITER = 100000;   // Workers の上限
const MAX_RESERVATIONS = 3000;   // 1 公演の取り置きの上限（受付の画面で扱える数）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // 通信できるかの確認用（レジ・受付のオンライン／オフライン表示）。DB には触らない
      if (url.pathname === '/api/ping') return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      await ensureSchema(env.DB);
      const route = request.method + ' ' + url.pathname;

      // 別サイトからの書き込みリクエストを拒否（Cookie の SameSite=Strict に加えて念のため）
      if (request.method !== 'GET') {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return json({ error: '不正なリクエストです' }, 403);
      }

      if (url.pathname === '/api/order' || url.pathname.startsWith('/api/order/')) return await orderApi(request, env, url, route, ctx);
      if (url.pathname.startsWith('/api/admin/')) return await registerApi(request, env, url, route);
      if (url.pathname.startsWith('/api/master/')) return await masterApi(request, env, url, route);
      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500, e.headers);
    }
  },
};

// ===== レジ・受付 API =====
async function registerApi(request, env, url, route) {
  const db = env.DB;
  const role = 'register';

  if (route === 'POST /api/admin/login') {
    const body = await readJson(request);
    const staff = cleanName(body.staff);
    if (!staff) throw httpError('名前を入力してください', 400);
    await login(request, env, role, body.password);
    const sess = await createSession(request, db, role, staff);
    await audit(db, staff, role, 'ログイン', sess.device + (body.screen === 'reception' ? '（受付）' : ''));
    return json(body.screen === 'reception' ? { ok: true } : await registerData(db, sess.row), 200, { 'Set-Cookie': sess.cookie });
  }
  if (route === 'POST /api/admin/logout') return logout(request, db, role);

  const sess = await requireSession(request, db, role);

  if (route === 'GET /api/admin/data') return json(await registerData(db, sess));
  if (route === 'GET /api/admin/sales') return json(await salesPage(db, await getActiveProject(db), url.searchParams));

  // ----- 受付（取り置きの受け渡し） -----
  // 当日に使う公演の取り置きの一覧（変化がなければ rev だけ返す）
  if (route === 'GET /api/admin/reservations') return json(await receptionData(db, await getActiveProject(db), url.searchParams));
  // 受け渡し済みにする／戻す（状態を指定するので何度送っても同じ。オフラインで操作した時刻 at も受け取る）
  if (route === 'POST /api/admin/reservations/handed') {
    const body = await readJson(request);
    const id = Math.floor(Number(body.id) || 0);
    const row = await db.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first();
    if (!row) throw httpError('取り置きが見つかりません（管理画面で取り込み直された可能性があります）', 404);
    const want = !!body.handed;
    if (!!row.handed_at !== want) {
      const at = want ? clientTime(body.at) : null;
      await db.batch([
        db.prepare('UPDATE reservations SET handed_at = ?, handed_by = ? WHERE id = ?').bind(at, want ? sess.staff : '', id),
        bumpRev(db, row.project_id),
      ]);
      if (!want) {
        await audit(db, sess.staff, role, '受け渡しを取り消し', `${await projectLabel(db, row.project_id)}${row.res_no} ${row.name}（${row.handed_by || '—'} が受け渡し済みにしていた）` + (body.offline ? '・オフライン操作' : ''));
      }
    }
    return json({ ok: true, id, handed: want });
  }

  // ----- レジ（当日券） -----
  if (route === 'POST /api/admin/sales') {
    const body = await readJson(request);
    await recordSale(db, body, sess.staff);
    // オフライン再送（lite）のときは重い集計を返さない
    return json(body.lite ? { ok: true } : await registerData(db, sess));
  }
  // 取消／戻すを「状態を指定して」設定する（同じ操作を何度送っても結果は同じ）
  if (route === 'POST /api/admin/sales/set-cancel') {
    const body = await readJson(request);
    // 売上記録の全リセットより前に端末で行った操作は捨てる（リセットした記録を復活させない）
    const P = body.projectId != null ? await getProject(db, body.projectId) : await getActiveProject(db);
    if (P && body.epoch != null && Number(body.epoch) !== P.epoch) return json({ ok: true, stale: true });
    const row = body.clientId
      ? await db.prepare('SELECT * FROM sales WHERE client_id = ?').bind(String(body.clientId)).first()
      : await db.prepare('SELECT * FROM sales WHERE id = ?').bind(Number(body.id) || 0).first();
    if (!row) throw httpError('会計が見つかりません', 404);
    const want = body.cancelled ? 1 : 0;
    if (row.cancelled !== want) {
      await db.prepare('UPDATE sales SET cancelled = ? WHERE id = ?').bind(want, row.id).run();
      await audit(db, sess.staff, role, want ? '会計を取消' : '取消を戻す',
        `${await projectLabel(db, row.project_id)}#${row.order_no} ${yen(row.amount)} ${row.payment}（担当 ${row.staff || '—'}）` + (body.offline ? '・オフライン操作' : ''));
    }
    return json({ ok: true, id: row.id, cancelled: want });
  }
  return json({ error: 'Not Found' }, 404);
}

// ===== 管理（マスター）API =====
async function masterApi(request, env, url, route) {
  const db = env.DB;
  const role = 'master';

  if (route === 'POST /api/master/login') {
    const body = await readJson(request);
    await login(request, env, role, body.password);
    const sess = await createSession(request, db, role, 'マスター');
    await audit(db, 'マスター', role, 'ログイン', sess.device);
    return json(await projectsData(db), 200, { 'Set-Cookie': sess.cookie });
  }
  if (route === 'POST /api/master/logout') return logout(request, db, role);

  const sess = await requireSession(request, db, role);

  // ----- 公演の一覧・作成・変更（公演を選ぶ前の画面） -----
  if (route === 'GET /api/master/projects') return json(await projectsData(db));
  if (route === 'POST /api/master/projects') {
    const body = await readJson(request);
    const made = await createProject(db, body);
    const what = made.src ? `（「${made.src.name}」から複製：${[made.copy.products && `券種 ${made.copied} 件`, made.copy.payments && '支払方法'].filter(Boolean).join('・') || 'なし'}）` : '';
    await audit(db, 'マスター', role, '公演を作成', made.name + what);
    if (body.activate) await setActiveProject(db, made.id);
    return json({ ...(await projectsData(db)), created: made.id });
  }
  const pj = url.pathname.match(/^\/api\/master\/projects\/(\d+)(?:\/(activate|delete))?$/);
  if (request.method === 'POST' && pj) {
    const P = await getProject(db, pj[1]);
    if (!P) throw httpError('公演が見つかりません', 404);
    if (pj[2] === 'activate') {
      await setActiveProject(db, P.id);
      await audit(db, 'マスター', role, '当日に使う公演を変更', P.name);
    } else if (pj[2] === 'delete') {
      // 公演の削除：その公演の会計（明細）・取り置き・券種もすべて消す。当日に使っている公演は消せない。
      // 会計か取り置きの記録があるときは、確認のため公演名とマスターパスワードの入力が必要
      if (P.id === await activeProjectId(db)) throw httpError('当日に使っている公演は削除できません。先にほかの公演を「当日に使う」にしてください', 400);
      const body = await readJson(request).catch(() => ({}));
      const st = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS total
          FROM sales WHERE project_id = ?`).bind(P.id).first();
      const rc = await db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE project_id = ?').bind(P.id).first();
      if (st.n > 0 || rc.n > 0) {
        if (String(body.confirm || '').trim() !== P.name) throw httpError('確認のため、公演名を正しく入力してください', 400);
        await login(request, env, role, body.password, 'マスターパスワードが違います');
      }
      const pc = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE project_id = ?').bind(P.id).first();
      await db.batch([
        db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE project_id = ?)').bind(P.id),
        db.prepare('DELETE FROM sales WHERE project_id = ?').bind(P.id),
        db.prepare('DELETE FROM reservations WHERE project_id = ?').bind(P.id),
        db.prepare('DELETE FROM products WHERE project_id = ?').bind(P.id),
        db.prepare('DELETE FROM projects WHERE id = ?').bind(P.id),
      ]);
      await audit(db, 'マスター', role, '公演を削除', `${P.name}（当日券の会計 ${st.n} 件・売上 ${yen(st.total)}・取り置き ${rc.n} 件・券種 ${pc.n} 件を削除）`);
      return json(await projectsData(db));
    } else {
      // 公演の設定（公演名・期間・開場時刻）の変更
      const f = readProjectFields(await readJson(request), P);
      await db.prepare('UPDATE projects SET name = ?, start_date = ?, end_date = ?, open_at = ? WHERE id = ?')
        .bind(f.name, f.startDate, f.endDate, f.openAt, P.id).run();
      await audit(db, 'マスター', role, '公演の設定を変更', `［${f.name}］${f.startDate}〜${f.endDate}` + (f.openTime ? `・開場 ${f.openTime}` : '・開場時刻なし'));
    }
    return json(await masterData(db, sess, await getProject(db, P.id)));
  }

  // ----- ここから下は、選んだ公演（?project= / X-Project）についての操作 -----
  const P = await projectFromRequest(db, request, url);
  const tag = `［${P.name}］`;
  const reload = async (extra) => json({ ...(await masterData(db, sess, await getProject(db, P.id))), ...extra });

  if (route === 'GET /api/master/data') return json(await masterData(db, sess, P));
  const csvName = request.method === 'GET' && url.pathname.match(/^\/api\/master\/([a-z_]+\.csv)$/);
  if (csvName && CSV_FILES[csvName[1]]) return csvResponse(db, P, csvName[1], url.searchParams);

  // ----- 取り置き -----
  // CSV の取り込み。dryRun なら確認用の結果だけ返す（何も書き込まない）
  if (route === 'POST /api/master/reservations/import') {
    const body = await readJson(request);
    const mode = body.mode === 'replace' ? 'replace' : 'append';
    const plan = await planImport(db, P, String(body.csv || ''), mode);
    if (body.dryRun) return json({ preview: plan.preview });
    if (plan.preview.errors.length) throw httpError(`CSV に直すところが ${plan.preview.errors.length} か所あるため、取り込めません`, 400);
    await applyImport(db, P, plan);
    const c = plan.preview.counts;
    await audit(db, 'マスター', role, '取り置きを取り込み',
      `${tag}${mode === 'replace' ? '置き換え' : '追加・更新'}：新規 ${c.created} 件・更新 ${c.updated} 件・変更なし ${c.unchanged} 件` + (c.removed ? `・削除 ${c.removed} 件` : '') + `（${body.fileName ? cleanName(body.fileName).slice(0, 60) : 'CSV'}）`);
    return reload({ imported: c });
  }
  // 受け渡しの記録だけ消す（リハーサル用）／取り置きをすべて削除
  if (route === 'POST /api/master/reservations/reset') {
    const body = await readJson(request);
    const all = body.what === 'all';
    const word = all ? '削除' : '未に戻す';
    if (String(body.confirm || '').trim() !== word) throw httpError(`確認のため「${word}」と入力してください`, 400);
    const st = await db.prepare('SELECT COUNT(*) AS n, COUNT(handed_at) AS handed FROM reservations WHERE project_id = ?').bind(P.id).first();
    await db.batch([
      all ? db.prepare('DELETE FROM reservations WHERE project_id = ?').bind(P.id)
        : db.prepare("UPDATE reservations SET handed_at = NULL, handed_by = '' WHERE project_id = ?").bind(P.id),
      bumpRev(db, P.id),
    ]);
    await audit(db, 'マスター', role, all ? '取り置きをすべて削除' : '受け渡しの記録をすべて未に戻す',
      `${tag}取り置き ${st.n} 件（うち受け渡し済み ${st.handed} 件）`);
    return reload();
  }

  // 団員から代金を回収した／戻す（その団員の「団員から回収」の取り置きをまとめて）
  if (route === 'POST /api/master/members/collect') {
    const body = await readJson(request);
    const key = memberKey(body.member);
    const rows = (await db.prepare("SELECT id, member, amount FROM reservations WHERE project_id = ? AND settle = 'member'").bind(P.id).all()).results
      .filter((r) => (memberKey(r.member) || '（団員の名前なし）') === key);
    if (!rows.length) throw httpError('その団員の取り置きが見つかりません', 404);
    const at = body.collected ? new Date().toISOString() : null;
    await db.batch(rows.map((r) => db.prepare('UPDATE reservations SET collected_at = ? WHERE id = ?').bind(at, r.id)));
    await audit(db, 'マスター', role, body.collected ? '団員から代金を回収' : '団員からの回収を取り消し',
      `${tag}${rows[0].member || '（団員の名前なし）'}：${rows.length} 件 ${yen(rows.reduce((a, r) => a + r.amount, 0))}`);
    return reload();
  }
  // 取り置きを 1 件削除（ウェブ予約の取り消しなど）
  const rd = url.pathname.match(/^\/api\/master\/reservations\/(\d+)\/delete$/);
  if (request.method === 'POST' && rd) {
    const r = await db.prepare('SELECT * FROM reservations WHERE id = ? AND project_id = ?').bind(Number(rd[1]), P.id).first();
    if (!r) throw httpError('取り置きが見つかりません', 404);
    await db.batch([db.prepare('DELETE FROM reservations WHERE id = ?').bind(r.id), bumpRev(db, P.id)]);
    await audit(db, 'マスター', role, '取り置きを削除', `${tag}${r.res_no} ${r.name}（${describeTickets(JSON.parse(r.tickets))}・${r.source === 'web' ? 'ウェブ' : 'CSV'}）` + (r.handed_at ? '・受け渡し済みだった' : ''));
    return reload();
  }
  if (route === 'POST /api/master/products') {
    const body = await readJson(request);
    const { before, after } = await saveProduct(db, P, body);
    await audit(db, 'マスター', role, before ? '券種を変更' : '券種を追加', tag + (before ? productDiff(before, after) : productText(after)));
    return reload();
  }
  // ウェブ予約の設定（受け付けるか・開場日時・1 回の上限枚数・取り置き専用パスワード）
  if (route === 'POST /api/master/web-order') {
    const body = await readJson(request);
    const row = await db.prepare('SELECT order_pw_hash FROM projects WHERE id = ?').bind(P.id).first();
    let openAt = P.openAt;
    if (body.openAt !== undefined) {
      openAt = body.openAt ? new Date(Date.parse(body.openAt)).toISOString() : null;
      if (body.openAt && Number.isNaN(Date.parse(body.openAt))) throw httpError('開場日時が不正です', 400);
    }
    const max = body.max !== undefined ? intIn(body.max, 1, MAX_QTY, '1回の予約の上限枚数') : P.orderMax;
    let hash = row.order_pw_hash;
    const pw = body.password != null ? String(body.password) : '';
    if (pw) {
      if (pw.length < MIN_ORDER_PASSWORD) throw httpError(`取り置き専用パスワードは${MIN_ORDER_PASSWORD}文字以上にしてください`, 400);
      if (pw.length > 100) throw httpError('パスワードが長すぎます', 400);
      hash = await hashPassword(pw);
    }
    const enabled = body.enabled !== undefined ? !!body.enabled : P.orderEnabled;
    if (enabled && !hash) throw httpError('ウェブ予約を受け付けるには、取り置き専用パスワードを決めてください', 400);
    if (enabled && !openAt) throw httpError('ウェブ予約を受け付けるには、上の「公演の設定」で開場時刻（締め切り）を入れてください', 400);
    await db.prepare('UPDATE projects SET order_enabled = ?, open_at = ?, order_max = ?, order_pw_hash = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, openAt, max, hash, P.id).run();
    await audit(db, 'マスター', role, 'ウェブ予約の設定を変更',
      `${tag}${enabled ? '受け付ける' : '受け付けない'}・締め切り ${openAt ? isoJst(openAt).slice(0, 16).replace('T', ' ') : 'なし'}・上限 ${max} 枚` + (pw ? '・パスワードを変更' : ''));
    return reload();
  }
  // 支払方法（この公演のレジに出す支払方法）
  if (route === 'POST /api/master/payments') {
    const next = parsePayments((await readJson(request)).payments);
    await db.prepare('UPDATE projects SET payments = ? WHERE id = ?').bind(JSON.stringify(next), P.id).run();
    await audit(db, 'マスター', role, '支払方法を変更', `${tag}${P.payments.join('・')} → ${next.join('・')}`);
    return reload();
  }
  const pm = url.pathname.match(/^\/api\/master\/products\/(\d+)\/(move|delete)$/);
  if (request.method === 'POST' && pm) {
    const id = Number(pm[1]);
    const prod = await db.prepare('SELECT * FROM products WHERE id = ? AND project_id = ?').bind(id, P.id).first();
    if (!prod) throw httpError('券種が見つかりません', 404);
    if (pm[2] === 'delete') {
      const used = await db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?').bind(id).first();
      if (used.n > 0) throw httpError('当日券の販売の記録がある券種は削除できません。「販売中」を外して販売停止にしてください', 400);
      const resv = await db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE project_id = ? AND tickets LIKE ?").bind(P.id, `%"productId":${id},%`).first();
      if (resv.n > 0) throw httpError(`取り置き ${resv.n} 件で使っている券種は削除できません。「販売中」を外すと、レジにだけ出なくなります`, 400);
      await db.batch([
        db.prepare('UPDATE products SET bundle_with = NULL WHERE bundle_with = ?').bind(id),   // この券種のセットに含めていた券種は単独に
        db.prepare('DELETE FROM products WHERE id = ?').bind(id),
      ]);
      await audit(db, 'マスター', role, '券種を削除', tag + prod.name);
    } else {
      const dir = Number((await readJson(request)).dir) < 0 ? -1 : 1;
      const list = (await db.prepare('SELECT id FROM products WHERE project_id = ? ORDER BY sort, id').bind(P.id).all()).results.map((x) => x.id);
      const i = list.indexOf(id), j = i + dir;
      if (j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        await db.batch(list.map((pid, k) => db.prepare('UPDATE products SET sort = ? WHERE id = ?').bind(k + 1, pid)));
      }
    }
    return reload();
  }
  if (route === 'POST /api/master/register-password') {
    const body = await readJson(request);
    await setPassword(db, 'register', body.next);
    let detail = '';
    if (body.revokeAll) {
      const n = await revokeWhere(db, "role = 'register'");
      detail = `レジ・受付の端末 ${n} 台を締め出し`;
    }
    await audit(db, 'マスター', role, 'レジ・受付のパスワードを変更', detail);
    return reload();
  }
  if (route === 'POST /api/master/master-password') {
    const body = await readJson(request);
    await login(request, env, role, body.current, '現在のマスターパスワードが違います');
    await setPassword(db, 'master', body.next);
    // 他の端末のマスターログインは無効にする
    await revokeWhere(db, "role = 'master' AND id != ?", sess.id);
    await audit(db, 'マスター', role, 'マスターパスワードを変更', '他の端末のマスターログインを解除');
    return reload();
  }
  if (route === 'POST /api/master/revoke-all') {
    const body = await readJson(request);
    let n, what;
    if (body.target === 'master') {
      n = await revokeWhere(db, "role = 'master' AND id != ?", sess.id);
      what = `ほかのマスター端末 ${n} 台`;
    } else {
      n = await revokeWhere(db, "role = 'register'");
      what = `レジ・受付の端末 ${n} 台`;
    }
    await audit(db, 'マスター', role, '締め出し', what);
    return reload();
  }
  // 当日券の売上記録の全リセット（テスト用・この公演の会計だけ。取り置きはそのまま）。確認の文字とマスターパスワードの再入力が必要
  if (route === 'POST /api/master/reset-sales') {
    const body = await readJson(request);
    if (String(body.confirm || '').trim() !== 'リセット') throw httpError('確認のため「リセット」と入力してください', 400);
    await login(request, env, role, body.password, 'マスターパスワードが違います');
    const before = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS total,
        COALESCE(SUM(cancelled), 0) AS cancelled FROM sales WHERE project_id = ?`).bind(P.id).first();
    await db.batch([
      db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE project_id = ?)').bind(P.id),
      db.prepare('DELETE FROM sales WHERE project_id = ?').bind(P.id),   // 会計番号（order_no）は次から #1 に戻る
      // 世代を進めて、リセット前にレジ端末で打った未送信の会計を受け付けないようにする
      db.prepare('UPDATE projects SET epoch = epoch + 1 WHERE id = ?').bind(P.id),
    ]);
    await audit(db, 'マスター', role, '当日券の売上記録を全リセット',
      `${tag}会計 ${before.n} 件（うち取消 ${before.cancelled} 件・売上 ${yen(before.total)}）を削除`);
    return reload();
  }
  // 当日券の販売終了／再開（販売終了中はレジで新しい会計を記録できない。受付はそのまま使える）
  if (route === 'POST /api/master/closed') {
    const body = await readJson(request);
    await db.prepare('UPDATE projects SET closed_at = ? WHERE id = ?').bind(body.closed ? new Date().toISOString() : null, P.id).run();
    await audit(db, 'マスター', role, body.closed ? '当日券の販売終了' : '当日券の販売再開', tag + (body.closed ? 'レジの会計の記録を停止' : 'レジの会計の記録を再開'));
    return reload();
  }
  if (route === 'POST /api/master/unlock') {
    const res = await db.prepare('DELETE FROM login_failures').run();
    await audit(db, 'マスター', role, 'ログイン制限を解除', `失敗記録 ${res.meta.changes || 0} 件を消去`);
    return reload();
  }
  const m = url.pathname.match(/^\/api\/master\/sessions\/(\d+)\/revoke$/);
  if (request.method === 'POST' && m) {
    const id = Number(m[1]);
    if (id === sess.id) throw httpError('自分自身は締め出せません。ログアウトを使ってください', 400);
    const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
    if (!row) throw httpError('端末が見つかりません', 404);
    await revokeWhere(db, 'id = ?', id);
    await audit(db, 'マスター', role, '締め出し', `${ROLES[row.role].label}：${row.staff}（${row.device}）`);
    return reload();
  }
  return json({ error: 'Not Found' }, 404);
}

/** 公演の一覧の画面に渡すデータ */
async function projectsData(db) {
  return { projects: await projectList(db), active: await activeProjectId(db), today: jstDay().date };
}

async function setActiveProject(db, id) {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('active_project', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(id)).run();
}

// ===== 認証 =====

/** パスワードを照合する。失敗回数の制限つき。失敗したら例外を投げる */
async function login(request, env, role, password, wrongMessage, verify) {
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const since = new Date(now - LOCK_MINUTES * 60000).toISOString();

  // 直近 LOCK_MINUTES 分の失敗が MAX_FAILS 回以上ならロック中
  const nth = await db.prepare(`SELECT at FROM login_failures WHERE ip = ? AND role = ? AND at > ?
    ORDER BY at DESC LIMIT 1 OFFSET ?`).bind(ip, role, since, MAX_FAILS - 1).first();
  if (nth) {
    const mins = Math.max(1, Math.ceil((new Date(nth.at).getTime() + LOCK_MINUTES * 60000 - now) / 60000));
    throw httpError(role === 'order' ? `パスワードの間違いが続いたため、あと約${mins}分は予約できません` : `ログインに続けて失敗したため、あと約${mins}分はログインできません`, 429);
  }

  if (await (verify ? verify(String(password || '')) : verifyPassword(env, role, String(password || '')))) {
    await db.batch([
      db.prepare('DELETE FROM login_failures WHERE ip = ? AND role = ?').bind(ip, role),
      db.prepare('DELETE FROM login_failures WHERE at < ?').bind(new Date(now - 86400000).toISOString()),
    ]);
    return;
  }

  await db.prepare('INSERT INTO login_failures (ip, role, at) VALUES (?, ?, ?)').bind(ip, role, new Date(now).toISOString()).run();
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND role = ? AND at > ?')
    .bind(ip, role, since).first();
  await audit(db, '—', role, 'ログイン失敗', `${ROLES[role].label}（${n}回目）`);
  const left = MAX_FAILS - n;
  const what = role === 'order' ? '予約' : 'ログイン';
  throw httpError((wrongMessage || 'パスワードが違います') +
    (left > 0 ? `（あと${left}回間違えると${LOCK_MINUTES}分間${what}できなくなります）` : `（${LOCK_MINUTES}分間${what}できません）`), 401);
}

async function verifyPassword(env, role, password) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(role + '_pw_hash').first();
  if (row) return verifyHash(password, row.value);
  // まだ画面から変更していないときは secret と照合
  const initial = env[ROLES[role].secret];
  if (!initial) throw httpError(`${ROLES[role].secret} が設定されていません`, 500);
  return safeEqual(await sha256(password), await sha256(initial));
}

async function setPassword(db, role, next) {
  next = String(next || '');
  if (next.length < MIN_PASSWORD) throw httpError(`新しいパスワードは${MIN_PASSWORD}文字以上にしてください`, 400);
  if (next.length > 200) throw httpError('パスワードが長すぎます', 400);
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(role + '_pw_hash', await hashPassword(next)).run();
}

async function createSession(request, db, role, staff) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + ROLES[role].ttl * 1000);
  const device = deviceName(request.headers.get('User-Agent') || '');
  const res = await db.prepare(`INSERT INTO sessions (token_hash, role, staff, device, created_at, last_seen, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(hex(await sha256(token)), role, staff, device, now.toISOString(), now.toISOString(), expires.toISOString()).run();
  // 古いセッションの掃除
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now.getTime() - 7 * 86400000).toISOString()).run();
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(res.meta.last_row_id).first();
  return { row, device, cookie: cookieHeader(role, token, ROLES[role].ttl) };
}

async function getSession(request, db, role) {
  const token = readCookie(request, ROLES[role].cookie);
  if (!token) return null;
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND role = ? AND revoked = 0 AND expires_at > ?`)
    .bind(hex(await sha256(token)), role, now).first();
  if (!row) return null;
  // 最終利用時刻は 1 分に 1 回だけ更新
  if (Date.parse(now) - Date.parse(row.last_seen) > 60000) {
    await db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').bind(now, row.id).run();
  }
  return row;
}

async function requireSession(request, db, role) {
  const sess = await getSession(request, db, role);
  if (!sess) {
    throw httpError('ログインしてください（締め出されたか、期限が切れました）', 401, { 'Set-Cookie': cookieHeader(role, '', 0) });
  }
  return sess;
}

async function logout(request, db, role) {
  const sess = await getSession(request, db, role);
  if (sess) {
    await revokeWhere(db, 'id = ?', sess.id);
    await audit(db, sess.staff, role, 'ログアウト', sess.device);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(role, '', 0) });
}

async function revokeWhere(db, where, ...binds) {
  const res = await db.prepare(`UPDATE sessions SET revoked = 1 WHERE revoked = 0 AND expires_at > ? AND ${where}`)
    .bind(new Date().toISOString(), ...binds).run();
  return res.meta.changes || 0;
}

function cookieHeader(role, token, maxAge) {
  const r = ROLES[role];
  return `${r.cookie}=${token}; Path=${r.path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function deviceName(ua) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '不明な端末';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} / ${br}` : os;
}

// ===== パスワードのハッシュ =====
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

async function verifyHash(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const actual = await pbkdf2(password, unb64url(salt), Number(iter));
  return safeEqual(actual, unb64url(hash));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ===== DB =====
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    // 公演。券種・会計・取り置きは公演ごと
    //   epoch: 当日券の売上記録の世代（全リセットで 1 増える）、rev: 取り置きの版（受付の画面の更新の確認用）
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      payments TEXT,
      closed_at TEXT,
      epoch INTEGER NOT NULL DEFAULT 1,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      order_enabled INTEGER NOT NULL DEFAULT 0,
      open_at TEXT,
      order_max INTEGER NOT NULL DEFAULT 10,
      order_pw_hash TEXT
    )`),
    // 券種（sets は数量ごとの価格の JSON 配列）
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '枚',
      sets TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      bundle_with INTEGER,
      web INTEGER NOT NULL DEFAULT 1
    )`),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS products_project_name ON products (project_id, name)'),
    // 当日券の会計。order_no は公演ごとに #1 から。client_id は端末で付けた会計ID（再送で二重にしない）
    db.prepare(`CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      order_no INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      units INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      payment TEXT NOT NULL,
      cancelled INTEGER NOT NULL DEFAULT 0,
      staff TEXT NOT NULL DEFAULT '',
      client_id TEXT
    )`),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS sales_client_id ON sales (client_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS sales_project ON sales (project_id, id)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      set_qty INTEGER NOT NULL,
      set_price INTEGER NOT NULL,
      count INTEGER NOT NULL,
      pack_label TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items (sale_id)'),
    // 取り置き。res_no は CSV の「番号」（公演ごとに重ならない）。tickets は [{ productId, name, unit, qty }] の JSON
    //   amount: チケット代の合計、settle: 代金の払い方（reception = 当日受付で / member = 終演後に団員から回収 / paid = 支払済み）
    //   paid: settle = paid のとき 1（前の版との互換）、handed_at: 受け渡した時刻（null = まだ）
    //   member / email: 予約した団員（ウェブ予約）・紹介した団員（CSV）、collected_at: 団員から代金を回収した時刻
    db.prepare(`CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      res_no TEXT NOT NULL,
      name TEXT NOT NULL,
      kana TEXT NOT NULL DEFAULT '',
      tickets TEXT NOT NULL,
      qty INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      handed_at TEXT,
      handed_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'csv',
      contact TEXT NOT NULL DEFAULT '',
      client_id TEXT,
      settle TEXT NOT NULL DEFAULT '',
      member TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      collected_at TEXT
    )`),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS reservations_no ON reservations (project_id, res_no)'),
    // ウェブ予約の記録（同じ接続元からの件数の制限用。古いものは消す）
    db.prepare('CREATE TABLE IF NOT EXISTS order_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, at TEXT NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      staff TEXT NOT NULL,
      device TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      role TEXT NOT NULL,
      at TEXT NOT NULL
    )`),
  ]);
  // あとから足した列（ウェブ予約）。前の版で作ったデータベースには ALTER で足す
  const cols = async (t) => (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name);
  const pc = await cols('projects'), rc = await cols('reservations'), xc = await cols('products');
  for (const [has, sql] of [
    [pc.includes('order_enabled'), 'ALTER TABLE projects ADD COLUMN order_enabled INTEGER NOT NULL DEFAULT 0'],
    [pc.includes('open_at'), 'ALTER TABLE projects ADD COLUMN open_at TEXT'],
    [pc.includes('order_max'), 'ALTER TABLE projects ADD COLUMN order_max INTEGER NOT NULL DEFAULT 10'],
    [pc.includes('order_pw_hash'), 'ALTER TABLE projects ADD COLUMN order_pw_hash TEXT'],
    [xc.includes('web'), 'ALTER TABLE products ADD COLUMN web INTEGER NOT NULL DEFAULT 1'],
    [rc.includes('source'), "ALTER TABLE reservations ADD COLUMN source TEXT NOT NULL DEFAULT 'csv'"],
    [rc.includes('contact'), "ALTER TABLE reservations ADD COLUMN contact TEXT NOT NULL DEFAULT ''"],
    [rc.includes('client_id'), 'ALTER TABLE reservations ADD COLUMN client_id TEXT'],
    [rc.includes('settle'), "ALTER TABLE reservations ADD COLUMN settle TEXT NOT NULL DEFAULT ''"],
    [rc.includes('member'), "ALTER TABLE reservations ADD COLUMN member TEXT NOT NULL DEFAULT ''"],
    [rc.includes('email'), "ALTER TABLE reservations ADD COLUMN email TEXT NOT NULL DEFAULT ''"],
    [rc.includes('collected_at'), 'ALTER TABLE reservations ADD COLUMN collected_at TEXT'],
  ]) if (!has) await addColumn(db, sql);
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS reservations_client_id ON reservations (client_id)').run();
  // 新しい環境では、空の公演を 1 つ作って「当日に使う」にする（何度実行しても 1 つだけ）
  const today = jstDay().date;
  await db.batch([
    db.prepare(`INSERT INTO projects (name, start_date, end_date, payments, created_at)
        SELECT '最初の公演', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM projects)`)
      .bind(today, today, JSON.stringify(DEFAULT_PAYMENTS), new Date().toISOString()),
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_project', (SELECT MIN(id) FROM projects)) ON CONFLICT(key) DO NOTHING"),
  ]);
  schemaReady = true;
}

/** 列の追加（同時に別のリクエストが追加済みでもエラーにしない） */
async function addColumn(db, sql) {
  try { await db.prepare(sql).run(); } catch (e) {
    if (!/duplicate column/i.test(String(e.message))) throw e;
  }
}

// ===== 公演 =====
function rowToProject(r) {
  let payments = null;
  try { payments = JSON.parse(r.payments || 'null'); } catch {}
  if (!Array.isArray(payments) || !payments.length) payments = [...DEFAULT_PAYMENTS];
  return {
    id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date,
    closedAt: r.closed_at || null, epoch: r.epoch, rev: r.rev, createdAt: r.created_at, payments,
    orderEnabled: !!r.order_enabled, openAt: r.open_at || null, orderMax: r.order_max || ORDER_MAX_DEFAULT, orderPassword: !!r.order_pw_hash,
  };
}

async function getProject(db, id) {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(Math.floor(Number(id)) || 0).first();
  return row ? rowToProject(row) : null;
}

async function activeProjectId(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'active_project'").first();
  return row ? Number(row.value) : 1;
}

/** レジ・受付で使う公演（管理画面で「当日に使う」にした公演） */
async function getActiveProject(db) {
  const p = await getProject(db, await activeProjectId(db));
  if (p) return p;
  const first = await db.prepare('SELECT * FROM projects ORDER BY id LIMIT 1').first();
  if (!first) throw httpError('公演がありません。管理画面で作ってください', 503);
  return rowToProject(first);
}

/** 管理画面の操作の対象の公演（?project= または X-Project。なければ当日に使う公演） */
async function projectFromRequest(db, request, url) {
  const id = url.searchParams.get('project') || request.headers.get('X-Project');
  if (!id) return getActiveProject(db);
  const p = await getProject(db, id);
  if (!p) throw httpError('公演が見つかりません', 404);
  return p;
}

/** 操作の記録に付ける公演の名前（例: ［第60回定期演奏会］） */
async function projectLabel(db, id) {
  const p = await getProject(db, id);
  return p ? `［${p.name}］` : '';
}

/** 画面に渡す公演の情報 */
const projectInfo = (P) => ({ id: P.id, name: P.name, startDate: P.startDate, endDate: P.endDate, payments: P.payments,
  openAt: P.openAt, openTime: P.openAt ? isoJst(P.openAt).slice(11, 16) : '', webOrder: webOrderInfo(P) });

/** ウェブ予約の状態。open: いま受け付けているか（受け付ける設定で、パスワードがあり、開場前） */
function webOrderInfo(P, now = Date.now()) {
  const before = P.openAt ? now < Date.parse(P.openAt) : false;
  return {
    enabled: P.orderEnabled, openAt: P.openAt, max: P.orderMax, password: P.orderPassword,
    open: P.orderEnabled && P.orderPassword && before,
    state: !P.orderEnabled ? 'off' : !P.orderPassword || !P.openAt ? 'incomplete' : before ? 'open' : 'closed',
  };
}

/** 支払方法の一覧を整える（1〜MAX_PAYMENTS 種類・重複なし・1 つ 20 文字まで） */
function parsePayments(v) {
  if (!Array.isArray(v)) throw httpError('支払方法が不正です', 400);
  const out = [];
  for (const x of v) {
    const n = cleanName(x).slice(0, 20);
    if (n && !out.includes(n)) out.push(n);
  }
  if (!out.length) throw httpError('支払方法を1つ以上選んでください', 400);
  if (out.length > MAX_PAYMENTS) throw httpError(`支払方法は${MAX_PAYMENTS}種類までです`, 400);
  return out;
}

/** 公演の入力（名前・期間）をチェックして整える */
function readProjectFields(body, base = {}) {
  const name = cleanName(body.name ?? base.name).slice(0, 40);
  if (!name) throw httpError('公演名を入力してください', 400);
  const date = (v, label) => {
    const s = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw httpError(`${label}を入力してください`, 400);
    return s;
  };
  const startDate = date(body.startDate ?? base.startDate, '公演日');
  const endDate = date(body.endDate ?? base.endDate ?? startDate, '最終日');
  if (endDate < startDate) throw httpError('最終日は公演日と同じか、それより後にしてください', 400);
  // 開場時刻（ウェブ予約の締め切り）。公演日のその時刻（日本時間）。空なら決めていない
  const openTime = String(body.openTime ?? (base.openAt ? isoJst(base.openAt).slice(11, 16) : '')).trim();
  if (openTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(openTime)) throw httpError('開場時刻は 18:00 のように入力してください', 400);
  const openAt = openTime ? new Date(`${startDate}T${openTime}:00+09:00`).toISOString() : null;
  return { name, startDate, endDate, openTime, openAt };
}

/** 公演の一覧（当日券の件数・売上、取り置きの件数つき） */
async function projectList(db) {
  const rows = (await db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM sales s WHERE s.project_id = p.id AND s.cancelled = 0) AS orders,
      (SELECT COALESCE(SUM(amount), 0) FROM sales s WHERE s.project_id = p.id AND s.cancelled = 0) AS total,
      (SELECT COUNT(*) FROM reservations r WHERE r.project_id = p.id) AS reservations,
      (SELECT COUNT(*) FROM products x WHERE x.project_id = p.id) AS products
    FROM projects p ORDER BY p.start_date DESC, p.id DESC`).all()).results;
  const active = await activeProjectId(db);
  return rows.map((r) => ({ ...projectInfo(rowToProject(r)), orders: r.orders, total: r.total, reservations: r.reservations, products: r.products, active: r.id === active }));
}

/**
 * 公演を作る。copyFrom があれば、その公演から選んだ設定（券種・価格 / 支払方法）を複製する。
 * 会計・取り置きは複製しない。
 */
async function createProject(db, body) {
  const f = readProjectFields(body);
  const copy = body.copy || {};
  const src = body.copyFrom ? await getProject(db, body.copyFrom) : null;
  if (body.copyFrom && !src) throw httpError('複製元の公演が見つかりません', 400);
  // 支払方法：複製するなら複製元と同じ、入力があればそれ、なければ 現金
  const payments = src && copy.payments ? src.payments : body.payments ? parsePayments(body.payments) : [...DEFAULT_PAYMENTS];
  const res = await db.prepare(`INSERT INTO projects (name, start_date, end_date, open_at, payments, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(f.name, f.startDate, f.endDate, f.openAt, JSON.stringify(payments), new Date().toISOString()).run();
  const id = res.meta.last_row_id;
  let copied = 0;
  if (src && copy.products) {
    const rows = (await db.prepare('SELECT * FROM products WHERE project_id = ? ORDER BY sort, id').bind(src.id).all()).results;
    // 券種を 1 つずつ複製して、新しい ID を控える（「○○のセットに含める」の相手を新しい ID に付け替えるため）
    const map = new Map();
    for (const r of rows) {
      const ins = await db.prepare(`INSERT INTO products (project_id, name, unit, sets, active, sort, bundle_with, web) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
        .bind(id, r.name, r.unit, r.sets, r.active, r.sort, r.web ?? 1).run();
      map.set(r.id, ins.meta.last_row_id);
    }
    const links = rows.filter((r) => r.bundle_with && map.has(r.bundle_with));
    if (links.length) await db.batch(links.map((r) => db.prepare('UPDATE products SET bundle_with = ? WHERE id = ?').bind(map.get(r.bundle_with), map.get(r.id))));
    copied = rows.length;
  }
  return { id, name: f.name, src, copied, copy };
}

// ===== 券種 =====
function rowToProduct(r) {
  return { id: r.id, name: r.name, unit: r.unit, sets: JSON.parse(r.sets), active: !!r.active, sort: r.sort, bundleWith: r.bundle_with || null, web: r.web !== 0 };
}

/** 公演の券種（並び順）。all = false なら販売中だけ */
async function getProducts(db, projectId, { all = false } = {}) {
  const rows = (await db.prepare(`SELECT * FROM products WHERE project_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, id`).bind(projectId).all()).results;
  return rows.map(rowToProduct);
}

function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(`${label}は${min}〜${max}の整数で入力してください`, 400);
  return n;
}

const productText = (p) => `${p.name}：` + p.sets.map((s) => `${s.qty}${p.unit}${s.price}円`).join('・') +
  (p.bundleWith ? `（${p.bundleName || '別の券種'}のセットに含める）` : '') + (p.active ? '' : '（販売停止）') + (p.web === false ? '（ウェブ予約に出さない）' : '');
function productDiff(a, b) {
  const t = productText(a), u = productText(b);
  return t === u ? u : `${t} → ${u}`;
}

async function saveProduct(db, P, body) {
  const name = cleanName(body.name).slice(0, 20);
  if (!name) throw httpError('券種名を入力してください', 400);
  const unit = cleanName(body.unit).slice(0, 4) || '枚';
  if (!Array.isArray(body.sets) || body.sets.length === 0) throw httpError('価格を1つ以上入力してください', 400);
  if (body.sets.length > 8) throw httpError('セットは8種類までです', 400);
  const sets = body.sets.map((x) => ({
    qty: intIn(x.qty, 1, 99, 'セットの枚数'),
    price: intIn(x.price, 0, 1000000, '価格'),
  })).sort((a, b) => a.qty - b.qty);
  if (new Set(sets.map((x) => x.qty)).size !== sets.length) throw httpError('同じ枚数のセットが重複しています', 400);
  if (sets[0].qty !== 1) throw httpError(`1${unit}の価格は必ず入力してください（どの枚数でも組めるようにするため）`, 400);
  const active = body.active === false ? 0 : 1;
  const web = body.web === false ? 0 : 1;
  const dup = await db.prepare('SELECT id FROM products WHERE project_id = ? AND name = ? AND id != ?').bind(P.id, name, Number(body.id) || 0).first();
  if (dup) throw httpError(`「${name}」という券種はすでにあります`, 400);
  // 「○○のセットに含める」：相手は自分以外で、相手自身はほかの券種のセットに含めていないこと（1 段だけ）
  let bundleWith = Number(body.bundleWith) || null;
  if (bundleWith) {
    const self = Number(body.id) || 0;
    if (bundleWith === self) throw httpError('自分自身のセットには含められません', 400);
    const leader = await db.prepare('SELECT id, name, sets, bundle_with FROM products WHERE id = ? AND project_id = ?').bind(bundleWith, P.id).first();
    if (!leader) throw httpError('セットに含める相手の券種が見つかりません', 400);
    if (leader.bundle_with) throw httpError(`「${leader.name}」はほかの券種のセットに含めているので、相手にできません`, 400);
    if (!JSON.parse(leader.sets).some((x) => x.qty > 1)) {
      throw httpError(`「${leader.name}」にはセット価格（2${unit}以上の価格）がないので、合わせて組む相手にできません`, 400);
    }
    if (self) {
      const followers = await db.prepare('SELECT name FROM products WHERE bundle_with = ?').bind(self).first();
      if (followers) throw httpError(`「${followers.name}」がこの券種のセットに含まれているので、この券種をほかのセットには含められません`, 400);
    }
  }

  let before = null;
  if (body.id) {
    const row = await db.prepare('SELECT * FROM products WHERE id = ? AND project_id = ?').bind(Number(body.id), P.id).first();
    if (!row) throw httpError('券種が見つかりません', 404);
    before = rowToProduct(row);
    await db.prepare('UPDATE products SET name = ?, unit = ?, sets = ?, active = ?, bundle_with = ?, web = ? WHERE id = ?')
      .bind(name, unit, JSON.stringify(sets), active, bundleWith, web, before.id).run();
  } else {
    const { m } = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM products WHERE project_id = ?').bind(P.id).first();
    await db.prepare('INSERT INTO products (project_id, name, unit, sets, active, sort, bundle_with, web) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(P.id, name, unit, JSON.stringify(sets), active, m + 1, bundleWith, web).run();
  }
  const leaderName = bundleWith ? (await db.prepare('SELECT name FROM products WHERE id = ?').bind(bundleWith).first()).name : null;
  if (before && before.bundleWith) before.bundleName = (await db.prepare('SELECT name FROM products WHERE id = ?').bind(before.bundleWith).first() || {}).name;
  return { before, after: { name, unit, sets, active: !!active, bundleWith, bundleName: leaderName, web: !!web } };
}

/** 会計の行に明細（items と説明文）を付ける */
async function attachItems(db, sales) {
  if (!sales.length) return sales;
  const ids = sales.map((x) => x.id);
  // D1 は 1 回の問い合わせに渡せる値が 100 個までなので、50 件ずつに分けて読む
  const items = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`)
      .bind(...chunk).all()).results;
    items.push(...rows);
  }
  return sales.map((x) => {
    const its = items.filter((i) => i.sale_id === x.id);
    return { ...x, items: its, desc: describeItems(its) };
  });
}

/** 取り置きの版（受付の画面の更新の確認用。取り込み・受け渡しのたびに 1 増える）。db.batch に入れて使う */
function bumpRev(db, projectId) {
  return db.prepare('UPDATE projects SET rev = rev + 1 WHERE id = ?').bind(projectId);
}

async function audit(db, actor, role, action, detail) {
  await db.prepare('INSERT INTO audit (at, actor, role, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), actor, role, action, detail || '').run();
}

/** 当日券の販売終了の状態（管理画面で設定）。null なら販売中 */
const closedOf = (P) => (P.closedAt ? { at: P.closedAt } : null);

/** ISO の日時を日本時間の日付（YYYY-MM-DD）に */
function jstDate(iso) {
  return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
}

/** 今日（日本時間）の日付と、その範囲（UTC の ISO 文字列） */
function jstDay() {
  const JST = 9 * 3600000;
  const nowJst = new Date(Date.now() + JST);
  const y = nowJst.getUTCFullYear(), m = nowJst.getUTCMonth(), d = nowJst.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - JST);
  return {
    date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + 86400000).toISOString(),
  };
}

/** 端末で操作した時刻（オフラインの操作を正しい時刻で残す）。不自然な値ならサーバーの時刻 */
function clientTime(v) {
  const now = Date.now();
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= now + 5 * 60000 && t >= now - 7 * 86400000 ? new Date(t).toISOString() : new Date(now).toISOString();
}

// ===== 集計 =====

/** 当日券の集計（レジ・管理画面で共通） */
async function salesSummary(db, P) {
  const t = await db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(units), 0) AS units
    FROM sales WHERE project_id = ? AND cancelled = 0`).bind(P.id).first();
  // 券種ごと（その時点の券種名で記録した明細を、券種 ID でまとめる）
  const rows = (await db.prepare(`SELECT si.product_id, MAX(si.name) AS name, MAX(si.unit) AS unit,
        SUM(si.set_qty * si.count) AS qty, SUM(si.set_price * si.count) AS amount
      FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.project_id = ? AND s.cancelled = 0
      GROUP BY si.product_id`).bind(P.id).all()).results;
  const products = await getProducts(db, P.id, { all: true });
  // 今の券種の並び順で、売れていない券種（販売中のもの）も 0 で表示する
  const byProduct = products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, qty: 0, amount: 0, active: p.active }));
  for (const r of rows) {
    let g = byProduct.find((b) => b.id === r.product_id);
    if (!g) { g = { id: r.product_id, name: r.name, unit: r.unit, qty: 0, amount: 0, active: false }; byProduct.push(g); }
    g.qty += r.qty;
    g.amount += r.amount;
  }
  const pays = (await db.prepare(`SELECT payment, COUNT(*) AS count, SUM(amount) AS amount
    FROM sales WHERE project_id = ? AND cancelled = 0 GROUP BY payment`).bind(P.id).all()).results;
  // 支払方法ごと：今の公演で使う支払方法（0 件でも）＋ 記録にだけある支払方法（途中で外したものなど）
  const byPayment = {};
  const payments = [...P.payments];
  P.payments.forEach((p) => (byPayment[p] = { amount: 0, count: 0 }));
  pays.forEach((r) => {
    if (!payments.includes(r.payment)) payments.push(r.payment);
    byPayment[r.payment] = { amount: r.amount, count: r.count };
  });
  return {
    total: t.total, orders: t.orders, units: t.units,
    byProduct: byProduct.filter((g) => g.qty || g.active),
    byPayment, payments,
  };
}

function rowToReservation(r) {
  let tickets = [];
  try { tickets = JSON.parse(r.tickets) || []; } catch {}
  return {
    id: r.id, no: r.res_no, name: r.name, kana: r.kana, tickets, qty: r.qty, amount: r.amount, ...settleOf(r),
    note: r.note, handedAt: r.handed_at || null, handedBy: r.handed_by || '',
    source: r.source || 'csv', contact: r.contact || '', createdAt: r.created_at,
    member: r.member || '', email: r.email || '', collectedAt: r.collected_at || null,
  };
}

/** 代金の払い方。due = 受付で受け取る額、memberDue = 終演後に団員から回収する額 */
function settleOf(r) {
  const settle = ['reception', 'member', 'paid'].includes(r.settle) ? r.settle : r.paid ? 'paid' : 'reception';
  return { settle, paid: settle === 'paid', due: settle === 'reception' ? r.amount : 0, memberDue: settle === 'member' ? r.amount : 0 };
}
const SETTLE_LABEL = { reception: '当日', member: '団員', paid: '済' };
/** 団員の名前をそろえる（全角・半角、空白のあるなしで別の人にしない） */
const memberKey = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');

async function getReservations(db, projectId) {
  const rows = (await db.prepare('SELECT * FROM reservations WHERE project_id = ? ORDER BY id').bind(projectId).all()).results;
  return rows.map(rowToReservation);
}

/** 取り置きの集計（件数・枚数・受け渡し済み・当日精算の受け取り） */
function reservationSummary(list) {
  const s = { count: 0, qty: 0, handed: 0, handedQty: 0, dueTotal: 0, collected: 0, uncollected: 0, web: 0, webQty: 0,
    memberTotal: 0, memberCollected: 0, memberUncollected: 0, byType: [] };
  const by = new Map();
  for (const r of list) {
    s.count++; s.qty += r.qty;
    if (r.source === 'web') { s.web++; s.webQty += r.qty; }
    if (r.handedAt) { s.handed++; s.handedQty += r.qty; }
    s.dueTotal += r.due;
    if (r.handedAt) s.collected += r.due; else s.uncollected += r.due;
    s.memberTotal += r.memberDue;
    if (r.collectedAt) s.memberCollected += r.memberDue; else s.memberUncollected += r.memberDue;
    for (const t of r.tickets) {
      const k = t.productId ? 'id:' + t.productId : 'name:' + t.name;
      const g = by.get(k) || { name: t.name, unit: t.unit || '枚', qty: 0, handedQty: 0 };
      g.qty += t.qty;
      if (r.handedAt) g.handedQty += t.qty;
      by.set(k, g);
    }
  }
  s.byType = [...by.values()];
  return s;
}

/** 団員ごとの精算（終演後に団員から回収する分）。団員の名前ごとにまとめる */
function memberSummary(list) {
  const by = new Map();
  for (const r of list) {
    if (r.settle !== 'member' && !r.member) continue;
    const k = memberKey(r.member) || '（団員の名前なし）';
    const g = by.get(k) || { key: k, member: r.member || '（団員の名前なし）', emails: [], count: 0, qty: 0, handedQty: 0, amount: 0, collected: 0, uncollected: 0, others: 0, lastCollectedAt: null };
    if (r.email && !g.emails.includes(r.email)) g.emails.push(r.email);
    g.count++; g.qty += r.qty;
    if (r.handedAt) g.handedQty += r.qty;
    if (r.settle === 'member') {
      g.amount += r.amount;
      if (r.collectedAt) { g.collected += r.amount; if (!g.lastCollectedAt || r.collectedAt > g.lastCollectedAt) g.lastCollectedAt = r.collectedAt; } else g.uncollected += r.amount;
    } else g.others++;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => a.member.localeCompare(b.member, 'ja'));
}

/** 当日の売上（当日券の売上＋取り置きの当日精算で受け取った額） */
async function summary(db, P) {
  const sales = await salesSummary(db, P);
  const reservations = reservationSummary(await getReservations(db, P.id));
  return {
    project: projectInfo(P),
    ...sales,
    reservations,
    grandTotal: sales.total + reservations.collected,
    products: await getProducts(db, P.id),   // レジに出す券種（販売中だけ）
    payMethods: P.payments,                   // レジのボタンに出す支払方法
    closed: closedOf(P),                       // 当日券の販売終了中なら { at }
    updatedAt: new Date().toISOString(),
  };
}

async function recentAudit(db, limit) {
  return (await db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all()).results;
}

/** 会計一覧（新しい順・ページ送り）。取消済みも含む */
async function salesPage(db, P, params) {
  const limit = Math.min(100, Math.max(1, Math.floor(Number(params.get('limit')) || 50)));
  const before = Math.floor(Number(params.get('before')) || 0);
  const rows = (before > 0
    ? await db.prepare('SELECT * FROM sales WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?').bind(P.id, before, limit + 1).all()
    : await db.prepare('SELECT * FROM sales WHERE project_id = ? ORDER BY id DESC LIMIT ?').bind(P.id, limit + 1).all()).results;
  const counts = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(cancelled), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS amount FROM sales WHERE project_id = ?`).bind(P.id).first();
  return { project: projectInfo(P), sales: await attachItems(db, rows.slice(0, limit)), hasMore: rows.length > limit, ...counts };
}

async function registerData(db, sess) {
  const P = await getActiveProject(db);
  const recent = await db.prepare('SELECT * FROM sales WHERE project_id = ? ORDER BY id DESC LIMIT 5').bind(P.id).all();
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM sales WHERE project_id = ?').bind(P.id).first();
  return {
    ...(await summary(db, P)),
    recent: await attachItems(db, recent.results),
    salesCount: n,
    epoch: P.epoch,
    audit: await recentAudit(db, 30),
    me: { staff: sess.staff, expiresAt: sess.expires_at },
  };
}

/**
 * 受付の画面のデータ：当日に使う公演の取り置き全件。
 * 端末が持っている rev と公演が今と同じなら、一覧は返さない（数秒ごとに読まれるので軽くする）。
 */
async function receptionData(db, P, params) {
  if (params.get('project') === String(P.id) && params.get('rev') === String(P.rev)) return { rev: P.rev, same: true };
  return {
    rev: P.rev, project: projectInfo(P),
    reservations: await getReservations(db, P.id),
    products: (await getProducts(db, P.id, { all: true })).map((p) => ({ id: p.id, name: p.name, unit: p.unit })),
  };
}

async function masterData(db, sess, P) {
  const sessions = await db.prepare(`SELECT id, role, staff, device, created_at, last_seen, expires_at FROM sessions
      WHERE revoked = 0 AND expires_at > ? ORDER BY role, last_seen DESC`).bind(new Date().toISOString()).all();
  const pw = await db.prepare("SELECT key FROM settings WHERE key IN ('register_pw_hash', 'master_pw_hash')").all();
  const changed = pw.results.map((r) => r.key);
  const locks = await db.prepare(`SELECT role, COUNT(*) AS n FROM login_failures WHERE at > ? GROUP BY ip, role HAVING n >= ?`)
    .bind(new Date(Date.now() - LOCK_MINUTES * 60000).toISOString(), MAX_FAILS).all();
  return {
    ...(await summary(db, P)),
    reservationList: await getReservations(db, P.id),
    members: memberSummary(await getReservations(db, P.id)),
    projects: await projectList(db),
    projectSettings: { ...projectInfo(P), active: P.id === await activeProjectId(db) },
    sessions: sessions.results.map((s) => ({ ...s, current: s.id === sess.id })),
    audit: await recentAudit(db, 200),
    passwords: {
      registerChanged: changed.includes('register_pw_hash'),
      masterChanged: changed.includes('master_pw_hash'),
    },
    locked: locks.results.map((l) => ROLES[l.role].label),
    allProducts: await getProducts(db, P.id, { all: true }),
    allSales: await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cancelled), 0) AS cancelled FROM sales WHERE project_id = ?').bind(P.id).first(),
    me: { expiresAt: sess.expires_at },
  };
}

// ===== 当日券の会計 =====
async function recordSale(db, body, staff) {
  // 会計した時点の公演（オフラインで打った会計は、そのあと公演が切り替わっても元の公演に記録する）
  const P = body.projectId != null ? await getProject(db, body.projectId) : await getActiveProject(db);
  if (!P) throw httpError('この会計の公演が見つかりません（管理画面で削除された可能性があります）', 409);
  // 支払方法：その公演の支払方法のどれか。オフラインで打ったあとに管理画面で外された支払方法は、
  // お客さんからはもう受け取っているので記録し、操作の記録に残す（明細つきの画面から届いたときだけ）
  const payment = cleanName(body.payment).slice(0, 20);
  if (!payment) throw httpError('支払方法が不正です', 400);
  const paymentOff = !P.payments.includes(payment);
  if (paymentOff && !Array.isArray(body.lines)) throw httpError('この公演では使わない支払方法です。画面を更新してください', 409);
  // 販売終了後に打った会計は受け付けない（終了前に端末で打って、あとから届いた未送信の会計は受け付ける）
  const closed = closedOf(P);
  if (closed) {
    const t = Date.parse(body.createdAt);
    if (!Number.isFinite(t) || t >= Date.parse(closed.at)) throw httpError('当日券の販売は終了しました。会計は記録できません', 423);
  }
  const clientId = body.clientId == null ? null : String(body.clientId).slice(0, 64);
  if (clientId && !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw httpError('会計IDが不正です', 400);
  // 売上記録の全リセットより前に端末で打った会計は捨てる（リセットした記録を復活させない）
  if (body.epoch != null && Number(body.epoch) !== P.epoch) return { stale: true };
  // 同じ会計ID がすでにあれば何もしない（再送による二重登録の防止）
  if (clientId && await db.prepare('SELECT id FROM sales WHERE client_id = ?').bind(clientId).first()) return { duplicate: true };

  const snapshot = Array.isArray(body.lines) ? body.lines : null;   // 端末で計算した明細（オフライン対応の画面が送る）
  const all = await getProducts(db, P.id, { all: true });
  // 枚数からお客さんに有利なセットをサーバー側で組み直す（画面側の計算は信用しない）
  const cart = {};
  let unknown = false;
  for (const [pid, q] of Object.entries(body.items || {})) {
    const n = Math.floor(Number(q) || 0);
    if (n <= 0) continue;
    if (n > MAX_QTY) throw httpError(`1つの券種は一度に${MAX_QTY}枚までです`, 400);
    const p = all.find((x) => String(x.id) === String(pid));
    if (!p || (!p.active && !snapshot)) {
      if (!snapshot) throw httpError('販売していない券種が含まれています。画面を更新しました', 409);
      unknown = true;
    }
    cart[pid] = n;
  }
  let priced = null;
  if (!unknown) {
    // レジの画面と同じく「販売中の券種＋この会計に入っている券種」で組む（販売停止の相手とはまとめない）
    try { priced = priceCart(all.filter((p) => p.active || cart[p.id]), cart); } catch (e) { if (!snapshot) throw httpError(e.message, 400); }
  }
  if (priced && !priced.lines.length) throw httpError('券種が選択されていません', 400);

  // 端末で表示・会計した内容が、今の価格と違うとき
  //   - 明細なしの画面: 記録せず 409 で確認を求める
  //   - オフライン対応の画面（明細あり）: お客さんから受け取った金額で記録し、操作の記録に残す
  let lines, goods, units, mismatch = false;
  const sameAsServer = priced && snapshot && sameLines(priced, snapshot);
  if (priced && (!snapshot || sameAsServer)) {
    if (!snapshot && body.expectedGoods != null && Number(body.expectedGoods) !== priced.goods) {
      throw httpError('価格が変更されています。画面を更新したので、金額を確認してもう一度記録してください', 409);
    }
    lines = priced.lines;
    goods = priced.goods; units = priced.units;
  } else {
    lines = validateSnapshot(snapshot);
    goods = lines.reduce((a, l) => a + l.packs.reduce((b, k) => b + k.price * k.count, 0), 0);
    units = lines.reduce((a, l) => a + l.packs.reduce((b, k) => b + k.qty * k.count, 0), 0);
    mismatch = true;
  }

  const createdAt = clientTime(body.createdAt);   // 端末で会計した時刻（オフライン中の会計を正しい時刻で残す）
  const cid = clientId || 'srv-' + b64url(crypto.getRandomValues(new Uint8Array(12)));
  // 会計と明細を 1 つのトランザクションで書く（明細は client_id で会計を引く）
  // 会計番号（order_no）は公演ごとに 1 から。1 つの INSERT の中で決めるので、同時に届いても重ならない
  const stmts = [db.prepare(`INSERT INTO sales (project_id, order_no, created_at, units, amount, payment, staff, client_id)
      VALUES (?, (SELECT COALESCE(MAX(order_no), 0) + 1 FROM sales WHERE project_id = ?), ?, ?, ?, ?, ?, ?)`)
    .bind(P.id, P.id, createdAt, units, goods, payment, staff, cid)];
  const items = itemsFromLines(lines);
  for (const it of items) {
    stmts.push(db.prepare(`INSERT INTO sale_items (sale_id, product_id, name, unit, set_qty, set_price, count, pack_label)
        VALUES ((SELECT id FROM sales WHERE client_id = ?), ?, ?, ?, ?, ?, ?, ?)`)
      .bind(cid, it.product_id, it.name, it.unit, it.set_qty, it.set_price, it.count, it.pack_label));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    // 同じ会計ID が同時に届いた（もう一方が先に記録済み）
    if (clientId && /UNIQUE/i.test(String(e.message))) return { duplicate: true };
    throw e;
  }
  if (paymentOff) {
    await audit(db, staff, 'register', '今は使っていない支払方法で記録', `［${P.name}］${payment} ${yen(goods)}（端末で会計した支払方法のまま）`);
  }
  if (mismatch) {
    await audit(db, staff, 'register', '今の価格と違う会計を記録', `［${P.name}］${describeItems(items)} ${yen(goods)}（端末で会計した金額のまま）`);
  }
  return { duplicate: false };
}

function sameLines(priced, snapshot) {
  // セットの組み方と、券種ごとの枚数（混ぜたセットの内訳）が同じか
  const norm = (ls) => JSON.stringify(ls.map((l) => [
    String(l.productId),
    l.packs.map((k) => [Number(k.qty), Number(k.price), Number(k.count)]),
    (l.members || []).map((m) => [String(m.productId), Number(m.qty)]).sort(),
  ]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return norm(priced.lines.map((l) => ({ productId: l.product.id, packs: l.packs, members: l.members.map((m) => ({ productId: m.product.id, qty: m.qty })) })))
    === norm(snapshot.map((l) => ({ productId: l.productId, packs: l.packs || [], members: l.members || [{ productId: l.productId, qty: (l.packs || []).reduce((a, k) => a + k.qty * k.count, 0) }] })));
}

/** 端末から送られた明細の形と値をチェック */
function validateSnapshot(snapshot) {
  if (!snapshot || !snapshot.length || snapshot.length > 20) throw httpError('会計の明細が不正です', 400);
  return snapshot.map((l) => {
    const name = cleanName(l.name).slice(0, 20);
    if (!name || !Array.isArray(l.packs) || !l.packs.length || l.packs.length > 8) throw httpError('会計の明細が不正です', 400);
    const packs = l.packs.map((k) => ({
      qty: intIn(k.qty, 1, 99, 'セットの枚数'),
      price: intIn(k.price, 0, 1000000, '価格'),
      count: intIn(k.count, 1, MAX_QTY, '個数'),
    }));
    const product = { id: Math.max(0, Math.floor(Number(l.productId) || 0)), name, unit: cleanName(l.unit).slice(0, 4) || '枚' };
    const total = packs.reduce((a, k) => a + k.qty * k.count, 0);
    // 混ぜたセットの内訳（券種ごとの枚数）。合計がセットの枚数と合わなければ不正
    let members = [{ product, qty: total }];
    if (Array.isArray(l.members) && l.members.length) {
      if (l.members.length > 8) throw httpError('会計の明細が不正です', 400);
      members = l.members.map((m) => ({
        product: { id: Math.max(0, Math.floor(Number(m.productId) || 0)), name: cleanName(m.name).slice(0, 20) || name, unit: cleanName(m.unit).slice(0, 4) || product.unit },
        qty: intIn(m.qty, 1, MAX_QTY, '枚数'),
      }));
      if (members.reduce((a, m) => a + m.qty, 0) !== total) throw httpError('会計の明細が不正です', 400);
    }
    return { product, packs, members };
  });
}

// ===== 取り置きの CSV の取り込み（様式は docs/reservation-csv.md） =====

/** CSV（RFC 4180）を行の配列に。BOM・CRLF・引用符の中の改行とカンマに対応 */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 見出しの言い方の揺れ（全角・半角、空白は無視して比べる）
const RES_COLUMNS = {
  no: ['番号', '受付番号', '予約番号', '整理番号', '取り置き番号', '取置番号', 'no', 'no.', 'id'],
  name: ['氏名', '名前', 'お名前', '予約者', '予約者名', '代表者', '代表者名', 'name'],
  kana: ['フリガナ', 'ふりがな', 'カナ', 'かな', 'よみがな', 'ヨミガナ', 'よみ', '読み', '氏名(フリガナ)', 'お名前(フリガナ)', '氏名(ふりがな)', 'お名前(ふりがな)'],
  type: ['券種', 'チケット', 'チケットの種類', '種類', '席種', '券の種類'],
  qty: ['枚数', '数', '数量', '人数', '予約枚数'],
  pay: ['支払', '支払い', '支払状況', '支払い状況', '精算', '入金', '入金状況', '支払済', '支払い済み'],
  amount: ['金額', '代金', '料金', 'チケット代', '金額(円)', '代金(円)', '料金(円)'],
  note: ['備考', 'メモ', '連絡事項', 'コメント', 'note'],
  contact: ['連絡先', '電話', '電話番号', 'tel'],
  member: ['団員', '団員氏名', '団員名', '団員の名前', '紹介者', '担当団員', '招待者', '予約した団員'],
  email: ['団員のメール', '団員のメールアドレス', 'メール', 'メールアドレス', 'email', 'e-mail'],
};
// 書き出した CSV（reservations.csv）にだけある列。取り込むときは黙って読み飛ばす
const RES_EXPORT_ONLY = ['枚数計', '受付で受け取る額(円)', '受け取った額(円)', '受け渡し', '受け渡し日時', '受け渡した人', '受付方法', '申込日時', '団員から回収'];
const MEMBER_WORDS = ['団員', '団員精算', '団員払い', '団員から', '団員から回収', '終演後', '終演後精算'];
const PAID_WORDS = ['済', '済み', '支払済', '支払済み', '支払い済み', '振込済', '振込済み', '入金済', '入金済み', '前払い', '前払', '事前', 'paid', 'yes', '1', '○', '〇', '✓', 'true'];
const UNPAID_WORDS = ['', '当日', '当日精算', '当日払い', '未', '未払い', '未払', '未入金', '受付で', '受付', 'no', '0', '×', 'false', '-'];

const normHead = (h) => String(h || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const stripUnit = (h) => h.replace(/\((枚|円|人|名|件)\)$/, '');

/**
 * CSV を読んで、取り込みの計画（何を新しく作り、何を更新し、何を消すか）と確認用の結果を作る。
 * mode: 'append'（追加・更新。CSV にない取り置きはそのまま）/ 'replace'（置き換え。CSV にない取り置きは消す）
 * 同じ番号の取り置きは、受け渡しの記録を残したまま内容だけ更新する。
 */
async function planImport(db, P, csv, mode) {
  const errors = [], warnings = [];
  const products = await getProducts(db, P.id, { all: true });
  const err = (line, message) => { if (errors.length < 100) errors.push({ line, message }); };
  const rows = parseCsv(csv);
  // 見出しの行（最初の空でない行）
  let h = rows.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (h < 0) throw httpError('CSV が空です', 400);
  const head = rows[h].map(normHead);
  const col = {};
  for (const [key, names] of Object.entries(RES_COLUMNS)) {
    const set = names.map(normHead);
    let i = head.findIndex((x) => set.includes(x));
    if (i < 0) i = head.findIndex((x) => set.includes(stripUnit(x)));
    if (i >= 0) col[key] = i;
  }
  // 券種ごとの列（見出しが券種名。例: 「一般」「学生(枚)」）
  const used = new Set(Object.values(col));
  const wide = [];
  head.forEach((x, i) => {
    if (used.has(i) || !x) return;
    const p = products.find((pp) => normHead(pp.name) === x || normHead(pp.name) === stripUnit(x));
    if (p) { wide.push({ i, p }); used.add(i); }
  });
  const ignoredHeads = rows[h].filter((x, i) => !used.has(i) && x.trim() !== '' && !RES_EXPORT_ONLY.map(normHead).includes(normHead(x)));
  if (ignoredHeads.length) warnings.push(`使わない列があります：${ignoredHeads.join('、')}（券種の列のつもりなら、管理画面の券種名と同じ名前にしてください）`);
  if (col.name == null) err(h + 1, '「氏名」の列がありません（見出しの行に「氏名」と書いてください）');
  if (col.type == null && !wide.length && products.length !== 1) {
    err(h + 1, products.length ? '「券種」の列がありません（券種が 2 つ以上あるときは「券種」と「枚数」の列か、券種名の列が必要です）' : '券種がまだありません。先に「券種・価格」で券種を登録してください');
  }
  if (errors.length) return { preview: { errors, warnings, counts: { rows: 0, created: 0, updated: 0, unchanged: 0, removed: 0, removedHanded: 0 }, items: [] } };

  const cell = (r, i) => (i == null ? '' : String(r[i] ?? '').trim());
  const findType = (name) => {
    const n = normHead(name);
    return products.find((p) => normHead(p.name) === n);
  };
  const toInt = (v) => {
    const s = String(v).normalize('NFKC').replace(/[,¥￥円枚\s]/g, '');
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };

  // 1 行ずつ読む。同じ番号の行は 1 件にまとめる（券種ごとに 1 行ずつ書く書き方に対応）
  const byNo = new Map();
  const list = [];
  for (let k = h + 1; k < rows.length; k++) {
    const r = rows[k];
    const line = k + 1;
    if (!r.some((c) => String(c).trim() !== '')) continue;   // 空の行
    const no = cleanName(cell(r, col.no)).slice(0, 20);
    const name = cleanName(cell(r, col.name)).slice(0, 40);
    if (!name) { err(line, '氏名が空です'); continue; }
    const tickets = new Map();
    const addTicket = (p, q) => {
      const t = tickets.get(p.id) || { productId: p.id, name: p.name, unit: p.unit, qty: 0 };
      t.qty += q;
      tickets.set(p.id, t);
    };
    let ok = true;
    if (col.type != null || (!wide.length && products.length === 1)) {
      const tname = cell(r, col.type);
      const qs = cell(r, col.qty);
      const q = qs === '' ? 1 : toInt(qs);
      if (tname || col.type == null || qs) {
        const p = col.type == null || (!tname && products.length === 1) ? products[0] : findType(tname);
        if (!p) { err(line, `券種「${tname}」は登録されていません（登録済み：${products.map((x) => x.name).join('・') || 'なし'}）`); ok = false; }
        else if (!(q >= 1 && q <= MAX_QTY)) { err(line, `枚数「${qs}」が不正です（1〜${MAX_QTY}の整数）`); ok = false; }
        else addTicket(p, q);
      }
    }
    for (const w of wide) {
      const v = cell(r, w.i);
      if (v === '') continue;
      const q = toInt(v);
      if (!(q >= 0 && q <= MAX_QTY)) { err(line, `「${w.p.name}」の枚数「${v}」が不正です`); ok = false; continue; }
      if (q > 0) addTicket(w.p, q);
    }
    const payRaw = cell(r, col.pay).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const member = cleanName(cell(r, col.member)).normalize('NFKC').replace(/\s+/g, ' ').slice(0, 40);
    // 支払：済 → 支払済み、団員 → 終演後に団員から回収、当日 → 受付で受け取る。空欄は、団員の名前があれば団員から、なければ当日
    let settle;
    if (PAID_WORDS.includes(payRaw) || /^(支払|振込|入金)?済/.test(payRaw)) settle = 'paid';
    else if (MEMBER_WORDS.includes(payRaw) || /^団員/.test(payRaw)) settle = 'member';
    else if (payRaw === '') settle = member ? 'member' : 'reception';
    else if (UNPAID_WORDS.includes(payRaw) || /^当日/.test(payRaw) || /^未/.test(payRaw)) settle = 'reception';
    else { err(line, `支払「${cell(r, col.pay)}」が読めません（「済」「当日」「団員」のどれかを書いてください）`); ok = false; }
    const amountRaw = cell(r, col.amount);
    let amount = null;
    if (amountRaw !== '') {
      amount = toInt(amountRaw);
      if (!(amount >= 0 && amount <= 10000000)) { err(line, `金額「${amountRaw}」が不正です`); ok = false; }
    }
    if (!ok) continue;
    const note = String(cell(r, col.note)).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, 200);
    const kana = cleanName(cell(r, col.kana)).slice(0, 40);
    const contact = cleanName(cell(r, col.contact)).slice(0, 100);
    const email = cleanName(cell(r, col.email)).slice(0, 100);
    const rec = no && byNo.get(no);
    if (rec) {
      // 同じ番号の 2 行目以降：券種を足す
      if (rec.name !== name) { err(line, `番号「${no}」が別の人（${rec.name}）と重なっています`); continue; }
      if (rec.settle !== settle) { err(line, `番号「${no}」の行で支払（済／当日／団員）が食い違っています`); continue; }
      for (const t of tickets.values()) {
        const x = rec.tickets.get(t.productId);
        if (x) x.qty += t.qty; else rec.tickets.set(t.productId, t);
      }
      if (amount != null) rec.amount = (rec.amount || 0) + amount;
      if (note && !rec.note.includes(note)) rec.note = rec.note ? rec.note + '／' + note : note;
      if (kana && !rec.kana) rec.kana = kana;
      continue;
    }
    const item = { line, no, name, kana, tickets, settle, amount, note, contact, member, email };
    list.push(item);
    if (no) byNo.set(no, item);
  }

  // 券種・枚数・金額を決める
  for (const it of list) {
    it.tickets = [...it.tickets.values()].filter((t) => t.qty > 0)
      .sort((a, b) => products.findIndex((p) => p.id === a.productId) - products.findIndex((p) => p.id === b.productId));
    it.qty = it.tickets.reduce((a, t) => a + t.qty, 0);
    if (!it.qty) { err(it.line, `${it.name}：券種と枚数がありません`); continue; }
    if (it.amount == null) {
      const cart = {};
      it.tickets.forEach((t) => (cart[t.productId] = t.qty));
      try { it.amount = priceCart(products, cart).total; } catch (e) { err(it.line, `${it.name}：${e.message}`); }
    }
  }
  if (list.length > MAX_RESERVATIONS) err(h + 1, `取り置きは 1 公演 ${MAX_RESERVATIONS} 件までです`);

  // 既存の取り置きと突き合わせる（番号が同じなら同じ取り置き）
  const existing = (await db.prepare('SELECT * FROM reservations WHERE project_id = ?').bind(P.id).all()).results;
  const exByNo = new Map(existing.map((r) => [r.res_no, r]));
  // 番号のない行には番号を付ける（今ある番号の続きの数字）
  const numOf = (s) => (/^\d+$/.test(s) ? Number(s) : 0);
  let next = Math.max(0, ...list.map((x) => numOf(x.no)), ...(mode === 'append' ? existing.map((r) => numOf(r.res_no)) : [])) + 1;
  const taken = new Set([...list.map((x) => x.no).filter(Boolean), ...(mode === 'append' ? existing.map((r) => r.res_no) : [])]);
  for (const it of list) {
    if (it.no) continue;
    while (taken.has(String(next))) next++;
    it.no = String(next++);
    it.autoNo = true;
    taken.add(it.no);
  }
  const counts = { rows: list.length, created: 0, updated: 0, unchanged: 0, removed: 0, removedHanded: 0 };
  const sig = (x) => JSON.stringify([x.name, x.kana, x.tickets.map((t) => [t.productId, t.qty]), x.qty, x.amount, x.settle, x.note, x.contact || '', x.member || '', x.email || '']);
  for (const it of list) {
    const ex = exByNo.get(it.no);
    if (!ex) { it.status = 'new'; counts.created++; continue; }
    it.existingId = ex.id;
    const old = rowToReservation(ex);
    it.handedAt = old.handedAt;
    // CSV に列がない項目（フリガナ・備考）は、今の値を残す
    if (col.kana == null) it.kana = old.kana;
    if (col.note == null) it.note = old.note;
    if (col.contact == null) it.contact = old.contact;
    if (col.member == null) it.member = old.member;
    if (col.email == null) it.email = old.email;
    // 支払の列がなく、団員の名前を残したときは、今の払い方のまま
    if (col.pay == null) it.settle = old.settle;
    if (sig(it) === sig({ ...old, tickets: old.tickets })) { it.status = 'same'; counts.unchanged++; }
    else { it.status = 'update'; counts.updated++; }
  }
  const inFile = new Set(list.map((x) => x.no));
  // 置き換えでも、ウェブで受け付けた取り置きは消さない（CSV で取り込んだものだけを置き換える）
  const toRemove = mode === 'replace' ? existing.filter((r) => !inFile.has(r.res_no) && (r.source || 'csv') !== 'web') : [];
  const keptWeb = mode === 'replace' ? existing.filter((r) => !inFile.has(r.res_no) && r.source === 'web').length : 0;
  if (keptWeb) warnings.push(`ウェブで受け付けた取り置き ${keptWeb} 件は、CSV になくても残します`);
  counts.removed = toRemove.length;
  counts.removedHanded = toRemove.filter((r) => r.handed_at).length;
  if (counts.removedHanded) warnings.push(`受け渡し済みの取り置き ${counts.removedHanded} 件が CSV にないため、受け渡しの記録ごと消えます`);
  if (list.some((x) => x.autoNo)) warnings.push('番号のない行には、番号を自動で付けます（あとで同じ CSV を取り込み直すと、別の取り置きとして増えるので、番号を付けておくのがおすすめです）');

  const items = list.map((x) => ({
    line: x.line, no: x.no, autoNo: !!x.autoNo, name: x.name, kana: x.kana, tickets: x.tickets, ticketsText: describeTickets(x.tickets),
    qty: x.qty, amount: x.amount, settle: x.settle, paid: x.settle === 'paid', due: x.settle === 'reception' ? x.amount : 0, memberDue: x.settle === 'member' ? x.amount : 0,
    member: x.member, note: x.note, status: x.status, handed: !!x.handedAt,
  }));
  return {
    list, toRemove,
    preview: {
      errors, warnings, counts, items,
      removedItems: toRemove.slice(0, 50).map((r) => ({ no: r.res_no, name: r.name, handed: !!r.handed_at })),
      totals: { qty: items.reduce((a, x) => a + x.qty, 0), due: items.reduce((a, x) => a + x.due, 0), memberDue: items.reduce((a, x) => a + x.memberDue, 0) },
    },
  };
}

async function applyImport(db, P, plan) {
  const now = new Date().toISOString();
  const stmts = [];
  for (const it of plan.list) {
    const tickets = JSON.stringify(it.tickets);
    if (it.status === 'new') {
      stmts.push(db.prepare(`INSERT INTO reservations (project_id, res_no, name, kana, tickets, qty, amount, paid, settle, note, contact, member, email, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(P.id, it.no, it.name, it.kana, tickets, it.qty, it.amount, it.settle === 'paid' ? 1 : 0, it.settle, it.note, it.contact || '', it.member || '', it.email || '', now, now));
    } else if (it.status === 'update') {
      // 受け渡しの記録（handed_at / handed_by）は残す
      stmts.push(db.prepare('UPDATE reservations SET name = ?, kana = ?, tickets = ?, qty = ?, amount = ?, paid = ?, settle = ?, note = ?, contact = ?, member = ?, email = ?, updated_at = ? WHERE id = ?')
        .bind(it.name, it.kana, tickets, it.qty, it.amount, it.settle === 'paid' ? 1 : 0, it.settle, it.note, it.contact || '', it.member || '', it.email || '', now, it.existingId));
    }
  }
  for (const r of plan.toRemove) stmts.push(db.prepare('DELETE FROM reservations WHERE id = ?').bind(r.id));
  stmts.push(bumpRev(db, P.id));
  // D1 の 1 回のまとめ書きは大きすぎないように分ける（rev の更新は最後のまとまりに入る）
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
}

// ===== ウェブの取り置き予約（/order） =====
// 出演者（団員）が、知り合いにチケットを事前に渡せないときに使う。
//   1. 団員のメールアドレスと、事前に渡した取り置き専用パスワードで認証（間違いが続くとしばらく止める）
//   2. 団員氏名を入れ、お客さん 1 組ごとのカード（氏名はカタカナのセイ・メイ、券種と枚数、備考）を必要なだけ足して、まとめて予約
//   代金はいつも、終演後に団員からまとめて回収する（settle = member。受付ではお客さんから受け取らない）
//   3. 予約したら控えを表示。メールの送信サービス（Resend）の設定があれば、団員のメールアドレスに控えを送る
// ログインはしない。予約のたびにパスワードを確かめる。
// 受け付けるのは「当日に使う」公演で、ウェブ予約を受け付ける設定にしてあり、開場時刻より前のときだけ。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_GUESTS = 10;   // 1 回にまとめて予約できるお客さんの組の数
/** カタカナにそろえる（ひらがな・半角カナ・全角英数を直し、空白を取る） */
const toKatakana = (s) => String(s || '').normalize('NFKC').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/\s+/g, '');
const KATAKANA_RE = /^[ァ-ー]+$/;   // ァ〜ヺ・ー（中黒も可）

async function orderApi(request, env, url, route, ctx) {
  const db = env.DB;
  const P = await getActiveProject(db);
  const info = webOrderInfo(P);
  const pub = () => ({ project: { id: P.id, name: P.name, startDate: P.startDate }, open: info.open, state: info.state, openAt: P.openAt, max: P.orderMax, maxGuests: MAX_GUESTS, mail: mailConfigured(env) });

  // 予約のページを開いたとき（公演名と、受け付けているかどうかだけ。券種と価格は認証のあと）
  if (route === 'GET /api/order/status') return json(pub());

  const body = await readJson(request);
  if (!info.open) {
    throw httpError(info.state === 'closed' ? 'ウェブでの取り置きの受け付けは締め切りました（開場時刻を過ぎました）' : 'いまはウェブでの取り置きを受け付けていません', 403);
  }
  const email = String(body.email || '').trim().normalize('NFKC').toLowerCase().slice(0, 100);
  if (!EMAIL_RE.test(email)) throw httpError('メールアドレスを正しく入力してください', 400);
  const row = await db.prepare('SELECT order_pw_hash FROM projects WHERE id = ?').bind(P.id).first();
  await login(request, env, 'order', body.password, '取り置き専用パスワードが違います', (pw) => verifyHash(pw, row.order_pw_hash));
  const products = (await getProducts(db, P.id, { all: true })).filter((p) => p.web);

  if (route === 'POST /api/order/unlock') {
    return json({ ...pub(), email, products: products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, sets: p.sets, bundleWith: p.bundleWith })) });
  }
  if (route !== 'POST /api/order') return json({ error: 'Not Found' }, 404);

  if (body.projectId != null && Number(body.projectId) !== P.id) throw httpError('受け付ける公演が変わりました。ページを開き直してください', 409);
  // 同じ予約を 2 回送った（通信が切れて送り直したなど）：1 回分として扱い、最初の予約を返す
  // （お客さんごとの会計ID は「送信の ID-番号」）
  const clientId = String(body.clientId || '');
  if (!/^[A-Za-z0-9_-]{8,60}$/.test(clientId)) throw httpError('リクエストが不正です。ページを開き直してください', 400);
  const already = async () => (await db.prepare("SELECT * FROM reservations WHERE client_id = ? OR client_id GLOB ? ORDER BY id").bind(clientId, clientId + '-*').all()).results;
  const dup = await already();
  if (dup.length) return json({ ok: true, duplicate: true, reservations: dup.map((r) => orderReceipt(rowToReservation(r), P)), mailed: false });

  const member = cleanName(body.member).normalize('NFKC').replace(/\s+/g, ' ').slice(0, 40);
  if (!member) throw httpError('団員氏名を入力してください', 400);
  // 前の版の形（お客さん 1 組だけ）も受け付ける
  const sent = Array.isArray(body.guests) ? body.guests : [{ sei: body.sei, mei: body.mei, items: body.items, note: body.note }];
  if (!sent.length) throw httpError('お客さんを 1 組以上入れてください', 400);
  if (sent.length > MAX_GUESTS) throw httpError(`1回にまとめて予約できるのは${MAX_GUESTS}組までです`, 400);
  const guests = sent.map((g, i) => {
    const who = sent.length > 1 ? `${i + 1}組目のお客さん：` : '';
    const sei = toKatakana(g && g.sei), mei = toKatakana(g && g.mei);
    if (!sei || !mei) throw httpError(`${who}氏名（セイ・メイ）をカタカナで入力してください`, 400);
    if (!KATAKANA_RE.test(sei) || !KATAKANA_RE.test(mei)) throw httpError(`${who}氏名はカタカナだけで入力してください（漢字・英字・記号は使えません）`, 400);
    if (sei.length + mei.length > 30) throw httpError(`${who}氏名が長すぎます`, 400);
    const items = (g && g.items) || {};
    for (const k of Object.keys(items)) {
      if (Number(items[k]) > 0 && !products.some((p) => String(p.id) === String(k))) throw httpError('受け付けていない券種が含まれています。ページを開き直してください', 409);
    }
    const cart = {}, tickets = [];
    for (const p of products) {
      const q = Math.floor(Number(items[p.id]) || 0);
      if (q < 0 || q > MAX_QTY) throw httpError(`${who}枚数が不正です`, 400);
      if (q > 0) { cart[p.id] = q; tickets.push({ productId: p.id, name: p.name, unit: p.unit, qty: q }); }
    }
    const qty = tickets.reduce((a, t) => a + t.qty, 0);
    if (!qty) throw httpError(`${who}券種と枚数を選んでください`, 400);
    if (qty > P.orderMax) throw httpError(`${who}1組あたり${P.orderMax}枚までです`, 400);
    let amount;
    try { amount = priceCart(products, cart).total; } catch (e) { throw httpError(e.message, 400); }
    const note = String((g && g.note) || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 200);
    return { name: `${sei} ${mei}`, tickets, qty, amount, note };
  });
  const names = guests.map((g) => g.name);
  if (new Set(names).size !== names.length) throw httpError('同じ氏名が 2 回入っています。1 組の分は 1 枚のカードにまとめてください', 400);

  // いたずら対策：同じ接続元からの予約（お客さんの人数）は 1 時間に ORDER_LIMIT 件まで
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM order_log WHERE ip = ? AND at > ?').bind(ip, hourAgo).first();
  if (n + guests.length > ORDER_LIMIT) throw httpError('短い時間に予約が続いたため、しばらく受け付けられません。時間をおいてください', 429);

  // 番号は W1, W2, …（CSV で取り込む取り置きの番号と重ならないように）。まとめて 1 つのトランザクションで書く。同時に届いたら付け直す
  const now = new Date().toISOString();
  for (let attempt = 0; ; attempt++) {
    try {
      await db.batch([
        ...guests.map((g, i) => db.prepare(`INSERT INTO reservations (project_id, res_no, name, kana, tickets, qty, amount, paid, settle, note, member, email, source, client_id, created_at, updated_at)
            VALUES (?, 'W' || (SELECT COALESCE(MAX(CAST(SUBSTR(res_no, 2) AS INTEGER)), 0) + 1 FROM reservations WHERE project_id = ? AND res_no GLOB 'W[0-9]*'),
              ?, ?, ?, ?, ?, 0, 'member', ?, ?, ?, 'web', ?, ?, ?)`)
          .bind(P.id, P.id, g.name, g.name, JSON.stringify(g.tickets), g.qty, g.amount, g.note, member, email, `${clientId}-${i}`, now, now)),
        ...guests.map(() => db.prepare('INSERT INTO order_log (ip, at) VALUES (?, ?)').bind(ip, now)),
        db.prepare('DELETE FROM order_log WHERE at < ?').bind(new Date(Date.now() - 86400000).toISOString()),
        bumpRev(db, P.id),
      ]);
      break;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;
      const again = await already();
      if (again.length) return json({ ok: true, duplicate: true, reservations: again.map((r) => orderReceipt(rowToReservation(r), P)), mailed: false });
      if (attempt >= 4) throw httpError('混み合っています。もう一度「予約する」を押してください', 503);
    }
  }
  const saved = (await already()).map((r) => orderReceipt(rowToReservation(r), P));
  // 控えのメール（送信サービスの設定があるときだけ。届くのを待たずに返す）
  let mailed = false;
  if (mailConfigured(env)) {
    const job = sendReceiptMail(env, email, member, saved, P).catch((e) => audit(db, member, 'order', '控えのメールを送れませんでした', `${email}：${String(e.message || e).slice(0, 200)}`));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    mailed = true;
  }
  return json({ ok: true, reservations: saved, mailed });
}

/** 予約した団員に見せる内容（控え） */
const orderReceipt = (r, P) => ({
  no: r.no, name: r.name, tickets: r.tickets, qty: r.qty, amount: r.amount, settle: r.settle, member: r.member, email: r.email, note: r.note,
  createdAt: r.createdAt, project: { id: P.id, name: P.name, startDate: P.startDate }, openAt: P.openAt,
});

// ===== 控えのメール =====
// Cloudflare だけでは好きなアドレスにメールを送れないので、メール送信サービス Resend（https://resend.com）を使う。
//   npx wrangler secret put RESEND_API_KEY   （Resend の API キー）
//   npx wrangler secret put MAIL_FROM        （送り主。Resend で確認したドメインのアドレス。例: 定演チケット <ticket@example.com>）
// 2 つとも設定してあるときだけ送る。なければ送らない（予約の画面の「メールで控えを送る」ボタンは、団員のメールアプリで送る）
const mailConfigured = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

/** 控えの本文（予約の画面の「メールで控えを送る」と同じ内容） */
function receiptText(member, list, P) {
  const total = list.reduce((a, r) => a + r.amount, 0);
  const when = (iso) => isoJst(iso).slice(0, 16).replace('T', ' ');
  return [
    `${member} さん`,
    '',
    `${P.name} のチケットの取り置きを、次のとおり受け付けました。`,
    '',
    ...list.flatMap((r) => [`■ 予約番号 ${r.no}　${r.name} 様`, `　${describeTickets(r.tickets)}　${yen(r.amount)}` + (r.note ? `\n　備考：${r.note}` : '')]),
    '',
    `合計 ${list.length} 組・${list.reduce((a, r) => a + r.qty, 0)} 枚・${yen(total)}`,
    `代金は終演後に ${member} さんからまとめて回収します（お客さんは受付で払いません）。`,
    '',
    'お客さんには、当日受付でお名前（カタカナ）か予約番号を伝えるようお知らせください。チケットをお渡しします。',
    P.openAt ? `ウェブでの取り置きは ${when(P.openAt)}（開場時刻）で締め切ります。変更・取り消しはチケット係に連絡してください。` : '変更・取り消しはチケット係に連絡してください。',
  ].join('\n');
}

async function sendReceiptMail(env, to, member, list, P) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM, to: [to],
      subject: `【取り置きの控え】${P.name}（${list.map((r) => r.no).join('・')}）`,
      text: receiptText(member, list, P),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ===== ユーティリティ =====
function httpError(message, status, headers) {
  return Object.assign(new Error(message), { status, headers });
}

async function readJson(request) {
  try { return await request.json(); } catch { throw httpError('リクエストが不正です', 400); }
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}

const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** 日本時間の ISO 8601（例: 2026-11-02T11:48:26+09:00） */
function isoJst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + '+09:00';
}

// ===== CSV の書き出し（定義は docs/csv-spec.md） =====
//   sales_ja.csv         当日券の会計（手集計用。Excel 向け。日本語の項目名、券種ごとの枚数を列に）
//   sales.csv            当日券の会計（データ分析用。1 行 = 1 会計）
//   sale_items.csv       当日券の明細（データ分析用。1 行 = 1 会計 × 1 券種 × 1 セットの種類）
//   reservations.csv     取り置きの一覧と受け渡しの状況（日本語の項目名。取り込みの様式と同じ列を含むので、そのまま取り込み直せる）
//   reservations_template.csv  取り込み用の様式（見出しと記入例）
// 共通: 1 行目が項目名、2 行目からデータ。UTF-8（BOM 付き。?bom=0 で BOM なし）、改行 CRLF。
//       金額は円の整数、日時は ISO 8601（+09:00）。取り消した会計は含めない。
const CSV_FILES = {
  'sales_ja.csv': salesJaCsvRows,
  'sales.csv': salesCsvRows,
  'sale_items.csv': saleItemsCsvRows,
  'reservations.csv': reservationsCsvRows,
  'reservations_template.csv': reservationsTemplateRows,
  'members.csv': membersCsvRows,
};

async function csvResponse(db, P, name, params) {
  const needSales = name.startsWith('sale');
  const sales = needSales ? await attachItems(db, (await db.prepare('SELECT * FROM sales WHERE project_id = ? AND cancelled = 0 ORDER BY id').bind(P.id).all()).results) : [];
  const ctx = { products: await getProducts(db, P.id, { all: true }), project: P };
  if (name.startsWith('reservations') || name === 'members.csv') ctx.reservations = await getReservations(db, P.id);
  const rows = CSV_FILES[name](sales, ctx);
  const body = rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const stamp = isoJst(new Date().toISOString()).slice(0, 16).replace(/[-:T]/g, '');
  const bom = params.get('bom') === '0' ? '' : '﻿';   // Excel で文字化けしないよう既定は BOM 付き
  const file = name === 'reservations_template.csv' ? `teien_p${P.id}_reservations_template.csv` : `teien_p${P.id}_${name.replace('.csv', '')}_${stamp}.csv`;
  return new Response(bom + body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8; header=present',
      // ファイル名に公演の番号を入れる（例: teien_p1_sales_202611021930.csv）
      'content-disposition': `attachment; filename="${file}"`,
      'cache-control': 'no-store',
    },
  });
}

/** 1 つの値を CSV のセルに（RFC 4180。カンマ・ダブルクォート・改行を含むときだけ囲む） */
function csvCell(c) {
  if (c == null) return '';
  let s = String(c);
  // 文字列が = + - @ で始まると Excel が数式として実行するので、先頭に ' を付ける（数値は対象外）
  if (typeof c === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const businessDate = (iso) => isoJst(iso).slice(0, 10);

function salesCsvRows(sales, { project }) {
  const header = ['sale_id', 'project_id', 'order_no', 'sold_at', 'business_date', 'payment_method', 'ticket_quantity', 'total_amount_yen', 'staff_name'];
  return [header].concat(sales.map((r) => [
    r.id, project.id, r.order_no, isoJst(r.created_at), businessDate(r.created_at), r.payment, r.units, r.amount, r.staff,
  ]));
}

function saleItemsCsvRows(sales) {
  const header = ['sale_id', 'sold_at', 'business_date', 'product_id', 'ticket_type', 'pack_size', 'pack_price_yen', 'pack_count', 'quantity', 'amount_yen', 'unit_name', 'is_mixed_pack', 'mixed_pack_label'];
  const rows = [header];
  for (const r of sales) {
    for (const it of r.items) {
      rows.push([r.id, isoJst(r.created_at), businessDate(r.created_at), it.product_id || null, it.name, it.set_qty, it.set_price, it.count,
        it.set_qty * it.count, it.set_price * it.count, it.unit, it.pack_label ? 1 : 0, it.pack_label || null]);
    }
  }
  return rows;
}

/** 券種の列（今の券種の並び順＋記録にだけある券種）。lines(x) は [{ productId, name, unit, qty }] */
function typeColumns(products, records, lines) {
  const cols = products.map((p) => ({ key: 'id:' + p.id, name: p.name, unit: p.unit, used: false, active: p.active }));
  for (const x of records) {
    for (const l of lines(x)) {
      const key = l.productId ? 'id:' + l.productId : 'name:' + l.name;
      let c = cols.find((y) => y.key === key);
      if (!c) { c = { key, name: l.name, unit: l.unit, used: false, active: false }; cols.push(c); }
      c.used = true;
    }
  }
  return cols.filter((c) => c.used || c.active);
}

/** 手集計用（Excel 向け）：1 行 = 1 会計。日本語の項目名、券種ごとの枚数を 1 列ずつ（横持ち） */
function salesJaCsvRows(sales, { products }) {
  const linesOf = (r) => r.items.map((it) => ({ productId: it.product_id, name: it.name, unit: it.unit, qty: it.set_qty * it.count }));
  const cols = typeColumns(products, sales, linesOf);
  const keyOf = (l) => (l.productId ? 'id:' + l.productId : 'name:' + l.name);
  const units = new Set(cols.map((c) => c.unit));
  const unitAll = units.size === 1 ? [...units][0] : '枚';
  const header = ['会計番号', '日付', '時刻', '支払方法', '担当者', ...cols.map((c) => `${c.name}(${c.unit})`), `枚数計(${unitAll})`, '合計(円)', '内容（参考）'];
  return [header].concat(sales.map((r) => {
    const ls = linesOf(r);
    const t = isoJst(r.created_at);
    return [r.order_no, t.slice(0, 10).replace(/-/g, '/'), t.slice(11, 19), r.payment, r.staff,
      ...cols.map((c) => ls.filter((l) => keyOf(l) === c.key).reduce((a, l) => a + l.qty, 0)), r.units, r.amount, r.desc];
  }));
}

/** 取り置きの一覧（受け渡しの状況つき）。取り込みの様式の列（番号・氏名・フリガナ・券種ごとの枚数・支払・金額・備考）を含む */
function reservationsCsvRows(_, { products, reservations }) {
  const cols = typeColumns(products, reservations, (r) => r.tickets);
  const keyOf = (t) => (t.productId ? 'id:' + t.productId : 'name:' + t.name);
  const numSort = (a, b) => String(a.no).localeCompare(String(b.no), 'ja', { numeric: true });
  const header = ['番号', '氏名', 'フリガナ', ...cols.map((c) => `${c.name}(${c.unit})`), '枚数計', '支払', '金額(円)',
    '受付で受け取る額(円)', '受け取った額(円)', '受け渡し', '受け渡し日時', '受け渡した人', '備考', '連絡先', '受付方法', '申込日時', '団員', '団員のメール', '団員から回収'];
  return [header].concat([...reservations].sort(numSort).map((r) => [
    r.no, r.name, r.kana || null, ...cols.map((c) => r.tickets.filter((t) => keyOf(t) === c.key).reduce((a, t) => a + t.qty, 0)), r.qty,
    SETTLE_LABEL[r.settle], r.amount, r.due, r.handedAt ? r.due : 0, r.handedAt ? '済' : '未',
    r.handedAt ? isoJst(r.handedAt) : null, r.handedBy || null, r.note || null,
    r.contact || null, r.source === 'web' ? 'ウェブ' : 'CSV', r.createdAt ? isoJst(r.createdAt) : null,
    r.member || null, r.email || null, r.settle === 'member' ? (r.collectedAt ? '済' : '未') : null,
  ]));
}

/** 団員ごとの精算（終演後に団員から回収する分） */
function membersCsvRows(_, { reservations }) {
  const header = ['団員', 'メールアドレス', '取り置き(件)', '枚数', 'うち受け渡し済み(枚)', '団員から回収する額(円)', '回収済み(円)', '未回収(円)', '回収', '団員の精算でない取り置き(件)'];
  return [header].concat(memberSummary(reservations).map((g) => [
    g.member, g.emails.join(' ') || null, g.count, g.qty, g.handedQty, g.amount, g.collected, g.uncollected,
    g.amount ? (g.uncollected ? (g.collected ? '一部' : '未') : '済') : null, g.others,
  ]));
}

/** 取り込みの様式（見出しと記入例 2 行。券種は登録済みの名前を使う） */
function reservationsTemplateRows(_, { products }) {
  const a = products[0] ? products[0].name : '一般';
  const b = products[1] ? products[1].name : a;
  return [
    ['番号', '氏名', 'フリガナ', '券種', '枚数', '支払', '金額', '団員', '備考'],
    ['1', '岡大 太郎', 'オカダイ タロウ', a, '2', '団員', '', '山田 花子', ''],
    ['2', 'グリー 花子', 'グリー ハナコ', a, '1', '済', '', '', '振込済み'],
    ['2', 'グリー 花子', 'グリー ハナコ', b, '1', '済', '', '', ''],
  ];
}
