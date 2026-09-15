/* Linux 命令查询 · 联网更新适配层
 * 出网仅经 spark.net.fetch(host 代理);无宿主能力时一切联网操作按故障处理,离线出厂数据不受影响。
 * 职责:①「检查更新」拉远端索引 → 校验 → 与出厂索引差分 → 只增不替换的覆盖层(db);
 *      ②覆盖层新增命令的正文按需拉取并缓存;③恢复出厂(清覆盖层)。
 * jsdelivr 主源 → raw.githubusercontent 兜底,withTimeout 15s。
 */
(function (global) {
'use strict';

var UPD = {};

var INDEX_URLS = [
  'https://cdn.jsdelivr.net/npm/linux-command/dist/data.json',
  'https://raw.githubusercontent.com/jaywcjlove/linux-command/master/dist/data.json'
];
var DOC_URLS = [
  'https://cdn.jsdelivr.net/npm/linux-command/command/<N>.md',
  'https://raw.githubusercontent.com/jaywcjlove/linux-command/master/command/<N>.md'
];
var FETCH_TIMEOUT_MS = 15000;
var STORE_TIMEOUT_MS = 10000;
var NAME_RE = /^[a-z0-9][a-z0-9_.+-]*$/;
var OVERLAY_KEY = 'lc_idx_overlay';

var spark = global.spark || null;

function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error((label || '操作') + '超时(' + Math.round(ms / 1000) + 's)')); }, ms);
    })
  ]);
}

/* ── 出网:归一到 {status, text()} ── */

function netFetchText(url) {
  if (!spark || !spark.net || typeof spark.net.fetch !== 'function') {
    return Promise.reject(new Error('net.fetch 不可用(宿主无联网能力)'));
  }
  var p;
  try {
    p = Promise.resolve().then(function () {
      return spark.net.fetch(url, { method: 'GET' });
    });
  } catch (e) {
    return Promise.reject(e);
  }
  return withTimeout(p, FETCH_TIMEOUT_MS, '请求').then(function (res) {
    if (!res || res.status !== 200) throw new Error('HTTP ' + (res && res.status ? res.status : 'ERR'));
    return withTimeout(res.text(), FETCH_TIMEOUT_MS, '读取');
  });
}

function fetchFirst(urls) {
  var i = 0;
  function tryOne() {
    if (i >= urls.length) return Promise.reject(new Error('全部数据源不可达'));
    return netFetchText(urls[i++]).catch(function (e) {
      if (i >= urls.length) throw e;
      return tryOne();
    });
  }
  return tryOne();
}

/* ── 持久化:spark.db 优先,localStorage 兜底(db 挂起超时也回退) ── */

function dbGet(key) {
  var useDb = spark && spark.db && typeof spark.db.get === 'function';
  var p = useDb
    ? (function () { try { return withTimeout(spark.db.get(key), STORE_TIMEOUT_MS, '缓存读取'); } catch (e) { return Promise.resolve(null); } })()
      .catch(function () { return null; })
    : Promise.resolve(null);
  return p.then(function (v) {
    if (v !== undefined && v !== null) return v;
    try { return JSON.parse(global.localStorage.getItem('lcmd_' + key) || 'null'); } catch (e) { return null; }
  });
}

function dbSet(key, val) {
  var done = false;
  var useDb = spark && spark.db && typeof spark.db.set === 'function';
  var first;
  if (useDb) {
    try {
      first = withTimeout(spark.db.set(key, val), STORE_TIMEOUT_MS, '缓存写入')
        .then(function () { done = true; }).catch(function () {});
    } catch (e) { first = Promise.resolve(); }
  } else first = Promise.resolve();
  return first.then(function () {
    if (done) return;
    try { global.localStorage.setItem('lcmd_' + key, JSON.stringify(val)); } catch (e) { /* 存不进就放弃 */ }
  });
}

function dbDel(key) {
  var useDb = spark && spark.db && typeof spark.db.set === 'function';
  var first;
  if (useDb) {
    try { first = withTimeout(spark.db.set(key, null), STORE_TIMEOUT_MS, '缓存清理').catch(function () {}); }
    catch (e) { first = Promise.resolve(); }
  } else first = Promise.resolve();
  return first.then(function () {
    try { global.localStorage.removeItem('lcmd_' + key); } catch (e) { /* 忽略 */ }
  });
}

/* ── 远端索引校验闸:结构漂移即拒收 ── */

function validateRemoteIndex(raw) {
  var obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error('返回内容不是合法 JSON'); }
  var names = Object.keys(obj);
  if (names.length < 580) throw new Error('远端索引条数异常(' + names.length + '),拒收');
  for (var i = 0; i < names.length; i++) {
    var e = obj[names[i]];
    if (!e || typeof e.n !== 'string' || typeof e.d !== 'string' || !NAME_RE.test(e.n)) {
      throw new Error('远端索引条目形状异常,拒收');
    }
  }
  return obj;
}

/* ── 检查更新 ──

checkIndex({onProgress}) → {added:[{n,d}], totalRemote, source}
覆盖层只增不替换:仅收录出厂索引中不存在的命令;旧覆盖层条目保留。 */
UPD.checkIndex = function (opts) {
  opts = opts || {};
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
  onProgress(4, '读取本地覆盖层…');
  return UPD.loadOverlay().then(function (overlay) {
    onProgress(8, '连接数据源…');
    return fetchFirst(INDEX_URLS).then(function (raw) {
      onProgress(60, '校验远端索引…');
      var remote = validateRemoteIndex(raw);
      var known = {};
      var factory = global.LCMD_INDEX || [];
      for (var i = 0; i < factory.length; i++) known[factory[i].n] = true;
      overlay = overlay || { schema: 1, built: null, added: [] };
      var have = {};
      for (var k = 0; k < overlay.added.length; k++) have[overlay.added[k].n] = true;
      var added = overlay.added.slice();
      var names = Object.keys(remote).sort();
      for (var j = 0; j < names.length; j++) {
        var n = names[j];
        if (known[n] || have[n]) continue;
        var d = remote[n].d || '';
        if (!d.trim()) continue;
        added.push({ n: n, d: d });
        have[n] = true;
      }
      onProgress(90, '保存索引覆盖层…');
      var overlayOut = { schema: 1, built: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), added: added };
      return dbSet(OVERLAY_KEY, overlayOut).then(function () {
        onProgress(100, '完成');
        return { added: added, totalRemote: names.length, overlay: overlayOut };
      });
    });
  });
};

/* 覆盖层读取(带形状校验,脏数据按无覆盖层处理) */
UPD.loadOverlay = function () {
  return dbGet(OVERLAY_KEY).then(function (v) {
    if (!v || v.schema !== 1 || !Array.isArray(v.added)) return null;
    var clean = [];
    for (var i = 0; i < v.added.length; i++) {
      var e = v.added[i];
      if (e && typeof e.n === 'string' && typeof e.d === 'string' && NAME_RE.test(e.n)) clean.push({ n: e.n, d: e.d });
    }
    return { schema: 1, built: v.built || null, added: clean };
  });
};

UPD.clearOverlay = function () {
  return dbDel(OVERLAY_KEY);
};

/* ── 覆盖层命令的正文按需拉取(缓存 db lc_doc:<name>) ── */

function docUrl(name) {
  return DOC_URLS.map(function (tpl) { return tpl.replace('<N>', encodeURIComponent(name)); });
}

UPD.fetchDoc = function (name) {
  var key = 'lc_doc:' + name;
  return dbGet(key).then(function (cached) {
    if (typeof cached === 'string' && cached.length > 30) return cached;
    return fetchFirst(docUrl(name)).then(function (md) {
      if (typeof md !== 'string' || md.length < 30 || md.indexOf(name) < 0) {
        throw new Error('远端文档内容异常');
      }
      return dbSet(key, md).then(function () { return md; });
    });
  });
};

UPD.available = function () {
  return !!(spark && spark.net && typeof spark.net.fetch === 'function');
};

global.LCMD_UPDATER = UPD;
})(typeof window !== 'undefined' ? window : globalThis);