# 04 — Flow: the demo faucet (evidence)

Companion to [`04-flow-faucet-claim.mmd`](04-flow-faucet-claim.mmd). **This is the only way money is
created on this venue.** Withdrawal returns 410; trading only moves value between accounts. So the
faucet is the mint, and it is worth reading closely.

---

## Hops in order

| # | Hop | Source `file:line` |
|---|---|---|
| 1 | `/faucet` dynamically imports `FaucetForm` with `ssr:false` | [pages/faucet.tsx:5](../../cryptodex-frontend/pages/faucet.tsx#L5) |
| 1 | `faucetClaim()` → `POST /spot/faucet/claim` on `${SPOT_API}/api` | [WalletService.ts:72](../../cryptodex-frontend/services/Wallet/WalletService.ts#L72), [SpotApiService.ts:9](../../cryptodex-frontend/services/Wallet/SpotApiService.ts#L9) |
| 3–5 | Guards: `passportAuth` → `blockStoodDownAccount` → `trackValueFlight` | [spot.route.js:134](../../cryptodex-spotapi/routes/spot.route.js#L134) |
| 6 | `claimFaucet` | [faucet.controller.js:470](../../cryptodex-spotapi/controllers/faucet.controller.js#L470) |
| 7 | **`SET faucet_cooldown_<userId> NX EX 86400`** — taken first | [faucet.controller.js:480](../../cryptodex-spotapi/controllers/faucet.controller.js#L480) |
| 8–10 | On refusal: read `TTL`, answer 429 with `retryAfter` | [faucet.controller.js:488](../../cryptodex-spotapi/controllers/faucet.controller.js#L488) |
| 11 | `Currency.find({coin: {$in: FAUCET_COINS}})` | [faucet.controller.js:509](../../cryptodex-spotapi/controllers/faucet.controller.js#L509) |
| 12–13 | No currency resolves → **release the cooldown**, 500, nothing credited | [faucet.controller.js:564](../../cryptodex-spotapi/controllers/faucet.controller.js#L564) |
| 14–16 | `adjustSpotBalance` → Redis `hincrbyfloat`, then `syncSlowLedgers` over gRPC | [paperLedger.js:190](../../cryptodex-spotapi/controllers/paperLedger.js#L190), [:169](../../cryptodex-spotapi/controllers/paperLedger.js#L169) |
| 17 | `recordCreditedLegs` → one `DepositEvent` per leg | [faucet.controller.js:270](../../cryptodex-spotapi/controllers/faucet.controller.js#L270) |
| 19 | Response carries `credited`, `signatures`, `headline` | [faucet.controller.js:252](../../cryptodex-spotapi/controllers/faucet.controller.js#L252) |

**Constants:** `FAUCET_AMOUNT = 1000` per coin, `FAUCET_COINS = ['USD']`,
`FAUCET_COOLDOWN_SECONDS = 24*60*60` ([faucet.controller.js:51](../../cryptodex-spotapi/controllers/faucet.controller.js#L51), [:74](../../cryptodex-spotapi/controllers/faucet.controller.js#L74)).
Pinned by tests on **both sides** against walletapi's `DEMO_SEED_COINS`, so a reset and a fresh
registration produce the same balances.

## The cooldown key is a lock, not a rate limit

The most important line in this flow ([faucet.controller.js:480](../../cryptodex-spotapi/controllers/faucet.controller.js#L480)):

```js
redisClient.set(cooldownKey(userId), Date.now().toString(), 'EX', FAUCET_COOLDOWN_SECONDS, 'NX')
```

`SET … NX EX` is **atomic acquire-or-fail**. It is taken *before anything is read or credited*, and
the claim proceeds only if the reply is exactly `'OK'`. Two concurrent claims cannot both win — this
is mutual exclusion, not merely a 24-hour policy.

**Release is conditional on nothing having been credited.** Two paths hand the cooldown back:

1. No faucet `Currency` document resolves → `DEL` before any balance moves.
2. In the `catch`: `if (userId && !creditedAny) await redisClient.del(...)`.

Releasing after a *partial* credit would let the credited coins be claimed twice
([faucet.controller.js:564](../../cryptodex-spotapi/controllers/faucet.controller.js#L564)). A partial failure therefore keeps the cooldown — deliberately
choosing "user waits 24 h" over "user double-mints".

> The cooldown uses its **own raw Redis client** with the prefix applied by hand, not the shared
> prefix-applying helpers ([faucet.controller.js:148](../../cryptodex-spotapi/controllers/faucet.controller.js#L148)).

## Idempotency is best-effort, not a gate

`DepositEvent.signature` carries a unique index, described in-file as *"what makes a claim
idempotent"* ([depositEvent.js:107](../../cryptodex-spotapi/models/depositEvent.js#L107)). The signature is
`faucet-${timestamp}-${userId}-${wallet}-${coin}` — the wallet is included so one coin credited to two
wallets yields two rows rather than colliding ([faucet.controller.js:252](../../cryptodex-spotapi/controllers/faucet.controller.js#L252)).

**But the index cannot refuse a claim.** `recordCreditedLegs` wraps `DepositEvent.create` in
try/catch; on failure it pushes the credit *without* a signature and continues
([faucet.controller.js:270](../../cryptodex-spotapi/controllers/faucet.controller.js#L270)):

> "A failure here never fails the claim — the balances are already credited"

So the real mutual exclusion is the **cooldown lock**; the unique index is an audit-trail integrity
constraint that runs *after* the money moved. Worth being precise about in an interview: the write
order means the index can never be the thing that prevents a double credit.

## Reset — the mirror image

`POST /faucet/reset` is `passportAuth` + `blockStoodDownAccount` **without `trackValueFlight`**, and
that omission is deliberate ([spot.route.js:160](../../cryptodex-spotapi/routes/spot.route.js#L160)):

> the reset is the WRITER the registry excludes readers from: it takes the margin freeze itself and
> then reads the registry, so registering itself would make it wait for itself

The reset takes the per-user margin freeze via `claimOnce`, drains in-flight value operations, then
performs **absolute** writes — setting faucet coins and zeroing everything else
([faucet.controller.js:744](../../cryptodex-spotapi/controllers/faucet.controller.js#L744)). Its idempotency property is structural:
`reset(reset(x)) == reset(x)`.

That freeze key is the same one `RESERVE_LUA` `EXISTS`-checks inside the order path — which is how a
reset and a concurrent order placement cannot interleave ([redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179)).

## Ledger writes

`adjustSpotBalance` writes Redis and then fires `syncSlowLedgers`, which **never throws**. On failure
it logs *"LEDGER SYNC FAILURE … wallet.assets is now diverged from Redis (Redis remains
authoritative)"* ([paperLedger.js:169](../../cryptodex-spotapi/controllers/paperLedger.js#L169)).

Unlike the trade path, the faucet **does** sync Mongo — faucet/deposit paths are the only ones that
call `updateUserAsset`.

## UI behaviour worth noting

`refreshCooldown()` sets `retryAfter = null` on **any** error, and the Claim button is disabled only
when `retryAfter > 0` — so a failure to read the cooldown **fails open in the UI**
([FaucetForm.tsx:130](../../cryptodex-frontend/components/Wallet/FaucetForm.tsx#L130)). Harmless, because the server-side `SET NX` is the real gate.

The receipt is built from the API's own `credited` list, not client-side constants — *"the UI cannot
describe a credit the server did not report"* ([FaucetForm.tsx:145](../../cryptodex-frontend/components/Wallet/FaucetForm.tsx#L145)). One exception:
the *pre*-claim copy ("Claim 1,000 USD") is a duplicated client constant, acknowledged in-file as a
second copy of a server value ([lib/faucetReceipt.ts:67](../../cryptodex-frontend/lib/faucetReceipt.ts#L67)).

---

## Unverified

1. Whether any `DepositEvent` rows exist with a missing signature (the best-effort fallback path) —
   that is a live-data question.
2. Whether the `faucet_cooldown_*` keys survive a Redis restart. They are `EX`-bounded, but Redis
   persistence config is deployment-side. **If Redis is flushed, every account can claim again
   immediately** — the cooldown is the only thing rate-limiting the mint.
3. Real behaviour when `adjustSpotBalance` partially succeeds across multiple coins. With
   `FAUCET_COINS = ['USD']` there is only one leg today, so the partial-credit path is not currently
   reachable.

## Open questions

1. **Redis is the only thing bounding money creation.** The cooldown key is the mint's rate limit and
   it lives entirely in a cache. Is Redis persistence configured in production?
2. **A partial failure costs the user 24 hours.** The trade-off is deliberate, but there is no
   operator path to release a cooldown short of deleting the key by hand.
3. **The pre-claim UI constant duplicates a server value** ([faucetReceipt.ts:67](../../cryptodex-frontend/lib/faucetReceipt.ts#L67)) — the
   file itself suggests deriving it from `/faucet/status` instead.
4. **`FAUCET_COINS` and `DEMO_SEED_COINS` are two constants in two services** kept in step by tests on
   both sides. Should one be authoritative and read over gRPC?
5. **`/faucet/history` is served by `depositCtrl.getDepositHistory`** — the resurrected deposit route
   ([spot.route.js:150](../../cryptodex-spotapi/routes/spot.route.js#L150)). Its sibling `getDepositInfo` is exported and tested but mounted
   nowhere.
