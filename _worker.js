// @ts-ignore
import { connect } from 'cloudflare:sockets';

// ##################################################################
// ##############          核心配置 (Core Configuration)          ##############
// ##################################################################

// 这些值将由 Cloudflare 环境变量动态覆盖。
// These values will be dynamically overridden by Cloudflare Environment Variables.
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
let webSocketPath = '/'; // 默认路径，建议在环境变量中修改

// ##################################################################
// ##############         性能优化 (Performance Optimizations)       ##############
// ##################################################################

let userID_Bytes = uuidToBytes(userID);

function uuidToBytes(uuid) {
	const bytes = new Uint8Array(16);
	const hex = uuid.replaceAll('-', '');
	for (let i = 0; i < 16; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function compareUint8Arrays(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}


// ##################################################################
// ##############          Worker 主逻辑 (Main Worker Logic)         ##############
// ##################################################################

export default {
	async fetch(request, env, ctx) {
		try {
			// 在 fetch handler 内部安全地初始化配置，避免 1101 错误
			initializeConfig(env);
			
			const url = new URL(request.url);
			const upgradeHeader = request.headers.get('Upgrade');

			if (upgradeHeader === 'websocket' && url.pathname === webSocketPath) {
				// 仅当路径匹配时才处理 WebSocket 请求
				return await vlessOverWSHandler(request);
			} else {
				// 对于所有其他请求，返回伪装主页
				return await getCamouflagePage(request);
			}
		} catch (err) {
			let e = err;
			return new Response(e.toString(), { status: 500 });
		}
	},
};

/**
 * 从环境变量中安全地初始化配置
 * @param {{UUID: string, PROXYIP: string, WSPATH: string}} env
 */
function initializeConfig(env) {
	const env_userID = env.UUID || userID;
	if (env_userID !== userID) {
		if (!isValidUUID(env_userID)) {
			throw new Error('UUID in environment variable is not valid');
		}
		userID = env_userID;
		userID_Bytes = uuidToBytes(userID);
	}
	
	proxyIP = env.PROXYIP || proxyIP;
	// 确保路径以 / 开头
	webSocketPath = env.WSPATH ? (env.WSPATH.startsWith('/') ? env.WSPATH : '/' + env.WSPATH) : webSocketPath;
}

// ##################################################################
// ##############      WebSocket VLESS 处理器 (VLESS Handler)     ##############
// ##################################################################

async function vlessOverWSHandler(request) {
	const [client, webSocket] = Object.values(new WebSocketPair());
	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (info, event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, log);
	let remoteSocketWapper = { value: null };
	let isDns = false;

	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns) return; 
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID_Bytes);

			address = addressRemote;
			portWithRandomLog = `${portRemote} ${isUDP ? 'udp' : 'tcp'} ${Math.random().toString(36).substring(2, 6)}`;
			if (hasError) throw new Error(message);
			
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
					await handleDNSQuery(chunk.slice(rawDataIndex), webSocket, vlessVersion);
				} else {
					throw new Error('UDP proxy only enabled for DNS port 53');
				}
				return;
			}

			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);
			
			await handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
		safeCloseWebSocket(webSocket);
	});

	return new Response(null, { status: 101, webSocket: client });
}


// ##################################################################
// ##############         出站连接处理 (Outbound Logic)         ##############
// ##################################################################

async function handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({ hostname: address, port: port });
		remoteSocketWapper.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}

	async function retry() {
		if (!proxyIP) {
			log("首次连接无数据返回，但未设置 PROXYIP，无法重试。");
			return;
		}
		log(`首次连接到 ${addressRemote} 无数据返回，正在尝试通过 PROXYIP (${proxyIP}) 重试...`);
		
		const tcpSocket = await connectAndWrite(proxyIP, portRemote);
		tcpSocket.closed.catch(error => {
			log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		});
		
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false;

	await remoteSocket.readable.pipeTo(
		new WritableStream({
			async write(chunk, controller) {
				hasIncomingData = true;
				if (webSocket.readyState !== WS_READY_STATE_OPEN) {
					controller.error('webSocket.readyState is not open');
				}
				if (vlessHeader) {
					webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
					vlessHeader = null;
				} else {
					webSocket.send(chunk);
				}
			},
			close() {
				log(`remoteSocket.readable is close, hasIncomingData: ${hasIncomingData}`);
			},
			abort(reason) {
				console.error(`remoteSocket.readable abort`, reason);
			},
		})
	).catch((error) => {
		console.error(`remoteSocketToWS has exception`, error.stack || error);
		safeCloseWebSocket(webSocket);
	});

	if (!hasIncomingData && retry) {
		log(`连接到 ${remoteSocket.remoteAddress}:${remoteSocket.remotePort} 的连接已关闭，但未收到任何数据。`);
		await retry();
	}
}

// ##################################################################
// ##############          辅助函数 (Helper Functions)         ##############
// ##################################################################

function processVlessHeader(vlessBuffer, userIDBytes) {
	if (vlessBuffer.byteLength < 24) {
		return { hasError: true, message: 'invalid data' };
	}
	const view = new Uint8Array(vlessBuffer);
	const receivedUUID = view.slice(1, 17);
	if (!compareUint8Arrays(receivedUUID, userIDBytes)) {
		return { hasError: true, message: 'invalid user' };
	}

	const vlessVersion = view.slice(0, 1);
	const optLength = view[17];
	const command = view[18 + optLength];

	if (command !== 1 && command !== 2) {
		return { hasError: true, message: `command ${command} is not support` };
	}

	const isUDP = (command === 2);
	const portIndex = 19 + optLength;
	const portRemote = new DataView(vlessBuffer, portIndex, 2).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressType = view[addressIndex];
	let addressLength = 0;
	let addressRemote = '';
	let rawDataIndex = 0;

	switch (addressType) {
		case 1:
			addressLength = 4;
			addressRemote = view.slice(addressIndex + 1, addressIndex + 1 + addressLength).join('.');
			rawDataIndex = addressIndex + 1 + addressLength;
			break;
		case 2:
			addressLength = view[addressIndex + 1];
			addressRemote = new TextDecoder().decode(view.slice(addressIndex + 2, addressIndex + 2 + addressLength));
			rawDataIndex = addressIndex + 2 + addressLength;
			break;
		case 3:
			addressLength = 16;
			const ipv6 = [];
			const ipv6View = new DataView(vlessBuffer, addressIndex + 1, 16);
			for (let i = 0; i < 8; i++) {
				ipv6.push(ipv6View.getUint16(i * 2).toString(16));
			}
			addressRemote = `[${ipv6.join(':')}]`;
			rawDataIndex = addressIndex + 1 + addressLength;
			break;
		default:
			return { hasError: true, message: `invalid address type: ${addressType}` };
	}

	return { hasError: false, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP };
}

async function handleDNSQuery(queryData, webSocket, vlessVersion) {
	try {
		const resp = await fetch('https://1.1.1.1/dns-query', {
			method: 'POST',
			headers: { 'content-type': 'application/dns-message' },
			body: queryData,
		});
		const dnsResult = await resp.arrayBuffer();
		const udpSize = dnsResult.byteLength;
		const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
		const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
		
		if (webSocket.readyState === WS_READY_STATE_OPEN) {
			webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsResult]).arrayBuffer());
		}
	} catch (error) {
		console.error('DoH query failed', error);
	}
}

function makeReadableWebSocketStream(webSocketServer, log) {
	let readableStreamCancel = false;
	return new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) return;
				controller.enqueue(event.data);
			});
			webSocketServer.addEventListener('close', () => {
				if (readableStreamCancel) return;
				controller.close();
				safeCloseWebSocket(webSocketServer);
			});
			webSocketServer.addEventListener('error', (err) => controller.error(err));
		},
		cancel(reason) {
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});
}

const WS_READY_STATE_OPEN = 1;
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

// ##################################################################
// ##############        HTML 伪装页面 (Camouflage Page)       ##############
// ##################################################################

async function getCamouflagePage(request) {
    const url = new URL(request.url);
    const host = url.host;
	
	return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>项目文档</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.8; background-color: #fdfdff; color: #333; margin: 0; padding: 2em; }
        .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 2em; border-radius: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.05); }
        h1, h2 { color: #2c3e50; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5em; }
        p { color: #555; }
        code { background-color: #f0f0f0; padding: 0.2em 0.4em; border-radius: 5px; font-family: 'Courier New', Courier, monospace; }
        .footer { text-align: center; margin-top: 2em; color: #999; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <h1>项目初始化成功</h1>
        <p>欢迎使用我们的云原生部署解决方案。您的服务已在 <code>${host}</code> 上成功启动。</p>
        
        <h2>关于此项目</h2>
        <p>这是一个基于 Cloudflare Workers 的边缘计算项目模板，旨在提供高性能、高可用性的全球分布式服务。所有请求均通过 Cloudflare 的边缘网络进行处理，确保了最低的延迟和最高的安全性。</p>
        
        <h2>状态</h2>
        <p>所有系统均正常运行。当前服务节点状态为 <strong>在线</strong>。</p>
        <p>要开始使用，请参考我们的内部开发文档，配置您的客户端应用程序以连接到指定的 WebSocket 端点。</p>
        
        <h2>下一步</h2>
        <p>请查阅您的部署日志和环境变量配置，以确保所有参数（如 <code>UUID</code>, <code>PROXYIP</code>, <code>WSPATH</code>）均已正确设置。</p>
    </div>
    <div class="footer">
        <p>&copy; 2025 Edge Services Inc. All rights reserved.</p>
    </div>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
