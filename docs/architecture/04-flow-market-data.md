# 04 — Flow: market data to order book (evidence)

Companion to [`04-flow-market-data.mmd`](04-flow-market-data.mmd). How live Binance L2 depth becomes
both the **tradable** paper ladder and the **displayed** order book — from one snapshot, under one
health verdict.

---

## Hops in order

| # | Hop | Source `file:line` |
|---|---|---|
| — | Started 5 s after listen, for `{status:'active', botstatus:'binance'}` pairs | [server.js:130](../../cryptodex-spotapi/server.js#L130), [binanceWebSocket.js:391](../../cryptodex-spotapi/lib/binanceWebSocket.js#L391) |
| — | Symbol mapping: `secondCurrencySymbol === "USD" ? first + "USDT" : first + second` — so BTC/USD tracks **BTCUSDT** | [binanceWebSocket.js:391](../../cryptodex-spotapi/lib/binanceWebSocket.js#L391) |
| 1–2 | `GET /api/v3/depth` **limit 1000**, 10s timeout | [binanceWebSocket.js:166](../../cryptodex-spotapi/lib/binanceWebSocket.js#L166) |
| 3 | Snapshot **clears** bids/asks *and* `bufferedEvents`, then sets `lastUpdateId` | [binanceWebSocket.js:204](../../cryptodex-spotapi/lib/binanceWebSocket.js#L204) |
| 4–5 | Open `@depth@100ms` and `@aggTrade` sockets | [binanceWebSocket.js:533](../../cryptodex-spotapi/lib/binanceWebSocket.js#L533), [:709](../../cryptodex-spotapi/lib/binanceWebSocket.js#L709) |
| 6–10 | Sequence handling — gap test, buffer, replay | [binanceWebSocket.js:792](../../cryptodex-spotapi/lib/binanceWebSocket.js#L792), [:241](../../cryptodex-spotapi/lib/binanceWebSocket.js#L241) |
| 11 | `mirrorDepthToRedis` — top 20/side + `depth_meta_binance_<pairId>` | [binanceWebSocket.js:321](../../cryptodex-spotapi/lib/binanceWebSocket.js#L321) |
| 12 | `emitOrderBook` → `notifyDepthListener` (listener injected by `setDepthListener`) | [binanceWebSocket.js:348](../../cryptodex-spotapi/lib/binanceWebSocket.js#L348) |
| 13–17 | `resolveDepthSnapshot` — memory first, Redis second | [depthSource.js:49](../../cryptodex-spotapi/lib/depthSource.js#L49), [:22](../../cryptodex-spotapi/lib/depthSource.js#L22) |
| 18–19 | `assessDepthHealth` — five breakers | [depthHealth.js:148](../../cryptodex-spotapi/lib/depthHealth.js#L148) |
| 20–23 | `buildPaperOrders` → `hdel` then `hset` the ladder | [paperBook.controller.js:245](../../cryptodex-spotapi/controllers/paperBook.controller.js#L245), [:509](../../cryptodex-spotapi/controllers/paperBook.controller.js#L509) |
| 24–27 | Merge real user levels, drop crossing ones, slice to 20, publish | [bookPublish.controller.js:296](../../cryptodex-spotapi/controllers/bookPublish.controller.js#L296), [:177](../../cryptodex-spotapi/controllers/bookPublish.controller.js#L177) |

## The central design decision

**One snapshot, one verdict, two consumers.** Both the tradable ladder and the displayed book resolve
depth through the *same* `resolveDepthSnapshot` and judge it with the *same* `assessDepthHealth`.

The file header names the bug this prevents ([depthHealth.js:4](../../cryptodex-spotapi/lib/depthHealth.js#L4)):

> display and tradable liquidity were derived twice with two copies of "is this depth usable", so
> "when the ladder was purged by a circuit breaker the display kept rendering a full, pretty,
> 20-level book — so every visible signal said 'healthy' while nothing on the exchange could fill"

This is the single best "non-obvious decision" in the codebase for interview purposes: **the UI and
the matcher must share one liquidity truth, or the UI will lie confidently.**

## The five breakers

| Breaker | Condition | Env var / default |
|---|---|---|
| `no_depth` | null resolution (neither memory nor Redis) | — |
| `stale_depth` | `now - updatedAt > 45 s` | `PAPER_BOOK_STALE_MS` / 45000 |
| `empty_side` | either side empty or not an array | — |
| `crossed_book` | `!(asks[0].price > bids[0].price)` | — |
| `price_deviation` | `abs(bestAsk - markPrice)/markPrice > 5%` | `PAPER_BOOK_CROSS_GUARD` / 0.05 |

Source: [depthHealth.js:149-174](../../cryptodex-spotapi/lib/depthHealth.js#L149-L174).

**Every one is written to fail closed on garbage.** `stale_depth` uses `(Number(updatedAt) || 0)`
because a raw subtraction on an absent timestamp yields `NaN`, and `NaN > threshold` is `false` — a
snapshot with no timestamp would have been judged *fresh* ([depthHealth.js:156](../../cryptodex-spotapi/lib/depthHealth.js#L156)).
`crossed_book` is a strict `>` inside a negation so `NaN` on either side is condemned, not accepted
([depthHealth.js:168](../../cryptodex-spotapi/lib/depthHealth.js#L168)).

A sixth gate, `LADDER_STALE_MS` (15 s ≈ seven missed matcher cycles), lives in the same file
**deliberately** — it once existed twice under two env var names, so the two copies could disagree
([depthHealth.js:61](../../cryptodex-spotapi/lib/depthHealth.js#L61)).

## Ladder construction

`buildPaperOrders` walks best-first levels, accumulates until the group clears `MIN_NOTIONAL` (25),
then emits **one order quoted at the group's *worst* price** — so the ladder never quotes better than
the real book ([paperBook.controller.js:245](../../cryptodex-spotapi/controllers/paperBook.controller.js#L245)). `LEVELS = 12` per side
([paperBook.controller.js:28](../../cryptodex-spotapi/controllers/paperBook.controller.js#L28)).

Each synthetic row is owned by the admin liquidity account, with `isPaper:true`, `isMaker:true`,
`liquidityType:"off"`, and `orderDate` backdated 60 s ([paperBook.controller.js:274](../../cryptodex-spotapi/controllers/paperBook.controller.js#L274)).

**Replace, never merge.** Each cycle `hdel`s the ids written last cycle, sweeps leftover `isPaper` rows,
then `hset`s the new ones. Real user orders are only *read* here ([paperBook.controller.js:509](../../cryptodex-spotapi/controllers/paperBook.controller.js#L509)).

**Every abnormal exit purges the ladder** — pair ineligible, any breaker, missing admin liquidity,
unexpected error, or a pair the matcher stopped visiting. Rationale: the ladder was never debited from
any wallet, so a stale one is free money ([paperBook.controller.js:454](../../cryptodex-spotapi/controllers/paperBook.controller.js#L454)).

**The SPOF:** no `admin_liquidity/liquidation` in Redis → `dropLadder("no_admin_liquidity")` and every
user order rests forever ([paperBook.controller.js:490](../../cryptodex-spotapi/controllers/paperBook.controller.js#L490)).

## Resilience

| Concern | Mechanism | Source |
|---|---|---|
| Liveness | Measured on **depth data only** — Binance pings every ~20 s, so counting a ping as life leaves "connected and perfectly useless" sockets alive forever | [binanceWebSocket.js:552](../../cryptodex-spotapi/lib/binanceWebSocket.js#L552) |
| Watchdog | 10 s tick reconciles desired vs actual streams; silence > 30 s → restart; desync > 15 s → re-snapshot | [binanceWebSocket.js:606](../../cryptodex-spotapi/lib/binanceWebSocket.js#L606), [:92](../../cryptodex-spotapi/lib/binanceWebSocket.js#L92) |
| Reconnect | Deletes from the map **first**, then `ws.terminate()` (not `close()` — a dead socket will not complete a closing handshake) | [binanceWebSocket.js:505](../../cryptodex-spotapi/lib/binanceWebSocket.js#L505) |
| Superseded sockets | `close` handler returns early unless it is still the registered socket — a late close used to delete the live connection | [binanceWebSocket.js:580](../../cryptodex-spotapi/lib/binanceWebSocket.js#L580) |
| Buffer cap | `MAX_BUFFERED_EVENTS = 2000` | [binanceWebSocket.js:92](../../cryptodex-spotapi/lib/binanceWebSocket.js#L92) |
| Redis mirror timestamp | `ts` is `cache.updatedAt`, **not** `Date.now()` — stamping write-time would make stale depth look fresh | [binanceWebSocket.js:321](../../cryptodex-spotapi/lib/binanceWebSocket.js#L321) |
| Display honesty | If zero `isPaper` rows are actually in Redis, publish an empty book (`ladder_not_built`) — Redis overrules the in-memory assertion | [bookPublish.controller.js:177](../../cryptodex-spotapi/controllers/bookPublish.controller.js#L177) |
| Publish coalescing | One in-flight build per pair; ticks arriving during it collapse | [bookPublish.controller.js:279-298](../../cryptodex-spotapi/controllers/bookPublish.controller.js#L279-L298) |
| Boot safety | On boot, every `binance` pair's ladder is purged before the matcher can reach it | [server.js:112](../../cryptodex-spotapi/server.js#L112) |

**Why `limit=1000` and not 100:** measured on BTCUSDT, 100 levels span ~$17 (3 buckets at a $10 step)
while 1000 span ~$200 (21 buckets) ([binanceWebSocket.js:166](../../cryptodex-spotapi/lib/binanceWebSocket.js#L166)).

**Delivery is a global broadcast**, not a room emit ([spotapi/config/socketIO.js:126](../../cryptodex-spotapi/config/socketIO.js#L126))
*(verified)*. The client's `subscribe('spot')` does not affect it.

---

## Unverified

1. Real reconnect behaviour under a genuine Binance outage — the logic is read, not exercised.
2. Whether `PAPER_BOOK_*` env vars are overridden in production; all defaults are code-side.
3. Whether the `@aggTrade` 250 ms flush interval holds under load.
4. Whether **TLS verification is actually disabled** for these calls at runtime. The module setting
   `NODE_TLS_REJECT_UNAUTHORIZED = "0"` is on the boot import chain by inspection
   ([chart/symbols_database.js:11](../../cryptodex-spotapi/controllers/chart/symbols_database.js#L11)), but this was not observed executing.

## Open questions

1. **Can `markPrice` drift trip its own breaker?** `price_deviation` compares venue depth against
   `pairData.markPrice`, which `newTradeHistory` overwrites from each fill
   ([spot.controller.js:7038](../../cryptodex-spotapi/controllers/spot.controller.js#L6454)). A run of fills could in principle walk `markPrice` away
   from the feed that produced it.
2. **Display vs tradable content divergence is a known, accepted design gap.** The display shows the
   raw 20-level venue book; the tradable ladder shows 12 groups quoted at worst-of-group. Bounded and
   negligible on deep liquid USD pairs, but they are not the same numbers.
3. **`NODE_TLS_REJECT_UNAUTHORIZED = "0"`** means every arrow to Binance in this flow runs without
   certificate verification. The sibling file documents removing the identical line as "the serious
   one" ([chart/request-processor.js:25-31](../../cryptodex-spotapi/controllers/chart/request-processor.js#L25-L31)).
4. **Single process by construction:** streams are opened per process and socket.io has no adapter, so
   N replicas means N upstream connections and partitioned broadcasts.
