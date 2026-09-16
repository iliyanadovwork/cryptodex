# 03 — Components: frontend (evidence)

Companion to [`03-components-frontend.mmd`](03-components-frontend.mmd). Next.js 13.4.13, **pages
router**, entirely client-rendered after the static shell.

---

## Edge

| Element | What it is | Source `file:line` | Notes |
|---|---|---|---|
| `middleware.ts` | The **only** route guard that actually runs | [middleware.ts:18](../../cryptodex-frontend/middleware.ts#L18) | matcher `/((?!api|_next|favicon.ico|socket.io).*)` |
| `components/Router/routes.ts` | `authRoutes`, `protectedRoutes`, `matchesRoute` | [routes.ts:45](../../cryptodex-frontend/components/Router/routes.ts#L45) | **`.ts`, not `.tsx`** |

**The session signal at the edge is the `loggedin` cookie only** — the JWT itself is never inspected
there ([middleware.ts:18](../../cryptodex-frontend/middleware.ts#L18)). `protectedRoutes` = `/deactive`, `/faucet`, `/history`, `/reset`,
`/security`, `/wallet`. **`/spot` is deliberately not protected** — the trading screen is readable
signed-out.

`handleAuthSSR` exists and is imported by three pages but **never invoked** — there is no
`getServerSideProps` anywhere ([utils/auth.js:9](../../cryptodex-frontend/utils/auth.js#L9)).

> `routes.ts` documents its own historical bug: entries were once written in Next's file-system
> pattern spelling (`/deposit/[id]`), which no real pathname can match, so those three guarded nothing
> ([routes.ts:1](../../cryptodex-frontend/components/Router/routes.ts#L1)).

## Pages

| Route | Purpose | Source |
|---|---|---|
| `pages/_app.tsx` | Provider + PersistGate, `SocketContext`, `PaperTradingBanner`, IdleTimer 30 min | [_app.tsx:165](../../cryptodex-frontend/pages/_app.tsx#L165) |
| `pages/spot/[id].tsx` | The trading screen. Resolves the pair slug, sets the `spotpair` cookie, emits `subscribe` | [spot/[id].tsx:99](../../cryptodex-frontend/pages/spot/[id].tsx#L99) |
| `pages/spot/index.tsx` | No UI — redirects to the first active pair; hard fallback `/spot/BTC_USD` | [spot/index.tsx:19](../../cryptodex-frontend/pages/spot/index.tsx#L19) |
| `pages/faucet.tsx` / `reset.tsx` | Demo credit / demo reset (were `/deposit` and `/withdraw`) | [faucet.tsx:5](../../cryptodex-frontend/pages/faucet.tsx#L5) |
| `pages/api/client-info.ts` | **The only API route.** Same-origin IP/geo, replacing a call to ipapi.co | [client-info.ts:7](../../cryptodex-frontend/pages/api/client-info.ts#L7) |

`next.config.js` declares **13 temporary redirects** for pages this venue no longer has — `/innerhome`
and `/market` → `/spot`, `/deposit` → `/faucet`, `/withdraw` → `/reset`, `/2fa` → `/security`, `/faq`
and `/terms` → `/`, and so on
([next.config.js:61](../../cryptodex-frontend/next.config.js#L61)). They are `permanent: false` deliberately, to avoid baking a 308 into
browser caches.

## Service layer — five axios instances

| Module | Targets | Base URL | Source |
|---|---|---|---|
| `config/axios.js` | userapi | `config.API_URL` (global axios default) | [axios.js:12](../../cryptodex-frontend/config/axios.js#L12) |
| `services/User/BaseService.js` | userapi | `${USER_API}/api` | [BaseService.js:17](../../cryptodex-frontend/services/User/BaseService.js#L17) |
| `services/Wallet/BaseService.ts` | walletapi | `${WALLET_API}/api` | [BaseService.ts:20](../../cryptodex-frontend/services/Wallet/BaseService.ts#L20) |
| `services/Common/BaseService.ts` | **walletapi** (not a separate service) | `${WALLET_API}/api` | [Common/BaseService.ts:19](../../cryptodex-frontend/services/Common/BaseService.ts#L19) |
| `services/Spot/BaseService.ts` | spotapi | `${SPOT_API}/api` | [Spot/BaseService.ts:13](../../cryptodex-frontend/services/Spot/BaseService.ts#L13) |
| `services/Wallet/SpotApiService.ts` | spotapi (faucet) | `${SPOT_API}/api` | [SpotApiService.ts:7](../../cryptodex-frontend/services/Wallet/SpotApiService.ts#L7) |

**The token is stored in four places and read in three different orders.** Login writes it to
localStorage `authToken`, the `userToken` cookie, the `loggedin` marker cookie, and redux-persist's
`user` blob ([EmailForm.tsx:179](../../cryptodex-frontend/components/Login/EmailForm.tsx#L179), [store/index.ts:22](../../cryptodex-frontend/store/index.ts#L22)). Lookup order differs per client:

- User / Common / Spot → redux-persist, then `userToken` cookie
- Wallet → redux-persist → localStorage → js-cookie → raw `document.cookie`
- **Wallet/SpotApiService → localStorage first** ([SpotApiService.ts:19](../../cryptodex-frontend/services/Wallet/SpotApiService.ts#L19))

The header is set **raw, with no `Bearer ` prefix** ([User/BaseService.js:43](../../cryptodex-frontend/services/User/BaseService.js#L43)).

**401 teardown is duplicated in four response interceptors** — and
`services/Wallet/SpotApiService.ts` **has no response interceptor at all**, so a 401 on a faucet call
does not sign the user out ([Spot/BaseService.ts:50](../../cryptodex-frontend/services/Spot/BaseService.ts#L50)).

`utils/clearSession.ts` is the single logout teardown; its header records that the navbar button and
the idle timeout each used to clear only *some* of the four copies, leaving a still-valid JWT to be
re-attached ([clearSession.ts:18](../../cryptodex-frontend/utils/clearSession.ts#L18)).

## Realtime

**One socket, opened against `config.SPOT_API`** — *not* `config.SOCKET_URL`, which has no consumer
([socketConnectivity.js:36](../../cryptodex-frontend/config/socketConnectivity.js#L36)).

| Event | Direction | Consumer | Source |
|---|---|---|---|
| `CREATEROOM` | → server | private room join, JWT-validated | [socketConnectivity.js:66](../../cryptodex-frontend/config/socketConnectivity.js#L66) |
| `subscribe` / `unSubscribe` | → server | rooms `spot` and the ticker root | [spot/[id].tsx:132](../../cryptodex-frontend/pages/spot/[id].tsx#L132) |
| `marketPrice` | ← server | 5 components | [MarketPrice.tsx:179](../../cryptodex-frontend/components/spot/MarketPrice.tsx#L179) |
| `orderBook` | ← server | `OrderBook.tsx`, filtered on `pairId` | [OrderBook.tsx:781](../../cryptodex-frontend/components/spot/OrderBook.tsx#L781) |
| `recentTrade` | ← server | `RecentTrade.tsx` | [RecentTrade.tsx:254](../../cryptodex-frontend/components/spot/RecentTrade.tsx#L254) |
| `openOrder`, `orderHistory`, `tradeHistory`, `updateTradeAsset` | ← server | private per-user feeds | [OpenOrder.tsx:259](../../cryptodex-frontend/components/spot/OpenOrder.tsx#L259) |
| `ROOMREJECTED` | ← server | triggers full session teardown | [socketConnectivity.js:83](../../cryptodex-frontend/config/socketConnectivity.js#L83) |

⚠️ **The `subscribe` calls do not affect delivery of `marketPrice` / `orderBook` / `recentTrade`** —
those are `socketIO.emit(...)`, a global broadcast ([spotapi/config/socketIO.js:126](../../cryptodex-spotapi/config/socketIO.js#L126)).
Room membership matters only for the private per-user events.

⚠️ **All four `socket.on("reconnect", …)` handlers are dead.** `reconnect` is a socket.io-client v4
**Manager** event, not a Socket event. Re-joining survives only because `socketConnectivity.js:124`
also handles `connect`.

`socket.io-msgpack-parser` is a declared dependency but `connectionOptions` sets no `parser`, so the
default JSON parser is in use ([package.json:85](../../cryptodex-frontend/package.json#L85)).

## Charting

The TradingView Advanced Charts library is **self-hosted**, not a CDN dependency:
`library_path: "/static/charting_library/"` ([Chart.js:73](../../cryptodex-frontend/components/spot/Chart.js#L73)). `lib/customDatafeed.js`
speaks UDF to spotapi over raw `fetch` with a 10s `AbortController` timeout and **no Authorization
header** — the chart feed is unauthenticated ([customDatafeed.js:30](../../cryptodex-frontend/lib/customDatafeed.js#L30)).

The only third-party browser script is the TradingView **ticker-tape embed** on the landing page
([bannerPage.tsx:159](../../cryptodex-frontend/components/Market/bannerPage.tsx#L159)).

## Order submission

`lib/cryptoJS.js` AES-wraps the order payload as a single `token` field before POSTing
([cryptoJS.js:86](../../cryptodex-frontend/lib/cryptoJS.js#L86)); call sites are `MarketOrder.tsx:180`, `LimitOrder.tsx:227`,
`cancelOrderRequest.ts:82`. The key is `NEXT_PUBLIC_CRYPTO_SECRET_KEY` — **inlined into the browser
bundle**, and documented as deliberately public. It is obfuscation, not authentication.

---

## Unverified

1. Whether `NEXT_PUBLIC_RECAPTCHA_KEY` / `NEXT_PUBLIC_MODE` are set in the deployed frontend, which
   decides whether Google's script loads at all ([_app.tsx:294](../../cryptodex-frontend/pages/_app.tsx#L294)).
2. Whether the deployed `NEXT_PUBLIC_CRYPTO_SECRET_KEY` equals spotapi's constant. The example file
   carries the same literal, but the Railway value is not in the repo.
3. Whether any CSP at the platform layer would block the TradingView embed.

## Open questions

1. **`services/Wallet/SpotApiService.ts` has no 401 response interceptor**
   ([SpotApiService.ts:7](../../cryptodex-frontend/services/Wallet/SpotApiService.ts#L7)) — a faucet call with an expired token fails silently
   instead of signing the user out. Deliberate?
2. **Four token copies, three lookup orders.** Is there a reason not to collapse to one?
3. ~~**The four dead `reconnect` handlers.**~~ **FIXED 2026-08-26.** `OrderBook.tsx` and
   `socketConnectivity.js` now listen on the **Manager** (`socket.io.on`), which is where
   socket.io-client v4 emits `reconnect`; the two redundant re-join copies in `_app.tsx` and
   `navbar.tsx` were removed, since `socketConnectivity`'s `connect` handler already re-joins on every
   reconnect. OrderBook had **no** resync path at all before this. Covered by a new mutation-checked
   regression test.
4. **`typescript.ignoreBuildErrors: true`** ([next.config.js:45](../../cryptodex-frontend/next.config.js#L45)) means `next build` cannot fail
   on a type error. Intentional for velocity?
5. ~~**`tsconfig.json` includes two files that do not exist.**~~ **FIXED 2026-08-26.** Both phantom
   entries removed from the `include` array.
6. **`jest.setup.js:226` globally mocks `@/lib/roundOf`** — any test of the real rounding implementation
   must use `jest.requireActual`, which is an easy trap.
