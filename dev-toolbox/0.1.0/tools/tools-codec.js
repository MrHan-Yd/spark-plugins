/* tools-codec.js — 编解码组：Base64/URL/Unicode/ASCII/Hex/String/Hex-Base64/HTML实体/进制/原反补码/JWT */
(function () {
  'use strict';

  /* ---------- Base64 ---------- */
  App.tool({
    id: 'base64', name: 'Base64', group: 'codec', alias: 'base64编码 base64解码 b64',
    desc: '文本与 Base64 互转，支持 URL 安全变体与文件',
    icon: 'M6 8h12v8H6zM9 8V6a3 3 0 0 1 6 0v2M3 20h18',
    render: function (host) {
      var t = UI.ioTool(host, {
        placeholder: '输入要编码的文本，或粘贴 Base64 解码…',
        rows: 10,
        swap: true,
        options: [
          { kind: 'check', id: 'b64url', label: 'URL 安全(-_)', value: false }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var isB64 = /^[A-Za-z0-9+/\-_=\s]+$/.test(text.trim()) && !/[^\x00-\x7f]/.test(text);
          var b64 = Codec.textToB64(text, v.b64url);
          var dec = null;
          try { dec = Codec.b64ToText(text); } catch (e) { }
          if (dec !== null && isB64) out.set('编码 →\n' + b64 + '\n\n解码尝试 →\n' + dec);
          else out.set(b64);
        },
        foot: function () {
          var row = UI.el('div', { class: 'btnrow' });
          var b = UI.btn('选择文件编码', function () {
            UI.filePick('', false, function (name, bytes) {
              t.input.value = '(文件 ' + name + '，' + bytes.length + ' 字节)';
              t.out.set(Codec.bytesToB64(bytes, document.getElementById('b64url').checked));
              UI.toast('已编码 ' + name);
            });
          });
          row.appendChild(b);
          return row;
        }
      });
      var h = UI.el('div', { class: 'hint', text: '输入自动判断方向：纯 ASCII Base64 字符集会同时给出编码与解码结果。' });
      host.appendChild(h);
    }
  });

  /* ---------- URL 编解码 ---------- */
  App.tool({
    id: 'urlcode', name: 'URL 编解码', group: 'codec', alias: 'url编码 url解码 转义',
    desc: 'Component / URI / 表单（+ 为空格）三种模式',
    icon: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
    render: function (host) {
      var t = UI.ioTool(host, {
        placeholder: '输入文本编码，或粘贴 URL 编码解码…',
        rows: 8,
        swap: true,
        options: [
          {
            kind: 'select', id: 'urlmode', label: '模式', value: 'component', options: [
              { v: 'component', t: 'Component（encodeURIComponent）' },
              { v: 'uri', t: 'URI（encodeURI，保留结构符）' },
              { v: 'form', t: 'Form（空格转 +）' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          var s = text.trim();
          if (/%[0-9a-fA-F]{2}/.test(s)) out.set(Codec.urlDecode(s, v.urlmode));
          else out.set(Codec.urlEncode(s, v.urlmode));
        }
      });
      UI.ioTool; // noop
      var h = UI.el('div', { class: 'hint', text: '含 %XX 编码时自动解码，否则编码；解码失败会给出原因。' });
      host.appendChild(h);
    }
  });

  /* ---------- Unicode ---------- */
  App.tool({
    id: 'unicode', name: 'Unicode 转换', group: 'codec', alias: 'unicode转中文 中文转unicode emoji html实体 css实体',
    desc: '\\uXXXX / \\u{…} / HTML 实体 / CSS 实体双向转换',
    icon: 'M4 7V5h16v2M9 20h6M12 7v13',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入中文/emoji/实体转义，或粘贴 \\uXXXX 解码…',
        rows: 8,
        swap: true,
        options: [
          {
            kind: 'select', id: 'umode', label: '形式', value: 'u', options: [
              { v: 'u', t: '\\uXXXX' },
              { v: 'brace', t: '\\u{XXXXX}' },
              { v: 'dec', t: 'HTML 实体 &#x;' },
              { v: 'hex', t: 'HTML 实体 &#XX;' },
              { v: 'named', t: 'HTML 实体命名' },
              { v: 'css', t: 'CSS \\XXXX ' }
            ]
          },
          { kind: 'check', id: 'uall', label: '含 ASCII', value: false },
          { kind: 'check', id: 'uupper', label: '大写十六进制', value: false }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          var hasEsc = /\\u[0-9a-fA-F]{4}|\\u\{|&#x?[0-9a-fA-F]+;|&#\d+;|&[a-zA-Z][a-zA-Z0-9]{1,31};|\\[0-9a-fA-F]{1,6}/.test(text);
          if (hasEsc) { out.set(Codec.fromUnicode(text)); return; }
          var opt = { all: v.uall, upper: v.uupper };
          if (v.umode === 'brace') opt.braces = true;
          else if (v.umode === 'dec') opt.html = true;
          else if (v.umode === 'hex') opt.html = 'hex';
          else if (v.umode === 'named') opt.html = 'named';
          else if (v.umode === 'css') opt.css = true;
          out.set(Codec.toUnicode(text, opt));
        }
      });
      var h = UI.el('div', { class: 'hint', text: '自动判向：包含转义序列（\\u4f60、&#x…;、\\4f2d 等）就解码，否则按所选形式编码。emoji 以代理对/码点正确处理。' });
      host.appendChild(h);
    }
  });

  /* ---------- ASCII / 编码点 ---------- */
  App.tool({
    id: 'ascii', name: 'ASCII 转换', group: 'codec', alias: 'ascii编码 十进制 十六进制 八进制 二进制',
    desc: '文本 ↔ 编码点列表（10/16/8/2 进制，分隔符可选）',
    icon: 'M4 6h16M4 12h10M4 18h13',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入文本得到编码列表，或粘贴数字列表还原…',
        rows: 8,
        swap: true,
        options: [
          {
            kind: 'select', id: 'ardx', label: '进制', value: '10', options: [
              { v: '10', t: '十进制' }, { v: '16', t: '十六进制' }, { v: '8', t: '八进制' }, { v: '2', t: '二进制' }
            ]
          },
          {
            kind: 'select', id: 'asep', label: '分隔符', value: ' ', options: [
              { v: ' ', t: '空格' }, { v: ',', t: '逗号' }, { v: '', t: '无' }
            ]
          },
          {
            kind: 'select', id: 'adir', label: '方向', value: 'auto', options: [
              { v: 'auto', t: '自动判向' }, { v: 'enc', t: '文本→码点' }, { v: 'dec', t: '码点→文本' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          var radix = +v.ardx, sep = v.asep === '' ? '' : v.asep;
          if (v.adir === 'dec') { out.set(Codec.fromRadixList(text, radix)); return; }
          if (v.adir === 'enc') { out.set(Codec.toRadixList(text, radix, sep)); return; }
          if (/^[\s\d,;a-fA-Fx]+$/.test(text) && text.trim().match(/^[\d,;\s]+$/) || (radix === 16 && /^[0-9a-fA-F\s,]+$/.test(text))) {
            try { out.set(Codec.fromRadixList(text, radix)); return; } catch (e) { }
          }
          out.set(Codec.toRadixList(text, radix, sep));
        }
      });
    }
  });

  /* ---------- Hex/String ---------- */
  App.tool({
    id: 'hexstr', name: 'Hex/String', group: 'codec', alias: 'hex to string 十六进制转字符串 字符串转十六进制',
    desc: 'UTF-8 字节与十六进制互转',
    icon: 'M7 8l-4 4 4 4M17 8l4 4-4 4M13 5l-2 14',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '文本 → hex；粘贴 hex（可含空格/冒号/0x）→ 文本',
        rows: 8,
        swap: true,
        options: [
          { kind: 'check', id: 'hxsSpace', label: 'hex 加空格', value: false },
          { kind: 'check', id: 'hxsUpper', label: 'hex 大写', value: false },
          {
            kind: 'select', id: 'hxsDir', label: '方向', value: 'auto', options: [
              { v: 'auto', t: '自动判向' }, { v: 'enc', t: '强制编码' }, { v: 'dec', t: '强制解码' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          function enc() {
            var h = Codec.bytesToHex(Codec.utf8ToBytes(text), v.hxsSpace ? ' ' : '');
            return v.hxsUpper ? h.toUpperCase() : h;
          }
          function dec() { return Codec.bytesToUtf8(Codec.hexToBytes(text)); }
          if (v.hxsDir === 'dec') { out.set(dec()); return; }
          if (v.hxsDir === 'enc') { out.set(enc()); return; }
          // 自动：形如 hex 才尝试解码；beef/face 这类纯 a-f 单词可强制编码绕开歧义
          if (/^[0-9a-fA-F\s,:xX]+$/.test(text) && /[0-9a-fA-F]/.test(text)) {
            try { out.set(dec()); return; } catch (e) { }
          }
          out.set(enc());
        }
      });
    }
  });

  /* ---------- Hex/Base64 ---------- */
  App.tool({
    id: 'hexb64', name: 'Hex/Base64', group: 'codec', alias: 'hex to base64 base64 to hex',
    desc: '十六进制与 Base64 经字节中转互转',
    icon: 'M5 7h14M5 12h14M5 17h9',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '粘贴 hex 得 Base64；粘贴 Base64 得 hex',
        rows: 8,
        swap: true,
        options: [
          {
            kind: 'select', id: 'hxbDir', label: '方向', value: 'auto', options: [
              { v: 'auto', t: '自动判向' }, { v: 'enc', t: '按 Hex 编码' }, { v: 'dec', t: '按 Base64 解码' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var t = text.trim();
          function enc() { return Codec.bytesToB64(Codec.hexToBytes(t)); }
          function dec() { return Codec.bytesToHex(Codec.b64ToBytes(t)); }
          if (v.hxbDir === 'dec') { out.set(dec()); return; }
          if (v.hxbDir === 'enc') { out.set(enc()); return; }
          if (/^[0-9a-fA-F\s,:xX]+$/.test(t) && /[0-9a-fA-F]/.test(t) && !/[^0-9a-fA-F\s,:xX]/.test(t)) {
            try { out.set(enc()); return; } catch (e) { }
          }
          try { out.set(dec()); }
          catch (e) { throw new Error('无法识别输入：既不是合法 hex 也不是 Base64'); }
        }
      });
    }
  });

  /* ---------- HTML 实体 ---------- */
  App.tool({
    id: 'htmlent', name: 'HTML 编码', group: 'codec', alias: 'html编码 html转义 html entity',
    desc: '&lt; &amp; 等特殊字符转义与还原',
    icon: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '<div class="a">…</div> → 实体；含 &#x…;/&amp; 时自动还原',
        rows: 8,
        swap: true,
        options: [
          { kind: 'check', id: 'hmq', label: '转义引号', value: true },
          { kind: 'check', id: 'hma', label: '转义全部非 ASCII', value: false }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          if (/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/.test(text)) {
            out.set(Codec.htmlDecode(text));
            return;
          }
          out.set(Codec.htmlEncode(text, { quotes: v.hmq, all: v.hma }));
        }
      });
    }
  });

  /* ---------- 进制转换 ---------- */
  App.tool({
    id: 'radix', name: '进制转换', group: 'codec', alias: '进制 二进制 八进制 十六进制 36进制 64进制',
    desc: '2-64 任意进制互转（BigInt 精确大数）',
    icon: 'M7 4h10M7 12h10M7 20h6M12 4v16',
    render: function (host) {
      var box = UI.el('div', {});
      host.appendChild(box);
      var inV = UI.input('rdIn', '输入数值…');
      var selFrom = UI.select('rdFrom', radixOptions(), '10');
      var selTo = UI.select('rdTo', radixOptions(), '16');
      var out = UI.input('rdOut', '');
      out.readOnly = true;
      var copyB = UI.btn('复制', function () { if (out.value) UI.copy(out.value); });
      var err = UI.el('div', { class: 'errbox' });
      err.style.display = 'none';
      function conv() {
        try {
          UI.errShow(err, null);
          out.value = Codec.radixConvert(inV.value || '0', +selFrom.value, +selTo.value);
        } catch (e) { UI.errShow(err, e.message); out.value = ''; }
      }
      var row = UI.el('div', { class: 'unit-grid' });
      row.appendChild(UI.field('输入', inV));
      row.appendChild(UI.field('输入进制', selFrom));
      row.appendChild(UI.field('输出进制', selTo));
      var card = UI.el('div', { class: 'card' });
      card.appendChild(row);
      card.appendChild(UI.field('输出', out));
      var act = UI.el('div', { class: 'btnrow' });
      act.appendChild(UI.btn('交换进制', function () { var t = selFrom.value; selFrom.value = selTo.value; selTo.value = t; conv(); }));
      act.appendChild(copyB);
      card.appendChild(act);
      card.appendChild(err);
      box.appendChild(card);
      var h = UI.el('div', { class: 'hint', html: '进制字符表：2-36 用 <code>0-9a-z</code>；37-64 用 <code>0-9a-zA-Z</code>，63 加 <code>+</code>、64 加 <code>/</code>。' });
      box.appendChild(h);
      inV.addEventListener('input', conv);
      selFrom.addEventListener('change', conv);
      selTo.addEventListener('change', conv);
      conv();
      function radixOptions() {
        var a = [];
        for (var b = 2; b <= 64; b++) {
          var t = b + ' 进制';
          if (b === 2) t = '二进制 (2)';
          else if (b === 8) t = '八进制 (8)';
          else if (b === 10) t = '十进制 (10)';
          else if (b === 16) t = '十六进制 (16)';
          else if (b === 36) t = '36 进制';
          else if (b === 64) t = '64 进制';
          a.push({ v: String(b), t: t });
        }
        return a;
      }
    }
  });

  /* ---------- 原码/反码/补码 ---------- */
  App.tool({
    id: 'bits', name: '原码/反码/补码', group: 'codec', alias: '原码 反码 补码 有符号',
    desc: '十进制整数的原码、反码、补码（8/16/32/64 位）',
    icon: 'M4 12h6M14 12h6M7 8h10M7 16h4',
    render: function (host) {
      var box = UI.el('div', {});
      host.appendChild(box);
      var inV = UI.input('btIn', '如 -1、255、0x10');
      var selW = UI.select('btW', [{ v: '8', t: '8 位' }, { v: '16', t: '16 位' }, { v: '32', t: '32 位' }, { v: '64', t: '64 位' }], '8');
      var err = UI.el('div', { class: 'errbox' });
      err.style.display = 'none';
      var out = UI.el('div', {});
      function parse() {
        var s = (inV.value || '').trim();
        if (!s) { UI.errShow(err, null); out.innerHTML = ''; return; }
        try {
          UI.errShow(err, null);
          var v = s;
          if (/^0x/i.test(s)) v = String(BigInt(s));
          var f = Codec.signedForms(v, +selW.value);
          out.innerHTML = '';
          out.appendChild(UI.kvList([
            ['十进制', v],
            ['二进制', f.original],
            ['原码', f.original],
            ['反码', f.ones],
            ['补码', f.twos],
            ['补码(HEX)', f.hex.twos.toUpperCase().padStart(selW.value / 4, '0')]
          ]));
        } catch (e) { UI.errShow(err, e.message); out.innerHTML = ''; }
      }
      var card = UI.el('div', { class: 'card' });
      var row = UI.el('div', { class: 'unit-grid' });
      row.appendChild(UI.field('整数', inV));
      row.appendChild(UI.field('位宽', selW));
      card.appendChild(row);
      card.appendChild(out);
      card.appendChild(err);
      host.appendChild(card);
      inV.addEventListener('input', parse);
      selW.addEventListener('change', parse);
      parse();
    }
  });

  /* ---------- JWT 解码 ---------- */
  App.tool({
    id: 'jwt', name: 'JWT 解码', group: 'codec', alias: 'jwt 解码 token',
    desc: '解出 header / payload / 签名与时间声明（不做验签）',
    icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-6-8-9V7z',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '粘贴 JWT（支持 Bearer 前缀）…',
        rows: 7,
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var j = Codec.jwtDecode(text);
          var lines = [
            '== HEADER ==\n' + JSON.stringify(j.header, null, 2),
            '',
            '== PAYLOAD ==\n' + JSON.stringify(j.payload, null, 2)
          ];
          if (j.signatureHex) lines.push('', '== SIGNATURE (hex) ==\n' + j.signatureHex);
          if (j.timeClaims.length) lines.push('', '== 时间声明 ==\n' + j.timeClaims.join('\n'));
          lines.push('', j.expired ? '⚠ 已过期' : '未过期（以 exp 为准，本工具不做签名验证）');
          out.set(lines.join('\n'));
        }
      });
    }
  });
})();