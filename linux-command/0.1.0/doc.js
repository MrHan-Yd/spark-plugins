/* Linux 命令查询 · Markdown 渲染管线
 * md → marked → DOMPurify 白名单消毒 → innerHTML → 自有后处理(此时 DOM 已消毒,注入物全是我们自己的节点):
 *   hljs 高亮(无语言标注按 bash,单篇 ≤30 块) / 代码块包 .code + 复制按钮(点击事件由 app.js 委托)
 *   h2/h3 自派 id + 返回目录数据(≥3 个标题才显示 TOC,由 app.js 决定) / 链接降级 span / 表格包横滚容器
 */
(function (global) {
'use strict';

var DOC = {};

var FORBID_TAGS = 'script|style|iframe|object|embed|form|input|button|select|textarea|option|link|meta|svg|math|img|picture|source|video|audio|canvas|base|frame|frameset|noscript|template';
var FORBID_ATTR = 'style|srcset|formaction|xlink:href|background|dynsrc|lowsrc|ping|nonce|autofocus';

function markedParse(md) {
  var marked = global.marked;
  if (!marked || typeof marked.parse !== 'function') throw new Error('marked 未加载');
  return marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false, silent: false });
}

function sanitize(html) {
  var DOMPurify = global.DOMPurify;
  if (!DOMPurify) throw new Error('DOMPurify 未加载');
  /* 危险 URI(javascript:/data:/vbscript:)依赖 DOMPurify 默认 ALLOWED_URI_REGEXP 拦截,此处未覆写;
     升级 vendor 需复查该默认白名单仍不含这三种 scheme */
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: FORBID_TAGS.split('|'),
    FORBID_ATTR: FORBID_ATTR.split('|')
  });
}

/* 渲染主入口:render(md, articleEl) → {headings:[{id,text,level}]} */
DOC.render = function (md, article) {
  var raw = markedParse(String(md == null ? '' : md));
  var clean = sanitize(raw);
  article.innerHTML = clean;

  /* a → span(保留 href 作 title 弱提示,不开外链) */
  var links = article.querySelectorAll('a');
  for (var i = links.length - 1; i >= 0; i--) {
    var a = links[i];
    var span = article.ownerDocument.createElement('span');
    span.className = 'md-link';
    var href = a.getAttribute('href');
    if (href) { span.setAttribute('title', href); span.classList.add('has-href'); }
    while (a.firstChild) span.appendChild(a.firstChild);
    a.parentNode.replaceChild(span, a);
  }

  /* 表格横滚 */
  var tables = article.querySelectorAll('table');
  for (var t = 0; t < tables.length; t++) {
    var wrap = article.ownerDocument.createElement('div');
    wrap.className = 'tablewrap';
    tables[t].parentNode.insertBefore(wrap, tables[t]);
    wrap.appendChild(tables[t]);
  }

  /* 代码块:hljs + 复制按钮(复制文本从 DOM 现取,不复制数据) */
  var blocks = article.querySelectorAll('pre > code');
  var highlighted = 0;
  var hljs = global.hljs;
  for (var b = 0; b < blocks.length; b++) {
    var code = blocks[b];
    var pre = code.parentNode;
    var box = article.ownerDocument.createElement('div');
    box.className = 'code';
    pre.parentNode.insertBefore(box, pre);
    box.appendChild(pre);
    var btn = article.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.setAttribute('aria-label', '复制代码');
    btn.innerHTML = '<i class="ic ic-copy"></i>';
    box.appendChild(btn);
    if (hljs) {
      /* 语言类统一追加(31+ 块只上样式不高亮,保持渲染一致性) */
      var cls = code.className || '';
      if (!/(^|\s)language-/.test(cls) && !/(^|\s)hljs(\s|$)/.test(cls)) code.classList.add('language-bash');
      if (highlighted < 30) {
        try { hljs.highlightElement(code); highlighted++; } catch (e) { /* 高亮失败不影响可读 */ }
      }
    }
  }

  /* h2/h3 锚点 + TOC 数据 */
  var headings = [];
  var heads = article.querySelectorAll('h2, h3');
  for (var h = 0, seq = 0; h < heads.length; h++) {
    var el = heads[h];
    var id = 'md-h-' + seq++;
    el.setAttribute('id', id);
    var text = (el.textContent || '').trim();
    if (text) headings.push({ id: id, text: text, level: el.tagName === 'H2' ? 2 : 3 });
  }
  return { headings: headings };
};

DOC.available = function () {
  return !!(global.marked && global.DOMPurify);
};

global.LCMD_DOC = DOC;
})(typeof window !== 'undefined' ? window : globalThis);