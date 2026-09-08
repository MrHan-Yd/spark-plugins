/* crypto.js — 哈希引擎：MD5 / SHA-1 / SHA-256 / SHA-512 / HMAC（输入输出均为字节，支持增量） */
var Crypto = (function () {
  'use strict';

  function rotr32(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

  /* ========== MD5 ========== */
  var MD5_K = (function () {
    var k = [];
    for (var i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    return k;
  })();
  var MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  function md5Block(state, block, off) {
    var M = new Array(16), i;
    for (i = 0; i < 16; i++) {
      M[i] = (block[off + i * 4] | (block[off + i * 4 + 1] << 8) | (block[off + i * 4 + 2] << 16) | (block[off + i * 4 + 3] << 24)) >>> 0;
    }
    var a = state[0], b = state[1], c = state[2], d = state[3];
    var f, g, tmp;
    for (i = 0; i < 64; i++) {
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      tmp = d; d = c; c = b;
      var sum = (a + f + MD5_K[i] + M[g]) >>> 0;
      b = (b + rotl32(sum, MD5_S[(i % 4) + Math.floor(i / 16) * 4])) >>> 0;
      a = tmp;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
  }
  function md5DigestLE(words) {
    var out = new Uint8Array(16);
    for (var i = 0; i < 4; i++) {
      var w = words[i];
      out[i * 4] = w & 0xff; out[i * 4 + 1] = (w >>> 8) & 0xff;
      out[i * 4 + 2] = (w >>> 16) & 0xff; out[i * 4 + 3] = (w >>> 24) & 0xff;
    }
    return out;
  }

  /* ========== SHA-1 ========== */
  function sha1Block(state, block, off) {
    var w = new Array(80), i, t;
    for (i = 0; i < 16; i++) {
      w[i] = (block[off + i * 4] << 24) | (block[off + i * 4 + 1] << 16) | (block[off + i * 4 + 2] << 8) | block[off + i * 4 + 3];
    }
    for (i = 16; i < 80; i++) {
      t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((t << 1) | (t >>> 31)) >>> 0;
    }
    var a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];
    for (i = 0; i < 80; i++) {
      var f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      t = ((a << 5) | (a >>> 27)) + f + e + k + w[i];
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a;
      a = t >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0; state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0; state[4] = (state[4] + e) >>> 0;
  }

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

  /* ========== SHA-512（64 位用 [hi,lo] 表示） ========== */
  var SHA512_K = P80.map(function (p) { return icbrt(p << 192n) & 0xffffffffffffffffn; });
  var SHA512_H = P80.slice(0, 8).map(function (p) { return isqrt(p << 128n) & 0xffffffffffffffffn; });

  function add64(a, b) { return (a + b) & 0xffffffffffffffffn; }
  function rotr64(x, n) {
    n = BigInt(n % 64);
    return ((x >> n) | (x << (64n - n))) & 0xffffffffffffffffn;
  }
  function shr64(x, n) { return (x >> BigInt(n)) & 0xffffffffffffffffn; }

  function sha512Block(state, block, off) {
    var w = new Array(80), i;
    for (i = 0; i < 16; i++) {
      var hi = 0n, lo = 0n, j;
      for (j = 0; j < 4; j++) hi = (hi << 8n) | BigInt(block[off + i * 8 + j]);
      for (j = 4; j < 8; j++) lo = (lo << 8n) | BigInt(block[off + i * 8 + j]);
      w[i] = (hi << 32n) | lo;
    }
    for (i = 16; i < 80; i++) {
      var s0 = rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ shr64(w[i - 15], 7);
      var s1 = rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ shr64(w[i - 2], 6);
      w[i] = add64(add64(add64(w[i - 16], s0), w[i - 7]), s1);
    }
    var a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
    for (i = 0; i < 80; i++) {
      var S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
      var ch = (e & f) ^ (~e & g);
      var t1 = add64(add64(add64(add64(h, S1), ch), SHA512_K[i]), w[i]);
      var S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = add64(S0, maj);
      h = g; g = f; f = e; e = add64(d, t1); d = c; c = b; b = a; a = add64(t1, t2);
    }
    var st = [a, b, c, d, e, f, g, h];
    for (i = 0; i < 8; i++) state[i] = add64(state[i], st[i]);
  }

  /* ========== 通用增量框架 ========== */
  var ALGS = {
    md5: { blockSize: 64, digestLen: 16, init: function () { return [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]; }, block: md5Block, out: md5DigestLE },
    sha1: { blockSize: 64, digestLen: 20, init: function () { return [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]; }, block: sha1Block, out: beOut(20) },
    sha256: { blockSize: 64, digestLen: 32, init: function () { return SHA256_H.slice(); }, block: sha256Block, out: beOut(32) },
    sha512: { blockSize: 128, digestLen: 64, init: function () { return SHA512_H.slice(); }, block: sha512Block, out: be64Out() }
  };
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
  function be64Out() {
    return function (state) {
      var out = new Uint8Array(64);
      for (var i = 0; i < 8; i++) {
        var v = state[i];
        for (var j = 7; j >= 0; j--) { out[i * 8 + j] = Number(v & 0xffn); v >>= 8n; }
      }
      return out;
    };
  }

  function create(algName) {
    var A = ALGS[algName];
    if (!A) throw new Error('不支持的哈希算法：' + algName);
    var state = A.init();
    var buf = new Uint8Array(A.blockSize);
    var bufLen = 0, total = 0;
    function process(u8, start, end) {
      var p = start;
      while (p < end) {
        var take = Math.min(A.blockSize - bufLen, end - p);
        buf.set(u8.subarray(p, p + take), bufLen);
        bufLen += take; p += take;
        if (bufLen === A.blockSize) { A.block(state, buf, 0); bufLen = 0; }
      }
    }
    return {
      update: function (u8) { total += u8.length; process(u8, 0, u8.length); return this; },
      blockSize: A.blockSize,
      digest: function () {
        var bits = total * 8;
        var lenLen = algName === 'sha512' ? 16 : 8;
        var pad = new Uint8Array(bufLen <= A.blockSize - 1 - lenLen ? A.blockSize - bufLen : A.blockSize * 2 - bufLen);
        pad[0] = 0x80;
        // 长度字段：md5 小端 8 字节，其余大端（sha512 为 16 字节，用 BigInt 全量写入）
        var bitsHi = Math.floor(bits / 0x100000000); // ≥512MiB 输入时高位非 0
        if (algName === 'sha512') {
          var lenBytes = new Uint8Array(16);
          var v = BigInt(bits);
          for (var j = 15; j >= 0; j--) { lenBytes[j] = Number(v & 0xffn); v >>= 8n; }
          pad.set(lenBytes, pad.length - 16);
        } else if (algName === 'md5') {
          pad[pad.length - 8] = bits & 0xff; pad[pad.length - 7] = (bits >>> 8) & 0xff;
          pad[pad.length - 6] = (bits >>> 16) & 0xff; pad[pad.length - 5] = (bits >>> 24) & 0xff;
          pad[pad.length - 4] = bitsHi & 0xff; pad[pad.length - 3] = (bitsHi >>> 8) & 0xff;
          pad[pad.length - 2] = (bitsHi >>> 16) & 0xff; pad[pad.length - 1] = (bitsHi >>> 24) & 0xff;
        } else {
          pad[pad.length - 8] = (bitsHi >>> 24) & 0xff; pad[pad.length - 7] = (bitsHi >>> 16) & 0xff;
          pad[pad.length - 6] = (bitsHi >>> 8) & 0xff; pad[pad.length - 5] = bitsHi & 0xff;
          pad[pad.length - 4] = (bits >>> 24) & 0xff; pad[pad.length - 3] = (bits >>> 16) & 0xff;
          pad[pad.length - 2] = (bits >>> 8) & 0xff; pad[pad.length - 1] = bits & 0xff;
        }
        process(pad, 0, pad.length);
        var out = A.out(state);
        return out;
      },
      digestHex: function () { return toHex(this.digest()); }
    };
  }
  function toHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  /* ---------- SM3（GB/T 32907-2016，按原始字节输入；vendor sm-crypto 的 sm3 只收字符串） ---------- */
  var SM3_IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
  function sm3Rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  function sm3Bytes(data) {
    var len = data.length, bitLen = len * 8;
    var zeros = (64 - ((len + 9) % 64)) % 64;
    var msg = new Uint8Array(len + 1 + zeros + 8);
    msg.set(data);
    msg[len] = 0x80;
    for (var j = 0; j < 4; j++) {
      msg[msg.length - 8 + j] = (Math.floor(bitLen / 0x100000000) >>> (24 - 8 * j)) & 0xff;
      msg[msg.length - 4 + j] = (bitLen >>> (24 - 8 * j)) & 0xff;
    }
    var V = SM3_IV.slice();
    var W = new Array(68);
    for (var off = 0; off < msg.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) W[i] = ((msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3]) >>> 0;
      for (i = 16; i < 68; i++) {
        var t = W[i - 16] ^ W[i - 9] ^ sm3Rotl(W[i - 3], 15);
        W[i] = ((t ^ sm3Rotl(t, 15) ^ sm3Rotl(t, 23)) ^ sm3Rotl(W[i - 13], 7) ^ W[i - 6]) >>> 0;
      }
      var A = V[0], B = V[1], C = V[2], D = V[3], E = V[4], F = V[5], G = V[6], H = V[7];
      for (i = 0; i < 64; i++) {
        var T = i < 16 ? 0x79cc4519 : 0x7a879d8a; // 与标准测试向量一致的轮常量（GB/T 32907 实现通用值）
        var SS1 = sm3Rotl((sm3Rotl(A, 12) + E + sm3Rotl(T, i % 32)) >>> 0, 7);
        var SS2 = (SS1 ^ sm3Rotl(A, 12)) >>> 0;
        // GB/T 32907：TT1 用 SS2 + W'，TT2 用 SS1 + W
        var TT1 = ((i < 16 ? (A ^ B ^ C) : ((A & B) | (A & C) | (B & C))) + D + SS2 + (W[i] ^ W[i + 4])) >>> 0;
        var TT2 = ((i < 16 ? (E ^ F ^ G) : ((E & F) | (~E & G))) + H + SS1 + W[i]) >>> 0;
        D = C;
        C = sm3Rotl(B, 9);
        B = A;
        A = TT1;
        H = G;
        G = sm3Rotl(F, 19);
        F = E;
        E = (TT2 ^ sm3Rotl(TT2, 9) ^ sm3Rotl(TT2, 17)) >>> 0;
      }
      V[0] = (V[0] ^ A) >>> 0; V[1] = (V[1] ^ B) >>> 0; V[2] = (V[2] ^ C) >>> 0; V[3] = (V[3] ^ D) >>> 0;
      V[4] = (V[4] ^ E) >>> 0; V[5] = (V[5] ^ F) >>> 0; V[6] = (V[6] ^ G) >>> 0; V[7] = (V[7] ^ H) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (V[i] >>> 24) & 0xff; out[i * 4 + 1] = (V[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (V[i] >>> 8) & 0xff; out[i * 4 + 3] = V[i] & 0xff;
    }
    return out;
  }
  function hash(algName, data) {
    if (algName === 'sm3') return toHex(sm3Bytes(data instanceof Uint8Array ? data : new Uint8Array(data)));
    var h = create(algName);
    h.update(data instanceof Uint8Array ? data : new Uint8Array(data));
    return h.digestHex();
  }

  function hmac(algName, key, msg) {
    var A = ALGS[algName];
    var bs = A.blockSize;
    var k = key instanceof Uint8Array ? key : new Uint8Array(key);
    if (k.length > bs) k = hashBytes(algName, k);
    var kp = new Uint8Array(bs);
    kp.set(k);
    var ip = new Uint8Array(bs), op = new Uint8Array(bs);
    for (var i = 0; i < bs; i++) { ip[i] = kp[i] ^ 0x36; op[i] = kp[i] ^ 0x5c; }
    var inner = create(algName); inner.update(ip); inner.update(msg instanceof Uint8Array ? msg : new Uint8Array(msg));
    var outer = create(algName); outer.update(op); outer.update(inner.digest());
    return outer.digestHex();
  }
  function hashBytes(algName, data) {
    var h = create(algName); h.update(data instanceof Uint8Array ? data : new Uint8Array(data));
    return h.digest();
  }

  return {
    hash: hash, hmac: hmac, create: create, toHex: toHex,
    algs: ['md5', 'sha1', 'sha256', 'sha512'],
    ALGS: ALGS
  };
})();
if (typeof globalThis !== 'undefined') globalThis.Crypto = Crypto;