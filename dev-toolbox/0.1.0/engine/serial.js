/* serial.js — 序列化转换引擎：JSON ↔ XML / YAML / PHP数组 / PHP序列化 / properties */
var Serial = (function () {
  'use strict';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  /* ---------- XML ---------- */
  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function jsonToXml(v, rootName, indentSize) {
    var out = ['<?xml version="1.0" encoding="utf-8"?>'];
    function emit(tag, val, indent, isArrayItem) {
      var pad = ' '.repeat(indent * indentSize);
      if (Array.isArray(val)) {
        for (var item of val) emit(tag, item, indent, true);
        return;
      }
      if (isObj(val)) {
        var attrs = '';
        var rest = {};
        for (var k in val) {
          if (k.charAt(0) === '@') attrs += ' ' + k.slice(1) + '="' + escXml(val[k]) + '"';
          else rest[k] = val[k];
        }
        var keys = Object.keys(rest);
        if (!keys.length) { out.push(pad + '<' + tag + attrs + ' />'); return; }
        out.push(pad + '<' + tag + attrs + '>');
        for (var k2 of keys) {
          if (k2 === '#text') { out.push(pad + ' '.repeat(indentSize) + escXml(rest[k2])); continue; }
          emit(k2, rest[k2], indent + 1);
        }
        out.push(pad + '</' + tag + '>');
        return;
      }
      out.push(pad + '<' + tag + '>' + escXml(val === null || val === undefined ? '' : val) + '</' + tag + '>');
    }
    emit(rootName || 'root', v, 0);
    return out.join('\n');
  }
  function parseXml(s) {
    s = String(s == null ? '' : s).trim().replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    var i = 0;
    function decodeEnt(t) {
      return t.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
        .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(+d); })
        .replace(/&(amp|lt|gt|quot|apos);/g, function (m, n) { return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n]; });
    }
    function parseNode(endTag) {
      var obj = {};
      var textParts = [];
      while (i < s.length) {
        if (s[i] !== '<') {
          var lt = s.indexOf('<', i);
          if (lt < 0) { textParts.push(decodeEnt(s.slice(i).trim())); i = s.length; break; }
          textParts.push(decodeEnt(s.slice(i, lt).trim()));
          i = lt; continue;
        }
        if (s.startsWith('<![CDATA[', i)) {
          var ce = s.indexOf(']]>', i + 9);
          if (ce < 0) { textParts.push(s.slice(i + 9)); i = s.length; break; }
          textParts.push(s.slice(i + 9, ce));
          i = ce + 3; continue;
        }
        var gt = s.indexOf('>', i);
        if (gt < 0) break;
        var tag = s.slice(i + 1, gt);
        if (tag[0] === '/') {
          i = gt + 1;
          return { obj: obj, text: textParts.filter(Boolean).join(' ') };
        }
        var nameM = tag.match(/^([^\s/>]+)/);
        var name = nameM ? nameM[1] : '';
        var self = /\/\s*$/.test(tag);
        var attrs = {};
        var am, re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        while ((am = re.exec(tag))) attrs[am[1]] = decodeEnt(am[3] !== undefined ? am[3] : am[4]);
        i = gt + 1;
        var child = { '#': null };
        if (!self) {
          var inner = parseNode(name);
          child = inner.obj;
          var txt = inner.text;
          if (txt) child['#'] = txt;
        }
        var val;
        var childKeys = Object.keys(child).filter(function (k) { return k !== '#'; });
        var ownText = child['#'];
        delete child['#'];
        if (self) {
          val = Object.keys(attrs).length ? attrs : '';
        } else if (!childKeys.length && Object.keys(attrs).length === 0) {
          val = ownText || '';
        } else {
          val = child;
          for (var ak in attrs) val['@' + ak] = attrs[ak];
          if (ownText) val['#'] = ownText;
        }
        if (obj[name] === undefined) obj[name] = val;
        else if (Array.isArray(obj[name])) obj[name].push(val);
        else obj[name] = [obj[name], val];
      }
      return { obj: obj, text: textParts.filter(Boolean).join(' ') };
    }
    var root = parseNode(null);
    var keys = Object.keys(root.obj);
    return keys.length === 1 ? root.obj[keys[0]] : root.obj;
  }
  function xmlToJson(s) { return JSON.stringify(parseXml(s), null, 2); }

  /* ---------- YAML（依赖 vendor jsyaml） ---------- */
  function yaml() {
    var g = typeof window !== 'undefined' ? window : globalThis;
    if (!g.jsyaml) throw new Error('js-yaml 未加载（assets/vendor/jsyaml.js）');
    return g.jsyaml;
  }
  function jsonToYaml(v) {
    var opts = { indent: 2, lineWidth: 120, noRefs: true };
    return yaml().dump(v, opts);
  }
  function yamlToJson(s) { var docs = yaml().loadAll(String(s)); return JSON.stringify(docs.length ? docs[0] : null, null, 2); } // 多文档取首段，与工具提示一致

  /* ---------- PHP 数组 ---------- */
  function jsonToPhp(v, opt) {
    opt = opt || {};
    var long = opt.style === 'array';
    function gen(val, indent) {
      if (val === null) return 'null';
      if (val === true) return 'true';
      if (val === false) return 'false';
      if (typeof val === 'number') return String(val);
      if (typeof val === 'string') return "'" + val.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
      var pad = ' '.repeat(indent * (opt.indent || 4));
      var padIn = ' '.repeat((indent + 1) * (opt.indent || 4));
      var entries = [];
      var isList = Array.isArray(val);
      var keys = isList ? val.map(function (_, i) { return i; }) : Object.keys(val);
      var sequential = Array.isArray(val) && keys.every(function (k, i) { return k === i; });
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var key;
        if (isList && sequential) key = k;
        else key = typeof k === 'string' ? "'" + k.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" : k;
        entries.push(padIn + (isList && sequential ? '' : key + ' => ') + gen(isList ? val[i] : val[k], indent + 1) + ',');
      }
      if (!entries.length) return long ? 'array()' : '[]';
      var open = long ? 'array(' : '[';
      var close = long ? ')' : ']';
      return open + '\n' + entries.join('\n') + '\n' + pad + close;
    }
    return gen(v, 0);
  }
  function phpToJson(s) {
    s = String(s == null ? '' : s).trim();
    var i = 0;
    function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
    function parseValue() {
      ws();
      if (s[i] === undefined) throw new Error('PHP 数组语法意外结束');
      var c = s[i];
      if (c === '[' || (s.startsWith('array', i) && /[(]/.test(s[i + 5] || ''))) {
        var isLong = c !== '[';
        i += isLong ? 5 : 1;
        if (isLong && s[i] !== '(') throw new Error('array 后缺少 (');
        i++; // (
        var obj = {}, arr = [], idx = 0, seenKey = false;
        ws();
        if (s[i] === ')' || s[i] === ']') { i++; return isLong && !seenKey ? [] : (isLong ? obj : arr); }
        while (true) {
          ws();
          var key = parseValue();
          ws();
          var val;
          if (s[i] === '=' && s[i + 1] === '>') { i += 2; ws(); val = parseValue(); }
          else { val = key; key = idx++; }
          if (typeof key === 'number') arr[+key] = val;
          else obj[key] = val;
          ws();
          if (s[i] === ',') { i++; ws(); if (s[i] === ')' || s[i] === ']') { i++; break; } continue; }
          if (s[i] === ')' || s[i] === ']') { i++; break; }
          throw new Error('PHP 数组语法错误：位置 ' + i + ' 附近缺少 , 或 )');
        }
        if (Object.keys(obj).length) { for (var k in arr) if (!isNaN(+k)) obj[+k] = arr[+k]; return obj; }
        return arr;
      }
      if (c === '"' || c === "'") {
        var quote = c, out = '';
        i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\') { var nx = s[i + 1]; out += ({ n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0' }[nx] !== undefined ? { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0' }[nx] : nx); i += 2; continue; }
          out += s[i]; i++;
        }
        i++;
        return out;
      }
      if (c === '-' || /[0-9]/.test(c)) {
        var j = i; if (c === '-') i++;
        while (i < s.length && /[0-9.eE+]/.test(s[i])) i++;
        var numStr = s.slice(j, i);
        return numStr.indexOf('.') >= 0 ? parseFloat(numStr) : parseInt(numStr, 10);
      }
      if (s.startsWith('true', i)) { i += 4; return true; }
      if (s.startsWith('false', i)) { i += 5; return false; }
      if (s.startsWith('null', i)) { i += 4; return null; }
      if (s.startsWith('NULL', i)) { i += 4; return null; }
      // 裸字符串键（PHP 允许无引号常量键）
      var m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (m) { i += m[0].length; return m[0]; }
      throw new Error('PHP 数组语法错误：位置 ' + i + ' 无法识别 ' + JSON.stringify(s[i]));
    }
    var v = parseValue();
    return JSON.stringify(v, null, 2);
  }

  /* ---------- PHP serialize ---------- */
  function jsonToPhpSerialize(v) {
    function ser(val) {
      if (val === null) return 'N;';
      if (typeof val === 'boolean') return 'b:' + (val ? 1 : 0) + ';';
      if (typeof val === 'number') {
        if (Number.isInteger(val)) return 'i:' + val + ';';
        var d = String(val);
        return 'd:' + d + ';';
      }
      if (typeof val === 'string') return 's:' + byteLen(val) + ':"' + val + '";';
      if (Array.isArray(val)) {
        var items = [];
        for (var i = 0; i < val.length; i++) items.push(ser(i) + ser(val[i]));
        return 'a:' + val.length + ':{' + items.join('') + '}';
      }
      var keys = Object.keys(val);
      var items2 = [];
      for (var k of keys) items2.push(ser(k) + ser(val[k]));
      return 'a:' + keys.length + ':{' + items2.join('') + '}';
    }
    return ser(v);
  }
  function byteLen(s) {
    var n = 0;
    var b = Codec.utf8ToBytes(s);
    return b.length;
  }
  function phpSerializeToJson(s) {
    var src = Codec.utf8ToBytes(String(s == null ? '' : s).trim());
    var i = 0;
    function peekByte() { return src[i]; }
    function expectByte(b) {
      if (src[i] !== b) throw new Error('PHP serialize 语法错误：位置 ' + i + ' 期望 ' + String.fromCharCode(b));
      i++;
    }
    function expectStr(str) { for (var c = 0; c < str.length; c++) expectByte(str.charCodeAt(c)); }
    function readBytes(n) {
      if (i + n > src.length) throw new Error('PHP serialize 语法错误：意外结束');
      var out = src.subarray(i, i + n);
      i += n;
      return out;
    }
    function readDigits() {
      var start = i;
      if (src[i] === 0x2d) i++; // 负号
      while (i < src.length && src[i] >= 48 && src[i] <= 57) i++;
      return Codec.bytesToUtf8(src.subarray(start, i));
    }
    function parseVal() {
      var t = peekByte();
      i++; // 类型字符
      if (t === 0x4e) { expectByte(0x3b); return null; } // N;
      if (t === 0x62) { expectByte(0x3a); var bv = peekByte(); i += 2; return bv === 0x31; } // b:1;
      if (t === 0x69) { expectByte(0x3a); var ivv = readDigits(); expectByte(0x3b); return parseInt(ivv, 10); } // i:n;
      if (t === 0x64) { expectByte(0x3a); var ds = ''; while (src[i] !== 0x3b) ds += String.fromCharCode(src[i++]); i++; return parseFloat(ds); } // d:n;
      if (t === 0x73) { // s:len:"...";
        expectByte(0x3a);
        var len = parseInt(readDigits(), 10);
        expectByte(0x3a); expectByte(0x22);
        var raw = readBytes(len);
        expectByte(0x22); expectByte(0x3b);
        return Codec.bytesToUtf8(raw);
      }
      if (t === 0x61) { // a:count:{key val ...}
        expectByte(0x3a);
        var count = parseInt(readDigits(), 10);
        expectByte(0x3a); expectByte(0x7b);
        var obj = {}, isList = true;
        for (var k = 0; k < count; k++) {
          var key = parseVal();
          var val = parseVal();
          obj[key] = val;
          if (key !== k) isList = false;
        }
        expectByte(0x7d);
        if (isList && count > 0) { var arr = []; for (var x = 0; x < count; x++) arr.push(obj[x]); return arr; }
        return obj;
      }
      throw new Error('PHP serialize 语法错误：未知类型 ' + String.fromCharCode(t) + '，位置 ' + (i - 1));
    }
    return JSON.stringify(parseVal(), null, 2);
  }

  /* ---------- properties ---------- */
  function jsonToProps(v, opt) {
    opt = opt || {};
    var out = [];
    function walk(obj, prefix) {
      for (var k in obj) {
        var key = prefix ? prefix + (opt.sep || '.') + k : k;
        var val = obj[k];
        if (isObj(val)) walk(val, key);
        else if (Array.isArray(val)) {
          if (opt.array === 'comma') out.push(key + '=' + val.join(','));
          else for (var i = 0; i < val.length; i++) {
            if (isObj(val[i])) walk(val[i], key + '[' + i + ']');
            else out.push(key + '[' + i + ']=' + toPropStr(val[i]));
          }
        } else out.push(key + '=' + toPropStr(val));
      }
    }
    function toPropStr(v2) {
      if (v2 === null || v2 === undefined) return '';
      if (typeof v2 === 'boolean') return v2 ? 'true' : 'false';
      // .properties 以 \ 为转义符：值里的反斜杠/换行/制表必须转义，否则结构被破坏
      return String(v2).replace(/\\/g, '\\\\').replace(/[\r\n]+/g, '\\n').replace(/\t/g, '\\t');
    }
    walk(v, '');
    return out.join('\n') + '\n';
  }
  function propsToJson(s, opt) {
    opt = opt || {};
    var nested = opt.nested !== false;
    var root = {};
    var lines2 = String(s == null ? '' : s).split(/\r\n|\r|\n/);
    for (var ln of lines2) {
      var t = ln.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) continue;
      var eq = t.search(/[=:]/);
      if (eq < 0) continue;
      var key = t.slice(0, eq).trim();
      var val = t.slice(eq + 1).trim();
      // 反转义
      val = val.replace(/\\([=:\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      key = key.replace(/\\([=:\\])/g, '$1');
      if (!nested) { root[key] = val; continue; }
      var parts = key.split(opt.sep || '.');
      var cur = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var p = parts[i];
        if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
        cur = cur[p];
      }
      var last = parts[parts.length - 1];
      var arrM = last.match(/^(.+)\[(\d+)\]$/);
      if (arrM) {
        var an = arrM[1], idx = +arrM[2];
        if (!(an in cur) || !Array.isArray(cur[an])) cur[an] = [];
        cur[an][idx] = val;
      } else cur[last] = val;
    }
    return JSON.stringify(root, null, 2);
  }

  return {
    jsonToXml: jsonToXml, parseXml: parseXml, xmlToJson: xmlToJson,
    jsonToYaml: jsonToYaml, yamlToJson: yamlToJson,
    jsonToPhp: jsonToPhp, phpToJson: phpToJson,
    jsonToPhpSerialize: jsonToPhpSerialize, phpSerializeToJson: phpSerializeToJson,
    jsonToProps: jsonToProps, propsToJson: propsToJson
  };
})();
if (typeof globalThis !== 'undefined') globalThis.Serial = Serial;