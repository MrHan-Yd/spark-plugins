/* ── 正则编辑器 · 大文本模式扫描引擎 ─────────────────────────
   面向大内容（10MB+ 也不冻结界面）：
   - 全部内置模式拼成一条「单遍」交替正则（命名分组归属），一次 exec 循环完成分类计数；
   - 内容按 256K 字符分块，块间让出主线程（进度条 + 可取消）；
   - 块间 4K 字符重叠 + 相对偏移去重，保证跨块边界的命中恰好计一次；
   - 内置模式全部为线性复杂度（无嵌套歧义量词），扫描本身不会灾难性回溯；
     用户自写的危险模式请走「测试」页，由 Worker 看门狗兜底。 */
(function (global) {
  'use strict';

  var CHUNK = 1 << 18;        /* 256K 字符/块：单块同步耗时控制在 ~100ms 内 */
  var OVERLAP = 4096;         /* 块间重叠：覆盖库内模式可能的命中长度 */
  var MAX_COUNT = 1000000;    /* 单模式计数上限 */
  var MAX_SCAN = 1 << 27;     /* 128M 字符硬上限，超出截断并提示 */

  /* 内置模式库：仅用 (?:) 非捕获分组（组合正则靠命名分组归属）。
     按特异度从高到低排列，组合时前面的优先命中。 */
  var LIB = [
    { key: 'email',    label: '邮箱地址',        re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
    { key: 'url',      label: '网址 URL',        re: /\b(?:https?|ftp):\/\/[^\s<>"'\)\]]+/ },
    { key: 'uuid',     label: 'UUID',            re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/ },
    { key: 'idcard',   label: '身份证号（18位）', re: /\b\d{17}[\dXx]\b/ },
    { key: 'mobile',   label: '手机号（中国大陆）', re: /\b1[3-9]\d{9}\b/ },
    { key: 'mac',      label: 'MAC 地址',        re: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/ },
    { key: 'ipv4',     label: 'IPv4 地址',       re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/ },
    { key: 'isodt',    label: 'ISO 日期时间',     re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/ },
    { key: 'isodate',  label: 'ISO 日期',        re: /\b\d{4}-\d{1,2}-\d{1,2}\b/ },
    { key: 'slashdate', label: '斜杠日期',       re: /\b\d{4}\/\d{1,2}\/\d{1,2}\b/ },
    { key: 'time',     label: '时间 HH:MM(:SS)', re: /\b\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,6})?\b/ },
    { key: 'hexcolor', label: '十六进制颜色',     re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/ },
    { key: 'version',  label: '版本号',          re: /\b\d+(?:\.\d+){1,3}\b/ },
    { key: 'money',    label: '金额（¥/$/€）',   re: /[¥$€£]\s?\d+(?:,\d{3})*(?:\.\d{1,2})?/ },
    { key: 'percent',  label: '百分数',          re: /\b\d+(?:\.\d+)?%/ },
    { key: 'hexstr',   label: '十六进制串（≥8位）', re: /\b(?:0x)?[0-9a-fA-F]{8,}\b/ },
    { key: 'base64',   label: 'Base64 片段',     re: /\b[A-Za-z0-9+/]{20,}={0,2}\b/ },
    { key: 'number',   label: '数字',            re: /-?\b\d+(?:\.\d+)?\b/ },
    { key: 'htmltag',  label: 'HTML 标签',       re: /<\/?[A-Za-z][\w-]*(?:\s+[^<>]*)?>/ },
    { key: 'cjk',      label: '连续汉字（≥2）',   re: /[\u4e00-\u9fff]{2,}/ }
  ];

  function buildCombined() {
    var parts = LIB.map(function (t, i) { return '(?<t' + i + '>' + t.re.source + ')'; });
    return new RegExp(parts.join('|'), 'g');
  }

  /* 单块字符构成统计：仅计入 [from, to) 相对区间（左右扩展区不重复计） */
  function tally(chunk, from, to, stats) {
    var letters = 0, digits = 0, cjk = 0, spaces = 0, others = 0, nl = 0;
    for (var i = from; i < to; i++) {
      var c = chunk.charCodeAt(i);
      if (c === 10) nl++;
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
      else if (c >= 48 && c <= 57) digits++;
      else if (c >= 0x4e00 && c <= 0x9fff) cjk++;
      else if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) spaces++;
      else others++;
    }
    stats.letters += letters; stats.digits += digits; stats.cjk += cjk;
    stats.spaces += spaces; stats.others += others;
    stats._nl += nl;
  }

  function analyze(text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var onProgress = opts.onProgress || function () {};
      var shouldCancel = opts.shouldCancel || function () { return false; };
      var truncatedScan = false;
      if (text.length > MAX_SCAN) { text = text.slice(0, MAX_SCAN); truncatedScan = true; }

      var combined;
      try { combined = buildCombined(); }
      catch (e) { resolve({ error: '内置模式库编译失败：' + e.message }); return; }

      var counts = new Array(LIB.length);
      var capped = new Array(LIB.length);
      var samples = new Array(LIB.length);
      for (var i = 0; i < LIB.length; i++) { counts[i] = 0; capped[i] = false; samples[i] = []; }

      var stats = { chars: text.length, lines: 0, letters: 0, digits: 0, cjk: 0, spaces: 0, others: 0, _nl: 0 };
      var t0 = Date.now();
      var pos = 0;
      var cancelled = false;

      function finish() {
        /* 行数按 wc 口径：换行符计行，末尾无换行补一行 */
        stats.lines = text.length ? stats._nl + (text.charCodeAt(text.length - 1) === 10 ? 0 : 1) : 0;
        var tokens = LIB.map(function (t, i) {
          return {
            key: t.key, label: t.label, pattern: t.re.source,
            count: counts[i], truncated: capped[i], samples: samples[i]
          };
        });
        resolve({ tokens: tokens, stats: stats, elapsed: Date.now() - t0, truncatedScan: truncatedScan, cancelled: false });
      }

      function step() {
        if (shouldCancel()) { cancelled = true; }
        if (cancelled) { resolve({ cancelled: true, elapsed: Date.now() - t0 }); return; }
        if (pos >= text.length) { finish(); return; }

        var start = pos;
        var end = Math.min(text.length, start + CHUNK);
        /* 左扩展：让 exec 的最左匹配拿到跨块 token 的真实起点（而不是从中段
           重新匹配），再按绝对起点归属到 [start, end) 即可恰好计一次。
           右扩展：保证本块能完整命中归属自己的 token（库内模式长度 ≤ OVERLAP）。 */
        var leftBase = start > 0 ? Math.max(0, start - OVERLAP) : 0;
        var chunkEnd = (end < text.length) ? Math.min(text.length, end + OVERLAP) : end;
        var chunk = text.slice(leftBase, chunkEnd);

        combined.lastIndex = 0;
        var r;
        while ((r = combined.exec(chunk)) !== null) {
          if (r[0].length === 0) {
            combined.lastIndex++;
            if (combined.lastIndex >= chunk.length) break;
            continue;
          }
          var absStart = leftBase + r.index;
          if (absStart >= start && absStart < end) {
            var ti = -1, g = r.groups;
            if (g) {
              for (var k in g) {
                if (g[k] !== undefined) { ti = +k.slice(1); break; }
              }
            }
            if (ti >= 0 && ti < LIB.length) {
              counts[ti]++;
              if (counts[ti] >= MAX_COUNT) capped[ti] = true;
              if (samples[ti].length < 3) {
                var s = r[0];
                samples[ti].push(s.length > 200 ? s.slice(0, 200) + '…' : s);
              }
            }
          }
        }

        tally(chunk, start - leftBase, end - leftBase, stats);
        pos = end;
        onProgress({ done: end, total: text.length });
        if (pos >= text.length) { finish(); return; }
        setTimeout(step, 0);
      }

      setTimeout(step, 0);
    });
  }

  var api = { analyze: analyze, LIB: LIB, CHUNK: CHUNK, OVERLAP: OVERLAP };
  if (typeof window !== 'undefined') window.RegexScan = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.__regexscan__ = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));