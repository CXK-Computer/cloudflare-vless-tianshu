// @ts-ignore
import { connect } from 'cloudflare:sockets';

// =================================================================
//                      CONFIGURATION
// This script requires AUTH_TOKEN and FALLBACK_HOST to be set.
// =================================================================
let authToken = '';
let fallbackHost = '';
let authTokenBytes = new Uint8Array(16);

export default {
    async fetch(request, env, ctx) {
        try {
            // Load configuration from environment variables
            authToken = env.AUTH_TOKEN;
            fallbackHost = env.FALLBACK_HOST;

            if (!authToken || !fallbackHost) {
                return new Response("错误：请在环境变量中设置 AUTH_TOKEN 和 FALLBACK_HOST。", { status: 400 });
            }
            authTokenBytes = uuidToBytes(authToken);

            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                return new Response("这是一个诊断脚本，请使用 WebSocket 客户端连接。", { status: 200 });
            }

            return await handleDirectRelay(request);

        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

// =================================================================
//                   DIRECT RELAY LOGIC
// This function directly relays traffic to the FALLBACK_HOST.
// =================================================================

async function handleDirectRelay(request) {
    const [client, serverSocket] = Object.values(new WebSocketPair());
    serverSocket.accept();

    let remoteConnection = null;
    let initialData = null;

    serverSocket.addEventListener('message', async (event) => {
        try {
            if (remoteConnection) {
                const writer = remoteConnection.writable.getWriter();
                await writer.write(event.data);
                writer.releaseLock();
            } else {
                // The first chunk of data contains the VLESS header
                const view = new Uint8Array(event.data);
                const receivedAuthToken = view.slice(1, 17);

                if (!compareUint8Arrays(receivedAuthToken, authTokenBytes)) {
                    serverSocket.close(1008, "Authentication failed");
                    return;
                }
                
                // Assume the client wants to connect to port 443 on the fallback host.
                // We ignore the destination address in the VLESS header for this test.
                const port = 443; 
                initialData = event.data; // Keep the original VLESS header

                // Establish the direct connection to the fallback host
                remoteConnection = connect({ hostname: fallbackHost, port: port });
                
                // Bridge the connections
                const writer = remoteConnection.writable.getWriter();
                await writer.write(initialData);
                writer.releaseLock();

                bridgeConnections(remoteConnection, serverSocket);
            }
        } catch (error) {
            console.error("Relay error:", error);
            if (remoteConnection) remoteConnection.close();
            serverSocket.close(1011, "Relay failed");
        }
    });

    return new Response(null, { status: 101, webSocket: client });
}


async function bridgeConnections(remoteSocket, webSocket) {
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState === 1) {
                        webSocket.send(chunk);
                    }
                },
                close() {
                    if (webSocket.readyState === 1) {
                        webSocket.close(1000, "Remote connection closed");
                    }
                },
            })
        );
    } catch (error) {
        console.error("Bridging error:", error);
        if (webSocket.readyState === 1) {
            webSocket.close(1011, "Bridging failed");
        }
    }
}

// --- Utility Functions ---
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
