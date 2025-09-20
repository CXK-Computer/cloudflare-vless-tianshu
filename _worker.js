import { connect as tlsConnect } from 'node:tls';

// 支持全局代理路径配置 /socks5://, /http://, 和 /https://
let 哎呀呀这是我的VL密钥 = "fb01086e-abb9-4983-976f-d407bbea9a4c";

/**
 * 适配器类 (Adapter Class)
 * 作用: 将 Node.js 的 Duplex 流接口转换为 Web API 的 Streams (ReadableStream/WritableStream) 接口。
 * 原因: `node:tls` 返回的是 Node.js 风格的流, 而脚本的其他部分 (如 WebSocket) 使用的是 Web 标准流。
 * 这个适配器是两者之间的桥梁, 使得它们可以相互通信。
 */
class NodeToWebStreamAdapter {
  constructor(nodeStream) {
    // .opened 是一个 Promise, 在 TLS 连接成功建立后 resolve
    this.opened = new Promise((resolve, reject) => {
      nodeStream.once('secureConnect', resolve); // 对于 TLS, 我们等待 secureConnect 事件
      nodeStream.once('error', reject);
    });

    // 创建一个 ReadableStream 来读取从 Node.js 流传来的数据
    this.readable = new ReadableStream({
      start(controller) {
        nodeStream.on('data', chunk => {
          controller.enqueue(chunk);
          // 如果 Web Stream 的缓冲区满了, 就暂停从 Node.js 流读取数据, 以实现反压 (backpressure)
          if (controller.desiredSize <= 0) {
            nodeStream.pause();
          }
        });
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', err => controller.error(err));
      },
      // 当消费者准备好接收更多数据时, 恢复从 Node.js 流读取
      pull(controller) {
        nodeStream.resume();
      },
      cancel() {
        nodeStream.destroy();
      }
    });

    // 创建一个 WritableStream 来将数据写入到 Node.js 流
    this.writable = new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => {
          nodeStream.write(chunk, err => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      },
      close() {
        return new Promise(resolve => {
          nodeStream.end(resolve);
        });
      },
      abort(err) {
        nodeStream.destroy(err);
      }
    });
  }
}


// 解析代理路径配置
function 解析代理路径(路径) {
  // 修改: 增加了对 https 的支持
  const proxyMatch = 路径.match(/\/(socks5|http|https):\/\/([^\/\?&]+)/);
  return proxyMatch ? {
    类型: proxyMatch[1],
    账号: [decodeURIComponent(proxyMatch[2])]
  } : { 类型: 'direct' };
}

// Base64解码函数
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
        const DOH结果 = await (await fetch('https://dns.google/dns-query', {
          method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: DNS查询
        })).arrayBuffer();
        const 长度头部 = new Uint8Array([(DOH结果.byteLength >> 8) & 0xff, DOH结果.byteLength & 0xff]);
        WS接口.send(await new Blob([长度头部, DOH结果]));
        return;
      }
      
      const 地址索引 = 端口索引 + 2;
      const 地址类型 = 二进制数据[地址索引];
      let 地址信息索引 = 地址索引 + 1, 访问地址, 地址长度;
      
      switch (地址类型) {
        case 1:
          地址长度 = 4;
          访问地址 = 二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度).join('.');
          break;
        case 2:
          地址长度 = 二进制数据[地址信息索引++];
          访问地址 = new TextDecoder().decode(二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度));
          break;
        case 3:
          地址长度 = 16;
          const ipv6 = [], 读取IPV6 = new DataView(二进制数据.buffer, 地址信息索引, 16);
          for (let i = 0; i < 8; i++) ipv6.push(读取IPV6.getUint16(i * 2).toString(16));
          访问地址 = ipv6.join(':');
          break;
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
    console.error('传输管道错误:', e);
    WS接口.close();
  }
}

async function 创建代理连接(代理配置, 地址类型, 访问地址, 访问端口) {
  // 新增逻辑: 如果是 https 代理, 使用 Node.js tls 模块以跳过证书验证
  if (代理配置.类型 === 'https') {
    for (const 账号字符串 of 代理配置.账号) {
      try {
        const { 账号, 密码, 地址, 端口 } = 解析代理账号(账号字符串);
        
        const nodeSocket = tlsConnect({
          host: 地址,
          port: 端口,
          rejectUnauthorized: false // 关键: 禁用证书验证
        });
        
        const adapter = new NodeToWebStreamAdapter(nodeSocket);
        
        await adapter.opened; // 等待与代理服务器的 TLS 连接建立
        
        // 在已建立的(不安全的)TLS连接上, 发起 HTTP CONNECT 请求
        await 建立HTTP连接(adapter, 账号, 密码, 地址类型, 访问地址, 访问端口);
        
        return adapter; // 返回适配器, 其接口与原生 Socket 兼容
      } catch (error) {
        console.error(`HTTPS 代理连接失败:`, error);
      }
    }
    throw new Error(`所有 HTTPS 代理失效`);
  }

  // ---- 原有逻辑: 处理 direct, http, 和 socks5 ----
  if (代理配置.类型 === 'direct') {
    const hostname = 地址类型 === 3 ? `[${访问地址}]` : 访问地址;
    return (await import('cloudflare:sockets')).connect({ hostname, port: 访问端口 });
  }
  
  for (const 账号字符串 of 代理配置.账号) {
    try {
      const { 账号, 密码, 地址, 端口 } = 解析代理账号(账号字符串);
      // 使用 Cloudflare 原生 Socket API
      const socket = (await import('cloudflare:sockets')).connect({ hostname: 地址, port: 端口 });
      await socket.opened;
      
      if (代理配置.类型 === 'socks5') {
        await 建立SOCKS5连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口);
      } else { // 处理 'http'
        await 建立HTTP连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口);
      }
      
      return socket;
    } catch (error) {
      console.error(`${代理配置.类型}代理连接失败:`, error);
    }
  }
  throw new Error(`所有${代理配置.类型}代理失效`);
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
    
    if (connectResponse[0] !== 0x05 || connectResponse[1] !== 0x00) {
      throw new Error(`连接失败: ${访问地址}:${访问端口}`);
    }
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
  
  const [地址, 端口 = 443] = 地址段.includes('[') ? 
    [地址段.slice(0, 地址段.lastIndexOf(']') + 1), 地址段.split(']:')[1]] :
    地址段.split(':');
    
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
        
        return new Response(null, { 
          status: 101, 
          webSocket: 客户端,
          headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' }
        });
      }
      
      return new Response('Hello World', { 
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }
      });
    } catch (error) {
      return new Response(`Worker Error: ${error.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};
