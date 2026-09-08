/* textkit.js — 文本处理引擎：大小写/标点/简繁/替换/统计/行操作 + 变量名转换 + 拼音 */
var TextKit = (function () {
  'use strict';

  /* ---------- 大小写 ---------- */
  function changeCase(s, mode) {
    switch (mode) {
      case 'upper': return s.toUpperCase();
      case 'lower': return s.toLowerCase();
      case 'title': return s.replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, function (m, p, l) { return p + l.toUpperCase(); })
        .replace(/(\p{L})([\p{L}]+)/gu, function (m, a, rest) { return a + rest; });
      case 'cap': return s.replace(/(^|[.!?；。！？]\s*)(\p{L})/gu, function (m, p, l) { return p + l.toUpperCase(); });
      case 'toggle': return s.split('').map(function (c) { return c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(); }).join('');
      default: return s;
    }
  }

  /* ---------- 中英标点 ---------- */
  var CN2EN = { '，': ',', '。': '.', '；': ';', '：': ':', '？': '?', '！': '!', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>', '、': ',', '～': '~', '——': '-', '…': '...', '·': '.', '　': ' ' };
  var EN2CN = { ',': '，', '.': '。', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）', '[': '【', ']': '】', '<': '《', '>': '》', '~': '～' };
  function punctConvert(s, to) {
    if (to === 'en') {
      return s.replace(/——/g, '-').replace(/…/g, '...').replace(/[，。；：？！“”‘’【】《》、～·　]/g, function (c) { return CN2EN[c] !== undefined ? CN2EN[c] : c; });
    }
    return s.replace(/[,.:;?!\[\]~]/g, function (c) {
      if (to === 'cn') return EN2CN[c] || c;
      return c;
    }).replace(/\.\.\./g, '…');
  }
  function cn2enPunct(s) {
    return s.replace(/——/g, '-').replace(/…/g, '...').replace(/[，。；：？！“”‘’【】《》、～·]/g, function (c) { return CN2EN[c] || c; }).replace(/　/g, ' ');
  }
  function en2cnPunct(s) {
    // . [ ] 也在转换表里；小数点（前后都是数字）不转
    return s.replace(/\.\.\./g, '…').replace(/[.,:;?!()\[\]<>~]/g, function (c, off, str) {
      if (c === '.' && ((str[off - 1] || '').match(/\d/) || (str[off + 1] || '').match(/\d/))) return c;
      return EN2CN[c] || c;
    });
  }

  /* ---------- 简繁转换（数据来自 assets/vendor/s2t.js、t2s.js） ---------- */
  function buildMap(str) {
    var map = {};
    var a = str.split('|');
    for (var i = 0; i + 1 < a.length; i += 2) map[a[i]] = a[i + 1];
    return map;
  }
  function convertByMap(s, map) {
    var out = [];
    for (var ch of s) out.push(map[ch] !== undefined ? map[ch] : ch);
    return out.join('');
  }
  function s2t(s) {
    var g = typeof window !== 'undefined' ? window : globalThis;
    if (!g.S2T) throw new Error('简繁数据未加载（assets/vendor/s2t.js）');
    return convertByMap(s, buildMap(g.S2T));
  }
  function t2s(s) {
    var g = typeof window !== 'undefined' ? window : globalThis;
    if (!g.T2S) throw new Error('繁转简数据未加载（assets/vendor/t2s.js）');
    return convertByMap(s, buildMap(g.T2S));
  }

  /* ---------- 行操作 ---------- */
  function lines(s) { return String(s == null ? '' : s).split(/\r\n|\r|\n/); }
  function dedupeLines(s, opt) {
    opt = opt || {};
    var seen = new Set(), out = [], trimmed = [];
    for (var ln of lines(s)) {
      var key = opt.trim ? ln.replace(/\s+/g, ' ').trim() : ln;
      if (!seen.has(key)) { seen.add(key); out.push(ln); }
    }
    return out.join('\n');
  }
  function addLineNumbers(s, opt) {
    opt = opt || {};
    var start = opt.start === undefined ? 1 : (+opt.start || 0);
    var sep = opt.sep === undefined ? '. ' : opt.sep;
    var ls = lines(s);
    var width = String(start + Math.max(0, ls.length - 1)).length;
    if (!opt.pad) width = 0;
    return ls.map(function (ln, i) {
      var n = String(start + i);
      while (n.length < width) n = '0' + n;
      return n + sep + ln;
    }).join('\n');
  }
  function sortLines(s, mode) {
    var ls = lines(s);
    var coll = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator('zh-Hans-CN') : null;
    var cmp = function (a, b) { return coll ? coll.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0); };
    switch (mode) {
      case 'asc': ls.sort(cmp); break;
      case 'desc': ls.sort(function (a, b) { return -cmp(a, b); }); break;
      case 'lenAsc': ls.sort(function (a, b) { return a.length - b.length || cmp(a, b); }); break;
      case 'lenDesc': ls.sort(function (a, b) { return b.length - a.length || cmp(a, b); }); break;
      case 'reverse': ls.reverse(); break;
      case 'shuffle':
        for (var i = ls.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = ls[i]; ls[i] = ls[j]; ls[j] = t;
        }
        break;
      default: break;
    }
    return ls.join('\n');
  }
  function trimLines(s) { return lines(s).map(function (l) { return l.replace(/^[\s\uFEFF\xA0\u200b-\u200f\u2028\u2029\u3000]+|[\s\uFEFF\xA0\u200b-\u200f\u2028\u2029\u3000]+$/g, ''); }).join('\n'); }
  function removeEmptyLines(s) { return lines(s).filter(function (l) { return l.trim() !== ''; }).join('\n'); }
  function replaceText(s, find, to, opt) {
    opt = opt || {};
    if (opt.regex) {
      var flags = (opt.ignoreCase ? 'i' : '') + (opt.multiline ? 'm' : '') + 'g';
      var re = new RegExp(find, flags);
      return String(s == null ? '' : s).replace(re, to);
    }
    return String(s == null ? '' : s).split(find || '').join(to || '');
  }
  function textStats(s) {
    var l = lines(s);
    var chars = 0, cn = 0, en = 0, num = 0, spaces = 0, punct = 0, other = 0;
    var bytes = 0;
    var b = Codec.utf8ToBytes(String(s == null ? '' : s));
    bytes = b.length;
    for (var ch of String(s == null ? '' : s)) {
      chars++;
      var cp = ch.codePointAt(0);
      if (/\s/.test(ch)) spaces++;
      else if (/[\u4e00-\u9fff]/.test(ch)) cn++;
      else if (/[a-zA-Z]/.test(ch)) en++;
      else if (/[0-9]/.test(ch)) num++;
      else punct++;
    }
    var words = (String(s == null ? '' : s).match(/[a-zA-Z0-9_\-\u4e00-\u9fff]+/g) || []).length;
    return { chars: chars, charsNoSpace: chars - spaces, cn: cn, en: en, num: num, punct: punct, spaces: spaces, bytes: bytes, lines: l.length, words: words };
  }

  /* ---------- 变量名格式转换 ---------- */
  function toWords(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return [];
    var parts = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-\s.]+/g, ' ')
      .trim().split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (/^[A-Z0-9]{2,}$/.test(p)) { out.push(p); continue; }   // 缩写词整体保留
      var sub = p.replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/([0-9])([a-zA-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
      for (var j = 0; j < sub.length; j++) if (sub[j]) out.push(sub[j]);
    }
    return out;
  }
  function nameStyles(input) {
    var w = toWords(input);
    if (!w.length) return { _empty: true };
    var lower = w.map(function (x) { return x.toLowerCase(); });
    function cap(x) { return x.charAt(0).toUpperCase() + x.slice(1); }
    var camel = w.map(function (x, i) { return i === 0 ? x.toLowerCase() : cap(x.toLowerCase()); }).join('');
    var pascal = w.map(function (x) { return cap(x.toLowerCase()); }).join('');
    var kebab = lower.join('-');
    var snake = lower.join('_');
    var upper = lower.join('_').toUpperCase();
    var title = w.map(cap).join(' ');
    var space = lower.join(' ');
    return {
      'var-name': kebab, 'VAR_NAME': upper, 'VarName': pascal,
      'varName': camel, 'var_name': snake, 'var name': space, 'Var Name': title
    };
  }

  /* ---------- 拼音（数据来自 assets/vendor/pinyin-dict.js，num 形式如 han4） ---------- */
  var _pyMap = null;
  function pyMap() {
    if (_pyMap) return _pyMap;
    var g = typeof window !== 'undefined' ? window : globalThis;
    if (!g.PINYIN_DICT) throw new Error('拼音数据未加载（assets/vendor/pinyin-dict.js）');
    _pyMap = buildMap(g.PINYIN_DICT);
    return _pyMap;
  }
  var TONE_MARK = { a: ['ā', 'á', 'ǎ', 'à'], e: ['ē', 'é', 'ě', 'è'], i: ['ī', 'í', 'ǐ', 'ì'], o: ['ō', 'ó', 'ǒ', 'ò'], u: ['ū', 'ú', 'ǔ', 'ù'], v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'] };
  function numToMark(py) {
    var m = py.match(/^([a-zü]+)([0-4])$/);
    if (!m) return py;
    var base = m[1], tone = +m[2];
    if (!tone) return base; // 轻声（0）：去数字、不标调
    tone -= 1;
    var idx = -1, kind = null;
    for (var k of ['a', 'e', 'o']) { var p = base.indexOf(k); if (p >= 0 && idx < 0) { idx = p; kind = k; } }
    if (idx < 0) {
      // 标在最后一个元音（iu/ü 并列标后；字典里 ü 也可能写作 v）
      for (var i = base.length - 1; i >= 0; i--) {
        var c = base[i];
        if (c === 'i' || c === 'u' || c === 'v' || c === 'ü') { idx = i; kind = (c === 'v' || c === 'ü') ? 'v' : c; break; }
      }
    }
    if (idx < 0) return py;
    return base.slice(0, idx) + TONE_MARK[kind][tone] + base.slice(idx + 1);
  }
  function pinyin(text, opt) {
    opt = opt || {};
    var map = pyMap();
    var sep = opt.sep === undefined ? ' ' : opt.sep;
    var out = [];
    var firstOut = [];
    for (var ch of String(text == null ? '' : text)) {
      var py = map[ch];
      if (!py || !/^[a-zü]+[0-9]$/.test(py)) {
        out.push(ch); firstOut.push(/[\u4e00-\u9fff]/.test(ch) ? '' : ch);
        continue;
      }
      var plain = py.replace(/[0-9]$/, '').replace(/v/g, 'ü');
      if (opt.style === 'num') out.push(py.replace(/v/g, 'v'));
      else if (opt.style === 'mark') out.push(numToMark(py));
      else out.push(plain);
      firstOut.push(plain.charAt(0).toUpperCase());
    }
    return { full: out.join(sep), initials: firstOut.join(sep === ' ' ? '' : sep.charAt(0) === ' ' ? '' : '') };
  }
  function pinyinInitials(text) {
    var map = pyMap();
    var out = [];
    for (var ch of String(text == null ? '' : text)) {
      var py = map[ch];
      if (py && /^[a-zü]+[0-9]$/.test(py)) out.push(py[0].toUpperCase());
      else if (/[a-zA-Z]/.test(ch)) out.push(ch.toUpperCase());
      else if (ch.trim()) out.push(ch);
    }
    return out.join('');
  }

  return {
    changeCase: changeCase,
    cn2enPunct: cn2enPunct, en2cnPunct: en2cnPunct,
    s2t: s2t, t2s: t2s,
    dedupeLines: dedupeLines, addLineNumbers: addLineNumbers, sortLines: sortLines,
    trimLines: trimLines, removeEmptyLines: removeEmptyLines,
    replaceText: replaceText, textStats: textStats,
    toWords: toWords, nameStyles: nameStyles,
    pinyin: pinyin, pinyinInitials: pinyinInitials, numToMark: numToMark
  };
})();
if (typeof globalThis !== 'undefined') globalThis.TextKit = TextKit;