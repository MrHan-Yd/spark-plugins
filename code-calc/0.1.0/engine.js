'use strict';
/* ══════════════ 词法 & 语法 ══════════════ */
const KEYWORDS = new Set(['let','const','var','function','return','if','else','for','while','break','continue','true','false','null','undefined','typeof','and','or','not']);
const OPS3 = ['===','!==','**=','<<=','>>=','>>>'];
const OPS2 = ['==','!=','<=','>=','&&','||','??','**','++','--','+=','-=','*=','/=','%=','&=','|=','^=','=>','<<','>>'];
const OPS1 = '+-*/%()[]{}<>=!&|^~;,.?:';
const ASSIGN_OPS = new Set(['=','+=','-=','*=','/=','%=','**=','&&=','||=','??=','&=','|=','^=','<<=','>>=','>>>=']);
const BIN_LOOKUP = { '??':2,'||':3,'&&':4,'|':5,'^':6,'&':7,'==':8,'!=':8,'===':8,'!==':8,'<':9,'<=':9,'>':9,'>=':9,'<<':10,'>>':10,'>>>':10,'+':11,'-':11,'*':12,'/':12,'%':12 };
const EXPO_PREC = 14;
const TIME_LIMIT = 1500, LOOP_MAX = 1000000, CALL_MAX = 1000000, DEPTH_MAX = 100, RANGE_MAX = 1000000;

function calcErr(message, line){ return { __calc: true, message: message, line: line || 0 }; }
function isDigit(c){ return c >= '0' && c <= '9'; }
function isIdentStart(c){ return /[A-Za-z_$\u4e00-\u9fff]/.test(c); }
function isIdentPart(c){ return isIdentStart(c) || isDigit(c); }

function readEscape(src, j, line){
  if (j >= src.length) return { v: '', next: j, nl: 0 };
  const c = src[j];
  const simple = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', '0':'\0', '\\':'\\', "'":"'", '"':'"', '`':'`' };
  if (c === '\n') return { v: '', next: j + 1, nl: 1 };
  if (simple[c] !== undefined) return { v: simple[c], next: j + 1, nl: 0 };
  if (c === 'x' && /^[0-9a-fA-F]{2}/.test(src.slice(j + 1, j + 3)))
    return { v: String.fromCharCode(parseInt(src.slice(j + 1, j + 3), 16)), next: j + 3, nl: 0 };
  if (c === 'u'){
    if (src[j + 1] === '{'){
      const end = src.indexOf('}', j + 2);
      if (end > 0 && /^[0-9a-fA-F]+$/.test(src.slice(j + 2, end)))
        return { v: String.fromCodePoint(parseInt(src.slice(j + 2, end), 16)), next: end + 1, nl: 0 };
    } else if (/^[0-9a-fA-F]{4}/.test(src.slice(j + 1, j + 5)))
      return { v: String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16)), next: j + 5, nl: 0 };
  }
  return { v: c, next: j + 1, nl: 0 };
}

/* 扫描模板字符串：src[i] === '`'，返回 { end(闭合反引号后), parts, nl } */
function scanTemplate(src, i, errLine){
  const parts = [];
  let j = i + 1, buf = '', bufStart = j, nl = 0;
  const n = src.length;
  while (j < n){
    const ch = src[j];
    if (ch === '`'){
      if (j > bufStart) parts.push({ t:'s', v: buf, s: bufStart, e: j });
      return { end: j + 1, parts: parts, nl: nl };
    }
    if (ch === '\\'){ const r = readEscape(src, j + 1, errLine + nl); buf += r.v; j = r.next; continue; }
    if (ch === '$' && src[j + 1] === '{'){
      if (j > bufStart) parts.push({ t:'s', v: buf, s: bufStart, e: j });
      const inner = scanTplExpr(src, j + 2, errLine + nl);
      parts.push({ t:'e', src: src.slice(j + 2, inner.end), s: j + 2, e: inner.end, line: errLine + nl });
      nl += inner.nl;
      j = inner.end + 1; bufStart = j; buf = '';
      continue;
    }
    if (ch === '\n') nl++;
    buf += ch; j++;
  }
  throw calcErr('模板字符串未闭合', errLine + nl);
}

/* 扫描 ${...} 内的表达式，返回匹配的 '}' 下标 */
function scanTplExpr(src, from, errLine){
  let depth = 1, k = from, nl = 0;
  const n = src.length;
  while (k < n){
    const ch = src[k];
    if (ch === '/' && src[k + 1] === '/'){ while (k < n && src[k] !== '\n') k++; continue; }
    if (ch === '/' && src[k + 1] === '*'){
      k += 2;
      while (k < n && !(src[k] === '*' && src[k + 1] === '/')){ if (src[k] === '\n') nl++; k++; }
      k += 2; continue;
    }
    if (ch === '\n'){ nl++; k++; continue; }
    if (ch === '"' || ch === "'"){
      k++;
      while (k < n && src[k] !== ch){
        if (src[k] === '\\') k++;
        if (src[k] === '\n') throw calcErr('字符串未闭合', errLine + nl);
        k++;
      }
      k++; continue;
    }
    if (ch === '`'){ const r = scanTemplate(src, k, errLine + nl); nl += r.nl; k = r.end; continue; }
    if (ch === '{'){ depth++; k++; continue; }
    if (ch === '}'){ depth--; if (depth === 0) return { end: k, nl: nl }; k++; continue; }
    k++;
  }
  throw calcErr('模板字符串未闭合', errLine + nl);
}

function wordLike(tok){
  return tok && (tok.type === 'ident' || tok.type === 'num' ||
    (tok.type === 'op' && (tok.value === ')' || tok.value === ']')));
}
function prevMeaningful(toks){
  for (let k = toks.length - 1; k >= 0; k--)
    if (toks[k].type !== 'nl' && toks[k].type !== 'comment') return toks[k];
  return null;
}

function tokenize(src, lineOffset){
  if (lineOffset === undefined) lineOffset = 0;
  const toks = [];
  let i = 0, line = 1 + lineOffset;
  const n = src.length;
  const push = (type, value, s, e) => toks.push({ type: type, value: value, line: line, s: s, e: e });
  while (i < n){
    const c = src[i];
    if (c === '\n'){ push('nl', '\n', i, i + 1); i++; line++; continue; }
    if (c === ' ' || c === '\t' || c === '\r'){ i++; continue; }
    if (c === '/' && src[i + 1] === '/'){
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      push('comment', src.slice(i, j), i, j); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*'){
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')){ if (src[j] === '\n') line++; j++; }
      if (j >= n) throw calcErr('注释未闭合', line);
      push('comment', src.slice(i, j + 2), i, j + 2); i = j + 2; continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]) && !wordLike(prevMeaningful(toks)))){
      let j = i;
      if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')){
        const baseChar = src[i + 1].toLowerCase();
        const base = baseChar === 'x' ? 16 : baseChar === 'b' ? 2 : 8;
        const cls = base === 16 ? /[0-9a-fA-F_]/ : base === 2 ? /[01_]/ : /[0-7_]/;
        j = i + 2; let digits = '';
        while (j < n && cls.test(src[j])){ digits += src[j]; j++; }
        const clean = digits.replace(/_/g, '');
        if (!clean.length) throw calcErr('数字格式错误', line);
        const v = parseInt(clean, base);
        push('num', v, i, j); i = j; continue;
      }
      while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
      if (src[j] === '.' && (isDigit(src[j + 1]) || src[j + 1] === '_')){
        j++;
        while (j < n && (isDigit(src[j]) || src[j] === '_')) j++;
      }
      if (src[j] === 'e' || src[j] === 'E'){
        const k = j + 1;
        if (isDigit(src[k]) || ((src[k] === '+' || src[k] === '-') && isDigit(src[k + 1]))){
          j = k;
          if (src[j] === '+' || src[j] === '-') j++;
          while (j < n && isDigit(src[j])) j++;
        }
      }
      const v = Number(src.slice(i, j).replace(/_/g, ''));
      if (Number.isNaN(v)) throw calcErr('数字格式错误', line);
      push('num', v, i, j); i = j; continue;
    }
    if (c === '"' || c === "'"){
      let j = i + 1, out = '', closed = false;
      while (j < n){
        const ch = src[j];
        if (ch === '\\'){ const r = readEscape(src, j + 1, line); out += r.v; line += r.nl; j = r.next; continue; }
        if (ch === '\n') break;
        if (ch === c){ j++; closed = true; break; }
        out += ch; j++;
      }
      if (!closed) throw calcErr('字符串未闭合', line);
      push('str', out, i, j); i = j; continue;
    }
    if (c === '`'){
      const r = scanTemplate(src, i, line);
      push('tpl', r.parts, i, r.end);
      line += r.nl; i = r.end; continue;
    }
    if (isIdentStart(c)){
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const w = src.slice(i, j);
      push(KEYWORDS.has(w) ? 'kw' : 'ident', w, i, j); i = j; continue;
    }
    const three = src.substr(i, 3);
    if (OPS3.indexOf(three) !== -1){ push('op', three, i, i + 3); i += 3; continue; }
    const two = src.substr(i, 2);
    if (OPS2.indexOf(two) !== -1){ push('op', two, i, i + 2); i += 2; continue; }
    if (OPS1.indexOf(c) !== -1){ push('op', c, i, i + 1); i++; continue; }
    throw calcErr(`无法识别的符号 "${c}"`, line);
  }
  push('eof', '', n, n);
  return toks;
}

/* ══════════════ 语法分析 ══════════════ */
function makeParser(t){
  let p = 0;
  let loopDepth = 0, fnDepth = 0;

  const cur = () => t[p];
  const nx = () => t[p + 1];
  const isOp = v => cur().type === 'op' && cur().value === v;
  const isKw = v => cur().type === 'kw' && cur().value === v;
  const skipNl = () => { while (cur().type === 'nl') p++; };
  const lastLine = () => t[p - 1].line;
  const err = (msg, tok) => { throw calcErr(msg, (tok || cur()).line); };
  const disp = tok => {
    if (tok.type === 'str') return '字符串';
    if (tok.type === 'num') return '数字';
    if (tok.type === 'tpl') return '模板字符串';
    if (tok.type === 'nl') return '换行';
    if (tok.type === 'eof') return '结尾';
    return String(tok.value);
  };

  function endStatement(){
    if (cur().type === 'nl'){ skipNl(); return; }
    if (isOp(';')){ p++; skipNl(); return; }
    if (cur().type === 'eof' || isOp('}')) return;
    err(`意外的符号 "${disp(cur())}"`);
  }

  function program(){
    const body = [];
    skipNl();
    while (cur().type !== 'eof'){
      body.push(statement());
      endStatement();
    }
    return { type: 'program', body: body };
  }

  function statement(){
    if (isKw('let') || isKw('const') || isKw('var')) return decl();
    if (isKw('function')) return funcDecl();
    if (isKw('if')) return ifStmt();
    if (isKw('while')) return whileStmt();
    if (isKw('for')) return forStmt();
    if (isKw('break')){ if (loopDepth <= 0) err('break 只能在循环内使用'); p++; return { type:'break', line: lastLine() }; }
    if (isKw('continue')){ if (loopDepth <= 0) err('continue 只能在循环内使用'); p++; return { type:'continue', line: lastLine() }; }
    if (isKw('return')){
      if (fnDepth <= 0) err('return 只能在函数内使用');
      p++;
      if (cur().type === 'nl' || isOp(';') || isOp('}') || cur().type === 'eof')
        return { type:'return', value: null, line: lastLine() };
      const value = expression();
      return { type:'return', value: value, line: lastLine() };
    }
    if (isOp('{')) return block();
    if (isOp(';')){ p++; return { type:'empty', line: lastLine() }; }
    const expr = expression();
    return { type:'exprstmt', expr: expr, line: lastLine() };
  }

  function decl(){
    const kind = cur().value; p++;
    const list = [];
    for (;;){
      if (cur().type !== 'ident') err('应有变量名');
      const name = cur().value; const nameLine = cur().line; p++;
      let init = null, line = nameLine;
      if (isOp('=')){ p++; init = expression(); line = lastLine(); }
      list.push({ name: name, init: init, line: line });
      if (isOp(',')){ p++; skipNl(); continue; }
      break;
    }
    if (kind === 'const' && list.some(d => !d.init)) err('const 声明需要初始化值');
    return { type:'decl', kind: kind, decls: list, line: list[0].line };
  }

  function funcDecl(){
    p++;
    if (cur().type !== 'ident') err('应有函数名');
    const name = cur().value; p++;
    skipNl();
    if (!isOp('(')) err(`函数 "${name}" 后应有 "("`);
    p++;
    const params = [];
    skipNl();
    if (!isOp(')')){
      for (;;){
        if (cur().type !== 'ident') err('参数应为变量名');
        params.push(cur().value); p++;
        skipNl();
        if (isOp(',')){ p++; skipNl(); if (isOp(')')) break; continue; }
        break;
      }
    }
    if (!isOp(')')) err('应有 ")"');
    p++;
    skipNl();
    fnDepth++;
    const body = block();
    fnDepth--;
    return { type:'funcdecl', name: name, params: params, body: body, line: lastLine() };
  }

  function block(){
    if (!isOp('{')) err('应有 "{"');
    p++; skipNl();
    const body = [];
    while (!isOp('}')){
      if (cur().type === 'eof') err('应有 "}"（大括号未闭合）');
      body.push(statement());
      endStatement();
    }
    p++;
    return { type:'block', body: body, line: lastLine() };
  }

  function ifStmt(){
    p++;
    if (!isOp('(')) err('应有 "("');
    p++; skipNl();
    const cond = expression(); skipNl();
    if (!isOp(')')) err('应有 ")"');
    p++;
    const then = statement();
    let els = null;
    let j = p;
    while (t[j] && t[j].type === 'nl') j++;
    if (t[j] && t[j].type === 'kw' && t[j].value === 'else'){ p = j + 1; els = statement(); }
    return { type:'if', cond: cond, then: then, els: els, line: lastLine() };
  }

  function whileStmt(){
    p++;
    if (!isOp('(')) err('应有 "("');
    p++; skipNl();
    const cond = expression(); skipNl();
    if (!isOp(')')) err('应有 ")"');
    p++;
    loopDepth++;
    const body = statement();
    loopDepth--;
    return { type:'while', cond: cond, body: body, line: lastLine() };
  }

  function forUpdate(){
    const e = expression();
    if (cur().type === 'op' && ASSIGN_OPS.has(cur().value)){
      if (!isTarget(e)) err('赋值号左侧无效');
      const op = cur().value; p++;
      const v = expression();
      return { type:'exprstmt', expr: { type:'assign', target: e, op: op, value: v, line: lastLine() }, line: lastLine() };
    }
    return { type:'exprstmt', expr: e, line: lastLine() };
  }

  function forStmt(){
    p++;
    if (!isOp('(')) err('应有 "("');
    p++; skipNl();
    let init = null;
    if (!isOp(';')){
      if (isKw('let') || isKw('const') || isKw('var')) init = decl();
      else init = forUpdate();
    }
    if (!isOp(';')) err('应有 ";"');
    p++; skipNl();
    let cond = null;
    if (!isOp(';')) cond = expression();
    if (!isOp(';')) err('应有 ";"');
    p++; skipNl();
    let update = null;
    if (!isOp(')')) update = forUpdate();
    skipNl();
    if (!isOp(')')) err('应有 ")"');
    p++;
    loopDepth++;
    const body = statement();
    loopDepth--;
    return { type:'for', init: init, cond: cond, update: update, body: body, line: lastLine() };
  }

  /* ── 表达式 ── */
  function expression(){ return assignExpr(); }

  function isArrowAhead(){
    if (cur().type === 'ident' && nx() && nx().type === 'op' && nx().value === '=>') return true;
    if (isOp('(')){
      let j = p + 1;
      while (t[j] && t[j].type === 'nl') j++;
      if (t[j] && t[j].type === 'op' && t[j].value === ')'){
        let k = j + 1;
        while (t[k] && t[k].type === 'nl') k++;
        return !!(t[k] && t[k].type === 'op' && t[k].value === '=>');
      }
      const seen = new Set();
      let k = j;
      for (;;){
        if (!t[k] || t[k].type !== 'ident' || seen.has(t[k].value)) return false;
        seen.add(t[k].value);
        k++;
        while (t[k] && t[k].type === 'nl') k++;
        if (t[k] && t[k].type === 'op' && t[k].value === ','){ k++; while (t[k] && t[k].type === 'nl') k++; continue; }
        break;
      }
      if (t[k] && t[k].type === 'op' && t[k].value === ')'){
        k++;
        while (t[k] && t[k].type === 'nl') k++;
        return !!(t[k] && t[k].type === 'op' && t[k].value === '=>');
      }
    }
    return false;
  }

  function assignExpr(){
    if (isArrowAhead()) return arrow();
    const left = ternary();
    if (cur().type === 'op' && ASSIGN_OPS.has(cur().value)){
      if (!isTarget(left)) err('赋值号左侧无效');
      const op = cur().value; p++;
      const value = assignExpr();
      return { type:'assign', target: left, op: op, value: value, line: lastLine() };
    }
    return left;
  }

  function arrow(){
    const params = [];
    if (isOp('(')){
      p++; skipNl();
      if (!isOp(')')){
        for (;;){
          if (cur().type !== 'ident') err('参数应为变量名');
          params.push(cur().value); p++;
          skipNl();
          if (isOp(',')){ p++; skipNl(); continue; }
          break;
        }
      }
      if (!isOp(')')) err('应有 ")"');
      p++;
    } else {
      if (cur().type !== 'ident') err('应有参数');
      params.push(cur().value); p++;
    }
    skipNl();
    if (!isOp('=>')) err('应有 "=>"');
    p++;
    skipNl();
    fnDepth++;
    const isBlock = isOp('{');
    const body = isBlock ? block() : assignExpr();
    fnDepth--;
    return { type:'arrow', params: params, body: body, isBlock: isBlock, line: lastLine() };
  }

  function ternary(){
    const cond = binary(1);
    if (isOp('?')){
      p++; skipNl();
      const a = assignExpr(); skipNl();
      if (!isOp(':')) err('应有 ":"');
      p++; skipNl();
      const b = assignExpr();
      return { type:'cond', cond: cond, a: a, b: b, line: lastLine() };
    }
    return cond;
  }

  function binary(minPrec){
    let left = unary();
    for (;;){
      if (cur().type === 'nl'){
        let j = p;
        while (t[j] && t[j].type === 'nl') j++;
        const nt = t[j];
        if (!(nt && (nt.type === 'op' && (BIN_LOOKUP[nt.value] !== undefined || nt.value === '**')
          || (nt.type === 'kw' && (nt.value === 'and' || nt.value === 'or'))))) break;
        p = j;
      }
      let op = null;
      if (cur().type === 'op') op = cur().value;
      else if (cur().type === 'kw' && (cur().value === 'and' || cur().value === 'or'))
        op = cur().value === 'and' ? '&&' : '||';
      if (!op) break;
      let prec;
      if (op === '**') prec = EXPO_PREC;
      else { prec = BIN_LOOKUP[op]; if (prec === undefined) break; }
      if (prec < minPrec) break;
      p++; skipNl();
      const rhs = binary(op === '**' ? prec : prec + 1);
      left = { type:'bin', op: op, left: left, right: rhs, line: lastLine() };
    }
    return left;
  }

  function unary(){
    if (isKw('typeof')){ p++; return { type:'unary', op:'typeof', operand: unary(), line: lastLine() }; }
    if (isKw('not')){ p++; return { type:'unary', op:'!', operand: unary(), line: lastLine() }; }
    if (cur().type === 'op' && (cur().value === '!' || cur().value === '~' || cur().value === '-' || cur().value === '+')){
      const op = cur().value; p++;
      return { type:'unary', op: op, operand: unary(), line: lastLine() };
    }
    if (cur().type === 'op' && (cur().value === '++' || cur().value === '--')){
      const op = cur().value; p++;
      const target = unary();
      if (!isTarget(target)) err(`"${op}" 需要变量`);
      return { type:'update', op: op, target: target, prefix: true, line: lastLine() };
    }
    return postfix();
  }

  function postfix(){
    let e = callMember();
    while (cur().type === 'op' && (cur().value === '++' || cur().value === '--') && cur().line === t[p - 1].line){
      if (!isTarget(e)) err(`"${cur().value}" 需要变量`);
      const op = cur().value; p++;
      e = { type:'update', op: op, target: e, prefix: false, line: lastLine() };
    }
    return e;
  }

  function callMember(){
    let e = primary();
    for (;;){
      // 链式调用可跨行：点号写在行首延续上一行表达式
      if (cur().type === 'nl'){
        let j = p;
        while (t[j] && t[j].type === 'nl') j++;
        if (t[j] && t[j].type === 'op' && t[j].value === '.') p = j;
        else break;
      }
      if (isOp('.')){
        p++;
        if (!(cur().type === 'ident' || cur().type === 'kw')) err('"." 后应有属性名');
        const name = cur().value; p++;
        e = { type:'member', obj: e, name: name, line: lastLine() };
      } else if (isOp('[')){
        p++; skipNl();
        const idx = expression(); skipNl();
        if (!isOp(']')) err('应有 "]"');
        p++;
        e = { type:'index', obj: e, index: idx, line: lastLine() };
      } else if (isOp('(')){
        p++; skipNl();
        const args = [];
        if (!isOp(')')){
          for (;;){
            args.push(assignExpr()); skipNl();
            if (isOp(',')){ p++; skipNl(); if (isOp(')')) break; continue; }
            break;
          }
        }
        if (!isOp(')')) err('应有 ")"');
        p++;
        e = { type:'call', callee: e, args: args, line: lastLine() };
      } else break;
    }
    return e;
  }

  function primary(){
    const tk = cur();
    if (tk.type === 'num' || tk.type === 'str'){ p++; return { type:'lit', value: tk.value, line: tk.line }; }
    if (tk.type === 'tpl'){ p++; return tplNode(tk); }
    if (tk.type === 'kw'){
      if (tk.value === 'true'){ p++; return { type:'lit', value: true, line: tk.line }; }
      if (tk.value === 'false'){ p++; return { type:'lit', value: false, line: tk.line }; }
      if (tk.value === 'null'){ p++; return { type:'lit', value: null, line: tk.line }; }
      if (tk.value === 'undefined'){ p++; return { type:'lit', value: undefined, line: tk.line }; }
      err(`意外的关键字 "${tk.value}"`);
    }
    if (tk.type === 'ident'){ p++; return { type:'ident', name: tk.value, line: tk.line }; }
    if (tk.type === 'op' && tk.value === '('){
      p++; skipNl();
      const e = expression(); skipNl();
      if (!isOp(')')) err('应有 ")"');
      p++;
      return e;
    }
    if (tk.type === 'op' && tk.value === '['){
      p++; skipNl();
      const elems = [];
      if (!isOp(']')){
        for (;;){
          elems.push(assignExpr()); skipNl();
          if (isOp(',')){ p++; skipNl(); if (isOp(']')) break; continue; }
          break;
        }
      }
      if (!isOp(']')) err('应有 "]"');
      p++;
      return { type:'array', elems: elems, line: lastLine() };
    }
    if (tk.type === 'op' && tk.value === '{'){
      p++; skipNl();
      const props = [];
      if (!isOp('}')){
        for (;;){
          let key;
          if (cur().type === 'ident' || cur().type === 'kw') key = cur().value;
          else if (cur().type === 'str') key = String(cur().value);
          else if (cur().type === 'num') key = fmtNum(cur().value);
          else err('对象的键名无效');
          p++; skipNl();
          if (!isOp(':')) err('应有 ":"');
          p++; skipNl();
          const val = assignExpr();
          props.push({ key: key, val: val, line: lastLine() });
          skipNl();
          if (isOp(',')){ p++; skipNl(); if (isOp('}')) break; continue; }
          break;
        }
      }
      if (!isOp('}')) err('应有 "}"');
      p++;
      return { type:'object', props: props, line: lastLine() };
    }
    if (tk.type === 'eof') err('缺少表达式');
    err(`意外的符号 "${disp(tk)}"`);
  }

  function tplNode(tk){
    const parts = tk.value.map(pt =>
      pt.t === 's' ? { t:'s', v: pt.v } : { t:'e', expr: exprFromSrc(pt.src, pt.line) });
    return { type:'tpl', parts: parts, line: tk.line };
  }

  return { program: program, expression: expression };
}

function exprFromSrc(src, baseLine){
  const sub = tokenize(src, baseLine - 1).filter(x => x.type !== 'comment');
  return makeParser(sub).expression();
}
function parse(src){
  const toks = tokenize(src).filter(x => x.type !== 'comment');
  return makeParser(toks).program();
}
function isTarget(node){
  return node.type === 'ident' || node.type === 'member' || node.type === 'index';
}

/* ══════════════ 值显示 ══════════════ */
function fmtNum(v){
  if (Number.isNaN(v)) return 'NaN';
  if (!isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const p = Number(v.toPrecision(12));
  if (Number.isInteger(p) && Math.abs(p) < 1e15) return String(p);
  return String(p);
}
function identLike(k){ return typeof k === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k); }
function dispItem(x){ return typeof x === 'string' ? JSON.stringify(x) : toDisp(x); }
function toDisp(v){
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'string') return (v === '' || /[\n\r]/.test(v) || /^\s|\s$/.test(v)) ? JSON.stringify(v) : v;
  if (Array.isArray(v))
    return '[' + v.slice(0, 100).map(dispItem).join(', ') + (v.length > 100 ? '，… 共 ' + v.length + ' 项' : '') + ']';
  if (v instanceof Map){
    if (v === MATH_MAP) return 'Math';
    const es = Array.from(v.entries()).slice(0, 50);
    return '{' + es.map(e => (identLike(e[0]) ? e[0] : JSON.stringify(e[0])) + ': ' + dispItem(e[1])).join(', ')
      + (v.size > 50 ? '，…' : '') + '}';
  }
  if (v && v.__closure) return 'ƒ ' + (v.name ? v.name : '') + '(' + v.params.join(', ') + ')';
  if (v && v.__native) return 'ƒ ' + (v.__name || '内置') + '(…)';
  return String(v);
}
function rawDisp(v){ return typeof v === 'string' ? v : toDisp(v); }
function typeName(v){
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return '数组';
  if (v instanceof Map) return v === MATH_MAP ? 'Math' : '对象';
  if (v && (v.__closure || v.__native)) return '函数';
  const t = typeof v;
  return t === 'number' ? '数字' : t === 'string' ? '字符串' : t === 'boolean' ? '布尔值' : t;
}
function typeOf(v){
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Map) return v === MATH_MAP ? 'Math' : 'object';
  if (v && (v.__closure || v.__native)) return 'function';
  return typeof v;
}
function truthy(v){
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return true;
}
function looseEq(a, b){
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  const ta = typeof a, tb = typeof b;
  if (ta === 'object' || tb === 'object'){
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return toDisp(a) === toDisp(b);
  }
  const na = ta === 'boolean' ? +a : a;
  const nb = tb === 'boolean' ? +b : b;
  const t2a = typeof na, t2b = typeof nb;
  if (t2a === 'number' && t2b === 'number') return na === nb;
  if (t2a === 'string' && t2b === 'string') return na === nb;
  if (t2a === 'number' && t2b === 'string'){
    const nb2 = Number(nb);
    return !Number.isNaN(nb2) && na === nb2;
  }
  if (t2a === 'string' && t2b === 'number'){
    const na2 = Number(na);
    return !Number.isNaN(na2) && na2 === nb;
  }
  return false;
}

/* ══════════════ 运行环境 ══════════════ */
function Scope(parent){ this.vars = new Map(); this.consts = new Set(); this.parent = parent || null; }
function scopeLookup(env, name){
  let s = env;
  while (s){
    if (s.vars.has(name)) return { scope: s, value: s.vars.get(name) };
    s = s.parent;
  }
  return null;
}

const BUILTIN_SCOPE = new Scope(null);
const MATH_MAP = new Map();
const ARRAY_METHODS = {};
const STRING_METHODS = {};
const NUMBER_METHODS = {};

function defMath(name, fn){
  const rec = { __native: fn, __name: name };
  MATH_MAP.set(name, rec);
  BUILTIN_SCOPE.vars.set(name, rec);
}
function defFree(name, fn){
  BUILTIN_SCOPE.vars.set(name, { __native: fn, __name: name });
}
function collectNums(args, name){
  const xs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  for (const x of xs)
    if (typeof x !== 'number' || Number.isNaN(x))
      throw calcErr(`${name}: 参数必须是数字或数字数组`);
  return xs;
}

BUILTIN_SCOPE.vars.set('Math', MATH_MAP);
BUILTIN_SCOPE.vars.set('undefined', undefined);
BUILTIN_SCOPE.vars.set('PI', Math.PI);
BUILTIN_SCOPE.vars.set('E', Math.E);
MATH_MAP.set('PI', Math.PI);
MATH_MAP.set('E', Math.E);

for (const nm of ['abs','ceil','floor','trunc','sign','sqrt','cbrt','exp','log2','log10','sin','cos','tan','asin','acos','atan','sinh','cosh','tanh'])
  defMath(nm, function(args){ return Math[nm](args[0]); });
defMath('pow', function(a){ return Math.pow(a[0], a[1]); });
defMath('atan2', function(a){ return Math.atan2(a[0], a[1]); });
defMath('hypot', function(a){ return Math.hypot.apply(null, a); });
defMath('min', function(a){ const xs = collectNums(a, 'min'); let m = Infinity; for (const x of xs) if (x < m) m = x; return m; });
defMath('max', function(a){ const xs = collectNums(a, 'max'); let m = -Infinity; for (const x of xs) if (x > m) m = x; return m; });
defMath('log', function(a){ return (a.length > 1 && a[1] !== undefined) ? Math.log(a[0]) / Math.log(a[1]) : Math.log(a[0]); });
defMath('round', function(a){
  const d = (a.length > 1 && a[1] !== undefined) ? Math.trunc(+a[1] || 0) : 0;
  if (d <= 0) return Math.round(a[0]);
  const pw = Math.pow(10, d);
  return Math.round(a[0] * pw) / pw;
});
defMath('random', function(a){
  if (a.length && a[0] !== undefined)
    return a[1] !== undefined ? a[0] + Math.random() * (a[1] - a[0]) : Math.random() * a[0];
  return Math.random();
});
defFree('randInt', function(a){
  const lo = Math.trunc(+a[0] || 0), hi = Math.trunc(+a[1] || 0);
  if (hi < lo) throw calcErr('randInt: 上限不能小于下限');
  return lo + Math.floor(Math.random() * (hi - lo + 1));
});
defFree('sum', function(a){
  const xs = a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
  let s = 0;
  for (const x of xs){
    if (typeof x !== 'number') throw calcErr('sum: 数组元素必须是数字');
    s += x;
  }
  return s;
});
defFree('avg', function(a){
  const xs = a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
  if (!xs.length) throw calcErr('avg: 空数组没有平均值');
  let s = 0;
  for (const x of xs){
    if (typeof x !== 'number') throw calcErr('avg: 数组元素必须是数字');
    s += x;
  }
  return s / xs.length;
});
defFree('len', function(a){
  const v = a[0];
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return v.length;
  if (v instanceof Map) return v.size;
  throw calcErr('len: 参数应是数组、字符串或对象');
});
defFree('str', function(a){ return toDisp(a[0]); });
defFree('num', function(a){ return typeof a[0] === 'number' ? a[0] : Number(toDisp(a[0])); });
defFree('int', function(a){ return Math.trunc(typeof a[0] === 'number' ? a[0] : Number(toDisp(a[0]))); });
defFree('range', function(a){
  let start = 0, end, step = 1;
  if (!a.length || a[0] === undefined) throw calcErr('range 需要参数');
  if (a[1] === undefined){ end = a[0]; }
  else { start = a[0]; end = a[1]; step = a[2] === undefined ? 1 : a[2]; }
  start = +start; end = +end; step = +step;
  if (step === 0 || Number.isNaN(step)) throw calcErr('range 的步长不能为 0');
  const count = Math.ceil((end - start) / step);
  if (!(count > 0)) return [];
  if (count > RANGE_MAX) throw calcErr('range 最多生成 ' + RANGE_MAX + ' 个元素');
  const out = [];
  if (step > 0) for (let v = start; v < end; v += step) out.push(v);
  else for (let v = start; v > end; v += step) out.push(v);
  return out;
});
defFree('keys', function(a){
  const v = a[0];
  if (v instanceof Map) return Array.from(v.keys());
  throw calcErr('keys 的参数应是对象');
});
defFree('values', function(a){
  const v = a[0];
  if (v instanceof Map) return Array.from(v.values());
  throw calcErr('values 的参数应是对象');
});

function requireFn(fn, who){
  if (!fn || !(fn.__closure || fn.__native))
    throw calcErr(`${who} 的参数应是函数`);
}
ARRAY_METHODS.join = function(args){
  const sep = args[0] === undefined ? ',' : (typeof args[0] === 'string' ? args[0] : toDisp(args[0]));
  return Array.prototype.map.call(this, x => typeof x === 'string' ? x : toDisp(x)).join(sep);
};
ARRAY_METHODS.map = function(args, ctx){
  requireFn(args[0], 'map');
  const out = [];
  for (let i = 0; i < this.length; i++) out.push(callFunction(args[0], [this[i], i], ctx, 0));
  return out;
};
ARRAY_METHODS.filter = function(args, ctx){
  requireFn(args[0], 'filter');
  const out = [];
  for (let i = 0; i < this.length; i++)
    if (truthy(callFunction(args[0], [this[i], i], ctx, 0))) out.push(this[i]);
  return out;
};
ARRAY_METHODS.reduce = function(args, ctx){
  requireFn(args[0], 'reduce');
  let acc = args[1], start = 0;
  if (args[1] === undefined){
    if (!this.length) throw calcErr('reduce: 空数组需要初始值');
    acc = this[0]; start = 1;
  }
  for (let i = start; i < this.length; i++) acc = callFunction(args[0], [acc, this[i], i], ctx, 0);
  return acc;
};
ARRAY_METHODS.includes = function(args){ const x = args[0]; for (const e of this) if (looseEq(e, x)) return true; return false; };
ARRAY_METHODS.indexOf = function(args){ const x = args[0]; for (let i = 0; i < this.length; i++) if (this[i] === x) return i; return -1; };
ARRAY_METHODS.slice = function(args){
  const a = args[0] === undefined ? undefined : Math.trunc(+args[0] || 0);
  const b = args[1] === undefined ? undefined : Math.trunc(+args[1] || 0);
  return Array.prototype.slice.call(this, a, b);
};
STRING_METHODS.toUpperCase = function(){ return String(this).toUpperCase(); };
STRING_METHODS.toLowerCase = function(){ return String(this).toLowerCase(); };
STRING_METHODS.trim = function(){ return String(this).trim(); };
STRING_METHODS.includes = function(args){ return String(this).includes(typeof args[0] === 'string' ? args[0] : toDisp(args[0])); };
STRING_METHODS.indexOf = function(args){ return String(this).indexOf(typeof args[0] === 'string' ? args[0] : toDisp(args[0])); };
STRING_METHODS.startsWith = function(args){ return String(this).startsWith(typeof args[0] === 'string' ? args[0] : toDisp(args[0])); };
STRING_METHODS.endsWith = function(args){ return String(this).endsWith(typeof args[0] === 'string' ? args[0] : toDisp(args[0])); };
STRING_METHODS.charAt = function(args){ return String(this).charAt(Math.trunc(+args[0] || 0)); };
STRING_METHODS.slice = function(args){
  const a = args[0] === undefined ? undefined : Math.trunc(+args[0] || 0);
  const b = args[1] === undefined ? undefined : Math.trunc(+args[1] || 0);
  return String(this).slice(a, b);
};
STRING_METHODS.split = function(args){
  if (args[0] === undefined) return [String(this)];
  const sep = typeof args[0] === 'string' ? args[0] : toDisp(args[0]);
  if (sep === '') return Array.from(String(this));
  return String(this).split(sep);
};
STRING_METHODS.repeat = function(args){
  const cnt = Math.trunc(+args[0] || 0);
  if (cnt < 0 || !isFinite(cnt)) throw calcErr('repeat: 次数不能为负');
  if (String(this).length * cnt > 1000000) throw calcErr('repeat: 结果过长（上限 100 万字符）');
  return String(this).repeat(cnt);
};
STRING_METHODS.replace = function(args){
  const from = typeof args[0] === 'string' ? args[0] : toDisp(args[0]);
  const to = typeof args[1] === 'string' ? args[1] : toDisp(args[1]);
  return String(this).split(from).join(to);
};
NUMBER_METHODS.toFixed = function(args){
  const d = args[0] === undefined ? 0 : Math.max(0, Math.min(100, Math.trunc(+args[0] || 0)));
  return Number(this).toFixed(d);
};
NUMBER_METHODS.toString = function(args){
  const n = Number(this);
  if (args[0] === undefined) return String(n);
  return n.toString(Math.max(2, Math.min(36, Math.trunc(+args[0] || 10))));
};

/* ══════════════ 求值 ══════════════ */
function bump(ctx, line){
  ctx.steps++;
  if ((ctx.steps & 4095) === 0 && Date.now() - ctx.t0 > TIME_LIMIT)
    throw calcErr('执行超时（超过 1.5 秒），请检查是否有死循环', line);
}
function loopsGuard(ctx, line){
  ctx.loops++;
  if (ctx.loops > LOOP_MAX)
    throw calcErr('循环执行超过 ' + LOOP_MAX + ' 次，可能存在死循环', line);
  if ((ctx.loops & 8191) === 0 && Date.now() - ctx.t0 > TIME_LIMIT)
    throw calcErr('执行超时（超过 1.5 秒），请检查是否有死循环', line);
}
function computeBin(op, a, b, line){
  switch (op){
    case '+':
      if (typeof a === 'string' || typeof b === 'string') return toDisp(a) + toDisp(b);
      if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) return toDisp(a) + toDisp(b);
      return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '**': return a ** b;
    case '==': return looseEq(a, b);
    case '!=': return !looseEq(a, b);
    case '===': return a === b;
    case '!==': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '>>>': return a >>> b;
  }
  throw calcErr('未知运算符 ' + op, line);
}
function getMember(obj, name, line){
  if (obj === null || obj === undefined)
    throw calcErr(`无法读取 ${typeName(obj)} 的属性 "${name}"`, line);
  if (obj instanceof Map){
    if (obj.has(name)) return obj.get(name);
    throw calcErr(`${typeName(obj)} 没有属性 "${name}"`, line);
  }
  if (Array.isArray(obj)){
    if (name === 'length') return obj.length;
    const m = ARRAY_METHODS[name];
    if (m) return { __native: m, __self: obj, __name: name };
    throw calcErr(`数组没有方法 "${name}"`, line);
  }
  if (typeof obj === 'string'){
    if (name === 'length') return obj.length;
    const m = STRING_METHODS[name];
    if (m) return { __native: m, __self: obj, __name: name };
    throw calcErr(`字符串没有方法 "${name}"`, line);
  }
  if (typeof obj === 'number'){
    const m = NUMBER_METHODS[name];
    if (m) return { __native: m, __self: obj, __name: name };
    throw calcErr(`数字没有方法 "${name}"`, line);
  }
  throw calcErr(`${typeName(obj)} 没有属性 "${name}"`, line);
}
function getIndex(obj, idx, line){
  if (obj === null || obj === undefined)
    throw calcErr(`无法读取 ${typeName(obj)} 的下标`, line);
  if (Array.isArray(obj)){
    let i = typeof idx === 'number' ? Math.trunc(idx) : NaN;
    if (Number.isNaN(i)) throw calcErr('数组下标必须是数字', line);
    if (i < 0) i += obj.length;
    return i >= 0 && i < obj.length ? obj[i] : undefined;
  }
  if (typeof obj === 'string'){
    let i = typeof idx === 'number' ? Math.trunc(idx) : NaN;
    if (Number.isNaN(i)) throw calcErr('字符串下标必须是数字', line);
    if (i < 0) i += obj.length;
    return i >= 0 && i < obj.length ? obj[i] : undefined;
  }
  if (obj instanceof Map) return obj.has(idx) ? obj.get(idx) : undefined;
  throw calcErr(`${typeName(obj)} 不支持下标访问`, line);
}
function resolveSlot(target, env, ctx, line){
  if (target.type === 'ident'){
    const found = scopeLookup(env, target.name);
    // 命中内置层时视为未声明：走用户全局的影子声明，避免污染内置作用域
    if (found && found.scope === BUILTIN_SCOPE) return { missing: true, name: target.name };
    if (!found) return { missing: true, name: target.name };
    if (found.scope.consts.has(target.name))
      throw calcErr(`不能给常量 "${target.name}" 重新赋值`, line);
    return { get: () => found.scope.vars.get(target.name), set: v => found.scope.vars.set(target.name, v) };
  }
  if (target.type === 'member'){
    const obj = evalExpr(target.obj, env, ctx);
    if (!(obj instanceof Map)) throw calcErr(`${typeName(obj)} 不支持属性赋值`, line);
    return {
      get: () => (obj.has(target.name) ? obj.get(target.name) : undefined),
      set: v => obj.set(target.name, v)
    };
  }
  if (target.type === 'index'){
    const obj = evalExpr(target.obj, env, ctx);
    const idx = evalExpr(target.index, env, ctx);
    if (Array.isArray(obj)){
      let i = typeof idx === 'number' ? Math.trunc(idx) : NaN;
      if (Number.isNaN(i)) throw calcErr('数组下标必须是数字', line);
      if (i < 0) i += obj.length;
      return { get: () => obj[i], set: v => { obj[i] = v; } };
    }
    if (obj instanceof Map) return { get: () => (obj.has(idx) ? obj.get(idx) : undefined), set: v => obj.set(idx, v) };
    throw calcErr(`${typeName(obj)} 不支持下标赋值`, line);
  }
  throw calcErr('赋值号左侧无效', line);
}
function callFunction(v, args, ctx, line){
  if (v && v.__closure){
    ctx.calls++;
    if (ctx.calls > CALL_MAX) throw calcErr('函数调用次数超过上限', line);
    if (++ctx.depth > DEPTH_MAX){ ctx.depth--; throw calcErr('函数嵌套层数过多（递归没有终止）', line); }
    try {
      const env2 = new Scope(v.env);
      for (let i = 0; i < v.params.length; i++) env2.vars.set(v.params[i], args[i]);
      if (v.isBlock){
        try {
          execBlock(v.body.body, env2, true, ctx);
          return undefined;
        } catch (sig){
          if (sig && sig.__return) return sig.value;
          throw sig;
        }
      }
      return evalExpr(v.body, env2, ctx);
    } finally { ctx.depth--; }
  }
  if (v && v.__native) return v.__native.call(v.__self || null, args, ctx);
  throw calcErr(`"${toDisp(v)}" 不是函数`, line);
}
function labelFor(t){
  if (t.type === 'ident') return t.name;
  if (t.type === 'member'){ const base = labelFor(t.obj); return base ? base + '.' + t.name : null; }
  return null;
}
function labelOfNode(n){
  if (n.type === 'assign' || n.type === 'update') return labelFor(n.target);
  return null;
}

function evalExpr(node, env, ctx){
  bump(ctx, node.line);
  switch (node.type){
    case 'lit': return node.value;
    case 'ident': {
      const f = scopeLookup(env, node.name);
      if (!f) throw calcErr(`未定义的变量 "${node.name}"`, node.line);
      return f.scope.vars.get(node.name);
    }
    case 'array': return node.elems.map(e => evalExpr(e, env, ctx));
    case 'object': {
      const m = new Map();
      for (const pr of node.props) m.set(pr.key, evalExpr(pr.val, env, ctx));
      return m;
    }
    case 'tpl':
      return node.parts.map(pt => pt.t === 's' ? pt.v : toDisp(evalExpr(pt.expr, env, ctx))).join('');
    case 'bin': {
      const op = node.op;
      if (op === '&&'){ const l = evalExpr(node.left, env, ctx); return truthy(l) ? evalExpr(node.right, env, ctx) : l; }
      if (op === '||'){ const l = evalExpr(node.left, env, ctx); return truthy(l) ? l : evalExpr(node.right, env, ctx); }
      if (op === '??'){ const l = evalExpr(node.left, env, ctx); return (l !== null && l !== undefined) ? l : evalExpr(node.right, env, ctx); }
      const a = evalExpr(node.left, env, ctx);
      const b = evalExpr(node.right, env, ctx);
      return computeBin(op, a, b, node.line);
    }
    case 'unary': {
      const v = evalExpr(node.operand, env, ctx);
      switch (node.op){
        case '-': return -v;
        case '+': return +v;
        case '!': return !truthy(v);
        case '~': return ~v;
        case 'typeof': return typeOf(v);
      }
      break;
    }
    case 'cond':
      return truthy(evalExpr(node.cond, env, ctx)) ? evalExpr(node.a, env, ctx) : evalExpr(node.b, env, ctx);
    case 'assign': {
      const slot = resolveSlot(node.target, env, ctx, node.line);
      const rhs = evalExpr(node.value, env, ctx);
      if (slot.missing){
        if (node.op !== '=') throw calcErr(`未定义的变量 "${slot.name}"`, node.line);
        ctx.global.vars.set(slot.name, rhs);
        return rhs;
      }
      const nv = node.op === '=' ? rhs : computeBin(node.op.slice(0, -1), slot.get(), rhs, node.line);
      slot.set(nv);
      return nv;
    }
    case 'update': {
      const slot = resolveSlot(node.target, env, ctx, node.line);
      if (slot.missing) throw calcErr(`未定义的变量 "${slot.name}"`, node.line);
      const oldV = slot.get();
      const nv = computeBin(node.op === '++' ? '+' : '-', oldV, 1, node.line);
      slot.set(nv);
      return node.prefix ? nv : oldV;
    }
    case 'member': return getMember(evalExpr(node.obj, env, ctx), node.name, node.line);
    case 'index': return getIndex(evalExpr(node.obj, env, ctx), evalExpr(node.index, env, ctx), node.line);
    case 'call': {
      const cv = evalExpr(node.callee, env, ctx);
      const args = node.args.map(a => evalExpr(a, env, ctx));
      return callFunction(cv, args, ctx, node.line);
    }
    case 'arrow':
      return { __closure: true, params: node.params, body: node.body, env: env, isBlock: node.isBlock, name: null };
  }
  throw calcErr('内部错误：未知节点 ' + node.type, node.line);
}

function exec(stmt, env, silent, ctx){
  bump(ctx, stmt.line);
  switch (stmt.type){
    case 'decl': {
      for (const d of stmt.decls){
        const val = d.init ? evalExpr(d.init, env, ctx) : undefined;
        env.vars.set(d.name, val);
        if (stmt.kind === 'const') env.consts.add(d.name);
        if (!silent) ctx.results.push({ line: d.line, label: d.name, text: toDisp(val), raw: rawDisp(val) });
      }
      break;
    }
    case 'funcdecl':
      env.vars.set(stmt.name, { __closure: true, params: stmt.params, body: stmt.body, env: env, isBlock: true, name: stmt.name });
      break;
    case 'exprstmt': {
      const v = evalExpr(stmt.expr, env, ctx);
      if (!silent) ctx.results.push({ line: stmt.line, label: labelOfNode(stmt.expr), text: toDisp(v), raw: rawDisp(v) });
      break;
    }
    case 'block': {
      const child = new Scope(env);
      execBlock(stmt.body, child, true, ctx);
      break;
    }
    case 'if':
      if (truthy(evalExpr(stmt.cond, env, ctx))) exec(stmt.then, env, true, ctx);
      else if (stmt.els) exec(stmt.els, env, true, ctx);
      break;
    case 'while':
      for (;;){
        loopsGuard(ctx, stmt.line);
        if (!truthy(evalExpr(stmt.cond, env, ctx))) break;
        try { exec(stmt.body, env, true, ctx); }
        catch (sig){ if (sig && sig.__break) break; if (!(sig && sig.__continue)) throw sig; }
      }
      break;
    case 'for': {
      const env2 = new Scope(env);
      if (stmt.init) exec(stmt.init, env2, true, ctx);
      for (;;){
        loopsGuard(ctx, stmt.line);
        if (stmt.cond && !truthy(evalExpr(stmt.cond, env2, ctx))) break;
        try { exec(stmt.body, env2, true, ctx); }
        catch (sig){ if (sig && sig.__break) break; if (!(sig && sig.__continue)) throw sig; }
        if (stmt.update) exec(stmt.update, env2, true, ctx);
      }
      break;
    }
    case 'return':
      throw { __return: true, value: stmt.value ? evalExpr(stmt.value, env, ctx) : undefined };
    case 'break': throw { __break: true };
    case 'continue': throw { __continue: true };
    case 'empty': break;
    default: throw calcErr('内部错误：未知语句 ' + stmt.type, stmt.line);
  }
}
function execBlock(stmts, env, silent, ctx){
  for (const s of stmts) exec(s, env, silent, ctx);
}

function runScript(src){
  const t0 = Date.now();
  const ctx = { steps: 0, calls: 0, loops: 0, depth: 0, t0: t0, results: [], global: null };
  const userGlobal = new Scope(BUILTIN_SCOPE);
  ctx.global = userGlobal;
  let error = null;
  try {
    const ast = parse(src);
    execBlock(ast.body, userGlobal, false, ctx);
  } catch (e){
    if (e && e.__calc) error = { message: e.message, line: e.line || 0 };
    else error = { message: '内部错误：' + ((e && e.message) || String(e)), line: 0 };
  }
  const vars = [];
  userGlobal.vars.forEach((v, name) => {
    vars.push({
      name: name,
      kind: userGlobal.consts.has(name) ? 'const' : 'let',
      text: toDisp(v),
      raw: (v && v.__closure) ? name : rawDisp(v)
    });
  });
  return { ok: !error, error: error, results: ctx.results, vars: vars, ms: Date.now() - t0 };
}
