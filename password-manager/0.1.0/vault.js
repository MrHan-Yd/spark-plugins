/* vault.js — 密码管家 · 保险库数据层（模型 / 加解密 / 存取 / 导入导出 / 密码生成）
 *
 * 安全模型（与 README「数据安全」一节一一对应）：
 *   开门密码 P
 *     ├─ BCrypt(P, salt, cost=10) → "$2a$10$…"（60 字符）存盘，只用于校验，不可逆；
 *     └─ AES-256 密钥 = SHA-256(该 BCrypt 密文) —— 即"开门密码经过哈希处理的值"。
 *   每条帐号（含用户名、密码、备注、网址……）整条 JSON 用 AES-256-CBC + PKCS7 加密，
 *   每条独立随机 16 字节 IV，与密文拼接后 base64 落盘。
 *   落盘数据 = meta（明文骨架 + bcrypt 密文 + 校验块）+ vault（密文）。没有开门密码，
 *   既拿不到密钥，也无法通过校验块与 PKCS7 校验，数据不可解、不可枚举。
 *
 * 依赖：CryptoBox（crypto.js）、bcryptjs（bcrypt.js，暴露 window.dcodeIO.bcrypt）。
 */

var Vault = (function () {
  'use strict';

  var META_KEY = 'pm.meta';
  var DATA_KEY = 'pm.data';
  var PREFS_KEY = 'pm.prefs';

  var SCHEMA = 1;
  var BCrypt_COST = 10;
  var MARKER = 'spark-password-manager/v1';   /* 校验块明文 */
  var MAX_HISTORY = 5;

  /* ---------- 依赖 ---------- */
  function getBcrypt() {
    var b = (typeof globalThis !== 'undefined' && globalThis.dcodeIO && globalThis.dcodeIO.bcrypt) || null;
    if (!b) throw new Error('bcrypt 库未加载，无法进行开门密码运算');
    return b;
  }
  function getCryptoBox() {
    var c = (typeof globalThis !== 'undefined' && globalThis.CryptoBox) || null;
    if (!c) throw new Error('CryptoBox 未加载，无法进行加解密');
    return c;
  }

  /* ---------- 存储适配：spark.db 优先，其次 localStorage（开发预览用） ---------- */
  var store = (function () {
    if (typeof spark !== 'undefined' && spark && spark.db) {
      return {
        get: function (k) { return spark.db.get(k); },
        set: function (k, v) { return spark.db.set(k, v); },
        remove: function (k) { return spark.db.remove(k); }
      };
    }
    return {
      get: function (k) {
        try { return Promise.resolve(JSON.parse(localStorage.getItem(k))); } catch (e) { return Promise.resolve(null); }
      },
      set: function (k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 配额满则忽略 */ }
        return Promise.resolve(true);
      },
      remove: function (k) {
        try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
        return Promise.resolve(true);
      }
    };
  })();

  function setStore(s) { store = s; }   /* 单元测试注入用 */

  /* ---------- 内存态 ---------- */
  var meta = null;      /* 明文元信息 */
  var key = null;       /* 32 字节 AES 密钥（仅解锁期间存在） */
  var data = null;      /* 明文保险库 { records, groups, updated } */

  function now() { return Date.now(); }
  function uid(prefix) {
    return (prefix || 'r') + '_' + now().toString(36) + '_' +
      getCryptoBox().toHex(getCryptoBox().randomBytes(4));
  }

  /* ---------- 开门密码 → 密钥 ---------- */
  /* bcrypt 只取前 72 字节，超长密码先 SHA-256 归一再交给 bcrypt，避免静默截断 */
  function bcryptInput(pw) {
    var C = getCryptoBox();
    var bytes = C.utf8Bytes(String(pw));
    if (bytes.length <= 72) return String(pw);
    return '$sha256$' + C.toHex(C.sha256(bytes));
  }
  function keyFromHash(hashStr) {
    return getCryptoBox().sha256(getCryptoBox().utf8Bytes(hashStr));
  }
  function newSalt() {
    try { return getBcrypt().genSaltSync(BCrypt_COST); }
    catch (e) {
      /* 宿主无 CSPRNG 时 genSaltSync 会失败；回退到自带随机源组盐 */
      var C = getCryptoBox();
      var ab = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789./';
      var raw = C.randomBytes(16), s = '';
      for (var i = 0; i < 16; i++) s += ab[raw[i] & 63];
      return '$2a$' + ('0' + BCrypt_COST).slice(-2) + '$' + s;
    }
  }

  /* ---------- 加解密单条密文 ---------- */
  function seal(plainObj) {
    var C = getCryptoBox();
    var iv = C.randomBytes(16);
    var ct = C.aesCbcEncrypt(key, iv, C.utf8Bytes(JSON.stringify(plainObj)));
    return { iv: C.toBase64(iv), ct: C.toBase64(ct) };
  }
  function open(box) {
    var C = getCryptoBox();
    if (!box || !box.iv || !box.ct) throw new Error('密文块结构不完整');
    var plain = C.aesCbcDecrypt(key, C.fromBase64(box.iv), C.fromBase64(box.ct));
    return JSON.parse(C.utf8String(plain));
  }

  /* ---------- 落盘 ---------- */
  function saveMeta() {
    meta.updated = now();
    return store.set(META_KEY, meta);
  }
  function saveData() {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    data.updated = now();
    var box = seal(data);
    meta.count = data.records.length;
    var p = store.set(DATA_KEY, box);
    return Promise.resolve(p).then(function () { return saveMeta(); });
  }

  /* ---------- 生命周期 ---------- */
  /* 读取 meta，判断是否已建库 */
  function init() {
    return Promise.resolve(store.get(META_KEY)).then(function (m) {
      meta = m || null;
      return { exists: !!(meta && meta.bcrypt), meta: meta };
    });
  }

  function isUnlocked() { return !!key; }
  function isVaultReady() { return !!(meta && meta.bcrypt); }

  /* 首次建库：设置开门密码 */
  function setup(masterPassword, opts) {
    var bcrypt = getBcrypt();
    if (!masterPassword || String(masterPassword).length < 6) {
      return Promise.reject(new Error('开门密码至少 6 位'));
    }
    var salt = newSalt();
    return bcrypt.hash(bcryptInput(masterPassword), salt).then(function (hashStr) {
      key = keyFromHash(hashStr);
      meta = {
        schema: SCHEMA,
        kdf: 'bcrypt-sha256',
        bcrypt: hashStr,
        cost: BCrypt_COST,
        created: now(),
        updated: now(),
        count: 0,
        hint: (opts && opts.hint) || ''
      };
      data = { records: [], groups: [], updated: now() };
      meta.check = seal({ marker: MARKER, at: now() });
      return saveData();
    });
  }

  /* 解锁：一次 bcrypt 运算同时完成「校验」与「派生密钥」 */
  function unlock(masterPassword) {
    if (!meta || !meta.bcrypt) return Promise.reject(new Error('尚未建立保险库'));
    var bcrypt = getBcrypt();
    var salt = String(meta.bcrypt).slice(0, 29);   /* $2a$10$ + 22 字符盐 */
    return bcrypt.hash(bcryptInput(masterPassword), salt).then(function (hashStr) {
      var C = getCryptoBox();
      if (!C.equalBytes(C.utf8Bytes(hashStr), C.utf8Bytes(String(meta.bcrypt)))) {
        throw new Error('WRONG_PASSWORD');
      }
      key = keyFromHash(hashStr);
      /* 校验块解不开 = 落盘数据与元信息不一致（被篡改/损坏） */
      var chk;
      try { chk = open(meta.check); } catch (e) { throw new Error('VAULT_CORRUPT'); }
      if (!chk || chk.marker !== MARKER) throw new Error('VAULT_CORRUPT');
      return Promise.resolve(store.get(DATA_KEY)).then(function (box) {
        if (!box) { data = { records: [], groups: [], updated: now() }; return { ok: true, records: 0 }; }
        var plain;
        try { plain = open(box); } catch (e) { throw new Error('VAULT_CORRUPT'); }
        data = normalize(plain);
        return { ok: true, records: data.records.length };
      });
    });
  }

  function lock() {
    key = null;
    data = null;
  }

  /* 仅校验开门密码，不改变解锁状态、不派生密钥（导出前二次确认等场景用） */
  function verifyPassword(pw) {
    if (!meta || !meta.bcrypt) return Promise.resolve(false);
    var C = getCryptoBox();
    return getBcrypt().hash(bcryptInput(pw), String(meta.bcrypt).slice(0, 29)).then(function (h) {
      return C.equalBytes(C.utf8Bytes(h), C.utf8Bytes(String(meta.bcrypt)));
    }).catch(function () { return false; });
  }

  /* 对外暴露的非敏感元信息（设置页展示用，绝不包含密钥材料） */
  function metaInfo() {
    if (!meta) return Promise.resolve(null);
    return Promise.resolve({
      schema: meta.schema, kdf: meta.kdf, cost: meta.cost,
      created: meta.created, updated: meta.updated,
      count: meta.count || 0, hint: meta.hint || ''
    });
  }

  /* 兼容/清洗：确保结构完整，字段类型正确 */
  function normalize(plain) {
    var d = plain && typeof plain === 'object' ? plain : {};
    var groups = Array.isArray(d.groups) ? d.groups.filter(function (g) { return g && g.id; }) : [];
    var gids = {};
    groups.forEach(function (g) { gids[g.id] = true; if (!g.name) g.name = '未命名分组'; });
    var records = (Array.isArray(d.records) ? d.records : []).filter(function (r) { return r && r.id; }).map(function (r, i) {
      r.title = String(r.title == null ? '' : r.title);
      r.username = String(r.username == null ? '' : r.username);
      r.password = String(r.password == null ? '' : r.password);
      r.url = String(r.url == null ? '' : r.url);
      r.note = String(r.note == null ? '' : r.note);
      r.tags = Array.isArray(r.tags) ? r.tags.map(String) : [];
      if (!Array.isArray(r.history)) r.history = [];
      if (r.group && !gids[r.group]) r.group = '';    /* 分组被删则回归未分组 */
      if (typeof r.order !== 'number') r.order = i;
      r.fav = !!r.fav;
      if (typeof r.created !== 'number') r.created = now();
      if (typeof r.updated !== 'number') r.updated = r.created;
      return r;
    });
    groups.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    records.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    records.forEach(function (r, i) { r.order = i; });
    return { records: records, groups: groups, updated: typeof d.updated === 'number' ? d.updated : now() };
  }

  /* ---------- 查询 ---------- */
  function snapshot() {
    return { records: data ? data.records.slice() : [], groups: data ? data.groups.slice() : [] };
  }
  function getRecord(id) {
    var list = data ? data.records : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function groupName(gid) {
    if (!gid) return '';
    var gs = data ? data.groups : [];
    for (var i = 0; i < gs.length; i++) if (gs[i].id === gid) return gs[i].name;
    return '';
  }

  /* 过滤 + 搜索：命中标题/用户名/网址/备注/标签 */
  function query(opts) {
    opts = opts || {};
    var kw = String(opts.keyword || '').trim().toLowerCase();
    var gid = opts.group || '';
    var list = (data ? data.records : []).filter(function (r) {
      if (opts.fav && !r.fav) return false;
      if (gid === '__nogroup') { if (r.group) return false; }
      else if (gid && gid !== '__all' && r.group !== gid) return false;
      if (!kw) return true;
      var hay = (r.title + '\n' + r.username + '\n' + r.url + '\n' + r.note + '\n' + r.tags.join(' ')).toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
    var sort = opts.sort || 'order';
    list.sort(function (a, b) {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh-Hans-CN');
      if (sort === 'updated') return b.updated - a.updated;
      if (sort === 'created') return b.created - a.created;
      return (a.order || 0) - (b.order || 0);
    });
    return list;
  }

  function counts() {
    var out = { total: 0, fav: 0, nogroup: 0, byGroup: {} };
    (data ? data.records : []).forEach(function (r) {
      out.total++;
      if (r.fav) out.fav++;
      if (!r.group) out.nogroup++;
      else out.byGroup[r.group] = (out.byGroup[r.group] || 0) + 1;
    });
    return out;
  }

  /* ---------- 记录增删改 ---------- */
  function upsert(fields) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var isNew = !fields.id;
    var rec = isNew ? {
      id: uid('r'), created: now(), order: data.records.length, history: [], tags: [], fav: false
    } : getRecord(fields.id);
    if (!rec) return Promise.reject(new Error('记录不存在'));
    var before = rec.password || '';
    ['title', 'username', 'url', 'note', 'group'].forEach(function (f) {
      if (fields[f] != null) rec[f] = String(fields[f]);
    });
    if (fields.password != null) rec.password = String(fields.password);
    if (Array.isArray(fields.tags)) rec.tags = fields.tags.map(function (t) { return String(t).trim(); }).filter(Boolean);
    if (typeof fields.fav === 'boolean') rec.fav = fields.fav;
    if (!rec.title && rec.username) rec.title = rec.username;
    if (!rec.title && !rec.username && rec.url) rec.title = rec.url.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    if (!rec.title) rec.title = '未命名';
    /* 密码历史：仅当密码真的变了且旧值非空 */
    if (!isNew && fields.password != null && before && before !== rec.password) {
      rec.history.unshift({ pw: before, at: now() });
      rec.history = rec.history.slice(0, MAX_HISTORY);
    }
    rec.updated = now();
    if (isNew) data.records.push(rec);
    return saveData().then(function () { return { record: rec, isNew: isNew }; });
  }

  function remove(ids) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var set = {};
    (Array.isArray(ids) ? ids : [ids]).forEach(function (i) { set[i] = true; });
    var kept = data.records.filter(function (r) { return !set[r.id]; });
    var removed = data.records.length - kept.length;
    data.records = kept;
    data.records.forEach(function (r, i) { r.order = i; });
    return saveData().then(function () { return { removed: removed }; });
  }

  /* 拖拽排序：ids 为新顺序 */
  function reorder(ids) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var map = {}, i;
    for (i = 0; i < ids.length; i++) map[ids[i]] = i;
    data.records.sort(function (a, b) {
      var x = map[a.id], y = map[b.id];
      if (x == null) x = 1e9 + (a.order || 0);
      if (y == null) y = 1e9 + (b.order || 0);
      return x - y;
    });
    data.records.forEach(function (r, k) { r.order = k; });
    return saveData();
  }

  function clearHistory(id) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var rec = getRecord(id);
    if (!rec) return Promise.reject(new Error('记录不存在'));
    rec.history = [];
    rec.updated = now();
    return saveData();
  }

  /* ---------- 分组 ---------- */
  function addGroup(name) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    name = String(name || '').trim();
    if (!name) return Promise.reject(new Error('分组名不能为空'));
    var dup = data.groups.some(function (g) { return g.name === name; });
    if (dup) return Promise.reject(new Error('已存在同名分组'));
    var g = { id: uid('g'), name: name, order: data.groups.length };
    data.groups.push(g);
    return saveData().then(function () { return g; });
  }
  function renameGroup(gid, name) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    name = String(name || '').trim();
    if (!name) return Promise.reject(new Error('分组名不能为空'));
    var g = null;
    data.groups.forEach(function (x) { if (x.id === gid) g = x; });
    if (!g) return Promise.reject(new Error('分组不存在'));
    g.name = name;
    return saveData();
  }
  function removeGroup(gid) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    data.groups = data.groups.filter(function (g) { return g.id !== gid; });
    data.groups.forEach(function (g, i) { g.order = i; });
    data.records.forEach(function (r) { if (r.group === gid) r.group = ''; });
    return saveData();
  }
  function reorderGroups(ids) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var map = {};
    ids.forEach(function (id, i) { map[id] = i; });
    data.groups.sort(function (a, b) {
      var x = map[a.id], y = map[b.id];
      if (x == null) x = 1e9; if (y == null) y = 1e9;
      return x - y;
    });
    data.groups.forEach(function (g, i) { g.order = i; });
    return saveData();
  }

  /* ---------- 修改开门密码（整库用新密钥重加密） ---------- */
  function changeMasterPassword(oldPw, newPw) {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var bcrypt = getBcrypt();
    var salt0 = String(meta.bcrypt).slice(0, 29);
    return bcrypt.hash(bcryptInput(oldPw), salt0).then(function (h) {
      var C = getCryptoBox();
      if (!C.equalBytes(C.utf8Bytes(h), C.utf8Bytes(String(meta.bcrypt)))) throw new Error('WRONG_PASSWORD');
      if (!newPw || String(newPw).length < 6) throw new Error('新开门密码至少 6 位');
      return bcrypt.hash(bcryptInput(newPw), newSalt());
    }).then(function (nh) {
      key = keyFromHash(nh);
      meta.bcrypt = nh;
      meta.check = seal({ marker: MARKER, at: now() });
      return saveData();
    });
  }

  /* ---------- 生成器 ---------- */
  var SETS = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digit: '0123456789',
    symbol: '!@#$%^&*()-_=+[]{};:,.?/~'
  };
  var AMBIGUOUS = 'Il1O0o';

  function generate(opts) {
    var C = getCryptoBox();
    opts = opts || {};
    var len = Math.max(4, Math.min(128, parseInt(opts.length, 10) || 16));
    var pools = [];
    if (opts.lower !== false) pools.push(SETS.lower);
    if (opts.upper !== false) pools.push(SETS.upper);
    if (opts.digit !== false) pools.push(SETS.digit);
    if (opts.symbol) pools.push(SETS.symbol);
    if (!pools.length) pools.push(SETS.lower);
    if (opts.excludeAmbiguous) {
      pools = pools.map(function (p) {
        return p.split('').filter(function (c) { return AMBIGUOUS.indexOf(c) < 0; }).join('');
      }).filter(Boolean);
    }
    var all = pools.join('');
    var out = [], i;
    /* 先保证每个启用字符集至少出现一次，降低"看起来没含数字"的返工 */
    for (i = 0; i < pools.length && i < len; i++) out.push(pick(pools[i]));
    while (out.length < len) out.push(pick(all));
    /* Fisher–Yates，随机源为 CSPRNG */
    for (i = out.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out.join('');

    function randInt(n) {   /* 拒绝采样，去除取模偏差 */
      var limit = Math.floor(256 / n) * n, b;
      do { b = C.randomBytes(1)[0]; } while (b >= limit);
      return b % n;
    }
    function pick(s) { return s.charAt(randInt(s.length)); }
  }

  function entropyBits(pw) {
    pw = String(pw || '');
    if (!pw) return 0;
    var pools = 0;
    if (/[a-z]/.test(pw)) pools += 26;
    if (/[A-Z]/.test(pw)) pools += 26;
    if (/[0-9]/.test(pw)) pools += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pools += 30;
    if (/[^\x00-\x7f]/.test(pw)) pools += 100;   /* 非 ASCII 按更宽字符集估算 */
    if (!pools) pools = 1;
    return Math.round(pw.length * Math.log2(pools));
  }
  /* 常见弱口令粗筛（不做联网撞库，纯本地前缀/连续/重复特征） */
  var COMMON = ['123456', 'password', 'qwerty', 'admin', 'abc123', '111111', 'letmein', 'iloveyou', 'welcome', 'monkey', 'dragon', '000000', '666666', '888888', 'a123456'];
  function strength(pw) {
    pw = String(pw || '');
    var bits = entropyBits(pw);
    var issues = [];
    if (pw.length < 8) issues.push('长度不足 8 位');
    if (!/[A-Z]/.test(pw)) issues.push('缺少大写字母');
    if (!/[a-z]/.test(pw)) issues.push('缺少小写字母');
    if (!/[0-9]/.test(pw)) issues.push('缺少数字');
    if (!/[^A-Za-z0-9]/.test(pw)) issues.push('缺少符号');
    var low = pw.toLowerCase();
    var hitCommon = COMMON.some(function (c) { return low.indexOf(c) >= 0; });
    if (hitCommon) { bits = Math.min(bits, 20); issues.push('包含常见弱口令片段'); }
    if (/^(.)\1+$/.test(pw)) { bits = Math.min(bits, 12); issues.push('全部为重复字符'); }
    if (/^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(pw)) { bits = Math.min(bits, 30); issues.push('开头为连续序列'); }
    var level = bits >= 100 ? 4 : bits >= 70 ? 3 : bits >= 45 ? 2 : bits >= 28 ? 1 : 0;
    return { bits: bits, level: level, issues: issues, label: ['极弱', '弱', '一般', '强', '很强'][level] };
  }

  /* ---------- 导入 / 导出 ---------- */
  /* 导出加密包（本插件格式，可再导入回来；数据仍是密文，换机器后需原开门密码才可读） */
  function exportEncrypted() {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    return saveData().then(function () {
      return store.get(DATA_KEY);
    }).then(function (box) {
      return {
        app: 'spark-password-manager',
        schema: SCHEMA,
        exported_at: now(),
        meta: {
          kdf: meta.kdf, bcrypt: meta.bcrypt, cost: meta.cost, hint: meta.hint || '',
          created: meta.created, count: meta.count, check: meta.check
        },
        data: box
      };
    });
  }

  function exportPlain() {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    return Promise.resolve({
      app: 'spark-password-manager',
      format: 'plain',
      exported_at: now(),
      groups: data.groups.map(function (g) { return { id: g.id, name: g.name }; }),
      records: data.records.map(function (r) {
        return {
          title: r.title, username: r.username, password: r.password, url: r.url,
          note: r.note, group: groupName(r.group), tags: r.tags, fav: r.fav,
          created: r.created, updated: r.updated
        };
      })
    });
  }

  function toCsv() {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    var head = ['title', 'username', 'password', 'url', 'group', 'tags', 'note'];
    var lines = [head.join(',')];
    data.records.forEach(function (r) {
      lines.push([r.title, r.username, r.password, r.url, groupName(r.group), r.tags.join('|'), r.note]
        .map(csvCell).join(','));
    });
    return Promise.resolve('\ufeff' + lines.join('\r\n'));
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    text = String(text).replace(/^\ufeff/, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch === '\r') { /* 忽略 */ }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  var FIELD_ALIAS = {
    title: ['title', 'name', '名称', '标题', '帐号名', '账号名', '项目'],
    username: ['username', 'user', 'login', 'account', '用户名', '帐号', '账号', '登录名'],
    password: ['password', 'pass', 'pwd', '密码'],
    url: ['url', 'website', 'site', 'link', '网址', '地址', '网站'],
    group: ['group', 'category', 'folder', '分组', '分类'],
    note: ['note', 'notes', 'remark', 'comment', '备注', '说明'],
    tags: ['tags', 'tag', '标签']
  };
  function mapHeader(cells) {
    return cells.map(function (c) {
      var k = String(c || '').trim().toLowerCase();
      for (var f in FIELD_ALIAS) if (FIELD_ALIAS[f].indexOf(k) >= 0) return f;
      return '';
    });
  }

  /* 导入：mode = 'merge'（默认，跳过同名+同用户名） | 'replace' */
  function importData(text, opts) {
    /* 解析期的同步异常统一转成 rejected Promise，调用方只处理一种错误形态 */
    try { return Promise.resolve(importParse(text, opts)); }
    catch (e) { return Promise.reject(e); }
  }
  function importParse(text, opts) {
    if (!key) throw new Error('保险库处于锁定状态');
    opts = opts || {};
    var raw = String(text || '').trim();
    if (!raw) throw new Error('内容为空');
    var items = null, groups = [];

    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
      if (Array.isArray(obj)) { items = obj; }
      else if (obj.app === 'spark-password-manager' && obj.format === 'plain') {
        items = obj.records || [];
        groups = (obj.groups || []).map(function (g) { return g.name; }).filter(Boolean);
      } else if (obj.app === 'spark-password-manager' && obj.data && obj.meta) {
        return importEncrypted(obj, opts);      /* 加密包走密钥分支 */
      } else if (Array.isArray(obj.records)) {
        items = obj.records;
        if (Array.isArray(obj.groups)) groups = obj.groups.map(function (g) { return typeof g === 'string' ? g : g.name; }).filter(Boolean);
      } else {
        throw new Error('无法识别的 JSON 结构');
      }
    } else {
      var rows = parseCsv(raw);
      if (rows.length < 2) throw new Error('CSV 至少需要表头 + 1 行数据');
      var map = mapHeader(rows[0]);
      if (map.indexOf('password') < 0 && map.indexOf('username') < 0) throw new Error('CSV 表头未能识别出「用户名/密码」列');
      items = rows.slice(1).map(function (cells) {
        var o = {};
        map.forEach(function (f, i) { if (f) o[f] = cells[i]; });
        return o;
      });
    }
    return applyImport(items, groups, opts);
  }

  function importEncrypted(pkg, opts) {
    var bcrypt = getBcrypt();
    var C = getCryptoBox();
    var m = pkg.meta || {};
    if (!m.bcrypt) return Promise.reject(new Error('加密包缺少开门密码校验信息'));
    var pw = opts.password;
    if (!pw) return Promise.reject(new Error('NEED_PASSWORD'));
    var salt = String(m.bcrypt).slice(0, 29);
    return bcrypt.hash(bcryptInput(pw), salt).then(function (h) {
      if (!C.equalBytes(C.utf8Bytes(h), C.utf8Bytes(String(m.bcrypt)))) throw new Error('WRONG_PASSWORD');
      var k2 = keyFromHash(h);
      var plain;
      try {
        plain = JSON.parse(C.utf8String(C.aesCbcDecrypt(k2, C.fromBase64(pkg.data.iv), C.fromBase64(pkg.data.ct))));
      } catch (e) { throw new Error('加密包解密失败，文件可能已损坏'); }
      var d = normalize(plain);
      return applyImport(d.records.map(function (r) {
        r.group = groupNameOf(d, r.group);
        return r;
      }), d.groups.map(function (g) { return g.name; }), opts);
    });
  }
  function groupNameOf(d, gid) {
    for (var i = 0; i < d.groups.length; i++) if (d.groups[i].id === gid) return d.groups[i].name;
    return '';
  }

  function applyImport(items, groupNames, opts) {
    opts = opts || {};
    if (!Array.isArray(items)) items = [];
    var added = 0, skipped = 0, groupAdded = 0, changed = false;
    if (opts.mode === 'replace') {
      data.records = [];
      data.groups = [];
      changed = true;
    }
    /* 分组按名字对齐，缺则新建 */
    function ensureGroup(name) {
      name = String(name || '').trim();
      if (!name) return '';
      for (var i = 0; i < data.groups.length; i++) if (data.groups[i].name === name) return data.groups[i].id;
      var g = { id: uid('g'), name: name, order: data.groups.length };
      data.groups.push(g);
      groupAdded++;
      changed = true;
      return g.id;
    }
    if (Array.isArray(groupNames)) groupNames.forEach(ensureGroup);

    var existing = {};
    data.records.forEach(function (r) { existing[r.title + '\u0001' + r.username] = true; });

    items.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') { skipped++; return; }
      var r = {
        id: uid('r'),
        title: String(raw.title || raw.name || raw['名称'] || raw['标题'] || '').trim(),
        username: String(raw.username || raw.user || raw['用户名'] || raw['帐号'] || raw['账号'] || '').trim(),
        password: String(raw.password || raw['密码'] || ''),
        url: String(raw.url || raw.website || raw['网址'] || '').trim(),
        note: String(raw.note || raw.notes || raw['备注'] || ''),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : (raw.tags ? String(raw.tags).split(/[|,]/).map(function (t) { return t.trim(); }).filter(Boolean) : []),
        group: ensureGroup(raw.group || raw['分组'] || ''),
        fav: !!raw.fav,
        created: typeof raw.created === 'number' ? raw.created : now(),
        updated: typeof raw.updated === 'number' ? raw.updated : now(),
        order: data.records.length,
        history: Array.isArray(raw.history) ? raw.history.slice(0, MAX_HISTORY) : []
      };
      if (!r.title && !r.username && !r.password) { skipped++; return; }
      if (!r.title) r.title = r.username || r.url || '未命名';
      var sig = r.title + '\u0001' + r.username;
      if (opts.mode !== 'replace' && existing[sig]) { skipped++; return; }
      existing[sig] = true;
      data.records.push(r);
      added++;
      changed = true;
    });
    if (!changed) return Promise.resolve({ added: 0, skipped: skipped, groupAdded: 0 });
    return saveData().then(function () {
      return { added: added, skipped: skipped, groupAdded: groupAdded };
    });
  }

  /* 清空全部数据（保留开门密码，用于"清空帐号"） */
  function wipeRecords() {
    if (!key) return Promise.reject(new Error('保险库处于锁定状态'));
    data.records = [];
    data.groups = [];
    return saveData();
  }
  /* 彻底销毁：删掉 meta 与 data，等于恢复出厂（开门密码一并消失） */
  function destroy() {
    lock();
    meta = null;
    return Promise.resolve(store.remove(DATA_KEY))
      .then(function () { return store.remove(META_KEY); });
  }

  /* ---------- 偏好设置（非敏感，明文存） ---------- */
  function loadPrefs() {
    return Promise.resolve(store.get(PREFS_KEY)).then(function (p) {
      return Object.assign({
        theme: 'dark',
        autoLockSec: 300,
        clipboardClearSec: 20,
        lockOnBlur: false,
        sort: 'order',
        gen: { length: 16, upper: true, lower: true, digit: true, symbol: true, excludeAmbiguous: false }
      }, p || {});
    });
  }
  function savePrefs(prefs) { return store.set(PREFS_KEY, prefs); }

  return {
    /* 常量 */
    SCHEMA: SCHEMA, COST: BCrypt_COST,
    /* 依赖注入（测试用） */
    setStore: setStore,
    /* 生命周期 */
    init: init, setup: setup, unlock: unlock, lock: lock,
    isUnlocked: isUnlocked, isVaultReady: isVaultReady,
    verifyPassword: verifyPassword, metaInfo: metaInfo,
    /* 读 */
    snapshot: snapshot, query: query, counts: counts, getRecord: getRecord, groupName: groupName,
    /* 写 */
    upsert: upsert, remove: remove, reorder: reorder, clearHistory: clearHistory,
    addGroup: addGroup, renameGroup: renameGroup, removeGroup: removeGroup, reorderGroups: reorderGroups,
    changeMasterPassword: changeMasterPassword,
    /* 生成器 */
    generate: generate, strength: strength, entropyBits: entropyBits,
    /* 导入导出 */
    exportEncrypted: exportEncrypted, exportPlain: exportPlain, toCsv: toCsv,
    parseCsv: parseCsv, importData: importData,
    /* 危险操作 / 偏好 */
    wipeRecords: wipeRecords, destroy: destroy,
    loadPrefs: loadPrefs, savePrefs: savePrefs,
    /* 测试用 */
    _internal: {
      bcryptInput: bcryptInput, keyFromHash: keyFromHash, seal: seal, open: open,
      normalize: normalize, uid: uid, MARKER: MARKER, META_KEY: META_KEY, DATA_KEY: DATA_KEY, PREFS_KEY: PREFS_KEY
    }
  };
})();

if (typeof globalThis !== 'undefined') globalThis.Vault = Vault;
