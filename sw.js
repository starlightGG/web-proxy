// =====================================================
// ADBLOCK CONFIGURATION
// =====================================================
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
        if (regex.test(urlStr)) return true;
    }
    return false;
}

// =====================================================
// SCRAMJET & BARE-MUX SETUP
// =====================================================
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

// =====================================================
// SERVER STATE & CONFIG
// =====================================================
let wispConfig = {
    wispurl: null,
    servers: [],
    autoswitch: true
};

let serverHealth = new Map();
const MAX_CONSECUTIVE_FAILURES = 2;

// Mutex lock to prevent simultaneous initializations
let isInitializing = false; 

let resolveConfigReady;
const configReadyPromise = new Promise(resolve => resolveConfigReady = resolve);

// Lifecycle Events
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function pingServer(url) {
    return new Promise((resolve) => {
        try {
            const ws = new WebSocket(url);
            const timeout = setTimeout(() => {
                try { ws.close(); } catch {}
                resolve({ url, success: false });
            }, 3000);
            ws.onopen = () => {
                clearTimeout(timeout);
                try { ws.close(); } catch {}
                resolve({ url, success: true });
            };
            ws.onerror = () => {
                clearTimeout(timeout);
                resolve({ url, success: false });
            };
        } catch { resolve({ url, success: false }); }
    });
}

function switchToServer(url) {
    if (url === wispConfig.wispurl) return;
    console.log("SW: Switching Wisp Server to", url);
    wispConfig.wispurl = url;
    scramjet.client = null; // Clear existing client to force re-initialization
}

// =====================================================
// MESSAGE LISTENER
// =====================================================
self.addEventListener("message", ({ data }) => {
    if (data.type === "config") {
        if (data.wispurl) wispConfig.wispurl = data.wispurl;
        if (data.servers) wispConfig.servers = data.servers;
        if (typeof data.autoswitch !== 'undefined') wispConfig.autoswitch = data.autoswitch;
        
        if (wispConfig.wispurl && resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    }
});

// =====================================================
// FETCH LISTENER (STATIC & ROUTED ASSETS)
// =====================================================
self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        if (isAdBlocked(event.request.url)) {
            return new Response(null, { status: 204 });
        }
        await scramjet.loadConfig();
        if (scramjet.route(event)) {
            return scramjet.fetch(event);
        }
        return fetch(event.request);
    })());
});

// =====================================================
// SCRAMJET REQUEST LISTENER (THE PROXIED TRAFFIC)
// =====================================================
scramjet.addEventListener("request", async (e) => {
    e.response = (async () => {
        // Wait for the initial config from the frontend
        await configReadyPromise;
        
        if (!wispConfig.wispurl) {
            return new Response("Wisp URL missing", { status: 500 });
        }

        // --- TRANSPORT INITIALIZATION WITH MUTEX LOCK ---
        const ensureClientReady = async () => {
            // If already set up, return immediately
            if (scramjet.client && typeof scramjet.client.fetch === 'function') return true;

            // If another request is currently initializing, wait for it
            if (isInitializing) {
                while (isInitializing) {
                    await new Promise(r => setTimeout(r, 100));
                }
                return !!(scramjet.client && typeof scramjet.client.fetch === 'function');
            }

            // Start initialization
            isInitializing = true;
            try {
                const connection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
                await connection.setTransport("https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs", [{ wisp: wispConfig.wispurl }]);
                
                // Final safety check: wait for .fetch injection
                let check = 0;
                while (typeof connection.fetch !== 'function' && check < 30) {
                    await new Promise(r => setTimeout(r, 100));
                    check++;
                }
                
                scramjet.client = connection;
            } catch (err) {
                console.error("SW: Connection Init Failed:", err);
            } finally {
                isInitializing = false;
            }
            return !!(scramjet.client && typeof scramjet.client.fetch === 'function');
        };

        const isReady = await ensureClientReady();
        if (!isReady) {
            return new Response("Scramjet Error: Could not establish a secure connection to the Wisp server. Check bareworker.js or the server status.", { status: 502 });
        }

        // --- PROXIED FETCH ---
        const MAX_RETRIES = 2;
        let lastErr;

        for (let i = 0; i <= MAX_RETRIES; i++) {
            try {
                return await scramjet.client.fetch(e.url, {
                    method: e.method,
                    body: e.body,
                    headers: e.requestHeaders,
                    credentials: "include",
                    mode: e.mode === "cors" ? e.mode : "same-origin",
                    cache: e.cache,
                    redirect: "manual",
                    duplex: "half",
                });
            } catch (err) {
                lastErr = err;
                // Only retry GET requests on specific connection errors
                if (i === MAX_RETRIES || e.method !== 'GET') break;
                await new Promise(r => setTimeout(r, 500 * (i + 1)));
            }
        }

        // --- FAILURE & AUTOSWITCH HANDLING ---
        if (wispConfig.autoswitch && wispConfig.servers.length > 1) {
            console.warn("SW: Request failed on", wispConfig.wispurl, " - Attempting autoswitch.");
            for (const server of wispConfig.servers) {
                if (server.url === wispConfig.wispurl) continue;
                const check = await pingServer(server.url);
                if (check.success) {
                    switchToServer(server.url);
                    break;
                }
            }
        }

        return new Response("Scramjet Fetch Error: " + lastErr.message, { status: 502 });
    })();
});
