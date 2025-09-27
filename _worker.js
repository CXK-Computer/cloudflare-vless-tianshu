import { connect as cfConnect } from 'cloudflare:sockets';

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

// --- 核心配置 ---
// UUID, 请在使用时替换为您自己的
let 哎呀呀这是我的VL密钥 = "fb00086e-abb9-4983-976f-d407bbea9a4c"; 

// +++ 新增：性能与流量控制 +++
// 默认开启流量控制，解决高延迟和丢包问题。
// 如果您的网络环境极好，可以尝试关闭以获取更高速度，但稳定性可能下降。
const ENABLE_FLOW_CONTROL = true; 
// 流量控制的分片大小（字节），64或128是比较稳妥的值。
const FLOW_CHUNK_SIZE = 128; 

// --- 预计算 UUID (优化性能) ---
const UUID_BYTES = new Uint8Array(哎呀呀这是我的VL密钥.replace(/-/g, '').match(/.{2}/g).map(byte => parseInt(byte, 16)));

function isValidUUID(view) {
  if (view.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (view[i] !== UUID_BYTES[i]) return false;
  }
  return true;
}

function parseHostPort(hostSeg) {
    const match = hostSeg.match(/^\[(.+)\]:(\d+)$/);
    if (match) {
        return [match[1], parseInt(match[2])];
    }
    const lastColonIndex = hostSeg.lastIndexOf(':');
    // 确保不是IPv6地址的一部分
    if (lastColonIndex !== -1 && !hostSeg.slice(0, lastColonIndex).includes(':')) {
        const portStr = hostSeg.substring(lastColonIndex + 1);
        const port = parseInt(portStr);
        if (!isNaN(port)) {
            return [hostSeg.substring(0, lastColonIndex), port];
        }
    }
    return [hostSeg, 443];
}

function getSocks5Account(spec) {
    const atIndex = spec.lastIndexOf("@");
    const credsPart = atIndex !== -1 ? spec.slice(0, atIndex) : '';
    const hostPart = atIndex !== -1 ? spec.slice(atIndex + 1) : spec;
    
    let username = '', password = '';
    if (credsPart) {
        const colonIndex = credsPart.indexOf(":");
        if (colonIndex !== -1) {
            username = credsPart.slice(0, colonIndex);
            password = credsPart.slice(colonIndex + 1);
        } else {
            username = credsPart;
        }
    }
    
    const [host, port] = parseHostPort(hostPart);
    return { username, password, host, port };
}


export default {
  async fetch(request, env, ctx) {
    try {
      if (request.headers.get('Upgrade') === 'websocket') {
        const url = new URL(request.url);
        const decodedPath = decodeURIComponent(url.pathname + url.search);
        
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.send(new Uint8Array([0, 0]));
        ctx.waitUntil(启动传输管道(server, decodedPath));
        return new Response(null, { status: 101, webSocket: client });
      }

      // HTML 界面保持不变
      const hostname = request.headers.get('host');
      const vlessLink = `vless://${哎呀呀这是我的VL密钥}@${hostname}:443?sni=${hostname}&type=ws&security=tls&path=%2F#Direct`;
      const vlessPyipLink = `vless://${哎呀呀这是我的VL密钥}@${hostname}:443?sni=${hostname}&type=ws&security=tls&path=%2Fpyip%3Dwww.visa.com#PYIP-Mode`;
      
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Worker 配置与日志</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.6;background-color:#f4f4f9;color:#333;margin:0;padding:20px}.container{max-width:800px;margin:20px auto;background:#fff;padding:25px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}h1,h2,h3{color:#2a2a2a;border-bottom:2px solid #eaeaea;padding-bottom:10px}p,li{color:#555}button{background-color:#007bff;color:#fff;border:none;padding:10px 15px;border-radius:5px;cursor:pointer;font-size:16px;transition:background-color .3s}button:hover{background-color:#0056b3}code,pre{font-family:"Courier New",Courier,monospace;background:#e9e9e9;padding:2px 5px;border-radius:4px;word-break:break-all}.link-box{display:flex;align-items:center;justify-content:space-between;background:#f0f0f0;border:1px solid #ddd;border-radius:5px;padding:10px;margin-top:15px}.link-box pre{flex-grow:1;margin:0;padding-right:15px;white-space:pre-wrap}.copy-button{background-color:#28a745;flex-shrink:0}.copy-button:hover{background-color:#218838}#copy-status{color:#28a745;margin-top:10px;font-weight:700;display:none}.alert{padding:15px;margin-bottom:20px;border:1px solid transparent;border-radius:4px}.alert-info{color:#31708f;background-color:#d9edf7;border-color:#bce8f1}.alert-success{color:#3c763d;background-color:#dff0d8;border-color:#d6e9c6}hr{border:none;border-top:1px solid #ccc;margin:40px auto;max-width:800px}#logs{margin-top:20px}.log-entry{background:#f9f9f9;border:1px solid #ddd;border-radius:5px;padding:15px;margin-bottom:15px;word-wrap:break-word}.log-entry p{margin:0 0 10px}.log-entry strong{color:#1a1a1a}.log-entry pre{white-space:pre-wrap;word-break:break-all}.no-logs{color:#888}</style></head><body><div class="container"><h1>VLESS 配置中心</h1><div class="alert alert-info"><p><strong>工作原理：</strong> 本脚本采用“Plan A / Plan B”自动回退机制。</p><ul><li><strong>Plan A：</strong> 优先尝试直接连接目标网站。</li><li><strong>Plan B：</strong> 如果直连失败（例如目标网站受Cloudflare保护），则自动尝试使用您在路径(path)中设置的后备方案。</li></ul></div><h3>配置方案一：PYIP 模式 (推荐)</h3><div class="alert alert-success"><p>此模式是访问受Cloudflare保护网站的<strong>最佳选择</strong>。它通过“借路”一个同样使用Cloudflare的知名网站来建立隧道。</p></div><div class="link-box"><pre id="vless-pyip-link">${vlessPyipLink}</pre><button class="copy-button" onclick="copyToClipboard('vless-pyip-link')">复制 PYIP 模式</button></div><p>您可以将路径中的 <code>www.visa.com</code> 替换为任何其他大型Cloudflare网站，例如 <code>www.microsoft.com</code> 等。</p><h3 style="margin-top:30px;">配置方案二：SOCKS5 代理模式</h3><p>如果您有自己的海外SOCKS5代理服务器，可以使用此方案作为后备。</p><p>请手动修改VLESS配置中的 <code>path</code> 字段，格式如下：</p><pre>/socks5=user:pass@your.proxy.com:1080</pre><p>如果代理不需要认证，可以省略 <code>user:pass@</code> 部分。</p><h3 style="margin-top:30px;">配置方案三：直连模式 (不推荐)</h3><p>此模式无法访问受Cloudflare保护的网站，仅用于连接普通网站。不建议作为主力使用。</p><div class="link-box"><pre id="vless-link">${vlessLink}</pre><button class="copy-button" onclick="copyToClipboard('vless-link')">复制直连模式</button></div><p id="copy-status">已复制到剪贴板！</p></div><hr><div class="container"><h2>Worker 运行日志</h2><p>此页面显示最近在后台发生的连接错误。刷新此页面以查看最新日志。</p><button onclick="location.reload()">刷新日志</button><div id="logs">${errorLogs.length===0?'<p class="no-logs">目前没有错误日志。</p>':errorLogs.map(log=>{const detailsString=JSON.stringify(log.details,(key,value)=>value instanceof Error?{message:value.message,stack:value.stack}:typeof value==='bigint'?value.toString():value,2);return`<div class="log-entry"><p><strong>时间 (UTC):</strong> ${log.timestamp}</p><p><strong>信息:</strong> ${log.message}</p><pre><strong>详情:</strong>\n${detailsString}</pre></div>`}).join('')}</div></div><script>function copyToClipboard(elementId){const linkText=document.getElementById(elementId).innerText;if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(linkText).then(()=>{showCopyStatus()})}else{const tempInput=document.createElement('textarea');tempInput.style.position='absolute';tempInput.style.left='-9999px';document.body.appendChild(tempInput);tempInput.value=linkText;tempInput.select();document.execCommand('copy');document.body.removeChild(tempInput);showCopyStatus()}}
function showCopyStatus(){const status=document.getElementById('copy-status');status.style.display='block';setTimeout(()=>{status.style.display='none'},2000)}</script></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    } catch (error) {
      logError('Fetch Handler 发生致命错误', { error: error });
      return new Response(`Worker 发生严重错误: ${error.message}`, { status: 500 });
    }
  }
};


async function 启动传输管道(ws, decodedPath) {
  let tcpConn, writer, reader;
  let firstPacket = false;
  
  // +++ 引入任务队列，确保数据有序发送 +++
  let sendQueue = Promise.resolve();

  ws.addEventListener('message', async event => {
    if (!firstPacket) {
      firstPacket = true;
      try {
        const firstPacketData = event.data;
        const { destHost, destPort, addrType, initialPayload } = await parseFirstPacket(firstPacketData);

        tcpConn = await createSmartConnection(destHost, destPort, addrType, decodedPath);
        
        await tcpConn.opened;
        writer = tcpConn.writable.getWriter();
        reader = tcpConn.readable.getReader();

        if (initialPayload.length > 0) {
            // 使用任务队列发送首包剩余数据
            sendQueue = sendQueue.then(() => writer.write(initialPayload)).catch(err => logError('写入首包数据失败', {error: err}));
        }

        startBackPipe();

      } catch (e) {
        logError('首包处理或连接建立失败', { error: e.message, stack: e.stack });
        ws.close(1011, `Error processing first packet: ${e.message}`);
        tcpConn?.close();
      }
    } else {
      // 后续数据包同样使用任务队列发送
      if (writer) {
        sendQueue = sendQueue.then(() => writer.write(event.data)).catch(err => {
            logError('写入TCP失败', { error: err.message });
            ws.close();
            tcpConn?.close();
        });
      }
    }
  });

  async function startBackPipe() {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        if (value?.length > 0) {
          // +++ 应用流量控制 +++
          if (ENABLE_FLOW_CONTROL) {
            let offset = 0;
            while (offset < value.length) {
              const chunk = value.slice(offset, offset + FLOW_CHUNK_SIZE);
              sendQueue = sendQueue.then(() => ws.send(chunk)).catch(err => logError('WS分片发送失败', {error: err}));
              offset += FLOW_CHUNK_SIZE;
            }
          } else {
            sendQueue = sendQueue.then(() => ws.send(value)).catch(err => logError('WS发送失败', {error: err}));
          }
        }
      }
    } catch (e) {
      logError('数据回传失败', { error: e.message });
    } finally {
      ws.close();
      tcpConn?.close();
    }
  }
}

async function parseFirstPacket(firstData) {
    const buffer = (firstData instanceof ArrayBuffer) ? firstData : firstData.buffer;
    const view = new Uint8Array(buffer);
    
    if (view.length < 24) { // Basic VLESS header length check
        throw new Error('无效的VLESS请求头');
    }

    if (!isValidUUID(new Uint8Array(buffer, 1, 16))) throw new Error('UUID验证失败');

    const addonLength = view[17];
    const portIndex = 18 + addonLength + 1;
    const destPort = new DataView(buffer, portIndex, 2).getUint16(0);

    const addressIndex = portIndex + 2;
    const addrType = view[addressIndex];
    let addressInfoIndex = addressIndex + 1;
    let destHost, addrLen;
      
    switch (addrType) {
        case 1: addrLen = 4; destHost = new Uint8Array(buffer, addressInfoIndex, 4).join('.'); break;
        case 2: addrLen = view[addressInfoIndex++]; destHost = new TextDecoder().decode(new Uint8Array(buffer, addressInfoIndex, addrLen)); break;
        case 3: addrLen = 16; const ipv6 = []; const ipv6View = new DataView(buffer, addressInfoIndex, 16); for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16)); destHost = `[${ipv6.join(':')}]`; break;
        default: throw new Error('无效的目标地址类型');
    }
    
    const initialPayload = new Uint8Array(buffer, addressInfoIndex + addrLen);

    return { destHost, destPort, addrType, initialPayload };
}

async function createSmartConnection(destHost, destPort, addrType, decodedPath) {
    let tcpConn;
    try {
        tcpConn = cfConnect({ hostname: destHost.replace(/\[|\]/g, ''), port: destPort });
        return tcpConn;
    } catch (err) {
        logError('直连失败 (Plan A failed), 尝试后备方案 (Plan B)', { destination: `${destHost}:${destPort}`, error: err.message });
        
        const pyipMatch = decodedPath.match(/\/pyip=([^&]+)/);
        if (pyipMatch && pyipMatch[1]) {
            const [proxyHost, proxyPort] = parseHostPort(pyipMatch[1]);
            logError('使用 PYIP 模式连接', { proxy: `${proxyHost}:${proxyPort}` });
            return cfConnect({ hostname: proxyHost, port: proxyPort });
        }

        const socksMatch = decodedPath.match(/\/socks5=([^&]+)/);
        if (socksMatch && socksMatch[1]) {
            logError('使用 SOCKS5 模式连接', { proxy: socksMatch[1] });
            return createSocks5Connection(destHost, destPort, addrType, socksMatch[1]);
        }
        
        throw new Error('直连失败且未提供有效的后备方案 (pyip 或 socks5)');
    }
}

async function createSocks5Connection(destHost, destPort, addrType, socks5Spec) {
    const { username, password, host, port } = getSocks5Account(socks5Spec);
    const socks5Conn = cfConnect({ hostname: host, port: port });
    
    await socks5Conn.opened;
    const writer = socks5Conn.writable.getWriter();
    const reader = socks5Conn.readable.getReader();

    try {
        await writer.write(new Uint8Array([5, 1, 2])); 
        const authResp = (await reader.read()).value;
        if (!authResp || authResp[0] !== 5 || authResp[1] !== 2) {
            if (authResp[1] === 0) { // No auth needed
                 // continue
            } else {
                throw new Error('SOCKS5 认证方法协商失败');
            }
        }
        if (authResp[1] === 2) {
            const userPassPacket = new Uint8Array([1, username.length, ...new TextEncoder().encode(username), password.length, ...new TextEncoder().encode(password)]);
            await writer.write(userPassPacket);
            const userPassResp = (await reader.read()).value;
            if (!userPassResp || userPassResp[0] !== 1 || userPassResp[1] !== 0) {
                throw new Error('SOCKS5 账号密码错误');
            }
        }
        
        let addressBytes;
        const encoder = new TextEncoder();
        const cleanDestHost = destHost.replace(/\[|\]/g, '');

        if (addrType === 1) { 
            addressBytes = [1, ...cleanDestHost.split('.').map(Number)];
        } else if (addrType === 2) {
            const domainBytes = encoder.encode(cleanDestHost);
            addressBytes = [3, domainBytes.length, ...domainBytes];
        } else {
             const ipv6Bytes = [];
             const hextets = cleanDestHost.split(':');
             for (const hextet of hextets) {
                const val = parseInt(hextet, 16);
                ipv6Bytes.push(val >> 8, val & 0xff);
             }
             addressBytes = [4, ...ipv6Bytes];
        }

        const portBytes = [destPort >> 8, destPort & 0xff];
        const connectReq = new Uint8Array([5, 1, 0, ...addressBytes, ...portBytes]);
        
        await writer.write(connectReq);
        const connectResp = (await reader.read()).value;
        if (!connectResp || connectResp[0] !== 5 || connectResp[1] !== 0) {
            throw new Error(`SOCKS5 连接目标失败: ${connectResp[1]}`);
        }
        
        writer.releaseLock();
        reader.releaseLock();
        return socks5Conn;

    } catch(e) {
        writer.releaseLock();
        reader.releaseLock();
        await socks5Conn.close();
        throw e;
    }
}
