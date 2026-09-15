/* ui.js — 密码管家 · 自绘下拉框组件
 *
 * 为什么不用原生 <select>：它的下拉面板由操作系统/浏览器绘制，CSS 完全管不到
 * （深蓝高亮、方角、系统字体），跟插件的暗色玻璃风格严重违和。这里把原生 select
 * 保留在 DOM 里当「取值与语义」的真源（无障碍、`$(id).value` 读写都照旧），
 * 上面盖一层自绘按钮 + 弹层面板，样式与动效完全可控。
 *
 * 用法：
 *   AppSelect.enhance(document.getElementById('sort'));
 *   AppSelect.enhanceAll(root);          // 增强 root 下所有 select.mini-select
 * 增强后 `sel.value = 'x'` 会自动同步外观（已改写实例上的 value 访问器）。
 */

var AppSelect = (function () {
  'use strict';

  var instances = [];

  var CARET = '<span class="sel-caret" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg></span>';

  function closeAll(except) {
    instances.forEach(function (s) { if (s !== except) s.close(); });
  }

  function enhance(sel, opts) {
    if (!sel || sel.__appSelect) return sel && sel.__appSelect;
    opts = opts || {};
    var proto = Object.getPrototypeOf(sel);
    var valueDesc = Object.getOwnPropertyDescriptor(proto, 'value');

    var wrap = document.createElement('div');
    wrap.className = 'sel' + (opts.block ? ' sel-block' : '');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('sel-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');

    wrap.insertAdjacentHTML('afterbegin',
      '<button type="button" class="sel-btn" aria-haspopup="listbox" aria-expanded="false">' +
      '<span class="sel-label"></span>' + CARET + '</button>' +
      '<div class="sel-pop" role="listbox" hidden></div>');

    var btn = wrap.querySelector('.sel-btn');
    var pop = wrap.querySelector('.sel-pop');
    var label = wrap.querySelector('.sel-label');
    var isOpen = false, hi = 0, closeTimer = null;

    function options() {
      return Array.prototype.slice.call(sel.options);
    }
    function labelOf() {
      var o = sel.options[sel.selectedIndex];
      return o ? o.textContent : '—';
    }
    function renderPop() {
      pop.innerHTML = options().map(function (o, i) {
        return '<div class="sel-opt' + (i === sel.selectedIndex ? ' on' : '') + '" role="option" data-i="' + i + '"' +
          ' aria-selected="' + (i === sel.selectedIndex) + '">' +
          '<span class="sel-opt-text">' + esc(o.textContent) + '</span>' +
          '<span class="sel-tick" aria-hidden="true">✓</span></div>';
      }).join('');
    }
    /* 外观同步：原生 select 的选中项变了就刷新按钮文案与高亮 */
    function sync() {
      label.textContent = labelOf();
      btn.title = labelOf();
      pop.querySelectorAll('.sel-opt').forEach(function (n, i) {
        var on = i === sel.selectedIndex;
        n.classList.toggle('on', on);
        n.setAttribute('aria-selected', String(on));
      });
    }
    function markHi(i) {
      var nodes = pop.querySelectorAll('.sel-opt');
      if (!nodes.length) return;
      hi = Math.max(0, Math.min(nodes.length - 1, i));
      nodes.forEach(function (n, k) { n.classList.toggle('hi', k === hi); });
      if (nodes[hi].scrollIntoView) nodes[hi].scrollIntoView({ block: 'nearest' });
    }
    function open() {
      if (isOpen) return;
      clearTimeout(closeTimer);
      closeAll(inst);
      isOpen = true;
      renderPop();                                  /* 每次展开重建选项，动态增删分组也能跟上 */
      pop.hidden = false;
      pop.classList.remove('closing');
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      markHi(sel.selectedIndex < 0 ? 0 : sel.selectedIndex);
    }
    function close(focusBtn) {
      if (!isOpen) return;
      isOpen = false;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      pop.classList.add('closing');                  /* 先播退场动画再真正隐藏 */
      closeTimer = setTimeout(function () {
        pop.hidden = true;
        pop.classList.remove('closing');
      }, 140);
      if (focusBtn) btn.focus();
    }
    function pick(i) {
      var o = sel.options[i];
      if (!o) return;
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('change', { bubbles: true }));   /* 既有 handler 照常触发 */
      }
      sync();
      close(true);
    }
    var inst = { close: function (f) { close(f); }, el: sel, _isOpen: function () { return isOpen; } };
    instances.push(inst);
    sel.__appSelect = inst;

    /* 改写实例上的 value 访问器：程序改值时外观跟着变（调用点无需改动） */
    if (valueDesc && valueDesc.get && valueDesc.set) {
      Object.defineProperty(sel, 'value', {
        configurable: true,
        get: function () { return valueDesc.get.call(sel); },
        set: function (v) { valueDesc.set.call(sel, v); sync(); }
      });
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (isOpen) close(false); else open();
    });
    btn.addEventListener('keydown', function (e) {
      var k = e.key;
      /* 方向键/回车/空格由下拉自己消费，stopPropagation 防止同时被页面的列表导航接走 */
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) { open(); return; }
        if (k === 'Enter' || k === ' ') { pick(hi); return; }
        markHi(hi + (k === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (k === 'Home' || k === 'End') {
        e.preventDefault();
        e.stopPropagation();
        markHi(k === 'Home' ? 0 : options().length - 1);
        return;
      }
      if (k === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); close(true); }
      if (k === 'Tab' && isOpen) close(false);
    });
    pop.addEventListener('mousemove', function (e) {
      var n = e.target.closest('.sel-opt');
      if (n) markHi(parseInt(n.getAttribute('data-i'), 10));
    });
    pop.addEventListener('click', function (e) {
      var n = e.target.closest('.sel-opt');
      if (n) pick(parseInt(n.getAttribute('data-i'), 10));
    });
    /* 失焦（点别处）时收起；用 setTimeout 让点击先落到目标上 */
    btn.addEventListener('blur', function () { setTimeout(function () { if (isOpen && !wrap.contains(document.activeElement)) close(false); }, 0); });
    sel.addEventListener('change', sync);

    sync();
    return inst;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 点空白处收起所有下拉（capture 阶段，先于业务点击） */
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('.sel')) closeAll(null);
  }, true);

  return {
    enhance: enhance,
    enhanceAll: function (root) {
      Array.prototype.slice.call((root || document).querySelectorAll('select.mini-select'))
        .forEach(function (s) { enhance(s); });
    },
    closeAll: closeAll,
    /* 有没有展开中的下拉？有就收起并返回 true（Escape 时优先收下拉，别顺手取消了编辑） */
    closeAny: function () {
      var open = instances.filter(function (s) { return s._isOpen(); });
      open.forEach(function (s) { s.close(true); });
      return open.length > 0;
    },
    _instances: instances
  };
})();

if (typeof globalThis !== 'undefined') globalThis.AppSelect = AppSelect;
