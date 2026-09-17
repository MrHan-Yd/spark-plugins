/* Markdown 查看器 · 文件源层：把三种打开通道统一成同一个 Reader 接口。
 *
 * 三个宿主事实决定了降级矩阵（trace-board source.js 同款调研结论）：
 *   1) spark.fs 只有 read/write，没有目录列举/stat/watch；
 *   2) fs/net 都是纯文本通道（≤10MB），二进制（图片）走 fs.read 必损坏；
 *   3) <input type=file> 单选拿不到兄弟文件，相对路径图片/链接只有目录模式能解析。
 * 所以 canReadBinary() 是 Reader 的能力位，渲染层按它决定图片是渲染还是占位。
 *
 * @see [决策笔记 Reader 通道抽象](../../.agents/notes/implemented/architecture/2026-09-16-mdviewer-reader-channels.md)
 */
var MDV_SOURCE = (function () {
  'use strict';

  var MAX_BYTES = 10 * 1024 * 1024;   // 与宿主 fs.read 单文件上限对齐，File 通道也同限
  var DIR_SCAN_CAP = 2000;            // 目录模式最多登记的文件数，防超大目录撑爆内存

  function norm(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
  }

  function joinPath(a, b) {
    var left = norm(a).replace(/\/+$/, '');
    var right = norm(b).replace(/^\/+/, '');
    if (/^[A-Za-z]:/.test(right) || right.indexOf('//') === 0) return right; // b 本身是绝对路径
    return right ? left + '/' + right : left;
  }

  function dirName(p) {
    var s = norm(p);
    var i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i) : s;
  }

  function baseName(p) {
    var s = norm(p);
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function extName(p) {
    var b = baseName(p);
    var i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i).toLowerCase() : '';
  }

  function err(message, code) {
    var e = new Error(message);
    e.code = code || 'SOURCE_ERROR';
    /* 自产错误的 message 就是用户可读文案：readableErr 按 code 透传，不二次包装 */
    return e;
  }

  /* 自产错误（TOO_LARGE/NO_PATH/NOT_MD 等）自带用户可读 message，直接透传；
     只翻译宿主/IO 类错误 */
  function readableErr(e) {
    if (e && e.info) return e.info;                       // 已是翻译过的 info 对象，不二次包装
    var code = (e && e.code) || String((e && e.message) || e);
    if (code === 'TOO_LARGE' || code === 'NO_PATH' || code === 'NOT_MD' || code === 'UNAVAILABLE' || code === 'EMPTY') {
      return { code: code, title: (e && e.message) || '读取失败', body: '可改用手选文件打开，或检查路径后重试。' };
    }
    if (code === 'PERMISSION_DENIED') return { code: code, title: '未获得读取授权', body: '在 设置 → 插件 → Markdown 查看器 中授权「读取文件」，或手选文件打开。' };
    if (code === 'PERMISSION_SCOPE') return { code: code, title: '文件在授权目录范围外', body: '在 设置 → 插件 → Markdown 查看器 中，把文件所在目录加入读取授权范围，或手选文件打开。' };
    if (/not found|no such|不存在/i.test(String((e && e.message) || ''))) return { code: 'NOT_FOUND', title: '找不到文件', body: '路径不存在。注意需要完整路径（含盘符），或手选文件打开。' };
    return { code: code, title: '无法读取文件', body: '文件不存在、被其它程序占用或读取失败。' };
  }

  /* ── Reader A：spark.fs 按路径读（keyword/regex 通道，需 fs.read） ── */
  function sparkFsReader(path) {
    var root = dirName(path);
    return {
      kind: 'fs',
      label: norm(path),
      name: baseName(path),
      dir: root,
      key: 'fs:' + norm(path).toLowerCase(),
      canReadBinary: function () { return false; },   // fs.read 是纯文本通道，二进制必损坏
      async readText(rel) {
        if (window.spark && window.spark.fs) {
          return await window.spark.fs.read(rel);
        }
        throw err('宿主 spark.fs 不可用（浏览器预览模式）', 'UNAVAILABLE');
      },
      async readBlob() { return null; },              // 无二进制通道，调用方须先看 canReadBinary
      describe: function () { return 'spark.fs 读取，需授权目录范围'; }
    };
  }

  /* ── Reader B：手选单文件（零权限；相对路径无从解析，能力最窄） ── */
  function singleFileReader(file) {
    var name = file.name || '未命名.md';
    return {
      kind: 'file',
      label: name,
      name: name,
      dir: '',
      key: 'file:' + name + ':' + file.size,
      canReadBinary: function () { return false; },
      async readText() {
        if (file.size > MAX_BYTES) throw err('文件超过 10MB（上限 ' + Math.round(MAX_BYTES / 1048576) + 'MB）', 'TOO_LARGE');
        return await file.text();
      },
      async readBlob() { return null; },
      describe: function () { return '手选文件，句柄不持久'; }
    };
  }

  /* ── Reader C：手选目录（零权限；唯一能读二进制图片的通道） ──
     webkitdirectory 的 files 带 webkitRelativePath（<所选目录名>/<子路径>），
     把第一段剥掉当 trace-board 的 prefix 处理，键 = 相对目录根的路径。 */
  function dirReader(fileList) {
    var map = new Map();    // 归一化相对路径 → File
    var count = 0;
    for (var i = 0; i < fileList.length && count < DIR_SCAN_CAP; i++) {
      var f = fileList[i];
      var rel = norm(f.webkitRelativePath || f.name);
      var strip = rel.indexOf('/') >= 0 ? rel.slice(rel.indexOf('/') + 1) : rel;
      if (!strip) continue;
      map.set(strip, f);
      count++;
    }
    var rootLabel = (fileList[0] && norm(fileList[0].webkitRelativePath || '').split('/')[0]) || '所选目录';
    return {
      kind: 'dir',
      label: rootLabel,
      name: '',
      dir: '',
      key: 'dir:' + rootLabel + ':' + fileList.length,
      fileCount: count,
      canReadBinary: function () { return true; },
      hasFile: function (rel) { return map.has(norm(rel)); },
      async readText(rel) {
        var f = map.get(norm(rel));
        if (!f) throw err('目录内找不到文件：' + rel, 'NOT_FOUND');
        if (f.size > MAX_BYTES) throw err('文件超过 10MB（上限 ' + Math.round(MAX_BYTES / 1048576) + 'MB）', 'TOO_LARGE');
        return await f.text();
      },
      async readBlob(rel) {
        var f = map.get(norm(rel));
        return f ? f.slice(0) : null;
      },
      /* 目录模式下「目录里有哪些 md」：用于首页跳转和相对链接解析 */
      listMd: function () {
        var out = [];
        map.forEach(function (f, rel) {
          if (/^\.(md|markdown|mdx)$/.test(extName(rel))) out.push(rel);
        });
        return out.sort();
      },
      describe: function () { return '目录模式，可解析相对图片与站内跳转'; }
    };
  }

  /* ── regex/keyword 通道的候选路径提取 ──
     用户粘贴的路径常带引号/前后杂字；按可信度从高到低试，第一个「读得通」的赢。 */
  function extractCandidates(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return [];
    s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    var out = [];
    var push = function (v) { if (v && out.indexOf(v) < 0) out.push(v); };
    /* 1) 引号成对包裹的整段（最高优先，粘贴习惯） */
    var quoted = String(raw || '').match(/["'“”]([^"'“”]+\.(?:md|markdown|MD|Markdown|MDX|mdx))["'“”]/);
    if (quoted) push(quoted[1]);
    /* 2) 盘符绝对路径 */
    var drive = s.match(/[A-Za-z]:\\[^"”]*?\.(?:md|markdown|mdx)/i);
    if (drive) push(drive[0]);
    /* 3) UNC */
    var unc = s.match(/\\\\[^\s"”]+?\.(?:md|markdown|mdx)/i);
    if (unc) push(unc[0]);
    /* 4) 以 / 或 ~ 开头的 POSIX 路径 */
    var posix = s.match(/(?:~|\/)[^\s"”]+?\.(?:md|markdown|mdx)/);
    if (posix) push(posix[0]);
    /* 5) 相对路径（./x.md、../x.md） */
    var relp = s.match(/(?:\.{1,2}\/)[^\s"”]+?\.(?:md|markdown|mdx)/);
    if (relp) push(relp[0]);
    /* 6) 兜底：最后一个 .md 结尾的 token */
    var m = s.match(/[^\s"”]+\.(?:md|markdown|mdx)/gi);
    if (m && m.length) push(m[m.length - 1]);
    return out;
  }

  /* 试着读通一个候选：成功返回 reader，失败抛最后一个错误（供错误页展示） */
  async function openByPath(raw) {
    var candidates = extractCandidates(raw);
    if (!candidates.length) throw err('没有从输入里解析出 .md 路径', 'NO_PATH');
    var lastErr = null;
    for (var i = 0; i < candidates.length; i++) {
      var p = candidates[i];
      try {
        var r = sparkFsReader(p);
        var text = await r.readText(p);
        if (text == null) throw err('读取结果为空', 'EMPTY');
        r.text = text;
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || err('无法读取', 'SOURCE_ERROR');
  }

  function pickSingleFile(file) {
    if (!file) throw err('未选择文件', 'CANCELLED');
    var ext = extName(file.name);
    if (ext && !/^\.(md|markdown|mdx|txt)$/.test(ext)) {
      throw err('不是 Markdown 文件：' + file.name, 'NOT_MD');
    }
    var r = singleFileReader(file);
    r.pendingFile = file;
    return r;
  }

  function pickDir(fileList) {
    if (!fileList || !fileList.length) throw err('未选择目录', 'CANCELLED');
    return dirReader(fileList);
  }

  return {
    MAX_BYTES: MAX_BYTES,
    norm: norm,
    joinPath: joinPath,
    dirName: dirName,
    baseName: baseName,
    extName: extName,
    readableErr: readableErr,
    extractCandidates: extractCandidates,
    openByPath: openByPath,
    pickSingleFile: pickSingleFile,
    pickDir: pickDir
  };
})();
(typeof window !== 'undefined' ? window : globalThis).MDV_SOURCE = MDV_SOURCE;