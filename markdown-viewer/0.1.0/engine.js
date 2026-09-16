/* Markdown 查看器 · 渲染管线
 * md → marked(GFM) → DOMPurify 白名单消毒 → innerHTML → 自有后处理（此时 DOM 已消毒，
 * 注入物全是我们自己的节点——linux-command doc.js 同构纪律）：
 *   GitHub 兼容 slug（恢复 md 手写 #锚点 + 供阅读位置持久化） / TOC 数据 / 链接四分流 /
 *   图片四分流 / hljs 高亮(cap 30，无语言标注不硬套) / 表格横滚 / 任务列表只读化。
 *
 * input 放行策略：linux-command 把 input 整个 FORBID（其内容是受控文档库）；
 * 本插件看任意 md，GFM 任务列表的 checkbox 是刚需——所以 ADD_TAGS 放进 input，
 * 消毒后在自有后处理里收口：非 type=checkbox 的 input 一律删节点，checkbox 强制 disabled。
 * svg/math 维持 FORBID——mermaid/内联公式的渲染产物正是 svg/math，一期明确不支持。
 *
 * @see [决策笔记 DOMPurify 档位](../../.agents/notes/implemented/feature/2026-09-16-mdviewer-dompurify-profile.md)
 * @see [决策笔记 链接策略](../../.agents/notes/implemented/architecture/2026-09-16-mdviewer-link-policy.md)
 * @see [决策笔记 slug 与 TOC](../../.agents/notes/implemented/feature/2026-09-16-mdviewer-slug-toc.md)
 */
var MDV_ENGINE = (function () {
  'use strict';

  var HL_CAP = 30;

  var FORBID_TAGS = 'script|style|iframe|object|embed|form|button|select|textarea|option|link|meta|svg|math|picture|source|video|audio|canvas|base|frame|frameset|noscript|template';
  var FORBID_ATTR = 'style|srcset|formaction|xlink:href|background|dynsrc|lowsrc|ping|nonce|autofocus';

  function markedParse(marked, md) {
    if (!marked || typeof marked.parse !== 'function') throw new Error('marked 未加载');
    /* marked 5.x 移除 headerIds/mangle 选项——vendor 升级必改此处（VENDORS.md 已记） */
    return marked.parse(md, { gfm: true, breaks: false, mangle: false, headerIds: false, silent: false });
  }

  function sanitize(DOMPurify, html) {
    if (!DOMPurify) throw new Error('DOMPurify 未加载');
    /* 危险 URI(javascript:/data:/vbscript:)依赖 DOMPurify 默认 ALLOWED_URI_REGEXP 拦截，
       此处未覆写；升级 vendor 需复查该默认白名单仍不含这三种 scheme */
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: FORBID_TAGS.split('|'),
      FORBID_ATTR: FORBID_ATTR.split('|'),
      ADD_TAGS: ['input'],
      ADD_ATTR: ['type', 'checked', 'disabled']
    });
  }

  /* GitHub 兼容 slug：小写、去标点、空格→-、重名追加 -1/-2。
     与 GitHub 约定一致，md 作者手写的 [x](#section) 锚点天然恢复工作。 */
  function makeSlugger() {
    var seen = Object.create(null);
    return function (text) {
      var s = String(text).trim().toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!s) s = 'section';
      if (seen[s] == null) { seen[s] = 0; return s; }
      seen[s] += 1;
      return s + '-' + seen[s];
    };
  }

  /* 链接四分流：external(https) / anchor(#xxx) / internal(.md 相对路径) / dead(不可点)。
     红线：本地路径与一切非 http(s) scheme 归 dead——openExternal 只收 external，
     file:// 透传 = 默认程序打开任意文件 = 注入→RCE 路径，整段封死。 */
  function classifyLink(href) {
    var h = String(href || '').trim();
    if (/^https?:\/\//i.test(h)) return 'external';
    if (h.charAt(0) === '#') return 'anchor';
    if (/^([a-z][a-z0-9+.-]*):/i.test(h)) return 'dead';   // file/ftp/javascript/data/mailto/… 一律不可点
    if (/^\/\//.test(h)) return 'dead';                     // 协议相对 //host/x 视作远程，页面禁网不可点
    var path = h.split('#')[0];
    if (/\.(md|markdown|mdx)\/?$/i.test(path)) return 'internal';
    return 'dead';                                          // 相对非 md（图片/网页）也不透传
  }

  function classifyImage(src) {
    var s = String(src || '').trim();
    if (/^data:image\//i.test(s)) return 'inline';
    if (/^https?:\/\//i.test(s)) return 'remote';
    if (/^(file|ftp):/i.test(s)) return 'blocked';
    return 'relative';
  }

  /* 渲染主入口：render(mdText, reader, articleEl)
     → { toc:[{id,text,level}], pendingImgs, textLen }
     图片占位/objectURL 落地由 app.js 处理：这里只负责分类与打标。 */
  function render(mdText, reader, article) {
    var global = (typeof window !== 'undefined' ? window : globalThis);
    var marked = global.marked;
    var DOMPurify = global.DOMPurify;
    var doc = article.ownerDocument;

    var raw = markedParse(marked, String(mdText == null ? '' : mdText));
    var clean = sanitize(DOMPurify, raw);
    article.innerHTML = clean;

    /* input 收口：非 checkbox 删除；checkbox 强制 disabled（只读任务列表） */
    var inputs = article.querySelectorAll('input');
    for (var n = inputs.length - 1; n >= 0; n--) {
      var inp = inputs[n];
      var type = (inp.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox') {
        inp.setAttribute('disabled', '');
        inp.removeAttribute('name');
      } else {
        inp.parentNode.removeChild(inp);
      }
    }

    /* 标题：GitHub slug + TOC 数据 */
    var slug = makeSlugger();
    var toc = [];
    var heads = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (var h = 0; h < heads.length; h++) {
      var el = heads[h];
      var text = (el.textContent || '').trim();
      if (!text) continue;
      var id = 'md-' + slug(text);
      el.setAttribute('id', id);
      toc.push({ id: id, text: text, level: Number(el.tagName.charAt(1)) });
    }

    /* 链接分流：dead → 降级为不可点 span（title 留目标弱提示）；其余打标，点击行为归 app.js */
    var links = article.querySelectorAll('a[href]');
    for (var a = links.length - 1; a >= 0; a--) {
      var an = links[a];
      var href = an.getAttribute('href') || '';
      var cls = classifyLink(href);
      if (cls === 'dead') {
        var span = doc.createElement('span');
        span.className = 'dead-link';
        span.setAttribute('title', href);
        while (an.firstChild) span.appendChild(an.firstChild);
        an.parentNode.replaceChild(span, an);
      } else {
        an.setAttribute('data-link', cls);
        if (cls === 'internal') an.setAttribute('data-href', href);
      }
    }

    /* 图片分流：inline 直接用；relative 视 reader 能力位 → pending（等 app.js 填 objectURL）
       或 blocked（占位）；remote 禁网必失败 → 占位 + 点击可经 openExternal 在浏览器看 */
    var imgs = article.querySelectorAll('img[src]');
    var pendingImgs = [];
    for (var i = imgs.length - 1; i >= 0; i--) {
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      var cat = classifyImage(src);
      if (cat === 'inline') continue;
      if (cat === 'relative' && reader && reader.canReadBinary()) {
        img.setAttribute('data-img', 'pending');
        img.setAttribute('data-src', src);
      } else if (cat === 'remote') {
        img.setAttribute('data-img', 'remote');
      } else {
        img.setAttribute('data-img', 'blocked');
      }
      img.removeAttribute('src');
      pendingImgs.unshift(img);
    }

    /* 表格横滚 */
    var tables = article.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var wrap = doc.createElement('div');
      wrap.className = 'tablewrap';
      tables[t].parentNode.insertBefore(wrap, tables[t]);
      wrap.appendChild(tables[t]);
    }

    /* 代码块：头条（语言标签 + 复制按钮）+ hljs 高亮。
       无语言标注：不高亮、不硬套 bash——linux-command 硬套是因其内容全是命令，
       通用查看器套错语言比不高亮更难看。cap 30 与先例一致。 */
    var blocks = article.querySelectorAll('pre > code');
    var highlighted = 0;
    var hljs = global.hljs;
    for (var b = 0; b < blocks.length; b++) {
      var code = blocks[b];
      var pre = code.parentNode;
      var box = doc.createElement('div');
      box.className = 'code';
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);

      var head = doc.createElement('div');
      head.className = 'code-head';
      var lm = (code.className || '').match(/language-([\w+#.-]+)/);
      if (lm) {
        var lang = doc.createElement('span');
        lang.className = 'code-lang';
        lang.textContent = lm[1];
        head.appendChild(lang);
      }
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.setAttribute('aria-label', '复制代码');
      btn.setAttribute('title', '复制代码');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
      head.appendChild(btn);
      box.insertBefore(head, pre);

      if (hljs && lm && highlighted < HL_CAP) {
        try { hljs.highlightElement(code); highlighted++; } catch (e) { /* 高亮失败不影响可读 */ }
      }
    }

    /* 任务列表 li 打标（样式钩子：勾选态划线置灰） */
    var tasks = article.querySelectorAll('li input[type="checkbox"]');
    for (var ti = 0; ti < tasks.length; ti++) {
      var li = tasks[ti].closest('li');
      if (li) {
        li.classList.add('task');
        if (tasks[ti].hasAttribute('checked')) li.classList.add('done');
      }
    }

    var textLen = (article.textContent || '').replace(/\s+/g, '').length;
    return { toc: toc, pendingImgs: pendingImgs, textLen: textLen };
  }

  function available() {
    var g = (typeof window !== 'undefined' ? window : globalThis);
    return !!(g.marked && g.DOMPurify);
  }

  return { HL_CAP: HL_CAP, render: render, classifyLink: classifyLink, classifyImage: classifyImage, available: available };
})();
(typeof window !== 'undefined' ? window : globalThis).MDV_ENGINE = MDV_ENGINE;