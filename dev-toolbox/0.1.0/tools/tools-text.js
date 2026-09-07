/* tools-text.js — 文本处理组：统计/大小写/行处理/替换/命名/拼音/简繁/标点 */
(function () {
  'use strict';

  /* ---------- 文本统计 ---------- */
  App.tool({
    id: 'tstats', name: '文本统计', group: 'text', alias: '字数统计 字数 行数 字节',
    desc: '字符数、行数、中英文、数字标点、UTF-8 字节数',
    icon: 'M4 6h16M4 12h10M4 18h13M18 15v4M16 17h4',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '粘贴要统计的文本…',
        rows: 7,
        live: function (text, v, out) {
          if (!text.trim()) { out.setNode(UI.el('div', {})); return; }
          var s = TextKit.textStats(text);
          var node = UI.el('div', {});
          node.appendChild(UI.kvList([
            ['字符数', s.chars],
            ['非空白字符', s.charsNoSpace],
            ['空格数', s.spaces],
            ['行数', s.lines],
            ['单词数', s.words],
            ['中文字符', s.cn],
            ['英文字母', s.en],
            ['数字', s.num],
            ['标点', s.punct],
            null,
            ['UTF-8 字节', s.bytes]
          ]));
          out.setNode(node);
        }
      });
      host.appendChild(UI.hint('字节数按 UTF-8 编码计算（一个汉字 3 字节）。点击右侧数值可复制。'));
    }
  });

  /* ---------- 大小写转换 ---------- */
  App.tool({
    id: 'tcase', name: '大小写转换', group: 'text', alias: '大小写 全大写 全小写 首字母大写 交替大小写',
    desc: '全大写 / 全小写 / 每词首字母大写 / 句首大写 / 大小写互换',
    icon: 'M7 5l-4.5 12M7 5l4.5 12M4.6 12.5h4.8M16.5 17V7.5a2.6 2.6 0 0 1 5 1c.3 1.4-.9 2.3-2.4 3h-1.6c2.4 0 4 1 4 2.7a2.8 2.8 0 0 1-5 2.1',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入要转换的文本…',
        rows: 7,
        swap: true,
        options: [
          {
            kind: 'select', id: 'tcMode', label: '方式', value: 'upper', options: [
              { v: 'upper', t: '全部大写' }, { v: 'lower', t: '全部小写' },
              { v: 'title', t: '每个单词首字母大写' }, { v: 'cap', t: '句首字母大写' },
              { v: 'toggle', t: '大小写互换' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          out.set(TextKit.changeCase(text, v.tcMode));
        }
      });
    }
  });

  /* ---------- 行处理 ---------- */
  App.tool({
    id: 'tline', name: '行处理', group: 'text', alias: '去重 排序 行号 删空行 trim 倒序 随机打乱',
    desc: '去重 / 排序 / 加行号 / 去首尾空白 / 删除空行 / 倒序 / 打乱',
    icon: 'M5 6h9M5 12h9M5 18h9M17 4l3 3-3 3M17 14l3 3-3 3',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '每行一条，输入或粘贴…',
        rows: 9,
        swap: true,
        options: [
          {
            kind: 'select', id: 'tlOp', label: '操作', value: 'dedupe', options: [
              { v: 'dedupe', t: '去重' }, { v: 'dedupeTrim', t: '去重（忽略空白差异）' },
              { v: 'sortAsc', t: '排序 A→Z / 拼音' }, { v: 'sortDesc', t: '排序 Z→A' },
              { v: 'sortLenAsc', t: '按长度升序' }, { v: 'sortLenDesc', t: '按长度降序' },
              { v: 'reverse', t: '倒序' }, { v: 'shuffle', t: '随机打乱' },
              { v: 'trim', t: '去每行首尾空白' }, { v: 'strip', t: '删除空行' },
              { v: 'number', t: '加行号' }
            ]
          },
          { kind: 'input', id: 'tlStart', label: '行号起始', ph: '1', value: '1' },
          { kind: 'input', id: 'tlSep', label: '行号分隔符', ph: '. ', value: '. ' },
          { kind: 'check', id: 'tlPad', label: '行号补零对齐', value: true }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var r;
          switch (v.tlOp) {
            case 'dedupe': r = TextKit.dedupeLines(text); break;
            case 'dedupeTrim': r = TextKit.dedupeLines(text, { trim: true }); break;
            case 'sortAsc': r = TextKit.sortLines(text, 'asc'); break;
            case 'sortDesc': r = TextKit.sortLines(text, 'desc'); break;
            case 'sortLenAsc': r = TextKit.sortLines(text, 'lenAsc'); break;
            case 'sortLenDesc': r = TextKit.sortLines(text, 'lenDesc'); break;
            case 'reverse': r = TextKit.sortLines(text, 'reverse'); break;
            case 'shuffle': r = TextKit.sortLines(text, 'shuffle'); break;
            case 'trim': r = TextKit.trimLines(text); break;
            case 'strip': r = TextKit.removeEmptyLines(text); break;
            case 'number':
              r = TextKit.addLineNumbers(text, {
                start: parseInt(v.tlStart, 10) || 1,
                sep: v.tlSep === '' ? '. ' : v.tlSep.replace(/\\t/g, '\t'),
                pad: !!v.tlPad
              });
              break;
            default: r = text;
          }
          out.set(r);
        }
      });
      host.appendChild(UI.hint('「去重」保留首次出现的行；排序使用中文拼音 Collator。'));
    }
  });

  /* ---------- 文本替换 ---------- */
  App.tool({
    id: 'trepl', name: '文本替换', group: 'text', alias: '替换 正则替换 批量替换',
    desc: '普通字符串或正则替换，支持忽略大小写、多行模式',
    icon: 'M4 7h11M4 7l3-3M4 7l3 3M20 17H9M20 17l-3-3M20 17l-3 3M15 4l4 4M15 12l4-4',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入要处理的文本…',
        rows: 9,
        swap: true,
        options: [
          { kind: 'input', id: 'trFind', label: '查找', ph: '要查找的内容' },
          { kind: 'input', id: 'trTo', label: '替换为', ph: '替换后的内容（可空）' },
          { kind: 'check', id: 'trRegex', label: '正则表达式', value: false },
          { kind: 'check', id: 'trCase', label: '忽略大小写', value: false },
          { kind: 'check', id: 'trML', label: '^ $ 匹配每行', value: false }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          if (!v.trFind) { out.set(text); return; }
          out.set(TextKit.replaceText(text, v.trFind, v.trTo, {
            regex: v.trRegex, ignoreCase: v.trCase, multiline: v.trML
          }));
        }
      });
      host.appendChild(UI.hint('正则模式下替换串可用 $1 引用分组；普通模式下为字面量替换全部出现。'));
    }
  });

  /* ---------- 变量命名转换 ---------- */
  App.tool({
    id: 'tname', name: '变量命名转换', group: 'text', alias: '驼峰 下划线 kebab pascal 常量 命名',
    desc: 'camelCase / PascalCase / snake_case / kebab-case / 常量互转',
    icon: 'M8 5.5 4.5 12 8 18.5M16 5.5 19.5 12 16 18.5M11 16l2-8',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入变量名，如 user_name、getUserInfo、HTTPStatus Code…',
        rows: 3,
        live: function (text, v, out) {
          if (!text.trim()) { out.setNode(UI.el('div', {})); return; }
          var st = TextKit.nameStyles(text);
          if (st._empty) { out.set(''); return; }
          var node = UI.el('div', {});
          node.appendChild(UI.kvList([
            ['camelCase 变量', st['varName']],
            ['PascalCase 类型/类', st['VarName']],
            ['snake_case Python', st['var_name']],
            ['kebab-case CSS/URL', st['var-name']],
            ['CONSTANT 常量', st['VAR_NAME']],
            ['空格分隔 标题', st['var name']]
          ]));
          out.setNode(node);
        }
      });
      host.appendChild(UI.hint('自动识别驼峰、下划线、中划线、空格等分词方式；连续大写缩写词整体处理（如 HTTP、ID）。'));
    }
  });

  /* ---------- 汉字转拼音 ---------- */
  App.tool({
    id: 'tpinyin', name: '汉字转拼音', group: 'text', alias: '拼音 pinyin 音调 首字母',
    desc: '全拼（无声调/数字/符号三种风格）与首字母',
    icon: 'M4 5h16M9 3v2M15 3v2M6 5c0 6 2 9 6 14M13 10c2.5 0 5.5-.5 5.5-.5M12 9.5 15.5 19M18 19c-2.5-4-3.5-6.5-4.5-9',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入汉字…',
        rows: 5,
        swap: true,
        options: [
          {
            kind: 'select', id: 'tpStyle', label: '风格', value: 'plain', options: [
              { v: 'plain', t: '无声调（hanzi）' }, { v: 'mark', t: '声调符号（hàn zì）' }, { v: 'num', t: '数字声调（han4 zi4）' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var r = TextKit.pinyin(text, { style: v.tpStyle, sep: ' ' });
          out.set('全拼 →\n' + r.full + '\n\n首字母 →\n' + TextKit.pinyinInitials(text));
        }
      });
      host.appendChild(UI.hint('非汉字原样保留；多音字取常用读音（离线字典来自 pinyin-pro 数据）。'));
    }
  });

  /* ---------- 简繁转换 ---------- */
  App.tool({
    id: 'ts2t', name: '简繁转换', group: 'text', alias: '简体 繁体 繁简 opencc',
    desc: '简体中文 ↔ 繁体中文，逐字映射（OpenCC 数据）',
    icon: 'M5 4h6v6H5zM13 4h6v6h-6zM5 14h6v6H5zM13 14h6v6h-6zM11 7h2M11 17h2M8 10v4M16 10v4',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入中文文本…',
        rows: 7,
        swap: true,
        options: [
          {
            kind: 'select', id: 'ttDir', label: '方向', value: 's2t', options: [
              { v: 's2t', t: '简体 → 繁体' }, { v: 't2s', t: '繁体 → 简体' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          out.set(v.ttDir === 's2t' ? TextKit.s2t(text) : TextKit.t2s(text));
        }
      });
    }
  });

  /* ---------- 中英标点 ---------- */
  App.tool({
    id: 'tpunct', name: '中英标点', group: 'text', alias: '标点 全角 半角 中文标点 英文标点',
    desc: '中文标点 ↔ 英文标点互转（全角/半角）',
    icon: 'M6 11a2.5 2.5 0 1 0 0-.01M17 6.5a2.5 2.5 0 1 0 0 .01M4.5 17c1.5 3 5 3 6.5 0M14 15h6M14 18.5h4',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入文本…',
        rows: 7,
        swap: true,
        options: [
          {
            kind: 'select', id: 'tpDir', label: '方向', value: 'en', options: [
              { v: 'en', t: '中文标点 → 英文（全角转半角）' }, { v: 'cn', t: '英文标点 → 中文（半角转全角）' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text) { out.set(''); return; }
          out.set(v.tpDir === 'en' ? TextKit.cn2enPunct(text) : TextKit.en2cnPunct(text));
        }
      });
      host.appendChild(UI.hint('半角转全角会连带处理 , . : ; ? ! ( ) [ ] < > ~；全角转半角覆盖更多中文符号。'));
    }
  });
})();