/* cipher.js — 对称加密引擎：AES-128/192/256、DES、TripleDES、RC4、Rabbit
   模式：ECB/CBC/CTR/CFB/OFB；填充：PKCS7/Zero/ISO7816/None。输入输出均为字节。 */
var Cipher = (function () {
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

  /* ========== DES（位数组实现，1-based 位序与标准一致） ========== */
  var IP_T = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
  var FP_T = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
  var E_T = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13,
    12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
    24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
  var P_T = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
    2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
  var S_T = [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
      0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
      4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
      15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
      3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
      0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
      13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
      13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
      13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
      1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
      13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
      10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
      3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
      14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
      4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
      11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
      10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
      9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
      4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
      13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
      1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
      6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
      1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
      7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
      2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]];
  var PC1_T = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
    10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
    14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
  var PC2_T = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
    23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
    41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
  var SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

  function bitGet(b, n) { return (b[(n - 1) >> 3] >> (7 - ((n - 1) & 7))) & 1; }

  function desExpandKey(key) {
    if (key.length !== 8) throw new Error('DES 密钥必须为 8 字节');
    var c = [], d = [], i;
    for (i = 0; i < 28; i++) { c.push(bitGet(key, PC1_T[i])); d.push(bitGet(key, PC1_T[i + 28])); }
    var sub = [];
    for (var r = 0; r < 16; r++) {
      for (var s = 0; s < SHIFTS[r]; s++) { c.push(c.shift()); d.push(d.shift()); }
      var k = [];
      for (var b = 0; b < 48; b++) {
        var pos = PC2_T[b];
        k.push(pos <= 28 ? c[pos - 1] : d[pos - 29]);
      }
      sub.push(k);
    }
    return sub;
  }
  function desBlockBits(key, block, decrypt) {
    var sub = desExpandKey(key);
    var ip = [], i;
    for (i = 0; i < 64; i++) ip.push(bitGet(block, IP_T[i]));
    var L = ip.slice(0, 32), R = ip.slice(32);
    for (var r = 0; r < 16; r++) {
      var sk = decrypt ? sub[15 - r] : sub[r];
      var e = [];
      for (i = 0; i < 48; i++) e.push(R[E_T[i] - 1] ^ sk[i]);
      var fr = [];
      for (var bx = 0; bx < 8; bx++) {
        var b = e.slice(bx * 6, bx * 6 + 6);
        var row = (b[0] << 1) | b[5];
        var col = (b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4];
        var v = S_T[bx][row * 16 + col];
        for (i = 3; i >= 0; i--) fr.push((v >> i) & 1);
      }
      var out = [];
      for (i = 0; i < 32; i++) out.push(L[i] ^ fr[P_T[i] - 1]);
      L = R; R = out;
    }
    var pre = R.concat(L);
    var o = new Uint8Array(8);
    for (i = 0; i < 64; i++) if (pre[FP_T[i] - 1]) o[i >> 3] |= 0x80 >> (i & 7);
    return o;
  }

  /* ========== Rabbit（与 crypto-js / eSTREAM 参考实现一致的字节序约定） ========== */
  var RABBIT_A = [0x4d34d34d, 0xd34d34d3, 0x34d34d34, 0x4d34d34d, 0xd34d34d3, 0x34d34d34, 0x4d34d34d, 0xd34d34d3];
  function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  function bswap32(x) {
    return ((((x << 8) | (x >>> 24)) & 0x00ff00ff) | (((x << 24) | (x >>> 8)) & 0xff00ff00)) >>> 0;
  }
  function rabbitNextState(st) {
    var X = st.x, C = st.c;
    var oldC = st.oldC, g = st.g, i;
    for (i = 0; i < 8; i++) oldC[i] = C[i];
    for (i = 0; i < 8; i++) {
      var a = RABBIT_A[i];
      C[i] = (C[i] + a + st.carry) >>> 0;
      st.carry = C[i] < oldC[i] ? 1 : 0;
      if (i === 7) st.carry = C[7] < oldC[7] ? 1 : 0;
    }
    // 重算：逐位进位链（c_j += a_j + b_{j-1}）
    for (i = 0; i < 8; i++) {
      // 与 crypto-js 逐位一致：gx 不先截断到 32 位，平方的高位包含进位
      var gx = X[i] + C[i];
      var ga = gx & 0xffff;
      var gb = gx >>> 16;
      var gh = ((((ga * ga) >>> 17) + ga * gb) >>> 15) + gb * gb;
      var gl = (((gx & 0xffff0000) * gx) | 0) + (((gx & 0x0000ffff) * gx) | 0);
      g[i] = (gh ^ gl) | 0;
    }
    var nx = [];
    nx[0] = (g[0] + rotl32(g[7], 16) + rotl32(g[6], 16)) >>> 0;
    nx[1] = (g[1] + rotl32(g[0], 8) + g[7]) >>> 0;
    nx[2] = (g[2] + rotl32(g[1], 16) + rotl32(g[0], 16)) >>> 0;
    nx[3] = (g[3] + rotl32(g[2], 8) + g[1]) >>> 0;
    nx[4] = (g[4] + rotl32(g[3], 16) + rotl32(g[2], 16)) >>> 0;
    nx[5] = (g[5] + rotl32(g[4], 8) + g[3]) >>> 0;
    nx[6] = (g[6] + rotl32(g[5], 16) + rotl32(g[4], 16)) >>> 0;
    nx[7] = (g[7] + rotl32(g[6], 8) + g[5]) >>> 0;
    for (i = 0; i < 8; i++) X[i] = nx[i];
  }
  function rabbitCreate(key16, iv8) {
    if (key16.length !== 16) throw new Error('Rabbit 密钥必须为 16 字节');
    if (iv8 && iv8.length !== 8) throw new Error('Rabbit IV 必须为 8 字节');
    function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
    var K = [be32(key16, 0), be32(key16, 4), be32(key16, 8), be32(key16, 12)].map(function (w) { return bswap32(w); });
    var st = { x: [], c: [], carry: 0, oldC: [0, 0, 0, 0, 0, 0, 0, 0], g: [0, 0, 0, 0, 0, 0, 0, 0] };
    var x = st.x, c = st.c, i;
    x[0] = K[0] >>> 0; x[2] = K[1] >>> 0; x[4] = K[2] >>> 0; x[6] = K[3] >>> 0;
    x[1] = (((K[3] << 16) | (K[2] >>> 16)) >>> 0);
    x[3] = ((K[0] << 16) | (K[3] >>> 16)) >>> 0;
    x[5] = ((K[1] << 16) | (K[0] >>> 16)) >>> 0;
    x[7] = ((K[2] << 16) | (K[1] >>> 16)) >>> 0;
    c[0] = rotl32(K[2], 16); c[2] = rotl32(K[3], 16); c[4] = rotl32(K[0], 16); c[6] = rotl32(K[1], 16);
    c[1] = ((K[0] & 0xffff0000) | (K[1] & 0xffff)) >>> 0; c[3] = ((K[1] & 0xffff0000) | (K[2] & 0xffff)) >>> 0;
    c[5] = ((K[2] & 0xffff0000) | (K[3] & 0xffff)) >>> 0; c[7] = ((K[3] & 0xffff0000) | (K[0] & 0xffff)) >>> 0;
    st.carry = 0;
    for (i = 0; i < 4; i++) rabbitNextState(st);
    for (i = 0; i < 8; i++) c[i] = (c[i] ^ x[(i + 4) % 8]) >>> 0;
    if (iv8) {
      var iv0 = be32(iv8, 0), iv1 = be32(iv8, 4);
      var w0 = bswap32(iv0), w2 = bswap32(iv1);
      var w1 = ((w0 >>> 16) | (w2 & 0xffff0000)) >>> 0;
      var w3 = ((w2 << 16) | (w0 & 0xffff)) >>> 0;
      c[0] = (c[0] ^ w0) >>> 0; c[1] = (c[1] ^ w1) >>> 0;
      c[2] = (c[2] ^ w2) >>> 0; c[3] = (c[3] ^ w3) >>> 0;
      c[4] = (c[4] ^ w0) >>> 0; c[5] = (c[5] ^ w1) >>> 0;
      c[6] = (c[6] ^ w2) >>> 0; c[7] = (c[7] ^ w3) >>> 0;
      for (i = 0; i < 4; i++) rabbitNextState(st);
    }
    return st;
  }
  function rabbitKs(st) {
    rabbitNextState(st);
    var X = st.x, s = new Uint8Array(16);
    var t = [
      (X[0] ^ (X[5] >>> 16) ^ (X[3] << 16)) >>> 0,
      (X[2] ^ (X[7] >>> 16) ^ (X[5] << 16)) >>> 0,
      (X[4] ^ (X[1] >>> 16) ^ (X[7] << 16)) >>> 0,
      (X[6] ^ (X[3] >>> 16) ^ (X[1] << 16)) >>> 0
    ];
    for (var j = 0; j < 4; j++) {
      var w = bswap32(t[j]);
      s[j * 4] = (w >>> 24) & 0xff;
      s[j * 4 + 1] = (w >>> 16) & 0xff;
      s[j * 4 + 2] = (w >>> 8) & 0xff;
      s[j * 4 + 3] = w & 0xff;
    }
    return s;
  }
  function rabbitCrypt(key16, iv8, data) {
    var st = rabbitCreate(key16, iv8);
    var out = new Uint8Array(data.length);
    var ks = null, off = 16;
    for (var i = 0; i < data.length; i++) {
      if (off >= 16) { ks = rabbitKs(st); off = 0; }
      out[i] = data[i] ^ ks[off++];
    }
    return out;
  }

  /* ========== RC4 ========== */
  function rc4(key, data) {
    var k = key instanceof Uint8Array ? key : new Uint8Array(key);
    if (!k.length) throw new Error('RC4 密钥不能为空');
    var s = new Uint8Array(256), i, j = 0, t;
    for (i = 0; i < 256; i++) s[i] = i;
    for (i = 0; i < 256; i++) {
      j = (j + s[i] + k[i % k.length]) & 0xff;
      t = s[i]; s[i] = s[j]; s[j] = t;
    }
    var out = new Uint8Array(data.length), a = 0, b = 0;
    for (i = 0; i < data.length; i++) {
      a = (a + 1) & 0xff; b = (b + s[a]) & 0xff;
      t = s[a]; s[a] = s[b]; s[b] = t;
      out[i] = data[i] ^ s[(s[a] + s[b]) & 0xff];
    }
    return out;
  }

  /* ========== 填充 ========== */
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
    zero: {
      pad: function (len, bs) { var n = (bs - (len % bs)) % bs; return new Array(n).fill(0); },
      unpad: function (u8) { var e = u8.length; while (e > 0 && u8[e - 1] === 0) e--; return u8.subarray(0, e); }
    },
    iso7816: {
      pad: function (len, bs) { var n = bs - (len % bs); var a = new Array(n).fill(0); a[0] = 0x80; return a; },
      unpad: function (u8) {
        for (var i = u8.length - 1; i >= 0; i--) {
          if (u8[i] === 0x80) return u8.subarray(0, i);
          if (u8[i] !== 0) throw new Error('ISO7816 填充不合法，密钥或模式可能不正确');
        }
        throw new Error('ISO7816 填充不合法，密钥或模式可能不正确');
      }
    },
    none: {
      pad: function (len, bs) { if (len % bs) throw new Error('无填充模式要求明文长度为 ' + bs + ' 的整数倍'); return []; },
      unpad: function (u8) { return u8; }
    }
  };

  /* ========== 分组密码封装 ========== */
  var BLOCK_ALG = {
    aes: {
      bs: 16,
      make: function (key) {
        var exp = aesExpandKey(key);
        return {
          encrypt: function (b) { return aesEncryptBlock(exp, b); },
          decrypt: function (b) { return aesDecryptBlock(exp, b); }
        };
      },
      keyLen: [16, 24, 32]
    },
    des: {
      bs: 8,
      make: function (key) {
        return {
          encrypt: function (b) { return desBlockBits(key, b, false); },
          decrypt: function (b) { return desBlockBits(key, b, true); }
        };
      },
      keyLen: [8]
    },
    tripledes: {
      bs: 8,
      make: function (key) {
        if (key.length !== 16 && key.length !== 24) throw new Error('TripleDES 密钥必须为 16 或 24 字节');
        var k1 = key.subarray(0, 8), k2 = key.subarray(8, 16), k3 = key.length === 24 ? key.subarray(16, 24) : key.subarray(0, 8);
        return {
          encrypt: function (b) { return desBlockBits(k3, desBlockBits(k2, desBlockBits(k1, b, false), true), false); },
          decrypt: function (b) { return desBlockBits(k1, desBlockBits(k2, desBlockBits(k3, b, true), false), true); }
        };
      },
      keyLen: [16, 24]
    }
  };

  function incrBlock(b) {
    var o = new Uint8Array(b.length);
    o.set(b);
    for (var i = o.length - 1; i >= 0; i--) { o[i] = (o[i] + 1) & 0xff; if (o[i]) break; }
    return o;
  }

  function crypt(algName, data, key, opt) {
    opt = opt || {};
    var A = BLOCK_ALG[algName];
    if (!A) throw new Error('不支持的算法：' + algName);
    if (A.keyLen.indexOf(key.length) < 0) throw new Error('密钥长度须为 ' + A.keyLen.join('/') + ' 字节，当前 ' + key.length);
    var bs = A.bs, bf = A.make(key);
    var mode = (opt.mode || 'CBC').toUpperCase();
    var iv = opt.iv;
    if (mode !== 'ECB' && (!iv || iv.length !== bs)) throw new Error(mode + ' 模式需要 ' + bs + ' 字节 IV');
    var P = PADDING[opt.padding || 'pkcs7'];
    var i, off;

    if (opt.decrypt) {
      if (!data.length || data.length % bs) throw new Error('密文长度必须是 ' + bs + ' 字节的整数倍');
      var out = new Uint8Array(data.length);
      var prev = mode === 'ECB' ? null : new Uint8Array(iv);
      for (off = 0; off < data.length; off += bs) {
        var cur = data.subarray(off, off + bs);
        var d = bf.decrypt(cur);
        if (mode === 'ECB') out.set(d, off);
        else if (mode === 'CBC') {
          for (i = 0; i < bs; i++) out[off + i] = d[i] ^ prev[i];
          prev = new Uint8Array(cur);
        } else if (mode === 'CFB') {
          var ks = bf.encrypt(prev);
          for (i = 0; i < bs; i++) out[off + i] = cur[i] ^ ks[i];
          prev = new Uint8Array(cur);
        } else { // OFB / CTR 解密与加密相同
          var kk = bf.encrypt(mode === 'CTR' ? prev : prev);
          for (i = 0; i < bs; i++) out[off + i] = cur[i] ^ kk[i];
          prev = mode === 'CTR' ? incrBlock(prev) : kk;
        }
      }
      return P.unpad(out, bs);
    }

    var padArr = P.pad(data.length, bs);
    var msg = new Uint8Array(data.length + padArr.length);
    msg.set(data);
    for (i = 0; i < padArr.length; i++) msg[data.length + i] = padArr[i] & 0xff;
    var out2 = new Uint8Array(msg.length);
    var prev2 = mode === 'ECB' ? null : new Uint8Array(iv);
    for (off = 0; off < msg.length; off += bs) {
      var blk = msg.subarray(off, off + bs);
      if (mode === 'ECB') {
        out2.set(bf.encrypt(blk), off);
      } else if (mode === 'CBC') {
        var x = new Uint8Array(bs);
        for (i = 0; i < bs; i++) x[i] = blk[i] ^ prev2[i];
        var e = bf.encrypt(x);
        out2.set(e, off);
        prev2 = e;
      } else if (mode === 'CFB') {
        var ks2 = bf.encrypt(prev2);
        var cb = new Uint8Array(bs);
        for (i = 0; i < bs; i++) { out2[off + i] = blk[i] ^ ks2[i]; cb[i] = out2[off + i]; }
        prev2 = cb;
      } else {
        var kk2 = bf.encrypt(prev2);
        for (i = 0; i < bs; i++) out2[off + i] = blk[i] ^ kk2[i];
        prev2 = mode === 'CTR' ? incrBlock(prev2) : kk2;
      }
    }
    return out2;
  }
  function encrypt(algName, data, key, opt) { return crypt(algName, data, key, opt); }
  function decrypt(algName, data, key, opt) {
    opt = opt || {};
    opt.decrypt = true;
    return crypt(algName, data, key, opt);
  }

  function rabbit(key16, iv8, data) { return rabbitCrypt(key16, iv8, data); }

  return {
    encrypt: encrypt, decrypt: decrypt, rc4: rc4, rabbit: rabbit,
    incrBlock: incrBlock, PADDING: PADDING,
    _test: { SBOX: SBOX, desBlock: desBlockBits, rabbitCreate: rabbitCreate, rabbitKs: rabbitKs }
  };
})();
if (typeof globalThis !== 'undefined') globalThis.Cipher = Cipher;