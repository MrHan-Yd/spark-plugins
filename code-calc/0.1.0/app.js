/* ══════════════ 界面 ══════════════ */
const $ = id => document.getElementById(id);
const ta = $('code'), hlEl = $('hl'), resEl = $('results'), codebox = $('codebox');
const vlistEl = $('vlist'), vcountEl = $('vcount'), stL = $('stL'), stR = $('stR');
const toastEl = $('toast'), maskEl = $('mask');
const panel = $('panel'), phelpEl = $('phelp'), pkwEl = $('pkw');
const ptabHelp = $('ptabHelp'), ptabKw = $('ptabKw');
const PAD_T = 14, LINE_H = 22;
const LS = { script: 'spark_codecalc_script_v2', legacyScript: 'spark_codecalc_script', theme: 'spark_codecalc_theme' };
function lsGet(k){ try { return localStorage.getItem(k); } catch (e){ return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, v); } catch (e){} }
function lsDel(k){ try { localStorage.removeItem(k); } catch (e){} }

const SAMPLE = [
  '// 代码计算器 —— 像写代码一样算数',
  '// 顶层每行表达式的值会显示在右侧，改一改试试',
  '',
  'let 单价 = 99.9',
  'let 数量 = 3',
  '单价 * 数量',
  '',
  'let 折扣 = 0.85',
  '总价 = 单价 * 数量 * 折扣      // 未声明的变量会自动创建',
  '总价.toFixed(2)',
  '',
  '// 循环、函数、模板字符串都支持',
  'let total = 0',
  'for (let i = 1; i <= 100; i++) {',
  '  total += i',
  '}',
  'total',
  '',
  'let avg = xs => sum(xs) / len(xs)',
  'avg([4, 8, 15, 16, 23, 42])',
  '',
  '`订单金额：${总价.toFixed(2)} 元（${数量} 件）`'
].join('\n');

const HELP_HTML = [
  ['变量', 'let 价格 = 99.9　const PI2 = 3.14　直接写 <code>x = 5</code> 会自动声明；支持中文变量名'],
  ['运算', '<code>+ - * / % **</code>　比较 <code>== != &lt; &gt; &lt;= &gt;=</code>　逻辑 <code>&amp;&amp; || !</code> 或 <code>and or not</code>　位运算 <code>&amp; | ^ ~ &lt;&lt; &gt;&gt;</code>　三元 <code>条件 ? a : b</code>'],
  ['数字', '支持 <code>0xff</code> 十六进制、<code>0b101</code> 二进制、<code>1_000_000</code> 分隔符、<code>1.5e3</code> 科学计数'],
  ['字符串', '"文本" 或 \'文本\'；模板字符串：<code>`总价：${总价.toFixed(2)} 元`</code>'],
  ['函数', '<code>let avg = xs =&gt; sum(xs) / len(xs)</code>，或 <code>function f(x) { return x * 2 }</code>；调用 <code>avg([...])</code>、<code>f(3)</code>'],
  ['循环', '<code>for (let i = 1; i &lt;= 10; i++) { … }</code>　<code>while (条件) { … }</code>　<code>break</code> / <code>continue</code>'],
  ['分支', '<code>if (x &gt; 3) { … } else { … }</code>，表达式里也可以用三元'],
  ['数组', '<code>let a = [3, 1, 2]</code>　取值 <code>a[0]</code>、<code>a[-1]</code> 倒数　方法 <code>a.map(x =&gt; x * 2)</code>、<code>a.filter(…)</code>、<code>a.join(", ")</code>'],
  ['对象', '<code>let o = {宽: 3, 高: 4}</code>　读取 <code>o.宽</code> 或 <code>o["宽"]</code>'],
  ['内置', 'sum avg len min max range rand randInt round(x, d) str num int keys values；数学：<code>sqrt pow log sin cos</code> 等，<code>Math.PI</code>、<code>PI</code>、<code>E</code>'],
  ['提示', '只有<b>顶层的表达式 / 赋值行</b>会显示结果；点击结果或变量可复制；长时间无响应会被自动中断']
].map(r => `<div class="hrow"><span class="hk">${r[0]}</span><span class="hv">${r[1]}</span></div>`).join('');

/* 关键字速查：r[1] === null 为分组标题；语言关键字段落的关键字渲染成可点击插入的 chip */
const KW_ROWS = [
  ['语言关键字', null],
  [['let', 'const', 'var'], '声明变量：<code>let x = 5</code>；<code>const</code> 声明后不能重新赋值；<code>var</code> 等效 let。直接写 <code>x = 5</code> 会自动声明'],
  [['true', 'false'], '布尔值'],
  [['null', 'undefined'], '空值 / 未定义；<code>null == undefined</code> 为 true'],
  [['typeof'], '查看类型：<code>typeof 1</code> → "number"、数组 → "array"、函数 → "function"'],
  [['and', 'or', 'not'], '逻辑与 / 或 / 非，等价 <code>&amp;&amp;</code> <code>||</code> <code>!</code>'],
  [['if', 'else'], '条件执行：<code>if (x &gt; 0) { … } else { … }</code>'],
  [['for'], '计数循环：<code>for (let i = 1; i &lt;= 10; i++) { … }</code>'],
  [['while'], '条件循环：<code>while (x &gt; 0) { … }</code>'],
  [['break', 'continue'], '跳出循环 / 跳过本轮继续下一次'],
  [['function'], '定义函数：<code>function f(x) { return x * 2 }</code>；箭头写法 <code>let f = x =&gt; x * 2</code>'],
  [['return'], '在函数内返回结果并结束执行'],
  ['内置函数', null],
  [['数学'], 'abs ceil floor round(x, d) trunc sign sqrt cbrt pow exp log(x, base) log2 log10 sin cos tan asin acos atan atan2 sinh cosh tanh hypot min max'],
  [['随机'], '<code>random()</code> 0~1　<code>random(a, b)</code> 区间　<code>randInt(a, b)</code> 整数含两端'],
  [['序列'], '<code>sum</code> 求和　<code>avg</code> 平均　<code>len</code> 长度　<code>range(起, 止[, 步长])</code>　<code>keys / values</code>（对象）'],
  [['转换'], '<code>str(x)</code> 转文本　<code>num(x)</code> 转数字　<code>int(x)</code> 截断取整'],
  [['常量'], '<code>PI</code> <code>E</code>（<code>Math.PI</code> / <code>Math.E</code> 等效）']
];
let kwSection = '';
const KW_HTML = KW_ROWS.map(r => {
  if (r[1] === null){ kwSection = r[0]; return `<div class="khead">${r[0]}</div>`; }
  const left = kwSection === '语言关键字'
    ? r[0].map(k => `<button class="kchip" data-kw="${k}">${k}</button>`).join('<span class="ksep">/</span>')
    : r[0][0];
  return `<div class="krow"><span class="kk">${left}</span><span class="kv">${r[1]}</span></div>`;
}).join('');

let toastTimer = 0;
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
}
function copyText(s){
  try {
    if (window.spark && spark.clipboard && spark.clipboard.writeText){
      const r = spark.clipboard.writeText(s);
      if (r && r.catch) r.catch(() => {});
      return true;
    }
  } catch (e){}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(s).catch(() => {});
      return true;
    }
  } catch (e){}
  try {
    const t = document.createElement('textarea');
    t.value = s;
    t.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch (e){ return false; }
}

let modalOnOk = null, mOkEl = $('mOk');
function showModal(o){
  $('mTitle').textContent = o.title;
  $('mBody').innerHTML = o.html || '';
  mOkEl.textContent = o.okText || '确定';
  mOkEl.className = 'mb primary' + (o.okDanger ? ' danger' : '');
  modalOnOk = o.onOk || null;
  maskEl.classList.remove('hidden');
  setTimeout(() => mOkEl.focus(), 30);
}
function closeModal(){ maskEl.classList.add('hidden'); modalOnOk = null; }
mOkEl.addEventListener('click', () => { const f = modalOnOk; closeModal(); if (f) f(); });
$('mCancel').addEventListener('click', closeModal);
maskEl.addEventListener('click', e => { if (e.target === maskEl) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!maskEl.classList.contains('hidden')) closeModal();
  else if (panel.classList.contains('open')) closePanel();
});

/* ── 主题 ── */
let theme = lsGet(LS.theme) === 'light' ? 'light' : 'dark';
function applyTheme(){ document.documentElement.dataset.theme = theme; }
applyTheme();
$('btnTheme').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  lsSet(LS.theme, theme);
});

/* ── 语法高亮 ── */
function spanIn(frag, cls, text){
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  frag.appendChild(s);
}
function textIn(frag, text){
  if (text) frag.appendChild(document.createTextNode(text));
}
function fillHighlightInto(container, src){
  let toks;
  try { toks = tokenize(src); } catch (e){
    container.textContent = src + '\n\u200b';
    return;
  }
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (let i = 0; i < toks.length; i++){
    const tk = toks[i];
    if (tk.type === 'eof') break;
    if (tk.s > pos) textIn(frag, src.slice(pos, tk.s));
    pos = tk.e;
    const raw = src.slice(tk.s, tk.e);
    switch (tk.type){
      case 'nl': textIn(frag, '\n'); break;
      case 'comment': spanIn(frag, 'tc', raw); break;
      case 'kw': spanIn(frag, 'tk', raw); break;
      case 'num': spanIn(frag, 'tn', raw); break;
      case 'str': spanIn(frag, 'ts', raw); break;
      case 'tpl': drawTpl(raw, frag); break;
      case 'ident': {
        let j = i + 1;
        while (j < toks.length && (toks[j].type === 'nl' || toks[j].type === 'comment')) j++;
        if (toks[j] && toks[j].type === 'op' && toks[j].value === '(') spanIn(frag, 'tf', raw);
        else textIn(frag, raw);
        break;
      }
      case 'op': spanIn(frag, 'to', raw); break;
    }
  }
  textIn(frag, src.slice(pos));
  if (src === '' || src.endsWith('\n')) textIn(frag, '\n\u200b');
  container.textContent = '';
  container.appendChild(frag);
}
function drawTpl(raw, frag){
  let i = 0;
  while (i < raw.length){
    const d = raw.indexOf('${', i);
    if (d === -1){ spanIn(frag, 'ts', raw.slice(i)); break; }
    if (d > i) spanIn(frag, 'ts', raw.slice(i, d));
    spanIn(frag, 'ts', '${');
    let end = -1;
    try { end = scanTplExpr(raw, d + 2, 1).end; } catch (e){ end = -1; }
    const exprSrc = raw.slice(d + 2, end === -1 ? raw.length - 1 : end);
    const sub = document.createElement('span');
    fillHighlightInto(sub, exprSrc);
    frag.appendChild(sub);
    spanIn(frag, 'ts', '}');
    i = end === -1 ? raw.length : end + 1;
  }
}

/* ── 输入提示（简单 IDE 式补全）── */
const SUGGEST_FUNCS = ['sum','avg','len','min','max','range','round','abs','floor','ceil','trunc','sign','sqrt','cbrt','pow','exp','log','log2','log10','sin','cos','tan','asin','acos','atan','atan2','sinh','cosh','tanh','hypot','random','randInt','str','num','int','keys','values'];
const SUGGEST_CONSTS = ['PI', 'E'];
const SUGGEST_KEYWORDS = ['let','const','var','for','while','if','else','break','continue','function','return','true','false','null','undefined','typeof','and','or','not'];
const sugBox = document.createElement('div');
sugBox.className = 'suggest';
codebox.appendChild(sugBox);
const caretMirror = document.createElement('span');
caretMirror.className = 'mono';
caretMirror.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre';
codebox.appendChild(caretMirror);
let sugItems = [], sugIndex = 0, sugFrom = 0, sugWord = '', composing = false;

ta.addEventListener('compositionstart', () => { composing = true; hideSuggest(); });
ta.addEventListener('compositionend', () => { composing = false; updateSuggest(); });
document.addEventListener('mousedown', e => { if (!sugBox.contains(e.target)) hideSuggest(); });
ta.addEventListener('blur', hideSuggest);

function suggestOpen(){ return sugItems.length > 0 && sugBox.classList.contains('show'); }
function hideSuggest(){ sugItems = []; sugBox.classList.remove('show'); }
function updateSuggest(){
  if (composing) return;
  const cs = ta.selectionStart;
  if (cs !== ta.selectionEnd) return hideSuggest();
  const before = ta.value.slice(0, cs);
  const m = before.match(/[A-Za-z_$\u4e00-\u9fff][A-Za-z0-9_$\u4e00-\u9fff]*$/);
  if (!m) return hideSuggest();
  const word = m[0];
  const low = word.toLowerCase();
  const pool = [];
  const seen = new Set();
  const add = (name, kind) => { if (!seen.has(name)){ seen.add(name); pool.push({ name: name, kind: kind }); } };
  for (const v of currentVars) add(v.name, v.text.indexOf('ƒ') === 0 ? '函数' : '变量');
  for (const f of SUGGEST_FUNCS) add(f, '函数');
  for (const c of SUGGEST_CONSTS) add(c, '常量');
  add('Math', '对象');
  for (const k of SUGGEST_KEYWORDS) add(k, '关键字');
  const cands = pool.filter(it => it.name.toLowerCase().startsWith(low));
  if (!cands.length || (cands.length === 1 && cands[0].name === word)) return hideSuggest();
  sugItems = cands.slice(0, 8);
  sugIndex = 0;
  sugFrom = cs - word.length;
  sugWord = word;
  renderSuggest();
  sugBox.classList.add('show');
  positionSuggest();
}
function renderSuggest(){
  sugBox.textContent = '';
  sugItems.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'sug-item' + (i === sugIndex ? ' active' : '');
    const nm = document.createElement('span');
    nm.className = 'sug-name';
    if (sugWord && it.name.toLowerCase().startsWith(sugWord.toLowerCase())){
      const b = document.createElement('b');
      b.textContent = it.name.slice(0, sugWord.length);
      nm.appendChild(b);
      nm.appendChild(document.createTextNode(it.name.slice(sugWord.length)));
    } else nm.textContent = it.name;
    const kd = document.createElement('span');
    kd.className = 'sug-kind';
    kd.textContent = it.kind;
    row.appendChild(nm);
    row.appendChild(kd);
    row.addEventListener('mousedown', e => { e.preventDefault(); sugIndex = i; acceptSuggest(); });
    row.addEventListener('mousemove', () => { if (sugIndex !== i){ sugIndex = i; paintActive(); } });
    sugBox.appendChild(row);
  });
}
function paintActive(){
  Array.from(sugBox.children).forEach((el, i) => el.classList.toggle('active', i === sugIndex));
}
function positionSuggest(){
  const cs = ta.selectionStart;
  const before = ta.value.slice(0, cs);
  const lineStart = before.lastIndexOf('\n') + 1;
  caretMirror.textContent = before.slice(lineStart);
  const w = caretMirror.getBoundingClientRect().width;
  const line = (before.match(/\n/g) || []).length + 1;
  let left = 16 + w - ta.scrollLeft;
  let top = 14 + line * LINE_H + 4 - ta.scrollTop;
  const bw = sugBox.offsetWidth, bh = sugBox.offsetHeight;
  if (left + bw > codebox.clientWidth - 8) left = codebox.clientWidth - 8 - bw;
  if (left < 8) left = 8;
  if (top + bh > codebox.clientHeight - 8)
    top = Math.max(8, 14 + (line - 1) * LINE_H - 4 - bh - ta.scrollTop);
  sugBox.style.left = left + 'px';
  sugBox.style.top = top + 'px';
}
function moveSuggest(d){
  if (!sugItems.length) return;
  sugIndex = (sugIndex + d + sugItems.length) % sugItems.length;
  paintActive();
}
function acceptSuggest(){
  const it = sugItems[sugIndex];
  if (!it) return hideSuggest();
  const end = ta.selectionStart;
  hideSuggest();
  ta.setSelectionRange(sugFrom, end);
  if (!insertAt(it.name)) onEdit(false);
}

/* ── 结果渲染 ── */
let lastGood = null, currentResults = [], currentVars = [], prevPills = new Map();
function drawPills(list, err){
  resEl.textContent = '';
  const byLine = new Map();
  for (const it of list){
    if (!byLine.has(it.line)) byLine.set(it.line, []);
    byLine.get(it.line).push(it);
  }
  if (err && !byLine.has(err.line)) byLine.set(err.line, null);
  const lineCount = ta.value.split('\n').length;
  const newPills = new Map();
  const lines = Array.from(byLine.keys()).sort((a, b) => a - b);
  for (const ln of lines){
    if (ln < 1 || ln > lineCount) continue;
    const pill = document.createElement('div');
    const segs = byLine.get(ln);
    if (err && ln === err.line){
      pill.className = 'pill err';
      pill.textContent = '⚠ ' + err.message;
      pill.title = err.message;
    } else {
      pill.className = 'pill';
      pill.title = '';
      for (const s of segs){
        if (s.label){
          const a = document.createElement('span');
          a.className = 'pl'; a.textContent = s.label;
          const q = document.createElement('span');
          q.className = 'ce'; q.textContent = '=';
          pill.appendChild(a); pill.appendChild(q);
          pill.title += s.label + ' = ' + s.raw + '  ';
        } else {
          pill.title += s.raw + '  ';
        }
        const b = document.createElement('span');
        b.className = 'pv'; b.textContent = s.text;
        pill.appendChild(b);
      }
      const raw = segs.map(s => s.label ? s.label + ' = ' + s.raw : s.raw).join(', ');
      pill.dataset.raw = segs.length === 1 ? segs[0].raw : raw;
      pill.addEventListener('click', () => {
        if (copyText(pill.dataset.raw)) toast('已复制：' + (pill.dataset.raw.length > 26 ? pill.dataset.raw.slice(0, 26) + '…' : pill.dataset.raw));
        else toast('复制失败');
      });
    }
    const key = pill.textContent + '|' + pill.className;
    if (prevPills.get(ln) !== key) pill.classList.add('anim');
    newPills.set(ln, key);
    pill.style.top = (PAD_T + (ln - 1) * LINE_H + 1) + 'px';
    resEl.appendChild(pill);
  }
  prevPills = newPills;
}
function drawVars(vars){
  vlistEl.textContent = '';
  vcountEl.textContent = vars.length;
  if (!vars.length){
    const s = document.createElement('span');
    s.className = 'vempty';
    s.textContent = '暂无变量 — 用 let 定义一个试试';
    vlistEl.appendChild(s);
    return;
  }
  for (const v of vars){
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.title = '点击复制：' + v.text;
    const a = document.createElement('span');
    a.className = 'cn'; a.textContent = v.name;
    const q = document.createElement('span');
    q.className = 'ce'; q.textContent = '=';
    const b = document.createElement('span');
    b.className = 'cv'; b.textContent = v.text;
    chip.appendChild(a); chip.appendChild(q); chip.appendChild(b);
    chip.addEventListener('click', () => {
      if (copyText(v.raw)) toast('已复制：' + v.name + ' = ' + (v.raw.length > 26 ? v.raw.slice(0, 26) + '…' : v.raw));
      else toast('复制失败');
    });
    vlistEl.appendChild(chip);
  }
}

/* ── 运行调度 ── */
let runTimer = 0;
function fit(){
  const lines = ta.value.split('\n').length;
  const need = Math.max(320, lines * LINE_H + 12);
  const avail = codebox.clientHeight - 32;
  ta.style.height = Math.max(need, avail, 320) + 'px';
  syncScroll();
}
function syncScroll(){
  hlEl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
}
ta.addEventListener('scroll', () => { syncScroll(); hideSuggest(); });
window.addEventListener('resize', fit);

function render(r){
  const results = r.ok ? r.results : (r.results.length ? r.results : (lastGood ? lastGood.results : []));
  const vars = r.ok ? r.vars : (r.results.length ? r.vars : (lastGood ? lastGood.vars : []));
  if (r.ok) lastGood = r;
  currentResults = results;
  currentVars = vars;
  drawPills(results, r.ok ? null : r.error);
  drawVars(vars);
  if (r.ok){
    stL.textContent = '就绪 · ' + r.ms + ' ms';
    stL.className = '';
  } else {
    stL.textContent = (r.error.line > 0 ? '第 ' + r.error.line + ' 行：' : '') + r.error.message;
    stL.className = 'st-err';
  }
  stR.textContent = vars.length + ' 变量 · ' + results.length + ' 结果';
}
function runNow(){
  const r = runScript(ta.value);
  render(r);
}
function onEdit(immediate){
  fit();
  fillHighlightInto(hlEl, ta.value);
  updateSuggest();
  lsSet(LS.script, ta.value);
  clearTimeout(runTimer);
  if (immediate) runNow();
  else runTimer = setTimeout(runNow, 90);
}
ta.addEventListener('input', () => onEdit(false));

/* ── 编辑快捷键 ── */
function insertAt(text){
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (e){ ok = false; }
  if (!ok){
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, 'end');
    return false;
  }
  return true;
}
function deleteSelection(){
  let ok = false;
  try { ok = document.execCommand('delete'); } catch (e){ ok = false; }
  if (!ok){
    ta.setRangeText('', ta.selectionStart, ta.selectionEnd, 'end');
    return false;
  }
  return true;
}
/* 光标上下文：'code' | 'quoted'(引号内) | 'tpl'(模板文本内) | 'comment'——跨行扫描引号/模板 ${}/注释 */
const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
function codeStateAt(pos){
  const src = ta.value.slice(0, pos);
  const stack = ['code'];
  const tplBraces = [];
  let braceDepth = 0;
  for (let i = 0; i < src.length; i++){
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === 'line'){ if (c === '\n') stack.pop(); continue; }
    if (top === 'block'){ if (c === '*' && src[i + 1] === '/'){ stack.pop(); i++; } continue; }
    if (typeof top === 'object'){
      if (c === '\\'){ i++; continue; }
      if (c === top.q) stack.pop();
      continue;
    }
    if (top === 'tpl'){
      if (c === '\\'){ i++; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && src[i + 1] === '{'){ stack.push('code'); i++; tplBraces.push(braceDepth); }
      continue;
    }
    if (c === '/' && src[i + 1] === '/'){ stack.push('line'); i++; continue; }
    if (c === '/' && src[i + 1] === '*'){ stack.push('block'); i++; continue; }
    if (c === '"' || c === "'"){ stack.push({ q: c }); continue; }
    if (c === '`'){ stack.push('tpl'); continue; }
    if (c === '{') braceDepth++;
    else if (c === '}'){
      if (tplBraces.length && tplBraces[tplBraces.length - 1] === braceDepth){
        tplBraces.pop();
        stack.pop();
      } else if (braceDepth > 0) braceDepth--;
    }
  }
  const top = stack[stack.length - 1];
  if (top === 'line' || top === 'block') return { kind: 'comment', quote: null };
  if (top === 'tpl') return { kind: 'tpl', quote: '`' };
  if (typeof top === 'object') return { kind: 'quoted', quote: top.q };
  return { kind: 'code', quote: null };
}
ta.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return;
  if (suggestOpen()){
    if (e.key === 'ArrowDown'){ e.preventDefault(); moveSuggest(1); return; }
    if (e.key === 'ArrowUp'){ e.preventDefault(); moveSuggest(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); acceptSuggest(); return; }
    if (e.key === 'Escape'){ e.preventDefault(); hideSuggest(); return; }
  }
  if (e.key === 'Tab'){
    e.preventDefault();
    if (!insertAt('  ')) onEdit(false);
    return;
  }
  if (e.key === 'Enter'){
    e.preventDefault();
    const v = ta.value, s = ta.selectionStart;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const indent = (v.slice(ls, s).match(/^[ \t]*/) || [''])[0];
    const prev = s > 0 ? v[s - 1] : '';
    const next = v[s] || '';
    const OPENERS = { '{': '}', '(': ')', '[': ']' };
    let ins = '\n' + indent;
    let caretBack = 0;
    if (OPENERS[prev] && next === OPENERS[prev]){
      ins = '\n' + indent + '  \n' + indent;
      caretBack = indent.length + 1;
    } else if (OPENERS[prev]){
      ins += '  ';
    }
    if (!insertAt(ins)) onEdit(false);
    if (caretBack){
      const pos = ta.selectionStart - caretBack;
      ta.setSelectionRange(pos, pos);
    }
    return;
  }
  /* ── 括号 / 引号自动补全 ── */
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'Backspace'){
    const st = ta.selectionStart;
    if (st !== ta.selectionEnd || st === 0) return;
    const prev = ta.value[st - 1], next = ta.value[st];
    const state = codeStateAt(st);
    if (BRACKET_PAIRS[prev] && BRACKET_PAIRS[prev] === next
      && (state.kind === 'code' || (state.kind === 'quoted' && state.quote === prev))){
      e.preventDefault();
      ta.setSelectionRange(st - 1, st + 1);
      if (!deleteSelection()) onEdit(false);
    }
    return;
  }
  if (e.key.length !== 1) return;
  const st = ta.selectionStart, en = ta.selectionEnd;
  const hasSel = st !== en;
  const state = codeStateAt(st);
  if (BRACKET_PAIRS[e.key]){
    if (state.kind !== 'code') return;
    e.preventDefault();
    if (hasSel){
      const sel = ta.value.slice(st, en);
      if (!insertAt(e.key + sel + BRACKET_PAIRS[e.key])) onEdit(false);
      const pos = ta.selectionStart - BRACKET_PAIRS[e.key].length;
      ta.setSelectionRange(pos, pos);
    } else {
      if ((e.key === '"' || e.key === "'" || e.key === '`') && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(ta.value[st] || '')) return;
      if (!insertAt(e.key + BRACKET_PAIRS[e.key])) onEdit(false);
      const pos = ta.selectionStart - 1;
      ta.setSelectionRange(pos, pos);
    }
    return;
  }
  if (e.key === ')' || e.key === ']' || e.key === '}' || e.key === '"' || e.key === "'" || e.key === '`'){
    if (hasSel || ta.value[st] !== e.key) return;
    const skippable = state.kind === 'code'
      || (state.kind === 'tpl' && e.key === '`')
      || (state.kind === 'quoted' && state.quote === e.key);
    if (!skippable) return;
    e.preventDefault();
    ta.setSelectionRange(st + 1, st + 1);
  }
});

/* ── 工具栏 ── */
$('btnSample').addEventListener('click', () => {
  if (ta.value === '' || ta.value === SAMPLE){
    ta.value = SAMPLE;
    onEdit(true);
    return;
  }
  showModal({
    title: '载入示例？',
    html: '当前内容会被覆盖（可先复制备份）。',
    okText: '载入',
    onOk(){ ta.value = SAMPLE; onEdit(true); toast('已载入示例'); }
  });
});
$('btnClear').addEventListener('click', () => {
  if (!ta.value) return;
  ta.value = '';
  onEdit(true);
});
$('btnCopy').addEventListener('click', () => {
  if (!currentResults.length){ toast('还没有可复制的结果'); return; }
  const srcLines = ta.value.split('\n');
  const out = currentResults.map(it =>
    (it.label ? it.label : (srcLines[it.line - 1] || '').trim()) + ' = ' + it.raw);
  const ok = copyText(out.join('\n'));
  toast(ok ? '已复制 ' + out.length + ' 条结果' : '复制失败');
});
/* ── 帮助抽屉（语法 / 关键字）── */
const LS_PANEL = 'spark_codecalc_panel';
let panelTab = 'help';
phelpEl.innerHTML = HELP_HTML;
pkwEl.innerHTML = '<div class="phint">点击关键字可插入到光标处</div>' + KW_HTML;
function openPanel(tab){
  panelTab = tab;
  ptabHelp.classList.toggle('active', tab === 'help');
  ptabKw.classList.toggle('active', tab === 'kw');
  phelpEl.classList.toggle('phidden', tab !== 'help');
  pkwEl.classList.toggle('phidden', tab !== 'kw');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  lsSet(LS_PANEL, tab);
}
function closePanel(){
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  lsSet(LS_PANEL, '');
}
$('btnHelp').addEventListener('click', () => {
  if (panel.classList.contains('open')) closePanel();
  else openPanel(panelTab);
});
$('ptabHelp').addEventListener('click', () => openPanel('help'));
$('ptabKw').addEventListener('click', () => openPanel('kw'));
$('pclose').addEventListener('click', closePanel);
pkwEl.addEventListener('click', e => {
  const b = e.target.closest('.kchip');
  if (!b) return;
  if (!insertAt(b.dataset.kw)) onEdit(false);
  toast('已插入 ' + b.dataset.kw);
});

/* ── 启动 ── */
// 默认空编辑器；示例只通过右上角「示例」按钮载入
// 旧版本曾把自动填充的示例存进 spark_codecalc_script，作废改用 v2 键，首次启动顺手清理旧键
const saved = lsGet(LS.script);
if (saved === null) lsDel(LS.legacyScript);
ta.value = saved === null ? '' : saved;
ta.placeholder = '像写代码一样算数，试试：\nlet 价格 = 99.9\nlet 数量 = 3\n价格 * 数量\n\n点右上角「示例」看完整演示';
onEdit(true);
ta.focus();
ta.setSelectionRange(ta.value.length, ta.value.length);

// 恢复上次打开的帮助面板（避免首帧动画，禁过渡后再移除）
const savedPanel = lsGet(LS_PANEL);
if (savedPanel === 'help' || savedPanel === 'kw'){
  panel.classList.add('notrans');
  openPanel(savedPanel);
  requestAnimationFrame(() => panel.classList.remove('notrans'));
}
