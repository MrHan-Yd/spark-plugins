/* Linux 命令查询 · 搜索引擎(纯函数层)
 * 只读 window.LCMD_INDEX,禁 DOM/禁网络/禁时间;唯一含 IO 的是 ensureChunk(懒加载分块)。
 * 评分档(每 token 取最高档):名称精确 1000 > 前缀(700−长惩罚) > 包含(500−位置惩罚)
 *   > 子序列(300−间隔惩罚) > 拼音首字母含 280 > 拼音全拼含 260 > 简介含 240
 * 多 token 空格分词 AND;排序:总分降序 → 名称长度升序 → 名称字典序(确定性输出)。
 */
(function (global) {
'use strict';

var ENGINE = {};

/* ── 基础工具 ── */

function letterOf(name) {
  var c = String(name || '').charAt(0);
  return /[a-z]/.test(c) ? c : '0';
}

/* 单 token 对单条目的最高档匹配;返回 {tier, score, start, end} 或 null */
function matchToken(e, tk) {
  var name = e.n;
  if (name === tk) return { tier: 'exact', score: 1000, start: 0, end: name.length };
  if (name.indexOf(tk) === 0) {
    return { tier: 'prefix', score: Math.max(610, 700 - (name.length - tk.length) * 4), start: 0, end: tk.length };
  }
  var idx = name.indexOf(tk);
  if (idx >= 0) {
    return { tier: 'includes', score: Math.max(410, 500 - idx * 4 - (name.length - tk.length) * 2), start: idx, end: idx + tk.length };
  }
  /* 子序列:名称字符按序命中(允许跳字),惩罚 = 跨越跨度 */
  var sub = subsequence(name, tk);
  if (sub) return { tier: 'subseq', score: 300 - Math.min(sub.span - tk.length, 15), start: sub.start, end: sub.end };

  var pi = e.pi || '', py = e.py || '';
  if (pi && pi.indexOf(tk) >= 0) return { tier: 'pyi', score: 280 };
  if (py && py.indexOf(tk) >= 0) return { tier: 'py', score: 260 };
  var d = e.d || '';
  var di = d.toLowerCase().indexOf(tk);
  if (di >= 0) return { tier: 'desc', score: 240, dStart: di, dEnd: di + tk.length };
  return null;
}

/* 子序列贪心匹配:逐字符找最早出现位置;返回 {start, end, span} 或 null */
function subsequence(name, tk) {
  var start = -1, cursor = 0;
  for (var i = 0; i < tk.length; i++) {
    var ch = tk[i];
    var at = name.indexOf(ch, cursor);
    if (at < 0) return null;
    if (start < 0) start = at;
    cursor = at + 1;
  }
  return { start: start, end: cursor, span: cursor - start };
}

/* 简介命中区间(所有 token 首个命中,合并重叠,上限 4 段) */
function descHits(e, tokens) {
  var d = e.d || '';
  var ranges = [];
  for (var i = 0; i < tokens.length && ranges.length < 4; i++) {
    var at = d.indexOf(tokens[i]);
    if (at >= 0) ranges.push([at, at + tokens[i].length]);
  }
  if (!ranges.length) return null;
  ranges.sort(function (a, b) { return a[0] - b[0]; });
  var merged = [ranges[0]];
  for (var j = 1; j < ranges.length; j++) {
    var last = merged[merged.length - 1];
    if (ranges[j][0] <= last[1]) last[1] = Math.max(last[1], ranges[j][1]);
    else merged.push(ranges[j]);
  }
  return merged;
}

/* ── 查询主入口 ──

query(entries, opts) → [{entry, score, nameHit, descHits}]
  opts.q        查询串(空格分词,大小写不敏感)
  opts.letter   首字母 scope('0' = 数字开头);null 不过滤
  opts.favsOnly boolean;配合 opts.favSet(Set)
  opts.favSet   Set<name>
  q 为空时:scope 过滤 + 名称字典序,结果不带命中区间。 */
ENGINE.query = function (entries, opts) {
  opts = opts || {};
  var q = (opts.q || '').toLowerCase().trim();
  var favsOnly = !!opts.favsOnly && !!(opts.favSet && typeof opts.favSet.has === 'function');

  var pool = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (opts.letter && letterOf(e.n) !== opts.letter) continue;
    if (favsOnly && !opts.favSet.has(e.n)) continue;
    pool.push(e);
  }

  if (!q) {
    pool.sort(function (a, b) { return a.n < b.n ? -1 : a.n > b.n ? 1 : 0; });
    return pool.map(function (e) { return { entry: e, score: 0, nameHit: null, descHits: null }; });
  }

  var tokens = q.split(/\s+/).filter(Boolean);
  var out = [];
  for (var j = 0; j < pool.length; j++) {
    var ent = pool[j];
    var total = 0, nameHit = null, ok = true;
    for (var k = 0; k < tokens.length; k++) {
      var m = matchToken(ent, tokens[k]);
      if (!m) { ok = false; break; }
      total += m.score;
      if (m.tier === 'exact' || m.tier === 'prefix' || m.tier === 'includes' || m.tier === 'subseq') {
        nameHit = [m.start, m.end];
      }
    }
    if (!ok) continue;
    out.push({ entry: ent, score: total, nameHit: nameHit, descHits: tokens.length ? descHits(ent, tokens) : null });
  }
  out.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var la = a.entry.n.length, lb = b.entry.n.length;
    if (la !== lb) return la - lb;
    return a.entry.n < b.entry.n ? -1 : a.entry.n > b.entry.n ? 1 : 0;
  });
  return out;
};

ENGINE.letterOf = letterOf;

/* ── 分块懒加载:点击命令时注入 <script>,加载后内存驻留(window.LCDC_DOCS) ── */

var loaded = {};   // letter → true(已就绪)
var pending = {};  // letter → Promise(在途)
var FAILED_WAIT_MS = 10000;

ENGINE.ensureChunk = function (letter, docBase) {
  if (loaded[letter]) return Promise.resolve();
  if (pending[letter]) return pending[letter];
  if (global.LCDC_DOCS && global.LCDC_DOCS[letter]) { loaded[letter] = true; return Promise.resolve(); }
  var d = global.document;
  if (!d) return Promise.reject(new Error('无 document,无法加载分块'));
  var p;
  p = new Promise(function (resolve, reject) {
    /* dead 标记:超时/失败后,迟到的 onload/onerror 不得触碰模块级 pending/loaded,
       否则会清掉重试请求的新 Promise(弱网下重复注入 <script>) */
    var dead = false;
    var s = d.createElement('script');
    var timer = setTimeout(function () { finish(false, new Error('分块加载超时')); }, FAILED_WAIT_MS);
    function finish(ok, err) {
      if (dead) return;
      dead = true;
      clearTimeout(timer);
      s.onload = null; s.onerror = null;
      if (s.parentNode) s.parentNode.removeChild(s);
      if (pending[letter] === p) pending[letter] = null;
      if (ok) { loaded[letter] = true; resolve(); }
      else reject(err);
    }
    s.src = (docBase || 'data/') + 'doc-' + letter + '.js';
    s.onload = function () {
      if (global.LCDC_DOCS && global.LCDC_DOCS[letter]) finish(true);
      else finish(false, new Error('分块内容缺失: ' + letter));
    };
    s.onerror = function () { finish(false, new Error('分块加载失败: ' + letter)); };
    (d.head || d.body).appendChild(s);
  });
  pending[letter] = p;
  return p;
};

ENGINE.hasChunk = function (letter) {
  return !!(global.LCDC_DOCS && global.LCDC_DOCS[letter]);
};

global.LCMD_ENGINE = ENGINE;
})(typeof window !== 'undefined' ? window : globalThis);