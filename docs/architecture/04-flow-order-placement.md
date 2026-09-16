# 04 — Flow: order placement, fill and settlement (evidence)

Companion to [`04-flow-order-placement.mmd`](04-flow-order-placement.mmd). **The flow to know.** It is
split in two because acceptance and matching are decoupled by a 2-second clock.

---

## Hops in order

| # | Hop | Source `file:line` |
|---|---|---|
| 1 | Browser AES-wraps the payload: `{token: encryptObject(order)}` | [MarketOrder.tsx:180](../../cryptodex-frontend/components/spot/MarketOrder.tsx#L180), [LimitOrder.tsx:227](../../cryptodex-frontend/components/spot/LimitOrder.tsx#L227) |
| 2 | `POST /api/spot/orderPlace` via `services/Spot/SpotService.ts` | [SpotService.ts:17](../../cryptodex-frontend/services/Spot/SpotService.ts#L17) |
| 3 | Gateway forwards byte for byte | [routes.mjs:83](../../deploy/routes.mjs#L83) |
| 4–5 | `passportAuth` — JWT, then **re-read Redis `userToken`**, reject on missing row, `userLocked`, or `tokenId` mismatch | [passport.js:22](../../cryptodex-spotapi/config/passport.js#L22) |
| 6–8 | `blockStoodDownAccount` — Redis `account_standdown` **and** walletapi `deactivateWallet(mode:"check")` | [standDownState.js:58](../../cryptodex-spotapi/controllers/standDownState.js#L58) |
| 9–10 | `trackValueFlight` — `BEGIN_FLIGHT_LUA`; 409 if a reset freeze is held, **503 if Redis is down (fails closed)** | [valueFlightGuard.js:43](../../cryptodex-spotapi/controllers/valueFlightGuard.js#L43) |
| 11 | `decryptTradeOrder` → `decryptObject`, **replaces `req.body`** with plaintext | [spot.controller.js:1017](../../cryptodex-spotapi/controllers/spot.controller.js#L1017) |
| 12–13 | `FetchpairData` — Redis `spotPairdata` first, single indexed Mongo `findOne` as fallback | [spot.controller.js:1486](../../cryptodex-spotapi/controllers/spot.controller.js#L1486) |
| 14 | `assertOrderTradable` — **before any money moves** (gate at 1646, debit at 1880) | [orderGate.js:253](../../cryptodex-spotapi/lib/orderGate.js#L253), [spot.controller.js:1646](../../cryptodex-spotapi/controllers/spot.controller.js#L1646) |
| 15 | Advisory balance read — *not* the decision | [spot.controller.js:1801](../../cryptodex-spotapi/controllers/spot.controller.js#L1801) |
| 16–17 | First-touch hydration: `updateUserWallet` over gRPC if the Redis field is absent | [spot.controller.js:1784](../../cryptodex-spotapi/controllers/spot.controller.js#L1784) |
| 18–21 | **`hincrbyfloatIfEnough` — the atomic reservation** | [spot.controller.js:1880](../../cryptodex-spotapi/controllers/spot.controller.js#L1880), [redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179) |
| 22 | Escrow credit — **a separate, non-atomic second command** | [spot.controller.js:1904](../../cryptodex-spotapi/controllers/spot.controller.js#L1904) |
| 23 | `hset` into `buyOpenOrders_<pairId>` / `sellOpenOrders_<pairId>` | [spot.controller.js:1948](../../cryptodex-spotapi/controllers/spot.controller.js#L1948) |
| 24 | `newOrderHistory` → Mongo, **not awaited** | [spot.controller.js:1946](../../cryptodex-spotapi/controllers/spot.controller.js#L1946) |
| 25 | `socketEmitOne("updateTradeAsset")` to the trader's private room | [spot.controller.js:1928](../../cryptodex-spotapi/controllers/spot.controller.js#L1928) |
| 27 | **2-second cron** → `matchingcall(pairId)`, unawaited, per pair | [spot.controller.js:4945](../../cryptodex-spotapi/controllers/spot.controller.js#L4361) *(verified)* |
| 28–30 | `await syncPaperBook` at the tick top — ladder is re-derived <1 ms before it is matched | [spot.controller.js:4984](../../cryptodex-spotapi/controllers/spot.controller.js#L4400) |
| 31–32 | `hgetall` both hashes into an in-memory snapshot | [spot.controller.js:4992](../../cryptodex-spotapi/controllers/spot.controller.js#L4408) |
| 33 | `tradeMatching` — buys price-desc, sells price-asc, market first; self-trade prevented by userId compare | [spot.controller.js:5151](../../cryptodex-spotapi/controllers/spot.controller.js#L4567) |
| 34 | `settlementCredit` ×2 — buyer gets base, seller gets quote | [spot.controller.js:991](../../cryptodex-spotapi/controllers/spot.controller.js#L991), [:5937](../../cryptodex-spotapi/controllers/spot.controller.js#L5353) |
| 35 | `releaseInOrder` + `refundUnspentReservation` + price-improvement refund | [spot.controller.js:492](../../cryptodex-spotapi/controllers/spot.controller.js#L492), [:631](../../cryptodex-spotapi/controllers/spot.controller.js#L631), [:5636](../../cryptodex-spotapi/controllers/spot.controller.js#L5052) |
| 36–37 | `passbook` audit row over gRPC — **swallowed on failure** | [grpc/walletService.js:109](../../cryptodex-spotapi/grpc/walletService.js#L109) |
| 38 | `newTradeHistory` → Mongo + Redis mirror; overwrites `markPrice` | [spot.controller.js:6965](../../cryptodex-spotapi/controllers/spot.controller.js#L6381) |
| 39–40 | Private emits + **global** book/tape broadcast | [spot.controller.js:5950](../../cryptodex-spotapi/controllers/spot.controller.js#L5366), [bookPublish.controller.js:296](../../cryptodex-spotapi/controllers/bookPublish.controller.js#L296) |

## The one atomic step

`RESERVE_LUA` is the only command in the venue that takes a reservation. Read, compare and debit in
one indivisible step ([redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179)) *(verified)*:

```lua
if redis.call('EXISTS', KEYS[2]) == 1 then return 'FROZEN' end
local amt = tonumber(ARGV[2])
if amt == nil or amt ~= amt or amt <= 0 then return nil end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
... if bal < amt then return nil end
return redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1], '-' .. ARGV[2])
```

The freeze check is **inside** the same call. The comment records a measured exploit that took an
account from 10,000 to 48,039.52 in four races before that check existed
([redis.controller.js:148](../../cryptodex-spotapi/controllers/redis.controller.js#L148)).

## Transaction boundaries — there are none

**No `startSession`, no `withTransaction` anywhere in spotapi** *(verified by grep)*. The only
atomicity is per-command Redis Lua: `RESERVE_LUA`, `HGETDEL_LUA`, `CLAIM_ONCE_LUA`, `BEGIN_FLIGHT_LUA`.

Consequences visible in the diagram:

- **Step 22 is not atomic with step 18.** There is a window where the money is debited and the escrow
  counter still reads zero. `lib/valueFlight.js` exists precisely because a counter could not close it.
- **Step 24 is not awaited.** The ledger moves before the order document exists. The 200 at step 26
  promises the reservation landed, not that anything was persisted.
- **Step 36 is fire-and-forget.** A failed passbook row is logged as permanently missing — the money
  has already moved.

## Money conservation is deliberately false

Sum `walletbalance_spot` across all accounts before and after a fill and the numbers differ. This is
by design, not a leak ([paperLedger.js:30](../../cryptodex-spotapi/controllers/paperLedger.js#L30)):

**The synthetic ladder is not a ledger account.** `settlementCredit` returns `null` for a synthetic
counterparty — no balance move, no passbook row, no fee ([spot.controller.js:942](../../cryptodex-spotapi/controllers/spot.controller.js#L942)). Only the
real user's side moves. The comment records that before this exemption the admin bot's balances had
drifted to 234,978 USD / 0.0777 BTC out of one-legged credits.

The invariants that *do* hold are **I1** (the user's own two legs balance), **I2** (the reservation
bound) and **I3** (an explicit mint/burn endpoint list).

## Error paths, retries, timeouts, idempotency

| Concern | Reality | Source |
|---|---|---|
| **Retries** | **None.** Every gRPC wrapper: 5s deadline → `.catch()` → `{status:false}` | [walletService.js:52](../../cryptodex-spotapi/grpc/walletService.js#L52) |
| **Idempotency** | **None on this path.** No client order id; `_id` is generated server-side per request | [spot.controller.js:1028](../../cryptodex-spotapi/controllers/spot.controller.js#L1028) |
| **Rate limiting** | **None.** `express-rate-limit` declared, imported nowhere | [package.json:25](../../cryptodex-spotapi/package.json#L25) *(verified)* |
| Fails closed | Value-flight registry 503s on Redis failure; unmeasurable order size fails the gate | [orderGate.js:253](../../cryptodex-spotapi/lib/orderGate.js#L253) |
| Frozen account | 409 `RESET_IN_PROGRESS` from inside the Lua | [redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179) |
| Unfillable market order | Swept and refunded via `cancelMarketOrder`, which **claims the row with `hgetdel` before refunding** so overlapping ticks cannot double-refund | [spot.controller.js:5129](../../cryptodex-spotapi/controllers/spot.controller.js#L4545) |
| Cancel/fill interlock | `tradePair` latch — cancel refuses while the matcher holds that pair | [spot.controller.js:1309](../../cryptodex-spotapi/controllers/spot.controller.js#L1309) |
| Cancel refund amount | From the order's own `inOrderReserved - inOrderReleased`, **not** recomputed from price×qty | [spot.controller.js:1375](../../cryptodex-spotapi/controllers/spot.controller.js#L1375) |

**Throughput ceiling:** the limit branch ends in an unconditional `break`, so **at most one limit fill
settles per pair per 2-second tick** ([spot.controller.js:5980](../../cryptodex-spotapi/controllers/spot.controller.js#L5396)) *(verified)*.

**Fees are zero:** `feeRateFor()` returns a hard `0`, with the arithmetic left standing so no
money-moving line had to be edited ([liquidityRole.js:231](../../cryptodex-spotapi/lib/liquidityRole.js#L231)) *(verified)*.

---

## Unverified

1. Whether `marketMatching`'s block ≈6420–6560 holds an additional balance mutator — it is the mirror
   of the buy-side path that was read, but was not itself read line by line.
2. Real-world latency from acceptance to fill. Structurally it is 0–2 s plus matcher runtime, but that
   was not measured.
3. Whether the deployed `NEXT_PUBLIC_CRYPTO_SECRET_KEY` matches spotapi's constant — if not, **every**
   order fails with `{"errors":{"token":"INVALID"}}`.

## Open questions

1. **Is one limit fill per pair per 2 s the intended ceiling?** A large resting order clears one
   counterparty level every 2 seconds.
2. **What should a client do on timeout?** No idempotency key means a retry double-places.
3. **Does the 200 at step 26 promise persistence?** Today it promises only that the reservation landed.
4. **Should the escrow credit be folded into `RESERVE_LUA`?** That would close the non-atomic window
   at step 22 and might make `lib/valueFlight.js` unnecessary.
5. **`liquidityRole` is stamped at acceptance and cannot be re-derived later**, because the ladder is
   rebuilt every 2 s with fresh ids and a backdated `orderDate` ([spot.controller.js:1679](../../cryptodex-spotapi/controllers/spot.controller.js#L1679)).
   Worth documenting as an invariant somewhere load-bearing?
