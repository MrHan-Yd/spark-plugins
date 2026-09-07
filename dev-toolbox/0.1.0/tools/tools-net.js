/* tools-net.js — 网络计算组：IP/子网计算、HTTP 状态码速查 */
(function () {
  'use strict';

  /* ---------- IP / 子网计算 ---------- */
  App.tool({
    id: 'subnet', name: 'IP 子网计算', group: 'net', alias: '子网掩码 cidr ip计算 网段 广播地址',
    desc: 'CIDR/掩码解析：网络号、广播、可用主机、掩码各进制',
    icon: 'M12 3a2 2 0 1 0 .01 0zM5 13a2 2 0 1 0 .01 0zM19 13a2 2 0 1 0 .01 0zM12 5v4M12 9H6.5a2 2 0 0 0-2 2v0M12 9h5.5a2 2 0 0 1 2 2v0M7 15v2.5h10V15',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入 IP 或 CIDR，如 192.168.10.35/26、10.0.0.0/8、255.255.255.0 …',
        rows: 2,
        live: function (text, v, out) {
          if (!text.trim()) { out.setNode(UI.el('div', {})); return; }
          var s = text.trim();
          var i = NetCalc.subnetInfo(s);
          var node = UI.el('div', {});
          node.appendChild(UI.kvList([
            ['输入', i.ip + '/' + i.prefix],
            ['类别', i['class']],
            null,
            ['网络地址', i.network],
            ['广播地址', i.broadcast],
            ['可用主机范围', i.firstHost + ' — ' + i.lastHost],
            ['地址总数', i.total.toLocaleString('zh-CN')],
            ['可用主机数', i.usable.toLocaleString('zh-CN')],
            null,
            ['子网掩码', i.mask],
            ['反掩码 (wildcard)', i.wildcard],
            null,
            ['掩码二进制', i.maskBin],
            ['掩码十六进制', i.maskHex],
            ['IP 二进制', i.ipBin],
            ['IP 十六进制', i.ipHex],
            ['IP 十进制整数', i.ipDec],
            ['IP 八进制', i.ipOct]
          ]));
          out.setNode(node);
        }
      });
      host.appendChild(UI.hint('支持「IP/前缀长度」「IP 掩码」「纯 IP（默认 /32）」「纯掩码（推导前缀）」；/31、/32 按点对点与主机规则处理。点击数值可复制。'));
    }
  });

  /* ---------- HTTP 状态码速查 ---------- */
  var HTTP_CODES = [
    ['100', '1xx', 'Continue', '继续：请求已收到，客户端应继续发送剩余部分'],
    ['101', '1xx', 'Switching Protocols', '切换协议：如升级为 WebSocket'],
    ['102', '1xx', 'Processing', '处理中（WebDAV）'],
    ['103', '1xx', 'Early Hints', '早期提示：提前下发链接头'],
    ['200', '2xx', 'OK', '成功：请求已处理'],
    ['201', '2xx', 'Created', '已创建：新资源建立成功'],
    ['202', '2xx', 'Accepted', '已接受：任务进入队列，稍后处理'],
    ['204', '2xx', 'No Content', '成功但无返回体'],
    ['206', '2xx', 'Partial Content', '部分内容：Range 断点续传'],
    ['301', '3xx', 'Moved Permanently', '永久重定向（SEO 权重转移）'],
    ['302', '3xx', 'Found', '临时重定向（浏览器改为 GET）'],
    ['303', '3xx', 'See Other', '参见其它：用 GET 访问新 URI'],
    ['304', '3xx', 'Not Modified', '未修改：命中缓存协商'],
    ['307', '3xx', 'Temporary Redirect', '临时重定向（保持原方法）'],
    ['308', '3xx', 'Permanent Redirect', '永久重定向（保持原方法）'],
    ['400', '4xx', 'Bad Request', '请求语法错误'],
    ['401', '4xx', 'Unauthorized', '未认证：缺少或无效凭证'],
    ['403', '4xx', 'Forbidden', '已认证但无权限'],
    ['404', '4xx', 'Not Found', '资源不存在'],
    ['405', '4xx', 'Method Not Allowed', 'HTTP 方法不支持'],
    ['408', '4xx', 'Request Timeout', '请求超时'],
    ['409', '4xx', 'Conflict', '冲突：与资源当前状态矛盾'],
    ['410', '4xx', 'Gone', '资源已永久删除'],
    ['413', '4xx', 'Payload Too Large', '请求体超过上限'],
    ['415', '4xx', 'Unsupported Media Type', '媒体类型不支持'],
    ['422', '4xx', 'Unprocessable Entity', '语法正确但语义无法处理（校验失败）'],
    ['429', '4xx', 'Too Many Requests', '触发限流'],
    ['500', '5xx', 'Internal Server Error', '服务器内部错误'],
    ['501', '5xx', 'Not Implemented', '功能未实现'],
    ['502', '5xx', 'Bad Gateway', '网关收到无效上游响应'],
    ['503', '5xx', 'Service Unavailable', '服务暂不可用 / 过载'],
    ['504', '5xx', 'Gateway Timeout', '网关等待上游超时'],
    ['507', '5xx', 'Insufficient Storage', '存储空间不足（WebDAV）']
  ];
  App.tool({
    id: 'httpref', name: 'HTTP 状态码', group: 'net', alias: '状态码 http code 速查 404 500',
    desc: '常用 1xx–5xx 状态码含义速查，支持关键字过滤',
    icon: 'M4 5h16M4 10h16M4 15h10M4 20h7',
    render: function (host) {
      UI.ioTool(host, {
        placeholder: '输入代码或关键字过滤，如 404、redirect、重定向、超时…',
        rows: 1,
        options: [
          {
            kind: 'select', id: 'hpCat', label: '分类', value: 'all', options: [
              { v: 'all', t: '全部' }, { v: '1xx', t: '1xx 信息' }, { v: '2xx', t: '2xx 成功' },
              { v: '3xx', t: '3xx 重定向' }, { v: '4xx', t: '4xx 客户端错误' }, { v: '5xx', t: '5xx 服务端错误' }
            ]
          }
        ],
        live: function (text, v, out) {
          var kw = text.trim().toLowerCase();
          var node = UI.el('div', {});
          var pairs = [];
          for (var c of HTTP_CODES) {
            if (v.hpCat !== 'all' && c[1] !== v.hpCat) continue;
            if (kw && (c[0] + ' ' + c[2] + ' ' + c[3]).toLowerCase().indexOf(kw) < 0) continue;
            pairs.push(['HTTP ' + c[0], c[2] + ' — ' + c[3]]);
          }
          if (!pairs.length) pairs.push(['无匹配', '换一个关键字试试']);
          node.appendChild(UI.kvList(pairs));
          out.setNode(node);
        }
      });
    }
  });
})();