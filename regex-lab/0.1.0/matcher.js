/* ── 正则编辑器 · 匹配执行器 ─────────────────────────────────
   所有用户正则都在 Web Worker（Blob URL）里执行，主线程永不阻塞：
   - Worker 内 exec 循环每 40ms 回报一次进度；
   - 宿主侧看门狗 4s 无进展即 terminate + 自愈重建（灾难性回溯的唯一解法）；
   - 有进展的合法长扫描（如 10MB 全文线性匹配）会不断重置看门狗，不会被误杀；
   - 宿主同一时刻只放行一个在途请求：新请求先用「取代」结算旧请求并重建
     Worker，再发车——杜绝「新请求的看门狗杀死正在服务旧请求的 Worker」；
   - Worker 不可用（构造失败 / blob 被策略拦截报 onerror）自动降级为主线程
     分片执行（localRun），UI 仍不冻结，但单次 exec 卡死无法防护。 */
(function (global) {
  'use strict';

  var WATCHDOG_MS = 4000;

  /* Worker 源码：字符串内避免模板字面量，方便主文件拼接 */
  var WORKER_SRC = [
    "'use strict';",
    "self.onmessage = function (e) {",
    "  var m = e.data;",
    "  if (!m || typeof m !== 'object') return;",
    "  if (m.type === 'match') doMatch(m);",
    "  else if (m.type === 'replace') doReplace(m);",
    "};",
    "function send(o) { self.postMessage(o); }",
    "function pack(r) {",
    "  var named = r.groups ? Object.keys(r.groups).length ? r.groups : null : null;",
    "  return { i: r.index, len: r[0].length,",
    "    groups: Array.prototype.slice.call(r, 1).map(function (x) { return x === undefined ? null : x; }),",
    "    named: named };",
    "}",
    "function doMatch(m) {",
    "  var re;",
    "  try { re = new RegExp(m.pattern, m.flags); }",
    "  catch (err) { send({ id: m.id, ok: false, error: 'regexp', message: err.message }); return; }",
    "  try {",
    "    var text = m.text, g = re.global, sticky = re.sticky;",
    "    var maxCount = 2000000, maxList = m.maxList || 1000;",
    "    var count = 0, truncated = false, matches = [];",
    "    var t0 = Date.now(), tick = t0;",
    "    re.lastIndex = 0;",
    "    if (g || sticky) {",
    "      for (;;) {",
    "        var r = re.exec(text);",
    "        if (r === null) break;",
    "        count++;",
    "        if (matches.length < maxList) matches.push(pack(r));",
    "        if (count >= maxCount) { truncated = true; break; }",
    "        if (r[0].length === 0) { re.lastIndex++; if (re.lastIndex > text.length) break; }",
    "        var now = Date.now();",
    "        if (now - tick > 40) { tick = now; send({ id: m.id, progress: true, at: re.lastIndex, count: count }); }",
    "        if (!g) break;",
    "      }",
    "    } else {",
    "      var r2 = re.exec(text);",
    "      if (r2 !== null) { count = 1; matches.push(pack(r2)); }",
    "    }",
    "    send({ id: m.id, ok: true, count: count, truncated: truncated, elapsed: Date.now() - t0, matches: matches });",
    "  } catch (err) { send({ id: m.id, ok: false, error: 'runtime', message: (err && err.message) || String(err) }); }",
    "}",
    "function doReplace(m) {",
    "  var flags = (m.flags || '').indexOf('g') < 0 ? (m.flags || '') + 'g' : m.flags;",
    "  var re;",
    "  try { re = new RegExp(m.pattern, flags); }",
    "  catch (err) { send({ id: m.id, ok: false, error: 'regexp', message: err.message }); return; }",
    "  try {",
    "    var text = m.text;",
    "    var count = 0, truncated = false;",
    "    var maxCount = 1000000, t0 = Date.now(), tick = t0;",
    "    re.lastIndex = 0;",
    "    for (;;) {",
    "      var r = re.exec(text);",
    "      if (r === null) break;",
    "      count++;",
    "      if (count >= maxCount) { truncated = true; break; }",
    "      if (r[0].length === 0) { re.lastIndex++; if (re.lastIndex > text.length) break; }",
    "      var now = Date.now();",
    "      if (now - tick > 40) { tick = now; send({ id: m.id, progress: true, at: re.lastIndex, count: count }); }",
    "    }",
    "    var cap = 262144;",
    "    var sample = text.length > cap ? text.slice(0, cap) : text;",
    "    var preview = sample.replace(re, m.repl == null ? '' : m.repl);",
    "    if (preview.length > 4000) preview = preview.slice(0, 4000);",
    "    send({ id: m.id, ok: true, count: count, truncated: truncated, preview: preview, elapsed: Date.now() - t0 });",
    "  } catch (err) { send({ id: m.id, ok: false, error: 'runtime', message: (err && err.message) || String(err) }); }",
    "}"
  ].join('\n');

  function packLocal(r) {
    var named = r.groups && Object.keys(r.groups).length ? r.groups : null;
    return {
      i: r.index, len: r[0].length,
      groups: Array.prototype.slice.call(r, 1).map(function (x) { return x === undefined ? null : x; }),
      named: named
    };
  }

  /* 无 Worker 时的主线程退化实现：30ms 分片让出 UI。
     match / replace 语义与 Worker 路径对齐（replace 强制 g、计数上限、preview）。 */
  function localRun(payload) {
    return new Promise(function (resolve) {
      var isReplace = payload.type === 'replace';
      var flags = payload.flags || '';
      if (isReplace && flags.indexOf('g') < 0) flags += 'g';
      var re;
      try { re = new RegExp(payload.pattern, flags); }
      catch (err) { resolve({ ok: false, error: 'regexp', message: err.message }); return; }
      var text = payload.text;
      var g = re.global;
      var maxList = payload.maxList || 1000;
      var maxCount = isReplace ? 1000000 : 2000000;
      var count = 0, truncated = false, matches = [], preview = '';
      var t0 = Date.now();
      function packAll() {
        var out = {
          ok: true, count: count, truncated: truncated,
          elapsed: Date.now() - t0, matches: matches, engine: 'local'
        };
        if (isReplace) {
          try {
            var cap = 262144;
            var sample = text.length > cap ? text.slice(0, cap) : text;
            preview = sample.replace(re, payload.repl == null ? '' : payload.repl);
            if (preview.length > 4000) preview = preview.slice(0, 4000);
            out.preview = preview;
          } catch (err) { resolve({ ok: false, error: 'runtime', message: (err && err.message) || String(err) }); return; }
        }
        resolve(out);
      }
      function step() {
        var deadline = Date.now() + 30;
        try {
          while (Date.now() < deadline) {
            if (!g) {
              var r0 = re.exec(text);
              if (r0 !== null) { count = 1; matches.push(packLocal(r0)); }
              packAll();
              return;
            }
            var r = re.exec(text);
            if (r === null) { packAll(); return; }
            count++;
            if (!isReplace && matches.length < maxList) matches.push(packLocal(r));
            if (count >= maxCount) { truncated = true; packAll(); return; }
            if (r[0].length === 0) { re.lastIndex++; if (re.lastIndex > text.length) { packAll(); return; } }
          }
        } catch (err) { resolve({ ok: false, error: 'runtime', message: (err && err.message) || String(err) }); return; }
        setTimeout(step, 0);
      }
      setTimeout(step, 0);
    });
  }

  function Matcher() {
    this.seq = 0;
    this.engine = 'worker';
    this.url = null;
    this.worker = null;
    this.current = null;   /* 单在途请求：{id, resolve, timer, touch} */
    try {
      var blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
      this.url = URL.createObjectURL(blob);
      this._spawn();
    } catch (e) {
      this.engine = 'local';
      this.worker = null;
    }
  }

  Matcher.prototype._spawn = function () {
    var self = this;
    this.worker = new Worker(this.url);
    this.worker.onmessage = function (e) { self._onmessage(e.data); };
    /* blob Worker 被环境策略拦截时构造不抛错而是异步 onerror——首次报错即降级 */
    this.worker.onerror = function () { self._degrade(); };
  };

  Matcher.prototype._degrade = function () {
    if (this.engine === 'local') return;
    this.engine = 'local';
    if (this.current) {
      var c = this.current;
      this.current = null;
      clearTimeout(c.timer);
      c.resolve({ ok: false, error: 'worker', engine: 'local', message: 'Worker 不可用，已切换为主线程分片执行' });
    }
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    this.worker = null;
  };

  Matcher.prototype._restart = function () {
    if (this.engine !== 'worker') return;
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    try { this._spawn(); } catch (e) { this._degrade(); }
  };

  Matcher.prototype._onmessage = function (d) {
    if (!d || typeof d.id !== 'number') return;
    var p = this.current;
    if (!p || d.id !== p.id) return; /* 已被取代的旧请求的迟到消息，忽略 */
    if (d.progress) { p.touch(); return; }
    this.current = null;
    clearTimeout(p.timer);
    p.resolve(d);
  };

  Matcher.prototype._request = function (payload) {
    var self = this;
    if (this.engine !== 'worker' || this.worker === null || typeof Worker === 'undefined') {
      return localRun(payload);
    }
    return new Promise(function (resolve) {
      /* 单在途：新请求作废旧请求并重建 Worker，保证看门狗只服务当前请求 */
      if (self.current) {
        var old = self.current;
        self.current = null;
        clearTimeout(old.timer);
        old.resolve({ ok: false, error: 'superseded' });
        self._restart();
      }
      var id = ++self.seq;
      payload.id = id;
      var p = { resolve: resolve, timer: null, touch: null, id: id };
      function kill() {
        if (self.current !== p) return;
        self.current = null;
        clearTimeout(p.timer);
        self._restart();
        resolve({
          ok: false, error: 'timeout', engine: 'worker',
          message: '匹配超过 ' + Math.round(WATCHDOG_MS / 1000) + ' 秒无进展，疑似灾难性回溯，已强制终止并重建执行器。' +
            '建议：简化嵌套量词（如 (a+)+）、缩小字符类范围、或拆分正则分步匹配。'
        });
      }
      p.touch = function () {
        clearTimeout(p.timer);
        p.timer = setTimeout(kill, WATCHDOG_MS);
      };
      p.timer = setTimeout(kill, WATCHDOG_MS);
      self.current = p;
      self.worker.postMessage(payload);
    });
  };

  Matcher.prototype.match = function (pattern, flags, text, opts) {
    opts = opts || {};
    return this._request({
      type: 'match', pattern: pattern, flags: flags, text: text,
      maxList: opts.maxList || 1000
    });
  };

  Matcher.prototype.replace = function (pattern, flags, repl, text) {
    return this._request({
      type: 'replace', pattern: pattern, flags: flags, repl: repl, text: text
    });
  };

  Matcher.prototype.destroy = function () {
    if (this.current) { clearTimeout(this.current.timer); this.current = null; }
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    if (this.url) { try { URL.revokeObjectURL(this.url); } catch (e) { /* ignore */ } }
  };

  var api = { Matcher: Matcher, WATCHDOG_MS: WATCHDOG_MS, WORKER_SRC: WORKER_SRC, localRun: localRun };
  if (typeof window !== 'undefined') window.RegexMatcher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.__regexmatcher__ = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));