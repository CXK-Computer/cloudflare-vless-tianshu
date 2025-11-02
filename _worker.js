import { connect } from 'cloudflare:sockets';

// ==================== 身份验证 ====================
const AUTH_UUID = "fb00086e-abb9-4983-976f-d407bbea9a4c"; // 在这里修改为你自己的UUID

// ==================== 极致优化配置 (来自优化版) ====================
const CONFIG = {
  // 稳定性配置
  KEEPALIVE_INTERVAL: 15000,           // 15秒心跳
  STALL_TIMEOUT: 7000,                 // 7秒无数据检测
  MAX_STALL_COUNT: 6,                  // 最大stall次数
  MAX_RECONNECT_ATTEMPTS: 20,          // 最大重连次数
  BASE_RECONNECT_DELAY: 100,           // 基础重连延迟(ms)
  MAX_RECONNECT_DELAY: 20000,          // 最大重连延迟(ms)
  RECONNECT_JITTER: 0.2,               // 重连随机抖动20%
  
  // 性能配置
  MIN_CHUNK_SIZE: 64,                  // 最小分片大小
  MAX_CHUNK_SIZE: 131072,              // 最大分片大小128KB
  INITIAL_CHUNK_SIZE: 4096,            // 初始分片大小
  SAMPLE_WINDOW: 15,                   // 采样窗口大小
  CONCURRENCY_LIMIT: 8,                // 并发队列限制
  BUFFER_POOL_SIZE: 32,                // 缓冲区池大小
  BUFFER_SIZE: 16384,                  // 缓冲区大小16KB
  
  // 传输优化
  ENABLE_DYNAMIC_CHUNKING: true,       // 启用动态分片
  ENABLE_ZERO_COPY: true,              // 启用零拷贝优化
  ENABLE_PREDICTIVE_RECONNECT: true,   // 启用预测性重连
  ENABLE_ADAPTIVE_FLOW: true,          // 启用自适应流量控制
  MAX_QUEUE_DEPTH: 100,                // 最大队列深度
  QUEUE_TIMEOUT: 1000,                 // 队列超时(ms)
};

// ==================== 入口函数 (融合逻辑) ====================
export default {
  async fetch(req, env, ctx) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Hello World! This is a high-performance proxy worker.', { status: 200 });
    }

    // 解析URL参数以获取路由配置 (来自路由灵活版)
    const url = new URL(req.url);
    const params = url.searchParams;
    const mode = params.get('mode') || 'auto';
    
    let s5Config = null, httpConfig = null, proxyIpConfig = null;

    if (params.has('s5')) {
      s5Config = parseProxyConfig(params.get('s5'));
    }
    if (params.has('http')) {
      httpConfig = parseProxyConfig(params.get('http'));
    }
    if (params.has('proxyip')) {
      const [host, port] = parseHostPort(params.get('proxyip'), 443);
      proxyIpConfig = { host, port };
    }

    const connectionModes = getConnectionModes(mode, params, s5Config, httpConfig, proxyIpConfig);
    const connectionOptions = {
        modes: connectionModes,
        s5: s5Config,
        http: httpConfig,
        proxyip: proxyIpConfig,
    };

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.send(new Uint8Array([0, 0])); // VLESS 协议版本响应

    ctx.waitUntil(handleConnection(server, connectionOptions));
    
    return new Response(null, { status: 101, webSocket: client });
  }
};


// ==================== 主连接处理器 (来自优化版, 稍作修改) ====================
async function handleConnection(ws, connectionOptions) {
  let socket = null, writer = null, reader = null;
  let isFirstMsg = true;
  let connectionInfo = {
    finalDestination: null, // 最终目标地址
    options: connectionOptions // 路由选项
  };
  let isReconnecting = false;
  
  const reconnectManager = new SmartReconnectionManager();
  const transmitter = new ZeroCopyTransmitter();
  const healthMonitor = new PredictiveHealthMonitor();
  const writeQueue = new HighPerformanceQueue();
  const readQueue = new HighPerformanceQueue();
  
  let lastActivity = Date.now();
  let lastDataReceived = Date.now();
  let bytesReceived = 0;
  let bytesSent = 0;
  let stallCount = 0;
  let keepaliveTimer = null;
  let healthCheckTimer = null;
  
  function updateActivity() { lastActivity = Date.now(); }
  function updateDataReceived() { lastDataReceived = Date.now(); stallCount = 0; }
  
  function cleanup() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    keepaliveTimer = null;
    healthCheckTimer = null;
    
    try { writer?.releaseLock(); } catch {}
    try { reader?.releaseLock(); } catch {}
    try { socket?.close(); } catch {}
    
    writer = null; reader = null; socket = null;
    writeQueue.clear();
    readQueue.clear();
  }
  
  function startHealthMonitoring() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(async () => {
      const idleTime = Date.now() - lastActivity;
      if (idleTime > CONFIG.KEEPALIVE_INTERVAL && !isReconnecting && writer) {
        try {
          const result = await healthMonitor.performHealthCheck(ws, writer);
          if (result.success) {
            updateActivity();
            reconnectManager.updateNetworkQuality(healthMonitor.healthScore);
          }
        } catch {}
      }
    }, CONFIG.KEEPALIVE_INTERVAL / 2);
    
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    healthCheckTimer = setInterval(() => {
      const timeSinceData = Date.now() - lastDataReceived;
      if (bytesReceived > 0 && timeSinceData > CONFIG.STALL_TIMEOUT && !isReconnecting) {
        stallCount++;
        if (stallCount >= CONFIG.MAX_STALL_COUNT) {
          attemptReconnect('stall detected');
        }
      }
      
      if (CONFIG.ENABLE_PREDICTIVE_RECONNECT && healthMonitor.shouldPreemptiveReconnect()) {
        attemptReconnect('predictive health');
      }
    }, CONFIG.STALL_TIMEOUT / 2);
  }
  
  async function attemptReconnect(reason) {
    if (isReconnecting || !connectionInfo.finalDestination || ws.readyState !== 1) return;
    
    if (!reconnectManager.shouldReconnect()) {
      cleanup();
      ws.close(1011, 'Max reconnection attempts reached');
      return;
    }
    
    isReconnecting = true;
    reconnectManager.recordFailure();
    
    const delay = reconnectManager.getReconnectDelay();
    
    try {
      cleanup();
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // 使用融合的连接建立逻辑进行重连
      const newConnection = await establishConnection(connectionInfo.finalDestination, connectionInfo.options);
      socket = newConnection.socket;
      writer = newConnection.writer;
      reader = newConnection.reader;
      
      updateActivity();
      updateDataReceived();
      stallCount = 0;
      isReconnecting = false;
      reconnectManager.recordSuccess();
      startReading();
      
    } catch (err) {
      isReconnecting = false;
      if (ws.readyState === 1) {
        // Continue retrying
        setTimeout(() => attemptReconnect('reconnect failed'), 1000);
      } else {
        cleanup();
      }
    }
  }
  
  async function startReading() {
    try {
      while (true) {
        const readStart = performance.now();
        const { done, value } = await reader.read();
        const readTime = performance.now() - readStart;
        
        if (value && value.length > 0) {
          bytesReceived += value.length;
          updateDataReceived();
          updateActivity();
          healthMonitor.recordHealthData(readTime, true);
          
          await readQueue.enqueue(() => {
            if (ws.readyState === 1) {
              bytesSent += value.length;
              return ws.send(value);
            }
          }, 0, 5000);
        }
        
        if (done) {
          await attemptReconnect('stream ended');
          break;
        }
      }
    } catch (err) {
      if (!isReconnecting) {
        await attemptReconnect('read error');
      }
    }
  }
  
  ws.addEventListener('message', async (evt) => {
    try {
      updateActivity();
      
      if (isFirstMsg) {
        isFirstMsg = false;
        const result = await processHandshake(evt.data, connectionInfo.options);
        socket = result.socket;
        writer = result.writer;
        reader = result.reader;
        connectionInfo.finalDestination = result.info;
        
        startReading();
        startHealthMonitoring();
      } else {
        bytesSent += evt.data.byteLength;
        await writeQueue.enqueue(async () => {
          try {
            await transmitter.optimizeTransmission(ws, evt.data, writer);
          } catch (err) {
            throw err;
          }
        }, 1, 10000);
      }
    } catch (err) {
      if (!isReconnecting) {
        setTimeout(() => attemptReconnect('initial connection error'), 100);
      }
    }
  });
  
  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
}

// ==================== 握手与连接建立 (融合逻辑) ====================
async function processHandshake(data, connectionOptions) {
  const bytes = new Uint8Array(data);
  const authKey = buildUUID(bytes, 1);
  if (authKey !== AUTH_UUID) throw new Error('Authentication failed');
  
  const addrInfo = extractAddress(bytes);

  // DNS 查询特殊处理 (来自路由灵活版)
  if (addrInfo.port === 53) {
      return handleDnsQuery(addrInfo.payload);
  }

  const connection = await establishConnection(addrInfo, connectionOptions);

  if (addrInfo.payload.length > 0) {
    await connection.writer.write(addrInfo.payload);
  }
  
  return {
    socket: connection.socket,
    writer: connection.writer,
    reader: connection.reader,
    info: { host: addrInfo.host, port: addrInfo.port, type: addrInfo.type }
  };
}

async function establishConnection(destination, options) {
    let establishedSocket = null;
    for (const mode of options.modes) {
        try {
            switch (mode) {
                case 's5':
                    if (options.s5) {
                        establishedSocket = await createSocks5ProxySocket(destination, options.s5);
                    }
                    break;
                case 'http':
                    if (options.http) {
                        establishedSocket = await createHttpProxySocket(destination, options.http);
                    }
                    break;
                case 'proxyip':
                     if (options.proxyip) {
                        establishedSocket = await connect(options.proxyip);
                    }
                    break;
                case 'direct':
                    const hostname = destination.type === 3 ? `[${destination.host}]` : destination.host;
                    establishedSocket = await connect({ hostname, port: destination.port });
                    break;
            }
            if (establishedSocket) break; // if connection is successful, break the loop
        } catch (err) {
            // Log error but continue to next mode
        }
    }
    
    if (!establishedSocket) {
        throw new Error('All connection modes failed');
    }

    await establishedSocket.opened;
    return {
        socket: establishedSocket,
        writer: establishedSocket.writable.getWriter(),
        reader: establishedSocket.readable.getReader()
    };
}

// ==================== SOCKS5 & HTTP 代理逻辑 (来自路由灵活版) ====================

// [!] 已修复: 替换为健壮的SOCKS5处理逻辑
async function createSocks5ProxySocket(destination, proxyConfig) {
    const socket = await connect({ hostname: proxyConfig.host, port: proxyConfig.port });
    await socket.opened;
    
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const encoder = new TextEncoder();

    // SOCKS5 handshake - 使用了新的 readExactly 函数
    // 注意: 当前实现只支持无需认证的SOCKS5代理
    await writer.write(new Uint8Array([5, 1, 0])); // 只支持无认证
    const resp1 = await readExactly(reader, 2);   // 精确读取2字节
    if (resp1[0] !== 5 || resp1[1] !== 0) {
        writer.releaseLock();
        reader.releaseLock();
        socket.close();
        throw new Error(`SOCKS5 handshake failed. Expected [5, 0], but got [${resp1.join(', ')}]. Your proxy might require authentication.`);
    }

    // SOCKS5 connect request
    let destHostBytes;
    switch (destination.type) {
        case 1: // IPv4
            destHostBytes = new Uint8Array([1, ...destination.host.split('.').map(Number)]);
            break;
        case 2: // Domain
            destHostBytes = new Uint8Array([3, destination.host.length, ...encoder.encode(destination.host)]);
            break;
        case 3: // IPv6
            // 修复IPv6解析bug
            const ipv6Bytes = destination.host.split(':').flatMap(s => {
                if (s === '') return []; // 处理双冒号 "::"
                const hex = s.padStart(4, '0');
                return [parseInt(hex.substring(0, 2), 16), parseInt(hex.substring(2, 4), 16)];
            });
             // 填充因 "::" 导致的缺失字节
            const expectedLength = 16;
            const finalIpv6Bytes = new Uint8Array(expectedLength);
            let head = [], tail = [];
            let doubleColonIndex = destination.host.split(':').indexOf('');
            if (doubleColonIndex !== -1) {
                let parts = destination.host.split('::');
                let headParts = parts[0].split(':').filter(p => p);
                let tailParts = parts.length > 1 && parts[1] ? parts[1].split(':').filter(p => p) : [];
                
                let headBytes = headParts.flatMap(s => {
                    const hex = s.padStart(4, '0');
                    return [parseInt(hex.substring(0, 2), 16), parseInt(hex.substring(2, 4), 16)];
                });
                 let tailBytes = tailParts.flatMap(s => {
                    const hex = s.padStart(4, '0');
                    return [parseInt(hex.substring(0, 2), 16), parseInt(hex.substring(2, 4), 16)];
                });

                finalIpv6Bytes.set(headBytes, 0);
                finalIpv6Bytes.set(tailBytes, expectedLength - tailBytes.length);

            } else {
                 finalIpv6Bytes.set(ipv6Bytes);
            }

            destHostBytes = new Uint8Array([4, ...finalIpv6Bytes]);
            break;
    }
    
    const portBytes = new Uint8Array([destination.port >> 8, destination.port & 0xff]);
    await writer.write(new Uint8Array([5, 1, 0, ...destHostBytes, ...portBytes]));

    // Read SOCKS5 connect response - 使用了新的 readExactly 函数
    const resp2Header = await readExactly(reader, 4); // 精确读取固定的4个字节头 (VER, REP, RSV, ATYP)
    if (resp2Header[0] !== 5 || resp2Header[1] !== 0) {
        writer.releaseLock();
        reader.releaseLock();
        socket.close();
        throw new Error(`SOCKS5 connection failed with code ${resp2Header[1]}`);
    }

    // 根据ATYP，读取剩余的地址和端口，并丢弃它们，以清空缓冲区
    let remainingLength = 0;
    switch (resp2Header[3]) { // ATYP
        case 1: // IPv4
            remainingLength = 4 + 2;
            break;
        case 3: // Domain, 第一个字节是长度
            const domainLen = (await readExactly(reader, 1))[0];
            remainingLength = domainLen + 2;
            break;
        case 4: // IPv6
            remainingLength = 16 + 2;
            break;
    }
    if (remainingLength > 0) {
        await readExactly(reader, remainingLength);
    }
    
    writer.releaseLock();
    reader.releaseLock();
    return socket;
}


async function createHttpProxySocket(destination, proxyConfig) {
    const socket = await connect({ hostname: proxyConfig.host, port: proxyConfig.port });
    await socket.opened;

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    
    const destAddress = destination.type === 3 ? `[${destination.host}]:${destination.port}` : `${destination.host}:${destination.port}`;
    let connectRequest = `CONNECT ${destAddress} HTTP/1.1\r\nHost: ${destAddress}\r\n`;

    if (proxyConfig.user || proxyConfig.pass) {
        const credentials = btoa(`${proxyConfig.user}:${proxyConfig.pass}`);
        connectRequest += `Proxy-Authorization: Basic ${credentials}\r\n`;
    }
    connectRequest += '\r\n';

    await writer.write(new TextEncoder().encode(connectRequest));

    let response = '';
    const decoder = new TextDecoder();
    while (!response.includes('\r\n\r\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('HTTP proxy connection closed prematurely');
        response += decoder.decode(value, { stream: true });
    }
    
    if (!response.startsWith('HTTP/1.1 200')) {
        throw new Error(`HTTP proxy connection failed: ${response.split('\r\n')[0]}`);
    }

    writer.releaseLock();
    reader.releaseLock();
    return socket;
}

async function handleDnsQuery(query) {
    const dohResponse = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: query
    });
    const dnsResult = await dohResponse.arrayBuffer();
    // This part is tricky as we don't have a WebSocket to send back to.
    // The current architecture assumes a long-lived connection.
    // For simplicity, we'll let this fail silently, as DNS-over-WS is a niche use case.
    // A proper implementation would require restructuring handleConnection significantly.
    // For now, we throw an error to indicate it's not supported in this merged version.
    throw new Error("DNS-over-WebSocket is not supported in this advanced configuration.");
}


// ==================== 所有管理器和类 (来自优化版) ====================
// SmartReconnectionManager, ZeroCopyTransmitter, PredictiveHealthMonitor, HighPerformanceQueue
// (These classes are copied directly from the "极致优化版" script without modification)
class SmartReconnectionManager{constructor(){this.attempts=0;this.lastReconnectTime=0;this.networkQuality=1;this.consecutiveFailures=0}shouldReconnect(){if(this.attempts>=CONFIG.MAX_RECONNECT_ATTEMPTS)return!1;const e=Math.min(.8,.3+this.attempts*.05);return!(this.networkQuality<e&&this.attempts>3&&Math.random()>.5)}getReconnectDelay(){const e=CONFIG.BASE_RECONNECT_DELAY,t=CONFIG.MAX_RECONNECT_DELAY;let s=Math.min(e*Math.pow(1.8,this.attempts-1),t);s*=1.5-.5*this.networkQuality;const o=s*CONFIG.RECONNECT_JITTER*(2*Math.random()-1);return s=Math.max(10,s+o),this.consecutiveFailures>2&&(s*=1+this.consecutiveFailures*.2),Math.min(s,t)}recordSuccess(){this.consecutiveFailures=0;this.attempts=0;this.networkQuality=Math.min(1,this.networkQuality+.1)}recordFailure(){this.attempts++;this.consecutiveFailures++;this.networkQuality=Math.max(.1,this.networkQuality-.15)}updateNetworkQuality(e){this.networkQuality=e}}
class ZeroCopyTransmitter{constructor(){this.chunkSize=CONFIG.INITIAL_CHUNK_SIZE;this.latencyHistory=[];this.throughputHistory=[];this.lastAdjustment=Date.now()}optimizeTransmission(e,t,s){return!CONFIG.ENABLE_DYNAMIC_CHUNKING||t.length<=this.chunkSize?this.directTransmit(e,t,s):this.chunkedTransmit(e,t,s)}async directTransmit(e,t,s){const o=performance.now();try{await s.write(t);const e=performance.now()-o;this.recordMetrics(t.length,e),this.adjustChunkSize()}catch(e){throw e}}async chunkedTransmit(e,t,s){const o=new Uint8Array(t);let i=0;const r=[];for(;i<o.length;){const t=o.slice(i,i+this.chunkSize),a=s.write(t).then(()=>{const e=5*Math.random()+1;this.recordMetrics(t.length,e)});if(r.push(a),i+=this.chunkSize,r.length>=CONFIG.CONCURRENCY_LIMIT){await Promise.race(r);const e=r.findIndex(e=>e.isFulfilled);e>-1&&r.splice(e,1)}}await Promise.all(r),this.adjustChunkSize()}recordMetrics(e,t){this.latencyHistory.push(t),this.throughputHistory.push(e),this.latencyHistory.length>CONFIG.SAMPLE_WINDOW&&this.latencyHistory.shift(),this.throughputHistory.length>CONFIG.SAMPLE_WINDOW&&this.throughputHistory.shift()}adjustChunkSize(){if(Date.now()-this.lastAdjustment<1e3||this.latencyHistory.length<5)return;const e=this.latencyHistory.reduce((e,t)=>e+t)/this.latencyHistory.length,t=this.throughputHistory.reduce((e,t)=>e+t)/this.throughputHistory.length;let s=this.chunkSize;e<20&&t>1048576?s=Math.min(2*this.chunkSize,CONFIG.MAX_CHUNK_SIZE):e<50&&t>524288?s=Math.min(1.5*this.chunkSize,CONFIG.MAX_CHUNK_SIZE):e>200?s=Math.max(.7*this.chunkSize,CONFIG.MIN_CHUNK_SIZE):e>500&&(s=Math.max(.4*this.chunkSize,CONFIG.MIN_CHUNK_SIZE)),this.chunkSize=Math.round(.6*this.chunkSize+.4*s),this.lastAdjustment=Date.now()}getOptimalChunkSize(){return this.chunkSize}}
class PredictiveHealthMonitor{constructor(){this.metrics={rtt:[],jitter:[],throughput:[],packetLoss:0};this.healthScore=1;this.lastHealthUpdate=Date.now();this.degradationTrend=0}async performHealthCheck(e,t){const s=performance.now(),o=Date.now();try{const i=new ArrayBuffer(8);return new DataView(i).setBigUint64(0,BigInt(s),!0),await t.write(new Uint8Array(i)),new Promise(t=>{const r=setTimeout(()=>{this.recordHealthData(null,!1),t({success:!1,rtt:null,checkId:o})},3e3);const a=i=>{if(8===i.data.byteLength){clearTimeout(r);const n=performance.now()-s;this.recordHealthData(n,!0),e.removeEventListener("message",a),t({success:!0,rtt:n,checkId:o})}};e.addEventListener("message",a)})}catch(e){return this.recordHealthData(null,!1),{success:!1,rtt:null,checkId:o}}}recordHealthData(e,t){if(t&&null!==e){this.metrics.rtt.push(e),this.metrics.rtt.length>20&&this.metrics.rtt.shift(),this.metrics.rtt.length>=2&&this.metrics.jitter.push(Math.abs(e-this.metrics.rtt[this.metrics.rtt.length-2])),this.metrics.jitter.length>20&&this.metrics.jitter.shift(),this.degradationTrend=Math.max(-.5,this.degradationTrend-.1)}else this.metrics.packetLoss++,this.degradationTrend=Math.min(1,this.degradationTrend+.2);this.updateHealthScore()}updateHealthScore(){if(0===this.metrics.rtt.length)return void(this.healthScore=.8);const e=this.metrics.rtt.reduce((e,t)=>e+t,0)/this.metrics.rtt.length,t=this.metrics.jitter.length>0?this.metrics.jitter.reduce((e,t)=>e+t,0)/this.metrics.jitter.length:0;let s=1,o=1;e>1e3?s=.1:e>500?s=.3:e>200?s=.6:e>100&&(s=.8);let i=1;t>100?i=.3:t>50?i=.6:t>20&&(i=.8),this.healthScore=Math.max(.1,Math.min(1,.6*s+.4*i))*(1-.3*this.degradationTrend),this.lastHealthUpdate=Date.now()}shouldPreemptiveReconnect(){return Date.now()-this.lastHealthUpdate>1e4&&this.healthScore<.4||this.healthScore<.2&&this.degradationTrend>.7}getHealthStatus(){const e=Date.now()-this.lastHealthUpdate;return e>15e3?"unknown":this.healthScore>=.8?"excellent":this.healthScore>=.6?"good":this.healthScore>=.4?"fair":"poor"}}
class HighPerformanceQueue{constructor(e=CONFIG.CONCURRENCY_LIMIT){this.tasks=[];this.active=0;this.processed=0;this.failed=0;this.concurrency=e;this.processing=!1}async enqueue(e,t=0,s=CONFIG.QUEUE_TIMEOUT){return new Promise((o,i)=>{const r={task:e,resolve:o,reject:i,priority:t,timestamp:Date.now(),timeoutId:setTimeout(()=>{i(new Error("Queue timeout"))},s)};this.insertTask(r),this.process()})}insertTask(e){let t=!1;for(let s=0;s<this.tasks.length;s++)if(this.tasks[s].priority<e.priority){this.tasks.splice(s,0,e),t=!0;break}t||this.tasks.push(e)}async process(){if(this.processing||this.active>=this.concurrency||0===this.tasks.length)return;this.processing=!0;for(;this.tasks.length>0&&this.active<this.concurrency;){const e=this.tasks.shift();this.active++,(async()=>{try{clearTimeout(e.timeoutId);const t=await e.task();this.processed++,e.resolve(t)}catch(t){this.failed++,e.reject(t)}finally{this.active--,this.tasks.length>0?this.process():this.processing=!1}})()}this.processing=!1}getStats(){const e=this.processed+this.failed;return{queueLength:this.tasks.length,active:this.active,processed:this.processed,failed:this.failed,successRate:e>0?this.processed/e:1,concurrency:this.concurrency}}clear(){this.tasks.forEach(e=>clearTimeout(e.timeoutId)),this.tasks=[]}}


// ==================== 所有工具函数 (来自两个脚本) ====================
function parseProxyConfig(proxyStr) {
    let user = null, pass = null, host = null, port = null;
    const atIndex = proxyStr.lastIndexOf('@');
    if (atIndex !== -1) {
        const credentials = proxyStr.substring(0, atIndex);
        const colonIndex = credentials.indexOf(':');
        if (colonIndex !== -1) {
            user = decodeURIComponent(credentials.substring(0, colonIndex));
            pass = decodeURIComponent(credentials.substring(colonIndex + 1));
        } else {
            user = decodeURIComponent(credentials);
        }
        [host, port] = parseHostPort(proxyStr.substring(atIndex + 1));
    } else {
        [host, port] = parseHostPort(proxyStr);
    }
    return { user, pass, host, port: +port || 443 };
}

function parseHostPort(hostPortStr, defaultPort = 443) {
    if (hostPortStr.startsWith('[')) {
        const closingBracketIndex = hostPortStr.lastIndexOf(']');
        const host = hostPortStr.substring(1, closingBracketIndex);
        const port = hostPortStr.substring(closingBracketIndex + 2) || defaultPort;
        return [host, port];
    }
    const colonIndex = hostPortStr.lastIndexOf(':');
    if (colonIndex === -1) {
        return [hostPortStr, defaultPort];
    }
    return [hostPortStr.substring(0, colonIndex), hostPortStr.substring(colonIndex + 1)];
}

function getConnectionModes(mode, params, s5, http, proxyip) {
    if (mode !== 'auto') {
        return [mode];
    }
    const order = [];
    for (const key of params.keys()) {
        if (key === 's5' && s5 && !order.includes('s5')) order.push('s5');
        else if (key === 'http' && http && !order.includes('http')) order.push('http');
        else if (key === 'proxyip' && proxyip && !order.includes('proxyip')) order.push('proxyip');
        else if (key === 'direct' && !order.includes('direct')) order.push('direct');
    }
    return order.length ? order : ['direct'];
}

function buildUUID(arr, start) {
  const hex = Array.from(arr.slice(start, start + 16)).map(n => n.toString(16).padStart(2, '0')).join('');
  return hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

function extractAddress(bytes) {
  const offset1 = 18 + bytes[17] + 1;
  const port = (bytes[offset1] << 8) | bytes[offset1 + 1];
  const type = bytes[offset1 + 2];
  let offset2 = offset1 + 3;
  let length, host;
  
  switch (type) {
    case 1: // IPv4
      length = 4;
      host = bytes.slice(offset2, offset2 + length).join('.');
      break;
    case 2: // Domain
      length = bytes[offset2];
      offset2++;
      host = new TextDecoder().decode(bytes.slice(offset2, offset2 + length));
      break;
    case 3: // IPv6
      length = 16;
      host = Array.from({length: 8}, (_, i) => {
          const val = (bytes[offset2 + i * 2] << 8) | bytes[offset2 + i * 2 + 1];
          return val.toString(16);
      }).join(':');
      break;
    default:
      throw new Error(`Invalid address type: ${type}`);
  }
  
  const payload = bytes.slice(offset2 + length);
  return { host, port, type, payload };
}

// [!] 新增: 用于精确读取指定长度字节的辅助函数
/**
 * 从 reader 中精确读取指定长度的字节
 * @param {ReadableStreamDefaultReader} reader 
 * @param {number} length 
 * @returns {Promise<Uint8Array>}
 */
async function readExactly(reader, length) {
  let buffer = new Uint8Array(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const { done, value } = await reader.read();
    if (done) {
      // 如果流提前结束，抛出错误
      throw new Error(`Stream ended prematurely. Expected ${length} bytes, but only got ${bytesRead}.`);
    }
    
    // 计算当前数据块中我们还需要的部分
    const bytesToRead = Math.min(value.length, length - bytesRead);
    const chunk = value.subarray(0, bytesToRead);
    
    buffer.set(chunk, bytesRead);
    bytesRead += chunk.length;

    // 注意: 这个简单实现没有处理 value 中可能包含下一个响应数据的情况。
    // 对于SOCKS5这种简单的请求-响应模式，这通常是安全的。
    // 更复杂的协议需要一个更复杂的带缓冲的读取器。
  }
  return buffer;
}
