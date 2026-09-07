/* netcalc.js — IP 网络计算器：CIDR/掩码分析、进制表示、地址分类 */
var NetCalc = (function () {
  'use strict';

  function ipToInt(ip) {
    var m = String(ip == null ? '' : ip).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) throw new Error('IPv4 格式不正确：' + ip);
    var v = 0;
    for (var i = 1; i <= 4; i++) {
      var o = +m[i];
      if (o > 255) throw new Error('八位组 ' + m[i] + ' 超出 0-255');
      v = v * 256 + o;
    }
    return v;
  }
  function intToIp(n) {
    n = Number(n);
    if (!(n >= 0 && n <= 4294967295)) throw new Error('整数超出 IPv4 范围');
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  function maskFromPrefix(p) {
    p = Number(p);
    if (!(p >= 0 && p <= 32)) throw new Error('掩码位数须为 0-32');
    if (p === 0) return 0;
    return (0xffffffff << (32 - p)) >>> 0;
  }
  function prefixFromMask(maskInt) {
    if (maskInt === 0) return 0;
    var m = maskInt >>> 0;
    var low = (m & -m) >>> 0;             // 最低位的 1
    if (((m + low) >>> 0) !== 0) throw new Error('子网掩码不连续（不是合法掩码）'); // 连续掩码加最低位必回绕到 0
    var zeros = 0;
    while (!(m & 1)) { zeros++; m >>>= 1; }
    return 32 - zeros;
  }
  function maskToDotted(maskInt) { return intToIp(maskInt >>> 0); }
  function parseCidr(str) {
    var s = String(str == null ? '' : str).trim();
    var ip, prefix;
    var m = s.match(/^([\d.]+)\s*\/\s*(\d{1,2})$/);
    if (m) { ip = m[1]; prefix = +m[2]; }
    else {
      var m2 = s.match(/^([\d.]+)\s+([\d.]+)$/);
      if (m2) { ip = m2[1]; prefix = prefixFromMask(ipToInt(m2[2])); }
      else {
        var m3 = s.match(/^([\d.]+)$/);
        if (m3) { ip = m3[1]; prefix = 32; }
        else throw new Error('请输入 IP/CIDR（如 192.168.1.10/24 或 192.168.1.10 255.255.255.0）');
      }
    }
    return { ip: ip, prefix: prefix };
  }

  function classify(ipInt) {
    if (ipInt >= 0x0a000000 && ipInt <= 0x0affffff) return 'A 类私有 (10.0.0.0/8)';
    if (ipInt >= 0xac100000 && ipInt <= 0xac1fffff) return 'B 类私有 (172.16.0.0/12)';
    if (ipInt >= 0xc0a80000 && ipInt <= 0xc0a8ffff) return 'C 类私有 (192.168.0.0/16)';
    if (ipInt >= 0x7f000000 && ipInt <= 0x7fffffff) return '环回 (127.0.0.0/8)';
    if (ipInt >= 0xa9fe0000 && ipInt <= 0xa9feffff) return '链路本地 (169.254.0.0/16)';
    if (ipInt >= 0xc0000000 && ipInt <= 0xc0000007) return '保留 (0.0.0.0/8 或 224+ 多播边界外)';
    if (ipInt >= 0xe0000000) return '多播/保留 (224.0.0.0/4+)';
    var first = ipInt >>> 24;
    if (first < 128) return 'A 类公网';
    if (first < 192) return 'B 类公网';
    if (first < 224) return 'C 类公网';
    return '保留';
  }

  function subnetInfo(str) {
    var c = parseCidr(str);
    var ipInt = ipToInt(c.ip);
    var mask = maskFromPrefix(c.prefix);
    var network = (ipInt & mask) >>> 0;
    var broadcast = (network | (~mask >>> 0)) >>> 0;
    var total = Math.pow(2, 32 - c.prefix);
    var usable = c.prefix >= 31 ? total : total - 2;
    var firstHost, lastHost;
    if (c.prefix >= 31) { firstHost = network; lastHost = broadcast; }
    else { firstHost = network + 1; lastHost = broadcast - 1; }
    return {
      ip: intToIp(ipInt), prefix: c.prefix,
      network: intToIp(network), broadcast: intToIp(broadcast),
      mask: maskToDotted(mask),
      maskBin: (mask >>> 0).toString(2).padStart(32, '0').replace(/(.{8})(?=.)/g, '$1.'),
      maskHex: '0x' + (mask >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      wildcard: maskToDotted((~mask) >>> 0),
      ipBin: (ipInt >>> 0).toString(2).padStart(32, '0').replace(/(.{8})(?=.)/g, '$1.'),
      ipHex: '0x' + (ipInt >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      ipDec: String(ipInt >>> 0),
      ipOct: '0o' + (ipInt >>> 0).toString(8),
      total: total, usable: usable,
      firstHost: intToIp(firstHost), lastHost: intToIp(lastHost),
      class: classify(ipInt)
    };
  }

  return {
    ipToInt: ipToInt, intToIp: intToIp,
    maskFromPrefix: maskFromPrefix, prefixFromMask: prefixFromMask,
    parseCidr: parseCidr, subnetInfo: subnetInfo, classify: classify
  };
})();
if (typeof globalThis !== 'undefined') globalThis.NetCalc = NetCalc;