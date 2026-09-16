# 03 — Components: spotapi (evidence)

Companion to [`03-components-spotapi.mmd`](03-components-spotapi.mmd). This is the trading engine and
market-data service — the container the whole system hinges on.

Grouped by real folder boundaries: `routes/` + `config/` (entry) → `controllers/` (domain) →
`lib/` (policy) → `controllers/redis.controller.js` + `models/` (data access) → `grpc/` + `lib/binanceWebSocket.js` (external).

---

## Entry points

| Element | What it is | Source `file:line` | Notes |
|---|---|---|---|
| `routes/spot.route.js` | 20 endpoint registrations | [spot.route.js:61](../../cryptodex-spotapi/routes/spot.route.js#L61) | Mounted at **both** `/api/spot` and `/app/spot` |
| `routes/dashboard.route.js` | 3 endpoints, all authenticated | [dashboard.route.js:11-17](../../cryptodex-spotapi/routes/dashboard.route.js#L11-L17) | Omitted from the diagram for node budget |
| `controllers/health.controller.js` | **readiness probe** for `/api/health` — process + dependencies, never market state |
| `config/socketIO.js` | socket.io server, CORS `origin:"*"` | [socketIO.js:30-33](../../cryptodex-spotapi/config/socketIO.js#L30-L33) | |
| `config/socketAuth.js` | `CREATEROOM` JWT handshake, `ROOMREJECTED` | [socketAuth.js:241](../../cryptodex-spotapi/config/socketAuth.js#L241) | |
| `config/cron.js` | 13 schedules | [cron.js:105](../../cryptodex-spotapi/config/cron.js#L105) | |
| in-controller cron | **the 2s matcher** — not in `cron.js` | [spot.controller.js:4945](../../cryptodex-spotapi/controllers/spot.controller.js#L4361) | *(verified directly)* |

> Both routers are `express()` sub-apps, not `express.Router()` ([spot.route.js:19-20](../../cryptodex-spotapi/routes/spot.route.js#L19-L20)).
> Because the router is mounted twice, **guards must live per-route rather than on the mount** — which
> is exactly how the order path is built.

**Endpoint count:** 23 router registrations + 2 app-level (`GET /api/health`, `GET /`), each reachable
under both `/api/*` and `/app/*` ([server.js:82-87](../../cryptodex-spotapi/server.js#L82-L87)).

Unauthenticated endpoints worth noting: `/tradePair`, `/ordeBook/:pairId` *(the path really is spelled
`ordeBook`)*, `/marketPrice/:pairId`, `/recentTrade/:pairId`, `/get-trends`, `/chart/:config`, `/health`,
and **`POST /depth-chart`** — a write-shaped verb serving read-only data with no guard
([spot.route.js:84](../../cryptodex-spotapi/routes/spot.route.js#L84)).

## Guards — the order path's middleware chain

`POST /orderPlace` runs **seven** middlewares in order ([spot.route.js:68](../../cryptodex-spotapi/routes/spot.route.js#L68)):

`passportAuth` → `blockStoodDownAccount` → `trackValueFlight` → `decryptValidate` →
`decryptTradeOrder` → `orderPlaceValidate` → `orderPlace`

| Guard | What it does | Source |
|---|---|---|
| `config/passport.js` | JWT + **re-reads the live session from Redis** `userToken`: rejects if absent, if `userLocked != "false"`, or if `tokenId` mismatches | [passport.js:22](../../cryptodex-spotapi/config/passport.js#L22) |
| `standDownState.js` | Freeze gate. Two sources: Redis `account_standdown` + walletapi `deactivateWallet(mode:"check")` over gRPC | [standDownState.js:58](../../cryptodex-spotapi/controllers/standDownState.js#L58) |
| `valueFlightGuard.js` | Registers the request so a concurrent reset cannot race it. Deregisters on `finish`, **deliberately not on `close`** | [valueFlightGuard.js:35](../../cryptodex-spotapi/controllers/valueFlightGuard.js#L35) |

The stand-down guard sits **before** the decrypt so a frozen account is refused without decrypting.
`cancelOrder` deliberately carries `trackValueFlight` but **not** `blockStoodDownAccount` — a freeze
must never trap funds behind an unfilled order ([spot.route.js:83](../../cryptodex-spotapi/routes/spot.route.js#L83)).

The order payload arrives as a single AES-encrypted `token` field ([spotTrade.validation.js:22](../../cryptodex-spotapi/validation/spotTrade.validation.js#L22)),
decrypted with a **hardcoded constant** shared with the browser bundle
([config/index.js:60](../../cryptodex-spotapi/config/index.js#L60)) — obfuscation, not authentication. The JWT is the real auth.

## Domain

| Element | Responsibility | Source |
|---|---|---|
| `spot.controller.js` (7457 lines) | Order entry, the matcher, settlement, 15 REST handlers | [spot.controller.js:4962](../../cryptodex-spotapi/controllers/spot.controller.js#L4378) |
| `paperBook.controller.js` | Mirrors Binance depth into admin-owned resting orders in the **same** Redis hashes the matcher reads | [paperBook.controller.js:454](../../cryptodex-spotapi/controllers/paperBook.controller.js#L454) |
| `bookPublish.controller.js` | The single publisher of every `orderBook` payload | [bookPublish.controller.js:279-298](../../cryptodex-spotapi/controllers/bookPublish.controller.js#L279-L298) |
| `faucet.controller.js` | `claimFaucet` (24h cooldown), `resetFaucet` (absolute writes) | [faucet.controller.js:470](../../cryptodex-spotapi/controllers/faucet.controller.js#L470), [:744](../../cryptodex-spotapi/controllers/faucet.controller.js#L744) |
| `fillCanary.js` | Zero-write shadow fill on an interval; backs `GET /health` | [fillCanary.js:817](../../cryptodex-spotapi/controllers/fillCanary.js#L817) |
| `chart/chart.controller.js` | TradingView UDF datafeed | [chart.controller.js:108-128](../../cryptodex-spotapi/controllers/chart/chart.controller.js#L108-L128) |

**The key architectural move:** the paper ladder is written as ordinary resting limit orders into
`buyOpenOrders_<pairId>` / `sellOpenOrders_<pairId>`, so **the existing matcher settles them with no
special-casing** ([paperBook.controller.js:9](../../cryptodex-spotapi/controllers/paperBook.controller.js#L9)). Synthetic rows carry `isPaper:true`,
`liquidityType:"off"`, and are owned by the admin liquidity account.

## Policy and ledger

| Element | Responsibility | Source |
|---|---|---|
| `lib/orderGate.js` | `assertOrderTradable` — market orders need healthy depth **and** ladder capacity for *this* order; unmeasurable size **fails closed**. Limit orders pass unless terminal | [orderGate.js:253](../../cryptodex-spotapi/lib/orderGate.js#L253), [:273](../../cryptodex-spotapi/lib/orderGate.js#L273) |
| `lib/depthHealth.js` | One verdict. Breakers: `no_depth`, `stale_depth` (45s), `empty_side`, `crossed_book`, `price_deviation` (5%) | [depthHealth.js:148](../../cryptodex-spotapi/lib/depthHealth.js#L148) |
| `lib/depthSource.js` | Memory-first, Redis-second snapshot resolution | [depthSource.js:49](../../cryptodex-spotapi/lib/depthSource.js#L49) |
| `paperLedger.js` | The sanctioned balance mutator across four mirrors | [paperLedger.js:190](../../cryptodex-spotapi/controllers/paperLedger.js#L190) |
| `redis.controller.js` | The Lua primitives: `hincrbyfloatIfEnough`, `hgetdel`, `claimOnce`, `beginFlight` | [redis.controller.js:189](../../cryptodex-spotapi/controllers/redis.controller.js#L189) |

**One health verdict feeds four consumers** — the ladder build, the display publish, the order gate
and the canary. This is deliberate: two derivations once let the UI show a full 20-level book while
nothing could fill.

**`RESERVE_LUA` is the only command that takes a reservation.** It EXISTS-checks the freeze key, then
HGETs and HINCRBYFLOATs in one indivisible step, so the balance can never go negative
([redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179)) *(verified directly)*.

## External clients

| Element | Target | Mechanism | Source |
|---|---|---|---|
| `lib/binanceWebSocket.js` | Binance | `wss://stream.binance.com:9443` depth@100ms + aggTrade; REST snapshot to seed | [binanceWebSocket.js:533](../../cryptodex-spotapi/lib/binanceWebSocket.js#L533), [:166](../../cryptodex-spotapi/lib/binanceWebSocket.js#L166) |
| `binance.controller.js` | Binance | REST ticker/klines/aggTrades on cron | [binance.controller.js:1421](../../cryptodex-spotapi/controllers/binance.controller.js#L1258) |
| `grpc/walletService.js` | walletapi | `getUserAsset`, `updateUserWallet`, `passbook`; 5s deadline, **no retry** | [walletService.js:34](../../cryptodex-spotapi/grpc/walletService.js#L34) |
| `grpc/walletStandDownService.js` | walletapi | `deactivateWallet(mode:"check")`, hand-rolled descriptor | [walletStandDownService.js:93](../../cryptodex-spotapi/grpc/walletStandDownService.js#L93) |
| `grpc/adminService.js`, `userService.js` | **userapi** | `saveAdminprofit`, user lookups | [adminService.js:29](../../cryptodex-spotapi/grpc/adminService.js#L29) *(verified)* |

## Data access

| Store | What lives there | Source |
|---|---|---|
| Redis `walletbalance_spot` | **the authoritative balance** | [paperLedger.js:22](../../cryptodex-spotapi/controllers/paperLedger.js#L22) |
| Redis `walletbalance_spot_inOrder` | escrow | [spot.controller.js:407](../../cryptodex-spotapi/controllers/spot.controller.js#L407) |
| Redis `buy/sellOpenOrders_<pairId>` | the live book | [spot.controller.js:1948](../../cryptodex-spotapi/controllers/spot.controller.js#L1948) |
| Redis `spotPairdata` | pair cache, preferred over Mongo | [loadPairs.js:50](../../cryptodex-spotapi/controllers/loadPairs.js#L50) |
| Redis `admin_liquidity/liquidation` | ladder owner — **the SPOF** | [paperBook.controller.js:488](../../cryptodex-spotapi/controllers/paperBook.controller.js#L488) |
| MongoDB `_spot` | `SpotOrder`, `TradeHistory`, `SpotPair`, … | [spot.controller.js:2532](../../cryptodex-spotapi/controllers/spot.controller.js#L2532) |
| MongoDB `_wallet` | **second connection**, currency lookups | [models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8) *(verified)* |

**Mongo is authoritative for the pair list; Redis is authoritative for everything live.**
`loadPairsToRedis` rehydrates the cache on boot and prunes phantoms, carrying over 11 `LIVE_ONLY_FIELDS`
that exist only in Redis ([loadPairs.js:25-37](../../cryptodex-spotapi/controllers/loadPairs.js#L25-L37)).

## Dormant modules (present, unreachable)

| Module | Why it is dead | Source |
|---|---|---|
| `withdrawal.controller.js` | Returns 410 Gone; **and the route is not even registered** | [withdrawal.controller.js:129-135](../../cryptodex-spotapi/controllers/withdrawal.controller.js#L129-L135) |
| `binance.controller.js` order path | Gated on `liquidityType=="binance"`, hardcoded `"off"` | [spot.controller.js:1851](../../cryptodex-spotapi/controllers/spot.controller.js#L1851) |
| `execute()` on the 2s cron | Reads `filled_orders_<pairId>`, which nothing writes | [spot.controller.js:7667](../../cryptodex-spotapi/controllers/spot.controller.js#L7083) |

> `routes/spot.route.js` carried a "Withdrawal Endpoints" comment block claiming the route "is KEPT,
> with its guards" when no such registration exists. **Corrected 2026-08-26** — the comment now states
> that the route is unregistered and answers 404, and why it was left that way.

---

## Unverified

1. Whether anything outside spotapi writes `filled_orders_<pairId>`, which would make `execute()` live.
   The search covered spotapi only.
2. Whether `marketMatching`'s mid-function block (≈6420–6560) contains an additional balance mutator —
   it is the mirror of the buy-side logic that *was* read line by line, but was not itself fully read.
3. The real divergence between Redis `walletbalance_spot` and Mongo `wallet.assets[].spotBal` in
   practice. The mechanism is verified; the magnitude is a runtime question.
4. Whether `SPOT_CANARY_DISABLED` is set in production, which would silence the fill canary that
   `railway.json`'s healthcheck ultimately gates deploys on.

## Open questions

1. **One limit fill per pair per 2-second tick.** The limit branch ends in an unconditional `break`
   ([spot.controller.js:5980](../../cryptodex-spotapi/controllers/spot.controller.js#L5396)) *(verified)*. Intended throughput ceiling?
2. **`tradePair` — the cancel/fill interlock — is a single module-level string shared by all pairs**,
   while the re-entry latch is per-pair ([spot.controller.js:112](../../cryptodex-spotapi/controllers/spot.controller.js#L112)). Safe at one market; a second
   market would let pair B overwrite pair A's latch.
3. **`limitOrderPlace` returns 200 without awaiting** `newOrderHistory()` or `passbook()`
   ([spot.controller.js:1946](../../cryptodex-spotapi/controllers/spot.controller.js#L1946)) — the ledger moves before the document exists.
4. **No rate limiting and no idempotency key** on `/orderPlace` *(both verified)*. A retried POST
   double-places. **Still open — deliberately not changed**, since both are behaviour changes to the
   trading path rather than defects.
5. **`express.static` points at a `public/` directory that does not exist** in this service
   ([server.js:76](../../cryptodex-spotapi/server.js#L76)) — yet the gateway forwards nothing to it, so it is harmless. Remove?
6. **`assessDepthHealth`'s `price_deviation` breaker compares venue depth against `pairData.markPrice`,
   which `newTradeHistory` overwrites from each fill** ([spot.controller.js:7038](../../cryptodex-spotapi/controllers/spot.controller.js#L6454)). Can a run of
   fills walk `markPrice` far enough to trip the breaker against the feed that produced it?
