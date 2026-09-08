/* format.js — 代码格式化/压缩引擎：js/ts/graphql、html/vue/xml、css/less/scss、json/json5、yaml、sql、markdown */
var Fmt = (function () {
  'use strict';
  function repeat(n) { return n > 0 ? ' '.repeat(n) : ''; }

  /* ================= C 风格分词（js/ts/graphql 共用） ================= */
  var BINOPS = ['===', '!==', '=>', '&&', '||', '??', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '++', '--', '<<', '>>', '>>>', '&=', '|=', '^=', '**', '?.', '...'];
  var WORD_OPS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'await', 'yield', 'throw'];

  function cTokens(src) {
    var T = [], i = 0, n = src.length;
    var prevSig = null;
    while (i < n) {
      var ch = src[i];
      if (/\s/.test(ch)) {
        var j = i, nl = 0;
        while (j < n && /\s/.test(src[j])) { if (src[j] === '\n') nl++; j++; }
        T.push({ t: 'ws', nl: nl }); i = j; continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        var k = i; while (k < n && src[k] !== '\n') k++;
        T.push({ t: 'lc', v: src.slice(i, k) }); i = k; continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        var k2 = src.indexOf('*/', i + 2);
        k2 = k2 < 0 ? n : k2 + 2;
        var bcv = src.slice(i, k2);
        T.push({ t: 'bc', v: bcv, nl: (bcv.match(/\n/g) || []).length }); i = k2; continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        var k3 = i + 1, deep = 0;
        while (k3 < n) {
          if (src[k3] === '\\') { k3 += 2; continue; }
          if (ch === '`' && src[k3] === '$' && src[k3 + 1] === '{') { deep++; k3 += 2; continue; }
          if (ch === '`' && deep > 0 && src[k3] === '}') { deep--; k3++; continue; }
          if (src[k3] === ch && deep === 0) break;
          k3++;
        }
        var sv = src.slice(i, Math.min(k3 + 1, n));
        T.push({ t: 'str', v: sv }); i = k3 + 1; prevSig = { t: 'v' }; continue;
      }
      if (ch === '/') {
        var isRe = !prevSig || prevSig.t === 'op' || (prevSig.t === 'w' && WORD_OPS.indexOf(prevSig.v) >= 0) ||
          prevSig.v === '(' || prevSig.v === '[' || prevSig.v === '{' || prevSig.v === ',' || prevSig.v === ';';
        if (isRe) {
          var k4 = i + 1, inCls = false, done = false;
          while (k4 < n) {
            var c4 = src[k4];
            if (c4 === '\\') { k4 += 2; continue; }
            if (c4 === '\n') break;
            if (c4 === '[') inCls = true;
            else if (c4 === ']') inCls = false;
            else if (c4 === '/' && !inCls) {
              var m = /[gimsuyvd]*/.exec(src.slice(k4 + 1));
              k4 += 1 + m[0].length; done = true; break;
            }
            k4++;
          }
          if (done) { T.push({ t: 'str', v: src.slice(i, k4) }); i = k4; prevSig = { t: 'v' }; continue; }
        }
      }
      if (/[A-Za-z_$\u4e00-\u9fa5]/.test(ch)) {
        var k5 = i; while (k5 < n && /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(src[k5])) k5++;
        var word = src.slice(i, k5);
        T.push({ t: 'w', v: word }); i = k5; prevSig = { t: 'w', v: word }; continue;
      }
      if (/[0-9]/.test(ch)) {
        var k6 = i; while (k6 < n && /[0-9a-fA-FxXoObB._]/.test(src[k6])) k6++;
        var numTok = src.slice(i, k6);
        // 科学计数法（1.5e-3；0x 前缀不适用）与 BigInt 后缀（10n）
        if (!/^0[xXoObB]/.test(numTok) && /[eE]$/.test(numTok) && (src[k6] === '+' || src[k6] === '-')) {
          k6++; while (k6 < n && /[0-9]/.test(src[k6])) k6++;
        }
        if (src[k6] === 'n' && /[0-9]/.test(numTok.slice(-1))) k6++;
        T.push({ t: 'num', v: src.slice(i, k6) }); i = k6; prevSig = { t: 'v' }; continue;
      }
      var three = src.substr(i, 3), two = src.substr(i, 2);
      var opLen = 1;
      if (three === '===' || three === '!==' || three === '...' || three === '<<=' || three === '>>=' || three === '**=' || three === '>>>') opLen = 3;
      else if (BINOPS.indexOf(two) >= 0) opLen = 2;
      var op = src.substr(i, opLen);
      T.push({ t: 'p', v: op }); i += opLen;
      // ) ] 是"值结束"，其后跟 / 应按除法而非正则起点处理
      prevSig = { t: (op === '(' || op === '[' || op === '{' || op === ',' || op === ';' || op === ':') ? op : (op === ')' || op === ']') ? 'v' : 'op', v: op };
    }
    return T;
  }
  function nextSig(T, from) {
    for (var i = from; i < T.length; i++) if (T[i].t !== 'ws') return T[i];
    return null;
  }
  function parenDepthAt(T, idx) {
    var d = 0;
    for (var i = 0; i < idx; i++) {
      var t = T[i];
      if (t.t !== 'p') continue;
      if (t.v === '(') d++;
      else if (t.v === ')') d = Math.max(0, d - 1);
    }
    return d;
  }

  function formatC(src, indentSize) {
    var T = cTokens(String(src == null ? '' : src).replace(/\r\n/g, '\n'));
    var out = [], indent = 0, line = '';
    var stack = [];      // 'block' | 'obj' | 'case' | 'justClosed'
    var prev = null;     // 上一个有效 token
    var lastUnary = false;
    var pendingBlank = 0;
    var KW_PAREN = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'with', 'do']);
    var UNARY_KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'await', 'yield', 'throw']);
    var NOPREFIX = new Set(['(', '[', '.', '!', '++', '--']);
    function nl() { if (line.trim() !== '') out.push(line); line = ''; }
    function pad() { return repeat(indent * indentSize); }
    function isUnaryPos(p) {
      if (!p) return true;
      if (p.t === 'p') return !(p.v === ')' || p.v === ']' || p.v === '++' || p.v === '--');
      if (p.t === 'w') return UNARY_KW.has(p.v);
      return false;
    }
    function spaceBetween(p, c) {
      if (!p) return ''; // 首个有效 token（行首）不需要前置空格
      if (lastUnary) return '';
      if (c.t === 'w') {
        if (p.t === 'w' || p.t === 'str' || p.t === 'num') return ' ';
        return NOPREFIX.has(p.v) ? '' : ' ';
      }
      if (c.t === 'str' || c.t === 'num') {
        if (p.t === 'p') return (NOPREFIX.has(p.v) || p.v === ',') ? '' : ' ';
        return ' ';
      }
      var v = c.v;
      if (v === ')' || v === ']' || v === ',' || v === ';' || v === '.' || v === ':') return '';
      if (v === '{') return (p.t === 'p' && (p.v === '(' || p.v === '[')) ? '' : ' ';
      if (v === '(') {
        if (p.t === 'w') return KW_PAREN.has(p.v) ? ' ' : '';
        return '';
      }
      if (v === '[') return '';
      if (v === '!' || v === '++' || v === '--') {
        if (p.t === 'w' || p.t === 'num' || p.t === 'str' || p.v === ')' || p.v === ']') return '';
        return ' ';
      }
      // 一般二元操作符；+/- 处于一元位置时紧贴
      if ((v === '+' || v === '-') && p.t === 'p') {
        return (p.v === '(' || p.v === '[') ? '' : ' ';
      }
      if (p.t === 'p') return (p.v === ')' || p.v === ']') ? ' ' : '';
      return ' ';
    }
    function emit(tok) {
      var unaryHere = tok.t === 'p' && (tok.v === '+' || tok.v === '-' || tok.v === '!' || tok.v === '++' || tok.v === '--') && isUnaryPos(prev);
      if (line === '') {
        if (pendingBlank) { out.push(''); pendingBlank = 0; }
        line = pad();
      } else {
        line += spaceBetween(prev, tok);
      }
      line += tok.v;
      prev = tok;
      lastUnary = unaryHere;
    }
    var i = 0;
    while (i < T.length) {
      var t = T[i];
      if (t.t === 'ws') {
        if (t.nl >= 2 && line.trim() === '') pendingBlank = 1;
        i++; continue;
      }
      if (t.t === 'lc' || t.t === 'bc') {
        if (line.trim() === '') {
          nl();
          if (pendingBlank) { out.push(''); pendingBlank = 0; }
          out.push(pad() + t.v);
        } else {
          line += ' ' + t.v;
          nl();
        }
        i++; continue;
      }
      if (t.t === 'w') {
        var w = t.v;
        if (stack[stack.length - 1] === 'justClosed' && (w === 'else' || w === 'catch' || w === 'finally' || w === 'while')) {
          stack.pop();
          if (line === '') line = pad();
          else line += ' ';
          line += w; prev = t; lastUnary = false;
          i++; continue;
        }
        if (stack[stack.length - 1] === 'case' && (w === 'case' || w === 'default')) {
          indent = Math.max(0, indent - 1); stack.pop();
        }
        emit(t);
        i++; continue;
      }
      if (t.t === 'str' || t.t === 'num') { emit(t); i++; continue; }
      var v = t.v;
      if (v === '{') {
        var look = nextSig(T, i + 1);
        if (look && look.v === '}') { // 空块/空对象内联
          if (line === '') line = pad();
          line += spaceBetween(prev, t) + '{ }';
          prev = look; i += 2; continue;
        }
        var isObj = /[=:,([?&|]$/.test(line.trim()) ||
          /(^|\s)(return|typeof|case|in|of|new|delete|void|await|yield|throw)$/.test(line.trim());
        if (line === '') line = pad();
        line += spaceBetween(prev, t) + '{';
        prev = t;
        if (isObj) { stack.push('obj'); indent++; }
        else { stack.push('block'); indent++; nl(); }
        i++; continue;
      }
      if (v === '}') {
        var kind = stack.pop();
        if (kind === 'block') {
          indent = Math.max(0, indent - 1);
          nl();
          line = pad() + '}';
          prev = t;
          var lk = nextSig(T, i + 1);
          if (lk && (lk.v === 'else' || lk.v === 'catch' || lk.v === 'finally' || (lk.v === 'while' && stackHasDo(T, i)))) {
            stack.push('justClosed');
          } else nl();
        } else if (kind === 'case') {
          indent = Math.max(0, indent - 1);
          nl();
          line = pad() + '}';
          prev = t;
          nl();
        } else { // obj
          indent = Math.max(0, indent - 1);
          nl();
          line = pad() + '}';
          prev = t;
          var lk2 = nextSig(T, i + 1);
          if (lk2 && lk2.v !== ',' && lk2.v !== ')' && lk2.v !== ']' && lk2.v !== ';' && lk2.v !== '.') nl();
        }
        i++; continue;
      }
      if (v === ';') {
        if (line === '') line = pad();
        line += ';';
        prev = t;
        if (parenDepthAt(T, i) === 0) nl();
        i++; continue;
      }
      if (v === ',') {
        if (line === '') line = pad();
        line += ',';
        prev = t;
        if (inCtx(stack, 'obj') && parenDepthAt(T, i) === 0) nl();
        i++; continue;
      }
      if (v === ':') {
        var first = line.trim().split(/[\s:]/)[0];
        if (first === 'case' || first === 'default') {
          if (line === '') line = pad();
          line += ':';
          prev = t;
          nl();
          indent++;
          stack.push('case');
        } else { emit(t); }
        i++; continue;
      }
      emit(t);
      i++; continue;
    }
    nl();
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd() + '\n';
  }
  function inCtx(stack, kind) {
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === kind) return true;
      if (stack[i] === 'block' || stack[i] === 'obj') return false;
    }
    return false;
  }
  function stackHasDo(T, idx) {
    for (var i = idx - 1; i >= 0; i--) {
      var t = T[i];
      if (t.t === 'ws') continue;
      if (t.t === 'w' && t.v === 'do') return true;
      return false;
    }
    return false;
  }

  /* ================= CSS / LESS / SCSS ================= */
  function formatCss(src, indentSize) {
    src = String(src == null ? '' : src).replace(/\r\n/g, '\n');
    var out = [], indent = 0, buf = '';
    var i = 0, n = src.length;
    function flushDecl() {
      var s = buf.trim();
      buf = '';
      if (!s) return;
      var ci = s.indexOf(':');
      if (ci > 0 && s.charAt(0) !== '@') {
        var prop = s.slice(0, ci).trim();
        var val = s.slice(ci + 1).trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ');
        out.push(repeat(indent * indentSize) + prop + ': ' + val + ';');
      } else {
        out.push(repeat(indent * indentSize) + s + (s.slice(-1) === ';' || s.slice(-1) === '}' ? '' : ';'));
      }
    }
    function flushSelector() {
      var s = buf.trim();
      buf = '';
      if (!s) return;
      s = s.replace(/\s*\n\s*/g, ' ').replace(/\s*,\s*/g, ',\n' + repeat(indent * indentSize)).replace(/\s+/g, ' ');
      out.push(repeat(indent * indentSize) + s + ' {');
      indent++;
    }
    while (i < n) {
      var ch = src[i];
      if (ch === '/' && src[i + 1] === '*') {
        var e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
        if (buf.trim()) flushSelector();
        var cmtLines = src.slice(i, e).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        for (var c of cmtLines) out.push(repeat(indent * indentSize) + c);
        i = e; continue;
      }
      if (ch === '"' || ch === "'") {
        var k = i + 1;
        while (k < n && src[k] !== ch) { if (src[k] === '\\') k++; k++; }
        buf += src.slice(i, k + 1); i = k + 1; continue;
      }
      if (ch === '{') { flushSelector(); i++; continue; }
      if (ch === '}') {
        if (buf.trim()) flushDecl();
        indent = Math.max(0, indent - 1);
        out.push(repeat(indent * indentSize) + '}');
        i++; continue;
      }
      if (ch === ';') { flushDecl(); i++; continue; }
      if (ch === '\n') { if (buf.trim()) buf += ' '; i++; continue; }
      buf += ch; i++;
    }
    if (buf.trim()) flushDecl();
    var dedup = [];
    for (var l of out) {
      if (l.trim() === '' && dedup.length && dedup[dedup.length - 1].trim() === '') continue;
      dedup.push(l);
    }
    return dedup.join('\n').replace(/\n{2,}/g, '\n').trim() + '\n';
  }

  /* ================= HTML / XML / VUE ================= */
  var VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  var RAW_TAGS = new Set(['script', 'style', 'pre', 'textarea']);

  function parseTags(src) {
    var nodes = [], i = 0, n = src.length;
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { nodes.push({ type: 'text', v: src.slice(i) }); break; }
      if (lt > i) nodes.push({ type: 'text', v: src.slice(i, lt) });
      if (src.startsWith('<!--', lt)) {
        var e = src.indexOf('-->', lt + 4); e = e < 0 ? n : e + 3;
        nodes.push({ type: 'comment', v: src.slice(lt, e) }); i = e; continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        var e2 = src.indexOf(']]>', lt + 9); e2 = e2 < 0 ? n : e2 + 3;
        nodes.push({ type: 'raw', v: src.slice(lt, e2) }); i = e2; continue;
      }
      var gt = src.indexOf('>', lt);
      if (gt < 0) { nodes.push({ type: 'text', v: src.slice(lt) }); break; }
      var tag = src.slice(lt + 1, gt);
      if (tag[0] === '/') {
        var nm0 = tag.match(/^\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
        nodes.push({ type: 'close', v: nm0 ? nm0[1].toLowerCase() : '' });
        i = gt + 1; continue;
      }
      if (tag[0] === '!' || tag[0] === '?') {
        nodes.push({ type: 'raw', v: src.slice(lt, gt + 1) });
        i = gt + 1; continue;
      }
      var nameM = tag.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
      var name = nameM ? nameM[1].toLowerCase() : '';
      var selfClose = /\/\s*$/.test(tag);
      nodes.push({ type: 'open', v: name, attrs: tag.slice(name.length).replace(/\/\s*$/, '').trim(), self: selfClose || VOID_TAGS.has(name) });
      i = gt + 1;
      if (!selfClose && !VOID_TAGS.has(name) && RAW_TAGS.has(name)) {
        var closeIdx = src.toLowerCase().indexOf('</' + name, i);
        if (closeIdx < 0) { nodes.push({ type: 'text', v: src.slice(i) }); i = n; continue; }
        nodes.push({ type: 'raw', v: src.slice(i, closeIdx) });
        var closeEnd = src.indexOf('>', closeIdx);
        nodes.push({ type: 'close', v: name });
        i = closeEnd + 1;
      }
    }
    return nodes;
  }

  function formatMarkup(src, indentSize) {
    var nodes = parseTags(String(src == null ? '' : src).replace(/\r\n/g, '\n'));
    var out = [], indent = 0, openStack = [];
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.type === 'text') {
        var linesT = nd.v.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        for (var l of linesT) out.push(repeat(indent * indentSize) + l);
        continue;
      }
      if (nd.type === 'comment' || nd.type === 'raw') {
        var cl = nd.v.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        for (var c of cl) out.push(repeat(indent * indentSize) + c);
        continue;
      }
      if (nd.type === 'open') {
        // 短文本内联：<tag>text</tag> 同行
        var nx = nodes[i + 1], nx2 = nodes[i + 2];
        if (!nd.self && nx && nx.type === 'text' && nx2 && nx2.type === 'close' && nx2.v === nd.v) {
          var txt = nx.v.trim();
          if (txt && txt.indexOf('\n') < 0 && txt.length <= 80) {
            var attr2 = nd.attrs ? ' ' + nd.attrs.replace(/\s+/g, ' ') : '';
            out.push(repeat(indent * indentSize) + '<' + nd.v + attr2 + '>' + txt + '</' + nd.v + '>');
            i += 2;
            continue;
          }
        }
        var attr = nd.attrs ? ' ' + nd.attrs.replace(/\s+/g, ' ') : '';
        out.push(repeat(indent * indentSize) + '<' + nd.v + attr + (nd.self ? ' />' : '>'));
        if (!nd.self) { indent++; openStack.push(nd.v); }
        continue;
      }
      if (nd.type === 'close') {
        var idx = openStack.lastIndexOf(nd.v);
        if (idx >= 0) {
          indent = Math.max(0, indent - (openStack.length - idx));
          openStack = openStack.slice(0, idx);
        }
        out.push(repeat(indent * indentSize) + '</' + nd.v + '>');
        continue;
      }
    }
    return out.join('\n').trim() + '\n';
  }

  /* ================= JSON / JSON5 ================= */
  function parseJsonLoose(src) {
    var s = String(src == null ? '' : src).trim();
    try { return JSON.parse(s); } catch (eStrict) { } // 合法 JSON 直接走严格解析，避免宽松路径误伤字符串内容
    var out = '', inStr = null;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inStr) {
        out += ch;
        if (ch === '\\') { out += s[i + 1] || ''; i++; }
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ch; continue; }
      if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (ch === '/' && s[i + 1] === '*') { var e = s.indexOf('*/', i + 2); if (e < 0) throw new Error('未闭合的块注释'); i = e + 1; continue; }
      out += ch;
    }
    s = out.replace(/,(\s*[}\]])/g, '$1');
    s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
    s = s.replace(/'((?:[^'\\]|\\.)*)'/g, function (m, inner) { return '"' + inner.replace(/"/g, '\\"') + '"'; });
    return JSON.parse(s);
  }
  function formatJson(src, indentSize) {
    var s = String(src == null ? '' : src).trim();
    var obj;
    try { obj = JSON.parse(s); }
    catch (e1) { obj = parseJsonLoose(s); }
    return JSON.stringify(obj, null, indentSize) + '\n';
  }

  /* ================= YAML（保守整理：tab→2空格、去尾空格、收敛空行） ================= */
  function formatYaml(src) {
    var ls = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n')
      .map(function (l) { return l.replace(/\t/g, '  ').replace(/[ \t]+$/, ''); });
    var out = [], blank = 0;
    for (var l of ls) {
      if (l.trim() === '') { if (++blank <= 1) out.push(''); continue; }
      blank = 0;
      out.push(l);
    }
    return out.join('\n').replace(/^\n+|\n+$/g, '') + '\n';
  }

  /* ================= SQL ================= */
  var SQL_MAJOR2 = ['INSERT INTO', 'GROUP BY', 'ORDER BY', 'DELETE FROM', 'UNION ALL', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE'];
  var SQL_MAJOR1 = ['SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'UPDATE', 'SET', 'UNION', 'JOIN', 'ON', 'WITH'];
  var SQL_UP = /^(SELECT|FROM|WHERE|AND|OR|NOT|NULL|IN|LIKE|BETWEEN|IS|AS|DISTINCT|CASE|WHEN|THEN|ELSE|END|ASC|DESC|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|JOIN|ON|GROUP|ORDER|BY|HAVING|UNION|LEFT|RIGHT|INNER|OUTER|CROSS|CREATE|TABLE|ALTER|DROP|WITH|COUNT|SUM|AVG|MIN|MAX)$/i;
  /* 把字符串字面量暂时替换为占位符，空白收敛/替换只作用于代码部分（占位符 1 起编） */
  function maskStrings(s, re) {
    var store = [];
    var masked = s.replace(re, function (m2) { store.push(m2); return '\x00' + store.length + '\x00'; });
    return { masked: masked, unmask: function (t) { return t.replace(/\x00\d+\x00/g, function (ph) { var v = store[+ph.slice(1, -1) - 1]; return v === undefined ? '' : v; }); } };
  }
  var SQL_STR_RE = /'(?:[^']|'')*'|"(?:[^"]|"")*"/g;
  function formatSql(src, indentSize, upper) {
    var m1 = maskStrings(String(src == null ? '' : src).replace(/\r\n/g, '\n'), SQL_STR_RE);
    var s = m1.masked.replace(/\s+/g, ' ').replace(/,/g, ' , ').trim();
    if (!s) return '\n';
    var tokens = s.split(' ');
    var lines2 = [], cur = '', depth = 0;
    function isMajor(j) {
      var two = (tokens[j] + ' ' + (tokens[j + 1] || '')).toUpperCase();
      if (SQL_MAJOR2.indexOf(two) >= 0) return 2;
      if (SQL_MAJOR1.indexOf(tokens[j].toUpperCase()) >= 0) return 1;
      return 0;
    }
    for (var j = 0; j < tokens.length; j++) {
      var m = depth === 0 ? isMajor(j) : 0;
      if (m) {
        if (cur.trim()) lines2.push(cur);
        cur = m === 2 ? tokens[j].toUpperCase() + ' ' + tokens[j + 1].toUpperCase() : tokens[j].toUpperCase();
        if (m === 2) j++;
        continue;
      }
      var tk = upper && SQL_UP.test(tokens[j]) ? tokens[j].toUpperCase() : tokens[j];
      var opens = (tk.match(/\(/g) || []).length, closes = (tk.match(/\)/g) || []).length;
      depth = Math.max(0, depth + opens - closes);
      cur += (cur.trim() && tk !== ',' ? ' ' : '') + tk;
      if (tk === ',' && depth === 0 && j + 1 < tokens.length) {
        lines2.push(cur);
        cur = ' '.repeat(indentSize);
      }
    }
    if (cur.trim()) lines2.push(cur);
    return m1.unmask(lines2.join('\n').replace(/\n{2,}/g, '\n').trimEnd()) + '\n';
  }

  /* ================= Markdown（保守整理） ================= */
  function formatMarkdown(src) {
    var ls = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
    var out = [], inFence = false;
    for (var l of ls) {
      if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; out.push(l.trim()); continue; }
      if (inFence) { out.push(l); continue; }
      l = l.replace(/[ \t]+$/, '');
      l = l.replace(/^(#{1,6})([^ #\n])/, '$1 $2');
      l = l.replace(/^(\s*)[-*+][ \t]+/, '$1- ');
      out.push(l);
    }
    var res = [], blank = 0;
    for (var l2 of out) {
      if (l2.trim() === '') { if (++blank <= 1) res.push(''); continue; }
      blank = 0; res.push(l2);
    }
    return res.join('\n').replace(/^\n+|\n+$/g, '') + '\n';
  }

  /* ================= 压缩 ================= */
  function minifyJs(src) {
    var T = cTokens(String(src == null ? '' : src));
    var out = '';
    var prev = null;
    for (var i = 0; i < T.length; i++) {
      var t = T[i];
      if (t.t === 'ws') {
        // 依赖换行 ASI 的语句边界补分号（启发式）
        if (t.nl >= 1 && prev && (prev.t === 'w' || prev.t === 'num' || prev.t === 'str')) {
          var nxt = nextSig(T, i + 1);
          if (nxt && (nxt.t === 'w' || nxt.t === 'num' || nxt.t === 'str')) out += ';';
        }
        continue;
      }
      if (t.t === 'lc' || t.t === 'bc') continue;
      var v = t.v;
      if (v === '}' && /;$/.test(out)) out = out.slice(0, -1);
      if (t.t === 'w' && (v === 'else' || v === 'do') && out.endsWith('}')) { out += v; prev = t; continue; }
      if (out && /[\w$)\]'"]$/.test(out) && /[\w$'"(]/.test(v.charAt(0)) === false) { out += v; prev = t; continue; }
      if (out && /[\w$)]$/.test(out) && (/^[\w$]/.test(v) || v.charAt(0) === '"' || v.charAt(0) === "'" || v.charAt(0) === '`' || v === '(')) out += ' ';
      else if (out && !/;$/.test(out) && prev && (prev.t === 'w' || prev.t === 'num') && (t.t === 'w' || t.t === 'num' || t.t === 'str')) out += ' ';
      else if (out && !/;$/.test(out) && prev && prev.t === 'str' && (t.t === 'w')) out += ' ';
      out += v;
      prev = t;
    }
    // 压缩在 token 层完成；不得对结果串做全局替换——字符串字面量内容不容改写
    return out.trim();
  }
  function minifyCss(src) {
    var m1 = maskStrings(String(src == null ? '' : src), /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g);
    var s = m1.masked.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    s = s.replace(/\s*([{}:;,>~])\s*/g, '$1').replace(/;}/g, '}');
    return m1.unmask(s).trim();
  }
  function minifyMarkup(src) {
    var nodes = parseTags(String(src == null ? '' : src).replace(/\r\n/g, '\n'));
    var out = '', skip = 0;
    for (var nd of nodes) {
      if (nd.type === 'text') { out += skip > 0 ? nd.v : nd.v.replace(/\s+/g, ' '); continue; }
      if (nd.type === 'comment') continue;
      if (nd.type === 'open') {
        if (RAW_TAGS.has(nd.v)) skip++;
        out += '<' + nd.v + (nd.attrs ? ' ' + nd.attrs.replace(/\s+/g, ' ') : '') + (nd.self ? ' />' : '>');
      } else if (nd.type === 'close') {
        if (RAW_TAGS.has(nd.v)) skip = Math.max(0, skip - 1);
        out += '</' + nd.v + '>';
      } else out += nd.v;
    }
    return out.trim();
  }
  function minifyJson(src) {
    var s = String(src == null ? '' : src).trim();
    try { return JSON.stringify(JSON.parse(s)); }
    catch (e) { return JSON.stringify(parseJsonLoose(s)); }
  }
  function minifySql(src) {
    var m1 = maskStrings(String(src == null ? '' : src), SQL_STR_RE);
    return m1.unmask(m1.masked.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim());
  }
  function minifyYaml(src) {
    return String(src == null ? '' : src).split('\n')
      .filter(function (l) { var t = l.trim(); return t && !t.startsWith('#'); }).join('\n');
  }

  return {
    formatC: formatC, cTokens: cTokens,
    formatCss: formatCss, formatMarkup: formatMarkup, parseTags: parseTags,
    formatJson: formatJson, parseJsonLoose: parseJsonLoose,
    formatYaml: formatYaml, formatSql: formatSql, formatMarkdown: formatMarkdown,
    minifyJs: minifyJs, minifyCss: minifyCss, minifyMarkup: minifyMarkup,
    minifyJson: minifyJson, minifySql: minifySql, minifyYaml: minifyYaml
  };
})();
if (typeof globalThis !== 'undefined') globalThis.Fmt = Fmt;