/* 硬件天梯 · 数据源层
 * 双源适配(Geekbench Browser / PassMark)+ 归一化 + 兜底链。
 * 出网仅经 spark.net.fetch(host 代理),页面无其它通道。
 * 无 Spark 宿主(net.fetch 缺失)时各源按故障处理,链式降级到缓存/出厂快照。
 */
(function (global) {
  'use strict';

  /* ── 常量 ─────────────────────────────────────────────── */

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  var BASE_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  };

  // 解析结果低于阈值视为该源失效(按 源:类别 分别设)
  var MIN_ITEMS = {
    'geekbench:cpu': 200, 'geekbench:gpu': 30,
    'passmark:cpu': 500, 'passmark:gpu': 500, 'passmark:disk': 500,
    'passmark:ram': 500, 'lainbo:soc': 150
  };
  var HDD_PAGE_DELAY_MS = 200;                                // 硬盘榜逐页抓取礼貌间隔
  var CACHE_MAX_ITEMS = { cpu: 4000, gpu: 4000, disk: 8000, ram: 4000, soc: 400 }; // spark.db 快照条目上限

  var METRIC = {
    'geekbench:cpu': 'Geekbench 多核',
    'geekbench:gpu': 'Geekbench OpenCL',
    'passmark:cpu': 'PassMark CPU Mark',
    'passmark:gpu': 'PassMark G3D Mark',
    'passmark:disk': 'PassMark Disk Rating',
    'passmark:ram': '读速 (GB/s)',
    'lainbo:soc': '安兔兔'
  };

  var SOURCE_LABEL = { geekbench: 'Geekbench', passmark: 'PassMark', lainbo: 'lainbo 天梯' };

  // 设备图标类名 → 厂商显示名(Geekbench device-icon)
  var VENDOR = {
    qualcomm: 'Qualcomm', amd: 'AMD', nvidia: 'NVIDIA', intel: 'Intel',
    apple: 'Apple', mediatek: 'MediaTek', samsung: 'Samsung', unisoc: 'UNISOC',
    hisilicon: 'HiSilicon', google: 'Google', arm: 'Arm'
  };

  // 每类的源优先级(主源在前)
  var CHAIN = {
    cpu: ['geekbench', 'passmark'],
    gpu: ['passmark', 'geekbench'],
    disk: ['passmark'],
    ram: ['passmark'],
    soc: ['lainbo']
  };

  /* ── 小工具 ───────────────────────────────────────────── */

  function decodeEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;|&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function (_, d) {
        return String.fromCharCode(+d);
      });
  }

  function stripTags(html) {
    return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  // '46,454' / '$584.97*' / 'NA' / '—' → number | null
  function parseNum(text) {
    if (text == null) return null;
    var s = stripTags(text).replace(/[,\s]/g, '');
    if (!s || /^(na|n\/a|—|-|\*)$/.test(s)) return null;
    var m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  // 取 tab pane(id='multi-core' 等)的范围:到下一个 pane 或页脚为止
  function slicePane(html, paneId) {
    var start = html.indexOf("id='" + paneId + "'");
    if (start < 0) start = html.indexOf('id="' + paneId + '"');
    if (start < 0) return null;
    var rel = html.slice(start).search(/class=['"]tab-pane|<footer|<\/main|<\/body/i);
    return rel > 0 ? html.slice(start, start + rel) : html.slice(start);
  }

  // 取主数据表格(按 id 属性,大小写不敏感——GPU 页标签是大写)
  function sliceTable(html, tableId) {
    var re = new RegExp('<table[^>]*id=["\']' + tableId + '["\'][^>]*>', 'i');
    var m = html.match(re);
    if (!m) return null;
    var end = html.toLowerCase().indexOf('</table', m.index + m[0].length);
    return end < 0 ? null : html.slice(m.index, end);
  }

  function isoNow() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 插件侧超时兜底:宿主 fetch/db 挂起不决时到点强制失败,防 busy 永久卡死(刷新按钮假死)。
  // 宿主 fetch 预算 25s,插件 30s 只在宿主自身挂死时兜底;db 为本地读写,10s 足够。
  var FETCH_TIMEOUT_MS = 30000;
  var STORE_TIMEOUT_MS = 10000;

  function withTimeout(p, ms, label) {
    return Promise.race([
      Promise.resolve(p),
      new Promise(function (_, rej) {
        setTimeout(function () {
          rej(new Error((label || '操作') + '超时(' + Math.round(ms / 1000) + 's)'));
        }, ms);
      })
    ]);
  }

  // 缓存快照形状校验:schema 演进/脏数据不满足时按无缓存处理,落到出厂快照
  function validSnapshot(s) {
    return !!s && s.schema === 1 && Array.isArray(s.items) &&
      typeof s.count === 'number' &&
      typeof s.fetched_at === 'string' && !isNaN(Date.parse(s.fetched_at));
  }

  function makeSnapshot(cat, source, items, partial) {
    items = items.filter(function (it) { return it && it.n && typeof it.s === 'number'; });
    items.sort(function (a, b) { return b.s - a.s; });
    var capped = items.slice(0, CACHE_MAX_ITEMS[cat] || 4000);
    return {
      schema: 1, category: cat, source: source, metric: METRIC[source + ':' + cat],
      fetched_at: isoNow(), partial: !!partial, count: capped.length, items: capped
    };
  }

  /* ── 解析器 ───────────────────────────────────────────── */

  // Geekbench 图表页:pane 内行 = td.name(a + 可选 .description) + td.score
  // 条目带结构化属性 a(厂商/核心/频率),供对比页逐行展示
  function parseGeekbenchPane(html, paneId) {
    var pane = slicePane(html, paneId);
    if (!pane) return [];
    var items = [];
    var rows = pane.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (var i = 0; i < rows.length; i++) {
      if (/stacked-heading/i.test(rows[i])) continue;
      var name = null, desc = '', score = null, vendor = null;
      var a = rows[i].match(/<a\s[^>]*href=['"][^'"]*['"][^>]*>([\s\S]*?)<\/a>/i);
      if (a) name = stripTags(a[1]);
      var vd = rows[i].match(/class=['"]device-icon\s+([\w-]+)['"]/i);
      if (vd) vendor = VENDOR[vd[1].toLowerCase()] || vd[1];
      var d = rows[i].match(/class=['"]description['"][^>]*>([\s\S]*?)<\/div>/i);
      if (d) desc = stripTags(d[1]);
      var sc = rows[i].match(/class=['"]score['"][^>]*>([\s\S]*?)<\/td>/i);
      if (sc) score = parseNum(sc[1]);
      if (name && score != null) {
        var item = { n: name, s: score };
        var attrs = {};
        if (vendor) attrs['厂商'] = vendor;
        if (desc) {
          item.m = desc;
          var ghz = desc.match(/([\d.]+)\s*GHz/i);
          if (ghz) attrs['频率'] = ghz[1] + ' GHz';
          var cores = desc.match(/\((\d+)\s*cores?\)/i);
          if (cores) attrs['核心'] = +cores[1];
        }
        if (Object.keys(attrs).length) item.a = attrs;
        items.push(item);
      }
    }
    return items;
  }

  // 把副 pane 的同型号分数并进主列表(如 单核/Vulkan/Metal),按型号名精确对齐。
  // minRatio:对齐率低于该值视为页面结构变化,回滚该属性宁缺毋滥;
  // 传 0 = 机会模式(Metal 这类只有部分型号才有的分数,有多少收多少)
  function mergeScores(items, extra, key, minRatio) {
    minRatio = minRatio == null ? 0.5 : minRatio;
    if (!extra.length) return items;
    var map = {};
    for (var i = 0; i < extra.length; i++) map[extra[i].n] = extra[i].s;
    var hit = 0;
    for (var j = 0; j < items.length; j++) {
      var v = map[items[j].n];
      if (v != null) {
        items[j].a = items[j].a || {};
        items[j].a[key] = v;
        hit++;
      }
    }
    if (hit < items.length * minRatio) {
      for (var k = 0; k < items.length; k++) {
        if (items[k].a) delete items[k].a[key];
        if (items[k].a && !Object.keys(items[k].a).length) delete items[k].a;
      }
    }
    return items;
  }

  // PassMark 列表页:cputable 行 = 各列 td;colIdx 指定 score/rank/extra/value/price 列序
  function parsePassmarkTable(html, colIdx) {
    var table = sliceTable(html, 'cputable');
    if (!table) return [];
    var out = [];
    var rows = table.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (var i = 0; i < rows.length; i++) {
      if (/<th\b/i.test(rows[i])) continue;
      var cells = [];
      var tds = rows[i].match(/<td\b[^>]*>([\s\S]*?)<\/td>/gi) || [];
      for (var j = 0; j < tds.length; j++) cells.push(stripTags(tds[j]));
      if (cells.length < 3) continue;
      var name = cells[0];
      var score = parseNum(cells[colIdx.score]);
      if (!name || score == null) continue;
      var meta = [];
      var attrs = {};
      if (colIdx.extra != null && cells[colIdx.extra]) {
        meta.push(colIdx.extraUnit ? cells[colIdx.extra] + colIdx.extraUnit : cells[colIdx.extra]);
        attrs[colIdx.extraKey || '容量'] = colIdx.extraNum ? parseNum(cells[colIdx.extra]) : cells[colIdx.extra];
      }
      if (cells[colIdx.rank]) meta.push('#' + cells[colIdx.rank]);
      if (colIdx.rank != null) {
        var rk = parseNum(cells[colIdx.rank]);
        if (rk != null) attrs['排名'] = rk;
      }
      if (colIdx.value != null) {
        var vv = parseNum(cells[colIdx.value]);
        if (vv != null) attrs['性价比'] = vv;
      }
      if (colIdx.write != null) {
        var wv = parseNum(cells[colIdx.write]);
        if (wv != null) {
          attrs[colIdx.writeKey || '写入'] = wv;
          if (colIdx.writeUnit) meta.push('写入 ' + wv + colIdx.writeUnit);
        }
      }
      if (colIdx.price != null) {
        var pv = parseNum(cells[colIdx.price]);
        if (pv != null) attrs['价格'] = pv;
      }
      var item = { n: name, s: score };
      if (meta.length) item.m = meta.join(' · ');
      if (Object.keys(attrs).length) item.a = attrs;
      out.push(item);
    }
    return out;
  }

  function parseHddPage(html) {
    // 硬盘列序:name, size, rating, rank, value, price
    return parsePassmarkTable(html, { score: 2, rank: 3, extra: 1, value: 4, price: 5 });
  }

  // 从页面发现最大页号:依次取 (of N) 文本、分页 select 的最大 option、pageN 链接,取最大值
  function discoverMaxPage(html) {
    var max = 1, m;
    var of = html.match(/\(of\s+(\d+)\)/i);
    if (of) max = Math.max(max, +of[1]);
    var sel = html.match(/<select[^>]*id=["']pageno["'][^>]*>([\s\S]*?)<\/select>/i);
    if (sel) {
      var opts = sel[1].match(/value=["'](\d+)["']/gi) || [];
      for (var i = 0; i < opts.length; i++) {
        m = opts[i].match(/(\d+)/);
        if (m && +m[1] > max) max = +m[1];
      }
    }
    var re = /hdd-list\/page(\d+)/g;
    while ((m = re.exec(html))) if (+m[1] > max) max = +m[1];
    return max;
  }

  /* ── lainbo 天梯(手机 SoC)───────────────────────────── */

  // 移动 SoC 命名特征:命中过半的 JSON 数组判为手机 SoC 榜
  // (桌面 CPU/GPU 榜不含天玑/麒麟/Exynos 系,Snapdragon X2 笔记本芯片只占少数)
  var SOC_NAME_RE = /(Snapdragon|Dimensity|Helio|Kirin|Tensor|Exynos|Xring|Tiger T\d|SC9863|MT\d{4}|A\d{1,2} (?:Bionic|Fusion))/;
  var SOC_VENDOR = {
    Qualcomm: '高通', Mediatek: '联发科', MediaTek: '联发科', HiSilicon: '海思',
    Samsung: '三星', Apple: '苹果', Google: '谷歌', Unisoc: '紫光展锐', Xiaomi: '小米'
  };

  // 从打包产物里按括号配对抽出所有 JSON.parse(`[...]`) 数组(Vite 单 bundle 混装多个榜单)
  function extractJsonArrays(js) {
    var out = [];
    var idx = 0;
    while (true) {
      var at = js.indexOf('JSON.parse(`', idx);
      if (at < 0) break;
      idx = at + 1;
      var start = js.indexOf('[', at);
      if (start < 0) continue;
      var end = -1, depth = 0, inStr = false, esc = false;
      for (var p = start; p < js.length; p++) {
        var c = js[p];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) { end = p; break; } }
      }
      if (end < 0) continue;
      var arr;
      try { arr = JSON.parse(js.slice(start, end + 1)); } catch (e) { continue; }
      if (Array.isArray(arr) && arr.length) out.push(arr);
    }
    return out;
  }

  // bundle 里混装多个榜单数组(字段统一 nameDetail/mark),按移动芯片关键词命中率识别 SoC 榜
  function parseLainboSoc(js) {
    var cands = extractJsonArrays(js);
    var best = null, bestRatio = 0;
    for (var i = 0; i < cands.length; i++) {
      var arr = cands[i];
      if (arr[0] == null || typeof arr[0] !== 'object' || arr[0].nameDetail == null) continue;
      var hits = 0;
      for (var j = 0; j < arr.length; j++) {
        if (arr[j].nameDetail != null && SOC_NAME_RE.test(String(arr[j].nameDetail))) hits++;
      }
      var ratio = hits / arr.length;
      if (ratio > bestRatio) { bestRatio = ratio; best = arr; }
    }
    if (!best || bestRatio < 0.5 || best.length < 100) return [];
    var out = [];
    for (var k = 0; k < best.length; k++) {
      var it = best[k];
      var name = stripTags(it.nameDetail);
      var s = typeof it.mark === 'number' ? it.mark : parseNum(it.mark);
      if (!name || !(s > 0)) continue;
      var item = { n: name, s: Math.round(s) };
      var vendor = SOC_VENDOR[name.split(' ')[0]];
      if (vendor) {
        item.m = vendor;                       // 行内备注与详情 meta 都能展示厂商
        (item.a = item.a || {})['厂商'] = vendor;
      }
      out.push(item);
    }
    return out;
  }

  /* ── 网络 ─────────────────────────────────────────────── */

  function netFetchText(url) {
    var spark = global.spark;
    if (!spark || !spark.net || typeof spark.net.fetch !== 'function') {
      return Promise.reject(new Error('net.fetch 不可用'));
    }
    // Promise.resolve().then 包一层:net.fetch 同步抛错(如 PERMISSION_DENIED)也归一到 rejection
    var p = Promise.resolve().then(function () {
      return spark.net.fetch(url, { method: 'GET', headers: baseHeaders() });
    }).then(function (resp) {
      if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
      return resp.text();
    });
    return withTimeout(p, FETCH_TIMEOUT_MS, '请求');
  }

  function baseHeaders() {
    return {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
  }

  /* ── 源定义 ───────────────────────────────────────────── */

  var SOURCES = {
    geekbench: {
      cpu: {
        url: 'https://browser.geekbench.com/processor-benchmarks',
        fetchAll: function (ctx) {
          var url = this.url;
          return ctx.fetchText(url).then(function (html) {
            var items = parseGeekbenchPane(html, 'multi-core');
            mergeScores(items, parseGeekbenchPane(html, 'single-core'), '单核');
            if (items.length < MIN_ITEMS['geekbench:cpu']) {
              throw new Error('解析失败(仅 ' + items.length + ' 条)');
            }
            return [makeSnapshot('cpu', 'geekbench', items)];
          });
        }
      },
      gpu: {
        url: 'https://browser.geekbench.com/gpu-benchmarks',
        fetchAll: function (ctx) {
          var url = this.url;
          return ctx.fetchText(url).then(function (html) {
            var items = parseGeekbenchPane(html, 'opencl');
            mergeScores(items, parseGeekbenchPane(html, 'vulkan'), 'Vulkan');
            mergeScores(items, parseGeekbenchPane(html, 'metal'), 'Metal', 0);
            if (items.length < MIN_ITEMS['geekbench:gpu']) {
              throw new Error('解析失败(仅 ' + items.length + ' 条)');
            }
            return [makeSnapshot('gpu', 'geekbench', items)];
          });
        }
      }
    },
    passmark: {
      cpu: {
        url: 'https://www.cpubenchmark.net/cpu-list/',
        fetchAll: function (ctx) {
          var url = this.url;
          return ctx.fetchText(url).then(function (html) {
            var items = parsePassmarkTable(html, { score: 1, rank: 2, value: 3, price: 4 });
            if (items.length < MIN_ITEMS['passmark:cpu']) {
              throw new Error('解析失败(仅 ' + items.length + ' 条)');
            }
            return [makeSnapshot('cpu', 'passmark', items)];
          });
        }
      },
      gpu: {
        url: 'https://www.videocardbenchmark.net/gpu_list.php',
        fetchAll: function (ctx) {
          var url = this.url;
          return ctx.fetchText(url).then(function (html) {
            var items = parsePassmarkTable(html, { score: 1, rank: 2, value: 3, price: 4 });
            if (items.length < MIN_ITEMS['passmark:gpu']) {
              throw new Error('解析失败(仅 ' + items.length + ' 条)');
            }
            return [makeSnapshot('gpu', 'passmark', items)];
          });
        }
      },
      disk: {
        base: 'https://www.harddrivebenchmark.net/hdd-list/',
        fetchAll: function (ctx) {
          var base = this.base;
          return ctx.fetchText(base).then(function (html) {
            var maxPage = discoverMaxPage(html);
            var all = parseHddPage(html);
            if (ctx.onProgress) ctx.onProgress({ page: 1, total: maxPage });
            var seq = Promise.resolve();
            for (var p = 2; p <= maxPage; p++) {
              (function (pageNo) {
                seq = seq.then(function () {
                  return ctx.fetchText(base + 'page' + pageNo).then(function (h2) {
                    var items = parseHddPage(h2);
                    for (var i = 0; i < items.length; i++) all.push(items[i]);
                    if (ctx.onProgress) ctx.onProgress({ page: pageNo, total: maxPage });
                    return delay(HDD_PAGE_DELAY_MS);
                  });
                });
              })(p);
            }
            return seq.then(function () {
              if (all.length < MIN_ITEMS['passmark:disk']) {
                throw new Error('解析失败(仅 ' + all.length + ' 条)');
              }
              return [makeSnapshot('disk', 'passmark', all)];
            }, function (err) {
              // 中途断页:已有整页数据则交出部分快照(partial 标记)
              if (all.length >= MIN_ITEMS['passmark:disk']) {
                return [makeSnapshot('disk', 'passmark', all, true)];
              }
              throw err;
            });
          });
        }
      },
      ram: {
        // 内存榜单页全量(4400+):读速作主分,延迟/写入/价格作参数
        url: 'https://www.memorybenchmark.net/ram_list.php',
        fetchAll: function (ctx) {
          var url = this.url;
          return ctx.fetchText(url).then(function (html) {
            var items = parsePassmarkTable(html, {
              score: 2,                 // Read Uncached (GB/s)
              extra: 1, extraKey: '延迟', extraUnit: ' ns', extraNum: true,
              write: 3, writeKey: '写入', writeUnit: ' GB/s',
              price: 4
            });
            if (items.length < MIN_ITEMS['passmark:ram']) {
              throw new Error('解析失败(仅 ' + items.length + ' 条)');
            }
            return [makeSnapshot('ram', 'passmark', items)];
          });
        }
      }
    },
    lainbo: {
      soc: {
        // cpu-mark.lainbo.com 无数据 API,榜单打包时写死在 Vite 单 bundle 里(文件名带内容哈希,
        // 会随发布变):动态获取 = 首页解析 bundle 引用 → 拉 bundle → 按内容识别 SoC 榜
        home: 'https://cpu-mark.lainbo.com/',
        fetchAll: function (ctx) {
          var home = this.home;
          return ctx.fetchText(home).then(function (html) {
            var m = html.match(/<script[^>]*\ssrc=["']([^"']*assets\/[^"']+\.js)["']/i) ||
              html.match(/<script[^>]*\ssrc=["']([^"']+\.js)["']/i);
            if (!m) throw new Error('首页未找到数据 bundle 引用');
            var src = m[1];
            var origin = home.replace(/^(https?:\/\/[^\/]+).*/, '$1');
            var bundleUrl = /^https?:\/\//i.test(src) ? src
              : origin + '/' + src.replace(/^\.\//, '').replace(/^\//, '');
            return ctx.fetchText(bundleUrl);
          }).then(function (js) {
            var items = parseLainboSoc(js);
            if (items.length < MIN_ITEMS['lainbo:soc']) {
              throw new Error('未识别到手机 SoC 榜(仅 ' + items.length + ' 条)');
            }
            return [makeSnapshot('soc', 'lainbo', items)];
          });
        }
      }
    }
  };

  /* ── 兜底链 ───────────────────────────────────────────── */

  // getSnapshot(cat, {store, allowNetwork, preferredSource, onProgress})
  //   → { snapshot, via: 'network'|'cache'|'builtin'|'none', failures: [{source, error}] }
  function getSnapshot(cat, opts) {
    opts = opts || {};
    var store = opts.store;
    var onProgress = opts.onProgress;
    var allowNetwork = opts.allowNetwork !== false;
    var preferred = opts.preferredSource;
    var failures = [];

    function trySource(srcName) {
      var def = SOURCES[srcName] && SOURCES[srcName][cat];
      if (!def) return Promise.reject(new Error('该源不支持此分类'));
      var ctx = { fetchText: opts.fetchText || netFetchText, onProgress: onProgress };
      return def.fetchAll(ctx);
    }

    var order = (CHAIN[cat] || []).slice();
    if (preferred) {
      order = order.filter(function (s) { return s !== preferred; });
      order.unshift(preferred);
    }

    var chainRun = (opts.allowNetwork === false)
      ? Promise.resolve(null)
      : order.reduce(function (p, srcName) {
          return p.then(function (snaps) {
            if (snaps) return snaps;
            return trySource(srcName).then(function (got) {
              // 缓存写失败只降级为"本次不缓存",不影响已抓到的数据交付
              var persist = null;
              try {
                if (store && store.set) {
                  persist = withTimeout(store.set('snap:' + cat + ':' + srcName, got[0]), STORE_TIMEOUT_MS, '缓存写入');
                }
              } catch (e) {
                persist = Promise.reject(e);
              }
              return Promise.resolve(persist).catch(function () {}).then(function () { return got; });
            }, function (err) {
              failures.push({ source: srcName, error: (err && err.message) || String(err) });
              return null;
            });
          });
        }, Promise.resolve(null));

    return chainRun.then(function (got) {
      if (got) return { snapshot: got[0], via: 'network', failures: failures };
      var chain = CHAIN[cat] || [];
      var lookups = chain.map(function (s) {
        // 缓存读失败/挂起按无缓存处理,链继续落到下一级,不得卡死整条链
        return withTimeout(store.get('snap:' + cat + ':' + s), STORE_TIMEOUT_MS, '缓存读取')
          .catch(function () { return null; });
      });
      return Promise.all(lookups).then(function (snaps) {
        var best = null;
        for (var k = 0; k < snaps.length; k++) {
          if (validSnapshot(snaps[k]) && (!best || snaps[k].fetched_at > best.fetched_at)) best = snaps[k];
        }
        if (best) return { snapshot: best, via: 'cache', failures: failures };
        var builtin = global.HWL_BUILTIN && global.HWL_BUILTIN[cat];
        if (validSnapshot(builtin)) return { snapshot: builtin, via: 'builtin', failures: failures };
        return { snapshot: null, via: 'none', failures: failures };
      });
    });
  }

  var api = {
    getSnapshot: getSnapshot,
    CHAIN: CHAIN,
    SOURCE_LABEL: SOURCE_LABEL,
    METRIC: METRIC,
    _internal: {
      decodeEntities: decodeEntities, stripTags: stripTags, parseNum: parseNum,
      slicePane: slicePane, sliceTable: sliceTable,
      parseGeekbenchPane: parseGeekbenchPane, parsePassmarkTable: parsePassmarkTable,
      parseHddPage: parseHddPage, discoverMaxPage: discoverMaxPage,
      extractJsonArrays: extractJsonArrays, parseLainboSoc: parseLainboSoc,
      mergeScores: mergeScores,
      makeSnapshot: makeSnapshot, SOURCES: SOURCES,
      netFetchText: netFetchText, withTimeout: withTimeout,
      setTimeouts: function (fetchMs, storeMs) {
        if (fetchMs) FETCH_TIMEOUT_MS = fetchMs;
        if (storeMs) STORE_TIMEOUT_MS = storeMs;
      }
    }
  };

  global.HWL_SOURCES = api;
})(typeof window !== 'undefined' ? window : globalThis);