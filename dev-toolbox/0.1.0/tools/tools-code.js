/* tools-code.js — 代码格式组：JS/CSS/HTML/SQL/Markdown 格式化 + XML/YAML/PHP/properties 互转 */
(function () {
  'use strict';

  function indentSel(id) {
    return {
      kind: 'select', id: id, label: '缩进', value: '2', options: [
        { v: '2', t: '2 空格' }, { v: '4', t: '4 空格' }, { v: 'tab', t: 'Tab' }
      ]
    };
  }
  function indentVal(id) {
    var s = document.getElementById(id).value;
    return s === 'tab' ? '\t' : parseInt(s, 10);
  }
  function fmtTool(def) {
    App.tool({
      id: def.id, name: def.name, group: 'code', alias: def.alias, desc: def.desc, icon: def.icon,
      render: function (host) {
        var opts = [{ kind: 'select', id: def.actId, label: '操作', value: 'fmt', options: [{ v: 'fmt', t: '格式化' }, { v: 'min', t: '压缩' }] }];
        if (def.indent !== false) opts.push(indentSel(def.indId));
        if (def.extra) opts = opts.concat(def.extra);
        UI.ioTool(host, {
          placeholder: def.ph,
          rows: 11,
          swap: true,
          options: opts,
          live: function (text, v, out) {
            if (!text.trim()) { out.set(''); return; }
            var ind = def.indent === false ? undefined : indentVal(def.indId);
            out.set(v[def.actId] === 'min' ? def.minify(text) : def.format(text, ind, v));
          }
        });
        if (def.hint) host.appendChild(UI.hint(def.hint));
      }
    });
  }

  /* ---------- JS 格式化 / 压缩 ---------- */
  fmtTool({
    id: 'jsfmt', name: 'JS 格式化', alias: 'js格式化 javascript 压缩 minify 美化',
    desc: 'JavaScript / C 风格代码格式化与压缩',
    icon: 'M9 6 4 12l5 6M15 6l5 6-5 6',
    actId: 'jsAct', indId: 'jsInd',
    ph: '粘贴 JavaScript（C/C++/Java 同样适用）…',
    format: function (text, ind) { return Fmt.formatC(text, ind === '\t' ? 4 : ind); },
    minify: function (text) { return Fmt.minifyJs(text); },
    hint: '基于 C 族大括号排版规则，对常规 JS/C/C++/Java 代码有效；模板字符串、正则等复杂场景请自行核对。'
  });

  /* ---------- CSS 格式化 / 压缩 ---------- */
  fmtTool({
    id: 'cssfmt', name: 'CSS 格式化', alias: 'css格式化 css压缩 美化',
    desc: 'CSS 格式化（每条声明一行）与压缩',
    icon: 'M4 5h7M4 10h7M4 15h7M13 4l4 4M13 9l4-4M13 14l4 4M13 19l4-4',
    actId: 'csAct', indId: 'csInd',
    ph: '粘贴 CSS…',
    format: function (text, ind) { return Fmt.formatCss(text, ind === '\t' ? 4 : ind); },
    minify: function (text) { return Fmt.minifyCss(text); }
  });

  /* ---------- HTML/XML 格式化 / 压缩 ---------- */
  fmtTool({
    id: 'htmlfmt', name: 'HTML 格式化', alias: 'html格式化 xml格式化 html压缩 html美化',
    desc: 'HTML / XML / SVG 缩进排版与压缩',
    icon: 'M8 5 3 12l5 7M16 5l5 7-5 7M13.5 4l-3 16',
    actId: 'htAct', indId: 'htInd',
    ph: '粘贴 HTML / XML / SVG…',
    format: function (text, ind) { return Fmt.formatMarkup(text, ind === '\t' ? 4 : ind); },
    minify: function (text) { return Fmt.minifyMarkup(text); }
  });

  /* ---------- SQL 格式化 / 压缩 ---------- */
  fmtTool({
    id: 'sqlfmt', name: 'SQL 格式化', alias: 'sql格式化 sql压缩 sql美化',
    desc: 'SQL 大关键字换行排版与压缩',
    icon: 'M5 5h14M7 10h10M9 15h6M4 20h16',
    actId: 'sqAct', indId: 'sqInd',
    extra: [{ kind: 'check', id: 'sqUpper', label: '关键字大写', value: true }],
    ph: '粘贴 SQL…',
    format: function (text, ind, v) { return Fmt.formatSql(text, ind === '\t' ? 4 : ind, v.sqUpper); },
    minify: function (text) { return Fmt.minifySql(text); }
  });

  /* ---------- Markdown 整理 ---------- */
  App.tool({
    id: 'mdfmt', name: 'Markdown 整理', group: 'code', alias: 'markdown 格式化 md 整理 空行',
    desc: '标题空格、列表符号规范、多余空行合并、行尾空白清理',
    icon: 'M4 6h16v12H4zM7 15V9.5M7 12l2.5-2.5M7 12l2.5 2.5M14.5 9.5V15M17 15l-2.5-5.5M17 15l2.5-5.5',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '粘贴 Markdown…',
        rows: 11,
        swap: true,
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          out.set(Fmt.formatMarkdown(text));
        }
      });
      host.appendChild(UI.hint('规范化：# 后补空格、列表统一为「- 」、连续空行合并为一个、去除行尾空白；代码块内不做改动。'));
    }
  });

  /* ---------- XML ↔ JSON ---------- */
  App.tool({
    id: 'xmljson', name: 'XML ↔ JSON', group: 'code', alias: 'xml转json json转xml xml json',
    desc: 'XML 与 JSON 双向转换（属性用 @、文本用 #）',
    icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 11h6M9 14h6M9 17h4',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入 JSON（转 XML）或 XML（转 JSON）…',
        rows: 11,
        swap: true,
        options: [
          {
            kind: 'select', id: 'xjDir', label: '方向', value: 'auto', options: [
              { v: 'auto', t: '自动判断' }, { v: 'j2x', t: 'JSON → XML' }, { v: 'x2j', t: 'XML → JSON' }
            ]
          },
          { kind: 'input', id: 'xjRoot', label: 'XML 根节点名', ph: 'root', value: 'root' },
          indentSel('xjInd')
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var s = text.trim();
          var dir = v.xjDir === 'auto' ? (s[0] === '<' ? 'x2j' : 'j2x') : v.xjDir;
          if (dir === 'x2j') out.set(Serial.xmlToJson(s));
          else out.set(Serial.jsonToXml(Fmt.parseJsonLoose(s), v.xjRoot || 'root', indentVal('xjInd') === '\t' ? 4 : indentVal('xjInd')));
        }
      });
      host.appendChild(UI.hint('规则：XML 属性映射为 JSON 的 @attr，标签文本为 #，重复标签为数组；JSON 转 XML 时数组生成重复标签。'));
    }
  });

  /* ---------- YAML ↔ JSON ---------- */
  App.tool({
    id: 'yamljson', name: 'YAML ↔ JSON', group: 'code', alias: 'yaml转json json转yaml yaml k8s',
    desc: 'YAML 与 JSON 双向转换（基于 js-yaml）',
    icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 12l2 2 4-5M9 17h6',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入 JSON（转 YAML）或 YAML（转 JSON）…',
        rows: 11,
        swap: true,
        options: [
          {
            kind: 'select', id: 'yjDir', label: '方向', value: 'auto', options: [
              { v: 'auto', t: '自动判断' }, { v: 'j2y', t: 'JSON → YAML' }, { v: 'y2j', t: 'YAML → JSON' }
            ]
          }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          var s = text.trim();
          var dir = v.yjDir === 'auto' ? (s[0] === '{' || s[0] === '[' ? 'j2y' : 'y2j') : v.yjDir;
          if (dir === 'y2j') out.set(Serial.yamlToJson(s));
          else out.set(Serial.jsonToYaml(Fmt.parseJsonLoose(s)));
        }
      });
      host.appendChild(UI.hint('自动判断按首字符：{ [ 开头视为 JSON，否则按 YAML 解析（支持多文档时取首段）。'));
    }
  });

  /* ---------- JSON ↔ PHP 数组 / properties / serialize ---------- */
  App.tool({
    id: 'jsonconv', name: 'JSON 多格式互转', group: 'code', alias: 'php数组 properties serialize php序列化 env 配置互转',
    desc: 'JSON ↔ PHP 数组 / properties / PHP serialize 双向转换',
    icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 11h2M13 11h2M9 14.5h2M13 14.5h2M9 18h6',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入 JSON 或目标格式文本…',
        rows: 11,
        swap: true,
        options: [
          {
            kind: 'select', id: 'jcTarget', label: '目标格式', value: 'php', options: [
              { v: 'php', t: 'PHP 数组' }, { v: 'props', t: 'properties (.properties)' }, { v: 'ser', t: 'PHP serialize' }
            ]
          },
          {
            kind: 'select', id: 'jcDir', label: '方向', value: 'j2x', options: [
              { v: 'j2x', t: 'JSON → 目标' }, { v: 'x2j', t: '目标 → JSON' }
            ]
          },
          {
            kind: 'select', id: 'jcStyle', label: 'PHP 风格', value: 'short', options: [
              { v: 'short', t: '短数组 [...]（PHP 5.4+）' }, { v: 'long', t: 'array(...) 传统写法' }
            ]
          },
          { kind: 'input', id: 'jcSep', label: 'properties 分隔符', ph: '.', value: '.' }
        ],
        live: function (text, v, out) {
          if (!text.trim()) { out.set(''); return; }
          if (v.jcDir === 'j2x') {
            var obj = Fmt.parseJsonLoose(text);
            if (v.jcTarget === 'php') {
              out.set(Serial.jsonToPhp(obj, { style: v.jcStyle === 'long' ? 'array' : undefined }));
            } else if (v.jcTarget === 'props') {
              out.set(Serial.jsonToProps(obj, { sep: v.jcSep || '.', array: 'index' }));
            } else {
              out.set(Serial.jsonToPhpSerialize(obj));
            }
          } else {
            if (v.jcTarget === 'php') out.set(Serial.phpToJson(text));
            else if (v.jcTarget === 'props') out.set(Serial.propsToJson(text));
            else out.set(Serial.phpSerializeToJson(text));
          }
        }
      });
      host.appendChild(UI.hint('properties 数组按下标展开 key[0]=…；PHP serialize 仅支持 UTF-8 字符串。目标 → JSON 时请确认方向与格式一致。'));
    }
  });
})();