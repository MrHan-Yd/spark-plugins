/* 数据源层：把三种来源统一成同一个 Reader 接口。
 *
 * 设计受两条宿主约束直接决定：
 *   1) 插件页不能直接出网 —— 引擎会拦掉页面内一切 http/https，唯一出网通道是 spark.net.fetch
 *      （window.fetch 分支只在浏览器里预览/调试时兜底，正式插件页里根本用不到）。
 *   2) spark.fs 只有 read/write，**没有目录列举** —— 所以「按路径读」必须依赖宿主生成的
 *      index.json 当入口；而「选目录」走 File API，能拿到整棵文件树，反而可以自己扫出索引来。
 */
var TraceSource = (function () {
  'use strict';

  var INDEX_REL = '.agents/trace/index.json';

  /** 看板已认识的 index schema 版本（宿主 trace-index.mjs 写入）。
   * 高于它不拒载、只降级提示 —— 归档通道的价值在"任何时候双击可看"，拒载会把新宿主产物变成不可读。
   * @see [SPEC §5.8 看板入口索引与 digest schema](../../.agents/runner/SPEC.md#58-看板入口索引与-digest-schema)
   */
  var KNOWN_SCHEMA = 1;

  function hasSpark() {
    return !!(window.spark && window.spark.fs && window.spark.net);
  }

  function norm(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
  }

  function joinPath(a, b) {
    var left = norm(a).replace(/\/+$/, '');
    var right = norm(b).replace(/^\/+/, '');
    return right ? left + '/' + right : left;
  }

  function err(message, code) {
    var e = new Error(message);
    e.code = code || 'SOURCE_ERROR';
    return e;
  }

  /* 约定：索引里的会话文件路径一律**相对 trace 根**（宿主就是这么写的，
     HTTP 托管时 base 也正好指向 trace 根）。所以每种 Reader 都要知道自己的 trace 前缀，
     readText(rel) 负责把前缀补上 —— 漏了它就会去项目根找 s_xxx/events.jsonl，必然 404/403。 */

  /* ── Reader A：选目录（File API / File System Access API）────── */

  /** 目录读出器公共部分：键 → File 的映射表建好后，前缀判定与读取全走这里。
   * webkitdirectory 与 FSA 句柄两条路都落到同一张表，避免行为分叉。 */
  function fileTableReader(index, topLabel) {
    var keys = Array.from(index.keys());
    // 选的是项目根 → 前缀是 .agents/trace/；直接选的 trace 目录 → 前缀为空
    var prefix = keys.some(function (k) { return k.indexOf('.agents/trace/') === 0; }) ? '.agents/trace/'
      : keys.some(function (k) { return /^[^/]+\/events\.jsonl$/.test(k); }) ? '' : '.agents/trace/';

    return {
      kind: 'dir',
      label: '所选目录' + (topLabel ? ' ' + topLabel : ''),
      prefix: prefix,
      async readText(rel) {
        var key = prefix + norm(rel);
        var f = index.get(key);
        if (!f) throw err('文件不在所选目录内：' + key, 'NOT_FOUND');
        return await f.text();
      },
      // 项目根相对路径读取（决策笔记在 .agents/notes/，与 trace 平级，不能带 trace 前缀）
      async readProjectText(rel) {
        var f = index.get(norm(rel));
        if (!f) throw err('文件不在所选目录内：' + norm(rel), 'NOT_FOUND');
        return await f.text();
      },
      list() { return keys; },
      hasIndex() { return index.has(prefix + 'index.json'); }
    };
  }

  function dirReader(files) {
    var files_ = Array.prototype.slice.call(files || []);
    var top = '';
    var table = new Map();
    for (var i = 0; i < files_.length; i++) {
      var f = files_[i];
      var rel = norm(f.webkitRelativePath || f.name);
      var seg = rel.split('/');
      if (!top && seg.length > 1) top = seg[0];
      table.set(rel, f);
    }
    // 选择器给的路径带一层顶层目录名，抹掉它，让键与项目内相对路径一致
    var index = new Map();
    table.forEach(function (f, rel) {
      index.set(top && rel.indexOf(top + '/') === 0 ? rel.slice(top.length + 1) : rel, f);
    });
    return fileTableReader(index, top);
  }

  /* ── Reader A'：FSA 目录句柄（File System Access API）───────────
   * 与 webkitdirectory 的本质差别：返回的 FileSystemDirectoryHandle 可以结构化克隆进
   * IndexedDB，刷新后取出来配 queryPermission/requestPermission 就能免重选直达。
   * 没有这条通道时（老内核/被禁）才退回「重新选一次」的死路。 */

  var FSA_FILE_CAP = 50000;

  async function walkFsaDir(dir, base, out, stat) {
    for await (var entry of dir.values()) {
      if (entry.kind === 'file') {
        if (++stat.count > FSA_FILE_CAP) {
          throw err('所选目录文件数超过 ' + FSA_FILE_CAP + '，扫描已中止；请选择更小的目录（如直接选 .agents 所在的项目根）', 'TOO_LARGE');
        }
        out.set(base ? base + '/' + entry.name : entry.name, await entry.getFile());
      } else if (entry.kind === 'directory') {
        await walkFsaDir(entry, base ? base + '/' + entry.name : entry.name, out, stat);
      }
    }
  }

  async function fsaReader(rootHandle) {
    var index = new Map();
    try {
      // 看板只读 .agents/trace 与 .agents/notes：根下有 .agents 就只扫它，
      // 巨型仓库（node_modules/.git）不陪跑；没有 .agents 再整树扫（用户可能直接选了 trace 目录）
      var agents = await rootHandle.getDirectoryHandle('.agents');
      await walkFsaDir(agents, '.agents', index, { count: 0 });
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') throw e;
      index = new Map();
      await walkFsaDir(rootHandle, '', index, { count: 0 });
    }
    return fileTableReader(index, rootHandle.name || '');
  }

  /* ── Reader B：按绝对路径读（spark.fs）──────────────────────── */

  /**
   * Reader B：按绝对路径读（spark.fs）。
   *
   * 这里必须自己把 `.agents/trace/` 补上，因为**索引里的会话文件路径是相对 trace 根**的
   * （宿主就是这么写的，HTTP 托管时 base 也正好指向 trace 根）。
   * 实测踩过：把 base 设成项目根、少拼这一层，去项目根找 `s_xxx/events.jsonl` 必然 403。
   * 用户可能填项目根，也可能直接填到 trace 目录，两种都要认。
   *
   * @see [SPEC §5.5 落盘布局](../../.agents/runner/SPEC.md#55-落盘布局)
   */
  function fsReader(root) {
    var base = norm(root).replace(/\/+$/, '');
    if (!base) throw err('路径为空', 'INVALID_ARGS');
    // 用户可能填项目根，也可能直接填到 trace 目录；两种都认
    var prefix = /\/\.agents\/trace$/.test(base) ? '' : '.agents/trace/';
    return {
      kind: 'fs',
      label: '路径 ' + base,
      base: base,
      prefix: prefix,
      async readText(rel) {
        if (!hasSpark()) throw err('没有宿主环境，无法按路径读文件。请改用「选择项目目录」。', 'UNAVAILABLE');
        return await window.spark.fs.read(joinPath(base, prefix + norm(rel)));
      },
      list() { return null; },
      hasIndex() { return true; }
    };
  }

  /* ── Reader C：HTTP 远程库 ──────────────────────────────────── */

  function httpReader(url) {
    var raw = String(url || '').trim();
    if (!/^https?:\/\//i.test(raw)) throw err('远程库地址要以 http:// 或 https:// 开头', 'INVALID_ARGS');
    var direct = /\.json(\?|#|$)/i.test(raw);
    var base = direct ? raw.replace(/[^/]*$/, '') : raw.replace(/\/+$/, '') + '/';
    var entryUrl = direct ? raw : base + 'index.json';

    async function fetchText(u) {
      var text = null;
      if (hasSpark()) {
        var r = await window.spark.net.fetch(u);
        if (r.status < 200 || r.status >= 300) throw err('HTTP ' + r.status + '：' + u, 'NETWORK_FAILED');
        text = await r.text();
      } else {
        var resp = await fetch(u);
        if (!resp.ok) throw err('HTTP ' + resp.status + '：' + u, 'NETWORK_FAILED');
        text = await resp.text();
      }
      return text;
    }

    return {
      kind: 'http',
      label: direct ? '远程 ' + raw : '远程库 ' + base,
      base: base,
      entryUrl: entryUrl,
      async readText(rel) { return await fetchText(base + norm(rel)); },
      async readEntry() { return await fetchText(entryUrl); },
      list() { return null; },
      hasIndex() { return true; }
    };
  }

  /* ── Reader D：粘贴的 JSON ──────────────────────────────────── */

  function inlineReader(data) {
    return {
      kind: 'inline',
      label: '粘贴的数据',
      async readText(rel) {
        throw err('粘贴模式只有入口数据，没有旁挂文件：' + norm(rel), 'NOT_FOUND');
      },
      list() { return null; },
      hasIndex() { return false; },
      inlineData: data
    };
  }

  /* ── 从文件树自己扫出索引（选目录模式不需要宿主预先生成 index.json）── */

  /* ── 从文件树自己扫出索引（选目录模式不需要宿主预先生成 index.json）── */

  /** 与 runner trace-index.mjs 的 parseNoteText 同构（AGENTS.md §4 骨架）；改字段两边一起改 */
  function parseNoteBody(body, status, category, id, file) {
    var m = body.match(/^#\s*Agent Note:\s*(.+)\s*$/m);
    return {
      id: id,
      file: file,
      status: status,
      category: category,
      date: (id.match(/^\d{4}-\d{2}-\d{2}/) || [null])[0],
      title: m ? m[1].trim() : id,
      body: body.length > 16000 ? body.slice(0, 16000) + '\n…（笔记超长已截断）' : body,
      truncated: body.length > 16000,
      refd_by: [],
      links: [],
    };
  }

  /** 从目录清单扫决策笔记（.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-主题.md）。
   * 引用口径与 runner 一致：其它笔记正文提到本篇 stem 即算被引用，按篇去重。 */
  async function deriveNotesFromListing(reader, rawKeys) {
    var re = /^\.agents\/notes\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2}-.+)\.md$/;
    var metas = [];
    rawKeys.forEach(function (k) {
      var m = re.exec(k);
      if (m) metas.push({ status: m[1], category: m[2], id: m[3], file: k });
    });
    if (!metas.length) return [];
    var notes = [];
    for (var i = 0; i < metas.length; i++) {
      try {
        var text = await reader.readProjectText(metas[i].file);
        notes.push(parseNoteText(text, metas[i].status, metas[i].category, metas[i].id, metas[i].file));
      } catch (e) { /* 单篇读不出来就跳过，不毁整批 */ }
    }
    for (var a = 0; a < notes.length; a++) {
      for (var b = 0; b < notes.length; b++) {
        if (a === b) continue;
        if (notes[b].body.indexOf(notes[a].id) >= 0) notes[a].refd_by.push(notes[b].id);
        if (notes[a].body.indexOf(notes[b].id) >= 0) notes[a].links.push(notes[b].id);
      }
    }
    notes.sort(function (x, y) { return (y.date || '').localeCompare(x.date || '') || x.id.localeCompare(y.id); });
    return notes;
  }

  async function deriveIndexFromListing(reader) {
    var all = reader.list();
    if (!all) return null;
    var prefix = reader.prefix || '';
    // 索引里的路径一律相对 trace 根，所以先从列表键里剥掉前缀
    var keys = all.map(function (r) { return prefix && r.indexOf(prefix) === 0 ? r.slice(prefix.length) : r; });
    var dirs = [];
    var seen = Object.create(null);
    keys.forEach(function (rel) {
      var m = /^(.*)\/events\.jsonl$/.exec(rel);
      if (m && !seen[m[1]]) { seen[m[1]] = 1; dirs.push(m[1]); }
    });
    // 纯笔记来源（未部署追溯宿主，只有 .agents/notes/ 没有任何会话）也要能载入：
    // 会话与笔记任一存在即产出派生索引，两个都缺才判"不认识"
    var notes = await deriveNotesFromListing(reader, all);
    if (!dirs.length && !notes.length) return null;

    var sessions = [];
    for (var i = 0; i < dirs.length; i++) {
      var dir = dirs[i];
      var summary = null;
      var summaryRel = dir + '/summary.json';
      if (keys.indexOf(summaryRel) >= 0) {
        try { summary = JSON.parse(await reader.readText(summaryRel)); } catch (e) { summary = null; }
      }
      var diffPrefix = dir + '/diffs/';
      var diffNames = keys
        .filter(function (r) { return r.indexOf(diffPrefix) === 0 && /\.diff$/.test(r); })
        .map(function (r) { return r.slice(diffPrefix.length); })
        .sort();
      var snapPrefix = dir + '/snapshots/';
      var snaps = keys.filter(function (r) { return r.indexOf(snapPrefix) === 0; }).map(function (r) { return r.slice(snapPrefix.length); });
      sessions.push({
        session_id: (summary && summary.session_id) || dir,
        dir: dir,
        started_at: summary && summary.started_at,
        ended_at: summary && summary.ended_at,
        project_path: summary && summary.project_path,
        policy: summary && summary.policy,
        stop_reason: summary && summary.stop_reason,
        rules_source: summary && summary.rules_source,
        rules_sha256_16: summary && summary.rules_sha256_16,
        counts: (summary && summary.counts) || {},
        errors: (summary && summary.errors) || {},
        failed_rules: (summary && summary.failed_rules) || [],
        protocol_error_methods: (summary && summary.protocol_error_methods) || [],
        files: {
          events: dir + '/events.jsonl',
          summary: keys.indexOf(summaryRel) >= 0 ? summaryRel : null,
          diffs: Object.fromEntries(diffNames.map(function (n) { return [n, dir + '/diffs/' + n]; })),
          snapshots: snaps.map(function (n) { return dir + '/snapshots/' + n; })
        },
        diffNames: diffNames,
        derived: true
      });
    }
    return {
      schema: 1,
      kind: 'spark-trace-index',
      project_path: (sessions[0] && sessions[0].project_path) || reader.label,
      generated_at: Date.now(),
      derived: true,
      notes: notes,
      notes_truncated: false,
      sessions: sessions.sort(function (a, b) { return (b.started_at || 0) - (a.started_at || 0); })
    };
  }

  /* ── 入口 JSON ──────────────────────────────────────────────── */

  function parseEntry(text, source) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw err('入口文件不是合法 JSON（' + source + '）：' + e.message, 'INVALID_ARGS');
    }
    if (!data || !Array.isArray(data.sessions)) {
      throw err('入口文件里没有 sessions 数组，看板认不出这个格式（' + source + '）', 'INVALID_ARGS');
    }
    if (typeof data.schema === 'number' && data.schema > KNOWN_SCHEMA) data.schemaNewer = true;
    return data;
  }

  /* ── 顶层：载入 ─────────────────────────────────────────────── */

  async function load(desc) {
    var reader;
    if (desc.kind === 'dir') reader = desc.handle ? await fsaReader(desc.handle) : dirReader(desc.files);
    else if (desc.kind === 'fs') reader = fsReader(desc.root);
    else if (desc.kind === 'http') reader = httpReader(desc.url);
    else if (desc.kind === 'inline') reader = inlineReader(desc.data);
    else throw err('未知数据源：' + desc.kind, 'INVALID_ARGS');

    var index = null;
    var notes = [];

    if (desc.kind === 'inline') {
      index = parseEntry(JSON.stringify(reader.inlineData), reader.label);
      notes.push('来自粘贴的数据，事件已内联');
    } else if (desc.kind === 'http') {
      var text = await reader.readEntry();
      index = parseEntry(text, reader.entryUrl);
      notes.push(index.kind === 'spark-trace-bundle' ? '远程单文件包（事件已内联）' : '远程索引 + 按需拉取会话文件');
    } else if (desc.kind === 'dir') {
      // 选目录模式：优先用宿主的 index.json，没有就自己扫
      if (reader.hasIndex()) {
        try {
          index = parseEntry(await reader.readText('index.json'), reader.prefix + 'index.json');
          notes.push('使用了目录内的 index.json');
        } catch (e) {
          notes.push('目录内 index.json 不可用（' + e.message + '），改为扫描目录结构');
        }
      } else {
        notes.push('目录内没有 index.json，改为扫描目录结构');
      }
      if (!index) index = await deriveIndexFromListing(reader);
    } else {
      index = parseEntry(await reader.readText('index.json'), reader.prefix + 'index.json');
      notes.push('按路径读取宿主的 index.json');
    }

    if (!index) {
      throw err(
        '这个来源里没找到可识别的追溯数据。期望看到 .agents/trace/index.json、形如 <会话>/events.jsonl 的会话目录，' +
        '或形如 .agents/notes/{状态}/{分类}/yyyy-mm-dd-主题.md 的决策笔记（均在所选目录内）。',
        'NOT_FOUND'
      );
    }

    index.sessions.forEach(function (s) {
      if (!s.dir && s.files && s.files.events) s.dir = norm(s.files.events).replace(/\/events\.jsonl$/, '');
      if (!s.dir) s.dir = s.session_id;
      if (!s.files) s.files = {};
      if (!s.files.events) s.files.events = s.dir + '/events.jsonl';
      if (!Array.isArray(s.diffNames)) s.diffNames = Object.keys(s.files.diffs || {});
    });

    return { reader: reader, index: index, notes: notes };
  }

  /* ── 会话级读取 ─────────────────────────────────────────────── */

  /* 不变量：session.events 非空 ⇔ 事件内联在会话条目里（bundle/粘贴源）。
     文件源不把解析结果写回 session —— 一旦写回，轮询就分不清「内联死数据」和「上一轮的缓存快照」，
     app.js 的 startPolling 靠这个不变量判断要不要轮询。 */

  async function loadEvents(reader, session) {
    if (!session) return [];
    if (Array.isArray(session.events)) return session.events;   // 内联：数据是死的，直接给
    return await readEventsFile(reader, session);
  }

  async function readEventsFile(reader, session) {
    var text = await reader.readText(session.files.events);
    var out = [];
    var badLines = 0;
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try { out.push(JSON.parse(lines[i])); } catch (e) { badLines++; }
    }
    // 坏行跳过可以，静默跳过不行：尾部半行是宿主异常退出的常见产物，计数要随状态栏披露
    session.corrupt_lines = badLines;
    return out;
  }

  /** 字节长度探针：判断「events.jsonl 有没有长」不必整页解析。
   * spark.fs 只有 read/write（没有 stat/watch，source.js 头注），拿不到便宜的字节数，
   * 只能 readText 硬读全文取长度 —— 省掉的是 JSON.parse 与重建渲染，IO 省不掉，轮询时要有数。 */
  async function probeEventsLength(reader, session) {
    if (!session) return -1;
    try {
      return String(await reader.readText(session.files.events)).length;
    } catch (e) { return -1; }
  }

  async function loadDiff(reader, session, name) {
    if (session.diffs_inline && typeof session.diffs_inline[name] === 'string') return session.diffs_inline[name];
    var rel = (session.files.diffs && session.files.diffs[name]) || (session.dir + '/diffs/' + name);
    return await reader.readText(rel);
  }

  async function loadSnapshot(reader, session, name) {
    var rel = (session.files.snapshots && session.files.snapshots.indexOf(name) >= 0)
      ? session.dir + '/snapshots/' + name
      : null;
    if (!rel) throw err('快照不在清单里：' + name, 'NOT_FOUND');
    return await reader.readText(rel);
  }

  /* ── 错误 → 给人看的话 ──────────────────────────────────────── */

  function explain(e) {
    var code = e && e.code;
    var msg = (e && e.message) || String(e);
    if (code === 'PERMISSION_SCOPE') {
      return '路径超出授权范围。按路径读需要先在 设置 → 插件 里把该项目目录加进授权范围；' +
             '或者直接用「选择项目目录…」，那条路不需要授权。';
    }
    if (code === 'PERMISSION_DENIED') {
      return '插件缺少 fs.read / net 权限。请在 设置 → 插件 里为本插件授权后重试。';
    }
    if (code === 'NETWORK_FAILED') {
      return '网络失败：' + msg + '。检查 URL 是否可达、是否 https、响应体是否超过 10MB。';
    }
    if (code === 'NOT_FOUND') return msg;
    if (code === 'INVALID_ARGS') return msg;
    if (code === 'UNAVAILABLE') return msg;
    return msg;
  }

  /* ── 数据源库：本地与远程同一个库，只用 kind 区分 ──────────────
   * 为什么要有库：三种来源做成互斥表单的话，每次都得重新填，也留不下"最近在看哪个项目"。
   * dir 条目分两态：FSA 句柄（showDirectoryPicker）能进 IndexedDB 长期记住，标 hasHandle，
   * 重开免重选；webkitdirectory 老通道拿不到长期句柄，仍标 needsReselect，点它唤起重选。
   *
   * 存储通道：spark.db 优先 + localStorage 兜底，双写双读。实测踩过：只写 spark.db 且把写失败
   * 静默吞掉，db 不可用（浏览器预览/宿主 db 异常）时整个库刷新即丢，用户看到的是「最近使用也没了」；
   * time-converter / hw-ladder 的偏好存储本来就是双写，这里是把看板补齐到同一模式。
   * @see [Agent Note: 看板数据源库持久化加 localStorage 兜底](../../.agents/notes/implemented/bug-fix/2026-09-16-看板数据源库持久化兜底.md)
   * @see [Agent Note: 看板目录句柄持久化免重选直达](../../.agents/notes/implemented/bug-fix/2026-09-16-看板目录句柄持久化直达.md) */

  /* 句柄库与条目库分开：句柄必须存 IndexedDB（结构化克隆才保得住 FileSystemDirectoryHandle），
     localStorage 只存得了普通 JSON，句柄混进条目会被 JSON.stringify 打回空壳 */
  var HDB_NAME = 'trace-board';
  var HDB_STORE = 'handles';

  function hdbOpen() {
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open(HDB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(HDB_STORE); };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error || err('IndexedDB 打不开', 'UNAVAILABLE')); };
    });
  }

  async function handleSave(key, handle) {
    try {
      var db = await hdbOpen();
      await new Promise(function (res, rej) {
        var tx = db.transaction(HDB_STORE, 'readwrite');
        tx.objectStore(HDB_STORE).put(handle, key);
        tx.oncomplete = res;
        tx.onerror = function () { rej(tx.error); };
      });
      return true;
    } catch (e) { return false; }
  }

  async function handleGet(key) {
    try {
      var db = await hdbOpen();
      return await new Promise(function (resolve, reject) {
        var rq = db.transaction(HDB_STORE, 'readonly').objectStore(HDB_STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    } catch (e) { return null; }
  }

  async function handleDrop(key) {
    try {
      var db = await hdbOpen();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(HDB_STORE, 'readwrite');
        tx.objectStore(HDB_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (e) { /* 条目已删，句柄残留无碍 */ }
  }

  /** FSA 句柄授权闸。queryPermission 免手势，requestPermission 必须发生在用户点击的手势里，
     否则抛 SecurityError —— 所以「自动恢复」只查不问（request:false），要权永远留给点击路径。 */
  async function ensurePermission(handle, opts) {
    var mayAsk = !(opts && opts.request === false);
    try {
      if (!handle || typeof handle.queryPermission !== 'function') return true;   // 老内核没有权限查询，直接试读
      if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
      if (!mayAsk) return false;
      return (await handle.requestPermission({ mode: 'read' })) === 'granted';
    } catch (e) { return false; }
  }

  var LIB_KEY = 'sources';
  var LS_PREFIX = 'trace-board:';

  function lsGet(name) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + name);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) { return null; }
  }

  function lsSet(name, value) {
    try { localStorage.setItem(LS_PREFIX + name, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  var KIND_LABEL = { dir: '本地目录', fs: '本地路径', http: '远程库', inline: '粘贴数据' };

  function newId() {
    return 'src_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function entryKey(e) {
    if (e.kind === 'fs') return 'fs:' + norm(e.path).toLowerCase();
    if (e.kind === 'http') return 'http:' + String(e.url || '');
    if (e.kind === 'dir') return 'dir:' + String(e.label || '');
    return 'inline:' + String(e.id || e.addedAt || '');
  }

  /* dbBroken：本会话内 db 一旦写失败就连读也绕开 —— 写挂了的 db 读出来多半是陈旧库，
     会把 localStorage 里更新的数据盖回去，兜底就白做了 */
  var dbBroken = false;
  /* lastSave：最近一次入库的实际落盘结果 'db' | 'local' | 'none'（null=本会话还没存过）。
     落盘失败不再静默：数据源库抽屉按这个如实披露，用户才知道"刷新还在不在" */
  var lastSave = null;

  function lastSaveMode() { return lastSave; }

  async function libLoad() {
    if (!dbBroken && hasSpark() && window.spark.db) {
      try {
        var v = await window.spark.db.get(LIB_KEY);
        if (Array.isArray(v)) return v;
      } catch (e) { /* db 读不动就走兜底 */ }
    }
    var local = lsGet(LIB_KEY);
    return Array.isArray(local) ? local : [];
  }

  async function libSave(list) {
    var okDb = false;
    if (!dbBroken && hasSpark() && window.spark.db) {
      try { await window.spark.db.set(LIB_KEY, list); okDb = true; }
      catch (e) { dbBroken = true; }
    }
    var okLocal = lsSet(LIB_KEY, list);
    lastSave = okDb ? 'db' : (okLocal ? 'local' : 'none');
    return list;
  }

  function libSort(list) {
    return list.slice().sort(function (a, b) {
      return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    });
  }

  /** 入库（已存在则更新使用时间与次数）；返回 {list, entry} */
  async function libUpsert(entry) {
    var list = await libLoad();
    var key = entryKey(entry);
    var now = Date.now();
    var hit = -1;
    for (var i = 0; i < list.length; i++) {
      if (entryKey(list[i]) === key) { hit = i; break; }
    }
    var saved;
    if (hit >= 0) {
      list[hit].lastUsedAt = now;
      list[hit].useCount = (list[hit].useCount || 0) + 1;
      if (entry.label) list[hit].label = entry.label;
      if (entry.detail) list[hit].detail = entry.detail;
      // 同一目录换通道重选（老 webkitdirectory → FSA）：hasHandle 跟着新通道走，老 needsReselect 标记清掉
      if (entry.kind === 'dir') {
        list[hit].hasHandle = !!entry.hasHandle;
        if (list[hit].hasHandle) delete list[hit].needsReselect;
      }
      saved = list[hit];
    } else {
      saved = Object.assign({ pinned: false, useCount: 1, addedAt: now, lastUsedAt: now }, entry, { id: newId() });
      list.unshift(saved);
    }
    // 粘贴的数据可能很大，只留最近几条，避免把 db 撑爆
    var inlines = list.filter(function (e) { return e.kind === 'inline'; });
    if (inlines.length > 5) {
      var keep = {};
      libSort(inlines).slice(0, 5).forEach(function (e) { keep[e.id] = 1; });
      keep[saved.id] = 1;
      list = list.filter(function (e) { return e.kind !== 'inline' || keep[e.id]; });
    }
    await libSave(list);
    return { list: libSort(list), entry: saved };
  }

  async function libRemove(id) {
    var list = await libLoad();
    var dead = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { dead = list[i]; break; }
    // 目录条目连坐：句柄库里那份一起删，不然删掉的条目还在 IDB 里留个孤儿句柄
    if (dead && dead.kind === 'dir') await handleDrop(entryKey(dead));
    list = list.filter(function (e) { return e.id !== id; });
    await libSave(list);
    return libSort(list);
  }

  async function libTogglePin(id) {
    var list = await libLoad();
    list.forEach(function (e) { if (e.id === id) e.pinned = !e.pinned; });
    await libSave(list);
    return libSort(list);
  }

  /** 条目 → load() 的 desc；dir 分两态：FSA 句柄带 key 去句柄库取，老条目返回 null 并说明原因 */
  function entryToDesc(entry) {
    if (entry.kind === 'fs') return { kind: 'fs', root: entry.path };
    if (entry.kind === 'http') return { kind: 'http', url: entry.url };
    if (entry.kind === 'inline') return { kind: 'inline', data: entry.data };
    return null;
  }

  function fromDesc(desc, index) {
    if (desc.kind === 'fs') {
      return { kind: 'fs', label: norm(desc.root), detail: 'spark.fs 读取，需授权目录范围', path: norm(desc.root) };
    }
    if (desc.kind === 'http') {
      return { kind: 'http', label: String(desc.url), detail: 'spark.net.fetch 拉取', url: String(desc.url) };
    }
    if (desc.kind === 'dir') {
      if (desc.handle) {
        // FSA 句柄条目：句柄本体由 loadFrom 存进句柄库，条目里只标 hasHandle
        return { kind: 'dir', label: desc.label || desc.handle.name || '(未命名目录)', detail: '目录句柄已记住，重开免重选（浏览器可能再要一次授权）', hasHandle: true };
      }
      return { kind: 'dir', label: desc.label || '(未命名目录)', detail: '目录选择器授权，重开窗口需重新选择', needsReselect: true };
    }
    if (desc.kind === 'inline') {
      return { kind: 'inline', label: '粘贴的数据 ' + (index ? index.sessions.length + ' 个会话' : ''), detail: '数据内嵌在库里', data: desc.data };
    }
    return null;
  }

  return {
    INDEX_REL: INDEX_REL,
    KNOWN_SCHEMA: KNOWN_SCHEMA,
    KIND_LABEL: KIND_LABEL,
    LS_PREFIX: LS_PREFIX,
    libLoad: libLoad,
    libUpsert: libUpsert,
    libRemove: libRemove,
    libTogglePin: libTogglePin,
    libSort: libSort,
    lastSaveMode: lastSaveMode,
    handleSave: handleSave,
    handleGet: handleGet,
    ensurePermission: ensurePermission,
    fsaReader: fsaReader,
    entryKey: entryKey,
    entryToDesc: entryToDesc,
    fromDesc: fromDesc,
    load: load,
    loadEvents: loadEvents,
    probeEventsLength: probeEventsLength,
    loadDiff: loadDiff,
    loadSnapshot: loadSnapshot,
    deriveIndexFromListing: deriveIndexFromListing,
    parseEntry: parseEntry,
    explain: explain,
    hasSpark: hasSpark,
    joinPath: joinPath,
    norm: norm
  };
})();

globalThis.TraceSource = TraceSource;
