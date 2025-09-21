// @ts-ignore
import { connect } from 'cloudflare:sockets';

// ##################################################################
// ##############          核心配置 (Core Configuration)          ##############
// ##################################################################

// 默认的用户 ID (UUID)，强烈建议在 Cloudflare 的环境变量中覆盖它。
// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run: Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

// 默认的回退 IP (ProxyIP)，必须在 Cloudflare 的环境变量中进行设置。
// This is the fallback IP address for sites behind Cloudflare.
// It MUST be configured in Cloudflare's environment variables.
let proxyIP = '';

// ##################################################################
// ##############         性能优化 (Performance Optimizations)       ##############
// ##################################################################

// --- 性能优化：预计算 UUID ---
// 将 UUID 字符串转换为字节数组，用于后续的超高性能逐字节比对，避免字符串操作带来的开销。
let userID_Bytes = uuidToBytes(userID);

/**
 * 将 UUID 字符串转换为 Uint8Array
 * @param {string} uuid
 * @returns {Uint8Array}
 */
function uuidToBytes(uuid) {
	const bytes = new Uint8Array(16);
	const hex = uuid.replaceAll('-', '');
	for (let i = 0; i < 16; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * 逐字节比较两个 Uint8Array
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function compareUint8Arrays(a, b) {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * 检查字符串是否为有效的 UUID 格式
 * @param {string} uuid
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}


// ##################################################################
// ##############          Worker 主逻辑 (Main Worker Logic)         ##############
// ##################################################################

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			// 从环境变量中读取配置，如果存在则覆盖默认值
			const env_userID = env.UUID || userID;
			if (env_userID !== userID) {
				if (!isValidUUID(env_userID)) {
					throw new Error('UUID in environment variable is not valid');
				}
				userID = env_userID;
				userID_Bytes = uuidToBytes(userID);
			}
			
			proxyIP = env.PROXYIP || proxyIP;

			const upgradeHeader = request.headers.get('Upgrade');
			if (upgradeHeader !== 'websocket') {
				// 如果不是 WebSocket 请求，则返回配置和日志的 HTML 页面
				return await getDisplayPage(request);
			} else {
				// 处理 WebSocket VLESS 请求
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			let e = err;
			return new Response(e.toString(), { status: 500 });
		}
	},
};

// ##################################################################
// ##############      WebSocket VLESS 处理器 (VLESS Handler)     ##############
// ##################################################################

/**
 * 处理 VLESS over WebSocket 的请求
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (info, event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	let remoteSocketWapper = { value: null };
	let isDns = false;

	// 将 WebSocket 的可读流管道连接到一个可写流，用于处理传入的数据
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns) {
				// DNS 请求的特殊处理逻辑 (DoH)
				return; // DoH is handled directly in processVlessHeader
			}
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

			if (hasError) {
				throw new Error(message);
			}
			
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
			
			// 启动出站 TCP 连接
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
		// 确保在发生错误时关闭 WebSocket
		safeCloseWebSocket(webSocket);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}


// ##################################################################
// ##############         出站连接处理 (Outbound Logic)         ##############
// ##################################################################

/**
 * 处理出站 TCP 连接，包含核心的“IP 回退”逻辑
 * @param {{ value: import("@cloudflare/workers-types").Socket | null }} remoteSocketWapper
 * @param {string} addressRemote
 * @param {number} portRemote
 * @param {Uint8Array} rawClientData
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {(info: string, event?: any) => void} log
 */
async function handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
	
	/**
	 * 建立到目标地址的 TCP 连接并发送初始数据
	 * @param {string} address
	 * @param {number} port
	 * @returns {Promise<import("@cloudflare/workers-types").Socket>}
	 */
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocketWapper.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}

	/**
	 * 当首次连接失败（僵尸连接）时，执行重试逻辑
	 */
	async function retry() {
		if (!proxyIP) {
			log("首次连接无数据返回，但未设置 PROXYIP，无法重试。");
			return; // No PROXYIP configured, can't retry.
		}
		log(`首次连接到 ${addressRemote} 无数据返回，正在尝试通过 PROXYIP (${proxyIP}) 重试...`);
		
		const tcpSocket = await connectAndWrite(proxyIP, portRemote);
		
		// 无论重试是否成功，最终都要关闭 WebSocket
		tcpSocket.closed.catch(error => {
			log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		});
		
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log); // retry a new remote socket connection
	}

	// 首次尝试直接连接客户端请求的地址
	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// 将远程 TCP socket 的数据转发到 WebSocket，并传入 retry 函数
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 将远程 TCP Socket 的数据流转发到 WebSocket
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {(() => Promise<void>) | null} retry
 * @param {(info: string, event?: any) => void} log
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // 标志位，用于检测“僵尸连接”

	await remoteSocket.readable.pipeTo(
		new WritableStream({
			async write(chunk, controller) {
				hasIncomingData = true; // 只要有数据流入，就将标志位设为 true
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

	// 【核心逻辑】: 如果连接从始至终都没有收到任何数据，并且存在 retry 函数，则执行它
	if (!hasIncomingData && retry) {
		log(`连接到 ${remoteSocket.remoteAddress}:${remoteSocket.remotePort} 的连接已关闭，但未收到任何数据。`);
		await retry();
	}
}

// ##################################################################
// ##############          辅助函数 (Helper Functions)         ##############
// ##################################################################

/**
 * VLESS 头部协议解析
 * @param {ArrayBuffer} vlessBuffer
 * @param {Uint8Array} userIDBytes
 */
function processVlessHeader(vlessBuffer, userIDBytes) {
	if (vlessBuffer.byteLength < 24) {
		return { hasError: true, message: 'invalid data' };
	}
	const view = new Uint8Array(vlessBuffer);
	
	// --- 性能优化：使用逐字节比对 ---
	const receivedUUID = view.slice(1, 17);
	if (!compareUint8Arrays(receivedUUID, userIDBytes)) {
		return { hasError: true, message: 'invalid user' };
	}

	const vlessVersion = view.slice(0, 1);
	const optLength = view[17];
	const command = view[18 + optLength]; // 1=TCP, 2=UDP, 3=MUX

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
		case 1: // IPv4
			addressLength = 4;
			addressRemote = view.slice(addressIndex + 1, addressIndex + 1 + addressLength).join('.');
			rawDataIndex = addressIndex + 1 + addressLength;
			break;
		case 2: // Domain
			addressLength = view[addressIndex + 1];
			addressRemote = new TextDecoder().decode(view.slice(addressIndex + 2, addressIndex + 2 + addressLength));
			rawDataIndex = addressIndex + 2 + addressLength;
			break;
		case 3: // IPv6
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

/**
 * 处理 DNS (UDP port 53) 查询
 */
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


/**
 * 创建一个从 WebSocket 到 ReadableStream 的转换流
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader
 * @param {(info: string, event?: any) => void} log
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
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
			
			// 处理 0-RTT 数据
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) controller.error(error);
			else if (earlyData) controller.enqueue(earlyData);
		},
		cancel(reason) {
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) return { error: null };
	try {
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

// ##################################################################
// ##############        HTML 显示页面 (Display Page)        ##############
// ##################################################################

/**
 * 生成并返回配置和日志的 HTML 页面
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function getDisplayPage(request) {
    const url = new URL(request.url);
    const host = url.host;
	const vlessLink = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2048#${host}-Worker`;

	return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Worker 智能回退版</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.6; background-color: #f8f9fa; color: #212529; margin: 0; padding: 20px; }
        .container { max-width: 800px; margin: 20px auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        h1, h2 { color: #0056b3; border-bottom: 2px solid #0056b3; padding-bottom: 10px; }
        p, li { color: #495057; }
        code { background-color: #e9ecef; padding: 2px 6px; border-radius: 4px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace; }
        .config-box { background: #f1f3f5; border: 1px solid #dee2e6; border-radius: 5px; padding: 15px; margin-top: 15px; }
        .link-box { display: flex; align-items: center; justify-content: space-between; background: #e9ecef; border: 1px solid #ced4da; border-radius: 5px; padding: 10px; margin-top: 15px; }
        .link-box pre { flex-grow: 1; margin: 0; padding-right: 15px; white-space: pre-wrap; word-break: break-all; font-size: 14px; }
        button { background-color: #007bff; color: white; border: none; padding: 10px 18px; border-radius: 5px; cursor: pointer; font-size: 16px; transition: background-color 0.3s; }
        button:hover { background-color: #0056b3; }
        .copy-button { background-color: #28a745; }
        .copy-button:hover { background-color: #218838; }
        #copy-status { color: #28a745; margin-top: 10px; font-weight: bold; display: none; }
        .warning { background-color: #fff3cd; border: 1px solid #ffeeba; color: #856404; padding: 15px; border-radius: 5px; margin-top: 20px; }
        .warning strong { color: #664d03; }
    </style>
</head>
<body>
    <div class="container">
        <h1>VLESS Worker 智能回退版</h1>
        <p>这是一个高性能 VLESS Worker，内置了“IP 自动回退”机制，可以智能处理对 Cloudflare 网站的访问。</p>

        <h2>1. 核心配置 (环境变量)</h2>
        <p>要使此脚本正常工作，您**必须**在 Cloudflare Worker 的设置中配置以下环境变量：</p>
        <div class="config-box">
            <ul>
                <li><strong>UUID</strong>: 您的 VLESS 用户 ID。为了安全，建议您生成一个新的 UUID 并在这里设置。
                    <ul><li>当前脚本中的默认 UUID 为: <code>${userID}</code></li></ul>
                </li>
                <br>
                <li><strong>PROXYIP</strong>: <strong>(最关键的设置)</strong> 用于回退的 IP 地址。
                    <ul><li><strong>作用</strong>: 当访问同样受 Cloudflare 保护的网站失败时，脚本会自动尝试通过此 IP 重新连接。</li>
                    <li><strong>如何获取</strong>: 您可以使用一个 Cloudflare 优选 IP，或者您自己的任何一台海外 VPS 的 IP 地址。</li>
                    <li><strong>重要</strong>: 如果不设置此项，访问 Cloudflare 网站的功能将**无法**正常工作！</li>
                    <li>当前脚本中未设置 PROXYIP。</li>
                    </ul>
                </li>
            </ul>
        </div>
        <p><strong>设置方法</strong>: 进入 Worker 管理界面 -> Settings -> Variables -> Environment Variables -> Add variable。</p>

        <div class="warning">
            <strong>重要提示:</strong> 如果您发现无法访问某些网站（例如同样使用 Cloudflare 的网站），请务必检查您的 <code>PROXYIP</code> 环境变量是否已正确设置。
        </div>

        <h2>2. 您的 VLESS 配置链接</h2>
        <p>点击下方按钮复制您的 VLESS 链接，然后导入到客户端即可使用。</p>
        <div class="link-box">
            <pre id="vless-link">${vlessLink}</pre>
            <button class="copy-button" onclick="copyToClipboard()">复制</button>
        </div>
        <p id="copy-status">已复制到剪贴板！</p>

    </div>
    <script>
        function copyToClipboard() {
            const linkText = document.getElementById('vless-link').innerText;
            navigator.clipboard.writeText(linkText).then(() => {
                const status = document.getElementById('copy-status');
                status.style.display = 'block';
                setTimeout(() => { status.style.display = 'none'; }, 2000);
            });
        }
    </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
