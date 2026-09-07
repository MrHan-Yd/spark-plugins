/* tools-time.js — 时间日期组：时间戳/日期计算/Cron */
(function () {
  'use strict';

  function fmtLocal(d) {
    var info = DTime.describe(d);
    return info.local.slice(0, 19);
  }

  /* ---------- 时间戳转换 ---------- */
  App.tool({
    id: 'tstamp', name: '时间戳转换', group: 'time', alias: '时间戳 unix timestamp 毫秒 秒 日期',
    desc: 'Unix 时间戳 ↔ 日期双向转换，纯数字按秒/毫秒自动判断',
    icon: 'M12 7v5l3.5 2M12 3a9 9 0 1 0 .01 0zM12 1.5v2M12 20.5v2M2.5 12h2M19.5 12h2',
    render: function (host) {
      var t = UI.ioTool(host, {
        placeholder: '输入时间戳（1700000000 或 1700000000000）或日期（2024-03-15 08:30:00）…',
        rows: 3,
        swap: true,
        live: function (text, v, out) {
          if (!text.trim()) { out.setNode(UI.el('div', {})); return; }
          var d = DTime.parseInput(text);
          if (!d) throw new Error('无法解析为时间戳或日期。支持：Unix 秒/毫秒、ISO 8601、YYYY-MM-DD HH:MM:SS。');
          var info = DTime.describe(d);
          var bj = DTime.inTimezone(d, 8);
          var node = UI.el('div', {});
          node.appendChild(UI.kvList([
            ['Unix 秒', info.sec],
            ['Unix 毫秒', info.ms],
            ['微秒', info.us],
            null,
            ['本地时间', info.local.slice(0, 23)],
            ['北京时间 (UTC+8)', bj.text + ' ' + bj.weekday],
            ['UTC', info.utc.slice(0, 23)],
            ['ISO 8601', info.iso],
            null,
            ['星期', info.week],
            ['年内第几天', info.dayOfYear],
            ['本地 UTC 偏移', 'UTC' + (info.utcOffset >= 0 ? '+' : '') + info.utcOffset]
          ]));
          out.setNode(node);
        }
      });
      var foot = UI.el('div', { class: 'btnrow' });
      foot.appendChild(UI.btn('填入当前时间', function () {
        t.input.value = String(Math.floor(Date.now() / 1000));
        t.input.dispatchEvent(new Event('input'));
      }));
      host.appendChild(foot);
      host.appendChild(UI.hint('纯数字 ≤10 位按秒、≥13 位按毫秒解析；「交换」可把右侧文本区域内容复制回输入继续处理。'));
    }
  });

  /* ---------- 日期计算 ---------- */
  App.tool({
    id: 'tcalc', name: '日期计算', group: 'time', alias: '日期差 相差天数 加减天 日期加减 计算',
    desc: '两个日期相差多久；基准日期加/减年月日时分秒',
    icon: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 13h2M9 16.5h6M14.5 12.5 15.5 14.5 17.5 15 16 16.5 16.5 18.5 14.5 17.5 12.5 18.5 13 16.5 11.5 15 13.5 14.5z',
    render: function (host) {
      var box = UI.el('div', {});
      host.appendChild(box);

      // 卡片一：日期差
      var card1 = UI.el('div', { class: 'card' });
      card1.appendChild(UI.el('div', { class: 'opt-l', text: '日期差' }));
      var g1 = UI.el('div', { class: 'unit-grid' });
      var aIn = UI.input('tcA', '起始：2024-03-15 08:30:00');
      var bIn = UI.input('tcB', '结束：2025-01-01');
      g1.appendChild(UI.field('起始时间', aIn));
      g1.appendChild(UI.field('结束时间', bIn));
      card1.appendChild(g1);
      var r1 = UI.el('div', {});
      card1.appendChild(r1);
      box.appendChild(card1);

      function diffCalc() {
        r1.innerHTML = '';
        var a = DTime.parseInput(aIn.value), b = DTime.parseInput(bIn.value);
        if (!a || !b) return;
        var d = DTime.dateDiff(a, b);
        var sign = d.neg ? '-' : '';
        r1.appendChild(UI.kvList([
          ['相差', sign + d.days + ' 天 ' + d.hours + ' 小时 ' + d.mins + ' 分 ' + d.secs + ' 秒'],
          ['合计天数', d.totalDay],
          ['合计小时', d.totalHour],
          ['合计分钟', d.totalMin],
          ['合计秒', d.totalSec],
          ['合计毫秒', d.ms]
        ]));
      }
      aIn.addEventListener('input', diffCalc);
      bIn.addEventListener('input', diffCalc);

      // 卡片二：日期加减
      var card2 = UI.el('div', { class: 'card' });
      card2.appendChild(UI.el('div', { class: 'opt-l', text: '日期加减' }));
      var g2 = UI.el('div', { class: 'unit-grid' });
      var baseIn = UI.input('tcBase', '如 2024-03-15 或留空表示现在');
      var numIn = UI.input('tcNum', '数量', '30');
      var unitSel = UI.select('tcUnit', [
        { v: 'd', t: '天' }, { v: 'mo', t: '月' }, { v: 'y', t: '年' },
        { v: 'h', t: '小时' }, { v: 'mi', t: '分钟' }, { v: 's', t: '秒' }
      ], 'd');
      var dirSel = UI.select('tcDir', [{ v: '+', t: '加 (+)' }, { v: '-', t: '减 (-)' }], '+');
      g2.appendChild(UI.field('基准日期', baseIn));
      g2.appendChild(UI.field('数量', numIn));
      g2.appendChild(UI.field('单位', unitSel));
      g2.appendChild(UI.field('方向', dirSel));
      card2.appendChild(g2);
      var r2 = UI.el('div', {});
      card2.appendChild(r2);
      box.appendChild(card2);

      function addCalc() {
        r2.innerHTML = '';
        var base = DTime.parseInput(baseIn.value) || new Date();
        var n = parseInt(numIn.value, 10);
        if (!n && n !== 0) return;
        var parts = { sign: dirSel.value };
        parts[unitSel.value] = Math.abs(n);
        var r = DTime.dateAdd(base, parts);
        var info = DTime.describe(r);
        r2.appendChild(UI.kvList([
          ['结果时间', fmtLocal(r)],
          ['星期', info.week],
          ['Unix 秒', info.sec],
          ['Unix 毫秒', info.ms]
        ]));
      }
      baseIn.addEventListener('input', addCalc);
      numIn.addEventListener('input', addCalc);
      unitSel.addEventListener('change', addCalc);
      dirSel.addEventListener('change', addCalc);

      box.appendChild(UI.hint('日期差为绝对值（合计天数含小数）；加减月份自动处理月末（1/31 加 1 个月 → 2/29 等场景取当月最后一天）。'));
    }
  });

  /* ---------- Cron 表达式解析 ---------- */
  App.tool({
    id: 'tcron', name: 'Cron 解析', group: 'time', alias: 'cron 计划任务 定时 表达式 next',
    desc: '5/6 段 Cron 表达式解读与接下来 5 次执行时间',
    icon: 'M6 4h12v4H6zM8 4V2.5M16 4V2.5M4 8h16v12H4zM8 12h2M8 15h2M8 18h2M14 12h2M14 15h2M14 18h2M11 12h2M11 15h2M11 18h2',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入 cron 表达式，如 0 9 * * 1-5 或 */10 * * * * *',
        rows: 2,
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var p = DTime.parseCron(text);
          if (!p.ok) throw new Error(p.error);
          var lines = ['含义：' + p.describe, '', '接下来 5 次执行：'];
          var nx = DTime.cronNext(text, 5);
          if (nx.error) throw new Error(nx.error);
          if (!nx.list.length) lines.push('  （一年内无匹配执行时间）');
          for (var d of nx.list) lines.push('  ' + fmtLocal(d) + '  ' + DTime.describe(d).week);
          lines.push('', '字段：' + text.trim().split(/\s+/).join(' | '));
          out.set(lines.join('\n'));
        }
      });
      host.appendChild(UI.hint('支持 5 段（分 时 日 月 周）与 6 段（秒 分 时 日 月 周）；支持 * , - / 与月份/星期英文名缩写。下次执行时间从当前时刻起算。'));
    }
  });
})();