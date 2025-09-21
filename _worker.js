import { connect as cfConnect } from 'cloudflare:sockets';
//移除了: import { connect as tlsConnect } from 'node:tls';

// ================== 日志系统 ==================
let errorLogs = [];
const MAX_LOGS = 25;
function logError(message, details = {}) {
  const timestamp = new Date().toISOString();
  console.error(message, details);
  errorLogs.unshift({ timestamp, message, details });
  if (errorLogs.length > MAX_LOGS) errorLogs.length = MAX_LOGS;
}
// ============================================

const PROXY_REGEX = /\/(socks5|http):\/\/([^\/\?&]+)/; // 正则表达式中移除了 https
let 哎呀呀这是我的VL密钥 = "fb00086e-abb9-4983-976f-d407bbea9a4c";

// --- CPU 优化: 预计算 UUID 字节数组，实现最快验证 ---
const UUID_BYTES = new Uint8Array(哎呀呀这是我的VL密钥.replace(/-/g, '').match(/.{2}/g).map(byte => parseInt(byte, 16)));

function isValidUUID(view) {
  if (view.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (view[i] !== UUID_BYTES[i]) return false;
  }
  return true;
}

function 解析代理路径(路径) {
  const proxyMatch = 路径.match(PROXY_REGEX);
  return proxyMatch ? { 类型: proxyMatch[1], 账号: [decodeURIComponent(proxyMatch[2])] } : { 类型: 'direct' };
}

// ... base64Decode 和其他辅助函数保持不变 ...
function base64Decode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return atob(padded);
}

async function 启动传输管道(WS接口, 代理配置) {
  let TCP接口, 首包数据 = false, 首包处理完成, 传输数据, 读取数据;
  try {
    WS接口.addEventListener('message', async event => {
      if (!首包数据) {
        首包数据 = true;
        首包处理完成 = 解析首包数据(event.data);
      } else {
        try {
          await 首包处理完成;
          if (传输数据) await 传输数据.write(event.data);
        } catch (e) {
          logError('写入 TCP 失败', { error: e });
          WS接口.close();
          TCP接口?.close();
        }
      }
    });

    async function 解析首包数据(首包) {
      const buffer = (首包 instanceof ArrayBuffer) ? 首包 : 首包.buffer;
      const view = new Uint8Array(buffer);
      
      if (view.length < 38) {
          throw new Error('无效的 VLESS 请求头');
      }

      const uuidView = new Uint8Array(buffer, 1, 16);
      if (!isValidUUID(uuidView)) throw new Error('UUID验证失败');

      const addonLength = view[17];
      const portIndex = 18 + addonLength + 1;
      const portView = new DataView(buffer, portIndex, 2);
      const 访问端口 = portView.getUint16(0);

      if (访问端口 === 53) {
        const dnsQueryView = new Uint8Array(buffer, portIndex + 9);
        const DOH结果 = await (await fetch('https://dns.google/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: dnsQueryView })).arrayBuffer();
        WS接口.send(await new Blob([new Uint8Array([(DOH结果.byteLength >> 8) & 0xff, DOH结果.byteLength & 0xff]), DOH结果]));
        return;
      }

      const addressIndex = portIndex + 2;
      const addressType = view[addressIndex];
      let addressInfoIndex = addressIndex + 1;
      let 访问地址, addressLength;
      
      switch (addressType) {
        case 1: addressLength = 4; 访问地址 = new Uint8Array(buffer, addressInfoIndex, 4).join('.'); break;
        case 2: addressLength = view[addressInfoIndex++]; 访问地址 = new TextDecoder().decode(new Uint8Array(buffer, addressInfoIndex, addressLength)); break;
        case 3: addressLength = 16; const ipv6 = []; const ipv6View = new DataView(buffer, addressInfoIndex, 16); for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16)); 访问地址 = ipv6.join(':'); break;
        default: throw new Error('无效的访问地址');
      }

      TCP接口 = await 创建代理连接(代理配置, addressType, 访问地址, 访问端口);
      await TCP接口.opened;
      传输数据 = TCP接口.writable.getWriter();
      读取数据 = TCP接口.readable.getReader();

      const initialDataIndex = addressInfoIndex + addressLength;
      if (initialDataIndex < buffer.byteLength) {
        const initialDataView = new Uint8Array(buffer, initialDataIndex);
        await 传输数据.write(initialDataView);
      }
      
      启动回传管道();
    }
    
    async function 启动回传管道() {
      try {
        while (true) {
          const { done, value } = await 读取数据.read();
          if (done) break;
          if (value?.length > 0) WS接口.send(value);
        }
      } catch (e) {
        logError('数据回传失败', { error: e });
      } finally {
        WS接口.close();
        TCP接口?.close();
      }
    }
  } catch (e) {
    logError('传输管道发生致命错误', { error: e });
    WS接口.close();
  }
}

async function 创建代理连接(代理配置, 地址类型, 访问地址, 访问端口) {
  if (代理配置.类型 === 'direct') {
    const hostname = 地址类型 === 3 ? `[${访问地址}]` : 访问地址;
    return cfConnect({ hostname, port: 访问端口 });
  }

  const connectionPromises = 代理配置.账号.map(账号字符串 => 
    connectToProxy(账号字符串, 代理配置.类型, 地址类型, 访问地址, 访问端口)
  );

  try {
    return await Promise.any(connectionPromises);
  } catch (e) {
    const errorMessages = e.errors ? e.errors.map(err => err.message) : [e.message];
    logError(`所有 ${代理配置.类型} 代理均连接失败`, { errors: errorMessages });
    throw new Error(`所有 ${代理配置.类型} 代理均连接失败`);
  }
}

async function connectToProxy(账号字符串, 类型, 地址类型, 访问地址, 访问端口) {
  try {
    // SOCKS5 or HTTP
    const { 账号, 密码, 地址, 端口 } = 解析代理账号(账号字符串);
    const socket = cfConnect({ hostname: 地址, port: 端口 });
    await socket.opened;
    if (类型 === 'socks5') {
      await 建立SOCKS5连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口);
    } else {
      await 建立HTTP连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口);
    }
    return socket;
  } catch (error) {
    throw new Error(`代理 ${账号字符串} 连接失败: ${error.message}`);
  }
}

// ... SOCKS5, HTTP, IPv6 等辅助函数保持不变 ...
async function 建立SOCKS5连接(socket, 账号, 密码, 地址类型, 访问地址, 访问端口) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  try {
    await writer.write(new Uint8Array([5, 2, 0, 2]));
    const authResponse = (await reader.read()).value;
    if (!authResponse || authResponse.length < 2) throw new Error("SOCKS5 认证响应无效");
    if (authResponse[1] === 0x02) {
      if (!账号 && !密码) throw new Error('SOCKS5 代理需要凭证，但未提供');
      await writer.write(new Uint8Array([1, 账号.length, ...encoder.encode(账号), 密码.length, ...encoder.encode(密码)]));
      const authResult = (await reader.read()).value;
      if (!authResult || authResult.length < 2 || authResult[0] !== 0x01 || authResult[1] !== 0x00) throw new Error('SOCKS5 账号密码错误');
    } else if (authResponse[1] !== 0x00) {
      throw new Error(`SOCKS5 不支持的认证方法: ${authResponse[1]}`);
    }
    let 地址数据;
    switch (地址类型) {
      case 1: 地址数据 = new Uint8Array([1, ...访问地址.split('.').map(Number)]); break;
      case 2: 地址数据 = new Uint8Array([3, 访问地址.length, ...encoder.encode(访问地址)]); break;
      case 3: 地址数据 = 构建IPv6地址(访问地址); break;
    }
    await writer.write(new Uint8Array([5, 1, 0, ...地址数据, 访问端口 >> 8, 访问端口 & 0xff]));
    const connectResponse = (await reader.read()).value;
    if (!connectResponse || connectResponse.length < 2 || connectResponse[0] !== 0x05 || connectResponse[1] !== 0x00) throw new Error(`SOCKS5 连接目标失败: ${访问地址}:${访问端口}`);
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
      if (done) throw new Error('HTTP 代理连接中断');
      响应 += decoder.decode(value, { stream: true });
      if (响应.includes('\r\n\r\n')) break;
    }
    const 状态码 = 响应.match(/HTTP\/1\.[01]\s+(\d+)/)?.[1];
    if (状态码 !== '200') throw new Error(`HTTP 代理连接失败: ${响应.split('\r\n')[0]}`);
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
    // ... HTML 页面和 fetch 主逻辑 ...
    try {
      if (访问请求.headers.get('Upgrade') === 'websocket') {
        let 路径 = 访问请求.url.replace(/^https?:\/\/[^/]+/, '');
        try {
          路径 = decodeURIComponent(路径);
        } catch (e) {}
        
        const 代理配置 = 解析代理路径(路径);
        const [客户端, WS接口] = Object.values(new WebSocketPair());
        WS接口.accept();
        WS接口.send(new Uint8Array([0, 0]));
        ctx.waitUntil(启动传输管道(WS接口, 代理配置));
        return new Response(null, { status: 101, webSocket: 客户端 });
      }

      const url = new URL(访问请求.url);
      const hostname = url.hostname;
      const vlessLink = `vless://${哎呀呀这是我的VL密钥}@${hostname}:443?sni=${hostname}&host=${hostname}&type=ws&security=tls&path=%2F&encryption=none`;
      
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Worker 配置与日志</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.6;background-color:#f4f4f9;color:#333;margin:0;padding:20px}.container{max-width:800px;margin:20px auto;background:#fff;padding:25px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}h1,h2{color:#2a2a2a;border-bottom:2px solid #eaeaea;padding-bottom:10px}p{color:#555}button{background-color:#007bff;color:#fff;border:none;padding:10px 15px;border-radius:5px;cursor:pointer;font-size:16px;transition:background-color .3s}button:hover{background-color:#0056b3}.link-box{display:flex;align-items:center;justify-content:space-between;background:#f0f0f0;border:1px solid #ddd;border-radius:5px;padding:10px;margin-top:15px}.link-box pre{flex-grow:1;margin:0;padding-right:15px;white-space:pre-wrap;word-break:break-all;font-family:"Courier New",Courier,monospace;font-size:14px}.copy-button{background-color:#28a745}.copy-button:hover{background-color:#218838}#copy-status{color:#28a745;margin-top:10px;font-weight:700;display:none}hr.separator{border:none;border-top:1px solid #ccc;margin:40px auto;max-width:800px}#logs{margin-top:20px}.log-entry{background:#f9f9f9;border:1px solid #ddd;border-radius:5px;padding:15px;margin-bottom:15px;word-wrap:break-word}.log-entry p{margin:0 0 10px}.log-entry strong{color:#1a1a1a}.log-entry pre{background:#e9e9e9;padding:10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;font-family:"Courier New",Courier,monospace}.no-logs{color:#888}</style></head><body><div class="container"><h1>VLESS 配置链接</h1><p>点击下方按钮复制基础直连模式的 VLESS 配置链接 (Path: /)。要使用代理，请手动修改 path 部分。</p><div class="link-box"><pre id="vless-link">${vlessLink}</pre><button class="copy-button" onclick="copyToClipboard()">复制</button></div><p id="copy-status">已复制到剪贴板！</p></div><hr class="separator"><div class="container"><h2>Worker 运行日志</h2><p>此页面显示最近在后台发生的连接错误。刷新此页面以查看最新日志。</p><button onclick="location.reload()">刷新日志</button><div id="logs">${errorLogs.length===0?'<p class="no-logs">目前没有错误日志。</p>':errorLogs.map(log=>{const detailsString=JSON.stringify(log.details,(key,value)=>value instanceof Error?{message:value.message,stack:value.stack}:typeof value==='bigint'?value.toString():value,2);return`
                          <div class="log-entry"><p><strong>时间 (UTC):</strong> ${log.timestamp}</p><p><strong>信息:</strong> ${log.message}</p><pre><strong>详情:</strong>\n${detailsString}</pre></div>`}).join('')}</div></div><script>function copyToClipboard(){const linkText=document.getElementById('vless-link').innerText;if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(linkText).then(()=>{showCopyStatus()})}else{const tempInput=document.createElement('textarea');tempInput.style.position='absolute';tempInput.style.left='-9999px';document.body.appendChild(tempInput);tempInput.value=linkText;tempInput.select();document.execCommand('copy');document.body.removeChild(tempInput);showCopyStatus()}}
function showCopyStatus(){const status=document.getElementById('copy-status');status.style.display='block';setTimeout(()=>{status.style.display='none'},2000)}</script></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    } catch (error) {
      logError('Fetch Handler 发生致命错误', { error: error });
      return new Response(`Worker 发生严重错误: ${error.message}`, { status: 500 });
    }
  }
};
