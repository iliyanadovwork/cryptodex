# Cryptodex — architecture map

A spot-only **paper-trading** crypto exchange: virtual money, live Binance market data. Built to be
explained out loud.

Every box, arrow and claim in these diagrams is traceable to a line of code. Each `.mmd` has a
companion `.md` with a `element | what it is | file:line` table — that table is the reading list.

---

## 1. The two-minute narrative

> Say this top-down. Each paragraph maps to one diagram.

**What it is.** Cryptodex is a paper-trading spot exchange. Users register, get 1,000 virtual USD,
and trade a single market — BTC/USD — against **live** order-book depth streamed from Binance. Nothing
is custodied and nothing can be withdrawn: the withdrawal endpoint returns 410 Gone. That single
constraint is what makes the rest of the design defensible.

**Who it talks to.** One human actor and, in practice, one external dependency that matters: Binance's
public market-data API. Two WebSocket streams (depth diffs at 100 ms, and the aggregated trade tape)
plus four REST endpoints. Everything else is peripheral — Resend for activation email, CryptoCompare
for an FX table, a TradingView ticker widget in the browser. There are **no inbound webhooks at all**,
and the entire custody apparatus — Fireblocks, seven chain gateways, KYC, SMS — is stubbed or deleted.
→ [01-context](01-context.mmd)

**How it's deployed.** Two Railway services. The frontend is a Next.js app. The backend is **one
container running five processes**: a supervisor as PID 1, three Express services, and a
zero-dependency gateway on the single public port. They share a container because they dial each other
over *plaintext gRPC on loopback* — splitting them would put unauthenticated RPC on a network. The
supervisor's whole job is to kill the container if any child dies, because a venue that accepts logins
while the matching engine is dead is worse than one that is plainly down. → [02-containers](02-containers.mmd)

**How the trading engine works.** This is the interesting part. spotapi holds an in-memory mirror of
Binance's L2 book, kept in sync by sequence-numbered diffs with a watchdog and re-snapshot logic. Every
two seconds a cron rebuilds a **synthetic ladder** — twelve price levels per side, written as ordinary
resting limit orders owned by an admin account, into the very same Redis hashes that hold real user
orders. Then the ordinary matcher runs. The trick is that the paper liquidity needs *no special-casing
in the matcher at all*: it looks like resting orders, so it settles like resting orders.
→ [03-components-spotapi](03-components-spotapi.mmd), [04-flow-market-data](04-flow-market-data.mmd)

**Where the money lives.** **Redis is authoritative, not MongoDB.** Balances live in a Redis hash;
Mongo's copy is seeded once and then deliberately allowed to drift. There are no database transactions
anywhere — the only atomicity in the system is four Lua scripts, of which one matters: a
reserve-if-sufficient script that checks a freeze flag, reads the balance and debits it in a single
indivisible step. And total value is deliberately **not** conserved across a trade, because the
synthetic counterparty is exempt from settlement. → [05-data](05-data.mmd), [04-flow-order-placement](04-flow-order-placement.mmd)

**Where money comes from.** A faucet, on a 24-hour cooldown enforced by `SET NX EX` — an atomic lock,
not a rate limit. It is the only mint in the system. → [04-flow-faucet-claim](04-flow-faucet-claim.mmd)

**The one-sentence version.** *A single-market paper exchange that mirrors a real venue's order book
into synthetic resting orders so an ordinary matching engine can fill against live liquidity, with
Redis as the authoritative ledger and no distributed transactions anywhere.*

---

## 2. The diagrams

| File | What it shows |
|---|---|
| [00-inventory.md](00-inventory.md) | Languages, layout, entry points, config loading, tests — the groundwork |
| [01-context.mmd](01-context.mmd) · [evidence](01-context.md) | The venue, its one actor, and every external system it reaches |
| [02-containers.mmd](02-containers.mmd) · [evidence](02-containers.md) | Deployable units, the gRPC mesh, and how production differs from local |
| [03-components-spotapi.mmd](03-components-spotapi.mmd) · [evidence](03-components-spotapi.md) | The trading engine: guards, matcher, ladder, publisher, policy |
| [03-components-userapi.mmd](03-components-userapi.mmd) · [evidence](03-components-userapi.md) | Identity: auth, mail policy vs transport, session store |
| [03-components-walletapi.mmd](03-components-walletapi.mmd) · [evidence](03-components-walletapi.md) | Balances and currency metadata — a mostly-gRPC service |
| [03-components-frontend.mmd](03-components-frontend.mmd) · [evidence](03-components-frontend.md) | Next.js edge guard, five axios clients, one socket |
| [04-flow-order-placement.mmd](04-flow-order-placement.mmd) · [evidence](04-flow-order-placement.md) | **The flow to know.** Accept → reserve → match → settle |
| [04-flow-market-data.mmd](04-flow-market-data.mmd) · [evidence](04-flow-market-data.md) | Binance depth → tradable ladder + displayed book |
| [04-flow-registration.mmd](04-flow-registration.mmd) · [evidence](04-flow-registration.md) | Register → provision wallet → activate → log in |
| [04-flow-faucet-claim.mmd](04-flow-faucet-claim.mmd) · [evidence](04-flow-faucet-claim.md) | The only way money is created |
| [05-data.mmd](05-data.mmd) · [evidence](05-data.md) | Three databases, 20 collections, and where authority really lives |

[02-containers](02-containers.mmd) doubles as the index for the four component diagrams.

---

## 3. Interview drill

### spotapi — the trading engine

**If it dies:** the whole container dies with it. The supervisor exits non-zero on any child exit, by
design — *"a container that keeps answering on :8080 while spotapi is dead is worse than one that is
plainly down: the venue would accept logins, show balances, and silently never fill an order"*
([supervisor.mjs:8-14](../../deploy/supervisor.mjs#L8-L14)). Railway restarts, ON_FAILURE, max 10. On boot every ladder is
purged before the matcher can reach it ([server.js:112](../../cryptodex-spotapi/server.js#L112)).

**Where the bottleneck is:** the 2-second matcher tick, and specifically the unconditional `break` at
the end of the limit branch — **at most one limit fill settles per pair per tick**
([spot.controller.js:5980](../../cryptodex-spotapi/controllers/spot.controller.js#L5396)). A large resting order clears one counterparty level every two
seconds. Secondary: `spot.controller.js` is 8,041 lines in one module, and the matcher `hgetall`s both
order-book hashes in full every tick ([spot.controller.js:4992](../../cryptodex-spotapi/controllers/spot.controller.js#L4408)).

**How it scales:** **it doesn't, as written.** `numReplicas: 1` ([railway.json:9](../../railway.json#L9)) is not a
budget choice, it's a correctness requirement:
- the matcher's only mutual exclusion is an in-process `Set` of per-pair locks ([spot.controller.js:4968](../../cryptodex-spotapi/controllers/spot.controller.js#L4384)) — no distributed lock;
- the ladder is rebuilt wholesale each tick, so two writers would fight ([paperBook.controller.js:509](../../cryptodex-spotapi/controllers/paperBook.controller.js#L509));
- Binance streams open per process ([binanceWebSocket.js:386](../../cryptodex-spotapi/lib/binanceWebSocket.js#L386));
- **socket.io has no adapter**, so a broadcast reaches only that process's clients ([config/socketIO.js:126](../../cryptodex-spotapi/config/socketIO.js#L126)).

To scale you would need a Redis socket.io adapter, a distributed matcher lock, and one designated
stream owner per pair.

**Consistency boundary:** a single Redis key. `RESERVE_LUA` is the only command that takes a
reservation, and it checks the freeze flag, reads and debits atomically
([redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179)). Outside that one script there is **no** transactional boundary
— no `startSession`, no `withTransaction` anywhere *(verified by grep)*. The escrow credit is a
separate, non-atomic second command ([spot.controller.js:1904](../../cryptodex-spotapi/controllers/spot.controller.js#L1904)), which is precisely why the
value-flight registry exists.

### walletapi — balances

**If it dies:** container dies. But note it is *not* on the critical path for a fill — spotapi settles
against Redis directly and only calls walletapi for hydration on first touch and for fire-and-forget
audit rows ([spot.controller.js:57-60](../../cryptodex-spotapi/controllers/spot.controller.js#L57-L60)). Trading would continue; the audit trail would silently
gap, since a failed `passbook` is logged and swallowed ([grpc/walletService.js:109](../../cryptodex-spotapi/grpc/walletService.js#L109)).

**Where the bottleneck is:** `getWallet` loads the whole wallet document plus a currency map on every
balance read ([wallet.controller.js:355](../../cryptodex-walletapi/controllers/wallet.controller.js#L355)). Fine at one market and 23 asset fields.

**How it scales:** better than spotapi — it is nearly stateless, since Redis holds the truth. The
blocker is the shared container, not the service.

**Consistency boundary:** `HSETNX`. Mongo seeds each Redis balance field **once**, then reports Redis
forever. So Mongo can never correct Redis after first touch — the divergence is permanent and
intentional ([paperLedger.js:169](../../cryptodex-spotapi/controllers/paperLedger.js#L169)).

### userapi — identity

**If it dies:** container dies. Sessions would fail everywhere, because **all three** services validate
against the Redis `userToken` row rather than the JWT alone ([passport.js:22](../../cryptodex-spotapi/config/passport.js#L22)) — though
that row is in Redis, so an already-issued token keeps working for the other two services as long as
Redis is up.

**Where the bottleneck is:** PBKDF2 at 100,000 iterations, 128 bytes, SHA-512 on every login
([User.js:414](../../cryptodex-userapi/models/User.js#L424)) — deliberately expensive, and **unthrottled**: there is no rate limiting
anywhere in the service ([server.js:77](../../cryptodex-userapi/server.js#L77)). That combination is the one I'd raise unprompted.

**How it scales:** statelessly, except that its socket.io server has no adapter — which is moot, since
no client connects to it ([config/socketIO.js:10](../../cryptodex-userapi/config/socketIO.js#L10)).

**Consistency boundary:** the Redis `userToken` row — one live session per account. A re-login
overwrites `tokenId` and instantly invalidates the previous token, which is also what drives the
socket's `ROOMREJECTED session_revoked`.

### gateway — the front door

**If it dies:** every API request and every socket dies; the Next.js app still serves pages, so the
user sees a loaded UI with no data. The supervisor takes the container down.

**Where the bottleneck is:** it is a single Node process proxying **all** HTTP and tunnelling **every**
WebSocket frame at the TCP level ([gateway.mjs:17-22](../../deploy/gateway.mjs#L17-L22)). Node's `requestTimeout` and
`headersTimeout` are deliberately relaxed for long-polling ([gateway.mjs:23-28](../../deploy/gateway.mjs#L23-L28)) — which
means *no* route has an upstream timeout.

**How it scales:** horizontally in principle (it is stateless), but pointless while the services behind
it cannot.

**Consistency boundary:** none — it rewrites nothing and forwards byte for byte ([routes.mjs:9-19](../../deploy/routes.mjs#L9-L19)).

### frontend

**If it dies:** trading stops for users, but the engine keeps matching — the 2-second cron and the
Binance streams are server-side. Resting orders keep filling with nobody watching.

**Where the bottleneck is:** it is entirely client-rendered after the static shell — no
`getServerSideProps` anywhere ([utils/auth.js:9](../../cryptodex-frontend/utils/auth.js#L9)) — so first paint waits on the API.

**Consistency boundary:** none of its own; it is a projection. Worth noting the edge guard trusts only
a `loggedin` **cookie** and never inspects the JWT ([middleware.ts:18](../../cryptodex-frontend/middleware.ts#L18)) — it is a UX
redirect, not a security boundary. The real check is server-side on every request.

---

## 4. Non-obvious decisions

Things a naive design would not do, with the reason where the code gives one.

**1. The paper ladder is written as real resting orders.** Rather than special-casing synthetic
liquidity in the matcher, `syncPaperBook` writes admin-owned limit orders into the same
`buyOpenOrders_<pairId>` hashes as real users, so *the existing matcher settles them unchanged*
([paperBook.controller.js:9](../../cryptodex-spotapi/controllers/paperBook.controller.js#L9)). Zero matcher changes for the entire paper conversion.

**2. Display and matcher share one health verdict.** The stated reason is a real outage: two
derivations of "is this depth usable" meant *"when the ladder was purged by a circuit breaker the
display kept rendering a full, pretty, 20-level book — so every visible signal said 'healthy' while
nothing on the exchange could fill"* ([depthHealth.js:4](../../cryptodex-spotapi/lib/depthHealth.js#L4)). **My favourite lesson in this
codebase:** the UI and the engine must share one liquidity truth, or the UI lies confidently.

**3. Money conservation is deliberately false.** The synthetic counterparty is exempt from settlement,
so only the user's side of a fill moves. Anyone auditing with "total value is conserved" will find a
leak on every fill. Before the exemption, the admin bot had drifted to 234,978 USD out of one-legged
credits ([spot.controller.js:942](../../cryptodex-spotapi/controllers/spot.controller.js#L942), [paperLedger.js:30](../../cryptodex-spotapi/controllers/paperLedger.js#L30)).

**4. Fees are zeroed at the rate source, not by deleting the arithmetic.** `feeRateFor()` returns a
hard `0`, and every fee term downstream is left standing: *"Cutting fee terms out of a matching
engine's settlement is exactly where a mint or a burn gets introduced; this cannot introduce one"*
([liquidityRole.js:231](../../cryptodex-spotapi/lib/liquidityRole.js#L231)).

**5. The gateway routes on real paths so socket.io keeps working.** A prefix scheme (`/spot/...`) was
rejected because `io("https://host/spot")` reads a **namespace**, not a path — the handshake would fail
with "Invalid namespace" and the whole trading screen would go dark ([routes.mjs:21-36](../../deploy/routes.mjs#L21-L36)).
The services happened to already be mounted on disjoint path spaces, so nothing needed rewriting.

**6. Fail-fast supervision instead of supervisord.** supervisord's default is to *restart* a dead child
and keep the container up — the exact "limp along silently" failure being avoided
([supervisor.mjs:16-26](../../deploy/supervisor.mjs#L16-L26)).

**7. Vestigial schema fields are retained on purpose.** Removing a mongoose path doesn't delete data, but
it *does* make mongoose drop that field on the next save. Enum members are worse: a document that already
stores a value dropped from the enum fails validation on its next write, turning an unrelated settings
update into a 500 for exactly the users who chose it. Clearing either is a migration, not a schema edit
([userSetting.js:60-80](../../cryptodex-userapi/models/userSetting.js#L60-L80)).

**8. The faucet cooldown is a lock, not a rate limit.** `SET NX EX` is taken before anything is read,
and is released **only if nothing was credited** — choosing "user waits 24 h" over "user double-mints"
([faucet.controller.js:480](../../cryptodex-spotapi/controllers/faucet.controller.js#L480), [:564](../../cryptodex-spotapi/controllers/faucet.controller.js#L564)).

**9. Cancel is deliberately *not* freeze-gated.** A cancel only turns escrow back into spendable
balance, so a freeze must never trap funds behind an unfilled order ([spot.route.js:83](../../cryptodex-spotapi/routes/spot.route.js#L83)).

**10. `liquidityRole` is stamped at acceptance.** It cannot be re-derived later because the ladder is
rebuilt every 2 s with fresh ids and a backdated `orderDate` ([spot.controller.js:1679](../../cryptodex-spotapi/controllers/spot.controller.js#L1679)).

**11. Liveness is measured on depth *data*, not on the socket.** Binance pings every ~20 s, so counting
a ping as life leaves a socket that is "perfectly connected and perfectly useless" alive forever
([binanceWebSocket.js:552](../../cryptodex-spotapi/lib/binanceWebSocket.js#L552)). Likewise the Redis depth mirror stamps `cache.updatedAt`, not
`Date.now()`, so stale depth cannot look fresh ([binanceWebSocket.js:321](../../cryptodex-spotapi/lib/binanceWebSocket.js#L321)).

**12. `responseGuard` forces a 500 if no handler ever replies** ([responseGuard.js:20](../../cryptodex-userapi/lib/responseGuard.js#L20)) —
a guard against a real defect class, with `ops/response-sweep.cjs` as the static counterpart.

---

## 5. What static reading could not determine

Consolidated from every evidence file. These need a running system or the Railway dashboard.

### Runtime configuration
- Whether `RESEND_API_KEY` is set. If empty, registration completes with **no activation email and no
  user-visible error** ([emailGateway.js:36-43](../../cryptodex-userapi/lib/emailGateway.js#L36-L43)).
- Whether `NEXT_PUBLIC_CRYPTO_SECRET_KEY` matches spotapi's hardcoded constant. If not, **every order
  is rejected** with `{"errors":{"token":"INVALID"}}`.
- Whether `WALLET_DB_URL` is set. If unset, spotapi's second Mongo connection silently targets
  `localhost` ([models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8)).
- Whether `NEXT_PUBLIC_RECAPTCHA_KEY` / `NEXT_PUBLIC_MODE` are set — decides whether Google's script
  loads in visitors' browsers.
- Whether `SPOT_CANARY_DISABLED` is set, which would silence the canary the healthcheck depends on.
- Whether `numReplicas` was raised in the dashboard after `railway.json` was written.
- Whether the two Railway services reach each other privately or over the public internet.

### Feature flags and mode switches
- **`TEST_MODE`** is a double auth bypass: it skips OTP validation entirely and enables
  `POST /api/auth/test-verify`. `test-verify` has a hard production veto; **the OTP bypass does not**
  ([auth.controller.js:933](../../cryptodex-userapi/controllers/auth.controller.js#L714) vs [:1729](../../cryptodex-userapi/controllers/auth.controller.js#L1510)). Whether it leaks into any deployed
  environment is unverifiable from the repo.
- `NODE_ENV=production` is a hard veto forcing real email delivery ([mailDelivery.js:75](../../cryptodex-userapi/lib/mailDelivery.js#L75)).
- All `PAPER_BOOK_*` thresholds are code-side defaults; production overrides unknown.

### Live data questions
- Whether any pre-conversion `SpotOrder` carries `liquidityType:"binance"`. **The 5-second cron that
  would make signed Binance calls is already running** — it is idle because the query returns nothing,
  not because it is off ([binance.controller.js:977](../../cryptodex-spotapi/controllers/binance.controller.js#L814)).
- Whether `PriceConversion` rows still carry `fetchFrom:'off'` (the CryptoCompare branch).
- Actual drift between Redis `walletbalance_spot` and Mongo `wallet.assets[].spotBal`.
- **Whether Redis persistence is configured.** The faucet cooldown is the only thing bounding money
  creation, and it lives entirely in Redis. A flush lets every account claim again immediately.

### Things worth fixing, found along the way

Not architecture, but surfaced while tracing and worth a decision:

**Fixed on 2026-08-26** (see the per-file evidence documents for detail):

1. ~~TLS verification disabled process-wide in spotapi~~ — the
   `NODE_TLS_REJECT_UNAUTHORIZED = "0"` line is removed. It was on the boot import chain, so every
   Binance HTTPS call had been running without certificate verification.
2. ~~CryptoCompare API key as a literal in a URL~~, and ~~the Infura fallback key~~ — both now read
   from the environment. **Both old values are in git history; rotate them.**
3. ~~spotapi mutating global axios defaults~~ with an `X-MBX-APIKEY` header on every request.
4. ~~A latent gRPC mismatch~~ — walletapi called `newNotification` where userapi serves
   `notification`, **and** the two `notificationReq` messages numbered their fields differently, so a
   name-only fix would have silently scrambled the payload rather than erroring.
5. ~~`DEPLOYMENT.md` stale~~ on `healthcheckPath`, the `build` block, and the supervisor's env
   injection. Also corrected: the USDC demo-grant claims in `README.md` / `SYSTEM_GUIDE.md`, stale
   counts in `ops/README.md`, and `paperLedger.js`'s own header, which had drifted out of step with
   its body about the removed flat ledger.
6. ~~Four dead socket `reconnect` listeners~~ — the order book had **no** resync path at all after a
   dropped connection. Now on the Manager, with a mutation-checked regression test.
7. ~~`railway.json` gated deploys on `/api/health`~~, which on a one-market venue means any Binance
   depth breaker fails the healthcheck. Now `/`, as `DEPLOYMENT.md` §5 always argued.

**Still open, deliberately** — these are design decisions, not defects, and changing them alters
trading behaviour:

1. **No rate limiting anywhere.** `express-rate-limit` is declared in spotapi and imported nowhere
   *(verified)*; userapi and walletapi have no limiter at all. `/orderPlace`, `/login` and
   `/register` are all unthrottled — and `/login` runs PBKDF2 at 100k iterations, so it is also a
   cheap way to burn CPU.
2. **No idempotency on order placement** — a retried POST double-places.
3. **One limit fill per pair per 2-second tick** ([spot.controller.js:5980](../../cryptodex-spotapi/controllers/spot.controller.js#L5396)).
4. ~~**The walletapi integration suite is order-dependent.**~~ **FIXED 2026-08-26** — `maxWorkers: 1`
   in both walletapi's and userapi's `jest.config.js`. Both suites share one mongodb-memory-server and
   one redis keyspace without namespacing per worker; measured across three runs of an unchanged tree,
   walletapi gave 9/2/6 failures and userapi 8/4/0, with different test names each time. The real fix
   is a per-worker database name and redis prefix.

---

## Method

Produced by parallel read-only agents, each required to cite `file:line`, followed by an adversarial
completeness critic that spot-checked citations against the real files. The critic caught genuine
errors before they became diagram arrows — a non-existent filename, four dead `reconnect` listeners
presented as live wiring, a missing 2-second matcher cron, and a socket "room" model that is actually a
global broadcast. Claims marked *(verified)* were then re-read by hand.

Diagrams were checked with a structural linter for all three Mermaid grammars used here
(flowchart, sequenceDiagram, erDiagram). No Mermaid renderer was available in this environment, so
syntax is validated structurally rather than by rendering — worth one visual check on GitHub.
