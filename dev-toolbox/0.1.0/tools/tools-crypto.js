/* tools-crypto.js — 加密哈希组：哈希/AES/DES/3DES/RC4/Rabbit/SM2/SM4/Bcrypt */
(function () {
  'use strict';

  function keyBytes(s, enc) {
    if (enc === 'hex') return Codec.hexToBytes(s);
    if (enc === 'base64') return Codec.b64ToBytes(s);
    if (enc === 'utf8') return Codec.utf8ToBytes(s);
    throw new Error('未知编码：' + enc);
  }
  function encSelect(id, label, v) {
    return {
      kind: 'select', id: id, label: label, value: v || 'utf8', options: [
        { v: 'utf8', t: 'UTF-8 文本' }, { v: 'hex', t: 'Hex' }, { v: 'base64', t: 'Base64' }
      ]
    };
  }

  /* ---------- 哈希 ---------- */
  App.tool({
    id: 'hash', name: '哈希计算', group: 'crypto', alias: 'md5 sha1 sha256 sha512 sm3 哈希 摘要 校验',
    desc: 'MD5 / SHA1 / SHA256 / SHA512 / SM3，支持批量行与文件',
    icon: 'M5 7h14v10H5zM8 7V5h8v2M8 12h8M8 15h5',
    render: function (host) {
      var t = UI.ioTool(host, {
        placeholder: '输入文本（多行可批量逐行计算）…',
        rows: 7,
        options: [
          {
            kind: 'select', id: 'halg', label: '算法', value: 'md5', options: [
              { v: 'md5', t: 'MD5' }, { v: 'sha1', t: 'SHA-1' }, { v: 'sha256', t: 'SHA-256' },
              { v: 'sha512', t: 'SHA-512' }, { v: 'sm3', t: 'SM3' }
            ]
          },
          { kind: 'check', id: 'hbatch', label: '逐行批量', value: false },
          { kind: 'check', id: 'hupper', label: '大写', value: false }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          function digestOf(bytes) {
            if (v.halg === 'sm3') {
              var hex = (window.SM && SM.sm3) ? SM.sm3(Codec.bytesToUtf8(bytes)) : null;
              if (hex === null) throw new Error('sm-crypto 未加载');
              return hex;
            }
            return Crypto.hash(v.halg, bytes);
          }
          var lines = text.split(/\r\n|\r|\n/).filter(function (l) { return l !== ''; });
          if (v.hbatch && lines.length > 1) {
            var res = lines.map(function (l) { return digestOf(Codec.utf8ToBytes(l)); });
            if (v.hupper) res = res.map(function (s) { return s.toUpperCase(); });
            out.set(lines.map(function (l, i) { return res[i] + '  ' + l; }).join('\n'));
          } else {
            var d = digestOf(Codec.utf8ToBytes(text));
            if (v.hupper) d = d.toUpperCase();
            out.set(d);
          }
        }
      });
      var row = UI.el('div', { class: 'btnrow' });
      row.appendChild(UI.btn('计算文件哈希', function () {
        UI.filePick('', false, function (name, bytes) {
          try {
            var d;
            var alg = document.getElementById('halg').value;
            if (alg === 'sm3') d = (window.SM && SM.sm3) ? SM.sm3(Codec.bytesToUtf8(bytes)) : null;
            else d = Crypto.hash(alg, bytes);
            var up = document.getElementById('hupper').checked;
            t.out.set((up ? d.toUpperCase() : d) + '  (' + name + ', ' + bytes.length + ' 字节)');
            UI.toast('已计算 ' + name);
          } catch (e) { UI.toast(e.message, true); }
        });
      }));
      host.appendChild(row);
      var h = UI.el('div', { class: 'hint', text: '逐行批量：每行输出「哈希 + 两空格 + 原文」，类似 md5sum 格式。' });
      host.appendChild(h);
    }
  });

  /* ---------- 对称加解密（AES/DES/3DES/RC4/Rabbit） ---------- */
  function cipherTool(def) {
    App.tool({
      id: def.id, name: def.name, group: 'crypto', alias: def.alias, desc: def.desc, icon: def.icon,
      render: function (host) {
        var card = UI.el('div', { class: 'card' });
        var o1 = UI.el('div', { class: 'optsbar' });
        function addOpt(ctrl, label) {
          var w = UI.el('label', { class: 'opt' });
          if (label) w.appendChild(UI.el('span', { class: 'opt-l', text: label }));
          w.appendChild(ctrl);
          o1.appendChild(w);
          return ctrl;
        }
        var selDir = addOpt(UI.select('cd' + def.id, [{ v: 'enc', t: '加密' }, { v: 'dec', t: '解密' }], 'enc'), '方向');
        var selMode = def.modes ? addOpt(UI.select('cm' + def.id, def.modes.map(function (m) { return { v: m, t: m }; }), 'CBC'), '模式') : null;
        var selKeyEnc = addOpt(UI.select('ck' + def.id, [{ v: 'utf8', t: '密钥:UTF-8' }, { v: 'hex', t: '密钥:Hex' }, { v: 'base64', t: '密钥:Base64' }]), '');
        var inKey = addOpt(UI.input('ci' + def.id, def.keyPh || '密钥'), '');
        var selIvEnc, inIv;
        if (def.iv) {
          selIvEnc = addOpt(UI.select('cv' + def.id, [{ v: 'utf8', t: 'IV:UTF-8' }, { v: 'hex', t: 'IV:Hex' }, { v: 'base64', t: 'IV:Base64' }]), '');
          inIv = addOpt(UI.input('cj' + def.id, def.ivPh || 'IV'), '');
        }
        var selPad = def.pads ? addOpt(UI.select('cp' + def.id, def.pads.map(function (p) { return { v: p[0], t: p[1] }; }), 'pkcs7'), '填充') : null;
        var selFmt = addOpt(UI.select('cf' + def.id, [{ v: 'base64', t: '输出:Base64' }, { v: 'hex', t: '输出:Hex' }]), '');
        card.appendChild(o1);
        host.appendChild(card);

        UI.ioTool(host, {
          placeholder: def.ph,
          rows: 9,
          swap: true,
          live: function (text, v, out) {
            if (!text.trim()) { out.set(''); return; }
            var key = keyBytes(inKey.value || '', selKeyEnc.value);
            var iv = def.iv ? keyBytes(inIv.value || '', selIvEnc.value) : null;
            var opt = { mode: selMode ? selMode.value : 'ECB', iv: iv, padding: selPadVal(), decrypt: selDir.value === 'dec' };
            var result;
            if (def.kind === 'block') {
              if (selDir.value === 'dec') {
                var data = selFmt.value === 'hex' ? Codec.hexToBytes(text.trim()) : Codec.b64ToBytes(text.trim());
                result = Codec.bytesToUtf8(Cipher.decrypt(def.alg, data, key, opt));
              } else {
                var data2 = Codec.utf8ToBytes(text);
                var ct = Cipher.encrypt(def.alg, data2, key, opt);
                result = selFmt.value === 'hex' ? Codec.bytesToHex(ct) : Codec.bytesToB64(ct);
              }
            } else if (def.kind === 'rc4') {
              var data3 = selDir.value === 'dec'
                ? (selFmt.value === 'hex' ? Codec.hexToBytes(text.trim()) : Codec.b64ToBytes(text.trim()))
                : Codec.utf8ToBytes(text);
              var pt = Cipher.rc4(key, data3);
              result = selDir.value === 'dec' ? Codec.bytesToUtf8(pt)
                : (selFmt.value === 'hex' ? Codec.bytesToHex(pt) : Codec.bytesToB64(pt));
            } else if (def.kind === 'rabbit') {
              if (selDir.value === 'dec') {
                var data4 = selFmt.value === 'hex' ? Codec.hexToBytes(text.trim()) : Codec.b64ToBytes(text.trim());
                result = Codec.bytesToUtf8(Cipher.rabbit(key, iv, data4));
              } else {
                var ct2 = Cipher.rabbit(key, iv, Codec.utf8ToBytes(text));
                result = selFmt.value === 'hex' ? Codec.bytesToHex(ct2) : Codec.bytesToB64(ct2);
              }
            }
            out.set(result);
          }
        });
        function selPadVal() { return selPad ? selPad.value : 'pkcs7'; }
        if (def.hint) host.appendChild(UI.hint(def.hint));
      }
    });
  }

  cipherTool({
    id: 'aes', name: 'AES 加解密', kind: 'block', alg: 'aes', iv: true, modes: ['ECB', 'CBC', 'CTR', 'CFB', 'OFB'],
    pads: [['pkcs7', 'PKCS7'], ['zero', 'Zero'], ['iso7816', 'ISO7816'], ['none', '无']],
    alias: 'aes加密 aes解密 aes', icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-6-8-9V7z',
    desc: 'AES-128/192/256，五种模式、四种填充、密钥/IV 三种编码',
    ph: '明文（加密）或 Base64/Hex 密文（解密）…',
    keyPh: '16/24/32 字节', ivPh: '16 字节',
    hint: '密钥长度决定 AES-128/192/256；密文输入格式跟随「输出」选择（解密时为输入格式）。'
  });
  cipherTool({
    id: 'des', name: 'DES 加解密', kind: 'block', alg: 'des', iv: true, modes: ['ECB', 'CBC', 'CTR', 'CFB', 'OFB'],
    pads: [['pkcs7', 'PKCS7'], ['zero', 'Zero'], ['iso7816', 'ISO7816'], ['none', '无']],
    alias: 'des加密 des解密 des', icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-6-8-9V7zM12 8v5',
    desc: 'DES（8 字节密钥），五种模式',
    ph: '明文（加密）或 Base64/Hex 密文（解密）…',
    keyPh: '8 字节', ivPh: '8 字节'
  });
  cipherTool({
    id: 'tripledes', name: 'TripleDES', kind: 'block', alg: 'tripledes', iv: true, modes: ['ECB', 'CBC', 'CTR', 'CFB', 'OFB'],
    pads: [['pkcs7', 'PKCS7'], ['zero', 'Zero'], ['iso7816', 'ISO7816'], ['none', '无']],
    alias: '3des tripledes des3', icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-6-8-9V7zM9 12h6M9 15h6',
    desc: '3DES（16/24 字节密钥），五种模式',
    ph: '明文（加密）或 Base64/Hex 密文（解密）…',
    keyPh: '16/24 字节', ivPh: '8 字节'
  });
  cipherTool({
    id: 'rc4', name: 'RC4', kind: 'rc4', iv: false, modes: null,
    alias: 'rc4加密 rc4解密 rc4', icon: 'M5 12h4l2-6 2 12 2-8 1 3h3',
    desc: 'RC4 流加密，密文 Base64/Hex 输出',
    ph: '明文（加密）或 Base64/Hex 密文（解密）…',
    keyPh: '任意长度'
  });
  cipherTool({
    id: 'rabbit', name: 'Rabbit', kind: 'rabbit', iv: true, modes: null,
    pads: [['pkcs7', 'PKCS7'], ['zero', 'Zero'], ['iso7816', 'ISO7816'], ['none', '无']],
    alias: 'rabbit 加密', icon: 'M4 17c2-6 5-9 8-9s6 3 8 9M8 8V5M16 8V5',
    desc: 'Rabbit 流加密（16 字节密钥 + 可选 8 字节 IV）',
    ph: '明文（加密）或 Base64/Hex 密文（解密）…',
    keyPh: '16 字节', ivPh: '8 字节（可空）'
  });

  /* ---------- 国密 SM2 / SM4 ---------- */
  App.tool({
    id: 'sm2', name: 'SM2 国密', group: 'crypto', alias: 'sm2 国密 加密 签名',
    desc: 'SM2 密钥对生成、加解密、签名验签（C1C3C2）',
    icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-6-8-9V7zM12 8l2.5 2.5L12 13l-2.5-2.5z',
    render: function (host) {
      var box = UI.el('div', {});
      host.appendChild(box);
      var kp = null;
      var kvBox = UI.el('div', {});
      var card = UI.el('div', { class: 'card' });
      var row = UI.el('div', { class: 'btnrow' });
      var genB = UI.btn('生成密钥对', function () {
        kp = window.SM.sm2.generateKeyPairHex();
        renderKp();
        UI.toast('已生成 SM2 密钥对');
      }, { primary: true });
      row.appendChild(genB);
      card.appendChild(row);
      var kvs = UI.el('div', {});
      card.appendChild(kvs);
      box.appendChild(card);

      var t = UI.ioTool(host, {
        placeholder: '输入明文加密，或粘贴 Hex 密文解密（密文模式 C1C3C2）…',
        rows: 8,
        swap: true,
        options: [
          { kind: 'select', id: 'sm2dir', label: '方向', value: 'enc', options: [{ v: 'enc', t: '加密' }, { v: 'dec', t: '解密' }] }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          if (!kp) throw new Error('请先生成密钥对');
          if (v.sm2dir === 'enc') {
            var cipherData = window.SM.sm2.doEncrypt(text, kp.publicKey, 1);
            out.set('04' + cipherData);
          } else {
            var hexIn = text.trim().replace(/^0x/, '');
            if (!/^[0-9a-fA-F]+$/.test(hexIn) || hexIn.length % 2) throw new Error('解密输入应为 Hex 密文（可点「交换」把密文换到输入侧）');
            var plain = window.SM.sm2.doDecrypt(hexIn, kp.privateKey, 1);
            if (!plain && /^04/i.test(hexIn)) plain = window.SM.sm2.doDecrypt(hexIn.slice(2), kp.privateKey, 1);
            if (!plain) throw new Error('解密失败：密文或密钥不正确（支持带 04 前缀的密文）');
            out.set(plain);
          }
        }
      });

      // 签名 / 验签面板
      var sigCard = UI.el('div', { class: 'card' });
      var msgIn = UI.field('消息', UI.input('sm2Msg', '待签名或验签的消息…'));
      var sigIn = UI.field('签名 (Hex)', UI.input('sm2Sig', '验签时粘贴 DER Hex 签名…'));
      var sigRes = UI.el('div', { class: 'hint' });
      var srow = UI.el('div', { class: 'btnrow' });
      srow.appendChild(UI.btn('签名', function () {
        if (!kp) { UI.toast('请先生成密钥对', true); return; }
        sigIn.querySelector('input').value = window.SM.sm2.doSignature(msgIn.querySelector('input').value, kp.privateKey, { hash: true, der: true });
        sigRes.textContent = '已签名';
        sigRes.style.color = 'var(--ok)';
      }, { primary: true }));
      srow.appendChild(UI.btn('验签', function () {
        if (!kp) { UI.toast('请先生成密钥对', true); return; }
        try {
          var okSig = window.SM.sm2.doVerifySignature(
            msgIn.querySelector('input').value,
            sigIn.querySelector('input').value.trim(),
            kp.publicKey, { hash: true, der: true });
          sigRes.textContent = okSig ? '验签通过' : '验签失败';
          sigRes.style.color = okSig ? 'var(--ok)' : 'var(--err)';
        } catch (e) { sigRes.textContent = '签名格式不合法'; sigRes.style.color = 'var(--err)'; }
      }));
      sigCard.appendChild(msgIn);
      sigCard.appendChild(sigIn);
      sigCard.appendChild(srow);
      sigCard.appendChild(sigRes);
      box.appendChild(sigCard);
      box.appendChild(UI.el('div', { class: 'hint', text: '加密使用 C1C3C2 模式，密文输出前补 04；解密自动兼容带/不带 04 前缀；签名使用 DER 编码。' }));
      function renderKp() {
        kvs.innerHTML = '';
        if (!kp) { kvs.appendChild(UI.hint('尚未生成密钥对，点击上方按钮。')); return; }
        kvs.appendChild(UI.kvList([
          ['公钥 (Hex)', kp.publicKey],
          ['私钥 (Hex)', kp.privateKey]
        ]));
      }
      renderKp();
    }
  });

  App.tool({
    id: 'sm4', name: 'SM4 国密', group: 'crypto', alias: 'sm4 国密 分组加密',
    desc: 'SM4（128 位分组），ECB/CBC，PKCS7 填充，Hex 密钥',
    icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-6-8-9V7zM8 11h8M8 14h5',
    render: function (host) {
      var t = UI.ioTool(host, {
        placeholder: '输入明文加密，或粘贴 Hex 密文解密…',
        rows: 9,
        swap: true,
        options: [
          { kind: 'select', id: 'sm4dir', label: '方向', value: 'enc', options: [{ v: 'enc', t: '加密' }, { v: 'dec', t: '解密' }] },
          { kind: 'select', id: 'sm4mode', label: '模式', value: 'ecb', options: [{ v: 'ecb', t: 'ECB' }, { v: 'cbc', t: 'CBC' }] },
          { kind: 'input', id: 'sm4key', label: '密钥 (32位Hex)', ph: '0123456789abcdeffedcba9876543210', value: '0123456789abcdeffedcba9876543210' },
          { kind: 'input', id: 'sm4iv', label: 'IV (32位Hex, CBC)', ph: '00000000000000000000000000000000', value: '00000000000000000000000000000000' }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          if (!window.SM || !window.SM.sm4) throw new Error('sm-crypto 未加载');
          var key = v.sm4key.trim();
          if (!/^[0-9a-fA-F]{32}$/.test(key)) throw new Error('密钥必须是 32 位十六进制（128 位）');
          var opt = v.sm4mode === 'cbc' ? { mode: 'cbc', iv: v.sm4iv.trim(), padding: 'pkcs#7' } : { padding: 'pkcs#7' };
          if (opt.mode === 'cbc' && !/^[0-9a-fA-F]{32}$/.test(opt.iv)) throw new Error('IV 必须是 32 位十六进制');
          if (v.sm4dir === 'enc') out.set(window.SM.sm4.encrypt(text, key, opt));
          else out.set(window.SM.sm4.decrypt(text.trim(), key, opt));
        }
      });
    }
  });

  /* ---------- Bcrypt ---------- */
  App.tool({
    id: 'bcrypt', name: 'Bcrypt', group: 'crypto', alias: 'bcrypt 加密 校验',
    desc: 'Bcrypt 哈希与密码校验（自动盐）',
    icon: 'M5 10h14v10H5zM8 10V7a4 4 0 0 1 8 0v3',
    render: function (host) {
      var box = UI.el('div', {});
      host.appendChild(box);
      if (!(window.dcodeIO && window.dcodeIO.bcrypt)) {
        box.appendChild(UI.el('div', { class: 'errbox', text: 'bcrypt 库未加载（assets/vendor/bcrypt.js）' }));
        return;
      }
      var bc = window.dcodeIO.bcrypt;
      var card = UI.el('div', { class: 'card' });
      var pwIn = UI.input('bcPw', '输入密码…');
      var rounds = UI.select('bcR', [{ v: '10', t: '10 轮' }, { v: '11', t: '11 轮' }, { v: '12', t: '12 轮' }], '10');
      var hashOut = UI.input('bcHash', '');
      hashOut.readOnly = true;
      var row = UI.el('div', { class: 'unit-grid' });
      row.appendChild(UI.field('密码', pwIn));
      row.appendChild(UI.field('强度', rounds));
      card.appendChild(row);
      var b1 = UI.btn('生成哈希', function () {
        if (!pwIn.value) { UI.toast('请输入密码', true); return; }
        hashOut.value = bc.hashSync(pwIn.value, +rounds.value);
      }, { primary: true });
      var b2 = UI.btn('复制', function () { if (hashOut.value) UI.copy(hashOut.value); });
      var act = UI.el('div', { class: 'btnrow' });
      act.appendChild(b1);
      act.appendChild(b2);
      card.appendChild(act);
      card.appendChild(UI.field('哈希结果', hashOut));
      card.appendChild(UI.el('div', { class: 'hint', text: '校验：把哈希粘贴到下方，输入原文验证。' }));
      box.appendChild(card);

      var vcard = UI.el('div', { class: 'card' });
      var hashIn = UI.field('Bcrypt 哈希', UI.input('bcVin', '$2a$10$…'));
      var plainIn = UI.field('原文', UI.input('bcPin', '原文…'));
      var vres = UI.el('div', { class: 'hint' });
      function verify() {
        var h = hashIn.querySelector('input').value.trim();
        var p = plainIn.querySelector('input').value;
        if (!h) { vres.textContent = ''; return; }
        try {
          var ok = bc.compareSync(p, h);
          vres.textContent = ok ? '校验通过：原文与哈希匹配' : '不匹配：原文或哈希不正确';
          vres.style.color = ok ? 'var(--ok)' : 'var(--err)';
        } catch (e) { vres.textContent = '哈希格式不合法'; vres.style.color = 'var(--err)'; }
      }
      vcard.appendChild(hashIn);
      vcard.appendChild(plainIn);
      vcard.appendChild(vres);
      vcard.addEventListener('input', verify);
      host.appendChild(vcard);
    }
  });
})();