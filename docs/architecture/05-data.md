# 05 — Data model (evidence)

Companion to [`05-data.mmd`](05-data.mmd). Three MongoDB databases, one Redis instance, and a
deliberate split of authority between them.

> **Entities are named by COLLECTION, not by JS model alias.** In spotapi those two disagree — badly.
> See [The naming inversion](#the-naming-inversion-read-this-before-any-spotapi-code).

---

## Database ownership

| Database | Owner | Collections |
|---|---|---|
| `cryptodex_user` | userapi | `user`, `usersetting`, `language`, `sitesetting`, `emailtemplate`, `notification`, `adminProfitHistory`, `userkycs`, `restrictedIp`, `loginHistoryModel`, `admin`, `userHistoryKyc` |
| `cryptodex_wallet` | walletapi | `wallet`, `currency`, `priceconversion`, `transaction`, `passbook`, `ProfitLoss`, `userBalanceHistory`, `smslog`, `depositHash`, `redisPassBook`, `gasStation` |
| `cryptodex_spot` | spotapi | `spotpair`, `spotOrder`, `orderHistory`, `tradeHistory`, `sequenceId`, `depositEvent`, `withdrawalEvent`, `favouritepair`, `volumeBot`, `tradeBot` |

Each service uses a single default `mongoose.connect(config.DATABASE_URI)`
([userapi/config/dbConnection.js:16](../../cryptodex-userapi/config/dbConnection.js#L16),
[walletapi/config/dbConnection.js:16](../../cryptodex-walletapi/config/dbConnection.js#L16)) — **with one exception**, below.

## The naming inversion (read this before any spotapi code)

`models/index.js` re-exports two models under names that mean the opposite of what they say
([spotapi/models/index.js:3](../../cryptodex-spotapi/models/index.js#L3)):

**FIXED 2026-08-26.** The names now match the collections, and
[`tests/unit/model-registry.test.js`](../../cryptodex-spotapi/tests/unit/model-registry.test.js) pins each export to its collection so
it cannot drift back. What it used to be:

| Old barrel export | Actually resolved to | Now called |
|---|---|---|
| `SpotTrade` | the **`spotOrder`** collection — live/open orders | `SpotOrder` |
| `SpotOrder` | the **`orderHistory`** collection | `OrderHistory` |
| `spotOrderHistory` | the same object as `SpotOrder` | removed (duplicate alias) |

So `SpotOrder` meant order *history* while the live table answered to `SpotTrade`. The rename was
verified by snapshotting every export's resolved collection before and after and diffing them.

`ChartSchema` is **not a model** — `chartdoc.js` exports a bare `Schema` that consumers bind to a
collection at runtime ([chartdoc.js:36](../../cryptodex-spotapi/models/chartdoc.js#L36)); the chart controller registers six models
dynamically ([chart.controller.js:810](../../cryptodex-spotapi/controllers/chart/chart.controller.js#L810)).

## Cross-database relationships (none enforced)

MongoDB has no foreign keys, and these span *separate databases*, so every one of these is
id-by-convention. Nothing validates them.

| Relationship | Mechanism | Source |
|---|---|---|
| **`wallet._id` IS `user._id`** | The wallet's primary key *is* the user's `_id` — a 1:1 identity join across two databases | [wallet.js:74-78](../../cryptodex-walletapi/models/wallet.js#L74-L78) |
| `wallet.userCode` | Derived from `_id` via `IncCntObjId` — last 6 hex chars parsed as base-16 | [createAsset.js:51-53](../../cryptodex-walletapi/controllers/createAsset.js#L51-L53) |
| `spotpair.firstCurrencyId` / `secondCurrencyId` | → `currency` in the **wallet** DB | [spotpair.js:15](../../cryptodex-spotapi/models/spotpair.js#L15), [:29](../../cryptodex-spotapi/models/spotpair.js#L29) |
| `spotOrder.userId`, `orderHistory.userId`, `tradeHistory.buyUserId`/`sellUserId` | → `user` in the **user** DB | [spotTrade.js:83](../../cryptodex-spotapi/models/spotTrade.js#L83) |
| `passbook.tableId` | → a spot row, declared as `String`, no ref | [adminProfitHistory.js:21-24](../../cryptodex-userapi/models/adminProfitHistory.js#L21-L24) |

**This is why spotapi opens a second Mongoose connection.** `spotapi/models/currency.js` calls
`mongoose.createConnection(process.env.WALLET_DB_URL || 'mongodb://localhost:27017/cryptodex_wallet')`
at module scope so it can resolve `spotpair`'s currency refs without a gRPC round-trip
([spotapi/models/currency.js:8](../../cryptodex-spotapi/models/currency.js#L8)) *(verified)*. It is the only cross-service **direct
database read** in the system.

### Broken refs worth knowing

Several `ref:` targets name models that were never registered — a `.populate()` on them throws
`MissingSchemaError`:

- `user.referaluserid` → `ref: "users"` (plural), but the registered model is `user` (singular)
  ([User.js:317-320](../../cryptodex-userapi/models/User.js#L317-L320) vs [:433](../../cryptodex-userapi/models/User.js#L443)).
- `notification.userId`, `loginHistoryModel.userId` → same plural `users`
  ([notification.js:8-11](../../cryptodex-userapi/models/notification.js#L8-L11)).
- `spotOrder.pairId` → `ref:'spotpairs'`, but the model is registered as `spotpair`
  ([spotTrade.js:88](../../cryptodex-spotapi/models/spotTrade.js#L88) vs [spotpair.js:144](../../cryptodex-spotapi/models/spotpair.js#L144)).

These are harmless *because nothing populates them* — the code joins by hand. But they are traps.

## Where authority actually lives

This is the single most important thing about the data model, and it is **not** visible in the schemas:

| Data | Authority | Mongo's role |
|---|---|---|
| **Spot balances** | **Redis** `walletbalance_spot` | seeded once via `HSETNX`, then stale |
| Escrow | **Redis** `walletbalance_spot_inOrder` | not mirrored |
| Live order book | **Redis** `buy/sellOpenOrders_<pairId>` | `spotOrder` is a lagging mirror |
| Pair list | **Mongo** `spotpair` | Redis `spotPairdata` is the cache |
| Identity, settings, templates | **Mongo** | — |

Stated explicitly: *"Redis is authoritative for paper trading, so a gRPC ledger sync failure is logged
loudly but never fails the operation"* ([paperLedger.js:22](../../cryptodex-spotapi/controllers/paperLedger.js#L22)) *(verified)*.

**`wallet.assets[].spotBal` is not updated by a trade at all.** The fill path never calls
`updateUserAsset`; only faucet/deposit paths sync it ([paperLedger.js:169](../../cryptodex-spotapi/controllers/paperLedger.js#L169)). Because
walletapi seeds Redis with `HSETNX` and then reports Redis ([wallet.controller.js:355](../../cryptodex-walletapi/controllers/wallet.controller.js#L355)), the
user never sees the drift — and **Mongo can never correct Redis once the field exists**.

**There is no transaction boundary anywhere in spotapi** *(verified by grep)*. The only atomicity is
per-command Redis Lua ([redis.controller.js:179](../../cryptodex-spotapi/controllers/redis.controller.js#L179)).

## Deliberately retained dead fields

One schema keeps fields nothing reads, with a stated reason — good interview material:

**`usersetting` keeps vestigial preferences and enum members.** *"REMOVING AN ENUM MEMBER IS NOT SAFE. A
UserSetting document that already stores `defaultWallet: "derivativeBal"` would fail schema validation
on its next save."* Mongoose `strict` mode is the matching hazard for a plain field: dropping the path
stops mongoose writing it, so the next save of an existing document silently deletes the stored value.
Clearing either out is a migration — normalise `defaultWallet` to `"spotBal"`, then `$unset` the rest —
not a schema edit ([userSetting.js:60-80](../../cryptodex-userapi/models/userSetting.js#L60-L80)).

**`wallet.assets[]` no longer declares its vestigial balance fields.** They and the comment that
justified them are gone from [wallet.js](../../cryptodex-walletapi/models/wallet.js), so any value still
stored under them is dropped by mongoose on a document's next save; an `$unset` migration is now
tidy-up rather than a prerequisite. Nothing writes them any more either: the seed builds the
liquidity bot's wallet through the **raw driver**, which applies no schema, and its asset list is now
exactly the paths `wallet.js` declares ([reset-and-seed.mjs](../../ops/reset-and-seed.mjs)) — a field
list that had outlived the schema it was copied from.

## Keys and idempotency

| Constraint | Where | Purpose |
|---|---|---|
| `user.userId` unique, `user.email` unique | [User.js:77-98](../../cryptodex-userapi/models/User.js#L77-L98) | `email` required is **commented out** |
| `wallet.userCode` unique | [wallet.js:79-83](../../cryptodex-walletapi/models/wallet.js#L79-L83) | derived, therefore lossy — see below |
| `depositEvent.signature` unique | [depositEvent.js:103](../../cryptodex-spotapi/models/depositEvent.js#L103) | **the faucet's idempotency key** |
| `language.code` unique | [language.js:9-13](../../cryptodex-userapi/models/language.js#L9-L13) | |
| `userkycs.userId` unique | [userKyc.js:10-15](../../cryptodex-userapi/models/userKyc.js#L10-L15) | one KYC doc per user (KYC surface removed) |

`sequenceId` backs human-readable order codes via `findOneAndUpdate($inc)`, seeded at `10e10`
([spot.controller.js:1519](../../cryptodex-spotapi/controllers/spot.controller.js#L1519)).

**`spotOrder._id` is not a real ObjectId.** `createobjectId()` builds a 24-hex string from
`Date.now()/1000` in base-16 plus 16 random hex chars ([spot.controller.js:1028](../../cryptodex-spotapi/controllers/spot.controller.js#L1028)).

---

## Unverified

1. **Whether the indexes declared in these schemas actually exist in the deployed databases.** Mongoose
   builds them on connect by default, but that is a runtime fact.
2. **Whether the residue collections `currencies` / `spotpairs` (pluralised) exist.** The seed's
   `--verify` warns about them ([reset-and-seed.mjs:774](../../ops/reset-and-seed.mjs#L774)), but confirming needs a live query.
3. **Actual document counts and real drift** between `wallet.assets[].spotBal` and Redis.
4. **Whether the 12 model files deleted from userapi's barrel left orphaned collections behind.** The
   header states the collections were *not* dropped ([userapi/models/index.js:3-13](../../cryptodex-userapi/models/index.js#L3-L13)).

## Open questions

1. **`wallet.userCode` is `unique: true` but derived lossily** — `IncCntObjId` parses only the last 6
   hex characters of the ObjectId ([generalFun.js:11-18](../../cryptodex-walletapi/lib/generalFun.js#L11-L18)). Two users whose `_id`s share
   those 6 characters would collide on insert. Collision-resistant enough at this scale, but it is a
   real ceiling.
2. ~~**`loginHistoryModel.adminId` has an uncastable default.**~~ **FIXED 2026-08-26.** Confirmed it
   produced `ValidationError: Cast to ObjectId failed for value "admins"` on every validate; the bogus
   `default` is replaced with the `ref: 'admin'` it was evidently meant to be.
3. **`emailtemplate` has no index on `(identifier, langCode)`** despite that being the exact lookup key
   used on every outgoing email ([emailtemplate.js:4-30](../../cryptodex-userapi/models/emailtemplate.js#L4-L30)).
4. **`sitesetting.binanceDeposit.startTime/endTime` defaults are frozen at process boot** — the helper
   is *called* at schema-definition time rather than passed as a function reference
   ([sitesetting.js:112](../../cryptodex-userapi/models/sitesetting.js#L112)).
5. **Type/default mismatches** that mongoose silently casts: `spotOrder.orderValue` is a `Number` with
   `default: ''`; `beforeBalance`/`afterBalance` are `String` with `default: 0`
   ([spotTrade.js:139](../../cryptodex-spotapi/models/spotTrade.js#L139), [:155](../../cryptodex-spotapi/models/spotTrade.js#L143)). `user.userLocked` is a `String` holding `"false"`.
6. ~~**Should the barrel aliases be renamed?**~~ **DONE 2026-08-26** — see above.
