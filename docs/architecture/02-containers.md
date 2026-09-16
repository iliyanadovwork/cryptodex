# 02 — Containers (evidence)

Companion to [`02-containers.mmd`](02-containers.mmd), which draws the **production (Railway)**
topology. The local topology differs materially and is documented at the bottom.

**Derived from deploy config first:** [railway.json](../../railway.json) → [deploy/Dockerfile](../../deploy/Dockerfile) →
[deploy/supervisor.mjs](../../deploy/supervisor.mjs) → [deploy/routes.mjs](../../deploy/routes.mjs), then package manifests, then code.

---

## Deployable units

| Element | What it is | Source `file:line` | Notes |
|---|---|---|---|
| **cryptodex-web** | Separate Railway service. NIXPACKS, `npx next start -p ${PORT:-3000}`, healthcheck `/` | [frontend/railway.json:4](../../cryptodex-frontend/railway.json#L4) | `numReplicas: 1`, restart ON_FAILURE ×10 |
| **cryptodex-api** | One container, DOCKERFILE builder, `node deploy/supervisor.mjs`, healthcheck `/api/health`, timeout 300s | [railway.json:3-15](../../railway.json#L3-L15) | `numReplicas: 1` — see [Scaling](#scaling-and-failure) |
| ├ **supervisor.mjs** | PID 1. Spawns four children; **exits non-zero if any one dies** | [supervisor.mjs:8-14](../../deploy/supervisor.mjs#L8-L14) | Deliberately not supervisord/s6 ([:16-26](../../deploy/supervisor.mjs#L16-L26)) |
| ├ **gateway.mjs** | Zero-dependency reverse proxy on `$PORT`. Rewrites nothing | [gateway.mjs:43](../../deploy/gateway.mjs#L43) | Started only after all three listen ([supervisor.mjs:299](../../deploy/supervisor.mjs#L299)) |
| ├ **userapi** | Express + socket.io. HTTP 2567, gRPC 6001 | [supervisor.mjs:109-113](../../deploy/supervisor.mjs#L109-L113) | |
| ├ **walletapi** | Express, no socket.io. HTTP 3002, gRPC 6002 | [supervisor.mjs:116-120](../../deploy/supervisor.mjs#L116-L120) | |
| └ **spotapi** | Express + socket.io + Binance feeds. HTTP 2568, gRPC 6003 | [supervisor.mjs:123-127](../../deploy/supervisor.mjs#L123-L127) | |
| **MongoDB** | Managed. Three DBs derived from `MONGO_URL` + `DB_PREFIX` | [supervisor.mjs:101-105](../../deploy/supervisor.mjs#L101-L105) | |
| **Redis** | Managed, single instance, shared by all three | [redis.controller.js:6](../../cryptodex-spotapi/controllers/redis.controller.js#L6) | |

The image contains the **three backends only** — frontend, `advanced-charts/` and
`system-smoke-test/` are excluded ([.dockerignore:71-74](../../.dockerignore#L71-L74)). `ops/` is kept so production can be
seeded from inside the private network ([.dockerignore:97-101](../../.dockerignore#L97-L101)).

## Arrows — browser to venue

| From → To | Mechanism | Source |
|---|---|---|
| Trader → cryptodex-web | HTTPS, server-rendered shell then client-side app | [frontend/railway.json:6](../../cryptodex-frontend/railway.json#L6) |
| Trader → gateway | HTTPS REST/JSON. Every `NEXT_PUBLIC_*_API` points at the same gateway origin | [config/index.js:24-26](../../cryptodex-frontend/config/index.js#L24-L26) |
| Trader → gateway | WebSocket (socket.io) → forwarded to spotapi | [routes.mjs:91](../../deploy/routes.mjs#L91) |

> The browser talks to **two** origins: the Next.js service for pages, the gateway for all data.
> They are separate Railway services with separate hostnames.

## Arrows — gateway to services

Prefix routing, longest-match, forwarded byte for byte ([routes.mjs:104-113](../../deploy/routes.mjs#L104-L113)):

| Prefixes | → | Source |
|---|---|---|
| `/api/auth` `/api/user` `/api/language` `/app/*` `/images` `/profile` | userapi | [routes.mjs:66-73](../../deploy/routes.mjs#L66-L73) |
| `/api/wallet` `/api/currency` `/api/common` `/currency` `/deposit` | walletapi | [routes.mjs:76-80](../../deploy/routes.mjs#L76-L80) |
| `/api/spot` `/api/dashboard` `/app/spot` `/app/dashboard` `/socket.io` | spotapi | [routes.mjs:83-91](../../deploy/routes.mjs#L83-L91) |

`/api/health` is owned by the gateway itself and **fans out to all three**, returning 200 only if all
three answer 200 ([gateway.mjs:78-97](../../deploy/gateway.mjs#L78-L97)).

> **`/api/health` now means the same thing on all three services (fixed 2026-08-26).** It used to be
> aliased on spotapi to the **fill canary**, which answers 503 whenever the venue cannot fill.
> `summarise()` returns `unhealthy` only when *every* pair fails ([fillCanary.js:373](../../cryptodex-spotapi/controllers/fillCanary.js#L373))
> — and on a **one-market** venue that is any single depth breaker. Gating deploys on it meant a
> Binance hiccup could fail a deploy and, with `restartPolicyType: "ON_FAILURE"`, restart a live
> container into an outage restarting cannot fix.
>
> spotapi now has a real readiness probe — `lib/serviceHealth.js` + `controllers/health.controller.js`,
> mirroring the other two. Mongo and **Redis** are hard dependencies (503); the wallet DB connection is
> soft (degraded, still 200); **the Binance depth feed is reported but never gates the status code**.
> `railway.json` points at `/api/health` again, and the fan-out is meaningful once more.
> `/api/spot/health` is unchanged and remains the tradability signal to alert on.

## Arrows — the gRPC mesh

All channels are `createInsecure()` on 127.0.0.1 — **plaintext, unauthenticated**, which is the stated
reason for the one-container topology ([Dockerfile:9-23](../../deploy/Dockerfile#L9-L23), [railway-api.env.example:140](../../railway-api.env.example#L140)).

| From → To | Methods actually imported | Source |
|---|---|---|
| **spotapi → walletapi** | `getUserAsset`, `updateUserWallet`, `passbook` | [spot.controller.js:57-60](../../cryptodex-spotapi/controllers/spot.controller.js#L57-L60) *(verified)* |
| **spotapi → walletapi** | `deactivateWallet` (stand-down check, hand-rolled descriptor) | [walletStandDownService.js:93](../../cryptodex-spotapi/grpc/walletStandDownService.js#L93) |
| **spotapi → walletapi** | currency lookups | [currencyService.js:28](../../cryptodex-spotapi/grpc/currencyService.js#L28) *(dials `WALLET_URL`)* |
| **spotapi → userapi** | `saveAdminprofit` (admin), user lookups | [adminService.js:29](../../cryptodex-spotapi/grpc/adminService.js#L29), [userService.js:28](../../cryptodex-spotapi/grpc/userService.js#L28) *(dial `USER_URL`)* |
| **userapi → spotapi** | `cancelOrderForDeactiveAcc` — on account deactivation | [user.controller.js:1487](../../cryptodex-userapi/controllers/user.controller.js#L1487) *(verified)* |
| **userapi → walletapi** | `newAsset`, `getAdminDashboard`, `deactivateWallet`; `currencyId`, `priceConversionGrpc` | [walletService.js:26](../../cryptodex-userapi/grpc/walletService.js#L26), [currencyService.js:35](../../cryptodex-userapi/grpc/currencyService.js#L35) *(verified)* |
| **walletapi → userapi** | `fetchUser`, `bankDetail`, `sendMail` (+ `notification`, unimported) | [userService.js:25](../../cryptodex-walletapi/grpc/userService.js#L25) *(verified)* |

**gRPC reliability is uniform and thin:** 5000 ms deadline, `.catch()` → `{status:false}`, **no retry,
no backoff, no queue** ([spotapi/grpc/walletService.js:34](../../cryptodex-spotapi/grpc/walletService.js#L34), [:52](../../cryptodex-spotapi/grpc/walletService.js#L52)).

**Server surfaces** (what each *serves*): userapi 3 services / 12 methods
([grpc/server.js:53-117](../../cryptodex-userapi/grpc/server.js#L53-L117)); walletapi 3 services / 12+ methods ([grpc/server.js:56-157](../../cryptodex-walletapi/grpc/server.js#L56-L157));
**spotapi exactly one** — `cancelOrderForDeactiveAcc` ([grpc/server.js:36](../../cryptodex-spotapi/grpc/server.js#L36)). spotapi is close to a
pure gRPC *consumer*.

> ⚠️ **Latent mismatch:** walletapi's client calls `newNotification`; userapi registers `notification`.
> gRPC dispatches on the method path, so this would return `12 UNIMPLEMENTED`. Latent only because
> walletapi's `notification` export has no importer ([userService.js:83](../../cryptodex-walletapi/grpc/userService.js#L83) vs
> [userapi/grpc/server.js:69](../../cryptodex-userapi/grpc/server.js#L69)).

## Arrows — datastores

| From → To | Mechanism | Source |
|---|---|---|
| each service → MongoDB | Mongoose 6; **the HTTP port opens only after Mongo connects** | [userapi/server.js:68](../../cryptodex-userapi/server.js#L68) |
| **spotapi → wallet DB (2nd connection)** | `mongoose.createConnection` at module scope, `WALLET_DB_URL` | [spotapi/models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8) *(verified)* |
| each service → Redis | `redis@3.1.2`, keys prefixed `REDIS_PREFIX` | [redis.controller.js:6](../../cryptodex-spotapi/controllers/redis.controller.js#L6) |

**spotapi reads walletapi's database directly.** That is a cross-service data access which bypasses
the gRPC boundary — called out again in [05-data](05-data.md). Its fallback is
`mongodb://localhost:27017/cryptodex_wallet`, which on Railway resolves to nothing
([railway-api.env.example:65](../../railway-api.env.example#L65)).

---

## Scaling and failure

**`numReplicas: 1` on both services** ([railway.json:9](../../railway.json#L9), [frontend/railway.json:11](../../cryptodex-frontend/railway.json#L11)) — and the
backend genuinely cannot be scaled horizontally as written:

- **The matcher is a bare 2-second cron per process** ([spot.controller.js:4945](../../cryptodex-spotapi/controllers/spot.controller.js#L4361)). Its only
  mutual exclusion is an in-process `Set` of per-pair locks and a module-level flag
  ([:4968](../../cryptodex-spotapi/controllers/spot.controller.js#L4384)). Two spotapi processes would run two matchers over one Redis book with no
  distributed lock.
- **The paper ladder is rebuilt wholesale every tick** by whichever process owns it
  ([paperBook.controller.js:509](../../cryptodex-spotapi/controllers/paperBook.controller.js#L509)); two writers would fight.
- **Binance streams are opened per process** ([binanceWebSocket.js:386](../../cryptodex-spotapi/lib/binanceWebSocket.js#L386)) — N replicas means
  N upstream connections.
- **socket.io has no adapter configured**, so a broadcast reaches only the clients attached to that
  process ([spotapi/config/socketIO.js:126](../../cryptodex-spotapi/config/socketIO.js#L126)).

**Failure is all-or-nothing by design.** Any child dying takes the container down, deliberately: a
container answering on :8080 while spotapi is dead "would accept logins, show balances, and silently
never fill an order" ([supervisor.mjs:8-14](../../deploy/supervisor.mjs#L8-L14)). Railway then restarts (ON_FAILURE, max 10).

**Boot is concurrent, not staged.** The three services start together because each dials the others'
gRPC lazily and `dbConnection` retries Mongo every second; the gateway waits for all three so
Railway's healthcheck cannot see a half-built venue ([supervisor.mjs:32-38](../../deploy/supervisor.mjs#L32-L38)). The 280s
`waitForPort` ceiling, the Dockerfile `--start-period`, and `healthcheckTimeout: 300` are kept in step
on purpose ([supervisor.mjs:213-224](../../deploy/supervisor.mjs#L213-L224)).

---

## The local topology is different

`start-all.sh` boots MongoDB → Redis → clear ports → 3 backends → wait → frontend → status
([start-all.sh:118-278](../../start-all.sh#L118-L278)).

**There is no gateway and no supervisor locally.** Neither script references `deploy/`; the browser on
:3000 talks straight to :2567 / :2568 / :3002 ([start-all.sh:284-287](../../start-all.sh#L284-L287)).

| | Production | Local |
|---|---|---|
| Front door | gateway on one port | none — three origins |
| Process control | supervisor, fail-fast | `nohup` + `lsof` port kill |
| Datastores | managed | brew-managed `mongod` / `redis-server` |
| Env file | none (`start:prod` passes no path) | per-service `local.env` |
| Logs | tagged stdout | `/tmp/*.log` via `ops/logcap.pl` |

Consequences worth knowing: **CORS is `origin: '*'` in all three services**, which is what makes the
three-origin local setup work at all ([userapi/server.js:26](../../cryptodex-userapi/server.js#L26)). And the single-origin
assumption that lets socket.io work in production is a *container-only* property
([routes.mjs:21-36](../../deploy/routes.mjs#L21-L36)).

Redis persists to the repo root in local dev, so **the tracked `dump.rdb` is the live dataset**
([start-all.sh:185-186](../../start-all.sh#L185-L186)). `stop-all.sh` deliberately leaves both datastores running
([stop-all.sh:72](../../stop-all.sh#L72)).

---

## Unverified

1. Actual Railway service names, regions, plan and whether Mongo/Redis are Railway-managed or external.
   The repo shows only the variable *shapes* ([railway-api.env.example:74](../../railway-api.env.example#L74)).
2. Whether `WALLET_DB_URL` is set in the deployed environment. If unset, spotapi's second connection
   silently targets `localhost` and the currency lookups it backs would fail
   ([spotapi/models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8)).
3. Whether the two Railway services can reach each other over a private network or only the public
   internet — not determinable from the repo.
4. Whether `numReplicas` has been raised in the Railway dashboard since this `railway.json` was written.

## Open questions

1. **`/app/*` alias mounts** double the public surface of userapi and spotapi and the gateway forwards
   them ([routes.mjs:69-71](../../deploy/routes.mjs#L69-L71)). No frontend code calls them. Retire, or keep for a mobile client?
2. **spotapi's second Mongo connection into the wallet database** ([models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8))
   bypasses the gRPC boundary that otherwise defines service ownership. Deliberate performance choice,
   or leftover?
3. **No socket.io adapter** is configured, so the design is single-process by construction. Is
   horizontal scale a goal, or is one replica the permanent answer?
4. **The gateway is a single point of failure with no timeout on upstream requests** other than
   Node's relaxed defaults for long-polling ([gateway.mjs:23-28](../../deploy/gateway.mjs#L23-L28)). Intentional for socket.io —
   but it applies to every route.
