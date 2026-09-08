/* tools-gen.js — 生成工具组：UUID/随机串/二维码/识码/条形码 + 单位换算 */
(function () {
  'use strict';

  /* ---------- UUID 生成 ---------- */
  App.tool({
    id: 'uuidgen', name: 'UUID 生成', group: 'gen', alias: 'uuid guid v4 生成 唯一id',
    desc: 'UUID v4 批量生成，可控制大小写、连字符、花括号',
    icon: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7.5 9.5v5M10.5 9.5v5M9 9.5 10.5 14.5M13.5 9.5v5h2M13.5 12h1.8',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '点击「生成」得到 UUID 列表…',
        rows: 7,
        options: [
          { kind: 'input', id: 'ugCount', label: '数量', ph: '1-1000', value: '5' },
          {
            kind: 'select', id: 'ugCase', label: '大小写', value: 'lower', options: [
              { v: 'lower', t: '小写' }, { v: 'upper', t: '大写' }
            ]
          },
          { kind: 'check', id: 'ugNodash', label: '去掉连字符', value: false },
          { kind: 'check', id: 'ugBrace', label: '花括号包裹', value: false }
        ],
        live: function (text, v, out) {
          var n = Math.min(1000, Math.max(1, parseInt(v.ugCount, 10) || 1));
          var list = Codec.uuidBatch(n, {
            lower: v.ugCase === 'lower', upper: v.ugCase === 'upper',
            nodash: v.ugNodash, braces: v.ugBrace
          });
          out.set(list.join('\n'));
        }
      });
      host.appendChild(UI.hint('UUID v4 由密码学安全随机源生成，可批量、控制大小写/连字符/花括号。'));
    }
  });

  /* ---------- 随机字符串 / 密码 ---------- */
  App.tool({
    id: 'randstr', name: '随机字符串', group: 'gen', alias: '随机密码 密码生成 随机串 salt token',
    desc: '密码级随机串：长度、数量、字符集、排除易混淆字符',
    icon: 'M6 11a2.5 2.5 0 1 0 .01 0zM17 11a2.5 2.5 0 1 0 .01 0zM6 13.5V15a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-1.5M12 3v3M9.5 5l5 0',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '点击生成，或修改参数实时刷新…',
        rows: 7,
        options: [
          { kind: 'input', id: 'rsLen', label: '长度', ph: '1-1024', value: '16' },
          { kind: 'input', id: 'rsCount', label: '数量', ph: '1-1000', value: '5' },
          { kind: 'check', id: 'rsLower', label: '小写', value: true },
          { kind: 'check', id: 'rsUpper', label: '大写', value: true },
          { kind: 'check', id: 'rsDigit', label: '数字', value: true },
          { kind: 'check', id: 'rsSpec', label: '特殊符号', value: false },
          { kind: 'check', id: 'rsNoAmb', label: '排除 il1Lo0O 等易混淆', value: false },
          { kind: 'input', id: 'rsCustom', label: '附加自定义字符', ph: '如 -_' }
        ],
        live: function (text, v, out) {
          out.set(Codec.randomStrings({
            length: parseInt(v.rsLen, 10) || 16,
            count: parseInt(v.rsCount, 10) || 1,
            lower: v.rsLower, upper: v.rsUpper, digit: v.rsDigit, special: v.rsSpec,
            custom: v.rsCustom, noAmbig: v.rsNoAmb
          }).join('\n'));
        }
      });
      host.appendChild(UI.hint('随机源为 crypto.getRandomValues，适合做密码、salt、token；至少选择一种字符集。'));
    }
  });

  /* ---------- ULID 生成 ---------- */
  App.tool({
    id: 'ulidgen', name: 'ULID 生成', group: 'gen', alias: 'ulid 有序id 排序id 生成 唯一id 雪花',
    desc: '48 位毫秒时间戳 + 80 位随机数，字典序即时间序，支持同毫秒单调递增',
    icon: 'M7 3h10M12 3v4M5 7h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM8 12h3M8 16h6M14 12h2',
    render: function (host) {
      var tsBox;
      UI.ioTool(host, {
        placeholder: '实时生成 ULID（26 位 Crockford Base32）…',
        rows: 7,
        options: [
          { kind: 'input', id: 'ulCount', label: '数量', ph: '1-1000', value: '5' },
          {
            kind: 'select', id: 'ulCase', label: '大小写', value: 'upper', options: [
              { v: 'upper', t: '大写（规范形式）' }, { v: 'lower', t: '小写' }
            ]
          },
          { kind: 'check', id: 'ulMono', label: '同毫秒单调递增（保证批内有序）', value: false }
        ],
        live: function (text, v, out) {
          var n = Math.min(1000, Math.max(1, parseInt(v.ulCount, 10) || 1));
          var list = Codec.ulidBatch(n, { mono: v.ulMono, lower: v.ulCase === 'lower' });
          out.set(list.join('\n'));
          if (tsBox) {
            tsBox.innerHTML = '';
            try {
              var t = Codec.ulidDecodeTime(list[0]);
              var ms = ('00' + (t % 1000)).slice(-3);
              tsBox.appendChild(UI.kvList([
                ['首条时间戳', t + ' ms'],
                ['对应时间', new Date(t).toLocaleString('zh-CN', { hour12: false }) + '.' + ms]
              ]));
            } catch (e) { }
          }
        },
        foot: function () { tsBox = UI.el('div', {}); return tsBox; }
      });
      host.appendChild(UI.hint('ULID = 48 位毫秒时间戳 + 80 位随机数，Crockford Base32 编码（不含 I/L/O/U），26 位定长、按字典序排序即按时间排序；勾选单调递增后，同一毫秒内随机位自动 +1，适合做数据库主键。'));
    }
  });

  /* ---------- 二维码生成 ---------- */
  App.tool({
    id: 'qrcode', name: '二维码生成', group: 'gen', alias: '二维码 qrcode qr 生成',
    desc: '文本/网址转二维码，四档容错，SVG 输出',
    icon: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5M19 14h1M14 19h1M18 17.5h2M11 4v3M11 13v7M13 8h2M20 8v2',
    render: function (host) {
      var card = UI.el('div', { class: 'card' });
      var bar = UI.el('div', { class: 'optsbar' });
      var ecSel = UI.select('qrEc', [
        { v: 'M', t: '容错 M（常用，15%）' }, { v: 'L', t: 'L（7%）' },
        { v: 'Q', t: 'Q（25%）' }, { v: 'H', t: 'H（30%，可遮挡）' }
      ], 'M');
      var ecWrap = UI.el('label', { class: 'opt' });
      ecWrap.appendChild(UI.el('span', { class: 'opt-l', text: '容错级别' }));
      ecWrap.appendChild(ecSel);
      bar.appendChild(ecWrap);
      card.appendChild(bar);
      var txt = UI.ta('qrText', '输入内容，如 https://example.com …', 3);
      card.appendChild(txt);
      var qrimg = UI.el('div', { class: 'qrimg' });
      var qrErr = UI.el('div', { class: 'hint' });
      card.appendChild(qrErr);
      var box = UI.el('div', { class: 'qrbox' });
      box.appendChild(qrimg);
      card.appendChild(box);
      host.appendChild(card);

      function gen() {
        qrErr.textContent = '';
        var v = txt.value;
        if (!v.trim()) { qrimg.innerHTML = ''; return; }
        if (!window.qrcode) { qrErr.textContent = 'qrcode 库未加载（assets/vendor/qrcode.js）'; return; }
        try {
          var qr = window.qrcode(0, ecSel.value);
          qr.addData(v);
          qr.make();
          qrimg.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        } catch (e) {
          qrimg.innerHTML = '';
          qrErr.textContent = '生成失败：' + (e.message || e) + '（内容过长时请减少字符）';
        }
      }
      txt.addEventListener('input', gen);
      ecSel.addEventListener('change', gen);
      host.appendChild(UI.hint('右侧白底区即二维码，右键或截图即可使用；typeNumber 自动按内容长度选择。'));
    }
  });

  /* ---------- 二维码识别 ---------- */
  App.tool({
    id: 'qrscan', name: '二维码识别', group: 'gen', alias: '二维码解码 识码 qrscan 扫码 识别图片',
    desc: '从图片识别二维码内容（本地解码，不上传）',
    icon: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 7h.01M17 7h.01M7 12h4v5H7zM14 12h3M14 15h3M14 17.5h3',
    render: function (host) {
      var card = UI.el('div', { class: 'card' });
      var drop = UI.el('div', { class: 'drop', text: '点击选择图片，或把图片拖到这里（PNG / JPG，纯本地识别）' });
      card.appendChild(drop);
      var resBox = UI.el('div', {});
      card.appendChild(resBox);
      host.appendChild(card);

      function decodeBlob(blob) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          var d = ctx.getImageData(0, 0, c.width, c.height);
          var r = window.jsQR ? jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' }) : null;
          resBox.innerHTML = '';
          if (r && r.data) {
            resBox.appendChild(UI.kvList([
              ['识别结果', r.data],
              ['图片尺寸', d.width + ' x ' + d.height]
            ]));
            var row = UI.el('div', { class: 'btnrow' });
            row.appendChild(UI.btn('复制内容', function () { UI.copy(r.data); }, { primary: true }));
            resBox.appendChild(row);
            UI.toast('识别成功');
          } else {
            UI.toast('未识别到二维码，请换更清晰的图片', true);
          }
        };
        img.onerror = function () { URL.revokeObjectURL(url); UI.toast('图片加载失败', true); };
        img.src = url;
      }
      function pick() { UI.filePick('image/*', false, function (name, bytes) { decodeBlob(new Blob([bytes])); }); }
      drop.addEventListener('click', pick);
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); drop.classList.remove('over');
        var f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) decodeBlob(f);
      });
      host.appendChild(UI.hint('基于 jsQR 本地解码，图片不会离开本机；建议截取二维码周边留白，避免强反光。'));
    }
  });

  /* ---------- 条形码生成 ---------- */
  App.tool({
    id: 'barcode', name: '条形码生成', group: 'gen', alias: '条形码 barcode ean13 code128 upc',
    desc: 'CODE128 / EAN-13 / UPC / CODE39 等格式条形码',
    icon: 'M4 5v14M7 5v14M10 5v10M13 5v14M16 5v14M19 5v10M4 19h15',
    render: function (host) {
      var card = UI.el('div', { class: 'card' });
      var bar = UI.el('div', { class: 'optsbar' });
      var fmtSel = UI.select('bcFmt', [
        { v: 'CODE128', t: 'CODE128（任意 ASCII）' }, { v: 'EAN13', t: 'EAN-13（12/13 位数字）' },
        { v: 'EAN8', t: 'EAN-8（7/8 位数字）' }, { v: 'UPC', t: 'UPC-A（11/12 位数字）' },
        { v: 'CODE39', t: 'CODE39（A-Z 0-9 空格 -.$/+%）' }, { v: 'ITF14', t: 'ITF-14（13/14 位数字）' },
        { v: 'codabar', t: 'Codabar（数字与 -$:/.+）' }, { v: 'MSI', t: 'MSI（纯数字）' },
        { v: 'pharmacode', t: 'Pharmacode（3-131070）' }
      ], 'CODE128');
      var fw = UI.el('label', { class: 'opt' });
      fw.appendChild(UI.el('span', { class: 'opt-l', text: '格式' }));
      fw.appendChild(fmtSel);
      bar.appendChild(fw);
      card.appendChild(bar);
      var txt = UI.input('bcText', '输入条码内容…');
      card.appendChild(UI.field('内容', txt));
      var bErr = UI.el('div', { class: 'hint' });
      var svgBox = UI.el('div', { class: 'qrimg' });
      svgBox.style.width = '300px';
      svgBox.style.height = '140px';
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgBox.appendChild(svg);
      var box = UI.el('div', { class: 'qrbox' });
      box.appendChild(svgBox);
      card.appendChild(bErr);
      card.appendChild(box);
      host.appendChild(card);

      function gen() {
        bErr.textContent = '';
        var v = txt.value;
        if (!v.trim()) { svg.innerHTML = ''; return; }
        if (!window.JsBarcode) { bErr.textContent = 'JsBarcode 库未加载（assets/vendor/jsbarcode.js）'; return; }
        try {
          window.JsBarcode(svg, v, {
            format: fmtSel.value, width: 2, height: 90, displayValue: true,
            fontSize: 14, margin: 6, background: '#ffffff', lineColor: '#000000'
          });
        } catch (e) {
          svg.innerHTML = '';
          bErr.textContent = '生成失败：' + (e.message || e) + '（请检查内容是否符合所选格式的字符/位数要求）';
        }
      }
      txt.addEventListener('input', gen);
      fmtSel.addEventListener('change', gen);
      host.appendChild(UI.hint('EAN-13 缺少校验位时自动补算；扫描枪读取建议保持白底黑条。'));
    }
  });

  /* ---------- 单位换算 ---------- */
  App.tool({
    id: 'unitconv', name: '单位换算', group: 'units', alias: '单位换算 换算 长度 重量 温度 数据存储',
    desc: '长度/面积/体积/质量/温度/压力/功率/能量/数据存储等 14 类',
    icon: 'M4 20 15 9M4 20h7M4 20v-7M13 5h6M13 8h6M16 3v7M5 6l1.5 2.5M8 5 6.5 7.5 4 7l2-3z',
    render: function (host) {
      var card = UI.el('div', { class: 'card' });
      var cats = Units.CATEGORIES;
      var catSel = UI.select('ucCat', Object.keys(cats).map(function (k) { return { v: k, t: cats[k].name }; }), 'length');
      var fromSel = UI.select('ucFrom', [], '米');
      var toSel = UI.select('ucTo', [], '千米');
      var valIn = UI.input('ucVal', '数值', '1');
      var grid = UI.el('div', { class: 'unit-grid' });
      grid.appendChild(UI.field('类别', catSel));
      grid.appendChild(UI.field('从', fromSel));
      grid.appendChild(UI.field('到', toSel));
      grid.appendChild(UI.field('数值', valIn));
      card.appendChild(grid);
      var res = UI.el('div', {});
      card.appendChild(res);
      var hintEl = UI.el('div', { class: 'hint' });
      card.appendChild(hintEl);
      host.appendChild(card);

      function fillUnits(cat, keep) {
        var units = Object.keys(cats[cat].units);
        fromSel.innerHTML = '';
        toSel.innerHTML = '';
        for (var u of units) {
          var o1 = UI.el('option', { text: u }); o1.value = u;
          var o2 = UI.el('option', { text: u }); o2.value = u;
          fromSel.appendChild(o1);
          toSel.appendChild(o2);
        }
        var cur = Object.keys(cats[cat].units);
        if (keep && cur.indexOf(keep) >= 0) { fromSel.value = keep; }
        else { fromSel.value = cats[cat].base; }
        if (cur.indexOf(cats[cat].base) >= 0 && fromSel.value === cats[cat].base) toSel.value = cur.find(function (u) { return u !== fromSel.value; }) || cur[0];
        else toSel.value = cur[0];
        if (fromSel.value === toSel.value) toSel.value = cur.find(function (u) { return u !== fromSel.value; }) || cur[0];
      }
      function calc() {
        res.innerHTML = '';
        hintEl.textContent = '';
        try {
          var r = Units.convert(catSel.value, valIn.value, fromSel.value, toSel.value);
          var inv = Units.convert(catSel.value, 1, toSel.value, fromSel.value);
          res.appendChild(UI.kvList([
            [valIn.value + ' ' + fromSel.value + ' =', Units.fmtNum(r) + ' ' + toSel.value],
            ['1 ' + toSel.value + ' =', Units.fmtNum(inv) + ' ' + fromSel.value]
          ]));
          hintEl.textContent = '点击数值可复制。';
        } catch (e) {
          hintEl.textContent = e.message;
          hintEl.style.color = 'var(--err)';
        }
      }
      function onCat() { fillUnits(catSel.value); calc(); }
      catSel.addEventListener('change', onCat);
      fromSel.addEventListener('change', calc);
      toSel.addEventListener('change', calc);
      valIn.addEventListener('input', calc);
      fillUnits('length');
      calc();
      host.appendChild(UI.hint('温度为公式换算（摄氏/华氏/开尔文/兰氏）；数据存储同时提供十进制（KB=1000B）与二进制（KiB=1024B）。'));
    }
  });
})();