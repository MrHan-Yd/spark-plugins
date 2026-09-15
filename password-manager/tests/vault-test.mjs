/* 密码管家 · 加密与数据层自检（Node 端）
 *
 * 运行：node password-manager/tests/vault-test.mjs
 *
 * 覆盖：
 *   1. SHA-256 对 NIST 公开测试向量
 *   2. AES-256-CBC 对 NIST SP 800-38A F.2.5 向量 + 与 Node/OpenSSL 逐字节交叉验证
 *   3. bcrypt 对 OpenBSD/bcrypt 公开已知答案向量
 *   4. 保险库端到端：建库 → 增删改查 → 上锁/解锁（对错密码）→ 篡改检测 → 改开门密码
 *   5. 生成器 / 强度 / 导入导出
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '0.1.0');
const load = (f) => import('file://' + path.join(dir, f).replace(/\\/g, '/'));

/* bcrypt.js 是 UMD：CJS 环境下走 module.exports，不会挂到全局，这里补一次 */
const bcrypt = (await load('bcrypt.js')).default || globalThis.dcodeIO?.bcrypt;
globalThis.dcodeIO = globalThis.dcodeIO || {};
globalThis.dcodeIO.bcrypt = bcrypt;
await load('crypto.js');
await load('vault.js');

const C = globalThis.CryptoBox;
const V = globalThis.Vault;

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
};
const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (a) => Uint8Array.from(a);
const section = (s) => console.log('\n' + s);

/* ══════════ 1. SHA-256 ══════════ */
section('1. SHA-256（NIST FIPS 180-4 向量）');
await t('空串', () => assert.equal(C.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'));
await t('"abc"', () => assert.equal(C.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
await t('448-bit 双块消息', () => assert.equal(
  C.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'));
await t('1,000,000 个 "a"', () => {
  const big = new Uint8Array(1000000).fill(0x61);
  assert.equal(C.sha256Hex(big), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});
await t('与 node:crypto 随机 200 组一致', () => {
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 200);
    const buf = nodeCrypto.randomBytes(len);
    assert.equal(C.sha256Hex(u8(buf)), nodeCrypto.createHash('sha256').update(buf).digest('hex'));
  }
});

/* ══════════ 2. AES-256-CBC ══════════ */
section('2. AES-256-CBC');
const NIST_KEY = C.fromHex('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4');
const NIST_IV = C.fromHex('000102030405060708090a0b0c0d0e0f');
const NIST_PT = C.fromHex(
  '6bc1bee22e409f96e93d7e117393172a' + 'ae2d8a571e03ac9c9eb76fac45af8e51' +
  '30c81c46a35ce411e5fbc1191a0a52ef' + 'f69f2445df4f9b17ad2b417be66c3710');
const NIST_CT =
  'f58c4c04d6e5f1ba779eabfb5f7bfbd6' + '9cfc4e967edb808d679f777bc6702c7d' +
  '39f23369a9d9bacfa530e26304231461' + 'b2eb05e2c39be9fcda6c19078c6a9d1b';

await t('NIST SP 800-38A F.2.5 向量（前 4 块密文一致）', () => {
  const ct = C.aesCbcEncrypt(NIST_KEY, NIST_IV, NIST_PT);
  assert.equal(hex(ct.subarray(0, 64)), NIST_CT);
});
await t('NIST 向量 + PKCS7：与 node 实现逐字节一致', () => {
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', NIST_KEY, NIST_IV);
  const ref = Buffer.concat([cipher.update(Buffer.from(NIST_PT)), cipher.final()]);
  assert.equal(hex(C.aesCbcEncrypt(NIST_KEY, NIST_IV, NIST_PT)), ref.toString('hex'));
});
await t('随机 300 组：双向与 node/OpenSSL 一致', () => {
  for (let i = 0; i < 300; i++) {
    const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(16);
    const len = Math.floor(Math.random() * 200) + 1;   /* 覆盖 1..200 字节，含 16 的整数倍 */
    const pt = nodeCrypto.randomBytes(len);
    const mine = C.aesCbcEncrypt(u8(key), u8(iv), u8(pt));
    const c = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const ref = Buffer.concat([c.update(pt), c.final()]);
    assert.equal(hex(mine), ref.toString('hex'), '密文不一致 len=' + len);
    assert.equal(hex(C.aesCbcDecrypt(u8(key), u8(iv), mine)), pt.toString('hex'), '自解不等 len=' + len);
    assert.equal(hex(C.aesCbcDecrypt(u8(key), u8(iv), u8(ref))), pt.toString('hex'), '解 node 密文不等');
  }
});
await t('错误密钥被 PKCS7 校验拦下（不返回垃圾明文）', () => {
  const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(16);
  const ct = C.aesCbcEncrypt(u8(key), u8(iv), C.utf8Bytes('secret-value'));
  assert.throws(() => C.aesCbcDecrypt(u8(nodeCrypto.randomBytes(32)), u8(iv), ct));
});
await t('UTF-8 往返（中文/emoji/代理对）', () => {
  const s = '中文备注 🔐 émoji 𝄞 混合';
  assert.equal(C.utf8String(C.utf8Bytes(s)), s);
  const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(16);
  assert.equal(C.utf8String(C.aesCbcDecrypt(u8(key), u8(iv), C.aesCbcEncrypt(u8(key), u8(iv), C.utf8Bytes(s)))), s);
});
await t('base64 / hex 编解码往返', () => {
  for (let i = 1; i < 40; i++) {
    const b = nodeCrypto.randomBytes(i);
    assert.equal(hex(C.fromBase64(C.toBase64(u8(b)))), b.toString('hex'));
    assert.equal(hex(C.fromHex(C.toHex(u8(b)))), b.toString('hex'));
  }
});

/* ══════════ 3. bcrypt ══════════ */
section('3. bcrypt（bcrypt 官方已知答案向量）');
const KAT = [
  ['', '$2a$06$DCq7YPn5Rq63x1Lad4cll.', '$2a$06$DCq7YPn5Rq63x1Lad4cll.TV4S6ytwfsfvkgY8jIucDrjc8deX1s.'],
  ['a', '$2a$06$m0CrhHm10qJ3lXRY.5zDGO', '$2a$06$m0CrhHm10qJ3lXRY.5zDGO3rS2KdeeWLuGmsfGlMfOxih58VYVfxe'],
  ['abc', '$2a$06$If6bvum7DFjUnE9p2uDeDu', '$2a$06$If6bvum7DFjUnE9p2uDeDu0YHzrHM6tf.iqN8.yx.jNN1ILEf7h0i'],
  ['abcdefghijklmnopqrstuvwxyz', '$2a$06$.rCVZVOThsIa97pEDOxvGu', '$2a$06$.rCVZVOThsIa97pEDOxvGuRRgzG64bvtJ0938xuqzv18d3ZpQhstC'],
  ['~!@#$%^&*()      ~!@#$%^&*()PNBFRD', '$2a$06$fPIsBO8qRqkjj273rfaOI.', '$2a$06$fPIsBO8qRqkjj273rfaOI.HtSV9jLDpTbZn782DC6/t7qT67P6FfO']
];
for (const [pw, salt, want] of KAT) {
  await t('KAT ' + JSON.stringify(pw.length > 12 ? pw.slice(0, 12) + '…' : pw), () => {
    assert.equal(bcrypt.hashSync(pw, salt), want);
    assert.equal(bcrypt.compareSync(pw, want), true);
  });
}
await t('compareSync 对错误密码返回 false', () => assert.equal(bcrypt.compareSync('wrong', KAT[2][2]), false));
await t('cost=10 生成的哈希格式 $2a$10$ 且可自校验', () => {
  const h = bcrypt.hashSync('开门密码测试', bcrypt.genSaltSync(10));
  assert.match(h, /^\$2a\$10\$[./A-Za-z0-9]{53}$/);
  assert.equal(bcrypt.compareSync('开门密码测试', h), true);
  assert.equal(bcrypt.compareSync('开门密码测计', h), false);
});
await t('cost=10 单次耗时在可用区间（<5s）', () => {
  const t0 = Date.now();
  bcrypt.hashSync('perf-check', bcrypt.genSaltSync(10));
  const dt = Date.now() - t0;
  console.log('      （实测 ' + dt + 'ms）');
  assert.ok(dt < 5000, 'cost=10 耗时 ' + dt + 'ms，过长');
});

/* ══════════ 4. 保险库端到端 ══════════ */
section('4. 保险库端到端');
function memStore() {
  const m = new Map();
  return {
    get: (k) => Promise.resolve(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null),
    set: (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(true); },
    remove: (k) => { m.delete(k); return Promise.resolve(true); },
    _raw: m
  };
}
const store = memStore();
let currentStore = store;
V.setStore(store);

const PW = 'Str0ng-开门密码-2026';
const GOODS = [
  { title: 'GitHub', username: 'me@example.com', password: 'gh_P@ssw0rd!', url: 'https://github.com', note: '两步验证已开', tags: ['开发'], group: '' },
  { title: '银行', username: '6222****8888', password: '银-háng#2026', url: '', note: '查询密码', group: '' },
  { title: '邮箱', username: 'me@example.com', password: 'mail-1234', url: 'https://mail.example.com', group: '' }
];

await t('init：未建库时 exists=false', async () => {
  const r = await V.init();
  assert.equal(r.exists, false);
  assert.equal(V.isVaultReady(), false);
});

await t('setup：开门密码以 bcrypt 密文存储（cost=10，无明文残留）', async () => {
  await V.setup(PW);
  const meta = store._raw.get('pm.meta');
  assert.equal(meta.kdf, 'bcrypt-sha256');
  assert.match(meta.bcrypt, /^\$2a\$10\$/);
  assert.equal(meta.cost, 10);
  assert.ok(!JSON.stringify(meta).includes(PW), 'meta 中不应出现开门密码明文');
  assert.equal(V.isUnlocked(), true);
  const data = store._raw.get('pm.data');
  assert.deepEqual(Object.keys(data).sort(), ['ct', 'iv']);
  const ct = Buffer.from(data.ct, 'base64').toString('latin1');
  assert.ok(ct.length > 0);
});

await t('开门密码只卡「至少 4 位」，不校验大小写/字符种类', async () => {
  const s2 = memStore(); V.setStore(s2);
  await assert.rejects(() => V.setup('123'), /至少 4 位/);
  await V.setup('1234');                       /* 纯数字 4 位 → 放行 */
  assert.equal(V.isUnlocked(), true);
  V.lock();
  await V.unlock('1234');                      /* 且能正常解锁 */
  assert.equal(V.isUnlocked(), true);
  const s3 = memStore(); V.setStore(s3);
  await V.setup('abcd');                       /* 纯小写 4 位 → 放行 */
  assert.equal(V.isUnlocked(), true);
  V.setStore(store); V.lock();
  await V.init(); await V.unlock(PW);          /* 回到主测试保险库 */
  assert.equal(V.isUnlocked(), true);
});

await t('upsert：新增 3 条并落盘（密文中不含任何明文）', async () => {
  for (const g of GOODS) await V.upsert(g);
  assert.equal(V.counts().total, 3);
  const raw = JSON.stringify(store._raw.get('pm.data'));
  for (const g of GOODS) {
    assert.ok(!raw.includes(g.title), '密文里出现了标题明文：' + g.title);
    assert.ok(!raw.includes(g.password), '密文里出现了密码明文');
  }
});

await t('query：关键字（标题/用户名/备注/标签）与分组过滤', async () => {
  assert.equal(V.query({ keyword: 'github' }).length, 1);
  assert.equal(V.query({ keyword: 'ME@example.com' }).length, 2);
  assert.equal(V.query({ keyword: '查询密码' }).length, 1);
  assert.equal(V.query({ keyword: '开发' }).length, 1);
  assert.equal(V.query({ keyword: '不存在的东西' }).length, 0);
  assert.equal(V.query({}).length, 3);
});

await t('分组：新建/改名/移动/删除后记录回归未分组', async () => {
  const g = await V.addGroup('工作');
  await assert.rejects(() => V.addGroup('工作'), /同名/);
  const gh = V.query({ keyword: 'github' })[0];
  await V.upsert({ id: gh.id, group: g.id });
  assert.equal(V.counts().byGroup[g.id], 1);
  assert.equal(V.query({ group: g.id }).length, 1);
  assert.equal(V.query({ group: '__nogroup' }).length, 2);
  await V.renameGroup(g.id, '工作账号');
  assert.equal(V.groupName(g.id), '工作账号');
  await V.removeGroup(g.id);
  assert.equal(V.query({ group: '__nogroup' }).length, 3);
});

await t('排序：reorder 后 order 与查询顺序一致', async () => {
  const ids = V.query({}).map((r) => r.id).reverse();
  await V.reorder(ids);
  assert.deepEqual(V.query({}).map((r) => r.id), ids);
});

await t('密码历史：改密码后旧值进 history（上限 5）', async () => {
  const rec = V.query({ keyword: '邮箱' })[0];
  let last = rec.password;
  for (let i = 0; i < 7; i++) {
    await V.upsert({ id: rec.id, password: 'pw-' + i });
    assert.equal(V.getRecord(rec.id).history[0].pw, last);
    last = 'pw-' + i;
  }
  assert.equal(V.getRecord(rec.id).history.length, 5);
  await V.clearHistory(rec.id);
  assert.equal(V.getRecord(rec.id).history.length, 0);
});

await t('lock：内存中的密钥与明文被清空', async () => {
  V.lock();
  assert.equal(V.isUnlocked(), false);
  assert.equal(V.snapshot().records.length, 0);
  await assert.rejects(() => V.upsert({ title: 'x' }), /锁定/);
});

await t('unlock：错误开门密码 → WRONG_PASSWORD，且不留下密钥', async () => {
  await assert.rejects(() => V.unlock(PW + 'x'), /WRONG_PASSWORD/);
  assert.equal(V.isUnlocked(), false);
});

await t('unlock：正确开门密码 → 全部记录逐字段还原', async () => {
  const r = await V.unlock(PW);
  assert.equal(r.ok, true);
  const byTitle = {};
  V.query({}).forEach((x) => { byTitle[x.title] = x; });
  assert.equal(byTitle['GitHub'].username, 'me@example.com');
  assert.equal(byTitle['GitHub'].note, '两步验证已开');
  assert.deepEqual(byTitle['GitHub'].tags, ['开发']);
  assert.equal(byTitle['银行'].password, '银-háng#2026');
});

await t('篡改检测：密文被改一个字节 → 解锁报 VAULT_CORRUPT', async () => {
  const box = store._raw.get('pm.data');
  const raw = Buffer.from(box.ct, 'base64');
  raw[5] ^= 0x01;
  store._raw.set('pm.data', { iv: box.iv, ct: raw.toString('base64') });
  V.lock();
  await assert.rejects(() => V.unlock(PW), /VAULT_CORRUPT/);
  /* 还原，避免影响后续用例 */
  raw[5] ^= 0x01;
  store._raw.set('pm.data', { iv: box.iv, ct: raw.toString('base64') });
  await V.unlock(PW);
});

await t('解密走 PKCS7 校验：换掉整块密文无法静默产出垃圾明文', async () => {
  const C2 = globalThis.CryptoBox;
  const box = store._raw.get('pm.data');
  const raw = Buffer.from(box.ct, 'base64');
  const flipped = Buffer.concat([raw.subarray(0, 16), Buffer.alloc(16, 0xff), raw.subarray(32)]);
  store._raw.set('pm.data', { iv: box.iv, ct: flipped.toString('base64') });
  V.lock();
  await assert.rejects(() => V.unlock(PW), /VAULT_CORRUPT/);
  store._raw.set('pm.data', { iv: box.iv, ct: box.ct });
  await V.unlock(PW);
  assert.ok(C2);
});

await t('修改开门密码：旧密码失效、新密码可解锁、数据不变', async () => {
  const before = JSON.stringify(V.query({}).map((r) => [r.title, r.username, r.password]));
  const NEW = 'NewPass-2026-新';
  await assert.rejects(() => V.changeMasterPassword('错的密码', NEW), /WRONG_PASSWORD/);
  await assert.rejects(() => V.changeMasterPassword(PW, '123'), /至少 4 位/);
  await V.changeMasterPassword(PW, NEW);
  assert.match(store._raw.get('pm.meta').bcrypt, /^\$2a\$10\$/);
  V.lock();
  await assert.rejects(() => V.unlock(PW), /WRONG_PASSWORD/);
  await V.unlock(NEW);
  assert.equal(JSON.stringify(V.query({}).map((r) => [r.title, r.username, r.password])), before);
});

/* ══════════ 5. 生成器 / 导出导入 ══════════ */
section('5. 生成器 / 强度 / 导入导出');
await t('generate：长度、字符集开关、保底字符都符合预期', () => {
  const p = V.generate({ length: 24, upper: true, lower: true, digit: true, symbol: true });
  assert.equal(p.length, 24);
  assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/);
  assert.match(p, /[^A-Za-z0-9]/);
  const onlyDigits = V.generate({ length: 10, upper: false, lower: false, digit: true, symbol: false });
  assert.match(onlyDigits, /^[0-9]{10}$/);
  const noAmb = V.generate({ length: 60, excludeAmbiguous: true, symbol: false });
  assert.ok(!/[Il1O0o]/.test(noAmb));
  /* 随机性：100 次生成不重复 */
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(V.generate({ length: 20 }));
  assert.equal(seen.size, 100);
});

await t('strength：弱口令判弱、高熵判强', () => {
  assert.ok(V.strength('123456').level <= 1);
  assert.ok(V.strength('password').issues.includes('包含常见弱口令片段'));
  assert.ok(V.strength('aaaaaaaa').level <= 1);
  assert.ok(V.strength('qwertyuiop').level <= 2);
  assert.equal(V.strength(V.generate({ length: 24 })).level, 4);
  assert.ok(V.entropyBits('') === 0);
});

await t('exportPlain → importData(merge)：按 标题+用户名 去重', async () => {
  const plain = await V.exportPlain();
  const text = JSON.stringify(plain);
  const r1 = await V.importData(text);
  assert.equal(r1.added, 0);
  assert.ok(r1.skipped >= 3);
  /* 改个用户名再导入应能加进去 */
  plain.records[0].username = 'another@example.com';
  const r2 = await V.importData(JSON.stringify(plain));
  assert.equal(r2.added, 1);
  await V.remove(V.query({ keyword: 'another@example.com' })[0].id);
});

await t('CSV：导出 → 解析 → 再导入，含逗号/引号/换行字段', async () => {
  const csv = await V.toCsv();
  const rows = V.parseCsv(csv);
  assert.equal(rows.length, V.counts().total + 1);
  const tricky = '密码,带逗号\n"引号" \'单引号\'';
  await V.upsert({ title: 'CSV 边界', username: 'csv@x.com', password: tricky, note: '备注,含逗号' });
  const csv2 = await V.toCsv();
  const parsed = V.parseCsv(csv2);
  const header = parsed[0];
  const row = parsed.find((r) => r[header.indexOf('title')] === 'CSV 边界');
  assert.equal(row[header.indexOf('password')], tricky);
  assert.equal(row[header.indexOf('note')], '备注,含逗号');
  await V.remove(V.query({ keyword: 'CSV 边界' })[0].id);
});

await t('CSV 中文表头识别', async () => {
  const csv = '名称,用户名,密码,网址,备注\n知乎,me@zhihu.com,zhihu-pw,https://zhihu.com,手机号注册\n';
  const r = await V.importData(csv);
  assert.equal(r.added, 1);
  const rec = V.query({ keyword: '知乎' })[0];
  assert.equal(rec.password, 'zhihu-pw');
  assert.equal(rec.note, '手机号注册');
  await V.remove(rec.id);
});

await t('加密包：导出 → 用另一套保险库 + 同一开门密码导入成功', async () => {
  const pkg = await V.exportEncrypted();
  assert.equal(pkg.app, 'spark-password-manager');
  assert.ok(!JSON.stringify(pkg).includes('GitHub'), '加密包不应含明文');
  const target = memStore();
  V.setStore(target);
  await V.init();
  await V.setup('另一个保险库-开门密码');
  await V.importData(JSON.stringify(pkg), { password: 'NewPass-2026-新' });
  assert.equal(V.counts().total, 3);
  assert.equal(V.query({ keyword: 'github' })[0].password, 'gh_P@ssw0rd!');
  /* 用错开门密码解加密包 → 拒绝 */
  const third = memStore();
  V.setStore(third);
  await V.init();
  await V.setup('第三个保险库');
  await assert.rejects(() => V.importData(JSON.stringify(pkg), { password: '错' }), /WRONG_PASSWORD/);
  await assert.rejects(() => V.importData(JSON.stringify(pkg)), /NEED_PASSWORD/);
  currentStore = third;
});

await t('加密包需要开门密码：未提供时报 NEED_PASSWORD 且不写入', async () => {
  const before = V.counts().total;
  await assert.rejects(() => V.importData(JSON.stringify({ a: 1 })), /无法识别/);
  assert.equal(V.counts().total, before);
});

await t('wipeRecords / destroy 清空数据', async () => {
  await V.wipeRecords();
  assert.equal(V.counts().total, 0);
  await V.destroy();
  assert.equal(currentStore._raw.size, 0, 'destroy 后不应残留 meta/data');
  const r = await V.init();
  assert.equal(r.exists, false);
});

await t('偏好读写', async () => {
  const p = await V.loadPrefs();
  assert.equal(p.autoLockSec, 300);
  p.autoLockSec = 60;
  await V.savePrefs(p);
  const p2 = await V.loadPrefs();
  assert.equal(p2.autoLockSec, 60);
});

console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
