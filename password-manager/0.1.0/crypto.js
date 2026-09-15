/* crypto.js — 密码管家的密码学底座（纯 JS、零依赖、零网络请求）
 *
 * 组成（密码学核心全部机械抽取自本仓库 dev-toolbox/0.1.0，未改写任何核心代码）：
 *   · AES-256 分组加解密 + PKCS7 填充 ← engine/cipher.js
 *   · SHA-256                        ← engine/crypto.js
 *   · bcrypt（EksBlowfish）          ← bcrypt.js（bcryptjs 2.4.3，见 VENDORS.md）
 * 抽取时剔除了密码管家用不到的算法（DES/3DES/RC4/Rabbit/MD5/SHA-1/SHA-512/SM3）与
 * 五模式通用封装，只保留 CBC + PKCS7 这一条路径。
 *
 * 用途（调用方见 vault.js）：
 *   1) 开门密码 → bcrypt(cost=10) 密文存盘，只用于校验；磁盘上没有任何可逆的密码材料。
 *   2) AES-256 密钥 = SHA-256(bcrypt 密文)，即规范里"开门密码经过哈希处理的值"。
 *      攻击者即使拿到全部落盘数据，也必须先求出开门密码才能算出密钥。
 */

var CryptoBox = (function () {
  'use strict';

  /* ---------- GF(2^8) 乘法 ---------- */
  var EXP = new Uint8Array(256), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x ^= (((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff); }
    EXP[255] = EXP[0];
  })();
  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }
  /* ========== AES（S 盒由 GF(2^8) 逆元 + 仿射变换程序化生成） ========== */
  var SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
  (function () {
    for (var i = 0; i < 256; i++) {
      var inv = i === 0 ? 0 : EXP[255 - LOG[i]];
      var s = 0x63 ^ inv;
      var r = inv;
      r = ((r << 1) | (r >>> 7)) & 0xff; s ^= r;
      r = ((r << 1) | (r >>> 7)) & 0xff; s ^= r;
      r = ((r << 1) | (r >>> 7)) & 0xff; s ^= r;
      r = ((r << 1) | (r >>> 7)) & 0xff; s ^= r;
      SBOX[i] = s & 0xff;
    }
    for (var j = 0; j < 256; j++) INV_SBOX[SBOX[j]] = j;
  })();
  var SHIFT = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
  var RCON = (function () { var r = [0, 1]; for (var i = 2; i <= 10; i++) r.push(gmul(r[i - 1], 2)); return r; })();

  function aesExpandKey(key) {
    var nk = key.length / 4;
    if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('AES 密钥长度必须为 16/24/32 字节');
    var nr = nk + 6;
    var w = new Uint32Array(4 * (nr + 1));
    for (var i = 0; i < nk; i++) {
      w[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
    }
    for (i = nk; i < 4 * (nr + 1); i++) {
      var t = w[i - 1];
      if (i % nk === 0) {
        t = ((t << 8) | (t >>> 24)) >>> 0;
        t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
        t = (t ^ (RCON[i / nk] << 24)) >>> 0;
      } else if (nk > 6 && i % nk === 4) {
        t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    return { w: w, nr: nr };
  }
  function rkByte(w, idx, i) { return (w[idx] >>> (24 - (i % 4) * 8)) & 0xff; }

  function aesEncryptBlock(exp, input) {
    var w = exp.w, nr = exp.nr;
    var s = new Uint8Array(16), i, r;
    for (i = 0; i < 16; i++) s[i] = input[i] ^ rkByte(w, i >> 2, i);
    for (var r = 1; r < nr; r++) {
      var t = new Uint8Array(16);
      for (i = 0; i < 16; i++) t[i] = SBOX[s[SHIFT[i]]];
      for (var c = 0; c < 4; c++) {
        var a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
        s[c * 4] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        s[c * 4 + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
      }
      for (i = 0; i < 16; i++) s[i] ^= rkByte(w, r * 4 + (i >> 2), i);
    }
    var f = new Uint8Array(16);
    for (i = 0; i < 16; i++) f[i] = (SBOX[s[SHIFT[i]]] ^ rkByte(w, nr * 4 + (i >> 2), i)) & 0xff;
    return f;
  }
  function aesDecryptBlock(exp, input) {
    var w = exp.w, nr = exp.nr;
    var s = new Uint8Array(16), i;
    for (i = 0; i < 16; i++) s[i] = input[i] ^ rkByte(w, nr * 4 + (i >> 2), i);
    for (var r = nr - 1; r >= 1; r--) {
      var t = new Uint8Array(16);
      for (i = 0; i < 16; i++) t[SHIFT[i]] = INV_SBOX[s[i]];
      for (i = 0; i < 16; i++) s[i] = t[i] ^ rkByte(w, r * 4 + (i >> 2), i);
      for (var c = 0; c < 4; c++) {
        var a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[c * 4 + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[c * 4 + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[c * 4 + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }
    var f = new Uint8Array(16);
    for (i = 0; i < 16; i++) f[SHIFT[i]] = INV_SBOX[s[i]];
    for (i = 0; i < 16; i++) f[i] ^= rkByte(w, i >> 2, i);
    return f;
  }

  /* ---------- PKCS7 填充（自 engine/cipher.js 机械抽取） ---------- */
  var PADDING = {
    pkcs7: {
      pad: function (len, bs) { var n = bs - (len % bs); return new Array(n).fill(n); },
      unpad: function (u8, bs) {
        var n = u8[u8.length - 1];
        if (n < 1 || n > bs || n > u8.length) throw new Error('填充校验失败，密钥/模式/填充方式可能不正确');
        for (var i = u8.length - n; i < u8.length; i++) if (u8[i] !== n) throw new Error('填充校验失败，密钥或模式可能不正确');
        return u8.subarray(0, u8.length - n);
      }
    },
  };

  /* ---------- SHA-256（自 engine/crypto.js 机械抽取） ---------- */
  function rotr32(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  /* ========== SHA-256 ========== */
  var P80 = (function () {
    var ps = [], n = 2, c = 0;
    while (c < 80) {
      var isP = true;
      for (var d = 2; d * d <= n; d++) if (n % d === 0) { isP = false; break; }
      if (isP) ps.push(BigInt(n));
      n++; c = ps.length;
    }
    return ps;
  })();
  function isqrt(n) {
    if (n < 2n) return n;
    var x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    while (x * x > n) x--;
    while ((x + 1n) * (x + 1n) <= n) x++;
    return x;
  }
  function icbrt(n) {
    if (n < 2n) return n;
    var x = n, y = (2n * x + n / (x * x)) / 3n;
    while (y < x) { x = y; y = (2n * x + n / (x * x)) / 3n; }
    while (x * x * x > n) x--;
    while ((x + 1n) * (x + 1n) * (x + 1n) <= n) x++;
    return x;
  }
  var SHA256_K = P80.slice(0, 64).map(function (p) { return Number(icbrt(p << 96n) & 0xffffffffn); });
  var SHA256_H = P80.slice(0, 8).map(function (p) { return Number(isqrt(p << 64n) & 0xffffffffn); });

  function sha256Block(state, block, off) {
    var w = new Array(64), i;
    for (i = 0; i < 16; i++) {
      w[i] = (block[off + i * 4] << 24) | (block[off + i * 4 + 1] << 16) | (block[off + i * 4 + 2] << 8) | block[off + i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      var S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    var st = [a, b, c, d, e, f, g, h];
    for (i = 0; i < 8; i++) state[i] = (state[i] + st[i]) >>> 0;
  }
  function beOut(len) {
    return function (state) {
      var out = new Uint8Array(len);
      for (var i = 0; i < len / 4; i++) {
        out[i * 4] = (state[i] >>> 24) & 0xff; out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (state[i] >>> 8) & 0xff; out[i * 4 + 3] = state[i] & 0xff;
      }
      return out;
    };
  }

  /* ---------- 字节与编码工具（胶水层） ---------- */

  function asBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x && typeof ArrayBuffer !== 'undefined' && x instanceof ArrayBuffer) return new Uint8Array(x);
    if (Array.isArray(x)) return new Uint8Array(x);
    throw new Error('需要字节数组');
  }

  /* UTF-8 编解码：手写实现，不依赖 TextEncoder/escape，任何宿主下结果一致 */
  function utf8Bytes(str) {
    var s = String(str), out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }
  function utf8String(bytes) {
    var b = asBytes(bytes), out = '', i = 0, c, u;
    while (i < b.length) {
      c = b[i++];
      if (c < 0x80) { out += String.fromCharCode(c); continue; }
      if (c >= 0xc0 && c < 0xe0) { u = ((c & 0x1f) << 6) | (b[i++] & 0x3f); }
      else if (c >= 0xe0 && c < 0xf0) { u = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f); }
      else if (c >= 0xf0) {
        u = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        u -= 0x10000;
        out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
        continue;
      } else { continue; } /* 非法首字节：跳过（lossy） */
      out += String.fromCharCode(u);
    }
    return out;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(x) {
    var b = asBytes(x), s = '', i;
    for (i = 0; i + 2 < b.length; i += 3) {
      var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    var rest = b.length - i;
    if (rest === 1) {
      var n1 = b[i] << 16;
      s += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + '==';
    } else if (rest === 2) {
      var n2 = (b[i] << 16) | (b[i + 1] << 8);
      s += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '=';
    }
    return s;
  }
  function fromBase64(str) {
    var s = String(str).replace(/[^A-Za-z0-9+/]/g, ''), out = [], i, n;
    for (i = 0; i + 3 < s.length; i += 4) {
      n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | (B64.indexOf(s[i + 2]) << 6) | B64.indexOf(s[i + 3]);
      out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    }
    var rest = s.length - i;
    if (rest === 3) {
      n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | (B64.indexOf(s[i + 2]) << 6);
      out.push((n >> 16) & 0xff, (n >> 8) & 0xff);
    } else if (rest === 2) {
      n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12);
      out.push((n >> 16) & 0xff);
    }
    return new Uint8Array(out);
  }

  function toHex(x) {
    var b = asBytes(x), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function fromHex(str) {
    var s = String(str).replace(/[^0-9a-fA-F]/g, ''), out = new Uint8Array(s.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  /* 密码学安全随机数：宿主无 CSPRNG 时直接失败（绝不退回 Math.random） */
  function randomBytes(n) {
    if (typeof globalThis === 'undefined' || !globalThis.crypto || !globalThis.crypto.getRandomValues) {
      throw new Error('当前环境没有可用的密码学随机源，为安全起见拒绝继续');
    }
    var b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  function concatBytes() {
    var parts = [], total = 0, i;
    for (i = 0; i < arguments.length; i++) { var p = asBytes(arguments[i]); parts.push(p); total += p.length; }
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  /* 定长比较：不因长度/前缀差异产生可观测的时间差 */
  function equalBytes(a, b) {
    var x = asBytes(a), y = asBytes(b);
    var diff = x.length ^ y.length, n = Math.max(x.length, y.length);
    for (var i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
    return diff === 0;
  }

  /* ---------- SHA-256 一次性接口（beOut 亦自 engine/crypto.js 机械抽取） ---------- */
  /* 摘要输入：字符串按 UTF-8 解释，字节数组原样 */
  function asMessage(x) {
    return typeof x === 'string' ? utf8Bytes(x) : asBytes(x);
  }
  var SHA256_OUT = beOut(32);
  function sha256Bytes(data) {
    var msg = asMessage(data), bits = msg.length * 8;
    var padLen = (64 - ((msg.length + 9) % 64)) % 64;
    var buf = new Uint8Array(msg.length + 1 + padLen + 8);
    buf.set(msg);
    buf[msg.length] = 0x80;
    var hi = Math.floor(bits / 0x100000000);
    buf[buf.length - 8] = (hi >>> 24) & 0xff; buf[buf.length - 7] = (hi >>> 16) & 0xff;
    buf[buf.length - 6] = (hi >>> 8) & 0xff; buf[buf.length - 5] = hi & 0xff;
    buf[buf.length - 4] = (bits >>> 24) & 0xff; buf[buf.length - 3] = (bits >>> 16) & 0xff;
    buf[buf.length - 2] = (bits >>> 8) & 0xff; buf[buf.length - 1] = bits & 0xff;
    var state = SHA256_H.slice();
    for (var off = 0; off < buf.length; off += 64) sha256Block(state, buf, off);
    return SHA256_OUT(state);
  }

  /* ---------- AES-256-CBC（胶水：只拼 CBC + PKCS7 一条路径） ---------- */
  var BLOCK = 16;
  function aesCbcEncrypt(key, iv, data) {
    var exp = aesExpandKey(asBytes(key));
    var msg = asBytes(data), pad = PADDING.pkcs7.pad(msg.length, BLOCK);
    var buf = new Uint8Array(msg.length + pad.length);
    buf.set(msg);
    for (var i = 0; i < pad.length; i++) buf[msg.length + i] = pad[i] & 0xff;
    var out = new Uint8Array(buf.length), prev = asBytes(iv).slice();
    for (var off = 0; off < buf.length; off += BLOCK) {
      var x = new Uint8Array(BLOCK);
      for (var j = 0; j < BLOCK; j++) x[j] = buf[off + j] ^ prev[j];
      var e = aesEncryptBlock(exp, x);
      out.set(e, off);
      prev = e;
    }
    return out;
  }
  function aesCbcDecrypt(key, iv, data) {
    var exp = aesExpandKey(asBytes(key));
    var ct = asBytes(data);
    if (!ct.length || ct.length % BLOCK) throw new Error('密文长度必须是 16 字节的整数倍');
    var out = new Uint8Array(ct.length), prev = asBytes(iv).slice();
    for (var off = 0; off < ct.length; off += BLOCK) {
      var cur = ct.subarray(off, off + BLOCK);
      var d = aesDecryptBlock(exp, cur);
      for (var j = 0; j < BLOCK; j++) out[off + j] = d[j] ^ prev[j];
      prev = cur.slice();
    }
    return PADDING.pkcs7.unpad(out, BLOCK);
  }

  return {
    /* 编码 */
    utf8Bytes: utf8Bytes, utf8String: utf8String,
    toBase64: toBase64, fromBase64: fromBase64,
    toHex: toHex, fromHex: fromHex,
    concatBytes: concatBytes, equalBytes: equalBytes,
    randomBytes: randomBytes,
    /* 摘要 */
    sha256: sha256Bytes,
    sha256Hex: function (d) { return toHex(sha256Bytes(d)); },
    /* 对称加密 */
    aesCbcEncrypt: aesCbcEncrypt, aesCbcDecrypt: aesCbcDecrypt,
    /* 自检用（不参与业务） */
    _test: { aesExpandKey: aesExpandKey, pkcs7: PADDING.pkcs7, blockSize: BLOCK }
  };
})();

if (typeof globalThis !== 'undefined') globalThis.CryptoBox = CryptoBox;
