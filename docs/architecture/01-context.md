# 01 — Context (evidence)

Companion to [`01-context.mmd`](01-context.mmd). One box for the venue, every actor, every external
system it calls or is called by.

**Scope rule applied:** a system earns a box only if a code path reaches it. Hostnames that appear in
config with no live consumer are listed under [Config-only hostnames](#config-only-hostnames--deliberately-not-drawn)
rather than drawn — otherwise the diagram would claim eleven integrations the venue does not have.

---

## Elements

| Element | What it is | Source `file:line` | Notes |
|---|---|---|---|
| **Trader (browser)** | The only human actor. There is no operator UI and no privileged role — the venue has exactly one kind of user. | [railway-api.env.example:131](../../railway-api.env.example#L131) | `ADMIN_URL` survives in config and is marked DEAD; nothing renders from it |
| **Cryptodex (the system)** | Next.js web app + userapi + walletapi + spotapi. Decomposed in [02-containers](02-containers.mmd). | [deploy/Dockerfile:2](../../deploy/Dockerfile#L2) | "all three services, one container, one public port" |
| **MongoDB** | Three databases: `<prefix>_user`, `_wallet`, `_spot`. Managed instance addressed by env var. | [supervisor.mjs:101-105](../../deploy/supervisor.mjs#L101-L105) | Derived from `MONGO_URL` + `DB_PREFIX`, default prefix `cryptodex` |
| **Redis** | One shared instance, all keys under `REDIS_PREFIX`. **Authoritative for balances.** | [paperLedger.js:22](../../cryptodex-spotapi/controllers/paperLedger.js#L22) | "Redis is authoritative for paper trading" — verified directly |
| **Binance public market data** | The feed the entire order book is mirrored from. Unauthenticated. | [binanceWebSocket.js:533](../../cryptodex-spotapi/lib/binanceWebSocket.js#L533) | See mechanisms below |
| **Binance authenticated trading** | Signed order/cancel/status API. Present in code, **unreachable**. | [spot.controller.js:1851](../../cryptodex-spotapi/controllers/spot.controller.js#L1851) | Drawn dashed. See [Why Binance is two boxes](#why-binance-is-two-boxes) |
| **Resend** | Transactional email over HTTPS. The only email path — there is no SMTP. | [lib/emailGateway.js:45](../../cryptodex-userapi/lib/emailGateway.js#L45) | `POST https://api.resend.com/emails`, `Authorization: Bearer` |
| **CryptoCompare** | FX price lookup on a 5-minute cron. | [priceCNV.controller.js:66](../../cryptodex-walletapi/controllers/priceCNV.controller.js#L66) | Key now read from `CRYPTOCOMPARE_API_KEY`; omitted when unset (fixed 2026-08-26) |
| **TradingView ticker-tape** | Third-party `<script>` the **browser** loads directly — not a server call. | [bannerPage.tsx:159](../../cryptodex-frontend/components/Market/bannerPage.tsx#L159) | Only remaining third-party script in the bundle |
| **Railway** | Build + run platform; injects `PORT` and the datastore URLs. | [railway.json:3-11](../../railway.json#L3-L11) | Also builds the image from `deploy/Dockerfile` |

## Arrows

| From → To | Mechanism | Source `file:line` |
|---|---|---|
| Trader → Cryptodex | HTTPS REST/JSON | [config/axios.js:12](../../cryptodex-frontend/config/axios.js#L12) |
| Trader → Cryptodex | WebSocket (socket.io), namespace `/`, engine.io path `/socket.io/` | [socketConnectivity.js:36](../../cryptodex-frontend/config/socketConnectivity.js#L36) |
| Trader → TradingView | HTTPS, browser loads `s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js` | [bannerPage.tsx:159](../../cryptodex-frontend/components/Market/bannerPage.tsx#L159) |
| Cryptodex → MongoDB | Mongoose 6 over the MongoDB wire protocol | [spotapi/models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8) |
| Cryptodex → Redis | `redis@3.1.2` client over RESP | [redis.controller.js:6](../../cryptodex-spotapi/controllers/redis.controller.js#L6) |
| Binance ⇢ Cryptodex | WebSocket `wss://stream.binance.com:9443/ws/<sym>@depth@100ms` | [binanceWebSocket.js:533](../../cryptodex-spotapi/lib/binanceWebSocket.js#L533) |
| Binance ⇢ Cryptodex | WebSocket `…@aggTrade` (the trade tape) | [binanceWebSocket.js:709](../../cryptodex-spotapi/lib/binanceWebSocket.js#L709) |
| Cryptodex → Binance | HTTPS `GET /api/v3/depth` — snapshot that seeds each stream | [binanceWebSocket.js:166](../../cryptodex-spotapi/lib/binanceWebSocket.js#L166) |
| Cryptodex → Binance | HTTPS `GET /api/v3/ticker/24hr` — 30s cron | [binance.controller.js:1421](../../cryptodex-spotapi/controllers/binance.controller.js#L1258) |
| Cryptodex → Binance | HTTPS `GET /api/v3/klines` — 60s cron | [binance.controller.js:1519](../../cryptodex-spotapi/controllers/binance.controller.js#L1356) |
| Cryptodex → Binance | HTTPS `GET /api/v3/aggTrades` — on request | [binance.controller.js:1271](../../cryptodex-spotapi/controllers/binance.controller.js#L1108) |
| Cryptodex → Binance | HTTPS SDK `prices()` — walletapi FX table | [walletapi/binance.controller.js:8](../../cryptodex-walletapi/controllers/binance.controller.js#L8) |
| Cryptodex → Resend | HTTPS `POST /emails` | [lib/emailGateway.js:45](../../cryptodex-userapi/lib/emailGateway.js#L45) |
| Cryptodex ⇢ CryptoCompare | HTTPS `GET /data/price`, 5-minute cron | [priceCNV.controller.js:66](../../cryptodex-walletapi/controllers/priceCNV.controller.js#L66) |
| Cryptodex ⇢ Binance (auth) | HTTPS signed `order` / `cancelOrder` / `getOrder` — **dormant** | [binance.controller.js:490](../../cryptodex-spotapi/controllers/binance.controller.js#L476) |
| Railway ⇢ Cryptodex | Injects `PORT`; `MONGO_URL`/`REDIS_URL` supplied as service variables | [railway-api.env.example:35](../../railway-api.env.example#L35) |

---

## Why Binance is two boxes

Same provider, two different trust relationships, and only one of them is live.

**Live and unauthenticated** — the public market-data surface. Two WebSocket streams plus four REST
endpoints. No API key is used ([binanceWebSocket.js:533](../../cryptodex-spotapi/lib/binanceWebSocket.js#L533)). Both streams are started 5 s after
boot for every `{status:'active', botstatus:'binance'}` pair ([server.js:130](../../cryptodex-spotapi/server.js#L130),
[binanceWebSocket.js:386](../../cryptodex-spotapi/lib/binanceWebSocket.js#L386)). **This is the venue's only source of prices — if it stops, the paper
book cannot be built.**

**Dormant and authenticated** — real order placement. `binanceApiNode.order()` exists at four call
sites ([binance.controller.js:490](../../cryptodex-spotapi/controllers/binance.controller.js#L476), 555, 766, 840) and `cancelOrder` at 892. The routing
gate is `liquidityType == "binance"` ([spot.controller.js:2387](../../cryptodex-spotapi/controllers/spot.controller.js#L2387)) — but **both** order-entry
paths hard-code the literal `liquidityType: "off"`, with the comment *"PAPER TRADING: never follow
botstatus. 'binance' here routes to liquidityOrderPlace which places a REAL order on Binance"*
([spot.controller.js:1851](../../cryptodex-spotapi/controllers/spot.controller.js#L1851)). The branch cannot be true.

It is drawn — dashed — rather than omitted, because **the 5-second cron that would drive it is already
running**. `binOrderTask.start()` executes at module scope, and `checkOrder()` queries for
`liquidityType:"binance"` orders every 5 seconds, calling signed `getOrder()` for each hit
([binance.controller.js:977](../../cryptodex-spotapi/controllers/binance.controller.js#L814)). It is idle because the query returns nothing, **not** because it
is switched off. A single pre-conversion row with that flag would wake it. That is an architectural
fact worth a box.

## Notable absences

**No inbound webhooks anywhere.** Every mounted route across the three services was enumerated; none
is webhook/callback/notify/IPN shaped, and none is signature-authenticated. The two that existed are
documented as deleted: `/fireblocksWebhook` ([wallet.route.js:113](../../cryptodex-walletapi/routes/wallet.route.js#L113)) and `/kyc-webhook`
([user.route.js:19](../../cryptodex-userapi/routes/user.route.js#L19)). The frontend's only API route, `/api/client-info`, is same-origin
([pages/api/client-info.ts:7](../../cryptodex-frontend/pages/api/client-info.ts#L7)).

**No SMTP.** `nodemailer` is declared in two manifests but imported by no source file; the only hit
outside `package.json` is a commented-out config block ([userapi/config/index.js:193](../../cryptodex-userapi/config/index.js#L193)).

**No object storage.** Both `multer` consumers use `multer.diskStorage` writing into the service's own
`public/` tree ([wallet.controller.js:150](../../cryptodex-walletapi/controllers/wallet.controller.js#L150)). No `aws-sdk`, no `cloudinary` in any manifest.

**No browser CDNs.** jQuery, Font Awesome, Bootstrap and Google Fonts were all removed and
self-hosted ([pages/_app.tsx:247](../../cryptodex-frontend/pages/_app.tsx#L247)). `next.config.js` whitelists only `localhost` and
`*.cryptodex.com` image origins ([next.config.js:25](../../cryptodex-frontend/next.config.js#L25)).

**reCAPTCHA is effectively absent.** Server-side verification exists but every call site is commented
out ([lib/recaptcha.js:33](../../cryptodex-userapi/lib/recaptcha.js#L33)); the env template marks the key DEAD. The browser provider *may*
mount if a site key is set and the host is non-loopback ([pages/_app.tsx:294](../../cryptodex-frontend/pages/_app.tsx#L294)) — but **no
component calls `useGoogleReCaptcha`**, so no token is ever produced. Not drawn.

## Config-only hostnames — deliberately not drawn

Present in `walletapi/config/index.js` with live-shaped API keys, but **every consumer is a paper
stub** ([bnbGateway.js:1](../../cryptodex-walletapi/controllers/coin/bnbGateway.js#L1)): bsc-dataseed, bscscan, buddyscan, trongrid, etherscan,
polygonscan, polygon.llamarpc, Infura ([config/index.js:94-170](../../cryptodex-walletapi/config/index.js#L94-L170), [:324](../../cryptodex-walletapi/config/index.js#L324)); Mailgun,
Cloudinary, CoinMarketCap, CoinPayments ([config/index.js:183](../../cryptodex-walletapi/config/index.js#L183)), and Sumsub in userapi ([config/index.js:39](../../cryptodex-userapi/config/index.js#L39)).

They are excluded because drawing them would misrepresent the system's real dependency surface. They
are recorded here because the keys are real-shaped and sitting in tracked source.

> `web3` constructs a BSC RPC provider at module load, but its **only** use is
> `web3.utils.isAddress(...)` — a pure offline string check, no RPC ([currency.validation.js:13](../../cryptodex-walletapi/validation/currency.validation.js#L13)).

---

## Unverified

1. Whether any pre-conversion `SpotOrder` row carries `liquidityType:"binance"` in the live database,
   which would wake the already-running 5-second cron into signed Binance calls. The *write* path can
   no longer create one ([spot.controller.js:1851](../../cryptodex-spotapi/controllers/spot.controller.js#L1851)); existing rows cannot be ruled out statically.
2. Whether `RESEND_API_KEY` is populated in the deployed environment. Under `NODE_ENV=production`
   delivery is forced on ([mailDelivery.js:75](../../cryptodex-userapi/lib/mailDelivery.js#L75)), but an empty key makes `sendEmail` refuse
   before the request and log `not_configured` ([emailGateway.js:36-43](../../cryptodex-userapi/lib/emailGateway.js#L36-L43)).
3. Whether `NEXT_PUBLIC_RECAPTCHA_KEY` / `NEXT_PUBLIC_MODE` are set on the deployed frontend — this
   decides whether Google's script loads in visitors' browsers at all.
4. Whether `PriceConversion` rows still carry `fetchFrom:'off'`, the branch that fires the
   CryptoCompare call. The seeder writes exactly that ([venue-data.mjs:241](../../ops/seed/venue-data.mjs#L241)).
5. Whether any CSP at the Railway edge would block the TradingView script. No CSP is configured in
   `next.config.js` or `middleware.ts`; the platform layer is outside the repo.

## Open questions

1. ~~**TLS verification is disabled process-wide in spotapi.**~~ **FIXED 2026-08-26.** The
   `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` line has been removed from
   [chart/symbols_database.js](../../cryptodex-spotapi/controllers/chart/symbols_database.js),
   matching the removal already documented in its sibling `request-processor.js`. Every Binance edge
   in this diagram now verifies certificates.
2. ~~**spotapi mutates global axios defaults with Binance credentials at import time.**~~
   **FIXED 2026-08-26.** Both `axios.defaults` mutations removed from
   [binance.controller.js](../../cryptodex-spotapi/controllers/binance.controller.js).
   Every axios call site in the service already passed an absolute URL, and every live one targets a
   public Binance endpoint that takes no credential.
3. ~~**The CryptoCompare key is a literal in the URL.**~~ **FIXED 2026-08-26.** Now read from
   `CRYPTOCOMPARE_API_KEY` via config, and the `api_key` parameter is omitted entirely when unset
   (CryptoCompare serves this endpoint anonymously at a lower rate limit).
   **The old key is in git history — treat it as leaked and rotate it.**
4. **Is the TradingView ticker-tape embed meant to stay?** It is the only third-party script in the
   browser bundle and it sends the venue's pair list to TradingView as `BINANCE:<SYM>USDT`
   ([bannerPage.tsx:146](../../cryptodex-frontend/components/Market/bannerPage.tsx#L146)).
