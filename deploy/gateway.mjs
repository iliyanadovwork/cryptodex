/**
 * THE GATEWAY - one public port in front of three loopback Express apps.
 * ======================================================================
 *
 * Listens on $PORT (Railway injects it) and forwards to 127.0.0.1:<upstream>
 * according to deploy/routes.mjs. It rewrites nothing: the request line, the
 * headers and the body go through unchanged, so every service sees exactly the
 * request it would have seen on the developer's machine.
 *
 * ZERO DEPENDENCIES, ON PURPOSE. http-proxy / express-http-proxy would each add
 * a package (and a transitive tree) to an image whose whole point is to be
 * small and cheap, to do two things this file does in ~100 lines. node:http and
 * node:net are already in the runtime.
 *
 * WHAT IT HANDLES THAT A NAIVE PROXY DOES NOT
 *
 *  1. WEBSOCKET UPGRADE. socket.io's `websocket` transport is an HTTP Upgrade,
 *     which never reaches a normal 'request' handler. The 'upgrade' event below
 *     opens a raw TCP socket to spotapi, replays the request line and headers
 *     verbatim, and then pipes the two sockets together. From that point the
 *     gateway is a dumb tube and every frame - order book, trades, private fill
 *     events - flows untouched.
 *
 *  2. LONG POLLING. socket.io falls back to `polling` when a websocket cannot be
 *     established, and a poll deliberately holds a request open. Node's default
 *     `requestTimeout` (300s) and `headersTimeout` would eventually cut those,
 *     so both are relaxed here. Responses are STREAMED, never buffered, or a
 *     poll would only deliver when it closed.
 *
 *  3. /api/health FANS OUT. All three services answer /api/health, so no single
 *     prefix route can express it. The gateway asks all three and returns 200
 *     only when all three answer 200. Railway's healthcheck then means "the
 *     venue is up", not "one third of the venue is up".
 *
 * An unrouted path gets an explicit 404 naming this gateway. A silent default
 * to one service would turn a missing route into a confusing 401 or 404 from an
 * unrelated API; this way the mistake says what it is, in the browser console.
 */
import http from "node:http";
import net from "node:net";
import { routeFor, UPSTREAMS } from "./routes.mjs";

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const UPSTREAM_HOST = "127.0.0.1";

const log = (...a) => console.log("[gateway]", ...a);

/** Health of one upstream: resolves to a small object, never rejects. */
function probe(service) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAMS[service],
        path: "/api/health",
        method: "GET",
        timeout: 4000,
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ service, status: res.statusCode, ok: res.statusCode === 200 })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ service, status: 0, ok: false, error: "timeout" });
    });
    req.on("error", (err) =>
      resolve({ service, status: 0, ok: false, error: err.code || err.message })
    );
    req.end();
  });
}

async function aggregateHealth(res) {
  const names = Object.keys(UPSTREAMS);
  const results = await Promise.all(names.map(probe));
  const ok = results.every((r) => r.ok);
  const body = JSON.stringify(
    {
      status: ok ? "ok" : "degraded",
      services: Object.fromEntries(
        results.map((r) => [r.service, { status: r.status, ok: r.ok, error: r.error }])
      ),
    },
    null,
    2
  );
  res.writeHead(ok ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];

  if (pathname === "/api/health" || pathname === "/health") {
    aggregateHealth(res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: String(err) }));
    });
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("cryptodex gateway\n");
    return;
  }

  const service = routeFor(pathname);
  if (!service) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        message: `no route for ${pathname} - see deploy/routes.mjs`,
        gateway: true,
      })
    );
    return;
  }

  // Forward the request line and headers unchanged, plus the usual forwarding
  // hints. `host` is left as the client sent it so any absolute URL a service
  // builds from it still points at the public hostname.
  const headers = { ...req.headers };
  const priorFor = headers["x-forwarded-for"];
  headers["x-forwarded-for"] = priorFor
    ? `${priorFor}, ${req.socket.remoteAddress}`
    : req.socket.remoteAddress;
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "http";
  headers["x-cryptodex-upstream"] = service;

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAMS[service],
      method: req.method,
      path: req.url,
      headers,
    },
    (upRes) => {
      // Echo the decision back. When a call misbehaves, the browser's network
      // tab then says which of the three services answered it, which is the
      // first question anyone debugging a single-origin deployment asks.
      res.writeHead(upRes.statusCode, { ...upRes.headers, "x-cryptodex-upstream": service });
      upRes.pipe(res); // streamed: long-polling and downloads both work
    }
  );

  upstream.on("error", (err) => {
    log(`upstream ${service} error on ${req.method} ${pathname}:`, err.code || err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ success: false, message: `${service} unreachable`, gateway: true })
      );
    } else {
      res.destroy();
    }
  });

  req.on("aborted", () => upstream.destroy());
  // req 'aborted' only fires while the REQUEST is still incomplete. A GET (long
  // poll, static download) completes as soon as its headers arrive, so a client
  // that then drops the connection mid-RESPONSE - tab close, mobile disconnect,
  // cancelled download, socket.io polling reconnect churn - never fires it, and
  // `upRes.pipe(res)` does not tear down its source when res closes. The
  // upstream would keep producing the whole response nobody is reading and pin a
  // loopback socket. Destroy it the moment the client socket closes early.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});

/**
 * WEBSOCKET. The order book and every private fill event ride this path; if it
 * does not work the trading screen is dead, so it is tunnelled at the TCP level
 * rather than re-implemented.
 */
server.on("upgrade", (req, clientSocket, head) => {
  const pathname = req.url.split("?")[0];
  const service = routeFor(pathname);
  if (!service) {
    clientSocket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  const upstreamSocket = net.connect(UPSTREAMS[service], UPSTREAM_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  const bail = (where) => (err) => {
    log(`ws ${where} error on ${pathname}:`, err.code || err.message);
    upstreamSocket.destroy();
    clientSocket.destroy();
  };
  upstreamSocket.on("error", bail("upstream"));
  clientSocket.on("error", bail("client"));
  // Neither side should be culled for being quiet: socket.io's own 15s ping is
  // the liveness check, and an idle-but-open market feed is normal.
  clientSocket.setTimeout(0);
  clientSocket.setNoDelay(true);
  upstreamSocket.setNoDelay(true);
});

// requestTimeout bounds how long a client may take to SEND the whole request
// (headers + body), NOT how long the RESPONSE may stay open. A socket.io long
// poll is fully received the instant its headers land and then holds the
// RESPONSE open, so the default 300s never threatened it - disabling
// requestTimeout only removed slowloris protection (a client dribbling request
// bytes forever to pin a socket) without helping the poll at all. Keep a finite
// receive deadline; response duration is governed by keepAliveTimeout and the
// per-socket setTimeout(0) on the WS path.
server.requestTimeout = 300000;
server.headersTimeout = 120000;
server.keepAliveTimeout = 72000; // above the usual 60s edge-proxy idle timeout

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  log(
    "upstreams:",
    Object.entries(UPSTREAMS)
      .map(([k, v]) => `${k}=${UPSTREAM_HOST}:${v}`)
      .join(" ")
  );
});

const shutdown = (sig) => {
  log(`${sig} - closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
