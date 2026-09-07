/* ui.js — UI 组件库与通用工具页工厂 */
var UI = (function () {
  'use strict';

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    }
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
    return n;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(path, size) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('width', size || 16);
    s.setAttribute('height', size || 16);
    s.setAttribute('aria-hidden', 'true');
    // 直接建 path 并设 d,不走 innerHTML——部分 webview 对 SVG 元素设 innerHTML 会把子节点解析进 HTML 命名空间导致不渲染
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }

  /* ---------- 基础控件 ---------- */
  function ta(id, ph, rows) {
    var t = el('textarea', { class: 'ta mono', id: id, placeholder: ph || '', rows: rows || 6, spellcheck: 'false' });
    t.setAttribute('autocomplete', 'off');
    return t;
  }
  function input(id, ph, value) {
    var t = el('input', { class: 'in', id: id, placeholder: ph || '', value: value || '' });
    t.setAttribute('autocomplete', 'off');
    t.setAttribute('spellcheck', 'false');
    return t;
  }
  function select(id, options, value) {
    var s = el('select', { class: 'sel', id: id });
    for (var o of options) {
      var opt = el('option', { text: o.t !== undefined ? o.t : o });
      opt.value = o.v !== undefined ? o.v : o;
      if ((o.v !== undefined ? o.v : o) === value) opt.selected = true;
      s.appendChild(opt);
    }
    return s;
  }
  function check(id, label, checked) {
    var l = el('label', { class: 'chk' });
    var c = el('input', { type: 'checkbox', id: id });
    c.checked = !!checked;
    l.appendChild(c);
    l.appendChild(el('span', { text: label }));
    return l;
  }
  function btn(label, onclick, opts) {
    opts = opts || {};
    var b = el('button', { class: 'bt' + (opts.primary ? ' primary' : '') + (opts.danger ? ' danger' : '') + (opts.small ? ' small' : ''), text: label });
    if (opts.title) b.title = opts.title;
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }
  function field(labelText, ctrl) {
    var w = el('div', { class: 'field' });
    w.appendChild(el('span', { class: 'flabel', text: labelText }));
    w.appendChild(ctrl);
    return w;
  }
  function optsRow() {
    var r = el('div', { class: 'opts' });
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) r.appendChild(arguments[i]);
    return r;
  }
  function hint(text) { return el('div', { class: 'hint', text: text }); }

  /* ---------- 输入/输出面板 ---------- */
  function paneHeader(extraBtns) {
    var bar = el('div', { class: 'pbar' });
    if (extraBtns) for (var b of extraBtns) bar.appendChild(b);
    return bar;
  }
  function copyBtn(getText, small) {
    var b = el('button', { class: 'pbt' + (small ? ' small' : ''), title: '复制结果' });
    b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>复制';
    b.addEventListener('click', function () {
      var v = getText();
      if (v === undefined || v === null) return;
      copy(String(v));
    });
    return b;
  }
  function clearBtn(target, small) {
    var b = el('button', { class: 'pbt' + (small ? ' small' : ''), title: '清空' });
    b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12h9.4l.8-12"/></svg>清空';
    b.addEventListener('click', function () {
      if (target.value !== undefined) { target.value = ''; target.dispatchEvent(new Event('input')); }
      else target.textContent = '';
    });
    return b;
  }
  function swapBtn(a, b) {
    var btnEl = el('button', { class: 'pbt', title: '交换输入输出' });
    btnEl.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3"/></svg>交换';
    btnEl.addEventListener('click', function () {
      var t = a.value; a.value = b.value; b.value = t;
      a.dispatchEvent(new Event('input'));
    });
    return btnEl;
  }

  /* ---------- 复制 / 下载 / 提示 ---------- */
  function copy(text) {
    function fallback() {
      var tmp = el('textarea', { class: 'copy-tmp' });
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); toast('已复制'); }
      catch (e) { toast('复制失败', true); }
      document.body.removeChild(tmp);
    }
    if (typeof spark !== 'undefined' && spark.clipboard && spark.clipboard.writeText) {
      spark.clipboard.writeText(text).then(function () { toast('已复制'); })
        .catch(function () { legacyCopy(text); });
    } else legacyCopy(text);
  }
  function legacyCopy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); })
        .catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var tmp = el('textarea', { class: 'copy-tmp' });
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); toast('已复制'); }
      catch (e) { toast('复制失败', true); }
      document.body.removeChild(tmp);
    }
  }
  var toastTimer = null;
  function toast(msg, isErr) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 1800);
  }
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  function filePick(accept, asText, cb) {
    var inp = document.createElement('input');
    inp.type = 'file';
    if (accept) inp.accept = accept;
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      if (asText) {
        r.onload = function () { cb(f.name, r.result); };
        r.readAsText(f);
      } else {
        r.onload = function () { cb(f.name, new Uint8Array(r.result)); };
        r.readAsArrayBuffer(f);
      }
    };
    inp.click();
  }
  function errShow(box, msg) {
    if (!box) return;
    if (msg) { box.textContent = msg; box.style.display = 'block'; }
    else { box.textContent = ''; box.style.display = 'none'; }
  }

  /* ---------- 键值输出表格 ---------- */
  function kvList(pairs, opts) {
    opts = opts || {};
    var box = el('div', { class: 'kvs' });
    for (var p of pairs) {
      if (p === null) { box.appendChild(el('div', { class: 'kvs-sep' })); continue; }
      var row = el('div', { class: 'kv' });
      row.appendChild(el('span', { class: 'kv-k', text: p[0] }));
      var v = el('span', { class: 'kv-v mono', text: p[1] === undefined || p[1] === null ? '' : String(p[1]) });
      if (!opts.noCopy) {
        v.title = '点击复制';
        v.addEventListener('click', function () { copy(this.textContent); }.bind(v));
      }
      row.appendChild(v);
      box.appendChild(row);
    }
    return box;
  }

  /* ---------- 通用工具页工厂 ----------
     def = {
       placeholder, rows,
       options: [{kind:'select'|'check'|'input', id, label, options, value, ph}],
       live: (text, vals, out) -> void   // out: {set(text)|setNode(el)|err(msg)}
       swap: true,
       btnText, btnFn   // 非实时按钮模式
     } */
  var ioSeq = 0;
  function ioTool(host, def) {
    var state = { values: {} };
    var uid = 'iot' + (++ioSeq) + '-';
    var wrap = el('div', { class: 'iotool' });
    var inTa = ta(uid + 'in', def.placeholder, def.rows || 8);
    var outTa = ta(uid + 'out', '');
    outTa.readOnly = true;
    var inBarBtns = [copyBtn(function () { return inTa.value; }), clearBtn(inTa)];
    if (def.swap) inBarBtns.push(swapBtn(inTa, outTa));
    var inBar = paneHeader(inBarBtns);
    var inCol = el('div', { class: 'pane' });
    inCol.appendChild(inBar);
    inCol.appendChild(inTa);
    var outNodeHost = el('div', { class: 'outnode' });
    var outSet = {
      set: function (s) { outNodeHost.style.display = 'none'; outNodeHost.innerHTML = ''; outTa.style.display = 'block'; outTa.value = s === undefined || s === null ? '' : String(s); },
      setNode: function (n) { outTa.style.display = 'none'; outNodeHost.style.display = 'block'; outNodeHost.innerHTML = ''; outNodeHost.appendChild(n); }
    };
    var errBoxEl = el('div', { class: 'errbox' });
    errBoxEl.style.display = 'none';

    var optsBar = el('div', { class: 'optsbar' });
    if (def.options) {
      for (var od of def.options) {
        var ctrl;
        if (od.kind === 'select') ctrl = select(od.id, od.options, od.value);
        else if (od.kind === 'check') ctrl = check(od.id, od.label, od.value);
        else ctrl = input(od.id, od.ph, od.value);
        state.values[od.id] = od.kind === 'check' ? !!od.value : (od.value || '');
        if (od.kind === 'check') {
          ctrl.querySelector('input').addEventListener('change', function () {
            state.values[this.id] = this.checked;
            refreshSoon();
          });
        } else {
          ctrl.addEventListener('input', function () { state.values[this.id] = this.value; refreshSoon(); });
          ctrl.addEventListener('change', function () { state.values[this.id] = this.value; refreshSoon(); });
        }
        var fw = el('label', { class: 'opt' });
        if (od.label) fw.appendChild(el('span', { class: 'opt-l', text: od.label }));
        fw.appendChild(ctrl);
        optsBar.appendChild(fw);
      }
    }
    function vals() {
      var v = {};
      for (var k in state.values) {
        var e = document.getElementById(k);
        v[k] = e ? (e.type === 'checkbox' ? e.checked : e.value) : state.values[k];
      }
      return v;
    }
    var timer = null;
    function refreshSoon() { clearTimeout(timer); timer = setTimeout(refresh, 120); }
    function refresh() {
      errShow(errBoxEl, null);
      try { def.live(inTa.value, vals(), outSet); }
      catch (e) { errShow(errBoxEl, e && e.message ? e.message : String(e)); }
    }
    inTa.addEventListener('input', refreshSoon);

    var grid = el('div', { class: 'iogrid' });
    var outCol = el('div', { class: 'col' });
    outCol.appendChild(paneHeader([copyBtn(function () { return outTa.style.display === 'none' ? outNodeHost.textContent : outTa.value; }), clearBtn(outTa)]));
    outCol.appendChild(outTa);
    outCol.appendChild(outNodeHost);
    outCol.appendChild(errBoxEl);
    grid.appendChild(inCol);
    grid.appendChild(outCol);

    wrap.appendChild(optsBar);
    wrap.appendChild(grid);
    if (def.foot) wrap.appendChild(def.foot());
    host.appendChild(wrap);
    if (def.init) { try { def.init(inTa, vals, outSet); } catch (e) { errShow(errBoxEl, e.message); } }
    if (def.live) refresh();
    return { input: inTa, output: outTa, out: outSet, values: vals, refresh: refresh, err: errBoxEl };
  }

  return {
    el: el, svgIcon: svgIcon, ta: ta, input: input, select: select, check: check,
    btn: btn, field: field, optsRow: optsRow, hint: hint,
    copy: copy, toast: toast, download: download, filePick: filePick,
    errShow: errShow, kvList: kvList, ioTool: ioTool, copyBtn: copyBtn, clearBtn: clearBtn, swapBtn: swapBtn
  };
})();
if (typeof globalThis !== 'undefined') globalThis.UI = UI;