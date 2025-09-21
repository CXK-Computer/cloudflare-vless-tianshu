import { connect as tlsConnect } from 'node:tls';

// ================== 日志系统 ==================
// 用于存储最近的错误日志
let errorLogs = [];
// 日志最大存储数量
const MAX_LOGS = 25;

/**
 * 记录一个错误日志
 * @param {string} message - 错误的主要信息
 * @param {object} details - 包含错误上下文的附加对象
 */
function logError(message, details = {}) {
  const timestamp = new Date().toISOString();
  console.error(message, details); 
  errorLogs.unshift({
    timestamp,
    message,
    details: JSON.stringify(details, (key, value) => 
      value instanceof Error ? { message: value.message, stack: value.stack } : value, 2)
  });
  if (errorLogs.length > MAX_LOGS) {
    errorLogs.length = MAX_LOGS;
  }
}
// ============================================

// 支持全局代理路径配置 /socks5://, /http://, 和 /https://
let 哎呀呀这是我的VL密钥 = "fb00086e-abb9-4983-976f-d407bbea9a4c";

class NodeToWebStreamAdapter {
  constructor(nodeStream) {
    this.opened = new Promise((resolve, reject) => {
      nodeStream.once('secureConnect', resolve);
      nodeStream.once('error', reject);
    });
    this.readable = new ReadableStream({
      start(controller) {
        nodeStream.on('data', chunk => controller.enqueue(chunk));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', err => controller.error(err));
      },
      cancel() { nodeStream.destroy(); }
    });
    this.writable = new WritableStream({
      write(chunk) { return new Promise(resolve => nodeStream.write(chunk, resolve)); },
      close() { return new Promise(resolve => nodeStream.end(resolve)); },
      abort(err) { nodeStream.destroy(err); }
    });
  }
}

function 解析代理路径(路径) {
  const proxyMatch = 路径.match(/\/(socks5|http|https):\/\/([^\/\?&]+)/);
  return proxyMatch ? { 类型: proxyMatch[1], 账号: [decodeURIComponent(proxyMatch[2])] } : { 类型: 'direct' };
}

function base64Decode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return atob(padded);
}

async function 启动传输管道(WS接口, 代理配置) {
  let TCP接口, 首包数据 = false, 首包处理完成, 传输数据, 读取数据, 传输队列 = Promise.resolve();
  try {
    WS接口.addEventListener('message', async event => {
      if (!首包数据) {
        首包数据 = true;
        首包处理完成 = 解析首包数据(event.data);
        传输队列 = 传输队列.then(() => 首包处理完成).catch();
      } else {
        await 首包处理完成;
        传输队列 = 传输队列.then(async () => await 传输数据.write(event.data)).catch();
      }
    });
    async function 解析首包数据(首包数据) {
      const 二进制数据 = new Uint8Array(首包数据);
      const 验证VL的密钥 = (a, i = 0) => [...a.slice(i, i + 16)].map(b => b.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      if (验证VL的密钥(二进制数据.slice(1, 17)) !== 哎呀呀这是我的VL密钥) throw new Error('UUID验证失败');
      const 端口索引 = 18 + 二进制数据[17] + 1;
      const 访问端口 = new DataView(二进制数据.buffer, 端口索引, 2).getUint16(0);
      if (访问端口 === 53) {
        const DNS查询 = 二进制数据.slice(端口索引 + 9);
        const DOH结果 = await (await fetch('https://dns.google/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: DNS查询 })).arrayBuffer();
        WS接口.send(await new Blob([new Uint8Array([(DOH结果.byteLength >> 8) & 0xff, DOH结果.byteLength & 0xff]), DOH结果]));
        return;
      }
      const 地址索引 = 端口索引 + 2;
      const 地址类型 = 二进制数据[地址索引];
      let 地址信息索引 = 地址索引 + 1, 访问地址, 地址长度;
      switch (地址类型) {
        case 1: 地址长度 = 4; 访问地址 = 二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度).join('.'); break;
        case 2: 地址长度 = 二进制数据[地址信息索引++]; 访问地址 = new TextDecoder().decode(二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度)); break;
        case 3: 地址长度 = 16; const ipv6 = []; const 读取IPV6 = new DataView(二进制数据.buffer, 地址信息索引, 16); for (let i = 0; i < 8; i++) ipv6.push(读取IPV6.getUint16(i * 2).toString(16)); 访问地址 = ipv6.join(':'); break;
        default: throw new Error('无效的访问地址');
      }
      TCP接口 = await 创建代理连接(代理配置, 地址类型, 访问地址, 访问端口);
      await TCP接口.opened;
      传输数据 = TCP接口.writable.getWriter();
      读取数据 = TCP接口.readable.getReader();
      const 初始数据 = 二进制数据.slice(地址信息索引 + 地址长度);
      if (初始数据.length) await 传输数据.write(初始数据);
      启动回传管道();
    }
    async function 启动回传管道() {
      while (true) {
        const { done, value } = await 读取数据.read();
        if (value?.length > 0) 传输队列 = 传输队列.then(() => WS接口.send(value)).catch();
        if (done) break;
      }
    }
  } catch (e) {
    logError('传输管道发生致命错误', { error: e });
    WS接口.close();
  }
}

async function 创建代理连接(代理配置, 地址类型, 访问地址, 访问端口) {
  if (代理配置.类型 === 'https') {
    for (const 账号字符串 of 代理配置.账号) {
      try {
        const { 账号, 密码, 地址, 端口 } = 解析代理账号(账号字符串);
        const nodeSocket = tlsConnect({ host: 地址, port: 端口, rejectUnauthorized: false });
        const adapter = new NodeToWebStreamAdapter(nodeSocket);
        await adapter.opened;
        await 建立HTTP连接(adapter, 账号, 密码, 地址类型, 访问地址, 访问端口);
        return adapter;
      } catch (error) {
        logError(`HTTPS 代理连接失败`, { proxy: 账号字符串, target: `${访问地址}:${访问端口}`, error: error });
      }
    }
    throw new Error(`所有 HTTPS 代理失效`);
  }
  if (代理配置.类型 === 'direct') {
    const hostname = 地址类型 === 3 ? `[${访问地址}]` : 访问地址;
    return (await import('cloudflare:sockets')).connect({ hostname, port: 访问端口 });
  }
  for (const 账号字符串 of 代理配置.账号) {
    try {
      const { 账号, 密码, 地址, 端口 } = 解析代理账号(账号字符串);
      const socket = (await import('cloudflare:sockets')).connect({ hostname: 地址, port: 端口 });
      await socket.opened;
      if (代理配置.类型 === 'socks5') {
        await 建立SOCKS5连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口);
      } else {
        await 建立HTTP连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口);
      }
      return socket;
    } catch (error) {
      logError(`${代理配置.类型} 代理连接失败`, { proxy: 账号字符串, target: `${访问地址}:${访问端口}`, error: error });
    }
  }
  throw new Error(`所有 ${代理配置.类型} 代理失效`);
}

async function 建立SOCKS5连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  try {
    await writer.write(new Uint8Array([5, 2, 0, 2]));
    const authResponse = (await reader.read()).value;
    if (authResponse[1] === 0x02) {
      if (!账号 || !密码) throw new Error('未配置账号密码');
      await writer.write(new Uint8Array([1, 账号.length, ...encoder.encode(账号), 密码.length, ...encoder.encode(密码)]));
      const authResult = (await reader.read()).value;
      if (authResult[0] !== 0x01 || authResult[1] !== 0x00) throw new Error('账号密码错误');
    }
    let 地址数据;
    switch (地址类型) {
      case 1: 地址数据 = new Uint8Array([1, ...访问地址.split('.').map(Number)]); break;
      case 2: 地址数据 = new Uint8Array([3, 访问地址.length, ...encoder.encode(访问地址)]); break;
      case 3: 地址数据 = 构建IPv6地址(访问地址); break;
    }
    await writer.write(new Uint8Array([5, 1, 0, ...地址数据, 访问端口 >> 8, 访问端口 & 0xff]));
    const connectResponse = (await reader.read()).value;
    if (connectResponse[0] !== 0x05 || connectResponse[1] !== 0x00) throw new Error(`连接失败: ${访问地址}:${访问端口}`);
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

async function 建立HTTP连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  try {
    const 目标地址 = 地址类型 === 3 ? `[${访问地址}]:${访问端口}` : `${访问地址}:${访问端口}`;
    let HTTP请求 = `CONNECT ${目标地址} HTTP/1.1\r\nHost: ${目标地址}\r\n`;
    if (账号 || 密码) {
      HTTP请求 += `Proxy-Authorization: Basic ${btoa(`${账号}:${密码}`)}\r\n`;
    }
    await writer.write(new TextEncoder().encode(HTTP请求 + '\r\n'));
    let 响应 = '', decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('连接中断');
      响应 += decoder.decode(value, { stream: true });
      if (响应.includes('\r\n\r\n')) break;
    }
    const 状态码 = 响应.match(/HTTP\/1\.[01]\s+(\d+)/)?.[1];
    if (状态码 !== '200') throw new Error(`连接失败: ${响应.split('\r\n')[0]}`);
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

function 构建IPv6地址(地址) {
  const 去括号 = 地址.replace(/^\[|\]$/g, '');
  const 分段 = 去括号.split('::');
  const 前缀 = 分段[0] ? 分段[0].split(':').filter(Boolean) : [];
  const 后缀 = 分段[1] ? 分段[1].split(':').filter(Boolean) : [];
  const 完整分段 = [...前缀, ...Array(8 - 前缀.length - 后缀.length).fill('0'), ...后缀];
  const IPv6字节 = 完整分段.flatMap(段 => { const v = parseInt(段 || '0', 16); return [v >> 8, v & 0xff]; });
  return new Uint8Array([0x04, ...IPv6字节]);
}

function 解析代理账号(代理字符串) {
  const atIndex = 代理字符串.lastIndexOf("@");
  const 账号段 = 代理字符串.slice(0, atIndex);
  const 地址段 = 代理字符串.slice(atIndex + 1);
  let 账号 = '', 密码 = '';
  if (atIndex !== -1 && 账号段) {
    try {
      const 解码 = base64Decode(账号段);
      const colonIndex = 解码.indexOf(":");
      账号 = colonIndex !== -1 ? 解码.slice(0, colonIndex) : 解码;
      密码 = colonIndex !== -1 ? 解码.slice(colonIndex + 1) : '';
    } catch {
      const colonIndex = 账号段.lastIndexOf(":");
      账号 = colonIndex !== -1 ? 账号段.slice(0, colonIndex) : 账号段;
      密码 = colonIndex !== -1 ? 账号段.slice(colonIndex + 1) : '';
    }
  }
  const [地址, 端口 = 443] = 地址段.includes('[') ? [地址段.slice(0, 地址段.lastIndexOf(']') + 1), 地址段.split(']:')[1]] : 地址段.split(':');
  return { 账号, 密码, 地址, 端口: parseInt(端口) };
}

export default {
  async fetch(访问请求, env, ctx) {
    try {
      if (访问请求.headers.get('Upgrade') === 'websocket') {
        const 路径 = 访问请求.url.replace(/^https?:\/\/[^/]+/, '');
        const 代理配置 = 解析代理路径(路径);
        const [客户端, WS接口] = Object.values(new WebSocketPair());
        WS接口.accept();
        WS接口.send(new Uint8Array([0, 0]));
        ctx.waitUntil(启动传输管道(WS接口, 代理配置));
        return new Response(null, { status: 101, webSocket: 客户端 });
      }

      const url = new URL(访问请求.url);
      const hostname = url.hostname;
      const uuid = 哎呀呀这是我的VL密钥;
      const vlessLink = `vless://${uuid}@${hostname}:443?sni=${hostname}&host=${hostname}&type=ws&security=tls&path=%2F&encryption=none`;
      
      const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Worker 配置与日志</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.6; background-color: #f4f4f9; color: #333; margin: 0; padding: 20px; }
              .container { max-width: 800px; margin: 20px auto; background: #fff; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              h1, h2 { color: #2a2a2a; border-bottom: 2px solid #eaeaea; padding-bottom: 10px; }
              p { color: #555; }
              button { background-color: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; font-size: 16px; transition: background-color 0.3s; }
              button:hover { background-color: #0056b3; }
              .link-box { display: flex; align-items: center; justify-content: space-between; background: #f0f0f0; border: 1px solid #ddd; border-radius: 5px; padding: 10px; margin-top: 15px; }
              .link-box pre { flex-grow: 1; margin: 0; padding-right: 15px; white-space: pre-wrap; word-break: break-all; font-family: "Courier New", Courier, monospace; font-size: 14px; }
              .copy-button { background-color: #28a745; }
              .copy-button:hover { background-color: #218838; }
              #copy-status { color: #28a745; margin-top: 10px; font-weight: bold; display: none; }
              hr.separator { border: none; border-top: 1px solid #ccc; margin: 40px auto; max-width: 800px; }
              #logs { margin-top: 20px; }
              .log-entry { background: #f9f9f9; border: 1px solid #ddd; border-radius: 5px; padding: 15px; margin-bottom: 15px; word-wrap: break-word; }
              .log-entry p { margin: 0 0 10px; }
              .log-entry strong { color: #1a1a1a; }
              .log-entry pre { background: #e9e9e9; padding: 10px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; font-family: "Courier New", Courier, monospace; }
              .no-logs { color: #888; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>VLESS 配置链接</h1>
              <p>点击下方按钮复制基础直连模式的 VLESS 配置链接 (Path: /)。</p>
              <div class="link-box">
                  <pre id="vless-link">${vlessLink}</pre>
                  <button class="copy-button" onclick="copyToClipboard()">复制</button>
              </div>
              <p id="copy-status">已复制到剪贴板！</p>
          </div>
      
          <hr class="separator">
      
          <div class="container">
              <h2>Worker 运行日志</h2>
              <p>此页面显示最近在后台发生的连接错误。刷新此页面以查看最新日志。</p>
              <button onclick="location.reload()">刷新日志</button>
              <div id="logs">
                  ${errorLogs.length === 0 
                      ? '<p class="no-logs">目前没有错误日志。尝试使用客户端连接一次，如果失败，错误将显示在这里。</p>' 
                      : errorLogs.map(log => `
                          <div class="log-entry">
                              <p><strong>时间 (UTC):</strong> ${log.timestamp}</p>
                              <p><strong>信息:</strong> ${log.message}</p>
                              <pre><strong>详情:</strong>\n${log.details}</pre>
                          </div>
                      `).join('')}
              </div>
          </div>
      
          <script>
              function copyToClipboard() {
                  const linkText = document.getElementById('vless-link').innerText;
                  const tempInput = document.createElement('textarea');
                  tempInput.style.position = 'absolute';
                  tempInput.style.left = '-9999px';
                  document.body.appendChild(tempInput);
                  tempInput.value = linkText;
                  tempInput.select();
                  document.execCommand('copy');
                  document.body.removeChild(tempInput);

                  const status = document.getElementById('copy-status');
                  status.style.display = 'block';
                  setTimeout(() => {
                      status.style.display = 'none';
                  }, 2000);
              }
          </script>
      </body>
      </html>
      `;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    } catch (error) {
      logError('Fetch Handler 发生致命错误', { error: error });
      return new Response(`Worker 发生严重错误: ${error.message}`, { status: 500 });
    }
  }
};

