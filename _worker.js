// @ts-ignore
import { connect } from 'cloudflare:sockets';

// =================================================================
//                      CONFIGURATION STORE
// This object holds the configuration loaded from environment variables.
// =================================================================

const config = {
	authToken: 'd342d11e-d424-4583-b36e-524ab1f0afa4', // Corresponds to the old UUID
	fallbackHost: '',    // Corresponds to the old PROXYIP
	endpointPath: '/',      // Corresponds to the old WSPATH
	authTokenBytes: new Uint8Array(16),
};


// =================================================================
//                       MAIN WORKER LOGIC
// =================================================================

export default {
	async fetch(request, env, ctx) {
		try {
			// Initialize configuration within the fetch handler to prevent startup errors (1101).
			initializeConfiguration(env);
			
			const url = new URL(request.url);
			const upgradeHeader = request.headers.get('Upgrade');

			// Route requests based on path and upgrade header.
			if (upgradeHeader === 'websocket' && url.pathname === config.endpointPath) {
				return await handleDataStream(request);
			} else {
				return serveLandingPage(request);
			}
		} catch (err) {
			console.error('Critical Error in fetch handler:', err);
			return new Response(err.toString(), { status: 500 });
		}
	},
};

/**
 * Loads configuration from Cloudflare environment variables.
 * @param {{AUTH_TOKEN: string, FALLBACK_HOST: string, ENDPOINT_PATH: string}} env
 */
function initializeConfiguration(env) {
	const newAuthToken = env.AUTH_TOKEN || config.authToken;
	if (newAuthToken !== config.authToken) {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(newAuthToken)) {
			throw new Error('AUTH_TOKEN in environment variable is not a valid UUID');
		}
		config.authToken = newAuthToken;
		config.authTokenBytes = uuidToBytes(config.authToken);
	}
	
	config.fallbackHost = env.FALLBACK_HOST || config.fallbackHost;
	config.endpointPath = env.ENDPOINT_PATH ? (env.ENDPOINT_PATH.startsWith('/') ? env.ENDPOINT_PATH : '/' + env.ENDPOINT_PATH) : config.endpointPath;
}


// =================================================================
//                   DATA STREAM & CONNECTION HANDLING
// =================================================================

/**
 * Handles the WebSocket data stream.
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function handleDataStream(request) {
	const [client, serverSocket] = Object.values(new WebSocketPair());
	serverSocket.accept();

	const streamController = createStreamController(serverSocket);

	let remoteConnection = { value: null };
	let isDnsQuery = false;

	streamController.readable.pipeTo(new WritableStream({
		async write(chunk) {
			if (isDnsQuery) return;
			if (remoteConnection.value) {
				const writer = remoteConnection.value.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				error,
				destinationPort = 443,
				destinationAddress = '',
				dataStartIndex,
				protocolVersion = new Uint8Array([0, 0]),
				isUDP,
			} = parseRequestHeader(chunk, config.authTokenBytes);
			
			if (hasError) throw new Error(error);

			if (isUDP) {
				if (destinationPort === 53) {
					isDnsQuery = true;
					await forwardDnsQuery(chunk.slice(dataStartIndex), serverSocket, protocolVersion);
				} else {
					throw new Error('UDP traffic is only permitted for DNS on port 53.');
				}
				return;
			}
			
			// For TCP traffic
			await initiateForwarding(
				remoteConnection,
				destinationAddress,
				destinationPort,
				chunk.slice(dataStartIndex),
				serverSocket,
				new Uint8Array([protocolVersion[0], 0])
			);
		},
	})).catch((err) => {
		console.error('Data stream processing error:', err);
		closeWebSocket(serverSocket);
	});

	return new Response(null, { status: 101, webSocket: client });
}

/**
 * Initiates the outbound TCP connection with fallback logic.
 * @param {{ value: import("@cloudflare/workers-types").Socket | null }} remoteConnection
 */
async function initiateForwarding(remoteConnection, address, port, initialData, webSocket, responseHeader) {
	
	const connectAndWrite = async (hostname, port) => {
		const tcpSocket = connect({ hostname, port });
		remoteConnection.value = tcpSocket;
		const writer = tcpSocket.writable.getWriter();
		await writer.write(initialData);
		writer.releaseLock();
		return tcpSocket;
	};

	const retryWithFallback = async () => {
		if (!config.fallbackHost) {
			console.log("Initial connection failed, but no FALLBACK_HOST is configured. Cannot retry.");
			return;
		}
		console.log(`Initial connection to ${address} failed, retrying with FALLBACK_HOST: ${config.fallbackHost}`);
		
		const fallbackSocket = await connectAndWrite(config.fallbackHost, port);
		fallbackSocket.closed.finally(() => closeWebSocket(webSocket));
		
		bridgeConnections(fallbackSocket, webSocket, responseHeader, null);
	};

	const initialSocket = await connectAndWrite(address, port);
	bridgeConnections(initialSocket, webSocket, responseHeader, retryWithFallback);
}

/**
 * Bridges the remote TCP socket and the client WebSocket.
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket
 * @param {() => Promise<void>) | null} onFailover
 */
async function bridgeConnections(remoteSocket, webSocket, responseHeader, onFailover) {
	let responseHeaderSent = false;
	let hasReceivedData = false;

	await remoteSocket.readable.pipeTo(new WritableStream({
		async write(chunk) {
			hasReceivedData = true;
			if (webSocket.readyState !== 1) return;
			
			if (!responseHeaderSent) {
				webSocket.send(await new Blob([responseHeader, chunk]).arrayBuffer());
				responseHeaderSent = true;
			} else {
				webSocket.send(chunk);
			}
		},
	})).catch(() => {});

	if (!hasReceivedData && onFailover) {
		console.log(`Connection to ${remoteSocket.remoteAddress}:${remoteSocket.remotePort} closed without data. Triggering failover.`);
		await onFailover();
	}
}


// =================================================================
//                         UTILITY FUNCTIONS
// =================================================================

/**
 * Parses the VLESS protocol header from the client's first data chunk.
 * @param {ArrayBuffer} dataChunk
 * @param {Uint8Array} authTokenBytes
 */
function parseRequestHeader(dataChunk, authTokenBytes) {
	if (dataChunk.byteLength < 24) {
		return { hasError: true, error: 'Invalid data length' };
	}
	const view = new Uint8Array(dataChunk);
	const receivedAuthToken = view.slice(1, 17);
	if (!compareUint8Arrays(receivedAuthToken, authTokenBytes)) {
		return { hasError: true, error: 'Authentication failed' };
	}

	const protocolVersion = view.slice(0, 1);
	const addonLength = view[17];
	const command = view[18 + addonLength]; // 1=TCP, 2=UDP

	if (command !== 1 && command !== 2) {
		return { hasError: true, error: `Unsupported command: ${command}` };
	}

	const isUDP = (command === 2);
	const portIndex = 19 + addonLength;
	const destinationPort = new DataView(dataChunk, portIndex, 2).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressType = view[addressIndex];
	let addressLength = 0;
	let destinationAddress = '';
	let dataStartIndex = 0;

	switch (addressType) {
		case 1: // IPv4
			addressLength = 4;
			destinationAddress = view.slice(addressIndex + 1, addressIndex + 1 + addressLength).join('.');
			dataStartIndex = addressIndex + 1 + addressLength;
			break;
		case 2: // Domain
			addressLength = view[addressIndex + 1];
			destinationAddress = new TextDecoder().decode(view.slice(addressIndex + 2, addressIndex + 2 + addressLength));
			dataStartIndex = addressIndex + 2 + addressLength;
			break;
		case 3: // IPv6
			addressLength = 16;
			const ipv6 = Array.from(new Uint16Array(dataChunk.slice(addressIndex + 1, addressIndex + 1 + addressLength)))
				.map(v => v.toString(16)).join(':');
			destinationAddress = `[${ipv6}]`;
			dataStartIndex = addressIndex + 1 + addressLength;
			break;
		default:
			return { hasError: true, error: `Invalid address type: ${addressType}` };
	}

	return { hasError: false, destinationAddress, destinationPort, dataStartIndex, protocolVersion, isUDP };
}

async function forwardDnsQuery(queryData, webSocket, protocolVersion) {
	try {
		const response = await fetch('https://1.1.1.1/dns-query', {
			method: 'POST',
			headers: { 'content-type': 'application/dns-message' },
			body: queryData,
		});
		const dnsResult = await response.arrayBuffer();
		const resultSize = dnsResult.byteLength;
		const sizeBuffer = new Uint8Array([(resultSize >> 8) & 0xff, resultSize & 0xff]);
		const responseHeader = new Uint8Array([protocolVersion[0], 0]);
		
		if (webSocket.readyState === 1) {
			webSocket.send(await new Blob([responseHeader, sizeBuffer, dnsResult]).arrayBuffer());
		}
	} catch (error) {
		console.error('DNS over HTTPS query failed:', error);
	}
}

function createStreamController(webSocket) {
	let isCancelled = false;
	const readable = new ReadableStream({
		start(controller) {
			webSocket.addEventListener('message', (event) => {
				if (isCancelled) return;
				controller.enqueue(event.data);
			});
			webSocket.addEventListener('close', () => {
				if (isCancelled) return;
				controller.close();
				closeWebSocket(webSocket);
			});
			webSocket.addEventListener('error', (err) => controller.error(err));
		},
		cancel() {
			isCancelled = true;
			closeWebSocket(webSocket);
		}
	});
	return { readable };
}

function closeWebSocket(socket) {
	try {
		if (socket.readyState === 1) { // OPEN
			socket.close();
		}
	} catch (error) {
		// Ignore potential errors from closing an already closed socket.
	}
}

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

// =================================================================
//                      LANDING PAGE (CAMOUFLAGE)
// =================================================================

async function serveLandingPage(request) {
    const host = new URL(request.url).host;
	return new Response(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Edge Gateway Service</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; background-color: #f4f4f4; color: #333; margin: 0; padding: 2em; }
        .container { max-width: 760px; margin: 0 auto; background: #fff; padding: 2em 3em; border: 1px solid #ddd; }
        h1 { color: #000; }
        p { color: #666; }
        .status { color: green; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Service Deployed Successfully</h1>
        <p>This endpoint (<code>${host}</code>) is an operational entry point for the Edge Gateway Service.</p>
        <h2>System Status</h2>
        <p>All systems are functioning normally. Current node status is <span class="status">ONLINE</span>.</p>
        <p>Client applications must be configured with the correct authentication token and endpoint path to establish a data stream. Please consult the internal engineering documentation for connection parameters.</p>
    </div>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
