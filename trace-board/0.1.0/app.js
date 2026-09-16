/* 追溯看板 · 状态与接线
 * 视图渲染：render.js（单会话详情）/ modules.js（四个聚合模块）
 * 数据读取：source.js（含数据源库）  事件模型：analyze.js / aggregate.js
 * 安全底线：trace 内容是不可信输入，一律 textContent 注入，不拼 innerHTML。
 */
(function () {
  'use strict';

  var S = {
    module: 'baseline',
    subTab: 'timeline',
    reader: null,
    index: null,
    entry: null,
    session: null,
    events: null,
    model: null,
    loadToken: 0,        // 会话异步载入的时序闸：响应回来时序号对不上就丢弃，防连点两个会话后 model 与 session 错配
    loadingSession: false,
    loadingSource: false,
    pollTimer: null,     // 会话详情自动刷新的 interval 句柄（null = 没在轮询）
    pollBusy: false,     // 上一次探针/重读还没回来就先跳过本轮，防慢 IO 时轮询自己叠自己
    pollLastLen: -1,     // 探针基线：上次读到的 events.jsonl 文本长度（-1 = 尚无基线，下一个 tick 必重读）
    scope: new Set(),
    evo: { month: '全部', kind: '全部' },
    pit: { status: '全部', category: '全部', sort: 'newest' },
    led: { severity: '全部' },
    query: '',
    activeNote: null,
    library: [],
    drawer: null,
    theme: 'light',
  };

  var MODULES = ['baseline', 'evolution', 'pitfalls', 'ledger', 'session'];
  var $ = TraceRender.$;
  var h = TraceRender.h;
  var toast = TraceRender.toast;
  var setStatus = TraceRender.setStatus;

  /* ── 统计范围 ───────────────────────────────────────────────── */

  function inScope(s) {
    if (!S.scope.size) return false;   // 空集 = 用户显式全不选
    return S.scope.has(s.dir);
  }

  function initScope() {
    S.scope = new Set((S.index ? S.index.sessions : []).map(function (s) { return s.dir; }));
  }

  function setScope(s, on) {
    if (on) S.scope.add(s.dir);
    else S.scope.delete(s.dir);
    TraceRender.renderRail();
    renderActivePane();
  }

  function scopeSessions() {
    if (!S.index) return [];
    return S.index.sessions.filter(inScope);
  }

  function setScopeAll(mode) {
    if (!S.index) return;
    if (mode === 'all') initScope();
    else if (mode === 'none') S.scope = new Set();
    else if (mode === 'bad') {
      // 旧版 aggregate.js 被宿主缓存时没有 isBad，就地兜底回旧口径，别让「仅有问题」直接抛错
      var bad = TraceAggregate.isBad || function (s) {
        var e = s.errors || {};
        return ((e.protocol || 0) + (e.compliance_failed || 0)) > 0;
      };
      S.scope = new Set(S.index.sessions.filter(bad).map(function (s) { return s.dir; }));
    }
    TraceRender.renderRail();
    renderActivePane();
  }

  /* ── 模块切换 ───────────────────────────────────────────────── */

  function setModule(mod) {
    S.module = mod;
    // 离开详情就收轮询：探针每 3s 一次全文读，用户在聚合模块里看板时是纯空转
    if (mod !== 'session') stopPolling();
    // 左轨（统计范围勾选）只服务「会话详情」；其余模块收起左轨让内容满幅，统计范围默认全选不变
    // @see [Agent Note: 左轨只留在会话详情](../../.agents/notes/implemented/simplification/2026-09-16-左轨只留在会话详情.md)
    document.body.classList.toggle('rail-off', mod !== 'session');
    Array.prototype.forEach.call(document.querySelectorAll('#mods .mod'), function (b) {
      var on = b.dataset.mod === mod;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    MODULES.forEach(function (m) { $('pane-' + m).hidden = m !== mod; });
    renderActivePane();
  }

  function renderActivePane() {
    var mod = S.module;
    var pane = $('pane-' + mod);
    if (!pane) return;
    if (mod === 'session') {
      TraceRender.renderSessionShell(pane);
      return;
    }
    TraceRender.clear(pane);
    if (!S.index) {
      if (S.loadingSource) { pane.appendChild(TraceRender.skeleton()); return; }
      // 刷新后目录类来源没法自动重开（浏览器不给长期句柄），空态必须给「上次在用」直达入口，
      // 不然用户对着一卡片空看板不知道从哪进 —— fs/http 类自动重开失败（如未授权）也走这里重试
      // @see [Agent Note: 看板目录条目一键重开](../../.agents/notes/implemented/bug-fix/2026-09-16-看板目录条目一键重开.md)
      var last = S.library[0];
      if (last) {
        var dirHandle = last.kind === 'dir' && last.hasHandle;
        var isDir = last.kind === 'dir' && !dirHandle;
        pane.appendChild(TraceRender.emptyState([
          '还没有载入数据源。',
          dirHandle
            ? '上次在用「' + (last.label || '上次的项目') + '」——点下面一键重开（浏览器可能再要一次授权）。'
            : isDir
              ? '上次在用「' + (last.label || '上次的项目') + '」——目录类要重新选一次目录（内容不变）。'
              : '上次在用「' + (last.label || '上次的数据源') + '」，点下面直接重开。',
        ], {
          icon: 'clock',
          cta: h('button', {
            cls: 'primary-btn',
            text: isDir ? '重新打开：' + (last.label || '') + '（重选目录…）' : '重新打开：' + (last.label || ''),
            onclick: function () { openEntry(last); },
          }),
        }));
        return;
      }
      pane.appendChild(TraceRender.emptyState(['还没有载入数据源。', '点顶栏左侧的按钮打开「数据源库」。'], {
          icon: 'clock',
          cta: h('button', { cls: 'primary-btn', text: '打开数据源库', onclick: function () { openDrawer('library'); } }),
        }));
      return;
    }
    var sessions = scopeSessions();
    // 零会话但带决策笔记的来源（未部署宿主，纯靠 agent 写笔记）也要渲染：
    // 笔记是全库的、不受统计范围约束，四个聚合模块以笔记为主，会话相关视图自然给空态
    if (!sessions.length && !TraceAggregate.noteList(S.index).length) {
      pane.appendChild(TraceRender.emptyState(['统计范围是空的。', '在左轨勾上至少一个会话，或点「全选」。'], {
        icon: 'check',
        cta: h('button', { cls: 'mini-btn', text: '全选', onclick: function () { setScopeAll('all'); } }),
      }));
      return;
    }
    if (mod === 'baseline') TraceModules.renderBaseline(pane, sessions);
    else if (mod === 'evolution') TraceModules.renderEvolution(pane, sessions);
    else if (mod === 'pitfalls') TraceModules.renderPitfalls(pane, sessions);
    else TraceModules.renderLedger(pane, sessions);
  }

  /* ── 会话详情 ───────────────────────────────────────────────── */

  const POLL_MS = 3000;

  async function loadSession(session, wantModule) {
    var token = ++S.loadToken;
    S.session = session;
    S.loadingSession = true;
    TraceRender.renderRail();
    if (wantModule) setModule('session');
    setStatus('正在读取 ' + session.session_id + ' …', 'busy');
    try {
      var events = await TraceSource.loadEvents(S.reader, session);
      if (token !== S.loadToken) return;   // await 期间用户已打开别的会话：本次结果整体丢弃，不与新的竞争赋值
      S.loadingSession = false;
      S.events = events;
      buildModel(session, events);
      if (S.module === 'session') TraceRender.renderSessionShell($('pane-session'));
      var corrupt = session.corrupt_lines || 0;
      setStatus(session.session_id + ' · ' + events.length + ' 事件' +
        (corrupt ? ' · 跳过 ' + corrupt + ' 条损坏行' : '') +
        ' · ' + TraceAnalyze.fmtDuration(S.model.summary.span), 'ready');
      startPolling(session);
    } catch (e) {
      if (token !== S.loadToken) return;
      S.loadingSession = false;
      var why = TraceSource.explain(e);
      setStatus('会话读取失败', 'error');
      toast(why, true);
    }
  }

  function buildModel(session, events) {
    S.events = events;
    S.model = {
      summary: TraceAnalyze.summarize(events, session),
      turns: TraceAnalyze.groupTurns(events),
      methods: TraceAnalyze.methodInventory(events),
      compliance: TraceAnalyze.complianceItems(events),
      rules: null,
      writes: TraceAnalyze.appliedWrites(events),
      commands: TraceAnalyze.executedCommands(events),
      denied: TraceAnalyze.deniedItems(events),
      protocolErrors: TraceAnalyze.protocolErrors(events),
    };
    S.model.rules = TraceAnalyze.rulesUsed(S.model.compliance);
  }

  /* ── 会话详情自动刷新：agent 干活时 events.jsonl 在增长，看板跟着长 ──
   * 探针 = 全文文本长度（spark.fs 没有 stat/watch，见 source.js 头注），长度没变就跳过本轮，
   * 变了才整页重读重算。内联源（bundle/粘贴）事件是死的，不轮询。
   * @see [Agent Note: 会话详情自动刷新](../../.agents/notes/implemented/feature/2026-09-16-会话详情自动刷新.md)
   */
  function startPolling(session) {
    stopPolling();
    if (Array.isArray(session.events)) { S.pollLastLen = -1; return; }   // 内联数据不会变，轮询是纯空转
    S.pollLastLen = -1;
    S.pollTimer = setInterval(function () { pollSessionTick(session); }, POLL_MS);
  }

  function stopPolling() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    S.pollLastLen = -1;
  }

  async function pollSessionTick(session) {
    if (S.pollBusy || S.loadingSession || document.hidden) return;   // 非可见期宿主多半也在挂起，回来后 visibilitychange 补一枪
    S.pollBusy = true;
    try {
      var len = await TraceSource.probeEventsLength(S.reader, session);
      if (len >= 0 && S.pollLastLen === len) return;   // 没长：省掉重读与重渲染
      S.pollLastLen = len;
      if (len < 0) return;
      var token = ++S.loadToken;
      var events = await TraceSource.loadEvents(S.reader, session);   // 文件源必走重读（缓存不变量：文件源不回写 session.events）
      if (token !== S.loadToken || S.session !== session) return;   // 重读期间用户切了会话：丢弃
      buildModel(session, events);
      if (S.module === 'session') TraceRender.renderSessionShell($('pane-session'));
      var corrupt = session.corrupt_lines || 0;
      setStatus(session.session_id + ' · ' + events.length + ' 事件' +
        (corrupt ? ' · 跳过 ' + corrupt + ' 条损坏行' : '') +
        ' · ' + TraceAnalyze.fmtDuration(S.model.summary.span) + ' · 自动刷新 ' + nowClock(), 'ready');
    } catch (e) { /* 一轮探针失败不打断轮询，下一 tick 重试 */ }
    finally {
      S.pollBusy = false;
    }
  }

  function nowClock() {
    var d = new Date();
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.session && S.module === 'session') pollSessionTick(S.session);
  });

  function openSession(session) { return loadSession(session, true); }

  function openSessionByDir(dir) {
    var hit = S.index && S.index.sessions.filter(function (s) { return s.dir === dir; })[0];
    if (hit) openSession(hit);
    else toast('这个会话不在当前数据源里', true);
  }

  /* ── 载入数据源 ─────────────────────────────────────────────── */

  async function loadFrom(desc, options) {
    stopPolling();
    S.loadingSource = true;
    if (!S.index) renderActivePane();   // 首次载入先给骨架；换源失败时旧数据原地保留（骨架只在无数据的窗口期出现）
    setStatus('正在载入 …', 'busy');
    hint('读取中…');
    try {
      var res = await TraceSource.load(desc);
      S.loadingSource = false;
      S.reader = res.reader;
      S.index = res.index;
      S.entry = (options && options.entry) || null;
      S.session = null;
      S.events = null;
      S.model = null;
      initScope();
      hint(res.reader.label + ' · ' + res.index.sessions.length + ' 个会话 · ' + res.notes.join('；'));

      // 入库：本地与远程同一个库，只用 kind 区分
      var rec = TraceSource.fromDesc(desc);
      if (rec) {
        if (desc.kind === 'dir') rec.label = res.reader.label.replace(/^所选目录\s*/, '') || rec.label;
        // FSA 句柄另存句柄库（IndexedDB）：键跟条目键一致，重开时按键取回
        if (desc.kind === 'dir' && desc.handle) await TraceSource.handleSave(TraceSource.entryKey(rec), desc.handle);
        var up = await TraceSource.libUpsert(rec);
        S.library = up.list;
        S.entry = up.entry;
      }
      renderLibrary();
      renderSourceButton();
      TraceRender.renderRail();
      // schema 版本闸门：高于已知版本照常载入，状态栏常驻降级提示，另弹一次 toast 提醒
      var newer = !!res.index.schemaNewer;
      var statusText = res.reader.label + ' · ' + res.index.sessions.length + ' 个会话' +
        (newer ? ' · 索引版本较新，未知字段可能显示不全' : '');
      setStatus(statusText, 'ready');
      if (newer) toast('索引 schema 高于看板已知版本（' + TraceSource.KNOWN_SCHEMA + '），按降级模式展示');
      // 品牌计数与避坑徽章：笔记篇数 + 运行时被拦/合规未过
      var noteCount = TraceAggregate.noteList(res.index).length;
      $('brand-n').textContent = (noteCount ? noteCount + ' 篇笔记 · ' : '') + res.index.sessions.length + ' 会话';
      var pitN = TraceAggregate.noteList(res.index).filter(function (n) { return n.status === 'rejected'; }).length
        + res.index.sessions.reduce(function (acc, s) {
          var c = s.counts || {};
          return acc + ((s.errors || {}).compliance_failed || 0) + Math.max(0, (c.write_attempts || 0) - (c.write_applied || 0));
        }, 0);
      $('n-pit').textContent = pitN ? String(pitN) : '';
      setModule(S.module === 'session' && !res.index.sessions.length ? 'baseline' : S.module);
      if (S.module === 'session') {
        var first = res.index.sessions[0];
        if (first) await loadSession(first, false);
      }
    } catch (e) {
      S.loadingSource = false;
      var why = TraceSource.explain(e);
      if (/合法 JSON/.test(why)) why += '。点「重新载入」重试一次。';
      hint(why, 'bad');
      setStatus('载入失败', 'error');
      toast(why, true);
      if (!S.index) renderActivePane();   // 首次载入失败：把骨架换成空态指引
    }
  }

  function hint(msg, level) {
    var box = $('src-hint');
    box.textContent = msg || '';
    box.className = 'src-hint' + (level ? ' ' + level : '');
  }

  /** 顶栏那个按钮：显示"这是什么类型的来源 + 在看哪个" */
  function renderSourceButton() {
    var kindEl = $('src-kind');
    var labelEl = $('src-label');
    if (!S.reader) {
      kindEl.textContent = '未选择';
      kindEl.className = 'srcbtn-kind none';
      labelEl.textContent = '点这里选一个数据源';
      return;
    }
    kindEl.textContent = TraceSource.KIND_LABEL[S.reader.kind] || S.reader.kind;
    kindEl.className = 'srcbtn-kind';
    labelEl.textContent = (S.entry && (S.entry.label || S.entry.path || S.entry.url)) || S.reader.label || '';
  }

  function idToGo(drawer) {
    if (drawer === 'library') return $('library');
    if (drawer === 'note') return $('note-view');
    return $('help');
  }

  /* ── 笔记详情抽屉 ───────────────────────────────────────────── */

  function renderNoteView() {
    var box = $('note-body');
    TraceRender.clear(box);
    var n = S.activeNote;
    if (!n) return;
    box.appendChild(h('div', { cls: 'note-tags' }, [
      h('span', { cls: 'chip ' + (TraceAggregate.NOTE_STATUS_CLASS[n.status] || 'chip-skip'), text: TraceAggregate.NOTE_STATUS_LABEL[n.status] || n.status }),
      h('span', { cls: 'cat-tag cat-' + n.category, text: TraceAggregate.NOTE_CLASS_LABEL[n.category] || n.category }),
    ]));

    // 文件名即锚点 id：路径展示成注释 callout，一键复制出可直接粘进代码的 @see 行
    if (n.file) {
      box.appendChild(h('div', { cls: 'note-callout' }, [
        h('span', { cls: 'note-callout-path', text: '// Note: 见 ' + n.file }),
        h('button', {
          cls: 'mini-btn note-callout-copy',
          text: '复制反向代码注释',
          onclick: function () { copyText('// @see [Agent Note: ' + (n.title || '') + '](' + n.file + ')'); },
        }),
      ]));
    }

    box.appendChild(h('h2', { cls: 'note-title', text: n.title }));

    var refs = (n.refd_by || []).length;
    var metaBits = [];
    if (n.date) metaBits.push(h('span', { text: n.date }));
    if (n.id) metaBits.push(h('span', { text: '#' + n.id }));
    if (metaBits.length || refs) {
      var meta = h('div', { cls: 'note-meta' });
      metaBits.forEach(function (b, i) {
        if (i) meta.appendChild(h('span', { cls: 'note-meta-dot', text: '·' }));
        meta.appendChild(b);
      });
      if (refs) {
        if (metaBits.length) meta.appendChild(h('span', { cls: 'note-meta-dot', text: '·' }));
        meta.appendChild(h('b', { cls: 'note-meta-refs', text: '被引用 ' + refs + ' 次' }));
      }
      box.appendChild(meta);
    }

    // 正文按 ## 小节拆块渲染：编号 + 标签 + 右侧细线；保持纯文本注入，markdown 不解析（与参考站一致）
    var lines = String(n.body || '').split('\n');
    var secName = null;
    var buf = [];
    var secNo = 0;
    function flush() {
      if (!secName) return;
      secNo++;
      box.appendChild(h('div', { cls: 'note-section' }, [
        h('div', { cls: 'note-sec-head' }, [
          h('span', { cls: 'note-sec-no', text: (secNo < 10 ? '0' : '') + secNo }),
          h('b', { text: secName }),
        ]),
        h('div', { cls: 'note-sec-body', text: buf.join('\n').trim() || '—' }),
      ]));
    }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^##\s/.test(l)) { flush(); secName = l.replace(/^##\s*/, '').trim(); buf = []; }
      else if (secName) buf.push(l);
    }
    flush();

    var allNotes = TraceAggregate.noteList(S.index);
    function linkRow(label, ids, dir) {
      if (!ids || !ids.length) return;
      var btns = [];
      ids.forEach(function (id) {
        var target = allNotes.filter(function (x) { return x.id === id; })[0];
        btns.push(h('button', {
          cls: 'note-link ' + dir,
          text: target ? target.title : id,
          onclick: function () { openNote(target || n); },
        }));
      });
      box.appendChild(h('div', { cls: 'note-linkgroup' }, [
        h('b', { text: label }),
        h('div', { cls: 'note-links' }, btns),
      ]));
    }
    linkRow('引用了这些笔记', n.links, 'up');
    linkRow('被这些笔记引用', n.refd_by, 'down');
  }

  function openNote(note) {
    if (!note) return;
    S.activeNote = note;
    openDrawer('note');
    renderNoteView();
  }

  /* ── 数据源库 ───────────────────────────────────────────────── */

  function renderLibrary() {
    var list = $('lib-list');
    TraceRender.clear(list);
    $('lib-count').textContent = S.library.length ? S.library.length + ' 条' : '空';
    if (!S.library.length) {
      list.appendChild(TraceRender.emptyState(['还没有打开过任何数据源。', '下面选一种添加，之后就会出现在这里。']));
      return;
    }
    // 存储通道如实披露：db 挂了但兜底在 → 说清暂存在哪；两条通道都挂 → 明说不会保留
    var saveMode = TraceSource.lastSaveMode();
    if (saveMode === 'local' || saveMode === 'none') {
      list.appendChild(h('div', { cls: 'row-src', text: saveMode === 'local'
        ? 'spark.db 不可用，库暂存在本页 localStorage（仍能跨刷新）'
        : '两条存储通道都不可用，本次会话添加的记录不会保留' }));
    }
    S.library.forEach(function (e) {
      var active = S.entry && S.entry.id === e.id;
      // 选中态用 row.active（accent 底），不再借用 row.warn 琥珀警示色 —— 选中不是警告，两种语义混用会互相污染
      var row = h('div', { cls: 'row' + (active ? ' active' : ''), dataset: { id: e.id } });
      var acts = h('div', { cls: 'row-acts' });
      acts.appendChild(h('button', {
        cls: 'mini-btn',
        text: e.kind === 'dir' && e.needsReselect ? '重新选择目录…' : '打开',
        onclick: function () { openEntry(e); },
      }));
      acts.appendChild(h('button', {
        cls: 'mini-btn',
        text: e.pinned ? '取消置顶' : '置顶',
        onclick: async function () { S.library = await TraceSource.libTogglePin(e.id); renderLibrary(); },
      }));
      acts.appendChild(h('button', {
        cls: 'mini-btn',
        text: '删除',
        onclick: async function () {
          S.library = await TraceSource.libRemove(e.id);
          if (S.entry && S.entry.id === e.id) S.entry = null;
          renderLibrary();
          toast('已从库里移除');
        },
      }));

      row.appendChild(h('div', { cls: 'row-top' }, [
        // 置顶走中性 chip-dir：绿色只留给「通过/干净」，钉住不是"好"
        h('span', { cls: 'chip chip-dir', text: e.pinned ? '置顶' : TraceSource.KIND_LABEL[e.kind] || e.kind }),
        h('span', { cls: 'row-rule', text: e.label || e.path || e.url || '(未命名)' }),
        h('span', { cls: 'row-stat', text: (e.useCount || 1) + ' 次 · ' + relTime(e.lastUsedAt) }),
      ]));
      if (e.detail) row.appendChild(h('div', { cls: 'row-src', text: e.detail }));
      if (e.needsReselect) {
        row.appendChild(h('div', { cls: 'row-src', text: '浏览器不给目录长期句柄，重开窗口要重新选一次目录（内容不变）' }));
      } else if (e.kind === 'dir' && e.hasHandle) {
        row.appendChild(h('div', { cls: 'row-src', text: '目录句柄已记住：刷新后点「打开」直接重开；浏览器可能再要一次授权，点允许即可' }));
      }
      row.appendChild(acts);
      // 卡片本体可点 = 主操作（打开 / 目录类唤起重选）；点按钮不算点卡片，免得和置顶/删除抢事件
      // @see [Agent Note: 看板目录条目一键重开](../../.agents/notes/implemented/bug-fix/2026-09-16-看板目录条目一键重开.md)
      row.addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('button')) return;
        openEntry(e);
      });
      list.appendChild(row);
    });
  }

  function relTime(ts) {
    if (!ts) return '—';
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }

  // 选择目录优先走 File System Access API：返回的目录句柄能进 IndexedDB，刷新后免重选直达；
  // webkitdirectory 的 File 句柄刷新即失效，只配当老内核兜底
  function pickDirectory() {
    if (window.showDirectoryPicker) {
      window.showDirectoryPicker({ mode: 'read' }).then(function (handle) {
        if (handle) loadFrom({ kind: 'dir', handle: handle });
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return;   // 用户取消，不当作故障
        pickDirectoryLegacy();                       // webview 有函数但被禁：退回 input 选择器
      });
      return;
    }
    pickDirectoryLegacy();
  }

  function pickDirectoryLegacy() {
    var input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', function () {
      if (!input.files || !input.files.length) return;
      loadFrom({ kind: 'dir', files: input.files });
    });
    input.click();
  }

  async function openEntry(entry) {
    if (entry.kind === 'dir') {
      closeDrawer();
      if (entry.hasHandle) {
        var handle = await TraceSource.handleGet(TraceSource.entryKey(entry));
        // requestPermission 必须借这次点击的手势要权 —— 过了这一村就没有下一店，
        // 所以权限流放在 openEntry 里而不是丢给后台
        // @see [Agent Note: 看板目录句柄持久化免重选直达](../../.agents/notes/implemented/bug-fix/2026-09-16-看板目录句柄持久化直达.md)
        if (handle && await TraceSource.ensurePermission(handle)) {
          loadFrom({ kind: 'dir', handle: handle }, { entry: entry });
          return;
        }
        toast(handle ? '没拿到目录访问授权，重新选一次目录' : '记住的目录句柄已失效，重新选一次目录');
        pickDirectory();
        return;
      }
      toast('目录需要重新选一次（浏览器不给长期句柄）');
      pickDirectory();
      return;
    }
    var desc = TraceSource.entryToDesc(entry);
    if (!desc) { toast('这条记录打不开了', true); return; }
    S.entry = entry;
    closeDrawer();
    loadFrom(desc, { entry: entry });
  }

  /* ── 抽屉与遮罩 ─────────────────────────────────────────────── */

  var closeTimer = null;
  function openDrawer(which) {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    S.drawer = which;
    var target = idToGo(which);
    ['library', 'note-view', 'help'].forEach(function (id) {
      $(id).hidden = $(id) !== target;
    });
    $('overlay').hidden = false;
    target.hidden = false;
    $('overlay').classList.remove('closing');
    target.classList.remove('closing');
    if (which === 'library') renderLibrary();
    if (which === 'note') renderNoteView();
    var closer = target.querySelector('.close-row .ghost-btn');
    if (closer) closer.focus();   // 焦点迁入抽屉，Escape/键盘流从这里开始
  }

  function closeDrawer() {
    if (!S.drawer) return;
    var target = idToGo(S.drawer);
    var ov = $('overlay');
    target.classList.add('closing');
    ov.classList.add('closing');
    closeTimer = setTimeout(function () {
      closeTimer = null;
      if (!target.classList.contains('closing')) return;   // 150ms 内又被打开，别误关
      target.hidden = true;
      ov.hidden = true;
      target.classList.remove('closing');
      ov.classList.remove('closing');
      S.drawer = null;
    }, 150);
  }

  /* ── 主题 ───────────────────────────────────────────────────── */

  function applyTheme(next) {
    S.theme = next;
    document.documentElement.setAttribute('data-theme', next);
    // 主题按钮的日/月图标由 CSS（data-theme 选择器 + mask 令牌）切换，这里不再写 textContent
    try { if (window.spark && window.spark.db) window.spark.db.set('theme', next).catch(function () { /* db 挂了走兜底 */ }); } catch (e) { /* 忽略 */ }
    // db 之外同步 localStorage 兜底，理由同数据源库（db 不可用时主题也不能跟着丢）
    // @see [Agent Note: 看板数据源库持久化加 localStorage 兜底](../../.agents/notes/implemented/bug-fix/2026-09-16-看板数据源库持久化兜底.md)
    try { localStorage.setItem(TraceSource.LS_PREFIX + 'theme', JSON.stringify(next)); } catch (e) { /* 忽略 */ }
  }

  /* ── 复制 ───────────────────────────────────────────────────── */

  async function copyText(text, okMsg) {
    try {
      if (window.spark && window.spark.clipboard) await window.spark.clipboard.writeText(String(text));
      else {
        var ta = document.createElement('textarea');
        ta.value = String(text);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(okMsg || '已复制');
    } catch (e) {
      toast('复制失败：' + ((e && e.message) || e), true);
    }
  }

  /* ── 绑定 ───────────────────────────────────────────────────── */

  function bind() {
    $('btn-lib').addEventListener('click', function () { openDrawer('library'); });
    $('lib-close').addEventListener('click', closeDrawer);
    $('note-close').addEventListener('click', closeDrawer);
    $('help-close').addEventListener('click', closeDrawer);
    $('overlay').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.drawer) closeDrawer();
    });

    // 顶栏全局搜索：过滤笔记类视图（承重墙/分类阵列/时间线/清单/避坑卡）
    $('in-search').addEventListener('input', function () {
      S.query = $('in-search').value;
      renderActivePane();
    });
    document.addEventListener('keydown', function (e) {
      // 「/」聚焦搜索框 —— 输入框内不抢，组合键也不抢
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var t = e.target;
        if (t && t.closest && t.closest('input, textarea')) return;
        e.preventDefault();
        $('in-search').focus();
      }
    });

    $('btn-dir').addEventListener('click', function () { closeDrawer(); pickDirectory(); });
    $('btn-path').addEventListener('click', function () {
      var p = $('in-path').value.trim();
      if (!p) { toast('先填项目根路径', true); return; }
      closeDrawer();
      loadFrom({ kind: 'fs', root: p });
    });
    $('btn-url').addEventListener('click', function () {
      var u = $('in-url').value.trim();
      if (!u) { toast('先填远程库地址', true); return; }
      closeDrawer();
      loadFrom({ kind: 'http', url: u });
    });
    $('btn-paste').addEventListener('click', function () {
      var text = $('in-paste').value.trim();
      if (!text) { toast('先粘贴 JSON 内容', true); return; }
      var data;
      try {
        data = TraceSource.parseEntry(text, '粘贴内容');
      } catch (e) {
        var why = TraceSource.explain(e);
        hint(why, 'bad');
        toast(why, true);
        return;
      }
      closeDrawer();
      loadFrom({ kind: 'inline', data: data });
    });
    [['in-path', 'btn-path'], ['in-url', 'btn-url']].forEach(function (pair) {
      $(pair[0]).addEventListener('keydown', function (e) { if (e.key === 'Enter') $(pair[1]).click(); });
    });

    $('btn-reload').addEventListener('click', function () {
      if (!S.reader) { toast('还没载入过数据源', true); return; }
      if (S.entry) openEntry(S.entry);
      else toast('这条来源需要重新选择', true);
    });

    Array.prototype.forEach.call(document.querySelectorAll('#mods .mod'), function (b) {
      b.addEventListener('click', function () { setModule(b.dataset.mod); });
    });

    $('btn-scope-all').addEventListener('click', function () { setScopeAll('all'); });
    $('btn-scope-none').addEventListener('click', function () { setScopeAll('none'); });
    $('btn-scope-bad').addEventListener('click', function () { setScopeAll('bad'); });

    $('btn-theme').addEventListener('click', function () { applyTheme(S.theme === 'dark' ? 'light' : 'dark'); });
    $('btn-help').addEventListener('click', function () { openDrawer('help'); });
  }

  /* ── 启动 ───────────────────────────────────────────────────── */

  async function restoreTheme() {
    try {
      var theme = null;
      if (window.spark && window.spark.db) {
        try { theme = await window.spark.db.get('theme'); } catch (e) { /* 走兜底 */ }
      }
      if (theme !== 'light' && theme !== 'dark') {
        try { theme = JSON.parse(localStorage.getItem(TraceSource.LS_PREFIX + 'theme')); } catch (e) { theme = null; }
      }
      if (theme === 'light' || theme === 'dark') applyTheme(theme);
    } catch (e) { /* 忽略 */ }
  }

  async function restoreLibrary() {
    S.library = TraceSource.libSort(await TraceSource.libLoad());
    renderLibrary();
    // 按最近使用找第一条能自动重开的来源。目录句柄类只在 queryPermission 已放行时才自动重开
    //（requestPermission 要用户手势，启动时没有，硬要必抛 SecurityError）；没放行就留给空态 CTA 去要权
    // @see [Agent Note: 看板目录句柄持久化免重选直达](../../.agents/notes/implemented/bug-fix/2026-09-16-看板目录句柄持久化直达.md)
    for (var i = 0; i < S.library.length; i++) {
      var e = S.library[i];
      if (e.kind === 'dir') {
        if (!e.hasHandle) continue;   // 老 webkitdirectory 条目：没有句柄可恢复，只能等用户点
        var handle = await TraceSource.handleGet(TraceSource.entryKey(e));
        if (!handle || !(await TraceSource.ensurePermission(handle, { request: false }))) continue;
        S.entry = e;
        await loadFrom({ kind: 'dir', handle: handle }, { entry: e });
        return true;
      }
      var desc = TraceSource.entryToDesc(e);
      if (!desc) continue;
      S.entry = e;
      await loadFrom(desc, { entry: e });
      return true;
    }
    return false;
  }

  async function init() {
    // 加载自检：五个全局任一缺失（宿主缓存/加载中断），后面全是难排查的怪象 —— 直接给出可行动指引
    var missing = ['TraceSource', 'TraceAnalyze', 'TraceAggregate', 'TraceRender', 'TraceModules']
      .filter(function (n) { return !window[n]; });
    if (missing.length) {
      document.body.textContent = '';
      var box = document.createElement('div');
      box.style.cssText = 'margin:140px auto 0;max-width:440px;text-align:center;color:#7f8ba1;font:400 13px/1.8 system-ui,sans-serif;';
      box.textContent = '看板脚本没有加载完整（缺少 ' + missing.join('、') + '）。多数是宿主缓存了旧文件：完全关闭本窗口后重新打开即可恢复。';
      document.body.appendChild(box);
      return;
    }
    TraceRender.configure({
      getState: function () { return S; },
      copy: copyText,
      loadDiff: TraceSource.loadDiff,
      openSession: openSession,
      inScope: inScope,
      setScope: setScope,
      setSubTab: function (t) { S.subTab = t; renderActivePane(); },
    });
    TraceModules.configure({
      getState: function () { return S; },
      openSession: openSession,
      openSessionByDir: openSessionByDir,
      openNote: openNote,
      setEvo: function (p) { Object.assign(S.evo, p); renderActivePane(); },
      setPit: function (p) { Object.assign(S.pit, p); renderActivePane(); },
      resetPit: function () { S.pit = { status: '全部', category: '全部', sort: 'newest' }; renderActivePane(); },
      setLed: function (p) { Object.assign(S.led, p); renderActivePane(); },
    });

    bind();
    setModule('baseline');
    renderSourceButton();
    TraceRender.renderRail();
    renderActivePane();
    await restoreTheme();

    var opened = false;
    if (window.spark && window.spark.input && window.spark.input.text) {
      var input = window.spark.input.text.trim();
      if (/^https?:\/\//i.test(input)) { await loadFrom({ kind: 'http', url: input }); opened = true; }
      else if (input) { await loadFrom({ kind: 'fs', root: input }); opened = true; }
    }
    if (!opened) opened = await restoreLibrary();

    var base = opened
      ? '就绪 · 顶栏左侧可切换数据源'
      : (window.spark ? '就绪 · 点顶栏左侧打开数据源库' : '就绪（无宿主环境：用「选择项目目录」）');
    // 刚入库就发现两条通道都存不上时必须点名，不然"刷新即丢"又是无声的
    if (TraceSource.lastSaveMode() === 'none') base += ' · 库存不上，本次选择不会记住';
    setStatus(base, 'ready');
    // 首屏不自动弹抽屉：空态页已有「打开数据源库」引导按钮，再自动弹抽屉会抢走首屏注意力、遮住看板本身
    // @see [Agent Note: 看板首屏降噪与自有 logo](../../.agents/notes/implemented/simplification/2026-09-16-看板首屏降噪与自有-logo.md)
  }

  /* ── 页面加固：屏蔽默认右键菜单与浏览器快捷键 ───────────────── */

  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
    e.preventDefault();
  });

  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var editing = e.target && e.target.closest && e.target.closest('input, textarea');
    // DevTools / 打印 / 刷新：任何焦点都拦（F12、F5、Ctrl+Shift+I/J/C、Ctrl+P）
    if (k === 'f12' || k === 'f5' ||
        (e.shiftKey && (e.ctrlKey || e.metaKey) && (k === 'i' || k === 'j' || k === 'c')) ||
        ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'p')) {
      e.preventDefault();
      return;
    }
    // Ctrl+R：输入框/文本域内放行；其余位置（会整页刷新）拦截
    if (!editing && (e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'r') {
      e.preventDefault();
    }
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 供冒烟测试断言用（不参与业务）
  globalThis.__traceBoard = {
    state: S,
    setModule: setModule,
    loadFrom: loadFrom,
    openEntry: openEntry,
    openSession: openSession,
    scopeSessions: scopeSessions,
    setScopeAll: setScopeAll,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
  };
})();
