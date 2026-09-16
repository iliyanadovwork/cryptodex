# 03 — Components: walletapi (evidence)

Companion to [`03-components-walletapi.mmd`](03-components-walletapi.mmd). Balances, currency metadata,
the FX conversion table, and the demo grant given to new accounts.

**The shape to understand:** walletapi's *main* surface is **gRPC, not HTTP**. It has four live HTTP
endpoints; spotapi and userapi move every balance through its gRPC server on 6002. That is why the
smoke test health-probes it rather than liveness-probes it — an Express process whose gRPC socket
never bound serves `/api/currency/getCurrency` perfectly while the venue gets `14 UNAVAILABLE`
([system-smoke-test/services.js:90](../../system-smoke-test/services.js#L90)).

---

## Entry points

| Element | What it is | Source `file:line` | Notes |
|---|---|---|---|
| `routes/wallet.route.js` | **4 live endpoints**: `getAssetsDetails`, `getAsset/:currencyId`, `history/transaction/:payment`, `transfer` | [wallet.route.js:13](../../cryptodex-walletapi/routes/wallet.route.js#L13) | `transfer` is a 410 |
| `routes/currency.route.js` | `GET /getCurrency` | [currency.route.js:12](../../cryptodex-walletapi/routes/currency.route.js#L12) | unauthenticated |
| `routes/common.route.js` | `GET /priceConversion`, `GET /getCurrency` | [common.route.js:10](../../cryptodex-walletapi/routes/common.route.js#L10) | both unauthenticated |
| `routes/health.route.js` | `GET /api/health` | [health.route.js:15](../../cryptodex-walletapi/routes/health.route.js#L15) | mounted **first**, deliberately |
| `express.static(public/)` | coin icons at `/currency/*` | [server.js:33](../../cryptodex-walletapi/server.js#L33) | 21 PNGs + symlink aliases |
| `grpc/server.js` | wallet 9 methods, currency 3, plus a demo `NewsService` | [grpc/server.js:56-157](../../cryptodex-walletapi/grpc/server.js#L56-L157) | **the real surface** |
| `config/cron.js` | 5-minute price conversion | [cron.js:12](../../cryptodex-walletapi/config/cron.js#L12) | |

**Health is mounted before every other router on purpose**: passport's JWT strategy reads the session
row out of Redis, so a Redis outage would otherwise take the health endpoint down with everything else
([server.js:35-38](../../cryptodex-walletapi/server.js#L35-L38)).

**walletapi mounts only `/api/*`** — no `/app/*` aliases, unlike the other two ([server.js:39-43](../../cryptodex-walletapi/server.js#L39-L43))
*(verified)*.

## Guards

| Guard | What it does | Source |
|---|---|---|
| `config/passport.js` | single `usersAuth` JWT strategy | [passport.js:36](../../cryptodex-walletapi/config/passport.js#L36) |
| `blockFrozenWallet` | binds **two** sources: `Wallet.frozen` (the authority) + the shared Redis `account_standdown` mark | [wallet.controller.js:222](../../cryptodex-walletapi/controllers/wallet.controller.js#L222) |
| `trackValueFlight` | on `/transfer` only; deregisters on `finish`, not `close` | [valueFlightGuard.js:24](../../cryptodex-walletapi/controllers/valueFlightGuard.js#L24) |

Read routes deliberately skip the frozen guard — reading a balance cannot move value
([wallet.route.js:13](../../cryptodex-walletapi/routes/wallet.route.js#L13)).

**No rate limiting and no helmet** — neither appears in source or `package.json`
([package.json:13](../../cryptodex-walletapi/package.json#L13)). CORS is `origin: '*'` ([server.js:25](../../cryptodex-walletapi/server.js#L25)).

## Domain

| Element | Responsibility | Source |
|---|---|---|
| `wallet.controller.js` (2609 lines) | the four live endpoints + the whole dormant custody apparatus | [wallet.controller.js:146](../../cryptodex-walletapi/controllers/wallet.controller.js#L146) |
| `createAsset.js` | **the demo grant** — `DEMO_SEED_COINS = ["USD"]`, `DEMO_SEED_AMOUNT = 1000` | [createAsset.js:20](../../cryptodex-walletapi/controllers/createAsset.js#L20) *(verified)* |
| `currency.controller.js` | currency list; builds icon URLs as `SERVER_URL + /currency/ + file` | [currency.controller.js:237](../../cryptodex-walletapi/controllers/currency.controller.js#L237) |
| `priceCNV.controller.js` | FX table from Binance + CryptoCompare on a 5-min cron | [priceCNV.controller.js:52](../../cryptodex-walletapi/controllers/priceCNV.controller.js#L52) |
| `health.controller.js` | two parallel dependency probes, 1500 ms deadline each; reports `grpc.bound` and `standDownGuard.ready` | [health.controller.js:109](../../cryptodex-walletapi/controllers/health.controller.js#L109) |

### The balance read is the interesting one

`getWallet` seeds `walletbalance_spot`, `_locked` and `_inOrder` from the Mongo asset **using HSETNX**,
then reports whatever Redis holds ([wallet.controller.js:355](../../cryptodex-walletapi/controllers/wallet.controller.js#L355)).

`HSETNX` = *set only if absent*. So Mongo seeds the Redis field **once**, and after that the displayed
balance follows the trading engine's ledger, not the document. This is what makes the deliberate
Redis/Mongo divergence invisible to the user — and it means **a Mongo asset that has drifted will never
be re-read once the Redis field exists**.

## Dormant — but not deletable

The seven coin gateways and the Fireblocks module are **imported at module scope** by
`wallet.controller.js`, which is why they cannot simply be removed: the gRPC boot chain
(`grpc/server.js` → `createAsset.js` → `coin.controller.js`) pulls them in
([wallet.controller.js:9-20](../../cryptodex-walletapi/controllers/wallet.controller.js#L9-L20)).

Each is a paper stub — `bnbGateway.createAddress` returns `"paper-bnb-" + Date.now().toString(16)`,
`getCryptoBalance` returns `{status:true, balance:0}` ([bnbGateway.js:1](../../cryptodex-walletapi/controllers/coin/bnbGateway.js#L1)). Fireblocks'
`fireblocksPOST` answers 200 `"Paper trading mode - webhook disabled"` ([firebase.js:117](../../cryptodex-walletapi/controllers/coin/firebase.js#L117)).

> **Custody routes are deleted, not stubbed** — `/fiatDeposit`, `/coinWithdraw`, `/fiatWithdraw`,
> `/userDeposit`, `/getWithdrawLimit`, `/createAddress` are gone from the router entirely
> ([wallet.route.js:88-106](../../cryptodex-walletapi/routes/wallet.route.js#L88-L106)). Their controllers survive as unreachable exports.

`web3` constructs a BSC provider at module load, but its only use is `web3.utils.isAddress(...)` — an
offline string check, no RPC ([currency.validation.js:13](../../cryptodex-walletapi/validation/currency.validation.js#L13)).

## Data access

| Store | What | Source |
|---|---|---|
| Redis `walletbalance_spot` / `_locked` / `_inOrder` | balances, seeded by HSETNX then owned by spotapi | [wallet.controller.js:355](../../cryptodex-walletapi/controllers/wallet.controller.js#L355) |
| Redis `priceCnv` | FX table, owned by the 5-min cron | [reset-and-seed.mjs:636](../../ops/reset-and-seed.mjs#L636) |
| MongoDB `_wallet` | `Wallet` (with `assets[]`), `Currency`, `Transaction`, `PriceConversion` | see [05-data](05-data.md) |

**spotapi opens a second Mongoose connection directly into this database** for currency lookups
([spotapi/models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8)) — a cross-service data access that bypasses the gRPC
boundary.

---

## Unverified

1. Whether `PriceConversion` rows still carry `fetchFrom:'off'` in the live database — that is the
   branch that fires the CryptoCompare call ([priceCNV.controller.js:56](../../cryptodex-walletapi/controllers/priceCNV.controller.js#L56)).
2. Whether any `Wallet.assets[]` subdocument has drifted from its Redis counterpart in practice. The
   mechanism is verified; the magnitude is a runtime question.
3. Whether the coin-icon `public/currency/` symlink aliases survive the Docker `COPY` — symlinks
   sometimes do not.

## Open questions

1. ~~**`getTrnxHistory`'s param guard is inert.**~~ **FIXED 2026-08-26.** The misplaced bracket
   (`["fiat", "crypto".includes(payment)]`) is now `["fiat","crypto"].includes(payment)`. The only
   live caller passes the literal `'crypto'`, so no client behaviour changes.
2. ~~**The CryptoCompare API key is a literal inside the fetch URL.**~~ **FIXED 2026-08-26.** Moved to
   `CRYPTOCOMPARE_API_KEY`; omitted from the URL when unset. **Rotate the old key — it is in git
   history.**
3. **`HSETNX` seeding means Mongo can never correct Redis.** Is there an intended reconciliation path,
   or is Redis simply the permanent authority once seeded?
4. **Should the dormant gateways be replaced with a single no-op module?** They exist only to satisfy
   a module-scope import chain ([wallet.controller.js:9-20](../../cryptodex-walletapi/controllers/wallet.controller.js#L9-L20)), and each still carries a
   config block with live-shaped API keys.
5. ~~**`INFURA_API_KEY` has a hardcoded fallback in tracked source.**~~ **FIXED 2026-08-26.** The
   fallback is now `""`. Nothing on a paper venue dials Infura. **Rotate the old project id.**
