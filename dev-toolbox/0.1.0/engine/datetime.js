/* datetime.js — 时间引擎：时间戳互转/时区/日期计算/crontab 解析与下次执行 */
var DTime = (function () {
  'use strict';

  var WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad(n, w) { var s = String(Math.abs(n)); while (s.length < (w || 2)) s = '0' + s; return (n < 0 && w === undefined ? '' : '') + s; }

  /* ---------- 输入解析 ---------- */
  function parseInput(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return null;
    if (/^-?\d+$/.test(s)) {
      var v = Number(s);
      if (v > 1e15) return null;
      return new Date(v >= 1e11 ? v : v * 1000);
    }
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?$/);
    if (m) {
      var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[5] || 0), +(m[6] || 0), Math.floor(+(m[7] || 0)), m[7] ? Math.round((parseFloat(m[7]) % 1) * 1000) : 0);
      if (isNaN(d.getTime())) return null;
      return d;
    }
    var d2 = new Date(s);
    if (!isNaN(d2.getTime())) return d2;
    return null;
  }

  /* ---------- 时间戳转换 ---------- */
  function describe(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    return {
      sec: Math.floor(d.getTime() / 1000),
      ms: d.getTime(),
      us: d.getTime() * 1000,
      iso: d.toISOString(),
      local: formatLocal(d),
      utc: formatUTC(d),
      week: WEEK_CN[d.getDay()],
      dayOfYear: Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000),
      utcOffset: -d.getTimezoneOffset() / 60
    };
  }
  function formatLocal(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }
  function formatUTC(d) {
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3);
  }
  function inTimezone(d, offsetHours) {
    // 指定 UTC 偏移（小时，可带 .5）下的墙钟时间字符串
    var ms = d.getTime() + offsetHours * 3600000;
    var t = new Date(ms);
    return {
      text: t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + ' ' +
        pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds()),
      weekday: WEEK_CN[t.getUTCDay()],
      sign: offsetHours >= 0 ? '+' : '-',
      offset: Math.abs(offsetHours).toFixed(Math.abs(offsetHours % 1) ? 1 : 0)
    };
  }

  /* ---------- 时间计算器 ---------- */
  function dateDiff(a, b) {
    var ms = b.getTime() - a.getTime();
    var neg = ms < 0; ms = Math.abs(ms);
    var s = Math.floor(ms / 1000);
    var days = Math.floor(s / 86400);
    var hours = Math.floor(s % 86400 / 3600);
    var mins = Math.floor(s % 3600 / 60);
    var secs = s % 60;
    return {
      ms: ms, totalSec: s, totalMin: Math.floor(s / 60), totalHour: Math.floor(s / 3600),
      totalDay: +(ms / 86400000).toFixed(4),
      days: days, hours: hours, mins: mins, secs: secs, neg: neg
    };
  }
  function dateAdd(d, parts) {
    // parts: {y, mo, d, h, mi, s, sign}
    var sign = parts.sign === '-' ? -1 : 1;
    var r = new Date(d.getTime());
    if (parts.y) r.setFullYear(r.getFullYear() + sign * parts.y);
    if (parts.mo) r = addMonths(r, sign * parts.mo);
    if (parts.d) r.setDate(r.getDate() + sign * parts.d);
    if (parts.h) r.setHours(r.getHours() + sign * parts.h);
    if (parts.mi) r.setMinutes(r.getMinutes() + sign * parts.mi);
    if (parts.s) r.setSeconds(r.getSeconds() + sign * parts.s);
    return r;
  }
  function addMonths(d, n) {
    var day = d.getDate();
    var target = new Date(d.getFullYear(), d.getMonth() + n, 1);
    var dim = daysInMonth(target.getFullYear(), target.getMonth());
    target.setDate(Math.min(day, dim));
    target.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
    return target;
  }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  /* ---------- Crontab ---------- */
  var MON_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  function parseCron(expr) {
    var fields = String(expr == null ? '' : expr).trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 7) {
      return { ok: false, error: '字段数应为 5 个（分 时 日 月 周）或 6 个（秒 分 时 日 月 周），当前 ' + fields.length + ' 个' };
    }
    var sec = null;
    if (fields.length >= 6) { sec = fields[0]; fields = fields.slice(1); }
    try {
      var minF = parseCronField(fields[0], 0, 59, null, '分钟');
      var hourF = parseCronField(fields[1], 0, 23, null, '小时');
      var domF = parseCronField(fields[2], 1, 31, null, '日');
      var monF = parseCronField(fields[3], 1, 12, MON_NAMES, '月');
      var dowF = parseCronDow(fields[4], '周');
      var secF = sec ? parseCronField(sec, 0, 59, null, '秒') : null;
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return {
      ok: true, sec: secF, min: minF, hour: hourF, dom: domF, mon: monF, dow: dowF,
      hasSeconds: !!secF,
      restricted: { dom: !domF.wildcard, dow: !dowF.wildcard },
      describe: describeCron(fields, !!secF)
    };
  }
  function parseCronField(f, min, max, names, label) {
    try {
      return parseCronFieldCore(f, min, max, names);
    } catch (e) {
      throw new Error(label + '字段「' + f + '」：' + e.message);
    }
  }
  function normField(tok, names) {
    var t = String(tok).trim().toLowerCase();
    if (t === '*' || t === '?') return null;
    if (/^\d+$/.test(t)) return Number(t);
    if (names && names[t] !== undefined) return names[t];
    return NaN;
  }
  function parseCronFieldCore(f, min, max, names) {
    if (!f || !f.length) throw new Error('字段为空');
    var parts = f.split(',');
    var set = new Set();
    var wildcard = false;
    for (var p of parts) {
      var step = 1, range = p;
      if (p.includes('/')) {
        var seg = p.split('/');
        if (seg.length > 2) throw new Error('格式错误');
        range = seg[0];
        step = Number(seg[1]);
        if (!/^\d+$/.test(seg[1]) || step < 1) throw new Error('步长「' + seg[1] + '」必须是正整数');
      }
      var lo = min, hi = max;
      if (range !== '*' && range !== '?') {
        if (p.includes('/')) {
          lo = normField(range, names);
          if (lo === null || isNaN(lo)) throw new Error('起点「' + range + '」无法识别');
          if (lo < min || lo > max) throw new Error('起点 ' + lo + ' 超出 [' + min + ', ' + max + ']');
          hi = max;
        } else {
          var dash = range.split('-');
          if (dash.length === 1) {
            var one = normField(dash[0], names);
            if (one === null || isNaN(one)) throw new Error('取值「' + range + '」无法识别');
            if (one < min || one > max) throw new Error('取值 ' + one + ' 超出 [' + min + ', ' + max + ']');
            set.add(one); continue;
          }
          if (dash.length !== 2) throw new Error('区间格式错误：' + range);
          lo = normField(dash[0], names); hi = normField(dash[1], names);
          if (lo === null || isNaN(lo) || hi === null || isNaN(hi)) throw new Error('区间「' + range + '」无法识别');
          if (lo < min || hi > max || lo > hi) throw new Error('区间 ' + lo + '-' + hi + ' 不合法（范围 [' + min + ', ' + max + ']）');
        }
      } else wildcard = true;
      for (var v = lo; v <= hi; v += step) set.add(v);
      if (range === '*' && !p.includes('/')) for (var w = min; w <= max; w++) set.add(w);
    }
    if (!set.size) throw new Error('没有匹配到任何值');
    return { values: set, wildcard: wildcard && !p.includes('/') };
  }
  function parseCronDow(f, label) {
    try {
      var r = parseCronFieldCore(f, 0, 6, DOW_NAMES);
      var vals = new Set();
      for (var v of r.values) vals.add(v % 7);
      r.values = vals;
      return r;
    } catch (e) {
      throw new Error(label + '字段「' + f + '」：' + e.message);
    }
  }
  function cronNext(expr, count) {
    var p = parseCron(expr);
    if (!p.ok) return { error: p.error };
    var out = [];
    var t = new Date();
    t.setSeconds(p.hasSeconds ? 0 : 0, 0);
    if (!p.hasSeconds) t.setMinutes(t.getMinutes() + 1, 0);
    else t.setSeconds(t.getSeconds() + 1);
    var limit = 366 * 24 * 3600; // 最多回溯一年
    var steps = 0;
    while (out.length < count && steps < limit) {
      steps++;
      if (t.getFullYear() < new Date().getFullYear() - 1) break;
      if (!p.mon.values.has(t.getMonth() + 1)) { advanceMonth(t, p.mon.values); continue; }
      var domOk = p.dom.values.has(t.getDate());
      var dowOk = p.dow.values.has(t.getDay());
      var dayMatch = p.restricted.dom && p.restricted.dow ? (domOk || dowOk) : (p.restricted.dom ? domOk : dowOk);
      if (!p.restricted.dom && !p.restricted.dow) dayMatch = true;
      if (!dayMatch) { t.setDate(t.getDate() + 1); if (!p.hasSeconds) t.setHours(0, 0, 0, 0); else t.setHours(0, 0, 0, 0); continue; }
      if (!p.hour.values.has(t.getHours())) {
        t.setHours(t.getHours() + 1, 0, 0, 0);
        continue;
      }
      if (!p.min.values.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
      if (p.sec && !p.sec.values.has(t.getSeconds())) { t.setSeconds(t.getSeconds() + 1, 0); continue; }
      out.push(new Date(t.getTime()));
      t.setSeconds(t.getSeconds() + (p.hasSeconds ? 1 : 60), 0);
    }
    return { list: out };
  }
  function advanceMonth(t, monSet) {
    var y = t.getFullYear(), m = t.getMonth() + 1;
    for (var i = 0; i < 48; i++) {
      m++;
      if (m > 12) { m = 1; y++; }
      if (monSet.has(m)) { t.setFullYear(y, m - 1, 1); t.setHours(0, 0, 0, 0); return; }
    }
    t.setFullYear(t.getFullYear() + 10);
  }
  function describeCron(fields, hasSec) {
    // 简短中文描述
    var f = fields;
    var desc = [];
    function fld(x, names, unit) {
      if (x === '*' || x === '?') return null;
      return x;
    }
    var min = f[0], hour = f[1], dom = f[2], mon = f[3], dow = f[4];
    var timePart = null;
    if (/^\*\/(\d+)$/.test(min) && /^\*\/(\d+)$/.test(hour)) timePart = '每 ' + hour.split('/')[1] + ' 小时的第 ' + min.split('/')[1] + ' 分钟';
    else if (/^\*\/(\d+)$/.test(min) && hour === '*') timePart = '每 ' + min.split('/')[1] + ' 分钟';
    else if (min === '*' && hour === '*') timePart = '每分钟';
    else if (hour === '*') timePart = '每小时的第 ' + min + ' 分钟';
    else if (/^\*\//.test(min)) timePart = '每天 ' + hour + ' 点起每 ' + min.split('/')[1] + ' 分钟';
    else timePart = '每天 ' + pad(hour) + ':' + pad(min);
    var datePart = null;
    if (dom !== '*' && dom !== '?') datePart = '每月 ' + dom + ' 号';
    if (mon !== '*' && mon !== '?') datePart = (datePart ? datePart + '、' : '') + mon + ' 月';
    if (dow !== '*' && dow !== '?') {
      var dmap = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
      if (/^\d(-\d)?$/.test(dow)) {
        var seg = dow.split('-').map(Number);
        datePart = (datePart ? datePart + '、' : '') + '每周' + seg.map(function (x) { return dmap[x % 7]; }).join('到周');
      } else datePart = (datePart ? datePart + '、' : '') + '每周' + dow;
    }
    if (hasSec) desc.unshift('带秒字段');
    return [datePart, timePart].filter(Boolean).join(' ');
  }

  return {
    parseInput: parseInput, describe: describe, inTimezone: inTimezone,
    dateDiff: dateDiff, dateAdd: dateAdd, addMonths: addMonths,
    parseCron: parseCron, cronNext: cronNext, WEEK_CN: WEEK_CN
  };
})();
if (typeof globalThis !== 'undefined') globalThis.DTime = DTime;