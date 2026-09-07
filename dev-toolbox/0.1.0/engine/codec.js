/* codec.js — 编解码引擎：字节/UTF-8、Base64、Hex、URL、Unicode、HTML实体、ASCII、进制、原反补码、UUID、JWT、随机串 */
var Codec = (function () {
  'use strict';

  /* ---------- 字节与 UTF-8 ---------- */
  var _te = new TextEncoder();
  var _td = new TextDecoder('utf-8', { fatal: false });

  function utf8ToBytes(s) { return _te.encode(s); }
  function bytesToUtf8(b) { return _td.decode(b); }

  function bytesToHex(b, sep) {
    var out = new Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out.join(sep || '');
  }
  function hexToBytes(h) {
    var s = String(h == null ? '' : h).trim().replace(/^0x/i, '').replace(/[\s,:-]+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error('包含非法十六进制字符');
    if (s.length % 2) throw new Error('十六进制长度必须为偶数');
    var out = new Uint8Array(s.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  var B64STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToB64(bytes, urlsafe) {
    var alpha = urlsafe ? B64STD.replace(/\+/g, '-').replace(/\//g, '_') : B64STD;
    var out = [], i, n = bytes.length;
    for (i = 0; i < n; i += 3) {
      var b1 = bytes[i], b2 = i + 1 < n ? bytes[i + 1] : 0, b3 = i + 2 < n ? bytes[i + 2] : 0;
      out.push(alpha[b1 >> 2],
        alpha[((b1 & 3) << 4) | (b2 >> 4)],
        i + 1 < n ? alpha[((b2 & 15) << 2) | (b3 >> 6)] : '=',
        i + 2 < n ? alpha[b3 & 63] : '=');
    }
    return out.join('');
  }
  function b64ToBytes(s) {
    var str = String(s == null ? '' : s).trim().replace(/^data:[^;]*;base64,/i, '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str)) throw new Error('包含非法 Base64 字符');
    str = str.replace(/=+$/, '');
    if (str.length % 4 === 1) throw new Error('Base64 长度不合法');
    var map = {}, i;
    for (i = 0; i < 64; i++) map[B64STD[i]] = i;
    var out = [], acc = 0, bits = 0;
    for (i = 0; i < str.length; i++) {
      acc = (acc << 6) | map[str[i]]; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    return new Uint8Array(out);
  }
  function textToB64(s, urlsafe) { return bytesToB64(utf8ToBytes(s), urlsafe); }
  function b64ToText(s) { return bytesToUtf8(b64ToBytes(s)); }

  /* ---------- URL 编解码 ---------- */
  function urlEncode(s, mode) {
    if (mode === 'uri') return encodeURI(s);
    if (mode === 'form') return encodeURIComponent(s).replace(/%20/g, '+');
    return encodeURIComponent(s);
  }
  function urlDecode(s, mode) {
    var str = String(s == null ? '' : s).trim();
    if (mode === 'form' || /\+/.test(str)) str = str.replace(/\+/g, '%20');
    try { return decodeURIComponent(str); }
    catch (e) { throw new Error('解码失败：百分比编码不完整或非法（' + e.message + '）'); }
  }

  /* ---------- HTML 实体 ---------- */
  var ENT_NAME = {
    38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: 'apos', 160: 'nbsp',
    169: 'copy', 174: 'reg', 8482: 'trade', 8230: 'hellip', 8212: 'mdash', 8211: 'ndash',
    8216: 'lsquo', 8217: 'rsquo', 8220: 'ldquo', 8221: 'rdquo', 176: 'deg', 177: 'plusmn',
    215: 'times', 247: 'divide', 189: 'frac12', 190: 'frac14', 188: 'frac34',
    8364: 'euro', 163: 'pound', 165: 'yen', 162: 'cent', 167: 'sect', 182: 'para',
    183: 'middot', 171: 'laquo', 187: 'raquo', 8226: 'bull', 8240: 'permil',
    8592: 'larr', 8594: 'rarr', 8593: 'uarr', 8595: 'darr', 8596: 'harr',
    913: 'Alpha', 914: 'Beta', 915: 'Gamma', 916: 'Delta', 917: 'Epsilon', 918: 'Zeta',
    919: 'Eta', 920: 'Theta', 921: 'Iota', 922: 'Kappa', 923: 'Lambda', 924: 'Mu',
    925: 'Nu', 926: 'Xi', 927: 'Omicron', 928: 'Pi', 929: 'Rho', 931: 'Sigma',
    932: 'Tau', 933: 'Upsilon', 934: 'Phi', 935: 'Chi', 936: 'Psi', 937: 'Omega',
    945: 'alpha', 946: 'beta', 947: 'gamma', 948: 'delta', 949: 'epsilon', 950: 'zeta',
    951: 'eta', 952: 'theta', 953: 'iota', 954: 'kappa', 955: 'lambda', 956: 'mu',
    957: 'nu', 958: 'xi', 959: 'omicron', 960: 'pi', 961: 'rho', 963: 'sigma',
    964: 'tau', 965: 'upsilon', 966: 'phi', 967: 'chi', 968: 'psi', 969: 'omega'
  };
  var ENT_REV = {};
  (function () { for (var k in ENT_NAME) ENT_REV[ENT_NAME[k]] = +k; })();

  function htmlEncode(s, opt) {
    opt = opt || {};
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], code = s.charCodeAt(i);
      if (code === 38) out += '&amp;';
      else if (code === 60) out += '&lt;';
      else if (code === 62) out += '&gt;';
      else if ((code === 34 || code === 39) && opt.quotes) out += ENT_NAME[code] ? '&' + ENT_NAME[code] + ';' : '&#' + code + ';';
      else if (opt.all) {
        var name = ENT_NAME[code];
        out += (name && opt.named) ? '&' + name + ';' : '&#' + code + ';';
      } else out += ch;
    }
    return out;
  }
  function htmlDecode(s) {
    var rev = {};
    for (var c in ENT_NAME) rev[ENT_NAME[c]] = +c;
    rev.amp = 38; rev.lt = 60; rev.gt = 62; rev.quot = 34; rev.apos = 39; rev.nbsp = 160;
    return String(s == null ? '' : s).replace(/&(#[xX]?)([0-9a-fA-F]+);|&([a-zA-Z][a-zA-Z0-9]{1,31});/g, function (m, hash, num, name) {
      if (hash) {
        var code = hash === '#' ? parseInt(num, 10) : parseInt(num, 16);
        if (!(code >= 0) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
        try { return String.fromCodePoint(code); } catch (e) { return m; }
      }
      var fixed = rev[name] !== undefined ? rev[name] : rev[name.toLowerCase()];
      return fixed !== undefined ? String.fromCodePoint(fixed) : m;
    });
  }

  /* ---------- Unicode 转义 ---------- */
  function toUnicode(s, opt) {
    opt = opt || {};
    var out = [];
    var upper = opt.upper === true;
    function hx(n, pad) {
      var h = n.toString(16).toUpperCase();
      if (!upper) h = h.toLowerCase();
      while (h.length < (pad || 4)) h = '0' + h;
      return h;
    }
    if (opt.html) {
      for (var i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);
        // HTML 编码始终转义 XML 特殊字符
        if (code === 38) { out.push('&amp;'); continue; }
        if (code === 60) { out.push('&lt;'); continue; }
        if (code === 62) { out.push('&gt;'); continue; }
        if ((code === 34 || code === 39) && opt.quotes !== false) { out.push('&#' + code + ';'); continue; }
        if (code < 128 && !opt.all) { out.push(s[i]); continue; }
        var name = ENT_NAME[code];
        if (name && opt.html === 'named') out.push('&' + name + ';');
        else if (opt.html === 'hex') out.push('&#x' + hx(code, 1) + ';');
        else out.push('&#' + code + ';');
      }
      return out.join('');
    }
    if (opt.css) {
      for (var j = 0; j < s.length; j++) {
        var cc = s.charCodeAt(j);
        if (cc < 128 && !opt.all) { out.push(s[j]); continue; }
        out.push('\\' + hx(cc, opt.cssPad || 4) + ' ');
      }
      return out.join('').replace(/\\[0-9a-fA-F]+ (?=[0-9a-fA-F])/g, function (m) { return m; });
    }
    // \uXXXX / \u{...}
    if (opt.braces) {
      for (var ch of s) {
        var cp = ch.codePointAt(0);
        if (cp < 128 && !opt.all) out.push(ch);
        else out.push('\\u{' + hx(cp, 1) + '}');
      }
      return out.join('');
    }
    for (var k = 0; k < s.length; k++) {
      var cu = s.charCodeAt(k);
      if (cu < 128 && !opt.all) out.push(s[k]);
      else out.push('\\u' + hx(cu, 4));
    }
    return out.join('');
  }
  function fromUnicode(s) {
    return String(s == null ? '' : s)
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#x([0-9a-fA-F]+);?/gi, function (m, h) {
        var c = parseInt(h, 16); return c <= 0x10ffff ? String.fromCodePoint(c) : m;
      })
      .replace(/&#(\d+);?/g, function (m, d) {
        var c = +d; return c <= 0x10ffff ? String.fromCodePoint(c) : m;
      })
      .replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (m, h) { // CSS \XXXXX 转义（可选尾随空格）
        var c = parseInt(h, 16);
        return c >= 0x20 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
      })
      .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, function (m, name) {
        var rev = htmlDecode._rev;
        return rev[name] !== undefined ? String.fromCodePoint(rev[name]) : m;
      });
  }

  /* ---------- ASCII / 编码点列表 ---------- */
  function toRadixList(s, radix, sep) {
    sep = sep === undefined ? ' ' : sep;
    var out = [];
    for (var ch of s) out.push(ch.codePointAt(0).toString(radix));
    return out.join(sep);
  }
  function fromRadixList(s, radix) {
    var tokens = String(s == null ? '' : s).trim().split(/[\s,;、|]+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var v = parseInt(tokens[i], radix);
      if (!(v >= 0) || v > 0x10ffff) throw new Error('第 ' + (i + 1) + ' 个值「' + tokens[i] + '」不是合法的 ' + radix + ' 进制编码点');
      out.push(String.fromCodePoint(v));
    }
    return out.join('');
  }

  /* ---------- 进制转换（2-64，BigInt） ---------- */
  var R36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  var R64 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
  function radixAlphabet(base) {
    if (base <= 36) return R36.slice(0, base);
    return R64.slice(0, base);
  }
  function radixConvert(input, fromBase, toBase) {
    var alpha = radixAlphabet(fromBase);
    var s = String(input == null ? '' : input).trim();
    if (!s) return '';
    var neg = false;
    if (s[0] === '-' || s[0] === '−') { neg = true; s = s.slice(1); }
    var idx = {};
    for (var i = 0; i < alpha.length; i++) idx[alpha[i]] = i;
    if (fromBase <= 36) {
      s = s.toLowerCase();
      if (fromBase === 16 && /^0x/i.test(s)) s = s.slice(2);
      if ((fromBase === 2) && /^0b/i.test(s)) s = s.slice(2);
      if ((fromBase === 8) && /^0o/i.test(s)) s = s.slice(2);
    }
    var v = 0n, B = BigInt(fromBase);
    for (var j = 0; j < s.length; j++) {
      var d = idx[s[j]];
      if (d === undefined) throw new Error('「' + s[j] + '」不是 ' + fromBase + ' 进制的合法字符');
      v = v * B + BigInt(d);
    }
    if (toBase === 10) return (neg ? '-' : '') + v.toString(10);
    var outA = radixAlphabet(toBase), TB = BigInt(toBase);
    if (v === 0n) return '0';
    var digits = [];
    while (v > 0n) { digits.push(outA[Number(v % TB)]); v = v / TB; }
    return (neg ? '-' : '') + digits.reverse().join('');
  }

  /* ---------- 原码 / 反码 / 补码 ---------- */
  function signedForms(value, bits) {
    var v;
    try { v = BigInt(String(value).trim()); } catch (e) { throw new Error('请输入合法整数'); }
    var max = (1n << BigInt(bits - 1));
    if (v >= max || v < -max) throw new Error('超出 ' + bits + ' 位有符号范围 [' + (-max) + ', ' + (max - 1n) + ']');
    var width = BigInt(bits);
    var mask = (1n << width) - 1n;
    var sign = v < 0n ? 1n : 0n;
    var mag = (v < 0n ? -v : v) & (mask >> 1n);
    var orig = (sign << BigInt(bits - 1)) | mag;
    // 反码：原码符号位不变、数值位取反；补码：模 2^n 加法（正确处理 -2^(n-1) 特例）
    var ones = v >= 0n ? orig : ((sign << BigInt(bits - 1)) | ((~mag) & (mask >> 1n)));
    var twos = v >= 0n ? orig : ((1n << width) + v) & mask;
    function pad(x) { var s = x.toString(2); while (s.length < bits) s = '0' + s; return s; }
    return {
      original: pad(orig), ones: pad(ones), twos: pad(twos),
      hex: { original: orig.toString(16), ones: ones.toString(16), twos: twos.toString(16) }
    };
  }

  /* ---------- UUID ---------- */
  function uuidV4() {
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : require_node_crypto_();
    if (!c) throw new Error('环境缺少安全随机源');
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = bytesToHex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function require_node_crypto_() {
    try { return typeof require === 'function' ? require('crypto').webcrypto : null; }
    catch (e) { return null; }
  }
  var UUID_NIL = '00000000-0000-0000-0000-000000000000';
  function uuidBatch(count, opt) {
    opt = opt || {};
    var out = [];
    for (var i = 0; i < count; i++) {
      var u = opt.nil ? UUID_NIL : uuidV4();
      if (opt.lower) u = u.toLowerCase();
      if (opt.upper) u = u.toUpperCase();
      if (opt.nodash) u = u.replace(/-/g, '');
      if (opt.braces) u = '{' + u + '}';
      out.push(u);
    }
    return out;
  }

  /* ---------- JWT 解码 ---------- */
  function jwtDecode(token) {
    var t = String(token == null ? '' : token).trim().replace(/^Bearer\s+/i, '');
    var seg = t.split('.');
    if (seg.length < 2) throw new Error('JWT 至少需要 header.payload 两段（以 . 分隔）');
    function b64uJson(segStr) {
      var pad = segStr.replace(/-/g, '+').replace(/_/g, '/');
      while (pad.length % 4) pad += '=';
      var json = bytesToUtf8(b64ToBytes(pad));
      try { return JSON.parse(json); } catch (e) { throw new Error('该段不是合法 JSON：' + e.message); }
    }
    var header = b64uJson(seg[0]), payload = b64uJson(seg[1]);
    var claims = [];
    var keys = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (payload[k] !== undefined) {
        var label = { iss: '签发方', sub: '主题', aud: '受众', exp: '过期时间', nbf: '生效时间', iat: '签发时间', jti: 'JWT ID' }[k];
        var v = payload[k];
        if ((k === 'exp' || k === 'nbf' || k === 'iat') && typeof v === 'number') {
          var d = new Date(v > 1e12 ? v : v * 1000);
          claims.push(k + ': ' + v + ' — ' + label + ' ' + d.toLocaleString('zh-CN'));
        } else claims.push(k + ': ' + v + ' — ' + label);
      }
    }
    return {
      header: header, payload: payload,
      signatureB64: seg[2] || null,
      signatureHex: seg[2] ? bytesToHex(b64ToBytes(seg[2] + repeatPad(seg[2]))) : null,
      timeClaims: claims,
      expired: typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()
    };
  }
  function repeatPad(s) { var p = ''; while ((s.length + p.length) % 4) p += '='; return p; }

  /* ---------- 随机字符串 ---------- */
  var RSET = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digit: '0123456789',
    special: '!@#$%^&*()-_=+[]{};:,.<>?/~',
    ambiguous: 'il1Lo0O\'"`|'
  };
  function randomStrings(opt) {
    var len = Math.max(1, Math.min(1024, opt.length | 0));
    var count = Math.max(1, Math.min(1000, opt.count | 0));
    var cs = '';
    if (opt.lower) cs += RSET.lower;
    if (opt.upper) cs += RSET.upper;
    if (opt.digit) cs += RSET.digit;
    if (opt.special) cs += RSET.special;
    if (opt.custom) cs += String(opt.custom);
    if (!cs) throw new Error('请至少选择一种字符集');
    if (opt.noAmbig) cs = cs.split('').filter(function (c) { return RSET.ambiguous.indexOf(c) < 0; }).join('');
    if (!cs.length) throw new Error('过滤易混淆字符后字符集为空');
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : require_node_crypto_();
    var out = [], buf = new Uint32Array(len);
    for (var i = 0; i < count; i++) {
      c.getRandomValues(buf);
      var s = '';
      for (var j = 0; j < len; j++) s += cs[buf[j] % cs.length];
      out.push(s);
    }
    return out;
  }

  /* ---------- ULID ---------- */
  var ULID_B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32，不含 I/L/O/U
  function ulidEncodeTime(time) {
    var s = '';
    for (var i = 0; i < 10; i++) { s = ULID_B32[time % 32] + s; time = Math.floor(time / 32); }
    return s;
  }
  function ulidEncodeRand(b) { // 10 字节 80 bit -> 16 个 5bit 字符
    var s = '', acc = 0, n = 0;
    for (var i = 0; i < 10; i++) {
      acc = ((acc << 8) | b[i]) & 0x1fff; n += 8;
      while (n >= 5) { n -= 5; s += ULID_B32[(acc >>> n) & 31]; }
    }
    return s;
  }
  function ulidDecodeTime(s) {
    var str = String(s == null ? '' : s).trim().toUpperCase();
    if (str.length !== 26) throw new Error('ULID 固定 26 字符，当前 ' + str.length + ' 位');
    var t = 0;
    for (var i = 0; i < 10; i++) {
      var idx = ULID_B32.indexOf(str[i]);
      if (idx < 0) throw new Error('第 ' + (i + 1) + ' 位含非法字符（Crockford Base32 不含 I/L/O/U）：' + str[i]);
      t = t * 32 + idx;
    }
    return t;
  }
  function ulidIncRand(b) { for (var i = 9; i >= 0; i--) { if (b[i] === 255) b[i] = 0; else { b[i]++; return; } } }
  function ulidBatch(count, opt) {
    opt = opt || {};
    count = Math.max(1, Math.min(1000, count | 0));
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : require_node_crypto_();
    if (!c) throw new Error('环境缺少安全随机源');
    var out = [], prevT = -1, prevR = null;
    for (var i = 0; i < count; i++) {
      var t = Date.now(), r;
      if (opt.mono && t === prevT) { r = prevR; ulidIncRand(r); }
      else { r = new Uint8Array(10); c.getRandomValues(r); }
      prevT = t; prevR = r;
      var s = ulidEncodeTime(t) + ulidEncodeRand(r);
      if (opt.lower) s = s.toLowerCase();
      out.push(s);
    }
    return out;
  }

  return {
    utf8ToBytes: utf8ToBytes, bytesToUtf8: bytesToUtf8,
    bytesToHex: bytesToHex, hexToBytes: hexToBytes,
    bytesToB64: bytesToB64, b64ToBytes: b64ToBytes,
    textToB64: textToB64, b64ToText: b64ToText,
    urlEncode: urlEncode, urlDecode: urlDecode,
    htmlEncode: htmlEncode, htmlDecode: htmlDecode,
    toUnicode: toUnicode, fromUnicode: fromUnicode,
    toRadixList: toRadixList, fromRadixList: fromRadixList,
    radixConvert: radixConvert, signedForms: signedForms,
    uuidV4: uuidV4, uuidBatch: uuidBatch, UUID_NIL: UUID_NIL,
    jwtDecode: jwtDecode, randomStrings: randomStrings,
    ulidBatch: ulidBatch, ulidDecodeTime: ulidDecodeTime, ULID_B32: ULID_B32
  };
})();
if (typeof globalThis !== 'undefined') globalThis.Codec = Codec;