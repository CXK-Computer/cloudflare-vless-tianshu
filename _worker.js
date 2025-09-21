/**
 * VLESS & Trojan 双协议 Worker
 * 该脚本融合了模块化设计、面向对象的编程思想以及最高效的流处理技术，
 * 可以在单一 Cloudflare Worker 上同时处理 VLESS 和 Trojan 协议的 WebSocket 连接。
 * @version 3.0.1 - 修复了 fetch handler 中 ctx 参数缺失导致 1101 错误的 Bug。
 */

// 导入 Cloudflare Sockets API
import { connect } from 'cloudflare:sockets';

// ==================
//   配置管理模块
// ==================
class Config {
    constructor(env) {
        // VLESS UUID，提供一个默认值方便快速部署
        this.vlessId = env.UUID || "ef3dcc57-6689-48e4-b3f9-2a62d88c730a"; 
        // Trojan 密码，提供一个默认值方便快速部署
        this.trojanPassword = env.TROJAN_PASSWORD || "aaeaa2f3-1a94-46fb-8438-23f46052a0fa";
        this.validate();
    }
    validate() {
        if (!this.vlessId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this.vlessId)) {
            throw new Error('无效或缺失的 VLESS UUID');
        }
        if (!this.trojanPassword) {
            throw new Error('缺失的 Trojan 密码');
        }
    }
}

// ==================
//   日志系统模块
// ==================
class Logger {
    constructor(prefix = '') {
        this.prefix = prefix ? `[${prefix}] ` : '';
    }
    info(message, ...args) {
        console.log(`${this.prefix}${message}`, ...args);
    }
    error(message, ...args) {
        console.error(`${this.prefix}${message}`, ...args);
    }
}

// 用于在前端 UI 页面显示的全局日志数组
const globalLogs = [];
function logToUI(level, message, details) {
    const timestamp = new Date().toISOString();
    globalLogs.unshift({
        timestamp,
        level,
        message,
        details: JSON.stringify(details, (key, value) =>
            value instanceof Error ? { message: value.message, stack: value.stack } : value, 2)
    });
    if (globalLogs.length > 50) {
        globalLogs.length = 50;
    }
}

// ==================
//   协议处理模块
// ==================
class VlessProtocolHandler {
    constructor(userId) {
        this.userIdBytes = this.parseUUID(userId);
    }

    parseUUID(uuid) {
        const hex = uuid.replace(/-/g, '');
        return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    parseHeader(buffer) {
        const view = new DataView(buffer);
        if (view.byteLength < 24) return { error: '数据包过短 (VLESS)' };

        const receivedUUID = new Uint8Array(buffer, 1, 16);
        for (let i = 0; i < 16; i++) {
            if (this.userIdBytes[i] !== receivedUUID[i]) {
                return { error: 'UUID 认证失败' };
            }
        }

        const version = view.getUint8(0);
        const optLength = view.getUint8(17);
        const command = view.getUint8(18 + optLength);

        if (command !== 1) return { error: `仅支持 TCP (VLESS)，收到: ${command}` };

        let offset = 19 + optLength;
        const port = view.getUint16(offset);
        offset += 2;

        const addressType = view.getUint8(offset);
        offset += 1;

        let address, addressLength;
        switch (addressType) {
            case 1: // IPv4
                addressLength = 4;
                address = Array.from(new Uint8Array(buffer, offset, addressLength)).join('.');
                break;
            case 2: // Domain
                addressLength = view.getUint8(offset);
                offset += 1;
                address = new TextDecoder().decode(new Uint8Array(buffer, offset, addressLength));
                break;
            case 3: // IPv6
                addressLength = 16;
                const ipv6Bytes = new Uint8Array(buffer, offset, addressLength);
                address = Array.from({ length: 8 }, (_, i) => new DataView(ipv6Bytes.buffer, ipv6Bytes.byteOffset + i * 2, 2).getUint16(0).toString(16)).join(':');
                break;
            default:
                return { error: `未知的地址类型 (VLESS): ${addressType}` };
        }

        const dataStartIndex = offset + addressLength;
        return { protocol: 'vless', version, address, port, dataStartIndex };
    }
}

class TrojanProtocolHandler {
    constructor(password) {
        this.expectedHashBytes = this.hexToBytes(this.sha224(password));
    }

    parseHeader(buffer) {
        if (buffer.byteLength < 58) return { error: '数据包过短 (Trojan)' };
        const receivedHash = new Uint8Array(buffer, 0, 56);
        for (let i = 0; i < 56; i++) {
            if (this.expectedHashBytes[i] !== receivedHash[i]) {
                return { error: '密码认证失败 (Trojan)' };
            }
        }

        let offset = 58; // 56 for hash + 2 for CRLF
        if (buffer[offset++] !== 1) return { error: '仅支持 CONNECT 命令 (Trojan)' };

        const view = new DataView(buffer);
        const addressType = view.getUint8(offset++);
        let address, addressLength;

        switch (addressType) {
            case 1: // IPv4
                addressLength = 4;
                address = Array.from(new Uint8Array(buffer, offset, addressLength)).join('.');
                break;
            case 3: // Domain
                addressLength = view.getUint8(offset++);
                address = new TextDecoder().decode(new Uint8Array(buffer, offset, addressLength));
                break;
            case 4: // IPv6
                addressLength = 16;
                const ipv6Bytes = new Uint8Array(buffer, offset, addressLength);
                address = Array.from({ length: 8 }, (_, i) => new DataView(ipv6Bytes.buffer, ipv6Bytes.byteOffset + i * 2, 2).getUint16(0).toString(16)).join(':');
                break;
            default:
                return { error: `未知的地址类型 (Trojan): ${addressType}` };
        }
        
        offset += addressLength;
        const port = view.getUint16(offset);
        offset += 2; // port
        offset += 2; // CRLF

        const dataStartIndex = offset;
        return { protocol: 'trojan', address, port, dataStartIndex };
    }
    
    hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
        }
        return bytes;
    }

    // Pure JS SHA-224 implementation
    sha224(message) {
        const K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        let H = [
            0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
            0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4
        ];

        const msg_utf8 = unescape(encodeURIComponent(message));
        const msg_len = msg_utf8.length;
        const msg_words = [];

        for (let i = 0; i < msg_len; i++) {
            msg_words[i >> 2] |= msg_utf8.charCodeAt(i) << (24 - (i % 4) * 8);
        }
        msg_words[msg_len >> 2] |= 0x80 << (24 - (msg_len % 4) * 8);
        msg_words[(((msg_len + 8) >> 6) << 4) + 15] = msg_len * 8;
        
        const rotateRight = (n, s) => (n >>> s) | (n << (32 - s));

        for (let i = 0; i < msg_words.length; i += 16) {
            const w = new Array(64);
            for (let j = 0; j < 16; j++) w[j] = msg_words[i + j];
            for (let j = 16; j < 64; j++) {
                const s0 = rotateRight(w[j - 15], 7) ^ rotateRight(w[j - 15], 18) ^ (w[j - 15] >>> 3);
                const s1 = rotateRight(w[j - 2], 17) ^ rotateRight(w[j - 2], 19) ^ (w[j - 2] >>> 10);
                w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
            }

            let [a, b, c, d, e, f, g, h] = H;
            for (let j = 0; j < 64; j++) {
                const S1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
                const ch = (e & f) ^ (~e & g);
                const temp1 = (h + S1 + ch + K[j] + w[j]) | 0;
                const S0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (S0 + maj) | 0;
                h = g; g = f; f = e; e = (d + temp1) | 0;
                d = c; c = b; b = a; a = (temp1 + temp2) | 0;
            }

            H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
            H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
        }
        
        return H.slice(0, 7).map(word => {
            const hex = word.toString(16);
            return '0'.repeat(8 - hex.length) + hex;
        }).join('');
    }
}


// ==================
//   主逻辑入口
// ==================
export default {
    async fetch(request, env, ctx) { // <--- 修复点 1: 补上 ctx 参数
        const logger = new Logger('Main');
        try {
            const config = new Config(env);

            if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
                return this.generateUIPage(request, config);
            }

            const [client, server] = Object.values(new WebSocketPair());
            server.accept();

            // <--- 修复点 2: 使用正确的 ctx.waitUntil
            ctx.waitUntil(this.handleWebSocket(server, request, config).catch(err => {
                logger.error('WebSocket 处理失败:', err);
                logToUI('error', 'WebSocket 处理失败', { error: err });
                server.close(1011, 'Internal Error');
            }));

            return new Response(null, { status: 101, webSocket: client });

        } catch (err) {
            logger.error('Fetch handler 错误:', err);
            logToUI('error', 'Fetch handler 错误', { error: err });
            return new Response(err.message, { status: 500 });
        }
    },

    async handleWebSocket(webSocket, request, config) {
        const connectionId = crypto.randomUUID().slice(0, 8);
        const logger = new Logger(connectionId);

        const wsStream = new ReadableStream({
            start(controller) {
                webSocket.addEventListener('message', event => controller.enqueue(event.data));
                webSocket.addEventListener('close', () => controller.close());
                webSocket.addEventListener('error', err => controller.error(err));
            }
        });
        
        const wsReader = wsStream.getReader();
        const { value: firstChunk, done } = await wsReader.read();

        if (done) throw new Error('客户端未发送数据即关闭连接');
        
        // --- 智能协议探测 ---
        const trojanHandler = new TrojanProtocolHandler(config.trojanPassword);
        let headerResult = trojanHandler.parseHeader(firstChunk);

        if (headerResult.error) { // 如果不是 Trojan, 尝试 VLESS
            const vlessHandler = new VlessProtocolHandler(config.vlessId);
            headerResult = vlessHandler.parseHeader(firstChunk);
            if (headerResult.error) {
                logToUI('error', '协议认证失败', { error: '既不是 VLESS 也不是 Trojan', connectionId });
                throw new Error('协议认证失败');
            }
        }
        // ---------------------

        const { protocol, address, port, dataStartIndex } = headerResult;
        logger.info(`协议: ${protocol}, 请求: ${address}:${port}`);
        
        // 根据协议发送不同响应
        if (protocol === 'vless') {
            webSocket.send(new Uint8Array([headerResult.version, 0])); // VLESS 响应
        }
        // Trojan 协议不需要初始响应

        // 注意：这个简化版本不包含链式代理，如有需要需添加 ConnectionHandler
        logger.info(`正在直连: ${address}:${port}`);
        const hostname = address.includes(':') ? `[${address}]` : address;
        const remoteSocket = await connect({ hostname, port });
        
        const initialData = firstChunk.slice(dataStartIndex);
        
        const readable = new ReadableStream({
            start(controller) {
                if (initialData.byteLength > 0) {
                    controller.enqueue(initialData);
                }
                
                (async () => {
                    while(true) {
                        try {
                            const { value, done } = await wsReader.read();
                            if (done) {
                                controller.close();
                                break;
                            }
                            controller.enqueue(value);
                        } catch(err) {
                            controller.error(err);
                            break;
                        }
                    }
                })();
            }
        });
        
        // 使用 pipeTo 实现高效转发
        readable.pipeTo(remoteSocket.writable, { preventClose: true }).catch(err => logger.error("WS->Remote pipe error:", err));
        logger.info(`✅ [${protocol}] WS -> Remote pipe setup complete.`);
        
        remoteSocket.readable.pipeTo(new WritableStream({
            write(chunk) {
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(chunk);
                }
            },
            close() {
                logger.info('Remote closed, closing WebSocket.');
                webSocket.close(1000);
            }
        })).catch(err => logger.error("Remote->WS pipe error:", err));

        logger.info(`✅ [${protocol}] Remote -> WS pipe setup complete.`);
    },

    generateUIPage(request, config) {
      const url = new URL(request.url);
      const hostname = url.hostname;
      const vlessLink = `vless://${config.vlessId}@${hostname}:443?encryption=none&security=tls&sni=${hostname}&type=ws&host=${hostname}&path=${encodeURIComponent('/')}#${hostname}-VLESS`;
      const trojanLink = `trojan://${config.trojanPassword}@${hostname}:443?security=tls&sni=${hostname}&type=ws&host=${hostname}&path=${encodeURIComponent('/')}#${hostname}-Trojan`;
      
      const logsHtml = globalLogs.length === 0 
          ? '<p class="no-logs">目前没有错误日志。</p>' 
          : globalLogs.map(log => `
              <div class="log-entry" style="border-left: 4px solid ${log.level === 'error' ? '#f44336' : '#2196F3'};">
                  <p><strong>时间 (UTC):</strong> ${log.timestamp}</p>
                  <p><strong>信息:</strong> ${log.message}</p>
                  <pre><strong>详情:</strong>\n${log.details}</pre>
              </div>
          `).join('');

      const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>双协议 Worker 配置</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.6; background-color: #f4f4f9; color: #333; margin: 0; padding: 20px; }
              .container { max-width: 800px; margin: 20px auto; background: #fff; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              h1, h2 { color: #2a2a2a; border-bottom: 2px solid #eaeaea; padding-bottom: 10px; }
              .protocol-section { margin-bottom: 30px; }
              .link-box { display: flex; align-items: center; justify-content: space-between; background: #f0f0f0; border: 1px solid #ddd; border-radius: 5px; padding: 10px; margin-top: 15px; }
              .link-box pre { flex-grow: 1; margin: 0; padding-right: 15px; white-space: pre-wrap; word-break: break-all; font-family: "Courier New", Courier, monospace; font-size: 14px; }
              .copy-button { background-color: #28a745; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; font-size: 16px; transition: background-color 0.3s; }
              .copy-button:hover { background-color: #218838; }
              #copy-status { color: #28a745; margin-top: 10px; font-weight: bold; display: none; }
              hr.separator { border: none; border-top: 1px solid #ccc; margin: 40px auto; }
              #logs { margin-top: 20px; }
              .log-entry { background: #f9f9f9; border-radius: 5px; padding: 15px; margin-bottom: 15px; word-wrap: break-word; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>VLESS & Trojan 双协议配置</h1>
              <p>此 Worker 同时支持 VLESS 和 Trojan 协议。请根据您的客户端选择下方对应的配置链接。</p>
              
              <div class="protocol-section">
                  <h2>VLESS 配置</h2>
                  <div class="link-box">
                      <pre id="vless-link">${vlessLink}</pre>
                      <button class="copy-button" onclick="copyToClipboard('vless-link')">复制</button>
                  </div>
              </div>

              <div class="protocol-section">
                  <h2>Trojan 配置</h2>
                  <div class="link-box">
                      <pre id="trojan-link">${trojanLink}</pre>
                      <button class="copy-button" onclick="copyToClipboard('trojan-link')">复制</button>
                  </div>
              </div>
              <p id="copy-status">已复制到剪贴板！</p>
          </div>
      
          <hr class="separator">
      
          <div class="container">
              <h2>Worker 运行日志</h2>
              <p>刷新此页面以查看最新日志。</p>
              <button onclick="location.reload()" style="background-color: #007bff;">刷新日志</button>
              <div id="logs">${logsHtml}</div>
          </div>
      
          <script>
              function copyToClipboard(elementId) {
                  const linkText = document.getElementById(elementId).innerText;
                  navigator.clipboard.writeText(linkText).then(() => {
                    const status = document.getElementById('copy-status');
                    status.style.display = 'block';
                    setTimeout(() => { status.style.display = 'none'; }, 2000);
                  });
              }
          </script>
      </body>
      </html>
      `;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
};

