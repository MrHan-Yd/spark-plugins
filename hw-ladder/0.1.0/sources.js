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
    'passmark:cpu': 500, 'passmark:gpu': 500, 'passmark:disk': 500
  };
  var HDD_PAGE_DELAY_MS = 200;                                // 硬盘榜逐页抓取礼貌间隔
  var CACHE_MAX_ITEMS = { cpu: 4000, gpu: 4000, disk: 8000 }; // spark.db 快照条目上限

  var METRIC = {
    'geekbench:cpu': 'Geekbench 多核',
    'geekbench:gpu': 'Geekbench OpenCL',
    'passmark:cpu': 'PassMark CPU Mark',
    'passmark:gpu': 'PassMark G3D Mark',
    'passmark:disk': 'PassMark Disk Rating'
  };

  var SOURCE_LABEL = { geekbench: 'Geekbench', passmark: 'PassMark' };

  // 每类的源优先级(主源在前)
  var CHAIN = {
    cpu: ['geekbench', 'passmark'],
    gpu: ['passmark', 'geekbench'],
    disk: ['passmark']
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
  function parseGeekbenchPane(html, paneId) {
    var pane = slicePane(html, paneId);
    if (!pane) return [];
    var items = [];
    var rows = pane.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (var i = 0; i < rows.length; i++) {
      if (/stacked-heading/i.test(rows[i])) continue;
      var name = null, desc = '', score = null;
      var a = rows[i].match(/<a\s[^>]*href=['"][^'"]*['"][^>]*>([\s\S]*?)<\/a>/i);
      if (a) name = stripTags(a[1]);
      var d = rows[i].match(/class=['"]description['"][^>]*>([\s\S]*?)<\/div>/i);
      if (d) desc = stripTags(d[1]);
      var sc = rows[i].match(/class=['"]score['"][^>]*>([\s\S]*?)<\/td>/i);
      if (sc) score = parseNum(sc[1]);
      if (name && score != null) {
        var item = { n: name, s: score };
        if (desc) item.m = desc;
        items.push(item);
      }
    }
    return items;
  }

  // PassMark 列表页:cputable 行 = 各列 td;colIdx 指定 name/score/rank/extra 列序
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
      if (colIdx.extra != null && cells[colIdx.extra]) meta.push(cells[colIdx.extra]);
      if (cells[colIdx.rank]) meta.push('#' + cells[colIdx.rank]);
      var item = { n: name, s: score };
      if (meta.length) item.m = meta.join(' · ');
      out.push(item);
    }
    return out;
  }

  function parseHddPage(html) {
    // 硬盘列序:name, size, rating, rank, value, price
    return parsePassmarkTable(html, { score: 2, rank: 3, extra: 1 });
  }

  // 从页面链接发现最大页号(/hdd-list/pageN)
  function discoverMaxPage(html) {
    var max = 1, m, re = /hdd-list\/page(\d+)/g;
    while ((m = re.exec(html))) if (+m[1] > max) max = +m[1];
    return max;
  }

  /* ── 网络 ─────────────────────────────────────────────── */

  function netFetchText(url) {
    var spark = global.spark;
    if (!spark || !spark.net || typeof spark.net.fetch !== 'function') {
      return Promise.reject(new Error('net.fetch 不可用'));
    }
    return spark.net.fetch(url, { method: 'GET', headers: baseHeaders() }).then(function (resp) {
      if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
      return resp.text();
    });
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
            var items = parsePassmarkTable(html, { score: 1, rank: 2 });
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
            var items = parsePassmarkTable(html, { score: 1, rank: 2 });
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
              return store.set('snap:' + cat + ':' + srcName, got[0]).then(function () { return got; });
            }, function (err) {
              failures.push({ source: srcName, error: (err && err.message) || String(err) });
              return null;
            });
          });
        }, Promise.resolve(null));

    return chainRun.then(function (got) {
      if (got) return { snapshot: got[0], via: 'network', failures: failures };
      var chain = CHAIN[cat] || [];
      var lookups = chain.map(function (s) { return store.get('snap:' + cat + ':' + s); });
      return Promise.all(lookups).then(function (snaps) {
        var best = null;
        for (var k = 0; k < snaps.length; k++) {
          if (snaps[k] && (!best || snaps[k].fetched_at > best.fetched_at)) best = snaps[k];
        }
        if (best) return { snapshot: best, via: 'cache', failures: failures };
        var builtin = global.HWL_BUILTIN && global.HWL_BUILTIN[cat];
        if (builtin) return { snapshot: builtin, via: 'builtin', failures: failures };
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
      makeSnapshot: makeSnapshot, SOURCES: SOURCES
    }
  };

  global.HWL_SOURCES = api;
})(typeof window !== 'undefined' ? window : globalThis);