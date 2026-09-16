# Cryptodex — System Guide

**What this is:** a paper-trading crypto exchange. Virtual money only. No order is ever
routed to a real venue, no blockchain is ever touched. It mirrors live Binance market
data so the prices are real, but every balance, fill and position is bookkeeping in
Redis and Mongo.

This document describes the system **as it actually is today**, verified by reading the
code and exercising the running stack. For what it is and how to start it from a clone,
see [`README.md`](README.md). The venue began as a custody-bearing exchange and was
converted; §12 records what was removed and why, and the git history carries the rest.

*Last checked against the running stack: **2026-08-13**, by registering fresh accounts
and trading with them. §7 (health), §8 (log growth) and §10 carry live measurements that
go stale — §9 is how to re-take them.*

> **SCOPE.** This is a **spot-only** venue with **one wallet** and **no custody**. Four
> processes: frontend, userapi, spotapi, walletapi. Removed from the repository, in
> successive reductions and on purpose — not broken, not pending:
>
> - the identity/security surface — 2FA, anti-phishing code, login IP blocklist, login
>   history journal, KYC;
> - the P2P market, phone/SMS OTP and user roles;
> - support tickets, the CMS, FAQ, and the separate marketing landing-page app (the
>   venue's own front page at `/` remains);
> - **custody in its entirety** — deposits, withdrawals, deposit addresses, the wallet
>   pool, the Solana hot wallet, the Helius webhooks, Fireblocks. Nothing in this
>   repository can reach a blockchain.
>
> Sections that described any of it have been rewritten or removed rather than left to
> rot; see §5 and §12. Git history has all of it.

If you are picking this up cold, read §1, §2 and §9 and you can operate it. Read §4–§7
before you change anything.

---

## 1. Services, ports, and how to start them

| Service | Port | Directory |
|---|---|---|
| Frontend (Next.js) | 3000 | `cryptodex-frontend` |
| User API | 2567 (gRPC 6001) | `cryptodex-userapi` |
| Spot API | 2568 (gRPC 6003) | `cryptodex-spotapi` |
| Wallet API | 3002 (gRPC 6002) | `cryptodex-walletapi` |
| MongoDB | 27017 | `mongodb-data-27017/` |
| Redis | 6379 | keys prefixed `cryptodex_`, persists to `./dump.rdb` |

```bash
./start-all.sh     # starts Mongo, Redis, the 3 APIs and the frontend — idempotent
./stop-all.sh      # stops the 4 app services; leaves Mongo and Redis running
```

`start-all.sh` locates the repository from its own path (`BASH_SOURCE`), so it works from
any working directory and any checkout location. It used to hard-code one developer's
home directory, which meant a clone could not be started by the only documented command
for starting it.

`start-all.sh` blocks on a real `mongosh ping` and `redis-cli ping` before launching
anything (the APIs hydrate caches at boot, so starting them against a cold datastore
produced a silently half-initialised stack), then polls each port for a listener rather
than sleeping. It aborts rather than booting a broken stack. At the end it asserts pair
cache hydration and prints the boot time.

**Redis must be started from the repo root.** Its persistence directory is relative to
its working directory and the dataset lives at `./dump.rdb`. Starting it elsewhere boots
an *empty* Redis and looks exactly like total data loss. `start-all.sh` handles this and
asserts `redis-cli config get dir` afterwards.

**There is no standing test account.** The one this line used to name
(`papersmoke1@test.com`) went with a database reset and does not exist. Make one in
three calls — it takes about a second and it is also the check in §9.6:

```bash
E="check$(date +%s)@example.com"; P='Passw0rd!23'
curl -s -X POST localhost:2567/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$E\",\"password\":\"$P\",\"confirmPassword\":\"$P\",\"roleType\":1,\"checkbox\":true}"
curl -s -X POST localhost:2567/api/auth/test-verify -H 'Content-Type: application/json' -d "{\"email\":\"$E\"}"
curl -s -X POST localhost:2567/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"roleType\":1,\"email\":\"$E\",\"password\":\"$P\"}"
```

The login response's `token` **already contains `Bearer `** — send it verbatim as the
`Authorization` header.

---

## 2. Getting demo funds

> **This section used to state the demo grant at TEN TIMES its real value.** It said new
> users are seeded 10,000 USDC and that a faucet claim credits 10,000 of each coin, and
> it backed both with a "measured" JSON block showing balances of 20,000. The real
> numbers are **1,000** and **1,000**, and they have been since commit `07808c9`
> ("signup seed and faucet drop to 1000"). The figures below were re-taken from the
> source and from a live registration on 2026-08-13. If you are auditing this document,
> this is the paragraph that most deserved the audit: it was wrong about money, in the
> generous direction, in the operator's guide.

**At registration** walletapi seeds **1,000 USD** into the spot wallet and nothing
else — `DEMO_SEED_COINS = ["USD"]`, `DEMO_SEED_AMOUNT = 1000` in
`walletapi/controllers/createAsset.js:20-21`:

```json
{"USD":"1000","BTC":"0"}
```

> **Corrected 2026-08-26.** This paragraph said "1,000 USDC and 1,000 USD" and
> quoted `DEMO_SEED_COINS = ["USDC","USD"]`, measured on 2026-08-13. The USDC half
> is no longer true: USDC was dropped with its currency row, its balances and its
> price conversion, because it had no market on a venue that lists BTC/USD alone.
> The amount (1,000) was and is right. `ops/README.md` already recorded the USDC
> removal — this file did not.

**After that**, the faucet:

```
POST :2568/api/spot/faucet/claim    # 24h cooldown
POST :2568/api/spot/faucet/reset    # sets the faucet coins back, zeroes everything else
GET  :2568/api/spot/faucet/status   # cooldown remaining
```

**A claim credits one wallet.** `FAUCET_COINS = ['USD']` (faucet.controller.js:74)
at `FAUCET_AMOUNT = 1000` (:51), into the **spot** wallet, and nothing else — the
same single coin registration seeds, and the two constants are pinned to each other
by tests on both sides so a reset and a fresh registration land on the same
balances.
`reset` does the same thing in the other direction — it *sets* the faucet balance
and *zeroes* every other ledger.

Measured on a fresh account, 2026-08-13 (register → activate → login → claim): USD went
from `1000` to `2000`. That is 1,000 seeded at registration plus 1,000 claimed.

Both require auth and both are behind `blockStoodDownAccount` (an account that can
re-fund itself is not frozen). The cooldown is a Redis `SET NX EX` on
`cryptodex_faucet_cooldown_<userId>` (86400s); a failed credit releases the key so a user
is never locked out by an error.

Both endpoints answer with a `credited` array — every coin that moved, the wallet it
moved into, the balance it ended at — plus a one-line `headline` built from that same
list, and each leg is persisted as its own `DepositEvent` with signature
`faucet-<ts>-<userId>-<wallet>-<coin>` (per-leg, so a coin credited to two wallets in
one claim does not collide on the unique signature index).

In the UI these are `/faucet` (**Claim Demo Funds**) and `/reset` (**Reset demo
account**). They were `/deposit` and `/withdraw` — renamed because the URLs were lying by
their names: neither had moved money since the paper conversion, and a visitor clicking
"Withdraw" in a bookmark was being offered a wipe of their account. Both old paths still
307-redirect to the new ones.

Known limitation: `reset` does not cancel open orders or positions.

---

## 3. How money is represented — the ledger helpers

A single spot balance is recorded in up to **four** places, and every writer has to move
them together or money is created or destroyed:

1. Redis `cryptodex_walletbalance_spot`, field `<userId>_<currencyId>` — **the trading
   engine ledger, authoritative for live trading.** `spot.controller.js` HINCRBYFLOATs
   this one.
2. Redis `cryptodex_walletbalance_spot`, field `<userId>_<assetDocId>` — the wallet API
   ledger (`getWallet` reads under the asset document id). For coins seeded through
   walletapi's `createAsset` the asset subdocument `_id` *is* the currency `_id`, so in
   practice these collapse into one field.
3. `wallet.assets[].spotBal` in the wallet DB (regular units), written over gRPC.

> **Corrected 2026-08-26.** This list used to have a fourth entry — the flat `assets`
> collection, "USDC only" — and described USDC as carrying a third Redis field because
> of it. Both went with USDC itself: `paperLedger.js` states "THE FLAT `assets` LEDGER
> IS GONE … a spot balance now lives in exactly one place: the trading-engine Redis
> field." The stale text was copied from that file's own header comment, which had
> drifted out of step with its body; both are fixed.

**Redis is authoritative.** A gRPC ledger sync failure is logged loudly but never fails
the operation.

Because keeping four locations in step by hand is how balances drift, all balance
mutation goes through **ledger helpers**, and these are the only sanctioned mutators:

| Service | Helper |
|---|---|
| spot | `controllers/paperLedger.js` |

There is one ledger helper, and one wallet for it to write.

Key invariants in `paperLedger.js`:

- `resolveAccount()` returns every ledger location for a user+currency. `fields[0]` is
  always the trading-engine field.
- `adjustSpotBalance()` moves a **delta** with HINCRBYFLOAT so concurrent placements and
  fills never clobber each other; a field that does not exist yet is seeded from the flat
  ledger plus the delta rather than overwritten. (Overwriting was a real bug: the faucet
  once wrote a stale computed total over a live balance.)
- `setSpotBalance()` is the absolute-set path, used by `reset`.
- Mirroring to the flat collection and gRPC never throws.

**Do not hand-roll balance writes.** Use these.

---

## 4. How spot actually fills — the paper ladder

This is the part most worth understanding, because it is the least obvious.

For pairs with `botstatus: "binance"` (which is all three live spot pairs) the matching
engine originally had **no counterparty source at all** — `tradeMatching` only
synthesises liquidity for `"off"`/`"bot"` pairs — so user orders rested forever and never
filled. `controllers/paperBook.controller.js` fixes that:

1. `lib/binanceWebSocket.js` streams live Binance L2 depth into memory.
2. `syncPaperBook()` mirrors that depth as **resting, admin-owned limit orders written
   into the real `cryptodex_{buy,sell}OpenOrders_<pairId>` hashes**, flagged `isPaper:true`.
   12 synthetic price levels per side (`LEVELS = 12`), levels grouped until each clears
   `PAPER_BOOK_MIN_NOTIONAL` (default 25).
3. The **existing** engine then matches and settles with no special-casing: a user market
   buy walks the real ask ladder, a market sell walks the real bid ladder, a limit order
   fills when the book reaches it.

The ladder is rewritten **synchronously at the top of `matchingcall()`**, on a 2s cron,
immediately before the matcher reads the hashes — so the liquidity matched against is
<1ms old by construction rather than by discipline.

The bot account itself comes from Redis `cryptodex_admin_liquidity`, field `liquidation`.
**If that key is missing, nothing fills**, on any pair. Do not delete it.

The ladder is purged (and the display must go empty) when: depth goes stale/empty/
crossed/deviant, the pair goes ineligible, `admin_liquidity` vanishes, a write throws, or
the matcher stops visiting the pair at all. A ladder not rewritten for `PAPER_BOOK_ORPHAN_MS`
(30s) is **orphaned** and swept — necessary because `syncPaperBook` is only reached
through `matchingcall`, which only visits pairs on the matcher's active list, so a
deleted pair's last ladder would otherwise rest forever.

`syncPaperBook` replaces the ladder by `hdel`-ing every previous id and *then* `hset`-ing
the new ones, with awaits in between. **There is therefore a millisecond-wide window
every 2s in which Redis holds zero paper orders while the ladder is perfectly healthy.**
This matters — see §6.

---

## 5. Spot is the only product

This venue trades spot. Two Redis facts are load-bearing and must not be deleted:

- **`admin_liquidity` field `liquidation`** — the bot account, and the single Redis fact
  the spot ladder is conditional on. Do not delete it (§11).
- **`marginFreeze`** — checked by spot's own reservation Lua on every order.

**`STAND_DOWN_HASH = "account_standdown"`** is the shared freeze mark. Both spotapi
(`lib/accountStandDown.js`) and walletapi (`lib/walletStandDown.js`) must declare the
SAME string: renaming it on one side only silently un-freezes every account marked
there, and `tests/unit/wallet-shared-mark-stand-down.test.js` pins it for that reason.
The account freeze binds two sources — walletapi's `wallet.frozen` is the authority and
is read first — and fails closed when either cannot be read.

---

## 6. Health and the order gate — why display and liquidity share one verdict

Each service has a health/policy trio:

| Service | Modules |
|---|---|
| spot | `lib/depthHealth.js`, `lib/depthSource.js`, `lib/orderGate.js`, plus `paperBook.getLadderState()` |

(Spot's is the only such trio, which is why the "do not copy this rule twice" warning
below is advice about the future rather than a description of the present.)

### The rule that must not be copied twice

"Is this depth usable" lives in **exactly one** function, `depthHealth.assessDepthHealth`.
"Is a ladder actually resting" lives in **exactly one** function,
`paperBook.getLadderState`. The order gate owns *neither* — it owns only the **policy**
of what those verdicts mean **for an order**, which is a genuinely different question
from what they mean for a **display**.

This is not architectural purity, it is a bug that actually happened: two copies of "is
this depth usable" is precisely how the UI ended up rendering a full 20-level order book
for a pair whose ladder had been purged. The display and the liquidity check now share
one verdict so the book you see and the book you can trade against cannot disagree.

The same lesson applies to thresholds. The fill canary used to declare its own
`SPOT_CANARY_LADDER_MAX_AGE_MS` with the same default as `LADDER_STALE_MS` — so raising
the documented knob moved the gate and left the *monitor* still reporting against 15s: a
canary calling a ladder healthy after the display and the order gate had condemned it.
Thresholds are imported, never restated.

### Why the gate is on the server

The verdict was originally enforced in exactly one place: the browser. The order book
payload carried `healthy: false`, React disabled the Buy/Sell button, and everyone
declared it fixed. But `POST /api/spot/orderPlace` had no check at all — so an order
submitted while nothing could fill was **accepted and the balance debited immediately**.
A stale tab, a mobile client, a scripted API user or a retry landing during recovery
walks straight past a disabled button. The gate now runs on the server, immediately after
pair validation and **before any balance-moving line**, so a rejected order moves nothing,
writes no passbook row, and leaves no orphan in the open-order hash.

### The policy: market strict, limit permissive

**Market orders require a fully fillable book** — healthy depth AND a resting ladder AND
a ladder *big enough to fill the whole order*. A market order is a promise of immediate
execution; with no liquidity it does not rest usefully, it sits in the book as
`price: "market"` with funds debited, unfillable and unpriceable. There is no state of
the book in which accepting one beats refusing it.

Size is part of the verdict rather than a separate check because the gate originally
asked only "is a ladder resting" — right for an order of one satoshi, wrong for an order
twenty times the size of the book, which passed, consumed every level, and left its
remainder resting as `price: "market"` with funds already debited. The capacity
measurement is deliberately **conservative**: it counts the synthetic ladder only, not
real user orders that may also be resting. Erring is safe in exactly one direction.
`ladderCapacityFor` pairs the units in one place — a market buy spends quote and is
measured against sell **notional**; a market sell delivers base and is measured against
buy **quantity**. Mixing those units is the one arithmetic mistake that would make the
check meaningless.

**Limit orders are refused only for terminal, pair-level verdicts** (`pair_ineligible`,
`no_pair`). A resting limit order is exactly as legitimate when the feed hiccups for
eight seconds as when it is perfect, and blocking limits would remove the one instrument
a user has to get *out* of a position while the feed is unwell.

**Cancel and close are deliberately UNGATED.** Every path they take releases margin or
refunds a reservation rather than locking it, so they cannot commit the failure the gate
exists to prevent, and refusing one could only trap a user inside a position or strand
funds. Money is therefore always recoverable: every gate outcome ends either in "nothing
moved" or in "money the user can take back on demand".

### Why the order path trusts memory and does not re-check Redis

`bookPublish.controller.js` double-checks the in-memory ladder assertion by counting
paper rows in the hashes it is already reading. **The order path must not copy that** —
because of the millisecond-wide zero-paper-orders window described in §4. A display can
absorb a spurious blank; it republishes 100ms later. A user pressing Buy cannot absorb a
spurious rejection. The in-memory assertion, expired by `LADDER_STALE_MS` and recorded
"gone" *before* any purge begins, is the correct source there.

### Tunables

| Constant | Env var | Default | Meaning |
|---|---|---|---|
| `DEPTH_STALE_MS` | `PAPER_BOOK_STALE_MS` | 45000 | depth older than this is unusable |
| `LADDER_STALE_MS` | `PAPER_BOOK_LADDER_STALE_MS` | 15000 | ladder assertion expiry (shared by gate, display, canary) |
| `PRICE_DEVIATION_GUARD` | `PAPER_BOOK_CROSS_GUARD` | 0.05 | max fractional drift of best ask from `markPrice` |
| `MIN_NOTIONAL` | `PAPER_BOOK_MIN_NOTIONAL` | 25 | min notional per synthetic level |
| `ORPHAN_MS` | `PAPER_BOOK_ORPHAN_MS` | 30000 | ladder sweep threshold |
| `ORDER_BOOK_DEPTH` | — (hard-coded) | 20 | published book levels |
| `LEVELS` | — (hard-coded) | 12 | synthetic price levels per side |

`LADDER_STALE_MS` and `ORPHAN_MS` are different questions: the first is when a ladder
stops **counting as liquidity**, the second is when it is physically **swept out of
Redis**. All the tunables above live in spotapi (`lib/depthHealth.js`,
`controllers/paperBook.controller.js`), which is now the only place they could live.

---

## 7. Health endpoints — one path, three different questions

**All three APIs answer `GET /api/health`, unauthenticated, 200 when healthy and 503 when
not.** That one path is an alias, on every service, to whatever check that
service actually has — so a monitor can probe four ports identically without knowing which
kind of check it will get. The checks are *not* the same check:

| Service | `GET /api/health` | Also at | What it actually asserts |
|---|---|---|---|
| spotapi 2568 | fill canary | `/api/spot/health` | a market order **could fill right now** |
| userapi 2567 | dependency check | — | process up, Mongo + Redis connected, email provider config |
| walletapi 3002 | dependency check | — | the same, plus its gRPC bind (`127.0.0.1:6002`) and the stand-down guard |

The frontend (3000) has **no** health endpoint; `GET :3000/api/health` is a 404.

**The distinction that matters:** only spot's is a *liquidity* check — it answers "can an
order fill right now", which is the question the 5.5-hour silent-outage below made
urgent. The other two are dependency checks and answer nothing about fills.

### The fill canary (spot only)

**Why it exists:** spot stopped filling for 5.5 hours and nothing noticed. Every service
was up, the UI rendered a book, no error was logged, every test passed. Tests pass
against mocks; what broke was *live liquidity*. Uptime checks answer "is the process
alive", not "can a user's order actually trade".

**Mechanism — a non-committing dry run.** Every cycle (`SPOT_CANARY_INTERVAL_MS`, default
180000) the canary reads the live resting book from Redis and walks it exactly as a market
order would — best price first, consuming `openQuantity` — to see whether a small probe
would fully fill, then throws the result away.

It performs **zero writes**. No hset, no hdel, no wallet mutation, no Mongo insert. That
is the whole safety argument and it holds structurally: it never touches
`walletbalance_spot`/`_inOrder`, never creates a resting order (so there is no cleanup
path to fail and no crash window that can strand one), and nothing it does is observable
to a user. A dedicated canary *account* placing real self-cancelling probes was rejected
precisely because it would consume real liquidity, print rows into trade history and
volume charts, and could strand a resting order if the process died between place and
cancel.

**Liveness is checked separately.** A dry run proves liquidity exists; it does not prove
the engine is turning. Because the ladder is rewritten synchronously at the top of
`matchingcall()`, a ladder older than `LADDER_STALE_MS` means the matcher is not running
even if the book looks perfect. Together the two checks cover what a live probe order
would have proved.

**Verdicts are reported cause-first.** Checks run cheapest-and-deepest first (pair
eligibility → depth feed → ladder → simulated fill) so a dead depth feed reports
`stale_depth`, not the `no_ladder` it inevitably produces a cycle later.

### The endpoint

```
GET http://localhost:2568/api/spot/health      # unauthenticated on purpose
GET http://localhost:2568/api/health           # the same handler, via the alias
```

Unauthenticated because it is what a human or an uptime monitor reaches for when the
platform feels wrong, and it returns system state only. **HTTP 200 when healthy, 503 when
unhealthy.** Response cached for `SPOT_CANARY_HEALTH_CACHE_MS` (2s).

```json
{
  "status": "healthy",
  "verdict": "ok",
  "matcher": { "running": true, "evidence": "paper_ladder_refresh", "ladderAgeMs": 1141 },
  "depthFeed": { "summary": { "total": 3, "connected": 3, "desynced": 0, "allConnected": true } }
}
```

Verdicts include `ok`, `stale_depth`, `no_depth`, `empty_side`, `crossed_book`,
`price_deviation`, `ladder_not_built`, `ladder_stale`, `ladder_orphaned`,
`no_admin_liquidity`, `insufficient_liquidity`, `matcher_stalled`, `one_sided_ladder`,
`pair_ineligible`, `no_pair`, `canary_error`.

When it cannot fill, the log line names the subsystem that actually failed and a remedy,
rate-limited to one line per `SPOT_CANARY_REPEAT_LOG_MS` (10 min):

```
[FILL-CANARY] CANNOT FILL BTCUSD verdict=ladder_stale ...
[FILL-CANARY] WHY: <remedy>
```

Spot's is the only fill canary on the stack, and the only service that needs one:
userapi and walletapi answer dependency checks, and spot is the only matching engine
that can go silently illiquid.

---

## 8. Log rotation

Service logs are piped through `ops/logcap.pl`, a size-capped rotating sink that
`start-all.sh` wires up. Defaults: **24 MiB cap, 2 retained generations = 72 MiB ceiling
per service.** Override with `LOG_MAX_BYTES` / `LOG_KEEP`, or set `CRYPTODEX_LOG_ROTATE=0`
for plain unrotated redirects.

Why a pipe and not `truncate` or `mv`: `nohup npm start > /tmp/x.log` opens the file
*without* `O_APPEND`, so node keeps its own file offset. Truncating in place does not
reset that offset (the file goes sparse and immediately reports its old size again), and
renaming leaves the writer attached to the old inode so the new log stays empty forever.
A sink process owning the file on the other end of a pipe is the only way to rotate
without editing service code. `logcap.pl` exits on EOF, so it never outlives its service.

Measured growth on this stack, 120-second sample, 2026-08-13 (see §9.7 for how to
re-measure):

| service | growth | note |
|---|---|---|
| spot-api | **10.7 MB/hr** (372,728 B in 120 s) | dominated by `[Socket] Emitting orderBook`. Rotates every ~2.3h |
| wallet-api | 0.016 MB/hr | negligible |
| user-api | 0.007 MB/hr | negligible |
| frontend | 0.007 MB/hr | negligible |

`spot-api` dominates the table by a wide margin and is the reason rotation was added at
all. Any growth figure here was taken while other work was running against the stack;
re-measure (§9.7) before drawing conclusions from it.

`--rotate-on-start` retires the previous run's log to `<log>.1` at each boot, so every
boot starts with a clean file.

**All four logs are wrapped, checked 2026-08-13.** `lsof` shows `perl` and only `perl`
holding the write fd on `/tmp/{spot,user,wallet}-api.log` and `/tmp/frontend.log`, and
`pgrep -f "ops/logcap.pl" | wc -l` answers **8** — two processes (a `sh` and a `perl`)
per wrapped service, four services. Rotation is visibly working: `spot-api.log.2` had
reached exactly 25,165,905 bytes, the 24 MiB cap.

An earlier revision of this section reported the frontend log as held by `node` and
therefore unrotated. That was true when it was written and is not true now; the hazard it
describes is real and is kept in §10, because the cause — restarting a service by hand
with a plain `>` redirect — has not gone anywhere.

---

## 9. How do I know it is working?

Run these in order. Each one is independently meaningful.

### 9.0 The one command that does most of this for you

```bash
cd system-smoke-test && npm test
```

17 checks: all four services' health, a **brand-new** account registered through the real
endpoints, activated, logged in, its balances read back out of walletapi with the token
userapi minted, then the pair list, order book, tape, market price, trends and chart
against a pair id resolved from the venue rather than assumed. On a healthy stack it is
17/17 and exits 0. `node check-services.js` in the same directory is the faster version:
it asks each service's own health endpoint and nothing else.

The rest of §9 is what to run when that fails, and what each answer means.

### 9.1 All four services listening

```bash
for p in 3000 2567 2568 3002; do
  printf "%-6s %s\n" "$p" "$(lsof -ti:$p -sTCP:LISTEN >/dev/null 2>&1 && echo UP || echo DOWN)"
done
```

Expect four `UP`. Checked 2026-08-13: four up.

### 9.2 Pair caches hydrated

```bash
echo "spotPairdata = $(redis-cli hlen cryptodex_spotPairdata)"
```

Expect `3`. Anything less means spotapi booted against a cold or unreachable Mongo.

### 9.3 Health endpoints — all three APIs

```bash
for p in 2567 2568 3002; do
  printf "%-6s %s\n" "$p" "$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://localhost:$p/api/health)"
done
```

The frontend (3000) has no health endpoint and answers 404; that is expected.

`2567` and `3002` should be `200` — they check Mongo, Redis and, for wallet, the gRPC
bind and the stand-down guard. `2568` should be `200`; a 503 there means spot genuinely
cannot fill and the `verdict` names why:

```bash
curl -s http://localhost:2568/api/spot/health | python3 -m json.tool | head -20
```

Expect `"status": "healthy"`, `"verdict": "ok"`, `matcher.running: true`, a small
`ladderAgeMs` (< ~4000), and `depthFeed.summary.allConnected: true` with
`connected: 3, desynced: 0`.

### 9.4 The paper ladder is actually resting

```bash
# BTCUSD - the only listed market (ETHUSD/SOLUSD were delisted)
P=695bf1017573eeb15a749c9d
redis-cli hlen cryptodex_buyOpenOrders_$P
redis-cli hlen cryptodex_sellOpenOrders_$P
redis-cli hvals cryptodex_sellOpenOrders_$P | grep -c '"isPaper":true'
```

Expect ~12 paper rows per side (`LEVELS = 12`); the hash total may be slightly higher
because real user orders live in the same hash. **Zero paper rows means nothing can
fill.** Also confirm the liquidity account exists — without it no service fills anything:

```bash
redis-cli hget cryptodex_admin_liquidity liquidation | head -c 80
```

### 9.5 A spot market order actually FILLS

This is the only check that proves the whole path end to end. It moves real (virtual)
balance, so expect the numbers to change. It registers its own account, so it needs no
standing test user and leaves nothing shared behind.

Run it from the repository root — **the paths are relative on purpose**; this script used
to hard-code `/Users/illy/...` and could not run on another machine.

```bash
cat > /tmp/spotfill.mjs <<'EOF'
// Resolved against the WORKING DIRECTORY, not this script's location - so it is
// correct on any machine and any checkout path. A plain relative `import` would
// resolve against /tmp and fail; an absolute one is what made the previous
// version of this script unrunnable anywhere but its author's laptop.
const { encryptObject } = await import(
  new URL('cryptodex-spotapi/lib/cryptoJS.js', `file://${process.cwd()}/`).href
);
const U='http://localhost:2567', W='http://localhost:3002', S='http://localhost:2568';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t) } catch { return t.slice(0,150) } };

// A fresh account, through the real endpoints.
const E = `fill${Date.now()}@example.com`, P = 'Passw0rd!23';
await j(await fetch(U+'/api/auth/register', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({email:E,password:P,confirmPassword:P,roleType:1,checkbox:true})}));
await j(await fetch(U+'/api/auth/test-verify', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({email:E})}));
const TOK = (await j(await fetch(U+'/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({roleType:1,email:E,password:P})}))).token;   // already contains "Bearer "

const bal = async () => Object.fromEntries(((await j(await fetch(
  W+'/api/wallet/getAssetsDetails', {headers:{Authorization:TOK}}))).result||[]).map(r=>[r.coin,r.spotBal]));

// The pair id comes from the venue, never from a constant.
const pairs = await j(await fetch(S+'/api/spot/tradePair'));
const btc = (pairs.result||pairs).find(p => p.tikerRoot === 'BTCUSD');

const place = (o) => fetch(S+'/api/spot/orderPlace', {method:'POST',
  headers:{'Content-Type':'application/json', Authorization:TOK},
  body: JSON.stringify({ token: encryptObject(o) })});

const b0 = await bal(); console.log('BEFORE', JSON.stringify(b0));
const r = await place({spotPairId:btc._id, orderValue:'25', buyorsell:'buy', orderType:'market'});
console.log('orderPlace', r.status, JSON.stringify(await j(r)).slice(0,120));

// The quote debit is immediate; the BASE credit lands on the next matcher tick
// (2s cron), so POLL rather than sleeping once - a single 2.5s wait races it.
let b1 = b0;
for (let i = 0; i < 12; i++) {
  await new Promise(s => setTimeout(s, 1500));
  b1 = await bal();
  if (+b1.BTC > +b0.BTC) { console.log(`filled after ~${((i+1)*1.5).toFixed(1)}s`); break }
}
console.log('AFTER ', JSON.stringify(b1));
console.log('USD delta', (+b1.USD-+b0.USD).toFixed(6), 'BTC delta', (+b1.BTC-+b0.BTC).toFixed(10));
console.log(+b1.BTC > +b0.BTC ? 'FILL CONFIRMED' : 'NOT FILLED - see 9.3 / 9.4');

// The sell side, which is a different code path: it is measured in BASE, and the
// validator spells the quantity `amount`.
const qty = (+b1.BTC*0.5).toFixed(8);
const ms = await place({spotPairId:btc._id, amount:qty, quantity:qty, buyorsell:'sell', orderType:'market'});
console.log('market sell', ms.status, JSON.stringify(await j(ms)).slice(0,120));
EOF
node /tmp/spotfill.mjs
```

Expect `orderPlace 200 {"status":true,...}` then `FILL CONFIRMED`, a **USD delta of about
−25** and a positive BTC delta, typically within 2s.

Measured 2026-08-13 on this stack: a 40 USD market buy filled `+0.0006304090 BTC`; selling
half of that back returned `+19.96 USD` and debited `−0.0003152 BTC`.

Reading the result:

- **USD debited, BTC credited** — the whole path works.
- **USD debited, BTC still 0 after ~18s** — the order was accepted but is not matching.
  The debit happens at placement and the base credit only at match, so this is the
  signature of a stalled matcher or a missing ladder: check §9.3 (`matcher.running`,
  `ladderAgeMs`) and §9.4 (paper row count, `admin_liquidity`).
- **HTTP 400** — the gate refused it and `reason` names why. **Nothing was charged**;
  balances will be unchanged. That is correct behaviour, not a failure.

Occasional transient `ladder_not_built` refusals are expected and harmless: the ladder is
torn down and rewritten every 2s, and an order arriving in that window is refused before
any money moves. Observed rate on an otherwise healthy stack was 1 refusal in 13
consecutive market orders, with `GET /api/spot/health` reporting `verdict: ok` and 12/12
ladder rows resting immediately afterwards. Retry once before concluding anything is
wrong; a *persistent* `ladder_not_built` with a matching unhealthy verdict in §9.3 is the
real fault.

### 9.5b A limit order rests, and cancelling it refunds exactly

Cancel is the check most worth having, because a cancel that refunds the wrong amount
mints or destroys money silently. **The payload shape is not obvious** and getting it
wrong answers `400 {"message":"Order not found"}`, which reads like a bug and is not:

- the body field is **`id`**, not `token` (`cancelOrder` decrypts `req.body.id`);
- it carries `tableId` and `orderId`, where `tableId` is `` `${buyorsell}OpenOrders_${pairId}` ``
  and `orderId` is the order's `_id`;
- spotapi's `cancelAuthorised` requires the order to be yours, not to be a paper ladder
  order, and the `tableId` to name the order's **own** side. `frontend/lib/cancelOrderRequest.ts`
  builds exactly this and is the reference.

Continuing the §9.5 script (it reuses `TOK`, `btc`, `place`, `j` and `S` from it):

```js
const px = (Number(btc.markPrice) * 0.7).toFixed(2);          // well below the touch, so it rests
await place({spotPairId:btc._id, price:px, quantity:'0.0005', amount:'0.0005',
             buyorsell:'buy', orderType:'limit'});
const rows = (await j(await fetch(`${S}/api/spot/openOrder/${btc._id}`,
             {headers:{Authorization:TOK}}))).result.data;
const o = rows[0];
await fetch(S+'/api/spot/cancelOrder', {method:'POST',
  headers:{'Content-Type':'application/json', Authorization:TOK},
  body: JSON.stringify({ id: encryptObject({
    tableId: `${o.buyorsell}OpenOrders_${o.pairId}`, orderId: o._id }) })});
```

Measured 2026-08-13: USD `1000` → `977.81` when the limit order reserved funds → `1000`
exactly after the cancel. The reservation came back to the last decimal.

### 9.6 The ordinary auth path still works

The second standing bar is the **plain sign-in path**, because that is
what the 2026-08-08 security removal was most likely to break: 2FA, the login IP
blocklist and the login journal were all cut out of the login handlers themselves.

Register a **fresh** account through the real endpoints and trade with it:

```bash
E="check$(date +%s)@example.com"; P='Passw0rd!23'
curl -s -X POST localhost:2567/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$E\",\"password\":\"$P\",\"confirmPassword\":\"$P\",\"roleType\":1,\"checkbox\":true,\"langCode\":\"en\"}"
curl -s -X POST localhost:2567/api/auth/test-verify -H 'Content-Type: application/json' -d "{\"email\":\"$E\"}"
curl -s -X POST localhost:2567/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"roleType\":1,\"email\":\"$E\",\"password\":\"$P\"}" | head -c 200
```

Expect `"status":"SUCCESS"` and a token **on the first attempt, with no code of any
kind**. Then run §9.5 with that token.

And confirm the removed surface is actually gone rather than merely unlinked — these
must all be `404` (checked 2026-08-13: all four are, and so is
`/api/dashboard/lifeTimeReward`, which went with the referral surface):

```bash
for r in /api/user/2fa /api/user/loginHistory /api/user/antiphishingcode /api/user/kyc \
         /api/dashboard/lifeTimeReward; do
  printf "%-32s %s\n" "$r" "$(curl -s -o /dev/null -w '%{http_code}' localhost:2567$r)"
done
```

and these must be `307` rather than rendering a page. `next.config.js` declares thirteen
temporary redirects: `/innerhome` and `/market` → `/spot`; `/deposit` → `/faucet`;
`/withdraw` → `/reset`; `/2fa`, `/kyc`, `/log-session` → `/security`; `/faq`,
`/contactus`, `/support-ticket`, `/terms`, `/privacy-policy` and `/notification` → `/`.

```bash
for r in /innerhome /market /deposit /withdraw /2fa /kyc /log-session /faq /terms /notification; do
  printf "%-18s %s\n" "$r" "$(curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' localhost:3000$r)"
done
```

### 9.7 Log rotation is bounded

```bash
ls -la /tmp/*-api.log*                       # .log.1/.log.2 should cap at ~24 MiB
du -ch /tmp/*-api.log* /tmp/frontend.log* | tail -1
pgrep -f "ops/logcap.pl" | wc -l             # 2 per WRAPPED service (a sh + a perl)
for f in spot-api user-api wallet-api frontend; do
  printf "%-14s %s\n" "$f" "$(lsof /tmp/$f.log 2>/dev/null | awk 'NR>1{print $1}' | sort -u | tr '\n' ' ')"
done                                         # ONLY perl may hold a write fd
```

A fully-wrapped stack gives **8** (2 per wrapped service, 4 services), and every line of
the loop prints `perl` and nothing else. Checked 2026-08-13: 8, and all four show `perl`.
Any service showing `node` there has had rotation bypassed — the usual cause is a manual
restart with a plain `>` redirect.

To re-measure the growth rate (the sample below is what produced the §8 table; a 120 s
window is the shortest that is not dominated by a single burst):

```bash
A=$(stat -f %z /tmp/spot-api.log); sleep 120; B=$(stat -f %z /tmp/spot-api.log)
python3 -c "print(round(($B-$A)*30/1048576, 2), 'MB/hr')"
```

---

## 10. Known remaining issues

**Operational**

- `spot-api.log` grows **10.7 MB/hr** (measured 2026-08-13), ~85% of it a single
  `[Socket] Emitting orderBook` line. Rotation bounds the disk cost but the noise makes
  the log hard to read and caps retained history at ~7h.
- Rotation is applied **by `start-all.sh` only**. A service restarted by hand with a
  plain `>` redirect silently loses rotation, and **that has happened before** — the
  frontend once ran outside `logcap.pl` for a whole session. All four are wrapped as of
  2026-08-13 (§8, §9.7); check rather than assume.
- `mongodb.log` (repo root, ~10 MB) and `/opt/homebrew/var/log/redis.log` are not covered
  by `logcap.pl`. Neither is currently growing, but nothing bounds them either.
- Logging in again **invalidates the previous session** — the JWT carries a `tokenId` and
  only the newest is accepted. A script that logs in twice will 401 on the older token.
  Reuse one token per script run.

**Product / correctness**

- `faucet/reset` does not cancel open orders or positions.
- Registration seeding writes no `DepositEvent` (cross-service collection); faucet claims
  do — one row per credited leg (§2).
- The market-order capacity check counts only synthetic ladder liquidity, not resting
  real user orders, so an order that *could* have filled against another user may be
  refused. Deliberate — see §6.
- The frontend (3000) has no health endpoint at all.
- **Empty identity collections remain in Mongo**, deliberately unread and undeleted:
  `cryptodex_user` still carries `userkycs`, `userHistoryKyc`, `loginHistoryModel` and
  `restrictedIp`. Nothing writes any of them. Purging the Mongo collections is the
  owner's decision, not a side effect of removing a screen.
- **The e2e suite.** `e2e/faucet.spec.ts` and `e2e/reset.spec.ts` (formerly
  `wallet-deposit.spec.ts` and `withdrawal.spec.ts`) cover `/faucet` and `/reset`;
  `e2e/auth.spec.ts` / `e2e/spot-trading.spec.ts` contain vacuous if-wrapped
  assertions (pre-existing). The jest suites are the ones that mean something.
- Binance depth-snapshot 400s / sequence-gap warnings at boot come from the order-book
  resync WIP, not the paper conversion.
- **There is no key material in this repository any more, and the gRPC channels are
  plaintext.** 54 cert/key files — 21 of them PEM private keys, issued for earlier
  deployment hostnames — have been deleted, along with
  `walletapi/config/*_key.pem`, `walletapi/config/jwt.js`
  and the Fireblocks `controllers/coin/*.key` secrets.

  This was safe because **the mTLS was never in force**. All three gRPC servers bind
  `grpc.ServerCredentials.createInsecure()` (`spotapi`, `userapi`, `walletapi`
  `grpc/server.js`), and every live client channel passes
  `grpc.credentials.createInsecure()`. The `createSsl(...)` calls that read those files
  — including `userapi/grpc/currencyService.js`, which read
  `./private/walletapi.<host>.{ca,key,crt}` on every boot — built credential objects
  that were then discarded in favour of the insecure ones. The only consumer that did
  use an SSL credential was `spotapi/grpc/client.js`, a module no file imports, aimed at
  a `config.GRPC.SITE_INFO_URL` that spotapi's config never defines. So the files were
  read at boot as a side effect of dead code, and nothing more.

  The four services are one venue on one host talking over 127.0.0.1. If that ever
  changes, both ends need real credentials *and* the servers need to stop binding
  insecure — generated at deploy time, never committed. `.gitignore` now excludes
  `*.key`, `*.pem`, `*.crt`, `*.csr`, `*.p12`, `*.pfx` and `private/`, and
  `git ls-files` returns no key material at all.
- **The per-service `local.env` / `dev.env` / `prod.env` files are committed to git**,
  with live-looking Resend, Helius, Fireblocks, Telnyx, Sumsub and Solana hot-wallet
  keys in them. Every one of those belongs to a deleted feature, so nothing reads them —
  but they are in the history. `.gitignore` now excludes `*.env`, which stops new ones
  being added and does **not** untrack the existing ones; `git rm --cached` does that and
  leaves the files on disk so the stack keeps running. `*.env.example` templates are
  committed in their place. See the root README, "Configuration and secrets".
- **`package-lock.json` is gitignored**, in every service. Two clones can therefore
  resolve different dependency trees. This is the largest remaining reproducibility gap.

---

## 11. Safety rules for anyone working on this

- **Never delete or modify `cryptodex_admin_liquidity`.** The spot ladder is built from it
  and the matcher is conditional on it. Nothing fills without it.
- Never drop databases or delete user data. Induce faults non-destructively (add your own
  scratch field/pair and remove only that, or use tests with mocked Redis).
- Balance mutations go through the ledger helpers in §3. Do not hand-roll writes.
- Cancel and close must stay ungated so funds are always recoverable.
- Never print the contents of a `.env` or `.key` file into a report, a commit message or
  a chat log. Reading one to fix a config bug is fine; reproducing a value is not, and
  several of the values in this tree are real third-party keys (§10).
- The standing bar for any change: **spot must still fill, and the ordinary sign-in path
  must still work** — register, activate, log in, claim, place market and limit orders
  both sides, cancel, read the panels, check the wallet. Prove both (§9.5, §9.6), do not
  assume them.
- **Do not describe a removal as a bug fix without checking.** The 2026-08-08 brief for
  the security removal asserted that login "issues a token for a wrong code, a right code
  and no code alike". That had been true once and had already been fixed; re-verified
  live before anything was touched, 2FA was enforcing correctly. It was removed anyway,
  as a scope decision — but the difference is the difference between an accurate record
  and the fifth round of a false source comment.

---

## 12. The identity and security surface, and why it is gone

Removed on 2026-08-08, frontend and backend, deliberately and at the owner's request.
None of it protected anything on a venue whose money is imaginary, and the KYC half was
collecting passport and address scans — real, sensitive documents — for a university
project that cannot use them.

| Removed | Where it lived |
|---|---|
| Two-factor authentication (TOTP) | `pages/2fa.tsx`, `components/security/2fa.tsx`, `lib/totpQr.ts`; userapi `/api/user/2fa`, `/2fa-status`, `/2fa-data`, `/disable-2fa`, `lib/twoFactor.js` |
| Anti-phishing code | `components/security/Antiphising.tsx`; userapi `/api/user/antiphishingcode` |
| Login IP blocklist | userapi `/api/admin/IpRestriction` and the `ipAddress.findOne` check inside every login path |
| Login history journal | `pages/log-session.tsx` and its two navbar links; userapi `/api/user/loginHistory`, `/userLoginHist` |
| KYC | `pages/kyc.tsx`, `components/kyc/`, `components/security/kyc.tsx`; userapi `/api/user/kyc`, `/kyc/idproof`, `/kyc/addressproof`, `/kycdetail`, `/kyc-webhook`, `/accessToken`, `controllers/{userKyc,sumsubkyc}.controller.js` |

**Kept, because it is the product working rather than theatre:** registration, e-mail
verification/activation, login, logout, forgot/reset password, change password, session
handling (the JWT `tokenId` still invalidates the previous session), and the socket-room
authentication — that last one stops users reading each other's private data and is
correctness, not hardening.

Three things worth knowing about the consequences:

1. **2FA was working when it was removed.** Verified live first: with an authenticator
   enrolled, a login with no code returned the `TWO_FA` challenge and no token, `000000`
   returned `400 Invalid 2FA code` and no token, and only a correct TOTP produced a
   token. This was a scope reduction, not a repair. See §11.
2. **Nobody is locked out.** Accounts that had enrolled an authenticator are simply no
   longer asked for a code — the gate is gone, not inverted. `google2Fa.secret` is left
   on the User document untouched, so the enrolment survives if the owner ever wants it
   back.
3. **`/2fa`, `/kyc` and `/log-session` redirect (307) to `/security`** rather than 404.
   All three were linked from the product for its whole life and are in bookmarks; a 404
   answers "does this page exist" correctly and answers the visitor's actual question not
   at all. Non-permanent, for the same reason as every other redirect in `next.config.js`.

`/security` is now down to what the venue can honestly offer: the password you sign in
with, and the address it can reach you at. The "Security level" meter went too — it
scored four factors, three of which no longer exist, so it could only ever have read
"Low" for every account forever.
