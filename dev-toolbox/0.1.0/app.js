/* app.js — 外壳：工具注册、侧栏导航、路由、主题 */
var App = (function () {
  'use strict';
  var TOOLS = [];
  var GROUPS = [
    ['codec', '编解码'],
    ['crypto', '加密哈希'],
    ['text', '文本处理'],
    ['time', '时间日期'],
    ['code', '代码格式'],
    ['net', '网络计算'],
    ['gen', '生成工具'],
    ['units', '单位换算']
  ];
  var current = null;
  var rendered = {};

  function tool(def) { TOOLS.push(def); }

  function byId(id) {
    for (var t of TOOLS) if (t.id === id) return t;
    return null;
  }

  function renderNav(filter) {
    var list = document.getElementById('nav');
    list.innerHTML = '';
    filter = (filter || '').trim().toLowerCase();
    var shown = 0;
    for (var g of GROUPS) {
      var items = TOOLS.filter(function (t) {
        if (t.group !== g[0]) return false;
        if (!filter) return true;
        return (t.name + ' ' + t.id + ' ' + (t.alias || '')).toLowerCase().indexOf(filter) >= 0;
      });
      if (!items.length) continue;
      var sec = UI.el('div', { class: 'navsec' });
      sec.appendChild(UI.el('div', { class: 'navsec-t', text: g[1] }));
      for (var t of items) {
        var item = UI.el('button', { class: 'navitem' + (current === t.id ? ' active' : '') });
        item.appendChild(UI.svgIcon(t.icon || 'M12 3v18M3 12h18', 15));
        item.appendChild(UI.el('span', { text: t.name }));
        item.addEventListener('click', function () { go(this.dataset.id); });
        item.dataset.id = t.id;
        sec.appendChild(item);
        shown++;
      }
      list.appendChild(sec);
    }
    if (!shown) {
      var empty = UI.el('div', { class: 'navempty', text: filter ? '没有匹配的工具' : '' });
      list.appendChild(empty);
    }
  }

  function go(id, skipHash) {
    var t = byId(id);
    if (!t) return false;
    current = id;
    if (!skipHash) { try { location.hash = '#' + id; } catch (e) { } }
    var main = document.getElementById('main');
    for (var c of Array.from(main.children)) c.style.display = 'none';
    if (!rendered[id]) {
      var box = UI.el('section', { class: 'tool' });
      var head = UI.el('header', { class: 'tool-head' });
      var icon = UI.el('span', { class: 'tool-icon' });
      icon.appendChild(UI.svgIcon(t.icon || 'M12 3v18M3 12h18', 20));
      head.appendChild(icon);
      var ht = UI.el('div', { class: 'tool-ht' });
      ht.appendChild(UI.el('h2', { text: t.name }));
      if (t.desc) ht.appendChild(UI.el('p', { text: t.desc }));
      head.appendChild(ht);
      box.appendChild(head);
      var body = UI.el('div', { class: 'tool-body' });
      try { t.render(body); }
      catch (e) {
        body.appendChild(UI.el('div', { class: 'errbox', text: '工具初始化失败：' + (e.message || e) }));
      }
      box.appendChild(body);
      main.appendChild(box);
      rendered[id] = box;
    }
    rendered[id].style.display = 'block';
    document.getElementById('crumb').textContent = t.name;
    renderNav(document.getElementById('navsearch').value);
    try { localStorage.setItem('devtool.last', id); } catch (e) { }
    var nav = document.querySelector('.navitem[data-id="' + id + '"]');
    if (nav) nav.classList.add('active');
    return true;
  }

  function setTheme(mode) {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem('devtool.theme', mode); } catch (e) { }
  }
  function toggleTheme() {
    var mode = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(mode);
  }

  function boot() {
    var q = '';
    try { q = (typeof spark !== 'undefined' && spark.input && spark.input.text) || ''; } catch (e) { }
    // 主题
    var theme = 'dark';
    try { theme = localStorage.getItem('devtool.theme') || 'dark'; } catch (e) { }
    document.documentElement.dataset.theme = theme;
    var btnTheme = document.getElementById('btnTheme');
    if (btnTheme) btnTheme.addEventListener('click', toggleTheme);

    // 搜索过滤
    var ns = document.getElementById('navsearch');
    ns.addEventListener('input', function () { renderNav(this.value); });
    ns.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = document.querySelector('.navitem');
        if (first) first.click();
      }
      if (e.key === 'Escape') { this.value = ''; renderNav(''); }
    });

    renderNav('');
    // 初始工具：hash > 输入词匹配 > 上次使用 > 第一个
    var initial = null;
    var h = (location.hash || '').replace(/^#/, '');
    if (h && byId(h)) initial = h;
    if (!initial && q) {
      var ql = q.toLowerCase();
      for (var t of TOOLS) {
        if ((t.id + ' ' + t.name + ' ' + (t.alias || '')).toLowerCase().indexOf(ql) >= 0) { initial = t.id; break; }
      }
      if (!initial) ns.value = q;
    }
    if (!initial) { try { initial = localStorage.getItem('devtool.last'); } catch (e) { } }
    if (!initial || !byId(initial)) initial = TOOLS.length ? TOOLS[0].id : null;
    if (initial) go(initial, true);
    else {
      var main = document.getElementById('main');
      main.appendChild(UI.el('div', { class: 'welcome' }));
    }
    if (typeof spark !== 'undefined' && spark.dev && spark.dev.openDevTools) {
      var bd = document.getElementById('btnDev');
      if (bd) bd.style.display = '';
    }
  }

  return { tool: tool, boot: boot, go: go, TOOLS: TOOLS, GROUPS: GROUPS, toggleTheme: toggleTheme };
})();
if (typeof globalThis !== 'undefined') globalThis.App = App;
document.addEventListener('DOMContentLoaded', function () { App.boot(); });

/* 页面加固：屏蔽默认右键菜单与浏览器快捷键 */
document.addEventListener('contextmenu', function (e) {
  // 输入框/文本域保留系统菜单（剪切/复制/粘贴）
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('keydown', function (e) {
  var k = (e.key || '').toLowerCase();
  var editing = e.target && e.target.closest && e.target.closest('input, textarea');
  // DevTools / 打印 / 刷新：任何焦点都拦（F12、F5、Ctrl+Shift+I/J/C、Ctrl+P）
  if (k === 'f12' || k === 'f5' ||
      (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
      ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
    e.preventDefault();
    return;
  }
  // Ctrl+R：输入框/文本域内放行；其余位置（会整页刷新）拦截
  if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
    e.preventDefault();
  }
}, true);