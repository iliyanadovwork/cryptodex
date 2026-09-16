# Phase 0 — Inventory

**System:** Cryptodex — a spot-only **paper-trading** crypto exchange (virtual money, live market data).
**Repo root:** `.` · branch `paper-trading`

## How to read this file

Everything below was read out of the tree. Each row cites `file:line` — that citation *is* the
reading list. Nothing here is inferred from folder names.

**Source-of-truth order used:** deploy/infra config → package manifests → env var usage → code.
Prose docs (`README.md`, `SYSTEM_GUIDE.md`, `DEPLOYMENT.md`) were read as *claims to be checked*,
not as evidence — and two of their claims turned out to be **stale** (see [Doc claims that the code contradicts](#doc-claims-that-the-code-contradicts)).

Anything not confirmed against a real line is in [Unverified](#unverified) or [Open questions](#open-questions), never in the tables.

---

## 1. Shape of the repository

Four services, each an independent npm package with its **own `node_modules`**. This is *not* an
npm/yarn workspace: the root manifest declares scripts and no dependencies, and says so.

| Path | What it is | Source |
|---|---|---|
| `cryptodex-userapi/` | Auth / identity / profile service | [package.json:1](../../cryptodex-userapi/package.json#L1) |
| `cryptodex-walletapi/` | Balances, currencies, demo faucet backing | [package.json:1](../../cryptodex-walletapi/package.json#L1) |
| `cryptodex-spotapi/` | Trading engine + market data + socket server | [package.json:1](../../cryptodex-spotapi/package.json#L1) |
| `cryptodex-frontend/` | Next.js 13 web client | [package.json:2](../../cryptodex-frontend/package.json#L2) |
| `deploy/` | Dockerfile, supervisor, gateway, routing table | [deploy/Dockerfile:7](../../deploy/Dockerfile#L7) |
| `ops/` | Seed/reset tool, log rotation, static sweep | [ops/reset-and-seed.mjs:92](../../ops/reset-and-seed.mjs#L92) |
| `system-smoke-test/` | End-to-end smoke runner + service prober | [system-smoke-test/package.json:5](../../system-smoke-test/package.json#L5) |
| `advanced-charts/` | **git submodule** (gitlink `160000`, commit `cde69b49`), a CRA app; **no `.gitmodules`** | `git ls-tree HEAD advanced-charts` |

> The three backend directory names are structural only. Inside the Docker image they are renamed
> `userapi` / `walletapi` / `spotapi` ([Dockerfile:82-84](../../deploy/Dockerfile#L82-L84)), with symlinks back to the long names so
> `ops/reset-and-seed.mjs` keeps resolving ([Dockerfile:103-105](../../deploy/Dockerfile#L103-L105)).

**Root manifest is scripts-only** — `seed`, `start`, `stop`, `smoke`; no dependencies, node `>=18.12`
([package.json:6-14](../../package.json#L6-L14)).

`advanced-charts/` is **not** wired into the running system. The TradingView library the app actually
uses is vendored *inside* the frontend at `public/static/charting_library/` and
`components/spot/ChartLib/` ([Chart.js:73](../../cryptodex-frontend/components/spot/Chart.js#L73)). The submodule is a build-time/reference copy.

---

## 2. Languages, frameworks, runtimes

### Backends (all three)

All three are **ESM** (`"type": "module"`) Node services with near-identical stacks:

| Concern | Choice | Source |
|---|---|---|
| HTTP | Express 4.18 | [userapi/package.json:23](../../cryptodex-userapi/package.json#L23) |
| DB driver | Mongoose 6.7 | [userapi/package.json:29](../../cryptodex-userapi/package.json#L29) |
| Cache/live state | `redis` **3.1.2** (callback-era client) | [spotapi/package.json:29](../../cryptodex-spotapi/package.json#L29) |
| Inter-service RPC | `@grpc/grpc-js` + `@grpc/proto-loader` | [userapi/package.json:12](../../cryptodex-userapi/package.json#L12) |
| Auth | `passport-jwt` + `jsonwebtoken` | [userapi/package.json:26](../../cryptodex-userapi/package.json#L26) |
| Scheduling | `node-cron` | [spotapi/package.json:27](../../cryptodex-spotapi/package.json#L27) |
| Realtime | `socket.io` 4 (userapi + spotapi only) | [spotapi/package.json:31](../../cryptodex-spotapi/package.json#L31) |
| Tests | Jest 29/30 + supertest + `mongodb-memory-server` | [spotapi/package.json:40](../../cryptodex-spotapi/package.json#L40) |

### Frontend

Next.js **13.4.13, pages router** (there is no `app/` directory), React 18.2, TypeScript 5.1,
Redux Toolkit + redux-persist, axios, socket.io-client ([package.json:53](../../cryptodex-frontend/package.json#L53)).

Two notable build settings:

- **TypeScript build errors are ignored** — `typescript.ignoreBuildErrors: true`, so `next build`
  cannot fail on a type error ([next.config.js:45](../../cryptodex-frontend/next.config.js#L45)).
- `reactStrictMode: false`, `swcMinify: false` ([next.config.js:21](../../cryptodex-frontend/next.config.js#L21)).

**Rendering:** entirely client-side after the static shell. There is no `getServerSideProps` /
`getStaticProps` / `getInitialProps` anywhere in `pages/`; `handleAuthSSR` exists and is imported but
never invoked ([utils/auth.js:9](../../cryptodex-frontend/utils/auth.js#L9)).

---

## 3. Deployable units

There are **two distinct topologies** — the container one and the local one — and they differ in a
way that matters: *the gateway exists only in the container.*

### 3a. Production (Railway) — the source of truth

**Service 1 — `cryptodex-api`: one container, five processes.**

Root [railway.json](../../railway.json) builds `deploy/Dockerfile` and runs `node deploy/supervisor.mjs`;
healthcheck `/api/health`, timeout 300s, restart ON_FAILURE ×10, `numReplicas: 1` ([railway.json:3-11](../../railway.json#L3-L11)).

| Process | Role | Port | Source |
|---|---|---|---|
| `deploy/supervisor.mjs` | PID 1; spawns the four below, dies if any dies | — | [supervisor.mjs:8](../../deploy/supervisor.mjs#L8) |
| userapi | `node server.js` | 2567 (gRPC 6001) | [supervisor.mjs:109-113](../../deploy/supervisor.mjs#L109-L113) |
| walletapi | `node server.js` | 3002 (gRPC 6002) | [supervisor.mjs:116-120](../../deploy/supervisor.mjs#L116-L120) |
| spotapi | `node server.js` | 2568 (gRPC 6003) | [supervisor.mjs:123-127](../../deploy/supervisor.mjs#L123-L127) |
| `deploy/gateway.mjs` | Single public port, reverse proxy | `$PORT` (8080) | [gateway.mjs:43](../../deploy/gateway.mjs#L43) |

The Dockerfile is a **two-stage build** (`node:20-bookworm-slim`), because bcrypt (userapi) and the
web3/keccak stack (walletapi) compile native code ([Dockerfile:25-28](../../deploy/Dockerfile#L25-L28)). It uses `npm install`, not
`npm ci`, because **no lockfiles are committed** for the backends ([Dockerfile:30-34](../../deploy/Dockerfile#L30-L34)).

Three design decisions are stated in the source and worth carrying into the diagrams:

1. **Why one container, not three services.** All three dial each other over **plaintext gRPC on
   127.0.0.1**; splitting them would put unauthenticated gRPC on a network ([Dockerfile:9-23](../../deploy/Dockerfile#L9-L23)).
2. **Fail-fast supervision.** If any child dies, the container dies — a container answering on :8080
   while spotapi is dead would accept logins and silently never fill an order ([supervisor.mjs:8-14](../../deploy/supervisor.mjs#L8-L14)).
   Deliberately *not* supervisord (which restarts and keeps the container up) ([supervisor.mjs:16-26](../../deploy/supervisor.mjs#L16-L26)).
3. **The gateway rewrites nothing.** The three services were already mounted on disjoint path
   spaces, so the URL is forwarded byte for byte ([routes.mjs:9-19](../../deploy/routes.mjs#L9-L19)). This is what keeps
   socket.io working: `io(config.SPOT_API)` reads a **namespace**, not a path, so a `/spot/…` prefix
   would break the handshake with "Invalid namespace" ([routes.mjs:21-36](../../deploy/routes.mjs#L21-L36)).

**Service 2 — `cryptodex-web`:** separate Railway service, NIXPACKS, `npx next start -p ${PORT:-3000}`,
healthcheck `/` ([frontend/railway.json:4](../../cryptodex-frontend/railway.json#L4)).

**Services 3 & 4:** managed MongoDB and Redis (addressed by env var; see §6).

The image is the **three backends only** — the frontend, `advanced-charts/` and `system-smoke-test/`
are excluded ([.dockerignore:71-74](../../.dockerignore#L71-L74)). `ops/` is deliberately *kept* so production can be seeded from
inside the private network ([.dockerignore:97-101](../../.dockerignore#L97-L101)).

### 3b. The gateway routing table

Longest-prefix wins; a prefix matches only at a `/` or `?` boundary ([routes.mjs:104-113](../../deploy/routes.mjs#L104-L113)).

| Prefixes | → service |
|---|---|
| `/api/auth` `/api/user` `/api/language` `/app/auth` `/app/user` `/app/language` `/images` `/profile` | userapi |
| `/api/wallet` `/api/currency` `/api/common` `/currency` `/deposit` | walletapi |
| `/api/spot` `/api/dashboard` `/app/spot` `/app/dashboard` `/socket.io` | spotapi |

Source: [routes.mjs:64-92](../../deploy/routes.mjs#L64-L92). Upstream ports from `USERAPI_PORT` / `WALLETAPI_PORT` / `SPOTAPI_PORT`
([routes.mjs:95-99](../../deploy/routes.mjs#L95-L99)).

Two things the gateway does that a naive proxy would not:

- **WebSocket upgrade** is tunnelled at the TCP level — a raw socket to spotapi, request line and
  headers replayed verbatim, then the two sockets piped ([gateway.mjs:17-22](../../deploy/gateway.mjs#L17-L22)).
- **`/api/health` fans out.** All three services answer it, which no prefix table can express, so the
  gateway owns the path and returns 200 only if **all three** answer 200 ([gateway.mjs:78-97](../../deploy/gateway.mjs#L78-L97)).

### 3c. Local development — a different topology

`start-all.sh` is a 7-stage boot: MongoDB → Redis → clear ports → 3 backends → wait → frontend →
status ([start-all.sh:118-278](../../start-all.sh#L118-L278)). It starts its own `mongod` and `redis-server` via brew with fallbacks
([start-all.sh:124-166](../../start-all.sh#L124-L166)), polls readiness rather than sleeping ([start-all.sh:225](../../start-all.sh#L225)), and pipes every service
through `ops/logcap.pl` for rotation ([start-all.sh:101-112](../../start-all.sh#L101-L112)).

**There is no gateway and no supervisor locally.** Neither script mentions `deploy/`; the browser on
:3000 talks straight to :2567 / :2568 / :3002 ([start-all.sh:284-287](../../start-all.sh#L284-L287)). The single-origin front door is a
container-only construct — a genuine prod/dev divergence.

The only data-level assertion at the end of boot is `redis-cli hlen cryptodex_spotPairdata >= 1`
("empty — no pair can trade") ([start-all.sh:270-271](../../start-all.sh#L270-L271)).

`stop-all.sh` kills the four listeners and sweeps by directory name, and **deliberately leaves Mongo
and Redis running** ([stop-all.sh:72](../../stop-all.sh#L72)).

---

## 4. Entry points

### 4a. HTTP entry points and boot order

All three backends follow the same shape, and in all three **the HTTP port opens only after Mongo
connects** — which is why the supervisor's `waitForPort` ceiling is 280s, not 120s ([supervisor.mjs:213-224](../../deploy/supervisor.mjs#L213-L224)).

| Service | Entry | Listen gated on Mongo | gRPC start | Socket.io |
|---|---|---|---|---|
| userapi | `server.js` | [server.js:68](../../cryptodex-userapi/server.js#L68) | dynamic import inside listen cb, [:70](../../cryptodex-userapi/server.js#L70) | yes, [:63](../../cryptodex-userapi/server.js#L63) |
| walletapi | `server.js` | [server.js:39-43](../../cryptodex-walletapi/server.js#L39-L43) mounts | see §5 | no |
| spotapi | `server.js` | [server.js:112](../../cryptodex-spotapi/server.js#L112) boot reload | see §5 | yes |

**Route mounting is asymmetric across the three services** — this is a real topology fact, not a tidy
one. userapi and spotapi mount **every router twice**, once under `/api` and again under `/app`
(a mobile-era alias); walletapi mounts `/api` only:

| Service | Mounts | Source |
|---|---|---|
| userapi | `/api/health` `/api/auth` `/api/language` `/api/user` **+** `/app/language` `/app/user` `/app/auth` | [server.js:48-57](../../cryptodex-userapi/server.js#L48-L57) |
| walletapi | `/api/health` `/api/currency` `/api/common` `/api/wallet` — **no `/app/*`** | [server.js:39-43](../../cryptodex-walletapi/server.js#L39-L43) |
| spotapi | `/api/spot` `/api/dashboard` **+** `/app/spot` `/app/dashboard`; `/api/health` mounted directly | [server.js:81-87](../../cryptodex-spotapi/server.js#L81-L87) |

The gateway forwards both prefix families ([routes.mjs:69-71](../../deploy/routes.mjs#L69-L71), [:85-86](../../deploy/routes.mjs#L85-L86)), so the doubled surface is
publicly reachable.

**Health endpoints.** userapi and walletapi mount `/api/health` as a router; spotapi mounts it
inline with `app.get` ([spotapi/server.js:81](../../cryptodex-spotapi/server.js#L81)) *and* exposes a deeper `/api/spot/health` fill canary
([routes/spot.route.js:61](../../cryptodex-spotapi/routes/spot.route.js#L61)).

**Global middleware — userapi, in registration order** ([server.js:25-43](../../cryptodex-userapi/server.js#L25-L43)):
`morgan("dev")` → `cors({origin:'*'})` → **`responseGuard(60000)`** (forces a 500 if no handler ever
replies) → `express.json({limit:'10mb'})` → `express.urlencoded` → `passport.initialize()` →
`express.static(public/)`. **No 404 handler and no error middleware** are registered anywhere in its
77 lines ([server.js:77](../../cryptodex-userapi/server.js#L77)). CORS is `origin: '*'` in all three services.

### 4b. Scheduled jobs

**spotapi registers thirteen cron schedules in `config/cron.js`** — plus the single most important
one, which is *not* in that file:

| Schedule | Job | Source |
|---|---|---|
| `*/2 * * * * *` | **The matcher** — `matchingcall(pairId)` per active pair | [spot.controller.js:4945](../../cryptodex-spotapi/controllers/spot.controller.js#L4361) |
| `*/30 * * * * *` | Binance 24h ticker refresh → `marketPrice` broadcast | [config/cron.js:105](../../cryptodex-spotapi/config/cron.js#L105) |
| `0 * * * * *` | Binance klines refresh (7 intervals × pair) | [config/cron.js:126](../../cryptodex-spotapi/config/cron.js#L126) |
| ×9 | `redisToDB` chart write-back, one per interval (1m…1M) | [config/cron.js:46](../../cryptodex-spotapi/config/cron.js#L46),[50](../../cryptodex-spotapi/config/cron.js#L50),[54](../../cryptodex-spotapi/config/cron.js#L54),[58](../../cryptodex-spotapi/config/cron.js#L58),[62](../../cryptodex-spotapi/config/cron.js#L62),[66](../../cryptodex-spotapi/config/cron.js#L66),[70](../../cryptodex-spotapi/config/cron.js#L70),[74](../../cryptodex-spotapi/config/cron.js#L74),[78](../../cryptodex-spotapi/config/cron.js#L78) |
| weekly | `clearSpotRedis` | [config/cron.js:96](../../cryptodex-spotapi/config/cron.js#L96) |
| `*/5 * * * * *` | `binOrderTask` → `checkOrder()`; **idle only because no order can be `liquidityType:"binance"`** | [binance.controller.js:977](../../cryptodex-spotapi/controllers/binance.controller.js#L814) |

> **A cron inventory built from `config/cron.js` alone misses the matcher.** It is declared at module
> scope in the controller.

Other services:

| Service | Job | Source |
|---|---|---|
| walletapi | `*/5 * * * *` price conversion (Binance + CryptoCompare), gated on `RUN_CRON=="true"` (which is `"true"` in every branch) | [config/cron.js:12](../../cryptodex-walletapi/config/cron.js#L12), [:40-41](../../cryptodex-walletapi/config/cron.js#L40-L41) |
| userapi | `cleanupUnactivatedAccounts.start()` after listen | [server.js:74](../../cryptodex-userapi/server.js#L74) |

### 4c. CLI / one-off entry points

Beyond the services themselves:

| Entry | What | Source |
|---|---|---|
| `npm run seed` → `ops/reset-and-seed.mjs` | Seed / `--verify` / `--reset --confirm <prefix>` | [package.json:10](../../package.json#L10), [reset-and-seed.mjs:118-127](../../ops/reset-and-seed.mjs#L118-L127) |
| `npm run smoke` | Full register→login→trade journey | [system-smoke-test/smoke-test.js:208](../../system-smoke-test/smoke-test.js#L208) |
| `system-smoke-test/check-services.js` | Health/liveness prober | [check-services.js:159](../../system-smoke-test/check-services.js#L159) |
| `ops/response-sweep.cjs` | Static sweep for handlers that never reply | [response-sweep.cjs:2](../../ops/response-sweep.cjs#L2) |
| walletapi root scripts (×12) | `addCurrency`, `backfillPaperAssets`, `createSpotPairs`, … several mutate collections | [backfillPaperAssets.js:1](../../cryptodex-walletapi/backfillPaperAssets.js#L1) |
| spotapi `scripts/` + `loadPairsToRedis.js` | one-off maintenance | — |
| userapi `scripts/sync-templates.js` | pushes email templates to Resend | [sync-templates.js:21](../../cryptodex-userapi/scripts/sync-templates.js#L21) |

⚠️ `ops/README.md` flags seed scripts that **must not** be run: `userapi/scripts/seed-pairs.js`
`deleteMany({})`s currencies and pairs, destroying every `walletbalance_spot` key because currency
`_id`s change ([ops/README.md:221](../../ops/README.md#L221)).

---

## 5. Cross-process wiring

### 5a. gRPC — who serves what

All channels are `createInsecure()` on 127.0.0.1 ([railway-api.env.example:140](../../railway-api.env.example#L140)).

| Service | Serves | Source |
|---|---|---|
| userapi | `siteSetting`; `user` (7 methods incl. `botUser`, `notification`); `admin` (2) | [grpc/server.js:53-117](../../cryptodex-userapi/grpc/server.js#L53-L117) |
| walletapi | `wallet` (9), `currency` (3), plus a hardcoded demo `NewsService` | [grpc/server.js:56-157](../../cryptodex-walletapi/grpc/server.js#L56-L157) |
| spotapi | **exactly one method** — `cancelOrderForDeactiveAcc` | [grpc/server.js:36](../../cryptodex-spotapi/grpc/server.js#L36) |

**spotapi is essentially a pure gRPC *consumer*.** Its client to walletapi uses a 5000 ms deadline,
`.catch()`es into `{status:false}`, and has **no retry and no backoff** ([grpc/walletService.js:34](../../cryptodex-spotapi/grpc/walletService.js#L34), [:52](../../cryptodex-spotapi/grpc/walletService.js#L52)).

**One latent name mismatch:** walletapi's client calls `newNotification`; userapi registers the
handler as `notification`. gRPC dispatches on the method path, so this would return `12 UNIMPLEMENTED`
— latent only because walletapi's `notification` export currently has no importer
([walletapi/grpc/userService.js:83](../../cryptodex-walletapi/grpc/userService.js#L83) vs [userapi/grpc/server.js:69](../../cryptodex-userapi/grpc/server.js#L69)).

### 5b. Socket.io — two servers, one client

**spotapi's socket server is the one the browser uses.** The frontend opens exactly one socket, to
`config.SPOT_API` — *not* `config.SOCKET_URL`, which is a dead key ([socketConnectivity.js:36](../../cryptodex-frontend/config/socketConnectivity.js#L36)).

A crucial distinction for the diagrams:

- **`socketEmitAll` is `socketIO.emit(type, data)` — a broadcast to every connected socket, ignoring
  rooms entirely** ([spotapi/config/socketIO.js:126](../../cryptodex-spotapi/config/socketIO.js#L126)) *(verified directly)*.
  So the client's `subscribe('spot')` / per-pair ticker-room joins have **no bearing** on delivery of
  `marketPrice`, `orderBook` or the Binance-sourced `recentTrade`.
- `socketEmitOne` emits into the room named by the userId — the genuinely private path
  ([socketIO.js:134](../../cryptodex-spotapi/config/socketIO.js#L134)). Private rooms are joined only via `CREATEROOM`, which re-validates the JWT.

**userapi runs a second socket.io server** with no `subscribe` handler, emitting `unreadnotification`,
`passwordVerify`, `registerVerify` — and **no client in the repo ever connects to it**
([userapi/config/socketIO.js:10](../../cryptodex-userapi/config/socketIO.js#L10)).

**Events emitted with no listener:** `filledOrder`, `depthChart`, `chartUpdate`, `ROOMJOINED`
([spot.controller.js:3959](../../cryptodex-spotapi/controllers/spot.controller.js#L3551), [:7274](../../cryptodex-spotapi/controllers/spot.controller.js#L6690), [binance.controller.js:1541](../../cryptodex-spotapi/controllers/binance.controller.js#L1378), [socketAuth.js:241](../../cryptodex-spotapi/config/socketAuth.js#L241)).

**Dead listeners:** all four `socket.on("reconnect", …)` registrations are inert — `reconnect` is a
socket.io-client v4 **Manager** event, not a Socket event. Re-joining survives only because
`socketConnectivity.js:124` also handles `connect`.

---

## 6. Configuration and environment loading

### The mechanism

All three backends begin `config/index.js` with `import "dotenv/config"` — dotenv's **zero-config**
loader, which reads `.env` **from the process working directory** at import time
([userapi:1](../../cryptodex-userapi/config/index.js#L1), [walletapi:1](../../cryptodex-walletapi/config/index.js#L1), [spotapi:1](../../cryptodex-spotapi/config/index.js#L1)) *(verified directly)*.

Which file actually wins is decided **by the npm script**, not by the config module:

| Script | Env file applied |
|---|---|
| `npm start` | `dotenv_config_path=local.env` |
| `npm run dev` / `prod` | `dev.env` / `prod.env` |
| **`npm run start:prod`** (what the container runs) | **none — pure process environment** |

Each `config/index.js` has **three `NODE_ENV` branches** (production / development / else)
([userapi/config/index.js:46](../../cryptodex-userapi/config/index.js#L46), [:90](../../cryptodex-userapi/config/index.js#L90), [:181](../../cryptodex-userapi/config/index.js#L181)).

### The three variables that cannot be shared

Railway gives one environment to a service, but three processes need different values. The supervisor
**derives** them ([supervisor.mjs:54-76](../../deploy/supervisor.mjs#L54-L76)):

- `MONGO_URL` (or `MONGO_PUBLIC_URL`/`DATABASE_URL`) + `DB_PREFIX` → `<prefix>_user` / `_wallet` / `_spot`
  ([supervisor.mjs:101-105](../../deploy/supervisor.mjs#L101-L105)); an explicit `<NAME>_DATABASE_URI` wins.
- `GRPC_{USER,WALLET,SPOT}_URL` → each child's own `GRPC_URL` ([supervisor.mjs:113](../../deploy/supervisor.mjs#L113),[120](../../deploy/supervisor.mjs#L120),[127](../../deploy/supervisor.mjs#L127)).
- `PORT` per child ([supervisor.mjs:268-275](../../deploy/supervisor.mjs#L268-L275)).

The declared `USERAPI_GRPC_URL` / `WALLETAPI_GRPC_URL` / `SPOTAPI_GRPC_URL` names are **read by no
source file** — setting them changes nothing ([railway-api.env.example:150](../../railway-api.env.example#L150)).

### Config landmines worth knowing

| Item | Detail | Source |
|---|---|---|
| `WALLET_DB_URL` | spotapi opens a **second mongoose connection into the wallet DB** at module scope; fallback is `localhost`, which resolves to nothing on Railway | [spotapi/models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8) |
| `SECRET_KEY` | All three fall back to the **same 128-hex literal** in the repo. Setting it on some services and not others is the failure mode | [userapi/config/index.js:50](../../cryptodex-userapi/config/index.js#L50) |
| `cryptoSecretKey` | **Not an env var at all** — a literal constant; the frontend's `NEXT_PUBLIC_CRYPTO_SECRET_KEY` must equal it or every order is rejected | [spotapi/config/index.js:60](../../cryptodex-spotapi/config/index.js#L60) |
| `REDIS_PREFIX` | Must be byte-identical to the seed's `--redis-prefix`; a mismatch is **silent** | [railway-api.env.example:81](../../railway-api.env.example#L81) |
| **`TEST_MODE`** | A **double auth bypass**: skips OTP validation entirely, and enables `POST /api/auth/test-verify`, which marks any address verified. Has a hard production veto | [auth.controller.js:933](../../cryptodex-userapi/controllers/auth.controller.js#L714), [:1729](../../cryptodex-userapi/controllers/auth.controller.js#L1510) |

### The frontend's two-env-file trap

`config/index.js` reads **single-underscore** `NEXT_PUBLIC_*`, while the committed `local.env` /
`dev.env` / `prod.env` spell everything with a **double** underscore (`NEXT_PUBLIC__USER_API`) — so
**nothing in those files ever reaches the app** ([config/index.js:27](../../cryptodex-frontend/config/index.js#L27)). The file that actually configures
local dev is the gitignored `.env.local`. `local.env` exists only because `npm run dev` is
`env-cmd -f local.env next dev` and env-cmd fails if it is absent ([.env.local.example:5](../../cryptodex-frontend/.env.local.example#L5)).

Dead frontend config keys (read into the object, consumed by nothing): `SOCKET_URL`, `FRONT_URL`,
`ADMIN_URL`, `getGeoInfo`, `ONRAMP_APP_ID` ([config/index.js:19-22](../../cryptodex-frontend/config/index.js#L19-L22), [:46](../../cryptodex-frontend/config/index.js#L46)).

> `NEXT_PUBLIC_SECRET_KEY` (the backends' JWT signing key) was **removed** from frontend config —
> `NEXT_PUBLIC_*` is inlined into the browser bundle, so the key that signs every session was
> readable and forgeable by any visitor ([config/index.js:2](../../cryptodex-frontend/config/index.js#L2)).

---

## 7. Data stores

| Store | Owner | Notes |
|---|---|---|
| MongoDB `<prefix>_user` | userapi | |
| MongoDB `<prefix>_wallet` | walletapi | also read by spotapi via a second connection |
| MongoDB `<prefix>_spot` | spotapi | |
| Redis (single instance, `REDIS_PREFIX`) | **shared by all three** | client is `redis@3.1.2` |

**Redis is the authoritative balance store**, not Mongo. Stated explicitly in the ledger module:
*"Redis is authoritative for paper trading, so a gRPC ledger sync failure is logged loudly but never
fails the operation"* ([paperLedger.js:22](../../cryptodex-spotapi/controllers/paperLedger.js#L22)) *(verified directly)*.

Key Redis structures on the trading path:

| Key | Holds | Source |
|---|---|---|
| `walletbalance_spot` field `<userId>_<currencyId>` | **the live balance** | [paperLedger.js:22](../../cryptodex-spotapi/controllers/paperLedger.js#L22) |
| `walletbalance_spot_inOrder` | escrow / reserved-unspent | [spot.controller.js:407](../../cryptodex-spotapi/controllers/spot.controller.js#L407) |
| `buyOpenOrders_<pairId>` / `sellOpenOrders_<pairId>` | the live book the matcher reads | [spot.controller.js:1948](../../cryptodex-spotapi/controllers/spot.controller.js#L1948) |
| `spotPairdata` | pair cache, preferred over Mongo | [reset-and-seed.mjs:598](../../ops/reset-and-seed.mjs#L598) |
| `admin_liquidity` / `liquidation` | **the ladder-owner SPOF** (see below) | [paperBook.controller.js:488](../../cryptodex-spotapi/controllers/paperBook.controller.js#L488) |
| `depth_meta_binance_*`, `buy_depth_binance_*`, `sell_depth_binance_*` | Binance depth mirror | [lib/depthSource.js:49](../../cryptodex-spotapi/lib/depthSource.js#L49) |

**The two stores diverge by design.** The fill path never calls `updateUserAsset`, so
`wallet.assets[].spotBal` in Mongo is *not* updated by a trade; only faucet/deposit paths sync it
([paperLedger.js:169](../../cryptodex-spotapi/controllers/paperLedger.js#L169)). walletapi's wallet view `HSETNX`-seeds from Mongo and then reports **Redis**
([wallet.controller.js:355](../../cryptodex-walletapi/controllers/wallet.controller.js#L355)).

**There is no transaction boundary anywhere in spotapi** — no `startSession`, no `withTransaction`
*(verified directly by grep over `controllers lib models config routes server.js`)*. The only
atomicity is per-command Redis Lua: `RESERVE_LUA`, `HGETDEL_LUA`, `CLAIM_ONCE_LUA`, `BEGIN_FLIGHT_LUA`
([redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179)) *(verified directly)*.

---

## 8. What the venue actually is

Worth stating plainly, because it shrinks every subsequent diagram:

- **Two currencies:** BTC (crypto, 8dp) and USD (fiat, 2dp) ([venue-data.mjs:65](../../ops/seed/venue-data.mjs#L65)).
- **One market:** BTC/USD, `tikerRoot` `BTCUSD`, `botstatus: 'binance'` ([venue-data.mjs:123](../../ops/seed/venue-data.mjs#L123)).
- Mapped upstream to Binance **`BTCUSDT`** (because `secondCurrencySymbol === 'USD'`)
  ([lib/binanceWebSocket.js:386](../../cryptodex-spotapi/lib/binanceWebSocket.js#L386)).
- **Fees are zero by construction** — `feeRateFor()` returns a hard `0`; the arithmetic is
  deliberately left standing so no line that moves money had to be edited ([lib/liquidityRole.js:231](../../cryptodex-spotapi/lib/liquidityRole.js#L231))
  *(verified directly)*.
- **Two order types only:** `limit`, `market`. `stop_limit` / `stop_market` / `trailing_stop` are
  answered 400 ([spotTrade.validation.js:40](../../cryptodex-spotapi/validation/spotTrade.validation.js#L40), [:67](../../cryptodex-spotapi/validation/spotTrade.validation.js#L67)). The machinery behind them is **deleted**, not
  dormant: the three placement handlers, both triggers, the binance-side stop handlers, their three
  validators, and the order fields only they used (`stopPrice`, `trailingPrice`, `distance`,
  `conditionalType`, order-level `marketPrice`) are gone. The refusal list stays as the API contract.
- **New accounts get 1,000 USD** (`DEMO_SEED_COINS = ["USD"]`) ([createAsset.js:20](../../cryptodex-walletapi/controllers/createAsset.js#L20)); the faucet
  grants the same ([faucet.controller.js:74](../../cryptodex-spotapi/controllers/faucet.controller.js#L74)).
- **Withdrawal returns 410 Gone** before reading or writing anything ([withdrawal.controller.js:130](../../cryptodex-spotapi/controllers/withdrawal.controller.js#L130)).

**The single point of failure:** if Redis `admin_liquidity/liquidation` is absent, `syncPaperBook`
logs "orders cannot fill", drops the ladder, and **every user order rests forever**
([paperBook.controller.js:490](../../cryptodex-spotapi/controllers/paperBook.controller.js#L490)). `ops/reset-and-seed.mjs` is the **only** thing in the tree that writes
that field — the two in-product writers are both unreachable ([ops/README.md:135](../../ops/README.md#L135),
[user.controller.js:1589](../../cryptodex-userapi/controllers/user.controller.js#L1589)).

---

## 9. External systems (summary — Phase 1 will diagram these)

**Live:**

| System | Mechanism | Used by | Source |
|---|---|---|---|
| Binance public WS `@depth@100ms` | WebSocket (`ws`) | spotapi — **the feed the whole book mirrors** | [binanceWebSocket.js:533](../../cryptodex-spotapi/lib/binanceWebSocket.js#L533) |
| Binance public WS `@aggTrade` | WebSocket | spotapi — the trade tape | [binanceWebSocket.js:709](../../cryptodex-spotapi/lib/binanceWebSocket.js#L709) |
| Binance REST `/depth` `/ticker/24hr` `/klines` `/aggTrades` | HTTPS | spotapi (snapshot + crons) | [binanceWebSocket.js:166](../../cryptodex-spotapi/lib/binanceWebSocket.js#L166), [binance.controller.js:1421](../../cryptodex-spotapi/controllers/binance.controller.js#L1258) |
| Binance REST (SDK) `prices()` | HTTPS, unauthenticated | walletapi FX table | [binance.controller.js:8](../../cryptodex-walletapi/controllers/binance.controller.js#L8) |
| **CryptoCompare** | HTTPS, **API key hardcoded in the URL** | walletapi, 5-min cron | [priceCNV.controller.js:66](../../cryptodex-walletapi/controllers/priceCNV.controller.js#L66) |
| **Resend** (email) | HTTPS API | userapi — activation / reset | [lib/emailGateway.js:45](../../cryptodex-userapi/lib/emailGateway.js#L45) |
| TradingView ticker-tape embed | browser `<script>` from `s3.tradingview.com` | frontend landing page | [bannerPage.tsx:159](../../cryptodex-frontend/components/Market/bannerPage.tsx#L159) |

**No SMTP anywhere** — `nodemailer` is declared in two manifests but imported by no source file
([userapi/config/index.js:193](../../cryptodex-userapi/config/index.js#L193)).

**No inbound webhooks anywhere.** Every mounted route across the three services was enumerated; none
is webhook/callback/IPN shaped. The two that existed — `/fireblocksWebhook` and `/kyc-webhook` — are
documented as deleted ([wallet.route.js:113](../../cryptodex-walletapi/routes/wallet.route.js#L113), [user.route.js:19](../../cryptodex-userapi/routes/user.route.js#L19)).

**Removed / stubbed (config survives, code does not):** Fireblocks custody, Sumsub KYC, Telnyx/Twilio
SMS, Solana/Helius, seven chain gateways (all return `"paper-bnb-…"` synthetic values), Mailgun,
Cloudinary, CoinMarketCap, CoinPayments, ipapi.co, reCAPTCHA server-side.

**Present but unreachable:** Binance *authenticated* order placement. `binanceApiNode.order()` exists
at four call sites, but both order-entry paths hard-code `liquidityType: "off"` with the comment
*"PAPER TRADING: never follow botstatus"*, and every match branch requires `"off"`
([spot.controller.js:1851](../../cryptodex-spotapi/controllers/spot.controller.js#L1851)). The 5-second `binOrderTask` cron that would poll it **is already running**;
it is idle only because no order can carry that flag ([binance.controller.js:977](../../cryptodex-spotapi/controllers/binance.controller.js#L814)).

---

## 10. Test layout

| Package | Runner | Layout |
|---|---|---|
| spotapi | Jest 29 | `tests/unit` (43) + `tests/integration` (2) |
| walletapi | Jest 30 | `tests/unit` (20) + `tests/integration` (6) + `fixtures/`, `helpers/` |
| userapi | Jest 29 | `tests/unit` (15) + `tests/integration` (3) + `helpers/` |
| frontend | Jest 30 + jsdom | `__tests__/`, `__mocks__/`, `jest.setup.js` |
| frontend e2e | Playwright | `e2e/`, `playwright.config.ts` |
| smoke | `node --test` | `system-smoke-test/check-services.test.js` |

All three backends use `mongodb-memory-server` for integration tests.

⚠️ `jest.setup.js:226` **globally `jest.mock`s `@/lib/roundOf`** with a rounding stub — a unit test of
the real implementation must use `jest.requireActual`.

The smoke test **depends on a shipped test backdoor**: it completes registration via
`POST /api/auth/test-verify`, gated by `TEST_MODE`, which is `true` in the committed
`userapi/local.env` ([smoke-test.js:228](../../system-smoke-test/smoke-test.js#L228), [auth.route.js:42](../../cryptodex-userapi/routes/auth.route.js#L42)).

---

## 11. Doc claims that the code contradicts

Read `DEPLOYMENT.md` with care — two of its load-bearing claims are **stale**:

| Doc claim | Reality | Source |
|---|---|---|
| `railway.json` sets `healthcheckPath: "/"` and "there is no `build` block" | It sets `"/api/health"` **and** has a `build` block | [railway.json:5](../../railway.json#L5), [:12-15](../../railway.json#L12-L15) *(read directly)* |
| supervisor spawns children with only `NODE_ENV` and `PORT`, so all three would share one DB URI | It derives per-service `DATABASE_URI` **and** `GRPC_URL` | [supervisor.mjs:101-105](../../deploy/supervisor.mjs#L101-L105) *(read directly)* |
| `README.md` / `SYSTEM_GUIDE.md`: demo grant is "1,000 USDC and 1,000 USD" | **USD only** | [createAsset.js:20](../../cryptodex-walletapi/controllers/createAsset.js#L20), [faucet.controller.js:74](../../cryptodex-spotapi/controllers/faucet.controller.js#L74) |
| `ops/README.md`: boot asserts `spotPairdata = 3` | Asserts `>= 1`; the venue lists one pair | [start-all.sh:271](../../start-all.sh#L271) |

39 of 44 checked doc claims *were* confirmed against code — these four are the exceptions.

---

## Unverified

Things that cannot be settled by reading the tree:

1. **Live database contents.** That Mongo currently holds exactly one `spotpair`, that no
   `SpotOrder` carries `liquidityType:"binance"` (which would wake the 5s cron into signed Binance
   calls), and that `PriceConversion` rows still carry `fetchFrom:'off'`. Code proves the *write paths*; rows predating the paper conversion cannot be ruled out.
2. **Deployed env values.** Whether `RESEND_API_KEY`, `NEXT_PUBLIC_RECAPTCHA_KEY`, `NEXT_PUBLIC_MODE`
   and `NEXT_PUBLIC_CRYPTO_SECRET_KEY` are set, and whether the last equals spotapi's constant.
3. **Which `config/index.js` branch is selected at runtime** (all three carry the same
   `cryptoSecretKey` literal, so the conclusion is unaffected).
4. **Any CSP at the platform layer.** No CSP is configured in `next.config.js` or `middleware.ts`;
   Railway's edge is outside the repo.
5. **Whether anything outside spotapi writes `filled_orders_<pairId>`** — which would make the
   otherwise no-op `execute()` on the 2s cron live. The search covered spotapi only.
6. **Runtime effect of `NODE_TLS_REJECT_UNAUTHORIZED='0'`** — the module was confirmed on the boot
   import chain by reading imports, but the service was not executed.

## Open questions

Flagged for you; several are design questions rather than defects.

1. **Throughput ceiling.** The limit branch of `tradeMatching` ends in an unconditional `break`
   ([spot.controller.js:5980](../../cryptodex-spotapi/controllers/spot.controller.js#L5396)) *(verified directly)*, so **at most one limit fill settles per pair per
   2-second tick**. Intended?
2. **TLS verification is disabled process-wide in spotapi.** `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`
   sits at module scope in a chart sample that is on the boot import chain, so every Binance HTTPS
   call runs under it. The sibling file documents removing the identical line as "the serious one"
   ([chart/symbols_database.js:11](../../cryptodex-spotapi/controllers/chart/symbols_database.js#L11), [chart/request-processor.js:25-31](../../cryptodex-spotapi/controllers/chart/request-processor.js#L25-L31)).
3. **No idempotency on order placement**, and the reservation is taken *before* the order document is
   written. A retried POST double-places. Intended client behaviour on timeout?
4. **`express-rate-limit` is declared but imported nowhere** *(verified directly)*. Removed
   deliberately, or dropped wiring? Nothing rate-limits `/orderPlace`.
5. **`limitOrderPlace` returns 200 without awaiting** `newOrderHistory()` or `passbook()`
   ([spot.controller.js:1946](../../cryptodex-spotapi/controllers/spot.controller.js#L1946)). Does a 200 promise persistence, or only that the reservation landed?
6. **Hardcoded third-party keys in tracked source** — CryptoCompare (on a live 5-min cron), Infura
   fallback, bscscan/polygonscan/etherscan. Is rotation in scope, or a separate track?
7. **`tradePair` cancel-latch is a single module-level string shared by all pairs**, while the
   re-entry latch is per-pair. Safe at one market; breaks at two ([spot.controller.js:112](../../cryptodex-spotapi/controllers/spot.controller.js#L112)).
8. **Should config-only external hostnames appear on the Context diagram?** (bscscan, infura,
   trongrid, mailgun, cloudinary, …) — none has a live code path, but all are spelled out with
   live-shaped keys.
9. **Is Binance one box or two?** The public market-data surface is unambiguously live; the
   authenticated trading surface is present in code, held off only by a hardcoded literal. Different
   trust relationships to one provider.
10. **`/app/*` alias mounts** double the public surface on userapi and spotapi. Keep them on the
    diagrams, or note and omit?

---

## Method note

Produced by parallel read-only agents, each required to cite `file:line`, followed by an adversarial
completeness critic that spot-checked citations. The critic caught real errors — a non-existent
filename (`routes.tsx` → [routes.ts](../../cryptodex-frontend/components/Router/routes.ts)), four dead `reconnect` listeners
presented as live wiring, a missing 2-second matcher cron, and a socket "room" model that is actually
a global broadcast. Every claim marked *(verified directly)* above was then re-read by hand.
