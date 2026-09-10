/* ── 正则编辑器 · 示例推断引擎 ───────────────────────────────
   从若干示例字符串推断正则：
   1. 每条示例切分成「游程」(同类的连续字符段：数字/字母/汉字/空白/字面量)；
   2. 多条示例按游程序列做 DP 对齐合并，得到每段的字符类与长度区间；
   3. 按选项渲染成正则，并生成中文解读。
   差异过大时回退为枚举 (?:a|b|c) 或宽度通配，保证永远有产出。 */
(function (global) {
  'use strict';

  var INF = 1e9;
  var MAX_EXAMPLES = 200;
  var MAX_EXAMPLE_LEN = 500;

  /* ── 字符分类 ──
     d 数字  l 小写  u 大写  a 字母  w 字母数字下划线
     s 空白  c 汉字  x 字面量(逐字符) */
  function classify(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57) return 'd';
    if (c >= 97 && c <= 122) return 'l';
    if (c >= 65 && c <= 90) return 'u';
    if (ch === ' ' || ch === '\t') return 's';
    if (c >= 0x4e00 && c <= 0x9fff) return 'c';
    return 'x';
  }

  function applyFold(k, fold) {
    if (fold && (k === 'l' || k === 'u')) return 'a';
    return k;
  }

  /* 切游程：相邻同类合并；相同字面量合并计数 */
  function tokenize(s, fold) {
    var runs = [], i = 0;
    while (i < s.length) {
      var ch = s[i];
      var k = classify(ch);
      if (k === 'x') {
        var j = i + 1;
        while (j < s.length && s[j] === ch) j++;
        runs.push({ cls: 'lit', ch: ch, min: j - i, max: j - i });
        i = j;
      } else {
        var j2 = i + 1;
        while (j2 < s.length && classify(s[j2]) === k) j2++;
        runs.push({ cls: applyFold(k, fold), min: j2 - i, max: j2 - i });
        i = j2;
      }
    }
    return runs;
  }

  /* ── 字面量与字符类渲染 ── */
  var LIT_SPECIALS = '\\^$.|?*+()[]{}';
  function escapeLiteral(ch) {
    if (LIT_SPECIALS.indexOf(ch) >= 0) return '\\' + ch;
    return ch;
  }
  function escapeInClass(ch) {
    if (ch === '\\' || ch === ']' || ch === '^' || ch === '[' || ch === '-') return '\\' + ch;
    return ch;
  }

  function renderSet(chars) {
    var uniq = [];
    chars.forEach(function (c) { if (uniq.indexOf(c) < 0) uniq.push(c); });
    if (uniq.length === 1) return escapeLiteral(uniq[0]);
    var body = uniq.map(escapeInClass).join('');
    return '[' + body + ']';
  }

  function renderClass(run, opts) {
    var k = run.cls, compact = opts.compact;
    switch (k) {
      case 'lit': return escapeLiteral(run.ch);
      case 'd': return compact ? '\\d' : '[0-9]';
      case 'l': return '[a-z]';
      case 'u': return '[A-Z]';
      case 'a': return '[A-Za-z]';
      case 'w': return compact ? '\\w' : '[A-Za-z0-9_]';
      case 'c': return '[\\u4e00-\\u9fa5]';
      case 's': return '\\s';
      case 'set': return renderSet(run.chars || []);
      default: return '.';
    }
  }

  var CLASS_DESC = {
    d: '数字', l: '小写字母', u: '大写字母', a: '字母（不分大小写）',
    w: '字母/数字/下划线', c: '汉字', s: '空白字符', set: '指定字符集合', any: '任意字符'
  };

  /* ── 量词渲染与描述 ── */
  function renderQuant(min, max, atom) {
    if (min === 1 && max === 1) return atom;
    var q;
    if (min === max) q = '{' + min + '}';
    else if (min === 0) q = max >= INF ? '*' : (max === 1 ? '?' : '{0,' + max + '}');
    else q = max >= INF ? '{' + min + ',}' : '{' + min + ',' + max + '}';
    /* 单字符原子可直接跟量词；类/字面量渲染出来都是单元素 */
    return atom + q;
  }
  function quantDesc(min, max) {
    if (min === 1 && max === 1) return '';
    if (min === max) return '重复 ' + min + ' 次';
    if (min === 0) {
      if (max >= INF) return '任意次';
      if (max === 1) return '可选（0~1 次）';
      return '出现 0~' + max + ' 次';
    }
    return max >= INF ? '至少 ' + min + ' 次' : '重复 ' + min + '~' + max + ' 次';
  }

  /* ── 两个游程合并：返回 {cost, run} ──
     字面量字符能否归入字符类 k（决定合并代价为 0 还是降级） */
  function litFitsClass(ch, k, fold) {
    var ck = applyFold(classify(ch), fold);
    if (ck === k) return true;
    if (ck === 'a') return k === 'a' || k === 'w';
    if (ck === 'd') return k === 'w';
    if (ck === 'l' || ck === 'u') return k === 'a' || k === 'w';
    if (ck === 's') return k === 's';
    return false;
  }

  function mergeTwo(a, b, fold) {
    /* 返回 {cost, run}；run 为合并结果（min/max 取区间并集） */
    if (a.cls === 'lit' && b.cls === 'lit') {
      if (a.ch === b.ch) {
        return { cost: 0, run: { cls: 'lit', ch: a.ch, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
      }
      return {
        cost: 0.5,
        run: { cls: 'set', chars: [a.ch, b.ch], min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
      };
    }
    /* set 参与：字符并集（保留已并入的字符，第 3 种起继续并入而非降级） */
    if (a.cls === 'set' || b.cls === 'set') {
      var setRun = a.cls === 'set' ? a : b;
      var other = a.cls === 'set' ? b : a;
      var chars = setRun.chars.slice();
      var cls2 = 'set';
      if (other.cls === 'lit') {
        if (chars.indexOf(other.ch) < 0) chars.push(other.ch);
      } else if (other.cls === 'set') {
        other.chars.forEach(function (c) { if (chars.indexOf(c) < 0) chars.push(c); });
      } else if (chars.every(function (c) { return litFitsClass(c, other.cls, fold); })) {
        cls2 = other.cls; /* 字符集整体可归入该类（如全部数字 → \d） */
      } else {
        return { cost: 2, run: { cls: 'any', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
      }
      if (chars.length > 24) return { cost: 2, run: { cls: 'any', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
      return { cost: 0.5, run: { cls: cls2, chars: chars, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
    }
    if (a.cls === 'lit') {
      if (litFitsClass(a.ch, b.cls, fold)) return { cost: 0, run: { cls: b.cls, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
      return { cost: 2, run: { cls: 'any', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
    }
    if (b.cls === 'lit') return mergeTwo(b, a, fold);

    if (a.cls === b.cls) return { cost: 0, run: { cls: a.cls, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
    var letterish = { l: 1, u: 1, a: 1 };
    if (letterish[a.cls] && letterish[b.cls]) return { cost: 0, run: { cls: 'a', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
    if ((a.cls === 'd' || letterish[a.cls]) && (b.cls === 'd' || letterish[b.cls])) {
      return { cost: 0.5, run: { cls: 'w', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
    }
    return { cost: 2, run: { cls: 'any', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } };
  }

  /* ── DP 对齐两条游程序列 ──
     返回 {ops, cost}: ops 为 ['=',i,j] ['-',i] ['+',j] 序列 */
  function align(A, B, fold) {
    var n = A.length, m = B.length;
    var GAP = 1.0;
    var d = new Array((n + 1) * (m + 1));
    var i, j;
    d[0] = 0;
    for (i = 1; i <= n; i++) d[i * (m + 1)] = i * GAP;
    for (j = 1; j <= m; j++) d[j] = j * GAP;
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        var sub = d[(i - 1) * (m + 1) + (j - 1)] + mergeTwo(A[i - 1], B[j - 1], fold).cost;
        var del = d[(i - 1) * (m + 1) + j] + GAP;
        var ins = d[i * (m + 1) + (j - 1)] + GAP;
        var best = sub, op = 0;
        if (del < best) { best = del; op = 1; }
        if (ins < best) { best = ins; op = 2; }
        d[i * (m + 1) + j] = best;
      }
    }
    var ops = [], ci = n, cj = m, cost = d[n * (m + 1) + m];
    while (ci > 0 || cj > 0) {
      if (ci > 0 && cj > 0 && d[ci * (m + 1) + cj] === d[(ci - 1) * (m + 1) + (cj - 1)] + mergeTwo(A[ci - 1], B[cj - 1], fold).cost) {
        ops.push(['=', ci - 1, cj - 1]); ci--; cj--;
      } else if (ci > 0 && d[ci * (m + 1) + cj] === d[(ci - 1) * (m + 1) + cj] + GAP) {
        ops.push(['-', ci - 1]); ci--;
      } else {
        ops.push(['+', cj - 1]); cj--;
      }
    }
    ops.reverse();
    return { ops: ops, cost: cost };
  }

  /* 逐条把示例合并进当前游程模型。
     规模护栏：模型游程数超限即中止（bail），由上层回退到枚举/宽松模式，
     避免 200 条×500 字符的极端示例把同步 DP 推到秒级以上。 */
  var MAX_MODEL_RUNS = 140;
  var MAX_SINGLE_RUNS = 80;
  var MAX_TOTAL_RUNS = 2400;

  function mergeAll(tokenLists, fold) {
    var model = tokenLists[0].map(function (r) { return cloneRun(r); });
    var cost = 0, bailed = false;
    for (var t = 1; t < tokenLists.length; t++) {
      var res = align(model, tokenLists[t], fold);
      cost += res.cost;
      var merged = [];
      for (var k = 0; k < res.ops.length; k++) {
        var op = res.ops[k];
        if (op[0] === '=') {
          var m2 = mergeTwo(model[op[1]], tokenLists[t][op[2]], fold);
          merged.push(m2.run);
        } else if (op[0] === '-') {
          var r = cloneRun(model[op[1]]);
          r.min = 0;
          merged.push(r);
        } else {
          var r2 = cloneRun(tokenLists[t][op[2]]);
          r2.min = 0;
          merged.push(r2);
        }
      }
      model = coalesce(merged);
      if (model.length > MAX_MODEL_RUNS) { bailed = true; break; }
    }
    return { model: model, cost: cost, bailed: bailed };
  }

  function cloneRun(r) {
    var o = { cls: r.cls, min: r.min, max: r.max };
    if (r.ch !== undefined) o.ch = r.ch;
    if (r.chars) o.chars = r.chars.slice();
    return o;
  }

  /* 相邻同类（含可选区间）游程二次合并，让 \d{0,2}\d{1,3} 这类缝合成 \d{1,5} 的近似 */
  function coalesce(runs) {
    var out = [];
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var last = out.length ? out[out.length - 1] : null;
      if (last && last.cls === r.cls && last.cls !== 'lit' && last.cls !== 'set') {
        last.min = Math.min(last.min, r.min);
        last.max = Math.max(last.max, r.max);
        last.min = Math.min(last.min, last.max);
      } else {
        out.push(cloneRun(r));
      }
    }
    return out;
  }

  /* ── 对外：从示例数组生成 ── */
  function fromExamples(examples, opts) {
    opts = opts || {};
    var fold = !!opts.fold;
    var notes = [];
    var lines = [];
    for (var i = 0; i < examples.length; i++) {
      var s = String(examples[i]).replace(/\r$/, '');
      if (!s.trim()) continue;
      if (s.length > MAX_EXAMPLE_LEN) { s = s.slice(0, MAX_EXAMPLE_LEN); }
      lines.push(s);
      if (lines.length >= MAX_EXAMPLES) break;
    }
    if (!lines.length) {
      return { pattern: '', explain: [], matched: 0, total: 0, notes: ['没有可用示例：请输入至少一行非空文本'] };
    }
    if (examples.length > MAX_EXAMPLES) notes.push('示例超过 ' + MAX_EXAMPLES + ' 行，仅取前 ' + MAX_EXAMPLES + ' 行参与推断');
    if (examples.some(function (e) { return String(e).length > MAX_EXAMPLE_LEN; })) {
      notes.push('单条示例超过 ' + MAX_EXAMPLE_LEN + ' 字符的已截断');
    }

    var tokenLists = lines.map(function (s) { return tokenize(s, fold); });

    /* 结构完全一致：逐位直配（最准） */
    var same = tokenLists.every(function (tl) {
      if (tl.length !== tokenLists[0].length) return false;
      for (var k = 0; k < tl.length; k++) {
        var a = tl[k], b = tokenLists[0][k];
        if (a.cls !== b.cls) return false;
        if (a.cls === 'lit' && a.ch !== b.ch) return false;
      }
      return true;
    });

    var model, alt = false;
    if (same) {
      model = tokenLists[0].map(function (r, idx) {
        var merged = cloneRun(r);
        for (var t = 1; t < tokenLists.length; t++) {
          var o = tokenLists[t][idx];
          if (merged.cls === 'lit' && o.cls === 'lit' && o.ch !== merged.ch) {
            merged = { cls: 'set', chars: [merged.ch, o.ch], min: Math.min(merged.min, o.min), max: Math.max(merged.max, o.max) };
          } else if (merged.cls === 'set') {
            /* 第 3 种及以后的字面量并入既有字符集 */
            if (o.cls === 'lit') {
              if (merged.chars.indexOf(o.ch) < 0) merged.chars.push(o.ch);
            } else if (o.cls === 'set' && o.chars) {
              o.chars.forEach(function (c) { if (merged.chars.indexOf(c) < 0) merged.chars.push(c); });
            }
            merged.min = Math.min(merged.min, o.min);
            merged.max = Math.max(merged.max, o.max);
          } else {
            merged.min = Math.min(merged.min, o.min);
            merged.max = Math.max(merged.max, o.max);
          }
        }
        if (merged.cls === 'set' && merged.chars && merged.chars.length > 24) {
          merged = { cls: 'any', min: merged.min, max: merged.max };
          notes.push('示例在第 ' + (idx + 1) + ' 段差异过大，已放宽为任意字符');
        }
        return merged;
      });
    } else {
      var maxRuns = 0, totalRuns = 0;
      tokenLists.forEach(function (tl) {
        if (tl.length > maxRuns) maxRuns = tl.length;
        totalRuns += tl.length;
      });
      var res = (maxRuns > MAX_SINGLE_RUNS || totalRuns > MAX_TOTAL_RUNS)
        ? { model: [], cost: 0, bailed: true }
        : mergeAll(tokenLists, fold);
      model = res.bailed ? [] : coalesce(res.model);
      /* 差异过大 / 规模超限 → 枚举或通配回退 */
      var totalLen = lines.reduce(function (a, s) { return a + s.length; }, 0);
      if (res.bailed || res.cost > Math.max(3.5, totalLen * 0.12)) {
        alt = true;
        if (lines.length <= 8 && lines.every(function (s) { return s.length <= 64; })) {
          var body = lines.map(function (s) {
            return s.split('').map(escapeLiteral).join('');
          }).join('|');
          model = { ALT: body };
          notes.push(res.bailed ? '示例规模过大，已改为逐条枚举匹配' : '示例结构差异较大，已改为逐条枚举匹配');
        } else {
          var mn = Math.min.apply(null, lines.map(function (s) { return s.length; }));
          var mx = Math.max.apply(null, lines.map(function (s) { return s.length; }));
          model = { ANYW: [mn, mx] };
          notes.push('示例差异过大且条数偏多，仅给出长度约束的宽松模式');
        }
      } else {
        notes.push('示例存在结构差异，已按对齐合并推断（区间为各示例的并集）');
      }
    }

    /* 渲染 */
    var body, explain = [];
    if (alt && model.ALT !== undefined) {
      body = '(?:' + model.ALT + ')';
      explain.push('枚举 ' + lines.length + ' 条示例的完整字面量（差异过大时的保底方案）');
    } else if (model.ANYW !== undefined) {
      body = '.{' + model.ANYW[0] + ',' + model.ANYW[1] + '}';
      explain.push('任意 ' + model.ANYW[0] + '~' + model.ANYW[1] + ' 个字符（宽松兜底）');
    } else {
      var parts = [];
      for (var k2 = 0; k2 < model.length; k2++) {
        var r = model[k2];
        var atom = renderClass(r, opts);
        parts.push(renderQuant(r.min, r.max, atom));
        var desc = r.cls === 'lit' ? '字面量 ' + JSON.stringify(r.ch) : (CLASS_DESC[r.cls] || r.cls);
        var q = quantDesc(r.min, r.max);
        explain.push((q ? q.replace(/次/, '次') + '（' : '1 个（') + desc + (q ? '）' : '）'));
      }
      body = parts.join('');
    }
    if (opts.anchor) {
      body = '^' + body + '$';
      notes.push('已整行锚定 ^…$：在多行内容中测试需加 m 标志按行匹配，或取消「整行匹配」改为片段匹配');
    }

    /* 校验：几条示例能被生成结果完整命中 */
    var matched = 0, re = null;
    try {
      re = new RegExp(body);
      for (var v = 0; v < lines.length; v++) {
        if (re.test(lines[v])) matched++;
      }
    } catch (e) { notes.push('生成的正则无法编译：' + e.message); }

    return { pattern: body, explain: explain.slice(0, 60), matched: matched, total: lines.length, notes: notes };
  }

  /* 从大文本取示例行（供「取自内容」）；单行超 500 字符就地截断，
     避免超长单行原样灌进示例框 */
  function linesFromContent(content, maxLines) {
    maxLines = maxLines || MAX_EXAMPLES;
    var out = [], start = 0, idx;
    var s = content;
    while (out.length < maxLines && start < s.length) {
      idx = s.indexOf('\n', start);
      var line = idx < 0 ? s.slice(start) : s.slice(start, idx);
      line = line.replace(/\r$/, '').trim();
      if (line.length > MAX_EXAMPLE_LEN) line = line.slice(0, MAX_EXAMPLE_LEN);
      if (line) out.push(line);
      if (idx < 0) break;
      start = idx + 1;
    }
    return out;
  }

  /* ── 任意正则的中文解读（尽力而为） ── */
  function explainPattern(src) {
    if (!src) return ['（空正则）'];
    if (src.length > 3000) return ['正则过长（' + src.length + ' 字符），略去解读'];
    var out = [];
    var i = 0;
    var ERR = null;
    function lit(c) {
      if (c === ' ') return '空格';
      if (c === '\t') return '制表符';
      return JSON.stringify(c);
    }
    while (i < src.length && out.length < 60) {
      var c = src[i];
      if (c === '\\') {
        var n = src[i + 1];
        if (n === undefined) { out.push('字面量 \\'); i++; continue; }
        if (n === 'd') { out.push('数字 \\d'); }
        else if (n === 'D') { out.push('非数字 \\D'); }
        else if (n === 'w') { out.push('字母/数字/下划线 \\w'); }
        else if (n === 'W') { out.push('非字母数字 \\W'); }
        else if (n === 's') { out.push('空白 \\s'); }
        else if (n === 'S') { out.push('非空白 \\S'); }
        else if (n === 'b') { out.push('单词边界 \\b'); }
        else if (n === 'B') { out.push('非单词边界 \\B'); }
        else if (n === 'n') { out.push('换行符'); }
        else if (n === 't') { out.push('制表符'); }
        else if (n === 'r') { out.push('回车符'); i += 2; continue; }
        else if (n === 'u' && src[i + 2] === '{') {
          var close2 = src.indexOf('}', i + 2);
          out.push(close2 > 0 ? '字面量 ' + src.slice(i, close2 + 1) : '字面量 ' + src.slice(i, i + 6));
          i = close2 > 0 ? close2 + 1 : i + 6;
          continue;
        }
        else if (n === 'u' || n === 'x') { out.push('字面量 ' + src.slice(i, i + (n === 'u' ? 6 : 4))); }
        else if (n === '0') { out.push('字面量 NUL'); }
        else if (n >= '0' && n <= '9') { out.push('反向引用分组 ' + n); }
        else { out.push('字面量 ' + lit(n)); }
        i += (n === 'u' ? 6 : n === 'x' ? 4 : 2);
        continue;
      }
      if (c === '[') {
        var j = i + 1, neg = false;
        if (src[j] === '^') { neg = true; j++; }
        if (src[j] === ']') j++;
        while (j < src.length && src[j] !== ']') {
          if (src[j] === '\\') j++;
          j++;
        }
        if (j >= src.length) { ERR = '字符类未闭合'; break; }
        out.push((neg ? '「不在集合内」' : '「集合内」') + src.slice(i, j + 1));
        i = j + 1;
        var qt = readQuant(src, i);
        if (qt.consumed) { out[out.length - 1] += quantPhrase(qt); i += qt.consumed; }
        continue;
      }
      if (c === '(') {
        if (src.slice(i, i + 3) === '(?:') { out.push('分组开始（不捕获）'); i += 3; }
        else if (src.slice(i, i + 3) === '(?=' || src.slice(i, i + 3) === '(?!') { out.push(src[i + 2] === '=' ? '正向预查开始 (?=' : '负向预查开始 (?!'); i += 3; }
        else if (src.slice(i, i + 4) === '(?<=' || src.slice(i, i + 4) === '(?<!') { out.push(src[i + 3] === '=' ? '正向后顾开始 (?<=' : '负向后顾开始 (?<!'); i += 4; }
        else if (src[i + 1] === '?') {
          var close = src.indexOf('>', i);
          if (src[i + 2] === '<' && close > 0) { out.push('命名分组「' + src.slice(i + 3, close) + '」开始'); i = close + 1; }
          else { out.push('分组开始 (?…)'); i += 2; }
        } else { out.push('捕获分组开始 ('); i += 1; }
        continue;
      }
      if (c === ')') { out.push('分组结束'); i++; continue; }
      if (c === '|') { out.push('「或」'); i++; continue; }
      if (c === '^') { out.push('行首 ^'); i++; continue; }
      if (c === '$') { out.push('行尾 $'); i++; continue; }
      if (c === '.') { out.push('除换行外任意字符 .'); i++; continue; }
      if (c === '*' || c === '+' || c === '?') { out[out.length - 1] && (out[out.length - 1] += ({ '*': '，重复任意次 *', '+': '，至少一次 +', '?': '，可省略 ?' })[c]); i++; continue; }
      if (c === '{') {
        var q2 = readQuant(src, i);
        if (q2.consumed) { out[out.length - 1] && (out[out.length - 1] += '，' + quantPhrase(q2)); i += q2.consumed; continue; }
        out.push('字面量 {'); i++; continue;
      }
      out.push('字面量 ' + lit(c));
      i++;
    }
    if (ERR) out.push('⚠ ' + ERR);
    if (i < src.length && out.length >= 60) out.push('…（超出解读长度上限）');
    return out;
  }

  function readQuant(src, i) {
    if (src[i] !== '{') return { consumed: 0 };
    var j = src.indexOf('}', i);
    if (j < 0) return { consumed: 0 };
    var body = src.slice(i + 1, j);
    if (!/^\d+(,\d*)?$/.test(body)) return { consumed: 0 };
    return { consumed: j - i + 1, body: body };
  }
  function quantPhrase(q) {
    var b = q.body;
    if (b.indexOf(',') < 0) return '重复 ' + b + ' 次';
    var mm = b.split(',');
    if (mm[1] === '') return '至少 ' + mm[0] + ' 次';
    if (mm[0] === '0') return '可省略（0~' + mm[1] + ' 次）';
    return '重复 ' + mm[0] + '~' + mm[1] + ' 次';
  }

  var api = {
    fromExamples: fromExamples,
    linesFromContent: linesFromContent,
    explainPattern: explainPattern,
    escapeLiteral: escapeLiteral
  };
  if (typeof window !== 'undefined') window.RegexGen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.__regexgen__ = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));