// 实时通道：一个零依赖的极简 WebSocket 服务端。
// 只做两件事：把事件广播出去、把看板的审批决定收进来。
// 与「参考 demo 的纯前端 board」不同，这条路必须有进程 —— 因为要拦的是在途的一次 RPC。
// 强约束：绑定 127.0.0.1 + 必须带 token，否则任何本机进程都能替人点「批准」。
// @see [SPEC §4.2 实时通道鉴权（v1 缺失）](SPEC.md#42-实时通道鉴权v1-缺失)
import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) break;
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) === 0x80;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    offset = p + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/**
 * @param {{port:number, token:string, onMessage?:(msg:any)=>void, onClientCount?:(n:number)=>void}} opts
 *        port 传 0 表示随机端口
 */
export function startWsServer({ port = 9001, token, onMessage = () => {}, onClientCount = () => {} }) {
  return new Promise((resolve, reject) => {
    const clients = new Set();

    const server = http.createServer((req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`本端口只接受 WebSocket 升级。示例：ws://127.0.0.1:${server.address()?.port}/?token=<token>\n`);
    });

    server.on('upgrade', (req, socket) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const provided = url.searchParams.get('token') ?? req.headers['x-trace-token'];
      if (!token || provided !== token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'),
      );
      socket.setNoDelay(true);

      let buf = Buffer.alloc(0);
      const client = { socket, id: crypto.randomUUID().slice(0, 8) };
      clients.add(client);
      onClientCount(clients.size);

      const send = (obj) => {
        try {
          socket.write(encodeFrame(JSON.stringify(obj)));
        } catch {
          /* 客户端已断，忽略 */
        }
      };
      client.send = send;

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.opcode === 0x8) {
            socket.end();
            continue;
          }
          if (f.opcode === 0x9) {
            try {
              socket.write(encodeFrame(f.payload, 0xa));
            } catch {
              /* ignore */
            }
            continue;
          }
          if (f.opcode !== 0x1) continue;
          let parsed;
          try {
            parsed = JSON.parse(f.payload.toString('utf8'));
          } catch {
            continue;
          }
          try {
            onMessage(parsed, client);
          } catch {
            /* 回调异常不能拖垮通道 */
          }
        }
      });
      const drop = () => {
        if (clients.delete(client)) onClientCount(clients.size);
      };
      socket.on('error', drop);
      socket.on('close', drop);
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        url: `ws://127.0.0.1:${actualPort}/?token=${token}`,
        broadcast(obj) {
          const frame = encodeFrame(JSON.stringify(obj));
          for (const c of clients) {
            try {
              c.socket.write(frame);
            } catch {
              /* ignore */
            }
          }
        },
        clientCount: () => clients.size,
        close() {
          for (const c of clients) {
            try {
              c.socket.destroy();
            } catch {
              /* ignore */
            }
          }
          clients.clear();
          server.close();
        },
      });
    });
  });
}
