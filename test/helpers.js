/**
 * テスト用に Worker（src/index.js）を Miniflare で動かす。D1 はテストごとの一時フォルダに作る。
 */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'http://localhost';
export const PASSWORDS = { register: 'reg-pass-1234', master: 'master-pass-1234' };

/** 一時的な D1 の保存先（同じ保存先で Worker を起動し直すと、データが残った状態で再起動できる） */
export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'teien-test-'));
}

export async function startWorker(persistDir) {
  // Miniflare 5 は設定の形が変わったので、これまでの形（v4）で書いて変換する
  const mf = new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: persistDir,   // D1 の保存先
    workers: [{
      name: 'teien-ticket',
      modules: [
        { type: 'ESModule', path: join(root, 'src/index.js') },
        { type: 'ESModule', path: join(root, 'src/xlsx.js') },
        { type: 'ESModule', path: join(root, 'public/pricing.js') },
      ],
      modulesRoot: root,
      compatibilityDate: '2026-10-01',
      d1Databases: { DB: 'test-db' },
      bindings: { ADMIN_PASSWORD: PASSWORDS.register, MASTER_PASSWORD: PASSWORDS.master },
    }],
  }));
  await mf.ready;
  const db = await mf.getD1Database('DB');
  const cookies = {};
  /** API を呼ぶ。role を渡すとそのログインの Cookie を付ける。戻り値は { status, body, headers } */
  async function api(path, { method, body, role, headers = {} } = {}) {
    const h = { Origin: ORIGIN, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (role && cookies[role]) h.Cookie = cookies[role];
    const res = await mf.dispatchFetch(ORIGIN + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set && role) cookies[role] = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json ?? text, headers: res.headers };
  }
  async function loginMaster() {
    const r = await api('/api/master/login', { body: { password: PASSWORDS.master }, role: 'master' });
    if (r.status !== 200) throw new Error('master login failed: ' + JSON.stringify(r.body));
    return r.body;
  }
  async function loginRegister(staff = 'テスト担当') {
    const r = await api('/api/admin/login', { body: { staff, password: PASSWORDS.register }, role: 'register' });
    if (r.status !== 200) throw new Error('register login failed: ' + JSON.stringify(r.body));
    return r.body;
  }
  /** SQL を実行して行を返す */
  async function query(sql, ...binds) {
    return (await db.prepare(sql).bind(...binds).all()).results;
  }
  return { mf, db, api, cookies, loginMaster, loginRegister, query, dispose: () => mf.dispose() };
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
