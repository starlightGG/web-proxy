
const ADBLOCK = {
    blocked: [
  "googlevideo.com/videoplayback",
  "youtube.com/get_video_info",
  "youtube.com/api/stats/ads",
  "youtube.com/pagead",
  "youtube.com/api/stats",
  "youtube.com/get_midroll",
  "youtube.com/ptracking",
  "youtube.com/youtubei/v1/player",
  "youtube.com/s/player",
  "youtube.com/api/timedtext",
  "facebook.com/ads",
  "facebook.com/tr",
  "fbcdn.net/ads",
  "graph.facebook.com/ads",
  "graph.facebook.com/pixel",
  "ads-api.twitter.com",
  "analytics.twitter.com",
  "twitter.com/i/ads",
  "ads.yahoo.com",
  "advertising.com",
  "adtechus.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "rubiconproject.com",
  "pubmatic.com",
  "criteo.com",
  "openx.net",
  "taboola.com",
  "outbrain.com",
  "moatads.com",
  "casalemedia.com",
  "unityads.unity3d.com",
  "/ads/",
  "/adserver/",
  "/banner/",
  "/promo/",
  "/tracking/",
  "/beacon/",
  "/metrics/",
  "adsafeprotected.com",
  "chartbeat.com",
  "scorecardresearch.com",
  "quantserve.com",
  "krxd.net",
  "demdex.net"
]   
};

function isAdBlocked(url) {
    const urlStr = url.toString();
    for (const pattern of ADBLOCK.blocked) {
        let regexPattern = pattern
            .replace(/\*/g, '.*')
            .replace(/\./g, '\\.')
            .replace(/\?/g, '\\?');
        const regex = new RegExp('^' + regexPattern + '$', 'i');
        if (regex.test(urlStr)) {
            return true;
        }
    }
    return false;
}

const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);
self.basePath = self.basePath || basePath;

self.$scramjet = {
    files: {
        wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
        sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js",
    }
};

importScripts("https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js");
importScripts("https://cdn.jsdelivr.net/npm/@mercuryworkshop/bare-mux/dist/index.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker({
    prefix: basePath + "scramjet/"
});

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Wisp configuration - receives from script.js via postMessage
let wispConfig = {
    wispurl: null,
    servers: [],
    autoswitch: true
};

// Server health tracking for autoswitching
let serverHealth = new Map();
let currentServerStartTime = null;
const MAX_CONSECUTIVE_FAILURES = 2;
const PING_TIMEOUT = 3000;

let resolveConfigReady;
const configReadyPromise = new Promise(resolve => resolveConfigReady = resolve);

// Ping a wisp server to check if it's responsive
async function pingServer(url) {
    return new Promise((resolve) => {
        const start = Date.now();
        try {
            const ws = new WebSocket(url);
            const timeout = setTimeout(() => {
                try { ws.close(); } catch {}
                resolve({ url, success: false, latency: null });
            }, PING_TIMEOUT);

            ws.onopen = () => {
                clearTimeout(timeout);
                const latency = Date.now() - start;
                try { ws.close(); } catch {}
                resolve({ url, success: true, latency });
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                try { ws.close(); } catch {}
                resolve({ url, success: false, latency: null });
            };
        } catch {
            resolve({ url, success: false, latency: null });
        }
    });
}

// Update server health status
function updateServerHealth(url, success) {
    const health = serverHealth.get(url) || { consecutiveFailures: 0, successes: 0, lastSuccess: 0 };
    
    if (success) {
        health.consecutiveFailures = 0;
        health.successes++;
        health.lastSuccess = Date.now();
    } else {
        health.consecutiveFailures++;
    }
    
    serverHealth.set(url, health);
    return health;
}

function switchToServer(url, latency = null) {
    if (url === wispConfig.wispurl) return;
    
    console.log(`SW: Switching from ${wispConfig.wispurl} to ${url}`);
    wispConfig.wispurl = url;
    currentServerStartTime = Date.now();
    
    // Notify all clients
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage({
                type: 'wispChanged',
                url: url,
                name: wispConfig.servers.find(s => s.url === url)?.name || 'Unknown Server',
                latency: latency
            });
        });
    });

    // Reset connection to force reconnection with new server
    if (scramjet && scramjet.client) {
        scramjet.client = null;
    }
}

// Proactively check server health and switch if needed
async function proactiveServerCheck() {
    if (!wispConfig.autoswitch || !wispConfig.servers || wispConfig.servers.length === 0) return;

    const currentUrl = wispConfig.wispurl;
    
    // Ping all servers to get current health status
    const results = await Promise.all(
        wispConfig.servers.map(s => pingServer(s.url))
    );

    // Update health tracking
    results.forEach(r => updateServerHealth(r.url, r.success));

    // If current server is bad and we have a better option, switch
    const currentHealth = serverHealth.get(currentUrl);
    if (currentHealth && currentHealth.consecutiveFailures > 0) {
        const bestWorking = results
            .filter(r => r.success && r.url !== currentUrl)
            .sort((a, b) => a.latency - b.latency)[0];

        if (bestWorking) {
            switchToServer(bestWorking.url, bestWorking.latency);
        }
    }
}

self.addEventListener("message", ({ data }) => {
    if (data.type === "config") {
        if (data.wispurl) {
            wispConfig.wispurl = data.wispurl;
            console.log("SW: Received wispurl", data.wispurl);
            currentServerStartTime = Date.now();
        }
        if (data.servers && data.servers.length > 0) {
            wispConfig.servers = data.servers;
            console.log("SW: Received servers", data.servers.length);
            if (wispConfig.autoswitch) {
                setTimeout(proactiveServerCheck, 500);
            }
        }
        if (typeof data.autoswitch !== 'undefined') {
            wispConfig.autoswitch = data.autoswitch;
            if (wispConfig.autoswitch && wispConfig.servers?.length > 0) {
                setTimeout(proactiveServerCheck, 500);
            }
        }
        // Resolve config ready when we have at least wispurl
        if (wispConfig.wispurl && resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    } else if (data.type === "ping") {
        pingServer(wispConfig.wispurl).then(result => {
            self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({ type: 'pingResult', ...result });
                });
            });
        });
    }
});

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        // Check if request URL matches ad blocking patterns
        if (isAdBlocked(event.request.url)) {
            console.log("SW: Blocked ad request:", event.request.url);
            return new Response(new ArrayBuffer(0), { status: 204 });
        }

        await scramjet.loadConfig();
        if (scramjet.route(event)) {
            return scramjet.fetch(event);
        }
        return fetch(event.request);
    })());
});

// Add a lock to prevent multiple simultaneous connection attempts
let isConnecting = false;

scramjet.addEventListener("request", async (e) => {
    e.response = (async () => {
        // 1. Wait for config with a timeout so it doesn't hang forever
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Config Timeout")), 5000)
        );
        
        try {
            await Promise.race([configReadyPromise, timeoutPromise]);
        } catch (err) {
            console.error("SW: Proceeding without explicit config signal");
        }
        
        if (!wispConfig.wispurl) {
            return new Response("Wisp URL missing", { status: 503 });
        }

        // 2. Singleton Connection Logic (Prevents "Double-Connecting" 503s)
        if (!scramjet.client && !isConnecting) {
            isConnecting = true;
            try {
                const connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
                await connection.setTransport("https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs", [{ wisp: wispConfig.wispurl }]);
                scramjet.client = connection;
            } catch (connErr) {
                isConnecting = false;
                return new Response("Transport Connection Failed", { status: 503 });
            }
            isConnecting = false;
        }

        // 3. Robust Fetch with logic to handle 503/Abort errors
        const MAX_RETRIES = 2;
        let lastErr;

        for (let i = 0; i <= MAX_RETRIES; i++) {
            try {
                // Ensure we have a client before fetching
                if (!scramjet.client) throw new Error("Client not ready");

                return await scramjet.client.fetch(e.url, {
                    method: e.method,
                    body: e.body,
                    headers: e.requestHeaders,
                    redirect: "manual",
                });
            } catch (err) {
                lastErr = err;
                // If it's a connection error, kill the client so it rebuilds on next attempt
                if (err.message.includes("connection") || err.message.includes("WebSocket")) {
                    scramjet.client = null; 
                }
                
                if (i < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 1000 * i)); // Exponential backoff
                    continue;
                }
            }
        }

        return new Response(`Proxy Error: ${lastErr.message}`, { status: 503 });
    })();
});
